import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertDispatchable, assessContainment, buildMasterStatus, containmentHold } from '../src/master.js';
import type { Work } from '../src/model.js';

const observedAt = '2030-01-01T12:00:00.000Z';
const at = (offsetMs: number) => new Date(Date.parse(observedAt) + offsetMs).toISOString();
const workspace = { host: 'coordinator-host', path: '/srv/worktrees/GY-74-1', branch: 'graphyard/gy-74-1', epoch: 1, owner: 'worker-a' };
const clean = { method: 'linux-proc-systemd' as const, platform: 'linux', uid: 1000, workspacePath: workspace.path, processes: [], scopes: [], held: [], recordedScope: null, inaccessible: 0, unverifiable: [] };

function item(overrides: Partial<Work> = {}): Work {
  return { id: 'id-GY-74', key: 'GY-74', title: 'Item', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/item.ts'], stage: 'build', revision: 3, policyRevision: 1, createdAt: observedAt, updatedAt: observedAt,
    stageEnteredAt: observedAt, ready: true, epoch: 1, lease: null, workspaces: [workspace], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: null, blocker: null, gates: [], violations: [], ...overrides } as Work;
}
/** A supervised launch: the quarantine records the launch deadlines, and the lease is renewed past them. */
function launched(leaseExpiresAt: string | null, launchAt = at(-60_000)) {
  return item({
    lease: leaseExpiresAt ? { owner: 'worker-a', epoch: 1, expiresAt: leaseExpiresAt } : null,
    containmentQuarantine: { owner: 'worker-a', epoch: 1, at: launchAt, settlementHash: 'a'.repeat(64), launchAcknowledgedAt: launchAt, launchExpiresAt: launchAt, leaseExpiresAt: launchAt },
  } as Partial<Work>);
}
const worker = { name: 'claude-a', principal: 'worker-a', agentName: 'claude-a', mode: 'worker' } as any;
const herdr = { name: 'claude-a', agent_status: 'working', pane_id: 'p1' } as any;
const status = (work: Work, probe = () => clean) => {
  const containment = assessContainment([work], { hostId: 'coordinator-host', observedAt, clockOffset: { min: 0, max: 1 }, localNow: new Date(observedAt), probe } as any);
  return buildMasterStatus({ work: [work], now: observedAt }, [worker], [herdr], {}, containment);
};

test('unit:containment-attention-live-worker a renewed lease on the quarantined epoch raises no attention and is never probed', () => {
  // The launch deadlines have passed long ago, but the worker keeps renewing its lease.
  const live = launched(at(90_000), at(-3_600_000));
  let probed = 0;
  const report = status(live, () => { probed++; return clean; });
  const row = report.work[0];
  assert.equal(probed, 0, 'a live worker\'s supervisor is not inspected for absence');
  assert.equal(row.attention, null);
  assert.equal(row.attentionOwner, null);
  assert.deepEqual(report.attentionItems, []);
  assert.equal(report.counts.attention, 0);
  assert.equal(report.counts.quarantined, 0);
  assert.equal(row.owner, 'worker-a');
  assert.deepEqual({ phase: row.containment?.phase, settleable: row.containment?.settleable, attestation: row.containment?.attestation },
    { phase: 'live', settleable: false, attestation: null });
  assert.doesNotMatch(JSON.stringify(report), /blocks dispatch|grace window/);
});

test('unit:containment-attention-live-worker a lapsed lease inside the grace window raises attention with the time remaining', () => {
  const lapsing = launched(at(-30_000));
  const row = status(lapsing).work[0];
  assert.equal(row.containment?.phase, 'grace');
  assert.equal(row.containment?.graceRemainingMs, 90_000);
  assert.equal(row.containment?.settleable, false);
  assert.equal(row.attention, `Worker lease for epoch 1 lapsed at ${at(-30_000)}; containment grace window has 90s remaining before supervisor absence can be verified`);
  assert.match(row.attentionOwner!.next, /settle-containment GY-74 REASON once settleable/);
  assert.equal(row.attentionOwner!.human, false);
  // Reconciliation may already have cleared the lapsed lease; the quarantine's own deadlines still time the window.
  assert.equal(status(launched(null, at(-30_000))).work[0].containment?.phase, 'grace');
});

test('unit:containment-attention-live-worker a lease past its grace window names the elapsed window and the settle command once settleable', () => {
  const stranded = launched(null, at(-600_000));
  const settleable = status(stranded).work[0];
  assert.equal(settleable.containment?.phase, 'lapsed');
  assert.equal(settleable.containment?.settleable, true);
  assert.equal(settleable.attention, 'Containment quarantine from epoch 1 is verified settleable; run master settle-containment GY-74');
  assert.equal(settleable.attentionOwner!.next, 'graphyard master settle-containment GY-74 REASON');

  const held = status(stranded, () => ({ ...clean, processes: [{ pid: 4242, evidence: 'command' as const }] }) as any).work[0];
  assert.equal(held.containment?.settleable, false);
  assert.match(held.attention!, new RegExp(`^Containment quarantine from epoch 1 blocks dispatch: worker lease lapsed at ${at(-600_000).replace(/\./g, '\\.')}, past the 120s grace window; Process 4242 of the contained worker is still present`));
  assert.match(held.attentionOwner!.next, /Stop the recorded supervisor/);
});

test('unit:containment-hold-wording a live worker holds dispatch as the item in progress by its owner, not as a quarantine', () => {
  const live = launched(at(90_000));
  const hold = containmentHold(live, Date.parse(observedAt));
  assert.equal(hold, `GY-74 is in progress by worker-a under lease epoch 1 (active until ${at(90_000)})`);
  assert.doesNotMatch(hold!, /quarantin|containment/i);
  assert.throws(() => assertDispatchable(live, [live], observedAt), (error: Error) => error.message === hold);
  assert.equal(status(live).work[0].containment?.hold, hold);
});

test('unit:containment-hold-wording a lapsed or superseded owner still holds dispatch as unverified containment', () => {
  const lapsed = launched(null, at(-600_000));
  assert.throws(() => assertDispatchable(lapsed, [lapsed], observedAt), /^Error: Dispatch blocked by unverified worker containment from epoch 1$/);
  // A lease held by someone else, or on another epoch, is not the contained worker at work.
  const other = { ...lapsed, lease: { owner: 'worker-b', epoch: 1, expiresAt: at(90_000) } } as Work;
  assert.equal(containmentHold(other, Date.parse(observedAt)), 'Dispatch blocked by unverified worker containment from epoch 1');
  const superseded = { ...lapsed, lease: { owner: 'worker-a', epoch: 2, expiresAt: at(90_000) } } as Work;
  assert.equal(containmentHold(superseded, Date.parse(observedAt)), 'Dispatch blocked by unverified worker containment from epoch 1');
  assert.equal(containmentHold(item(), Date.parse(observedAt)), null);
});
