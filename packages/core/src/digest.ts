import type { Env } from './env.js';
import { GitHubClient, LIMITS, type RepoTree } from './github.js';

/**
 * The minimum a provider must offer to produce a digest. GitHubClient and
 * GitLabClient both satisfy it, with different call shapes underneath.
 */
export interface ArchiveSource {
  getArchive(project: string, ref: string): Promise<ReadableStream<Uint8Array>>;
  getBlob?(project: string, sha: string): Promise<Uint8Array>;
  /**
   * One file's bytes. GitLab throttles archive downloads on a budget separate
   * from its API, so when the archive is refused this is the only way to get
   * content — and its API budget is generous enough to make it viable.
   */
  getRawFile?(project: string, ref: string, path: string): Promise<Uint8Array>;
}
import { applySelection, type Selection } from './select.js';
import { readTarGz } from './tar.js';
import { estimateFromText } from './tokens.js';
import { redactSecrets } from './redact.js';
import { chooseStrategy, requestCost, assertAffordable, type Strategy } from './content.js';

/** A file that could not be included, and why. Never dropped silently. */
export interface Truncation {
  readonly kind: 'tree-truncated' | 'binary' | 'too-large' | 'missing';
  readonly detail: string;
  readonly paths?: readonly string[];
}

/** A secret found and replaced, reported per file. Never silent. */
export interface RedactionRecord {
  readonly path: string;
  readonly kind: string;
  readonly count: number;
}

export interface DigestFile {
  readonly path: string;
  readonly text: string;
  readonly tokens: number;
}

export interface Digest {
  readonly owner: string;
  readonly repo: string;
  readonly ref: string;
  readonly files: readonly DigestFile[];
  readonly totalTokens: number;
  /** Always true. Every count in this project is an estimate. */
  readonly estimated: true;
  readonly truncations: readonly Truncation[];
  /** Secrets replaced before the digest left the machine. */
  readonly redactions: readonly RedactionRecord[];
  readonly generatedAt: number;
}

/**
 * Parallel reads for the per-file fallback. Kept small deliberately: the point
 * is to stop wasting a generous rate budget on sequential waits, not to race
 * the host into throttling us again.
 */
const RAW_CONCURRENCY = 6;

/** Heuristic: a NUL byte in the first 8KB means binary. */
function isBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

export interface BuildOptions {
  readonly selection: Selection;
  /** Skip any single file above this many bytes. */
  readonly maxFileBytes?: number;
  /** Redact committed credentials before they reach a prompt. Default true. */
  readonly redact?: boolean;
  /** Override the automatic tarball-vs-blobs choice. */
  readonly strategy?: Strategy;
  /** Refuse before spending requests we do not have. Default true. */
  readonly checkBudget?: boolean;
  readonly onProgress?: (done: number, total: number) => void;
}

/**
 * Build a complete digest by streaming the repository tarball once. Files are
 * decoded only if the selection keeps them, so peak memory tracks the
 * selection rather than the repository.
 */
export async function buildDigest(
  env: Env,
  client: GitHubClient | ArchiveSource,
  owner: string,
  repo: string,
  tree: RepoTree,
  opts: BuildOptions,
): Promise<Digest> {
  const isGitHub = client instanceof GitHubClient;
  const project = isGitHub ? repo : `${owner}${owner && repo ? '/' : ''}${repo}`;
  const maxFileBytes = opts.maxFileBytes ?? 2_000_000;
  const doRedact = opts.redact ?? true;
  const { files: wanted } = applySelection(tree.files, opts.selection);
  const want = new Set(wanted.map((f) => f.path));

  const truncations: Truncation[] = [];
  /** Recorded when the archive was refused and we fell back to per-file reads. */
  let contentFallback: string | null = null;
  if (tree.truncated) {
    truncations.push({
      kind: 'tree-truncated',
      detail:
        `GitHub truncated the file listing for this repository (caps: ` +
        `${LIMITS.treeEntries.toLocaleString()} entries or ` +
        `${(LIMITS.treeBytes / 1e6).toFixed(0)}MB). Files beyond the cap are ` +
        `not listed and therefore cannot be included.`,
    });
  }

  // Blob-by-sha only exists on GitHub; GitLab tree entries carry no blob sha,
  // so its only content path is the archive.
  const strategy = isGitHub ? (opts.strategy ?? chooseStrategy(wanted, tree)) : 'tarball';
  if (isGitHub && opts.checkBudget !== false) {
    assertAffordable(client, requestCost(strategy, wanted));
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const out: DigestFile[] = [];
  const binary: string[] = [];
  const tooLarge: string[] = [];  // filled by the tar header gate, and below
  const redactions: RedactionRecord[] = [];
  let total = 0;
  let seen = 0;

  async function* entries(): AsyncGenerator<{ path: string; size: number; bytes: Uint8Array }> {
    if (strategy === 'tarball') {
      let stream: ReadableStream<Uint8Array>;
      if (isGitHub) {
        stream = await client.getTarball(owner, repo, tree.ref);
      } else {
        const src = client as ArchiveSource;
        try {
          stream = await src.getArchive(project, tree.ref);
        } catch (e) {
          // GitLab answers 406 when it is shaping archive downloads. A token
          // does not lift that budget, so fall back to reading the selected
          // files one at a time through the ordinary API.
          const status = (e as { status?: number } | null)?.status;
          if (status !== 406 || typeof src.getRawFile !== 'function') throw e;
          contentFallback =
            `The archive download was refused (406), so ${wanted.length} selected file(s) ` +
            `were read individually through the API instead. This costs one request per file.`;

          // Bounded concurrency: sequential reads took ~136s for 277 files.
          // GitLab's API budget is 500/minute, so a small pool is well within
          // it while cutting wall time by roughly the pool size.
          const pending = wanted.filter((f) => {
            if (f.size > maxFileBytes) { tooLarge.push(f.path); return false; }
            return true;
          });
          const getRaw = src.getRawFile.bind(src);
          let next = 0;
          const inflight = new Map<number, Promise<{ i: number; path: string; bytes: Uint8Array }>>();
          const start = (): void => {
            const i = next++;
            const f = pending[i];
            if (!f) return;
            inflight.set(
              i,
              getRaw(project, tree.ref, f.path).then((bytes) => ({ i, path: f.path, bytes })),
            );
          };
          for (let k = 0; k < Math.min(RAW_CONCURRENCY, pending.length); k++) start();
          while (inflight.size > 0) {
            const done = await Promise.race(inflight.values());
            inflight.delete(done.i);
            start();
            yield { path: done.path, size: done.bytes.length, bytes: done.bytes };
          }
          return;
        }
      }
      // The limit is enforced from the tar HEADER so an oversized entry is
      // never materialised. Checking after the read omitted the content but
      // still paid its memory cost, which defeats the point of a limit.
      yield* readTarGz(stream, (p) => want.has(p), {
        maxEntryBytes: maxFileBytes,
        onSkipped: (path) => tooLarge.push(path),
      });
      return;
    }
    for (const f of wanted) {
      const bytes = await (client as GitHubClient).getBlob(owner, repo, f.sha);
      yield { path: f.path, size: bytes.length, bytes };
    }
  }

  for await (const entry of entries()) {
    seen++;
    // Tarball entries were already gated by header size above; this catches
    // the per-blob path, where no header is available until after the fetch.
    if (entry.size > maxFileBytes) {
      if (!tooLarge.includes(entry.path)) tooLarge.push(entry.path);
    } else if (isBinary(entry.bytes)) {
      binary.push(entry.path);
    } else {
      const decoded = decoder.decode(entry.bytes);
      let text = decoded;
      if (doRedact) {
        const r = redactSecrets(entry.path, decoded);
        text = r.text;
        for (const h of r.hits) {
          redactions.push({ path: entry.path, kind: h.kind, count: h.count });
        }
      }
      const tokens = estimateFromText(entry.path, text);
      out.push({ path: entry.path, text, tokens });
      total += tokens;
    }
    opts.onProgress?.(seen, want.size);
  }

  const delivered = new Set(out.map((f) => f.path));
  const missing = [...want].filter(
    (p) => !delivered.has(p) && !binary.includes(p) && !tooLarge.includes(p),
  );

  if (binary.length) {
    truncations.push({ kind: 'binary', detail: `${binary.length} binary file(s) skipped.`, paths: binary });
  }
  if (tooLarge.length) {
    truncations.push({
      kind: 'too-large',
      detail: `${tooLarge.length} file(s) above ${(maxFileBytes / 1e6).toFixed(1)}MB skipped.`,
      paths: tooLarge,
    });
  }
  if (contentFallback !== null) {
    truncations.push({ kind: 'missing', detail: contentFallback });
  }
  if (missing.length) {
    truncations.push({
      kind: 'missing',
      detail: `${missing.length} selected file(s) were not present in the tarball.`,
      paths: missing,
    });
  }

  out.sort((a, b) => a.path.localeCompare(b.path));
  return {
    owner,
    repo,
    ref: tree.ref,
    files: out,
    totalTokens: total,
    estimated: true,
    truncations,
    redactions,
    generatedAt: env.now(),
  };
}
