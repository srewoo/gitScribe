import type { Digest } from './digest.js';
import type { CodeGraph, GraphView } from './graph.js';
import type { Tour } from './tour.js';
import { toMermaid } from './mermaid.js';

/**
 * What goes into a local snapshot of a repository, and what never does.
 *
 * A snapshot is handed to another tool (e.g. /brag) whose output may be posted
 * publicly, so the rules are stricter than the digest's: secrets are redacted
 * AND whole classes of sensitive file are not written at all. Every path is
 * checked before it touches the disk, because archive paths are untrusted.
 */

/** A safe relative path, normalised, or null if it could escape the snapshot root. */
export function safeRelative(path: string): string | null {
  if (!path || path.includes('\u0000') || path.includes('\\')) return null;
  if (path.startsWith('/') || /^[a-z]:/i.test(path)) return null;
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.length ? out.join('/') : null;
}

const SENSITIVE = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /credentials?[^/]*\.json$/i,
  /service[-_]?account[^/]*\.json$/i,
  /(^|\/)(secrets|credentials)\//i,
];

export function isSensitivePath(path: string): boolean {
  return SENSITIVE.some((re) => re.test(path));
}

const IMAGE = /\.(png|jpe?g|gif|svg|webp|ico|avif)$/i;
const BRAND_DIR = /(^|\/)(public|assets|static|images?|img|media)\//i;
const BRAND_NAME = /(logo|icon|favicon|screenshot|hero|og[-_]|banner|preview)/i;

export function isImage(path: string): boolean {
  return IMAGE.test(path);
}

/** Images worth handing to a video tool: small, capped, brand assets first. */
export function pickImages(
  files: ReadonlyArray<{ readonly path: string; readonly size: number }>,
  max = 40,
  maxBytes = 1_000_000,
): string[] {
  const rank = (p: string): number => (BRAND_NAME.test(p) ? 0 : 2) + (BRAND_DIR.test(p) ? 0 : 1);
  return files
    .filter((f) => isImage(f.path) && f.size <= maxBytes && !isSensitivePath(f.path))
    .sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path))
    .slice(0, max)
    .map((f) => f.path);
}

/** `.gitscribe/` contents: every line here is derived from the code. */
export function snapshotExtras(
  d: Digest,
  g: CodeGraph,
  view: GraphView,
  tour: Tour,
  skipped: readonly string[],
): Record<string, string> {
  const indeg = new Set(g.edges.map((e) => e.to));
  const entries = g.nodes.filter((n) => !indeg.has(n) && g.edges.some((e) => e.from === n));
  const fanIn = new Map<string, number>();
  for (const e of g.edges) fanIn.set(e.to, (fanIn.get(e.to) ?? 0) + 1);
  const core = [...fanIn].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
  const secrets = d.redactions.reduce((n, r) => n + r.count, 0);

  const facts = [
    `# ${d.owner}/${d.repo} @ ${d.ref}`,
    '',
    'Facts derived by GitScribe from the code. Use only these for any claim about how the project is built.',
    '',
    `- ${g.nodes.length} source files, ${g.edges.length} imports between them (every import was found in the code).`,
    `- Entry points (imported by nothing, import others): ${entries.join(', ') || 'none found'}.`,
    `- Most-used modules: ${core.map(([p, n]) => `${p} (imported by ${n})`).join(', ') || 'none'}.`,
    `- Packages used: ${g.external.join(', ') || 'none'}.`,
    `- Folders: ${[...new Set(view.boxes.map((b) => b.cluster).filter(Boolean))].join(', ') || '(flat)'}.`,
    '',
    '## Left out of this snapshot',
    `- ${secrets} secret(s) redacted in place.`,
    `- Not written at all (sensitive): ${skipped.join(', ') || 'none'}.`,
  ];
  return {
    'architecture.mmd': toMermaid(view),
    'tour.json': JSON.stringify(tour, null, 2),
    'facts.md': `${facts.join('\n')}\n`,
  };
}
