/**
 * Window arithmetic for the virtualized tree, kept pure and DOM-free so it can
 * be tested without a browser. Off-by-one here shows up as rows that never
 * paint or rows painted twice, which is exactly the kind of bug that hides.
 */
export interface Range {
  readonly first: number;
  readonly last: number;
}

export function visibleRange(
  scrollTop: number,
  clientHeight: number,
  rowCount: number,
  rowHeight: number,
  overscan: number,
): Range {
  if (rowCount <= 0 || rowHeight <= 0) return { first: 0, last: 0 };

  const safeTop = Math.max(0, scrollTop);
  // Clamp to the last row: after a filter shrinks the list, scrollTop can still
  // point past the end for a frame, which would invert the range and paint
  // nothing at all.
  const maxFirst = Math.max(0, rowCount - 1);
  const first = Math.min(maxFirst, Math.max(0, Math.floor(safeTop / rowHeight) - overscan));
  // +1 covers a row straddling the top edge; another +1 covers the bottom edge.
  const spanned = Math.ceil(clientHeight / rowHeight) + 1;
  const last = Math.min(rowCount, first + spanned + overscan * 2);
  return { first, last };
}
