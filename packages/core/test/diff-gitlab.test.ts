import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GitLabClient } from '../src/gitlab.js';
import { fetchMergeRequest, fetchGitLabCompare } from '../src/diff-gitlab.js';
import { parseChangeSpec } from '../src/diff.js';
import type { Env } from '../src/env.js';

const SECRET = 'AKIA' + 'Z7Q2EXAMPLEKEY42';
const diffs = [
  { old_path: 'a.ts', new_path: 'a.ts', diff: '@@ -1,2 +1,3 @@\n line\n-old\n+new\n+more\n' },
  { old_path: 'b.ts', new_path: 'b.ts', new_file: true, diff: `@@ -0,0 +1 @@\n+const key = "${SECRET}";\n` },
  { old_path: 'old.ts', new_path: 'renamed.ts', renamed_file: true, diff: '' },
  { old_path: 'gone.ts', new_path: 'gone.ts', deleted_file: true, diff: '@@ -1 +0,0 @@\n-bye\n' },
  { old_path: 'big.json', new_path: 'big.json', too_large: true, diff: '' },
];

function fakeEnv(): { env: Env; urls: string[] } {
  const urls: string[] = [];
  const fetch = async (url: string | URL | Request): Promise<Response> => {
    const u = String(url);
    urls.push(u);
    if (/merge_requests\/7$/.test(u)) {
      return Response.json({ title: 'Add login', source_branch: 'feat/login', target_branch: 'main', changes_count: '5' });
    }
    if (u.includes('merge_requests/7/diffs')) {
      const page = Number(new URL(u).searchParams.get('page'));
      const slice = page === 1 ? diffs.slice(0, 3) : diffs.slice(3);
      return Response.json(slice, { headers: { 'x-next-page': page === 1 ? '2' : '' } });
    }
    if (u.includes('/repository/compare')) {
      return Response.json({ commits: [{}, {}, {}], diffs: diffs.slice(0, 2), compare_timeout: true });
    }
    return new Response('nope', { status: 404 });
  };
  return { env: { fetch: fetch as typeof globalThis.fetch, now: () => 1 }, urls };
}

test('gitlab MR: paginated diffs, statuses, counts from hunks, secrets redacted', async () => {
  const { env } = fakeEnv();
  const d = await fetchMergeRequest(env, new GitLabClient(env), 'group/proj', 7);
  assert.equal(d.kind, 'pr');
  assert.equal(d.title, 'Add login');
  assert.equal(`${d.owner}/${d.repo}`, 'group/proj', 'no leading slash in headers');
  assert.equal(d.base, 'main');
  assert.equal(d.head, 'feat/login');
  assert.deepEqual(d.files.map((f) => `${f.status}:${f.path}`), [
    'modified:a.ts', 'added:b.ts', 'renamed:renamed.ts', 'removed:gone.ts', 'modified:big.json',
  ]);
  assert.equal(d.files[2]!.previousPath, 'old.ts');
  assert.equal(d.additions, 3);
  assert.equal(d.deletions, 2);
  assert.ok(!JSON.stringify(d.files).includes(SECRET), 'redacted');
  assert.equal(d.redactions.length, 1);
  assert.ok(d.truncations.some((t) => t.paths?.includes('big.json')), 'too-large diff reported');
});

test('gitlab compare: a timed-out comparison is reported as incomplete', async () => {
  const { env, urls } = fakeEnv();
  const d = await fetchGitLabCompare(env, new GitLabClient(env), 'group/proj', 'v1.0', 'main');
  assert.equal(d.kind, 'compare');
  assert.match(d.title, /v1\.0\.\.\.main \(3 commits\)/);
  assert.equal(d.files.length, 2);
  assert.ok(d.truncations.some((t) => /timed out/.test(t.detail)));
  assert.ok(urls.some((u) => u.includes('from=v1.0') && u.includes('to=main')));
});

test('change spec: GitLab merge request forms', () => {
  assert.deepEqual(parseChangeSpec('!42'), { kind: 'pr', number: 42 });
  assert.deepEqual(parseChangeSpec('https://gitlab.com/g/p/-/merge_requests/42'), { kind: 'pr', number: 42 });
});
