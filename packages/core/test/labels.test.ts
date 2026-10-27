import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGraph, groupGraph } from '../src/graph.js';
import { labelRequest, validateLabels, linkKey } from '../src/labels.js';
import { toMermaid } from '../src/mermaid.js';
import type { Digest, DigestFile } from '../src/digest.js';

function digestOf(files: Record<string, string>): Digest {
  const f: DigestFile[] = Object.entries(files).map(([path, text]) => ({ path, text, tokens: 1 }));
  return {
    owner: 'acme', repo: 'app', ref: 'abc1234', files: f, totalTokens: f.length,
    estimated: true, truncations: [], redactions: [], generatedAt: 1,
  };
}

const graph = buildGraph(digestOf({
  'js/book.js': "/** Coloring book shell. */\nimport { fill } from './fill.js';\nconst SECRET_BODY = 1;",
  'js/fill.js': 'export function fill() {}',
  'studio/upload.js': "import { fill } from '../js/fill.js';",
}));
const view = groupGraph(graph);

test('labels: the request carries the outline and box ids, never file bodies', () => {
  const req = labelRequest(graph, view);
  assert.ok(req.includes('js/book.js') && req.includes('Coloring book shell.') && req.includes('fill'));
  assert.ok(!req.includes('SECRET_BODY'));
});

test('labels: real boxes, clusters and links are kept', () => {
  const r = validateLabels(view, JSON.stringify({
    boxes: { 'js/fill.js': 'Region fill engine', 'js/book.js': 'Book experience' },
    clusters: { js: 'Coloring book' },
    links: [{ from: 'js/book.js', to: 'js/fill.js', verb: 'finds fill regions' }],
    entry: 'Child or parent',
  }));
  assert.deepEqual(r.dropped, []);
  assert.equal(r.labels.boxes['js/fill.js'], 'Region fill engine');
  assert.equal(r.labels.clusters['js'], 'Coloring book');
  assert.equal(r.labels.links[linkKey('js/book.js', 'js/fill.js')], 'finds fill regions');
  assert.equal(r.labels.entry, 'Child or parent');
});

test('labels: invented files, folders and connections are dropped and counted', () => {
  const r = validateLabels(view, JSON.stringify({
    boxes: { 'js/fill.js': 'Fill', 'js/imaginary.js': 'Ghost' },
    clusters: { lib: 'Library' },
    links: [
      { from: 'js/fill.js', to: 'js/book.js', verb: 'reverse of a real edge' },
      { from: 'studio/upload.js', to: 'js/fill.js', verb: 'uses fill' },
    ],
  }));
  assert.equal(r.dropped.length, 3);
  assert.ok(r.dropped.some((d) => d.includes('js/imaginary.js')));
  assert.ok(r.dropped.some((d) => d.includes('lib')));
  assert.ok(r.dropped.some((d) => d.includes('js/fill.js → js/book.js')));
  assert.equal(r.labels.links[linkKey('studio/upload.js', 'js/fill.js')], 'uses fill');
});

test('labels: a fenced reply is accepted; garbage degrades to no labels with a warning', () => {
  const fenced = validateLabels(view, '```json\n{"boxes":{"js/fill.js":"Fill"}}\n```');
  assert.equal(fenced.labels.boxes['js/fill.js'], 'Fill');
  const bad = validateLabels(view, 'Sure! Here is your diagram: nodes are cool');
  assert.deepEqual(bad.labels.boxes, {});
  assert.match(bad.warning ?? '', /not valid JSON/);
});

test('labels: overlong or non-string labels are rejected, not trusted', () => {
  const r = validateLabels(view, JSON.stringify({ boxes: { 'js/fill.js': 'x'.repeat(500), 'js/book.js': 42 } }));
  assert.equal(r.labels.boxes['js/fill.js']!.length <= 60, true);
  assert.equal(r.labels.boxes['js/book.js'], undefined);
});

test('mermaid: stable, sanitised ids and escaped labels', () => {
  const { labels } = validateLabels(view, JSON.stringify({
    boxes: { 'js/fill.js': 'Fill "engine" [core]' },
    links: [{ from: 'js/book.js', to: 'js/fill.js', verb: 'finds regions' }],
  }));
  const m = toMermaid(view, labels);
  assert.equal(m, toMermaid(view, labels), 'deterministic');
  assert.match(m, /^flowchart TD/);
  assert.ok(m.includes('#quot;engine#quot;'), 'quotes escaped');
  assert.ok(m.includes('-->|"finds regions"|'));
  assert.ok(m.includes('subgraph'), 'folders become subgraphs');
  const withEntry = toMermaid(view, { ...labels, entry: 'Child' });
  assert.ok(withEntry.includes('entry(("Child"))'));
  assert.equal((withEntry.match(/entry -\.->/g) ?? []).length, 2, 'entry reaches only unimported boxes');
  for (const line of m.split('\n').filter((l) => l.includes('-->'))) {
    assert.match(line.trim(), /^n\d+ -->/, 'ids are sanitised');
  }
});

test('labels: an unambiguous short name is mapped to its box; an ambiguous one is not', () => {
  const g = buildGraph(digestOf({
    'js/fill.js': 'export const a = 1;', 'js/book.js': "import { a } from './fill.js';",
    'pages/a/index.js': '', 'pages/b/index.js': '',
  }));
  const v = groupGraph(g);
  const r = validateLabels(v, JSON.stringify({
    boxes: { 'fill.js': 'Region fill engine', 'index.js': 'Ambiguous' },
    links: [{ from: 'book.js', to: 'fill.js', verb: 'fills regions' }],
  }));
  assert.equal(r.labels.boxes['js/fill.js'], 'Region fill engine');
  assert.equal(r.labels.links[linkKey('js/book.js', 'js/fill.js')], 'fills regions');
  assert.ok(r.dropped.some((d) => d.includes('index.js')), 'two boxes named index.js: not guessed');
});

test('labels: a "folder" the model names that is really a grouped box labels that box', () => {
  const view = {
    mode: 'module' as const,
    boxes: [{ id: 'tools', label: 'tools', cluster: '', files: ['tools/a.js', 'tools/b.js'] },
      { id: 'app.js', label: 'app.js', cluster: '', files: ['app.js'] }],
    links: [],
  };
  const r = validateLabels(view, JSON.stringify({ clusters: { tools: 'Build scripts' } }));
  assert.equal(r.labels.boxes['tools'], 'Build scripts');
  assert.deepEqual(r.dropped, []);
});

test('labels: a name for a real file hidden inside a grouped folder is not called invented', () => {
  const view = {
    mode: 'module' as const,
    boxes: [{ id: 'tools', label: 'tools', cluster: '', files: ['tools/build.mjs', 'tools/lint.mjs'] }],
    links: [],
  };
  const r = validateLabels(view, JSON.stringify({ boxes: { 'tools/build.mjs': 'Build script', 'tools/ghost.mjs': 'Ghost' } }));
  assert.deepEqual(r.grouped, ['tools/build.mjs']);
  assert.deepEqual(r.dropped, ['box "tools/ghost.mjs" does not exist']);
});
