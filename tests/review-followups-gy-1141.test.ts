import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Work } from '../src/model/work.js';
import { followUpShipReceiptKey, foldUnshippedFollowUps } from '../src/model/followups-held.js';
import { migrateToParents } from '../src/server/followups-ship.js';
import { workerSlotWait } from '../src/model/action-kinds.js';

test('manual:review-followups-triaged GY-1141.1: followUpShipReceiptKey bounds idempotency key to 200 chars for long keys (finding 2)', () => {
  const at = '2026-10-02T12:00:00.000Z';
  const parent = { pendingFollowUps: { at, findings: [{ path: 'src/a.ts', text: 'f1' }] } } as any;

  // Short key is unchanged: key@at
  const shortKey = 'followups-after-ship:GY-500';
  assert.equal(followUpShipReceiptKey(shortKey, parent), `${shortKey}@${at}`);

  // 200-char key is bounded to <= 200 chars
  const longKey1 = 'k'.repeat(190) + '-suffix-1';
  const longKey2 = 'k'.repeat(190) + '-suffix-2';
  assert.equal(longKey1.length, 199);
  assert.equal(longKey2.length, 199);

  const scoped1 = followUpShipReceiptKey(longKey1, parent);
  const scoped2 = followUpShipReceiptKey(longKey2, parent);

  assert.ok(scoped1.length <= 200, `scoped key length ${scoped1.length} exceeds 200`);
  assert.ok(scoped2.length <= 200, `scoped key length ${scoped2.length} exceeds 200`);

  // Distinct long keys produce distinct scoped receipts
  assert.notEqual(scoped1, scoped2, 'distinct caller keys must produce distinct scoped receipts');

  // Identical calls replay identically
  assert.equal(followUpShipReceiptKey(longKey1, parent), scoped1, 'idempotent calls replay identically');

  // Different hold timestamps produce distinct receipts
  const parent2 = { pendingFollowUps: { at: '2026-10-02T14:00:00.000Z', findings: [{ path: 'src/b.ts', text: 'f2' }] } } as any;
  assert.notEqual(followUpShipReceiptKey(longKey1, parent), followUpShipReceiptKey(longKey1, parent2));
});

test('manual:review-followups-triaged GY-1141.2: migrateToParents ends lapsed leases as expired at lease deadline via endLapsedAttempt (finding 3)', async () => {
  const claimedAt = '2026-10-02T10:00:00.000Z';
  const expiresAt = '2026-10-02T10:15:00.000Z';
  const migrationTime = new Date('2026-10-02T12:00:00.000Z');

  const base = {
    type: 'chore', priority: 2, criteria: [], plannedFiles: ['src/a.ts'], policy: { checks: ['test'], review: true },
    revision: 1, policyRevision: 1, createdAt: claimedAt, updatedAt: claimedAt, stageEnteredAt: claimedAt,
    workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [],
    evidence: [], observation: null, blocker: null, gates: [], violations: [], description: '',
  };

  const parent: Work = {
    ...base, id: 'parent-1', key: 'GY-100', title: 'Parent', stage: 'build', dependencies: [], ready: true, epoch: 1, lease: null,
  } as unknown as Work;

  const followUp: Work = {
    ...base, id: 'followup-1', key: 'GY-101', title: 'Lapsed Follow-up', stage: 'build', dependencies: ['parent-1'], ready: true, epoch: 1,
    lease: { owner: 'worker-1', epoch: 1, expiresAt },
    pipeline: {
      attempts: [{ epoch: 1, owner: 'worker-1', claimedAt, endedAt: null, end: null }],
      interventions: { blocked: 0, requirements: 0 },
      reworkRounds: 0, submittedAt: null, resubmittedAt: null,
    },
    origin: { reviewFollowUps: { parent: 'GY-100', findings: [{ path: 'src/a.ts', text: 'f1' }] } },
  } as unknown as Work;

  const mockDb = {
    query: async (sql: string) => {
      if (sql.includes('FROM events WHERE kind=$1')) return { rows: [] };
      if (sql.includes('SELECT document FROM work_items')) return { rows: [{ document: parent }, { document: followUp }] };
      return { rows: [] };
    },
  };

  const services: any = {
    engine: {
      evaluate: () => {},
      recordDispatch: async () => {},
    },
  };

  const actor: any = { id: 'master', role: 'admin' };
  const result = await migrateToParents(services, mockDb as any, actor, migrationTime);

  assert.equal(result.folded, 1);
  assert.equal(followUp.lease, null);
  assert.equal(followUp.stage, 'done');
  assert.equal(followUp.closure?.kind, 'superseded');

  // Attempt must be ended as 'expired' at the lease deadline (expiresAt), NOT at migrationTime as 'released'
  const attempt = followUp.pipeline!.attempts[0];
  assert.equal(attempt.end, 'expired', 'lapsed lease must end as expired');
  assert.equal(attempt.endedAt, expiresAt, 'endedAt must record lease deadline, not migration time');
});

test('manual:review-followups-triaged GY-1141.3: workerSlotWait excludes terminated worker sessions from busy slot waits (finding 7)', () => {
  // Terminated / killed sessions should return false so stall attention is not deferred 30 minutes
  const killedReason = 'no worker profile can take GY-999: claude-primary (Herdr agent graphyard-claude-1 is killed)';
  assert.equal(workerSlotWait(killedReason), false, 'killed worker session must not be counted as busy launch profile');

  const terminatedReason = 'no worker profile can take GY-999: claude-primary (Herdr agent graphyard-claude-1 is terminated)';
  assert.equal(workerSlotWait(terminatedReason), false, 'terminated worker session must not be counted as busy');

  const exitedReason = 'no worker profile can take GY-999: claude-primary (Herdr agent graphyard-claude-1 is exited)';
  assert.equal(workerSlotWait(exitedReason), false, 'exited worker session must not be counted as busy');

  // Active sessions still count as busy
  const workingReason = 'no worker profile can take GY-999: claude-primary (Herdr agent graphyard-claude-1 is working)';
  assert.equal(workerSlotWait(workingReason), true, 'working session is counted as busy');

  const idleReason = 'no worker profile can take GY-999: claude-primary (Herdr agent graphyard-claude-1 is idle)';
  assert.equal(workerSlotWait(idleReason), true, 'idle session is counted as busy');

  // A profile mix where one is killed and one is working returns false (not all active)
  const mixedReason = 'no worker profile can take GY-999: claude-1 (Herdr agent c1 is working), claude-2 (Herdr agent c2 is killed)';
  assert.equal(workerSlotWait(mixedReason), false, 'mix with killed worker must not be a capacity slot wait');
});
