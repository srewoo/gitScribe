import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Tour } from '@gitscribe/core';
import type { Layout } from '../src/diagram-layout.js';
import { timeline, segmentAt, cameraAt, ease, fitCamera, READABLE } from '../src/video-timeline.js';

const layout: Layout = {
  width: 1000, height: 600,
  boxes: [
    { id: 'a', x: 100, y: 100, w: 80, h: 32, title: 'a', sub: '', cluster: '', files: ['a'] },
    { id: 'b', x: 900, y: 500, w: 80, h: 32, title: 'b', sub: '', cluster: 'lib', files: ['b'] },
  ],
  clusters: [{ id: 'lib', x: 900, y: 500, w: 160, h: 100, title: 'lib' }],
  links: [{ from: 'a', to: 'b', weight: 1, points: [{ x: 100, y: 116 }, { x: 900, y: 484 }] }],
};
const tour: Tour = {
  title: 'x', preset: 'share', totalMs: 2500 + 2500 + 3000 + 3000 + 2500,
  stops: [
    { target: 'a', kind: 'box', caption: 'A', links: [], ms: 3000 },
    { target: 'lib', kind: 'cluster', caption: 'Lib', links: [], ms: 3000 },
  ],
};
const size = { w: 1920, h: 1080 };

test('timeline: segments are contiguous and add up to the tour length', () => {
  const segs = timeline(tour);
  assert.deepEqual(segs.map((s) => s.kind), ['intro', 'overview', 'stop', 'stop', 'outro']);
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i]!.start, segs[i - 1]!.end);
  assert.equal(segs[0]!.start, 0);
  assert.equal(segs.at(-1)!.end, tour.totalMs);
});

test('timeline: segmentAt finds the right segment and local progress', () => {
  const segs = timeline(tour);
  assert.equal(segmentAt(segs, 0).seg.kind, 'intro');
  const mid = segmentAt(segs, 5000 + 1500);
  assert.equal(mid.seg.kind, 'stop');
  assert.equal(mid.seg.stop, 0);
  assert.ok(Math.abs(mid.local - 0.5) < 1e-9);
  assert.equal(segmentAt(segs, tour.totalMs + 99).seg.kind, 'outro', 'clamped past the end');
});

test('ease: starts at 0, ends at 1, and is monotonic', () => {
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  let last = -1;
  for (let x = 0; x <= 1; x += 0.05) { assert.ok(ease(x) >= last); last = ease(x); }
});

test('camera: overview shows everything; a stop ends framed on its target', () => {
  const segs = timeline(tour);
  const fit = fitCamera(layout, size);
  assert.deepEqual(cameraAt(segs, 2500 + 100, tour, layout, size), fit);
  const onA = cameraAt(segs, 5000 + 2900, tour, layout, size);
  assert.ok(Math.abs(onA.cx - 100) < 1 && Math.abs(onA.cy - 100) < 1, `centred on a: ${JSON.stringify(onA)}`);
  assert.ok(onA.scale > fit.scale, 'zoomed in');
  const onLib = cameraAt(segs, 8000 + 2900, tour, layout, size);
  assert.ok(Math.abs(onLib.cx - 900) < 1 && Math.abs(onLib.cy - 500) < 1);
  const between = cameraAt(segs, 8000 + 300, tour, layout, size);
  assert.ok(between.cx > 100 && between.cx < 900, 'moving between stops');
});

test('camera: a wide diagram gets a readable glide during the overview', () => {
  const wide: Layout = { ...layout, width: 6000, height: 600,
    boxes: [layout.boxes[0]!, { ...layout.boxes[1]!, x: 5900 }], clusters: [] };
  const segs = timeline(tour);
  const fit = fitCamera(wide, size);
  const early = cameraAt(segs, 2500 + 500, tour, wide, size);
  const late = cameraAt(segs, 2500 + 2300, tour, wide, size);
  const end = cameraAt(segs, 2500 + 2499, tour, wide, size);
  assert.deepEqual(early, fit, 'opens on the whole shape while it builds in');
  assert.ok(late.scale >= READABLE - 1e-9, `readable during the glide (${late.scale})`);
  // Stop 1 is box "a" on the far left, so the glide travels towards it and ends near it.
  assert.ok(end.cx < late.cx, 'glides across, towards the first stop');
  assert.ok(Math.abs(end.cx - 100) < Math.abs(end.cx - 5900), 'ends nearer the first stop');
  const firstStopStart = cameraAt(segs, 5000, tour, wide, size);
  assert.ok(Math.abs(firstStopStart.cx - end.cx) < 1 && Math.abs(firstStopStart.scale - end.scale) < 1e-6, 'no jump into stop 1');
});

test('camera: a diagram that already reads well is not panned', () => {
  const compact: Layout = { ...layout, width: 600, height: 300 };
  const segs = timeline(tour);
  assert.ok(fitCamera(compact, size).scale >= READABLE);
  assert.deepEqual(cameraAt(segs, 2500 + 2300, tour, compact, size), fitCamera(compact, size));
});
