import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Evidence, Observation, Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { atomicPrivateWrite, masterConfigSchema, type MasterConfig } from '../src/master.js';
import { lostRun, producerIdleGraceMs, readProducerLedger, reconcileProducers, sessionRetry, type ProducerRecord } from '../src/producer.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';

// GY-496: GY-421 waited over seventy minutes in review with its unit proofs missing. All four of
// its unit-producer runs were headless Pi runs a loop restart killed (exit 143); each counted as an
// attempt, the request was spent, and nothing escalated, requested a rework or relaunched it. One
// case per proof: unit:killed-runs-not-counted.

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
  return { id: 'work-421', key: 'GY-421', title: 'Exhaustion notice', description: '', type: 'bug', priority: 0, dependencies: [], 
    criteria: [{ id: 'AC-1', text: 'Notice', proofs: ['unit:exhaustion-only-provider-notice', 'unit:tmp-reclaim'] }],
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 421 }, reworkRequested: false, scenarioRequirements: [], evidence: [] as Evidence[],
    observation: observation(candidate), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}
/**
 * An item holding the unit producer request. Since GY-1235 the reconciler opens none (proofs gate
 * nothing), so it is the one a record raised before then still holds; the reconciler keeps it while
 * its proofs are unproven, and the dispatch tick and the loop still settle it.
 */
const requested = () => {
  const item = work();
  item.autoDispatch = { review: null, history: [], producers: [{ id: 'producer-unit-gy-421', kind: 'producer', group: 'unit', proofs: ['unit:exhaustion-only-provider-notice', 'unit:tmp-reclaim'],
    sha: H, baseSha: B, policyRevision: 1, pr: 421, requestedAt: iso(-7_300_000), reason: `unit proofs have no trusted evidence on ${H.slice(0, 12)}`, state: 'requested' }] };
  reconcileAutoDispatch(item, [item], new Date(clock));
  assert.equal(item.autoDispatch.producers.length, 1, 'the reconciler keeps the retained request');
  return item;
};
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
  const root = await temporaryDirectory('proof-attempts');
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
