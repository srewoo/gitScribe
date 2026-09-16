import { firstMatch } from './glob.js';
import type { TreeFile } from './github.js';

/**
 * Three-layer selection algebra: defaults, then glob rules, then explicit
 * per-path overrides. Overrides always win — a file a user ticked by hand is
 * never taken away by a rule.
 */
export interface Selection {
  readonly exclude: readonly string[];
  readonly include: readonly string[];
  /** path -> explicit on/off, set by ticking a row. */
  readonly overrides: Readonly<Record<string, boolean>>;
}

export const emptySelection: Selection = { exclude: [], include: [], overrides: {} };

/** Sensible defaults: noise nobody wants in a prompt. */
export const DEFAULT_EXCLUDES: readonly string[] = [
  '.git/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '*.lock',
  'package-lock.json',
  '**/*.min.js',
  '**/*.map',
  '**/*.snap',
];

export interface Decision {
  readonly selected: boolean;
  /** The glob that excluded this file, for display. Null when selected. */
  readonly excludedBy: string | null;
}

export function decide(path: string, sel: Selection): Decision {
  const override = sel.overrides[path];
  if (override !== undefined) return { selected: override, excludedBy: null };

  if (sel.include.length > 0) {
    const inc = firstMatch(path, sel.include);
    if (inc === null) return { selected: false, excludedBy: null };
  }
  const ex = firstMatch(path, sel.exclude);
  if (ex !== null) return { selected: false, excludedBy: ex };
  return { selected: true, excludedBy: null };
}

export interface SelectionSummary {
  readonly files: readonly TreeFile[];
  readonly totalTokens: number;
  readonly totalBytes: number;
}

export function applySelection(files: readonly TreeFile[], sel: Selection): SelectionSummary {
  const kept: TreeFile[] = [];
  let totalTokens = 0;
  let totalBytes = 0;
  for (const f of files) {
    if (!decide(f.path, sel).selected) continue;
    kept.push(f);
    totalTokens += f.tokens;
    totalBytes += f.size;
  }
  return { files: kept, totalTokens, totalBytes };
}

/**
 * Largest-first suggestions to get under a budget. Returns the fewest files
 * whose removal closes the gap — the "drop these" list.
 */
export function suggestDrops(
  files: readonly TreeFile[],
  overBy: number,
): readonly TreeFile[] {
  if (overBy <= 0) return [];
  const sorted = [...files].sort((a, b) => b.tokens - a.tokens);
  const drops: TreeFile[] = [];
  let freed = 0;
  for (const f of sorted) {
    if (freed >= overBy) break;
    drops.push(f);
    freed += f.tokens;
  }
  return drops;
}
