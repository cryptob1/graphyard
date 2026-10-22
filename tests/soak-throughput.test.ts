import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { retainedActions } from '../src/daemon/state.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { loopThroughputMeasurement, throughputMeasurementDirectory, throughputMeasurementRetention, throughputRemeasureMs, verifyThroughput } from '../src/throughput.js';
import { appendThroughputLedger, recordedEntry, throughputEscalationMs, throughputLedgerFile } from '../src/throughput-ledger.js';
import { backlogCounts, machineKind } from '../src/model/machine-backlog.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1438 over simulated days. The loop re-measures the serving release while its newest
 * measurement is unverified and deliveries keep merging. GY-2186: the loop files no owner item and
 * raises no needs-decision — a measurement that cannot verify the claim is the throughput attention
 * line alone. The loop runs here on a one-minute cycle over a whole day of one release, a delivery
 * merging every five minutes, in two worlds:
 *
 * - one whose deliveries are excluded for reasons no coordinator left (no submission is recorded),
 *   so the population may yet accumulate and nothing escalates: every re-measure is at least
 *   `throughputRemeasureMs` after the one before, the asks between them follow the failure backoff,
 *   never one per cycle, with one status read per ask, and the measurement directory and the loop's
 *   actions stay bounded however long the release serves;
 * - one whose every delivery carries a coordinator fingerprint (a blocked report), so past the bound
 *   the population cannot accumulate: the measurement shows the needs-decision, the release is
 *   re-measured hourly (GY-1458), and nothing is filed or escalated while it stands, with every
 *   system invariant holding after every cycle.
 */
const minute = 60_000, hour = 60 * minute, day = 24 * hour, start = Date.parse('2026-10-07T00:00:00.000Z');
const sha = (label: string) => createHash('sha1').update(label).digest('hex');
const serving = sha('serving-release');

/**
 * A delivered item as the snapshot carries it, merged at `at`; `blocked` gives it a coordinator
 * fingerprint. `submittedMs` before the merge, it is instead an admitted delivery: submitted, its
 * review requested and executed by an executor, nothing a coordinator left on it.
 */
function delivery(index: number, at: number, blocked: boolean, submittedMs: number | null = null): Work {
  const when = new Date(at).toISOString();
  const iso = (ms: number) => new Date(at - submittedMs! + ms).toISOString();
  const admitted = submittedMs === null ? {} : {
    submission: { pr: index }, implementers: ['worker-1'],
    pipeline: { attempts: [{ epoch: 1, owner: 'worker-1', claimedAt: iso(-10 * minute), endedAt: iso(0), end: 'submitted' }], submittedAt: iso(0), reworkRounds: 0, interventions: { blocked: 0, requirements: 0 }, backfill: null },
    actionQueue: { actions: [], history: [{ id: `review-${index}`, kind: 'request-review', work: `w-${index}`, key: `GY-${index}`, inputs: { kind: 'request-review' }, gate: 'review', refusal: null, reason: '', binding: 'request-review:0',
      requestedBy: 'graphyard', requestedAt: iso(minute), state: 'done', claim: null, attempts: 1, resolvedAt: iso(3 * minute), result: 'done', resolution: 'settled', history: [
        { at: iso(minute), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
        { at: iso(2 * minute), event: 'claimed', requester: 'graphyard', executor: 'executor-a', result: null, reason: 'attempt 1 claimed by executor-a on host-a' },
        { at: iso(3 * minute), event: 'completed', requester: 'graphyard', executor: 'executor-a', result: 'done', reason: '' }] }] },
  };
  return { id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, key: `GY-${index}`, title: `Delivery ${index}`, description: '', type: 'bug', priority: 2, stage: 'done',
    revision: 3, policyRevision: 1, createdAt: when, updatedAt: when, stageEnteredAt: when, ready: true, epoch: 1, lease: null, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], criteria: [], dependencies: [], 
    policy: { checks: ['test'], review: true }, delivery: { mergeSha: sha(`merge-${index}`), mergedAt: when, mergedAtRepository: when },
    ...(blocked ? { pipeline: { attempts: [], interventions: { blocked: 1, requirements: 0 } } } : {}), ...admitted } as unknown as Work;
}

/** One simulated world: a release serving all day, the loop on a one-minute cycle, a delivery merging every five minutes. */
async function world(root: string, initiallyBlocked: boolean, submittedMs: number | null = null) {
  let blocked = initiallyBlocked;
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, 'coordinator.token'), cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
    githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { intervalSeconds: 60, deploymentReuseMinutes: 0 } }) as MasterConfig;
  const state = emptyDaemonState(config);
  let now = start;
  state.lock = { id: 'lock', pid: process.pid, host: config.hostId, startedAt: new Date(now).toISOString(), heartbeatAt: new Date(now).toISOString() };
  // The claim was observed serving an hour before the day starts, so every delivery of the day is in its window.
  const claim = delivery(1, start - 2 * hour, false);
  claim.delivery!.deployment = { sha: serving, mergeSha: claim.delivery!.mergeSha, source: 'endpoint', observedAt: new Date(start - hour).toISOString(), covers: 'exact', at: new Date(start - hour).toISOString(), observer: 'coordinator-1' } as never;
  const work: Work[] = [claim];
  let next = 2;
  const asks: { cycle: number; at: number; outcome: string }[] = [], violations: string[] = [], counts = { statusReads: 0 };
  const effects: DaemonEffects = {
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: work.map(item => ({ ...item })), now: new Date(now).toISOString() }), closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async delivered => ({ source: 'endpoint', sha: serving, at: new Date(now).toISOString(), reason: null, deployed: delivered.map(item => item.key), pending: [], requests: 0 }) as never,
    recordDeployment: async () => {}, persist: async () => {},
    measureThroughput: async (snapshot, observedSha) => {
      const outcome = await loopThroughputMeasurement(root, { work: snapshot, observedSha, now: () => now, origin: 'https://graphyard.example', claimKey: claim.key,
        status: async () => { counts.statusReads++; return { now: new Date(now).toISOString(), release: { version: '0.9.1', revision: serving } }; },
        readItem: async id => work.find(item => item.id === id)!, contains: async () => true });
      asks.push({ cycle: state.cycle, at: now, outcome: outcome.outcome });
      return outcome;
    },
  };
  /** One cycle a minute until `until`; a delivery merges every five. */
  const cycles = async (until: number) => {
    while (now < until) {
      now += minute;
      if ((now - start) % (5 * minute) === 0) work.push(delivery(next++, now - 30_000, blocked, submittedMs));
      const before = asks.length;
      await runCycle(config, state, effects, () => now);
      assert.ok(asks.length - before <= 1, `at most one ask per cycle: ${asks.length - before} in cycle ${state.cycle}`);
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${state.cycle} (+${(now - start) / minute} min): ${check.invariant} — ${check.reading}`);
    }
  };
  const throughputActions = () => Object.keys(state.actions).filter(key => key.includes('throughput'));
  const unblock = () => { blocked = false; };
  return { state, work, asks, counts, cycles, throughputActions, unblock, violations, claim, now: () => now };
}

test('unit:soak-throughput-remeasure — over a simulated day of one unverified release, re-measures stay spaced and bounded, and nothing is filed or escalated', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-throughput');
  try {
    const day1 = await world(root, false);
    await day1.cycles(start + day);
    const { asks, counts, state } = day1, recorded = asks.filter(ask => ask.outcome === 'recorded');
    assert.ok(recorded.length >= 2, `the release is re-measured as deliveries merge: ${recorded.length} measurement(s)`);
    for (let index = 1; index < recorded.length; index++) assert.ok(recorded[index].at - recorded[index - 1].at >= throughputRemeasureMs,
      `re-measures at least ${throughputRemeasureMs / minute} min apart: ${(recorded[index].at - recorded[index - 1].at) / minute} min before measurement ${index + 1}`);
    assert.ok(recorded.length <= day / throughputRemeasureMs + 1, `no more than one measurement per spacing: ${recorded.length}`);
    // An unverified answer is asked again on the failure backoff, which doubles from one cycle to its 30-cycle cap.
    for (let index = 2; index < asks.length; index++) assert.ok(asks[index].cycle - asks[index - 1].cycle >= 2, `asked on the backoff, never once per cycle: cycles ${asks[index - 1].cycle} and ${asks[index].cycle}`);
    assert.ok(asks.length <= Math.ceil(state.cycle / 30) + 8, `at most one ask per backoff cap once it saturates: ${asks.length} asks for ${recorded.length} measurements over ${state.cycle} cycles`);
    assert.equal(counts.statusReads, asks.length, 'one status read per ask');
    assert.ok((await readdir(join(root, throughputMeasurementDirectory))).filter(name => name !== throughputLedgerFile).length <= throughputMeasurementRetention, 'the measurement directory stays within its retention');
    assert.deepEqual(day1.throughputActions().sort(), [`throughput:${serving}`], 'one answer for the release, however long it serves');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:soak-throughput-stall — over a simulated day whose every delivery carries a coordinator fingerprint, the measurement shows the needs-decision and the release is re-measured hourly, and nothing is filed or escalated', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-throughput-stall');
  try {
    const stalled = await world(root, true);
    await stalled.cycles(start + day);
    const { asks, counts } = stalled;
    assert.ok(asks.length >= 12, `re-measured while the needs-decision stands: ${asks.length}`);
    // GY-2186: no owner item is filed and no escalation raised; the attention line is the ask.
    assert.deepEqual(stalled.throughputActions().sort(), [`throughput:${serving}`], 'one answer record for the release');
    assert.equal(counts.statusReads, asks.length, 'one status read per ask');
    assert.ok((await readdir(join(root, throughputMeasurementDirectory))).filter(name => name !== throughputLedgerFile).length <= throughputMeasurementRetention, 'the measurement directory stays within its retention');
  } finally { await rm(root, { recursive: true, force: true }); }
});
