import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { retryStopAttention } from '../src/retry-stop.js';
import { unansweredRequestAttention } from '../src/cli/unanswered-requests.js';
import { classifyAttention, faultClassItem, trackFaults, type FaultInstance, type FaultRecord } from '../src/model/fault-classes.js';
import { launchWaitAttention, type LaunchWait } from '../src/auto-dispatch.js';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { clearDiagnoses, diagnosesSettled, diagnosisStep, type DiagnosticianEffects } from '../src/daemon/diagnosis.js';
import { postRun } from '../src/daemon/doctor.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { diagnosisPayloadSchema, diagnosticianSettings } from '../src/runner/payloads.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';
import { graphyardTools as piTools } from '../integrations/pi/index.js';

// GY-1091, 2026-10-01: five unclassified faults in 24 hours, from two shared causes.
//
// - GY-727, GY-859, GY-1069: "GY-N is awaiting rework for a non-exercising proof: ..." — the line
//   unansweredRequestAttention raises for a producer that recorded its proof as not exercising its
//   criterion (GY-817). Its builder set no kind and no catalogue signature named its wording.
// - GY-73 (PR #501, approval 5379316566) and GY-957 (PR #508, approval 5375815849): "The loop stopped
//   retrying follow-up filing ... Graphyard refused the follow-ups for GY-1071 (409): Idempotency key
//   reused with different input". Two ledger records of one approval — the reviewed head's and the
//   head it was carried onto — appended its findings under the approval's one key, and the reason
//   names the head: GY-1071's ledger shows approval 5379316566 appended "at ccc14e051e77" at 12:41,
//   while the second record's kept append named "at 23f92d8bbe37" and was refused on every retry
//   until the retry stopped. The create path already resolved such a refusal (GY-598); the append did
//   not. The stop line itself also carried no kind. GY-1249 removed the follow-up filing, so the
//   append no longer exists; the stop line's classification is still tested below.
// GY-1085 landed first and already classifies the non-exercising-proof and stopped-retry lines, so
// both tests below are regression guards on that base, not reproductions of a base failure (GY-1168).
// The test is named for the proof it produces: manual:fault-class-unclassified.

const nonExercising = [
  ['GY-727', 'unit:reconcile-tick-bounded was recorded as not exercising AC-2 on bc00115a30ef: the mutation removing "Batches yield if they exceed reconcileBatchMs time. Exercise: removed batch time limit check." survived'],
  ['GY-859', 'unit:sync-restores-out-of-scope was recorded as not exercising AC-1 on 418b569602f4: the mutation removing "removed the --restore branch of syncWork in src/cli/workspace.ts (restore loop, commit, recheck)" survived'],
  ['GY-1069', 'unit:docs-no-duplication was recorded as not exercising AC-2 on a5119748b68b: the mutation removing "reverted the docs shrink (README.md and docs/ restored to base)" survived'],
] as const;

test('manual:fault-class-unclassified — GY-727, GY-859, GY-1069: a non-exercising proof awaiting rework is a proof fault, never unclassified', () => {
  const rows = nonExercising.map(([key, finding]) => ({ key, dispatch: { review: null, producers: [{ requestId: `request-${key}`, sinceMs: 600_000, group: 'claude',
    session: { state: 'completed', attempt: 1, resolution: 'recorded its proofs as not exercising their criterion', verdict: null }, unexercised: [finding] }] } }));
  const lines = unansweredRequestAttention(rows);
  assert.equal(lines.length, 3);
  const record: FaultRecord = { instances: [], open: {}, failing: {} };
  const opened = trackFaults(record, classifyAttention(lines), '2026-10-01T17:01:27.555Z');
  assert.deepEqual(opened.map(entry => [entry.subject, entry.kind, entry.faultClass]), nonExercising.map(([key]) => [key, 'nonexercising-proof', 'proof']));
  // A line recorded before its builder set the kind — the instances' own text — is recognised by its wording.
  for (const line of lines) {
    assert.match(line.text, /^GY-\d+ is awaiting rework for a non-exercising proof: /);
    const [worded] = classifyAttention([{ subject: line.subject, text: line.text }]);
    assert.deepEqual([worded.kind, worded.faultClass], ['nonexercising-proof', 'proof'], line.text);
  }
});

test('manual:fault-class-unclassified — a stopped loop retry is a loop fault, never unclassified', () => {
  const recorded = [
    { item: 'GY-73', step: 'follow-up filing for approval 5379316566 (PR #501)', error: 'the follow-ups could not be appended to GY-1071: Graphyard refused the follow-ups for GY-1071 (409): Idempotency key reused with different input' },
    { item: 'GY-957', step: 'follow-up filing for approval 5375815849 (PR #508)', error: 'the follow-ups could not be appended to GY-1054: Graphyard refused the follow-ups for GY-1054 (409): Idempotency key reused with different input' },
  ];
  for (const stop of recorded) {
    const line = retryStopAttention({ ...stop, count: 10, at: '2026-10-01T14:22:19.728Z' });
    for (const item of classifyAttention([line, { subject: line.subject, text: line.text }])) assert.deepEqual([item.kind, item.faultClass], ['retry-stopped', 'loop'], line.text);
  }
});

// GY-1171, 2026-10-03: four unclassified faults in 24 hours, one shared cause. Each was the line
// launchWaitAttention raises for a review request waiting past fifteen minutes without a reviewer
// launch (GY-710); the builder set no kind and no catalogue signature named its wording. GY-1141 and
// GY-1039 waited on the control plane reading a verdict a reviewer had already posted (GY-1083),
// GY-1158 and GY-1167 on every reviewer profile at its concurrency limit. GY-1175 gave the line its kind.
const busy = 'every reviewer profile is busy: claude-reviewer: at its concurrency limit (6 running, limit 6); opencode-reviewer: at its concurrency limit (1 running, limit 1); claude-reviewer-2: at its concurrency limit (1 running, limit 1); claude-reviewer-3: at its concurrency limit (1 running, limit 1); opencode-reviewer-2: at its concurrency limit (1 running, limit 1); raise concurrency in .graphyard/master.json or add a reviewer profile';
const launchWaitInstances: (LaunchWait & { at: string; expected: [string, string] })[] = [
  { work: 'GY-1141', requestId: '7b7bb6d191339ac9930f178873f9031d', sha: '5a121ecc8b7a', requestedAt: '2026-10-03T20:10:52.588Z', at: '2026-10-03T20:31:53.043Z',
    reason: 'reviewer session review-claude-1-7b7bb6d1 already answered with APPROVED (review 5402612611); the control plane settles the request once it reads that verdict', expected: ['review-settlement', 'review-convergence'] as [string, string] },
  { work: 'GY-1039', requestId: '07750d6e93aabd0c412d6b8edefa115d', sha: '25ea6a36f264', requestedAt: '2026-10-03T20:42:24.520Z', at: '2026-10-03T21:11:03.561Z',
    reason: 'reviewer session review-opencode-1 already answered with APPROVED (review 5402739662); the control plane settles the request once it reads that verdict', expected: ['review-settlement', 'review-convergence'] as [string, string] },
  { work: 'GY-1158', requestId: 'a8da2cffd0a2957d644dba21ef8ba3ec', sha: 'd116b6ab834b', requestedAt: '2026-10-03T21:21:57.842Z', at: '2026-10-03T21:43:18.514Z', reason: busy, expected: ['concurrency-starved', 'capacity'] as [string, string] },
  { work: 'GY-1167', requestId: '1c54475a0b26e5acdfbeb7598e7f68b9', sha: 'f73ebd15c5b5', requestedAt: '2026-10-03T21:26:50.368Z', at: '2026-10-03T21:43:18.514Z', reason: busy, expected: ['concurrency-starved', 'capacity'] as [string, string] },
].map(entry => ({ ...entry, kind: 'review' as const, group: null, waitedMs: Date.parse(entry.at) - Date.parse(entry.requestedAt) + 60_000 }));

test('manual:fault-class-unclassified — GY-1141, GY-1039, GY-1158, GY-1167: a review launch wait is classified by the reason it names, never unclassified', () => {
  for (const wait of launchWaitInstances) {
    const [line] = launchWaitAttention([wait]);
    assert.ok(line, `${wait.work}: its wait past fifteen minutes raises attention`);
    assert.match(line.text, /without a reviewer launch: /);
    // As the loop records it: the builder's kind, and as a reader holding only the line's words.
    const [built] = classifyAttention([line]);
    assert.deepEqual([built.kind, built.faultClass], wait.expected, `${wait.work}: ${line.text}`);
    const [worded] = classifyAttention([{ subject: line.subject, text: line.text }]);
    assert.deepEqual([worded.kind, worded.faultClass], wait.expected, `${wait.work} by wording: ${line.text}`);
  }
  // Any other launch wait is a launch that did not happen, still never unclassified.
  const [other] = classifyAttention(launchWaitAttention([{ ...launchWaitInstances[0], reason: 'Herdr session inventory is unavailable' }]));
  assert.deepEqual([other.kind, other.faultClass], ['launch-review', 'session-liveness']);
  const [worded] = classifyAttention([{ subject: other.subject, text: other.text }]);
  assert.deepEqual([worded.kind, worded.faultClass], ['launch-review', 'session-liveness']);

  // The loop's record of the four lines files no unclassified instance.
  const record: FaultRecord = { instances: [], open: {}, failing: {} };
  const opened = trackFaults(record, classifyAttention(launchWaitInstances.flatMap(wait => launchWaitAttention([wait]))), '2026-10-03T21:43:18.514Z');
  assert.deepEqual(opened.map(entry => [entry.subject, entry.kind, entry.faultClass]), launchWaitInstances.map(wait => [wait.work, ...wait.expected]));
});

// GY-1402 names this file for its proof: manual:fault-class-unclassified. The master loop filed 3
// unclassified faults in 24 hours; each is replayed below from its recorded instance. Against the
// base each test fails where it asserts the instance is not recorded again (or, for the stale
// stand-down, is recorded under the class that names it); against the candidate it passes.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2026-10-07T03:38:00Z');
const minute = 60_000, hour = 3_600_000;
const iso = (offset: number) => new Date(clock + offset).toISOString();
const policy = { threshold: 3, windowHours: 24 };
const settings = diagnosticianSettings({ diagnostician: { invariantBoundMinutes: 30 } });
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const item = (key: string, overrides: Partial<Work> = {}): Work => ({
  id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [],
  policy: { checks: ['test'], review: true }, plannedFiles: ['src/x.ts'], stage: 'backlog', revision: 1, policyRevision: 1,
  createdAt: iso(-hour), updatedAt: iso(0), stageEnteredAt: iso(-hour), ready: false, epoch: 0, lease: null, workspaces: [],
  candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
  gates: [], violations: [], ...overrides,
}) as unknown as Work;
const unclassified = (state: ReturnType<typeof emptyDaemonState>) => state.faults.instances.filter(entry => entry.faultClass === 'unclassified');
afterEach(() => clearDiagnoses());

// ---- Instance 1: action:fault on doctor:post:2026-10-06T14:08:45.963Z --------------------------

test('manual:fault-class-unclassified — action:fault|doctor:post:2026-10-06T14:08:45.963Z: a doctor post that times out on the plane is retried with no fault instance', async () => {
  const state = emptyDaemonState(config());
  const run = { at: '2026-10-06T14:08:45.963Z' } as Parameters<typeof postRun>[2];
  state.doctor.runs.push(run);
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  await postRun({ state, effects: { persist: async () => {} } as unknown as Cycle['effects'] }, { recordRun: async () => { throw timeout; } }, run, () => Date.parse('2026-10-06T14:40:53.123Z'));
  const action = state.actions[`doctor:post:${run.at}`];
  assert.equal(action.state, 'failed', 'the post is still recorded as not accepted');
  assert.match(action.detail, /it is posted again next cycle: The operation was aborted due to timeout/);
  assert.deepEqual(state.doctor.unposted, [run.at], 'and it stays queued for the next cycle');
  assert.equal(action.faultClass, undefined);
  assert.deepEqual(unclassified(state), [], 'the plane\'s window opens no unclassified fault');
  // A refusal of the run itself is still the doctor's fault, under its step's kind.
  await postRun({ state, effects: { persist: async () => {} } as unknown as Cycle['effects'] }, { recordRun: async () => { throw new Error('Graphyard refused doctor/runs (400): invalid run'); } }, run, () => Date.parse('2026-10-06T14:42:00Z'));
  assert.equal(unclassified(state).length, 1);
  assert.equal(unclassified(state)[0].kind, 'action:fault');
});

// ---- Diagnosis harness (as tests/diagnostician.test.ts drives the step) ---------------------------

function fakeRunner(name: string, respond: () => unknown): Runner {
  return { name, start<T>(_prompt: string, options: RunOptions<T>) {
    let result: RunResult<T>;
    try { const parsed = options.validate(respond()); result = { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] }; }
    catch (error) { result = { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
    return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
  } };
}
interface Harness { diagnostician: DiagnosticianEffects; filed: any[]; requested: { work: string; action: string; id: string }[]; outcomes: Map<string, { state: string; outcome?: string }> }
function harness(primary: () => unknown, fallback = primary): Harness {
  const h: Harness = { filed: [], requested: [], outcomes: new Map(), diagnostician: undefined as unknown as DiagnosticianEffects };
  h.diagnostician = { settings, cwd: '/checkout/project',
    runner: async attempt => ({ runner: fakeRunner(attempt, attempt === 'primary' ? primary : fallback), runtime: 'pi', model: attempt === 'primary' ? settings.model : settings.fallbackModel }),
    context: async () => ({ journal: ['2026-10-07T03:30:00Z reclaim: ENOTEMPTY'], serverLog: [], pullRequests: [] }),
    file: async input => { h.filed.push(input); return item(`GY-${1400 + h.filed.length}`, { title: input.title, priority: input.priority } as Partial<Work>); },
    decide: async (work, action) => { const id = randomUUID(); h.requested.push({ work: work.key, action, id }); h.outcomes.set(id, { state: 'requested' }); return { id }; },
  } as DiagnosticianEffects;
  return h;
}
const effects = (h: Harness): DaemonEffects => ({
  persist: async () => {}, snapshot: async () => ({ work: [], now: iso(0) }), faultClassPolicy: policy, diagnostician: h.diagnostician,
  approver: async (_target: Work, decision: string) => ({ agentName: `approver-${decision.slice(0, 8)}`, pane: null }),
  decisions: async (target: Work) => ({ decisions: h.requested.filter(entry => entry.work === target.key).map(entry => ({ id: entry.id, action: entry.action, ...h.outcomes.get(entry.id)!, input: {}, approvedBy: null, refusal: null })) }),
}) as unknown as DaemonEffects;
async function step(state: ReturnType<typeof emptyDaemonState>, fx: DaemonEffects, work: Work[], at: number) {
  const cycle = { config: config(), state, effects: fx, now: () => at, snapshot: { work, now: new Date(at).toISOString() }, clock: at, performed: [], isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() } as unknown as Cycle;
  await diagnosisStep(cycle); await diagnosesSettled();
}
/** A recurring-fault item as the loop files it (GY-1401 was the resources class). */
function recurring(state: ReturnType<typeof emptyDaemonState>, key: string) {
  const instances: FaultInstance[] = ['a', 'b', 'c'].map((name, index) => ({ id: `reclaim|${name}|${iso(-index * minute)}`, kind: 'action:reclaim', faultClass: 'resources',
    subject: `/tmp/${name}`, text: `ENOTEMPTY removing /tmp/${name}`, at: iso(-index * minute), lastSeenAt: iso(0), linkedTo: key }));
  state.faults.instances.push(...instances);
  const input = faultClassItem({ faultClass: 'resources', recent: instances }, policy, clock);
  return item(key, { title: input.title, description: input.description, origin: input.origin, type: 'bug', priority: 1 } as Partial<Work>);
}

// ---- Instance 2: action:diagnosis on GY-1401 -------------------------------------------------------

// The diagnostician's fix item for GY-1401, as the loop's cursor recorded it: each proof an id followed by prose.
const gy1401Criteria = [
  { id: 'AC-1', text: 'The pass removes a candidate with bounded retries.', proofs: ['unit:tmp-reclaim: a tree that gains files while the pass removes it is retried and removed rather than failed ENOTEMPTY'] },
  { id: 'AC-2', text: 'One entry\'s failure is isolated and named.', proofs: ['unit:tmp-reclaim: one entry\'s removal failure does not stop the pass\'s other removals'] },
  { id: 'AC-3', text: 'A persistently failing entry cannot recur silently.', proofs: ['unit:tmp-reclaim: the loop\'s reclaim step keeps a failing /tmp entry visible until it is removed'] },
];
const gy1401 = (criteria: typeof gy1401Criteria) => ({ subject: 'GY-1401', cause: 'The /tmp reclaim pass removes a tree once and fails ENOTEMPTY when it gains files meanwhile',
  evidence: { logLines: ['reclaim: ENOTEMPTY: directory not empty, rmdir /tmp/graphyard-x'], commands: [] }, faultClass: 'resources',
  fix: { title: 'Retry a /tmp removal that meets a transient ENOTEMPTY', description: 'The reclaim pass fails a tree that gains files while it is removed.', type: 'bug', priority: 1, criteria, plannedFiles: ['src/daemon/reclaim.ts', 'tests/tmp-reclaim.test.ts'] } });
const wellFormed = gy1401Criteria.map((criterion, index) => ({ ...criterion, proofs: [`unit:tmp-reclaim-${['retry', 'isolation', 'visible'][index]}`] }));

test('manual:fault-class-unclassified — action:diagnosis|GY-1401: the diagnose tool refuses a proof master create would refuse, so the agent corrects it in its run', async () => {
  const [diagnose] = piTools('diagnostician');
  await assert.rejects(diagnose.execute('call-1', gy1401(gy1401Criteria)), /graphyard_diagnose was not recorded: input\.fix\.criteria\[0\]\.proofs\[0\] must match .*Correct the call and make it again/);
  const accepted = await diagnose.execute('call-2', gy1401(wellFormed));
  assert.match(accepted.content[0].text, /recorded diagnosis GY-1401/);
  assert.equal(diagnosisPayloadSchema.safeParse(gy1401(gy1401Criteria)).success, false, 'the loop\'s own check of the payload refuses it too');
  assert.equal(diagnosisPayloadSchema.safeParse(gy1401(wellFormed)).success, true);
});

test('manual:fault-class-unclassified — action:diagnosis|GY-1401: a malformed fix from one model is no diagnosis, the fallback\'s is filed, and no unclassified fault opens', async () => {
  const state = emptyDaemonState(config());
  const subject = recurring(state, 'GY-1401');
  const h = harness(() => gy1401(gy1401Criteria), () => gy1401(wellFormed));
  const fx = effects(h);
  await step(state, fx, [subject], clock);
  await step(state, fx, [subject], clock + minute);
  assert.equal(h.filed.length, 1, JSON.stringify(state.diagnoses['GY-1401']));
  assert.deepEqual(h.filed[0].criteria.map((criterion: { proofs: string[] }) => criterion.proofs[0]), ['unit:tmp-reclaim-retry', 'unit:tmp-reclaim-isolation', 'unit:tmp-reclaim-visible']);
  assert.equal(state.diagnoses['GY-1401'].state, 'releasing');
  assert.deepEqual(unclassified(state), []);
});

// ---- Instance 3: action:diagnosis on GY-1399 -------------------------------------------------------

test('manual:fault-class-unclassified — action:diagnosis|GY-1399: three close requests settled stale stand down as a decision-stale fault, not an unclassified one', async () => {
  const state = emptyDaemonState(config());
  const subject = recurring(state, 'GY-1399');
  const covering = item('GY-1390', { stage: 'build' } as Partial<Work>);
  const h = harness(() => ({ ...gy1401(wellFormed), subject: 'GY-1399', fix: null, covering: 'GY-1390' }));
  const fx = effects(h);
  const at = (revision: number) => [{ ...subject, revision }, covering];
  await step(state, fx, at(390), clock);
  await step(state, fx, at(391), clock + minute);
  assert.equal(state.diagnoses['GY-1399'].state, 'closing');
  for (let round = 0; round < 3; round++) {
    h.outcomes.set(h.requested.at(-1)!.id, { state: 'stale', outcome: `Task revision changed (now ${392 + round}); reload and request again; the decision was not applied` });
    await step(state, fx, at(392 + round), clock + (2 + round) * minute);
  }
  assert.equal(h.requested.length, 3);
  assert.equal(state.diagnoses['GY-1399'].state, 'failed');
  assert.match(state.diagnoses['GY-1399'].detail, /3 close request\(s\) for the diagnosis of GY-1399 settled without applying, so it is not requested again/);
  assert.deepEqual(unclassified(state), [], 'the stand-down opens no unclassified fault');
  const stale = state.faults.instances.filter(entry => entry.kind === 'decision-stale');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].faultClass, 'decision');
  assert.ok(Object.keys(state.actions).some(key => key.startsWith('escalation:diagnosis-stale:')), 'the manual route is still escalated');
});
