/**
 * Model-aware request budgeting.
 *
 * A fixed 120,000-token chunk budget assumed every model has a large window.
 * Point a small local model at it and every request overflows — after the
 * paid ones have already been spent.
 *
 * An input allowance is what is left of a model's context once the requested
 * output, the system instructions, the wrapper the renderer adds, and an
 * uncertainty margin are all subtracted. Unknown capacity stays unknown: it is
 * never silently replaced with a default.
 */

/** `secondary`: a published but unverified figure, shown to the user as approximate. */
export type CapacitySource = 'vendor' | 'runtime' | 'user' | 'secondary' | 'unknown';

export interface ModelCapacity {
  /** Total context window in tokens, or null when genuinely unknown. */
  readonly contextTokens: number | null;
  /** Largest output the model will produce, when known. */
  readonly maxOutputTokens: number | null;
  readonly source: CapacitySource;
}

export interface BudgetRequest {
  readonly capacity: ModelCapacity;
  /** Output tokens this call will ask for. */
  readonly requestedOutput: number;
  /** Tokens for the system prompt, measured or estimated. */
  readonly systemTokens: number;
  /** Tokens the renderer adds around the content (headers, fences, manifest). */
  readonly overheadTokens?: number;
}

export interface Budget {
  /** Tokens available for content. Null when capacity is unknown. */
  readonly inputAllowance: number | null;
  readonly reason: string;
  /** True when the caller must ask the user rather than assume a number. */
  readonly needsUserInput: boolean;
}

/**
 * Proportion of the window held back for counting error. Estimates are biased
 * to over-count, but the bias is not itself measured yet, so the margin stays
 * deliberately generous.
 */
export const UNCERTAINTY_MARGIN = 0.1;
/** Fixed allowance for message envelope, role markers and formatting. */
export const ENVELOPE_TOKENS = 200;

export function planBudget(req: BudgetRequest): Budget {
  const { contextTokens, maxOutputTokens, source } = req.capacity;

  if (contextTokens === null) {
    return {
      inputAllowance: null,
      needsUserInput: true,
      reason:
        'This model’s context window is unknown, so no request size can be ' +
        'guaranteed to fit. Enter its context window under the model picker in Settings, ' +
        'or pick a model with a known window.',
    };
  }

  // Asking for more output than the model can produce is a request that fails
  // at the provider, not something to quietly clamp and hope.
  const output =
    maxOutputTokens === null ? req.requestedOutput : Math.min(req.requestedOutput, maxOutputTokens);

  const overhead = req.overheadTokens ?? 0;
  const margin = Math.ceil(contextTokens * UNCERTAINTY_MARGIN);
  const allowance =
    contextTokens - output - req.systemTokens - overhead - margin - ENVELOPE_TOKENS;

  if (allowance <= 0) {
    return {
      inputAllowance: null,
      needsUserInput: true,
      reason:
        `A ${contextTokens.toLocaleString()}-token window cannot hold ${output.toLocaleString()} ` +
        `tokens of output plus instructions and margin. Choose a model with a larger window, ` +
        `or request less output.`,
    };
  }

  return {
    inputAllowance: allowance,
    needsUserInput: false,
    reason:
      `${allowance.toLocaleString()} tokens of content per request ` +
      `(${contextTokens.toLocaleString()} window, source: ${source === 'secondary' ? 'approximate' : source}; less ` +
      `${output.toLocaleString()} output, ${req.systemTokens.toLocaleString()} instructions, ` +
      `${margin.toLocaleString()} margin).`,
  };
}

/**
 * Group note-sized strings into batches that each fit an allowance, so a
 * synthesis step over hundreds of notes reduces in stages instead of being
 * sent as one oversized request.
 */
export function batchWithinAllowance(
  items: readonly string[],
  allowance: number,
  estimate: (s: string) => number,
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let used = 0;

  for (const item of items) {
    const cost = estimate(item);
    if (cost > allowance) {
      // A single item over the allowance gets its own batch; the caller must
      // decide whether to split or report it, not pretend it fits.
      if (current.length > 0) { batches.push(current); current = []; used = 0; }
      batches.push([item]);
      continue;
    }
    if (used + cost > allowance && current.length > 0) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += cost;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
