import type { Env } from './env.js';
import type { Forge, RepoInfo } from './forge.js';
import { GitHubError, type RateLimit, type RepoTree, type TreeFile } from './github.js';
import { readTarGz } from './tar.js';
import { estimateFromBytes } from './tokens.js';
import { blobSizes } from './gitlab-sizes.js';

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

/**
 * GitLab client.
 *
 * Verified against gitlab.com, not assumed from GitHub's shapes:
 * - `GET /projects/:urlencoded_path` -> `default_branch`, `visibility`.
 * - `GET /projects/:id/repository/tree?recursive=true` returns
 *   `{id, mode, name, path, type}` and **no size**, paginated 100 per page.
 *   For a 26k-file repository that is 260 requests and still no sizes.
 * - `GET /projects/:id/repository/archive.tar.gz?sha=ref` is a single direct
 *   200 (no redirect) carrying every file and its real size in the tar header.
 *
 * So the tree is built FROM the archive. That costs bandwidth up front but one
 * request, and it is the only way to cost files on GitLab at all. GitLab's
 * unauthenticated API limit is 500/minute (`throttle_unauthenticated_api`),
 * far more generous than GitHub's 60/hour — but archive downloads are shaped
 * separately and answer **406 Not Acceptable** (not 429) when throttled, which
 * is why that status gets its own message below.
 *
 * Because tree-then-digest would otherwise fetch the same archive twice, a
 * small archive is held in memory between the two passes.
 */
/**
 * Requests in flight while listing a tree. A 1,700-file repo needs ~42 calls
 * (tree pages + size batches); 8 at a time stays far inside 500/minute.
 */
const PARALLEL = 8;

export class GitLabClient implements Forge {
  readonly id = 'gitlab' as const;
  readonly label = 'GitLab';
  readonly treeFromArchive = true;

  private lastRate: RateLimit | null = null;
  private readonly base: string;
  /**
   * One archive, reused between the tree pass and the digest pass. Bounded so
   * a huge monorepo re-downloads instead of pinning hundreds of MB in a
   * service worker.
   */
  private cache: { key: string; bytes: Uint8Array } | null = null;
  static readonly MAX_CACHED_ARCHIVE_BYTES = 64 * 1024 * 1024;

  constructor(
    private readonly env: Env,
    private readonly opts: { token?: string | undefined; host?: string | undefined } = {},
  ) {
    this.base = `https://${opts.host ?? 'gitlab.com'}/api/v4`;
  }

  get rateLimit(): RateLimit | null {
    return this.lastRate;
  }

  private headers(): HeadersInit {
    const h: Record<string, string> = {};
    // GitLab accepts a PAT either header; PRIVATE-TOKEN is the documented one.
    if (this.opts.token) h['PRIVATE-TOKEN'] = this.opts.token;
    return h;
  }

  /** GitLab reports a per-minute budget under different header names to GitHub. */
  private noteRate(h: Headers): void {
    const limit = h.get('ratelimit-limit');
    const remaining = h.get('ratelimit-remaining');
    const reset = h.get('ratelimit-reset');
    if (limit === null || remaining === null || reset === null) return;
    this.lastRate = { limit: +limit, remaining: +remaining, resetAt: +reset * 1000 };
  }

  private async get(path: string): Promise<Response> {
    const res = await this.env.fetch(`${this.base}${path}`, { headers: this.headers() });
    this.noteRate(res.headers);
    if (!res.ok) {
      throw new GitHubError(
        res.status === 404
          ? `GitLab project not found, or it is private and needs a token.`
          : res.status === 406
            ? `GitLab is throttling archive downloads (406). This budget is separate from the API's, and a token does not lift it.`
            : `GitLab responded ${res.status} for ${path}`,
        res.status,
        this.lastRate,
      );
    }
    return res;
  }

  /** JSON from an API path, for callers outside this client (e.g. diffs). */
  async getJson<T>(path: string): Promise<T> {
    return (await (await this.get(path)).json()) as T;
  }

  /** One page of a paginated listing, and whether another follows. */
  async getPage<T>(path: string): Promise<{ body: T; next: boolean }> {
    const res = await this.get(path);
    return { body: (await res.json()) as T, next: !!res.headers.get('x-next-page') };
  }

  private encoded(project: string): string {
    return encodeURIComponent(project.replace(/^\/|\/$/g, ''));
  }

  /** Resolve a branch, tag or commit to an immutable commit SHA. */
  async resolveCommit(project: string, ref: string): Promise<string> {
    const res = await this.get(
      `/projects/${this.encoded(project)}/repository/commits/${encodeURIComponent(ref)}`,
    );
    const body = (await res.json()) as { id?: string };
    if (!body.id) throw new GitHubError(`Could not resolve ${ref} to a commit`, 200, this.lastRate);
    return body.id;
  }

  async getRepoInfo(project: string): Promise<RepoInfo> {
    const res = await this.get(`/projects/${this.encoded(project)}`);
    const body = (await res.json()) as { default_branch?: string; visibility?: string };
    return {
      defaultBranch: body.default_branch ?? 'main',
      private: body.visibility !== 'public',
    };
  }

  async getArchive(project: string, ref: string): Promise<ReadableStream<Uint8Array>> {
    const key = `${project}@${ref}`;
    if (this.cache?.key === key) return streamOf(this.cache.bytes);

    const url =
      `${this.base}/projects/${this.encoded(project)}/repository/archive.tar.gz` +
      `?sha=${encodeURIComponent(ref)}`;
    const res = await this.env.fetch(url, { headers: this.headers() });
    this.noteRate(res.headers);
    if (!res.ok) {
      throw new GitHubError(
        res.status === 406
          ? `GitLab refused the archive download (406). Archive downloads are ` +
            `rate-limited separately from the API, so a token does not lift this ` +
            `one. Falling back to reading files individually.`
          : `GitLab archive request failed (${res.status})`,
        res.status,
        this.lastRate,
      );
    }
    if (!res.body) throw new GitHubError('GitLab archive had no body', res.status, this.lastRate);

    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > 0 && declared > GitLabClient.MAX_CACHED_ARCHIVE_BYTES) {
      return res.body; // too big to hold; the second pass re-downloads
    }
    const bytes = new Uint8Array(await new Response(res.body).arrayBuffer());
    if (bytes.length <= GitLabClient.MAX_CACHED_ARCHIVE_BYTES) {
      this.cache = { key, bytes };
    }
    return streamOf(bytes);
  }

  /**
   * One file's contents. GitLab's raw endpoint costs one request per file, but
   * the API budget is 500/minute, so this is a viable fallback when archive
   * downloads are throttled.
   */
  async getRawFile(project: string, ref: string, path: string): Promise<Uint8Array> {
    const res = await this.get(
      `/projects/${this.encoded(project)}/repository/files/` +
        `${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`,
    );
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Paginated tree listing. Carries NO sizes — that is GitLab's shape. */
  private async getTreeViaApi(project: string, ref: string): Promise<RepoTree> {
    const files: TreeFile[] = [];
    const MAX_PAGES = 200;
    const fetchPage = async (page: number): Promise<{ res: Response; batch: Array<{ path?: string; type?: string }> }> => {
      const res = await this.get(
        `/projects/${this.encoded(project)}/repository/tree` +
          `?recursive=true&per_page=100&page=${page}&ref=${encodeURIComponent(ref)}`,
      );
      return { res, batch: (await res.json()) as Array<{ path?: string; type?: string }> };
    };
    const add = (batch: Array<{ path?: string; type?: string }>): void => {
      for (const e of batch) {
        if (e.type !== 'blob' || !e.path) continue;
        // Size unknown here; filled from GraphQL below, or the tree says so.
        files.push({ path: e.path, size: 0, sha: '', tokens: 0 });
      }
    };

    const first = await fetchPage(1);
    add(first.batch);
    // GitLab states the page count up front (except on very large listings), so
    // the rest can load in parallel instead of one after another.
    const total = Number(first.res.headers.get('x-total-pages') ?? 0);
    let truncated = false;
    if (total > 1) {
      const last = Math.min(total, MAX_PAGES);
      truncated = total > MAX_PAGES;
      for (let p = 2; p <= last; p += PARALLEL) {
        const pages = await Promise.all(
          Array.from({ length: Math.min(PARALLEL, last - p + 1) }, (_, k) => fetchPage(p + k)),
        );
        for (const pg of pages) add(pg.batch);
      }
    } else {
      let page = 1;
      let res = first.res;
      let batch = first.batch;
      while (res.headers.get('x-next-page') && batch.length === 100) {
        if (++page > MAX_PAGES) { truncated = true; break; }
        ({ res, batch } = await fetchPage(page));
        add(batch);
      }
    }

    let note: string | undefined;
    const sizes = await blobSizes(this.env, {
      base: this.base, token: this.opts.token, onHeaders: (h) => this.noteRate(h), parallel: PARALLEL,
    }, project, ref, files.map((f) => f.path)).catch((e: Error) => {
      note = e.message;
      return null;
    });
    if (!sizes || files.some((f) => !sizes.has(f.path))) {
      return { ref, files, truncated, sizesUnknown: true, archiveRefused: true, ...(note ? { sizesNote: note } : {}) };
    }
    const sized = files.map((f) => {
      const size = sizes.get(f.path)!;
      return { ...f, size, tokens: estimateFromBytes(f.path, size) };
    });
    return { ref, files: sized, truncated, archiveRefused: true };
  }

  /**
   * Build the tree by streaming the archive and reading tar headers. Only the
   * path and size of each entry are retained, never the bytes, so this is
   * bounded by the file COUNT rather than the repository size.
   */
  async getTree(project: string, ref: string): Promise<RepoTree> {
    let stream: ReadableStream<Uint8Array>;
    try {
      stream = await this.getArchive(project, ref);
    } catch (e) {
      // gitlab.com throttles unauthenticated archive downloads hard (406), and
      // the block outlasts a minute. Fall back to the tree API so the user at
      // least gets a file list — without sizes, which the UI must disclose.
      if (e instanceof GitHubError && e.status === 406) return this.getTreeViaApi(project, ref);
      throw e;
    }
    const files: TreeFile[] = [];
    // The filter sees every entry's path and size from the tar header and
    // returns false, so metadata is recorded while no file's bytes are ever
    // retained. One pass, bounded by file COUNT rather than repository size.
    for await (const _ of readTarGz(stream, (path, size) => {
      files.push({ path, size, sha: '', tokens: estimateFromBytes(path, size) });
      return false;
    })) {
      // The generator yields nothing: every entry was filtered out above.
    }
    return { ref, files, truncated: false };
  }
}
