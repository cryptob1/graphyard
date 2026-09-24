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

// ---------------------------------------------------------------------------
// Deciding a worker's scope request without a master session (GY-85).
//
// A worker that finds it needs a file outside plannedFiles records a structured request — the
// paths and the reason — rather than a free-text blocker. Most of those requests ask for nothing
// new: the documentation this repository requires updating when behaviour changes, or a source
// file the item's own criteria already name. That is the item's own scope spelled out, so the
// control plane decides it from the item itself and the loop applies the decision on the cycle it
// sees the request. Anything wider — a path no criterion implies, a path the request would drop,
// or a change to criteria or proofs — is intent, not scope: it is refused, escalated with the
// reason, and the item stays blocked until an operator decides it.
// ---------------------------------------------------------------------------

/** A criterion as the decision reads it: its id and the text that may name the files it covers. */
export interface ScopeCriterion { id: string; text: string; proofs?: readonly string[] }
export interface ScopeRequestState {
  epoch: number; paths: string[]; reason: string; requestedBy: string; at: string;
  /** Planned paths the request would drop, and criteria it would rewrite: never decided here. */
  remove?: string[];
  criteria?: ScopeCriterion[];
  decision?: ScopeDecision | null;
}
export interface ScopeDecision {
  state: 'approved' | 'refused';
  reason: string;
  at: string;
  decidedBy: string;
  /** Request to decision, the latency AC-3 of GY-85 bounds. */
  waitedMs: number;
  /** What was decided, kept with the decision because an applied request is cleared. */
  paths: string[];
  requestedBy: string;
  requestedAt: string;
}

/**
 * Documentation this repository requires updating when behaviour changes (AGENTS.md: "Update the
 * relevant guide under `docs/` when behavior changes"), plus the agent contract itself. A request
 * for one of these files is implied by any behaviour change, so it needs no operator. Directory
 * scopes are not: the implication covers the guide a change touches, never the whole tree.
 */
export const documentationScopes = ['docs/', 'AGENTS.md', 'README.md'] as const;
/**
 * The surfaces that render or test the documentation: the web app that links to and embeds doc
 * pages, and the browser tests that pin their text. An item that plans the whole `docs/` tree
 * rewrites or moves pages these files consume, so a single file under them is implied scope.
 * A directory request is not: the implication covers the consumer a rewrite breaks, never a tree.
 */
export const documentationConsumerScopes = ['web/', 'browser-tests/'] as const;

const pathToken = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.*-]*|[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,5}/g;
const wellFormed = (path: string) => {
  const segments = pathScope(path).path.split('/');
  return segments.length > 0 && segments.every((segment, index) => segment !== '.' && segment !== '..' && (segment !== '' || index === segments.length - 1));
};
/**
 * The repository paths a sentence names, in the same bounded syntax plannedFiles uses: `src/a.ts`,
 * `docs/`, `tests/*`. Prose is not a glob language, so only tokens that look like a path are read
 * as one — a token that matches nothing the request asks for simply never implies anything.
 */
export function namedPaths(text: string) {
  return [...new Set((text.match(pathToken) ?? []).map(token => token.replace(/[.,;:)\]]+$/, '')).filter(token => token.includes('/') || /^[\w-]+\.[A-Za-z0-9]{1,5}$/.test(token)).filter(wellFormed))];
}

export interface ScopeImplication { scope: string; kind: 'criteria' | 'documentation' | 'documentation-consumer'; why: string }
/**
 * Every path scope the item itself already implies: the files its criteria name, and the
 * documentation the repository requires updating for the behaviour those criteria change.
 */
export function impliedScopes(criteria: readonly ScopeCriterion[], documentation: readonly string[] = documentationScopes): ScopeImplication[] {
  return [
    ...criteria.flatMap(criterion => namedPaths(criterion.text).map(scope => ({ scope, kind: 'criteria' as const, why: `${criterion.id} names ${scope}` }))),
    ...documentation.map(scope => ({ scope, kind: 'documentation' as const, why: `${scope} is documentation this repository requires updating when behaviour changes` })),
  ];
}

/**
 * The implication a requested path rests on, or null when the item implies nothing that covers it.
 * A directory request is only ever implied by a criterion that names that breadth itself: the
 * documentation rule covers the guide a change touches, never a whole tree at once.
 */
export function scopeImplication(path: string, implied: readonly ScopeImplication[]) {
  const breadth = pathScope(path).prefix;
  const found = implied.find(entry => pathScopeContains(entry.scope, path) && !(breadth && entry.kind !== 'criteria')) ?? null;
  return found?.kind === 'documentation-consumer' ? { ...found, why: `${path} renders or tests the documentation this item rewrites` } : found;
}

/** True when the item's planned scope covers the entire `docs/` tree, not one guide in it. */
export const plansDocumentationTree = (plannedFiles: readonly string[] = []) => plannedFiles.some(planned => pathScopeContains(planned, 'docs/'));

/** The blocker a refused scope request writes, and the prefix a later decision clears it by. */
export const scopeRefusalBlocker = 'Scope request refused';
/** GY-85 AC-3: the loop decides a request within five minutes at p90, over at least ten requests… */
export const scopeDecisionBudgetMs = 300_000;
/** …and no request is left undecided — no item blocked on scope — for longer than fifteen minutes. */
export const scopeBlockedBudgetMs = 900_000;
export const scopeDecisionSample = 10;

export interface ScopeVerdict { state: ScopeDecision['state']; reason: string; paths: string[] }
/**
 * The decision itself, computed from the item's own record: never from what the requester claims.
 * A purely additive request whose every path is implied is approved with the implication as its
 * audited reason; everything else is refused with the reason it was refused for.
 */
export function decideScopeRequest(
  item: { plannedFiles?: readonly string[]; criteria: readonly ScopeCriterion[] },
  request: Pick<ScopeRequestState, 'paths' | 'remove' | 'criteria'>,
  options: { documentation?: readonly string[]; documentationConsumers?: readonly string[] } = {},
): ScopeVerdict {
  // Paths the current planned scope already covers are no widening at all, so the decision is
  // about the rest: a master revision between the request and this decision narrows the ask
  // rather than invalidating it.
  const paths = [...new Set(request.paths)].filter(path => !(item.plannedFiles ?? []).some(planned => pathScopeContains(planned, path)));
  const refused = (reason: string): ScopeVerdict => ({ state: 'refused', reason, paths });
  if (request.remove?.length) return refused(`the request drops planned paths (${request.remove.join(', ')}); only additive scope is decided automatically, and narrowing containment is an operator requirements revision`);
  if (request.criteria?.length) return refused('the request rewrites criteria or proofs; requirements are decided by an operator and approved by an independent agent, never by the loop');
  if (!paths.length) return refused('the request names no path outside the planned scope; nothing is left to widen');
  const implied = [...impliedScopes(item.criteria, options.documentation),
    ...(plansDocumentationTree(item.plannedFiles) ? (options.documentationConsumers ?? documentationConsumerScopes).map(scope => ({ scope, kind: 'documentation-consumer' as const, why: `${scope} renders or tests the documentation this item rewrites` })) : [])];
  const matched = paths.map(path => ({ path, by: scopeImplication(path, implied) }));
  const outside = matched.filter(entry => !entry.by).map(entry => entry.path);
  if (outside.length) return refused(`${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} outside what this item's own criteria and the repository's documentation rule imply; an operator decides scope the item does not already carry`);
  return { state: 'approved', reason: `additive scope the item already implies — ${matched.map(entry => `${entry.path} (${entry.by!.why})`).join('; ')}`, paths };
}

/**
 * True when a request the loop refused would be approved by the rules as they stand now — a rule
 * change, or a widening that made its implication hold — so the loop asks the control plane to
 * decide it again rather than leave the item blocked on a verdict the rules no longer give.
 * Only a refusal that is still the item's blocker qualifies; an approval is never re-decided.
 */
export function redecidableScopeRefusal(item: { plannedFiles?: readonly string[]; criteria: readonly ScopeCriterion[]; blocker?: string | null; scopeRequest?: ScopeRequestState | null }) {
  const request = item.scopeRequest;
  return !!request && request.decision?.state === 'refused' && !!item.blocker?.startsWith(scopeRefusalBlocker)
    && decideScopeRequest(item, request).state === 'approved';
}
