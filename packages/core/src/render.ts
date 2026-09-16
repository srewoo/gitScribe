import type { Digest } from './digest.js';
import type { DiffDigest } from './diff.js';
import { partitionDigest, partManifest, type PartitionOptions } from './partition.js';

export type Format = 'md' | 'xml' | 'json' | 'txt';

const LANG: Readonly<Record<string, string>> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', py: 'python', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', rb: 'ruby', php: 'php', c: 'c', h: 'c', cc: 'cpp',
  cpp: 'cpp', cs: 'csharp', swift: 'swift', sh: 'bash', yml: 'yaml', yaml: 'yaml',
  json: 'json', md: 'markdown', html: 'html', css: 'css', sql: 'sql', toml: 'toml',
};

function langOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return LANG[ext] ?? '';
}

/** Longest run of backticks in the text, so a fence can always escape it. */
function fenceFor(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function directoryTree(paths: readonly string[]): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const p of [...paths].sort()) {
    const parts = p.split('/');
    for (let i = 0; i < parts.length; i++) {
      const prefix = parts.slice(0, i + 1).join('/');
      if (seen.has(prefix)) continue;
      seen.add(prefix);
      const isFile = i === parts.length - 1;
      lines.push(`${'  '.repeat(i)}${parts[i]}${isFile ? '' : '/'}`);
    }
  }
  return lines.join('\n');
}

function header(d: Digest): string {
  const when = new Date(d.generatedAt).toISOString();
  return [
    `${d.owner}/${d.repo} at ${d.ref}`,
    `${d.files.length} files, approximately ${d.totalTokens.toLocaleString()} tokens (estimated)`,
    `Generated ${when} by GitScribe`,
  ].join('\n');
}

function truncationLines(d: Digest): string[] {
  const lines: string[] = [];
  if (d.truncations.length > 0) {
    lines.push('', 'INCOMPLETE — the following could not be included:');
    for (const t of d.truncations) {
      lines.push(`- ${t.detail}`);
      for (const p of t.paths ?? []) lines.push(`    ${p}`);
    }
  }
  if (d.redactions.length > 0) {
    const n = d.redactions.reduce((sum, r) => sum + r.count, 0);
    lines.push('', `REDACTED — ${n} probable secret(s) replaced before this digest was produced:`);
    for (const r of d.redactions) lines.push(`- ${r.path}: ${r.count} x ${r.kind}`);
  }
  return lines;
}

function renderMarkdown(d: Digest): string {
  const parts: string[] = [
    `# ${d.owner}/${d.repo}`,
    '',
    header(d),
    ...truncationLines(d),
    '',
    '## Directory structure',
    '',
    '```',
    directoryTree(d.files.map((f) => f.path)),
    '```',
    '',
  ];
  for (const f of d.files) {
    const fence = fenceFor(f.text);
    parts.push(`## ${f.path}`, '', `${fence}${langOf(f.path)}`, f.text, fence, '');
  }
  return parts.join('\n');
}

function escapeXml(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
}

function renderXml(d: Digest): string {
  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<digest repo="${d.owner}/${d.repo}" ref="${d.ref}" estimated="true" tokens="${d.totalTokens}">`,
  ];
  for (const t of d.truncations) {
    parts.push(`  <truncation kind="${t.kind}">${escapeXml(t.detail)}</truncation>`);
  }
  for (const r of d.redactions) {
    parts.push(
      `  <redaction path="${escapeXml(r.path)}" kind="${r.kind}" count="${r.count}" />`,
    );
  }
  for (const f of d.files) {
    parts.push(`  <file path="${escapeXml(f.path)}" tokens="${f.tokens}">`);
    parts.push(`    <![CDATA[${f.text.split(']]>').join(']]]]><![CDATA[>')}]]>`);
    parts.push('  </file>');
  }
  parts.push('</digest>');
  return parts.join('\n');
}

function renderJson(d: Digest): string {
  return JSON.stringify(
    {
      repo: `${d.owner}/${d.repo}`,
      ref: d.ref,
      generatedAt: d.generatedAt,
      estimated: true,
      tokens: d.totalTokens,
      truncations: d.truncations,
      redactions: d.redactions,
      files: d.files,
    },
    null,
    2,
  );
}

function renderText(d: Digest): string {
  const rule = '='.repeat(56);
  const parts = [header(d), ...truncationLines(d), ''];
  for (const f of d.files) {
    parts.push(rule, `FILE: ${f.path}`, rule, f.text, '');
  }
  return parts.join('\n');
}

export function render(d: Digest, format: Format): string {
  switch (format) {
    case 'md': return renderMarkdown(d);
    case 'xml': return renderXml(d);
    case 'json': return renderJson(d);
    case 'txt': return renderText(d);
  }
}

/* ---------------------------------------------------------------- diffs */

function diffNotes(d: DiffDigest): string[] {
  const lines: string[] = [];
  if (d.truncations.length > 0) {
    lines.push('', 'INCOMPLETE — the following could not be included:');
    for (const t of d.truncations) {
      lines.push(`- ${t.detail}`);
      for (const p of t.paths ?? []) lines.push(`    ${p}`);
    }
  }
  if (d.redactions.length > 0) {
    const n = d.redactions.reduce((sum, r) => sum + r.count, 0);
    lines.push('', `REDACTED — ${n} probable secret(s) replaced.`);
    for (const r of d.redactions) lines.push(`- ${r.path}: ${r.count} x ${r.kind}`);
  }
  return lines;
}

export function renderDiff(d: DiffDigest, format: Format): string {
  const head = [
    `${d.owner}/${d.repo} — ${d.title}`,
    `${d.files.length} changed files, +${d.additions} -${d.deletions}`,
    `approximately ${d.totalTokens.toLocaleString()} tokens (estimated)`,
    `Generated ${new Date(d.generatedAt).toISOString()} by GitScribe`,
  ];

  if (format === 'json') {
    return JSON.stringify(
      {
        repo: `${d.owner}/${d.repo}`,
        kind: d.kind,
        base: d.base,
        head: d.head,
        title: d.title,
        estimated: true,
        tokens: d.totalTokens,
        additions: d.additions,
        deletions: d.deletions,
        truncations: d.truncations,
        redactions: d.redactions,
        files: d.files,
      },
      null,
      2,
    );
  }

  if (format === 'xml') {
    const parts = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<changes repo="${d.owner}/${d.repo}" kind="${d.kind}" base="${escapeXml(d.base)}" head="${escapeXml(d.head)}" estimated="true" tokens="${d.totalTokens}">`,
    ];
    for (const t of d.truncations) {
      parts.push(`  <truncation kind="${t.kind}">${escapeXml(t.detail)}</truncation>`);
    }
    for (const r of d.redactions) {
      parts.push(`  <redaction path="${escapeXml(r.path)}" kind="${r.kind}" count="${r.count}" />`);
    }
    for (const f of d.files) {
      parts.push(
        `  <file path="${escapeXml(f.path)}" status="${f.status}" additions="${f.additions}" deletions="${f.deletions}">`,
      );
      if (f.patch !== null) {
        parts.push(`    <![CDATA[${f.patch.split(']]>').join(']]]]><![CDATA[>')}]]>`);
      }
      parts.push('  </file>');
    }
    parts.push('</changes>');
    return parts.join('\n');
  }

  const parts = [
    format === 'md' ? `# ${d.owner}/${d.repo} — ${d.title}` : head[0]!,
    '',
    ...head.slice(1),
    ...diffNotes(d),
    '',
  ];

  if (format === 'md') {
    parts.push('## Changed files', '');
    for (const f of d.files) {
      parts.push(`- \`${f.path}\` — ${f.status}, +${f.additions} -${f.deletions}`);
    }
    parts.push('');
    for (const f of d.files) {
      if (f.patch === null) continue;
      const fence = fenceFor(f.patch);
      parts.push(`## ${f.path}`, '', `${fence}diff`, f.patch, fence, '');
    }
  } else {
    const rule = '='.repeat(56);
    for (const f of d.files) {
      parts.push(rule, `FILE: ${f.path}  (${f.status}, +${f.additions} -${f.deletions})`, rule);
      parts.push(f.patch ?? '(no rendered diff)', '');
    }
  }
  return parts.join('\n');
}

/* ------------------------------------------------------- chunked rendering */

/**
 * Render a digest as N self-describing parts, each fitting `budget` tokens.
 *
 * Every part states its position, lists what the other parts hold, and repeats
 * the incompleteness notices — a model reading part 4 alone must not mistake it
 * for the whole repository.
 */
export function renderParts(d: Digest, format: Format, opts: PartitionOptions): string[] {
  const p = partitionDigest(d, opts);
  const manifest = partManifest(p);

  return p.parts.map((part) => {
    const partDigest: Digest = { ...d, files: part.files, totalTokens: part.tokens };
    const body = render(partDigest, format);

    if (p.single) return body;

    const head = [
      `PART ${part.index} OF ${part.total} — ${d.owner}/${d.repo} at ${d.ref}`,
      '',
      `This is one slice of a repository too large for a single context window.`,
      `It holds ${part.files.length} of ${d.files.length} files, approximately ` +
        `${part.tokens.toLocaleString()} of ${d.totalTokens.toLocaleString()} tokens (estimated).`,
      part.index < part.total
        ? `Do not treat this as the complete repository; ${part.total - part.index} further part(s) follow.`
        : `This is the final part.`,
      '',
      'All parts:',
      manifest,
    ];
    if (part.oversized.length > 0) {
      head.push(
        '',
        `NOTE: the following file exceeds the per-part budget on its own and was ` +
          `not split, so this part is larger than the budget: ${part.oversized.join(', ')}`,
      );
    }

    if (format === 'json') {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      parsed['part'] = { index: part.index, total: part.total, oversized: part.oversized };
      parsed['partsManifest'] = p.parts.map((x) => ({
        index: x.index, files: x.files.length, tokens: x.tokens,
      }));
      return JSON.stringify(parsed, null, 2);
    }
    if (format === 'xml') {
      return body.replace(
        /^<digest /m,
        `<!-- ${head.join(' | ').replace(/--/g, '-')} -->\n<digest part="${part.index}" parts="${part.total}" `,
      );
    }
    // head entries can themselves be multi-line (the manifest), so flatten
    // before prefixing or the continuation lines fall out of the blockquote.
    const headLines = head.join('\n').split('\n');
    const prefix =
      format === 'md' ? headLines.map((l) => (l ? `> ${l}` : '>')).join('\n') : headLines.join('\n');
    return `${prefix}\n\n${body}`;
  });
}
