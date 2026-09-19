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
