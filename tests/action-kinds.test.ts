import test from 'node:test';
import assert from 'node:assert/strict';
import { workerSlotWait } from '../src/model/action-kinds.js';

test('unit:worker-slot-wait — workerSlotWait excludes terminated worker sessions from busy slot waits', () => {
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
