// Concern: cycle step 2 — decide open scope requests and measure the decision budget.
import type { Work } from '../model.js';
import { type ScopeRequestState, pathScope, pathScopeContains, pinningTestGround, redecidableScopeRefusal, routableScopeRequest, testFile, unplannedPaths } from '../model/scope.js';
import { barrelSuccessorGround, criterionSymbolGround, criterionSymbols, criterionTestGround, phraseCallees } from '../model/criterion-scope.js';
import { type Successor, successorGround, successorsOf } from '../model/successors.js';
import { findingScope, type ReviewFinding } from '../review-scope.js';
import { guardBroadScope } from '../master.js';
import { message, scopeMeasurementSchema } from './state.js';
import { scopeKey } from './reconcile.js';
import { scopeBudget } from './metrics.js';
import { readyToRetry } from './sessions.js';
import { boundDetail, detailChanged, namePaths } from './decisions.js';
import { findingRecheckMs, record } from './effects.js';
import type { Cycle } from './cycle.js';

/** A requested path the loop grants without an approver, and the audited ground it stands on. */
export interface ScopeGround { path: string; ground: string }
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
 */
export async function automaticScopeGrounds(item: Work, request: ScopeRequestState, paths: readonly string[], findings: readonly ReviewFinding[], exists: (path: string) => boolean, read?: (path: string) => Promise<string | null>, successors?: () => Promise<readonly Successor[]>, mentions?: (identifier: string) => Promise<number>): Promise<{ grounds: ScopeGround[] } | { grounds?: ScopeGround[]; refusal: string }> {
  const grounds: ScopeGround[] = [], refusals: string[] = [];
  let planned: { path: string; text: string | null }[] | null = null;
  let succeeding: readonly Successor[] | null = null;
  const symbols = criterionSymbols(item.criteria);
  const searched = new Map<string, number>();
  for (const path of paths) {
    const named = findingScope([path], findings, exists);
    if ('grounds' in named) { grounds.push(...named.grounds); continue; }
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
      if (mentions) for (const identifier of phraseCallees(text, symbols).slice(0, 20)) if (!searched.has(identifier)) searched.set(identifier, await mentions(identifier));
      const symbol = criterionSymbolGround(path, text, symbols, searched);
      if (symbol) { grounds.push({ path, ground: symbol }); continue; }
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
  const widenedOn = (grounds: { ground: string }[], count: number): string => {
    const kinds = new Set(grounds.map(entry => entry.ground.startsWith('successor of ') ? 'successor' : /^review /.test(entry.ground) ? 'finding' : 'criteria'));
    if (kinds.size === 1 && kinds.has('successor')) return `the base branch's split or rename of a planned file`;
    if (kinds.size === 1 && kinds.has('finding')) return `the review finding that names ${count === 1 ? 'it' : 'them'}`;
    if (kinds.size === 1) return `what the item's criteria name: a symbol a file defines or calls, or text a test pins`;
    return [kinds.has('finding') && 'a review finding', kinds.has('successor') && `the base branch's split or rename of a planned file`, kinds.has('criteria') && `what the item's criteria name`].filter(Boolean).join(' and ');
  };
  const widenOnFindings = async (item: Work, request: ScopeRequestState): Promise<string | null> => {
    if (!(effects.reviewFindings || effects.baseSuccessions || effects.baseText) || !effects.widenScope || request.remove?.length || request.criteria?.length) return null;
    if (!item.lease || item.lease.epoch !== request.epoch || Date.parse(item.lease.expiresAt) <= clock) return null;
    const paths = (request.decision?.paths?.length ? request.decision.paths : request.paths).filter(path => !(item.plannedFiles ?? []).some(planned => pathScopeContains(planned, path)));
    if (!paths.length) return null;
    const key = `${scopeKey(item, request)}:finding:${item.policyRevision}`;
    const previous = state.actions[key];
    if (previous?.state === 'done' && /^Widened /.test(previous.detail)) return previous.at;
    const judged = previous?.state === 'done';
    if (judged ? clock - Date.parse(previous.at) < findingRecheckMs : previous && (previous.state !== 'failed' || !readyToRetry(previous, state.cycle))) return null;
    const attempts = judged ? previous.attempts : (previous?.attempts ?? 0) + 1;
    try {
      const findings = await effects.reviewFindings?.(item) ?? [];
      const existing = await effects.basePaths?.(paths) ?? new Set<string>();
      const scoped = await automaticScopeGrounds(item, request, paths, findings, path => existing.has(path), effects.baseText, baseSuccessors(effects, item), effects.baseMentions);
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
      const reason = guardBroadScope({ ...item, plannedFiles: [...new Set([...(item.plannedFiles ?? []), ...granted])] },
        `Additive scope ${item.key}'s own change calls for — a review finding names it, it succeeds a planned file the base branch split, renamed or re-exports, a test pins text a planned file holds or a criterion changes, or it defines or calls a symbol a criterion names: ${grounds}. ${request.requestedBy} asked because ${request.reason}`.slice(0, 1900), { allow: false, command: 'the loop', existing: item.plannedFiles });
      const widened = await effects.widenScope(item, request, granted, reason) as Work | undefined;
      // The time the control plane recorded the answer, never the cycle's: the worker reads it at once.
      const recorded = widened?.scopeDecision;
      const at = recorded?.epoch === request.epoch && recorded.requestedAt === request.at ? recorded.at : new Date(now()).toISOString();
      if (rest) {
        // Partly widened: the rest stays refused, for the approver, and is judged again like any
        // refusal. The approver is asked for it against the widened item, never this cycle's
        // snapshot, whose plannedFiles would drop what was just granted.
        if (widened?.id === item.id) settled.set(item.id, widened);
        performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done', detail: boundDetail(`Partly widened ${item.key} with ${namePaths(granted)} on ${widenedOn(scoped.grounds!, granted.length)}: ${grounds}. The rest goes to the approver: ${rest}`), attempts, cycle: state.cycle }, now(), effects.persist));
        return null;
      }
      performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done', detail: boundDetail(`Widened ${item.key} with ${namePaths(paths)} on ${widenedOn(scoped.grounds!, paths.length)}: ${grounds}`), attempts, cycle: state.cycle }, now(), effects.persist));
      return at;
    } catch (error) {
      performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'failed', detail: boundDetail(`Could not widen ${item.key} on a review finding or a planned file's successor: ${message(error)}`), attempts, cycle: state.cycle }, now(), effects.persist));
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
export async function successorStep(cycle: Cycle) {
  const { state, effects, now, performed, isolate, open } = cycle;
  if (!effects.baseSuccessions || !effects.replan) return;
  for (const item of open) await isolate('scope', item, item.key, async () => {
    if (item.observation?.merged || !(item.plannedFiles ?? []).length) return;
    const key = `successors:${item.id}:${item.policyRevision}`;
    const previous = state.actions[key];
    if (previous && !readyToRetry(previous, state.cycle)) return;
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
      performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: null, epoch: item.epoch, state: 'failed',
        detail: boundDetail(`Could not re-plan ${item.key} onto the successors of its planned files: ${message(error)}`), attempts, cycle: state.cycle }, now(), effects.persist));
    }
  });
}
