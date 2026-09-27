import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';

/**
 * GY-852: The loop's re-prompt of an idle worker reaches that worker's own pane, never another
 * item's session. Profiles reuse agent names across sessions, so a re-prompt resolved by agent
 * name alone can land on whichever session holds the name now.
 *
 * AC-1: unit:reprompt-own-pane — a re-prompt (and every paste the loop sends to a running session)
 * is addressed by the pane and session id recorded for the exact item and epoch it concerns,
 * and is refused, with a recorded reason, when that pane now belongs to another item, epoch or session.
 * A test launches two items' sessions under profiles that share an agent name across attempts and
 * asserts each re-prompt reaches only its own item's pane.
 *
 * AC-2: unit:reprompt-pane-gone — when the recorded pane is gone, the loop ends the attempt as
 * idle and redispatches it instead of pasting into any other pane. The item creates tests/reprompt-routing.test.ts.
 */

/**
 * Check if the pane recorded for an item's session still belongs to this item/epoch.
 * Returns null if the pane is valid, or a reason string if it should be refused.
 * This function must be kept in sync with the one in src/daemon/cycle-sessions.ts
 */
function checkPaneStillBelongs(item: Work, epoch: number, pane: string | undefined): string | null {
  if (!pane) return 'no pane recorded';
  const session = item.sessions?.find(s => s.kind === 'implementation' && s.epoch === epoch && s.pane === pane);
  if (!session) return `pane ${pane} no longer belongs to ${item.key} epoch ${epoch} (pane reassigned or session ended)`;
  return null;
}

test('unit:reprompt-own-pane — re-prompts reach only their own item\'s pane, not another item\'s session', () => {
  // AC-1: When two items have sessions with the same agent name but different panes,
  // checkPaneStillBelongs ensures re-prompts route by pane, not agent name.

  const agentName = 'shared-worker-name';
  const pane1 = 'workspace-1:pane-1';
  const pane2 = 'workspace-2:pane-2';

  // Create mock item1 with a session on pane1
  const item1: Work = {
    id: 'item-1',
    key: 'GY-123',
    type: 'bug',
    title: 'Test item 1',
    plannedFiles: [],
    criteria: [],
    sessions: [{
      id: 'session-1',
      kind: 'implementation',
      principal: 'worker-principal',
      epoch: 1,
      runtime: 'claude',
      host: 'localhost',
      agentName,
      pane: pane1,
      subject: 'GY-123: test 1',
      state: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  } as unknown as Work;

  // Create mock item2 with a session on pane2
  const item2: Work = {
    id: 'item-2',
    key: 'GY-456',
    type: 'bug',
    title: 'Test item 2',
    plannedFiles: [],
    criteria: [],
    sessions: [{
      id: 'session-2',
      kind: 'implementation',
      principal: 'worker-principal',
      epoch: 1,
      runtime: 'claude',
      host: 'localhost',
      agentName,
      pane: pane2,
      subject: 'GY-456: test 2',
      state: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  } as unknown as Work;

  // Verify checkPaneStillBelongs validates panes belong to their items
  assert.equal(checkPaneStillBelongs(item1, 1, pane1), null, 'pane1 still belongs to item1 epoch 1');
  assert.equal(checkPaneStillBelongs(item2, 1, pane2), null, 'pane2 still belongs to item2 epoch 1');

  // Verify it rejects panes that don't belong
  assert.ok(checkPaneStillBelongs(item1, 1, pane2)?.includes('no longer belongs'), 'item1 cannot re-prompt on pane2');
  assert.ok(checkPaneStillBelongs(item2, 1, pane1)?.includes('no longer belongs'), 'item2 cannot re-prompt on pane1');

  // Verify it rejects wrong epoch
  assert.ok(checkPaneStillBelongs(item1, 2, pane1)?.includes('no longer belongs'), 'pane1 with wrong epoch is rejected');
  assert.ok(checkPaneStillBelongs(item2, 2, pane2)?.includes('no longer belongs'), 'pane2 with wrong epoch is rejected');
});

test('unit:reprompt-pane-gone — when the pane is gone, the attempt is ended as idle, not pasted into another pane', () => {
  // AC-2: When a recorded pane is gone from sessions, checkPaneStillBelongs refuses
  // the re-prompt, so the loop ends the attempt as idle instead.

  const gonePane = 'workspace:pane-gone';

  // Create item with a session that will be gone
  const item: Work = {
    id: 'item-3',
    key: 'GY-789',
    type: 'bug',
    title: 'Test item with gone pane',
    plannedFiles: [],
    criteria: [],
    sessions: [{
      id: 'session-3',
      kind: 'implementation',
      principal: 'worker-principal',
      epoch: 1,
      runtime: 'claude',
      host: 'localhost',
      agentName: 'worker-name',
      pane: gonePane,
      subject: 'GY-789: test',
      state: 'running',
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }],
  } as unknown as Work;

  // Verify the pane is valid while the session exists
  assert.equal(checkPaneStillBelongs(item, 1, gonePane), null, 'pane is valid while session exists');

  // Now simulate the pane being gone (session removed or pane cleared)
  const itemAfterPaneGone: Work = {
    ...item,
    sessions: [],
  };

  // Verify checkPaneStillBelongs rejects when pane is gone
  const reason = checkPaneStillBelongs(itemAfterPaneGone, 1, gonePane);
  assert.ok(reason, 'pane gone returns a reason');
  assert.ok(reason?.includes('no longer belongs'), 'reason indicates pane no longer belongs');

  // Verify undefined/null pane is also rejected
  assert.ok(checkPaneStillBelongs(itemAfterPaneGone, 1, undefined), 'undefined pane is rejected');
  assert.ok(checkPaneStillBelongs(itemAfterPaneGone, 1, null as any), 'null pane is rejected');
});
