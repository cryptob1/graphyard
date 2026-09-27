import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { triageBacklogStep } from '../src/daemon/cycle-triage.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { DaemonAction } from '../src/daemon/state.js';

// GY-513 (GY-402's review, finding 1): with run.research unset the loop ran no triage and said
// nothing until each item's day-late attention. It now records why on its own actions, as waiting.
const followUp = (key: string) => ({ id: `id-${key}`, key, title: `Follow-ups from the approved review of GY-1 (${key})`, description: '1. Finding with no thread: src/a.ts — x', type: 'chore',
  stage: 'backlog', ready: false, createdAt: '2026-09-26T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z', origin: { reviewFollowUps: { parent: 'GY-1', findings: [{ path: 'src/a.ts', text: 'x' }] } } }) as unknown as Work;

function cycle(work: Work[], research: unknown) {
  const performed: DaemonAction[] = [];
  const state = { actions: {}, faults: {}, cycle: 1 } as unknown as Cycle['state'];
  const value = { config: { repository: 'owner/repo', run: research ? { research } : {} }, state, performed, now: () => Date.parse('2026-09-26T12:00:00Z'), clock: Date.parse('2026-09-26T12:00:00Z'),
    snapshot: { work }, effects: { persist: async () => {}, recordTriage: async () => ({}) }, isolate: async (_k: unknown, _i: unknown, _n: unknown, body: () => Promise<unknown>) => body() } as unknown as Cycle;
  return { value, performed, state };
}

test('unit:triage-unconfigured-visible — an unconfigured loop records that triage is off, naming the waiting items, once until they change; nothing waiting records nothing', async () => {
  const run = cycle([followUp('GY-10'), followUp('GY-11')], null);
  await triageBacklogStep(run.value);
  assert.equal(run.performed.length, 1);
  assert.equal(run.performed[0]!.state, 'waiting', 'not a fault: nothing failed');
  assert.match(run.performed[0]!.detail, /Triage is off: run\.research does not name the research account, so 2 machine-filed items \(GY-10, GY-11\) wait unjudged/);
  await triageBacklogStep(run.value);
  assert.equal(run.performed.length, 1, 'an unchanged detail is not recorded again');
  const idle = cycle([], null);
  await triageBacklogStep(idle.value);
  assert.equal(idle.performed.length, 0);
});
