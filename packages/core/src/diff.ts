import type { Env } from './env.js';
import { GitHubClient, GitHubError, LIMITS } from './github.js';
import { estimateFromText } from './tokens.js';
import { redactSecrets } from './redact.js';
import type { Truncation, RedactionRecord } from './digest.js';

/**
 * Change digests: a pull request, a commit range, or a branch comparison.
 *
 * The hard part is not the plumbing, it is GitHub's caps. `compare` returns at
 * most 300 changed files and does NOT paginate past the first page, so a
 * larger comparison is silently incomplete unless we check and say so. Every
 * cap encountered becomes a Truncation naming the shortfall.
 */

export type ChangeKind = 'pr' | 'compare';

export interface ChangedFile {
  readonly path: string;
  readonly status: string;
  readonly additions: number;
  readonly deletions: number;
  /** Absent for binary files and for diffs GitHub declines to render. */
  readonly patch: string | null;
  readonly previousPath?: string;
}

export interface DiffDigest {
  readonly owner: string;
  readonly repo: string;
  readonly kind: ChangeKind;
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly files: readonly ChangedFile[];
  readonly additions: number;
  readonly deletions: number;
  readonly totalTokens: number;
  readonly estimated: true;
  readonly truncations: readonly Truncation[];
  readonly redactions: readonly RedactionRecord[];
  readonly generatedAt: number;
}

interface RawFile {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  previous_filename?: string;
}

function toChanged(raw: RawFile): ChangedFile | null {
  if (!raw.filename) return null;
  return {
    path: raw.filename,
    status: raw.status ?? 'modified',
    additions: raw.additions ?? 0,
    deletions: raw.deletions ?? 0,
    patch: raw.patch ?? null,
    ...(raw.previous_filename ? { previousPath: raw.previous_filename } : {}),
  };
}

export interface DiffOptions {
  readonly redact?: boolean;
  /** Stop after this many requests when paginating a large PR. */
  readonly maxRequests?: number;
}

/** A pull request's changed files, paginated up to GitHub's 3,000-file cap. */
export async function fetchPullRequest(
  env: Env,
  client: GitHubClient,
  owner: string,
  repo: string,
  number: number,
  opts: DiffOptions = {},
): Promise<DiffDigest> {
  const meta = await client.getJson<{
    title?: string;
    base?: { ref?: string };
    head?: { ref?: string };
    changed_files?: number;
  }>(`/repos/${owner}/${repo}/pulls/${number}`);

  const declared = meta.changed_files ?? 0;
  const maxRequests = opts.maxRequests ?? 30;
  const files: ChangedFile[] = [];
  const truncations: Truncation[] = [];

  for (let page = 1; page <= maxRequests; page++) {
    const batch = await client.getJson<RawFile[]>(
      `/repos/${owner}/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
    );
    for (const raw of batch) {
      const f = toChanged(raw);
      if (f) files.push(f);
    }
    if (batch.length < 100) break;
    if (page === maxRequests) {
      truncations.push({
        kind: 'missing',
        detail:
          `Stopped after ${maxRequests} pages (${files.length} files). GitHub caps ` +
          `pull request file listings at ${LIMITS.pullFiles.toLocaleString()} files, ` +
          `and each page costs a request.`,
      });
    }
  }

  if (declared > files.length) {
    truncations.push({
      kind: 'missing',
      detail: `GitHub reports ${declared} changed files but returned ${files.length}. ${
        declared - files.length
      } are missing from this digest.`,
    });
  }

  return assemble(env, owner, repo, 'pr', {
    base: meta.base?.ref ?? 'base',
    head: meta.head?.ref ?? 'head',
    title: meta.title ?? `Pull request #${number}`,
    files,
    truncations,
    redact: opts.redact ?? true,
  });
}

/**
 * A commit range or branch comparison. Hard-capped by GitHub at 300 files with
 * no pagination — this reports the shortfall rather than hiding it.
 */
export async function fetchCompare(
  env: Env,
  client: GitHubClient,
  owner: string,
  repo: string,
  base: string,
  head: string,
  opts: DiffOptions = {},
): Promise<DiffDigest> {
  const cmp = await client.getJson<{
    files?: RawFile[];
    total_commits?: number;
    status?: string;
  }>(`/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);

  const files = (cmp.files ?? []).map(toChanged).filter((f): f is ChangedFile => f !== null);
  const truncations: Truncation[] = [];

  if (files.length >= LIMITS.compareFiles) {
    truncations.push({
      kind: 'missing',
      detail:
        `This comparison hit GitHub's ${LIMITS.compareFiles}-file cap. The compare ` +
        `endpoint does not paginate past the first page, so any file beyond ${LIMITS.compareFiles} ` +
        `is absent and cannot be recovered from this endpoint. Digest a narrower ` +
        `range, or select the files from the repository tree instead.`,
    });
  }

  return assemble(env, owner, repo, 'compare', {
    base,
    head,
    title: `${base}...${head}${cmp.total_commits ? ` (${cmp.total_commits} commits)` : ''}`,
    files,
    truncations,
    redact: opts.redact ?? true,
  });
}

function assemble(
  env: Env,
  owner: string,
  repo: string,
  kind: ChangeKind,
  d: {
    base: string;
    head: string;
    title: string;
    files: ChangedFile[];
    truncations: Truncation[];
    redact: boolean;
  },
): DiffDigest {
  const redactions: RedactionRecord[] = [];
  const noPatch: string[] = [];
  let tokens = 0;
  let additions = 0;
  let deletions = 0;

  const files = d.files.map((f) => {
    additions += f.additions;
    deletions += f.deletions;
    if (f.patch === null) {
      noPatch.push(f.path);
      return f;
    }
    let patch = f.patch;
    if (d.redact) {
      const r = redactSecrets(f.path, patch);
      patch = r.text;
      for (const h of r.hits) redactions.push({ path: f.path, kind: h.kind, count: h.count });
    }
    tokens += estimateFromText(f.path, patch);
    return { ...f, patch };
  });

  const truncations = [...d.truncations];
  if (noPatch.length) {
    truncations.push({
      kind: 'binary',
      detail: `${noPatch.length} file(s) have no rendered diff (binary, or too large for GitHub to render).`,
      paths: noPatch,
    });
  }

  return {
    owner,
    repo,
    kind,
    base: d.base,
    head: d.head,
    title: d.title,
    files,
    additions,
    deletions,
    totalTokens: tokens,
    estimated: true,
    truncations,
    redactions,
    generatedAt: env.now(),
  };
}

/** `owner/repo#123`, a PR URL, `base...head`, or `base..head`. */
export function parseChangeSpec(
  spec: string,
): { kind: 'pr'; number: number } | { kind: 'compare'; base: string; head: string } {
  const prUrl = /\/pull\/(\d+)/.exec(spec);
  if (prUrl) return { kind: 'pr', number: Number(prUrl[1]) };
  const hash = /#(\d+)\s*$/.exec(spec);
  if (hash) return { kind: 'pr', number: Number(hash[1]) };
  if (/^\d+$/.test(spec.trim())) return { kind: 'pr', number: Number(spec.trim()) };

  const range = /^(.+?)\.{2,3}(.+)$/.exec(spec.trim());
  if (range) return { kind: 'compare', base: range[1]!, head: range[2]! };

  throw new GitHubError(
    `Could not read a pull request or commit range from ${JSON.stringify(spec)}. ` +
      `Try "1234", a pull request URL, or "v1.0...main".`,
    400,
    null,
  );
}
