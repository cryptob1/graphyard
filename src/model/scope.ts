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

interface RequirementsRevision {
  criteria: unknown[];
  dependencies: readonly string[];
  plannedFiles: readonly string[];
  exclusiveResources?: readonly string[];
  producerProofs?: readonly string[];
}
const canonical = (value: unknown) => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
const unchanged = (current: readonly unknown[], next: readonly unknown[]) => current.length === next.length && current.every(entry => next.some(other => canonical(entry) === canonical(other)));
/**
 * True when a requirements revision changes nothing but adding planned-file scope: every
 * criterion (with its proofs and any bootstrap attribution), dependency, exclusive resource
 * and producer proof is carried over unchanged, and at least one planned path is added.
 * Such a widening is non-weakening intent, so the engine may apply it while a worker holds
 * the lease — and inside a live containment quarantine — without ending the attempt.
 */
export function liveScopeWidening(current: RequirementsRevision, next: RequirementsRevision) {
  return unchanged(next.criteria, current.criteria)
    && unchanged(next.dependencies, current.dependencies)
    && unchanged(next.exclusiveResources ?? [], current.exclusiveResources ?? [])
    && unchanged(next.producerProofs ?? [], current.producerProofs ?? [])
    && current.plannedFiles.every(path => next.plannedFiles.includes(path))
    && new Set(next.plannedFiles).size === next.plannedFiles.length
    && next.plannedFiles.length > current.plannedFiles.length;
}
