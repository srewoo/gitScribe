#!/usr/bin/env node
/**
 * GitScribe MCP server.
 *
 * A thin stdio wrapper over @gitscribe/core. No server, no account, no API key
 * of its own. GITHUB_TOKEN is optional and only raises GitHub's rate limit.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  GitHubClient,
  buildDigest,
  applySelection,
  suggestDrops,
  chooseStrategy,
  requestCost,
  render,
  renderParts,
  partitionDigest,
  fetchPullRequest,
  fetchCompare,
  parseChangeSpec,
  renderDiff,
  checkGrounding,
  ANALYSIS_PROMPT,
  SYNTHESIS_PROMPT,
  nodeEnv,
  MODELS,
  DEFAULT_RESERVE,
  usableWindow,
  discoverOllama,
  DEFAULT_EXCLUDES,
  type Selection,
} from '@gitscribe/core';

const token = process.env['GITHUB_TOKEN'];
const client = new GitHubClient(nodeEnv, token ? { token } : {});

/** owner/repo, or any github.com URL containing one. */
function parseRepo(input: string): { owner: string; repo: string } {
  const cleaned = input.trim().replace(/^https?:\/\/(www\.)?github\.com\//, '');
  const [owner, repo] = cleaned.split('/');
  if (!owner || !repo) throw new Error(`Could not read "owner/repo" from ${JSON.stringify(input)}`);
  return { owner, repo: repo.replace(/\.git$/, '') };
}

function selectionFrom(exclude?: string[], include?: string[]): Selection {
  return {
    exclude: exclude ?? [...DEFAULT_EXCLUDES],
    include: include ?? [],
    overrides: {},
  };
}

async function resolveTree(repoInput: string, ref?: string) {
  const { owner, repo } = parseRepo(repoInput);
  const useRef = ref ?? (await client.getRepo(owner, repo)).defaultBranch;
  return { owner, repo, tree: await client.getTree(owner, repo, useRef) };
}

function rateNote(): string {
  const r = client.rateLimit;
  if (!r) return '';
  return `\n\nGitHub requests remaining: ${r.remaining}/${r.limit}${
    token ? '' : ' (anonymous; set GITHUB_TOKEN to raise this to 5,000/hour)'
  }`;
}

const server = new McpServer({ name: 'gitscribe', version: '0.1.0' });

/* ---------------------------------------------------------------- tools */

server.registerTool(
  'gitscribe_tree',
  {
    title: 'List a repository with per-file token estimates',
    description:
      'List every file in a GitHub repository with its size and ESTIMATED token cost. ' +
      'Costs 1-2 API requests regardless of repository size. Use this before ' +
      'gitscribe_digest to decide what to include.',
    inputSchema: {
      repo: z.string().describe('owner/repo, or a github.com URL'),
      ref: z.string().optional().describe('Branch, tag or commit SHA. Defaults to the default branch.'),
      exclude: z.array(z.string()).optional().describe('Glob rules to exclude. Omit for sensible defaults.'),
      include: z.array(z.string()).optional().describe('Glob rules to restrict to.'),
    },
  },
  async ({ repo, ref, exclude, include }) => {
    const { tree } = await resolveTree(repo, ref);
    const sel = applySelection(tree.files, selectionFrom(exclude, include));
    const lines = sel.files
      .slice()
      .sort((a, b) => b.tokens - a.tokens)
      .map((f) => `${String(f.tokens).padStart(8)}  ${f.path}`);

    const warning = tree.truncated
      ? '\n\nWARNING: GitHub truncated this listing (over 100,000 entries or 7MB). Files beyond the cap are not listed.'
      : '';

    return {
      content: [
        {
          type: 'text' as const,
          text:
            `${sel.files.length} files selected, approximately ${sel.totalTokens.toLocaleString()} tokens ` +
            `(ESTIMATED — no public tokenizer exists for most models; counts are biased to over-count).\n\n` +
            `  tokens  path\n${lines.join('\n')}${warning}${rateNote()}`,
        },
      ],
    };
  },
);

server.registerTool(
  'gitscribe_digest',
  {
    title: 'Produce an LLM-ready digest of a repository',
    description:
      'Fetch the selected files and render them as one document. Secrets are ' +
      'redacted by default. Any file that cannot be included is reported by ' +
      'path rather than dropped silently.',
    inputSchema: {
      repo: z.string().describe('owner/repo, or a github.com URL'),
      ref: z.string().optional(),
      exclude: z.array(z.string()).optional(),
      include: z.array(z.string()).optional(),
      format: z.enum(['md', 'xml', 'json', 'txt']).optional().describe('Default: md'),
      redact: z.boolean().optional().describe('Redact probable secrets. Default: true'),
      maxTokens: z
        .number()
        .optional()
        .describe(
          'Split the digest into parts of at most this many tokens each, so a ' +
            'repository too large for one context window is still covered completely. ' +
            'Use with `part` to fetch each slice.',
        ),
      part: z.number().optional().describe('Which part to return (1-based). Requires maxTokens.'),
    },
  },
  async ({ repo, ref, exclude, include, format, redact, maxTokens, part }) => {
    const { owner, repo: name, tree } = await resolveTree(repo, ref);
    const selection = selectionFrom(exclude, include);
    const digest = await buildDigest(nodeEnv, client, owner, name, tree, {
      selection,
      ...(redact !== undefined ? { redact } : {}),
    });
    const fmt = format ?? 'md';
    let body: string;
    if (maxTokens && maxTokens > 0) {
      const parts = renderParts(digest, fmt, { budget: maxTokens });
      const which = part ?? 1;
      if (which < 1 || which > parts.length) {
        throw new Error(
          `This digest splits into ${parts.length} part(s) at ${maxTokens} tokens each. ` +
            `Ask for a part between 1 and ${parts.length}.`,
        );
      }
      body = parts[which - 1]!;
    } else {
      body = render(digest, fmt);
    }

    const notes: string[] = [];
    if (digest.truncations.length) {
      notes.push(
        `INCOMPLETE: ${digest.truncations.map((t) => `${t.kind} (${t.paths?.length ?? 0})`).join(', ')}`,
      );
    }
    if (digest.redactions.length) {
      const n = digest.redactions.reduce((s, r) => s + r.count, 0);
      notes.push(`${n} probable secret(s) redacted.`);
    }

    return {
      content: [{ type: 'text' as const, text: notes.length ? `${notes.join(' ')}\n\n${body}` : body }],
    };
  },
);

server.registerTool(
  'gitscribe_estimate',
  {
    title: 'Check whether a selection fits a model, without fetching it',
    description:
      'Estimate token cost from the file tree alone — no content is downloaded. ' +
      'Reports whether it fits the target model and, if not, which files to drop.',
    inputSchema: {
      repo: z.string(),
      ref: z.string().optional(),
      exclude: z.array(z.string()).optional(),
      include: z.array(z.string()).optional(),
      model: z.string().optional().describe('Model id from gitscribe_models. Default: claude-opus-5'),
      reserve: z.number().optional().describe(`Tokens held back for prompt and reply. Default: ${DEFAULT_RESERVE}`),
    },
  },
  async ({ repo, ref, exclude, include, model, reserve }) => {
    const { tree } = await resolveTree(repo, ref);
    const sel = applySelection(tree.files, selectionFrom(exclude, include));
    const entry = MODELS.find((m) => m.id === (model ?? 'claude-opus-5'));
    if (!entry) throw new Error(`Unknown model ${model}. Call gitscribe_models for the list.`);

    const usable = usableWindow(entry, reserve ?? DEFAULT_RESERVE);
    const over = sel.totalTokens - usable;
    const strategy = chooseStrategy(sel.files, tree);

    const lines = [
      `${sel.files.length} files, approximately ${sel.totalTokens.toLocaleString()} tokens (ESTIMATED).`,
      `${entry.name}: ${entry.contextWindow.toLocaleString()} window, ${usable.toLocaleString()} usable after reserve.`,
      entry.windowSource === 'vendor'
        ? 'Context window: vendor-documented.'
        : `Context window: ${entry.windowSource} source, treat as approximate.`,
      over > 0
        ? `OVER by ${over.toLocaleString()} tokens.`
        : `Fits, with ${(-over).toLocaleString()} to spare.`,
      `Fetching this would cost ${requestCost(strategy, sel.files)} request(s) via the ${strategy} path.`,
    ];

    if (over > 0) {
      const drops = suggestDrops(sel.files, over);
      lines.push('', 'Dropping these would bring it under, largest first:');
      for (const d of drops) lines.push(`  ${String(d.tokens).padStart(8)}  ${d.path}`);
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') + rateNote() }] };
  },
);

server.registerTool(
  'gitscribe_plan_parts',
  {
    title: 'Plan how to cover a large repository across several prompts',
    description:
      'Work out how many parts a repository needs at a given token budget, and ' +
      'what each part will contain — computed from the file tree, without ' +
      'downloading content. Follow up with gitscribe_digest(maxTokens, part).',
    inputSchema: {
      repo: z.string(),
      ref: z.string().optional(),
      exclude: z.array(z.string()).optional(),
      include: z.array(z.string()).optional(),
      maxTokens: z.number().describe('Usable tokens per part.'),
    },
  },
  async ({ repo, ref, exclude, include, maxTokens }) => {
    const { owner, repo: name, tree } = await resolveTree(repo, ref);
    const sel = applySelection(tree.files, selectionFrom(exclude, include));
    // Plan from tree sizes alone — no content is fetched.
    const pseudo = {
      owner, repo: name, ref: tree.ref,
      files: sel.files.map((f) => ({ path: f.path, text: '', tokens: f.tokens })),
      totalTokens: sel.totalTokens,
      estimated: true as const,
      truncations: [], redactions: [], generatedAt: Date.now(),
    };
    const plan = partitionDigest(pseudo, { budget: maxTokens });
    const lines = plan.parts.map((p) => {
      const first = p.files[0]?.path ?? '(empty)';
      const last = p.files[p.files.length - 1]?.path ?? first;
      return `  part ${p.index}/${p.total}: ${p.files.length} files, ~${p.tokens.toLocaleString()} tokens` +
        `${p.oversized.length ? ` [OVERSIZED: ${p.oversized.join(', ')}]` : ''}\n      ${first}\n   …  ${last}`;
    });
    return {
      content: [{
        type: 'text' as const,
        text:
          `${sel.files.length} files, ~${sel.totalTokens.toLocaleString()} tokens (ESTIMATED) ` +
          `split into ${plan.parts.length} part(s) at ${maxTokens.toLocaleString()} tokens each:\n\n` +
          `${lines.join('\n')}\n\n` +
          `Fetch each with gitscribe_digest(repo, maxTokens: ${maxTokens}, part: N).` +
          rateNote(),
      }],
    };
  },
);

server.registerTool(
  'gitscribe_diff',
  {
    title: 'Digest a pull request, commit range, or branch comparison',
    description:
      'Digest only what changed. Reports GitHub\u2019s hard caps (300 files for a ' +
      'comparison, 3,000 for a pull request) rather than returning a partial diff silently.',
    inputSchema: {
      repo: z.string(),
      spec: z.string().describe('A PR number or URL, or a range like "v1.0...main".'),
      format: z.enum(['md', 'xml', 'json', 'txt']).optional(),
      redact: z.boolean().optional(),
    },
  },
  async ({ repo, spec, format, redact }) => {
    const { owner, repo: name } = parseRepo(repo);
    const parsed = parseChangeSpec(spec);
    const opts = redact !== undefined ? { redact } : {};
    const d =
      parsed.kind === 'pr'
        ? await fetchPullRequest(nodeEnv, client, owner, name, parsed.number, opts)
        : await fetchCompare(nodeEnv, client, owner, name, parsed.base, parsed.head, opts);

    const notes = d.truncations.map((t) => t.detail);
    const body = renderDiff(d, format ?? 'md');
    return {
      content: [{
        type: 'text' as const,
        text: notes.length ? `INCOMPLETE: ${notes.join(' ')}\n\n${body}` : body,
      }],
    };
  },
);

/* ----------------------------------------------------- README generation
 * The caller is already a language model, so this server never calls one and
 * needs no key. It supplies the chunks, the same prompts the extension uses,
 * and — the part that matters — a way to check the result against reality.
 */

server.registerTool(
  'gitscribe_readme_guide',
  {
    title: 'How to write a README that maps a codebase',
    description:
      'Returns the workflow and the exact prompts for turning a repository into ' +
      'a README a model can navigate by. Start here, then call ' +
      'gitscribe_readme_chunk for each part, then gitscribe_verify_readme.',
    inputSchema: {
      repo: z.string(),
      ref: z.string().optional(),
      exclude: z.array(z.string()).optional(),
      include: z.array(z.string()).optional(),
      maxTokens: z.number().optional().describe('Tokens per chunk. Default 120000.'),
    },
  },
  async ({ repo, ref, exclude, include, maxTokens }) => {
    const budget = maxTokens ?? 120_000;
    const { tree } = await resolveTree(repo, ref);
    const sel = applySelection(tree.files, selectionFrom(exclude, include));
    const pseudo = {
      owner: '', repo, ref: tree.ref,
      files: sel.files.map((f) => ({ path: f.path, text: '', tokens: f.tokens })),
      totalTokens: sel.totalTokens,
      estimated: true as const, truncations: [], redactions: [], generatedAt: Date.now(),
    };
    const plan = partitionDigest(pseudo, { budget });

    return {
      content: [{
        type: 'text' as const,
        text:
          `${sel.files.length} files, ~${sel.totalTokens.toLocaleString()} tokens (ESTIMATED), ` +
          `${plan.parts.length} chunk(s) at ${budget.toLocaleString()} tokens each.\n\n` +
          `WORKFLOW\n` +
          `1. For each part 1..${plan.parts.length}: call gitscribe_readme_chunk(repo, part) ` +
          `and write notes using the ANALYSIS PROMPT below. Keep the notes; discard the code.\n` +
          `2. Combine all notes and write the README using the SYNTHESIS PROMPT below.\n` +
          `3. Call gitscribe_verify_readme(repo, markdown) and fix anything it flags. ` +
          `Do not skip this: models invent filenames, and this check catches them.\n\n` +
          `=== ANALYSIS PROMPT ===\n${ANALYSIS_PROMPT}\n\n` +
          `=== SYNTHESIS PROMPT ===\n${SYNTHESIS_PROMPT}` + rateNote(),
      }],
    };
  },
);

server.registerTool(
  'gitscribe_readme_chunk',
  {
    title: 'Fetch one chunk of code to analyse',
    description:
      'Returns one part of the repository, sized to fit a context window, with ' +
      'the analysis instructions attached. Call once per part.',
    inputSchema: {
      repo: z.string(),
      part: z.number().describe('1-based part index.'),
      ref: z.string().optional(),
      exclude: z.array(z.string()).optional(),
      include: z.array(z.string()).optional(),
      maxTokens: z.number().optional().describe('Tokens per chunk. Default 120000.'),
    },
  },
  async ({ repo, part, ref, exclude, include, maxTokens }) => {
    const budget = maxTokens ?? 120_000;
    const { owner, repo: name, tree } = await resolveTree(repo, ref);
    const digest = await buildDigest(nodeEnv, client, owner, name, tree, {
      selection: selectionFrom(exclude, include),
    });
    const parts = renderParts(digest, 'md', { budget });
    if (part < 1 || part > parts.length) {
      throw new Error(`This repository splits into ${parts.length} part(s). Ask for 1..${parts.length}.`);
    }
    return {
      content: [{
        type: 'text' as const,
        text:
          `Write notes on the following code using these instructions.\n\n` +
          `=== INSTRUCTIONS ===\n${ANALYSIS_PROMPT}\n\n` +
          `=== CODE (part ${part} of ${parts.length}) ===\n${parts[part - 1]!}`,
      }],
    };
  },
);

server.registerTool(
  'gitscribe_verify_readme',
  {
    title: 'Check generated documentation against the real repository',
    description:
      'Compares every file path a document claims against the files that actually ' +
      'exist, and reports the ones that do not. Models invent filenames when ' +
      'describing code; this catches it. Always run this before presenting a ' +
      'generated README to a user.',
    inputSchema: {
      repo: z.string(),
      markdown: z.string().describe('The generated document to check.'),
      ref: z.string().optional(),
    },
  },
  async ({ repo, markdown, ref }) => {
    const { tree } = await resolveTree(repo, ref);
    const report = checkGrounding(markdown, tree.files.map((f) => f.path));

    if (report.unverified.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text:
            `PASS — all ${report.verified.length} file reference(s) in this document ` +
            `exist in ${repo}.` + rateNote(),
        }],
      };
    }
    return {
      content: [{
        type: 'text' as const,
        text:
          `FAIL — ${report.unverified.length} of ` +
          `${report.verified.length + report.unverified.length} referenced path(s) ` +
          `do NOT exist in ${repo}:\n\n` +
          report.unverified.map((p) => `  ${p}`).join('\n') +
          `\n\nThese are almost certainly fabricated. Remove them or replace them ` +
          `with real paths, then re-check. Verified references: ${report.verified.length}.` +
          rateNote(),
      }],
    };
  },
);

server.registerTool(
  'gitscribe_models',
  {
    title: 'List target models and their context windows',
    description:
      'List known models with context windows and where each number came from. ' +
      'Locally-running Ollama models are discovered at call time and are the ' +
      'only family whose window is exact rather than estimated.',
    inputSchema: {},
  },
  async () => {
    const rows = MODELS.map(
      (m) =>
        `  ${m.id.padEnd(28)} ${String(m.contextWindow).padStart(9)}  ${m.vendor} (${m.windowSource}, checked ${m.verifiedOn})`,
    );
    const ollama = await discoverOllama(nodeEnv.fetch);
    const local = ollama.length
      ? ollama.map((m) => `  ${m.name.padEnd(28)} ${String(m.contextWindow).padStart(9)}  Ollama (exact, read from the running server)`)
      : ['  (no local Ollama server responded at 127.0.0.1:11434)'];

    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Hosted models:\n${rows.join('\n')}\n\nLocal models:\n${local.join('\n')}\n\n` +
            `Token counts produced by GitScribe are ESTIMATES for every model except ` +
            `local Ollama windows. There is no public tokenizer for Claude, Gemini or Grok, ` +
            `so estimates are deliberately biased to over-count.`,
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
