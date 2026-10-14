import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { decisionInput, masterConfigSchema, type MasterConfig } from '../src/master.js';
import { loopThroughputMeasurement, openThroughputOwner, throughputMeasurementDirectory, throughputOwnerAnswered, throughputStatus, verifyThroughput } from '../src/throughput.js';
import { appendThroughputLedger, recordedEntry } from '../src/throughput-ledger.js';
import { standingThroughputStall } from '../src/daemon/throughput-effect.js';
import { throughputEscalatedAt, throughputEscalationKey } from '../src/daemon/cycle-delivery.js';
import { approverJudgeBoundMs, maxApproverLaunches } from '../src/daemon/decisions.js';
import { unansweredDecisionMs } from '../src/daemon/doctor.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1630 over simulated days. The loop requests the throughput owner's standing needs-decision
 * itself (effects.decide) and routes it to the independent approver (effects.approver), with no
 * master or doctor session in the path. It runs on a one-minute cycle for sixteen hours with the
 * production measurement and standing-ledger reader, the serving release changing every four hours
 * and a delivery merging every five minutes over its budget, so every release's miss is escalated on
 * the open owner. Each request's first approver is lost three minutes in without judging; its
 * replacement approves four minutes after launch, except the last request of the soak, which is
 * refused. After every cycle:
 *
 * - every request the loop made is the option of record on the open owner, at the revision the
 *   needs-decision was raised at, and is made once per raise, never once per cycle;
 * - an unanswered request has a live approver again within unansweredDecisionMs, and no request
 *   launches more than maxApproverLaunches approvers;
 * - every approved revision closes its owner in the next cycle, a successor carries the serving
 *   release, and an answered decision is never requested again;
 * - master status names the loop, never a master session, as the decision's agent-owner;
 * - every system invariant holds, and the loop's approval watches stay bounded.
 *
 * Once refused, the request stands for the master: nothing is requested or launched again on it.
 */
const minute = 60_000, hour = 60 * minute, start = Date.parse('2026-10-07T00:00:00.000Z'), end = start + 16 * hour - minute, releaseEvery = 4 * hour;
const sha = (label: string) => createHash('sha1').update(label).digest('hex');
type Ledgered = { id: string; action: string; state: string; input: any; reason: string; outcome: string | null; approvedBy: string | null; approvedAt?: string | null; refusal: { approver: string; reason: string } | null };

/** An admitted delivery merged at `at` that took 45 min from submission to merge: the p50 budget misses. */
function delivery(index: number, at: number): Work {
  const when = new Date(at).toISOString(), iso = (ms: number) => new Date(at - 45 * minute + ms).toISOString();
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

test('integration:soak-throughput-self-request — over sixteen hours of release changes, the loop requests every raised throughput needs-decision itself once, routes it to the independent approver, relaunches a lost approver within unansweredDecisionMs, closes each approved owner in the next cycle with a successor carrying the release, never asks an answered decision again, leaves a refusal standing, and every invariant holds', { timeout: 600_000 }, async () => {
  const root = await temporaryDirectory('soak-throughput-self-request');
  try {
    const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, 'coordinator.token'), cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main',
      githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [], run: { intervalSeconds: 60, deploymentReuseMinutes: 0 } }) as MasterConfig;
    const state = emptyDaemonState(config);
    let now = start, release = sha('release-0'), next = 2, id = 0;
    state.lock = { id: 'lock', pid: process.pid, host: config.hostId, startedAt: new Date(now).toISOString(), heartbeatAt: new Date(now).toISOString() };
    const claim = delivery(1, start - 2 * hour);
    claim.delivery!.deployment = { sha: release, mergeSha: claim.delivery!.mergeSha, source: 'endpoint', observedAt: new Date(start - hour).toISOString(), covers: 'exact', at: new Date(start - hour).toISOString(), observer: 'coordinator-1' } as never;
    const work: Work[] = [claim];
    // The pursuit opened 47 h before the soak on an unverified measurement, so every release's miss is escalated.
    await appendThroughputLedger(join(root, throughputMeasurementDirectory), recordedEntry(verifyThroughput([claim], start - 47 * hour, { deployed: { revision: release, version: '0.9.1', origin: 'https://graphyard.example', observedAt: new Date(start - 47 * hour).toISOString(), containsClaim: true, reason: null } }), { source: 'loop', file: null, output: '' }));

    const ledger = new Map<string, Ledgered[]>(), gone = new Set<string>(), violations: string[] = [], filed: string[] = [], closed: { key: string; at: number }[] = [], withdrawn: string[] = [];
    const requests: { key: string; input: any; at: number; raisedAt: number }[] = [], launches: { key: string; decision: string; agentName: string; at: number }[] = [];
    const effects: DaemonEffects = {
      agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
      snapshot: async () => ({ work: work.map(item => ({ ...item })), now: new Date(now).toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
      observeDeployment: async delivered => ({ source: 'endpoint', sha: release, at: new Date(now).toISOString(), reason: null, deployed: delivered.map(item => item.key), pending: [], requests: 0 }) as never,
      recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
      standingThroughputStall: standingThroughputStall(root, () => now),
      measureThroughput: async (snapshot, observedSha) => loopThroughputMeasurement(root, { work: snapshot, observedSha, now: () => now, origin: 'https://graphyard.example', claimKey: claim.key,
        status: async () => ({ now: new Date(now).toISOString(), release: { version: '0.9.1', revision: release } }) as never, readItem: async item => work.find(each => each.id === item)!, contains: async () => true }),
      readThroughputOwner: async owner => ({ ...work.find(item => item.id === owner.id)! }),
      fileThroughputOwner: async input => {
        const owner = { ...delivery(next++, now), title: input.title, description: input.description, criteria: input.criteria, stage: 'backlog', ready: false, delivery: undefined, policyRevision: 1 } as unknown as Work;
        filed.push(owner.key); work.push(owner); return owner;
      },
      closeThroughputOwner: async (owner, reason) => {
        const held = work.find(item => item.id === owner.id)!;
        Object.assign(held, { stage: 'done', closure: { kind: 'obsolete', reason, ref: null, by: 'operator-agent', at: new Date(now).toISOString(), from: held.stage } });
        closed.push({ key: owner.key, at: now }); return held;
      },
      // The control plane's decision ledger and the approver sessions, as the loop's decision effects see them.
      herdr: () => ({ available: true, agents: launches.filter(launch => ledger.get(launch.key)!.find(entry => entry.id === launch.decision)?.state === 'requested' && !gone.has(launch.agentName)).map(launch => ({ name: launch.agentName, agent_status: 'working' })) }) as never,
      decisions: async item => ({ decisions: ledger.get(item.key) ?? [] }),
      decide: async (item, action, reason, input = {}) => {
        const full = decisionInput(action, item, input), entry: Ledgered = { id: `00000000-0000-4000-9000-${String(++id).padStart(12, '0')}`, action, state: 'requested', input: full, reason, outcome: null, approvedBy: null, refusal: null };
        requests.push({ key: item.key, input: full, at: now, raisedAt: throughputEscalatedAt(state.actions, item) ?? -1 });
        ledger.set(item.key, [...ledger.get(item.key) ?? [], entry]);
        return { id: entry.id };
      },
      withdraw: async (item, decision) => { withdrawn.push(`${item.key}:${decision}`); },
      approver: async (item, decision) => {
        const agentName = `gy-approver-${item.key.toLowerCase()}-${launches.length}`;
        launches.push({ key: item.key, decision, agentName, at: now });
        return { agentName, pane: null };
      },
    };

    const releases = [release], applied = new Map<string, number>(), lostAt = new Map<string, number>();
    let refusedOn: string | null = null;
    const crossed = (from: number, every: number) => Math.floor((now - start) / every) > Math.floor((from - start) / every);
    while (now < end) {
      const from = now;
      now += minute;
      if (crossed(from, releaseEvery)) { release = sha(`release-${releases.length}`); releases.push(release); }
      if (crossed(from, 5 * minute)) work.push(delivery(next++, now - 30_000));
      await runCycle(config, state, effects, () => now);
      const at = `+${(now - start) / minute} min`;
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${state.cycle} (${at}): ${check.invariant} — ${check.reading}`);

      // Every applied answer closed its owner in the next cycle, and a successor carries the serving release.
      for (const [key, answeredAt] of applied) {
        const owner = work.find(item => item.key === key)!;
        assert.ok(owner.closure, `${at}: ${key}, approved at +${(answeredAt - start) / minute} min, is closed by the loop within one cycle`);
        assert.equal(Date.parse(owner.closure!.at), now, `${key} closes in the first cycle after its approval`);
        assert.match(owner.closure!.reason, /was answered by its requirements revision \d+; the loop closes it/);
        assert.ok(openThroughputOwner(work), `${at}: a successor carries the release once ${key} closes`);
        applied.delete(key);
      }
      // One request per raise, each the option of record on the owner at the revision it was raised at.
      const raises = new Set(requests.map(request => `${request.key}:${request.raisedAt}`));
      assert.equal(raises.size, requests.length, `${at}: one request per raise, never one per cycle: ${requests.map(request => `${request.key}:${request.raisedAt}`).join(', ')}`);
      for (const request of requests) {
        assert.equal(request.input.expectedPolicyRevision, request.raisedAt, `${request.key}'s request binds the revision it was raised at`);
        assert.match(request.input.criteria[0].text, /the coordination is left unchanged.*recorded unverified and never relaxed/);
      }
      assert.deepEqual(withdrawn, [], `${at}: nothing the loop asked is withdrawn`);
      // A requested decision with no live approver has one again within unansweredDecisionMs, never past maxApproverLaunches.
      for (const [key, entries] of ledger) for (const entry of entries) {
        const own = launches.filter(launch => launch.decision === entry.id);
        assert.ok(own.length <= maxApproverLaunches, `${at}: ${key}'s request launched ${own.length} approvers`);
        if (entry.state === 'requested') assert.ok(own.length, `${at}: ${key}'s request is routed to an approver in the cycle it is made`);
      }
      for (const [agentName, lost] of lostAt) {
        const launch = launches.find(each => each.agentName === agentName)!, relaunched = launches.find(each => each.decision === launch.decision && each.at > lost);
        const entry = ledger.get(launch.key)!.find(each => each.id === launch.decision)!;
        if (entry.state === 'requested') assert.ok(relaunched || now - lost < unansweredDecisionMs, `${at}: ${launch.key}'s lost approver is replaced within ${unansweredDecisionMs / minute} min`);
        if (relaunched) { assert.ok(relaunched.at - lost < unansweredDecisionMs); lostAt.delete(agentName); }
      }
      // master status names the loop as the agent-owner of the standing decision, never a master session.
      const line = await throughputStatus(root, { release: { version: '0.9.1', revision: release } }, work, now, owner => throughputEscalatedAt(state.actions, owner), true);
      assert.doesNotMatch(line.attention?.next ?? '', /graphyard master (decide|approver)/, `${at}: the attention names no hand path`);
      if (line.stall) assert.equal(line.attention!.role, 'control plane');
      assert.ok(Object.keys(state.approvals).length <= requests.length + 2, `${at}: the approval watches stay bounded: ${Object.keys(state.approvals).length}`);

      // The simulated approvers: each request's first loses its session three minutes in; a replacement judges four minutes after launch.
      for (const [key, entries] of ledger) for (const entry of entries.filter(each => each.state === 'requested')) {
        const own = launches.filter(launch => launch.decision === entry.id), first = own[0]!, last = own.at(-1)!;
        if (own.length === 1 && now - first.at >= 3 * minute && !gone.has(first.agentName)) { gone.add(first.agentName); lostAt.set(first.agentName, now); continue; }
        if (own.length < 2 || now - last.at < 4 * minute) continue;
        const owner = work.find(item => item.key === key)!;
        if (now + releaseEvery >= end && !refusedOn) {
          Object.assign(entry, { state: 'refused', refusal: { approver: 'graphyard-approver', reason: 'Not on this release' } });
          refusedOn = key;
          continue;
        }
        if (refusedOn) continue;
        Object.assign(entry, { state: 'applied', approvedBy: 'graphyard-approver', approvedAt: new Date(now).toISOString(), outcome: `Requirements revised to policy revision ${entry.input.expectedPolicyRevision + 1}` });
        owner.policyRevision = entry.input.expectedPolicyRevision + 1;
        applied.set(key, now);
      }
    }

    assert.ok(releases.length >= 4, `the serving release changed ${releases.length - 1} times`);
    const answered = requests.filter(request => request.key !== refusedOn);
    assert.equal(requests.length, releases.length, `one decision requested per release: ${requests.length} for ${releases.length}`);
    assert.equal(answered.length, releases.length - 1, `its approver answered every one but the refused last: ${answered.length} of ${releases.length}`);
    assert.deepEqual(closed.map(item => item.key), answered.map(request => request.key), 'every approved owner closed, and only those');
    for (const { key } of closed) assert.equal(throughputOwnerAnswered(work.find(item => item.key === key)!, throughputEscalatedAt(state.actions, { key }) ?? requests.find(request => request.key === key)!.raisedAt), true);
    assert.equal(new Set(requests.map(request => request.key)).size, requests.length, 'no owner was asked twice: an answered decision is never requested again');
    assert.ok(filed.length <= requests.length + 1, `owners stay bounded by the raises: ${filed.length} filed for ${requests.length} requests`);
    assert.equal(launches.length, 2 * requests.length, `each request's lost approver was replaced once, and no more: ${launches.length} launches for ${requests.length} requests`);

    // The refusal stands on the owner for the master: the escalation still waits, and nothing is requested or launched again on it.
    assert.ok(refusedOn, 'the last request was refused');
    const refused = ledger.get(refusedOn!)!;
    assert.equal(refused.length, 1);
    assert.equal(state.actions[throughputEscalationKey(refusedOn!, requests.find(request => request.key === refusedOn)!.raisedAt)]?.state, 'waiting');
    assert.equal(openThroughputOwner(work)?.key, refusedOn);
    assert.ok(Object.entries(state.actions).some(([key, action]) => key.startsWith('escalation:decision-refused:') && action.work === refusedOn), 'the refusal is left standing for the master');
    assert.equal(launches.filter(launch => launch.key === refusedOn).length, 2, 'no approver relaunched on a refused decision');
    assert.ok(approverJudgeBoundMs <= unansweredDecisionMs);
    assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  } finally { await rm(root, { recursive: true, force: true }); }
});
