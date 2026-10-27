import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildGraph, groupGraph, isCode } from '../src/graph.js';
import type { Digest, DigestFile } from '../src/digest.js';

function digestOf(files: Record<string, string>): Digest {
  const f: DigestFile[] = Object.entries(files).map(([path, text]) => ({ path, text, tokens: 1 }));
  return {
    owner: 'acme', repo: 'app', ref: 'abc1234', files: f, totalTokens: f.length,
    estimated: true, truncations: [], redactions: [], generatedAt: 1,
  };
}

const edges = (d: Digest): string[] => buildGraph(d).edges.map((e) => `${e.from} -> ${e.to}`).sort();

test('graph: every JS/TS import form becomes an edge', () => {
  const d = digestOf({
    'src/main.ts': [
      "import a from './a';",
      "import './b';",
      "export * from './c';",
      "export { d } from './d';",
      'import {\n  e,\n  f,\n} from "./e";',
      "const g = await import('./g');",
      "const h = require('./h');",
      "import type { I } from './i';",
    ].join('\n'),
    'src/a.ts': '', 'src/b.ts': '', 'src/c.ts': '', 'src/d.ts': '',
    'src/e.ts': '', 'src/g.ts': '', 'src/h.js': '', 'src/i.ts': '',
  });
  assert.deepEqual(edges(d), [
    'src/main.ts -> src/a.ts', 'src/main.ts -> src/b.ts', 'src/main.ts -> src/c.ts',
    'src/main.ts -> src/d.ts', 'src/main.ts -> src/e.ts', 'src/main.ts -> src/g.ts',
    'src/main.ts -> src/h.js', 'src/main.ts -> src/i.ts',
  ]);
});

test('graph: resolves extensions, index files, parent dirs and the TS .js convention', () => {
  const d = digestOf({
    'src/ui/view.ts': "import { x } from '../core/x.js';\nimport * as lib from '../lib';\nimport y from './y';",
    'src/core/x.ts': '',
    'src/lib/index.ts': '',
    'src/ui/y.tsx': '',
  });
  assert.deepEqual(edges(d), [
    'src/ui/view.ts -> src/core/x.ts', 'src/ui/view.ts -> src/lib/index.ts', 'src/ui/view.ts -> src/ui/y.tsx',
  ]);
});

test('graph: <script src> in HTML links the page to its scripts', () => {
  const d = digestOf({
    'index.html': '<script src="js/book.js"></script>\n<script type="module" src="/js/studio.js?v=2"></script>',
    'js/book.js': '', 'js/studio.js': '',
  });
  assert.deepEqual(edges(d), ['index.html -> js/book.js', 'index.html -> js/studio.js']);
});

test('graph: packages, aliases and missing files are reported, never drawn', () => {
  const g = buildGraph(digestOf({
    'src/a.ts': "import React from 'react';\nimport z from '@scope/pkg/sub';\nimport fs from 'node:fs';\n" +
      "import u from '@/utils';\nimport m from './missing';",
  }));
  assert.deepEqual(g.edges, []);
  assert.deepEqual([...g.external].sort(), ['@scope/pkg', 'node:fs', 'react']);
  assert.deepEqual(
    g.unresolved.map((u) => `${u.specifier}:${u.reason}`).sort(),
    ['./missing:missing', '@/utils:alias'],
  );
});

test('graph: asset imports (css, images, json) are neither edges nor unresolved', () => {
  const g = buildGraph(digestOf({
    'src/Scene.jsx': "import bg from '../res/bg.jpg';\nimport './styles.css';\nimport data from './data.json';\nimport a from './a';",
    'src/a.js': '',
  }));
  assert.deepEqual(g.edges.map((e) => e.to), ['src/a.js']);
  assert.deepEqual(g.unresolved, []);
});

test('graph: a dot inside a module name is not mistaken for an asset', () => {
  assert.deepEqual(
    edges(digestOf({ 'app.ts': "import s from './user.service';", 'user.service.ts': '' })),
    ['app.ts -> user.service.ts'],
  );
});

test('graph: a root-relative src in a nested HTML page resolves against that page (Vite)', () => {
  assert.deepEqual(
    edges(digestOf({ 'examples/demo/index.html': '<script type="module" src="/src/main.jsx"></script>', 'examples/demo/src/main.jsx': '' })),
    ['examples/demo/index.html -> examples/demo/src/main.jsx'],
  );
});

test('graph: a bare specifier that matches a repo path (baseUrl style) is an edge', () => {
  assert.deepEqual(
    edges(digestOf({ 'src/a.ts': "import b from 'src/b';", 'src/b.ts': '' })),
    ['src/a.ts -> src/b.ts'],
  );
});

test('graph: non-code files are skipped, not drawn', () => {
  const g = buildGraph(digestOf({ 'a.ts': '', 'README.md': '', 'logo.png': '', 'data.json': '' }));
  assert.deepEqual(g.nodes, ['a.ts']);
  assert.deepEqual([...g.skipped].sort(), ['README.md', 'data.json', 'logo.png']);
  assert.equal(isCode('x.d.ts'), true);
});

test('graph: outline carries imports, exports and the leading comment, not the body', () => {
  const g = buildGraph(digestOf({
    'fill.js': '/** Flood-fill engine for colouring regions. */\n' +
      "import { px } from './px.js';\nexport function floodFill() {}\nexport const TOLERANCE = 3;\n" +
      'export default class Filler {}\nconst secret = "body text";',
    'px.js': 'module.exports.read = 1;\nexports.write = 2;',
  }));
  const fill = g.outline.find((o) => o.path === 'fill.js')!;
  assert.deepEqual(fill.imports, ['px.js']);
  assert.deepEqual(fill.exports, ['floodFill', 'TOLERANCE', 'Filler']);
  assert.equal(fill.leadComment, 'Flood-fill engine for colouring regions.');
  assert.ok(!JSON.stringify(g.outline).includes('body text'), 'no file bodies in the outline');
  assert.deepEqual(g.outline.find((o) => o.path === 'px.js')!.exports, ['read', 'write']);
});

test('group: a small repo gets one box per file, clustered by folder', () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 30; i++) files[`js/f${i}.js`] = i > 0 ? `import x from './f${i - 1}.js';` : '';
  const v = groupGraph(buildGraph(digestOf(files)));
  assert.equal(v.mode, 'file');
  assert.equal(v.boxes.length, 30);
  assert.equal(v.boxes[0]!.cluster, 'js');
  assert.equal(v.links.length, 29);
});

test('group: a huge repo is grouped into at most 40 modules with weighted links', () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 26_000; i++) {
    const path = `pkg${i % 6}/mod${i % 5}/deep${i % 7}/f${i}.ts`;
    // Every file in pkg1 imports one file in pkg0: cross-module edges.
    files[path] = path.startsWith('pkg1/') ? "import a from '../../../pkg0/mod0/deep0/f0';" : '';
  }
  const g = buildGraph(digestOf(files));
  const v = groupGraph(g);
  assert.equal(v.mode, 'module');
  assert.ok(v.boxes.length <= 40, `${v.boxes.length} boxes`);
  assert.ok(v.boxes.length > 6, 'uses the deepest level that still fits, not the top level');
  const crossModule = g.edges.filter((e) => box(v, e.from) !== box(v, e.to)).length;
  assert.equal(v.links.reduce((n, l) => n + l.weight, 0), crossModule);
  assert.equal(v.boxes.reduce((n, b) => n + b.files.length, 0), g.nodes.length, 'every file in exactly one box');
});

test('group: expanding a module replaces it with its files', () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 90; i++) files[`m${i % 3}/f${i}.ts`] = '';
  const g = buildGraph(digestOf(files));
  const v = groupGraph(g, 40, new Set(['m0']));
  assert.equal(v.boxes.filter((b) => b.cluster === 'm0').length, 30);
  assert.ok(v.boxes.some((b) => b.id === 'm1' && b.files.length === 30));
});

test('group: just over the limit, the busiest modules open up to fill the budget', () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 18; i++) files[`js/f${i}.js`] = i ? `import a from './f0.js';` : '';
  for (let i = 0; i < 28; i++) files[`pages/p${i}.js`] = '';   // 46 files, js is where the imports are
  const v = groupGraph(buildGraph(digestOf(files)));
  assert.equal(v.mode, 'module');
  assert.ok(v.boxes.length <= 40);
  assert.equal(v.boxes.filter((b) => b.cluster === 'js').length, 18, 'busy module shown per file');
  assert.ok(v.boxes.some((b) => b.id === 'pages' && b.files.length === 28), 'quiet module stays grouped');
});

test('group: too many top-level folders share an "other" box', () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 100; i++) files[`d${i}/a.ts`] = '';
  const v = groupGraph(buildGraph(digestOf(files)));
  assert.equal(v.boxes.length, 40);
  assert.equal(v.boxes.find((b) => b.id === '(other)')!.files.length, 61);
});

function box(v: ReturnType<typeof groupGraph>, path: string): string {
  return v.boxes.find((b) => b.files.includes(path))!.id;
}
