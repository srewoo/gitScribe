/**
 * Repository identity and immutable snapshots.
 *
 * The cache was keyed by `forge:project@ref`, where `ref` is often a moving
 * branch. Two consequences, both silent:
 *
 *   - `main` moves, the cached tree is reused, and the export describes a
 *     revision that no longer exists.
 *   - Two self-hosted GitLab origins hosting the same project path share a
 *     cache entry, so one repository's tree can be served for another's.
 *
 * A snapshot pins a resolved commit, and identity includes the origin. Every
 * export, artifact and job carries the snapshot, so what was read is always
 * recoverable.
 */

export interface RepoIdentity {
  readonly forge: 'github' | 'gitlab';
  /** Canonical host, e.g. `github.com` or `gitlab.example.com`. */
  readonly origin: string;
  /** Canonical project path: `owner/repo`, or a nested GitLab group path. */
  readonly project: string;
}

export interface Snapshot {
  readonly repository: RepoIdentity;
  /** What the user asked for: a branch, tag, or commit. For display. */
  readonly requestedRef: string;
  /** What it resolved to. Everything is fetched at this commit. */
  readonly resolvedCommit: string;
  readonly resolvedAt: number;
}

export function identityKey(id: RepoIdentity): string {
  return `${id.forge}://${id.origin.toLowerCase()}/${id.project}`;
}

/**
 * Cache key for immutable content. Contains the resolved commit, never a
 * branch name, so an entry can never go stale — only unused.
 */
export function snapshotKey(s: Snapshot): string {
  return `${identityKey(s.repository)}@${s.resolvedCommit}`;
}

/** Separate, deliberately short-lived: which commit a moving ref points at. */
export interface RefResolution {
  readonly commit: string;
  readonly resolvedAt: number;
}

/**
 * How long a branch→commit resolution may be reused before re-checking.
 * Immutable content needs no TTL; only this mapping does.
 */
export const REF_FRESHNESS_MS = 60_000;

export class RefCache {
  private readonly entries = new Map<string, RefResolution>();

  private key(id: RepoIdentity, ref: string): string {
    return `${identityKey(id)}#${ref}`;
  }

  get(id: RepoIdentity, ref: string, now: number): string | null {
    const hit = this.entries.get(this.key(id, ref));
    if (!hit) return null;
    if (now - hit.resolvedAt > REF_FRESHNESS_MS) return null;
    return hit.commit;
  }

  set(id: RepoIdentity, ref: string, commit: string, now: number): void {
    this.entries.set(this.key(id, ref), { commit, resolvedAt: now });
  }

  /** Called on explicit reload: forget the mapping, keep immutable content. */
  invalidate(id: RepoIdentity, ref?: string): void {
    if (ref !== undefined) {
      this.entries.delete(this.key(id, ref));
      return;
    }
    const prefix = `${identityKey(id)}#`;
    for (const k of [...this.entries.keys()]) {
      if (k.startsWith(prefix)) this.entries.delete(k);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/** A 40- or 64-char hex string is already a commit and needs no resolution. */
export function looksLikeCommit(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref) || /^[0-9a-f]{64}$/i.test(ref);
}

/**
 * Content keyed by resolved commit. Unlike the ref cache this needs no TTL,
 * because the key names an immutable object.
 */
export class SnapshotCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly maxEntries = 8) {}

  get(s: Snapshot): T | undefined {
    return this.entries.get(snapshotKey(s));
  }

  set(s: Snapshot, value: T): void {
    const key = snapshotKey(s);
    // Simple LRU-ish bound: drop the oldest insertion when full.
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.delete(key);
    this.entries.set(key, value);
  }

  /** Drop everything for one repository — used when credentials change. */
  invalidateRepo(id: RepoIdentity): void {
    const prefix = `${identityKey(id)}@`;
    for (const k of [...this.entries.keys()]) {
      if (k.startsWith(prefix)) this.entries.delete(k);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
