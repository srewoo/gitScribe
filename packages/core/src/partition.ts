import type { Digest, DigestFile } from './digest.js';

/**
 * Split a digest that cannot fit one context window into ordered parts that
 * each do, so a large repository can be covered across several prompts with
 * nothing left out.
 *
 * Two rules drive the packing:
 *
 * 1. Files stay in path order, so a part is a contiguous slice of the tree and
 *    related files land together. Optimal bin-packing would interleave
 *    unrelated directories to shave a part off, which reads worse and helps a
 *    model less than locality does.
 * 2. Nothing is dropped. A single file larger than the budget gets its own
 *    part and is reported as oversized rather than silently truncated.
 */

export interface PartitionOptions {
  /** Usable tokens per part, after any reserve for prompt and reply. */
  readonly budget: number;
  /**
   * Tokens reserved inside each part for the header and manifest GitScribe
   * adds. Defaults to a deliberately generous fixed allowance.
   */
  readonly overhead?: number;
}

export interface DigestPart {
  /** 1-based, for "Part 3 of 7". */
  readonly index: number;
  readonly total: number;
  readonly files: readonly DigestFile[];
  readonly tokens: number;
  /** Files whose own size exceeds the budget; they could not be made to fit. */
  readonly oversized: readonly string[];
}

export interface Partitioned {
  readonly parts: readonly DigestPart[];
  readonly budget: number;
  /** True when everything fits one part and splitting was unnecessary. */
  readonly single: boolean;
}

const DEFAULT_OVERHEAD = 600;

export function partitionDigest(d: Digest, opts: PartitionOptions): Partitioned {
  const overhead = opts.overhead ?? DEFAULT_OVERHEAD;
  const budget = Math.max(1, opts.budget - overhead);

  if (d.totalTokens <= budget) {
    return {
      budget,
      single: true,
      parts: [
        { index: 1, total: 1, files: d.files, tokens: d.totalTokens, oversized: [] },
      ],
    };
  }

  const groups: Array<{ files: DigestFile[]; tokens: number; oversized: string[] }> = [];
  let current = { files: [] as DigestFile[], tokens: 0, oversized: [] as string[] };

  for (const f of d.files) {
    if (f.tokens > budget) {
      // Too big for any part. Give it one of its own rather than cutting it in
      // half mid-function, and say so.
      if (current.files.length > 0) {
        groups.push(current);
        current = { files: [], tokens: 0, oversized: [] };
      }
      groups.push({ files: [f], tokens: f.tokens, oversized: [f.path] });
      continue;
    }
    if (current.tokens + f.tokens > budget && current.files.length > 0) {
      groups.push(current);
      current = { files: [], tokens: 0, oversized: [] };
    }
    current.files.push(f);
    current.tokens += f.tokens;
  }
  if (current.files.length > 0) groups.push(current);

  return {
    budget,
    single: false,
    parts: groups.map((g, i) => ({
      index: i + 1,
      total: groups.length,
      files: g.files,
      tokens: g.tokens,
      oversized: g.oversized,
    })),
  };
}

/** Compact "what is in the other parts" map, so a model knows what it lacks. */
export function partManifest(p: Partitioned): string {
  return p.parts
    .map((part) => {
      const first = part.files[0]?.path ?? '(empty)';
      const last = part.files[part.files.length - 1]?.path ?? first;
      return `  Part ${part.index}/${part.total}: ${part.files.length} files, ` +
        `~${part.tokens.toLocaleString()} tokens — ${first} … ${last}`;
    })
    .join('\n');
}
