import type { GitHubClient, RepoTree, TreeFile } from './github.js';
import { GitHubError } from './github.js';

/**
 * How to fetch the selected file contents.
 *
 * The tarball costs ONE request regardless of repository size but downloads
 * everything. Per-blob fetches cost one request each but download only what
 * was asked for. For a small, sparse selection the blob path is cheaper in
 * bytes; past that the tarball wins decisively on requests, which is the
 * scarce resource on the anonymous 60/hour tier.
 */
export type Strategy = 'tarball' | 'blobs';

/** Blob path only for genuinely small, sparse selections of a LARGE repo. */
export const BLOB_MAX_FILES = 25;
export const BLOB_MAX_BYTE_SHARE = 0.15;
/**
 * Below this, the whole tarball is small enough that downloading it is cheaper
 * than spending one request per file. Requests are the scarce resource on the
 * anonymous tier; bytes only start to matter once there are a lot of them.
 */
export const TARBALL_ALWAYS_BELOW_BYTES = 10_000_000;

export function chooseStrategy(selected: readonly TreeFile[], tree: RepoTree): Strategy {
  // One request always beats N.
  if (selected.length <= 1) return 'tarball';
  if (selected.length > BLOB_MAX_FILES) return 'tarball';

  const repoBytes = tree.files.reduce((n, f) => n + f.size, 0);
  if (repoBytes === 0) return 'tarball';
  // A small repo downloads whole for less than the requests would cost.
  if (repoBytes < TARBALL_ALWAYS_BELOW_BYTES) return 'tarball';

  const share = selected.reduce((n, f) => n + f.size, 0) / repoBytes;
  return share <= BLOB_MAX_BYTE_SHARE ? 'blobs' : 'tarball';
}

/** Requests this plan will spend, excluding what has already been fetched. */
export function requestCost(strategy: Strategy, selected: readonly TreeFile[]): number {
  return strategy === 'tarball' ? 1 : selected.length;
}

export interface Affordability {
  readonly cost: number;
  readonly remaining: number | null;
  readonly affordable: boolean;
}

/**
 * Pre-flight cost check. Refusing before spending is the whole point: burning
 * the last of a 60/hour budget halfway through a digest leaves the user with
 * nothing AND no way to retry.
 */
export function checkAffordable(client: GitHubClient, cost: number): Affordability {
  const remaining = client.rateLimit?.remaining ?? null;
  return { cost, remaining, affordable: remaining === null || cost <= remaining };
}

export class RateBudgetError extends GitHubError {
  constructor(readonly needed: number, readonly available: number, resetAt: number) {
    super(
      `This selection needs ${needed} request(s) but only ${available} remain ` +
        `before the limit resets at ${new Date(resetAt).toISOString()}. ` +
        `Narrow the selection, add a token, or wait.`,
      403,
      null,
    );
    this.name = 'RateBudgetError';
  }
}

export function assertAffordable(client: GitHubClient, cost: number): void {
  const a = checkAffordable(client, cost);
  if (!a.affordable) {
    throw new RateBudgetError(a.cost, a.remaining ?? 0, client.rateLimit?.resetAt ?? Date.now());
  }
}
