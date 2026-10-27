import type { Tour } from '@gitscribe/core';
import type { Layout, PlacedBox } from './diagram-layout.js';
import type { Palette } from './diagram-svg.js';
import { timeline, segmentAt, cameraAt, ease, MOVE, type Segment, type Size } from './video-timeline.js';

/**
 * Draw one frame of a tour video. A pure function of time: preview plays it on
 * a visible canvas, export feeds the same frames to the encoder.
 */

export interface Scene {
  readonly layout: Layout;
  readonly tour: Tour;
  readonly segs: readonly Segment[];
  readonly size: Size;
  readonly palette: Palette;
  readonly repo: string;
  readonly commit: string;
  readonly stats: { readonly files: number; readonly imports: number };
}

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';

export function makeScene(layout: Layout, tour: Tour, size: Size, palette: Palette, repo: string, commit: string, stats: Scene['stats']): Scene {
  return { layout, tour, segs: timeline(tour), size, palette, repo, commit, stats };
}

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** Word-wrap into at most `max` lines that fit `width`. */
function wrap(ctx: Ctx, text: string, width: number, max: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > width && line) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines.slice(0, max);
}

function polylineLength(pts: ReadonlyArray<{ x: number; y: number }>): number {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  return n;
}

/** The diagram itself, under the camera. `focus` dims everything outside it. */
function drawDiagram(ctx: Ctx, s: Scene, reveal: number, focus: { ids: Set<string>; cluster?: string; links: Set<string>; draw: number } | null): void {
  const c = s.palette;
  const dim = (on: boolean): number => (focus && !on ? 0.22 : 1);

  for (const k of s.layout.clusters) {
    ctx.globalAlpha = clamp01(reveal * 3) * dim(focus?.cluster === k.id);
    roundRect(ctx, k.x - k.w / 2, k.y - k.h / 2, k.w, k.h, 8);
    ctx.fillStyle = c.p2;
    ctx.fill();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = focus?.cluster === k.id ? c.ac : c.line;
    ctx.lineWidth = focus?.cluster === k.id ? 2.5 : 1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = c.tx2;
    ctx.font = `600 11px ${FONT}`;
    ctx.fillText(k.title, k.x - k.w / 2 + 8, k.y - k.h / 2 + 14);
  }

  for (const l of s.layout.links) {
    const key = `${l.from}\u0000${l.to}`;
    const lit = focus?.links.has(key) ?? false;
    const grow = focus ? (lit ? focus.draw : 1) : clamp01((reveal - 0.45) * 2.2);
    if (grow <= 0) continue;
    ctx.globalAlpha = lit ? 1 : dim(false) * (l.dashed ? 0.6 : 0.85);
    ctx.strokeStyle = lit ? c.ac : c.tx3;
    ctx.lineWidth = lit ? 2.6 : Math.min(4, 1 + Math.log2(l.weight));
    ctx.setLineDash(l.dashed ? [6, 5] : []);
    const total = polylineLength(l.points);
    ctx.lineDashOffset = 0;
    if (!l.dashed) ctx.setLineDash([total * grow, total]);
    ctx.beginPath();
    l.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.setLineDash([]);
    if (grow >= 1 && l.points.length >= 2) arrowHead(ctx, l.points[l.points.length - 2]!, l.points[l.points.length - 1]!, lit ? c.ac : c.tx3);
  }

  ctx.globalAlpha = 1;
  for (const b of s.layout.boxes) drawBox(ctx, s, b, clamp01((reveal - 0.15) * 2.5) * dim(focus?.ids.has(b.id) ?? false), focus?.ids.has(b.id) ?? false);
  ctx.globalAlpha = 1;
}

function arrowHead(ctx: Ctx, a: { x: number; y: number }, b: { x: number; y: number }, color: string): void {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(b.x, b.y);
  ctx.lineTo(b.x - 8 * Math.cos(ang - 0.4), b.y - 8 * Math.sin(ang - 0.4));
  ctx.lineTo(b.x - 8 * Math.cos(ang + 0.4), b.y - 8 * Math.sin(ang + 0.4));
  ctx.fill();
}

function drawBox(ctx: Ctx, s: Scene, b: PlacedBox, alpha: number, focused: boolean): void {
  if (alpha <= 0) return;
  const c = s.palette;
  ctx.globalAlpha = alpha;
  roundRect(ctx, b.x - b.w / 2, b.y - b.h / 2, b.w, b.h, b.entry ? b.h / 2 : 6);
  ctx.fillStyle = c.panel;
  ctx.fill();
  ctx.strokeStyle = focused ? c.ac : b.files.length > 1 ? c.ac : c.line;
  ctx.lineWidth = focused ? 2.5 : 1;
  ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = c.tx;
  ctx.font = `500 11px ${FONT}`;
  ctx.fillText(b.title, b.x, b.sub ? b.y - 2 : b.y + 4, b.w - 8);
  if (b.sub) {
    ctx.fillStyle = c.tx3;
    ctx.font = `9.5px ${FONT}`;
    ctx.fillText(b.sub, b.x, b.y + 12, b.w - 8);
  }
  ctx.textAlign = 'start';
}

/** Full-frame text card: the title at the start, the counts at the end. */
function card(ctx: Ctx, s: Scene, lines: Array<{ text: string; size: number; color: string; weight?: number }>, alpha: number): void {
  const { w, h } = s.size;
  const u = Math.min(w, h) / 1080;
  ctx.globalAlpha = alpha;
  ctx.textAlign = 'center';
  const total = lines.reduce((n, l) => n + l.size * u * 1.5, 0);
  let y = h / 2 - total / 2;
  for (const l of lines) {
    ctx.font = `${l.weight ?? 400} ${l.size * u}px ${FONT}`;
    ctx.fillStyle = l.color;
    for (const line of wrap(ctx, l.text, w * 0.82, 3)) {
      y += l.size * u * 1.25;
      ctx.fillText(line, w / 2, y);
    }
    y += l.size * u * 0.25;
  }
  ctx.textAlign = 'start';
  ctx.globalAlpha = 1;
}

function caption(ctx: Ctx, s: Scene, heading: string, text: string, local: number): void {
  const { w, h } = s.size;
  const u = Math.min(w, h) / 1080;
  const c = s.palette;
  const typed = text.slice(0, Math.ceil(text.length * clamp01((local - MOVE * 0.6) / 0.35)));
  const pad = 28 * u;
  const width = Math.min(w - 2 * pad, 1400 * u);
  ctx.font = `${30 * u}px ${FONT}`;
  const lines = wrap(ctx, text, width - 2 * pad, 3);
  const boxH = pad * 1.6 + 26 * u + lines.length * 40 * u;
  const x = (w - width) / 2;
  const y = h - boxH - pad * 1.5;
  // The whole caption fades together; text must not appear before its box.
  const fade = clamp01((local - MOVE * 0.5) * 8);
  if (fade <= 0) return;
  ctx.globalAlpha = fade * 0.94;
  roundRect(ctx, x, y, width, boxH, 14 * u);
  ctx.fillStyle = c.panel;
  ctx.fill();
  ctx.strokeStyle = c.ac;
  ctx.lineWidth = 2 * u;
  ctx.stroke();
  ctx.globalAlpha = fade;
  ctx.fillStyle = c.ac;
  ctx.font = `600 ${22 * u}px ${FONT}`;
  ctx.fillText(heading, x + pad, y + pad + 16 * u);
  ctx.fillStyle = c.tx;
  ctx.font = `${30 * u}px ${FONT}`;
  wrap(ctx, typed, width - 2 * pad, 3).forEach((line, i) => ctx.fillText(line, x + pad, y + pad + 26 * u + (i + 1) * 40 * u));
  ctx.globalAlpha = 1;
}

export function drawFrame(ctx: Ctx, s: Scene, t: number): void {
  const { w, h } = s.size;
  const { seg, local } = segmentAt(s.segs, t);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = s.palette.bg;
  ctx.fillRect(0, 0, w, h);

  const cam = cameraAt(s.segs, t, s.tour, s.layout, s.size);
  ctx.setTransform(cam.scale, 0, 0, cam.scale, w / 2 - cam.cx * cam.scale, h / 2 - cam.cy * cam.scale);

  if (seg.kind === 'intro') {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const c = s.palette;
    const fade = clamp01(local * 5) * clamp01((1 - local) * 6);
    card(ctx, s, [
      ...(s.tour.hook ? [{ text: s.tour.hook, size: 64, color: c.tx, weight: 700 }] : []),
      { text: s.tour.title, size: s.tour.hook ? 36 : 72, color: s.tour.hook ? c.ac : c.tx, weight: s.tour.hook ? 600 : 700 },
      { text: `${s.repo} @ ${s.commit.slice(0, 7)}`, size: 30, color: c.tx2 },
      { text: 'Every arrow is a real import.', size: 26, color: c.tx3 },
    ], fade);
  } else if (seg.kind === 'overview') {
    drawDiagram(ctx, s, ease(local), null);
  } else if (seg.kind === 'stop') {
    const stop = s.tour.stops[seg.stop!]!;
    const ids = new Set(stop.kind === 'box' ? [stop.target] : s.layout.boxes.filter((b) => b.cluster === stop.target).map((b) => b.id));
    for (const l of stop.links) { ids.add(l.from); ids.add(l.to); }
    drawDiagram(ctx, s, 1, {
      ids, ...(stop.kind === 'cluster' ? { cluster: stop.target } : {}),
      links: new Set(stop.links.map((l) => `${l.from}\u0000${l.to}`)),
      draw: ease(clamp01((local - MOVE) / 0.35)),
    });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const heading = stop.kind === 'cluster'
      ? s.layout.clusters.find((k) => k.id === stop.target)?.title ?? stop.target
      : s.layout.boxes.find((b) => b.id === stop.target)?.title ?? stop.target;
    caption(ctx, s, heading, stop.caption, local);
  } else {
    drawDiagram(ctx, s, 1, null);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = s.palette.bg;
    ctx.globalAlpha = clamp01((local - 0.35) * 2.5) * 0.92;
    ctx.fillRect(0, 0, w, h);
    const c = s.palette;
    card(ctx, s, [
      { text: `${s.stats.files} files · ${s.stats.imports} imports`, size: 48, color: c.tx, weight: 700 },
      { text: s.repo, size: 32, color: c.ac, weight: 600 },
      { text: 'Made with GitScribe', size: 24, color: c.tx3 },
    ], clamp01((local - 0.45) * 3));
  }

  // A thin progress bar, so a viewer knows how long is left.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = s.palette.ac;
  ctx.fillRect(0, h - 4, (w * t) / s.tour.totalMs, 4);
  ctx.globalAlpha = 1;
}
