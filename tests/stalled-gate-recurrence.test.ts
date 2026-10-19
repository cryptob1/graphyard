import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState } from '../src/master-daemon.js';
import { actorlessSubmissions } from '../src/cli/actorless-submissions.js';
import { stalledActionAttention } from '../src/cli/stalled-actions.js';
import { syncConflict } from '../src/daemon/decisions.js';
import { reviewNeed } from '../src/model/dispatch.js';
import { actionId, type ActionRecord, type ActionRow } from '../src/model/actions.js';
import { actionStall, actionStallThreshold } from '../src/model/action-progress.js';
import { classifyAttention, faultClassPolicyFromEnv } from '../src/model/fault-classes.js';
import { recurringClasses } from '../src/model/fault-class-recurrence.js';
import { trackFaults } from '../src/model/fault-record.js';
import { coordinationSnapshot } from '../src/server/work-view.js';

// GY-1403 names this file for its proof: manual:fault-class-stalled-gate. The master loop filed 3
// stalled-gate faults in 24 hours on 6–7 October 2026: two `actorless` submissions (GY-1357,
// GY-1292) and one `blocker` (GY-1292). The shared cause: each reading counted a remedy the product
// was already carrying out, before the bound that remedy takes.
//
//   - actorless (both): a head that does not contain the base tip. GitHub reported GY-1357's head
//     conflicting, and the loop's routine decision step requested the sync rework (syncConflict) 25s
//     after the fault, once a fresh observation described the head; GitHub had not yet computed
//     GY-1292's mergeability, and the next observation's test merge recorded the conflict and raised
//     the `request-rework` row 21s after it. The actorless bound is 5 minutes from submission, but
//     that path spans observations and loop cycles of up to three minutes each.
//   - blocker: counted 100s after the worker raised it. The master requested the requirements
//     decision applying the operator's approved revision of AC-1 within four minutes; the item was
//     unblocked in thirty — the master's turn (`masterTurnWaitBoundMs`), as for an owed escalation.
//
// Each instance is replayed from the ledger (tests/fixtures/gy-1403-stalled-gate.json, read from
// `graphyard events`) as the item stood when the loop recorded it, through the loop's own fault
// step, after the coordination view the loop reads (`X-Graphyard-View: coordination`), which drops the
// pipeline timeline. Against the base each replay fails: the instance reproduces. Past the bound each is counted.

interface Instance {
  id: string; kind: 'actorless' | 'blocker'; subject: string; at: string; epoch: number; movedAt: string; moved: string;
  submittedAt?: string; observedAt?: string; pr?: number; sha?: string; baseSha?: string; baseTip?: string; mergeable?: boolean | null; conflicting?: boolean;
  claimedAt?: string; blockedAt?: string; blocker?: string;
}
const instances: Instance[] = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/gy-1403-stalled-gate.json', import.meta.url)), 'utf8'));
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: launcher,
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const shift = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();
// Written out rather than imported, so this file loads against the base: the bounds the remedies keep
// (src/daemon/faults.ts baseConflictWaitBoundMs, src/daemon/decisions.ts masterTurnWaitBoundMs).
const baseConflictWaitBoundMs = 30 * 60_000, masterTurnWaitBoundMs = 30 * 60_000;

/** The submitted item as the record held it: a head the base moved past, observed once, no request of any kind raised. */
function submitted(instance: Instance): Work {
  const candidate = { sha: instance.sha!, baseSha: instance.baseSha!, pr: instance.pr!, branch: `graphyard/${instance.subject.toLowerCase()}-1`, author: 'implementer' };
  const observation = { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: instance.mergeable, conflicting: instance.conflicting, protected: true, files: ['src/a.ts'], scopeFiles: [],
    at: instance.observedAt, prState: 'open', draft: false, baseTip: instance.baseTip, baseTree: instance.baseTip, baseTipContained: false } as unknown as Observation;
  return { id: `work-${instance.subject}`, key: instance.subject, title: instance.subject, description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'build', revision: 1, policyRevision: 1,
    createdAt: instance.submittedAt, updatedAt: instance.submittedAt, stageEnteredAt: instance.submittedAt, ready: true, epoch: instance.epoch, lease: null, workspaces: [],
    candidate, submission: { epoch: instance.epoch, pr: instance.pr }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation, blocker: null, escalations: [],
    autoDispatch: { review: null, producers: [], history: [] }, actionQueue: { actions: [], history: [] }, gates: [], violations: [], proofGaps: [], scopeRequest: null, containmentQuarantine: null } as unknown as Work;
}

/**
 * The blocked item as the record held it: the `blocked` report ended the attempt (released) at that
 * instant and, in the same transaction, recorded the worker's interrupted exhaustion for the epoch
 * (src/engine.ts), nothing else standing. The pipeline timeline is written too, though the loop's
 * coordination view drops it.
 */
function blocked(instance: Instance, blockedAt = instance.blockedAt!): Work {
  return { id: `work-${instance.subject}`, key: instance.subject, title: instance.subject, stage: 'build', epoch: instance.epoch, blocker: instance.blocker,
    escalations: [], violations: [], proofGaps: [], containmentQuarantine: null, humanRequest: null, scopeRequest: null, lease: null, submission: null, candidate: null, evidence: [], observation: null,
    capacity: { escalations: [], exhaustions: [{ role: 'worker', cause: 'interrupted', epoch: instance.epoch, profile: 'graphyard-claude-1', account: null, runtime: 'claude',
      reason: `blocked on epoch ${instance.epoch}: ${instance.blocker!.replace(/^blocked on epoch \d+: /, '')}`.slice(0, 500), resetsAt: null,
      partialWork: { state: 'not-applicable', detail: 'none' }, at: blockedAt, owner: 'graphyard-claude-1', recordedBy: 'graphyard-claude-1' }] },
    pipeline: { attempts: [{ epoch: instance.epoch, owner: 'graphyard-claude-1', claimedAt: instance.claimedAt, endedAt: blockedAt, end: 'released' }] } } as unknown as Work;
}

/** The stalled-gate faults the loop's fault step records for the item at `at`, with the actorless lines master status reports. */
function stalledGate(stored: Work, at: string) {
  const [work] = coordinationSnapshot({ work: [stored] }).work;
  assert.equal((work as unknown as { pipeline?: unknown }).pipeline, undefined, 'the loop reads the item without its pipeline timeline');
  const reported = actorlessSubmissions([work], new Date(at));
  return { reported, faults: cycleFaults(emptyDaemonState(config()), [work], Date.parse(at), { config: config(), reported }).filter(fault => fault.faultClass === 'stalled-gate') };
}

test('manual:fault-class-stalled-gate — GY-1403 lists 3 instances, and every one is replayed below', () => {
  assert.deepEqual(instances.map(instance => instance.id), ['actorless|GY-1357|2026-10-06T06:37:07.077Z', 'blocker|GY-1292|2026-10-07T03:05:03.860Z', 'actorless|GY-1292|2026-10-07T03:52:53.875Z']);
  // Each was moved by the product's own remedy within seconds to minutes of being counted.
  for (const instance of instances) assert.ok(Date.parse(instance.movedAt) > Date.parse(instance.at) && Date.parse(instance.movedAt) - Date.parse(instance.at) < 5 * 60_000, `${instance.id}: ${instance.moved}`);
});

for (const instance of instances.filter(entry => entry.kind === 'actorless')) {
  test(`manual:fault-class-stalled-gate — ${instance.id}: a head the base moved past is returned by the loop, not actorless, inside the bound`, () => {
    const work = submitted(instance);
    // The reading the instance recorded: a sync is the missing actor, nothing named, past the 5-minute actorless bound.
    assert.equal(reviewNeed(work, [work], new Date(instance.at)).state, 'base-not-contained');
    const { reported, faults } = stalledGate(work, instance.at);
    assert.equal(reported.length, 1, 'master status still names the line, so the wait stays visible');
    assert.match(reported[0].text, /no rework request and no named wait; missing a sync rework/);
    assert.deepEqual(faults.map(fault => fault.kind), [], `${instance.subject} is not counted while the loop returns its head: ${instance.moved}`);
    // GitHub's conflict is the loop's own sync rework decision; an uncomputed mergeability is read by the next observation.
    if (instance.conflicting) assert.ok(syncConflict(work), 'the routine decision step requests the sync rework for this head');
    else assert.equal(instance.mergeable, null, 'GitHub had not computed mergeability yet');
  });

  test(`manual:fault-class-stalled-gate — ${instance.id}: past the bound with nothing moving it, the head is actorless`, () => {
    const late = shift(instance.submittedAt!, baseConflictWaitBoundMs + 60_000);
    const { faults } = stalledGate(submitted({ ...instance, observedAt: shift(late, -60_000) }), late);
    assert.deepEqual(faults.map(fault => fault.kind), ['actorless']);
  });
}

for (const instance of instances.filter(entry => entry.kind === 'blocker')) {
  test(`manual:fault-class-stalled-gate — ${instance.id}: a blocker inside the master's turn is no stalled gate`, () => {
    const { faults } = stalledGate(blocked(instance), instance.at);
    assert.deepEqual(faults.map(fault => fault.kind), [], `${instance.subject}'s blocker was ${Math.round((Date.parse(instance.at) - Date.parse(instance.blockedAt!)) / 1000)}s old: ${instance.moved}`);
  });

  test(`manual:fault-class-stalled-gate — ${instance.id}: a blocker standing past the master's turn, or one the record cannot date, still counts`, () => {
    const late = shift(instance.blockedAt!, masterTurnWaitBoundMs + 60_000);
    assert.deepEqual(stalledGate(blocked(instance), late).faults.map(fault => fault.kind), ['blocker']);
    // Dated by nothing the loop reads: no blocked report of this epoch recorded, or one of an older epoch.
    const undated = blocked(instance);
    undated.capacity = null;
    assert.deepEqual(stalledGate(undated, instance.at).faults.map(fault => fault.kind), ['blocker']);
    const otherCause = blocked(instance);
    otherCause.capacity!.exhaustions[0] = { ...otherCause.capacity!.exhaustions[0], reason: 'session lost' };
    assert.deepEqual(stalledGate(otherCause, instance.at).faults.map(fault => fault.kind), ['blocker']);
    // A blocker the item's current attempt did not raise is not dated by an older attempt's end.
    assert.deepEqual(stalledGate({ ...blocked(instance), epoch: instance.epoch + 1 } as Work, instance.at).faults.map(fault => fault.kind), ['blocker']);
  });
}

// ---- GY-2014: permanent reasons no longer feed stalled-gate recurrence ---------------------------

const t0 = '2026-10-18T02:00:00.000Z';
const shiftIso = (at: string, ms: number) => new Date(Date.parse(at) + ms).toISOString();
const emptyFaultRecord = () => ({ instances: [] as never[], open: {} as Record<string, string>, failing: {} as Record<string, string> });

/** Several items stalled on one of GY-2014's permanent reasons. */
function boundReasonStalls() {
  const reasons: { key: string; kind: ActionRow['kind']; reason: string }[] = [
    { key: 'GY-1963', kind: 'resync', reason: 'Deployment endpoint answered 404' },
    { key: 'GY-1960', kind: 'resync', reason: 'Deployment endpoint answered 404' },
    { key: 'GY-1976', kind: 'resync', reason: 'Deployment endpoint answered 404' },
    { key: 'GY-1994', kind: 'dispatch', reason: 'Command failed: node bin/graphyard.mjs claim GY-1994\n{"error":"A valid Graphyard bearer token is required"}' },
    { key: 'GY-1998', kind: 'request-review', reason: 'The control plane refused the reviewer launch of GY-1998 (400): Invalid input' },
    { key: 'GY-2009', kind: 'request-review', reason: 'The control plane refused the reviewer launch of GY-2009 (400): Invalid input' },
  ];
  return reasons.map(({ key, kind, reason }, index) => {
    const at = shiftIso(t0, index * 60_000), id = randomUUID(), failures = actionStallThreshold;
    const first = shiftIso(at, -failures * 60_000);
    const history: ActionRecord[] = [{ at: shiftIso(first, -60_000), event: 'requested', requester: 'graphyard', executor: null, result: null, reason: `${key} needs ${kind}` }];
    for (let n = 0; n < failures; n++) {
      const failed = shiftIso(first, (n + 1) * 60_000);
      history.push({ at: shiftIso(failed, -10_000), event: 'claimed', requester: 'graphyard', executor: 'x', result: null, reason: `attempt ${n + 1}` },
        { at: failed, event: 'failed', requester: 'graphyard', executor: 'x', result: 'failed', reason });
    }
    const row: ActionRow = { id: actionId(kind, id, `${kind}:1`), kind, work: id, key, inputs: { kind } as ActionRow['inputs'], gate: 'build', refusal: null, reason: `${key} needs ${kind}`, binding: `${kind}:1`,
      requestedBy: 'graphyard', requestedAt: history[0].at, state: 'pending', claim: null, attempts: failures, retryAt: shiftIso(at, 60_000), resolvedAt: at, result: 'failed', resolution: reason, history };
    row.stall = actionStall(row)!;
    return { id, key, stage: 'build', actionQueue: { actions: [row], history: [] } } as unknown as Work;
  });
}

test('integration:stalled-gate-recurrence-bound-reasons — several items stalled only on permanent bound reasons file no stalled-action instances and no recurring stalled-gate item', () => {
  const work = boundReasonStalls();
  const now = shiftIso(t0, 10 * 60_000);
  const attention = stalledActionAttention({ work, now });
  assert.equal(attention.length, work.length, 'each stall is still visible');
  assert.ok(attention.every(entry => entry.kind === 'setup' && entry.subject === 'setup'), 'every line is the installation-level setup attention');
  assert.ok(!attention.some(entry => entry.kind === 'stalled-action'), 'none is a per-item stalled-action');

  const record = emptyFaultRecord();
  const opened = trackFaults(record, classifyAttention(attention), now);
  assert.ok(opened.every(instance => instance.faultClass === 'configuration' && instance.kind === 'setup'), 'instances land in configuration/setup');
  assert.ok(!opened.some(instance => instance.faultClass === 'stalled-gate' || instance.kind === 'stalled-action'), 'stalled-gate observes none from them');

  const policy = faultClassPolicyFromEnv({});
  const recurrence = recurringClasses(record.instances, policy, Date.parse(now));
  assert.equal(recurrence.find(entry => entry.faultClass === 'stalled-gate'), undefined, 'no stalled-gate class recurs');
});
