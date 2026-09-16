import { test } from 'node:test';
import assert from 'node:assert/strict';

import { partitionDigest, partManifest } from '../src/partition.js';
import { renderParts } from '../src/render.js';
import type { Digest, DigestFile } from '../src/digest.js';

function digestOf(files: ReadonlyArray<readonly [string, number]>): Digest {
  const f: DigestFile[] = files.map(([path, tokens]) => ({ path, tokens, text: `// ${path}` }));
  return {
    owner: 'acme', repo: 'monorepo', ref: 'abc1234',
    files: f,
    totalTokens: f.reduce((n, x) => n + x.tokens, 0),
    estimated: true, truncations: [], redactions: [],
    generatedAt: 1_758_000_000_000,
  };
}

test('partition: a digest that fits is left as one part', () => {
  const p = partitionDigest(digestOf([['a.ts', 100], ['b.ts', 100]]), { budget: 10_000 });
  assert.equal(p.single, true);
  assert.equal(p.parts.length, 1);
});

test('partition: every file lands in exactly one part', () => {
  const files = Array.from({ length: 200 }, (_, i) => [`src/f${i}.ts`, 500] as const);
  const d = digestOf(files);
  const p = partitionDigest(d, { budget: 10_000, overhead: 0 });

  const seen = p.parts.flatMap((x) => x.files.map((f) => f.path));
  assert.equal(seen.length, files.length, 'no file duplicated or dropped');
  assert.deepEqual(new Set(seen).size, files.length);
  assert.deepEqual(seen, files.map(([p2]) => p2), 'path order preserved');
});

test('partition: no part exceeds the budget, except for an oversized file', () => {
  const d = digestOf([['a.ts', 400], ['b.ts', 400], ['c.ts', 400], ['d.ts', 400]]);
  const p = partitionDigest(d, { budget: 1000, overhead: 0 });
  for (const part of p.parts) {
    if (part.oversized.length === 0) assert.ok(part.tokens <= 1000, `part ${part.index} = ${part.tokens}`);
  }
});

test('partition: a single file bigger than the budget gets its own part and is flagged', () => {
  const d = digestOf([['small.ts', 100], ['huge.ts', 50_000], ['after.ts', 100]]);
  const p = partitionDigest(d, { budget: 1000, overhead: 0 });

  const huge = p.parts.find((x) => x.oversized.includes('huge.ts'));
  assert.ok(huge, 'oversized file must be reported');
  assert.deepEqual(huge.files.map((f) => f.path), ['huge.ts'], 'it gets a part to itself');
  // and it is never silently truncated
  assert.equal(huge.files[0]!.tokens, 50_000);
});

test('partition: parts are contiguous, so directories stay together', () => {
  const d = digestOf([
    ['api/a.ts', 600], ['api/b.ts', 600],
    ['web/a.ts', 600], ['web/b.ts', 600],
  ]);
  const p = partitionDigest(d, { budget: 1200, overhead: 0 });
  assert.deepEqual(p.parts[0]!.files.map((f) => f.path), ['api/a.ts', 'api/b.ts']);
  assert.deepEqual(p.parts[1]!.files.map((f) => f.path), ['web/a.ts', 'web/b.ts']);
});

test('renderParts: each part says where it sits and what it lacks', () => {
  const files = Array.from({ length: 50 }, (_, i) => [`src/f${i}.ts`, 500] as const);
  const out = renderParts(digestOf(files), 'md', { budget: 5000, overhead: 0 });
  assert.ok(out.length > 1, 'must actually split');

  out.forEach((text, i) => {
    assert.match(text, new RegExp(`PART ${i + 1} OF ${out.length}`));
    assert.match(text, /All parts:/);
  });
  assert.match(out[0]!, /further part\(s\) follow/);
  assert.match(out[out.length - 1]!, /final part/);
});

test('renderParts: json parts stay valid json and carry their index', () => {
  const files = Array.from({ length: 30 }, (_, i) => [`f${i}.ts`, 500] as const);
  const out = renderParts(digestOf(files), 'json', { budget: 4000, overhead: 0 });
  assert.ok(out.length > 1);
  for (const [i, text] of out.entries()) {
    const parsed = JSON.parse(text) as { part: { index: number; total: number } };
    assert.equal(parsed.part.index, i + 1);
    assert.equal(parsed.part.total, out.length);
  }
});

test('renderParts: concatenating the parts covers every file exactly once', () => {
  const files = Array.from({ length: 60 }, (_, i) => [`src/f${i}.ts`, 400] as const);
  const out = renderParts(digestOf(files), 'md', { budget: 4000, overhead: 0 });
  for (const [path] of files) {
    const hits = out.filter((t) => t.includes(`## ${path}\n`)).length;
    assert.equal(hits, 1, `${path} should appear in exactly one part, saw ${hits}`);
  }
});

test('partManifest names the range each part covers', () => {
  const p = partitionDigest(digestOf([['a.ts', 600], ['b.ts', 600]]), { budget: 700, overhead: 0 });
  const m = partManifest(p);
  assert.match(m, /Part 1\/2/);
  assert.match(m, /a\.ts/);
});

test('renderParts: every markdown header line stays inside the blockquote', () => {
  const files = Array.from({ length: 40 }, (_, i) => [`src/f${i}.ts`, 500] as const);
  const out = renderParts(digestOf(files), 'md', { budget: 4000, overhead: 0 });
  for (const text of out) {
    const header = text.slice(0, text.indexOf('\n\n#'));
    for (const line of header.split('\n')) {
      assert.ok(line.startsWith('>'), `header line escaped the blockquote: ${JSON.stringify(line)}`);
    }
  }
});
