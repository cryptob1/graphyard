import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Work } from '../src/model.js';
import { faultClassItem, type FaultClass, type FaultInstance } from '../src/model/fault-classes.js';
import { providerLimit } from '../src/model/capacity.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { actionableSubjects, emptyDaemonState, loopAttention, loopLiveness, trackSilence, type DaemonAction, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { clearDiagnoses, diagnosesSettled, diagnosisLimitHoldMs, diagnosisStep, diagnosticianHeldUntil, type DiagnosticianEffects } from '../src/daemon/diagnosis.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import type { RunFailure, RunOptions, RunResult, Runner } from '../src/runner/types.js';

// GY-1092 names this file for its proof: manual:fault-class-loop. The master loop filed ten loop
// faults in a day, and they share one cause: the loop recorded as its own failure a wait that
// belonged to someone it cannot move.
//
// - Nine are action:diagnosis faults, one per recurring-fault item (GY-1083 … GY-1091), all at
//   22:22:33 on 2026-10-01: the diagnostician's provider answered every run with
//   `429 … Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-03 08:27:35`. One spent
//   account became one failed loop action per subject in flight. The diagnosis now waits for the
//   reset with no fault, is run again then, and launches nothing else into the spent provider.
// - One is loop-silence on GY-727: its head bc00115a held unit:reconcile-tick-bounded recorded as
//   not exercising AC-2, so no producer would ever be launched for it, and only the rework decision
//   could move it. The silence measure still counted the proof as the loop's own to produce and,
//   after 437 minutes, said nothing had acted. The rework decision is the subject now.
//
// Each instance is replayed below against what the loop does; each test fails on the base.

const silenceInstance = { id: 'loop-silence|GY-727|2026-10-01T16:02:06.353Z', kind: 'loop-silence', subject: 'GY-727', at: '2026-10-01T16:02:06.353Z' };
const diagnosisInstances = ([['GY-1083', 'review-convergence', '33.924'], ['GY-1084', 'decision', '33.940'], ['GY-1085', 'scope', '33.953'], ['GY-1086', 'configuration', '33.965'],
  ['GY-1087', 'merge', '33.979'], ['GY-1088', 'proof', '33.993'], ['GY-1089', 'resources', '34.006'], ['GY-1090', 'stalled-gate', '34.019'], ['GY-1091', 'unclassified', '34.031']] as const)
  .map(([subject, faultClass, seconds]) => ({ id: `action:diagnosis|${subject}|2026-10-01T22:22:${seconds}Z`, kind: 'action:diagnosis', subject, faultClass: faultClass as FaultClass, at: `2026-10-01T22:22:${seconds}Z` }));
const instances = [silenceInstance, ...diagnosisInstances];
const minute = 60_000, hour = 60 * minute;
const iso = (at: number) => new Date(at).toISOString();

function config(): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard',
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, mergeMethod: 'merge', workers: [], run: { proofWorkflow: 'acceptance.yml' } });
}
function item(key: string, at: number, overrides: Partial<Work> = {}): Work {
  return {
    id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'backlog', revision: 1, policyRevision: 1,
    createdAt: iso(at - 3 * hour), updatedAt: iso(at), stageEnteredAt: iso(at - hour), ready: false, epoch: 0, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [], ...overrides,
  } as unknown as Work;
}

test('manual:fault-class-loop — the item lists ten instances, and every one is replayed below', () => {
  assert.equal(instances.length, 10);
  assert.deepEqual(instances.map(entry => entry.subject), ['GY-727', 'GY-1083', 'GY-1084', 'GY-1085', 'GY-1086', 'GY-1087', 'GY-1088', 'GY-1089', 'GY-1090', 'GY-1091']);
});

// ---- The nine diagnoses refused by the provider's limit ----------------------------------------

const refusedAt = Date.parse('2026-10-01T22:22:33.900Z');
/** The provider's error, exactly as each run of the nine recorded it. */
const limitError = '429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-03 08:27:35"}';
const refusal: RunFailure = { reason: 'no-payload', detail: `the run ended without a graphyard_diagnose call (last error: ${limitError})` };
/** The reset the provider named: a wall clock with no zone, read in the host's zone. */
const reset = new Date('2026-10-03T08:27:35').toISOString();
const settings = diagnosticianSettings({ diagnostician: {} });

/** A runner whose every run ends as `answer` says: the provider's refusal, or a diagnosis of the subject named in the prompt. */
function runner(answer: () => 'refuse' | 'diagnose', starts: string[]): Runner {
  return {
    name: 'pi',
    start<T>(prompt: string, options: RunOptions<T>) {
      const subject = /subject "([^"]+)"/.exec(prompt)![1];
      starts.push(subject);
      let result: RunResult<T>;
      if (answer() === 'refuse') result = { ok: false, failure: refusal, payloads: [] };
      else {
        const payload = options.validate({ subject, cause: 'The cause the runs share', evidence: { logLines: ['a line'], commands: [] }, faultClass: 'loop', covering: 'GY-50' });
        result = { ok: true, tool: options.tool, payload, payloads: [payload] };
      }
      return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
    },
  };
}
function diagnostician(answer: () => 'refuse' | 'diagnose', starts: string[]): DiagnosticianEffects {
  return {
    settings, cwd: '/checkout/project',
    runner: async attempt => ({ runner: runner(answer, starts), runtime: 'pi', model: attempt === 'primary' ? 'zai/glm-5.3-flash' : 'zai/glm-5.3' }),
    context: async () => ({ journal: [], serverLog: [], pullRequests: [] }),
    file: async () => { throw new Error('no fix is filed here'); },
    decide: async () => ({ id: randomUUID() }),
  };
}
/** The recurring-fault item the loop filed for `faultClass`, keyed as it was. */
function recurring(key: string, faultClass: FaultClass, at: number) {
  const recent: FaultInstance[] = [0, 1, 2].map(index => ({ id: `${faultClass}|${key}|${index}`, kind: 'blocker', faultClass, subject: `GY-${index + 1}`, text: 'an instance', at: iso(at - index * minute), lastSeenAt: iso(at), linkedTo: key }));
  const input = faultClassItem({ faultClass, recent }, { threshold: 3, windowHours: 24 }, at);
  return item(key, at, { title: input.title, description: input.description, origin: input.origin } as Partial<Work>);
}
/** The open item the diagnosis names as already covering the cause. */
const covering = item('GY-50', refusedAt, { stage: 'build', title: 'The cause the runs share' } as Partial<Work>);
async function step(state: DaemonState, effects: DiagnosticianEffects, work: Work[], at: number) {
  const fx = { diagnostician: effects, persist: async () => {} } as unknown as DaemonEffects;
  const cycle = { config: config(), state, effects: fx, now: () => at, snapshot: { work, now: iso(at) }, clock: at, performed: [] as DaemonAction[],
    isolate: async (_kind: string, _item: unknown, _name: string, body: () => Promise<unknown>) => body() } as unknown as Cycle;
  await diagnosisStep(cycle);
  await diagnosesSettled();
  return cycle.performed;
}
const diagnosisFaults = (state: DaemonState) => state.faults.instances.filter(entry => entry.kind === 'action:diagnosis');
afterEach(() => clearDiagnoses());

test('manual:fault-class-loop — the provider error the nine runs ended on reads as its quota limit, with the reset it names', () => {
  assert.deepEqual(providerLimit(refusal.detail, refusedAt)?.resetsAt, reset);
  for (const text of ['the run ended without a graphyard_diagnose call', 'the graphyard_diagnose payload failed validation: subject must be a string', 'pi exited with code 1: ENOENT models.json'])
    assert.equal(providerLimit(text, refusedAt), null, text);
});

for (const instance of diagnosisInstances) {
  test(`manual:fault-class-loop — ${instance.id}: a diagnosis the provider refused for its limit waits for the reset and is no loop fault`, async () => {
    const state = emptyDaemonState(config()), starts: string[] = [];
    const work = [recurring(instance.subject, instance.faultClass, refusedAt - minute), covering];
    let answer: 'refuse' | 'diagnose' = 'refuse';
    const effects = diagnostician(() => answer, starts);
    await step(state, effects, work, refusedAt);
    const performed = await step(state, effects, work, refusedAt + 1000);
    assert.deepEqual(starts, [instance.subject, instance.subject], 'the primary and its fallback each ran once');
    const entry = state.diagnoses[instance.subject];
    assert.equal(entry.state, 'waiting');
    assert.equal(entry.retryAt, reset);
    assert.match(entry.detail, /quota or rate limit/);
    assert.deepEqual(diagnosisFaults(state), [], 'the refusal is the provider\'s capacity, not a loop fault');
    assert.ok(performed.every(action => action.state !== 'failed' && !action.faultClass), JSON.stringify(performed));
    // Nothing runs again before the reset, and the next cycle after it diagnoses the subject.
    await step(state, effects, work, Date.parse(reset) - minute);
    assert.equal(starts.length, 2);
    answer = 'diagnose';
    await step(state, effects, work, Date.parse(reset) + 1000);
    await step(state, effects, work, Date.parse(reset) + 2000);
    assert.equal(starts.length, 3);
    // Diagnosed, and moved on to closing the item as a duplicate of the item that covers its cause.
    assert.equal(state.diagnoses[instance.subject].state, 'closing');
    assert.equal(state.diagnoses[instance.subject].diagnosis?.covering, 'GY-50');
    assert.deepEqual(diagnosisFaults(state), []);
  });
}

test('manual:fault-class-loop — all nine refused in one cycle file no fault, and no subject filed meanwhile is launched into the spent provider', async () => {
  const state = emptyDaemonState(config()), starts: string[] = [];
  const work = diagnosisInstances.map(instance => recurring(instance.subject, instance.faultClass, refusedAt - minute));
  const effects = diagnostician(() => 'refuse', starts);
  await step(state, effects, work, refusedAt);
  await step(state, effects, work, refusedAt + 1000);
  assert.equal(starts.length, 18);
  assert.deepEqual(diagnosisFaults(state), []);
  assert.ok(Object.values(state.diagnoses).every(entry => entry.state === 'waiting'));
  work.push(recurring('GY-1092', 'loop', refusedAt + hour));
  await step(state, effects, work, refusedAt + 2 * hour);
  assert.equal(starts.length, 18, 'the new subject waits for the same reset');
  assert.equal(state.diagnoses['GY-1092'], undefined);
});

test('manual:fault-class-loop — after the reset one subject probes the provider: a still-spent provider costs one run pair per reset, and the rest follow its answer', async () => {
  const state = emptyDaemonState(config()), starts: string[] = [];
  const work = [...diagnosisInstances.map(instance => recurring(instance.subject, instance.faultClass, refusedAt - minute)), covering];
  let answer: 'refuse' | 'diagnose' = 'refuse';
  const effects = diagnostician(() => answer, starts);
  await step(state, effects, work, refusedAt);
  await step(state, effects, work, refusedAt + 1000);
  assert.equal(starts.length, 18);
  // The reset passes with the provider still spent: one probe, refused again, and the hold renewed.
  const after = Date.parse(reset) + 1000;
  await step(state, effects, work, after);
  await step(state, effects, work, after + 1000);
  assert.deepEqual(starts.slice(18), ['GY-1083', 'GY-1083'], 'one subject probed, primary and fallback');
  assert.equal(diagnosticianHeldUntil(state, after + 2000), iso(after + 1000 + diagnosisLimitHoldMs), "the probe's refusal renews the hour's hold: the reset it names is past");
  await step(state, effects, work, after + 30 * minute);
  assert.equal(starts.length, 20, 'nothing launched while the renewed hold stands');
  // The next probe is answered: it alone runs that cycle, and every other waiting subject follows.
  answer = 'diagnose';
  const recovered = after + diagnosisLimitHoldMs + 2000;
  await step(state, effects, work, recovered);
  assert.equal(starts.length, 21, 'one probe after the renewed hold');
  await step(state, effects, work, recovered + 1000);
  await step(state, effects, work, recovered + 2000);
  assert.equal(starts.length, 29, 'the eight others each ran once on the answered provider');
  assert.ok(Object.values(state.diagnoses).every(entry => entry.state !== 'waiting'));
  assert.deepEqual(diagnosisFaults(state), []);
});

test('manual:fault-class-loop — the hold is the latest reset any waiting diagnosis holds, not the newest refusal\'s', () => {
  const state = emptyDaemonState(config());
  const entry = (subject: string, updatedAt: number, retryAt: number) => ({ subject, kind: 'recurring', faultClass: 'loop', work: subject, state: 'waiting', startedAt: iso(updatedAt), updatedAt: iso(updatedAt),
    runs: [], diagnosis: null, fix: null, decision: null, answeredBy: null, retryAt: iso(retryAt), detail: '' }) as DaemonState['diagnoses'][string];
  state.diagnoses['GY-1083'] = entry('GY-1083', refusedAt, refusedAt + 3 * hour);
  state.diagnoses['GY-1084'] = entry('GY-1084', refusedAt + minute, refusedAt + hour);
  assert.equal(diagnosticianHeldUntil(state, refusedAt + 2 * hour), iso(refusedAt + 3 * hour));
});

test('manual:fault-class-loop — a limit phrase in an exit\'s stderr is no provider refusal: the run is a genuine failure', async () => {
  const state = emptyDaemonState(config()), starts: string[] = [];
  const effects = { ...diagnostician(() => 'refuse', starts), runner: async () => ({ runtime: 'pi', model: 'm', runner: { name: 'pi', start: <T>() => ({ id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {},
    result: async (): Promise<RunResult<T>> => ({ ok: false, failure: { reason: 'exit', detail: 'pi exited with code 1: the agent wrote "HTTP 429: usage limit reached" into its notes' }, payloads: [] }) }) } as Runner }) };
  await step(state, effects, [recurring('GY-1085', 'scope', refusedAt)], refusedAt);
  await step(state, effects, [recurring('GY-1085', 'scope', refusedAt)], refusedAt);
  assert.equal(state.diagnoses['GY-1085'].state, 'failed');
  assert.equal(diagnosisFaults(state).length, 1);
});

test('manual:fault-class-loop — a limit naming no reset waits the hold; a run that fails any other way is still a loop fault', async () => {
  const state = emptyDaemonState(config()), starts: string[] = [];
  const unnamed = diagnostician(() => 'refuse', starts);
  const plain = { ...unnamed, runner: async () => ({ runtime: 'pi', model: 'm', runner: { name: 'pi', start: <T>() => ({ id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {},
    result: async (): Promise<RunResult<T>> => ({ ok: false, failure: { reason: 'no-payload', detail: 'the run ended without a graphyard_diagnose call (last error: 429 Too Many Requests)' }, payloads: [] }) }) } as Runner }) };
  await step(state, plain, [recurring('GY-1083', 'review-convergence', refusedAt)], refusedAt);
  await step(state, plain, [recurring('GY-1083', 'review-convergence', refusedAt)], refusedAt);
  assert.equal(state.diagnoses['GY-1083'].retryAt, iso(refusedAt + diagnosisLimitHoldMs));
  clearDiagnoses();
  const other = emptyDaemonState(config());
  const failing = { ...unnamed, runner: async () => ({ runtime: 'pi', model: 'm', runner: { name: 'pi', start: <T>() => ({ id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {},
    result: async (): Promise<RunResult<T>> => ({ ok: false, failure: { reason: 'no-payload', detail: 'the run ended without a graphyard_diagnose call' }, payloads: [] }) }) } as Runner }) };
  await step(other, failing, [recurring('GY-1084', 'decision', refusedAt)], refusedAt);
  await step(other, failing, [recurring('GY-1084', 'decision', refusedAt)], refusedAt);
  assert.equal(other.diagnoses['GY-1084'].state, 'failed');
  assert.equal(diagnosisFaults(other).length, 1, 'the bound is not weakened: a diagnosis that genuinely fails is still a fault');
});

// ---- GY-727: a proof only a rework decision can move -----------------------------------------

const silentAt = Date.parse('2026-10-01T16:02:06.353Z');
const head = 'bc00115a30efdd0e97af316cd80ed7e8e518a655', base = '070161c467b01c8472593159f46a1bff75b43ec9';
const record = (proof: string, extra: Record<string, unknown> = {}) => ({ id: randomUUID(), proof, sha: head, baseSha: base, result: 'pass', trusted: true, policyRevision: 2,
  skipped: 0, executed: 3, producer: 'graphyard-acceptance', at: '2026-09-27T05:40:00.000Z', ...extra });
/** GY-727 as it stood: submitted at bc00115a, its unit request long past the producer timeout, one proof recorded as not exercising AC-2. */
function gy727(unexercised: boolean): Work {
  return item('GY-727', silentAt, {
    stage: 'build', ready: true, epoch: 5, policyRevision: 2,
    criteria: [{ id: 'AC-1', text: 'reads once', proofs: ['unit:reconcile-reads-open-items-once'] }, { id: 'AC-2', text: 'tick bounded', proofs: ['unit:reconcile-tick-bounded'] }] as Work['criteria'],
    submission: { epoch: 5, pr: 338, submittedAt: '2026-09-27T05:10:00.000Z' } as unknown as Work['submission'],
    candidate: { sha: head, baseSha: base, pr: 338 } as unknown as Work['candidate'],
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] },
      { name: 'acceptance', passed: false, reasons: ['AC-2: unit:reconcile-tick-bounded needs trusted passing evidence'] }] as Work['gates'],
    evidence: [record('unit:reconcile-reads-open-items-once'),
      record('unit:reconcile-tick-bounded', unexercised ? { trusted: false, unexercised: 'unit:reconcile-tick-bounded does not exercise AC-2: it passed against the tree with "Batches yield if they exceed reconcileBatchMs time" removed',
        exercise: { result: 'pass', executed: 3, behaviour: 'Batches yield if they exceed reconcileBatchMs time. Exercise: removed batch time limit check.', criterion: 'AC-2' } } : { trusted: false })] as unknown as Work['evidence'],
    autoDispatch: { review: null, history: [], producers: [{ id: '02337aa21d3feea7d575d1a00f3ea23a', pr: 338, sha: head, baseSha: base, kind: 'producer', group: 'unit', state: 'requested',
      proofs: ['unit:reconcile-reads-open-items-once', 'unit:reconcile-tick-bounded'], reason: 'no trusted evidence binds bc00115a30ef', requestedAt: '2026-09-27T05:12:55.795Z', policyRevision: 2 }] } as unknown as Work['autoDispatch'],
  });
}
/** 437 minutes of cycles every thirty seconds, the loop requesting GY-727's rework decision every quarter hour as it did; the silence attention at the end. */
function replay(work: Work[]) {
  const master = config(), span = 437 * minute, start = silentAt - span;
  const state: DaemonState = { ...emptyDaemonState(master), silence: { subjects: {}, lastActionAt: null } };
  state.lock = { pid: process.pid, host: 'machine-a', startedAt: iso(start), heartbeatAt: iso(start) } as DaemonState['lock'];
  let silence = trackSilence(state, actionableSubjects(master, work, start), [], start);
  for (let at = start; at <= silentAt; at += 30_000) {
    const performed = (at - start) % (15 * minute) === 0 ? [{ kind: 'decision', work: 'GY-727', state: 'done' } as DaemonAction] : [];
    silence = trackSilence(state, actionableSubjects(master, work, at), performed, at);
    state.lastCycleAt = iso(at);
  }
  const liveness = loopLiveness(state, silentAt, master.run.intervalSeconds * 1000);
  return { silence, attention: loopAttention({ liveness, silence }).filter(entry => entry.kind === 'loop-silence') };
}

test(`manual:fault-class-loop — ${silenceInstance.id}: a proof recorded as not exercising its criterion is the rework decision's wait, not the loop's silence`, () => {
  const subjects = actionableSubjects(config(), [gy727(true)], silentAt).map(subject => subject.key);
  assert.ok(!subjects.includes('proof:GY-727'), subjects.join(', '));
  const { attention } = replay([gy727(true)]);
  assert.deepEqual(attention, [], attention.map(entry => entry.text).join('\n'));
});

test('manual:fault-class-loop — a proof the producer still owes past its timeout keeps the silence bound: it is not weakened', () => {
  const { silence, attention } = replay([gy727(false)]);
  assert.equal(attention.length, 1);
  assert.equal(silence.longest?.key, 'proof:GY-727');
  assert.match(attention[0].text, /GY-727 is missing trusted evidence for unit:reconcile-tick-bounded for 437 minutes/);
});
