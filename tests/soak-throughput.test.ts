import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { loopThroughputMeasurement, openThroughputOwner, throughputClaim, throughputMeasurementDirectory, throughputMeasurementRetention, throughputRemeasureMs, throughputStallBound, throughputStatus, verifyThroughput } from '../src/throughput.js';
import { appendThroughputLedger, recordedEntry, throughputEscalationMs, throughputLedgerFile } from '../src/throughput-ledger.js';
import { standingThroughputStall } from '../src/daemon/throughput-effect.js';
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
 *   finding grows; once it is answered the loop closes the owner and, while the newest measurement
 *   still shows the needs-decision, files one successor in that same cycle, keyed by the answered
 *   revision, and raises it there once (GY-1465: never masterless; GY-1467: one successor per
 *   (release, answered revision), never a cycle unowned); once deliveries are made session-free again and its answer closes
 *   that one too, nothing stands and no further owner is filed;
 * - one whose deliveries are admitted (session-free, executed, submitted) but each takes 45 min from
 *   submission to merge, so the population accumulates past the claim's ten while the p50 budget
 *   misses (GY-1587): once the ledger's pursuit passes its escalation bound the escalated miss is
 *   raised once on the one owner, nothing more while it stands, and its answer closes the owner and
 *   files one successor that carries the release without the answered decision being asked again,
 *   with every system invariant holding after every cycle.
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
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], criteria: [], dependencies: [], plannedFiles: [],
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
  const asks: { cycle: number; at: number; outcome: string }[] = [], keys: string[] = [], violations: string[] = [], filed: string[] = [], closed: string[] = [], counts = { statusReads: 0 };
  const effects: DaemonEffects = {
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: work.map(item => ({ ...item })), now: new Date(now).toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async delivered => ({ source: 'endpoint', sha: serving, at: new Date(now).toISOString(), reason: null, deployed: delivered.map(item => item.key), pending: [], requests: 0 }) as never,
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    // The production read (`throughputEffects`): the needs-decision standing on the newest measurement recorded under `root`.
    standingThroughputStall: standingThroughputStall(root),
    measureThroughput: async (snapshot, observedSha) => {
      const outcome = await loopThroughputMeasurement(root, { work: snapshot, observedSha, now: () => now, origin: 'https://graphyard.example', claimKey: claim.key,
        status: async () => { counts.statusReads++; return { now: new Date(now).toISOString(), release: { version: '0.9.1', revision: serving } }; },
        readItem: async id => work.find(item => item.id === id)!, contains: async () => true });
      asks.push({ cycle: state.cycle, at: now, outcome: outcome.outcome });
      return outcome;
    },
    fileThroughputOwner: async (input, key) => {
      keys.push(key);
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
      if ((now - start) % (5 * minute) === 0) work.push(delivery(next++, now - 30_000, blocked, submittedMs));
      const before = asks.length;
      await runCycle(config, state, effects, () => now);
      assert.ok(asks.length - before <= 1, `at most one ask per cycle: ${asks.length - before} in cycle ${state.cycle}`);
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${state.cycle} (+${(now - start) / minute} min): ${check.invariant} — ${check.reading}`);
    }
  };
  const throughputActions = () => Object.keys(state.actions).filter(key => key.includes('throughput'));
  const escalations = () => Object.entries(state.actions).filter(([key]) => key.startsWith('escalation:throughput:'));
  const unblock = () => { blocked = false; };
  return { state, work, asks, filed, closed, counts, cycles, throughputActions, escalations, unblock, keys, violations, claim, now: () => now };
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

    // The answer: an approved requirements revision applied to the owner. The loop closes it; the newest
    // measurement still shows the needs-decision, so that same cycle files one successor and raises it there once.
    owner.policyRevision = 2;
    await stalled.cycles(start + day + 4 * hour);
    assert.deepEqual(closed, [owner.key]);
    const successor = openThroughputOwner(work)!;
    assert.ok(successor && successor.key !== owner.key);
    assert.deepEqual(filed, [owner.key, successor.key], 'one successor for the closure, while the needs-decision stands');
    const succeeded = Object.values(stalled.state.actions).filter(action => action.detail.startsWith(`Filed ${successor.key} `));
    assert.equal(succeeded.length, 1);
    // The answer closes the owner in the first cycle past the day (+1 min), and the successor is filed in that cycle.
    assert.equal(Date.parse(work.find(item => item.key === owner.key)!.closure!.at), start + day + minute);
    assert.equal(Date.parse(succeeded[0].at), start + day + minute, 'filed in the cycle that closed its predecessor');
    assert.equal(stalled.keys.length, 2, 'one filing each, never retried once filed');
    assert.ok(stalled.keys[1].startsWith(`throughput-owner:${serving}:${owner.key}:2:`), `keyed by the predecessor and the revision that answered it: ${stalled.keys[1]}`);
    assert.deepEqual(stalled.escalations().map(([, action]) => action.work), [owner.key, successor.key], 'escalations stay bounded: one per owner');

    // Deliveries become session-free again; the hourly re-measure finds nothing standing, and the successor's answer closes it with no third owner.
    stalled.unblock();
    await stalled.cycles(start + day + 8 * hour);
    successor.policyRevision = 2;
    await stalled.cycles(start + day + 12 * hour);
    assert.deepEqual(closed, [owner.key, successor.key]);
    assert.deepEqual(filed, [owner.key, successor.key], 'nothing stands, so no further owner is filed');
    assert.equal(openThroughputOwner(work), null);
    assert.equal(stalled.escalations().length, 2, 'one escalation per owner');
    assert.ok(stalled.throughputActions().length <= 4, `the loop's throughput records stay bounded: ${stalled.throughputActions().join(', ')}`);
    assert.equal(counts.statusReads, asks.length, 'one status read per ask');
    assert.ok((await readdir(join(root, throughputMeasurementDirectory))).filter(name => name !== throughputLedgerFile).length <= throughputMeasurementRetention, 'the measurement directory stays within its retention');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:soak-throughput-escalated-miss — over simulated days of one release whose session-free population accumulates while its p50 budget misses, the escalated miss is raised once on the one owner past the pursuit\'s bound, nothing more while it stands, and its answer closes the owner and files one successor that is never asked the answered decision again; reads, filings and escalations stay bounded and every invariant holds', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('soak-throughput-escalated-miss');
  try {
    const missing = await world(root, false, 45 * minute);
    // The pursuit opened 40 h before the day on an unverified measurement of this release, so it passes its 48 h bound 8 h in.
    const openedAt = start - 40 * hour;
    await appendThroughputLedger(join(root, throughputMeasurementDirectory), recordedEntry(verifyThroughput([missing.claim], openedAt, { deployed: { revision: serving, version: '0.9.1', origin: 'https://graphyard.example', observedAt: new Date(openedAt).toISOString(), containsClaim: true, reason: null } }), { source: 'loop', file: null, output: '' }));
    const escalatesAt = openedAt + throughputEscalationMs;

    // Before the bound: the population accumulates past ten, the budget misses, and the loop carries it.
    await missing.cycles(escalatesAt - minute);
    const { asks, filed, closed, counts, work, state } = missing;
    const owner = openThroughputOwner(work)!;
    assert.deepEqual(filed, [owner.key], 'one owner, filed once');
    assert.deepEqual(missing.escalations(), [], 'inside the bound nothing is escalated');
    const status = (at: number) => throughputStatus(root, { release: { version: '0.9.1', revision: serving } }, work, at);
    const early = await status(missing.now());
    assert.ok(early.owner.admitted >= throughputClaim.minimumDeliveries, `the population accumulated: ${early.owner.admitted} admitted`);
    assert.equal(early.verdict, 'unverified');

    // Past the bound, for the rest of the day: raised once on the open owner, and never again while it stands.
    await missing.cycles(start + day);
    const raised = missing.escalations();
    assert.equal(raised.length, 1, 'the escalated miss is raised once');
    assert.equal(raised[0][1].work, owner.key); assert.equal(raised[0][1].attempts, 1);
    assert.match(raised[0][1].detail, new RegExp(`^needs decision on ${owner.key}: GY-87's budgets missed .* over an accumulating population`));
    const raisedAt = Date.parse(raised[0][1].at);
    assert.ok(raisedAt >= escalatesAt && raisedAt <= escalatesAt + throughputRemeasureMs, `raised within one re-measure of the bound: ${raised[0][1].at}`);
    const standing = await status(missing.now());
    assert.equal(standing.stall?.cause, 'escalated-miss');
    assert.match(standing.attention!.next, new RegExp(`graphyard master decide ${owner.key} requirements`));
    assert.deepEqual(closed, [], 'unanswered, the owner stays open');
    const recorded = asks.filter(ask => ask.outcome === 'recorded');
    for (let index = 1; index < recorded.length; index++) assert.ok(recorded[index].at - recorded[index - 1].at >= throughputRemeasureMs, 're-measures stay spaced');
    assert.ok(recorded.length <= day / throughputRemeasureMs + 2, `re-measures stay bounded: ${recorded.length}`);

    // The answer: an approved requirements revision applied after the raise. The loop closes the owner on it, and one successor
    // carries the release; the answered decision is not asked again over the next half day of the same misses.
    owner.policyRevision = 2;
    await missing.cycles(start + day + 12 * hour);
    assert.deepEqual(closed, [owner.key]);
    assert.match(work.find(item => item.key === owner.key)!.closure!.reason, /on an escalated budget miss\) was answered by its requirements revision 2/);
    const successor = openThroughputOwner(work)!;
    assert.ok(successor && successor.key !== owner.key);
    assert.deepEqual(filed, [owner.key, successor.key], 'one successor, filed once');
    assert.equal(missing.keys.length, 2, 'one filing each, never retried once filed');
    assert.deepEqual(missing.escalations().map(([, action]) => action.work), [owner.key], 'the answered escalated miss is not raised on the successor');
    const after = await status(missing.now());
    assert.equal(after.stall, null);
    assert.equal(after.owner.item, successor.key);
    assert.doesNotMatch(after.attention!.text, /needs decision|escalated:/);
    assert.match(after.attention!.text, new RegExp(`answered at .*, so ${successor.key} carries the verification`));
    assert.ok(missing.throughputActions().length <= 3, `the loop's throughput records stay bounded: ${missing.throughputActions().join(', ')}`);
    assert.equal(counts.statusReads, asks.length, 'one status read per ask');
    for (let index = 2; index < asks.length; index++) assert.ok(asks[index].cycle - asks[index - 1].cycle >= 2, 'asked on the backoff, never once per cycle');
    assert.ok((await readdir(join(root, throughputMeasurementDirectory))).filter(name => name !== throughputLedgerFile).length <= throughputMeasurementRetention, 'the measurement directory stays within its retention');
    assert.deepEqual(missing.violations, [], 'every system invariant holds after every cycle');
    assert.ok(state.cycle >= 36 * 60);
  } finally { await rm(root, { recursive: true, force: true }); }
});
