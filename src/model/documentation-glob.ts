// Documentation path globs (GY-215), apart from model/scope.ts so that module keeps its budget.

/**
 * Whether a file lies inside one documentation glob: `docs/` or `docs/**` is a tree, `README.md` a
 * file, `*` matches within one path segment and `**` across segments (`packages/*\/README.md`).
 * Documentation paths are globs because a repository's docs are a pattern (every package README),
 * not one directory; planned-file scope keeps its deliberately bounded syntax.
 */
export function documentationGlobMatches(pattern: string, file: string) {
  const glob = pattern.replace(/^\.\//, ''), path = file.replace(/^\.\//, '');
  const source = /\/\*{1,2}$/.test(glob) ? glob.replace(/\*+$/, '**') : glob.endsWith('/') ? `${glob}**` : glob;
  const expression = source.split(/(\*\*\/?|\*|\?)/).map(part => part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${expression}$`).test(path);
}
