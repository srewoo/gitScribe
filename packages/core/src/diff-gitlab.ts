import type { Env } from './env.js';
import type { GitLabClient } from './gitlab.js';
import type { Truncation } from './digest.js';
import { assembleDiff, type ChangedFile, type DiffDigest, type DiffOptions } from './diff.js';

/**
 * GitLab merge requests and comparisons, in the same shape as GitHub's so the
 * renderers, redaction and reporting are shared.
 *
 * GitLab returns raw hunks without per-file counts, so additions and deletions
 * are counted from the hunks. It flags diffs it will not render (`too_large`,
 * `collapsed`) and comparisons that ran out of time (`compare_timeout`); both
 * are reported, never dropped silently.
 */

interface RawDiff {
  old_path?: string;
  new_path?: string;
  diff?: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  too_large?: boolean;
  collapsed?: boolean;
}

function toChanged(raw: RawDiff): ChangedFile | null {
  const path = raw.new_path ?? raw.old_path;
  if (!path) return null;
  let additions = 0;
  let deletions = 0;
  for (const line of (raw.diff ?? '').split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    else if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  const status = raw.new_file ? 'added' : raw.deleted_file ? 'removed' : raw.renamed_file ? 'renamed' : 'modified';
  return {
    path, status, additions, deletions,
    // An empty diff on a rename is a pure rename; on a flagged file it was withheld.
    patch: raw.diff || (raw.renamed_file && !raw.too_large && !raw.collapsed) ? raw.diff ?? '' : null,
    ...(raw.renamed_file && raw.old_path ? { previousPath: raw.old_path } : {}),
  };
}

const project = (p: string): string => encodeURIComponent(p.replace(/^\/|\/$/g, ''));
/** Renderers print `owner/repo`; a GitLab path nests, so split at the last slash. */
const ownerRepo = (p: string): [string, string] => {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i), p.slice(i + 1)];
};

export async function fetchMergeRequest(
  env: Env,
  client: GitLabClient,
  path: string,
  iid: number,
  opts: DiffOptions = {},
): Promise<DiffDigest> {
  const base = `/projects/${project(path)}/merge_requests/${iid}`;
  const meta = await client.getJson<{ title?: string; source_branch?: string; target_branch?: string; changes_count?: string }>(base);
  const maxRequests = opts.maxRequests ?? 30;
  const files: ChangedFile[] = [];
  const truncations: Truncation[] = [];

  for (let page = 1; ; page++) {
    const { body, next } = await client.getPage<RawDiff[]>(`${base}/diffs?per_page=100&page=${page}`);
    for (const raw of body) {
      const f = toChanged(raw);
      if (f) files.push(f);
    }
    if (!next) break;
    if (page === maxRequests) {
      truncations.push({ kind: 'missing', detail: `Stopped after ${maxRequests} pages (${files.length} files); each page costs a request.` });
      break;
    }
  }
  // GitLab reports "1000+" when it stopped counting; a plain number is checkable.
  const declared = Number(meta.changes_count);
  if (Number.isFinite(declared) && declared > files.length) {
    truncations.push({ kind: 'missing', detail: `GitLab reports ${declared} changed files but returned ${files.length}.` });
  } else if (meta.changes_count?.endsWith('+')) {
    truncations.push({ kind: 'missing', detail: `GitLab reports ${meta.changes_count} changed files, so this may not be all of them.` });
  }

  return assembleDiff(env, ...ownerRepo(path), 'pr', {
    base: meta.target_branch ?? 'base', head: meta.source_branch ?? 'head',
    title: meta.title ?? `Merge request !${iid}`, files, truncations, redact: opts.redact ?? true,
  });
}

export async function fetchGitLabCompare(
  env: Env,
  client: GitLabClient,
  path: string,
  from: string,
  to: string,
  opts: DiffOptions = {},
): Promise<DiffDigest> {
  const cmp = await client.getJson<{ commits?: unknown[]; diffs?: RawDiff[]; compare_timeout?: boolean }>(
    `/projects/${project(path)}/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
  );
  const files = (cmp.diffs ?? []).map(toChanged).filter((f): f is ChangedFile => f !== null);
  const truncations: Truncation[] = cmp.compare_timeout
    ? [{ kind: 'missing', detail: 'GitLab timed out building this comparison, so it may be incomplete. Compare a narrower range.' }]
    : [];
  const n = cmp.commits?.length ?? 0;
  return assembleDiff(env, ...ownerRepo(path), 'compare', {
    base: from, head: to, title: `${from}...${to}${n ? ` (${n} commits)` : ''}`,
    files, truncations, redact: opts.redact ?? true,
  });
}
