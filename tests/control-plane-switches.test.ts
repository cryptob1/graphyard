import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateLandability } from '../src/model-boundary/landability.js';
import { landabilityRefusals } from '../src/model/landability.js';
import { reconcileAutoDispatch } from '../src/model-boundary/dispatch.js';
import { foldMergeLedger } from '../src/model-boundary/merge-ledger.js';
import { mergeTrialKind } from '../src/model/merge-ledger.js';
import { mergeWriterIdle, mergeWriterInFlight, mergeWriterStep, type MergeWriterReads } from '../src/daemon/cycle-merge-writer.js';
import { emptyDaemonState, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { Observation, Work } from '../src/model/work.js';

// GY-1528: the control-plane merger switches off the gates the decided model retired — producer
// sessions and budget blockers — while github mode keeps each
// exactly as before.

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
  policy: { checks: ['test'], review: true }, stage: 'build', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null,
  workspaces: [{ host: 'h', path: '/w', branch: 'graphyard/gy-1-1', epoch: 1, owner: 'worker' }], submission: { epoch: 1, pr: 7 },
  candidate: { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-1-1', author: 'worker' }, reworkRequested: false, scenarioRequirements: [], evidence: [],
  observation: observation(source, paths), blocker: null, gates: [], violations: [], createdAt: iso(start), updatedAt: iso(start), stageEnteredAt: iso(start), ...fields,
} as unknown as Work);
const trialLedger = (proofs: Record<string, { executed: number; failed: number }>, tried = head) =>
  foldMergeLedger([
    { kind: 'merge.intent', payload: { key: 'GY-1', head: tried, baseTip: base, mergeSha: sha('merge'), risk: 'normal', at: iso(start) } },
    { kind: mergeTrialKind, payload: { head: tried, baseTip: base, mergeSha: sha('merge'), build: 'pass', tests: { passed: 1, failed: [], files: 1 }, files: [], proofs, durationMs: 1 } },
  ])['GY-1'];

test('unit:landability-control-plane-ledger-proofs — a control-plane candidate\'s acceptance reads unit:/integration: counts from work.mergeLedger.trial for the current head, asks manual: only of a sensitive change, reads e2e: counts from the bound-case run of the trial (GY-2965), and ignores producer evidence', () => {
  const acceptance = (work: Work) => landabilityRefusals(evaluateLandability(work, [work], new Date(start)), 'acceptance');
  const untried = item('control-plane', ['src/app.ts']);
  assert.deepEqual(acceptance(untried), [
    `AC-1: unit:item-works needs executed > 0 and failed = 0 in the merge writer's trial of this candidate; the merge writer has not trialled ${head.slice(0, 12)}`,
    `AC-1: integration:item-holds needs executed > 0 and failed = 0 in the merge writer's trial of this candidate; the merge writer has not trialled ${head.slice(0, 12)}`,
    `AC-1: e2e:item-ships needs executed > 0 and failed = 0 in the merge writer's trial of this candidate; the merge writer has not trialled ${head.slice(0, 12)}`,
  ], 'normal risk: no manual attestation; the e2e case is the trial\'s too');
  const passed = item('control-plane', ['src/app.ts'], { mergeLedger: trialLedger({ 'unit:item-works': { executed: 2, failed: 0 }, 'integration:item-holds': { executed: 1, failed: 0 }, 'e2e:item-ships': { executed: 1, failed: 0 } }) });
  assert.deepEqual(acceptance(passed), []);
  const failing = item('control-plane', ['src/app.ts'], { mergeLedger: trialLedger({ 'unit:item-works': { executed: 2, failed: 1 }, 'integration:item-holds': { executed: 0, failed: 0 }, 'e2e:item-ships': { executed: 1, failed: 0 } }) });
  assert.deepEqual(acceptance(failing).map(reason => reason.replace(/^.*; /, '')), ['the trial ran 2 and 1 failed', 'the trial ran 0 and 0 failed']);
  const stale = item('control-plane', ['src/app.ts'], { mergeLedger: trialLedger({ 'unit:item-works': { executed: 2, failed: 0 }, 'integration:item-holds': { executed: 1, failed: 0 } }, sha('older-head')) });
  assert.equal(acceptance(stale).length, 3, 'a trial of another head proves nothing for this one');
  // Sensitive: the manual attestation is required; trusted producer evidence for the unit proof changes nothing.
  const evidence = [{ id: 'e1', proof: 'unit:item-works', result: 'pass', trusted: true, executed: 5, skipped: 0, failed: 0, producer: 'producer', sha: head, baseSha: base, policyRevision: 1, at: iso(start) }];
  const sensitive = item('control-plane', ['src/store/schema.ts'], { evidence, mergeLedger: trialLedger({ 'integration:item-holds': { executed: 1, failed: 0 }, 'e2e:item-ships': { executed: 1, failed: 0 } }) });
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
  // Every change asks every declared proof, the manual attestation included (GY-2876: no lane waives one).
  const work = item(null, ['src/app.ts']);
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

test('unit:control-plane-mode-docs — docs/coordination.md names in one sentence what control-plane mode switches off', () => {
  for (const page of ['docs/coordination.md']) {
    const sentences = readFileSync(`${root}${page}`, 'utf8').split(/(?<=\.)\s+/).filter(sentence => /^Control-plane mode switches off /.test(sentence));
    assert.equal(sentences.length, 1, `${page} has the sentence once`);
    for (const named of ['plan refusals', 'sync restore', 'scope hook', 'producer sessions', 'budget-test blockers']) assert.ok(sentences[0]!.includes(named), `${page} names ${named}`);
  }
});

test('unit:merge-writer-waits-out-upgrade — the cycle in which a merge lands starts no new trial, so the loop\'s upgrade between cycles kills none; the next cycle starts it', async () => {
  const passed = ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: true, reasons: [] }));
  const head2 = sha('head2'), candidate2 = { sha: head2, baseSha: base, pr: 8, branch: 'graphyard/gy-2-1', author: 'worker' };
  const work = [item('control-plane', ['src/app.ts'], { gates: passed, stageEnteredAt: iso(start - 120_000) }),
    item('control-plane', ['src/app.ts'], { id: 'w2', key: 'GY-2', gates: passed, stageEnteredAt: iso(start - 60_000), candidate: candidate2, observation: { ...observation('control-plane', ['src/app.ts']), candidate: candidate2 } })];
  const trialled: string[] = [];
  const reads = { baseBranch: 'main', retrials: 1, now: () => start, fetch: async () => base, merge: async (headSha: string) => ({ mergeSha: sha(`merge:${headSha}`), files: ['src/app.ts'] }),
    trial: async (_mergeSha: string, _files: string[], target: Work) => { trialled.push(target.key); return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: { 'unit:item-works': { executed: 1, failed: 0 }, 'integration:item-holds': { executed: 1, failed: 0 }, 'e2e:item-ships': { executed: 1, failed: 0 } } }; },
    push: async () => 'pushed', holds: async () => false, record: async () => {}} as unknown as MergeWriterReads;
  const state = emptyDaemonState(config);
  const cycle = () => ({ state, effects: { mergeWriter: reads, persist: async () => {}, fileFaultClass: async () => ({ key: 'GY-900' }) } as unknown as DaemonEffects, now: () => start, snapshot: { work, now: iso(start) }, performed: [] as any[] }) as unknown as Cycle;
  await mergeWriterStep(cycle());
  await mergeWriterIdle(state);
  assert.deepEqual(trialled, ['GY-1']);
  const landed = cycle();
  await mergeWriterStep(landed);
  assert.ok(landed.performed.some(action => /^Merged GY-1 head/.test(action.detail)));
  assert.equal(state.mergeWriter.inFlight, null, 'nothing is in flight when the cycle that merged ends');
  work[0] = { ...work[0]!, stage: 'done', observation: { ...work[0]!.observation!, merged: true, mergeSha: sha(`merge:${head}`) } } as Work;
  await mergeWriterStep(cycle());
  assert.equal((state.mergeWriter.inFlight as { key: string } | null)?.key, 'GY-2', 'the next cycle starts the next trial');
});

test('unit:upgrade-waits-for-trial — the merge writer reports a trial in flight until it settles, which the loop\'s self-upgrade waits for', async () => {
  const passed = ['ready', 'build', 'review', 'test', 'merge'].map(name => ({ name, passed: true, reasons: [] }));
  const work = [item('control-plane', ['src/app.ts'], { gates: passed, stageEnteredAt: iso(start - 60_000) })];
  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const reads = { baseBranch: 'main', retrials: 1, now: () => start, fetch: async () => base, merge: async (headSha: string) => ({ mergeSha: sha(`merge:${headSha}`), files: ['src/app.ts'] }),
    trial: async () => { await held; return { build: 'pass', tests: { passed: 1, failed: [], files: 1 }, durationMs: 1, logTail: '', files: [], proofs: { 'unit:item-works': { executed: 1, failed: 0 }, 'integration:item-holds': { executed: 1, failed: 0 }, 'e2e:item-ships': { executed: 1, failed: 0 } } }; },
    push: async () => 'pushed', holds: async () => false, record: async () => {}} as unknown as MergeWriterReads;
  const state = emptyDaemonState(config);
  const cycle = { state, effects: { mergeWriter: reads, persist: async () => {}, fileFaultClass: async () => ({ key: 'GY-900' }) } as unknown as DaemonEffects, now: () => start, snapshot: { work, now: iso(start) }, performed: [] as any[] } as unknown as Cycle;
  assert.equal(mergeWriterInFlight(state), false, 'nothing in flight before a trial starts');
  await mergeWriterStep(cycle);
  assert.equal(mergeWriterInFlight(state), true, 'the trial is in flight: an upgrade now would kill it');
  release();
  await mergeWriterIdle(state);
  assert.equal(mergeWriterInFlight(state), false, 'once it settles the upgrade may run');
});
