import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import type { HerdrAgent } from '../src/master.js';
import { faulted } from '../src/master-status.js';
import { defaultDatabaseMaxBytes, needsAttention, readResources, resourceAttention, staleNameWindowMs, type ResourceInputs, type ResourceReading } from '../src/master-resources.js';

// GY-963: three resources faults in 24 hours, each a resource-bound attention item raised against a
// bound that did not measure a fault. The test is named for the proof it produces:
// manual:fault-class-resources.
//
// - resource:database-capacity, 2026-09-29T15:13:27Z and 16:28:54Z: GRAPHYARD_DATABASE_MAX_BYTES
//   was unset, so the plane reported pg_database_size (14.3 GB) against the 10 GiB default, a guess
//   the plane itself marks advisory. The reading stood exhausted forever and each /healthz read
//   gap re-raised it as a new instance.
// - resource:agent-names:claude-quaternary, 16:06:54Z: a concurrency-1 worker profile's finished
//   pane was counted the moment its lease ended, while the reclaim pass was still inside the grace
//   it waits before closing the pane, which it then did.

const at = Date.parse('2026-09-29T16:06:54.954Z');
const iso = (ms: number) => new Date(ms).toISOString();
const quaternary = { name: 'claude-quaternary', agentName: 'claude-quaternary', principal: 'graphyard-claude-4', mode: 'launch' };
const inputs = (overrides: Partial<ResourceInputs>): ResourceInputs => ({ now: at, reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null,
  profiles: { workers: [quaternary], reviewers: [], producers: [] }, ...overrides });
/** The base's rule: any low or exhausted reading raises attention, and a namespace does once anything in it is unowned. */
const baseNeedsAttention = (reading: ResourceReading) => (reading.state === 'low' || reading.state === 'exhausted') && (reading.resource !== 'agent-names' || reading.reclaimable > 0)
  && (reading.resource !== 'session-slots' || (reading.waiting ?? 0) > 0);
const resources = (readings: ResourceReading[]) => faulted(resourceAttention(readings)).faults.filter(group => group.faultClass === 'resources');

test('manual:fault-class-resources — database-capacity: the unconfigured default bound is reported but is never a resources fault; a configured one still is', () => {
  const plane = (bound: number, advisory: boolean) => ({ writable: true, writeError: null, github: null,
    database: { used: 14_300_000_000, bound, advisory, detail: 'pg_database_size against the default bound' } });
  for (const instance of ['2026-09-29T15:13:27.351Z', '2026-09-29T16:28:54.003Z']) {
    const readings = readResources(inputs({ now: Date.parse(instance), plane: plane(defaultDatabaseMaxBytes, true) }));
    const database = readings.find(reading => reading.id === 'database-capacity')!;
    assert.equal(database.state, 'exhausted', 'the reading itself is unchanged: 14.3 GB against the default');
    assert.equal(baseNeedsAttention(database), true, `the base raised resource:database-capacity at ${instance}`);
    assert.equal(needsAttention(database), false, `the candidate raises nothing at ${instance}`);
    assert.ok(!resourceAttention(readings).some(item => item.subject === 'resource:database-capacity'));
    assert.deepEqual(resources(readings), [], 'no resources fault instance is counted');
  }
  // Not weakened: a bound the operator configured is a real one, and reaching it is still a fault.
  const configured = readResources(inputs({ plane: plane(12_000_000_000, false) }));
  assert.ok(resourceAttention(configured).some(item => item.subject === 'resource:database-capacity'), 'a configured bound still raises attention');
  assert.equal(resources(configured).length, 1);
});

test('manual:fault-class-resources — agent-names:claude-quaternary: a finished pane inside the reclaim window is not a fault; one the pass left past it is', () => {
  const agents: HerdrAgent[] = [{ name: 'claude-quaternary', pane_id: 'w1V:pQ4', agent: 'claude', agent_status: 'done' }];
  // The item whose lease just ended: its session handle records when the session finished.
  const work = (endedAt: number | null) => [{ id: 'work-1', key: 'GY-900', stage: 'build', lease: null,
    sessions: endedAt === null ? [] : [{ id: 'graphyard-claude-4:3', kind: 'implementation', principal: quaternary.principal, epoch: null, runtime: 'claude', host: 'vishrog',
      workspace: 'w1V', tab: null, pane: 'w1V:pQ4', agentName: 'claude-quaternary', role: null, head: null, attach: null, transcript: null, subject: 'GY-900',
      startedAt: iso(endedAt - 600_000), updatedAt: iso(endedAt), endedAt: iso(endedAt), state: 'finished', outcome: 'lease ended' }] }] as unknown as Work[];
  const name = (now: number, endedAt: number | null) => readResources(inputs({ now, agents, work: work(endedAt) })).find(reading => reading.id === 'agent-names:claude-quaternary')!;

  // The instance: 30 seconds after the lease ended, inside the grace the reclaim pass waits out.
  const instance = name(at, at - 30_000);
  assert.deepEqual({ state: instance.state, reclaimable: instance.reclaimable }, { state: 'exhausted', reclaimable: 1 }, 'the name is held and nothing live owns it');
  assert.equal(baseNeedsAttention(instance), true, 'the base raised resource:agent-names:claude-quaternary while the reclaim was on schedule');
  assert.equal(needsAttention(instance), false, 'the candidate waits for the reclaim pass');
  assert.deepEqual(resources(readResources(inputs({ now: at, agents, work: work(at - 30_000) }))), []);

  // Not weakened: a pane the pass has not closed by the end of its window is a fault, as is one no
  // session records at all (nothing will reclaim it).
  const overdue = name(at + staleNameWindowMs, at);
  assert.equal(overdue.overdue, 1);
  assert.equal(needsAttention(overdue), true, 'a name held past the reclaim window raises attention');
  assert.equal(needsAttention(name(at, null)), true, 'a name no session records raises attention at once');
  assert.equal(resources(readResources(inputs({ now: at + staleNameWindowMs, agents, work: work(at) }))).length, 1);
});
