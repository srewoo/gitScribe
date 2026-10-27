import type { Env } from './env.js';
import { estimateFromBytes } from './tokens.js';

const API = 'https://api.github.com';

/** Hard caps documented by GitHub. Exceeding one truncates SILENTLY at the API. */
export const LIMITS = {
  /** Recursive trees truncates past either of these. */
  treeEntries: 100_000,
  treeBytes: 7_000_000,
  /** `compare` returns at most this many changed files and does not paginate. */
  compareFiles: 300,
  /** `pulls/:n/files` caps here, 100 per page = 30 requests at worst. */
  pullFiles: 3_000,
} as const;

export interface RateLimit {
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number;
}

export interface TreeFile {
  readonly path: string;
  readonly size: number;
  readonly sha: string;
  /** Estimated, never exact. See tokens.ts. */
  readonly tokens: number;
}

export interface RepoTree {
  readonly ref: string;
  readonly files: readonly TreeFile[];
  /** Set when the host truncated the listing. Never surface this silently. */
  readonly truncated: boolean;
  /**
   * Set when file sizes could not be obtained, so every per-file token figure
   * is a placeholder rather than an estimate. GitLab's tree API returns no
   * size, so this is true when the archive path was unavailable.
   */
  readonly sizesUnknown?: boolean;
  /**
   * Set when the host refused the archive while listing (GitLab 406), so
   * fetching content will cost one request per file rather than one download.
   */
  readonly archiveRefused?: boolean;
  /** Why sizes are unknown, when there is something the user can do about it. */
  readonly sizesNote?: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly rate: RateLimit | null,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

function parseRate(h: Headers): RateLimit | null {
  const limit = h.get('x-ratelimit-limit');
  const remaining = h.get('x-ratelimit-remaining');
  const reset = h.get('x-ratelimit-reset');
  if (limit === null || remaining === null || reset === null) return null;
  return { limit: +limit, remaining: +remaining, resetAt: +reset * 1000 };
}

export interface ClientOptions {
  /** Optional fine-grained PAT. Sent to api.github.com and nowhere else. */
  readonly token?: string | undefined;
}

export class GitHubClient {
  private lastRate: RateLimit | null = null;

  constructor(
    private readonly env: Env,
    private readonly opts: ClientOptions = {},
  ) {}

  get rateLimit(): RateLimit | null {
    return this.lastRate;
  }

  private headers(): HeadersInit {
    const h: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.opts.token) h['Authorization'] = `Bearer ${this.opts.token}`;
    return h;
  }

  private async get(path: string): Promise<Response> {
    const res = await this.env.fetch(`${API}${path}`, { headers: this.headers() });
    this.lastRate = parseRate(res.headers) ?? this.lastRate;
    if (!res.ok) {
      const exhausted = res.status === 403 && this.lastRate?.remaining === 0;
      throw new GitHubError(
        exhausted
          ? 'GitHub rate limit exhausted. The anonymous limit is 60 requests an hour and is shared by everyone on your IP address.'
          : `GitHub responded ${res.status} for ${path}`,
        res.status,
        this.lastRate,
      );
    }
    return res;
  }

  /** Typed GET against the REST API, with rate accounting. */
  async getJson<T>(path: string): Promise<T> {
    const res = await this.get(path);
    return (await res.json()) as T;
  }

  /**
   * One recursive call returns path, size and blob sha for every file. This is
   * what makes per-file token estimates available before any content is
   * downloaded — and therefore what makes a live-updating total possible.
   */
  async getTree(owner: string, repo: string, ref: string): Promise<RepoTree> {
    const res = await this.get(
      `/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    );
    const body = (await res.json()) as {
      truncated?: boolean;
      tree?: Array<{ path?: string; type?: string; size?: number; sha?: string }>;
    };
    const files: TreeFile[] = [];
    for (const e of body.tree ?? []) {
      if (e.type !== 'blob' || !e.path || e.sha === undefined) continue;
      const size = e.size ?? 0;
      files.push({ path: e.path, size, sha: e.sha, tokens: estimateFromBytes(e.path, size) });
    }
    return { ref, files, truncated: body.truncated === true };
  }

  /**
   * The whole repository at a ref, as a gzip stream — ONE rate-limit unit
   * regardless of size. api.github.com 302s to codeload.github.com, which
   * sends no permissive CORS header, so this only works from a context exempt
   * from CORS: the MV3 background service worker with host_permissions for
   * BOTH hosts, or Node. It will fail from a popup or content script.
   */
  async getTarball(owner: string, repo: string, ref: string): Promise<ReadableStream<Uint8Array>> {
    const url = `${API}/repos/${owner}/${repo}/tarball/${encodeURIComponent(ref)}`;
    const res = await this.env.fetch(url, { headers: this.headers(), redirect: 'follow' });
    this.lastRate = parseRate(res.headers) ?? this.lastRate;
    if (!res.ok) {
      throw new GitHubError(`Tarball request failed (${res.status})`, res.status, this.lastRate);
    }
    if (!res.body) throw new GitHubError('Tarball response had no body', res.status, this.lastRate);
    return res.body;
  }

  /**
   * One file's contents by blob SHA. Costs one request per file, so this is
   * only worth it for a small, sparse selection — see content.ts.
   */
  async getBlob(owner: string, repo: string, sha: string): Promise<Uint8Array> {
    const res = await this.get(`/repos/${owner}/${repo}/git/blobs/${sha}`);
    const body = (await res.json()) as { content?: string; encoding?: string };
    if (body.encoding !== 'base64' || body.content === undefined) {
      throw new GitHubError(`Unexpected blob encoding for ${sha}`, 200, this.lastRate);
    }
    const binary = atob(body.content.replace(/\n/g, ''));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  /**
   * Resolve a branch, tag or commit to an immutable commit SHA. Everything
   * downstream is fetched at that SHA, so a branch moving mid-session cannot
   * produce a mixed export.
   */
  async resolveCommit(owner: string, repo: string, ref: string): Promise<string> {
    const res = await this.get(
      `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`,
    );
    const body = (await res.json()) as { sha?: string };
    if (!body.sha) throw new GitHubError(`Could not resolve ${ref} to a commit`, 200, this.lastRate);
    return body.sha;
  }

  /** Default branch and visibility, for the header. */
  async getRepo(owner: string, repo: string): Promise<{ defaultBranch: string; private: boolean }> {
    const res = await this.get(`/repos/${owner}/${repo}`);
    const body = (await res.json()) as { default_branch?: string; private?: boolean };
    return { defaultBranch: body.default_branch ?? 'main', private: body.private === true };
  }
}
