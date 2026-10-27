import type { Env } from './env.js';

/**
 * File sizes the tree API leaves out, from GraphQL. Anonymous queries are
 * capped at complexity 200, about 2 per path plus a fixed cost, so 90 paths
 * per query fits (measured: 100 paths = 212). Null if GraphQL is unavailable.
 */
export async function blobSizes(
  env: Env,
  o: { base: string; token: string | undefined; onHeaders: (h: Headers) => void; parallel: number },
  project: string,
  ref: string,
  paths: readonly string[],
): Promise<Map<string, number> | null> {
  const BATCH = 90;
  const query =
    'query($p:ID!,$r:String!,$paths:[String!]!){project(fullPath:$p){repository{blobs(ref:$r,paths:$paths){nodes{path size}}}}}';
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
  const out = new Map<string, number>();
  const batch = async (part: readonly string[]): Promise<void> => {
    const res = await env.fetch(o.base.replace(/\/api\/v4$/, '/api/graphql'), {
      method: 'POST', headers,
      body: JSON.stringify({ query, variables: { p: project.replace(/^\/|\/$/g, ''), r: ref, paths: part } }),
    });
    o.onHeaders(res.headers);
    if (res.status === 429) {
      const wait = Math.ceil(Number(res.headers.get('retry-after') ?? 0) / 60);
      throw new Error(
        `GitLab's file-size lookup is rate-limited${wait ? ` for about ${wait} more minute(s)` : ''}` +
          '. Building the digest still gives real counts.',
      );
    }
    const body = (await res.json()) as {
      errors?: unknown[];
      data?: { project?: { repository?: { blobs?: { nodes?: Array<{ path: string; size: string | number }> } } } };
    };
    if (!res.ok || body.errors?.length) throw new Error('GraphQL size lookup failed');
    for (const n of body.data?.project?.repository?.blobs?.nodes ?? []) out.set(n.path, Number(n.size));
  };
  for (let i = 0; i < paths.length; i += BATCH * o.parallel) {
    const group: Promise<void>[] = [];
    for (let j = i; j < Math.min(paths.length, i + BATCH * o.parallel); j += BATCH) group.push(batch(paths.slice(j, j + BATCH)));
    await Promise.all(group);
  }
  return out;
}
