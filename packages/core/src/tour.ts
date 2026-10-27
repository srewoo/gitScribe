import type { CodeGraph, GraphView, Box } from './graph.js';
import type { DiagramLabels } from './labels.js';

/**
 * A guided tour of a diagram: which box or folder to visit, in what order, what
 * to say, and which arrows to light up. Pure data — the extension renders it.
 *
 * `planTour` needs no model. It starts where the code starts (the boxes nothing
 * imports) and walks the real arrows outward, so the order itself is evidence.
 */

export type TourPreset = 'onboarding' | 'share';

export interface TourStop {
  /** A box id, or a folder (cluster) name. */
  readonly target: string;
  readonly kind: 'box' | 'cluster';
  readonly caption: string;
  readonly links: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly ms: number;
}

export interface Tour {
  readonly title: string;
  /** Opening line for the share preset. */
  readonly hook?: string;
  readonly preset: TourPreset;
  readonly stops: readonly TourStop[];
  readonly totalMs: number;
}

export const PRESETS = {
  onboarding: { maxStops: 14, stopMs: 5000, maxStopMs: 9000, introMs: 4000, overviewMs: 5000, outroMs: 4000, minMs: 60_000, maxMs: 90_000 },
  share: { maxStops: 6, stopMs: 3000, maxStopMs: 5000, introMs: 2500, overviewMs: 2500, outroMs: 2500, minMs: 20_000, maxMs: 30_000 },
} as const;

export const MAX_CAPTION = 120;
const CLUSTER_MIN = 3;
const MAX_LINKS = 8;

export function clip(s: string, max = MAX_CAPTION): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function list(names: readonly string[], more: number): string {
  if (names.length === 1) return names[0]!;
  const head = names.slice(0, -1).join(', ');
  return more > 0 ? `${names.join(', ')} and ${more} more` : `${head} and ${names[names.length - 1]}`;
}

/** The arrows that touch a stop, capped so a hub does not light up everything. */
export function stopLinks(view: GraphView, members: ReadonlySet<string>): TourStop['links'] {
  return view.links
    .filter((l) => members.has(l.from) || members.has(l.to))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, MAX_LINKS)
    .map(({ from, to }) => ({ from, to }));
}

export function boxCaption(g: CodeGraph, view: GraphView, b: Box, labels?: DiagramLabels): string {
  const named = labels?.boxes[b.id];
  const lead = named ? `${b.label} — ${named}.` : b.files.length > 1 ? `${b.label} — ${b.files.length} files.` : `${b.label}.`;
  const comment = b.files.length === 1 ? g.outline.find((o) => o.path === b.id)?.leadComment ?? '' : '';
  const out = view.links.filter((l) => l.from === b.id).map((l) => view.boxes.find((x) => x.id === l.to)!.label);
  const inn = view.links.filter((l) => l.to === b.id).map((l) => view.boxes.find((x) => x.id === l.from)!.label);
  const parts = [lead];
  if (!named && comment) parts.push(comment.endsWith('.') ? comment : `${comment}.`);
  if (out.length) parts.push(`Uses ${out.length} ${out.length === 1 ? 'part' : 'parts'}: ${list(out.slice(0, 3), out.length - 3)}.`);
  else if (inn.length) parts.push(`Used by ${list(inn.slice(0, 3), inn.length - 3)}.`);
  return clip(parts.join(' '));
}

export function clusterCaption(view: GraphView, cluster: string, labels?: DiagramLabels): string {
  const boxes = view.boxes.filter((b) => b.cluster === cluster);
  const name = labels?.clusters[cluster];
  const head = name ? `${cluster} — ${name}` : cluster;
  const names = boxes.map((b) => b.label);
  return clip(`${head}: ${boxes.length} parts, including ${list(names.slice(0, 3), names.length - 3)}.`);
}

/** Durations so the preset lands inside its length range, whatever the stop count. */
export function finishTour(title: string, preset: TourPreset, stops: ReadonlyArray<Omit<TourStop, 'ms'>>, hook?: string): Tour {
  const p = PRESETS[preset];
  const fixed = p.introMs + p.overviewMs + p.outroMs;
  const n = Math.max(1, stops.length);
  const ms = Math.min(p.maxStopMs, Math.max(p.stopMs, Math.ceil((p.minMs - fixed) / n / 100) * 100));
  const timed = stops.map((s) => ({ ...s, ms }));
  return { title, preset, stops: timed, totalMs: fixed + ms * timed.length, ...(hook ? { hook } : {}) };
}

export function planTour(
  g: CodeGraph,
  view: GraphView,
  labels: DiagramLabels | undefined,
  preset: TourPreset,
  title: string,
): Tour {
  const indeg = new Map<string, number>();
  const outs = new Map<string, string[]>();
  for (const l of view.links) {
    indeg.set(l.to, (indeg.get(l.to) ?? 0) + 1);
    outs.set(l.from, [...(outs.get(l.from) ?? []), l.to]);
  }
  const degree = (id: string): number => (indeg.get(id) ?? 0) + (outs.get(id)?.length ?? 0);
  const byDegree = (a: string, b: string): number => degree(b) - degree(a) || a.localeCompare(b);
  const clusterSize = new Map<string, number>();
  for (const b of view.boxes) if (b.cluster) clusterSize.set(b.cluster, (clusterSize.get(b.cluster) ?? 0) + 1);
  const box = new Map(view.boxes.map((b) => [b.id, b]));

  // Breadth-first from the entry points, so the tour follows the code's own order.
  const roots = view.boxes.map((b) => b.id).filter((id) => !indeg.get(id)).sort(byDegree);
  const queue = [...roots];
  const seen = new Set(queue);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of [...(outs.get(id) ?? [])].sort(byDegree)) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  for (const b of view.boxes) if (!seen.has(b.id)) order.push(b.id);   // cycles with no root

  // A busy folder is one stop, not a stop per file.
  const stops: Array<Omit<TourStop, 'ms'> & { score: number }> = [];
  const done = new Set<string>();
  for (const id of order) {
    const b = box.get(id)!;
    const asCluster = b.cluster && (clusterSize.get(b.cluster) ?? 0) >= CLUSTER_MIN && indeg.get(id);
    const target = asCluster ? b.cluster : id;
    if (done.has(target)) continue;
    done.add(target);
    const members = new Set(asCluster ? view.boxes.filter((x) => x.cluster === b.cluster).map((x) => x.id) : [id]);
    stops.push({
      target, kind: asCluster ? 'cluster' : 'box',
      caption: asCluster ? clusterCaption(view, b.cluster, labels) : boxCaption(g, view, b, labels),
      links: stopLinks(view, members),
      score: [...members].reduce((n, m) => n + degree(m), 0),
    });
  }

  // Too many stops: keep the most connected, in tour order.
  const keep = new Set([...stops].sort((a, b) => b.score - a.score).slice(0, PRESETS[preset].maxStops));
  const kept = stops.filter((s) => keep.has(s)).map(({ score: _, ...s }) => s);
  return finishTour(title, preset, kept);
}
