import dagre, { type Point } from '@dagrejs/dagre';
import { linkKey, type DiagramLabels, type GraphView } from '@gitscribe/core';

/**
 * Positions for a diagram, computed once and drawn by `diagram-svg.ts`.
 * Pure — no DOM — so it runs under node:test, and so the walkthrough video can
 * reuse the same coordinates to animate between boxes.
 */

export interface PlacedBox {
  readonly id: string;
  /** Centre point, as dagre reports it. */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly title: string;
  /** The file or folder name, shown under a model-given title. Empty if none. */
  readonly sub: string;
  readonly cluster: string;
  readonly files: readonly string[];
  readonly entry?: true;
}

export interface PlacedCluster {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly title: string;
}

export interface PlacedLink {
  readonly from: string;
  readonly to: string;
  readonly weight: number;
  readonly points: ReadonlyArray<{ x: number; y: number }>;
  readonly verb?: string;
  /** Not an import: drawn dashed (the entry's links). */
  readonly dashed?: true;
}

export interface Layout {
  readonly width: number;
  readonly height: number;
  readonly boxes: readonly PlacedBox[];
  readonly clusters: readonly PlacedCluster[];
  readonly links: readonly PlacedLink[];
}

/**
 * The entry box's id. It is written into the SVG, so it must be valid XML text
 * (a NUL here made labelled diagrams unexportable), and it starts with "/" so it
 * can never equal a repository path, which is always relative.
 */
export const ENTRY_ID = '/entry';
const CLUSTER = 'cluster:';
// ponytail: width from character count, not measured text. Good enough for a
// monospace-ish label; measure with canvas if long labels start clipping.
const CHAR_W = 6.4;
const PAD_X = 22;

const boxWidth = (title: string, sub: string): number =>
  Math.min(240, Math.max(90, Math.max(title.length, sub.length * 0.9) * CHAR_W + PAD_X));

/**
 * Lay out both ways and keep the one whose shape best matches the space it is
 * shown in. A tall side panel wants left-to-right; a wide page wants top-down.
 */
export function layoutToFit(view: GraphView, labels: DiagramLabels | undefined, aspect: number): Layout {
  const score = (l: Layout): number => Math.abs(Math.log((l.width / Math.max(1, l.height)) / aspect));
  const tb = layoutDiagram(view, labels, 'TB');
  const lr = layoutDiagram(view, labels, 'LR');
  return score(lr) < score(tb) ? lr : tb;
}

export function layoutDiagram(view: GraphView, labels?: DiagramLabels, rankdir: 'TB' | 'LR' = 'TB'): Layout {
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: false });
  g.setGraph({ rankdir, nodesep: 22, ranksep: rankdir === 'LR' ? 70 : 56, marginx: 18, marginy: 18 });
  g.setDefaultEdgeLabel(() => ({}));

  const meta = new Map<string, Omit<PlacedBox, 'x' | 'y'>>();
  for (const b of view.boxes) {
    const named = labels?.boxes[b.id];
    const title = named ?? b.label;
    const sub = named ? b.label : b.files.length > 1 ? `${b.files.length} files` : '';
    const h = sub ? 44 : 32;
    const w = boxWidth(title, sub);
    meta.set(b.id, { id: b.id, w, h, title, sub, cluster: b.cluster, files: b.files });
    g.setNode(b.id, { width: w, height: h });
    if (b.cluster) {
      g.setNode(CLUSTER + b.cluster, { width: 0, height: 0 });
      g.setParent(b.id, CLUSTER + b.cluster);
    }
  }

  const imported = new Set(view.links.map((l) => l.to));
  if (labels?.entry) {
    const w = boxWidth(labels.entry, '');
    meta.set(ENTRY_ID, { id: ENTRY_ID, w, h: 34, title: labels.entry, sub: '', cluster: '', files: [], entry: true });
    g.setNode(ENTRY_ID, { width: w, height: 34 });
    for (const b of view.boxes) if (!imported.has(b.id)) g.setEdge(ENTRY_ID, b.id);
  }
  for (const l of view.links) g.setEdge(l.from, l.to, { weight: l.weight });

  dagre.layout(g);

  const boxes: PlacedBox[] = [];
  for (const [id, m] of meta) {
    const n = g.node(id);
    boxes.push({ ...m, x: n.x, y: n.y });
  }
  const clusters: PlacedCluster[] = [];
  for (const id of g.nodes()) {
    if (!id.startsWith(CLUSTER)) continue;
    const n = g.node(id);
    const folder = id.slice(CLUSTER.length);
    clusters.push({ id: folder, x: n.x, y: n.y, w: n.width, h: n.height, title: labels?.clusters[folder] ?? folder });
  }
  const weight = new Map(view.links.map((l) => [linkKey(l.from, l.to), l.weight]));
  const links: PlacedLink[] = g.edges().map((e) => {
    const points = (g.edge(e).points ?? []).map((p: Point) => ({ x: p.x, y: p.y }));
    if (e.v === ENTRY_ID) return { from: e.v, to: e.w, weight: 1, points, dashed: true };
    const verb = labels?.links[linkKey(e.v, e.w)];
    return { from: e.v, to: e.w, weight: weight.get(linkKey(e.v, e.w)) ?? 1, points, ...(verb ? { verb } : {}) };
  });

  const graph = g.graph();
  return { width: graph.width ?? 0, height: graph.height ?? 0, boxes, clusters, links };
}
