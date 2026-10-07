import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Observation, Work } from '../src/model.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { cycleFaults, emptyDaemonState } from '../src/master-daemon.js';
import { actorlessSubmissions } from '../src/cli/actorless-submissions.js';
import { syncConflict } from '../src/daemon/decisions.js';
import { reviewNeed } from '../src/model/dispatch.js';

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
// step. Against the base each replay fails: the instance reproduces. Past the bound each is counted.

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

/** The blocked item as the loop read it: the attempt that raised the blocker ended (released) at that instant, nothing else standing. */
function blocked(instance: Instance, blockedAt = instance.blockedAt!): Work {
  return { id: `work-${instance.subject}`, key: instance.subject, title: instance.subject, stage: 'build', epoch: instance.epoch, blocker: instance.blocker,
    escalations: [], violations: [], proofGaps: [], containmentQuarantine: null, humanRequest: null, scopeRequest: null, lease: null, submission: null, candidate: null,
    pipeline: { attempts: [{ epoch: instance.epoch, owner: 'graphyard-claude-1', claimedAt: instance.claimedAt, endedAt: blockedAt, end: 'released' }] } } as unknown as Work;
}

/** The stalled-gate faults the loop's fault step records for the item at `at`, with the actorless lines master status reports. */
function stalledGate(work: Work, at: string) {
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
    const undated = blocked(instance);
    (undated as unknown as { pipeline: unknown }).pipeline = undefined;
    assert.deepEqual(stalledGate(undated, instance.at).faults.map(fault => fault.kind), ['blocker']);
    // A blocker the item's current attempt did not raise is not dated by an older attempt's end.
    assert.deepEqual(stalledGate({ ...blocked(instance), epoch: instance.epoch + 1 } as Work, instance.at).faults.map(fault => fault.kind), ['blocker']);
  });
}
