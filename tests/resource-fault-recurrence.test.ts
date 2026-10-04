import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HerdrAgent } from '../src/master.js';
import type { Work } from '../src/model.js';
import type { ReviewRecord } from '../src/reviewer.js';
import { readProducerLedger, saveProducerLedger, type ProducerRecord } from '../src/producer.js';
import { finishedSessionGraceMs, loadedRevision, nameReclaimBoundMs, readResources, reclaimResources, resourceAttention, stuckSessionMs, type ResourceInputs } from '../src/master-resources.js';
import { classifyAttention } from '../src/model/fault-classes.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

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

test('manual:fault-class-resources — GY-1130: recurring resources faults from finished sessions not reclaimed are reproduced against base and do not recur against candidate', async () => {
  const directory = await temporaryDirectory('gy-1130-recurrence');
  await mkdir(join(directory, '.graphyard'), { recursive: true });
  const t0 = Date.parse('2026-10-03T02:20:00.000Z');

  // The 4 worker profiles whose agent names held the 4 agent-names instances:
  const gy1130Workers = [
    { name: 'cursor-secondary', principal: 'graphyard-cursor-2', agentName: 'graphyard-cursor-2', mode: 'launch' as const },
    { name: 'claude-secondary', principal: 'graphyard-claude-2', agentName: 'graphyard-claude-2', mode: 'launch' as const },
    { name: 'claude-quinary', principal: 'graphyard-opencode-3', agentName: 'graphyard-opencode-3', mode: 'launch' as const },
    { name: 'claude-quaternary', principal: 'graphyard-claude-4', agentName: 'graphyard-claude-4', mode: 'launch' as const },
  ];

  // The 6 producer profiles for the session-slots:producer instance:
  const gy1130Producers = Array.from({ length: 6 }, (_, index) => ({
    name: `producer-profile-${index + 1}`,
    agentName: `produce-agent-${index + 1}`,
  }));

  // The 4 worker agents holding panes:
  // 1. graphyard-cursor-2 in w1V:pEW8 (idle, no live session)
  // 3. graphyard-claude-2 in w1V:pEV8 (done, no live session)
  // 4. graphyard-opencode-3 in w1V:pETH (done, no live session)
  // 5. graphyard-claude-4 in w1V:pETJ (done, no live session)
  const workerAgents: HerdrAgent[] = [
    agent('graphyard-cursor-2', 'idle', 'w1V:pEW8'),
    agent('graphyard-claude-2', 'done', 'w1V:pEV8'),
    agent('graphyard-opencode-3', 'done', 'w1V:pETH'),
    agent('graphyard-claude-4', 'done', 'w1V:pETJ'),
  ];

  // The 6 producer agents: all finished (done or idle) in Herdr without submitting trusted evidence
  const producerAgents: HerdrAgent[] = gy1130Producers.map((profile, index) =>
    agent(profile.agentName, index % 2 === 0 ? 'done' : 'idle', `w1V:pPROD${index + 1}`),
  );

  const initialAgents = [...workerAgents, ...producerAgents];

  // Work items for workers (settled > 10m ago, no active lease)
  const workerWork: Work[] = [
    workerItem('graphyard-cursor-2', { startedAt: t0 - 3_600_000, endedAt: t0 - 15 * 60_000, state: 'done' }),
    workerItem('graphyard-claude-2', { startedAt: t0 - 3_600_000, endedAt: t0 - 15 * 60_000, state: 'done' }),
    workerItem('graphyard-opencode-3', { startedAt: t0 - 3_600_000, endedAt: t0 - 15 * 60_000, state: 'done' }),
    workerItem('graphyard-claude-4', { startedAt: t0 - 3_600_000, endedAt: t0 - 15 * 60_000, state: 'done' }),
  ];

  // 4 waiting producer requests waiting for a slot:
  const waitingWork: Work[] = Array.from({ length: 4 }, (_, index) => ({
    id: `waiting-item-${index + 1}`,
    key: `GY-WAIT-${index + 1}`,
    stage: 'proof',
    autoDispatch: {
      producers: [{ id: `req-wait-${index + 1}`, state: 'requested' }],
    },
  } as unknown as Work));

  const allWork = [...workerWork, ...waitingWork];

  // 6 pending producer records across the 6 profiles, idle/done for > stuckSessionMs:
  const pendingProducers: ProducerRecord[] = gy1130Producers.map((profile, index) => ({
    id: randomUUID(),
    key: `GY-PROD-${index + 1}`,
    pr: 1,
    sha: 'a'.repeat(40),
    baseSha: 'b'.repeat(40),
    policyRevision: 1,
    group: 'group-1',
    proofs: ['integration:proof'],
    profile: profile.name,
    principal: `principal-${profile.name}`,
    agentName: profile.agentName,
    pane: `w1V:pPROD${index + 1}`,
    requestId: `req-prod-${index + 1}`,
    attempt: 1,
    state: 'pending' as const,
    outcome: {},
    requestedAt: iso(t0 - 30 * 60_000),
    expiresAt: iso(t0 + 30 * 60_000),
    idleSince: iso(t0 - stuckSessionMs - 60_000),
  }));

  const reproducedConfig = {
    workers: gy1130Workers,
    producers: gy1130Producers,
    reviewers: [],
  };

  const reproducedInputs: ResourceInputs = {
    now: t0,
    reviews: [],
    producers: pendingProducers,
    agents: initialAgents,
    work: allWork,
    plane: null,
    loop: null,
    revision: null,
    disk: null,
    profiles: reproducedConfig,
  };

  // 1. REPRODUCE: Check that all 5 instances listed on GY-1130 are present and raise faults:
  const initialFaults = faults(reproducedInputs);
  assert.deepEqual(initialFaults.sort(), [
    'resource:agent-names:claude-quaternary',
    'resource:agent-names:claude-quinary',
    'resource:agent-names:claude-secondary',
    'resource:agent-names:cursor-secondary',
    'resource:session-slots:producer',
  ].sort());

  // 2. BASE: the base's reclaim pass reclaimed reviewer and producer panes only and failed a pending
  // session only when Herdr reported it blocked, so none of these five states had a path back: the
  // worker panes waited on the loop's close step alone, and the finished producers held their slots.
  assert.ok(pendingProducers.every(record => initialAgents.find(candidate => candidate.name === record.agentName)?.agent_status !== 'blocked'),
    'every producer finished idle or done, not blocked on a prompt');

  // 3. CANDIDATE: Run candidate reclaimResources with the candidate's implementation:
  await saveProducerLedger(directory, { version: 1, producers: pendingProducers });
  const closedPanes = new Set<string>();

  // Pass 1:
  // - All 6 producer sessions are failed and released (since agents are idle/done > stuckSessionMs)
  // - Their panes are closed immediately
  // - Worker panes are observed finished and unowned; their first sighting is recorded in seen
  const pass1 = await reclaimResources(
    directory,
    reproducedConfig,
    { work: allWork, agents: initialAgents },
    { tmpRoot: directory, now: t0, closePane: pane => { closedPanes.add(pane); } },
  );

  assert.equal(pass1.released.length, 6, 'Candidate releases all 6 stuck producer session slots');
  assert.equal(pass1.closed.length, 6, 'Candidate closes all 6 producer panes on release');

  // Pass 2: after finishedSessionGraceMs
  // - The 4 worker panes, seen across 2 passes at least finishedSessionGraceMs apart, are closed
  const agentsPass2 = initialAgents.filter(a => !closedPanes.has(a.pane_id!));
  const t1 = t0 + finishedSessionGraceMs;
  const pass2 = await reclaimResources(
    directory,
    reproducedConfig,
    { work: allWork, agents: agentsPass2 },
    { tmpRoot: directory, now: t1, closePane: pane => { closedPanes.add(pane); } },
  );

  assert.equal(pass2.closed.length, 4, 'Candidate closes all 4 finished worker panes');
  assert.deepEqual(pass2.closed.map(c => c.pane).sort(), ['w1V:pETH', 'w1V:pETJ', 'w1V:pEV8', 'w1V:pEW8'].sort());

  // Verify the updated producer ledger has 0 pending sessions:
  const updatedProducers = (await readProducerLedger(directory)).producers;
  assert.equal(updatedProducers.filter(p => p.state === 'pending').length, 0, 'No producer sessions remain pending');

  // Remaining active agents in Herdr after closing all reclaimed panes:
  const candidateAgents = initialAgents.filter(a => !closedPanes.has(a.pane_id!));
  assert.equal(candidateAgents.length, 0, 'All 10 finished/stuck panes were closed');

  // 4. NON-RECURRENCE: Evaluate resources on the candidate state:
  const candidateInputs: ResourceInputs = {
    ...reproducedInputs,
    now: t1,
    producers: updatedProducers,
    agents: candidateAgents,
  };

  const candidateFaults = faults(candidateInputs);
  assert.deepEqual(candidateFaults, [], 'None of the 5 recurring resources faults recur against the candidate');
});


test('manual:fault-class-resources — GY-1165: unknown-status worker panes and a recordless producer pane are reclaimed, so the seven names free themselves', async () => {
  const directory = await temporaryDirectory('gy-1165-recurrence');
  await mkdir(join(directory, '.graphyard'), { recursive: true });
  const t0 = Date.parse('2026-10-03T17:31:17.735Z');
  // The six worker profiles and the producer profile the seven instances name, each holding its one name.
  const held = [
    ['claude-quinary', 'graphyard-opencode-3', 'w1V:pG86'], ['claude-senary', 'graphyard-opencode-4', 'w1V:pG87'],
    ['claude-primary', 'graphyard-claude-1', 'w1V:pG8F'], ['claude-secondary', 'graphyard-claude-2', 'w1V:pG89'],
    ['opencode-primary', 'graphyard-opencode-1', 'w1V:pG5Q'], ['cursor-secondary', 'graphyard-cursor-2', 'w1V:pG7B'],
  ] as const;
  const config = {
    workers: held.map(([name, principal]) => ({ name, principal, agentName: principal, mode: 'launch' as const })),
    producers: [{ name: 'claude-producer-2', agentName: 'produce-claude-2' }], reviewers: [],
  };
  // Every worker pane reports `unknown` (its runtime stopped reporting) with no live lease, settled
  // well past the bound; the idle producer pane has no ledger record left (reaped at retention).
  const agents = [...held.map(([, principal, pane]) => agent(principal, 'unknown', pane)), agent('produce-claude-2', 'idle', 'w1V:pG8C')];
  const work = held.map(([, principal]) => workerItem(principal, { startedAt: t0 - 3_600_000, endedAt: t0 - 15 * 60_000, state: 'done' }));
  const state: ResourceInputs = { now: t0, reviews: [], producers: [], agents, work, plane: null, loop: null, revision: null, disk: null, profiles: config };
  const instances = [...held.map(([name]) => `resource:agent-names:${name}`), 'resource:agent-names:claude-producer-2'].sort();

  // 1. REPRODUCE: the state raises all seven instances.
  assert.deepEqual(faults(state).sort(), instances);

  // 2. BASE: the base pass closed a worker pane only when Herdr reported idle, done or blocked, and a
  // reviewer or producer pane only when a ledger record settled on its name. Each holder fails one of
  // those gates, so two passes the grace apart closed none of them and the faults re-raised every pass.
  const baseFinished = ['idle', 'done', 'blocked'];
  assert.ok(held.every(([, principal]) => !baseFinished.includes(agents.find(entry => entry.name === principal)!.agent_status!)), 'every worker pane is outside the base\'s finished statuses');
  assert.equal((await readProducerLedger(directory)).producers.filter(record => record.agentName === 'produce-claude-2').length, 0, 'the producer pane has no record to settle on');

  // 3. CANDIDATE: two passes the grace apart close all seven panes, and nothing earlier.
  const closed = new Set<string>();
  const closePane = (pane: string) => { closed.add(pane); };
  const first = await reclaimResources(directory, config, { work, agents }, { tmpRoot: directory, now: t0, closePane });
  assert.equal(first.closed.length, 0, 'the first sighting only starts the grace clock');
  const early = await reclaimResources(directory, config, { work, agents }, { tmpRoot: directory, now: t0 + finishedSessionGraceMs - 1, closePane });
  assert.equal(early.closed.length, 0, 'a pass inside the grace closes nothing');
  const second = await reclaimResources(directory, config, { work, agents }, { tmpRoot: directory, now: t0 + finishedSessionGraceMs, closePane });
  assert.deepEqual(second.closed.map(entry => entry.pane).sort(), [...held.map(([, , pane]) => pane), 'w1V:pG8C'].sort());
  assert.match(second.closed.find(entry => entry.pane === 'w1V:pG8C')!.reason, /left no record/);

  // 4. NON-RECURRENCE: with the closed panes gone, none of the seven instances is raised.
  assert.deepEqual(faults({ ...state, now: t0 + finishedSessionGraceMs, agents: agents.filter(entry => !closed.has(entry.pane_id!)) }), []);
});

test('manual:fault-class-resources — GY-1165: the widened reclaim still spares a running pane and a live lease', async () => {
  const directory = await temporaryDirectory('gy-1165-spared');
  await mkdir(join(directory, '.graphyard'), { recursive: true });
  const config = { workers, producers, reviewers: [] };
  // A running recordless producer (a launch whose record has not landed) and an unknown worker under a live lease.
  const agents = [agent('produce-claude-2', 'working', 'w1V:pW1'), agent('graphyard-opencode-1', 'unknown', 'w1V:pW2')];
  const work = [workerItem('graphyard-opencode-1', { startedAt: now - 3_600_000, state: 'running' }, { expiresAt: now + 3_600_000 })];
  const closed: string[] = [];
  for (const at of [now, now + finishedSessionGraceMs, now + 2 * finishedSessionGraceMs])
    await reclaimResources(directory, config, { work, agents }, { tmpRoot: directory, now: at, closePane: pane => { closed.push(pane); } });
  assert.deepEqual(closed, []);
});
