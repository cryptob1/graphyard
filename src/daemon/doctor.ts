// Concern: the pipeline doctor (GY-711) — the loop's ten-minute remedy worker, and the
// deterministic remedies the loop applies itself without an agent.
import { createHash } from 'node:crypto';
import type { Work } from '../model.js';
import { createSchema } from '../model.js';
import { isClosed } from '../model/closure.js';
import { openFaultClassItem } from '../model/fault-classes.js';
import { scopeRefusalBlocker, unplannedPaths } from '../model/scope.js';
import { approverSessionName, guardBroadScope } from '../master/autonomy.js';
import { containmentPhase } from '../master.js';
import { doctorReportPayloadSchema, doctorRunRecordSchema, doctorSettings, graphyardTools, type DoctorAction, type DoctorFile, type DoctorFinding, type DoctorRunRecord, type DoctorSettings } from '../runner/payloads.js';
import type { Runner } from '../runner/types.js';
import { readyToRetry } from './sessions.js';
import { stoppedStates, record } from './effects.js';
import { maxApproverLaunches } from './decisions.js';
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

/** The fault bounds of the doctor's checks, in minutes, as the shipped template states them. */
export const doctorBounds = {
  blockedMinutes: 10, workerMinutes: 60, ciMinutes: 20, reviewRequestMinutes: 5, launchMinutes: 2,
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
export function doctorDue(state: Pick<DaemonState, 'doctor'>, clock: number, settings: Pick<DoctorSettings, 'intervalMinutes' | 'enabled'>) {
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
  const cli = `node ${config.cliPath}`, b = doctorBounds;
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
    + `Act only where a check below has passed its fault bound; leave what is merely moving. Your sanctioned commands are ${doctorSanctionedCommands.map(name => `${cli} master ${name}`).join(', ')}, as the master's operator-agent identity; every other mutation is refused by your command allowlist — never merge, dispatch, submit evidence or touch a lease — and a refused command is recorded in your report, never retried. Never weaken a requirement; never approve a decision you requested yourself (request it, then ${cli} master approver GY-N DECISION for an independent approver). `
    + `A finding you cannot act on — a human-only decision (goals and priorities, money or accounts, credentials for people), or a fault class with no item to act through — mark unactionable; for the latter name the fault item to file, which the loop files at P0/P1 only if no open item already covers it. `
    + `Then call the ${graphyardTools.doctor} tool exactly once: one finding per stuck or overdue item under its check, one action entry per sanctioned command you ran and what it changed, and one filed entry per fault item you are asking the loop to file. Stop after the call.\n\nThe checks and their bounds:\n${checklist}\n\nThe evidence, as JSON:\n${JSON.stringify(input).slice(0, 100_000)}`;
}

/** Run the primary attempt, and the fallback once when the primary returns no valid report. */
async function runDoctor(effects: DoctorEffects, prompt: string) {
  const runs: DoctorRunRecord['runs'] = [], timeoutMs = effects.settings.timeoutMinutes * 60_000;
  for (const attempt of ['primary', 'fallback'] as const) {
    let chosen: Awaited<ReturnType<DoctorEffects['runner']>>;
    try { chosen = await effects.runner(attempt); }
    catch (error) { runs.push({ runtime: 'none', model: attempt, result: 'spawn', detail: `No ${attempt} runner: ${message(error)}`.slice(0, 500) }); continue; }
    const run = chosen.runner.start(prompt, { cwd: effects.cwd, env: { ...effects.env, GRAPHYARD_PI_ROLE: doctorRole }, tool: graphyardTools.doctor, timeoutMs,
      validate: payload => doctorReportPayloadSchema.parse(payload) });
    const result = await run.result();
    await Promise.resolve(chosen.release?.(`the ${attempt} doctor run ended`)).catch(() => {});
    runs.push({ runtime: chosen.runtime, model: chosen.model, result: result.ok ? 'reported' : result.failure.reason,
      detail: (result.ok ? `${result.payload.findings.length} finding(s), ${result.payload.actions.length} action(s), ${result.payload.filed.length} to file` : result.failure.detail).slice(0, 500) });
    if (result.ok) return { runs, report: result.payload };
    if (result.failure.reason === 'cancelled') break;
  }
  return { runs, report: null };
}

/** One doctor run this process has in flight, settled: a test's way to wait for it. */
let live: Promise<void> | null = null;
export async function doctorRunsSettled() { await live; }
/** Test seam: forget every run in flight. */
export function clearDoctorRuns() { live = null; }

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

/** The fault item a doctor run files, as `master create` would: the create schema's checks, P0/P1, and the class it closes. */
export function doctorFileItem(entry: DoctorFile, reason: string): DoctorFileInput {
  const input = createSchema.parse({ title: entry.title, description: entry.description, type: 'bug', priority: entry.priority, criteria: entry.criteria, plannedFiles: entry.plannedFiles,
    origin: { faultClass: { class: entry.faultClass, threshold: 1, windowHours: 1, count: 1, detectedAt: new Date().toISOString(), instances: [] } } });
  return { ...input, reason: guardBroadScope(input, reason, { allow: false, command: 'master create' }) };
}

/**
 * Apply one settled doctor run: record one event per item the run found or acted on, deduplicate
 * and file what it asked filed, and keep one run summary — what was stuck, why, what it did, what
 * it filed — on the cursor and the control plane.
 */
export async function applyDoctorRun(cycle: Cycle, effects: DoctorEffects, run: DoctorRunRecord, payload: { findings: DoctorFinding[]; actions: DoctorAction[]; filed: DoctorFile[] }, now: () => number) {
  const { state, effects: daemon, snapshot, performed } = cycle;
  const key = keyOf([run.at, ...payload.findings.map(finding => finding.subject)]);
  const note = async (subject: string, detail: string, outcome: DaemonAction['state'] = 'done') => {
    const itemKey = subjectKey(snapshot.work, subject);
    performed.push(await record(state, `${key}:${subject}:${performed.length}`, { kind: 'doctor', work: itemKey, principal: null, state: outcome, detail, attempts: 1, cycle: state.cycle }, now(), daemon.persist));
  };
  for (const finding of payload.findings)
    await note(finding.subject, `${finding.check} bound passed${finding.unactionable ? ', unactionable' : ''}: ${finding.detail}`.slice(0, 2000));
  for (const action of payload.actions)
    await note(action.subject, `${action.outcome === 'applied' ? 'Ran' : 'Was refused'} \`${action.command}\`: ${action.detail}`.slice(0, 2000), action.outcome === 'applied' ? 'done' : 'failed');
  const deduped = dedupDoctorFiles(payload.filed, snapshot.work);
  for (const { file, covered } of deduped) {
    if (covered) { await note('installation', `Not filing "${file.title}": the ${file.faultClass} fault class is already covered by an open item`); continue; }
    try {
      const filedItem = await effects.file(doctorFileItem(file, `The pipeline doctor found a ${file.faultClass} fault no open item covers: ${file.description.slice(0, 1500)}`), `${key}:file:${file.faultClass}`);
      run.filed.push({ faultClass: file.faultClass, title: file.title, work: filedItem.key, deduplicated: false });
      await note(filedItem.key, `Filed ${filedItem.key} (P${file.priority}) for the ${file.faultClass} fault no open item covered: ${file.title}`);
    } catch (error) { await note('installation', `Could not file "${file.title}": ${message(error)}`, 'failed'); }
  }
  run.state = 'reported';
  run.detail = `${run.findings.length} finding(s), ${run.actions.length} action(s), ${run.filed.length} filed, ${deduped.filter(entry => entry.covered).length} deduplicated: ${run.detail}`.slice(0, 1000);
  // The run record is already on the cursor's list; only its state, summary and filings move here.
  performed.push(await record(state, key, { kind: 'doctor', work: null, principal: null, state: 'done', detail: run.detail, attempts: 1, cycle: state.cycle }, now(), daemon.persist));
  await effects.recordRun?.(run).catch(() => { /* the cursor's copy stands; the next run posts again */ });
}

const retainedRuns = 20;

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
    // The run settles beside the loop and applies its own report when it ends (see `live` below);
    // only a run this process lost — a restart — is failed here, past its bound.
    if (live || clock - Date.parse(inFlight.at) < 2 * doctor.settings.timeoutMinutes * 60_000 + lostRunGraceMs) return;
    inFlight.state = 'failed';
    inFlight.detail = `The doctor run started ${inFlight.at} never ended in this process; it is recorded as lost`.slice(0, 1000);
    await record(state, `doctor:${inFlight.at}`, { kind: 'doctor', work: null, principal: null, state: 'failed', detail: inFlight.detail, attempts: 1, cycle: state.cycle }, now(), effects.persist);
    await doctor.recordRun?.(inFlight).catch(() => {});
    return;
  }
  if (!doctorDue(state, clock, doctor.settings)) return;
  const run = doctorRunRecordSchema.parse({ at: new Date(clock).toISOString(), state: 'running', runs: [], findings: [], actions: [], filed: [], detail: '' });
  state.doctor.runs = [...state.doctor.runs, run].slice(-retainedRuns);
  const input: DoctorInput = {
    items: snapshot.work.filter(item => item.stage !== 'done' && !isClosed(item)).slice(-100).map(item =>
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
        await record(state, `doctor:${current.at}`, { kind: 'doctor', work: null, principal: null, state: 'failed', detail: `The doctor run returned no report: ${current.detail}`, attempts: 1, cycle: state.cycle }, now(), effects.persist);
        await doctor.recordRun?.(current).catch(() => {});
        return;
      }
      await applyDoctorRun(cycle, doctor, current, outcome.report, now);
    })
    .finally(() => { live = null; });
}

/** How long past its bound a run recorded as running, with no run in this process, is waited for before it is recorded as lost. */
export const lostRunGraceMs = 5 * 60_000;

// ---------------------------------------------------------------------------
// The deterministic remedies (AC-3): what the doctor would apply most often needs no judgement,
// so the loop applies it itself, every cycle, without an agent.
// ---------------------------------------------------------------------------

/** The remedies' own record, one key per item and remedy, so each is applied once per situation. */
const remedyKey = (remedy: string, id: string) => `remedy:${remedy}:${id}`;

/**
 * Remedy 1: settle a lapsed containment whose attempt submitted. Its work is on the pull request,
 * so the dead supervisor protects nothing: the fence is lowered without the probe the
 * never-submitted case still requires.
 */
export async function settleSubmittedContainment(cycle: Cycle) {
  const { state, effects, now, snapshot, clock, performed, isolate } = cycle;
  for (const item of snapshot.work.filter(item => item.stage !== 'done' && item.containmentQuarantine
    && item.submission?.epoch === item.containmentQuarantine.epoch && containmentPhase(item, clock)?.state === 'lapsed')) {
    await isolate('settle', item, item.key, async () => {
      const quarantine = item.containmentQuarantine!, epoch = quarantine.epoch, key = remedyKey('settle', `${item.id}:${epoch}`);
      const previous = state.actions[key];
      if (previous && (previous.state === 'done' || !readyToRetry(previous, state.cycle))) return;
      if (!effects.settleContainment) return;
      await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'started', detail: `Settling the lapsed containment of ${item.key} epoch ${epoch}: the attempt submitted its work, so the fence protects nothing`, attempts: (previous?.attempts ?? 0) + 1, epoch, cycle: state.cycle }, now(), effects.persist);
      try {
        await effects.settleContainment(item, { key: item.id, id: item.id, epoch, owner: quarantine.owner, at: quarantine.at, host: cycle.config.hostId, workspacePath: null, scope: quarantine.scope ?? null,
          settleable: true, refusals: [], attestation: 'the attempt submitted its work, so no supervisor remains to verify', verification: null });
        performed.push(await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'done', detail: `Settled the lapsed containment of ${item.key} epoch ${epoch} without a probe: the attempt submitted, so its work is on pull request #${item.submission!.pr}`, attempts: 1, epoch, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'settle', work: item.key, principal: null, state: 'failed', detail: `Could not settle the lapsed containment of ${item.key} epoch ${epoch} whose attempt submitted: ${message(error)}`, attempts: 1, epoch, cycle: state.cycle }, now(), effects.persist));
      }
    });
  }
}

/**
 * Remedy 2: clear a blocker whose named scope is already in plannedFiles. A scope refusal left the
 * item's blocker standing, and a widening since applied covers every path it names: the loop
 * requests the `unblock` decision as the master's operator-agent identity for the approver to apply.
 */
export async function clearCoveredBlockers(cycle: Cycle) {
  const { state, effects, now, snapshot, performed, isolate } = cycle;
  const decide = effects.decide;
  if (!decide) return;
  for (const item of snapshot.work.filter(item => item.stage !== 'done' && item.blocker?.startsWith(scopeRefusalBlocker))) {
    await isolate('decision', item, item.key, async () => {
      // The remedy is only for a scope refusal whose every named path a later widening covered.
      const named = item.blocker!.match(/[\w.@-]+(?:\/[\w.@-]+)+/g) ?? [];
      if (!named.length || unplannedPaths(item.plannedFiles, named).length) return;
      const key = remedyKey('unblock', item.id);
      const previous = state.actions[key];
      if (previous && (previous.state === 'done' || !readyToRetry(previous, state.cycle))) return;
      await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'started', detail: `Requesting the unblock decision for ${item.key}: its blocker names only paths plannedFiles already covers`, attempts: (previous?.attempts ?? 0) + 1, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist);
      try {
        const decision = await decide(item, 'unblock', `${item.key}'s blocker stands on scope plannedFiles already covers: ${item.blocker!.slice(0, 500)}. The loop requests it be cleared; nothing outside plannedFiles is asked for.`, { expectedRevision: item.revision });
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `Requested unblock decision ${decision.id} for ${item.key}: the blocker names only paths plannedFiles already covers`, attempts: 1, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'failed', detail: `Could not request the unblock decision for ${item.key}: ${message(error)}`, attempts: 1, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
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
  for (const item of snapshot.work.filter(item => item.stage !== 'done')) {
    await isolate('decision', item, item.key, async () => {
      const history = await decisions(item).then(result => result.decisions, () => []);
      for (const decision of history.filter(entry => entry.state === 'requested')) {
        if (!decision.requestedAt || clock - Date.parse(decision.requestedAt) < unansweredDecisionMs) continue;
        const name = approverSessionName(item, decision.id);
        if (agents.some(agent => agent.name === name && !stoppedStates.includes(agent.agent_status ?? ''))) continue;
        if (launcher.busy(`launch:approver:${decision.id}`)) continue;
        const watch = Object.values(state.approvals).find(entry => entry.decision === decision.id);
        if (watch && (watch.launches >= maxApproverLaunches || watch.exhaustedAt)) continue;
        const key = remedyKey('approver', decision.id);
        const previous = state.actions[key];
        if (previous && (previous.state === 'done' || !readyToRetry(previous, state.cycle))) continue;
        try {
          const launched = await approver(item, decision.id);
          if (watch) Object.assign(watch, { launches: watch.launches + 1, agentName: launched.agentName, pane: launched.pane, launchedAt: new Date(clock).toISOString() });
          performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'done', detail: `Relaunched approver ${launched.agentName} for ${item.key}'s unanswered ${decision.action} decision ${decision.id} (requested ${decision.requestedAt}, unanswered past ${unansweredDecisionMs / 60_000} min)`, attempts: (previous?.attempts ?? 0) + 1, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
        } catch (error) {
          performed.push(await record(state, key, { kind: 'decision', work: item.key, principal: null, state: 'failed', detail: `Could not relaunch the approver for ${item.key}'s unanswered decision ${decision.id}: ${message(error)}`, attempts: (previous?.attempts ?? 0) + 1, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
        }
      }
    });
  }
}

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
