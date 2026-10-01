import { documentationGlobMatches } from './documentation-glob.js';
import { type ItemDocumentation, itemDocumentationPaths, testFile } from './scope.js';

// ---------------------------------------------------------------------------
// Documentation-gate tests (GY-954). A change that touches the documentation breaks the tests
// that read it — a word budget over every page, for one — yet no criterion names such a test and
// its source pins no label. When the item's scope or ask reaches the documentation it must keep
// current, a test whose source names a documentation path is the change's own scope, grounded
// like a pinning test from what the loop read on the base. Anything else goes to the approver.
// ---------------------------------------------------------------------------

/** True when the item's change touches the documentation it must keep current: its scope or its ask names a documentation path. */
export function touchesDocumentation(item: { plannedFiles?: readonly string[]; documentation?: ItemDocumentation | null }, paths: readonly string[]) {
  const scopes = itemDocumentationPaths(item);
  const named = (path: string) => scopes.some(scope => scope === path || documentationGlobMatches(scope, path));
  return [...(item.plannedFiles ?? []), ...paths].some(named);
}
/** The literal chunks a documentation glob contributes to a source search: `docs/`, `README.md`; a `*` contributes nothing. */
const globChunks = (scope: string) => scope.split('*').map(part => part.trim()).filter(part => part.length >= 4);
/**
 * The ground a documentation-gate test is granted on, or null: a test whose source names a
 * documentation path this change touches. Only a test file is granted, and only on text the loop
 * read from the base; an unrelated test still goes to the approver.
 */
export function documentationTestGround(path: string, text: string | null, documentation: readonly string[]): string | null {
  if (!text || !testFile(path)) return null;
  const named = documentation.find(scope => globChunks(scope).some(chunk => text.includes(chunk)));
  return named ? `${path} reads the documentation (${named}) this change rewrites` : null;
}
