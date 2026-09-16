const SLASH_MARK = '@@GS_GLOBSTAR_SLASH@@';
const ANY_MARK = '@@GS_GLOBSTAR@@';

/** Translate a gitignore-style glob to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, SLASH_MARK)
    .replace(/\*\*/g, ANY_MARK)
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .split(SLASH_MARK)
    .join('(?:.*/)?')
    .split(ANY_MARK)
    .join('.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * A rule matches a path if it matches the whole path, or — for a
 * separator-free rule like `*.lock` — the basename alone.
 */
export function matchesGlob(path: string, glob: string): boolean {
  const re = globToRegExp(glob);
  if (re.test(path)) return true;
  if (!glob.includes('/')) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    return re.test(base);
  }
  return false;
}

/** The first matching glob, or null. Callers surface which rule caught a file. */
export function firstMatch(path: string, globs: readonly string[]): string | null {
  for (const g of globs) if (matchesGlob(path, g)) return g;
  return null;
}
