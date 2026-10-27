import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GitLabClient } from '../src/gitlab.js';
import type { Env } from '../src/env.js';

/** A fake gitlab.com: the archive is throttled (406), the tree API has no sizes, GraphQL does. */
function fakeEnv(opts: { graphql: 'ok' | 'error' | 'partial' | 'limited' }): { env: Env; graphqlCalls: number[] } {
  const files = Array.from({ length: 200 }, (_, i) => `src/f${i}.ts`);
  const graphqlCalls: number[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = String(url);
    if (u.includes('/repository/archive')) return new Response('throttled', { status: 406 });
    if (u.includes('/repository/tree')) {
      const page = Number(new URL(u).searchParams.get('page'));
      const slice = files.slice((page - 1) * 100, page * 100).map((path) => ({ path, type: 'blob' }));
      return Response.json(slice, { headers: { 'x-next-page': page < 2 ? String(page + 1) : '', 'x-total-pages': '2' } });
    }
    if (u.endsWith('/api/graphql')) {
      const { variables } = JSON.parse(String(init?.body)) as { variables: { paths: string[] } };
      graphqlCalls.push(variables.paths.length);
      if (opts.graphql === 'error') return Response.json({ errors: [{ message: 'complexity' }] });
      if (opts.graphql === 'limited') return new Response('Rate limit exceeded', { status: 429, headers: { 'retry-after': '1092' } });
      const nodes = variables.paths
        .filter((p, i) => opts.graphql !== 'partial' || i > 0)
        .map((path) => ({ path, size: String(1000 + Number(path.match(/\d+/)![0])) }));
      return Response.json({ data: { project: { repository: { blobs: { nodes } } } } });
    }
    return new Response('not found', { status: 404 });
  };
  return { env: { fetch: fetch as typeof globalThis.fetch, now: () => 0 }, graphqlCalls };
}

test('gitlab: when the archive is refused, sizes come from GraphQL in capped batches', async () => {
  const { env, graphqlCalls } = fakeEnv({ graphql: 'ok' });
  const tree = await new GitLabClient(env).getTree('group/proj', 'main');
  assert.equal(tree.files.length, 200);
  assert.equal(tree.sizesUnknown, undefined, 'sizes are known');
  assert.equal(tree.files.find((f) => f.path === 'src/f7.ts')!.size, 1007);
  assert.ok(tree.files.every((f) => f.tokens > 0));
  assert.ok(graphqlCalls.every((n) => n <= 90), `batches ${graphqlCalls}`);
  assert.equal(graphqlCalls.reduce((a, b) => a + b, 0), 200);
  assert.equal(tree.archiveRefused, true, 'content will cost a request per file');
});

test('gitlab: if GraphQL fails or misses a file, sizes stay unknown rather than zero', async () => {
  for (const mode of ['error', 'partial'] as const) {
    const { env } = fakeEnv({ graphql: mode });
    const tree = await new GitLabClient(env).getTree('group/proj', 'main');
    assert.equal(tree.sizesUnknown, true, mode);
    assert.equal(tree.files.length, 200);
  }
});

test('gitlab: a rate-limited size lookup says why, and what helps', async () => {
  const { env } = fakeEnv({ graphql: 'limited' });
  const tree = await new GitLabClient(env).getTree('group/proj', 'main');
  assert.equal(tree.sizesUnknown, true);
  assert.match(tree.sizesNote ?? '', /rate-limited for about 19 more minute/);
  assert.match(tree.sizesNote ?? '', /digest still gives real counts/);
});
