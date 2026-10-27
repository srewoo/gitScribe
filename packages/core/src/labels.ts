import type { CodeGraph, GraphView } from './graph.js';

/**
 * Model-supplied names for a diagram — and the check that keeps them honest.
 *
 * The model sees the outline (paths, imports, exported names, a leading
 * comment), never file bodies. It may name boxes, folders and existing links.
 * It may not add a file, a folder or a connection: anything it mentions that
 * the graph does not contain is dropped and reported.
 */

export interface DiagramLabels {
  readonly boxes: Readonly<Record<string, string>>;
  readonly clusters: Readonly<Record<string, string>>;
  /** Keyed by `linkKey(from, to)`. */
  readonly links: Readonly<Record<string, string>>;
  /** Who or what uses the system, drawn as a starting point. */
  readonly entry?: string;
}

export interface LabelResult {
  readonly labels: DiagramLabels;
  /** Human-readable claims that were thrown away: not in the code. */
  readonly dropped: readonly string[];
  /** Real files the model named that are drawn inside a grouped folder box. */
  readonly grouped: readonly string[];
  readonly warning?: string;
}

const MAX_LABEL = 60;

export const emptyLabels = (): DiagramLabels => ({ boxes: {}, clusters: {}, links: {} });

export const linkKey = (from: string, to: string): string => `${from} → ${to}`;

/**
 * The box a model meant. Exact ids win; otherwise a short name (`fill.js` for
 * `js/fill.js`) counts only if exactly one box has it. Models abbreviate
 * constantly (measured: 35 of 37 labels from a 7B local model), and an
 * unambiguous abbreviation cannot point anywhere that is not in the code.
 */
export function resolveBox(view: GraphView, key: string): string | null {
  if (view.boxes.some((b) => b.id === key)) return key;
  const hits = view.boxes.filter((b) => b.label === key || b.id.endsWith(`/${key}`));
  return hits.length === 1 ? hits[0]!.id : null;
}

export const LABEL_PROMPT = `You name the parts of a software architecture diagram.

You are given boxes (files or folders), the folders that group them, and the
import links between boxes. These links are facts taken from the code. Your
job is ONLY to give short, plain-English names. Do not invent anything.

Reply with ONE JSON object and nothing else:
{
  "boxes":    { "<box id>": "<2-5 word name of what it does>" },
  "clusters": { "<folder>": "<2-4 word name for the group>" },
  "links":    [ { "from": "<box id>", "to": "<box id>", "verb": "<2-4 words>" } ],
  "entry":    "<who uses this system, 1-3 words>"
}

Rules:
- Use box ids and folders exactly as given. Never add new ones.
- Only label links that are listed. Never add a link or reverse one.
- Names describe purpose ("Region fill engine"), not file names.
- Keep every name under ${MAX_LABEL} characters.`;

/** The user message for a labelling call: structure only, never code. */
export function labelRequest(g: CodeGraph, view: GraphView): string {
  const byPath = new Map(g.outline.map((o) => [o.path, o]));
  const lines: string[] = ['BOXES'];
  for (const b of view.boxes) {
    lines.push(`- id: ${b.id}${b.cluster ? `  (folder: ${b.cluster})` : ''}`);
    for (const path of b.files.slice(0, 12)) {
      const o = byPath.get(path);
      const exp = o?.exports.length ? `  exports: ${o.exports.slice(0, 8).join(', ')}` : '';
      const doc = o?.leadComment ? `  — ${o.leadComment}` : '';
      lines.push(`    ${path}${exp}${doc}`);
    }
    if (b.files.length > 12) lines.push(`    … and ${b.files.length - 12} more files`);
  }
  const folders = [...new Set(view.boxes.map((b) => b.cluster).filter(Boolean))];
  lines.push('', 'FOLDERS', ...folders.map((f) => `- ${f}`));
  lines.push('', 'LINKS (from imports to)', ...view.links.map((l) => `- ${l.from} -> ${l.to}`));
  return lines.join('\n');
}

function parseJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)?.[1];
  const body = fenced ?? raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function cleanLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, MAX_LABEL) : null;
}

export function validateLabels(view: GraphView, raw: string): LabelResult {
  const parsed = parseJson(raw);
  if (!isRecord(parsed)) {
    return { labels: emptyLabels(), dropped: [], grouped: [], warning: 'The model reply was not valid JSON, so the diagram is unlabelled.' };
  }

  const folders = new Set(view.boxes.map((b) => b.cluster).filter(Boolean));
  const realLinks = new Set(view.links.map((l) => linkKey(l.from, l.to)));
  const dropped: string[] = [];
  const grouped: string[] = [];
  const inGroup = new Set(view.boxes.filter((b) => b.files.length > 1).flatMap((b) => b.files));
  const boxes: Record<string, string> = {};
  const clusters: Record<string, string> = {};
  const links: Record<string, string> = {};

  if (isRecord(parsed['boxes'])) {
    for (const [key, v] of Object.entries(parsed['boxes'])) {
      const id = resolveBox(view, key);
      if (!id && inGroup.has(key)) { grouped.push(key); continue; }
      if (!id) { dropped.push(`box "${key}" does not exist`); continue; }
      const label = cleanLabel(v);
      if (label) boxes[id] = label;
    }
  }
  // A cluster name renames a real folder. It cannot move files: membership
  // comes from the paths, so there is nothing here that could.
  if (isRecord(parsed['clusters'])) {
    for (const [folder, v] of Object.entries(parsed['clusters'])) {
      const label = cleanLabel(v);
      if (folders.has(folder)) { if (label) clusters[folder] = label; continue; }
      // A grouped folder is drawn as a box, so a "folder" name for it labels that box.
      const box = resolveBox(view, folder);
      if (!box) { dropped.push(`folder "${folder}" does not exist`); continue; }
      if (label && !boxes[box]) boxes[box] = label;
    }
  }
  if (Array.isArray(parsed['links'])) {
    for (const l of parsed['links']) {
      if (!isRecord(l) || typeof l['from'] !== 'string' || typeof l['to'] !== 'string') continue;
      const from = resolveBox(view, l['from']);
      const to = resolveBox(view, l['to']);
      const key = linkKey(from ?? l['from'], to ?? l['to']);
      if (!from || !to || !realLinks.has(key)) { dropped.push(`connection ${key} is not in the code`); continue; }
      const verb = cleanLabel(l['verb']);
      if (verb) links[key] = verb;
    }
  }
  const entry = cleanLabel(parsed['entry']);
  return { labels: { boxes, clusters, links, ...(entry ? { entry } : {}) }, dropped, grouped };
}
