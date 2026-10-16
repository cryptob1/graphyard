// Concern: the diagnostician (GY-439) — each recurring-fault item, and each invariant violation that
// persists past its bound, gets one headless diagnosis, and the diagnosis becomes a closure or a fix
// item through the normal two-party decision.
import { createHash } from 'node:crypto';
import { createSchema, type Work } from '../model.js';
import type { MergerMode } from '../merger-mode.js';
import { headlessTimeoutLimitCharge, providerLimit, type ExhaustionSignal, type LimitRunEvent } from '../model/capacity.js';
import { isClosed } from '../model/closure.js';
import { planeWideRefusal } from '../model/blocker-class.js';
import { closesFaultClass, faultClassMeaning, openFaultClassItem, type FaultClass, type FaultInstance, type FaultKind } from '../model/fault-classes.js';
import { derivePlannedFiles, plannedFilesRefusal, scopeExists, type PlannedFilesDerivation } from '../model/planned-files.js';
import { namedPaths } from '../model/scope.js';
import { decisionInput, guardBroadScope } from '../master/autonomy.js';
import type { MasterConfig } from '../master/profiles.js';
import { recordEnvironmentLog, selectionKey } from '../master/environments.js';
import { baseTree } from '../cli/planned-files-intent.js';
import { diagnosisPayloadSchema, diagnosisSettled, diagnosticianSettings, graphyardTools, type DiagnosisPayload, type DiagnosisRecord, type DiagnosticianSettings } from '../runner/payloads.js';
import { piRunner } from '../runner/pi.js';
// What a diagnosis outcome leaves behind — its record key, cause kind and lost-run grace — and the
// fix item filed from it live in ./diagnosis-fix.ts; imported for use here and re-exported, so
// every existing import keeps working.
import { clip, diagnosisInput, diagnosisPrompt, diagnosisKey, diagnosisLostGraceMs, filingTree, fixItem, iso, namedPullRequests, noDiagnosisKind } from './diagnosis-fix.js';
export { clip, diagnosisEvidenceMax, diagnosisInput, diagnosisPrompt, type DiagnosisInput, diagnosisKey, diagnosisLostGraceMs, deriveDiagnosisFixPlannedFiles, excerpt, fixItem, namedPullRequests, noDiagnosisKind } from './diagnosis-fix.js';
import { registryHeadlessLaunch, registryRunner } from '../runner/roles.js';
import type { Runner } from '../runner/types.js';
import { type DaemonAction, type DaemonState, message } from './state.js';
import { record, selectDiagnosticianFleet } from './effects.js';
import { createRefused } from './doctor.js';
import { adoptedOnRefusal, maxDecisionRequests, standingNamedIn } from './decisions.js';
import type { Cycle } from './cycle.js';

// ---------------------------------------------------------------------------
// The loop files 'Recurring <class> faults' items (GY-173), but a symptom counted is not a cause
// found: the master used to read the journal, the server log, GitHub and the code for each one and
// file the fix by hand. Here the loop does it. Within the cycle a recurring-fault item is filed —
// and once an invariant violation has stood past `run.diagnostician.invariantBoundMinutes` — it
// launches one diagnostician: a headless Pi session (the registry's diagnostician role when an
// operator defines one) given the item, its instances, and excerpts of the loop journal, the server
// log and the named pull requests' GitHub state, with read access to the repository. It returns a
// structured diagnosis through `graphyard_diagnose`; a run that returns none runs once more on the
// stronger fallback model.
//
// The diagnosis is answered one of two ways, each through a two-party decision the loop requests as
// the master's operator-agent identity and an independent approver judges:
//  - an existing open item already covers the cause: the recurring item is closed as its duplicate;
//  - otherwise a fix item is filed (validated by the checks `master create` applies), released at
//    the diagnosed priority, and then the recurring item is closed as its duplicate.
// The closure names the answering item (answeringItem), so a recurrence before that item is
// delivered links to the recurring item, and one after it files afresh (standingFaultClassItem).
// An invariant violation has no item to close: it is linked to the covering or released fix item.
//
// A run refused by its provider's quota or rate limit (an HTTP 429, a "limit exhausted" notice)
// diagnosed nothing, but nothing about the loop failed either (GY-1092): when every run of a
// diagnosis ends that way it waits for the provider's reset, records no fault, and is run again
// then — and no other subject is launched into the same spent provider meanwhile. After the reset
// one subject probes the provider, and the others wait for its answer (diagnosticianGate), so the
// retries cost one run pair per reset, not one per waiting subject. Recorded as a failed loop
// action, one spent account filed a loop fault for every subject in flight.
// ---------------------------------------------------------------------------

export const diagnosticianRole = 'diagnostician';
/** An invariant violation (GY-404) is a fault whose kind is `invariant:NAME`. */
export const isInvariantKind = (kind: string) => kind.startsWith('invariant:');

/**
 * The item that answers a recurring-fault item: the fix or covering item it was closed as a
 * duplicate of. Null for an item still open or closed any other way.
 */
export const answeringItem = (work: Pick<Work, 'stage'> & { closure?: { kind: string; ref: string | null } | null }): string | null =>
  work.stage === 'done' && work.closure?.kind === 'duplicate' && work.closure.ref ? work.closure.ref : null;
/**
 * The item standing for `faultClass` (recurringClasses' `standing`): the open item naming it, else
 * a recurring item closed as answered by another whose answer is not yet delivered. A recurrence
 * before the fix is delivered is the cause the fix is already for, so it links to the recurring
 * item; once the fix is delivered nothing stands, and a recurrence past the threshold files afresh.
 * An answer the snapshot does not hold, or one closed undelivered, leaves the recurring item standing.
 */
export function standingFaultClassItem(work: readonly Work[], faultClass: FaultClass): Work | null {
  const open = openFaultClassItem(work, faultClass);
  if (open) return open;
  return [...work].reverse().find(item => {
    if (closesFaultClass(item) !== faultClass || !answeringItem(item)) return false;
    const answer = work.find(other => other.key === answeringItem(item));
    return !answer || !(answer.stage === 'done' && !isClosed(answer));
  }) ?? null;
}

/** One thing to diagnose: a recurring-fault item with its instances, or one standing invariant violation. */
export interface DiagnosisSubject { id: string; kind: 'recurring' | 'invariant'; faultClass: FaultClass; work: Work | null; instances: FaultInstance[] }
/** What the diagnostician reads beside the repository: the excerpts, bounded, and the named pull requests' state. */
export interface DiagnosisContext { journal: string[]; serverLog: string[]; pullRequests: { number: number; state: unknown }[] }
/** The runner one attempt uses, what it runs on, the registry account it launched on (GY-1705), and how its registry session (if any) is ended. */
export interface DiagnosticianRun { runner: Runner; runtime: string; model: string; account?: string | null; release?: (reason: string) => Promise<unknown> }
export interface DiagnosticianEffects {
  settings: DiagnosticianSettings;
  /** The repository checkout the diagnostician reads: the loop's own. */
  cwd: string;
  /**
   * The recorded merger, as the diagnostician's own control-plane calls read it (GY-1835). Under a
   * `control-plane` merger an item's head, merge and verdicts are the control plane's own records,
   * so the diagnostician is not sent to GitHub for them: its context makes no `gh pr view` run and
   * its prompt's read list names `graphyard status GY-N` instead. Absent, github reads stand.
   */
  merger?: () => Promise<MergerMode>;
  /**
   * The base branch's tree the fix item's plannedFiles resolve against before filing (GY-1707).
   * Absent, the loop reads `cwd` the way `master create` does (`baseTree`); an unreadable checkout
   * fails the same way. Fix-producing fixtures supply this effect rather than inventing a tree.
   */
  tree?: (baseBranch: string) => Promise<{ ref: string; files: Set<string> }>;
  /** The primary run's runner (the registry's role, else Pi on `model`), or the fallback's (Pi on `fallbackModel`). */
  runner: (attempt: 'primary' | 'fallback', subject: DiagnosisSubject) => Promise<DiagnosticianRun>;
  /** The loop journal and server log excerpts and the GitHub state of the named pull requests. */
  context: (subject: DiagnosisSubject, pullRequests: number[]) => Promise<DiagnosisContext>;
  /** Files the fix item unreleased, as the master's operator-agent identity on `master create`'s route. */
  file: (input: FixInput, key: string) => Promise<Work>;
  /** Requests a two-party decision as the master's operator-agent identity. */
  decide: (work: Work, action: 'release' | 'close', reason: string, input: Record<string, unknown>) => Promise<{ id: string }>;
}
export type FixInput = ReturnType<typeof createSchema.parse> & { reason: string };

/** One call as the master's operator-agent identity, as `daemonEffects` wires it. */
export type DiagnosticianPost = (method: 'GET' | 'POST', path: string, body?: unknown, key?: string) => Promise<unknown>;
/**
 * The diagnostician's effects under the live configuration (GY-439, GY-1705). Its first run takes
 * the registry's diagnostician role when an operator defines one, else Pi on `run.diagnostician.model`;
 * the fallback run is Pi on the stronger `fallbackModel`. The registry account is returned with the
 * runner so a limit hold charges the selection, never a nominal profile.
 */
export const diagnosticianEffects = (config: MasterConfig, root: string, post: DiagnosticianPost, run: (command: string, args: string[]) => string | Promise<unknown>): DiagnosticianEffects => {
  const settings = diagnosticianSettings(config.run);
  const lines = async (command: string[]) => String(await run(command[0], command.slice(1))).split('\n');
  // GY-1835: the merger as the operator-agent identity reads it. An unreadable setting (an older
  // server without the route, a refused call) keeps today's github reads rather than blinding a
  // diagnostician over a plane hiccup.
  const merger = async (): Promise<MergerMode> => {
    try { const status = await post('GET', 'merger') as { merger?: unknown } | undefined; return status?.merger === 'control-plane' ? 'control-plane' : 'github'; }
    catch { return 'github'; }
  };
  return {
    settings, cwd: root, merger,
    runner: async (attempt, subject) => {
      if (attempt === 'primary') {
        const fleet = await selectDiagnosticianFleet(config, subject.work?.key);
        if (fleet) {
          const launch = registryHeadlessLaunch(fleet.account);
          await recordEnvironmentLog(config, fleet.health ? [fleet.health] : [], fleet.skipped, { key: selectionKey('diagnostician', diagnosticianRole), environment: fleet.account.name, kind: fleet.account.kind, at: new Date().toISOString(), work: subject.work?.key ?? null }).catch(() => {});
          return { runner: registryRunner(fleet.account), runtime: launch.command, model: launch.model, account: fleet.account.name, release: fleet.release };
        }
      }
      const model = attempt === 'primary' ? settings.model : settings.fallbackModel;
      return { runner: piRunner({ command: settings.command, model }), runtime: 'pi', model, account: null };
    },
    context: async (_subject, numbers) => ({
      journal: await lines(settings.journalCommand).catch(error => [`(the loop journal could not be read with ${settings.journalCommand.join(' ')}: ${message(error)})`]),
      serverLog: settings.serverLogCommand ? await lines(settings.serverLogCommand).catch(error => [`(the server log could not be read with ${settings.serverLogCommand!.join(' ')}: ${message(error)})`])
        : ['(no run.diagnostician.serverLogCommand is configured, so no server log excerpt was read)'],
      // GY-1835: under a control-plane merger a named pull request is the control plane's own
      // record, so no `gh pr view` runs for it — the prompt points the session at `graphyard status
      // GY-N` instead. With GitHub the recorded merger, every named pull request is read as before.
      pullRequests: await merger().then(mode => mode === 'control-plane' ? [] : Promise.all(numbers.map(async number => ({ number, state: await Promise.resolve(run('gh', ['pr', 'view', String(number), '--repo', config.repository, '--json', 'number,title,state,isDraft,mergeable,mergeStateStatus,headRefOid,baseRefName,reviewDecision,statusCheckRollup']))
        .then(output => JSON.parse(String(output)), (error: unknown) => ({ error: message(error) })) })))),
    }),
    file: (input, key) => post('POST', 'work', input, key) as Promise<Work>,
    decide: (work, action, reason, input) => post('POST', `work/${work.id}/decide`, { action, input: decisionInput(action, work, input), reason }) as Promise<{ id: string }>,
  };
};

/** `limit`: every run ended on its provider's quota or rate limit — the earliest known reset among them. `account`: the registry account the round spent (GY-1705). */
interface Outcome { runs: DiagnosisRecord['runs']; diagnosis: DiagnosisPayload | null; limit?: ExhaustionSignal | null; account?: string | null; holds?: { account: string; limit: ExhaustionSignal }[] }
/** How long a diagnosis refused by a provider naming no readable reset waits before it is run again. */
export const diagnosisLimitHoldMs = 60 * 60_000;
/** The least a provider-limited diagnosis waits, whatever reset the provider named: never a retry every cycle. */
export const diagnosisLimitMinimumMs = 5 * 60_000;
/**
 * Until when the diagnostician's provider is known spent: the latest retry time any waiting
 * diagnosis holds, while it is still ahead — the latest, so an older refusal naming a later reset
 * is never lifted early by a newer one naming a sooner. Null when nothing is waiting on a limit.
 */
export function diagnosticianHeldUntil(state: Pick<DaemonState, 'diagnoses'>, clock: number): string | null {
  const latest = Object.values(state.diagnoses).filter(entry => entry.state === 'waiting' && entry.retryAt).map(entry => entry.retryAt!).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return latest && Date.parse(latest) > clock ? latest : null;
}
/**
 * What the diagnostician may launch this cycle (GY-1092): `open` — anything, nothing waits on a
 * limit or a run launched since the last refusal came back answered by the provider; `held` — no
 * launch, the provider's reset is still ahead or the one probe since it is still running; `probe` —
 * one subject only, the first run after the reset. One probe per reset, never every waiting subject
 * at once: if the provider still refuses, the probe waits again and the rest wait with it, so a
 * spent account costs one primary and one fallback run per hold window however many subjects wait.
 */
export function diagnosticianGate(state: Pick<DaemonState, 'diagnoses'>, clock: number): 'open' | 'probe' | 'held' {
  const entries = Object.values(state.diagnoses), waiting = entries.filter(entry => entry.state === 'waiting');
  if (!waiting.length) return 'open';
  if (diagnosticianHeldUntil(state, clock)) return 'held';
  const refused = Math.max(...waiting.map(entry => Date.parse(entry.refusedAt ?? entry.updatedAt)));
  const since = entries.filter(entry => entry.state !== 'waiting' && Date.parse(entry.startedAt) > refused);
  if (since.some(entry => entry.state !== 'running')) return 'open';
  return since.length ? 'held' : 'probe';
}
/**
 * The one subject a probe runs: the waiting subject refused longest ago, so the retry order is
 * fair and deterministic, else the first subject listed when none of them is waiting (GY-1245).
 */
export function probeSubject<T extends { id: string }>(state: Pick<DaemonState, 'diagnoses'>, subjects: readonly T[]): T[] {
  const refusedAt = (subject: T) => { const entry = state.diagnoses[subject.id]; return entry?.state === 'waiting' ? Date.parse(entry.refusedAt ?? entry.updatedAt) : Infinity; };
  const oldest = [...subjects].sort((a, b) => refusedAt(a) - refusedAt(b))[0];
  return oldest ? [oldest] : [];
}
/** A waiting diagnosis whose retry time has come. */
const retryDue = (entry: DiagnosisRecord | undefined, clock: number) => entry?.state === 'waiting' && (!entry.retryAt || Date.parse(entry.retryAt) <= clock);
const live = new Map<string, Promise<void>>();
const outcomes = new Map<string, Outcome>();
/** GY-1713: mismatched standing-close 409s, held until the ledger changes (no re-POST every cycle). */
const standingHolds = new Map<string, { id: string; work: string }>();
/** Every diagnostician run this process has in flight, settled: a test's way to wait for them. */
export async function diagnosesSettled() { await Promise.all([...live.values()]); }
/** Test seam: forget every run, outcome and mismatched-standing hold. */
export function clearDiagnoses() { live.clear(); outcomes.clear(); standingHolds.clear(); }

/**
 * What needs a diagnosis now: every open recurring-fault item not yet diagnosed, and every
 * invariant violation standing past the bound, unlinked and not yet diagnosed.
 */
export function diagnosisSubjects(state: Pick<DaemonState, 'faults' | 'diagnoses'>, work: readonly Work[], clock: number, settings: Pick<DiagnosticianSettings, 'invariantBoundMinutes'>): DiagnosisSubject[] {
  const subjects: DiagnosisSubject[] = [];
  for (const item of work) {
    const faultClass = closesFaultClass(item);
    if (!faultClass || item.stage === 'done' || isClosed(item) || (state.diagnoses[item.key] && !retryDue(state.diagnoses[item.key], clock))) continue;
    const listed = new Set(item.origin?.faultClass?.instances.map(entry => entry.id) ?? []);
    const recorded = state.faults.instances.filter(entry => entry.linkedTo === item.key || listed.has(entry.id));
    const known = new Set(recorded.map(entry => entry.id));
    // An instance the cursor no longer retains is still evidence: the item's origin lists it.
    const origin = (item.origin?.faultClass?.instances ?? []).filter(entry => !known.has(entry.id))
      .map(entry => ({ ...entry, faultClass, text: '(no longer retained by the loop; the item description quotes it)', lastSeenAt: entry.at, linkedTo: item.key }));
    subjects.push({ id: item.key, kind: 'recurring', faultClass, work: item, instances: [...origin, ...recorded].slice(-100) });
  }
  const bound = settings.invariantBoundMinutes * 60_000, standing = new Set(Object.values(state.faults.open));
  for (const instance of state.faults.instances) {
    if (!isInvariantKind(instance.kind) || !standing.has(instance.id) || instance.linkedTo || (state.diagnoses[instance.id] && !retryDue(state.diagnoses[instance.id], clock))) continue;
    if (Date.parse(instance.at) + bound > clock) continue;
    subjects.push({ id: instance.id, kind: 'invariant', faultClass: instance.faultClass, work: null, instances: [instance] });
  }
  return subjects;
}

// What the diagnostician session is given and launched with — the pull requests its subject names
// (namedPullRequests), the bounded evidence input (diagnosisInput) and the prompt it is launched
// with, GY-1835's merger-aware read list included — lives in ./diagnosis-fix.ts beside the
// evidence-shaping it shares with the diagnosis outcome, and is re-exported above, so every
// existing import keeps working.

/** Run the primary attempt, and the fallback once when the primary returns no valid diagnosis. */
async function runDiagnosis(diagnostician: DiagnosticianEffects, subject: DiagnosisSubject, prompt: string): Promise<Outcome> {
  const runs: DiagnosisRecord['runs'] = [], limits: (ExhaustionSignal | null)[] = [], timed: { result: string; detail: string; events: LimitRunEvent[]; account: string | null }[] = [];
  let limitedAccount: string | null = null;
  const timeoutMs = diagnostician.settings.timeoutMinutes * 60_000, now = () => Date.now();
  for (const attempt of ['primary', 'fallback'] as const) {
    const startedAt = new Date().toISOString();
    let chosen: DiagnosticianRun;
    try { chosen = await diagnostician.runner(attempt, subject); }
    catch (error) { runs.push({ runtime: 'none', model: attempt, startedAt, endedAt: new Date().toISOString(), result: 'spawn', detail: clip(`No ${attempt} runner: ${message(error)}`, 500) }); limits.push(null); continue; }
    const attemptAccount = chosen.account ?? null;
    const run = chosen.runner.start(prompt, { cwd: diagnostician.cwd, env: { GRAPHYARD_PI_ROLE: diagnosticianRole }, tool: graphyardTools.diagnose, timeoutMs,
      validate: payload => {
        const parsed = diagnosisPayloadSchema.parse(payload);
        if (parsed.subject !== subject.id) throw new Error(`the diagnosis names ${parsed.subject}, not ${subject.id}`);
        return parsed;
      } });
    const result = await run.result();
    await Promise.resolve(chosen.release?.(`the ${attempt} diagnosis of ${subject.id} ended`)).catch(() => {});
    const detail = clip(result.ok ? `Diagnosed as ${result.payload.faultClass}: ${result.payload.cause}` : result.failure.detail, 500);
    const outcome = result.ok ? 'diagnosed' : result.failure.reason;
    runs.push({ runtime: chosen.runtime, model: chosen.model, startedAt, endedAt: new Date().toISOString(), result: outcome, detail });
    if (result.ok) return { runs, diagnosis: result.payload, account: attemptAccount };
    // Only the provider's own error is read — the last error a run that made no call ended on, or
    // (GY-1705) the retry/stream errors of a run stopped at its terminal-event bound. An invalid
    // payload's detail is the agent's submission, and an exit's carries stderr, which can mix in
    // the agent's output: a limit phrase there must not turn a real failure into a wait.
    timed.push({ result: outcome, detail, events: [...run.events], account: attemptAccount });
    if (result.failure.reason === 'timeout') limits.push(null); // resolved from `timed` below
    else {
      const providerError = result.failure.reason === 'no-payload' ? /\(last error: ([\s\S]*)\)$/.exec(result.failure.detail)?.[1] : undefined;
      const signal = providerError ? providerLimit(providerError, now()) : null;
      limits.push(signal);
      if (signal && attemptAccount) limitedAccount = attemptAccount;
    }
    if (result.failure.reason === 'cancelled') break;
  }
  const fromTimeout = headlessTimeoutLimitCharge(timed, now());
  const limited = fromTimeout ? null : (limits.length > 0 && limits.every(Boolean) ? limits as ExhaustionSignal[] : null);
  const signal = fromTimeout?.limit ?? (limited ? { reason: limited.at(-1)!.reason, resetsAt: limited.map(entry => entry.resetsAt).filter((at): at is string => !!at).sort()[0] ?? null } : null);
  const holds = fromTimeout?.holds ?? (limited && limitedAccount ? [{ account: limitedAccount, limit: signal! }] : []);
  return { runs, diagnosis: null, limit: signal, account: fromTimeout?.account ?? (limited ? limitedAccount : null), holds };
}


/**
 * Step 7c: launch a diagnosis for every subject that needs one, fold the runs that ended, and move
 * every diagnosis on by one decision: request it, launch its approver, or act on its outcome.
 */
export async function diagnosisStep(cycle: Cycle) {
  const { state, effects, now, snapshot, clock, performed } = cycle;
  const diagnostician = effects.diagnostician;
  if (!diagnostician || !diagnostician.settings.enabled) return;
  const note = async (entry: DiagnosisRecord, outcome: DaemonAction['state'], detail: string, faultKind?: FaultKind | null) => {
    entry.detail = clip(detail, 1000); entry.updatedAt = iso(now());
    performed.push(await record(state, diagnosisKey(entry.subject), { kind: 'diagnosis', work: entry.work ?? entry.fix, principal: null, state: outcome, detail,
      attempts: (state.actions[diagnosisKey(entry.subject)]?.attempts ?? 0) + (outcome === 'failed' ? 1 : 0), cycle: state.cycle }, now(), effects.persist, faultKind));
  };
  const subjects = diagnosisSubjects(state, snapshot.work, clock, diagnostician.settings);
  // A waiting diagnosis whose subject no longer needs one — the item closed, the violation linked — is dropped.
  const listed = new Set(subjects.map(subject => subject.id));
  for (const [key, entry] of Object.entries(state.diagnoses)) if (retryDue(entry, clock) && !listed.has(key)) delete state.diagnoses[key];
  // While the provider is spent, launching another subject only spends a run on the same refusal;
  // after its reset one subject probes it, and the rest follow once the provider has answered.
  // A refusal that came back since the last cycle is folded first, so it holds this cycle's launches.
  for (const entry of Object.values(state.diagnoses)) {
    const outcome = entry.state === 'running' ? outcomes.get(entry.subject) : undefined;
    if (outcome && !outcome.diagnosis && outcome.limit) await cycle.isolate('diagnosis', snapshot.work.find(candidate => candidate.key === entry.work) ?? null, `the diagnosis of ${entry.subject}`, () => ridePlane(entry, note, () => advance(cycle, diagnostician, entry, note)));
  }
  const gate = diagnosticianGate(state, clock);
  for (const subject of gate === 'held' ? [] : gate === 'probe' ? probeSubject(state, subjects) : subjects) {
    await cycle.isolate('diagnosis', subject.work, `the diagnosis of ${subject.id}`, () => launch(cycle, diagnostician, subject, note));
  }
  for (const entry of Object.values(state.diagnoses)) {
    if (diagnosisSettled(entry)) continue;
    const item = entry.work ? snapshot.work.find(candidate => candidate.key === entry.work) ?? null : null;
    await cycle.isolate('diagnosis', item, `the diagnosis of ${entry.subject}`, () => ridePlane(entry, note, () => advance(cycle, diagnostician, entry, note)));
  }
}

/**
 * GY-1345: a control-plane call the diagnosis makes — the fix item's filing, the decide request,
 * the decision history, the fresh snapshot — that fails plane-wide (planeWideRefusal: a 502
 * "Application failed to respond", a refused connection, a call that ran into its timeout) is the
 * plane's window, not the loop failing to diagnose. On 2026-10-06 one such window threw GY-1339's
 * release decide out to cycle.isolate, which recorded it as an action:diagnosis loop fault. It is
 * recorded failed with no fault kind, the entry keeps its state, and the next cycle moves it on from there:
 * the fix files under the same idempotency key, and the decision is requested afresh.
 */
async function ridePlane(entry: DiagnosisRecord, note: Note, body: () => Promise<unknown>) {
  try { await body(); }
  catch (error) {
    if (!planeWideRefusal(error)) throw error;
    await note(entry, 'failed', `The control plane failed plane-wide while the diagnosis of ${entry.subject} was moved on (${message(error)}); it stays ${entry.state} and the next cycle moves it on from there`, null);
  }
}

type Note = (entry: DiagnosisRecord, outcome: DaemonAction['state'], detail: string, faultKind?: FaultKind | null) => Promise<void>;

async function launch(cycle: Cycle, diagnostician: DiagnosticianEffects, subject: DiagnosisSubject, note: Note) {
  const { config, state, snapshot, clock } = cycle;
  standingHolds.delete(subject.id);
  const entry: DiagnosisRecord = { subject: subject.id, kind: subject.kind, faultClass: subject.faultClass, work: subject.work?.key ?? null, state: 'running',
    startedAt: iso(clock), updatedAt: iso(clock), runs: [], diagnosis: null, fix: null, decision: null, answeredBy: null, retryAt: null, refusedAt: null, detail: '' };
  state.diagnoses[subject.id] = entry;
  const context = await diagnostician.context(subject, namedPullRequests(subject, snapshot.work))
    .catch(error => ({ journal: [`(the excerpts could not be read: ${message(error)})`], serverLog: [], pullRequests: [] }));
  // GY-1835: the prompt's read list follows the recorded merger, read where the context reads it.
  const merger = await diagnostician.merger?.().catch(() => undefined);
  const prompt = diagnosisPrompt({ ...config, ...(merger ? { merger } : {}) }, diagnosisInput(subject, context, snapshot.work));
  const running = runDiagnosis(diagnostician, subject, prompt).catch(error => ({ runs: [{ runtime: 'none', model: 'none', startedAt: iso(clock), endedAt: new Date().toISOString(), result: 'exit', detail: clip(message(error), 500) }], diagnosis: null }))
    .then(outcome => { outcomes.set(subject.id, outcome); }).finally(() => live.delete(subject.id));
  live.set(subject.id, running);
  await note(entry, 'done', `Launched the diagnostician for ${subject.kind === 'recurring' ? `recurring-fault item ${subject.id}` : `invariant violation ${subject.id}`} (${subject.instances.length} instance(s)) on ${diagnostician.settings.model}, falling back to ${diagnostician.settings.fallbackModel}`);
}

async function advance(cycle: Cycle, diagnostician: DiagnosticianEffects, entry: DiagnosisRecord, note: Note) {
  const { state, effects, snapshot, clock, now } = cycle;
  if (entry.state === 'running') {
    const outcome = outcomes.get(entry.subject);
    if (!outcome) {
      // A run this process is not running whose bound has passed was lost with a restart.
      const bound = Date.parse(entry.startedAt) + 2 * diagnostician.settings.timeoutMinutes * 60_000 + diagnosisLostGraceMs;
      // GY-1318: the restart that lost it is the loop's own, and the handoff is the designed outcome:
      // still failed, but no fault kind, so no loop fault instance (as GY-1092 and GY-1266 did).
      if (!live.has(entry.subject) && clock > bound) { entry.state = 'failed'; await note(entry, 'failed', `The diagnosis of ${entry.subject} started ${entry.startedAt} never ended in this process; the master diagnoses it by hand`, null); }
      return;
    }
    outcomes.delete(entry.subject);
    entry.runs = outcome.runs.slice(-4);
    if (!outcome.diagnosis && outcome.limit) {
      const named = outcome.limit.resetsAt ? Date.parse(outcome.limit.resetsAt) : Number.NaN;
      // Settlement time, not the launch-cycle snapshot: two real timeouts can finish long after
      // `clock` was snapped, and the assumed-hour hold must start when the limit is known (GY-1705).
      const settledAt = now();
      entry.state = 'waiting';
      entry.retryAt = iso(Number.isFinite(named) && named > settledAt ? Math.max(named, settledAt + diagnosisLimitMinimumMs) : settledAt + diagnosisLimitHoldMs);
      entry.refusedAt = iso(settledAt);
      // Hold every named account whose own attempt reported the limit (GY-1705), never a nominal profile.
      for (const hold of outcome.holds ?? []) await effects.holdAccount?.(hold.account, { at: iso(settledAt), resetsAt: hold.limit.resetsAt, reason: hold.limit.reason, role: 'diagnostician', profile: diagnosticianRole, work: entry.work });
      // The provider's capacity, not the loop's failure: no fault kind, so no loop fault instance.
      await note(entry, 'waiting', `The diagnostician's provider refused the diagnosis of ${entry.subject} for its quota or rate limit (${outcome.limit.reason}); it is diagnosed again at ${entry.retryAt}, and no other diagnosis is launched before then`, null);
      return;
    }
    if (!outcome.diagnosis) { entry.state = 'failed'; await note(entry, 'failed', `The diagnostician returned no diagnosis of ${entry.subject}: ${outcome.runs.map(run => `${run.model} ${run.result}: ${run.detail}`).join('; ')}`, noDiagnosisKind(outcome.runs)); return; }
    entry.diagnosis = outcome.diagnosis; entry.state = 'diagnosed';
    await note(entry, 'done', `Diagnosed ${entry.subject} as ${outcome.diagnosis.faultClass}: ${outcome.diagnosis.cause}`);
  }
  const subjectItem = entry.work ? snapshot.work.find(item => item.key === entry.work) ?? null : null;
  if (entry.state === 'diagnosed') {
    const diagnosis = entry.diagnosis!;
    // GY-1266: a recurring item closed while it was diagnosed — delivered, or closed by the master —
    // needs nothing from its diagnosis. That is the subject moving on, not the loop failing: recorded
    // as a failed action it opened a loop fault for every such closure.
    if (entry.kind === 'recurring' && (!subjectItem || subjectItem.stage === 'done')) {
      entry.state = 'answered'; entry.answeredBy = subjectItem ? answeringItem(subjectItem) : null;
      await note(entry, 'done', `${entry.work} is no longer open, so its diagnosis is not acted on${entry.answeredBy ? `; it was closed as answered by ${entry.answeredBy}` : ''}`, null);
      return;
    }
    // GY-1374: a recurring item parked on an unanswered human-only decision waits on that person, and
    // a fix filed for it is the act they were asked for: released, it dispatches to worker executors
    // an item no worker may perform. GY-1367 (the revert approver App GY-1365 was parked on) was
    // refused for exactly that. The parked decision answers the diagnosis; nothing is filed or asked.
    const parked = entry.kind === 'recurring' && subjectItem?.humanRequest && !subjectItem.humanRequest.answer ? subjectItem.humanRequest : null;
    if (parked) {
      entry.state = 'answered'; entry.answeredBy = subjectItem!.key;
      await note(entry, 'done', `${entry.work} is parked on a human-only decision (${parked.kind}: ${clip(parked.needed, 300)}), so its diagnosis is left to that person and no fix is filed or released to worker executors. Diagnosis: ${clip(diagnosis.cause, 600)}`, null);
      return;
    }
    if (diagnosis.covering) {
      const covering = snapshot.work.find(item => item.key === diagnosis.covering);
      if (!covering || covering.stage === 'done' || covering.key === entry.work) { entry.state = 'failed'; await note(entry, 'failed', `The diagnosis names ${diagnosis.covering} as covering ${entry.subject}, but it is not another open item`); return; }
      if (entry.kind === 'invariant') return answer(state, entry, covering.key, note);
      return request(cycle, diagnostician, entry, subjectItem!, 'close', { kind: 'duplicate', ref: covering.key },
        `${entry.work} recurs from a cause ${covering.key} already covers, so it is closed as its duplicate. Diagnosis: ${diagnosis.cause}`, note);
    }
    let input: FixInput;
    try {
      const tree = await filingTree(diagnostician, cycle.config.baseBranch);
      input = fixItem(entry, diagnosis, tree);
    }
    catch (error) { entry.state = 'failed'; await note(entry, 'failed', `The diagnostician's fix item for ${entry.subject} fails the checks master create applies: ${message(error)}`, 'fix-item'); return; }
    let fix: Work;
    try { fix = await diagnostician.file(input, `${diagnosisKey(entry.subject)}:fix`); }
    catch (error) {
      // GY-1530 / GY-1713: the create route's own refusal (a 409: an e2e proof naming a scenario nothing
      // registered; or a 400 zod "Invalid input" under schema skew) is the same malformed fix as one
      // the local checks refuse, and settles the entry the same way, under the proof class's fix-item;
      // thrown on, it reached cycle.isolate as an unclassified action:diagnosis. A plane-wide failure
      // still throws to ridePlane, and the next cycle files again.
      if (!createRefused(error)) throw error;
      entry.state = 'failed';
      await note(entry, 'failed', `The control plane refused the diagnostician's fix item for ${entry.subject} as written, so it is not filed again; the diagnosis stands for the master to file by hand: ${message(error)}`, 'fix-item');
      return;
    }
    entry.fix = fix.key;
    await note(entry, 'done', `Filed ${fix.key} (priority ${fix.priority}) for the root cause of ${entry.subject}: ${diagnosis.cause}`);
    return request(cycle, diagnostician, entry, fix, 'release', {}, `Release ${fix.key}, the root-cause fix the diagnostician found for ${entry.subject}, at priority ${fix.priority}. Cause: ${diagnosis.cause}`, note);
  }
  if (entry.state !== 'releasing' && entry.state !== 'closing') return;
  const decision = entry.decision!, target = snapshot.work.find(item => item.key === decision.work);
  if (!target || !effects.decisions) return;
  const current = (await effects.decisions(target)).decisions.find(candidate => candidate.id === decision.id);
  if (!current) return;
  if (current.state === 'requested' && !decision.approver) return launchApprover(cycle, entry, target, note);
  if (current.state === 'refused' || current.state === 'failed') {
    // GY-1344: the recurring item was delivered meanwhile, and the approver refused the release as
    // duplicating that delivery (GY-1337's PR #815): its own delivery answered it, as GY-1266 does.
    if (entry.kind === 'recurring' && (!subjectItem || subjectItem.stage === 'done')) {
      entry.state = 'answered'; entry.answeredBy = subjectItem ? answeringItem(subjectItem) : null;
      return note(entry, 'done', `The ${decision.action} decision ${decision.id} on ${decision.work} was ${current.state} (${current.refusal?.reason ?? current.outcome ?? 'no reason recorded'}), but ${entry.work} is no longer open, so its diagnosis is not acted on`, null);
    }
    entry.state = current.state === 'refused' ? 'refused' : 'failed';
    // GY-1345: an approver's refusal is a considered judgement the decision class already counts
    // (decision-refused), so it settles the entry with no fault kind: one refusal, one instance.
    return note(entry, 'failed', `The ${decision.action} decision ${decision.id} on ${decision.work} was ${current.state}: ${current.refusal?.reason ?? current.outcome ?? 'no reason recorded'}; the diagnosis stands for the master to act on`,
      current.state === 'refused' ? null : undefined);
  }
  if (current.state === 'stale' || current.state === 'withdrawn') {
    // GY-1371: a target already done — the fix delivered, the item to close closed — has nothing left
    // to ask for: asked again, the server refuses it as immutable, every cycle, for ever.
    if (target.stage === 'done') return settleNoLongerOpen(state, entry, target, `The ${decision.action} decision ${decision.id} on ${decision.work} was settled ${current.state}, but ${decision.work} is no longer open`, note);
    return rerequest(cycle, diagnostician, entry, target, current, note);
  }
  if (current.state !== 'applied') return;
  if (entry.state === 'releasing') {
    await note(entry, 'done', `${decision.work} was released on the approved decision ${decision.id} (approved by ${current.approvedBy})`);
    if (entry.kind === 'invariant') return answer(state, entry, decision.work, note);
    // GY-1336: the recurring item was delivered or closed meanwhile — there is nothing left to close.
    if (!subjectItem || subjectItem.stage === 'done') return answer(state, entry, decision.work, note, `${entry.work} is no longer open, so it is not closed; its fix ${decision.work} was released on decision ${decision.id}`);
    return request(cycle, diagnostician, entry, subjectItem!, 'close', { kind: 'duplicate', ref: decision.work },
      `${entry.work} is answered by ${decision.work}, the root-cause fix released on decision ${decision.id}, so it is closed as its duplicate; a recurrence after ${decision.work} is delivered files afresh`, note);
  }
  return answer(state, entry, entry.fix ?? entry.diagnosis!.covering!, note, `${entry.work} was closed on the approved decision ${decision.id} (approved by ${current.approvedBy})`);
}

/** Request the decision as the master's operator-agent identity, then launch its independent approver. */
async function request(cycle: Cycle, diagnostician: DiagnosticianEffects, entry: DiagnosisRecord, work: Work, action: 'release' | 'close', input: Record<string, unknown>, reason: string, note: Note) {
  const requested = await decideFresh(cycle, diagnostician, entry, work, action, input, clip(reason, 2000), note);
  if (!requested) return;
  const { decision, target, adopted } = requested;
  entry.decision = { id: decision.id, action, work: target.key, approver: null };
  entry.state = action === 'release' ? 'releasing' : 'closing';
  await note(entry, 'done', adopted
    ? `Adopted ${action} decision ${decision.id}, already standing on ${target.key}, for the diagnosis of ${entry.subject}`
    : `Requested ${action} decision ${decision.id} on ${target.key} for the diagnosis of ${entry.subject}`);
  return launchApprover(cycle, entry, target, note, adopted);
}
const revisionRaced = (error: unknown) => /Task revision changed/.test(message(error));
/** GY-1336: the item was delivered after the cycle's snapshot, so the server refuses any decision on it. */
const deliveredMeanwhile = (error: unknown) => /Delivered work is immutable/.test(message(error));
/** GY-1713: standing-close 409 id via standingNamedIn + adoptedOnRefusal (GY-1374 / GY-1710). */
const standingAdopted = (error: unknown, action: 'release' | 'close') =>
  action !== 'release' && adoptedOnRefusal.includes(action) ? standingNamedIn(error, action) : null;
/** Same close kind+ref (ignore expectedRevision); else a concurrent close would corrupt the answer. */
const closeInputMatches = (standing: unknown, requested: Record<string, unknown>) => {
  const held = standing && typeof standing === 'object' ? standing as Record<string, unknown> : null;
  return !!held && held.kind === requested.kind && (held.ref ?? null) === (requested.ref ?? null);
};
type StandingCloseRead = { status: 'unread' } | { status: 'absent' } | { status: 'row'; entry: { id: string; action: string; state: string; input: unknown } };
/** Ledger read of a named close: unread (missing/rejected effect) vs absent vs row — never clear a hold on unread. */
async function standingCloseOn(cycle: Cycle, work: Work, held: string): Promise<StandingCloseRead> {
  if (!cycle.effects.decisions) return { status: 'unread' };
  try {
    const entry = (await cycle.effects.decisions(work)).decisions.find(candidate => candidate.id === held);
    return entry ? { status: 'row', entry } : { status: 'absent' };
  } catch { return { status: 'unread' }; }
}
/** Adopt only when ledger kind/ref match; mismatch → hold; unread → wait (no throw). */
async function adoptStandingClose(cycle: Cycle, work: Work, input: Record<string, unknown>, held: string): Promise<'adopt' | 'hold' | 'unread'> {
  const read = await standingCloseOn(cycle, work, held);
  if (read.status !== 'row' || read.entry.action !== 'close' || read.entry.state !== 'requested') return 'unread';
  return closeInputMatches(read.entry.input, input) ? 'adopt' : 'hold';
}
/**
 * GY-1318/GY-1336: revision race or delivered-meanwhile → reload once (bounded like rerequest) or settle
 * with no fault. GY-1713: matching standing-close 409 is adopted; mismatched is held until the ledger
 * changes (no re-POST); unread while held keeps the hold.
 */
async function decideFresh(cycle: Cycle, diagnostician: DiagnosticianEffects, entry: DiagnosisRecord, work: Work, action: 'release' | 'close', input: Record<string, unknown>, reason: string, note: Note): Promise<{ decision: { id: string }; target: Work; adopted?: boolean } | null> {
  const adoptHeld = async (held: string, target: Work) => {
    if (action === 'close') {
      const verdict = await adoptStandingClose(cycle, target, input, held);
      if (verdict === 'hold') {
        standingHolds.set(entry.subject, { id: held, work: target.key });
        await note(entry, 'done', `Close decision ${held} already stands on ${target.key}, but its closure does not match the diagnosis of ${entry.subject} (asked ${input.kind}${input.ref ? ` of ${input.ref}` : ''}); holding ${held} until its ledger state changes rather than adopting or re-asking`, null);
        return null;
      }
      if (verdict === 'unread') {
        await note(entry, 'done', `Close decision ${held} already stands on ${target.key}, but its ledger input could not be read for the diagnosis of ${entry.subject}; waiting rather than adopting or rethrowing`, null);
        return null;
      }
    }
    standingHolds.delete(entry.subject);
    return { decision: { id: held }, target, adopted: true as const };
  };
  const prior = action === 'close' ? standingHolds.get(entry.subject) : undefined;
  if (prior) {
    const read = await standingCloseOn(cycle, work, prior.id);
    if (read.status === 'unread') return null;
    if (read.status === 'row' && read.entry.state === 'requested' && read.entry.action === 'close') {
      if (closeInputMatches(read.entry.input, input)) {
        standingHolds.delete(entry.subject);
        return { decision: { id: prior.id }, target: work, adopted: true as const };
      }
      return null;
    }
    standingHolds.delete(entry.subject);
    await note(entry, 'done', `Standing close ${prior.id} on ${prior.work} no longer blocks the diagnosis of ${entry.subject} (${read.status === 'row' ? `now ${read.entry.state}` : 'gone from the ledger'}); requesting the diagnosis closure afresh`, null);
  }
  try { return { decision: await diagnostician.decide(work, action, reason, input), target: work }; }
  catch (error) {
    const held = standingAdopted(error, action);
    if (held) return adoptHeld(held, work);
    if (!revisionRaced(error) && !deliveredMeanwhile(error)) throw error;
    const why = `The ${action} request on ${work.key} for the diagnosis of ${entry.subject} was refused: ${message(error)}`;
    const fresh = (await cycle.effects.snapshot()).work.find(candidate => candidate.id === work.id);
    const applicable = !!fresh && !isClosed(fresh) && fresh.stage !== 'done' && (action === 'close' || (fresh.stage === 'backlog' && !fresh.ready));
    if (!applicable) {
      // GY-1371: releasing/closing settles here; else next cycle re-asks forever.
      standingHolds.delete(entry.subject);
      if (entry.state === 'releasing' || entry.state === 'closing') { await settleNoLongerOpen(cycle.state, entry, fresh ?? null, `${why}; ${work.key} no longer needs the ${action}`, note, action); return null; }
      await note(entry, 'done', `${why}; ${work.key} no longer needs the ${action}, so it is not asked again and the next cycle decides afresh`, null); return null;
    }
    const history = cycle.effects.decisions ? (await cycle.effects.decisions(fresh)).decisions : [];
    const spent = history.filter(candidate => candidate.action === action && (candidate.state === 'stale' || candidate.state === 'withdrawn')).length;
    if (spent >= maxDecisionRequests) { await note(entry, 'done', `${why}; ${spent} ${action} request(s) already settled without applying, so it is not asked again here and the next cycle decides afresh`, null); return null; }
    try { return { decision: await diagnostician.decide(fresh, action, reason, input), target: fresh }; }
    catch (again) {
      const adopted = standingAdopted(again, action);
      if (adopted) return adoptHeld(adopted, fresh);
      if (!revisionRaced(again) && !deliveredMeanwhile(again)) throw again;
      await note(entry, 'done', `${why}; asked again against revision ${fresh.revision} and refused again (${message(again)}), so the next cycle decides afresh`, null);
      return null;
    }
  }
}
/**
 * GY-1296: the server settled the entry's decision without applying it — 'stale' when the item's
 * revision moved before the approval (the loop's own writes to the item it asked about move it),
 * 'withdrawn' when it was taken back. Its outcome says to reload and request again, so the same
 * decision is requested against the item's current revision. The requests are bounded like the
 * decisions step's (maxDecisionRequests, counted from the item's own decision history, so the bound
 * survives a restart); once spent the diagnosis fails and an escalation names the manual route.
 */
async function rerequest(cycle: Cycle, diagnostician: DiagnosticianEffects, entry: DiagnosisRecord, target: Work, current: { id: string; state: string; outcome?: string | null }, note: Note) {
  const { state, effects, now } = cycle, decision = entry.decision!;
  const history = (await effects.decisions!(target)).decisions;
  const spent = history.filter(candidate => candidate.action === decision.action && (candidate.state === 'stale' || candidate.state === 'withdrawn')).length;
  const why = `The ${decision.action} decision ${decision.id} on ${decision.work} was settled ${current.state}: ${current.outcome ?? 'no reason recorded'}`;
  if (spent >= maxDecisionRequests) {
    entry.state = 'failed';
    await note(entry, 'failed', `${why}; ${spent} ${decision.action} request(s) for the diagnosis of ${entry.subject} settled without applying, so it is not requested again`, 'decision-stale');
    const detail = `${decision.work} still needs the ${decision.action} the diagnosis of ${entry.subject} asked for, but ${spent} requests settled stale or withdrawn (last ${decision.id}). `
      + `${decision.action === 'release' ? 'Release it by hand' : 'Close it by hand'}: graphyard master decide ${decision.work} ${decision.action}${decision.action === 'close' ? ` '{"kind":"duplicate","ref":"${entry.fix ?? entry.diagnosis?.covering}"}'` : ''} REASON, then graphyard master approver ${decision.work} DECISION`;
    cycle.performed.push(await record(state, `escalation:diagnosis-stale:${decision.id}`, { kind: 'escalation', work: decision.work, principal: null, state: 'done', detail, attempts: 1, cycle: state.cycle }, now(), effects.persist));
    return;
  }
  const input = decision.action === 'close' ? { kind: 'duplicate', ref: entry.fix ?? entry.diagnosis!.covering! } : {};
  const reason = decision.action === 'release'
    ? `Release ${target.key}, the root-cause fix the diagnostician found for ${entry.subject}, at priority ${target.priority}; requested again against revision ${target.revision} because decision ${decision.id} was settled ${current.state}. Cause: ${entry.diagnosis?.cause ?? ''}`
    : `${entry.work} is answered by ${input.ref}, so it is closed as its duplicate; requested again against revision ${target.revision} because decision ${decision.id} was settled ${current.state}`;
  await note(entry, 'done', `${why}; requesting it again against revision ${target.revision} (request ${spent + 1} of ${maxDecisionRequests})`);
  return request(cycle, diagnostician, entry, target, decision.action, input, reason, note);
}

/**
 * GY-1371: the entry's decision target no longer needs its action, so the entry is answered, with
 * no fault: by the target itself when it is a fix that was delivered or released meanwhile, by the
 * item a closed target names as its answer, or as no longer open when nothing names one.
 */
async function settleNoLongerOpen(state: DaemonState, entry: DiagnosisRecord, target: Work | null, why: string, note: Note, action = entry.decision!.action) {
  const by = !target ? null : action === 'release' && !isClosed(target) ? target.key : answeringItem(target);
  if (by) return answer(state, entry, by, note, `${why}, so the diagnosis of ${entry.subject} is answered by ${by}`);
  entry.state = 'answered'; entry.answeredBy = null;
  await note(entry, 'done', `${why}, so the diagnosis of ${entry.subject} is answered as no longer open`, null);
}

/** Approver for the entry's decision; GY-1713 reuses an existing launch/watch on an adopted close. */
async function launchApprover(cycle: Cycle, entry: DiagnosisRecord, work: Work, note: Note, adopted = false) {
  const decision = entry.decision!;
  if (!cycle.effects.approver) return;
  try {
    if (adopted) {
      const launches = await cycle.effects.approverLaunches?.().catch(() => []) ?? [];
      const fromLaunch = [...launches].reverse().find(row => row.decision === decision.id)?.agentName ?? null;
      const existing = fromLaunch ?? Object.values(cycle.state.approvals).find(watch => watch.decision === decision.id)?.agentName ?? null;
      if (existing) {
        decision.approver = existing;
        await note(entry, 'done', `Adopted ${decision.action} decision ${decision.id}, already standing on ${work.key}, reusing approver ${existing}`);
        return;
      }
    }
    const launched = await cycle.effects.approver(work, decision.id);
    decision.approver = launched.agentName;
    await note(entry, 'done', adopted
      ? `Adopted ${decision.action} decision ${decision.id}, already standing on ${work.key}, and launched approver ${launched.agentName}`
      : `Launched approver ${launched.agentName} for ${decision.action} decision ${decision.id} on ${work.key}`);
  } catch (error) { await note(entry, 'failed', `Could not launch the approver for ${decision.action} decision ${decision.id} on ${work.key}: ${message(error)}; it is launched again next cycle`, planeWideRefusal(error) ? null : undefined); }
}

/** The subject is answered by `by`: an invariant violation's instance is linked to it; a recurring item's closure already names it. */
async function answer(state: DaemonState, entry: DiagnosisRecord, by: string, note: Note, detail?: string) {
  if (entry.kind === 'invariant') { const instance = state.faults.instances.find(candidate => candidate.id === entry.subject); if (instance) instance.linkedTo = by; }
  standingHolds.delete(entry.subject);
  entry.answeredBy = by; entry.state = 'answered';
  await note(entry, 'done', detail ?? `${entry.subject} is answered by ${by}`);
}

/** The diagnoses `master status` reports under daemon.diagnoses, newest first. */
export function diagnosisReport(state: Pick<DaemonState, 'diagnoses'>, limit = 20) {
  const entries = Object.values(state.diagnoses).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { inFlight: entries.filter(entry => !diagnosisSettled(entry)).length,
    recent: entries.slice(0, limit).map(entry => ({ subject: entry.subject, kind: entry.kind, faultClass: entry.faultClass, state: entry.state, cause: entry.diagnosis?.cause ?? null,
      covering: entry.diagnosis?.covering ?? null, fix: entry.fix, decision: entry.decision, answeredBy: entry.answeredBy, retryAt: entry.retryAt, refusedAt: entry.refusedAt, detail: entry.detail, updatedAt: entry.updatedAt })) };
}
