// Concern: cycle step 2 — decide open scope requests and measure the decision budget.
import type { Work } from '../model.js';
import { type ScopeRequestState, companionGround, decideScopeRequest, itemDocumentationPaths, pathScope, pathScopeContains, pinningTestGround, plannedFilesMax, redecidableScopeRefusal, routableScopeRequest, scopeDecisionBinding, testFile, unplannedPaths } from '../model/scope.js';
import { importingTestGround, newProofTestGround, peerModuleGround } from '../model/scope-companions.js';
import { widenedPlannedFiles } from '../model/scope-collapse.js';
import { barrelSuccessorGround, criterionSymbolGround, criterionSymbols, criterionTestGround, phraseCallees } from '../model/criterion-scope.js';
import { type Successor, successorGround, successorsOf } from '../model/successors.js';
import { findingScope, type ReviewFinding } from '../review-scope.js';
import { guardBroadScope } from '../master.js';
import { RefusedResponse } from '../model/refusal.js';
import { message, scopeMeasurementSchema } from './state.js';
import { scopeKey } from './reconcile.js';
import { scopeBudget } from './metrics.js';
import { readyToRetry } from './sessions.js';
import { boundDetail, detailChanged, namePaths } from './decisions.js';
import { findingRecheckMs, record } from './effects.js';
import type { Cycle } from './cycle.js';

/** A requested path the loop grants without an approver, and the audited ground it stands on; `companion` marks a GY-955 companion. */
export interface ScopeGround { path: string; ground: string; companion?: boolean }
/**
 * GY-199. What grants each requested path without an approver: a trusted review finding naming it
 * (review-scope.ts findingScope), a file on the base that succeeds a planned file main split or
 * renamed (GY-394, model/successors.ts successorsOf) or that a planned re-export barrel names
 * (GY-438, model/criterion-scope.ts barrelSuccessorGround), a test whose quoted failing assertion a planned
 * file holds (model/scope.ts pinningTestGround), and — GY-438 — a test that pins a label, route or
 * CLI output a criterion changes (criterionTestGround) or a file that defines or directly calls a
 * symbol a criterion names (criterionSymbolGround). Every file is read from the base branch
 * outside every transaction; `successors` is read once, and only when a finding does not already
 * ground a path, and `mentions` searches the base tree for the identifiers a phrase-spelled call
 * would ground on. The grounded paths are returned with the refusal of the rest, so what the rules
 * ground is granted and only what they do not goes to the approver.
 *
 * GY-955: each path is judged on its own, so one ungrounded path never refuses the rest. A path the
 * engine's rule implies on its own (a criterion names it, documentation, a companion such as the
 * docs-budget gate beside a documentation path) is granted here too, and so are the companions only
 * the base can ground: a test importing a module a planned file is or re-exports
 * (importingTestGround), and a new test file the criteria's unit proofs need when no base file holds
 * them (newProofTestGround, searched by `held`).
 */
export async function automaticScopeGrounds(item: Work, request: ScopeRequestState, paths: readonly string[], findings: readonly ReviewFinding[], exists: (path: string) => boolean, read?: (path: string) => Promise<string | null>, successors?: () => Promise<readonly Successor[]>, mentions?: (identifier: string) => Promise<number>, held?: (proof: string) => Promise<number>): Promise<{ grounds: ScopeGround[] } | { grounds?: ScopeGround[]; refusal: string }> {
  const grounds: ScopeGround[] = [], refusals: string[] = [];
  let planned: { path: string; text: string | null }[] | null = null;
  let succeeding: readonly Successor[] | null = null;
  const symbols = criterionSymbols(item.criteria);
  const searched = new Map<string, number>();
  const documentation = itemDocumentationPaths(item);
  for (const path of paths) {
    const named = findingScope([path], findings, exists);
    if ('grounds' in named) { grounds.push(...named.grounds); continue; }
    const implied = decideScopeRequest(item, { paths: [path] });
    if (implied.state === 'approved') { grounds.push({ path, ground: implied.reason.replace(/^additive scope the item already implies — /, ''), companion: true }); continue; }
    const companion = companionGround(path, item, paths, documentation);
    if (companion) { grounds.push({ path, ground: companion, companion: true }); continue; }
    if (held && !pathScope(path).prefix && !path.includes('*') && !exists(path)) {
      const proofs = await newProofTestGround(path, item.criteria, held);
      if (proofs) { grounds.push({ path, ground: proofs, companion: true }); continue; }
    }
    if (successors && !pathScope(path).prefix && exists(path)) {
      succeeding ??= await successors();
      const successor = succeeding.find(entry => entry.path === path);
      if (successor) { grounds.push({ path, ground: successorGround(successor) }); continue; }
    }
    if (read && !pathScope(path).prefix && !path.includes('*') && exists(path)) {
      planned ??= await Promise.all((item.plannedFiles ?? []).filter(scope => !pathScope(scope).prefix && !scope.includes('*')).slice(0, 50).map(async scope => ({ path: scope, text: await read(scope) })));
      const text = await read(path);
      const barrel = barrelSuccessorGround(path, planned);
      if (barrel) { grounds.push({ path, ground: barrel }); continue; }
      const pinning = testFile(path) ? pinningTestGround(path, request.reason, text, planned) ?? criterionTestGround(path, text, symbols) : null;
      if (pinning) { grounds.push({ path, ground: pinning }); continue; }
      const importing = await importingTestGround(path, text, item.plannedFiles ?? [], read);
      if (importing) { grounds.push({ path, ground: importing, companion: true }); continue; }
      if (mentions) for (const identifier of phraseCallees(text, symbols).slice(0, 20)) if (!searched.has(identifier)) searched.set(identifier, await mentions(identifier));
      const symbol = criterionSymbolGround(path, text, symbols, searched);
      if (symbol) { grounds.push({ path, ground: symbol }); continue; }
      const peer = await peerModuleGround(path, text, item.plannedFiles ?? [], read);
      if (peer) { grounds.push({ path, ground: peer, companion: true }); continue; }
    }
    refusals.push(named.refusal);
  }
  if (!refusals.length) return { grounds };
  return grounds.length ? { grounds, refusal: refusals.join('; ') } : { refusal: refusals.join('; ') };
}

/** Step 2: decide the open scope requests, and measure the decision budget over what is still waiting. */
export async function scopeStep(cycle: Cycle) {
  const { state, effects, now, clock, performed, isolate, open } = cycle;
  // 2. Decide the open scope requests. A worker that needs a file its own criteria — or this
  //    repository's documentation rule — already imply must not wait for a master session to run
  //    a command: the control plane recomputes the decision from the item itself, and the loop
  //    asks it to settle every open request on the cycle it first sees one. An implied additive
  //    request is applied to the live item with its audited reason; anything wider is refused and
  //    escalated here with that reason, and the item stays blocked until an operator decides it.
  //    What this pass decides is kept, so the budget below measures what is still waiting rather
  //    than what has just been answered.
  const settled = new Map<string, Work>();
  // Items whose widening this cycle answered an ask no longer open (GY-1348): nothing more is said about that ask.
  const superseded = new Set<string>();
  // 2a. A refused request for files a review finding on the item's own change names. The finding
  //     is the grounds the item's criteria lack: the loop reads it with its own GitHub access and
  //     widens by exactly those files as the master's own additive intent, once per request and
  //     policy revision; anything the findings do not name stays refused and escalated. Findings
  //     change while the request and revision stand — a bot's thread lands after the refusal — so
  //     a refusal on the findings is judged again every findingRecheckMs, never cached for good.
  //     The reads take seconds; the widening names the request it answers, so a claim or lease
  //     end that clears that request meanwhile makes the control plane refuse it, never apply it.
  //     It answers with the time the control plane recorded the widening, or null when it did not widen.
  // What an automatic widening stood on, in the audit detail: the grounds it actually used.
  const widenedOn = (grounds: ScopeGround[], count: number): string => {
    const kinds = new Set(grounds.map(entry => entry.companion ? 'companion' : entry.ground.startsWith('successor of ') ? 'successor' : /^review /.test(entry.ground) ? 'finding' : 'criteria'));
    if (kinds.size === 1 && kinds.has('companion')) return `the companions the change inevitably carries: what the item implies, a test importing a planned module, a peer module a planned file imports or that imports it, the test its proofs live in or the docs-budget gate`;
    if (kinds.size === 1 && kinds.has('successor')) return `the base branch's split or rename of a planned file`;
    if (kinds.size === 1 && kinds.has('finding')) return `the review finding that names ${count === 1 ? 'it' : 'them'}`;
    if (kinds.size === 1) return `what the item's criteria name: a symbol a file defines or calls, or text a test pins`;
    return [kinds.has('finding') && 'a review finding', kinds.has('successor') && `the base branch's split or rename of a planned file`, kinds.has('criteria') && `what the item's criteria name`, kinds.has('companion') && 'the companions the change inevitably carries'].filter(Boolean).join(' and ');
  };
  const widenOnFindings = async (item: Work, request: ScopeRequestState): Promise<string | null> => {
    if (!(effects.reviewFindings || effects.baseSuccessions || effects.baseText) || !effects.widenScope || request.remove?.length || request.criteria?.length) return null;
    if (!item.lease || item.lease.epoch !== request.epoch || Date.parse(item.lease.expiresAt) <= clock) return null;
    const paths = (request.decision?.paths?.length ? request.decision.paths : request.paths).filter(path => !(item.plannedFiles ?? []).some(planned => pathScopeContains(planned, path)));
    if (!paths.length) return null;
    const key = `${scopeKey(item, request)}:finding:${item.policyRevision}`;
    const previous = state.actions[key];
    if (previous?.state === 'done' && /^Widened /.test(previous.detail)) return previous.at;
    // The rest of a partly widened request is the approver's once it is asked (GY-1293): reading the
    // findings again meanwhile would widen by one more hop of companions, move the revision the
    // approver's decision is bound to, and defer that decision another cycle.
    if (approverDeciding(state.approvals, item.key, request)) return null;
    const judged = previous?.state === 'done';
    if (judged ? clock - Date.parse(previous.at) < findingRecheckMs : previous && (previous.state !== 'failed' || !readyToRetry(previous, state.cycle))) return null;
    const attempts = judged ? previous.attempts : (previous?.attempts ?? 0) + 1;
    try {
      const prFindings = await effects.reviewFindings?.(item) ?? [];
      const itemFindings: ReviewFinding[] = (item.origin?.reviewFollowUps?.findings ?? []).map(f => ({
        ground: `review follow-up finding${f.path ? ` (${f.path})` : ''}`,
        text: `${f.path ? `${f.path} ` : ''}${f.text}`,
      }));
      const findings = [...prFindings, ...itemFindings];
      const existing = await effects.basePaths?.(paths) ?? new Set<string>();
      const scoped = await automaticScopeGrounds(item, request, paths, findings, path => existing.has(path), effects.baseText, baseSuccessors(effects, item), effects.baseMentions, effects.baseMentions);
      // A path no rule grounds goes to the approver; the ones the rules do ground are granted now,
      // so the approver judges only the rest (routableScopeRequest reads what is still unplanned).
      if ('refusal' in scoped && !scoped.grounds?.length) {
        const detail = boundDetail(`Not widened on a review finding, a planned file's successor or what the criteria name: ${scoped.refusal}`);
        const entry = await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done', detail, attempts, cycle: state.cycle }, now(), effects.persist);
        // An unchanged refusal is the same decision read again, not a new action.
        if (judged && previous.detail !== detail) performed.push(entry);
        return null;
      }
      const granted = scoped.grounds!.map(entry => entry.path), rest = 'refusal' in scoped ? scoped.refusal : null;
      const grounds = scoped.grounds!.map(entry => `${entry.path} (${entry.ground})`).join('; ');
      // No fold may represent the grounded paths under the cap: the widening is refused before it
      // is posted, and the request keeps its refusal as it stands for the approver (GY-630).
      const wide = widenedPlannedFiles(item, granted);
      if (!wide.representable) {
        const detail = boundDetail(`Not widened ${item.key}: the ${granted.length} grounded paths fold to ${wide.plannedFiles.length} planned entries, past the ${plannedFilesMax} plannedFiles holds, so no requirements revision can carry them`);
        const entry = await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done', detail, attempts, cycle: state.cycle }, now(), effects.persist);
        if (judged && previous.detail !== detail) performed.push(entry);
        return null;
      }
      const reason = guardBroadScope({ ...item, plannedFiles: [...new Set([...(item.plannedFiles ?? []), ...granted])] },
        `Additive scope ${item.key}'s own change calls for — a review finding names it, it succeeds a planned file the base branch split, renamed or re-exports, a test pins text a planned file holds or a criterion changes, it defines or calls a symbol a criterion names, or it is a companion the change inevitably carries: ${grounds}. ${request.requestedBy} asked because ${request.reason}`.slice(0, 1900), { allow: false, command: 'the loop', existing: item.plannedFiles });
      const widened = await effects.widenScope(item, request, granted, reason) as Work | undefined;
      // Every later step of this cycle reads the widened item, never the snapshot this widening
      // outdated: a successor re-plan posted from that snapshot is refused (GY-1235, GY-1293).
      if (widened?.id === item.id) settled.set(item.id, widened);
      // The time the control plane recorded the answer, never the cycle's: the worker reads it at once.
      const recorded = widened?.scopeDecision;
      const at = recorded?.epoch === request.epoch && recorded.requestedAt === request.at ? recorded.at : new Date(now()).toISOString();
      if (rest) {
        // Partly widened: the rest stays refused, for the approver, and is judged again like any
        // refusal. The approver is asked for it against the widened item, never this cycle's
        // snapshot, whose plannedFiles would drop what was just granted. The judgement stands for the
        // revision the widening made, so the decision step asks the approver this cycle (GY-1293).
        const detail = boundDetail(`Partly widened ${item.key} with ${namePaths(granted)} on ${widenedOn(scoped.grounds!, granted.length)}: ${grounds}. The rest goes to the approver: ${rest}`);
        performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done', detail, attempts, cycle: state.cycle }, now(), effects.persist));
        if (widened?.id === item.id && widened.policyRevision !== item.policyRevision)
          await record(state, `${scopeKey(item, request)}:finding:${widened.policyRevision}`, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done', detail, attempts: 1, cycle: state.cycle }, now(), effects.persist);
        return null;
      }
      performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done', detail: boundDetail(`Widened ${item.key} with ${namePaths(paths)} on ${widenedOn(scoped.grounds!, paths.length)}: ${grounds}`), attempts, cycle: state.cycle }, now(), effects.persist));
      return at;
    } catch (error) {
      // The race this widening is bound against, lost: the request was answered, withdrawn or re-asked
      // meanwhile, or its attempt ended, so the widening is moot — answered as the decide path answers
      // it, never a fault (GY-1347). A superseded ask is named, and its fresh ask is judged on its own
      // next cycle (GY-1348).
      const moot = mootScopeWidening(error);
      if (moot) {
        const superseding = supersededScopeAsk(error);
        if (superseding) superseded.add(item.id);
        const detail = boundDetail(`Not widened ${item.key}: ${moot}${superseding ? ` — the ask at ${request.at} by epoch ${request.epoch} was ${supersededScopeNote}` : ''}`);
        const entry = await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done', detail, attempts, cycle: state.cycle }, now(), effects.persist);
        // The same moot race read again on a recheck is not a new action.
        if (!judged || previous.detail !== detail) performed.push(entry);
        return null;
      }
      const transient = transientScopeRefusal(error);
      performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'failed', detail: boundDetail(`Could not widen ${item.key} on a review finding or a planned file's successor${transient ? ` (${transient}, ${transientScopeRetry})` : ''}: ${message(error)}`), attempts, cycle: state.cycle }, now(), effects.persist, scopeRefusalFault(transient, previous)));
      return null;
    }
  };
  for (const item of open) await isolate('scope', item, item.key, async () => {
    const request = item.scopeRequest;
    // A refusal is reconsidered only when the rules as they stand now would approve it — once per
    // policy revision of the item, backing off on failure — so a standing refusal never churns.
    const redecide = !!request?.decision && redecidableScopeRefusal(item);
    if (request?.decision?.state === 'refused' && !redecide) { await widenOnFindings(item, request); return; }
    if (!effects.decideScope || !request || (request.decision && !redecide)) return;
    // A request whose attempt no longer holds the lease is moot: a fresh attempt asks afresh.
    if (!item.lease || item.lease.epoch !== request.epoch || Date.parse(item.lease.expiresAt) <= clock) return;
    // One decider per request (GY-955): while an executor holds the control plane's approve-scope
    // row for it, that executor is the decider and the loop reads the outcome on a later cycle. A
    // row nobody has claimed is the loop's to answer, so a fleet serving no approve-scope never waits.
    if (executorDecidesScope(item, request, clock)) return;
    const key = redecide ? `${scopeKey(item, request)}:redecide:${item.policyRevision}` : scopeKey(item, request);
    const previous = state.actions[key];
    if (!readyToRetry(previous, state.cycle)) return;
    const attempts = (previous?.attempts ?? 0) + 1;
    await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'started',
      detail: `Deciding ${item.key}'s scope request for ${request.paths.length ? namePaths(request.paths) : 'no path'}`, attempts, cycle: state.cycle }, now(), effects.persist);
    try {
      const decided = await effects.decideScope(item);
      const decision = decided.scopeDecision;
      if (!decision) throw new Error('The control plane answered without a decision');
      settled.set(item.id, decided);
      // Decided meanwhile (GY-955): an executor's approve-scope, or a closing attempt, answered the
      // request between this cycle's snapshot and its post. The control plane answers with what it
      // recorded; a request it no longer holds is closed, so nothing is routed or escalated for it.
      if (decision.requestedAt !== request.at || !decided.scopeRequest && decision.state === 'refused') {
        performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done',
          detail: boundDetail(`${item.key}'s scope request for ${request.paths.length ? namePaths(request.paths) : 'no path'} was already answered: ${decision.requestedAt === request.at ? `${decision.state} — ${decision.reason}` : 'it is no longer open'}`), attempts, cycle: state.cycle }, now(), effects.persist));
        return;
      }
      // An additive refusal no finding grounds is put to the independent approver in step 4c, on
      // this same cycle: naming `master scope` would leave it waiting for a master to be around. Its
      // wait is measured when the approver answers, the decision the worker actually waits on.
      const routed = decision.state === 'refused' && !!effects.decide && !!effects.approver && !!routableScopeRequest(decided.scopeRequest ? decided : { ...item, scopeRequest: { ...request, decision } }, clock);
      if (!routed) state.scope.push(scopeMeasurementSchema.parse({ work: item.key, epoch: request.epoch, at: decision.at, waitedMs: decision.waitedMs, state: decision.state }));
      const waited = `${Math.round(decision.waitedMs / 1000)}s after ${request.requestedBy} asked`;
      performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done',
        detail: boundDetail(decision.state === 'approved'
          ? `Widened ${item.key} with ${namePaths(request.paths)} ${waited}: ${decision.reason}`
          : `Refused ${item.key}'s scope request for ${request.paths.length ? namePaths(request.paths) : 'no path'} ${waited}: ${decision.reason}`),
        attempts, cycle: state.cycle }, now(), effects.persist));
      const widenedAt = decision.state === 'refused' ? await widenOnFindings(decided, decided.scopeRequest ?? { ...request, decision }) : null;
      if (superseded.has(item.id)) return;
      if (widenedAt) {
        if (routed) state.scope.push(scopeMeasurementSchema.parse({ work: item.key, epoch: request.epoch, at: widenedAt, waitedMs: Math.max(0, Date.parse(widenedAt) - Date.parse(request.at)), state: 'approved' }));
        return;
      }
      if (decision.state === 'refused' && !routed) {
        const escalationKey = `escalation:scope:${item.id}:${request.at}`;
        // A partial widening just granted some paths: the escalation names only the ones still refused.
        const remaining = unplannedPaths((settled.get(item.id) ?? decided).plannedFiles, request.paths);
        performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done',
          detail: `${item.key} is blocked on scope: ${request.requestedBy} asked for ${remaining.length ? namePaths(remaining) : 'a requirements change'} because ${boundDetail(request.reason, 400)}, and the loop refused it because ${boundDetail(decision.reason, 500)}. Decide it with graphyard master scope ${item.key} REASON, or graphyard master requirements ${item.key} FILE REASON for anything that is not purely additive`,
          attempts: 1, cycle: state.cycle }, now(), effects.persist));
      }
    } catch (error) {
      performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'failed',
        detail: boundDetail(`Could not decide ${item.key}'s scope request: ${message(error)}`), attempts, cycle: state.cycle }, now(), effects.persist));
    }
  });

  // 2b. The promise that decision rests on: workers wait minutes, not a shift. A p90 above the
  //     budget, or any request left undecided past the blocked bound, is escalated with the
  //     numbers — the loop is the only thing that could have answered them.
  const budget = scopeBudget(open.map(item => settled.get(item.id) ?? item), state.scope, clock, !!effects.decide && !!effects.approver);
  for (const breach of budget.breaches) {
    const key = `escalation:scope-budget:${breach.id}`;
    if (!detailChanged(state.actions[key], breach.detail)) continue;
    performed.push(await record(state, key, { kind: 'escalation', work: null, principal: null, state: 'failed', detail: breach.detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  }
  return { settled, budget };
}

/**
 * True when an executor is deciding this request: the item's queue holds the approve-scope row
 * computed for it (bound to the request, or to its re-decision) under a live claim. A claim taken
 * after the loop's snapshot still races the loop's post; the control plane answers the second with
 * the standing decision, which the loop records as done (GY-955).
 */
export function executorDecidesScope(item: Pick<Work, 'actionQueue'>, request: Pick<ScopeRequestState, 'epoch' | 'at'>, clock: number) {
  const binding = scopeDecisionBinding(request);
  return (item.actionQueue?.actions ?? []).some(row => row.kind === 'approve-scope' && row.state === 'claimed' && (row.binding === binding || row.binding === `${binding}:redecide`)
    && !!row.claim && Date.parse(row.claim.expiresAt) > clock);
}

/** The successors of the item's planned files on the base since the item was planned, as a lazy read for `automaticScopeGrounds`. */
const baseSuccessors = (effects: Cycle['effects'], item: Work) => effects.baseSuccessions
  ? async () => { const read = await effects.baseSuccessions!(item.createdAt); return successorsOf(item.plannedFiles ?? [], read.successions).filter(entry => read.files.has(entry.path)); }
  : undefined;

/**
 * Step 2c (GY-394): re-plan open items onto the successors of the files they plan. When a merged
 * change splits or renames a file — GY-177 split src/master-daemon.ts into src/daemon/* — every open
 * item naming the old file would otherwise find the code it plans to change outside its scope, and
 * stall on a scope request or on the build gate. The loop reads the base branch's successions since
 * each item was planned and adds every successor that exists on the base, as the master's own
 * audited additive requirements revision naming each successor's ground. Nothing is removed, and an
 * item whose successors are all planned already is left alone, so a standing re-plan never churns.
 */
export async function successorStep(cycle: Cycle, settled: ReadonlyMap<string, Work> = new Map()) {
  const { state, effects, now, performed, isolate, open } = cycle;
  if (!effects.baseSuccessions || !effects.replan) return;
  // An item the scope step revised this cycle is re-planned from that revision, never from the
  // snapshot it outdated: the stale revision would be refused, not applied (GY-1235, GY-1293).
  for (const read of open) await isolate('scope', read, read.key, async () => {
    const item = settled.get(read.id) ?? read;
    if (item.observation?.merged || !(item.plannedFiles ?? []).length) return;
    const key = `successors:${item.id}:${item.policyRevision}`;
    const previous = state.actions[key];
    // A re-plan refused because the ask it answered was no longer open is tried afresh next cycle (GY-1348).
    if (previous && !readyToRetry(previous, state.cycle) && !previous.detail.includes(supersededScopeNote)) return;
    const attempts = (previous?.attempts ?? 0) + 1;
    try {
      const read = await effects.baseSuccessions!(item.createdAt);
      const found = successorsOf(item.plannedFiles ?? [], read.successions).filter(entry => read.files.has(entry.path));
      const missing = new Set(unplannedPaths(item.plannedFiles, found.map(entry => entry.path)));
      const adding = found.filter(entry => missing.has(entry.path));
      if (!adding.length) return;
      const grounds = adding.map(entry => `${entry.path} (${successorGround(entry)})`).join('; ');
      const reason = guardBroadScope({ ...item, plannedFiles: [...new Set([...(item.plannedFiles ?? []), ...missing])] },
        `Re-planned ${item.key} onto the successors of the files it plans, which the base branch split or renamed; nothing is removed: ${grounds}`.slice(0, 1900), { allow: false, command: 'the loop', existing: item.plannedFiles });
      await effects.replan!(item, [...missing], reason);
      performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: null, epoch: item.epoch, state: 'done',
        detail: boundDetail(`Re-planned ${item.key} with ${namePaths([...missing])}, the successors of planned files the base branch split or renamed: ${grounds}`), attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      const moot = supersededScopeAsk(error);
      if (moot) {
        performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: null, epoch: item.epoch, state: 'done',
          detail: boundDetail(`Not re-planned ${item.key} onto the successors of its planned files: ${moot} — the ask was ${supersededScopeNote}`), attempts, cycle: state.cycle }, now(), effects.persist));
        return;
      }
      const transient = transientScopeRefusal(error);
      performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: null, epoch: item.epoch, state: 'failed',
        detail: boundDetail(`Could not re-plan ${item.key} onto the successors of its planned files${transient ? ` (${transient}, ${transientScopeRetry})` : ''}: ${message(error)}`), attempts, cycle: state.cycle }, now(), effects.persist, scopeRefusalFault(transient, previous)));
    }
  });
}

/** What a scope action refused only transiently says, so its next failure can tell a run of them from one (GY-1293). */
const transientScopeRetry = 'so it is retried next cycle on a fresh read';
/**
 * GY-1293. Why the control plane refused one of the loop's own additive scope revisions without
 * judging its scope, or null: the plane answered 5xx (GY-1290 on 5 October 2026: an internal error
 * under reconciliation contention, widened on the next cycle), read from the response's own status,
 * or the item moved past the policy revision the loop read (a concurrent revision; the next cycle
 * reads the new one).
 */
export function transientScopeRefusal(error: unknown): string | null {
  if (error instanceof RefusedResponse && error.status >= 500) return 'the control plane answered 5xx';
  if (/Policy revision changed; reload before revising/.test(message(error))) return 'the item moved past the revision the loop read';
  return null;
}
/** What a widening refused for an ask no longer open says, so its record reads as the handled outcome it is (GY-1348). */
export const supersededScopeNote = 'answered, withdrawn or re-asked meanwhile; the fresh ask is judged on its own';
/**
 * GY-1348. Why the control plane refused one of the loop's widenings because the ask it answers no
 * longer stands, or null: the scope request it names was answered, withdrawn or re-asked meanwhile
 * (a worker's re-ask merges into the open request under its own `at`), or the attempt that asked no
 * longer holds the lease. The engine's refusal is the design (engine.ts, `answers`); the loop only
 * records it as handled, never as a scope fault. Only the plane's own 409 counts, as for any moot
 * widening (mootScopeWidening).
 */
export function supersededScopeAsk(error: unknown): string | null {
  if (!(error instanceof RefusedResponse) || error.status !== 409) return null;
  const text = message(error);
  if (/The scope request this widening answers is no longer open/.test(text)) return 'the scope request it answers was already answered: it is no longer open';
  if (/Epoch \d+, which asked for this scope, no longer holds the lease/.test(text)) return 'the attempt that asked for it no longer holds the lease';
  return null;
}
/**
 * GY-1347. Why the control plane refused the loop's widening as moot, or null: the widening names
 * the request it answers, and a claim, a lease end or a push between the loop's reads and its post
 * makes the plane refuse it (engine.ts, `data.answers`) rather than apply it — the design step 2a
 * describes. On 6 October 2026 GY-1336 and GY-1345 each counted that refusal as a scope fault,
 * while the decide path records the same race as already answered. A refusal with no response
 * status (a message merely quoting one) is not read as moot.
 */
export function mootScopeWidening(error: unknown): string | null {
  const superseded = supersededScopeAsk(error);
  if (superseded || !(error instanceof RefusedResponse) || error.status !== 409) return superseded;
  if (/The findings this widening rests on were read for .*, which is no longer the item's head/.test(message(error))) return `the head its findings were read for moved; they are read again for the new head in ${findingRecheckMs / 1000}s`;
  return null;
}
/**
 * The fault kind a refused scope action is noted under: a transient refusal judged nothing about the
 * item's scope, so one alone is no scope fault (null: stored for retry, never an instance); the
 * second in a row is, and so is every other refusal (undefined: the action's own kind, action:scope).
 * "In a row" is per action key, and the key names the policy revision: a stale-revision refusal's
 * retry runs under the new revision's key, so it starts a run of its own. That is intended — the
 * item moved on, and the retry is a new revision's first attempt, not the stale one again.
 */
export function scopeRefusalFault(transient: string | null, previous: { state: string; detail: string } | undefined): null | undefined {
  return transient && !(previous?.state === 'failed' && previous.detail.includes(transientScopeRetry)) ? null : undefined;
}
/** True while an approver judges the requirements decision that answers this scope request (GY-176). */
export function approverDeciding(approvals: Cycle['state']['approvals'], work: string, request: Pick<ScopeRequestState, 'epoch' | 'at'>) {
  return Object.values(approvals).some(watch => watch.work === work && !watch.settledAt && watch.scope?.epoch === request.epoch && watch.scope?.at === request.at);
}
