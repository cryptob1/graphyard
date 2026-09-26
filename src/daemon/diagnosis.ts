// Concern: the diagnostician (GY-439) — each recurring-fault item, and each invariant violation that
// persists past its bound, gets one headless diagnosis, and the diagnosis becomes a closure or a fix
// item through the normal two-party decision.
import { createHash } from 'node:crypto';
import { createSchema, type Work } from '../model.js';
import { isClosed } from '../model/closure.js';
import { closesFaultClass, faultClassMeaning, openFaultClassItem, type FaultClass, type FaultInstance } from '../model/fault-classes.js';
import { guardBroadScope } from '../master/autonomy.js';
import { diagnosisPayloadSchema, diagnosisSettled, graphyardTools, type DiagnosisPayload, type DiagnosisRecord, type DiagnosticianSettings } from '../runner/payloads.js';
import type { Runner } from '../runner/types.js';
import { type DaemonAction, type DaemonState, message } from './state.js';
import { record } from './effects.js';
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
/** The runner one attempt uses, what it runs on, and how its registry session (if any) is ended. */
export interface DiagnosticianRun { runner: Runner; runtime: string; model: string; release?: (reason: string) => Promise<unknown> }
export interface DiagnosticianEffects {
  settings: DiagnosticianSettings;
  /** The repository checkout the diagnostician reads: the loop's own. */
  cwd: string;
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

interface Outcome { runs: DiagnosisRecord['runs']; diagnosis: DiagnosisPayload | null }
const live = new Map<string, Promise<void>>();
const outcomes = new Map<string, Outcome>();
/** Every diagnostician run this process has in flight, settled: a test's way to wait for them. */
export async function diagnosesSettled() { await Promise.all([...live.values()]); }
/** Test seam: forget every run and outcome. */
export function clearDiagnoses() { live.clear(); outcomes.clear(); }

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
/** The last lines of an excerpt that fit `budget` characters, each clipped. */
export function excerpt(lines: readonly string[], budget: number, lineLimit = 400) {
  const kept: string[] = [];
  let used = 0;
  for (const line of [...lines].reverse()) {
    const clipped = clip(line, lineLimit);
    if (used + clipped.length + 1 > budget) break;
    kept.unshift(clipped); used += clipped.length + 1;
  }
  return kept;
}

/**
 * What needs a diagnosis now: every open recurring-fault item not yet diagnosed, and every
 * invariant violation standing past the bound, unlinked and not yet diagnosed.
 */
export function diagnosisSubjects(state: Pick<DaemonState, 'faults' | 'diagnoses'>, work: readonly Work[], clock: number, settings: Pick<DiagnosticianSettings, 'invariantBoundMinutes'>): DiagnosisSubject[] {
  const subjects: DiagnosisSubject[] = [];
  for (const item of work) {
    const faultClass = closesFaultClass(item);
    if (!faultClass || item.stage === 'done' || isClosed(item) || state.diagnoses[item.key]) continue;
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
    if (!isInvariantKind(instance.kind) || !standing.has(instance.id) || instance.linkedTo || state.diagnoses[instance.id]) continue;
    if (Date.parse(instance.at) + bound > clock) continue;
    subjects.push({ id: instance.id, kind: 'invariant', faultClass: instance.faultClass, work: null, instances: [instance] });
  }
  return subjects;
}

/** The pull requests the subject names: `#N` or `PR N` in its instances, and the candidates of the items its instances are on. */
export function namedPullRequests(subject: DiagnosisSubject, work: readonly Work[], limit = 5) {
  const numbers = new Set<number>();
  for (const instance of subject.instances) {
    for (const match of `${instance.subject} ${instance.text}`.matchAll(/(?:#|\bPR\s*#?|pull request\s*#?)(\d{1,7})\b/gi)) numbers.add(Number(match[1]));
    const item = work.find(entry => entry.key === instance.subject);
    const pr = item?.candidate?.pr ?? item?.submission?.pr;
    if (pr) numbers.add(pr);
  }
  return [...numbers].slice(0, limit);
}

/** Everything the diagnostician is given, bounded so the prompt stays one argument. */
export function diagnosisInput(subject: DiagnosisSubject, context: DiagnosisContext, work: readonly Work[]) {
  const open = work.filter(item => item.stage !== 'done' && !isClosed(item) && item.key !== subject.work?.key);
  return {
    subject: subject.id, kind: subject.kind, faultClass: subject.faultClass, meaning: faultClassMeaning[subject.faultClass],
    item: subject.work ? { key: subject.work.key, title: subject.work.title, description: clip(subject.work.description ?? '', 6000) } : null,
    instances: subject.instances.slice(-40).map(entry => ({ at: entry.at, lastSeenAt: entry.lastSeenAt, kind: entry.kind, subject: entry.subject, text: clip(entry.text, 300) })),
    journal: excerpt(context.journal, 24_000),
    serverLog: excerpt(context.serverLog, 16_000),
    pullRequests: context.pullRequests.slice(0, 5).map(entry => ({ number: entry.number, state: clip(JSON.stringify(entry.state ?? null), 2000) })),
    openItems: excerpt(open.map(item => `${item.key} [${item.stage}${item.ready ? ', ready' : ''}] ${item.title}`), 8_000, 200),
  };
}
export type DiagnosisInput = ReturnType<typeof diagnosisInput>;

export function diagnosisPrompt(config: { repository: string; cliPath: string }, input: DiagnosisInput) {
  const cli = `node ${config.cliPath}`;
  const what = input.kind === 'recurring'
    ? `the recurring-fault item ${input.item!.key} ("${input.item!.title}"), which the master loop filed because the ${input.faultClass} fault class (${input.meaning}) recurred`
    : `the invariant violation ${input.subject}, which has stood past its bound`;
  return `You are the Graphyard diagnostician for ${config.repository}. Diagnose ${what}. Find the one root cause its instances share, as a senior engineer on this codebase would: read the evidence below, the repository in this checkout, and the control plane (${cli} status GY-N, ${cli} master status, gh pr view N). `
    + 'This session is read-only: never edit, commit, push, claim, release, close, merge or decide anything, and never ask anyone anything. '
    + `Then call the ${graphyardTools.diagnose} tool exactly once with subject "${input.subject}", the cause, the evidence it rests on (log lines quoted exactly, and the commands you ran with what they showed), the fault class the cause belongs to, and exactly one answer: `
    + 'covering, the key of an existing open item (listed below) that already covers this cause, when one does; otherwise fix, the root-cause item to file — a title, a description stating the cause and evidence, the priority to release it at (0 highest to 4), testable criteria each with its proofs (such as unit:name), and the narrow plannedFiles the fix changes. Stop after the call.\n\n'
    + `The evidence, as JSON:\n${clip(JSON.stringify(input), diagnosisEvidenceMax)}`;
}
/** The evidence's bound in the prompt: the prompt is one process argument, which Linux caps at 128 KiB. */
export const diagnosisEvidenceMax = 100_000;

/** Run the primary attempt, and the fallback once when the primary returns no valid diagnosis. */
async function runDiagnosis(diagnostician: DiagnosticianEffects, subject: DiagnosisSubject, prompt: string): Promise<Outcome> {
  const runs: DiagnosisRecord['runs'] = [], timeoutMs = diagnostician.settings.timeoutMinutes * 60_000;
  for (const attempt of ['primary', 'fallback'] as const) {
    const startedAt = new Date().toISOString();
    let chosen: DiagnosticianRun;
    try { chosen = await diagnostician.runner(attempt, subject); }
    catch (error) { runs.push({ runtime: 'none', model: attempt, startedAt, endedAt: new Date().toISOString(), result: 'spawn', detail: clip(`No ${attempt} runner: ${message(error)}`, 500) }); continue; }
    const run = chosen.runner.start(prompt, { cwd: diagnostician.cwd, env: { GRAPHYARD_PI_ROLE: diagnosticianRole }, tool: graphyardTools.diagnose, timeoutMs,
      validate: payload => {
        const parsed = diagnosisPayloadSchema.parse(payload);
        if (parsed.subject !== subject.id) throw new Error(`the diagnosis names ${parsed.subject}, not ${subject.id}`);
        return parsed;
      } });
    const result = await run.result();
    await Promise.resolve(chosen.release?.(`the ${attempt} diagnosis of ${subject.id} ended`)).catch(() => {});
    runs.push({ runtime: chosen.runtime, model: chosen.model, startedAt, endedAt: new Date().toISOString(), result: result.ok ? 'diagnosed' : result.failure.reason,
      detail: clip(result.ok ? `Diagnosed as ${result.payload.faultClass}: ${result.payload.cause}` : result.failure.detail, 500) });
    if (result.ok) return { runs, diagnosis: result.payload };
    if (result.failure.reason === 'cancelled') break;
  }
  return { runs, diagnosis: null };
}

const iso = (at: number) => new Date(at).toISOString();
const diagnosisKey = (subject: string) => `diagnosis:${createHash('sha256').update(subject).digest('hex').slice(0, 24)}`;
/** How long past its bound a run recorded as running, with no run in this process, is waited for before it is recorded as lost. */
export const diagnosisLostGraceMs = 5 * 60_000;

/** The fix item as `master create` would file it: the create schema's checks and the broad-scope guard, unflagged. */
export function fixItem(entry: Pick<DiagnosisRecord, 'subject' | 'kind' | 'work'>, diagnosis: DiagnosisPayload): FixInput {
  const fix = diagnosis.fix!;
  const answers = entry.kind === 'recurring' ? `the recurring-fault item ${entry.work}` : `the invariant violation ${entry.subject}`;
  const description = clip([
    fix.description,
    `Filed by the master loop from the diagnostician's diagnosis of ${answers} (GY-439). Cause: ${diagnosis.cause}`,
    `Evidence:\n${[...diagnosis.evidence.logLines.map(line => `- log: ${line}`), ...diagnosis.evidence.commands.map(line => `- ran: ${line}`)].join('\n')}`,
  ].join('\n\n'), 20_000);
  const input = createSchema.parse({ title: fix.title, description, type: fix.type, priority: fix.priority, criteria: fix.criteria, plannedFiles: fix.plannedFiles });
  const reason = guardBroadScope(input, `The diagnostician found the root cause of ${answers}: ${clip(diagnosis.cause, 1500)}`, { allow: false, command: 'master create' });
  return { ...input, reason };
}

/**
 * Step 7c: launch a diagnosis for every subject that needs one, fold the runs that ended, and move
 * every diagnosis on by one decision: request it, launch its approver, or act on its outcome.
 */
export async function diagnosisStep(cycle: Cycle) {
  const { state, effects, now, snapshot, clock, performed } = cycle;
  const diagnostician = effects.diagnostician;
  if (!diagnostician || !diagnostician.settings.enabled) return;
  const note = async (entry: DiagnosisRecord, outcome: DaemonAction['state'], detail: string) => {
    entry.detail = clip(detail, 1000); entry.updatedAt = iso(now());
    performed.push(await record(state, diagnosisKey(entry.subject), { kind: 'diagnosis', work: entry.work ?? entry.fix, principal: null, state: outcome, detail,
      attempts: (state.actions[diagnosisKey(entry.subject)]?.attempts ?? 0) + (outcome === 'failed' ? 1 : 0), cycle: state.cycle }, now(), effects.persist));
  };
  for (const subject of diagnosisSubjects(state, snapshot.work, clock, diagnostician.settings)) {
    await cycle.isolate('diagnosis', subject.work, `the diagnosis of ${subject.id}`, () => launch(cycle, diagnostician, subject, note));
  }
  for (const entry of Object.values(state.diagnoses)) {
    if (diagnosisSettled(entry)) continue;
    const item = entry.work ? snapshot.work.find(candidate => candidate.key === entry.work) ?? null : null;
    await cycle.isolate('diagnosis', item, `the diagnosis of ${entry.subject}`, () => advance(cycle, diagnostician, entry, note));
  }
}

type Note = (entry: DiagnosisRecord, outcome: DaemonAction['state'], detail: string) => Promise<void>;

async function launch(cycle: Cycle, diagnostician: DiagnosticianEffects, subject: DiagnosisSubject, note: Note) {
  const { config, state, snapshot, clock } = cycle;
  const entry: DiagnosisRecord = { subject: subject.id, kind: subject.kind, faultClass: subject.faultClass, work: subject.work?.key ?? null, state: 'running',
    startedAt: iso(clock), updatedAt: iso(clock), runs: [], diagnosis: null, fix: null, decision: null, answeredBy: null, detail: '' };
  state.diagnoses[subject.id] = entry;
  const context = await diagnostician.context(subject, namedPullRequests(subject, snapshot.work))
    .catch(error => ({ journal: [`(the excerpts could not be read: ${message(error)})`], serverLog: [], pullRequests: [] }));
  const prompt = diagnosisPrompt(config, diagnosisInput(subject, context, snapshot.work));
  const running = runDiagnosis(diagnostician, subject, prompt).catch(error => ({ runs: [{ runtime: 'none', model: 'none', startedAt: iso(clock), endedAt: new Date().toISOString(), result: 'exit', detail: clip(message(error), 500) }], diagnosis: null }))
    .then(outcome => { outcomes.set(subject.id, outcome); }).finally(() => live.delete(subject.id));
  live.set(subject.id, running);
  await note(entry, 'done', `Launched the diagnostician for ${subject.kind === 'recurring' ? `recurring-fault item ${subject.id}` : `invariant violation ${subject.id}`} (${subject.instances.length} instance(s)) on ${diagnostician.settings.model}, falling back to ${diagnostician.settings.fallbackModel}`);
}

async function advance(cycle: Cycle, diagnostician: DiagnosticianEffects, entry: DiagnosisRecord, note: Note) {
  const { state, effects, snapshot, clock } = cycle;
  if (entry.state === 'running') {
    const outcome = outcomes.get(entry.subject);
    if (!outcome) {
      // A run this process is not running whose bound has passed was lost with a restart.
      const bound = Date.parse(entry.startedAt) + 2 * diagnostician.settings.timeoutMinutes * 60_000 + diagnosisLostGraceMs;
      if (!live.has(entry.subject) && clock > bound) { entry.state = 'failed'; await note(entry, 'failed', `The diagnosis of ${entry.subject} started ${entry.startedAt} never ended in this process; the master diagnoses it by hand`); }
      return;
    }
    outcomes.delete(entry.subject);
    entry.runs = outcome.runs.slice(-4);
    if (!outcome.diagnosis) { entry.state = 'failed'; await note(entry, 'failed', `The diagnostician returned no diagnosis of ${entry.subject}: ${outcome.runs.map(run => `${run.model} ${run.result}: ${run.detail}`).join('; ')}`); return; }
    entry.diagnosis = outcome.diagnosis; entry.state = 'diagnosed';
    await note(entry, 'done', `Diagnosed ${entry.subject} as ${outcome.diagnosis.faultClass}: ${outcome.diagnosis.cause}`);
  }
  const subjectItem = entry.work ? snapshot.work.find(item => item.key === entry.work) ?? null : null;
  if (entry.state === 'diagnosed') {
    const diagnosis = entry.diagnosis!;
    if (entry.kind === 'recurring' && (!subjectItem || subjectItem.stage === 'done')) { entry.state = 'failed'; await note(entry, 'failed', `${entry.work} is no longer open, so its diagnosis is not acted on`); return; }
    if (diagnosis.covering) {
      const covering = snapshot.work.find(item => item.key === diagnosis.covering);
      if (!covering || covering.stage === 'done' || covering.key === entry.work) { entry.state = 'failed'; await note(entry, 'failed', `The diagnosis names ${diagnosis.covering} as covering ${entry.subject}, but it is not another open item`); return; }
      if (entry.kind === 'invariant') return answer(state, entry, covering.key, note);
      return request(cycle, diagnostician, entry, subjectItem!, 'close', { kind: 'duplicate', ref: covering.key },
        `${entry.work} recurs from a cause ${covering.key} already covers, so it is closed as its duplicate. Diagnosis: ${diagnosis.cause}`, note);
    }
    let input: FixInput;
    try { input = fixItem(entry, diagnosis); }
    catch (error) { entry.state = 'failed'; await note(entry, 'failed', `The diagnostician's fix item for ${entry.subject} fails the checks master create applies: ${message(error)}`); return; }
    const fix = await diagnostician.file(input, `${diagnosisKey(entry.subject)}:fix`);
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
    entry.state = current.state === 'refused' ? 'refused' : 'failed';
    return note(entry, 'failed', `The ${decision.action} decision ${decision.id} on ${decision.work} was ${current.state}: ${current.refusal?.reason ?? current.outcome ?? 'no reason recorded'}; the diagnosis stands for the master to act on`);
  }
  if (current.state !== 'applied') return;
  if (entry.state === 'releasing') {
    await note(entry, 'done', `${decision.work} was released on the approved decision ${decision.id} (approved by ${current.approvedBy})`);
    if (entry.kind === 'invariant') return answer(state, entry, decision.work, note);
    return request(cycle, diagnostician, entry, subjectItem!, 'close', { kind: 'duplicate', ref: decision.work },
      `${entry.work} is answered by ${decision.work}, the root-cause fix released on decision ${decision.id}, so it is closed as its duplicate; a recurrence after ${decision.work} is delivered files afresh`, note);
  }
  return answer(state, entry, entry.fix ?? entry.diagnosis!.covering!, note, `${entry.work} was closed on the approved decision ${decision.id} (approved by ${current.approvedBy})`);
}

/** Request the decision as the master's operator-agent identity, then launch its independent approver. */
async function request(cycle: Cycle, diagnostician: DiagnosticianEffects, entry: DiagnosisRecord, work: Work, action: 'release' | 'close', input: Record<string, unknown>, reason: string, note: Note) {
  const decision = await diagnostician.decide(work, action, clip(reason, 2000), input);
  entry.decision = { id: decision.id, action, work: work.key, approver: null };
  entry.state = action === 'release' ? 'releasing' : 'closing';
  await note(entry, 'done', `Requested ${action} decision ${decision.id} on ${work.key} for the diagnosis of ${entry.subject}`);
  return launchApprover(cycle, entry, work, note);
}
/** The independent approver for the entry's decision; a launch that fails is tried again next cycle while the decision stands. */
async function launchApprover(cycle: Cycle, entry: DiagnosisRecord, work: Work, note: Note) {
  const decision = entry.decision!;
  if (!cycle.effects.approver) return;
  try {
    const launched = await cycle.effects.approver(work, decision.id);
    decision.approver = launched.agentName;
    await note(entry, 'done', `Launched approver ${launched.agentName} for ${decision.action} decision ${decision.id} on ${work.key}`);
  } catch (error) { await note(entry, 'failed', `Could not launch the approver for ${decision.action} decision ${decision.id} on ${work.key}: ${message(error)}; it is launched again next cycle`); }
}

/** The subject is answered by `by`: an invariant violation's instance is linked to it; a recurring item's closure already names it. */
async function answer(state: DaemonState, entry: DiagnosisRecord, by: string, note: Note, detail?: string) {
  if (entry.kind === 'invariant') { const instance = state.faults.instances.find(candidate => candidate.id === entry.subject); if (instance) instance.linkedTo = by; }
  entry.answeredBy = by; entry.state = 'answered';
  await note(entry, 'done', detail ?? `${entry.subject} is answered by ${by}`);
}

/** The diagnoses `master status` reports under daemon.diagnoses, newest first. */
export function diagnosisReport(state: Pick<DaemonState, 'diagnoses'>, limit = 20) {
  const entries = Object.values(state.diagnoses).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { inFlight: entries.filter(entry => !diagnosisSettled(entry)).length,
    recent: entries.slice(0, limit).map(entry => ({ subject: entry.subject, kind: entry.kind, faultClass: entry.faultClass, state: entry.state, cause: entry.diagnosis?.cause ?? null,
      covering: entry.diagnosis?.covering ?? null, fix: entry.fix, decision: entry.decision, answeredBy: entry.answeredBy, detail: entry.detail, updatedAt: entry.updatedAt })) };
}
