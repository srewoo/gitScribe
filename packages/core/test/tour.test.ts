import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGraph, groupGraph } from '../src/graph.js';
import { linkKey } from '../src/labels.js';
import { planTour, PRESETS } from '../src/tour.js';
import { tourRequest, validateTour } from '../src/tour-script.js';
import type { Digest, DigestFile } from '../src/digest.js';

function digestOf(files: Record<string, string>): Digest {
  const f: DigestFile[] = Object.entries(files).map(([path, text]) => ({ path, text, tokens: 1 }));
  return {
    owner: 'srewoo', repo: 'paintBrush', ref: 'abc1234', files: f, totalTokens: f.length,
    estimated: true, truncations: [], redactions: [], generatedAt: 1,
  };
}

// A paintBrush-shaped repo: two pages, two controllers, shared tools, page packs.
const files: Record<string, string> = {
  'book.html': '<script src="book.js"></script>',
  'studio.html': '<script src="studio.js"></script>',
  'book.js': ['fill', 'palette', 'save', 'sound', 'zoom', 'data'].map((m) => `import x from './js/${m}.js';`).join('\n'),
  'studio.js': "/** Upload studio. */\nimport f from './js/fill.js';\nimport u from './js/uploads.js';",
};
for (const m of ['fill', 'palette', 'save', 'sound', 'zoom', 'uploads']) files[`js/${m}.js`] = `export function ${m}() {}`;
files['js/data.js'] = ['a', 'b', 'c'].map((p) => `import ${p} from '../pages/${p}.js';`).join('\n');
for (const p of ['a', 'b', 'c']) files[`pages/${p}.js`] = '';

const graph = buildGraph(digestOf(files));
const view = groupGraph(graph);
const boxIds = new Set(view.boxes.map((b) => b.id));
const clusters = new Set(view.boxes.map((b) => b.cluster).filter(Boolean));
const realLinks = new Set(view.links.map((l) => linkKey(l.from, l.to)));

test('tour: every stop is a real box or folder, and every highlighted arrow is real', () => {
  for (const preset of ['onboarding', 'share'] as const) {
    const t = planTour(graph, view, undefined, preset, 'srewoo/paintBrush');
    assert.ok(t.stops.length >= 3, `${preset}: ${t.stops.length} stops`);
    for (const s of t.stops) {
      assert.ok(s.kind === 'box' ? boxIds.has(s.target) : clusters.has(s.target), s.target);
      for (const l of s.links) assert.ok(realLinks.has(linkKey(l.from, l.to)), `${l.from} → ${l.to}`);
      assert.ok(s.caption.length <= 120, s.caption);
    }
  }
});

test('tour: starts where the code starts and follows the arrows', () => {
  const t = planTour(graph, view, undefined, 'onboarding', 'srewoo/paintBrush');
  assert.ok(['book.html', 'studio.html'].includes(t.stops[0]!.target), t.stops[0]!.target);
  const order = t.stops.map((s) => s.target);
  assert.ok(order.indexOf('book.js') > order.indexOf('book.html'), 'a page comes before the script it loads');
});

test('tour: presets keep to their length and stop limits', () => {
  const on = planTour(graph, view, undefined, 'onboarding', 'x');
  const sh = planTour(graph, view, undefined, 'share', 'x');
  assert.ok(on.stops.length <= PRESETS.onboarding.maxStops && sh.stops.length <= PRESETS.share.maxStops);
  assert.ok(on.totalMs >= 60_000 && on.totalMs <= 90_000, `onboarding ${on.totalMs}`);
  assert.ok(sh.totalMs >= 20_000 && sh.totalMs <= 30_000, `share ${sh.totalMs}`);
  assert.equal(on.totalMs, PRESETS.onboarding.introMs + PRESETS.onboarding.overviewMs +
    on.stops.reduce((n, s) => n + s.ms, 0) + PRESETS.onboarding.outroMs);
});

test('tour: captions come from labels, names and comments', () => {
  const t = planTour(graph, view, { boxes: { 'book.js': 'Book experience' }, clusters: { js: 'Shared tools' }, links: {} }, 'onboarding', 'x');
  const book = t.stops.find((s) => s.target === 'book.js')!;
  assert.match(book.caption, /Book experience/);
  assert.match(book.caption, /6 /);
});

test('script: the request carries structure, not code', () => {
  const req = tourRequest(graph, view, undefined);
  assert.ok(req.includes('book.js') && req.includes('STOPS'));
  assert.ok(!req.includes('import x from'));
});

test('script: invented stops, arrows and file names are cut; real ones kept', () => {
  const r = validateTour(graph, view, undefined, JSON.stringify({
    title: 'paintBrush in 60 seconds',
    stops: [
      { target: 'book.html', caption: 'Everything starts at the book page.', links: [{ from: 'book.html', to: 'book.js' }] },
      { target: 'book.js', caption: 'The book controller wires up fill.js and save.js.', links: [{ from: 'book.js', to: 'js/fill.js' }, { from: 'js/fill.js', to: 'book.js' }] },
      { target: 'js', caption: 'Shared drawing tools.', links: [] },
      { target: 'server/api.js', caption: 'The API server.', links: [] },
      { target: 'studio.js', caption: 'Studio delegates to imaginary.js for uploads.', links: [] },
    ],
  }), 'onboarding', 'x');
  assert.equal(r.tour.title, 'paintBrush in 60 seconds');
  assert.deepEqual(r.tour.stops.map((s) => s.target), ['book.html', 'book.js', 'js', 'studio.js']);
  assert.equal(r.tour.stops[1]!.links.length, 1, 'reversed arrow cut');
  assert.doesNotMatch(r.tour.stops[3]!.caption, /imaginary/, 'caption naming a fake file replaced');
  assert.equal(r.dropped.length, 3);
});

test('script: a reply with too few real stops falls back to the code-only tour', () => {
  const r = validateTour(graph, view, undefined, '{"stops":[{"target":"nope.js","caption":"x"}]}', 'share', 'x');
  assert.match(r.warning ?? '', /code-only/);
  assert.ok(r.tour.stops.length >= 3);
  const bad = validateTour(graph, view, undefined, 'not json at all', 'share', 'x');
  assert.match(bad.warning ?? '', /code-only/);
});

test('script: a stop named by an unambiguous short name is accepted', () => {
  const r = validateTour(graph, view, undefined, JSON.stringify({
    stops: [
      { target: 'book.html', caption: 'Start here.' },
      { target: 'uploads.js', caption: 'Keeps uploaded pictures.' },
      { target: 'js', caption: 'Shared tools.' },
    ],
  }), 'share', 'x');
  assert.equal(r.warning, undefined, JSON.stringify(r.dropped));
  assert.deepEqual(r.tour.stops.map((s) => s.target), ['book.html', 'js/uploads.js', 'js']);
});
