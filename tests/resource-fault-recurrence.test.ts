import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { HerdrAgent, MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import type { ReviewRecord } from '../src/reviewer.js';
import { readProducerLedger, saveProducerLedger, type ProducerRecord } from '../src/producer.js';
import { baseReclaimGates, finishedSessionGraceMs, loadedRevision, nameReclaimBoundMs, readReclaimReports, readResources, reclaimResources, resourceAttention, selfUpgradeBoundMs, stuckSessionMs, type ResourceInputs } from '../src/master-resources.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
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
  // Past the self-upgrade's bound (GY-1196): before it, the move is the upgrade under way.
  assert.deepEqual(faults(inputs({ now: code.movedAt! + selfUpgradeBoundMs, revision: code })), ['resource:loaded-revision']);
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

  // 2. BASE: the base's own pass (its gates: a worker closed only when Herdr reported idle, done or
  // blocked, a reviewer or producer pane only when a record settled on its name), run two passes the
  // grace apart, closes none of the seven, so the faults re-raised every pass (GY-1192).
  const baseDirectory = await temporaryDirectory('gy-1165-base');
  await mkdir(join(baseDirectory, '.graphyard'), { recursive: true });
  const baseClosed: string[] = [];
  for (const at of [t0, t0 + finishedSessionGraceMs, t0 + 2 * finishedSessionGraceMs])
    await reclaimResources(baseDirectory, config, { work, agents }, { tmpRoot: baseDirectory, now: at, gates: baseReclaimGates, closePane: pane => { baseClosed.push(pane); } });
  assert.deepEqual(baseClosed, [], 'the base pass closes none of the seven holders');
  assert.deepEqual(faults({ ...state, now: t0 + 2 * finishedSessionGraceMs }).sort(), instances, 'so every instance is still raised on base');

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

/**
 * GY-1196: three resources faults after GY-1130 and GY-1165 shipped, sharing one cause: the plane's
 * declared reclaims for the two resources — the self-upgrade's restart for loaded-revision, the name
 * reclaim for agent-names — ran on the master cycle's cadence, and a loaded cycle runs for ten to
 * fifteen minutes, while the readings judged them on wall-clock bounds as if they ran at once.
 *
 * - resource:loaded-revision (11:07:12Z, 11:47:27Z): the self-upgrade between two cycles itself
 *   moved the checkout (reflog 11:06:39Z, 11:46:54Z); the next cycle's reading, 33 seconds later,
 *   faulted on the move the upgrade was still restarting onto.
 * - resource:agent-names:claude-primary (12:41:53Z): graphyard-claude-1's finished pane w1V:pHAS
 *   needed two reclaim passes 60s apart, one per cycle; cycles of 551s, 707s and 862s put the
 *   second pass past the 10-minute bound.
 */
test('manual:fault-class-resources — GY-1196: the loaded-revision instances are the self-upgrade under way, not a fault, until its bound passes', () => {
  const seconds = (at: string) => Math.floor(Date.parse(at) / 1000);
  const sha = (label: string) => label.padEnd(40, '0');
  /** A git and ps that answer for one loop process and the coordinator checkout's reflog, newest first. */
  const host = (startedAt: string, readAt: number, reflog: [string, string][], codeMoves: string[], behind: number) => (command: string, args: string[]) => {
    if (command === 'ps') return `${Math.floor(readAt / 1000) - seconds(startedAt)}\n`;
    if (args.includes('rev-parse')) return `${reflog[0][0]}\n`;
    if (args.includes('reflog')) return reflog.map(([commit, at]) => `${commit} HEAD@{${seconds(at)}}`).join('\n') + '\n';
    if (args.includes('diff')) return codeMoves.includes(args.at(-1)!) ? 'src/master.ts\n' : 'docs/operations-reference.md\n';
    return `${behind}\n`;
  };
  const instances = [
    // Instance 1: the loop started 10:54:47Z on dd13101b84ed; the upgrade moved the checkout to b289b9137069 at 11:06:39Z.
    { at: Date.parse('2026-10-04T11:07:12.746Z'), started: '2026-10-04T10:54:47Z', behind: 4, moved: '2026-10-04T11:06:39Z',
      reflog: [[sha('b289b9137069'), '2026-10-04T11:06:39Z'], [sha('dd13101b84ed'), '2026-10-04T10:43:58Z']] as [string, string][], code: [sha('b289b9137069')] },
    // Instance 2: the loop started 11:19:50Z on b289b9137069; a docs-only merge moved the checkout at
    // 11:30Z, which the loop is never behind on, then the upgrade moved it onto code at 11:46:54Z.
    { at: Date.parse('2026-10-04T11:47:27.419Z'), started: '2026-10-04T11:19:50Z', behind: 7, moved: '2026-10-04T11:46:54Z',
      reflog: [[sha('6bfc6514ab1a'), '2026-10-04T11:46:54Z'], [sha('d0c5d0c5d0c5'), '2026-10-04T11:30:00Z'], [sha('b289b9137069'), '2026-10-04T11:06:39Z']] as [string, string][], code: [sha('6bfc6514ab1a')] },
  ];
  for (const instance of instances) {
    const revision = loadedRevision('/nonexistent', 1, host(instance.started, instance.at, instance.reflog, instance.code, instance.behind), instance.at)!;
    assert.equal(revision.behind, instance.behind);
    assert.equal(revision.movedAt, Date.parse(instance.moved), 'the move onto unloaded code is timed from the reflog, not the first move since the start');
    // REPRODUCE against base: base's reading had no move time and counted every commit behind at once.
    const { movedAt: _, ...base } = revision;
    assert.deepEqual(faults(inputs({ now: instance.at, revision: base })), ['resource:loaded-revision']);
    // CANDIDATE: the same state 33 seconds after the upgrade's own move is the upgrade under way.
    assert.deepEqual(faults(inputs({ now: instance.at, revision })), []);
    const reading = readResources(inputs({ now: instance.at, revision })).find(entry => entry.id === 'loaded-revision')!;
    assert.equal(reading.state, 'ok');
    assert.match(reading.detail!, new RegExp(`${instance.behind} commits behind since ${instance.moved.replace('Z', '.000Z')}; the self-upgrade has until`));
    // The bound still holds: an upgrade that never lands (the refusal GY-1145 removes) is a fault once it passes.
    assert.deepEqual(faults(inputs({ now: Date.parse(instance.moved) + selfUpgradeBoundMs - 1, revision })), []);
    assert.deepEqual(faults(inputs({ now: Date.parse(instance.moved) + selfUpgradeBoundMs, revision })), ['resource:loaded-revision']);
  }
});

test('manual:fault-class-resources — GY-1196: the agent-names instance is reclaimed within its bound on the dispatcher tick, however long the cycle runs', async () => {
  const settled = Date.parse('2026-10-04T12:30:00.000Z'), readAt = Date.parse('2026-10-04T12:41:53.835Z');
  const config = { workers: [{ name: 'claude-primary', principal: 'graphyard-claude-1', agentName: 'graphyard-claude-1', mode: 'launch' as const }], reviewers: [], producers: [] };
  const pane = agent('graphyard-claude-1', 'idle', 'w1V:pHAS');
  const work = [workerItem('graphyard-claude-1', { startedAt: settled - 3_600_000, endedAt: settled, state: 'done' })];
  const state = (now: number, agents: HerdrAgent[]): ResourceInputs => ({ now, reviews: [], producers: [], agents, work, plane: null, loop: null, revision: null, disk: null, profiles: config });

  // REPRODUCE against base: the full pass ran once per cycle. The cycle that finished at 12:41:19Z
  // ran its pass early, before the session settled; the next ran its first sighting after 12:41:53Z.
  // At the reading the pane had been held, settled, for 11m53s: the instance.
  const base = await temporaryDirectory('gy-1196-base');
  await mkdir(join(base, '.graphyard'), { recursive: true });
  const baseClosed: string[] = [];
  for (const at of [settled - 5 * 60_000, readAt + 60_000]) await reclaimResources(base, config, { work, agents: [pane] }, { tmpRoot: base, now: at, closePane: closed => { baseClosed.push(closed); } });
  assert.deepEqual(baseClosed, [], 'the cycle-paced pass had closed nothing by the reading');
  assert.deepEqual(faults(state(readAt, [pane])), ['resource:agent-names:claude-primary']);

  // CANDIDATE: the dispatcher's tick runs the name pass every few seconds. Driven through the tick,
  // the pane closes at its second sighting a grace after the first, well inside the bound.
  const directory = await temporaryDirectory('gy-1196-candidate');
  await mkdir(join(directory, '.graphyard'), { recursive: true });
  let agents: HerdrAgent[] = [pane], clock = settled;
  const closedAt: Record<string, number> = {};
  const effects: DispatchEffects = {
    snapshot: async () => ({ work, now: new Date(clock).toISOString() }), agents: () => agents,
    credentials: async () => ({}), reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: [] }),
    launchReview: async () => {}, launchProducer: async () => {}, persist: async () => {},
    reclaimNames: async (snapshotWork, observed) => (await reclaimResources(directory, config, { work: snapshotWork, agents: observed }, { namesOnly: true, tmpRoot: directory, now: clock,
      closePane: closed => { closedAt[closed] = clock; agents = agents.filter(entry => entry.pane_id !== closed); } })).closed.map(entry => ({ pane: entry.pane, agentName: entry.name })),
  };
  const dispatchConfig = { url: 'https://graphyard.example', repository: 'owner/repo', hostId: 'vishrog', reviewers: [], producers: [], workers: [], run: {} } as unknown as MasterConfig;
  const cursor = emptyDispatchCursor(dispatchConfig);
  for (; clock <= settled + nameReclaimBoundMs && agents.length; clock += 10_000) await runDispatchTick(dispatchConfig, cursor, effects, () => clock);
  assert.ok(closedAt['w1V:pHAS'] !== undefined, 'the tick closed the finished pane');
  assert.ok(closedAt['w1V:pHAS'] - settled <= 3 * finishedSessionGraceMs, `closed ${(closedAt['w1V:pHAS'] - settled) / 1000}s after settling, inside the ${nameReclaimBoundMs / 60_000}-minute bound`);
  assert.deepEqual(faults(state(readAt, agents)), [], 'with the pane closed, the instance does not recur');
  // The name pass fails, reaps and sweeps nothing: no ledger written, no /tmp pass recorded.
  assert.equal((await readReclaimReports(directory)).every(report => report.reaped.review === 0 && report.reaped.producer === 0 && report.tmp.removed === 0 && report.released.length === 0), true);
});

test('GY-1192: the base gates run by the GY-1165 reproduction close what the base closed — an idle worker and a producer with a settled record', async () => {
  const directory = await temporaryDirectory('gy-1192-base-control');
  await mkdir(join(directory, '.graphyard'), { recursive: true });
  const config = { workers, producers, reviewers: [] };
  // The positive control for the base half: the same holders, made finished in the base's own terms.
  await saveProducerLedger(directory, { version: 1, producers: [{
    id: randomUUID(), key: 'GY-PROD-1', pr: 1, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, group: 'group-1', proofs: ['integration:proof'],
    profile: 'claude-producer-2', principal: 'principal-claude-producer-2', agentName: 'produce-claude-2', pane: 'w1V:pB2', requestId: 'req-prod-1', attempt: 1,
    state: 'completed' as const, outcome: {}, requestedAt: iso(now - 3_600_000), expiresAt: iso(now + 30 * 60_000), closedAt: iso(now - 15 * 60_000),
  } as ProducerRecord] });
  const agents = [agent('graphyard-opencode-1', 'idle', 'w1V:pB1'), agent('produce-claude-2', 'idle', 'w1V:pB2')];
  const work = [workerItem('graphyard-opencode-1', { startedAt: now - 3_600_000, endedAt: now - 15 * 60_000, state: 'done' })];
  const closed: string[] = [];
  for (const at of [now, now + finishedSessionGraceMs])
    await reclaimResources(directory, config, { work, agents }, { tmpRoot: directory, now: at, gates: baseReclaimGates, closePane: pane => { closed.push(pane); } });
  assert.deepEqual(closed.sort(), ['w1V:pB1', 'w1V:pB2']);
});

test('GY-1192: a recordless producer pane blocked or unknown waits the stuck-session bound and closes as never started; an idle one keeps the grace', async () => {
  const directory = await temporaryDirectory('gy-1192-recordless');
  await mkdir(join(directory, '.graphyard'), { recursive: true });
  const config = { workers: [], producers: [{ name: 'claude-producer-2', agentName: 'produce-claude-2', concurrency: 3 }], reviewers: [] };
  // A launch stuck on a trust prompt before its pending record landed, one whose runtime never reports, and a finished one.
  const agents = [agent('produce-claude-2-0000000a', 'blocked', 'w1V:pR1'), agent('produce-claude-2-0000000b', 'unknown', 'w1V:pR2'), agent('produce-claude-2-0000000c', 'idle', 'w1V:pR3')];
  const closed: { pane: string; reason: string }[] = [];
  const pass = (at: number) => reclaimResources(directory, config, { work: [], agents: agents.filter(entry => !closed.some(done => done.pane === entry.pane_id)) }, { tmpRoot: directory, now: at, closePane: () => {} }).then(report => { closed.push(...report.closed); });
  await pass(now);
  await pass(now + finishedSessionGraceMs);
  assert.deepEqual(closed.map(entry => entry.pane), ['w1V:pR3'], 'only the idle recordless pane closes at the grace');
  assert.match(closed[0].reason, /left no record$/);
  await pass(now + stuckSessionMs - 1);
  assert.equal(closed.length, 1, 'a blocked or unknown recordless pane survives inside the stuck-session bound');
  await pass(now + stuckSessionMs);
  assert.deepEqual(closed.map(entry => entry.pane).sort(), ['w1V:pR1', 'w1V:pR2', 'w1V:pR3']);
  for (const entry of closed.filter(entry => entry.pane !== 'w1V:pR3')) assert.match(entry.reason, /left no record: never started: (blocked|unknown) in Herdr for over 10 minutes/);
});
