import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';

import { buildDigest } from '../src/digest.js';
import { GitHubClient } from '../src/github.js';
import { redactSecrets, isEnvFile } from '../src/redact.js';
import { render } from '../src/render.js';
import type { Env } from '../src/env.js';
import type { RepoTree } from '../src/github.js';
import { estimateFromBytes } from '../src/tokens.js';

/* ---------------- fixture plumbing ---------------- */

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function tarball(entries: ReadonlyArray<{ path: string; body: Uint8Array }>): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const e of entries) {
    const header = new Uint8Array(512);
    header.set(enc.encode(e.path).subarray(0, 100), 0);
    header.set(enc.encode(octal(0o644, 8)), 100);
    header.set(enc.encode(octal(0, 8)), 108);
    header.set(enc.encode(octal(0, 8)), 116);
    header.set(enc.encode(octal(e.body.length, 12)), 124);
    header.set(enc.encode(octal(0, 12)), 136);
    header[156] = '0'.charCodeAt(0);
    header.set(enc.encode('ustar\0'), 257);
    header.set(enc.encode('00'), 263);
    header.set(enc.encode('        '), 148);
    let sum = 0;
    for (const b of header) sum += b;
    header.set(enc.encode(octal(sum, 7) + ' '), 148);
    blocks.push(header);
    const padded = new Uint8Array(Math.ceil(e.body.length / 512) * 512);
    padded.set(e.body);
    blocks.push(padded);
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const b of blocks) { out.set(b, at); at += b.length; }
  return out;
}

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

/** An Env whose fetch serves one canned tarball, so no network is touched. */
function envServing(entries: ReadonlyArray<{ path: string; body: Uint8Array }>): Env {
  const gz = new Uint8Array(gzipSync(tarball(entries)));
  const fetchFn = (async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(gz);
          c.close();
        },
      }),
      { status: 200, headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '58', 'x-ratelimit-reset': '1' } },
    )) as unknown as typeof globalThis.fetch;
  return { fetch: fetchFn, now: () => 1_758_000_000_000 };
}

function treeOf(specs: ReadonlyArray<readonly [string, number]>, truncated = false): RepoTree {
  return {
    ref: 'deadbeef',
    truncated,
    files: specs.map(([path, size]) => ({
      path,
      size,
      sha: 'x',
      tokens: estimateFromBytes(path, size),
    })),
  };
}

const noFilter = { exclude: [], include: [], overrides: {} };

/* ---------------- redaction unit ---------------- */

test('redact: catches vendor-prefixed credentials', () => {
  const src = [
    'const a = "AKIAIOSFODNN7EXAMPLE";',
    'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'anthropic = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAA"',
    'google: AIzaSyA1234567890abcdefghijklmnopqrstuv',
  ].join('\n');
  const { text: out, hits } = redactSecrets('src/config.ts', src);
  assert.ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.ok(!out.includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.ok(out.includes('[GITSCRIBE-REDACTED:aws-access-key-id]'));
  assert.equal(hits.length, 4);
});

test('redact: private key blocks are removed whole', () => {
  const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nkey\n-----END RSA PRIVATE KEY-----';
  const { text: out } = redactSecrets('deploy/id_rsa', key);
  assert.ok(!out.includes('MIIEow'));
  assert.ok(out.includes('[GITSCRIBE-REDACTED:private-key-block]'));
});

test('redact: env assignments only in env files, and placeholders survive', () => {
  const body = 'DATABASE_URL=postgres://real:secret@host/db\nAPI_KEY=\nSTRIPE_SECRET=<your-key-here>';
  const inEnv = redactSecrets('.env.production', body);
  assert.ok(!inEnv.text.includes('postgres://real:secret@host/db'));
  assert.ok(inEnv.text.includes('API_KEY='), 'empty value left alone');
  assert.ok(inEnv.text.includes('<your-key-here>'), 'obvious placeholder left alone');

  const elsewhere = redactSecrets('docs/setup.md', body);
  assert.ok(elsewhere.text.includes('postgres://real:secret@host/db'), 'not an env file');
});

test('redact: ordinary source is untouched', () => {
  const src = 'export const KEY = process.env.API_KEY;\nconst sk = "not-a-key";';
  const { text: out, hits } = redactSecrets('src/a.ts', src);
  assert.equal(out, src);
  assert.equal(hits.length, 0);
});

test('isEnvFile recognises the usual spellings', () => {
  for (const p of ['.env', '.env.local', 'app/.env.production']) assert.ok(isEnvFile(p), p);
  assert.ok(!isEnvFile('src/environment.ts'));
});

/* ---------------- truncation paths, end to end ---------------- */

test('digest: binary files are skipped and reported by path', async () => {
  const entries = [
    { path: 'r-sha/src/a.ts', body: text('export const a = 1;') },
    { path: 'r-sha/logo.png', body: new Uint8Array([0x89, 0x50, 0x00, 0x01, 0x02]) },
  ];
  const env = envServing(entries);
  const tree = treeOf([['src/a.ts', 19], ['logo.png', 5]]);
  const d = await buildDigest(env, new GitHubClient(env), 'o', 'r', tree, { selection: noFilter });

  assert.deepEqual(d.files.map((f) => f.path), ['src/a.ts']);
  const t = d.truncations.find((x) => x.kind === 'binary');
  assert.ok(t, 'binary truncation recorded');
  assert.deepEqual(t.paths, ['logo.png']);
});

test('digest: over-size files are skipped and reported by path', async () => {
  const big = text('x'.repeat(5000));
  const env = envServing([
    { path: 'r-sha/small.ts', body: text('ok') },
    { path: 'r-sha/huge.ts', body: big },
  ]);
  const tree = treeOf([['small.ts', 2], ['huge.ts', 5000]]);
  const d = await buildDigest(env, new GitHubClient(env), 'o', 'r', tree, {
    selection: noFilter,
    maxFileBytes: 1000,
  });

  const t = d.truncations.find((x) => x.kind === 'too-large');
  assert.ok(t, 'too-large truncation recorded');
  assert.deepEqual(t.paths, ['huge.ts']);
  assert.ok(!d.files.some((f) => f.path === 'huge.ts'));
});

test('digest: a selected file absent from the tarball is reported as missing', async () => {
  const env = envServing([{ path: 'r-sha/present.ts', body: text('ok') }]);
  // The tree claims a second file the tarball does not carry.
  const tree = treeOf([['present.ts', 2], ['ghost.ts', 100]]);
  const d = await buildDigest(env, new GitHubClient(env), 'o', 'r', tree, { selection: noFilter });

  const t = d.truncations.find((x) => x.kind === 'missing');
  assert.ok(t, 'missing truncation recorded');
  assert.deepEqual(t.paths, ['ghost.ts']);
});

test('digest: a truncated tree is reported before anything else', async () => {
  const env = envServing([{ path: 'r-sha/a.ts', body: text('ok') }]);
  const d = await buildDigest(env, new GitHubClient(env), 'o', 'r', treeOf([['a.ts', 2]], true), {
    selection: noFilter,
  });
  assert.equal(d.truncations[0]?.kind, 'tree-truncated');
  assert.match(render(d, 'md'), /INCOMPLETE/);
});

test('digest: every tree file ends up either rendered or named in a truncation', async () => {
  const env = envServing([
    { path: 'r-sha/ok.ts', body: text('fine') },
    { path: 'r-sha/bin.dat', body: new Uint8Array([0, 1, 2]) },
    { path: 'r-sha/big.ts', body: text('y'.repeat(4000)) },
  ]);
  const tree = treeOf([['ok.ts', 4], ['bin.dat', 3], ['big.ts', 4000], ['gone.ts', 9]]);
  const d = await buildDigest(env, new GitHubClient(env), 'o', 'r', tree, {
    selection: noFilter,
    maxFileBytes: 1000,
  });

  const accounted = new Set(d.files.map((f) => f.path));
  for (const t of d.truncations) for (const p of t.paths ?? []) accounted.add(p);
  const unexplained = tree.files.map((f) => f.path).filter((p) => !accounted.has(p));
  assert.deepEqual(unexplained, [], 'no file may vanish silently');
});

/* ---------------- redaction through the digest ---------------- */

test('digest: secrets are redacted by default and reported in every format', async () => {
  const env = envServing([
    { path: 'r-sha/.env', body: text('DATABASE_URL=postgres://u:p@h/db') },
    { path: 'r-sha/src/a.ts', body: text('const k = "AKIAIOSFODNN7EXAMPLE";') },
  ]);
  const tree = treeOf([['.env', 32], ['src/a.ts', 33]]);
  const d = await buildDigest(env, new GitHubClient(env), 'o', 'r', tree, { selection: noFilter });

  assert.equal(d.redactions.length, 2);
  for (const f of d.files) {
    assert.ok(!f.text.includes('AKIAIOSFODNN7EXAMPLE'));
    assert.ok(!f.text.includes('postgres://u:p@h/db'));
  }
  for (const fmt of ['md', 'xml', 'json', 'txt'] as const) {
    assert.match(render(d, fmt), /redact/i, `${fmt} must surface redactions`);
  }
});

test('digest: redaction can be switched off deliberately', async () => {
  const env = envServing([{ path: 'r-sha/src/a.ts', body: text('const k = "AKIAIOSFODNN7EXAMPLE";') }]);
  const d = await buildDigest(env, new GitHubClient(env), 'o', 'r', treeOf([['src/a.ts', 33]]), {
    selection: noFilter,
    redact: false,
  });
  assert.equal(d.redactions.length, 0);
  assert.ok(d.files[0]?.text.includes('AKIAIOSFODNN7EXAMPLE'));
});

/* ---------------- content strategy ---------------- */

test('strategy: small repo always takes the tarball, however sparse the selection', async () => {
  const { chooseStrategy } = await import('../src/content.js');
  const tree = treeOf([['a.ts', 1000], ['b.ts', 1000], ['c.ts', 1000]]);
  // 2 of 3 files, but the whole repo is 3KB — one request beats two.
  assert.equal(chooseStrategy(tree.files.slice(0, 2), tree), 'tarball');
});

test('strategy: large repo with a tiny sparse selection takes blobs', async () => {
  const { chooseStrategy } = await import('../src/content.js');
  const big = Array.from({ length: 200 }, (_, i) => [`f${i}.ts`, 500_000] as const);
  const tree = treeOf(big); // 100MB repo
  assert.equal(chooseStrategy(tree.files.slice(0, 3), tree), 'blobs');
});

test('strategy: large repo with a broad selection takes the tarball', async () => {
  const { chooseStrategy } = await import('../src/content.js');
  const big = Array.from({ length: 200 }, (_, i) => [`f${i}.ts`, 500_000] as const);
  const tree = treeOf(big);
  assert.equal(chooseStrategy(tree.files.slice(0, 100), tree), 'tarball');
});

test('budget: an unaffordable plan is refused before any request is spent', async () => {
  const { assertAffordable, RateBudgetError } = await import('../src/content.js');
  const env = envServing([]);
  const client = new GitHubClient(env);
  // Drive one request so the client has a rate snapshot (remaining: 58).
  await client.getTarball('o', 'r', 'ref').catch(() => {});
  assert.throws(() => assertAffordable(client, 5000), RateBudgetError);
  assert.doesNotThrow(() => assertAffordable(client, 1));
});

test('digest: an oversized entry is refused from the tar header, not after allocation', async () => {
  const { readTarGz } = await import('../src/tar.js');
  const big = text('x'.repeat(4000));
  const gz = gzipSync(tarball([
    { path: 'r-sha/small.ts', body: text('ok') },
    { path: 'r-sha/huge.ts', body: big },
  ]));
  const stream = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new Uint8Array(gz)); c.close(); },
  });

  const skipped: string[] = [];
  const yielded: Array<{ path: string; bytes: number }> = [];
  for await (const e of readTarGz(stream, () => true, {
    maxEntryBytes: 1000,
    onSkipped: (p) => skipped.push(p),
  })) {
    yielded.push({ path: e.path, bytes: e.bytes.length });
  }

  assert.deepEqual(skipped, ['huge.ts'], 'the oversized entry must be reported');
  assert.deepEqual(yielded.map((y) => y.path), ['small.ts']);
  // The decisive part: its bytes were never handed out at all.
  assert.ok(!yielded.some((y) => y.bytes > 1000), 'no oversized body was materialised');
});

test('digest: buildDigest still reports the oversized file by path', async () => {
  const env = envServing([
    { path: 'r-sha/small.ts', body: text('ok') },
    { path: 'r-sha/huge.ts', body: text('y'.repeat(5000)) },
  ]);
  const tree = treeOf([['small.ts', 2], ['huge.ts', 5000]]);
  const d = await buildDigest(env, new GitHubClient(env), 'o', 'r', tree, {
    selection: noFilter,
    maxFileBytes: 1000,
  });
  const t = d.truncations.find((x) => x.kind === 'too-large');
  assert.ok(t, 'still reported');
  assert.deepEqual(t.paths, ['huge.ts']);
});

/* --- GitLab: archive refused (406) must fall back, not fail --- */

test('digest: a 406 on the archive falls back to per-file reads', async () => {
  const wanted = ['src/a.ts', 'src/b.ts'];
  const fetched: string[] = [];

  const source = {
    getArchive: () => {
      const err = new Error('GitLab refused the archive download (406)') as Error & { status: number };
      err.status = 406;
      return Promise.reject(err);
    },
    getRawFile: (_project: string, _ref: string, path: string) => {
      fetched.push(path);
      return Promise.resolve(new TextEncoder().encode(`// contents of ${path}`));
    },
  };

  const env: Env = { fetch: (() => { throw new Error('no network'); }) as never, now: () => 1 };
  const tree = treeOf([['src/a.ts', 20], ['src/b.ts', 20]]);
  const d = await buildDigest(env, source as never, '', 'group/proj', tree, { selection: noFilter });

  assert.deepEqual(fetched, wanted, 'each selected file is read individually');
  assert.deepEqual(d.files.map((f) => f.path), wanted);
  assert.ok(d.files[0]!.text.includes('contents of src/a.ts'));

  // The fallback is disclosed, not silent — it costs a request per file.
  const note = d.truncations.find((t) => /read individually/.test(t.detail));
  assert.ok(note, 'the fallback must be reported in the digest');

  // The whole project path arrives as `repo`; the header must not read "/group/proj".
  assert.equal(`${d.owner}/${d.repo}`, 'group/proj');
});

test('digest: a non-406 archive failure still propagates', async () => {
  const source = {
    getArchive: () => {
      const err = new Error('boom') as Error & { status: number };
      err.status = 500;
      return Promise.reject(err);
    },
    getRawFile: () => Promise.resolve(new Uint8Array()),
  };
  const env: Env = { fetch: (() => { throw new Error('no network'); }) as never, now: () => 1 };
  await assert.rejects(
    () => buildDigest(env, source as never, '', 'g/p', treeOf([['a.ts', 5]]), { selection: noFilter }),
    /boom/,
  );
});

test('digest: oversized files are still skipped on the fallback path', async () => {
  const source = {
    getArchive: () => {
      const err = new Error('406') as Error & { status: number };
      err.status = 406;
      return Promise.reject(err);
    },
    getRawFile: (_p: string, _r: string, path: string) =>
      Promise.resolve(new TextEncoder().encode('x'.repeat(50))),
  };
  const env: Env = { fetch: (() => { throw new Error('no network'); }) as never, now: () => 1 };
  const tree = treeOf([['small.ts', 10], ['huge.ts', 9999]]);
  const d = await buildDigest(env, source as never, '', 'g/p', tree, {
    selection: noFilter, maxFileBytes: 100,
  });
  assert.deepEqual(d.files.map((f) => f.path), ['small.ts']);
  assert.ok(d.truncations.some((t) => t.paths?.includes('huge.ts')));
});
