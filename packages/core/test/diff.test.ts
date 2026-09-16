import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchPullRequest, fetchCompare, parseChangeSpec } from '../src/diff.js';
import { GitHubClient } from '../src/github.js';
import { renderDiff } from '../src/render.js';
import type { Env } from '../src/env.js';

/** An Env that answers canned JSON per URL substring. */
function envRouting(routes: ReadonlyArray<readonly [string, unknown]>): Env {
  const fetchFn = (async (url: string) => {
    for (const [frag, body] of routes) {
      if (String(url).includes(frag)) {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-limit': '60',
            'x-ratelimit-remaining': '55',
            'x-ratelimit-reset': '1',
          },
        });
      }
    }
    return new Response('{}', { status: 404, headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '55', 'x-ratelimit-reset': '1' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchFn, now: () => 1_758_000_000_000 };
}

const file = (n: number) => ({
  filename: `src/f${n}.ts`,
  status: 'modified',
  additions: 3,
  deletions: 1,
  patch: `@@ -1 +1 @@\n-old${n}\n+new${n}`,
});

test('parseChangeSpec reads PR numbers, URLs and ranges', () => {
  assert.deepEqual(parseChangeSpec('1234'), { kind: 'pr', number: 1234 });
  assert.deepEqual(parseChangeSpec('https://github.com/a/b/pull/99'), { kind: 'pr', number: 99 });
  assert.deepEqual(parseChangeSpec('a/b#7'), { kind: 'pr', number: 7 });
  assert.deepEqual(parseChangeSpec('v1.0...main'), { kind: 'compare', base: 'v1.0', head: 'main' });
  assert.deepEqual(parseChangeSpec('abc..def'), { kind: 'compare', base: 'abc', head: 'def' });
  assert.throws(() => parseChangeSpec('nonsense'));
});

test('compare at the 300-file cap reports the shortfall explicitly', async () => {
  const files = Array.from({ length: 300 }, (_, i) => file(i));
  const env = envRouting([['/compare/', { files, total_commits: 214 }]]);
  const d = await fetchCompare(env, new GitHubClient(env), 'o', 'r', 'v1', 'main');

  assert.equal(d.files.length, 300);
  const t = d.truncations.find((x) => /300-file cap/.test(x.detail));
  assert.ok(t, 'the cap must be reported, not hidden');
  // and it must reach the rendered output in every format
  for (const fmt of ['md', 'xml', 'json', 'txt'] as const) {
    assert.match(renderDiff(d, fmt), /300/, `${fmt} must carry the cap notice`);
  }
});

test('compare below the cap reports no truncation', async () => {
  const env = envRouting([['/compare/', { files: [file(1), file(2)], total_commits: 3 }]]);
  const d = await fetchCompare(env, new GitHubClient(env), 'o', 'r', 'a', 'b');
  assert.equal(d.truncations.length, 0);
  assert.equal(d.additions, 6);
  assert.equal(d.deletions, 2);
});

test('a PR reporting more changed files than it returns is flagged', async () => {
  const env = envRouting([
    ['/pulls/5/files', [file(1), file(2)]],
    ['/pulls/5', { title: 'Fix things', base: { ref: 'main' }, head: { ref: 'fix' }, changed_files: 9 }],
  ]);
  const d = await fetchPullRequest(env, new GitHubClient(env), 'o', 'r', 5);
  const t = d.truncations.find((x) => /9 changed files but returned 2/.test(x.detail));
  assert.ok(t, 'the discrepancy must be named');
});

test('files with no rendered diff are reported, not dropped silently', async () => {
  const env = envRouting([
    ['/compare/', { files: [file(1), { filename: 'logo.png', status: 'modified', additions: 0, deletions: 0 }] }],
  ]);
  const d = await fetchCompare(env, new GitHubClient(env), 'o', 'r', 'a', 'b');
  const t = d.truncations.find((x) => x.kind === 'binary');
  assert.ok(t);
  assert.deepEqual(t.paths, ['logo.png']);
  assert.equal(d.files.length, 2, 'the file itself stays listed');
});

test('secrets inside a patch are redacted', async () => {
  const env = envRouting([
    ['/compare/', { files: [{
      filename: '.env',
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: '@@ -0,0 +1 @@\n+AWS=AKIAIOSFODNN7EXAMPLE',
    }] }],
  ]);
  const d = await fetchCompare(env, new GitHubClient(env), 'o', 'r', 'a', 'b');
  assert.ok(!d.files[0]!.patch!.includes('AKIAIOSFODNN7EXAMPLE'));
  assert.equal(d.redactions.length, 1);
});

test('renderDiff json is parseable and keeps the file list', async () => {
  const env = envRouting([['/compare/', { files: [file(1)] }]]);
  const d = await fetchCompare(env, new GitHubClient(env), 'o', 'r', 'a', 'b');
  const parsed = JSON.parse(renderDiff(d, 'json')) as { files: unknown[]; estimated: boolean };
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.estimated, true);
});
