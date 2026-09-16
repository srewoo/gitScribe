import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { matchesGlob, globToRegExp } from '../src/glob.js';
import { readTarGz, stripRoot } from '../src/tar.js';
import { decide, applySelection, suggestDrops, DEFAULT_EXCLUDES } from '../src/select.js';
import { estimateFromBytes, estimateFromText } from '../src/tokens.js';
import { render } from '../src/render.js';
import type { Digest } from '../src/digest.js';
import type { TreeFile } from '../src/github.js';

/* ---------------- tar fixture ---------------- */

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

/** Build a real tar archive so the parser is tested against the actual format. */
function tarball(entries: ReadonlyArray<{ path: string; body: string }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const e of entries) {
    const header = new Uint8Array(512);
    const name = enc.encode(e.path);
    header.set(name.subarray(0, 100), 0);
    header.set(enc.encode(octal(0o644, 8)), 100);
    header.set(enc.encode(octal(0, 8)), 108);
    header.set(enc.encode(octal(0, 8)), 116);
    const bodyBytes = enc.encode(e.body);
    header.set(enc.encode(octal(bodyBytes.length, 12)), 124);
    header.set(enc.encode(octal(0, 12)), 136);
    header[156] = '0'.charCodeAt(0);
    header.set(enc.encode('ustar\0'), 257);
    header.set(enc.encode('00'), 263);
    // checksum: spaces first, then the sum of every byte
    header.set(enc.encode('        '), 148);
    let sum = 0;
    for (const b of header) sum += b;
    header.set(enc.encode(octal(sum, 7) + ' '), 148);

    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(bodyBytes.length / 512) * 512);
    padded.set(bodyBytes);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024)); // end-of-archive
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) { out.set(b, at); at += b.length; }
  return out;
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  // Deliberately chunked small, to exercise the buffering across reads.
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 333) {
        controller.enqueue(bytes.subarray(i, Math.min(i + 333, bytes.length)));
      }
      controller.close();
    },
  });
}

/* ---------------- glob ---------------- */

test('glob: ** crosses directories, * does not', () => {
  assert.ok(matchesGlob('a/b/c/x_test.js', '**/*_test.js'));
  assert.ok(matchesGlob('src/__tests__/a.js', '**/__tests__/**'));
  assert.ok(!matchesGlob('a/b.js', 'a/*/b.js'));
  assert.ok(matchesGlob('a/x/b.js', 'a/*/b.js'));
});

test('glob: separator-free rule also matches the basename', () => {
  assert.ok(matchesGlob('deep/nested/yarn.lock', '*.lock'));
  assert.ok(!matchesGlob('deep/nested/yarn.lock', 'src/*.lock'));
});

test('glob: dots are literal, not wildcards', () => {
  assert.ok(!globToRegExp('a.js').test('axjs'));
  assert.ok(globToRegExp('a.js').test('a.js'));
});

/* ---------------- selection ---------------- */

const files: TreeFile[] = [
  { path: 'src/index.ts', size: 3400, sha: 'a', tokens: 1000 },
  { path: 'src/__tests__/index.test.ts', size: 6800, sha: 'b', tokens: 2000 },
  { path: 'yarn.lock', size: 900_000, sha: 'c', tokens: 50_000 },
  { path: 'README.md', size: 4000, sha: 'd', tokens: 500 },
];

test('selection: exclusion records which rule caught the file', () => {
  const sel = { exclude: ['**/__tests__/**'], include: [], overrides: {} };
  const d = decide('src/__tests__/index.test.ts', sel);
  assert.equal(d.selected, false);
  assert.equal(d.excludedBy, '**/__tests__/**');
});

test('selection: an explicit override beats an exclude rule', () => {
  const sel = { exclude: ['*.lock'], include: [], overrides: { 'yarn.lock': true } };
  assert.equal(decide('yarn.lock', sel).selected, true);
});

test('selection: include list narrows before excludes apply', () => {
  const sel = { exclude: [], include: ['src/**'], overrides: {} };
  assert.equal(decide('README.md', sel).selected, false);
  assert.equal(decide('src/index.ts', sel).selected, true);
});

test('selection: defaults drop lockfiles, total reflects it', () => {
  const sel = { exclude: DEFAULT_EXCLUDES, include: [], overrides: {} };
  const out = applySelection(files, sel);
  assert.ok(!out.files.some((f) => f.path === 'yarn.lock'));
  assert.equal(out.totalTokens, 1000 + 2000 + 500);
});

test('suggestDrops: largest first, stops once the gap closes', () => {
  const drops = suggestDrops(files, 49_000);
  assert.deepEqual(drops.map((f) => f.path), ['yarn.lock']);
  assert.deepEqual(suggestDrops(files, 0), []);
});

/* ---------------- tokens ---------------- */

test('tokens: estimates over-count rather than under-count', () => {
  const text = 'x'.repeat(3400);
  // A real BPE on this would land near 3400/3.3; ours must not come in under.
  assert.ok(estimateFromText('a.ts', text) >= Math.floor(3400 / 3.3));
});

test('tokens: denser file types cost more per byte', () => {
  assert.ok(estimateFromBytes('a.lock', 10_000) > estimateFromBytes('a.md', 10_000));
});

/* ---------------- tar ---------------- */

test('tar: round-trips paths and contents, stripping the repo root', async () => {
  const gz = gzipSync(tarball([
    { path: 'facebook-react-a4f1e09/README.md', body: '# hello' },
    { path: 'facebook-react-a4f1e09/src/index.ts', body: 'export const a = 1;\n' },
  ]));
  const seen: Record<string, string> = {};
  for await (const e of readTarGz(streamOf(new Uint8Array(gz)))) {
    seen[e.path] = new TextDecoder().decode(e.bytes);
  }
  assert.deepEqual(Object.keys(seen).sort(), ['README.md', 'src/index.ts']);
  assert.equal(seen['README.md'], '# hello');
  assert.equal(seen['src/index.ts'], 'export const a = 1;\n');
});

test('tar: a filtered-out entry is skipped without breaking the stream', async () => {
  const gz = gzipSync(tarball([
    { path: 'r-sha/keep.ts', body: 'A'.repeat(700) },
    { path: 'r-sha/skip.bin', body: 'B'.repeat(1500) },
    { path: 'r-sha/also-keep.ts', body: 'C' },
  ]));
  const paths: string[] = [];
  for await (const e of readTarGz(streamOf(new Uint8Array(gz)), (p) => p.endsWith('.ts'))) {
    paths.push(e.path);
  }
  assert.deepEqual(paths, ['keep.ts', 'also-keep.ts']);
});

test('stripRoot removes exactly one leading segment', () => {
  assert.equal(stripRoot('owner-repo-sha/a/b.ts'), 'a/b.ts');
  assert.equal(stripRoot('solo'), 'solo');
});

/* ---------------- render ---------------- */

const digest: Digest = {
  owner: 'facebook',
  repo: 'react',
  ref: 'a4f1e09',
  files: [
    { path: 'README.md', text: 'has ``` a fence inside', tokens: 10 },
    { path: 'src/index.ts', text: 'export const a = 1;', tokens: 8 },
  ],
  totalTokens: 18,
  estimated: true,
  truncations: [{ kind: 'binary', detail: '1 binary file skipped.', paths: ['logo.png'] }],
  redactions: [],
  generatedAt: 1_758_000_000_000,
};

test('render: markdown fences escape content that contains backticks', () => {
  const md = render(digest, 'md');
  assert.ok(md.includes('````'), 'fence must be longer than the content run');
  assert.ok(md.includes('## src/index.ts'));
});

test('render: every format reports the digest as incomplete when it is', () => {
  for (const fmt of ['md', 'xml', 'json', 'txt'] as const) {
    const s = render(digest, fmt);
    assert.ok(/binary/i.test(s), `${fmt} must surface truncations`);
  }
});

test('render: every format declares counts as estimated', () => {
  assert.match(render(digest, 'md'), /estimated/i);
  assert.match(render(digest, 'xml'), /estimated="true"/);
  assert.match(render(digest, 'json'), /"estimated": true/);
  assert.match(render(digest, 'txt'), /estimated/i);
});

test('render: xml neutralises a CDATA terminator in file content', () => {
  const evil: Digest = { ...digest, files: [{ path: 'a.ts', text: 'x]]>y', tokens: 1 }] };
  const xml = render(evil, 'xml');
  assert.ok(!/x\]\]>y/.test(xml), 'raw ]]> must not survive into the CDATA block');
});

test('render: json is parseable and round-trips the file list', () => {
  const parsed = JSON.parse(render(digest, 'json')) as { files: unknown[] };
  assert.equal(parsed.files.length, 2);
});
