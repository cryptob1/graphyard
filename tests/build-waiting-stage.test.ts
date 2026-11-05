import { test } from 'node:test';
import assert from 'node:assert/strict';
import { itemLine } from '../src/cli/master-status.js';
import { prSteps } from '../src/model/pr-steps.js';
import type { Work } from '../src/model/work.js';

/**
 * GY-3095 AC-2: on 2026-11-04 nothing could launch for 2.5 hours, yet every item at build read
 * Building with blocker null. An item at build that no lease holds and no session runs reads
 * Waiting, with its reason when one is known, in master status and the dashboard stage label.
 */

const now = Date.parse('2026-11-05T02:00:00Z');
const base = {
  id: 'id', key: 'GY-7', title: 'Waits', description: '', type: 'bug', priority: 0, stage: 'build',
  dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
  policy: { checks: ['test'], review: true }, revision: 1, policyRevision: 1,
  createdAt: '2026-11-04T00:00:00Z', updatedAt: '2026-11-04T00:00:00Z', stageEnteredAt: '2026-11-04T00:00:00Z',
  ready: true, epoch: 1, lease: null, workspaces: [], candidate: null, submission: null, gates: [], evidence: [], violations: [],
};
const item = (extra: Record<string, unknown> = {}) => ({ ...base, ...extra }) as unknown as Work;
const dispatch = (history: { event: string; reason: string; result?: string | null }[]) => ({ actionQueue: { history: [], actions: [{
  id: 'a', kind: 'dispatch', work: 'id', key: 'GY-7', inputs: {}, gate: 'build', refusal: null, reason: 'GY-7 is ready and unassigned', binding: 'dispatch:1',
  requestedBy: 'graphyard', requestedAt: '2026-11-04T23:00:00Z', state: 'pending', claim: null, attempts: history.length,
  history: history.map(entry => ({ at: '2026-11-04T23:30:00Z', requester: 'graphyard', executor: 'host', result: null, ...entry })) }] } });

test('unit:build-without-session-reads-waiting — an item at build with no lease and no running session reads Waiting with its reason, never Building', async () => {
  // Imported when called, so the regression fails as a test case on a base without the stage label.
  const { plainStage, stageLabel } = await import('../src/model/plain-stage.js');
  const refused = 'role worker is at its concurrency limit (2 of 2 live: claude-a on GY-1, codex on GY-2)';
  const cases: [string, Work, string | null][] = [
    ['no reason known', item(), null],
    ['a recorded blocker', item({ blocker: 'npm test needs Docker' }), 'npm test needs Docker'],
    ['its launch failed', item(dispatch([{ event: 'requested', reason: 'ready' }, { event: 'failed', reason: refused, result: 'failed' }])), `its last launch failed: ${refused}`],
    ['a launch requested, not yet tried', item(dispatch([{ event: 'requested', reason: 'ready' }])), 'a launch is requested: GY-7 is ready and unassigned'],
    ['its lease expired and its session ended', item({ lease: { epoch: 1, owner: 'w', expiresAt: '2026-11-05T01:00:00Z' }, sessions: [{ id: 's', kind: 'implementation', state: 'ended' }] }), null],
  ];
  for (const [name, work, reason] of cases) {
    assert.equal(plainStage(work, undefined, undefined, now), 'Waiting', name);
    const line = itemLine(work, now);
    assert.equal(line.stage, 'Waiting', `master status: ${name}`);
    assert.equal(line.waiting, reason, `master status names the reason: ${name}`);
    // The dashboard points at a recorded blocker rather than repeating it; the item page shows it once (GY-1739).
    const shown = work.blocker ? 'held by its recorded blocker' : reason;
    assert.equal(stageLabel(work, undefined, undefined, now), shown ? `Waiting: ${shown}` : 'Waiting', `dashboard stage label: ${name}`);
    assert.equal(prSteps(work, now).label, shown ? `Waiting · waiting for a builder: ${shown}` : 'Waiting · waiting for a builder', `dashboard row: ${name}`);
  }

  // A live lease, or a running session without one, is being built.
  for (const [name, work] of [
    ['a live lease', item({ lease: { epoch: 1, owner: 'w', expiresAt: '2026-11-05T03:00:00Z' } })],
    ['a running session', item({ sessions: [{ id: 's', kind: 'implementation', state: 'running' }] })],
  ] as const) {
    assert.equal(plainStage(work, undefined, undefined, now), 'Building', name);
    const line = itemLine(work, now);
    assert.equal(line.stage, 'Building', name);
    assert.equal('waiting' in line, false, `a building item carries no wait: ${name}`);
    assert.equal(stageLabel(work, undefined, undefined, now), 'Building', name);
  }
});
