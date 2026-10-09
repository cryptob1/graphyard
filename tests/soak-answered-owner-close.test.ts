import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import * as deliveryStep from '../src/daemon/cycle-delivery.js';
import { throughputEscalatedAt } from '../src/daemon/cycle-delivery.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { loopThroughputMeasurement, openThroughputOwner, throughputMeasurementDirectory, throughputOwnerAnswered, throughputStatus, verifyThroughput } from '../src/throughput.js';
import { appendThroughputLedger, recordedEntry } from '../src/throughput-ledger.js';
import { standingThroughputStall } from '../src/daemon/throughput-effect.js';
import { backlogCounts, machineKind } from '../src/model/machine-backlog.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1609 over simulated days. A throughput owner stays open across releases, so the escalated miss
 * it is asked is the serving release's, whatever its title says; the master closed GY-1589
 * (2026-10-09T16:17:50Z) and GY-1605 (21:42:51Z) by hand because the loop raised that decision only
 * after its answer was applied, so no applied revision could ever read as answering it, while master
 * status kept asking `master decide` on it. Here the loop runs on a one-minute cycle, woken half a minute in every fourth minute, with the
 * production measurement (`loopThroughputMeasurement`) and the production standing-ledger reader
 * (`standingThroughputStall`) over two days and an hour in which the serving release changes every eight hours,
 * a delivery merges every five minutes and misses its budget, and the master answers each decision
 * master status asks two minutes after it is asked (the GY-1590 latency). After every cycle:
 *
 * - master status asks a decision only on the open owner the loop raised it on, never one already applied;
 * - every applied answer has its owner closed by the loop in the next cycle, and the reported
 *   operator backlog never holds an answered owner;
 * - the standing ledger is read at most once per `throughputStandingReadMs`, the wakes adding no read;
 * - every system invariant holds.
 */
const minute = 60_000, hour = 60 * minute, day = 24 * hour, start = Date.parse('2026-10-07T00:00:00.000Z');
const sha = (label: string) => createHash('sha1').update(label).digest('hex');
// The interval an open owner's standing read is throttled to; a minute where the loop has no such read.
const throughputStandingReadMs = (deliveryStep as { throughputStandingReadMs?: number }).throughputStandingReadMs ?? minute;
const releaseEvery = 8 * hour, answerAfter = 2 * minute, end = start + 2 * day + hour;

/** A delivery merged at `at`, admitted (submitted, review executed, nothing a coordinator left on it), 45 min from submission to merge: the p50 budget misses. */
function delivery(index: number, at: number, submittedMs = 45 * minute): Work {
  const when = new Date(at).toISOString(), iso = (ms: number) => new Date(at - submittedMs + ms).toISOString();
  return { id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, key: `GY-${index}`, title: `Delivery ${index}`, description: '', type: 'bug', priority: 2, stage: 'done',
    revision: 3, policyRevision: 1, createdAt: when, updatedAt: when, stageEnteredAt: when, ready: true, epoch: 1, lease: null, workspaces: [], candidate: null,
    reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], criteria: [], dependencies: [], plannedFiles: [],
    policy: { checks: ['test'], review: true }, delivery: { mergeSha: sha(`merge-${index}`), mergedAt: when, mergedAtRepository: when },
    submission: { pr: index }, implementers: ['worker-1'],
    pipeline: { attempts: [{ epoch: 1, owner: 'worker-1', claimedAt: iso(-10 * minute), endedAt: iso(0), end: 'submitted' }], submittedAt: iso(0), reworkRounds: 0, interventions: { blocked: 0, requirements: 0 }, backfill: null },
    actionQueue: { actions: [], history: [{ id: `review-${index}`, kind: 'request-review', work: `w-${index}`, key: `GY-${index}`, inputs: { kind: 'request-review' }, gate: 'review', refusal: null, reason: '', binding: 'request-review:0',
      requestedBy: 'graphyard', requestedAt: iso(minute), state: 'done', claim: null, attempts: 1, resolvedAt: iso(3 * minute), result: 'done', resolution: 'settled', history: [
        { at: iso(minute), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: '' },
        { at: iso(2 * minute), event: 'claimed', requester: 'graphyard', executor: 'executor-a', result: null, reason: 'attempt 1 claimed by executor-a on host-a' },
        { at: iso(3 * minute), event: 'completed', requester: 'graphyard', executor: 'executor-a', result: 'done', reason: '' }] }] },
  } as unknown as Work;
}

test('integration:soak-answered-owner-close — over simulated days of release changes and decision-applied passes, with the production measurement and standing-ledger reader, every answered owner closes within one cycle, master status asks only a decision the loop raised and none already applied, the operator backlog never holds an answered owner, standing reads stay one a minute and every invariant holds; the GY-1589 and GY-1605 hand-close sequence no longer reproduces', { timeout: 600_000 }, async () => {
  const root = await temporaryDirectory('soak-answered-owner-close');
  try {
    const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, 'coordinator.token'), cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
      githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { intervalSeconds: 60, deploymentReuseMinutes: 0 } }) as MasterConfig;
    const state = emptyDaemonState(config);
    let now = start, serving = sha('release-0'), next = 2;
    state.lock = { id: 'lock', pid: process.pid, host: config.hostId, startedAt: new Date(now).toISOString(), heartbeatAt: new Date(now).toISOString() };
    const claim = delivery(1, start - 2 * hour);
    claim.delivery!.deployment = { sha: serving, mergeSha: claim.delivery!.mergeSha, source: 'endpoint', observedAt: new Date(start - hour).toISOString(), covers: 'exact', at: new Date(start - hour).toISOString(), observer: 'coordinator-1' } as never;
    const work: Work[] = [claim];
    // The pursuit opened 47 h before the soak on an unverified measurement, so it is escalated an hour in and stays so: every release's miss is escalated.
    await appendThroughputLedger(join(root, throughputMeasurementDirectory), recordedEntry(verifyThroughput([claim], start - 47 * hour, { deployed: { revision: serving, version: '0.9.1', origin: 'https://graphyard.example', observedAt: new Date(start - 47 * hour).toISOString(), containsClaim: true, reason: null } }), { source: 'loop', file: null, output: '' }));
    const filed: string[] = [], closed: { key: string; at: number }[] = [], standingReads: number[] = [], violations: string[] = [];
    const standing = standingThroughputStall(root, () => now);
    const effects: DaemonEffects = {
      agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
      snapshot: async () => ({ work: work.map(item => ({ ...item })), now: new Date(now).toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
      observeDeployment: async delivered => ({ source: 'endpoint', sha: serving, at: new Date(now).toISOString(), reason: null, deployed: delivered.map(item => item.key), pending: [], requests: 0 }) as never,
      recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
      standingThroughputStall: async revision => { standingReads.push(now); return standing(revision); },
      measureThroughput: (snapshot, observedSha) => loopThroughputMeasurement(root, { work: snapshot, observedSha, now: () => now, origin: 'https://graphyard.example', claimKey: claim.key,
        status: async () => ({ now: new Date(now).toISOString(), release: { version: '0.9.1', revision: serving } }) as never,
        readItem: async id => work.find(item => item.id === id)!, contains: async () => true }),
      fileThroughputOwner: async input => {
        const owner = { ...delivery(next++, now), title: input.title, description: input.description, criteria: input.criteria, stage: 'backlog', ready: false, delivery: undefined, submission: null, pipeline: undefined, actionQueue: undefined, policyRevision: 1 } as unknown as Work;
        filed.push(owner.key); work.push(owner); return owner;
      },
      closeThroughputOwner: async (owner, reason) => {
        const held = work.find(item => item.id === owner.id)!;
        Object.assign(held, { stage: 'done', closure: { kind: 'obsolete', reason, ref: null, by: 'operator-agent', at: new Date(now).toISOString(), from: held.stage } });
        closed.push({ key: owner.key, at: now }); return held;
      },
    };
    /** master status's throughput line, as `assembleReportedAttention` reads it: the recorded measurement, the serving release and the loop's escalation record. */
    const status = () => throughputStatus(root, { release: { version: '0.9.1', revision: serving } }, work, now, owner => throughputEscalatedAt(state.actions, owner));
    const decideOn = (next: string | undefined) => /graphyard master decide (GY-\d+) requirements/.exec(next ?? '')?.[1] ?? null;
    /** The operator backlog as master status counts it (`backlogCounts`), and the answered owners it holds. */
    const operatorBacklog = () => work.filter(item => item.stage === 'backlog' && !item.ready && !machineKind(item));
    const answeredInBacklog = () => operatorBacklog().filter(item => throughputOwnerAnswered(item, throughputEscalatedAt(state.actions, item)));

    const asked = new Map<string, number>(), applied = new Map<string, number>();
    const releases = [serving];
    const crossed = (from: number, every: number) => Math.floor((now - start) / every) > Math.floor((from - start) / every);
    while (now < end) {
      // A cycle a minute, and every fourth minute a wake half a minute in: the standing read is throttled, not paced by the cycle.
      const from = now;
      now += state.cycle % 4 === 3 ? minute / 2 : now % minute ? minute / 2 : minute;
      if (crossed(from, releaseEvery)) { serving = sha(`release-${releases.length}`); releases.push(serving); }
      if (crossed(from, 5 * minute)) work.push(delivery(next++, now - 30_000));
      await runCycle(config, state, effects, () => now);
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${state.cycle} (+${(now - start) / minute} min): ${check.invariant} — ${check.reading}`);

      // Every applied answer was closed by the loop in the cycle after it was applied.
      for (const [key, at] of applied) {
        const owner = work.find(item => item.key === key)!;
        assert.ok(owner.closure, `+${(now - start) / minute} min: ${key}, answered at +${(at - start) / minute} min, is closed by the loop within one cycle`);
        assert.equal(Date.parse(owner.closure!.at), now, `${key} closes in the first cycle after its answer`);
        assert.match(owner.closure!.reason, /was answered by its requirements revision 2; the loop closes it/);
        applied.delete(key);
      }
      assert.deepEqual(answeredInBacklog().map(item => item.key), [], `+${(now - start) / minute} min: the operator backlog holds no answered owner`);
      assert.ok(backlogCounts(work, now).operator <= 1, 'at most the one open owner carries the serving release');

      const line = await status(), key = decideOn(line.attention?.next);
      if (!key) continue;
      // master status asks only the decision the loop raised on the open owner, unanswered.
      const owner = openThroughputOwner(work)!;
      assert.equal(key, owner.key, 'asked on the open owner');
      const raisedAt = throughputEscalatedAt(state.actions, owner);
      assert.notEqual(raisedAt, null, `+${(now - start) / minute} min: ${key} is asked a decision the loop raised`);
      assert.equal(throughputOwnerAnswered(owner, raisedAt), false, `${key} is never asked a decision already applied`);
      if (!asked.has(key)) asked.set(key, now);
      // The master decides, and the approver applies the revision two minutes after the ask.
      if (now - asked.get(key)! >= answerAfter) {
        owner.policyRevision = raisedAt! + 1;
        applied.set(key, now);
        const after = await status();
        assert.equal(decideOn(after.attention?.next), null, `${key}'s applied decision is not asked again`);
        assert.doesNotMatch(after.attention!.next, /master approver/);
      }
    }

    assert.ok(releases.length >= 6, `the serving release changed ${releases.length - 1} times`);
    assert.equal(asked.size, releases.length, `one needs-decision asked per release: ${[...asked.keys()].join(', ')}`);
    assert.deepEqual(closed.map(item => item.key), [...asked.keys()], 'the loop closed every answered owner; no master closed one by hand');
    // The GY-1589/GY-1605 shape: an owner filed for one release, still open when the next serves, is asked and closed on the serving release's miss.
    const carried = closed.filter(({ key }) => { const owner = work.find(item => item.key === key)!; return releases.some(release => owner.closure!.reason.includes(`files a second owner for ${release.slice(0, 12)} `) && !owner.title.includes(release.slice(0, 12))); });
    assert.ok(carried.length >= releases.length - 1, `owners open across a release change are asked and closed on the serving release's miss: ${carried.length}`);
    assert.equal(work.filter(item => item.closure && !/the loop closes it/.test(item.closure.reason)).length, 0, 'every closure is the loop\'s');
    assert.deepEqual(filed.filter(key => !work.find(item => item.key === key)!.closure), [openThroughputOwner(work)!.key], 'one open owner carries the serving release');
    // The standing ledger is read at most once a minute, whatever the cycle cadence: the half-minute wakes add no read.
    for (let index = 1; index < standingReads.length; index++) assert.ok(standingReads[index] - standingReads[index - 1] >= throughputStandingReadMs, `standing reads spaced: ${standingReads[index] - standingReads[index - 1]} ms`);
    assert.ok(standingReads.length <= (end - start) / throughputStandingReadMs, `standing reads bounded by the interval: ${standingReads.length} over ${state.cycle} cycles`);
    assert.ok(state.cycle > (end - start) / minute, 'the wakes ran cycles inside the interval');
    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  } finally { await rm(root, { recursive: true, force: true }); }
});
