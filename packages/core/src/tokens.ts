/**
 * Token estimation.
 *
 * No public tokenizer exists for Claude, Gemini or Grok, and calling a vendor
 * endpoint would require an API key — which this project does not have and
 * will not ask for. So every count here is an ESTIMATE, deliberately biased to
 * over-count: a digest reported as fitting must not then be rejected for
 * length. Any UI showing these numbers must label them as approximate.
 *
 * ponytail: byte-density heuristic, not a tokenizer. Swap in a real BPE only
 * if measured error exceeds the bias margin — shipping o200k_base costs 1-2MB
 * and would still only be exact for one model family.
 */

/** Characters per token, by content shape. Lower = denser = more tokens. */
const DENSITY: ReadonlyArray<readonly [RegExp, number]> = [
  [/\.(min\.js|min\.css|map)$/i, 2.2],
  [/\.(lock|sum)$|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i, 2.6],
  [/\.(json|ya?ml|toml|xml|svg|csv)$/i, 2.9],
  [/\.(md|mdx|txt|rst|adoc)$/i, 4.0],
  [/\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|c|h|cc|cpp|cs|swift|scala|sh)$/i, 3.3],
];
const DEFAULT_DENSITY = 3.4;

/** Deliberate over-count margin. See the module note. */
export const OVERCOUNT_BIAS = 1.06;

export function densityFor(path: string): number {
  for (const [re, d] of DENSITY) if (re.test(path)) return d;
  return DEFAULT_DENSITY;
}

/**
 * Estimate tokens from a byte length alone — no content needed. This is what
 * makes per-file costs available straight from the trees API, before a single
 * byte of content has been downloaded.
 */
export function estimateFromBytes(path: string, bytes: number): number {
  return Math.ceil((bytes / densityFor(path)) * OVERCOUNT_BIAS);
}

/** Estimate from decoded text, once content is in hand. */
export function estimateFromText(path: string, text: string): number {
  return Math.ceil((text.length / densityFor(path)) * OVERCOUNT_BIAS);
}
