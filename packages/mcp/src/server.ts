#!/usr/bin/env node
/**
 * GitScribe MCP server.
 *
 * A thin stdio wrapper over @gitscribe/core. No server, no account, no API key
 * of its own. GITHUB_TOKEN is optional and only raises GitHub's rate limit;
 * GITLAB_TOKEN is optional and reaches private GitLab projects.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createRequire } from 'node:module';
import { z } from 'zod';

import { writeSnapshot } from './snapshot.js';

import {
  GitHubClient,
  GitLabClient,
  parseTarget,
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
  fetchMergeRequest,
  fetchGitLabCompare,
  parseChangeSpec,
  renderDiff,
  checkGrounding,
  buildGraph,
  groupGraph,
  labelRequest,
  validateLabels,
  toMermaid,
  LABEL_PROMPT,
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
const gitlabToken = process.env['GITLAB_TOKEN'];
const gitlabClients = new Map<string, GitLabClient>();

const REPO_HELP =
  'owner/repo, a github.com or gitlab.com URL, a self-managed GitLab URL, or "gitlab:group/sub/project"';

const SIZES_UNKNOWN =
  'GitLab refused the archive download and its file sizes could not be looked up, so ' +
  'token figures are UNKNOWN, not zero.' +
  ' gitscribe_digest still works and reports real counts.';

type Repo =
  | { forge: 'github'; client: GitHubClient; owner: string; repo: string; ref?: string }
  | { forge: 'gitlab'; client: GitLabClient; owner: ''; repo: string; ref?: string };

/** GitHub or GitLab, from a URL or shorthand. GitLab passes its full project path as `repo`. */
function parseRepo(input: string): Repo {
  const t = parseTarget(input);
  if (!t) throw new Error(`Could not read a repository from ${JSON.stringify(input)}. Use ${REPO_HELP}.`);
  const ref = t.ref ? { ref: t.ref } : {};
  if (t.forge === 'gitlab') {
    const host = t.host ?? 'gitlab.com';
    let gl = gitlabClients.get(host);
    if (!gl) gitlabClients.set(host, (gl = new GitLabClient(nodeEnv, { token: gitlabToken, host })));
    return { forge: 'gitlab', client: gl, owner: '', repo: t.project, ...ref };
  }
  const [owner, repo] = t.project.split('/') as [string, string];
  return { forge: 'github', client, owner, repo, ...ref };
}

function selectionFrom(exclude?: string[], include?: string[]): Selection {
  return {
    exclude: exclude ?? [...DEFAULT_EXCLUDES],
    include: include ?? [],
    overrides: {},
  };
}

async function resolveTree(repoInput: string, ref?: string) {
  const r = parseRepo(repoInput);
  const wanted = ref ?? r.ref;
  if (r.forge === 'gitlab') {
    const useRef = wanted ?? (await r.client.getRepoInfo(r.repo)).defaultBranch;
    return { ...r, tree: await r.client.getTree(r.repo, useRef) };
  }
  const useRef = wanted ?? (await r.client.getRepo(r.owner, r.repo)).defaultBranch;
  return { ...r, tree: await r.client.getTree(r.owner, r.repo, useRef) };
}

function rateNote(r: Pick<Repo, 'forge' | 'client'> = { forge: 'github', client }): string {
  const rl = r.client.rateLimit;
  if (!rl) return '';
  if (r.forge === 'gitlab') {
    return `\n\nGitLab requests remaining this minute: ${rl.remaining}/${rl.limit}${
      gitlabToken ? '' : ' (anonymous; set GITLAB_TOKEN for private projects)'
    }`;
  }
  return `\n\nGitHub requests remaining: ${rl.remaining}/${rl.limit}${
    token ? '' : ' (anonymous; set GITHUB_TOKEN to raise this to 5,000/hour)'
  }`;
}

// Reported to MCP clients; read from package.json so it cannot drift from the published version.
const { version } = createRequire(import.meta.url)('../package.json') as { version: string };
const server = new McpServer({ name: 'gitscribe', version });

/* ---------------------------------------------------------------- tools */

server.registerTool(
  'gitscribe_tree',
  {
    title: 'List a repository with per-file token estimates',
    description:
      'List every file in a GitHub or GitLab repository with its size and ESTIMATED token cost. ' +
      'Costs 1-2 API requests regardless of repository size. Use this before ' +
      'gitscribe_digest to decide what to include.',
    inputSchema: {
      repo: z.string().describe(REPO_HELP),
      ref: z.string().optional().describe('Branch, tag or commit SHA. Defaults to the default branch.'),
      exclude: z.array(z.string()).optional().describe('Glob rules to exclude. Omit for sensible defaults.'),
      include: z.array(z.string()).optional().describe('Glob rules to restrict to.'),
    },
  },
  async ({ repo, ref, exclude, include }) => {
    const r = await resolveTree(repo, ref);
    const { tree } = r;
    const sel = applySelection(tree.files, selectionFrom(exclude, include));
    const lines = sel.files
      .slice()
      .sort((a, b) => b.tokens - a.tokens)
      .map((f) => `${(tree.sizesUnknown ? '?' : String(f.tokens)).padStart(8)}  ${f.path}`);

    const warning = tree.truncated
      ? `\n\nWARNING: ${r.forge === 'gitlab' ? 'GitLab' : 'GitHub'} truncated this listing. Files beyond the cap are not listed.`
      : '';
    const total = tree.sizesUnknown
      ? `${sel.files.length} files selected. ${SIZES_UNKNOWN}`
      : `${sel.files.length} files selected, approximately ${sel.totalTokens.toLocaleString()} tokens ` +
        `(ESTIMATED — no public tokenizer exists for most models; counts are biased to over-count).`;

    return {
      content: [
        {
          type: 'text' as const,
          text:
            `${total}\n\n  tokens  path\n${lines.join('\n')}${warning}${rateNote(r)}`,
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
      repo: z.string().describe(REPO_HELP),
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
    const r = await resolveTree(repo, ref);
    const selection = selectionFrom(exclude, include);
    const digest = await buildDigest(nodeEnv, r.client, r.owner, r.repo, r.tree, {
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
      repo: z.string().describe(REPO_HELP),
      ref: z.string().optional(),
      exclude: z.array(z.string()).optional(),
      include: z.array(z.string()).optional(),
      model: z.string().optional().describe('Model id from gitscribe_models. Default: claude-opus-5'),
      reserve: z.number().optional().describe(`Tokens held back for prompt and reply. Default: ${DEFAULT_RESERVE}`),
    },
  },
  async ({ repo, ref, exclude, include, model, reserve }) => {
    const r = await resolveTree(repo, ref);
    const { tree } = r;
    if (tree.sizesUnknown) throw new Error(`Cannot estimate ${repo}. ${SIZES_UNKNOWN}${tree.sizesNote ? ` ${tree.sizesNote}` : ''}`);
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
      tree.archiveRefused
        ? `Fetching this would cost ${sel.files.length} request(s): GitLab refused the archive, so files are read one by one.`
        : `Fetching this would cost ${requestCost(strategy, sel.files)} request(s) via the ${strategy} path.`,
    ];

    if (over > 0) {
      const drops = suggestDrops(sel.files, over);
      lines.push('', 'Dropping these would bring it under, largest first:');
      for (const d of drops) lines.push(`  ${String(d.tokens).padStart(8)}  ${d.path}`);
    }
    return { content: [{ type: 'text' as const, text: lines.join('\n') + rateNote(r) }] };
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
      repo: z.string().describe(REPO_HELP),
      ref: z.string().optional(),
      exclude: z.array(z.string()).optional(),
      include: z.array(z.string()).optional(),
      maxTokens: z.number().describe('Usable tokens per part.'),
    },
  },
  async ({ repo, ref, exclude, include, maxTokens }) => {
    const r = await resolveTree(repo, ref);
    const { tree } = r;
    if (tree.sizesUnknown) throw new Error(`Cannot plan parts for ${repo}. ${SIZES_UNKNOWN}${tree.sizesNote ? ` ${tree.sizesNote}` : ''}`);
    const sel = applySelection(tree.files, selectionFrom(exclude, include));
    // Plan from tree sizes alone — no content is fetched.
    const pseudo = {
      owner: r.owner, repo: r.repo, ref: tree.ref,
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
          rateNote(r),
      }],
    };
  },
);

server.registerTool(
  'gitscribe_diff',
  {
    title: 'Digest a pull request, commit range, or branch comparison',
    description:
      'Digest only what changed: a GitHub pull request or GitLab merge request, or a commit range. Reports GitHub\u2019s hard caps (300 files for a ' +
      'comparison, 3,000 for a pull request) rather than returning a partial diff silently.',
    inputSchema: {
      repo: z.string().describe(REPO_HELP),
      spec: z.string().describe('A PR/MR number ("123" or "!123"), a PR/MR URL, or a range like "v1.0...main".'),
      format: z.enum(['md', 'xml', 'json', 'txt']).optional(),
      redact: z.boolean().optional(),
    },
  },
  async ({ repo, spec, format, redact }) => {
    const r = parseRepo(repo);
    const parsed = parseChangeSpec(spec);
    const opts = redact !== undefined ? { redact } : {};
    const d = r.forge === 'gitlab'
      ? parsed.kind === 'pr'
        ? await fetchMergeRequest(nodeEnv, r.client, r.repo, parsed.number, opts)
        : await fetchGitLabCompare(nodeEnv, r.client, r.repo, parsed.base, parsed.head, opts)
      : parsed.kind === 'pr'
        ? await fetchPullRequest(nodeEnv, r.client, r.owner, r.repo, parsed.number, opts)
        : await fetchCompare(nodeEnv, r.client, r.owner, r.repo, parsed.base, parsed.head, opts);

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
      repo: z.string().describe(REPO_HELP),
      ref: z.string().optional(),
      exclude: z.array(z.string()).optional(),
      include: z.array(z.string()).optional(),
      maxTokens: z.number().optional().describe('Tokens per chunk. Default 120000.'),
    },
  },
  async ({ repo, ref, exclude, include, maxTokens }) => {
    const budget = maxTokens ?? 120_000;
    const r = await resolveTree(repo, ref);
    const { tree } = r;
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
          (tree.sizesUnknown
            ? `${sel.files.length} files. ${SIZES_UNKNOWN} The chunk count is known only once ` +
              `part 1 is fetched: gitscribe_readme_chunk reports "part 1 of N".\n\n`
            : `${sel.files.length} files, ~${sel.totalTokens.toLocaleString()} tokens (ESTIMATED), ` +
              `${plan.parts.length} chunk(s) at ${budget.toLocaleString()} tokens each.\n\n`) +
          `WORKFLOW\n` +
          `1. For each part 1..${tree.sizesUnknown ? 'N' : plan.parts.length}: call gitscribe_readme_chunk(repo, part) ` +
          `and write notes using the ANALYSIS PROMPT below. Keep the notes; discard the code.\n` +
          `2. Combine all notes and write the README using the SYNTHESIS PROMPT below.\n` +
          `3. Call gitscribe_verify_readme(repo, markdown) and fix anything it flags. ` +
          `Do not skip this: models invent filenames, and this check catches them.\n\n` +
          `=== ANALYSIS PROMPT ===\n${ANALYSIS_PROMPT}\n\n` +
          `=== SYNTHESIS PROMPT ===\n${SYNTHESIS_PROMPT}` + rateNote(r),
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
      repo: z.string().describe(REPO_HELP),
      part: z.number().describe('1-based part index.'),
      ref: z.string().optional(),
      exclude: z.array(z.string()).optional(),
      include: z.array(z.string()).optional(),
      maxTokens: z.number().optional().describe('Tokens per chunk. Default 120000.'),
    },
  },
  async ({ repo, part, ref, exclude, include, maxTokens }) => {
    const budget = maxTokens ?? 120_000;
    const r = await resolveTree(repo, ref);
    const digest = await buildDigest(nodeEnv, r.client, r.owner, r.repo, r.tree, {
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
      repo: z.string().describe(REPO_HELP),
      markdown: z.string().describe('The generated document to check.'),
      ref: z.string().optional(),
    },
  },
  async ({ repo, markdown, ref }) => {
    const r = await resolveTree(repo, ref);
    const { tree } = r;
    const report = checkGrounding(markdown, tree.files.map((f) => f.path));

    if (report.unverified.length === 0) {
      return {
        content: [{
          type: 'text' as const,
          text:
            `PASS — all ${report.verified.length} file reference(s) in this document ` +
            `exist in ${repo}.` + rateNote(r),
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
          rateNote(r),
      }],
    };
  },
);

server.registerTool(
  'gitscribe_diagram',
  {
    title: 'Architecture diagram whose arrows are real imports',
    description:
      'Build a diagram of which files import which (JS/TS/HTML), as Mermaid. Every arrow ' +
      'is an import found in the code; nothing is inferred. Small repos get one box per ' +
      'file, large ones one box per module (max 40). To add plain-English names: label ' +
      'the returned outline with the returned prompt, then call again with `labels` set ' +
      'to your JSON reply. Invented boxes or connections in `labels` are dropped and reported.',
    inputSchema: {
      repo: z.string().describe(REPO_HELP),
      ref: z.string().optional(),
      exclude: z.array(z.string()).optional(),
      include: z.array(z.string()).optional(),
      labels: z.string().optional().describe('Your JSON reply to the labelling prompt from a previous call.'),
    },
  },
  async ({ repo, ref, exclude, include, labels }) => {
    const r = await resolveTree(repo, ref);
    const digest = await buildDigest(nodeEnv, r.client, r.owner, r.repo, r.tree, {
      selection: selectionFrom(exclude, include),
    });
    const graph = buildGraph(digest);
    const view = groupGraph(graph);
    const checked = labels ? validateLabels(view, labels) : undefined;

    const report: string[] = [
      `${graph.nodes.length} source files, ${graph.edges.length} imports, ` +
        `${view.boxes.length} boxes (${view.mode === 'file' ? 'one per file'
          : `${view.boxes.filter((b) => b.files.length > 1).length} grouped folders, the rest single files`}).`,
    ];
    if (graph.unresolved.length) {
      report.push(`${graph.unresolved.length} import(s) could not be resolved and are not drawn: ` +
        graph.unresolved.slice(0, 20).map((u) => `${u.from} → ${u.specifier} (${u.reason})`).join('; '));
    }
    if (graph.skipped.length) report.push(`${graph.skipped.length} non-code file(s) left out.`);
    if (graph.external.length) report.push(`External packages: ${graph.external.slice(0, 30).join(', ')}.`);
    if (checked?.warning) report.push(checked.warning);
    if (checked?.dropped.length) {
      report.push(`${checked.dropped.length} invented claim(s) dropped: ${checked.dropped.join('; ')}.`);
    }

    const mermaid = toMermaid(view, checked?.labels);
    const labelling = labels
      ? ''
      : `\n\n=== TO LABEL IT ===\nAnswer this prompt, then call gitscribe_diagram again with labels set to your JSON.\n\n` +
        `${LABEL_PROMPT}\n\n${labelRequest(graph, view)}`;
    return {
      content: [{
        type: 'text' as const,
        text: `${report.join('\n')}\n\n\`\`\`mermaid\n${mermaid}\n\`\`\`${labelling}${rateNote(r)}`,
      }],
    };
  },
);

server.registerTool(
  'gitscribe_snapshot',
  {
    title: 'Write a repository into a local folder (for /brag and other tools)',
    description:
      'Copy a GitHub/GitLab repository, pinned to one commit, into a local folder without ' +
      'cloning: text files with secrets redacted, small images (logos, screenshots), and a ' +
      '.gitscribe/ folder with the import diagram, a code-only tour, and checked facts. Env ' +
      'files, keys and credential files are never written. Returns the folder path.',
    inputSchema: {
      repo: z.string().describe(REPO_HELP),
      ref: z.string().optional(),
      exclude: z.array(z.string()).optional(),
      include: z.array(z.string()).optional(),
      dir: z.string().optional().describe('Target folder. Default: <os temp>/gitscribe/<owner>-<repo>-<sha>.'),
    },
  },
  async ({ repo, ref, exclude, include, dir }) => {
    const r = await resolveTree(repo, ref);
    // Pin to a commit, so the files, the archive and the facts all describe one version.
    const commit = r.forge === 'github'
      ? await r.client.resolveCommit(r.owner, r.repo, r.tree.ref)
      : await r.client.resolveCommit(r.repo, r.tree.ref);
    const out = await writeSnapshot({
      forge: r.forge, client: r.client, owner: r.owner, repo: r.repo, tree: { ...r.tree, ref: commit },
      selection: selectionFrom(exclude, include), dir,
    });
    const lines = [
      `Snapshot written to ${out.dir}`,
      `${out.textFiles} text file(s), ${out.images} image(s), ${out.redacted} secret(s) redacted in place.`,
      `GitScribe facts: ${out.dir}/.gitscribe/facts.md, tour.json, architecture.mmd`,
      out.skipped.length ? `Not written: ${out.skipped.join(', ')}.` : 'Nothing was skipped.',
    ];
    if (r.tree.sizesUnknown) lines.push('GitLab reported no file sizes, so image size limits were applied after download.');
    return { content: [{ type: 'text' as const, text: lines.join('\n') + rateNote(r) }] };
  },
);

server.registerPrompt(
  'promo',
  {
    title: 'Promo video for a repository (via /brag)',
    description: 'Snapshot a GitHub/GitLab repo with GitScribe, then make a brag-style promo video of it.',
    argsSchema: {
      repo: z.string().describe(REPO_HELP),
      tone: z.string().optional().describe('Optional /brag tone or creative direction, e.g. "polished" or "fake Series A launch".'),
    },
  },
  ({ repo, tone }) => ({
    messages: [{
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: [
          `Make a promo video for the repository ${repo}.`,
          '',
          `1. Call the gitscribe_snapshot tool with repo "${repo}". It writes the repository into a local folder and returns its path.`,
          '2. Run the /brag skill on that folder as the project directory (read and write there, not in the current working directory)' +
            (tone ? `, with tone: ${tone}` : '') + '.',
          '3. Direction for /brag: the product story comes from the project itself, as usual. You may add ONE short "how it\'s built" beat. ' +
            'If you do, every claim in it must come from .gitscribe/facts.md or .gitscribe/tour.json in that folder; .gitscribe/architecture.mmd shows the real import graph. ' +
            'Do not invent modules, connections or numbers.',
          '4. When done, report the folder, the rendered video path, and the share copy.',
          '',
          'If gitscribe_snapshot reports that files were not written (env files, keys), do not try to obtain them.',
          '',
          'If no /brag skill is available, stop after step 1: report the snapshot folder and say that the brag ' +
            'plugin (https://github.com/latent-spaces/brag) is needed to make the video. Do not improvise a video pipeline.',
        ].join('\n'),
      },
    }],
  }),
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
