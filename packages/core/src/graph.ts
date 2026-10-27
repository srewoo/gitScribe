import type { Digest } from './digest.js';

/**
 * A repository's import graph, built from file text alone.
 *
 * Every edge is an import that resolves to a file actually in the digest. That
 * is the whole point: a diagram drawn from this cannot show a connection the
 * code does not make. Anything that does not resolve is reported, never
 * guessed — packages to `external`, the rest to `unresolved` with a reason.
 */

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
}

export interface Unresolved {
  readonly from: string;
  readonly specifier: string;
  /** `alias`: a path alias (`@/x`, `~/x`, `#x`) we do not read config for. */
  readonly reason: 'alias' | 'missing';
}

/** What a labelling model is allowed to see about a file. Never its body. */
export interface FileOutline {
  readonly path: string;
  /** Resolved repository paths this file imports. */
  readonly imports: readonly string[];
  readonly exports: readonly string[];
  readonly leadComment: string;
}

export interface CodeGraph {
  /** Source files, in digest order. */
  readonly nodes: readonly string[];
  readonly edges: readonly GraphEdge[];
  readonly unresolved: readonly Unresolved[];
  /** Package names imported, deduplicated. */
  readonly external: readonly string[];
  /** Files left out of the diagram because they are not code. */
  readonly skipped: readonly string[];
  readonly outline: readonly FileOutline[];
}

const CODE_EXT = /\.(?:[cm]?[jt]sx?|html?)$/i;
const ASSET = /\.(?:css|scss|sass|less|styl|png|jpe?g|gif|svg|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp[34]|wav|ogg|webm|json|txt|md|wasm|glsl|frag|vert)$/i;
const RESOLVE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_TO_TS: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'], '.jsx': ['.tsx'], '.mjs': ['.mts'], '.cjs': ['.cts'],
};

export function isCode(path: string): boolean {
  return CODE_EXT.test(path);
}

// ponytail: pattern matching, not a parser. An `import` inside a string or a
// comment can rarely yield a false edge; a real tokenizer is the upgrade path.
const STATIC_IMPORT = /\b(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"]([^'"\n]+)['"]/g;
const CALL_IMPORT = /\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const SCRIPT_SRC = /<script\b[^>]*?\bsrc\s*=\s*['"]([^'"]+)['"]/gi;

const NAMED_EXPORT =
  /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/g;
const CJS_EXPORT = /\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=/g;
const LEAD_COMMENT = /^\s*(?:#!.*\n\s*)?(\/\*[\s\S]*?\*\/|(?:\/\/[^\n]*\n?)+)/;
const HTML_TITLE = /<title>([^<]*)<\/title>/i;

function specifiers(path: string, text: string): string[] {
  const out: string[] = [];
  const res = /\.html?$/i.test(path) ? [SCRIPT_SRC] : [STATIC_IMPORT, CALL_IMPORT];
  for (const re of res) for (const m of text.matchAll(re)) out.push(m[1]!);
  return out;
}

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** Join and normalise `..`/`.` without touching the filesystem. */
function joinPath(base: string, rel: string): string {
  const parts = base ? base.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

function candidates(base: string): string[] {
  const out = [base];
  const ext = /\.[^./]+$/.exec(base)?.[0] ?? '';
  for (const alt of JS_TO_TS[ext] ?? []) out.push(base.slice(0, -ext.length) + alt);
  for (const e of RESOLVE_EXT) out.push(base + e);
  for (const e of RESOLVE_EXT) out.push(`${base}/index${e}`);
  return out;
}

function packageName(spec: string): string {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

type Resolution = { to: string } | { external: string } | { reason: Unresolved['reason'] } | null;

function resolve(from: string, raw: string, files: ReadonlySet<string>): Resolution {
  const spec = raw.replace(/[?#].*$/, '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(spec) || spec.startsWith('//')) return null;   // URL
  // `import './styles.css'` or an image is a bundler asset, not a code dependency.
  if (ASSET.test(spec)) return null;
  const find = (base: string): string | undefined => candidates(base).find((c) => files.has(c));

  if (spec.startsWith('/')) {
    // Root-relative: the repo root, or a nested app's own root (Vite's index.html).
    const hit = find(joinPath('', spec)) ?? find(joinPath(dirname(from), spec));
    return hit ? { to: hit } : { reason: 'missing' };
  }
  if (spec.startsWith('.')) {
    const hit = find(joinPath(dirname(from), spec));
    return hit ? { to: hit } : { reason: 'missing' };
  }
  // HTML `src="js/x.js"` is relative to the page, like `./js/x.js`.
  if (/\.html?$/i.test(from)) {
    const hit = find(joinPath(dirname(from), spec));
    return hit ? { to: hit } : { reason: 'missing' };
  }
  if (/^(?:@\/|~\/|#)/.test(spec)) return { reason: 'alias' };
  // `baseUrl`-style imports name a repo path directly.
  const rooted = find(joinPath('', spec));
  if (rooted) return { to: rooted };
  return { external: packageName(spec) };
}

function cleanComment(raw: string): string {
  return raw
    .replace(/^\/\*+|\*+\/$/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:\/\/+|\*)?\s?/, '').trim())
    .filter((l) => l && !l.startsWith('@'))
    .join(' ')
    .slice(0, 200);
}

function outlineOf(path: string, text: string, imports: string[]): FileOutline {
  const exports = new Set<string>();
  for (const re of [NAMED_EXPORT, CJS_EXPORT]) for (const m of text.matchAll(re)) exports.add(m[1]!);
  const lead = /\.html?$/i.test(path) ? HTML_TITLE.exec(text)?.[1] ?? '' : LEAD_COMMENT.exec(text)?.[1] ?? '';
  return { path, imports, exports: [...exports], leadComment: cleanComment(lead) };
}

export function buildGraph(d: Digest): CodeGraph {
  const nodes = d.files.filter((f) => isCode(f.path)).map((f) => f.path);
  const skipped = d.files.filter((f) => !isCode(f.path)).map((f) => f.path);
  const files = new Set(nodes);
  const edges: GraphEdge[] = [];
  const unresolved: Unresolved[] = [];
  const external = new Set<string>();
  const outline: FileOutline[] = [];

  for (const f of d.files) {
    if (!files.has(f.path)) continue;
    const targets = new Set<string>();
    for (const spec of specifiers(f.path, f.text)) {
      const r = resolve(f.path, spec, files);
      if (!r) continue;
      if ('to' in r) { if (r.to !== f.path) targets.add(r.to); }
      else if ('external' in r) external.add(r.external);
      else unresolved.push({ from: f.path, specifier: spec, reason: r.reason });
    }
    for (const to of targets) edges.push({ from: f.path, to });
    outline.push(outlineOf(f.path, f.text, [...targets]));
  }
  return { nodes, edges, unresolved, external: [...external], skipped, outline };
}

/* ---------------------------------------------------------------- grouping */

export interface Box {
  /** A file path in file mode; a folder key, or `(other)`, in module mode. */
  readonly id: string;
  readonly label: string;
  /** Folder the box is drawn inside. Empty for the repository root. */
  readonly cluster: string;
  readonly files: readonly string[];
}

export interface Link {
  readonly from: string;
  readonly to: string;
  /** Number of file-level imports this link stands for. */
  readonly weight: number;
}

export interface GraphView {
  readonly mode: 'file' | 'module';
  readonly boxes: readonly Box[];
  readonly links: readonly Link[];
}

export const MAX_BOXES = 40;
const OTHER = '(other)';

function moduleKey(path: string, depth: number): string {
  const dir = dirname(path);
  return dir ? dir.split('/').slice(0, depth).join('/') : '(root)';
}

/** Folder → box id, choosing the deepest depth that keeps the count within `max`. */
function moduleKeys(nodes: readonly string[], max: number): (path: string) => string {
  const maxDepth = Math.max(1, ...nodes.map((p) => dirname(p).split('/').length));
  for (let depth = maxDepth; depth >= 1; depth--) {
    const keys = new Set(nodes.map((p) => moduleKey(p, depth)));
    if (keys.size <= max) return (p) => moduleKey(p, depth);
  }
  // Even the top level is too wide: the biggest folders get boxes, the rest share one.
  const sizes = new Map<string, number>();
  for (const p of nodes) sizes.set(moduleKey(p, 1), (sizes.get(moduleKey(p, 1)) ?? 0) + 1);
  const kept = new Set(
    [...sizes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max - 1).map(([k]) => k),
  );
  return (p) => (kept.has(moduleKey(p, 1)) ? moduleKey(p, 1) : OTHER);
}

/**
 * Spend the box budget on detail: open the busiest modules into their files,
 * one at a time, while the total stays within `max`. A 46-file repo should not
 * collapse to six folders because it is six files over a hard threshold.
 */
function autoExpand(g: CodeGraph, moduleOf: (p: string) => string, max: number): Set<string> {
  const size = new Map<string, number>();
  const busy = new Map<string, number>();
  for (const p of g.nodes) size.set(moduleOf(p), (size.get(moduleOf(p)) ?? 0) + 1);
  for (const e of g.edges) {
    for (const m of new Set([moduleOf(e.from), moduleOf(e.to)])) busy.set(m, (busy.get(m) ?? 0) + 1);
  }
  let boxes = size.size;
  const open = new Set<string>();
  const order = [...size.keys()].sort((a, b) => (busy.get(b) ?? 0) - (busy.get(a) ?? 0) || a.localeCompare(b));
  for (const m of order) {
    const grow = size.get(m)! - 1;
    if (boxes + grow <= max) { open.add(m); boxes += grow; }
  }
  return open;
}

export function groupGraph(
  g: CodeGraph,
  max: number = MAX_BOXES,
  expanded: ReadonlySet<string> = new Set(),
): GraphView {
  const perFile = g.nodes.length <= max;
  const moduleOf = perFile ? (p: string) => p : moduleKeys(g.nodes, max);
  const open = perFile ? expanded : new Set([...expanded, ...autoExpand(g, moduleOf, max)]);
  const boxOf = (p: string): string => {
    const m = moduleOf(p);
    return open.has(m) ? p : m;
  };

  const members = new Map<string, string[]>();
  for (const p of g.nodes) {
    const id = boxOf(p);
    const list = members.get(id);
    if (list) list.push(p);
    else members.set(id, [p]);
  }

  const boxes: Box[] = [...members].map(([id, files]) => {
    const isFile = files.length === 1 && files[0] === id;
    const label = id.slice(id.lastIndexOf('/') + 1);
    // A file sits in its folder; a module sits in its parent folder.
    return { id, label, cluster: isFile ? dirname(id) : id === OTHER ? '' : dirname(id), files };
  });

  const weights = new Map<string, number>();
  for (const e of g.edges) {
    const from = boxOf(e.from);
    const to = boxOf(e.to);
    if (from === to) continue;
    const key = `${from}\u0000${to}`;
    weights.set(key, (weights.get(key) ?? 0) + 1);
  }
  const links = [...weights].map(([key, weight]) => {
    const [from, to] = key.split('\u0000') as [string, string];
    return { from, to, weight };
  });

  return { mode: perFile ? 'file' : 'module', boxes, links };
}
