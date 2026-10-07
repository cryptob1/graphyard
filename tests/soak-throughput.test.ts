import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { loopThroughputMeasurement, openThroughputOwner, throughputMeasurementDirectory, throughputMeasurementRetention, throughputRemeasureMs, throughputStallBound } from '../src/throughput.js';
import { throughputLedgerFile } from '../src/throughput-ledger.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1438 over simulated days. The loop re-measures the serving release while its newest
 * measurement is unverified and deliveries keep merging, files one item to own the verification,
 * and raises a needs-decision when session-free deliveries cannot accumulate. Each of those repeats
 * per cycle for as long as the release serves, so the loop runs here on a one-minute cycle over a
 * whole day of one release, a delivery merging every five minutes, in two worlds:
 *
 * - one whose deliveries are excluded for reasons no coordinator left (no submission is recorded),
 *   so the population may yet accumulate and nothing escalates: every re-measure is at least
 *   `throughputRemeasureMs` after the one before, the asks between them follow the failure backoff,
 *   never one per cycle, with one status read per ask, and the measurement directory, the loop's actions and the owner items stay
 *   bounded however long the release serves;
 * - one whose every delivery carries a coordinator fingerprint (a blocked report), so past the bound
 *   the population cannot accumulate: the needs-decision is raised once on the one owner, and while
 *   it stands unanswered the loop re-measures hourly (GY-1458) but raises nothing more, however the
 *   finding grows; once it is answered the loop closes the owner and files no second one for the release.
 */
const minute = 60_000, hour = 60 * minute, day = 24 * hour, start = Date.parse('2026-10-07T00:00:00.000Z');
const sha = (label: string) => createHash('sha1').update(label).digest('hex');
const serving = sha('serving-release');

/** A delivered item as the snapshot carries it, merged at `at`; `blocked` gives it a coordinator fingerprint. */
function delivery(index: number, at: number, blocked: boolean): Work {
  const when = new Date(at).toISOString();
  return { id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, key: `GY-${index}`, title: `Delivery ${index}`, description: '', type: 'bug', priority: 2, stage: 'done',
    revision: 3, policyRevision: 1, createdAt: when, updatedAt: when, stageEnteredAt: when, ready: true, epoch: 1, lease: null, workspaces: [], candidate: null, submission: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], criteria: [], dependencies: [], plannedFiles: [],
    policy: { checks: ['test'], review: true }, delivery: { mergeSha: sha(`merge-${index}`), mergedAt: when, mergedAtRepository: when },
    ...(blocked ? { pipeline: { attempts: [], interventions: { blocked: 1, requirements: 0 } } } : {}) } as unknown as Work;
}

/** One simulated world: a release serving all day, the loop on a one-minute cycle, a delivery merging every five minutes. */
async function world(root: string, blocked: boolean) {
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
  const asks: { cycle: number; at: number; outcome: string }[] = [], filed: string[] = [], closed: string[] = [], counts = { statusReads: 0 };
  const effects: DaemonEffects = {
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: work.map(item => ({ ...item })), now: new Date(now).toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async delivered => ({ source: 'endpoint', sha: serving, at: new Date(now).toISOString(), reason: null, deployed: delivered.map(item => item.key), pending: [], requests: 0 }) as never,
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    measureThroughput: async (snapshot, observedSha) => {
      const outcome = await loopThroughputMeasurement(root, { work: snapshot, observedSha, now: () => now, origin: 'https://graphyard.example', claimKey: claim.key,
        status: async () => { counts.statusReads++; return { now: new Date(now).toISOString(), release: { version: '0.9.1', revision: serving } }; },
        readItem: async id => work.find(item => item.id === id)!, contains: async () => true });
      asks.push({ cycle: state.cycle, at: now, outcome: outcome.outcome });
      return outcome;
    },
    fileThroughputOwner: async input => {
      const owner = { ...delivery(next++, now, false), title: input.title, description: input.description, criteria: input.criteria, stage: 'backlog', ready: false, delivery: undefined, policyRevision: 1 } as unknown as Work;
      filed.push(owner.key); work.push(owner); return owner;
    },
    closeThroughputOwner: async (owner, reason) => {
      const held = work.find(item => item.id === owner.id)!;
      Object.assign(held, { stage: 'done', closure: { kind: 'obsolete', reason, ref: null, by: 'operator-agent', at: new Date(now).toISOString(), from: held.stage } });
      closed.push(owner.key); return held;
    },
  };
  /** One cycle a minute until `until`; a delivery merges every five. */
  const cycles = async (until: number) => {
    while (now < until) {
      now += minute;
      if ((now - start) % (5 * minute) === 0) work.push(delivery(next++, now - 30_000, blocked));
      const before = asks.length;
      await runCycle(config, state, effects, () => now);
      assert.ok(asks.length - before <= 1, `at most one ask per cycle: ${asks.length - before} in cycle ${state.cycle}`);
    }
  };
  const throughputActions = () => Object.keys(state.actions).filter(key => key.includes('throughput'));
  const escalations = () => Object.entries(state.actions).filter(([key]) => key.startsWith('escalation:throughput:'));
  return { state, work, asks, filed, closed, counts, cycles, throughputActions, escalations };
}

test('unit:soak-throughput-remeasure — over a simulated day of one unverified release whose population may yet accumulate, re-measures stay spaced and bounded, one owner item is filed and stays open, and nothing escalates', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-throughput');
  try {
    const day1 = await world(root, false);
    await day1.cycles(start + day);
    const { asks, filed, closed, counts, state } = day1, recorded = asks.filter(ask => ask.outcome === 'recorded');
    assert.ok(recorded.length >= 2, `the release is re-measured as deliveries merge: ${recorded.length} measurement(s)`);
    for (let index = 1; index < recorded.length; index++) assert.ok(recorded[index].at - recorded[index - 1].at >= throughputRemeasureMs,
      `re-measures at least ${throughputRemeasureMs / minute} min apart: ${(recorded[index].at - recorded[index - 1].at) / minute} min before measurement ${index + 1}`);
    assert.ok(recorded.length <= day / throughputRemeasureMs + 1, `no more than one measurement per spacing: ${recorded.length}`);
    // An unverified answer is asked again on the failure backoff, which doubles from one cycle to its 30-cycle cap.
    for (let index = 2; index < asks.length; index++) assert.ok(asks[index].cycle - asks[index - 1].cycle >= 2, `asked on the backoff, never once per cycle: cycles ${asks[index - 1].cycle} and ${asks[index].cycle}`);
    assert.ok(asks.length <= Math.ceil(state.cycle / 30) + 8, `at most one ask per backoff cap once it saturates: ${asks.length} asks for ${recorded.length} measurements over ${state.cycle} cycles`);
    assert.equal(counts.statusReads, asks.length, 'one status read per ask');
    assert.ok((await readdir(join(root, throughputMeasurementDirectory))).filter(name => name !== throughputLedgerFile).length <= throughputMeasurementRetention, 'the measurement directory stays within its retention');
    assert.deepEqual(filed, ['GY-2'], 'one owner item for the unverified release, filed once');
    assert.deepEqual(closed, [], 'the owner stays open while the claim is unverified and no decision is asked of it');
    assert.deepEqual(day1.escalations(), [], 'a population that may yet accumulate is never escalated');
    assert.deepEqual(day1.throughputActions().sort(), [`throughput:${serving}`, `throughput:owner:${serving}`], 'one answer and one owner record for the release, however long it serves');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:soak-throughput-stall — over a simulated day whose every delivery carries a coordinator fingerprint, the needs-decision is raised once on the one owner, the release is re-measured hourly but nothing raised again while it stands, and its answer closes the owner', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-throughput-stall');
  try {
    const stalled = await world(root, true);
    await stalled.cycles(start + day);
    const { asks, filed, closed, counts, work } = stalled;
    const owner = openThroughputOwner(work)!;
    assert.deepEqual(filed, [owner.key], 'one owner, filed once and still open');
    const escalations = stalled.escalations();
    assert.equal(escalations.length, 1, 'the needs-decision is raised once');
    assert.equal(escalations[0][1].work, owner.key); assert.equal(escalations[0][1].attempts, 1);
    assert.match(escalations[0][1].detail, new RegExp(`^needs decision on ${owner.key}: session-free deliveries cannot accumulate`));
    // Raised by the first measurement whose window reached the bound; after it, the window kept growing — a changed finding —
    // and the loop re-measured it every hour (GY-1458), in the first cycle past the hour, without raising it again.
    const raisedAt = Date.parse(escalations[0][1].at);
    assert.ok(raisedAt < start + day / 2, `raised once the window passed the bound of ${throughputStallBound}, early in the day`);
    const remeasured = asks.filter(ask => ask.outcome === 'recorded' && ask.at >= raisedAt);
    assert.ok(remeasured.length >= 12, `re-measured hourly while the needs-decision stands: ${remeasured.length}`);
    for (let index = 1; index < remeasured.length; index++) assert.equal(remeasured[index].at - remeasured[index - 1].at, throughputRemeasureMs, 'each re-measure in the cycle that finds the hour passed');
    assert.deepEqual(closed, [], 'still open: neither verified nor answered');

    // The answer: an approved requirements revision applied to the owner. The loop closes it and files no second one for this release.
    owner.policyRevision = 2;
    await stalled.cycles(start + day + 4 * hour);
    assert.deepEqual(closed, [owner.key]);
    assert.deepEqual(filed, [owner.key], 'no second owner for a release whose owner closed on an answered decision');
    assert.equal(stalled.escalations().length, 1, 'escalations stay bounded: one per owner');
    assert.ok(stalled.throughputActions().length <= 3, `the loop's throughput records stay bounded: ${stalled.throughputActions().join(', ')}`);
    assert.equal(counts.statusReads, asks.length, 'one status read per ask');
    assert.ok((await readdir(join(root, throughputMeasurementDirectory))).filter(name => name !== throughputLedgerFile).length <= throughputMeasurementRetention, 'the measurement directory stays within its retention');
  } finally { await rm(root, { recursive: true, force: true }); }
});
