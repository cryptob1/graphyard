import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Work } from '../src/model.js';
import { faultClassItem, type FaultClass, type FaultInstance } from '../src/model/fault-classes.js';
import { providerLimit } from '../src/model/capacity.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { actionableSubjects, cycleCost, daemonEffects, emptyDaemonState, loopAttention, loopLiveness, runCycle, trackSilence, type DaemonAction, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { reworkWokenObservationMaxAgeMs } from '../src/daemon/decisions.js';
import { clearDiagnoses, diagnosesSettled, diagnosisLimitHoldMs, diagnosisReport, diagnosisStep, diagnosticianGate, diagnosticianHeldUntil, type DiagnosticianEffects } from '../src/daemon/diagnosis.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { diagnosticianSettings, diagnosisSettled } from '../src/runner/payloads.js';
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
    runs: [], diagnosis: null, fix: null, decision: null, answeredBy: null, retryAt: iso(retryAt), refusedAt: iso(updatedAt), detail: '' }) as DaemonState['diagnoses'][string];
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

test('manual:fault-class-loop — a waiting diagnosis is settled so inFlight counts no provider hold as active work, and diagnosticianGate keys on explicit refusal time', () => {
  const state = emptyDaemonState(config());
  const entry = (subject: string, updatedAt: number, retryAt: number, refusedAt: number) => ({
    subject, kind: 'recurring', faultClass: 'loop', work: subject, state: 'waiting', startedAt: iso(updatedAt), updatedAt: iso(updatedAt),
    runs: [], diagnosis: null, fix: null, decision: null, answeredBy: null, retryAt: iso(retryAt), refusedAt: iso(refusedAt), detail: '' }) as DaemonState['diagnoses'][string];
  const waitingEntry = entry('GY-1083', refusedAt, refusedAt + hour, refusedAt);
  state.diagnoses['GY-1083'] = waitingEntry;
  assert.ok(diagnosisSettled(waitingEntry));
  assert.equal(diagnosisReport(state).inFlight, 0);

  // If something later updates updatedAt, the gate still honours the refusal timestamp
  waitingEntry.updatedAt = iso(refusedAt + 2 * hour);
  state.diagnoses['GY-1083'].retryAt = iso(refusedAt + 10 * minute);
  state.diagnoses['GY-1084'] = { subject: 'GY-1084', kind: 'recurring', faultClass: 'loop', work: 'GY-1084', state: 'running',
    startedAt: iso(refusedAt + 15 * minute), updatedAt: iso(refusedAt + 15 * minute), runs: [], diagnosis: null, fix: null, decision: null, answeredBy: null, retryAt: null, refusedAt: null, detail: '' } as DaemonState['diagnoses'][string];
  assert.equal(diagnosticianGate(state, refusedAt + 20 * minute), 'held', 'the in-flight probe holds other launches even if waiting entry updatedAt changed');
});

// ---- GY-1266: three loop faults on 2026-10-05 ---------------------------------------------------
//
// GY-1266 names this file for its proof too. Its three instances share one cause: under GitHub
// delivery a merge burst moved the base under every open candidate, and the loop answered each
// head that then needed rework by waking its observation and waiting for one under two minutes old.
// The wake lands within the cycle, but the next cycle reads it one 300s interval later, so every
// landed observation was stale again: the wake was sent again — each a server reconcile of 3-14s,
// one after another in the decisions step — and no rework was ever requested.
//
// - loop-cost on loop: cycle 12245 spent 336s of 375s in the decisions step, past the interval.
// - loop-silence on GY-1132: nothing acted for 81 minutes on a head whose rework was never
//   requested; the silence named its missing proofs, which under GitHub delivery nobody produces.
// - action:diagnosis on GY-1252: a recurring item closed while it was diagnosed was recorded as
//   the loop's failed action — the subject moving on, counted as a loop fault.

const gy1266Instances = [
  { id: 'loop-silence|GY-1132|2026-10-05T05:25:42.725Z', kind: 'loop-silence', subject: 'GY-1132' },
  { id: 'action:diagnosis|GY-1252|2026-10-05T05:32:58.811Z', kind: 'action:diagnosis', subject: 'GY-1252' },
  { id: 'loop-cost|loop|2026-10-05T06:10:59.591Z', kind: 'loop-cost', subject: 'loop' },
];
const burstClock = Date.parse('2026-10-05T04:04:00.000Z'), intervalMs = 300_000, head1266 = 'a'.repeat(40), base1266 = 'b'.repeat(40);
/** A loop as the incident ran it: a reviewer App, an operator-agent's decisions, and the 300s interval. */
function burstConfig(run: Record<string, unknown> = {}): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [],
    reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/outside/reviewer.json', boundAt: iso(burstClock - hour) },
    reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' }], producers: [], run: { intervalSeconds: intervalMs / 1000, ...run } });
}
/** A submitted head a changes-requested verdict stands against, last observed at `observedAt`: it needs rework. */
function reworkHead(key: string, observedAt: number, overrides: Partial<Work> = {}): Work {
  const observation = { clockOffset: { min: 0, max: 0 }, candidate: { sha: head1266, baseSha: base1266, pr: 42, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'independent-reviewer', sha: head1266, state: 'CHANGES_REQUESTED' }], protected: true, mergeable: true, merged: false,
    mergeSha: null, files: ['src/loop.ts'], scopeFiles: [], at: iso(observedAt), prState: 'open', draft: false, baseTip: base1266, baseTipContained: true };
  return item(key, observedAt, { criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:loop'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', ready: true, epoch: 1,
    submission: { epoch: 1, pr: 42 }, candidate: { sha: head1266, baseSha: base1266, pr: 42, branch: `graphyard/${key.toLowerCase()}-1`, author: 'worker' }, observation,
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], ...overrides } as Partial<Work>);
}
/**
 * The merge burst, replayed: each 300s cycle ten more heads need rework, last observed three
 * minutes before they did. A wake costs the 8s server reconcile a resync measured that morning, and
 * its observation lands 30s after it is sent, as a prioritized wake does.
 */
const wave = 10;
/** The body the loop's production effects send to the server for `call`. */
async function sent(call: (effects: DaemonEffects) => Promise<unknown>) {
  const bodies: Record<string, unknown>[] = [];
  const live = daemonEffects('/nonexistent/gy-1266', burstConfig(), { snapshot: async () => ({ work: [], now: iso(burstClock) }),
    mutate: async (_path, data) => { bodies.push(data as Record<string, unknown>); return {}; }});
  await call(live);
  return bodies[0] ?? {};
}
async function replayBurst(cycles: number) {
  const config = burstConfig(), state = emptyDaemonState(config);
  const heads: { key: string; observedAt: number }[] = [];
  const landing = new Map<string, number>(), requested: string[] = [], wakes: { key: string; cycle: number }[] = [];
  const decisions = new Map<string, { id: string; action: string; state: string }[]>();
  let now = burstClock, cycle = 0;
  const snapshot = () => ({ work: heads.map(head => reworkHead(head.key, landing.has(head.key) && landing.get(head.key)! <= now ? landing.get(head.key)! : head.observedAt)), now: iso(now), jobs: [] });
  const effects: DaemonEffects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => snapshot(),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    // The wake goes through the loop's own effects, to a server that serves a prioritized wake ahead
    // of the polled backlog; the burst's backlog served no other wake inside the replay (GY-612's,
    // sent unprioritized at 06:23, had still not landed at 06:44).
    wakeObservation: async work => {
      wakes.push({ key: work.key, cycle });
      const resync = await sent(live => live.wakeObservation!(work));
      // GY-1286: a wake that asks for no tick (`wait: false`) is answered once the job is woken.
      now += resync.wait === false ? 500 : 8_000;
      if (resync.prioritized === true) landing.set(work.key, now + 30_000);
    },
    decide: async (work, action) => { requested.push(work.key); const id = randomUUID(); decisions.set(work.id, [...decisions.get(work.id) ?? [], { id, action, state: 'requested' }]); return { id }; },
    decisions: async work => ({ decisions: decisions.get(work.id) ?? [] }) as never,
    approver: async work => ({ agentName: `graphyard-approver-${work.key.toLowerCase()}`, pane: `pane-${work.key}` }),
    persist: async () => {},
  } as DaemonEffects;
  const results = [];
  for (cycle = 0; cycle < cycles; cycle++) {
    now = burstClock + cycle * intervalMs;
    for (let index = 0; index < wave; index++) heads.push({ key: `GY-${2000 + cycle * wave + index}`, observedAt: now - 3 * minute });
    results.push(await runCycle(config, state, effects, () => now));
  }
  return { results, requested, wakes, heads };
}

test('manual:fault-class-loop — GY-1266 lists three instances, and every one is replayed below', () => {
  assert.deepEqual(gy1266Instances.map(entry => entry.kind), ['loop-silence', 'action:diagnosis', 'loop-cost']);
});

test(`manual:fault-class-loop — ${gy1266Instances[2].id}: a merge burst's rework heads are decided from the observation the loop woke, so wakes stop repeating and the decisions step fits the interval`, async () => {
  const { results, requested, wakes, heads } = await replayBurst(6);
  for (const result of results) {
    const cost = cycleCost(result.metrics, intervalMs)!;
    assert.ok(cost.withinInterval, `cycle ${result.metrics.cycle} spent ${cost.workMs}ms of work against the ${intervalMs}ms interval: ${cost.breakdown}`);
  }
  // One wake per head, never one per head per cycle: the reading a wake brought in is decided from
  // (within reworkWokenObservationMaxAgeMs; a request still standing past that is observed afresh).
  for (let cycle = 0; cycle * intervalMs < reworkWokenObservationMaxAgeMs; cycle++)
    assert.deepEqual(wakes.filter(wake => wake.cycle === cycle).map(wake => wake.key), heads.slice(cycle * wave, (cycle + 1) * wave).map(head => head.key), `cycle ${cycle} wakes only the heads new to it`);
  assert.deepEqual([...new Set(requested)].sort(), heads.slice(0, 5 * wave).map(head => head.key).sort(), 'every head woken before the last cycle has its rework requested');
});

test(`manual:fault-class-loop — ${gy1266Instances[0].id}: no head waits past the silence bound for a rework the loop never requests`, async () => {
  const { results } = await replayBurst(6);
  const silence = results.at(-1)!.silence;
  const unrequested = silence.subjects.filter(subject => /needs a rework decision requested and approved/.test(subject.detail) && subject.idleMs > intervalMs);
  assert.deepEqual(unrequested.map(subject => subject.key), [], 'a rework head is requested on the cycle after its wake');
  assert.equal(silence.breached, false, JSON.stringify(silence.longest));
});

test(`manual:fault-class-loop — ${gy1266Instances[0].id}: GitHub delivery being the only delivery, a missing proof is nobody's to produce, so it is no subject of the loop's silence and no workflow is requested for it`, async () => {
  const at = Date.parse('2026-10-05T05:25:42.725Z');
  const gy1132 = reworkHead('GY-1132', at - minute, { gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] }],
    observation: { ...reworkHead('GY-1132', at - minute).observation!, reviews: [] } } as Partial<Work>);
  const master = burstConfig({ proofWorkflow: 'acceptance.yml' });
  const subjects = actionableSubjects(master, [gy1132], at).map(subject => subject.key);
  assert.ok(!subjects.includes('proof:GY-1132'), subjects.join(', '));
  // Nor does the shepherd step ask the proof workflow for it.
  const asked: string[] = [];
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work: [gy1132], now: iso(at), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: async (work: Work) => { asked.push(work.key); },
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(at), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    persist: async () => {} } as unknown as DaemonEffects;
  await runCycle(master, emptyDaemonState(master), effects, () => at);
  assert.deepEqual(asked, []);
});

test(`manual:fault-class-loop — ${gy1266Instances[1].id}: a recurring item closed while it was diagnosed answers its diagnosis, and is no loop fault`, async () => {
  const state = emptyDaemonState(config()), starts: string[] = [];
  const at = Date.parse('2026-10-05T05:30:00.000Z');
  const open = recurring('GY-1252', 'resources', at - minute);
  const effects = diagnostician(() => 'diagnose', starts);
  await step(state, effects, [open, covering], at);
  // The master closed GY-1252 before the diagnosis came back.
  const closed = { ...open, stage: 'done', closure: { kind: 'duplicate', ref: 'GY-1272' } } as unknown as Work;
  const performed = await step(state, effects, [closed, covering], at + 2 * minute);
  const entry = state.diagnoses['GY-1252'];
  assert.equal(entry.state, 'answered');
  assert.equal(entry.answeredBy, 'GY-1272');
  assert.deepEqual(performed.filter(action => action.state === 'failed').map(action => action.detail), []);
  assert.deepEqual(diagnosisFaults(state), [], 'no action:diagnosis loop fault');
});

// ---- GY-1286: three more loop faults on 2026-10-05 ----------------------------------------------
//
// GY-1286 names this file for its proof too (the GY-1234 instance, which needs the control plane's
// store, is replayed in tests/loop-faults-dispatch-wake.test.ts). The three instances share one
// cause: the loop waited, serially, on control-plane writes that could not finish inside it.
//
// - loop-cost on loop: cycle 12285 spent 319s of its own work in the decisions step against the
//   300s interval, and cycle 12293, after GY-1266 was loaded, 365s. Its slow calls were rework
//   `decide` requests and observation wakes (`resync`), each running into its 30s timeout, one
//   after another: a wake waited on the server's reconcile ticks, and a decision request on the
//   server's lock. The step now has a budget and hands what is left to the next cycle, which
//   reaches it first, and a wake waits on no tick.
// - loop-silence on GY-1135: 28 minutes on "missing trusted evidence" for a head under GitHub
//   delivery, which no producer serves. The base already clears it: GY-1266 counts no proof under
//   GitHub delivery. It recurred because the loop process that raised it (started 06:36Z) still
//   ran the code from before GY-1266's merge at 08:03Z until its upgrade went through at 08:35Z.
//   The test below pins it.
// - loop-silence on GY-1234: see tests/loop-faults-dispatch-wake.test.ts.

const gy1286Instances = [
  { id: 'loop-cost|loop|2026-10-05T08:21:38.779Z', kind: 'loop-cost', subject: 'loop' },
  { id: 'loop-silence|GY-1135|2026-10-05T08:25:25.831Z', kind: 'loop-silence', subject: 'GY-1135' },
  { id: 'loop-silence|GY-1234|2026-10-05T08:35:58.217Z', kind: 'loop-silence', subject: 'GY-1234' },
];
/** The 30s request timeout every slow call of cycles 12285 and 12293 ran into. */
const requestTimeoutMs = 30_000;
/**
 * Cycle 12293's backlog, replayed: twelve rework heads observed three minutes ago, whose rework
 * waits for a wake, and twelve observed moments ago, whose decision requests each time out after 30s. The server answers a wake at once when it asks for no tick, and after a 30s tick wait
 * otherwise, as it did that morning.
 */
async function replaySlowServer(cycles: number, attesting = 0) {
  const config = burstConfig(), state = emptyDaemonState(config);
  const fresh = Array.from({ length: 12 }, (_, index) => `GY-${3000 + index}`), stale = Array.from({ length: 12 }, (_, index) => `GY-${3100 + index}`);
  const attested = Array.from({ length: attesting }, (_, index) => `GY-${3200 + index}`);
  const decided: { key: string; cycle: number; action: string }[] = [], woken: { key: string; cycle: number; body: Record<string, unknown> }[] = [];
  let now = burstClock, cycle = 0;
  const snapshot = () => ({ work: [...stale.map(key => reworkHead(key, burstClock - 3 * minute)), ...fresh.map(key => reworkHead(key, now - 30_000)), ...attested.map(key => attestHead(key, now - 30_000))], now: iso(now), jobs: [] });
  const effects: DaemonEffects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => snapshot(),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(now), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {},
    wakeObservation: async work => {
      const body = await sent(live => live.wakeObservation!(work));
      woken.push({ key: work.key, cycle, body });
      now += body.wait === false ? 500 : requestTimeoutMs;
    },
    decide: async (work, action) => { decided.push({ key: work.key, cycle, action }); now += requestTimeoutMs; throw new Error('The operation was aborted due to timeout'); },
    decisions: async () => ({ decisions: [] }) as never,
    approver: async work => ({ agentName: `graphyard-approver-${work.key.toLowerCase()}`, pane: `pane-${work.key}` }),
    persist: async () => {},
  } as DaemonEffects;
  const results = [], deferred: string[][] = [];
  for (cycle = 0; cycle < cycles; cycle++) {
    now = burstClock + cycle * intervalMs;
    results.push(await runCycle(config, state, effects, () => now));
    deferred.push([...state.decisionsDeferred]);
  }
  return { results, decided, woken, deferred, fresh, stale, attested };
}
/** A head whose only refusal left is a `manual:` proof no producer may run: the loop's attestation pass requests it. */
function attestHead(key: string, observedAt: number): Work {
  return reworkHead(key, observedAt, { stage: 'acceptance', reworkRequested: false, criteria: [{ id: 'AC-1', text: 'Attested', proofs: ['manual:attested'] }],
    observation: { ...reworkHead(key, observedAt).observation!, reviews: [{ reviewer: 'independent-reviewer', sha: head1266, state: 'APPROVED' }] },
    gates: [{ name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] }, { name: 'acceptance', passed: false, reasons: ['AC-1: manual:attested needs trusted passing evidence on the current candidate'] }] } as Partial<Work>);
}

test('manual:fault-class-loop — GY-1286 lists three instances, and every one is replayed', () => {
  assert.deepEqual(gy1286Instances.map(entry => entry.subject), ['loop', 'GY-1135', 'GY-1234']);
});

test(`manual:fault-class-loop — ${gy1286Instances[0].id}: decision requests that each run into the 30s timeout no longer carry the decisions step past the interval`, async () => {
  const { results } = await replaySlowServer(4);
  for (const result of results) {
    const cost = cycleCost(result.metrics, intervalMs)!;
    assert.ok(cost.withinInterval, `cycle ${result.metrics.cycle} spent ${cost.workMs}ms of work against the ${intervalMs}ms interval: ${cost.breakdown}`);
  }
});

test(`manual:fault-class-loop — ${gy1286Instances[0].id}: what the step puts off is reached first on the next cycle, so every head is still requested`, async () => {
  const { results, decided, deferred, fresh } = await replaySlowServer(4);
  assert.ok(deferred[0].length, 'the first cycle runs out of budget and puts items off');
  const first = decided.filter(entry => entry.cycle === 1).map(entry => entry.key);
  assert.equal(first[0], deferred[0].find(key => fresh.includes(key)), 'the next cycle starts with what the last one put off');
  assert.deepEqual([...new Set(decided.map(entry => entry.key))].sort(), [...fresh].sort(), 'every fresh head has its rework requested within four cycles');
  const note = results[0].actions.find(action => action.detail.startsWith('The decisions step spent its'));
  assert.match(note?.detail ?? '', /120s budget; \d+ item\(s\) wait for the next cycle/);
});

test(`manual:fault-class-loop — ${gy1286Instances[0].id}: attestations reached only after the rework pass spent the budget are still requested, the oldest put off first`, async () => {
  // The review of the first fix: the attestation pass ran after the rework pass on the same clock,
  // in snapshot order, so under a sustained slow server it found the budget spent every cycle and
  // put every attestation off for good. Each pass now reaches the oldest item it put off first.
  const { decided, deferred, attested } = await replaySlowServer(4, 3);
  assert.deepEqual(deferred[0].filter(key => attested.includes(key)), attested.slice(1), `past the budget the pass reaches its first attestation and puts the rest off: ${JSON.stringify(deferred[0])}`);
  const first = attested.map(key => decided.find(entry => entry.action === 'attest' && entry.key === key));
  assert.deepEqual(first.map(entry => entry?.cycle), [0, 1, 2], `each cycle requests the oldest attestation put off, so none waits for good: ${JSON.stringify(decided.filter(entry => entry.action === 'attest'))}`);
});

test(`manual:fault-class-loop — ${gy1286Instances[0].id}: an observation wake asks for no reconcile tick, so it costs the step no tick wait`, async () => {
  const body = await sent(live => live.wakeObservation!(reworkHead('GY-3100', burstClock)));
  assert.deepEqual(body, { prioritized: true, wait: false });
  const { woken, stale } = await replaySlowServer(1);
  assert.deepEqual(woken.map(entry => entry.key).sort(), [...stale].sort(), 'every stale head is woken in the first cycle');
});

test(`manual:fault-class-loop — ${gy1286Instances[1].id}: a head under GitHub delivery missing a proof no producer serves is no subject of the loop's silence`, () => {
  // GY-1135 at 08:25: its rework head 8b364f91 submitted at 08:04, build and review passing, the
  // required test check failing while its failed jobs reran, unit:agy-quota-notice-detected unproduced.
  const at = Date.parse(gy1286Instances[1].id.split('|')[2]);
  const gates = [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: true, reasons: [] },
    { name: 'test', passed: false, reasons: ['Required CI check test has not passed on the current candidate; rerun: its failed jobs are rerunning (workflow run 37281344467)'] },
    { name: 'merge', passed: true, reasons: [] }, { name: 'github-delivery', passed: true, reasons: [] }];
  const gy1135 = reworkHead('GY-1135', at - 21 * minute, { criteria: [{ id: 'AC-1', text: 'Notice detected', proofs: ['unit:agy-quota-notice-detected'] }], gates,
    observation: { ...reworkHead('GY-1135', at - 21 * minute).observation!, reviews: [] } } as Partial<Work>);
  const master = burstConfig({ proofWorkflow: 'acceptance.yml' });
  const subjects = actionableSubjects(master, [gy1135], at);
  assert.ok(!subjects.some(subject => subject.kind === 'proof'), JSON.stringify(subjects));
});

// ---- GY-1318: three loop faults filed for handled outcomes on 2026-10-05 ------------------------
//
// GY-1318 names this file for its proof too. Its three instances were outcomes the loop handles by
// design, each recorded as a failed action of a kind the catalogue files under the loop class:
// (1) GY-1304's diagnosis release decide refused 409 "Task revision changed (now 2)" at request
//     time, the loop's own next write having moved the item after the cycle's snapshot;
// (2) doctor:2026-10-05T15:21:52.963Z, a doctor run with no report (replayed in
//     tests/pipeline-doctor.test.ts, unit:doctor-no-report-not-a-loop-fault);
// (3) GY-1308's diagnosis, orphaned by the loop's restart and handed off past its lost bound.

const gy1318Instances = [
  { id: 'action:diagnosis|GY-1304|2026-10-05T14:49:10.057Z', kind: 'action:diagnosis', subject: 'GY-1304', at: '2026-10-05T14:49:10.057Z' },
  { id: 'action:fault|doctor:2026-10-05T15:21:52.963Z|2026-10-05T15:34:34.669Z', kind: 'action:fault', subject: 'doctor:2026-10-05T15:21:52.963Z', at: '2026-10-05T15:34:34.669Z' },
  { id: 'action:diagnosis|GY-1308|2026-10-05T16:11:29.481Z', kind: 'action:diagnosis', subject: 'GY-1308', at: '2026-10-05T16:11:29.481Z' },
];
const raced = (revision: number) => new Error(`Graphyard refused work/work-GY-1304/decide (409): Task revision changed (now ${revision}); reload and request again`);
type Decisions = Awaited<ReturnType<NonNullable<DaemonEffects['decisions']>>>['decisions'];
/** One diagnosis step with the effects the decide path reads: the fresh snapshot, the decision history and the approver. */
async function decideStep(state: DaemonState, effects: DiagnosticianEffects, work: Work[], fresh: () => Work[], history: Decisions, at: number) {
  const fx = { diagnostician: effects, persist: async () => {}, snapshot: async () => ({ work: fresh(), now: iso(at) }), decisions: async () => ({ decisions: history }),
    approver: async () => ({ agentName: 'gy-approver', pane: null }) } as unknown as DaemonEffects;
  const cycle = { config: config(), state, effects: fx, now: () => at, snapshot: { work, now: iso(at) }, clock: at, performed: [] as DaemonAction[],
    isolate: async (_kind: string, _item: unknown, _name: string, body: () => Promise<unknown>) => body() } as unknown as Cycle;
  await diagnosisStep(cycle);
  await diagnosesSettled();
  return cycle.performed;
}
/** GY-1304 diagnosed, its covering item named: the next step requests the close decision. */
async function diagnosed(decide: DiagnosticianEffects['decide'], at: number) {
  const state = emptyDaemonState(config()), starts: string[] = [];
  const subject = recurring('GY-1304', 'loop', at - minute);
  const effects = { ...diagnostician(() => 'diagnose', starts), decide };
  await decideStep(state, effects, [subject, covering], () => [subject, covering], [], at);
  return { state, effects, subject };
}

test('manual:fault-class-loop — GY-1318 lists three instances, and every one is replayed', () => {
  assert.deepEqual(gy1318Instances.map(entry => entry.subject), ['GY-1304', 'doctor:2026-10-05T15:21:52.963Z', 'GY-1308']);
});

test(`unit:diagnosis-decide-revision-race — ${gy1318Instances[0].id}: a decide refused for a revision change reloads the item and requests again against its current revision, with no loop fault`, async () => {
  const at = Date.parse(gy1318Instances[0].at), asked: number[] = [];
  const decide: DiagnosticianEffects['decide'] = async work => { asked.push(work.revision); if (work.revision < 2) throw raced(2); return { id: 'decision-2' }; };
  const { state, effects, subject } = await diagnosed(decide, at);
  const moved = { ...subject, revision: 2 } as Work;
  const performed = await decideStep(state, effects, [subject, covering], () => [moved, covering], [], at + minute);
  assert.deepEqual(asked, [1, 2], 'asked once at the snapshot\'s revision, then again at the reloaded one');
  const entry = state.diagnoses['GY-1304'];
  assert.equal(entry.state, 'closing');
  assert.equal(entry.decision?.id, 'decision-2');
  assert.deepEqual(performed.filter(action => action.state === 'failed'), []);
  assert.deepEqual(diagnosisFaults(state), [], 'no action:diagnosis loop fault');
});

test(`unit:diagnosis-decide-revision-race — ${gy1318Instances[0].id}: a retry spent, raced again or no longer applicable records no failed action, and the next cycle decides afresh`, async () => {
  const at = Date.parse(gy1318Instances[0].at);
  const stale = (index: number) => ({ id: `stale-${index}`, action: 'close', state: 'stale', input: {}, approvedBy: null, outcome: 'Task revision changed' });
  for (const [why, fresh, history, again] of [
    ['spent', 2, [0, 1, 2].map(stale), false],
    ['raced again', 2, [], true],
    ['no longer applicable', null, [], false],
  ] as const) {
    clearDiagnoses();
    const asked: number[] = [];
    let raceAgain = again;
    const decide: DiagnosticianEffects['decide'] = async work => { asked.push(work.revision); if (work.revision < 2 || raceAgain) throw raced(3); return { id: 'decision-next' }; };
    const { state, effects, subject } = await diagnosed(decide, at);
    const reloaded = fresh === null ? { ...subject, stage: 'done', revision: 2, closure: { kind: 'duplicate', ref: 'GY-50', at: iso(at) } } as unknown as Work : { ...subject, revision: fresh } as Work;
    const performed = await decideStep(state, effects, [subject, covering], () => [reloaded, covering], history as unknown as Decisions, at + minute);
    assert.deepEqual(asked, again ? [1, 2] : [1], `${why}: asked again only while applicable and unspent`);
    assert.equal(state.diagnoses['GY-1304'].state, 'diagnosed', `${why}: the entry keeps its state for the next cycle`);
    assert.deepEqual(performed.filter(action => action.state === 'failed'), [], `${why}: no failed loop action`);
    assert.deepEqual(diagnosisFaults(state), [], `${why}: no loop fault`);
    // The next cycle decides afresh from its fresh snapshot.
    raceAgain = false;
    if (fresh !== null && !history.length) {
      await decideStep(state, effects, [reloaded, covering], () => [reloaded, covering], [], at + 2 * minute);
      assert.equal(state.diagnoses['GY-1304'].state, 'closing', `${why}: the next cycle requests it`);
    }
  }
});

test(`unit:diagnosis-decide-revision-race — any other decide refusal still fails the diagnosis step`, async () => {
  const at = Date.parse(gy1318Instances[0].at);
  const { state, effects, subject } = await diagnosed(async () => { throw new Error('Graphyard refused work/work-GY-1304/decide (403): not permitted'); }, at);
  await assert.rejects(decideStep(state, effects, [subject, covering], () => [subject, covering], [], at + minute), /403/);
});

test(`unit:diagnosis-lost-run-not-a-loop-fault — ${gy1318Instances[2].id}: a diagnosis orphaned by a restart is handed off past its lost bound with no loop fault`, async () => {
  const at = Date.parse(gy1318Instances[2].at), startedAt = Date.parse('2026-10-05T15:23:42.185Z');
  const state = emptyDaemonState(config()), starts: string[] = [];
  state.diagnoses['GY-1308'] = { subject: 'GY-1308', kind: 'recurring', faultClass: 'loop', work: 'GY-1308', state: 'running', startedAt: iso(startedAt), updatedAt: iso(startedAt),
    runs: [], diagnosis: null, fix: null, decision: null, answeredBy: null, retryAt: null, refusedAt: null, detail: '' };
  const performed = await step(state, diagnostician(() => 'diagnose', starts), [recurring('GY-1308', 'loop', startedAt)], at);
  assert.deepEqual(starts, [], 'nothing is relaunched in its place');
  assert.equal(state.diagnoses['GY-1308'].state, 'failed', 'the handoff is still recorded');
  assert.deepEqual(performed.filter(action => action.state === 'failed').map(action => action.detail),
    ['The diagnosis of GY-1308 started 2026-10-05T15:23:42.185Z never ended in this process; the master diagnoses it by hand']);
  assert.deepEqual(diagnosisFaults(state), [], 'no action:diagnosis loop fault');
});

// ---- GY-1336: three more loop faults on 2026-10-05 ----------------------------------------------
//
// GY-1336 names this file for its proof too. Its instances share GY-1318's cause: an outcome the loop
// handles by design, recorded as a failed action of a kind the catalogue files under the loop class.
// (1) doctor:2026-10-05T23:32:04.689Z and (2) doctor:3379f2b6c361998f7abec8ee:file:merge are replayed
// in tests/pipeline-doctor.test.ts; (3) is replayed here: GY-1333's diagnosis asked to close GY-1333
// after it was delivered, past the cycle's snapshot, and the server refused 409 "Delivered work is
// immutable; create a follow-up task" — the delivered leg of the race GY-1318 answered for a
// revision change.

const gy1336Instances = [
  { id: 'action:fault|doctor:2026-10-05T23:32:04.689Z|2026-10-05T23:33:14.947Z', kind: 'action:fault', subject: 'doctor:2026-10-05T23:32:04.689Z', at: '2026-10-05T23:33:14.947Z' },
  { id: 'action:fault|doctor:3379f2b6c361998f7abec8ee:file:merge|2026-10-06T00:02:05.141Z', kind: 'action:fault', subject: 'doctor:3379f2b6c361998f7abec8ee:file:merge', at: '2026-10-06T00:02:05.141Z' },
  { id: 'action:diagnosis|GY-1333|2026-10-06T00:45:38.033Z', kind: 'action:diagnosis', subject: 'GY-1333', at: '2026-10-06T00:45:38.033Z' },
];
const immutable = new Error('Graphyard refused work/97cfd8d6-c3c6-4876-8bf4-55f60d8d0d5c/decide (409): Delivered work is immutable; create a follow-up task');

test('manual:fault-class-loop — GY-1336 lists three instances, and every one is replayed', () => {
  assert.deepEqual(gy1336Instances.map(entry => entry.subject), ['doctor:2026-10-05T23:32:04.689Z', 'doctor:3379f2b6c361998f7abec8ee:file:merge', 'GY-1333']);
});

test(`manual:fault-class-loop — ${gy1336Instances[2].id}: a close refused because the item was delivered meanwhile is no loop fault, and the next cycle answers the diagnosis`, async () => {
  const at = Date.parse(gy1336Instances[2].at), asked: string[] = [];
  const decide: DiagnosticianEffects['decide'] = async work => { asked.push(work.key); throw immutable; };
  const { state, effects, subject } = await diagnosed(decide, at);
  const delivered = { ...subject, stage: 'done', revision: 5 } as unknown as Work;
  const performed = await decideStep(state, effects, [subject, covering], () => [delivered, covering], [], at + minute);
  assert.deepEqual(asked, ['GY-1304'], 'asked once; reloaded, the item is delivered, so it is not asked again');
  assert.deepEqual(performed.filter(action => action.state === 'failed'), [], 'no failed loop action');
  assert.deepEqual(diagnosisFaults(state), [], 'no action:diagnosis loop fault');
  assert.equal(state.diagnoses['GY-1304'].state, 'diagnosed', 'the entry waits for the next cycle');
  await decideStep(state, effects, [delivered, covering], () => [delivered, covering], [], at + 2 * minute);
  assert.equal(state.diagnoses['GY-1304'].state, 'answered', 'the next cycle sees the item delivered and answers the diagnosis');
  assert.deepEqual(diagnosisFaults(state), []);
});

test(`manual:fault-class-loop — ${gy1336Instances[2].id}: a fix released after its recurring item was delivered answers the diagnosis without asking to close a delivered item`, async () => {
  const at = Date.parse(gy1336Instances[2].at), asked: string[] = [];
  const state = emptyDaemonState(config()), starts: string[] = [];
  const fix = item('GY-1334', at, { stage: 'backlog', ready: true } as Partial<Work>);
  const delivered = { ...recurring('GY-1333', 'loop', at - hour), stage: 'done' } as unknown as Work;
  state.diagnoses['GY-1333'] = { subject: 'GY-1333', kind: 'recurring', faultClass: 'loop', work: 'GY-1333', state: 'releasing', startedAt: iso(at - hour), updatedAt: iso(at - minute),
    runs: [], diagnosis: { subject: 'GY-1333', cause: 'The cause', evidence: { logLines: ['a line'], commands: [] }, faultClass: 'loop', covering: null } as never, fix: 'GY-1334',
    decision: { id: 'release-1', action: 'release', work: 'GY-1334', approver: 'gy-approver' }, answeredBy: null, retryAt: null, refusedAt: null, detail: '' };
  const effects = { ...diagnostician(() => 'diagnose', starts), decide: async (work: Work) => { asked.push(work.key); throw immutable; } };
  const applied = [{ id: 'release-1', action: 'release', state: 'applied', input: {}, approvedBy: 'gy-approver', outcome: null }] as unknown as Decisions;
  const performed = await decideStep(state, effects, [delivered, fix], () => [delivered, fix], applied, at);
  assert.deepEqual(asked, [], 'no close is asked of a delivered item');
  assert.equal(state.diagnoses['GY-1333'].state, 'answered');
  assert.equal(state.diagnoses['GY-1333'].answeredBy, 'GY-1334');
  assert.deepEqual(performed.filter(action => action.state === 'failed'), []);
  assert.deepEqual(diagnosisFaults(state), [], 'no action:diagnosis loop fault');
});
