import { TOUR_PRESETS, type Tour } from '@gitscribe/core';
import type { Layout } from './diagram-layout.js';

/**
 * When things happen in a tour video, and where the camera is. Pure: every
 * frame is a function of time, so preview and export cannot disagree and a
 * single frame can be tested.
 */

export interface Segment {
  readonly kind: 'intro' | 'overview' | 'stop' | 'outro';
  readonly start: number;
  readonly end: number;
  /** Index into `tour.stops` for a stop segment. */
  readonly stop?: number;
}

export interface Camera {
  /** Diagram coordinates at the centre of the frame. */
  readonly cx: number;
  readonly cy: number;
  /** Video pixels per diagram unit. */
  readonly scale: number;
}

export interface Size { readonly w: number; readonly h: number }

/** Share of a stop spent moving the camera; the rest holds still to be read. */
export const MOVE = 0.3;
const MAX_ZOOM = 2.4;
/** Video pixels per diagram unit at which 11px box labels read comfortably (~18px). */
export const READABLE = 1.6;
const MARGIN = 0.12;

export function timeline(tour: Tour): Segment[] {
  const p = TOUR_PRESETS[tour.preset];
  const segs: Segment[] = [];
  let t = 0;
  const add = (kind: Segment['kind'], ms: number, stop?: number): void => {
    segs.push({ kind, start: t, end: t + ms, ...(stop !== undefined ? { stop } : {}) });
    t += ms;
  };
  add('intro', p.introMs);
  add('overview', p.overviewMs);
  tour.stops.forEach((s, i) => add('stop', s.ms, i));
  add('outro', p.outroMs);
  return segs;
}

export function segmentAt(segs: readonly Segment[], t: number): { seg: Segment; local: number } {
  const seg = segs.find((s) => t < s.end) ?? segs[segs.length - 1]!;
  const local = Math.min(1, Math.max(0, (t - seg.start) / (seg.end - seg.start)));
  return { seg, local };
}

/** Cubic ease-in-out. */
export function ease(x: number): number {
  const v = Math.min(1, Math.max(0, x));
  return v < 0.5 ? 4 * v * v * v : 1 - (-2 * v + 2) ** 3 / 2;
}

function frame(x0: number, y0: number, x1: number, y1: number, size: Size, cap: number): Camera {
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const scale = Math.min(cap, (size.w * (1 - 2 * MARGIN)) / w, (size.h * (1 - 2 * MARGIN)) / h);
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, scale };
}

export function fitCamera(layout: Layout, size: Size): Camera {
  return frame(0, 0, layout.width, layout.height, size, MAX_ZOOM);
}

/** Frame the stop's target, never zooming out further than the overview. */
export function stopCamera(tour: Tour, i: number, layout: Layout, size: Size): Camera {
  const s = tour.stops[i]!;
  const rect = s.kind === 'cluster'
    ? layout.clusters.find((c) => c.id === s.target)
    : layout.boxes.find((b) => b.id === s.target);
  if (!rect) return fitCamera(layout, size);
  const cam = frame(rect.x - rect.w / 2, rect.y - rect.h / 2, rect.x + rect.w / 2, rect.y + rect.h / 2, size, MAX_ZOOM);
  return { ...cam, scale: Math.max(cam.scale, fitCamera(layout, size).scale) };
}

const mix = (a: Camera, b: Camera, k: number): Camera => ({
  cx: a.cx + (b.cx - a.cx) * k,
  cy: a.cy + (b.cy - a.cy) * k,
  // Interpolate zoom in log space so a zoom feels even, not front-loaded.
  scale: Math.exp(Math.log(a.scale) + (Math.log(b.scale) - Math.log(a.scale)) * k),
});

/**
 * The overview's readable glide, for a diagram too wide (or tall) to read when
 * fitted: start and end cameras at a readable zoom, along the longer axis.
 * Null when the fitted view already reads well.
 */
function glide(layout: Layout, size: Size, toward?: Camera): { from: Camera; to: Camera } | null {
  const fit = fitCamera(layout, size);
  if (fit.scale >= READABLE) return null;
  const scale = READABLE;
  const halfW = size.w / 2 / scale;
  const halfH = size.h / 2 / scale;
  const wide = layout.width / size.w >= layout.height / size.h;
  const along = (len: number, half: number): [number, number] => (len > 2 * half ? [half, len - half] : [len / 2, len / 2]);
  const across = (len: number, half: number): number => Math.min(Math.max(len / 2, half), Math.max(half, len - half));
  // Travel towards the first stop, so the overview hands over without a long sweep back.
  const ordered = (a: number, b: number, target: number | undefined): [number, number] =>
    target !== undefined && Math.abs(target - a) < Math.abs(target - b) ? [b, a] : [a, b];
  if (wide) {
    const [a, b] = ordered(...along(layout.width, halfW), toward?.cx);
    const cy = across(layout.height, halfH);
    return { from: { cx: a, cy, scale }, to: { cx: b, cy, scale } };
  }
  const [a, b] = ordered(...along(layout.height, halfH), toward?.cy);
  const cx = across(layout.width, halfW);
  return { from: { cx, cy: a, scale }, to: { cx, cy: b, scale } };
}

/** Where the overview leaves the camera, so the first stop starts there without a jump. */
function overviewEnd(tour: Tour, layout: Layout, size: Size): Camera {
  return glide(layout, size, firstStop(tour, layout, size))?.to ?? fitCamera(layout, size);
}

const firstStop = (tour: Tour, layout: Layout, size: Size): Camera | undefined =>
  tour.stops.length ? stopCamera(tour, 0, layout, size) : undefined;

export function cameraAt(segs: readonly Segment[], t: number, tour: Tour, layout: Layout, size: Size): Camera {
  const fit = fitCamera(layout, size);
  const { seg, local } = segmentAt(segs, t);
  if (seg.kind === 'intro') return fit;
  if (seg.kind === 'overview') {
    // Whole shape while it builds in; then, if too small to read, zoom in and glide across.
    const g = glide(layout, size, firstStop(tour, layout, size));
    if (!g || local < 0.4) return fit;
    if (local < 0.6) return mix(fit, g.from, ease((local - 0.4) / 0.2));
    return mix(g.from, g.to, ease((local - 0.6) / 0.4));
  }
  const lastStop = tour.stops.length ? stopCamera(tour, tour.stops.length - 1, layout, size) : fit;
  if (seg.kind === 'outro') return mix(lastStop, fit, ease(local / 0.4));
  const i = seg.stop!;
  const from = i === 0 ? overviewEnd(tour, layout, size) : stopCamera(tour, i - 1, layout, size);
  return mix(from, stopCamera(tour, i, layout, size), ease(local / MOVE));
}
