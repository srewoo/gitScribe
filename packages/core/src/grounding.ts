/**
 * Grounding check for generated documentation.
 *
 * A model asked to describe a codebase will sometimes invent files. Observed in
 * testing: a small local model described `sindresorhus/slugify` as a Jest suite
 * with `acronyms.test.js` and `contractions.test.js`, when the repository has a
 * single `test.js` and uses AVA. The prompt forbids guessing; prompts are not
 * enforcement.
 *
 * Every file path a document mentions can be checked against the files that
 * were actually read. That turns an invisible hallucination into a visible,
 * listed fact — the same rule the rest of GitScribe follows for omissions.
 */

export interface GroundingReport {
  /** Paths mentioned that exist in the digest. */
  readonly verified: readonly string[];
  /** Paths mentioned that do NOT exist. Likely fabricated. */
  readonly unverified: readonly string[];
}

/** Anything that looks like a file path inside backticks or a heading. */
const CANDIDATE = /`([^`\n]+)`|^#{2,4}\s+(.+)$/gm;

/** Extensions common enough that a bare word with one is probably a path. */
const LOOKS_LIKE_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|c|h|cc|cpp|cs|swift|scala|sh|json|ya?ml|toml|md|html|css|sql|lock)$/i;

function normalise(s: string): string {
  return s
    .trim()
    .replace(/`/g, '')          // headings often wrap the path in backticks
    .replace(/^["']|["']$/g, '')
    .replace(/^\.\//, '')
    .replace(/[.,;:)\]]+$/, '')
    .trim();
}

/**
 * Compare the paths a document claims against the paths that were read.
 * A bare filename counts as verified if any real path ends with it, since
 * documents legitimately refer to `index.ts` rather than the full path.
 */
export function checkGrounding(
  markdown: string,
  realPaths: readonly string[],
): GroundingReport {
  const real = new Set(realPaths);
  const byBasename = new Set(realPaths.map((p) => p.slice(p.lastIndexOf('/') + 1)));
  const dirs = new Set<string>();
  for (const p of realPaths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }

  const verified = new Set<string>();
  const unverified = new Set<string>();

  for (const m of markdown.matchAll(CANDIDATE)) {
    const raw = m[1] ?? m[2] ?? '';
    const cand = normalise(raw);
    if (!cand || cand.includes(' ')) continue;

    // npm scopes look like paths but are package names: @scope/pkg.
    if (cand.startsWith('@')) continue;

    const known =
      real.has(cand) ||
      dirs.has(cand) ||
      dirs.has(cand.replace(/\/$/, '')) ||
      byBasename.has(cand) ||
      realPaths.some((p) => p.endsWith(`/${cand}`));

    if (known) {
      verified.add(cand);
      continue;
    }

    // Only ACCUSE something that carries a file extension. A slash-separated
    // name with no extension is as likely to be a repository slug or a package
    // ("sindresorhus/slugify") as a fabricated directory — and a check that
    // cries wolf is one people stop reading.
    if (LOOKS_LIKE_FILE.test(cand)) unverified.add(cand);
  }

  return { verified: [...verified].sort(), unverified: [...unverified].sort() };
}

/** A section appended to the document when it references files that do not exist. */
export function groundingNotice(report: GroundingReport, filesRead?: number): string {
  if (report.unverified.length === 0) return '';
  // filesRead is the digest's own file count. Deriving it from the number of
  // references checked (as this once did) states a different, wrong number.
  const scope =
    filesRead === undefined
      ? 'the files actually read'
      : `the ${filesRead} file(s) actually read`;
  return (
    `\n\n## Unverified references\n\n` +
    `The following paths appear in this document but were **not** among ` +
    `${scope}. ` +
    `Treat each as wrong until checked: usually the model invented it, though some ` +
    `are named only as files that are ignored or absent (such as a lockfile):\n\n` +
    report.unverified.map((p) => `- \`${p}\``).join('\n') +
    `\n\nA smaller or local model fabricates more often. If this list is long, ` +
    `regenerate with a stronger analysis model.\n`
  );
}
