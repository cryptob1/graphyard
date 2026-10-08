import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { retryStopAttention } from '../src/retry-stop.js';
import { unansweredRequestAttention } from '../src/cli/unanswered-requests.js';
import { classifyAttention, trackFaults, type FaultRecord } from '../src/model/fault-classes.js';
import { launchWaitAttention, type LaunchWait } from '../src/auto-dispatch.js';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { faultClassItem, recurringClasses, type FaultInstance } from '../src/model/fault-classes.js';
import { planeWideRefusal } from '../src/model/blocker-class.js';
import { masterConfigSchema } from '../src/master.js';
import { emptyDaemonState, runCycle, storeAction, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { postRun } from '../src/daemon/doctor.js';
import { clearDiagnoses, diagnosesSettled, type DiagnosticianEffects } from '../src/daemon/diagnosis.js';
import { RefusedResponse } from '../src/model/refusal.js';
import { maxDecisionRequests } from '../src/daemon/decisions.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { DoctorRunRecord } from '../src/daemon/state.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
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

// GY-1402: GY-1404 classifies the failed filing of a malformed fix (fix-item); the diagnose and doctor
// tools also refuse a proof master create would refuse at the call, so the agent corrects it in its run
// and the GY-1401 instance is not reached at all.
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
});

// GY-1402, 2026-10-06: three unclassified faults in 24 hours, each a failed maintenance action the loop
// classified only by its step (action:fault, action:diagnosis), though its wording named the cause:
// - doctor:post:2026-10-06T14:08:45.963Z — the control plane timed out the doctor-run post (plane-unavailable);
// - GY-1401 — the diagnostician's fix item failed master create's proof-ID pattern (fix-item);
// - GY-1399 — a close decision settled stale past the re-request bound (decision-stale).
// GY-1404 has the failing sites pass the cause their branch knows; the step kind stays the fallback.
afterEach(() => clearDiagnoses());
const day = 24 * 60 * 60_000;
const gy1402Clock = Date.parse('2026-10-06T14:10:00.000Z');
const gy1402Config = () => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const doctorRun = (at: string): DoctorRunRecord => ({ at, state: 'reported', runs: [], findings: [], actions: [], filed: [], detail: '' });
const kinds = (state: DaemonState) => state.faults.instances.map(entry => [entry.kind, entry.faultClass]);

function backlog(key: string, overrides: Partial<Work> = {}): Work {
  return { id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [], policy: { checks: ['test'], review: true }, plannedFiles: ['src/x.ts'],
    stage: 'backlog', revision: 1, policyRevision: 1, createdAt: iso(-60 * 60_000), updatedAt: iso(0), stageEnteredAt: iso(-60 * 60_000), ready: false, epoch: 0, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], ...overrides } as unknown as Work;
}
function iso(offset: number) { return new Date(gy1402Clock + offset).toISOString(); }
/** A loop with one recurring-fault item to diagnose, a diagnostician answering with `proof`, and a decision ledger that settles every approval stale. */
function diagnosisWorld(proof: string) {
  const settings = diagnosticianSettings({}), policy = { threshold: 3, windowHours: 24 };
  const state = emptyDaemonState(gy1402Config());
  const instances: FaultInstance[] = ['GY-1', 'GY-2', 'GY-3'].map((subject, index) => ({ id: `blocker|${subject}|${iso(-index * 60_000)}`, kind: 'blocker', faultClass: 'stalled-gate',
    subject, text: `${subject} waits on the merge of PR #77`, at: iso(-index * 60_000), lastSeenAt: iso(0), linkedTo: 'GY-101' }));
  state.faults.instances.push(...instances);
  const recurring = faultClassItem({ faultClass: 'stalled-gate', recent: instances }, policy, gy1402Clock);
  const work = [backlog('GY-101', { title: recurring.title, description: recurring.description, origin: recurring.origin } as Partial<Work>)];
  const ledger: { id: string; work: string; action: string; state: string; input: Record<string, unknown>; requestedAt: string; outcome: string | null; approvedBy: string | null }[] = [];
  let now = gy1402Clock;
  const fix = { title: 'Stop the observation race', description: 'The gate waits on an observation nobody refreshes.', type: 'bug' as const, priority: 1,
    criteria: [{ id: 'AC-1', text: 'The observation is refreshed within a cycle, by a test', proofs: [proof] }], plannedFiles: ['src/merge-queue.ts', 'tests/refresh.test.ts'] };
  const payload = { subject: 'GY-101', cause: 'The merge queue never re-reads a CLEAN pull request after its base moves', evidence: { logLines: ['merge GY-1 waiting'], commands: ['gh pr view 77'] }, faultClass: 'stalled-gate', fix };
  const runner: Runner = { name: 'pi', start<T>(_prompt: string, options: RunOptions<T>) {
    const parsed = options.validate(payload);
    const result: RunResult<T> = { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] };
    return { id: 'run', events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
  } };
  const diagnostician: DiagnosticianEffects = { settings, cwd: '/checkout/project', runner: async () => ({ runner, runtime: 'pi', model: settings.model }),
    context: async () => ({ journal: [], serverLog: [], pullRequests: [] }),
    file: async input => { const filed = backlog('GY-201', { title: input.title, criteria: input.criteria, plannedFiles: input.plannedFiles } as Partial<Work>); work.push(filed); return filed; },
    decide: async (target, action) => { const id = `decision-${ledger.length + 1}`; ledger.push({ id, work: target.key, action, state: 'requested', input: { expectedRevision: target.revision }, requestedAt: iso(now - gy1402Clock), outcome: null, approvedBy: null }); return { id }; } };
  const effects = { agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: work.map(entry => ({ ...entry })), now: new Date(now).toISOString() }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(now).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    faultClassPolicy: policy, persist: async () => {}, fileFaultClass: async () => work[0], diagnostician,
    approver: async (_target: Work, decision: string) => ({ agentName: `approver-${decision}`, pane: null }),
    decisions: async (target: Work) => ({ decisions: ledger.filter(entry => entry.work === target.key).map(entry => ({ ...entry })) }) } as unknown as DaemonEffects;
  return { state, ledger,
    async cycle(offset: number) { now = gy1402Clock + offset; await runCycle(gy1402Config(), state, effects, () => now); await diagnosesSettled(); },
    /** The approver approves; the item's revision has moved, so the server settles it stale. */
    settleStale() { for (const entry of ledger.filter(row => row.state === 'requested')) Object.assign(entry, { state: 'stale', outcome: 'Task revision changed (now 394); reload and request again; the decision was not applied' }); } };
}
/** The instances the diagnosis action opened: its failing run's, wherever the item it named. */
const diagnosisFaults = (state: DaemonState) => state.faults.instances.filter(entry => /diagnos/i.test(entry.text)).map(entry => [entry.kind, entry.faultClass, entry.text]);

test('unit:fault-class-action-wording — a doctor-run post the control plane timed out is plane-unavailable (deployment), and the accepted post ends it', async () => {
  const state = emptyDaemonState(gy1402Config());
  const run = doctorRun('2026-10-06T14:08:45.963Z');
  state.doctor.runs.push(run);
  let refuse: Error | null = new Error('The operation was aborted due to timeout');
  const effects = { recordRun: async () => { if (refuse) throw refuse; } };
  const cycle = { state, effects: { persist: async () => {} } } as unknown as Cycle;
  await postRun(cycle, effects, run, () => gy1402Clock);
  assert.deepEqual(kinds(state), [['plane-unavailable', 'deployment']]);
  assert.match(state.faults.instances[0].text, /^The control plane did not accept the doctor run of 2026-10-06T14:08:45\.963Z; it is posted again next cycle: The operation was aborted due to timeout$/);
  assert.equal(state.faults.failing[`doctor:post:${run.at}`], state.faults.instances[0].id, 'the refusal stands as a failing run');
  // Refused again: still the one instance.
  await postRun(cycle, effects, run, () => gy1402Clock + 60_000);
  assert.equal(state.faults.instances.length, 1);
  // The control plane takes it: the run ends, and a later refusal is a new instance.
  refuse = null;
  await postRun(cycle, effects, run, () => gy1402Clock + 120_000);
  assert.deepEqual(state.doctor.unposted, []);
  assert.equal(state.faults.failing[`doctor:post:${run.at}`], undefined, 'the accepted post ends the instance');
  assert.equal(state.actions[`doctor:post:${run.at}`].state, 'done');
  refuse = new Error('The operation was aborted due to timeout');
  await postRun(cycle, effects, run, () => gy1402Clock + 180_000);
  assert.deepEqual(kinds(state), [['plane-unavailable', 'deployment'], ['plane-unavailable', 'deployment']]);
});

test('unit:fault-class-action-wording — a fix item that fails master create\'s checks is fix-item (proof)', async () => {
  const w = diagnosisWorld('unit:observation refreshed within a cycle');
  await w.cycle(0);
  await w.cycle(60_000);
  assert.equal(w.state.diagnoses['GY-101'].state, 'failed');
  const faults = diagnosisFaults(w.state);
  assert.equal(faults.length, 1, JSON.stringify(faults));
  assert.deepEqual(faults[0].slice(0, 2), ['fix-item', 'proof']);
  assert.match(String(faults[0][2]), /^The diagnostician's fix item for GY-101 fails the checks master create applies: /);
});

test('unit:fault-class-action-wording — a diagnosis decision settled stale past the re-request bound is decision-stale (decision)', async () => {
  const w = diagnosisWorld('unit:observation-refreshed');
  await w.cycle(0);
  await w.cycle(60_000);
  assert.equal(w.ledger.length, 1, 'the release of the filed fix is requested');
  for (let round = 0; round < maxDecisionRequests; round += 1) { w.settleStale(); await w.cycle((2 + round) * 60_000); }
  assert.equal(w.state.diagnoses['GY-101'].state, 'failed');
  const faults = diagnosisFaults(w.state);
  assert.equal(faults.length, 1, JSON.stringify(faults));
  assert.deepEqual(faults[0].slice(0, 2), ['decision-stale', 'decision']);
  assert.match(String(faults[0][2]), /was settled stale: Task revision changed .+ settled without applying, so it is not requested again$/);
});

// The three GY-1402 instance lines, as the loop recorded them, with the kinds their sites now pass.
const gy1402 = [
  { key: 'doctor:post:2026-10-06T14:08:45.963Z', kind: 'fault', site: 'plane-unavailable', expected: 'deployment',
    detail: 'The control plane did not accept the doctor run of 2026-10-06T14:08:45.963Z; it is posted again next cycle: The operation was aborted due to timeout' },
  { key: 'diagnosis:GY-1401', kind: 'diagnosis', site: 'fix-item', expected: 'proof',
    detail: 'The diagnostician\'s fix item for GY-1401 fails the checks master create applies: [ { "message": "Invalid string: must match pattern /^(unit|integration|e2e|manual):[a-zA-Z0-9._/-]+$/" } ]' },
  { key: 'diagnosis:GY-1399', kind: 'diagnosis', site: 'decision-stale', expected: 'decision',
    detail: 'The close decision da6e7b2f-c678-44d1-9107-ee22d99d3c7f on GY-1399 was settled stale: Task revision changed (now 394); reload and request again; the decision was not applied; 3 close request(s) for the diagnosis of GY-1399 settled without applying, so it is not requested again' },
] as const;

test('manual:fault-class-unclassified — GY-1402: the doctor-run timeout, the GY-1401 fix item and the GY-1399 stale close open deployment, proof and decision instances, none unclassified', () => {
  const state = emptyDaemonState(gy1402Config());
  // The site that raised each line names its cause: a plane-wide refusal, and the two diagnosis branches.
  assert.ok(planeWideRefusal(new Error('The operation was aborted due to timeout')));
  for (const [index, line] of gy1402.entries()) storeAction(state, line.key, { kind: line.kind, work: null, principal: null, state: 'failed', detail: line.detail, attempts: 1, epoch: null, cycle: index, at: iso(index * 60_000) }, line.site);
  assert.deepEqual(state.faults.instances.map(entry => [entry.subject, entry.faultClass]), gy1402.map(line => [line.key, line.expected]));
  assert.deepEqual(recurringClasses(state.faults.instances, [], { threshold: 3, windowHours: 24 }, gy1402Clock + day / 2).filter(entry => entry.faultClass === 'unclassified'), [], 'no unclassified recurrence is filed');
});

// GY-1516, 2026-10-08: three unclassified faults in 24 hours, each a failed maintenance action the
// loop classified only by its step, though the loop knew the cause:
// - diagnosis:GY-1430 — both diagnostician runs were stopped at their 1200s bound (overlong-session);
// - isolated:diagnosis:GY-1473 — the create route refused the diagnostician's fix item (409) and the
//   refusal was thrown on to cycle.isolate (fix-item);
// - the doctor's filing of the same content, kept pending and refused again every cycle (fix-item).
// Both refusals name e2e:self-upgrade-loaded-revision-clears, a scenario nothing registers: scenarios
// register only from e2e/cases files, so no retry could ever clear it. GY-1530 has the sites pass
// their cause, drops the dead filing with an escalation naming the scenario, and settles the diagnosis.
const scenarioRefusal = 'Graphyard refused work (409): Register E2E scenario self-upgrade-loaded-revision-clears before creating work that requires it';
const gy1516 = [
  { key: 'diagnosis:GY-1430', kind: 'diagnosis', expected: 'session-liveness', site: 'overlong-session',
    detail: 'The diagnostician returned no diagnosis of GY-1430: zai/glm-5.3-flash timeout: no terminal event within 1200s; the run was stopped; zai/glm-5.3 timeout: no terminal event within 1200s; the run was stopped' },
  { key: 'isolated:diagnosis:GY-1473', kind: 'diagnosis', expected: 'proof', site: 'fix-item',
    detail: `Handling the diagnosis of GY-1473 in the diagnosis step threw, so only its own action failed and the cycle went on with every other item: ${scenarioRefusal}` },
  { key: 'doctor:3379f2b6c361998f7abec8ee:file:loop', kind: 'fault', expected: 'proof', site: 'fix-item',
    detail: `Still could not file "Master loop cannot restart or self-upgrade: coordinator checkout HEAD moves under the running loop, so the dirty-checkout guard stands for hours (instances 2026-10-08T01:09Z and 04:11Z)": ${scenarioRefusal}` },
] as const;

test('manual:fault-class-unclassified — GY-1516: the stopped diagnosis of GY-1430 and the two refused filings open session-liveness and proof instances, none unclassified, and the refusal is read as a create refusal naming its scenario', async () => {
  // Dynamic: on the base tree these symbols are absent, and the proof's exercise must run this case rather than fail the file at load.
  const { createRefused, unregisteredScenario } = await import('../src/daemon/doctor.js');
  const { noDiagnosisKind } = await import('../src/daemon/diagnosis.js');
  assert.equal(noDiagnosisKind([{ runtime: 'pi', result: 'timeout' }, { runtime: 'pi', result: 'timeout' }]), gy1516[0].site, 'the stopped diagnosis names its site kind');
  // The refusal as the operator-agent post throws it, and as plain text: a 409 of the create route, naming the unregistered scenario.
  for (const error of [new RefusedResponse(scenarioRefusal, 409, { error: scenarioRefusal.slice(scenarioRefusal.indexOf(': ') + 2) }), new Error(scenarioRefusal)]) {
    assert.ok(createRefused(error), 'a 409 is the create route refusing the content');
    assert.equal(unregisteredScenario(error), 'self-upgrade-loaded-revision-clears');
  }
  assert.ok(!createRefused(new Error('Graphyard refused work (503): the control plane is unavailable')), 'a plane that did not answer is no content refusal');
  assert.ok(!createRefused(new RefusedResponse('Graphyard refused work (502): Application failed to respond', 502, null)));
  assert.equal(unregisteredScenario(new Error('Graphyard refused work (409): Idempotency key reused with different input')), null);
  const state = emptyDaemonState(gy1402Config());
  for (const [index, line] of gy1516.entries()) storeAction(state, line.key, { kind: line.kind, work: null, principal: null, state: 'failed', detail: line.detail, attempts: 1, epoch: null, cycle: index, at: iso(index * 60_000) }, line.site);
  assert.deepEqual(state.faults.instances.map(entry => [entry.subject, entry.faultClass]), gy1516.map(line => [line.key, line.expected]));
  assert.deepEqual(recurringClasses(state.faults.instances, [], { threshold: 3, windowHours: 24 }, gy1402Clock + day / 2).filter(entry => entry.faultClass === 'unclassified'), [], 'no unclassified recurrence is filed');
});
