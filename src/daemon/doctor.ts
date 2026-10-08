// Concern: the pipeline doctor (GY-711) — the loop's ten-minute remedy worker, and the
// deterministic remedies the loop applies itself without an agent.
import { createHash } from 'node:crypto';
import type { Work } from '../model.js';
import { createSchema } from '../model.js';
import { isClosed } from '../model/closure.js';
import { planeWideRefusal } from '../model/blocker-class.js';
import { openFaultClassItem } from '../model/fault-classes.js';
import { workerSubmissionBoundMs } from '../model/attempt-bound.js';
import { scopeRefusalBlocker, unplannedPaths } from '../model/scope.js';
import { approverSessionName, guardBroadScope } from '../master/autonomy.js';
import { containmentPhase, type MasterConfig } from '../master.js';
import { selectFleetSession } from '../fleet.js';
import { registryHeadlessLaunch, registryRunner, runConfinement } from '../runner/roles.js';
import { piRunner } from '../runner/pi.js';
import { doctorActionSchema, doctorFindingsSchema, doctorFiledSchema, doctorRunRecordSchema, type DoctorAction, type DoctorFinding, type DoctorFiled, type DoctorPendingFile, type DoctorRunRecord } from './state.js';
import { doctorSettingsSchema, type DoctorSettings } from '../master/doctor-settings.js';
import { z } from 'zod';
import type { Runner } from '../runner/types.js';
import { readyToRetry } from './sessions.js';
import { stoppedStates, record } from './effects.js';
import { maxApproverLaunches } from './decisions.js';
import { decisionReadConcurrency } from './decision-reads.js';
import { message, type DaemonAction, type DaemonState } from './state.js';
import type { Cycle } from './cycle.js';

// ---------------------------------------------------------------------------
// All day a master session ran a ten-minute monitor by hand and repeatedly applied the same
// sanctioned actions. Here the loop does it. Every `run.doctor.intervalMinutes` (10 by default)
// it launches one doctor: a headless session on the registry's doctor role, else Pi, with the
// master's read access and the operator-agent identity's sanctioned commands only — scope,
// requirements, unblock, decide + approver, settle-containment, close, create, release — never
// merge, dispatch, evidence or lease commands (the shipped allowlist guard in integrations/pi
// blocks the rest and the doctor records the refusal). Its prompt is the shipped template below,
// naming every check bound. The three remedies that need no judgement at all the loop applies
// itself, every cycle, in `routineRemedies`.
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
  return {
    settings, cwd: root,
    env: { GRAPHYARD_URL: config.url, GRAPHYARD_TOKEN_FILE: config.operatorAgent!.credentialFile, GRAPHYARD_HOST_ID: config.hostId, GRAPHYARD_DOCTOR_CLI: config.cliPath },
    runner: async attempt => {
      if (attempt === 'primary') {
        const fleet = await selectFleetSession(config, doctorRole, { name: doctorRole, principal: config.operatorAgent!.id }, {});
        if (fleet) {
          const launch = registryHeadlessLaunch(fleet.account);
          // The doctor's command allowlist is the Pi extension's: a registry doctor role on any other runtime would run unguarded, so it is not used.
          if (launch.command === 'pi') return { runner: registryRunner(fleet.account, [...doctorSessionArgs]), runtime: launch.command, model: launch.model, release: fleet.release };
          await fleet.release(`the registry doctor role names runtime ${launch.command}; the doctor runs only on Pi, where its command allowlist applies`);
        }
      }
      const model = attempt === 'primary' ? settings.model : settings.fallbackModel;
      return { runner: piRunner({ command: settings.command, model, args: [...doctorSessionArgs], confine: runConfinement() }), runtime: 'pi', model };
    },
    file: (input, key) => post('POST', 'work', input, key) as Promise<Work>,
    recordRun: run => post('POST', 'doctor', run),
  };
};

/** The fault bounds of the doctor's checks, in minutes, as the shipped template states them. */
export const doctorBounds = {
  blockedMinutes: 10, workerMinutes: workerSubmissionBoundMs / 60_000, ciMinutes: 20, reviewRequestMinutes: 5, launchMinutes: 2,
  proofsMinutes: 30, mergeableMinutes: 5, decisionMinutes: 10,
} as const;

/** The sanctioned master commands the doctor may run, in the order the template names them. */
export const doctorSanctionedCommands = ['scope', 'requirements', 'unblock', 'decide', 'approver', 'settle-containment', 'close', 'create', 'release'] as const;

export interface DoctorEffects {
  settings: DoctorSettings;
  /** The repository checkout the doctor reads: the loop's own. */
  cwd: string;
  /** The session's environment: the control plane URL and the operator-agent credential by path, never the token itself. */
  env: Record<string, string>;
  /** The primary run's runner (the registry's doctor role, else Pi on `model`), or the fallback's (Pi on `fallbackModel`). */
  runner: (attempt: 'primary' | 'fallback') => Promise<{ runner: Runner; runtime: string; model: string; release?: (reason: string) => Promise<unknown> }>;
  /** Files the fault item, as the master's operator-agent identity on `master create`'s route. */
  file: (input: DoctorFileInput, key: string) => Promise<Work>;
  /** Posts one run summary to the control plane, so the dashboard's Doctor panel and `master status` show it. */
  recordRun?: (run: DoctorRunRecord) => Promise<unknown>;
}
export type DoctorFileInput = ReturnType<typeof createSchema.parse> & { reason: string };

export interface DoctorInput {
  /** One line per open item: what stage it holds, since when, and what its own record shows. */
  items: string[];
  /** The fault instances the loop has standing, newest first: what its own classification saw. */
  faults: string[];
}

/** The interval one doctor run waits for, from the settings in force. */
export const doctorIntervalMs = (settings: Pick<DoctorSettings, 'intervalMinutes'>) => settings.intervalMinutes * 60_000;
/** Whether a doctor run is due: none is in flight and the last one started past the interval. */
export function doctorDue(state: { doctor: { runs: DoctorRunRecord[] } }, clock: number, settings: Pick<DoctorSettings, 'intervalMinutes' | 'enabled'>) {
  if (!settings.enabled) return false;
  if (state.doctor.runs.some(entry => entry.state === 'running')) return false;
  const last = state.doctor.runs.at(-1);
  return !last || clock - Date.parse(last.at) >= doctorIntervalMs(settings);
}

/**
 * The shipped doctor prompt: what this session is, the checks and their fault bounds, the
 * sanctioned commands and nothing else, and the evidence to read. Every bound the module's
 * `doctorBounds` carries is named here, and the test holds the two together.
 */
export function doctorPrompt(config: { repository: string; cliPath: string }, input: DoctorInput) {
  const cli = config.cliPath.startsWith('node ') ? config.cliPath : `node ${config.cliPath}`, b = doctorBounds;
  const checklist = [
    `- blocked: an item blocked for more than ${b.blockedMinutes} min`,
    `- worker: an attempt holding its lease for more than ${b.workerMinutes} min without a submission`,
    `- ci: required checks not settled for more than ${b.ciMinutes} min`,
    `- review-request: a review request standing more than ${b.reviewRequestMinutes} min after green CI`,
    `- launch: a session launch not acknowledged for more than ${b.launchMinutes} min`,
    `- proofs: proof requests unanswered for more than ${b.proofsMinutes} min`,
    `- mergeable: a candidate reported mergeable for more than ${b.mergeableMinutes} min without merging`,
    `- decision: a requested decision unanswered for more than ${b.decisionMinutes} min`,
    `- containment: a lapsed containment quarantine holding an item claimable`,
    `- refusal: stale refusal text standing on an item whose state has moved past it`,
    `- overdue: items overdue in any step, by the stage clocks the evidence shows`,
  ].join('\n');
  return `You are the Graphyard pipeline doctor for ${config.repository}. Find stuck and overdue work and fix it through your sanctioned commands, doing what the master would have done by hand. Read the evidence below and the control plane (${cli} status GY-N, ${cli} master status, ${cli} master decisions GY-N, gh pr view). `
    + `Act only where a check below has passed its fault bound; leave what is merely moving. Your sanctioned commands are ${doctorSanctionedCommands.map(name => `${cli} master ${name}`).join(', ')}, as the master's operator-agent identity; every other mutation is refused by your command allowlist — never merge, dispatch, submit evidence or touch a lease — and a refused command is recorded in your report, never retried. Run each command by its bare program name with literal arguments: no variables, command substitution, redirection, wrappers or node options, and read only paths inside this checkout. Never weaken a requirement; never approve a decision you requested yourself (request it, then ${cli} master approver GY-N DECISION for an independent approver). `
    + `A finding you cannot act on — a human-only decision (goals and priorities, money or accounts, credentials for people), or a fault class with no item to act through — mark unactionable; for the latter name the fault item to file, which the loop files at P0/P1 only if no open item already covers it. `
    + `Then call the ${doctorTool} tool exactly once: one finding per stuck or overdue item under its check, one action entry per sanctioned command you ran and what it changed, and one filed entry per fault item you are asking the loop to file. Stop after the call.\n\nThe checks and their bounds:\n${checklist}\n\nThe evidence, as JSON:\n${JSON.stringify(boundedInput(input))}`;
}

/** The evidence within 100,000 characters, dropping whole lines from the end and saying how many, so it is always valid JSON. */
export function boundedInput(input: DoctorInput, limit = 100_000): DoctorInput & { omitted?: string } {
  const items = [...input.items], faults = [...input.faults];
  let dropped = 0;
  const shaped = () => ({ items, faults, ...(dropped ? { omitted: `${dropped} line(s) left out to fit the evidence bound; read them with master status` } : {}) });
  while (JSON.stringify(shaped()).length > limit && (faults.length || items.length)) { (faults.length ? faults : items).pop(); dropped++; }
  return shaped();
}

/** Run the primary attempt, and the fallback once when the primary returns no valid report. */
async function runDoctor(effects: DoctorEffects, prompt: string) {
  const runs: DoctorRunRecord['runs'] = [], timeoutMs = effects.settings.timeoutMinutes * 60_000;
  for (const attempt of ['primary', 'fallback'] as const) {
    if (stopping) { runs.push({ runtime: 'none', model: attempt, result: 'cancelled', detail: stopping.slice(0, 500) }); break; }
    let chosen: Awaited<ReturnType<DoctorEffects['runner']>>;
    try { chosen = await effects.runner(attempt); }
    catch (error) { runs.push({ runtime: 'none', model: attempt, result: 'spawn', detail: `No ${attempt} runner: ${message(error)}`.slice(0, 500) }); continue; }
    // The selected runner is released however its run ends, and a start that throws is a failed
    // attempt the fallback follows, never a leaked registry session.
    try {
      // Shutdown may begin while selection was awaited — before the run is the cancellable one
      // (`active`) — so recheck here: a stopping loop starts no doctor, and the finally below
      // releases the selected session without starting it.
      if (stopping) {
        runs.push({ runtime: chosen.runtime, model: chosen.model, result: 'cancelled', detail: stopping.slice(0, 500) });
        break;
      }
      const run = chosen.runner.start(prompt, { cwd: effects.cwd, env: { ...effects.env, GRAPHYARD_PI_ROLE: doctorRole }, tool: doctorTool, timeoutMs,
        validate: payload => doctorReportPayloadSchema.parse(payload) });
      active = run;
      const result = await run.result();
      runs.push({ runtime: chosen.runtime, model: chosen.model, result: result.ok ? 'reported' : result.failure.reason,
        detail: (result.ok ? `${result.payload.findings.length} finding(s), ${result.payload.actions.length} action(s), ${result.payload.filed.length} to file` : result.failure.detail).slice(0, 500) });
      if (result.ok) return { runs, report: result.payload };
      if (result.failure.reason === 'cancelled') break;
    } catch (error) {
      runs.push({ runtime: chosen.runtime, model: chosen.model, result: 'spawn', detail: `The ${attempt} run failed to start: ${message(error)}`.slice(0, 500) });
    } finally {
      active = null;
      await Promise.resolve().then(() => chosen.release?.(`the ${attempt} doctor run ended`)).catch(() => {});
    }
  }
  return { runs, report: null };
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
 * summary. `filed` entries are deduplicated first: a fault class an open item already stands for
 * is recorded as covered, never filed twice.
 */
export function dedupDoctorFiles(filed: readonly DoctorFile[], work: readonly Work[]): { file: DoctorFile; covered: boolean }[] {
  const seen = new Set<string>();
  return filed.map(entry => {
    const covered = seen.has(entry.faultClass) || !!openFaultClassItem(work, entry.faultClass);
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

/**
 * The fault item a doctor run files, as `master create` would: the create schema's checks, P0/P1,
 * and the class it closes. The criteria are the doctor's own words, so their shape is normalised
 * first — IDs numbered AC-1…, text bounded as create bounds it, proof IDs in the schema's form — and
 * a filing is refused only for what normalising cannot mend.
 */
export function doctorFileItem(entry: DoctorFile, reason: string): DoctorFileInput {
  const criteria = entry.criteria.map((criterion, index) => ({ id: `AC-${index + 1}`, text: criterion.text.slice(0, 2000), proofs: [...new Set(criterion.proofs.map(doctorProofId))] }));
  const input = createSchema.parse({ title: entry.title, description: entry.description, type: 'bug', priority: entry.priority, criteria, plannedFiles: entry.plannedFiles,
    origin: { faultClass: { class: entry.faultClass, threshold: 1, windowHours: 1, count: 1, detectedAt: new Date().toISOString(), instances: [] } } });
  return { ...input, reason: guardBroadScope(input, reason, { allow: false, command: 'master create' }) };
}

/** The reason a doctor filing carries: the class and the doctor's own evidence. */
const filingReason = (file: DoctorFile) => `The pipeline doctor found a ${file.faultClass} fault no open item covers: ${file.description.slice(0, 1500)}`;

/** The scenario a create refusal names as unregistered (src/engine.ts: "Register E2E scenario X before creating work that requires it"), or null. */
export function unregisteredScenarioOf(error: unknown): string | null {
  return /Register E2E scenario (\S+) before creating work/.exec(message(error))?.[1] ?? null;
}

/** The filing with every criterion's `e2e:<scenario>` proof made the manual proof of the same name. */
export function withoutScenario(file: DoctorFile, scenario: string): DoctorFile {
  return { ...file, criteria: file.criteria.map(criterion => ({ ...criterion, proofs: [...new Set(criterion.proofs.map(proof => doctorProofId(proof) === `e2e:${scenario}` ? `manual:${scenario}` : proof))] })) };
}

/**
 * Files one doctor item, mending the one refusal the filing itself can mend (GY-1531). A criterion
 * the doctor wrote against `e2e:<scenario>` with no scenario registered by that name is refused by
 * create on every attempt — no loop path registers a scenario — so the pending filing failed again
 * cycle after cycle and the fault class stayed unfiled. That proof becomes `manual:<scenario>` and
 * the filing is sent again at once; `file` is the filing as last sent, the one a later retry keeps.
 */
export async function fileDoctorItem(file: DoctorFile, key: string, send: DoctorEffects['file']): Promise<{ work: Work | null; file: DoctorFile; mended: string[]; error?: unknown }> {
  const mended: string[] = [];
  for (;;) {
    try { return { work: await send(doctorFileItem(file, filingReason(file)), key), file, mended }; }
    catch (error) {
      const scenario = unregisteredScenarioOf(error);
      if (!scenario || mended.includes(scenario)) return { work: null, file, mended, error };
      mended.push(scenario);
      file = withoutScenario(file, scenario);
    }
  }
}
/** The clause a filing's record carries for the proofs it mended, or nothing. */
const mendedClause = (mended: readonly string[]) => mended.length ? `; ${mended.map(scenario => `e2e:${scenario}`).join(', ')} named no registered scenario and was filed as ${mended.map(scenario => `manual:${scenario}`).join(', ')}` : '';

/**
 * A filing the create checks refuse even normalised is the doctor's malformed output, not the loop
 * failing: no retry can mend it, so it is raised as an escalation for the master to file by hand.
 */
const invalidFiling = (file: DoctorFile, error: unknown) =>
  `The doctor asked to file "${file.title}" (${file.faultClass}, P${file.priority}), but the filing fails the checks master create applies, so it is not filed; file it by hand with master create: ${message(error)}`.slice(0, 2000);

/**
 * Apply one settled doctor run: record one event per item the run found or acted on, deduplicate
 * and file what it asked filed, and keep one run summary — what was stuck, why, what it did, what
 * it filed — on the cursor and the control plane.
 */
export async function applyDoctorRun(cycle: Cycle, effects: DoctorEffects, run: DoctorRunRecord, payload: { findings: DoctorFinding[]; actions: DoctorAction[]; filed: DoctorFile[] }, now: () => number) {
  const { state, effects: daemon, performed } = cycle;
  const key = keyOf([run.at, ...payload.findings.map(finding => finding.subject)]);
  // GY-1338: a run settles minutes after the cycle that launched it, and items filed meanwhile are
  // not in that cycle's snapshot: a run started before GY-1332 existed filed GY-1333 for the same
  // class. Its filings are deduplicated against a read taken now; without one, they wait for the
  // retry, which deduplicates against its own cycle's snapshot, rather than file blind.
  const fresh = payload.filed.length ? await daemon.snapshot().then(read => read.work, () => null) : cycle.snapshot.work;
  const work = fresh ?? cycle.snapshot.work;
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
  const deduped = dedupDoctorFiles(payload.filed, work);
  for (const { file, covered } of deduped) {
    if (covered) { await note('installation', `Not filing "${file.title}": the ${file.faultClass} fault class is already covered by an open item`); continue; }
    const filingKey = `${key}:file:${file.faultClass}`;
    if (!fresh) {
      state.doctor.pendingFiles = [...state.doctor.pendingFiles.filter(entry => entry.key !== filingKey), { key: filingKey, at: run.at, file }].slice(-40);
      await note('installation', `Not filing "${file.title}" yet: the open items could not be read when the run settled, so it is filed on a later cycle if no open item covers the ${file.faultClass} fault class`);
      continue;
    }
    try { doctorFileItem(file, filingReason(file)); }
    catch (error) { await note('installation', invalidFiling(file, error), 'done', 'escalation'); continue; }
    const filed = await fileDoctorItem(file, filingKey, effects.file);
    if (filed.work) {
      // Filed: any pending retry of the same filing is dropped before the cursor is persisted.
      state.doctor.pendingFiles = state.doctor.pendingFiles.filter(entry => entry.key !== filingKey);
      run.filed.push({ faultClass: file.faultClass, title: file.title, work: filed.work.key, deduplicated: false });
      await note(filed.work.key, `Filed ${filed.work.key} (P${file.priority}) for the ${file.faultClass} fault no open item covered: ${file.title}${mendedClause(filed.mended)}`);
    } else {
      // A filing the control plane would not take is kept on the cursor — before the failed record
      // persists it — so a later cycle files it again under the same stable key; a control plane
      // that was only briefly unreachable loses no P0/P1 fault item (GY-711).
      // GY-1336: queued for that retry, the refusal is handled by design — still failed, but no fault
      // kind, so no loop fault instance (as GY-1295 and GY-1318 did); a retry that fails again is one.
      state.doctor.pendingFiles = [...state.doctor.pendingFiles.filter(entry => entry.key !== filingKey), { key: filingKey, at: run.at, file: filed.file }].slice(-40);
      performed.push(await record(state, filingKey, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Could not file "${file.title}"; it is filed again on a later cycle: ${message(filed.error)}`.slice(0, 2000), attempts: (state.actions[filingKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), daemon.persist, null));
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
 * A filing the control plane did not accept when its run applied is filed again on a later cycle,
 * under the same stable key, until the control plane takes it or an open item comes to cover the
 * class. The cursor is updated before the outcome is recorded, so an abrupt exit between the two
 * leaves the filing pending rather than lost.
 */
export async function retryDoctorFile(cycle: Cycle, effects: DoctorEffects, pending: DoctorPendingFile, now: () => number) {
  const { state, effects: daemon, snapshot } = cycle;
  const attempts = (state.actions[pending.key]?.attempts ?? 0) + 1;
  const drop = async (detail: string, work: string | null, outcome: DaemonAction['state']) => {
    state.doctor.pendingFiles = state.doctor.pendingFiles.filter(entry => entry.key !== pending.key);
    await record(state, pending.key, { kind: 'fault', work, principal: null, state: outcome, detail: detail.slice(0, 2000), attempts, cycle: state.cycle }, now(), daemon.persist);
  };
  if (openFaultClassItem(snapshot.work, pending.file.faultClass)) return drop(`Not filing "${pending.file.title}" on retry: the ${pending.file.faultClass} fault class is now covered by an open item`, null, 'done');
  try { doctorFileItem(pending.file, filingReason(pending.file)); }
  catch (error) {
    // Refused by the checks themselves, the filing would be refused the same way on every retry.
    state.doctor.pendingFiles = state.doctor.pendingFiles.filter(entry => entry.key !== pending.key);
    await record(state, pending.key, { kind: 'escalation', work: null, principal: null, state: 'done', detail: invalidFiling(pending.file, error), attempts, cycle: state.cycle }, now(), daemon.persist);
    return;
  }
  const filed = await fileDoctorItem(pending.file, pending.key, effects.file);
  if (filed.work) return drop(`Filed ${filed.work.key} (P${pending.file.priority}) for the ${pending.file.faultClass} fault on a later cycle: ${pending.file.title}${mendedClause(filed.mended)}`, filed.work.key, 'done');
  // The filing as last sent is what the next cycle retries: a proof mended here is not refused again.
  state.doctor.pendingFiles = state.doctor.pendingFiles.map(entry => entry.key === pending.key ? { ...entry, file: filed.file } : entry);
  await record(state, pending.key, { kind: 'fault', work: null, principal: null, state: 'failed', detail: `Still could not file "${pending.file.title}": ${message(filed.error)}`.slice(0, 2000), attempts, cycle: state.cycle }, now(), daemon.persist);
}

/**
 * Step 7c: the doctor. The deterministic remedies run every cycle; the doctor itself every
 * `run.doctor.intervalMinutes`. A run settles beside the loop and applies its own report (events
 * per item, the summary) when it ends, so no cycle ever waits on a model.
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
  const run = doctorRunRecordSchema.parse({ at: new Date(clock).toISOString(), state: 'running', runs: [], findings: [], actions: [], filed: [], detail: '' });
  state.doctor.runs = [...state.doctor.runs, run].slice(-retainedRuns);
  // Every open item is evidence, oldest stage first: an item that has held its stage longest is the
  // likeliest stuck one, so it leads, and `boundedInput` — not a newest-100 slice — is what bounds
  // the list, saying how many lines it left out.
  const input: DoctorInput = {
    items: snapshot.work.filter(item => item.stage !== 'done' && !isClosed(item))
      .sort((left, right) => Date.parse(left.stageEnteredAt) - Date.parse(right.stageEnteredAt))
      .map(item =>
        `${item.key} [${item.stage} since ${item.stageEnteredAt}${item.lease ? `, lease ${item.lease.owner} epoch ${item.lease.epoch} until ${item.lease.expiresAt}` : ', unclaimed'}]${item.blocker ? ` blocker: ${item.blocker.slice(0, 200)}` : ''}${item.candidate ? ` candidate ${item.candidate.sha.slice(0, 12)} (PR #${item.candidate.pr})` : ''}`),
    faults: state.faults.instances.slice(-40).reverse().map(instance => `${instance.at} ${instance.kind} on ${instance.subject}: ${instance.text}`),
  };
  const prompt = doctorPrompt(cycle.config, input);
  live = runDoctor(doctor, prompt).catch(error => ({ runs: [{ runtime: 'none', model: 'none', result: 'exit', detail: message(error).slice(0, 500) }], report: null }))
    .then(async outcome => {
      const current = state.doctor.runs.find(entry => entry.at === run.at);
      if (!current || current.state !== 'running') return;
      current.runs = outcome.runs;
      current.findings = (outcome.report?.findings ?? []).slice(-50);
      current.actions = (outcome.report?.actions ?? []).slice(-50);
      current.detail = outcome.report ? 'reported' : `no report: ${outcome.runs.map(entry => `${entry.model} ${entry.result}`).join('; ')}`.slice(0, 1000);
      if (!outcome.report) {
        current.state = 'failed';
        // Queued for posting before the fallible record, as the apply-failure path below does: a
        // failed run is never reaped as lost, so the marker is what keeps it retryable.
        state.doctor.unposted = [...new Set([...state.doctor.unposted, current.at])].slice(-40);
        // GY-1318: its models died or the loop's own shutdown cancelled it — the run is still failed,
        // posted and retried, and the next interval's run re-covers, but the loop did not fail to
        // cycle: no fault kind, so no loop fault instance (as GY-1295 did for allowlist refusals).
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

// ---------------------------------------------------------------------------
// The deterministic remedies (AC-3): what the doctor would apply most often needs no judgement,
// so the loop applies it itself, every cycle, without an agent.
// ---------------------------------------------------------------------------

/** The remedies' own record, one key per item and remedy, so each is applied once per situation. */
const remedyKey = (remedy: string, id: string) => `remedy:${remedy}:${id}`;

/**
 * Remedy 1: settle a lapsed containment whose attempt submitted. Its work is on the pull request,
 * so the fence protects nothing once its supervisor is gone. The loop verifies that on this host
 * with the same probe `master settle-containment` runs and settles through the same `autosettle`
 * contract, carrying the probe's verification for the control plane to re-check: a supervisor
 * still present, or a probe the control plane would refuse, is left standing and recorded.
 */
export async function settleSubmittedContainment(cycle: Cycle) {
  const { state, effects, now, snapshot, clock, clockOffset, performed, isolate } = cycle;
  if (!effects.containment || !effects.settleContainment) return;
  for (const item of snapshot.work.filter(item => item.containmentQuarantine
    && item.submission?.epoch === item.containmentQuarantine.epoch && containmentPhase(item, clock)?.state === 'lapsed')) {
    await isolate('settle', item, item.key, async () => {
      const epoch = item.containmentQuarantine!.epoch, key = remedyKey('settle', `${item.id}:${epoch}`);
      // The reclaim step settles a verified-dead fence itself; this remedy is not a second settler of the same one.
      if (['done', 'started'].includes(state.actions[`settle:${item.id}:${epoch}`]?.state ?? '')) return;
      const previous = state.actions[key];
      if (previous && (previous.state === 'done' || !readyToRetry(previous, state.cycle))) return;
      const assessment = (await effects.containment!([item], { now: snapshot.now, clockOffset }))[item.id];
      if (!assessment) return;
      const attempts = (previous?.attempts ?? 0) + 1;
      if (!assessment.settleable || !assessment.verification) {
        const detail = `The lapsed containment of ${item.key} epoch ${epoch}, whose attempt submitted pull request #${item.submission!.pr}, is not verified settleable on this host: ${assessment.refusals.join('; ') || 'the probe returned no verification'}`.slice(0, 2000);
        if (previous?.detail !== detail) performed.push(await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'failed', detail, attempts, epoch, cycle: state.cycle }, now(), effects.persist));
        return;
      }
      await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'started', detail: `Settling the lapsed containment of ${item.key} epoch ${epoch}: the attempt submitted and its supervisor is verified gone`, attempts, epoch, cycle: state.cycle }, now(), effects.persist);
      try {
        await effects.settleContainment!(item, assessment);
        performed.push(await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'done', detail: `Settled the lapsed containment of ${item.key} epoch ${epoch}: the attempt submitted pull request #${item.submission!.pr} and its supervisor is verified gone on ${assessment.host ?? cycle.config.hostId}`, attempts, epoch, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'failed', detail: `Could not settle the lapsed containment of ${item.key} epoch ${epoch} whose attempt submitted: ${message(error)}`, attempts, epoch, cycle: state.cycle }, now(), effects.persist));
      }
    });
  }
}

/** A word of free text that names a file: it has a directory part, or a file extension (`README.md`). */
const pathWord = /^(?:[\w.@-]+\/)+[\w.@-]*$|^[\w@-][\w.@-]*\.[A-Za-z][\w]*$/;

/**
 * The paths a scope-refusal blocker is about, when plannedFiles already covers every one of them,
 * else null. Coverage is judged from the item's structured scope record — the open request's paths,
 * or the paths its last scope decision named — never from the blocker's prose alone, so an item with
 * no such record keeps its blocker. Any file the prose names besides must be planned as well: a
 * refusal that cites a root-level file the record does not carry is not covered.
 */
export function coveredScopePaths(item: Pick<Work, 'blocker' | 'plannedFiles' | 'scopeRequest' | 'scopeDecision'>) {
  const recorded = item.scopeRequest?.paths ?? item.scopeDecision?.paths ?? [];
  if (!recorded.length) return null;
  const words = (item.blocker ?? '').split(/[\s,;()'"`]+/).map(word => word.replace(/[.:,;!?]+$/, '')).filter(word => pathWord.test(word) && !/^https?:/.test(word));
  const named = [...new Set([...recorded, ...words])];
  return unplannedPaths(item.plannedFiles, named).length ? null : named;
}

/**
 * Remedy 2: clear a blocker whose named scope is already in plannedFiles. A scope refusal left the
 * item's blocker standing, and a widening since applied covers every path it names. Clearing it
 * weakens nothing, so the loop applies `unblock` itself as the master's operator-agent identity,
 * bound to the revision it read — the non-weakening intent that identity owns, never requested.
 */
export async function clearCoveredBlockers(cycle: Cycle) {
  const { state, effects, now, snapshot, performed, isolate } = cycle;
  const unblock = effects.unblock;
  if (!unblock) return;
  for (const item of snapshot.work.filter(item => item.stage !== 'done' && item.blocker?.startsWith(scopeRefusalBlocker))) {
    await isolate('decision', item, item.key, async () => {
      // The remedy is only for a scope refusal whose every named path a later widening covered.
      const named = coveredScopePaths(item);
      if (!named) return;
      // Keyed by the revision it read: a blocker set again later is a new situation.
      const key = remedyKey('unblock', `${item.id}:${item.revision}`);
      const previous = state.actions[key];
      if (previous && (previous.state === 'done' || !readyToRetry(previous, state.cycle))) return;
      const attempts = (previous?.attempts ?? 0) + 1;
      try {
        await unblock(item, `The loop cleared ${item.key}'s scope-refusal blocker: every path it names (${named.join(', ')}) is already in plannedFiles, so nothing is widened and nothing is weakened (GY-711).`);
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `Cleared ${item.key}'s blocker as the operator-agent identity: its scope refusal names only paths plannedFiles already covers (${named.join(', ')})`.slice(0, 2000), attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'failed', detail: `Could not clear ${item.key}'s covered scope-refusal blocker: ${message(error)}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
      }
    });
  }
}

/** How long a requested decision may stand with no approver session before the loop relaunches one. */
export const unansweredDecisionMs = 10 * 60_000;

/**
 * Remedy 3: relaunch an approver for a decision unanswered past ten minutes. A requested decision
 * whose approver session is gone is a decision nobody will ever judge; the loop launches a fresh
 * independent session for it, within the launch bound every decision carries.
 */
export async function relaunchUnansweredApprovers(cycle: Cycle) {
  const { state, effects, now, snapshot, clock, performed, agents, isolate, launcher } = cycle;
  const { decisions, approver } = effects;
  if (!decisions || !approver) return;
  const checked = state.doctor.decisionsCheckedAt, held = cycle.heldDecisions;
  for (const id of Object.keys(checked)) if (!snapshot.work.some(item => item.id === id && item.stage !== 'done')) delete checked[id];
  let reads = decisionReadConcurrency;
  for (const item of snapshot.work.filter(item => item.stage !== 'done')) {
    // A history the decisions step holds is current to this cycle's ledger read (GY-1142) and costs
    // nothing. Any other is read at most once per item per `decisionCheckMs`, at most
    // `decisionReadConcurrency` a cycle, and first only `unansweredDecisionMs` after the remedy first
    // sees the item (its check is dated forward so): no decision is relaunched before ten minutes,
    // so an earlier read finds nothing to do and loads the control plane. What the remedy reads
    // joins the held histories, kept until the ledger shows the item's decisions moved.
    const kept = held.histories.get(item.id), last = checked[item.id];
    if (!last) checked[item.id] = new Date(clock + unansweredDecisionMs - decisionCheckMs).toISOString();
    if (!kept && (!last || clock - Date.parse(last) < decisionCheckMs || reads <= 0)) continue;
    if (!kept) { checked[item.id] = new Date(clock).toISOString(); reads -= 1; }
    await isolate('decision', item, item.key, async () => {
      const history = kept ?? await decisions(item).then(result => { held.histories.set(item.id, result.decisions); return result.decisions; }, () => []);
      for (const decision of history.filter(entry => entry.state === 'requested')) {
        if (!decision.requestedAt || clock - Date.parse(decision.requestedAt) < unansweredDecisionMs) continue;
        const name = approverSessionName(item, decision.id);
        if (agents.some(agent => agent.name === name && !stoppedStates.includes(agent.agent_status ?? ''))) continue;
        if (launcher.busy(`launch:approver:${decision.id}`)) continue;
        // A decision the loop watches — its own request, or a `master approver` session it adopted —
        // is relaunched and escalated by its approval supervision (GY-551); a second launcher here
        // would double its sessions and spend its bound twice. This remedy covers the rest.
        if (Object.values(state.approvals).some(entry => entry.decision === decision.id)) continue;
        const key = remedyKey('approver', decision.id);
        const previous = state.actions[key];
        // A replacement that also left without judging is relaunched again once the decision has
        // stood unanswered another ten minutes, within the launch bound every decision carries, so a
        // decision requested with no approver at all is never given up on.
        if (previous && (previous.attempts >= maxApproverLaunches || (previous.state === 'done' ? clock - Date.parse(previous.at) < unansweredDecisionMs : !readyToRetry(previous, state.cycle)))) continue;
        const attempts = (previous?.attempts ?? 0) + 1;
        const relaunch = async (sink: DaemonAction[]) => {
          try {
            const launched = await approver(item, decision.id);
            sink.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `Relaunched approver ${launched.agentName} for ${item.key}'s unanswered ${decision.action} decision ${decision.id} (requested ${decision.requestedAt}, unanswered past ${unansweredDecisionMs / 60_000} min; launch ${attempts} of ${maxApproverLaunches})`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
          } catch (error) {
            sink.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'failed', detail: `Could not relaunch the approver for ${item.key}'s unanswered decision ${decision.id}: ${message(error)}`, attempts, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
          }
        };
        // The launch runs on the launcher beside the loop's cycle (GY-616), as the loop's own approver
        // launches do, so slow launches never hold up this cycle's merges and dispatches; its result
        // is reported next cycle. A cycle run on its own launches in place.
        if (cycle.detached) cycle.launch('decision', item, `launch:approver:${decision.id}`, [], relaunch);
        else await relaunch(performed);
      }
    });
  }
}

/** How often the approver remedy reads one item's decision history. */
export const decisionCheckMs = 2 * 60_000;

/** The three deterministic remedies, every cycle, before the doctor itself is scheduled. */
export async function routineRemedies(cycle: Cycle) {
  await settleSubmittedContainment(cycle);
  await clearCoveredBlockers(cycle);
  await relaunchUnansweredApprovers(cycle);
}

/** The runs `master status` reports under daemon.doctor, newest first. */
export function doctorReport(state: Pick<DaemonState, 'doctor'>, limit = 10) {
  return { running: state.doctor.runs.some(entry => entry.state === 'running'), recent: [...state.doctor.runs].reverse().slice(0, limit) };
}
