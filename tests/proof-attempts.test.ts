import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Evidence, Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { atomicPrivateWrite, masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { exhaustedProofKey, type ExhaustedProof } from '../src/daemon/decisions.js';
import { lostRun, producerIdleGraceMs, readProducerLedger, reconcileProducers, sessionRetry, sessionRetryLimit, type ProducerRecord } from '../src/producer.js';
import { dispatchFailureAttention, emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';

// GY-496: GY-421 waited over seventy minutes in review with its unit proofs missing. All four of
// its unit-producer runs were headless Pi runs a loop restart killed (exit 143); each counted as an
// attempt, the request was spent, and nothing escalated, requested a rework or relaunched it. One
// case per proof: unit:killed-runs-not-counted, unit:exhausted-proofs-escalate.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1');
const at = '2026-09-25T23:05:00.000Z';
const clock = Date.parse(at);
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();

function observation(candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation {
  return { candidate: { ...candidate, pr: 421, branch: 'graphyard/gy-421-1', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true, ...extra };
}
function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 421, branch: 'graphyard/gy-421-1', author: 'implementer' };
  return { id: 'work-421', key: 'GY-421', title: 'Exhaustion notice', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Notice', proofs: ['unit:exhaustion-only-provider-notice', 'unit:tmp-reclaim'] }],
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 421 }, reworkRequested: false, scenarioRequirements: [], evidence: [] as Evidence[],
    observation: observation(candidate), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}
const requested = () => { const item = work(); reconcileAutoDispatch(item, [item], new Date(clock)); return item; };
function masterConfig(credentialFile: string): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    autoMerge: true, workers: [],
    producers: [{ name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: join(credentialFile, '..', 'producer-a.token') }] });
}
function dispatchEffects(items: () => Work[], log: string[], producers: any[]): DispatchEffects {
  return {
    snapshot: async () => ({ work: items(), now: new Date(clock).toISOString() }),
    agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews: [] }),
    reconcileProducers: async () => ({ producers }),
    launchReview: async () => {},
    launchProducer: async (item, request, profile) => { log.push(`producer:${item.key}:${request.group}:${profile.name}`); producers.push({ requestId: request.id, state: 'pending', requestedAt: iso(0), profile: profile.name }); },
    persist: async () => {},
  };
}
/** A pending headless producer record for the unit request, as the launcher writes it. */
function headlessRecord(requestId: string, attempt: number, extra: Partial<ProducerRecord> = {}): ProducerRecord {
  return { id: `00000000-0000-4000-8000-00000000000${attempt}`, requestId, attempt, key: 'GY-421', pr: 421, sha: H, baseSha: B, policyRevision: 1, group: 'unit',
    proofs: ['unit:exhaustion-only-provider-notice', 'unit:tmp-reclaim'], profile: 'producer-a', principal: 'proof-runner', agentName: `produce-a-${attempt}`, pane: null,
    requestedAt: iso(-600_000), expiresAt: iso(3_600_000), state: 'pending', outcome: {}, delivery: 'request', acknowledgedAt: iso(-600_000), runtime: 'pi', ...extra } as ProducerRecord;
}
const killed = (code: 143 | 137) => ({ runtime: 'pi', startedAt: iso(-600_000), endedAt: iso(-300_000), events: [], applied: [],
  result: { ok: false as const, reason: 'exit' as const, detail: `pi exited with code ${code}` } });

test('unit:killed-runs-not-counted — two producer runs ended with exit 143 settle as lost, the attempt count stays 0, and a third launch happens on the next tick', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-proof-attempts-'));
  try {
    const token = join(root, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const config = masterConfig(token), item = requested();
    const unit = item.autoDispatch!.producers.find(request => request.group === 'unit')!;
    assert.ok(unit, 'the unit group is requested');

    // Two runs killed with exit 143 (a supervisor restart stopping them), settled by reconciliation.
    await mkdir(join(root, '.graphyard'), { recursive: true });
    await atomicPrivateWrite(join(root, '.graphyard/producers.json'), { version: 1, producers: [headlessRecord(unit.id, 1, { run: killed(143) }), headlessRecord(unit.id, 2, { run: killed(143) })] });
    await reconcileProducers(root, config, [item], [], { now: () => new Date(clock) });
    const settled = await reconcileProducers(root, config, [item], [], { now: () => new Date(clock + producerIdleGraceMs) });
    assert.deepEqual(settled.producers.map(record => record.state), ['failed', 'failed']);
    for (const record of settled.producers) {
      assert.match(record.resolution!, /^lost: the headless run was killed \(pi exited with code 143\) before it reached a verdict/);
      assert.equal(lostRun(record), true);
    }
    const retry = sessionRetry(settled.producers, unit.id, clock + producerIdleGraceMs);
    assert.equal(retry.started, 0, 'a killed run does not count as an attempt');
    assert.equal(retry.lost, 2);
    assert.equal(retry.exhausted, false);
    assert.equal(retry.launch, true, 'and the request is relaunched at once, with no widening wait');

    // The dispatcher launches the third run on its next tick.
    const log: string[] = [];
    const tick = await runDispatchTick(config, emptyDispatchCursor(config), dispatchEffects(() => [item], log, [...settled.producers]), () => clock + producerIdleGraceMs);
    assert.deepEqual(log.filter(entry => entry.includes(':unit:')), ['producer:GY-421:unit:producer-a'], JSON.stringify(tick.waiting));

    // Exit 137 (SIGKILL) and a launcher that is gone (a restart with no process left to record the end) are lost too.
    await atomicPrivateWrite(join(root, '.graphyard/producers.json'), { version: 1, producers: [headlessRecord(unit.id, 3, { run: killed(137) }), headlessRecord(unit.id, 4, { launcherPid: 999_999 })] });
    await reconcileProducers(root, config, [item], [], { now: () => new Date(clock), alive: () => false });
    const more = (await reconcileProducers(root, config, [item], [], { now: () => new Date(clock + producerIdleGraceMs), alive: () => false })).producers;
    assert.deepEqual(more.map(lostRun), [true, true], JSON.stringify(more.map(record => record.resolution)));
    assert.match(more[1].resolution!, /launcher \(pid 999999\) is gone, a supervisor restart/);

    // Only runs that ended on their own without evidence, or ran past their timeout, count.
    const ended = { ...killed(143), result: { ok: false as const, reason: 'no-payload' as const, detail: 'the run ended without a submit_evidence call' } };
    await atomicPrivateWrite(join(root, '.graphyard/producers.json'), { version: 1, producers: [headlessRecord(unit.id, 5, { run: ended }), headlessRecord(unit.id, 6, { launcherPid: process.pid, expiresAt: iso(-1) })] });
    await reconcileProducers(root, config, [item], [], { now: () => new Date(clock) });
    const counted = (await reconcileProducers(root, config, [item], [], { now: () => new Date(clock + producerIdleGraceMs) })).producers;
    assert.deepEqual(counted.map(record => record.state), ['failed', 'expired']);
    assert.deepEqual(counted.map(lostRun), [false, false]);
    assert.equal(sessionRetry(counted, unit.id, clock).started, 2);
    assert.equal((await readProducerLedger(root)).producers.length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

function decisionLoop(items: () => Work[], decided: { action: string; reason: string }[], approvers: string[], exhausted: () => ExhaustedProof[]): DaemonEffects {
  return {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: items(), now: iso(1_000), jobs: [] }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({}),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(1_000), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    exhaustedProofs: async () => exhausted(),
    decide: async (_work: Work, action: string, reason: string) => { decided.push({ action, reason }); return { id: '5d8a8b9e-0000-4000-8000-000000000496' }; },
    decisions: async () => ({ decisions: decided.map(entry => ({ id: '5d8a8b9e-0000-4000-8000-000000000496', action: entry.action, state: 'requested', input: {}, approvedBy: null })) }),
    approver: async (_work: Work, decision: string) => { approvers.push(decision); return { agentName: 'graphyard-approver-gy-421', pane: 'pane-approver' }; },
    persist: async () => {},
  } as unknown as DaemonEffects;
}

test('unit:exhausted-proofs-escalate — a producer request whose attempts are used up raises an attention item naming its proof group, each attempt and the next owner, and one cycle later a rework decision quoting the attempts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-proof-exhausted-'));
  try {
    const token = join(root, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const config = masterConfig(token), item = requested();
    const unit = item.autoDispatch!.producers.find(request => request.group === 'unit')!;
    // Every counted attempt ended on its own without trusted evidence.
    const failed = Array.from({ length: sessionRetryLimit }, (_, index) => ({ requestId: unit.id, state: 'failed', attempt: index + 1, profile: 'producer-a', requestedAt: iso(-7_200_000 + index * 60_000), closedAt: iso(-3_600_000 + index * 60_000),
      resolution: `the headless run ended (no-payload: run ${index + 1} found no test named unit:tmp-reclaim) without trusted evidence for unit:tmp-reclaim (missing)` }));
    const log: string[] = [], cursor = emptyDispatchCursor(config);
    await runDispatchTick(config, cursor, dispatchEffects(() => [item], log, failed), () => clock);
    assert.ok(!log.some(entry => entry.includes(':unit:')), 'no fifth unit run is launched');
    const abandoned = cursor.abandoned[unit.id];
    assert.equal(abandoned?.group, 'unit');

    // The attention item: the proof group, every attempt's outcome, and who owns the next step.
    const [attention] = dispatchFailureAttention({ abandoned: [{ requestId: unit.id, ...abandoned }] });
    assert.match(attention.text, /for the unit proof group \(unit:exhaustion-only-provider-notice, unit:tmp-reclaim\)/);
    for (let run = 1; run <= sessionRetryLimit; run++) assert.ok(attention.text.includes(`attempt ${run} on producer-a: failed — the headless run ended (no-payload: run ${run} found`), attention.text);
    assert.equal(attention.role, 'master');
    assert.match(attention.next, /requests a rework decision for GY-421 on its next cycle/);

    // The loop: the first cycle raises it and requests nothing; the next requests the rework.
    const entry: ExhaustedProof = { requestId: unit.id, work: abandoned.work, sha: abandoned.sha, group: abandoned.group ?? null, proofs: abandoned.proofs ?? [], attempts: abandoned.attempts, reason: abandoned.reason };
    const submitted = work({ observation: observation({ sha: H, baseSha: B }, { at: iso(0) }) });
    const decided: { action: string; reason: string }[] = [], approvers: string[] = [];
    const loopConfig = masterConfigSchema.parse({ ...config, autoMerge: true, workers: [] });
    const state = emptyDaemonState(loopConfig), effects = decisionLoop(() => [submitted], decided, approvers, () => [entry]);
    await runCycle(loopConfig, state, effects, () => clock + 1_000);
    const raised = state.actions[exhaustedProofKey(entry)];
    assert.equal(raised?.kind, 'escalation');
    assert.match(raised.detail, /producer attempts for the unit proof group \(unit:exhaustion-only-provider-notice, unit:tmp-reclaim\) on a1ffffffffff are used up/);
    assert.match(raised.detail, /"attempt 1 on producer-a: failed — the headless run ended \(no-payload: run 1 found/);
    assert.match(raised.detail, /Next step, owned by the master loop: on its next cycle it requests a rework decision for GY-421/);
    assert.equal(decided.length, 0, 'the rework waits one cycle after the escalation');

    await runCycle(loopConfig, state, effects, () => clock + 2_000);
    assert.equal(decided.length, 1, JSON.stringify(decided));
    assert.equal(decided[0].action, 'rework');
    assert.match(decided[0].reason, /the producer attempts for the unit proof group .* ended without trusted evidence/);
    for (let run = 1; run <= sessionRetryLimit; run++) assert.ok(decided[0].reason.includes(`no-payload: run ${run} found no test named unit:tmp-reclaim`), `the reason quotes attempt ${run}: ${decided[0].reason}`);
    assert.equal(approvers.length, 1, 'an independent approver is launched for it');

    // A moved head is not reworked on the old head's spent request.
    const movedDecided: { action: string; reason: string }[] = [];
    const moved = work({ candidate: { sha: sha40('c3'), baseSha: B, pr: 421, branch: 'graphyard/gy-421-1', author: 'implementer' }, observation: observation({ sha: sha40('c3'), baseSha: B }, { at: iso(0) }) });
    const movedState = emptyDaemonState(loopConfig), movedEffects = decisionLoop(() => [moved], movedDecided, [], () => [entry]);
    await runCycle(loopConfig, movedState, movedEffects, () => clock + 1_000);
    await runCycle(loopConfig, movedState, movedEffects, () => clock + 2_000);
    assert.equal(movedDecided.length, 0);
    assert.equal(movedState.actions[exhaustedProofKey(entry)], undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});
