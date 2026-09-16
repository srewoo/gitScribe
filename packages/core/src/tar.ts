/**
 * Streaming tar reader over a gzip stream.
 *
 * GitHub's tarball costs ONE rate-limit unit regardless of repository size,
 * where per-blob fetches cost one each. Decompression uses the platform's
 * native DecompressionStream, present in both the MV3 service worker and
 * Node 18+, so there is no bundled inflate.
 */

const BLOCK = 512;

export interface TarEntry {
  readonly path: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

/** Caller decides which entries to keep, by path, before bytes are retained. */
export type EntryFilter = (path: string, size: number) => boolean;

export interface ReadLimits {
  /** Refuse any single entry whose HEADER declares more than this. */
  readonly maxEntryBytes?: number;
  /** Stop once this many decompressed bytes have been yielded. */
  readonly maxTotalBytes?: number;
  /** Stop after this many entries, whatever their size. */
  readonly maxEntries?: number;
  /** Called when an entry is refused, so the caller can record the omission. */
  readonly onSkipped?: (path: string, size: number, reason: 'too-large') => void;
  readonly signal?: AbortSignal;
}

function readString(buf: Uint8Array, offset: number, length: number): string {
  let end = offset;
  const limit = offset + length;
  while (end < limit && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(offset, end));
}

function readOctal(buf: Uint8Array, offset: number, length: number): number {
  const raw = readString(buf, offset, length).trim();
  if (raw === '') return 0;
  const n = parseInt(raw, 8);
  return Number.isFinite(n) ? n : 0;
}

/** Strip the `owner-repo-sha/` wrapper GitHub puts on every tarball entry. */
export function stripRoot(path: string): string {
  const i = path.indexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

function paxPaths(block: Uint8Array): string | null {
  const text = new TextDecoder().decode(block);
  const m = /\d+ path=([^\n]*)\n/.exec(text);
  return m?.[1] ?? null;
}

class ByteQueue {
  private chunks: Uint8Array[] = [];
  private length = 0;

  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.length += chunk.length;
  }

  get size(): number {
    return this.length;
  }

  /** Remove and return exactly `n` bytes; null when not enough are buffered. */
  take(n: number): Uint8Array | null {
    if (this.length < n) return null;
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0]!;
      const need = n - filled;
      if (head.length <= need) {
        out.set(head, filled);
        filled += head.length;
        this.chunks.shift();
      } else {
        out.set(head.subarray(0, need), filled);
        this.chunks[0] = head.subarray(need);
        filled = n;
      }
    }
    this.length -= n;
    return out;
  }
}

/**
 * Yield matching entries from a gzipped tar stream. Non-matching entries are
 * skipped without their bytes ever being retained, so peak memory tracks the
 * SELECTION rather than the repository.
 */
export async function* readTarGz(
  stream: ReadableStream<Uint8Array>,
  keep: EntryFilter = () => true,
  limits: ReadLimits = {},
): AsyncGenerator<TarEntry> {
  let yieldedBytes = 0;
  let yieldedEntries = 0;
  // The DOM lib types DecompressionStream's writable as BufferSource, which is
  // wider than ReadableStream<Uint8Array>; the runtime contract is exact.
  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  const reader = stream.pipeThrough(gunzip).getReader();
  const q = new ByteQueue();
  let done = false;
  // GNU 'L' and PAX 'x' records carry a long path for the entry that follows.
  let pendingLongPath: string | null = null;

  const fill = async (needed: number): Promise<boolean> => {
    while (q.size < needed && !done) {
      const { value, done: d } = await reader.read();
      if (d) { done = true; break; }
      if (value) q.push(value);
    }
    return q.size >= needed;
  };

  while (true) {
    if (limits.signal?.aborted) return;
    if (!(await fill(BLOCK))) return;
    const header = q.take(BLOCK)!;
    if (header.every((b) => b === 0)) continue; // end-of-archive padding

    const size = readOctal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const padded = Math.ceil(size / BLOCK) * BLOCK;

    let name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    if (pendingLongPath !== null) { name = pendingLongPath; pendingLongPath = null; }

    if (type === 'L' || type === 'x') {
      if (!(await fill(padded))) return;
      const block = q.take(padded)!.subarray(0, size);
      pendingLongPath =
        type === 'L' ? readString(block, 0, block.length) : paxPaths(block);
      continue;
    }

    const isFile = type === '0' || type === '\0';
    const path = stripRoot(name);

    // The size comes from the tar HEADER, so an oversized entry is refused
    // before its bytes are ever copied out of the queue. Checking after the
    // read would omit the content while still paying its memory cost.
    const tooBig = limits.maxEntryBytes !== undefined && size > limits.maxEntryBytes;
    if (tooBig && isFile && path !== '') limits.onSkipped?.(path, size, 'too-large');

    const overBudget =
      (limits.maxTotalBytes !== undefined && yieldedBytes + size > limits.maxTotalBytes) ||
      (limits.maxEntries !== undefined && yieldedEntries >= limits.maxEntries);

    if (!isFile || path === '' || tooBig || overBudget || !keep(path, size)) {
      if (padded > 0 && !(await fill(padded))) return;
      if (padded > 0) q.take(padded);
      continue;
    }

    if (!(await fill(padded))) return;
    const bytes = q.take(padded)!.subarray(0, size);
    yieldedBytes += size;
    yieldedEntries++;
    yield { path, size, bytes };
  }
}
