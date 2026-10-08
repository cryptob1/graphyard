import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { regressionRefusals, landingRegressions } from '../src/regression-guard.js';
import { restoreAndReport, restoreOffLine } from '../src/cli/sync-restore.js';
import { scopeGuardHook, sessionHarnessPlan, workerHarnessPlan } from '../src/master/harness.js';
import { controlPlaneMerger, scopeStep } from '../src/daemon/cycle-scope.js';
import { evaluateLandability, landabilityRefusals } from '../src/model/landability.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { foldMergeLedger, mergeTrialKind } from '../src/model/merge-ledger.js';
import { reworkWaitsForApprover, riskClassApprover, selfApprover } from '../src/server/lane-rework.js';
import { advisoryActionKey, advisoryChore, advisoryIdle, mergeWriterIdle, mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import type { MergePorts, MergeRecordEvent } from '../src/merge-writer/executor.js';
import { advisoryTests, preMergeTestFiles } from '../scripts/ci-tests.mjs';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Observation, Work } from '../src/model/work.js';

// GY-1528: the control-plane merger switches off the gates the decided model retired — plannedFiles
// and scope refusals, sync-restore, the scope hook, producer sessions, budget blockers and the
// normal-risk rework approver — while github mode keeps each exactly as before.

const root = fileURLToPath(new URL('..', import.meta.url));
const start = Date.parse('2030-05-01T00:00:00Z');
const iso = (at: number) => new Date(at).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const head = sha('head'), base = sha('base');
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });

const scoped = (path: string) => ({ path, status: 'modified' as const, sha: sha(path), baseSha: sha(`base:${path}`), additions: 1, deletions: 1, binary: false });
const observation = (source: 'control-plane' | null, paths: string[]): Observation => ({
  ...(source ? { source } : {}),
  candidate: { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-1-1', author: 'worker' }, checks: [], reviews: [], merged: false, mergeSha: null,
  mergeable: true, protected: true, files: paths, at: iso(start), baseTip: base, scopeFiles: paths.map(scoped),
} as unknown as Observation);
const item = (source: 'control-plane' | null, paths: string[], fields: Record<string, unknown> = {}): Work => ({
  id: 'w1', key: 'GY-1', title: 'switch fixture', type: 'feature', description: '', priority: 1, dependencies: [],
  criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works', 'integration:item-holds', 'manual:item-looks', 'e2e:item-ships'] }],
  policy: { checks: ['test'], review: true }, plannedFiles: ['src/app.ts'], stage: 'build', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null,
  workspaces: [{ host: 'h', path: '/w', branch: 'graphyard/gy-1-1', epoch: 1, owner: 'worker' }], submission: { epoch: 1, pr: 7 },
  candidate: { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-1-1', author: 'worker' }, reworkRequested: false, scenarioRequirements: [], evidence: [],
  observation: observation(source, paths), blocker: null, gates: [], violations: [], createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start), ...fields,
} as unknown as Work);
const trialLedger = (proofs: Record<string, { executed: number; failed: number }>, tried = head) =>
  foldMergeLedger([
    { kind: 'merge.intent', payload: { key: 'GY-1', head: tried, baseTip: base, mergeSha: sha('merge'), risk: 'normal', at: iso(start) } },
    { kind: mergeTrialKind, payload: { head: tried, baseTip: base, mergeSha: sha('merge'), build: 'pass', tests: { passed: 1, failed: [], files: 1 }, files: [], proofs, durationMs: 1 } },
  ])['GY-1'];

test('unit:scope-switches-control-plane — under the control-plane merger regressionRefusals refuses nothing on plannedFiles (landing regressions still computed), restore says it is off and commits nothing, the worker harness carries no scope-guard hook, and the loop decides no scope request', async () => {
  // plannedFiles: a file outside them refuses nothing for a control-plane observation.
  const outside = item('control-plane', ['src/app.ts', 'src/other.ts']);
  assert.deepEqual(regressionRefusals(outside, outside.observation!, []), []);
  const landing = { ...outside.observation!, landing: { base, files: [scoped('src/landed.ts')] } } as Observation;
  assert.equal(landingRegressions(outside, landing, []).length, 1, 'what landing would revert is still computed for status');
  assert.deepEqual(regressionRefusals(outside, landing, []), []);
  // sync --restore: one rev-parse for the report, no restore and no commit; the exit code stays 0.
  const calls: string[][] = [], printed: any[] = [];
  const git = (...args: string[]) => { calls.push(args); if (args[0] !== 'rev-parse') throw new Error(`restore ran git ${args.join(' ')}`); return head; };
  process.exitCode = 0;
  await restoreAndReport(git, value => printed.push(value), { work: { key: 'GY-1', plannedFiles: ['src/app.ts'] }, baseBranch: 'main', baseTip: base, regenerated: [], generated: [], refused: ['src/other.ts'], controlPlane: true });
  assert.deepEqual(calls, [['rev-parse', 'HEAD']]);
  assert.equal(process.exitCode, 0);
  assert.equal(printed.length, 1);
  assert.deepEqual([printed[0].ok, printed[0].restore, printed[0].restored], [true, 'off', []]);
  assert.ok(printed[0].next.startsWith(restoreOffLine), printed[0].next);
  // The worker harness: no scope-guard hook in either plan the launch writes.
  const workerInput = { cliPath: '/bin/graphyard', branch: 'graphyard/gy-1-1', baseBranch: 'main', credentialHome: '/creds', key: 'GY-1', epoch: 1, mergeWriter: 'control-plane' as const };
  assert.equal(workerHarnessPlan(workerInput).hooks, undefined);
  assert.equal(sessionHarnessPlan({ ...workerInput, role: 'worker', kind: 'claude', repository: 'owner/project', credentialDirectories: ['/creds/a'] }).hooks, undefined);
  // The loop's scope step: the merger is read, and no request is decided, widened or re-planned.
  const decided: string[] = [];
  const effects = { mergeWriter: { merger: async () => 'control-plane' }, decideScope: async (work: Work) => { decided.push(work.key); return work; }, persist: async () => {} } as unknown as DaemonEffects;
  const asking = item('control-plane', ['src/app.ts'], { lease: { epoch: 1, owner: 'worker', expiresAt: iso(start + 600_000) }, scopeRequest: { epoch: 1, at: iso(start), paths: ['src/other.ts'], requestedBy: 'worker', reason: 'needs it' } });
  const cycle = { state: emptyDaemonState(config), effects, now: () => start, clock: start, performed: [], open: [asking], isolate: async (_k: unknown, _i: unknown, _n: unknown, body: () => Promise<unknown>) => body() } as unknown as Cycle;
  assert.equal(await controlPlaneMerger(cycle), true);
  const { settled, budget } = await scopeStep(cycle);
  assert.deepEqual([decided, settled.size, budget.breaches, cycle.performed], [[], 0, [], []]);
});

test('unit:scope-switches-github-snapshot — under the github merger each switch behaves exactly as before: the plannedFiles refusal, the scope-guard hook, and a scope step that is not switched off by an absent, github or unreadable merger', async () => {
  const outside = item(null, ['src/app.ts', 'src/other.ts']);
  const refusals = regressionRefusals(outside, outside.observation!, []);
  assert.equal(refusals.length, 2);
  assert.equal(refusals[0], 'Candidate changes 1 file outside its planned files that must match the base branch byte-for-byte; run graphyard sync GY-1, restore each file from origin/<base>, and push again');
  assert.match(refusals[1], /^Out-of-scope regression: src\/other\.ts: /);
  const workerInput = { cliPath: '/bin/graphyard', branch: 'graphyard/gy-1-1', baseBranch: 'main', credentialHome: '/creds', key: 'GY-1', epoch: 1 };
  const hook = scopeGuardHook('/bin/graphyard', 'GY-1', 1);
  for (const mergeWriter of [undefined, 'github' as const]) {
    assert.deepEqual(workerHarnessPlan({ ...workerInput, mergeWriter }).hooks, [hook]);
    assert.deepEqual(sessionHarnessPlan({ ...workerInput, mergeWriter, role: 'worker', kind: 'claude', repository: 'owner/project', credentialDirectories: ['/creds/a'] }).hooks, [hook]);
  }
  // No merge writer reads, a github merger or a failed read all keep the scope step running.
  const cycleOf = (mergeWriter: unknown) => ({ effects: { mergeWriter } }) as unknown as Cycle;
  assert.equal(await controlPlaneMerger(cycleOf(null)), false);
  assert.equal(await controlPlaneMerger(cycleOf({ merger: async () => 'github' })), false);
  assert.equal(await controlPlaneMerger(cycleOf({ merger: async () => { throw new Error('status unreadable'); } })), false);
});

test('unit:landability-control-plane-ledger-proofs — a control-plane candidate\'s acceptance reads unit:/integration: counts from work.mergeLedger.trial for the current head, asks manual: only of a sensitive change, defers e2e:, and ignores producer evidence', () => {
  const acceptance = (work: Work) => landabilityRefusals(evaluateLandability(work, [work], new Date(start)), 'acceptance');
  const untried = item('control-plane', ['src/app.ts']);
  assert.deepEqual(acceptance(untried), [
    `AC-1: unit:item-works needs executed > 0 and failed = 0 in the merge writer's trial of this candidate; the merge writer has not trialled ${head.slice(0, 12)}`,
    `AC-1: integration:item-holds needs executed > 0 and failed = 0 in the merge writer's trial of this candidate; the merge writer has not trialled ${head.slice(0, 12)}`,
  ], 'normal risk: no manual attestation, e2e deferred');
  const passed = item('control-plane', ['src/app.ts'], { mergeLedger: trialLedger({ 'unit:item-works': { executed: 2, failed: 0 }, 'integration:item-holds': { executed: 1, failed: 0 } }) });
  assert.deepEqual(acceptance(passed), []);
  const failing = item('control-plane', ['src/app.ts'], { mergeLedger: trialLedger({ 'unit:item-works': { executed: 2, failed: 1 }, 'integration:item-holds': { executed: 0, failed: 0 } }) });
  assert.deepEqual(acceptance(failing).map(reason => reason.replace(/^.*; /, '')), ['the trial ran 2 and 1 failed', 'the trial ran 0 and 0 failed']);
  const stale = item('control-plane', ['src/app.ts'], { mergeLedger: trialLedger({ 'unit:item-works': { executed: 2, failed: 0 }, 'integration:item-holds': { executed: 1, failed: 0 } }, sha('older-head')) });
  assert.equal(acceptance(stale).length, 2, 'a trial of another head proves nothing for this one');
  // Sensitive: the manual attestation is required; trusted producer evidence for the unit proof changes nothing.
  const evidence = [{ id: 'e1', proof: 'unit:item-works', result: 'pass', trusted: true, executed: 5, skipped: 0, failed: 0, producer: 'producer', sha: head, baseSha: base, policyRevision: 1, at: iso(start) }];
  const sensitive = item('control-plane', ['src/store/schema.ts'], { evidence, mergeLedger: trialLedger({ 'integration:item-holds': { executed: 1, failed: 0 } }) });
  assert.deepEqual(acceptance(sensitive).map(reason => reason.split(' ')[1]), ['unit:item-works', 'manual:item-looks']);
  // A producer's judged failure of a proof nothing requires refuses no control-plane build.
  const strayFail = item('control-plane', ['src/app.ts'], { evidence: [{ ...evidence[0], id: 'e2', proof: 'unit:stray', result: 'fail', failed: 1 }], mergeLedger: passed.mergeLedger });
  assert.ok(!landabilityRefusals(evaluateLandability(strayFail, [strayFail], new Date(start)), 'build').some(reason => /no criterion requires/.test(reason)));
});

test('unit:no-producer-requests-control-plane — reconcileAutoDispatch opens no producer request for a control-plane candidate and withdraws one standing from before', () => {
  const standing = { id: 'p1', kind: 'producer', group: 'unit', proofs: ['unit:item-works'], sha: head, baseSha: base, policyRevision: 1, requestedAt: iso(start), state: 'requested', reason: 'prove it' };
  const work = item('control-plane', ['src/app.ts'], { autoDispatch: { review: null, producers: [standing], history: [] } });
  const transitions = reconcileAutoDispatch(work, [work], new Date(start));
  assert.deepEqual(work.autoDispatch!.producers, []);
  assert.ok(!transitions.some(entry => entry.event === 'dispatch.requested' && entry.request.kind === 'producer'));
  assert.deepEqual(transitions.filter(entry => entry.request.kind === 'producer').map(entry => [entry.event, entry.request.resolution]), [['dispatch.cancelled', 'the control plane is the merge writer: its trial judges the proofs, so no producer is asked']]);
  const again = reconcileAutoDispatch(work, [work], new Date(start + 1000));
  assert.ok(!again.some(entry => entry.request.kind === 'producer'), 'nothing is asked on the next pass either');
});

test('unit:landability-github-snapshot — a github-observed candidate keeps the producer-evidence acceptance rule word for word', () => {
  // A low-lane change asks only its e2e proof; a high-lane one every proof, the manual attestation included.
  const low = item(null, ['src/app.ts']);
  assert.deepEqual(landabilityRefusals(evaluateLandability(low, [low], new Date(start)), 'acceptance'), ['AC-1: e2e:item-ships needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy']);
  const work = item(null, ['src/store/schema.ts']);
  const reasons = landabilityRefusals(evaluateLandability(work, [work], new Date(start)), 'acceptance');
  assert.deepEqual(reasons, [
    'AC-1: unit:item-works needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy',
    'AC-1: integration:item-holds needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy',
    'AC-1: manual:item-looks needs trusted passing evidence, with skipped = 0, for this candidate and policy',
    'AC-1: e2e:item-ships needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy',
  ]);
  // The trial counts on the ledger are no evidence in github mode.
  const tried = item(null, ['src/store/schema.ts'], { mergeLedger: trialLedger({ 'unit:item-works': { executed: 1, failed: 0 }, 'integration:item-holds': { executed: 1, failed: 0 } }) });
  assert.deepEqual(landabilityRefusals(evaluateLandability(tried, [tried], new Date(start)), 'acceptance'), reasons);
});

test('unit:advisory-tests-selection — scripts/ci-tests.mjs exports the advisory budget tests; the trials\' affected selection leaves them out, `advisory` lists them, and the github CI selection still runs them', () => {
  assert.deepEqual(advisoryTests, ['tests/docs-budget.test.ts', 'tests/docs-budget-headroom.test.ts', 'tests/module-budgets.test.ts', 'tests/hotspots.test.ts', 'tests/interventions-hotspot-split.test.ts']);
  const cli = (...args: string[]) => execFileSync('node', ['scripts/ci-tests.mjs', ...args], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const affected = cli('affected', 'package.json');
  assert.match(affected[0]!, /^full: /);
  for (const advisory of advisoryTests) assert.ok(!affected.includes(advisory), `${advisory} is not in the trial's selection`);
  assert.equal(affected.length - 1, preMergeTestFiles().length - advisoryTests.length, 'everything else in the full selection still runs');
  assert.deepEqual(cli('advisory'), [`advisory: ${advisoryTests.length} advisory budget test file(s)`, ...advisoryTests]);
  for (const advisory of advisoryTests) assert.ok(preMergeTestFiles().includes(advisory), `${advisory} stays in github's pre-merge selection`);
});

test('integration:advisory-failure-files-chore — after the merge writer delivers a head the loop runs the advisory tests once on its merge commit, and each failing one files one chore naming the test and the merge sha; nothing is reverted and nothing is filed twice', async () => {
  const work = [item('control-plane', ['src/app.ts'], { gates: ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: true, reasons: [] })), stageEnteredAt: iso(start - 60_000) })];
  const events: MergeRecordEvent[] = [], advised: string[] = [], filed: { input: any; key: string }[] = [];
  const ports: MergePorts = {
    baseBranch: 'main', retrials: 1, now: () => start,
    fetch: async () => base,
    merge: async headSha => ({ mergeSha: sha(`merge:${headSha}`), files: ['src/app.ts'] }),
    trial: async () => ({ build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: {} }),
    push: async () => 'pushed', holds: async () => false,
    record: async (_target, event) => { events.push(event); },
  };
  const reads: MergeWriterReads = { ...ports, merger: async () => 'control-plane', advisory: async mergeSha => { advised.push(mergeSha); return { build: 'pass', failed: ['tests/hotspots.test.ts', 'scripts/ci-tests.mjs advisory'] }; } };
  const effects = { mergeWriter: reads, persist: async () => {}, fileFaultClass: async (input: any, key: string) => { filed.push({ input, key }); return { key: 'GY-900' } as Work; } } as unknown as DaemonEffects;
  const state = emptyDaemonState(config);
  const cycle = () => ({ state, effects, now: () => start, snapshot: { work, now: iso(start) }, performed: [] as any[] }) as unknown as Cycle;
  await mergeWriterStep(cycle());
  await mergeWriterIdle(state);
  const merged = cycle();
  await mergeWriterStep(merged);
  const mergeSha = sha(`merge:${head}`);
  assert.ok(merged.performed.some(action => /^Merged GY-1 head/.test(action.detail)));
  work[0] = { ...work[0]!, stage: 'done', observation: { ...work[0]!.observation!, merged: true, mergeSha } } as Work;
  await advisoryIdle(state);
  assert.deepEqual(advised, [mergeSha], 'one advisory run, on the merge commit');
  const filing = cycle();
  await mergeWriterStep(filing);
  assert.equal(filed.length, 1, 'the one failing test file files one chore; a selection failure names no test');
  assert.deepEqual(filed[0]!.input, advisoryChore('tests/hotspots.test.ts', mergeSha, 'GY-1'));
  assert.equal(filed[0]!.input.type, 'chore');
  assert.match(filed[0]!.input.title, new RegExp(`^Advisory test tests/hotspots\\.test\\.ts fails on ${mergeSha.slice(0, 12)}$`));
  assert.ok(filed[0]!.input.description.includes(mergeSha));
  assert.equal(state.actions[advisoryActionKey(mergeSha, 'tests/hotspots.test.ts')]?.state, 'done');
  assert.ok(!events.some(event => (event as { kind: string }).kind === 'revert'), 'nothing is reverted');
  for (let again = 0; again < 2; again++) await mergeWriterStep(cycle());
  assert.deepEqual([filed.length, advised.length], [1, 1], 'neither the run nor the chore repeats');
});

test('unit:rework-approver-by-risk — a control-plane rework waits for an approver only for a sensitive change, applied otherwise by graphyard-risk-class; github keeps reworkNeedsApprover by lane', () => {
  assert.equal(riskClassApprover, 'graphyard-risk-class');
  assert.ok(selfApprover(riskClassApprover), 'the risk class approves and applies at once, like the lane');
  assert.equal(reworkWaitsForApprover(item('control-plane', ['src/app.ts'])), false, 'normal risk under the control plane');
  assert.equal(reworkWaitsForApprover(item('control-plane', ['src/store/schema.ts'])), true, 'sensitive keeps the approver');
  assert.equal(reworkWaitsForApprover(item('control-plane', [])), true, 'an unknown change is sensitive');
  assert.equal(reworkWaitsForApprover(item(null, ['src/store/schema.ts'])), true, 'github: a high-lane change keeps the approver');
  assert.equal(reworkWaitsForApprover(item(null, ['tests/x.test.ts'])), false, 'github: a low-lane change needs none');
  assert.equal(reworkWaitsForApprover(item(null, ['src/server/routes/work.ts', 'src/app.ts'])), true, 'github: by lane, whatever the risk class says');
});

test('unit:docs-word-budget — docs/coordination.md and docs/development.md each name in one sentence of at most 25 words what control-plane mode switches off', () => {
  for (const page of ['docs/coordination.md', 'docs/development.md']) {
    const sentences = readFileSync(`${root}${page}`, 'utf8').split(/(?<=\.)\s+/).filter(sentence => /^Control-plane mode switches off /.test(sentence));
    assert.equal(sentences.length, 1, `${page} has the sentence once`);
    assert.ok(sentences[0]!.split(/\s+/).length <= 25, `${page}: ${sentences[0]}`);
    for (const named of ['plannedFiles', 'sync restore', 'scope hook', 'producer sessions', 'budget-test blockers', 'normal-risk rework approvers']) assert.ok(sentences[0]!.includes(named), `${page} names ${named}`);
  }
});
