import { test } from 'node:test';
import assert from 'node:assert/strict';

import { safeRelative, isSensitivePath, isImage, pickImages, snapshotExtras } from '../src/snapshot-files.js';
import { buildGraph, groupGraph } from '../src/graph.js';
import { planTour } from '../src/tour.js';
import type { Digest, DigestFile } from '../src/digest.js';

test('safeRelative: keeps ordinary paths, refuses anything that could escape', () => {
  assert.equal(safeRelative('src/app.js'), 'src/app.js');
  assert.equal(safeRelative('./a/./b.js'), 'a/b.js');
  for (const bad of ['../etc/passwd', 'a/../../x', '/etc/passwd', 'C:/win', 'a\\..\\b', 'a\u0000b', '', '.', 'a/..']) {
    assert.equal(safeRelative(bad), null, JSON.stringify(bad));
  }
  assert.equal(safeRelative('a/b/../c.js'), 'a/c.js', 'inner .. that stays inside is fine');
});

test('isSensitivePath: env files, keys and credential folders are never written', () => {
  for (const p of ['.env', 'app/.env.local', 'id_rsa', 'deploy/id_ed25519', 'certs/server.pem', 'a.key', 'x.p12',
    'gcp-credentials.json', 'my-service-account.json', 'secrets/db.txt', 'config/credentials/aws.ini']) {
    assert.equal(isSensitivePath(p), true, p);
  }
  for (const p of ['src/env.ts', 'keyboard.js', 'README.md', 'public/logo.png', 'docs/secrets-handling.md']) {
    assert.equal(isSensitivePath(p), false, p);
  }
});

test('pickImages: small images only, at most the cap, brand assets first', () => {
  const files = [
    { path: 'docs/diagram.png', size: 10_000 },
    { path: 'public/logo.svg', size: 2_000 },
    { path: 'src/huge.png', size: 5_000_000 },
    { path: 'assets/hero.jpg', size: 200_000 },
    { path: 'src/app.ts', size: 100 },
    ...Array.from({ length: 50 }, (_, i) => ({ path: `misc/p${i}.png`, size: 1000 })),
  ];
  const picked = pickImages(files, 40, 1_000_000);
  assert.equal(picked.length, 40);
  assert.deepEqual(new Set(picked.slice(0, 2)), new Set(['public/logo.svg', 'assets/hero.jpg']), 'brand assets first');
  assert.ok(!picked.includes('src/huge.png'));
  assert.ok(!picked.includes('src/app.ts'));
  assert.equal(isImage('a/icon.ICO'), true);
});

test('snapshotExtras: mermaid, tour and facts, all from the code', () => {
  const files: DigestFile[] = [
    { path: 'index.html', text: '<script src="app.js"></script>', tokens: 1 },
    { path: 'app.js', text: "import { fill } from './fill.js';\nimport React from 'react';", tokens: 1 },
    { path: 'fill.js', text: 'export function fill() {}', tokens: 1 },
    { path: 'README.md', text: '# Paint', tokens: 1 },
  ];
  const d: Digest = { owner: 'srewoo', repo: 'paintBrush', ref: 'abc1234', files, totalTokens: 4, estimated: true, truncations: [], redactions: [{ path: 'app.js', kind: 'aws', count: 1 }], generatedAt: 1 };
  const g = buildGraph(d);
  const v = groupGraph(g);
  const extras = snapshotExtras(d, g, v, planTour(g, v, undefined, 'onboarding', 'srewoo/paintBrush'), ['.env']);
  assert.match(extras['architecture.mmd']!, /^flowchart TD/);
  const tour = JSON.parse(extras['tour.json']!);
  assert.equal(tour.stops[0].target, 'index.html');
  const facts = extras['facts.md']!;
  assert.match(facts, /3 source files/);
  assert.match(facts, /2 imports/);
  assert.match(facts, /index\.html/);
  assert.match(facts, /react/);
  assert.match(facts, /1 secret/);
  assert.match(facts, /\.env/);
});
