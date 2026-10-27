import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GraphView } from '@gitscribe/core';
import { layoutDiagram, ENTRY_ID } from '../src/diagram-layout.js';

const view: GraphView = {
  mode: 'file',
  boxes: [
    { id: 'index.html', label: 'index.html', cluster: '', files: ['index.html'] },
    { id: 'js/book.js', label: 'book.js', cluster: 'js', files: ['js/book.js'] },
    { id: 'js/fill.js', label: 'fill.js', cluster: 'js', files: ['js/fill.js'] },
    { id: 'pages/a.js', label: 'a.js', cluster: 'pages', files: ['pages/a.js'] },
  ],
  links: [
    { from: 'index.html', to: 'js/book.js', weight: 1 },
    { from: 'js/book.js', to: 'js/fill.js', weight: 1 },
    { from: 'js/book.js', to: 'pages/a.js', weight: 5 },
  ],
};

const overlap = (a: { x: number; y: number; w: number; h: number }, b: typeof a): boolean =>
  Math.abs(a.x - b.x) * 2 < a.w + b.w && Math.abs(a.y - b.y) * 2 < a.h + b.h;

test('layout: every box is placed, inside the canvas, with no two overlapping', () => {
  const l = layoutDiagram(view);
  assert.equal(l.boxes.length, 4);
  for (const b of l.boxes) {
    assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y), b.id);
    assert.ok(b.x - b.w / 2 >= 0 && b.x + b.w / 2 <= l.width, `${b.id} within width`);
  }
  for (let i = 0; i < l.boxes.length; i++) {
    for (let j = i + 1; j < l.boxes.length; j++) {
      assert.ok(!overlap(l.boxes[i]!, l.boxes[j]!), `${l.boxes[i]!.id} vs ${l.boxes[j]!.id}`);
    }
  }
});

test('layout: folders become clusters that contain their boxes', () => {
  const l = layoutDiagram(view);
  const js = l.clusters.find((c) => c.id === 'js')!;
  for (const b of l.boxes.filter((x) => x.cluster === 'js')) {
    assert.ok(Math.abs(b.x - js.x) <= js.w / 2 && Math.abs(b.y - js.y) <= js.h / 2, `${b.id} inside js`);
  }
});

test('layout: links keep their weight and route through points', () => {
  const l = layoutDiagram(view);
  assert.equal(l.links.length, 3);
  for (const k of l.links) assert.ok(k.points.length >= 2);
  assert.equal(l.links.find((k) => k.to === 'pages/a.js')!.weight, 5);
});

test('layout: labels title the boxes and folders; the entry reaches only unimported boxes', () => {
  const l = layoutDiagram(view, {
    boxes: { 'js/fill.js': 'Region fill engine' },
    clusters: { js: 'Coloring book' },
    links: { 'js/book.js → js/fill.js': 'finds regions' },
    entry: 'Child or parent',
  });
  const fill = l.boxes.find((b) => b.id === 'js/fill.js')!;
  assert.equal(fill.title, 'Region fill engine');
  assert.equal(fill.sub, 'fill.js');
  assert.equal(l.clusters.find((c) => c.id === 'js')!.title, 'Coloring book');
  assert.equal(l.links.find((k) => k.to === 'js/fill.js')!.verb, 'finds regions');
  const entryLinks = l.links.filter((k) => k.from === ENTRY_ID);
  assert.deepEqual(entryLinks.map((k) => k.to), ['index.html']);
  assert.ok(entryLinks.every((k) => k.dashed));
});

test('layout: every id that reaches the SVG is valid XML text (no control characters)', () => {
  // A NUL in the entry id made labelled diagrams unexportable: PNG failed to decode, SVG files were corrupt.
  const l = layoutDiagram(view, { boxes: {}, clusters: {}, links: {}, entry: 'Users' });
  const ids = [...l.boxes.map((b) => b.id), ...l.links.flatMap((k) => [k.from, k.to]), ...l.clusters.map((c) => c.id)];
  for (const id of ids) assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(id), JSON.stringify(id));
  assert.ok(ENTRY_ID.startsWith('/'), 'cannot collide with a repo path, which is always relative');
});
