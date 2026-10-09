// Concern: folding a wide plannedFiles widening into directory entries, and the life of an attempt's scope asks — merging pending ones (GY-549) and reading one's outcome for the worker (GY-176).
import { type ScopeCriterion, type ScopeDecision, type ScopeRequestState, namedPaths, pathScope, pathScopeContains, plannedFilesMax, unplannedPaths } from './scope.js';
// ---------------------------------------------------------------------------
// Collapsing a wide widening into directory entries (GY-549).
//
// plannedFiles holds at most `plannedFilesMax` entries. A mechanical change that touches every test
// file (GY-421: 158 of them) can never be scoped file by file: the list hits the cap and the item
// stalls. So the widening the loop proposes folds the requested files into their deepest common
// directory entries — `tests/` for the 158 — when a directory would otherwise be named more than
// `collapseDirectoryFiles` times, or when the list would exceed the cap. A fold never reaches the
// repository root and stays inside the item's own area: the top-level directories its criteria
// name or its plannedFiles already carry. The decision names each directory and the files it covers.
// ---------------------------------------------------------------------------

/** More requested files than this under one directory are proposed as that directory. */
export const collapseDirectoryFiles = 20;
/** A directory entry a widening proposes in place of the requested files it covers. */
export interface CollapsedScope { scope: string; files: string[] }

/** Every directory above a path, deepest first: `tests/a/b.ts` → `tests/a/`, `tests/`. Never the root. */
const directoriesAbove = (path: string) => {
  const segments = pathScope(path).path.replace(/\/$/, '').split('/');
  return segments.slice(0, -1).map((_, index) => `${segments.slice(0, segments.length - 1 - index).join('/')}/`);
};
const depth = (scope: string) => pathScope(scope).path.split('/').length;

/**
 * The entries that remain once every entry another entry covers is dropped (GY-906): the create
 * schema permits overlapping plannedFiles, and an exact path a directory entry already covers is
 * not a second entry. Order is kept, and of two scopes that cover each other (`tests/`,
 * `tests/**`) the earlier stands.
 */
const normalizedScopes = (entries: readonly string[]) =>
  entries.filter((entry, index) => !entries.some((other, otherIndex) =>
    otherIndex !== index && pathScopeContains(other, entry) && !(pathScopeContains(entry, other) && otherIndex > index)));

/** The top-level directories an item's criteria name or its plannedFiles carry: where a fold may land. */
export function collapseArea(item: { criteria?: readonly ScopeCriterion[]; plannedFiles?: readonly string[] }) {
  const top = (path: string) => directoriesAbove(path).at(-1) ?? (pathScope(path).prefix ? `${pathScope(path).path.split('/')[0]}/` : null);
  return [...new Set([...(item.criteria ?? []).flatMap(criterion => namedPaths(criterion.text)), ...(item.plannedFiles ?? [])].map(top).filter((scope): scope is string => !!scope))];
}

/**
 * The plannedFiles a widening by `paths` proposes, with every directory entry it folded files into.
 * Entries already covered by another entry are normalized away first (GY-906): redundancy in the
 * item's own plannedFiles must never make a widening look unrepresentable — an item at the cap
 * holding `tests/` beside exact paths under it has room for the ask once the covered entries go.
 * Deepest directories first: one naming more than `collapseDirectoryFiles` entries becomes one
 * entry. Then, while the list is over `plannedFilesMax`, the directory that removes the most
 * entries is folded (the deepest on a tie). Only directories inside `area` that hold a requested
 * path are considered, so a fold never widens past what the request and the item already name;
 * planned entries it contains are folded with it. Paths already planned are not asked for again.
 */
export function collapsePlannedFiles(plannedFiles: readonly string[], paths: readonly string[], area: readonly string[]): { plannedFiles: string[]; collapsed: CollapsedScope[] } {
  const adding = unplannedPaths(plannedFiles, paths);
  let entries = normalizedScopes([...new Set([...plannedFiles, ...adding])]);
  const candidates = [...new Set(adding.flatMap(directoriesAbove))]
    .filter(directory => area.some(scope => pathScopeContains(scope, directory)))
    .sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
  const inside = (directory: string) => entries.filter(entry => pathScopeContains(directory, entry)).length;
  const fold = (directory: string) => { entries = [...entries.filter(entry => !pathScopeContains(directory, entry)), directory]; };
  for (const directory of candidates) if (!entries.includes(directory) && inside(directory) > collapseDirectoryFiles) fold(directory);
  while (entries.length > plannedFilesMax) {
    const best = candidates.filter(directory => !entries.includes(directory)).map(directory => ({ directory, count: inside(directory) }))
      .filter(entry => entry.count > 1).sort((a, b) => b.count - a.count || depth(b.directory) - depth(a.directory))[0];
    if (!best) break;
    fold(best.directory);
  }
  const collapsed = entries.filter(entry => !plannedFiles.includes(entry) && !adding.includes(entry))
    .map(scope => ({ scope, files: adding.filter(path => pathScopeContains(scope, path)) }));
  return { plannedFiles: entries, collapsed };
}

/** The plannedFiles a widening applies as, and whether any fold represents it under the cap (GY-630). */
export interface Widening { plannedFiles: string[]; collapsed: CollapsedScope[]; representable: boolean }

/**
 * The plannedFiles an approved widening by `paths` applies (GY-630). The rule and a review finding
 * approve directly, never through the approver, so their paths are unioned as asked while that
 * fits; a union over `plannedFilesMax` is folded exactly as a routed ask is, so a wide ask a
 * criterion's directory implies is applied as directory entries instead of stalling at the cap.
 * `representable` is false when even the fold leaves more entries than the cap holds: no revision
 * can carry the ask, so every caller refuses it rather than apply or post what the schemas reject.
 */
export function widenedPlannedFiles(item: { criteria?: readonly ScopeCriterion[]; plannedFiles?: readonly string[] }, paths: readonly string[]): Widening {
  const union = [...new Set([...(item.plannedFiles ?? []), ...paths])];
  if (union.length <= plannedFilesMax) return { plannedFiles: union, collapsed: [], representable: true };
  const folded = collapsePlannedFiles(item.plannedFiles ?? [], paths, collapseArea(item));
  return { ...folded, representable: folded.plannedFiles.length <= plannedFilesMax };
}

/**
 * A widening as the approver reads it: each folded directory with the requested files it covers
 * (so the decision names both), then the files listed as asked. The fold is said first, since a
 * long file list is what gets cut.
 */
export function describeWidening(paths: readonly string[], collapsed: readonly CollapsedScope[], max = 400) {
  const cut = (text: string, room: number) => text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`;
  const folded = collapsed.map(entry => `${entry.scope} (one directory entry, plannedFiles holding at most ${plannedFilesMax}; covers ${entry.files.length} requested file${entry.files.length === 1 ? '' : 's'}: ${cut(entry.files.join(', '), Math.max(60, Math.floor(max / (collapsed.length + 1))))})`);
  const listed = paths.filter(path => !collapsed.some(entry => pathScopeContains(entry.scope, path)));
  return cut([...folded, ...listed].join(', '), max);
}

/** True when every path of `current` is still inside some scope of `next`: kept, or folded into a directory. */
export const plannedFilesCovered = (current: readonly string[], next: readonly string[]) =>
  current.every(path => next.some(scope => pathScopeContains(scope, path)));

/**
 * One requirements decision covers every outstanding path of an attempt (GY-549): a new additive
 * ask while the same attempt's earlier one is still pending — undecided, or refused by the rule and
 * so with the approver — is merged into it, the paths still outside plannedFiles carried over. The
 * merged request is a new ask (its own instant), so a decision standing for the earlier one is
 * moved past and withdrawn, and one decision is requested for the whole. A request the approver
 * or a master refused, or one that drops paths or rewrites criteria, is replaced as before.
 */
export function mergedScopeRequest(pending: ScopeRequestState | null | undefined, ask: ScopeRequestState, plannedFiles: readonly string[] = []): ScopeRequestState {
  const additive = (request: ScopeRequestState) => !request.remove?.length && !request.criteria?.length;
  if (!pending || pending.epoch !== ask.epoch || !additive(pending) || !additive(ask) || (pending.decision && pending.decision.decidedBy !== 'graphyard')) return ask;
  const carried = unplannedPaths(plannedFiles, pending.paths);
  if (!carried.length) return ask;
  const reason = pending.reason === ask.reason || pending.reason.includes(ask.reason) ? pending.reason : `${pending.reason} | ${ask.reason}`;
  return { ...ask, paths: [...new Set([...carried, ...ask.paths])], reason: reason.length <= 2000 ? reason : `${reason.slice(0, 1999)}…` };
}

/**
 * The additive widening a refused request asks the approver for, a wide ask folded into directory
 * entries (GY-549), or null. A fold that still cannot represent the ask under the cap is never
 * routed: the revision it would propose is refused by the schema on every attempt, so the refusal
 * stays standing for the operator instead of a doomed decision (GY-630).
 */
export function routableScopeRequest(item: { plannedFiles?: readonly string[]; criteria?: readonly ScopeCriterion[]; scopeRequest?: ScopeRequestState | null; lease?: { epoch: number; expiresAt: string } | null }, now: number) {
  const request = item.scopeRequest;
  if (!request || request.decision?.state !== 'refused' || request.remove?.length || request.criteria?.length) return null;
  // A request whose attempt no longer holds the lease is moot: a fresh attempt asks afresh.
  if (!item.lease || item.lease.epoch !== request.epoch || Date.parse(item.lease.expiresAt) <= now) return null;
  return routableWidening(item, request);
}
const routableWidening = (item: { plannedFiles?: readonly string[]; criteria?: readonly ScopeCriterion[] }, request: ScopeRequestState) => {
  const paths = unplannedPaths(item.plannedFiles, request.paths);
  const folded = paths.length ? collapsePlannedFiles(item.plannedFiles ?? [], paths, collapseArea(item)) : null;
  return folded && folded.plannedFiles.length <= plannedFilesMax ? { request, paths, ...folded } : null;
};

/**
 * The ask an ended attempt carried to the item while the approver judged it (GY-1484), still routed
 * to that approver (GY-1568), or null. A worker that asks and then submits (or releases) ends its
 * attempt seconds later; the ask is carried, so no live request remains for `routableScopeRequest`
 * to read, and the loop used to withdraw the routed decision as one the item had moved past — the
 * operator then widened by hand. The carried ask keeps its epoch and instant, so the decision it is
 * routed as is the very one requested while the attempt lived, and its approval applies as the late
 * answer the engine accepts. Only while no attempt holds an ask of its own: a claim inherits it.
 */
export function routableCarriedRequest(item: { plannedFiles?: readonly string[]; criteria?: readonly ScopeCriterion[]; scopeRequest?: ScopeRequestState | null; carriedScopeRequest?: ScopeRequestState | null }) {
  const request = item.carriedScopeRequest;
  if (!request || item.scopeRequest || request.decision?.state !== 'refused' || request.decision.decidedBy !== 'graphyard' || request.remove?.length || request.criteria?.length) return null;
  return routableWidening(item, request);
}

/** The ask the independent approver judges for the item: its live attempt's routed request, or the one an ended attempt carried. */
export const routedScopeRequest = (item: Parameters<typeof routableScopeRequest>[0] & Parameters<typeof routableCarriedRequest>[0], now: number) =>
  routableScopeRequest(item, now) ?? routableCarriedRequest(item);

/**
 * True when the item's standing refusal is the terminal over-cap one (GY-906): a purely additive
 * request the widening rule refused that no fold represents under `plannedFilesMax`, so `master
 * scope` — the plain exact-path union — is refused by that same bound and can never carry the ask.
 * The liveness escalation and the status actions name `master requirements`, whose plannedFiles
 * can fold or split the ask under the cap, rather than an impossible command (GY-936).
 */
export function terminalScopeRefusal(item: { plannedFiles?: readonly string[]; criteria?: readonly ScopeCriterion[]; scopeRequest?: ScopeRequestState | null }): boolean {
  const request = item.scopeRequest;
  if (request?.decision?.state !== 'refused' || request.decision.decidedBy !== 'graphyard') return false;
  if (request.remove?.length || request.criteria?.length) return false;
  const paths = unplannedPaths(item.plannedFiles, request.paths);
  if (!paths.length) return false;
  return collapsePlannedFiles(item.plannedFiles ?? [], paths, collapseArea(item)).plannedFiles.length > plannedFilesMax;
}

/**
 * What the worker reads in its own session once its request is judged (GY-176) — from its own
 * `scope-request --wait` or `status`, never a message pasted into the session: carry on, or the
 * approver's reason and that the attempt stays inside plannedFiles, withdrawing the ask, which
 * lifts the refusal holding the item, rather than waiting on a master that will not come.
 */
export function scopeOutcomeMessage(key: string, epoch: number, outcome: { state: 'approved' | 'refused'; paths: readonly string[]; approver: string | null; reason: string | null; companions?: readonly string[] }, cli = 'graphyard') {
  const paths = outcome.paths.join(', ');
  // A path granted as the timing baseline's companion (GY-1023) is not planned: say what it does allow.
  const companions = outcome.companions?.length ? outcome.companions : [], planned = outcome.paths.filter(path => !companions.includes(path));
  return outcome.state === 'approved'
    ? `Graphyard: your scope request on ${key} (epoch ${epoch}) was approved${outcome.approver ? ` by ${outcome.approver}` : ''}${outcome.reason ? `: ${outcome.reason}` : ''}.${planned.length ? ` plannedFiles now include ${planned.join(', ')}` : ''}${companions.length ? `${planned.length ? ';' : ''} ${companions.join(', ')} is granted as an implied companion and stays outside plannedFiles, so only the lines of the test files this change adds or changes may change there,` : ''} and you keep your lease: continue the work.`
    : `Graphyard: your scope request on ${key} (epoch ${epoch}) for ${paths} was refused by the independent approver${outcome.approver ? ` ${outcome.approver}` : ''}: ${outcome.reason ?? 'no reason recorded'}. Stay inside plannedFiles: withdraw the request with ${cli} scope-request ${key} ${epoch} - and finish the work without those files, or record a blocker if the criteria cannot be met without them.`;
}

export type ScopeRequestOutcome = { state: 'pending' | 'ended'; text: string } | { state: 'approved' | 'refused'; text: string };
/**
 * The outcome of one ask (its epoch and instant, or the later ask of its attempt it merged into: GY-549), read from the item as the
 * control plane holds it now. A refusal by the widening rule (`decidedBy` graphyard) is not the
 * answer: the loop puts it to the independent approver, so it is still pending. An approval by
 * any path — the rule, a finding, the approver or a master — shows as the paths now planned.
 * A lease past its deadline ends the wait even before reconciliation clears it: no approval or
 * refusal can reach that attempt any more. `now` is the control plane's time (a snapshot's `now`),
 * since the deadline is one it issued: a worker host's clock is never compared with it.
 */
export function scopeRequestOutcome(item: { key: string; plannedFiles?: readonly string[]; lease?: { epoch: number; expiresAt: string } | null; scopeRequest?: ScopeRequestState | null; scopeDecision?: ScopeDecision | null },
  ask: { epoch: number; at: string; paths: readonly string[] }, now: number, cli = 'graphyard'): ScopeRequestOutcome {
  const own = item.scopeRequest?.epoch === ask.epoch && (item.scopeRequest.at === ask.at || unplannedPaths(item.plannedFiles, ask.paths).every(path => item.scopeRequest!.paths.includes(path))) ? item.scopeRequest : null;
  const decided = item.scopeDecision?.requestedAt === ask.at ? item.scopeDecision : null;
  const outside = unplannedPaths(item.plannedFiles, ask.paths), covered = !outside.length;
  // Liveness comes first: an outcome, even one decided before the deadline, is not this attempt's
  // to act on once its lease has lapsed or been reconciled away.
  if (item.lease?.epoch !== ask.epoch || Date.parse(item.lease.expiresAt) <= now) return { state: 'ended', text: `Graphyard: your lease on ${item.key} (epoch ${ask.epoch}) is no longer live, so no scope outcome applies to this attempt; stop the work` };
  // A path the decision granted for this ask without planning it — the timing baseline's implied companion (GY-1023) — is approved too.
  const granted = !own && decided?.state === 'approved' && outside.every(path => decided.paths.includes(path));
  if (!own && (covered || granted)) return { state: 'approved', text: scopeOutcomeMessage(item.key, ask.epoch, { state: 'approved', paths: ask.paths, approver: decided?.state === 'approved' && decided.decidedBy !== 'graphyard' ? decided.decidedBy : null, reason: decided?.state === 'approved' ? decided.reason : null, companions: outside }, cli) };
  const refusal = own?.decision ?? decided;
  // A refusal names only the paths still outside plannedFiles: one widened meanwhile, by any path,
  // is planned, and the worker is not told to finish without it.
  if (refusal?.state === 'refused' && refusal.decidedBy !== 'graphyard') return { state: 'refused', text: scopeOutcomeMessage(item.key, ask.epoch, { state: 'refused', paths: outside.length ? outside : ask.paths, approver: refusal.decidedBy, reason: refusal.reason }, cli) };
  // A purely additive refusal the widening rule gave that no fold represents (GY-906) is final for
  // this ask: routableScopeRequest declines it, so it is never routed to an approver, and reading
  // it as pending would hold the worker on a judgement that will not come. The viable action is to
  // split the ask: withdraw it and re-ask the part a fold represents, or finish without the rest.
  if (own && !own.remove?.length && !own.criteria?.length && !covered && own.decision?.state === 'refused' && own.decision.decidedBy === 'graphyard' && !routableScopeRequest(item, now))
    return { state: 'refused', text: `Graphyard: your scope request on ${item.key} (epoch ${ask.epoch}) for ${outside.join(', ')} cannot be carried: ${own.decision.reason}. Withdraw it with ${cli} scope-request ${item.key} ${ask.epoch} - and re-ask only the part that fits, or finish the work without it.` };
  if (!own) return { state: 'ended', text: `Graphyard: your scope request on ${item.key} (epoch ${ask.epoch}) is no longer open — withdrawn or re-asked — and nothing widened plannedFiles for it` };
  return { state: 'pending', text: `Graphyard: your scope request on ${item.key} (epoch ${ask.epoch}) for ${ask.paths.join(', ')} is ${own.decision ? 'with the independent approver: the widening rule could not ground it' : 'waiting for the widening rule'}; you keep your lease` };
}
