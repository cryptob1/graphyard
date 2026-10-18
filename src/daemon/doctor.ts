// Concern: the pipeline doctor (GY-711) — the loop's five-minute remedy worker; the deterministic remedies it would apply live beside it in ./remedies.ts.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Work } from '../model.js';
import { createSchema } from '../model.js';
import { doctorLimitRetryAt, doctorLimitUntilMarker, headlessTimeoutLimitCharge, type ExhaustionSignal, type LimitRunEvent } from '../model/capacity.js';
import { isClosed } from '../model/closure.js';
import { planeWideRefusal } from '../model/blocker-class.js';
import { RefusedResponse } from '../model/refusal.js';
import { doctorCoverNote, faultClassIsCovered, faultClassPolicyDefaults, faultClassPolicyFromEnv, type FaultClassPolicy, type FaultInstance } from '../model/fault-classes.js';
import { workerReclaimBoundMs, workerSubmissionBoundMs } from '../model/attempt-bound.js';
import { scopeRefusalBlocker, unplannedPaths } from '../model/scope.js';
import { approverSessionName, guardBroadScope } from '../master/autonomy.js';
import { containmentPhase, masterHarness, type MasterConfig } from '../master.js';
import { HarnessCheckoutRefusal, harnessApplyCheckout, recordServingUnits } from '../master/harness.js';
import { installUnitsFile } from '../install/units.js';
import { coordinatorCheckoutRoot } from '../master/profiles.js';
import { harnessDrift, writeHarnessPermissions } from '../harness.js';
import { selectFleetSession } from '../fleet.js';
import { heldAwareProbe, recordEnvironmentLog, selectionKey } from '../master/environments.js';
import { registryHeadlessLaunch, registryRunner, runConfinement } from '../runner/roles.js';
import { piRunner } from '../runner/pi.js';
import type { MergerMode } from '../merger-mode.js';
import { doctorActionSchema, doctorFindingsSchema, doctorFiledSchema, doctorRunRecordSchema, type DoctorAction, type DoctorFinding, type DoctorFiled, type DoctorPendingFile, type DoctorRunRecord } from './state.js';
import { doctorSettingsSchema, type DoctorSettings } from '../master/doctor-settings.js';
import { z } from 'zod';
import type { Runner } from '../runner/types.js';
import { readyToRetry } from './sessions.js';
import { stoppedStates, record } from './effects.js';
import { cycleCost, loopAttention, loopLiveness } from './liveness.js';
import { latencyBudget, silenceReport } from './metrics.js';
import { baseFailureAttention } from './cycle-base-failures.js';
import { maxApproverLaunches } from './decisions.js';
import { decisionReadConcurrency } from './decision-reads.js';
import { message, touchStanding, type DaemonAction, type DaemonState } from './state.js';
import type { Cycle } from './cycle.js';
// The deterministic remedies live in ./remedies.ts; they are used through `routineRemedies` below
// and re-exported here, so every existing import keeps working.
import { routineRemedies } from './remedies.js';
export { settleSubmittedContainment, coveredScopePaths, clearCoveredBlockers, unansweredDecisionMs, relaunchUnansweredApprovers, decisionCheckMs, applyHarnessContract, routineRemedies } from './remedies.js';

// ---------------------------------------------------------------------------
// GY-2003 / GY-2004: the loop's resolver. All day a master session ran a ten-minute monitor by
// hand and repeatedly applied the same sanctioned actions; here the loop does it, and the session
// is a resolver, not a checklist reader. Every `run.doctor.intervalMinutes` (5 by default) — and
// at once when the loop's progress watchdog fires (GY-2005: cycle.ts marks a run due when the
// silence bound breaches) — it
// launches one: a headless session on the registry's doctor role, else Pi, with the master's read
// access and the operator-agent identity's sanctioned commands only — scope, requirements,
// unblock, decide + approver, settle-containment, close, create, release and checkout-restore
// (GY-1658: the loop saves a dirty coordinator checkout to a named ref) — never merge, dispatch,
// evidence or lease commands (the shipped allowlist guard in integrations/pi blocks the rest and
// records the refusal). Its prompt is the short charter below: act on what has stalled, never ask
// a person, file an item only for a code change judged needed. The remedies that need no judgement
// at all the loop applies itself, every cycle, in `routineRemedies`.
// ---------------------------------------------------------------------------

export const doctorRole = 'doctor';

/** The tool name the doctor's Pi session submits its report through. */
export const doctorTool = 'graphyard_doctor_report';

/**
 * The tool set the doctor's session is launched with, on the runtime's tools flag: bash under its
 * command allowlist, and its report tool. Every other tool — read, edit, write, any built-in —
 * never starts, so none can reach past the checkout boundary before the extension's gate judges it
 * (the extension refuses them too, as the second line of defence).
 */
export const doctorSessionTools = ['bash', doctorTool] as const;

/** The launch arguments carrying that tool set, on the runtime's tools flag. */
export const doctorSessionArgs = ['--tools', doctorSessionTools.join(',')] as const;

/** The fault item a doctor run asks the loop to file: P0/P1, criteria and planned files (the shape state.ts keeps). */
export { doctorFiledSchema };
export type DoctorFile = DoctorFiled;
/** `graphyard_doctor_report`: the doctor's structured report, re-validated here (GY-711). Findings and actions are bound at the run record's own 50, so everything a report may carry is everything the posted run keeps. */
export const doctorReportPayloadSchema = z.object({
  findings: z.array(doctorFindingsSchema).max(50).default([]),
  actions: z.array(doctorActionSchema).max(50).default([]),
  filed: z.array(doctorFiledSchema).max(20).default([]),
}).strict();
export type DoctorReportPayload = z.infer<typeof doctorReportPayloadSchema>;

/** The doctor settings in force: `run.doctor` over its defaults, Pi's command from `run.pi` when it names none. */
export function doctorSettings(run: { doctor?: unknown; pi?: { command?: string } } | undefined): DoctorSettings {
  const parsed = doctorSettingsSchema.parse(run?.doctor ?? {});
  return { ...parsed, command: parsed.command ?? run?.pi?.command ?? 'pi' };
}

/** One call as the master's operator-agent identity, as `daemonEffects` wires it. */
export type OperatorAgentPost = (method: 'GET' | 'POST', path: string, body?: unknown, key?: string) => Promise<unknown>;

/**
 * The doctor's effects under the live configuration (GY-711). Its primary run takes the registry's
 * doctor role when an operator defines one, else Pi on `run.doctor.model`; the fallback run is Pi
 * on the stronger `fallbackModel`. Every run launches restricted to the doctor's own tool set —
 * bash and its report tool — so no other tool ever starts. The session holds the control plane URL
 * and the operator-agent credential by path — never the token itself — and its shipped command
 * allowlist (integrations/pi) holds it to the sanctioned master commands.
 */
export const doctorEffects = (config: MasterConfig, root: string, post: OperatorAgentPost): DoctorEffects => {
  const settings = doctorSettings(config.run);
  // The control plane is the only merge writer (GY-1835 reads it here).
  const merger = async (): Promise<MergerMode> => 'control-plane';
  return {
    settings, cwd: root, merger,
    env: { GRAPHYARD_URL: config.url, GRAPHYARD_TOKEN_FILE: config.operatorAgent!.credentialFile, GRAPHYARD_HOST_ID: config.hostId, GRAPHYARD_DOCTOR_CLI: config.cliPath },
    runner: async attempt => {
      if (attempt === 'primary') {
        const fleet = await selectFleetSession(config, doctorRole, { name: doctorRole, principal: config.operatorAgent!.id }, await heldAwareProbe(config)); // held accounts and twins are spent (GY-1574)
        if (fleet) {
          const launch = registryHeadlessLaunch(fleet.account);
          if (launch.command === 'pi') {
            await recordEnvironmentLog(config, fleet.health ? [fleet.health] : [], fleet.skipped, { key: selectionKey('doctor', doctorRole), environment: fleet.account.name, kind: fleet.account.kind, at: new Date().toISOString(), work: null }).catch(() => {});
            return { runner: registryRunner(fleet.account, [...doctorSessionArgs]), runtime: launch.command, model: launch.model, account: fleet.account.name, release: fleet.release };
          }
          await fleet.release(`the registry doctor role names runtime ${launch.command}; the doctor runs only on Pi, where its command allowlist applies`);
        }
      }
      const model = attempt === 'primary' ? settings.model : settings.fallbackModel;
      return { runner: piRunner({ command: settings.command, model, args: [...doctorSessionArgs], confine: runConfinement() }), runtime: 'pi', model, account: null };
    },
    file: (input, key) => post('POST', 'work', input, key) as Promise<Work>,
    recordRun: run => post('POST', 'doctor', run),
  };
};

/** The fault bounds of the doctor's checks, in minutes: the one declaration the soak worlds and the evidence share. The resolver's charter cites only the stall rules it acts on; the rest name the bounds the report's checks are judged past. */
export const doctorBounds = {
  blockedMinutes: 10, workerMinutes: workerSubmissionBoundMs / 60_000, ciMinutes: 20, reviewRequestMinutes: 5, launchMinutes: 2,
  proofsMinutes: 30, mergeableMinutes: 5, decisionMinutes: 10,
} as const;

/** The sanctioned master commands the resolver may run, the list the allowlist guard in integrations/pi shares. */
export const doctorSanctionedCommands = ['scope', 'requirements', 'unblock', 'decide', 'approver', 'settle-containment', 'close', 'create', 'release', 'checkout-restore'] as const;

export interface DoctorEffects {
  settings: DoctorSettings;
  /** The repository checkout the doctor reads: the loop's own. */
  cwd: string;
  /** The session's environment: the control plane URL and the operator-agent credential by path, never the token itself. */
  env: Record<string, string>;
  /** The primary run's runner (the registry's doctor role, else Pi on `model`), or the fallback's (Pi on `fallbackModel`). `account` is the registry selection the hold charges (GY-1705). */
  runner: (attempt: 'primary' | 'fallback') => Promise<{ runner: Runner; runtime: string; model: string; account?: string | null; release?: (reason: string) => Promise<unknown> }>;
  /** Files the fault item, as the master's operator-agent identity on `master create`'s route. */
  file: (input: DoctorFileInput, key: string) => Promise<Work>;
  /** Posts one run summary to the control plane, so the dashboard's Doctor panel and `master status` show it. */
  recordRun?: (run: DoctorRunRecord) => Promise<unknown>;
  /**
   * The recorded merger, as the doctor's own control-plane calls read it (GY-1835, review of
   * 3b7408170110). Under a `control-plane` merger an item's pull request, reviews and checks are
   * the control plane's own records, so the doctor is not sent to GitHub for them: its prompt's
   * read list names no `gh pr view` and the session environment narrows its guard's gh reads to
   * match. Absent, github reads stand.
   */
  merger?: () => Promise<MergerMode>;
}
export type DoctorFileInput = ReturnType<typeof createSchema.parse> & { reason: string };

export interface DoctorInput {
  /** One line per open item: what stage it holds, since when, and what its own record shows. */
  items: string[];
  /** The fault instances the loop has standing, newest first: what its own classification saw. */
  faults: string[];
  /** The loop's failed actions, newest first: steps that threw or were refused, with their reasons. */
  failedActions?: string[];
  /** The loop's attention lines, which master status puts first: its own health and the base failures. */
  attention?: string[];
}

/** The interval one doctor run waits for, from the settings in force. */
export const doctorIntervalMs = (settings: Pick<DoctorSettings, 'intervalMinutes'>) => settings.intervalMinutes * 60_000;
/** Whether a doctor run is due: none is in flight, no provider-limit hold stands (GY-1705), and the last one started past the interval — or the loop's progress watchdog marked one due (GY-2005). */
export function doctorDue(state: { doctor: { runs: DoctorRunRecord[]; watchdogDue?: boolean } }, clock: number, settings: Pick<DoctorSettings, 'intervalMinutes' | 'enabled'>) {
  if (!settings.enabled) return false;
  if (state.doctor.runs.some(entry => entry.state === 'running')) return false;
  if (doctorLimitRetryAt(state.doctor.runs, clock)) return false;
  if (state.doctor.watchdogDue) return true;
  const last = state.doctor.runs.at(-1);
  return !last || clock - Date.parse(last.at) >= doctorIntervalMs(settings);
}

/**
 * The shipped resolver prompt (GY-2004): a short act-don't-ask charter — what has stalled, the
 * master CLI action that clears each kind, never a person, an item filed only for a needed code
 * change — over the evidence to act on: the open items, the standing faults, the loop's failed
 * actions and its attention lines. The shared simplicity paragraph joins it when GY-1993 lands.
 */
export function doctorPrompt(config: { repository: string; cliPath: string; merger?: MergerMode }, input: DoctorInput) {
  const cli = config.cliPath.startsWith('node ') ? config.cliPath : `node ${config.cliPath}`;
  // GY-1835: the read list follows the recorded merger. Under the control-plane merger an item's
  // pull request, its reviews and its checks are the control plane's own records, so the request
  // names no `gh pr view`; with GitHub the merger it names the pull-request read as before.
  const reads = config.merger === 'control-plane'
    ? `${cli} status GY-N, ${cli} master status, ${cli} master decisions GY-N`
    : `${cli} status GY-N, ${cli} master status, ${cli} master decisions GY-N, gh pr view`;
  return [
    `You are the Graphyard resolver for ${config.repository} (the loop's doctor): you keep work moving, and you never ask a person.`,
    `Read the evidence below and the control plane (${reads}).`,
    `Act on what has stalled — or leave it with one line saying why it is fine to wait:`,
    `- an unreleased backlog item idle 20 minutes or more: release it (${cli} master release GY-N) and the loop dispatches it; release refuses any other item`,
    `- an attempt holding its lease for more than ${doctorBounds.workerMinutes} min without a submission: the loop ends it past ${workerReclaimBoundMs / 60_000} min and dispatches the item again, so leave it with a finding; a head it submitted that cannot land goes back for rework`,
    `- an item ready with no worker: read ${cli} master status for why nothing launched, and clear that`,
    `- a blocked item whose blocker no longer holds: ${cli} master unblock GY-N with a quoted reason`,
    `- a parked item, an escalation, a stale refusal, a lapsed containment quarantine (${cli} master settle-containment GY-N): decide within the item's intent with ${cli} master decide GY-N ACTION and a quoted reason`,
    `- a head that cannot land: send it back for rework with a concrete reason (${cli} master decide GY-N rework REASON)`,
    `- work that will never be delivered: close it with a reason (${cli} master close GY-N --obsolete, or --duplicate-of GY-M)`,
    `- a scope or requirements ask within the item's intent: decide it (${cli} master scope GY-N, ${cli} master requirements GY-N FILE); never weaken a requirement`,
    `- every failed action and attention line below: take the simplest action that clears it; an escalation:dirty-checkout line is yours to run (${cli} master checkout-restore with a quoted reason)`,
    `Never approve a decision you requested yourself: request it with ${cli} master decide, then ${cli} master approver GY-N DECISION launches an independent approver.`,
    `A human-only decision (goals and priorities, money or accounts, credentials for people) is never asked for in chat: mark its finding unactionable and move on.`,
    `File an item only for a code change you judge needed, quoting the why after the file (${cli} master create FILE 'why' — the guard refuses a create with no reason stated, so a notice never files an item); everything else is an action or a finding, never an item.`,
    `Run each command by its bare program name with literal arguments. Put a free-text reason last, enclosed in one pair of quotes: your allowlist refuses every other mutation — never merge, dispatch, evidence or lease — and records the refusal.`,
    `Then call the ${doctorTool} tool exactly once: one finding per item you judged, one action entry per command you ran and what it changed, one filed entry per item you asked filed. Stop after the call.`,
    ``,
    `The evidence, as JSON:`,
    JSON.stringify(boundedInput(input)),
  ].join('\n');
}

/** The evidence within 100,000 characters, dropping whole lines from the end and saying how many, so it is always valid JSON. */
export function boundedInput(input: DoctorInput, limit = 100_000): DoctorInput & { omitted?: string } {
  const items = [...input.items], faults = [...input.faults], failedActions = [...input.failedActions ?? []], attention = [...input.attention ?? []];
  let dropped = 0;
  const shaped = () => ({ items, faults, failedActions, attention, ...(dropped ? { omitted: `${dropped} line(s) left out to fit the evidence bound; read them with master status` } : {}) });
  while (JSON.stringify(shaped()).length > limit && (faults.length || items.length || failedActions.length || attention.length)) { (faults.length ? faults : items.length ? items : failedActions.length ? failedActions : attention).pop(); dropped++; }
  return shaped();
}

/** Run the primary attempt, and the fallback once when the primary returns no valid report. */
async function runDoctor(effects: DoctorEffects, prompt: string, merger?: MergerMode): Promise<{ runs: DoctorRunRecord['runs']; report: DoctorReportPayload | null; limit?: ExhaustionSignal | null; account?: string | null; holds?: { account: string; limit: ExhaustionSignal }[] }> {
  const runs: DoctorRunRecord['runs'] = [], timed: { result: string; detail: string; events: LimitRunEvent[]; account: string | null }[] = [];
  const timeoutMs = effects.settings.timeoutMinutes * 60_000;
  for (const attempt of ['primary', 'fallback'] as const) {
    if (stopping) { runs.push({ runtime: 'none', model: attempt, result: 'cancelled', detail: stopping.slice(0, 500) }); break; }
    let chosen: Awaited<ReturnType<DoctorEffects['runner']>>;
    try { chosen = await effects.runner(attempt); }
    catch (error) { runs.push({ runtime: 'none', model: attempt, result: 'spawn', detail: `No ${attempt} runner: ${message(error)}`.slice(0, 500) }); continue; }
    const attemptAccount = chosen.account ?? null;
    try {
      if (stopping) { runs.push({ runtime: chosen.runtime, model: chosen.model, result: 'cancelled', detail: stopping.slice(0, 500) }); break; }
      const run = chosen.runner.start(prompt, { cwd: effects.cwd, env: { ...effects.env, GRAPHYARD_PI_ROLE: doctorRole, ...(merger === 'control-plane' ? { GRAPHYARD_MERGER: merger } : {}) }, tool: doctorTool, timeoutMs,
        validate: payload => doctorReportPayloadSchema.parse(payload) });
      active = run;
      const result = await run.result();
      const detail = (result.ok ? `${result.payload.findings.length} finding(s), ${result.payload.actions.length} action(s), ${result.payload.filed.length} to file` : result.failure.detail).slice(0, 500);
      const outcome = result.ok ? 'reported' : result.failure.reason;
      runs.push({ runtime: chosen.runtime, model: chosen.model, result: outcome, detail });
      if (!result.ok) timed.push({ result: outcome, detail, events: [...run.events], account: attemptAccount });
      if (result.ok) return { runs, report: result.payload, account: attemptAccount };
      if (result.failure.reason === 'cancelled') break;
    } catch (error) {
      runs.push({ runtime: chosen.runtime, model: chosen.model, result: 'spawn', detail: `The ${attempt} run failed to start: ${message(error)}`.slice(0, 500) });
    } finally {
      active = null;
      await Promise.resolve().then(() => chosen.release?.(`the ${attempt} doctor run ended`)).catch(() => {});
    }
  }
  const charged = headlessTimeoutLimitCharge(timed, Date.now());
  return { runs, report: null, limit: charged?.limit ?? null, account: charged?.account ?? null, holds: charged?.holds ?? [] };
}

/** One doctor run this process has in flight, settled: a test's way to wait for it. */
let live: Promise<void> | null = null, active: { cancel(reason?: string): void } | null = null, stopping: string | null = null;
export async function doctorRunsSettled() { await live; }
/**
 * The loop is stopping: the run in flight is cancelled, no fallback starts, and its outcome is
 * recorded on the cursor before the loop releases its lock, so nothing continues past shutdown.
 */
export async function stopDoctorRuns(reason = 'the loop is stopping') {
  if (!live) return;
  stopping = reason;
  active?.cancel(reason);
  try { await live; } finally { stopping = null; }
}
/** Test seam: forget every run in flight. */
export function clearDoctorRuns() { live = null; active = null; stopping = null; }

const keyOf = (subjects: string[]) => `doctor:${createHash('sha256').update(subjects.sort().join(',')).digest('hex').slice(0, 24)}`;
const subjectKey = (work: readonly Work[], subject: string) => work.find(item => item.key === subject || item.id === subject)?.key ?? null;

/**
 * What the loop keeps of a doctor payload: one event per item it found or acted on, and the run
 * summary. `filed` entries are deduplicated first: a fault class a standing item (open or closed as
 * answered by an undelivered diagnostician fix), a GY-1632 delivered cover, or a fallen cover still
 * below the recurrence threshold stands for is recorded covered, never filed ahead of the loop's
 * own sweep (GY-1711).
 */
export function dedupDoctorFiles(filed: readonly DoctorFile[], work: readonly Work[], instances: readonly FaultInstance[] = [], now = 0, policy: FaultClassPolicy = faultClassPolicyDefaults): { file: DoctorFile; covered: boolean }[] {
  const seen = new Set<string>();
  return filed.map(entry => {
    const covered = seen.has(entry.faultClass) || faultClassIsCovered(work, entry.faultClass, instances, now, policy);
    seen.add(entry.faultClass);
    return { file: entry, covered };
  });
}

/**
 * A model-authored proof ID in the form the create schema takes (GY-1336): a doctor wrote
 * `integration: main guard retries the revert` where `master create` takes
 * `integration:main-guard-retries-the-revert`, and the whole filing was refused. The kind is kept
 * when it is one the schema knows (any case), else the proof is a manual one; the rest is slugged.
 */
export function doctorProofId(proof: string): string {
  const kind = /^\s*(unit|integration|e2e|manual)\s*:/i.exec(proof);
  const name = (kind ? proof.slice(kind[0].length) : proof).trim().replace(/[^a-zA-Z0-9._/-]+/g, '-').replace(/^[-/]+|[-/]+$/g, '').slice(0, 150);
  return `${kind ? kind[1].toLowerCase() : 'manual'}:${name || 'doctor-filed'}`;
}

/** The criteria in the form create takes them (see doctorFileItem), which is also what create judges for a refusal digest. */
const normalisedCriteria = (entry: DoctorFile) => entry.criteria.map((criterion, index) => ({ id: `AC-${index + 1}`, text: criterion.text.slice(0, 2000), proofs: [...new Set(criterion.proofs.map(doctorProofId))] }));

/**
 * The fault item a doctor run files, as `master create` would: the create schema's checks, P0/P1,
 * and the class it closes. The criteria are the doctor's own words, so their shape is normalised
 * first — IDs numbered AC-1…, text bounded as create bounds it, proof IDs in the schema's form — and
 * a filing is refused only for what normalising cannot mend.
 */
export function doctorFileItem(entry: DoctorFile, reason: string): DoctorFileInput {
  const criteria = normalisedCriteria(entry);
  const input = createSchema.parse({ title: entry.title, description: entry.description, type: 'bug', priority: entry.priority, criteria, plannedFiles: entry.plannedFiles,
    origin: { faultClass: { class: entry.faultClass, threshold: 1, windowHours: 1, count: 1, detectedAt: new Date().toISOString(), instances: [] } } });
  return { ...input, reason: guardBroadScope(input, reason, { allow: false, command: 'master create' }) };
}

/**
 * A filing the create checks refuse even normalised is the doctor's malformed output, not the loop
 * failing: no retry can mend it, so it is raised as an escalation for the master to file by hand.
 */
const invalidFiling = (file: DoctorFile, error: unknown) =>
  `The doctor asked to file "${file.title}" (${file.faultClass}, P${file.priority}), but the filing fails the checks master create applies, so it is not filed; file it by hand with master create: ${message(error)}`.slice(0, 2000);

/**
 * GY-1530 / GY-1713: create refused the filing (409 demand, or 400 Invalid input under schema skew)
 * rather than failing to answer — same content stays refused forever (GY-1516 / GY-1700). Structural
 * status else the operator-agent text; diagnosis reads fix-item refusals by the same rule.
 */
export const createRefused = (error: unknown) => error instanceof RefusedResponse
  ? error.status === 409 || error.status === 400
  : /^Graphyard refused \S+ \((?:409|400)\)/.test(message(error));
/**
 * The scenario a create refusal names as unregistered (src/engine.ts's "Register E2E scenario NAME
 * before creating work that requires it"), else null. Scenarios register only from the repository's
 * e2e/cases files (`graphyard e2e sync`) or an admin's defineScenario; a filing that cites one by a
 * name nothing registers is malformed, as a proof ID the checks refuse is, and can never be filed as written.
 */
export const unregisteredScenario = (error: unknown) => /Register E2E scenario (\S+) (?:before creating work that requires it|first)\b/.exec(message(error))?.[1] ?? null;

/**
 * A filing create refused (GY-1530): the content is malformed as far as the control plane is
 * concerned, so it is dropped from the pending files — never re-filed — and recorded failed under
 * the proof class's `fix-item` ("a fix item create refuses"), the cause, instead of the doctor step's
 * own kind. The escalation beside it names what the master must mend by hand: the scenario the
 * filing cites with no registered revision, or the refusal itself.
 */
/** The refused content's identity: what create judges (class, title, files, criteria), not the evidence prose, which carries a fresh timestamp every run. */
export const filingDigest = (file: DoctorFile) => createHash('sha256').update(JSON.stringify([file.faultClass, file.title, file.plannedFiles, normalisedCriteria(file)])).digest('hex').slice(0, 32);

/**
 * The digest as seen refusal at `at`. Nothing evicts a refusal, neither a count nor an age: whenever
 * the doctor reports that content again, however long after, it is not submitted to create again.
 */
const renewRefusal = (refused: DaemonState['doctor']['refusedFilings'], digest: string, at: number) => [...refused.filter(entry => entry.digest !== digest), { digest, at }];
const isRefused = (refused: DaemonState['doctor']['refusedFilings'], digest: string) => refused.some(entry => entry.digest === digest);

async function dropRefusedFiling(cycle: Pick<Cycle, 'state' | 'effects' | 'performed'>, key: string, file: DoctorFile, error: unknown, attempts: number, now: () => number) {
  const { state, effects: daemon, performed } = cycle;
  state.doctor.pendingFiles = state.doctor.pendingFiles.filter(entry => entry.key !== key);
  // The refusal outlives this run's key: a later run reporting the same content is not filed again, corrected content is.
  state.doctor.refusedFilings = renewRefusal(state.doctor.refusedFilings, filingDigest(file), now());
  // A pending retry that met the plane's outage opened a plane-unavailable run on this key (GY-1404),
  // and a key's later failures are noted against its standing run whatever their kind. The plane has
  // answered now, so that run is over: ended here, the refusal opens the proof instance it is.
  const standing = state.faults.failing[key] ? state.faults.instances.find(entry => entry.id === state.faults.failing[key]) : undefined;
  if (standing && standing.kind !== 'fix-item') delete state.faults.failing[key];
  const scenario = unregisteredScenario(error);
  performed.push(await record(state, key, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file "${file.title}", and it is not filed again: master create refused the filing itself${scenario ? ` for the e2e proof it cites, whose scenario ${scenario} has no registered revision` : ''}: ${message(error)}`.slice(0, 2000), attempts, cycle: state.cycle }, now(), daemon.persist, 'fix-item'));
  const mend = scenario
    ? `the filing cites e2e:${scenario}, and no scenario ${scenario} is registered (scenarios register only from e2e/cases files via graphyard e2e sync or an admin's defineScenario); register it, or file the item by hand with master create under a proof that exists`
    : `master create refused it (${message(error)}); file it by hand with master create once mended`;
  performed.push(await record(state, `escalation:doctor-filing:${key}`, { kind: 'escalation', work: null, principal: null, state: 'done', detail: `The doctor asked to file "${file.title}" (${file.faultClass}, P${file.priority}), but ${mend}`.slice(0, 2000), attempts: 1, cycle: state.cycle }, now(), daemon.persist));
}

/**
 * Apply one settled doctor run: record one event per item the run found or acted on, deduplicate
 * and file what it asked filed, and keep one run summary — what was stuck, why, what it did, what
 * it filed — on the cursor and the control plane.
 */
export async function applyDoctorRun(cycle: Cycle, effects: DoctorEffects, run: DoctorRunRecord, payload: { findings: DoctorFinding[]; actions: DoctorAction[]; filed: DoctorFile[] }, now: () => number) {
  const { state, effects: daemon, performed } = cycle;
  const key = keyOf([run.at, ...payload.findings.map(finding => finding.subject)]);
  // GY-1338: settle against a fresh snapshot (items filed meanwhile); without one, wait for retry.
  // Cover times use the plane clock (snapshot.now, else cycle.clock): host now() can lag the stamps.
  let work = cycle.snapshot.work, coverNow = cycle.clock, fresh: typeof work | null = payload.filed.length ? null : work;
  if (payload.filed.length) {
    const read = await daemon.snapshot().then(entry => entry, () => null);
    if (read) {
      work = fresh = read.work;
      const observed = Date.parse(read.now);
      if (Number.isFinite(observed)) coverNow = observed;
    }
  }
  const note = async (subject: string, detail: string, outcome: DaemonAction['state'] = 'done', kind: DaemonAction['kind'] = 'fault') => {
    const itemKey = subjectKey(work, subject);
    performed.push(await record(state, `${key}:${subject}:${performed.length}`, { kind, work: itemKey, principal: null, state: outcome, detail, attempts: 1, cycle: state.cycle }, now(), daemon.persist));
  };
  // A finding the doctor could not act on — a human-only decision, a fault with no item to act
  // through — is raised as an escalation, which master status reports under the loop's escalations.
  for (const finding of payload.findings)
    await note(finding.subject, `${finding.check} bound passed${finding.unactionable ? ', and the doctor could not act on it' : ''}: ${finding.detail}`.slice(0, 2000), 'done', finding.unactionable ? 'escalation' : 'fault');
  // A command the doctor's allowlist refused is the guard working: the doctor records it and adapts,
  // and the run itself succeeded. Recorded as failed, each refusal was a loop fault, and a run that
  // tried five read-only forms filed "Recurring loop faults" for a loop that never stopped (GY-1295).
  for (const action of payload.actions)
    await note(action.subject, `${action.outcome === 'applied' ? 'Ran' : 'Was refused'} \`${action.command}\`: ${action.detail}`.slice(0, 2000));
  const policy = daemon.faultClassPolicy ?? faultClassPolicyFromEnv(process.env);
  const instances = state.faults.instances;
  const deduped = dedupDoctorFiles(payload.filed, work, instances, coverNow, policy);
  for (const { file, covered } of deduped) {
    if (covered) { await note('installation', `Not filing "${file.title}": the ${file.faultClass} fault class is already covered by ${doctorCoverNote(work, file.faultClass, instances, coverNow, policy)}`); continue; }
    const filingKey = `${key}:file:${file.faultClass}`;
    if (isRefused(state.doctor.refusedFilings, filingDigest(file))) { state.doctor.refusedFilings = renewRefusal(state.doctor.refusedFilings, filingDigest(file), now()); await note('installation', `Not filing "${file.title}" again: master create refused this content earlier and the escalation for it stands; it is filed again only when the doctor corrects it`); continue; }
    if (!fresh) {
      state.doctor.pendingFiles = [...state.doctor.pendingFiles.filter(entry => entry.key !== filingKey), { key: filingKey, at: run.at, file }].slice(-40);
      await note('installation', `Not filing "${file.title}" yet: the open items could not be read when the run settled, so it is filed on a later cycle if no open or delivered cover accounts for the ${file.faultClass} fault class`);
      continue;
    }
    let input: DoctorFileInput;
    try { input = doctorFileItem(file, `The pipeline doctor found a ${file.faultClass} fault no open or delivered cover accounts for: ${file.description.slice(0, 1500)}`); }
    catch (error) { await note('installation', invalidFiling(file, error), 'done', 'escalation'); continue; }
    try {
      const filedItem = await effects.file(input, filingKey);
      // Filed: any pending retry of the same filing is dropped before the cursor is persisted.
      state.doctor.pendingFiles = state.doctor.pendingFiles.filter(entry => entry.key !== filingKey);
      run.filed.push({ faultClass: file.faultClass, title: file.title, work: filedItem.key, deduplicated: false });
      await note(filedItem.key, `Filed ${filedItem.key} (P${file.priority}) for the ${file.faultClass} fault no open or delivered cover accounted for: ${file.title}`);
    } catch (error) {
      // GY-1530: a refusal of the filing itself is never mended by a retry; it is dropped and classified.
      if (createRefused(error)) { await dropRefusedFiling(cycle, filingKey, file, error, (state.actions[filingKey]?.attempts ?? 0) + 1, now); continue; }
      // A filing the control plane would not take is kept on the cursor — before the failed record
      // persists it — so a later cycle files it again under the same stable key; a control plane
      // that was only briefly unreachable loses no P0/P1 fault item (GY-711).
      // GY-1336: queued for that retry, the refusal is handled by design — still failed, but no fault
      // kind, so no loop fault instance (as GY-1295 and GY-1318 did); a retry that fails again is one.
      state.doctor.pendingFiles = [...state.doctor.pendingFiles.filter(entry => entry.key !== filingKey), { key: filingKey, at: run.at, file }].slice(-40);
      performed.push(await record(state, filingKey, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file "${file.title}"; it is filed again on a later cycle: ${message(error)}`.slice(0, 2000), attempts: (state.actions[filingKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), daemon.persist, null));
    }
  }
  run.state = 'reported';
  run.detail = `${run.findings.length} finding(s), ${run.actions.length} action(s), ${run.filed.length} filed, ${deduped.filter(entry => entry.covered).length} deduplicated: ${run.detail}`.slice(0, 1000);
  // The run record is already on the cursor's list; only its state, summary and filings move here.
  performed.push(await record(state, key, { kind: 'fault', work: null, principal: null, state: 'done', detail: run.detail, attempts: 1, cycle: state.cycle }, now(), daemon.persist));
  await postRun(cycle, effects, run, now);
}

/**
 * Post one settled run to the control plane. A refusal or an unreachable control plane is recorded
 * as a failed action and the run is posted again on later cycles, until it is accepted or it
 * leaves the retained runs: the dashboard and `master status` are never silently without it.
 */
export async function postRun(cycle: Pick<Cycle, 'state' | 'effects'>, effects: Pick<DoctorEffects, 'recordRun'>, run: DoctorRunRecord, now: () => number) {
  const { state } = cycle;
  if (!effects.recordRun) return;
  const pending = new Set(state.doctor.unposted);
  try {
    await effects.recordRun(run);
    pending.delete(run.at);
    // A post accepted after a refusal ends the refusal's fault instance, whatever kind it opened as.
    if (state.actions[`doctor:post:${run.at}`]?.state === 'failed') await record(state, `doctor:post:${run.at}`, { kind: 'fault', work: null, principal: null, state: 'done', detail: `The control plane accepted the doctor run of ${run.at}`, attempts: state.actions[`doctor:post:${run.at}`]!.attempts, cycle: state.cycle }, now(), cycle.effects.persist);
  } catch (error) {
    pending.add(run.at);
    // GY-1404: a plane-wide refusal (a timeout, a 502) is the control plane not answering, not the doctor's step failing.
    await record(state, `doctor:post:${run.at}`, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `The control plane did not accept the doctor run of ${run.at}; it is posted again next cycle: ${message(error)}`.slice(0, 2000), attempts: (state.actions[`doctor:post:${run.at}`]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), cycle.effects.persist,
      planeWideRefusal(error) ? 'plane-unavailable' : undefined);
  }
  state.doctor.unposted = [...pending].filter(at => state.doctor.runs.some(entry => entry.at === at)).slice(-40);
}

const retainedRuns = 20;

/**
 * Retry a filing the plane did not accept: until create takes it, refuses it (GY-1530), or a
 * standing / delivered cover accounts for the class (GY-1711). Cursor updates before the outcome so
 * an abrupt exit keeps it pending.
 */
export async function retryDoctorFile(cycle: Cycle, effects: DoctorEffects, pending: DoctorPendingFile, now: () => number) {
  const { state, effects: daemon, snapshot, clock } = cycle;
  const attempts = (state.actions[pending.key]?.attempts ?? 0) + 1;
  const drop = async (detail: string, work: string | null, outcome: DaemonAction['state']) => {
    state.doctor.pendingFiles = state.doctor.pendingFiles.filter(entry => entry.key !== pending.key);
    await record(state, pending.key, { kind: 'fault', work, principal: null, state: outcome, detail: detail.slice(0, 2000), attempts, cycle: state.cycle }, now(), daemon.persist);
  };
  const policy = daemon.faultClassPolicy ?? faultClassPolicyFromEnv(process.env);
  if (faultClassIsCovered(snapshot.work, pending.file.faultClass, state.faults.instances, clock, policy)) {
    const by = doctorCoverNote(snapshot.work, pending.file.faultClass, state.faults.instances, clock, policy);
    return drop(`Not filing "${pending.file.title}" on retry: the ${pending.file.faultClass} fault class is now covered by ${by}`, null, 'done');
  }
  // Queued through an outage beside another run's copy, the same content may already have been refused.
  if (isRefused(state.doctor.refusedFilings, filingDigest(pending.file))) { state.doctor.refusedFilings = renewRefusal(state.doctor.refusedFilings, filingDigest(pending.file), now()); return drop(`Not filing "${pending.file.title}" on retry: master create refused this content earlier and the escalation for it stands`, null, 'done'); }
  let input: DoctorFileInput;
  try { input = doctorFileItem(pending.file, `The pipeline doctor found a ${pending.file.faultClass} fault no open or delivered cover accounts for: ${pending.file.description.slice(0, 1500)}`); }
  catch (error) {
    // Refused by the checks themselves, the filing would be refused the same way on every retry.
    state.doctor.pendingFiles = state.doctor.pendingFiles.filter(entry => entry.key !== pending.key);
    await record(state, pending.key, { kind: 'escalation', work: null, principal: null, state: 'done', detail: invalidFiling(pending.file, error), attempts, cycle: state.cycle }, now(), daemon.persist);
    return;
  }
  try {
    const filedItem = await effects.file(input, pending.key);
    await drop(`Filed ${filedItem.key} (P${pending.file.priority}) for the ${pending.file.faultClass} fault on a later cycle: ${pending.file.title}`, filedItem.key, 'done');
  } catch (error) {
    if (createRefused(error)) return dropRefusedFiling(cycle, pending.key, pending.file, error, attempts, now);
    // Refused again, the retry is a fault: the plane not answering is the plane's (GY-1404), any other the step's own.
    await record(state, pending.key, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Still could not file "${pending.file.title}": ${message(error)}`.slice(0, 2000), attempts, cycle: state.cycle }, now(), daemon.persist, planeWideRefusal(error) ? 'plane-unavailable' : undefined);
  }
}

/**
 * Step 7c: the doctor. The deterministic remedies run every cycle; the doctor itself every
 * `run.doctor.intervalMinutes`, and at once when the progress watchdog marked a run due (GY-2005).
 * A run settles beside the loop and applies its own report (events per item, the summary) when it
 * ends, so no cycle ever waits on a model.
 */
export async function doctorStep(cycle: Cycle) {
  const { state, effects, now, snapshot, clock } = cycle;
  const doctor = effects.doctor;
  await routineRemedies(cycle);
  if (!doctor) return;
  const inFlight = state.doctor.runs.find(entry => entry.state === 'running');
  if (inFlight) {
    // The run settles beside the loop and applies its own report when it ends (see `live` below).
    // A run this process did not start was started by a loop process that no longer runs (the
    // startup lock admits one loop), so nothing will ever settle it: it is failed at once, and the
    // next cycle starts the next run. Waiting out its bound held every run behind it (GY-1373).
    if (live) return;
    inFlight.state = 'failed';
    inFlight.detail = `The doctor run started ${inFlight.at} never ended in this process; it is recorded as lost`.slice(0, 1000);
    // Lost to the loop's own restart, as a run with no report is (GY-1318): failed, but no loop fault.
    await record(state, `doctor:${inFlight.at}`, { kind: 'fault', work: null, principal: null, state: 'failed', detail: inFlight.detail, attempts: 1, cycle: state.cycle }, now(), effects.persist, null);
    await postRun(cycle, doctor, inFlight, now);
    return;
  }
  // Runs the control plane refused or never received are posted again, one per cycle, and a fault
  // filing it did not accept is filed again under its stable key, one per cycle.
  const unposted = state.doctor.runs.find(entry => entry.state !== 'running' && state.doctor.unposted.includes(entry.at));
  if (unposted && readyToRetry(state.actions[`doctor:post:${unposted.at}`], state.cycle)) await postRun(cycle, doctor, unposted, now);
  const pendingFile = state.doctor.pendingFiles.find(entry => readyToRetry(state.actions[entry.key], state.cycle));
  if (pendingFile) await retryDoctorFile(cycle, doctor, pendingFile, now);
  if (!doctorDue(state, clock, doctor.settings)) return;
  // Launched on whichever trigger fired — the interval or the watchdog mark — so the mark never
  // outlives the run it started.
  state.doctor.watchdogDue = false;
  const run = doctorRunRecordSchema.parse({ at: new Date(clock).toISOString(), state: 'running', runs: [], findings: [], actions: [], filed: [], detail: '' });
  state.doctor.runs = [...state.doctor.runs, run].slice(-retainedRuns);
  // Every open item is evidence, oldest stage first: an item that has held its stage longest is the
  // likeliest stuck one, so it leads, and `boundedInput` — not a newest-100 slice — is what bounds
  // the list, saying how many lines it left out. Beside the standing faults, the loop's own signals
  // reach the resolver (GY-2004): its failed actions, newest first, and its attention lines as
  // master status puts them first — the loop's health read as cycling (it is), and the base
  // failures beside them.
  const intervalMs = cycle.config.run.intervalSeconds * 1000;
  const input: DoctorInput = {
    items: snapshot.work.filter(item => item.stage !== 'done' && !isClosed(item))
      .sort((left, right) => Date.parse(left.stageEnteredAt) - Date.parse(right.stageEnteredAt))
      .map(item =>
        `${item.key} [${item.stage} since ${item.stageEnteredAt}${item.lease ? `, lease ${item.lease.owner} epoch ${item.lease.epoch} until ${item.lease.expiresAt}` : ', unclaimed'}]${item.blocker ? ` blocker: ${item.blocker.slice(0, 200)}` : ''}${item.candidate ? ` candidate ${item.candidate.sha.slice(0, 12)} (PR #${item.candidate.pr})` : ''}`),
    faults: state.faults.instances.slice(-40).reverse().map(instance => `${instance.at} ${instance.kind} on ${instance.subject}: ${instance.text}`),
    failedActions: Object.entries(state.actions).filter(([, action]) => action.state === 'failed')
      .sort((left, right) => Date.parse(right[1].at) - Date.parse(left[1].at)).slice(0, 40)
      .map(([key, action]) => `${action.at} ${action.kind} on ${action.work ?? key}: ${action.detail}`),
    attention: [...loopAttention({
      liveness: { ...loopLiveness(state, clock, intervalMs, cycle.config.hostId), state: 'running' },
      silence: silenceReport(state.silence, clock),
      budget: latencyBudget(state.latency),
      cost: cycleCost(state.metrics?.at(-1) ?? null, intervalMs),
    }), ...baseFailureAttention(Object.values(state.baseFailures), cycle.config.baseBranch)]
      .map(line => `${line.subject}: ${line.text}`),
  };
  // GY-1835: the doctor reads the merger its reads serve: under the control-plane merger its
  // request names no `gh pr view`, and the session environment names the merger too, so the Pi
  // guard admits no `gh pr` read — an item's pull request, reviews and checks are then the
  // control plane's own records.
  const merger = await doctor.merger?.();
  const prompt = doctorPrompt({ ...cycle.config, ...(merger ? { merger } : {}) }, input);
  live = runDoctor(doctor, prompt, merger).catch(error => ({ runs: [{ runtime: 'none', model: 'none', result: 'exit', detail: message(error).slice(0, 500) }], report: null as DoctorReportPayload | null, limit: null, account: null, holds: [] as { account: string; limit: ExhaustionSignal }[] }))
    .then(async outcome => {
      const current = state.doctor.runs.find(entry => entry.at === run.at);
      if (!current || current.state !== 'running') return;
      current.runs = outcome.runs;
      current.findings = (outcome.report?.findings ?? []).slice(-50);
      current.actions = (outcome.report?.actions ?? []).slice(-50);
      if (!outcome.report && outcome.limit) {
        // Settlement time, not the launch clock: the round can run for two timeouts after doctorStep
        // snapped `clock`, and the hold / named-reset comparison must start when the limit is known.
        const settledAt = now();
        const named = outcome.limit.resetsAt ? Date.parse(outcome.limit.resetsAt) : Number.NaN;
        const until = new Date(Number.isFinite(named) && named > settledAt ? named : settledAt + 3_600_000).toISOString();
        for (const hold of outcome.holds ?? []) await effects.holdAccount?.(hold.account, { at: new Date(settledAt).toISOString(), resetsAt: hold.limit.resetsAt, reason: hold.limit.reason, role: 'doctor', profile: doctorRole, work: null });
        current.state = 'failed';
        current.detail = `no report: ${outcome.runs.map(entry => `${entry.model} ${entry.result}`).join('; ')}; ${doctorLimitUntilMarker}${until}`.slice(0, 1000);
        state.doctor.unposted = [...new Set([...state.doctor.unposted, current.at])].slice(-40);
        await record(state, `doctor:${current.at}`, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `The doctor run hit a provider limit (${outcome.limit.reason}); next run waits until ${until}`, attempts: 1, cycle: state.cycle }, now(), effects.persist, null);
        await postRun(cycle, doctor, current, now);
        return;
      }
      current.detail = outcome.report ? 'reported' : `no report: ${outcome.runs.map(entry => `${entry.model} ${entry.result}`).join('; ')}`.slice(0, 1000);
      if (!outcome.report) {
        current.state = 'failed';
        state.doctor.unposted = [...new Set([...state.doctor.unposted, current.at])].slice(-40);
        await record(state, `doctor:${current.at}`, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `The doctor run returned no report: ${current.detail}`, attempts: 1, cycle: state.cycle }, now(), effects.persist, null);
        await postRun(cycle, doctor, current, now);
        return;
      }
      await applyDoctorRun(cycle, doctor, current, outcome.report, now);
    })
    // The catch above settled the run itself; a throw while applying the settled report reaches
    // only here. Leaving the run `running` with `live` cleared would suppress every later cycle
    // until the lost-run bound expires and post an unhandled rejection, so the run is recorded as
    // failed and posted from this terminal handler instead.
    .catch(async error => {
      const current = state.doctor.runs.find(entry => entry.at === run.at);
      if (!current || current.state !== 'running') return;
      current.state = 'failed';
      current.detail = `Applying the report failed: ${message(error)}`.slice(0, 1000);
      // Queued for posting before anything that can throw: a failed run is never reaped as lost, so
      // the unposted marker is what keeps it retryable — the next cycle posts it and the next
      // successful persist carries the marker, even when persisting fails here as well.
      state.doctor.unposted = [...new Set([...state.doctor.unposted, current.at])].slice(-40);
      try {
        await record(state, `doctor:${current.at}`, { kind: 'fault', work: null, principal: null, state: 'failed', detail: current.detail, attempts: 1, cycle: state.cycle }, now(), effects.persist);
        await postRun(cycle, doctor, current, now);
      } catch { /* the run stays queued in `unposted`; a later cycle posts it and persists the cursor */ }
    })
    .finally(() => { live = null; });
}


/** The runs `master status` reports under daemon.doctor, newest first. */
export function doctorReport(state: Pick<DaemonState, 'doctor'>, limit = 10) {
  return { running: state.doctor.runs.some(entry => entry.state === 'running'), recent: [...state.doctor.runs].reverse().slice(0, limit) };
}
