// Repository path syntax: the bounded scopes items and proofs name, and documentation globs (GY-215).

// Deliberately bounded scope syntax: exact paths or directory prefixes ending /, /*, /**.
// Unsupported glob expressions are not interpreted as semantic dependency knowledge.
export function pathScope(value: string) {
  const path = value.replace(/^\.\//, '');
  const prefix = path.endsWith('/') || /\/\*{1,2}$/.test(path);
  return { path: prefix ? path.replace(/\*+$/, '') : path, prefix };
}
export function pathScopesOverlap(a: string, b: string) {
  const left = pathScope(a), right = pathScope(b);
  return left.path === right.path || left.prefix && right.path.startsWith(left.path) || right.prefix && left.path.startsWith(right.path);
}
/** True when `outer` covers every file `inner` can name. A file scope contains only itself. */
export function pathScopeContains(outer: string, inner: string) {
  const wide = pathScope(outer), narrow = pathScope(inner);
  return wide.path === narrow.path ? wide.prefix || !narrow.prefix : wide.prefix && narrow.path.startsWith(wide.path);
}
const pathToken = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.*-]*|[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,5}|(?<![\w./-])\.[A-Za-z_][\w.-]*/g;
const fileToken = /^[\w-]+\.[A-Za-z0-9]{1,5}$|^\.[A-Za-z_][\w.-]*$/;
export const wellFormed = (path: string) => {
  const segments = pathScope(path).path.split('/');
  return segments.length > 0 && segments.every((segment, index) => segment !== '.' && segment !== '..' && (segment !== '' || index === segments.length - 1));
};
/**
 * The repository paths a sentence names, in the bounded scope syntax: `src/a.ts`, `docs/`,
 * `tests/*`, and a root dotfile (`.gitignore`; GY-1479: a dot that starts a word, never one inside it).
 * Prose is not a glob language, so only tokens that look like a path are read as one.
 */
export function namedPaths(text: string) {
  return [...new Set((text.match(pathToken) ?? []).map(token => token.replace(/[.,;:)\]]+$/, '')).filter(token => token.includes('/') || fileToken.test(token)).filter(wellFormed))];
}
/** A test file: under a tests directory, or named `*.test.*` / `*.spec.*`. */
export const testFile = (path: string) => !pathScope(path).prefix && (/(^|\/)(tests?|__tests__|browser-tests|spec)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path));

/**
 * Whether a file lies inside one documentation glob: `docs/` or `docs/**` is a tree, `README.md` a
 * file, `*` matches within one path segment and `**` across segments (`packages/*\/README.md`).
 * Documentation paths are globs because a repository's docs are a pattern (every package README),
 * not one directory; path scopes keep their deliberately bounded syntax.
 */
export function documentationGlobMatches(pattern: string, file: string) {
  const glob = pattern.replace(/^\.\//, ''), path = file.replace(/^\.\//, '');
  const source = /\/\*{1,2}$/.test(glob) ? glob.replace(/\*+$/, '**') : glob.endsWith('/') ? `${glob}**` : glob;
  const expression = source.split(/(\*\*\/?|\*|\?)/).map(part => part === '**/' ? '(?:.*/)?' : part === '**' ? '.*' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${expression}$`).test(path);
}
