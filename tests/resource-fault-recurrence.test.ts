import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { HerdrAgent } from '../src/master.js';
import type { Work } from '../src/model.js';
import type { ReviewRecord } from '../src/reviewer.js';
import type { ProducerRecord } from '../src/producer.js';
import { loadedRevision, nameReclaimBoundMs, readResources, resourceAttention, type ResourceInputs } from '../src/master-resources.js';
import { classifyAttention } from '../src/model/fault-classes.js';

/**
 * GY-1089: 185 resources faults in 24 hours, every one a registered resource reading "at its bound"
 * for a state the product resolves on its own. Each instance shape the item lists is rebuilt here
 * from its own detail line, and none raises a resources fault; beside each, the state that is a
 * real fault still raises one, so the class is quieter only where it was wrong.
 *
 * - resource:agent-names:PROFILE — "working, no live session": a session running while its lease
 *   or record has not landed yet (a worker launched before its claim) or after it settled (winding
 *   down after complete, a reviewer after its verdict). "idle/done, no live session": a finished
 *   pane inside the reclaim's own bound, which the loop or the reclaim pass is about to close.
 * - resource:database-capacity — "against the default bound (… it warns but does not fail health)":
 *   an advisory bound nobody configured.
 * - resource:loaded-revision — the checkout moved past the loop's loaded commit by commits that
 *   touch no loaded code, which the self-upgrade deliberately restarts nothing for.
 */

const now = Date.parse('2026-10-01T13:27:57.751Z');
const iso = (ms: number) => new Date(ms).toISOString();
const workers = [
  { name: 'opencode-primary', principal: 'graphyard-opencode-1', agentName: 'graphyard-opencode-1', mode: 'launch' },
  { name: 'claude-tertiary', principal: 'graphyard-cursor-1', agentName: 'graphyard-claude-3', mode: 'launch' },
];
const producers = [{ name: 'claude-producer-2', agentName: 'produce-claude-2' }];
const reviewers = [{ name: 'review-claude-a', agentName: 'review-claude-a' }];
const inputs = (overrides: Partial<ResourceInputs>): ResourceInputs => ({ now, reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, revision: null, disk: null,
  profiles: { workers, reviewers, producers }, ...overrides });
const agent = (name: string, status: string, pane: string): HerdrAgent => ({ name, agent_status: status, pane_id: pane, agent: 'claude' } as HerdrAgent);
/** A worker's implementation session on an item, with no live lease (claimed later, or ended). */
const workerItem = (principal: string, session: { startedAt: number; endedAt?: number; state: string }, lease?: { expiresAt: number }) => ({
  id: randomUUID(), key: 'GY-1', stage: 'build', lease: lease ? { owner: principal, epoch: 1, expiresAt: iso(lease.expiresAt) } : null,
  sessions: [{ id: `${principal}:1`, kind: 'implementation', principal, epoch: 1, runtime: 'claude', host: 'vishrog', workspace: 'w1V', tab: null, pane: null, agentName: null, role: null, head: null,
    attach: null, transcript: null, subject: 'GY-1', startedAt: iso(session.startedAt), updatedAt: iso(session.endedAt ?? session.startedAt), endedAt: session.endedAt ? iso(session.endedAt) : null, state: session.state, outcome: null }],
}) as unknown as Work;
const producerRecord = (agentName: string, state: string, closedAt: number): ProducerRecord => ({ id: randomUUID(), agentName, state, requestedAt: iso(closedAt - 600_000), closedAt: iso(closedAt) } as unknown as ProducerRecord);
const reviewRecord = (agentName: string, state: string, closedAt: number): ReviewRecord => ({ id: randomUUID(), agentName, state, requestedAt: iso(closedAt - 600_000), closedAt: iso(closedAt) } as unknown as ReviewRecord);
/** The resources faults the loop would track from these inputs: the attention, classified as the loop classifies it. */
const faults = (input: ResourceInputs) => classifyAttention(resourceAttention(readResources(input))).filter(item => item.faultClass === 'resources').map(item => item.subject);

test('manual:fault-class-resources — a running session holding its profile\'s name is never a resources fault, whatever its record says', () => {
  // graphyard-opencode-1 (working, no live session): the launcher starts the pane, then claims the item.
  const launching = inputs({ agents: [agent('graphyard-opencode-1', 'working', 'w1V:pC3T')], work: [workerItem('graphyard-opencode-1', { startedAt: now - 44_000, state: 'running' })] });
  assert.deepEqual(faults(launching), []);
  // A worker winding down after complete ended its lease long ago, still working: the supervisor stops it.
  const windingDown = inputs({ agents: [agent('graphyard-claude-3', 'working', 'w1V:pC2P')], work: [workerItem('graphyard-cursor-1', { startedAt: now - 3_600_000, endedAt: now - 2 * nameReclaimBoundMs, state: 'done' })] });
  assert.deepEqual(faults(windingDown), []);
  // produce-claude-2 (working, no live session): its record settled, the session is still writing its result.
  const producing = inputs({ agents: [agent('produce-claude-2', 'working', 'w1V:pC4H')], producers: [producerRecord('produce-claude-2', 'completed', now - 2 * nameReclaimBoundMs)] });
  assert.deepEqual(faults(producing), []);
  const reading = readResources(producing).find(entry => entry.id === 'agent-names:claude-producer-2')!;
  assert.equal(reading.state, 'exhausted', 'the namespace still reads as full, so a launch into it is refused and attributed');
  assert.equal(reading.reclaimable, 0, 'a running session is nothing a reclaim gives back');
});

test('manual:fault-class-resources — a finished pane is a resources fault only once its reclaim is overdue', () => {
  // graphyard-claude-2 (idle, no live session) and produce-claude-4 (idle): settled a moment ago, the
  // loop's worker close and the reclaim pass's grace are still running.
  const fresh = inputs({
    agents: [agent('graphyard-opencode-1', 'idle', 'w1V:pC3T'), agent('produce-claude-2', 'idle', 'w1V:pC4H'), agent('review-claude-a', 'done', 'w1V:pC9A')],
    work: [workerItem('graphyard-opencode-1', { startedAt: now - 3_600_000, endedAt: now - 30_000, state: 'done' })],
    producers: [producerRecord('produce-claude-2', 'completed', now - 90_000)], reviews: [reviewRecord('review-claude-a', 'completed', now - 60_000)],
  });
  assert.deepEqual(faults(fresh), []);
  const reading = readResources(fresh).find(entry => entry.id === 'agent-names:claude-producer-2')!;
  assert.equal(reading.reclaimable, 1, 'the finished pane is reclaimable');
  assert.match(reading.detail!, /reclaim under way/);

  // The same panes past the bound: no reclaim path gave them back, and that is the fault.
  const stuck = inputs({ ...fresh, now: now + nameReclaimBoundMs });
  assert.deepEqual(faults(stuck).sort(), ['resource:agent-names:claude-producer-2', 'resource:agent-names:opencode-primary', 'resource:agent-names:review-claude-a']);
  assert.match(readResources(stuck).find(entry => entry.id === 'agent-names:opencode-primary')!.detail!, /not reclaimed within 10 minutes of settling/);
  // A finished pane on a name no record or session accounts for has no reclaim path at all: a fault at once.
  assert.deepEqual(faults(inputs({ agents: [agent('produce-claude-2', 'idle', 'w1V:pC4H')] })), ['resource:agent-names:claude-producer-2']);
  // A live lease owns its name, finished-looking or not.
  assert.deepEqual(faults(inputs({ now: now + nameReclaimBoundMs, agents: [agent('graphyard-opencode-1', 'idle', 'w1V:pC3T')],
    work: [workerItem('graphyard-opencode-1', { startedAt: now - 3_600_000, state: 'running' }, { expiresAt: now + 2 * nameReclaimBoundMs })] })), []);
});

test('manual:fault-class-resources — the database past an advisory default bound is reported, not a resources fault; past a configured bound it is', () => {
  const database = (advisory: boolean) => inputs({ plane: { writable: true, writeError: null, github: null,
    database: { used: 13.3e9, bound: 10 * 1024 ** 3, advisory, detail: advisory ? 'pg_database_size against the default bound (GRAPHYARD_DATABASE_MAX_BYTES unset and the database volume not readable from the plane; it warns but does not fail health)' : 'pg_database_size against GRAPHYARD_DATABASE_MAX_BYTES' } } });
  const reading = readResources(database(true)).find(entry => entry.id === 'database-capacity')!;
  assert.equal(reading.state, 'exhausted', 'the reading still shows the size against the default');
  assert.equal(reading.advisory, true);
  assert.deepEqual(faults(database(true)), []);
  assert.deepEqual(faults(database(false)), ['resource:database-capacity']);
});

test('manual:fault-class-resources — a checkout move that touches no loaded code leaves the loop current; one that does is a resources fault', () => {
  const started = Math.floor(now / 1000) - 600;
  const git = (changed: string) => (command: string, args: string[]) => command === 'ps' ? '600\n'
    : args.includes('rev-parse') ? `${'c'.repeat(40)}\n`
    : args.includes('reflog') ? `${'c'.repeat(40)} HEAD@{${started + 60}}\n${'l'.repeat(40)} HEAD@{${started - 60}}\n`
    : args.includes('diff') ? changed
    : '4\n';
  const docsOnly = loadedRevision('/nonexistent', 1, git('docs/operations-reference.md\nREADME.md\n'), now)!;
  assert.equal(docsOnly.behind, 0);
  assert.deepEqual(faults(inputs({ revision: docsOnly })), []);
  const code = loadedRevision('/nonexistent', 1, git('docs/operations-reference.md\nsrc/master.ts\n'), now)!;
  assert.equal(code.behind, 4);
  assert.deepEqual(faults(inputs({ revision: code })), ['resource:loaded-revision']);
});
