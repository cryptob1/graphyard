import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentOwner, loadMasterConfig, masterConfigSchema, setupMaster, type AttentionItem, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { cycleDelay, cycleFaults, emptyDaemonState, loopLiveness, runCycle, type DaemonEffects, type LoopState } from '../src/master-daemon.js';
import { launchAppearanceMs } from '../src/daemon/effects.js';
import type { Work } from '../src/model.js';
import type { ReviewRecord } from '../src/reviewer.js';
import { readProducerLedger, saveProducerLedger, type ProducerRecord } from '../src/producer.js';
import { baseReclaimGates, describeReclaim, finishedSessionGraceMs, ledgerRetentionMs, loadedRevision, nameReclaimBoundMs, readReclaimReports, readResources, readGitHubBudget, reclaimResources, resourceAttention, resourceReportFile, selfUpgradeBoundMs, stuckSessionMs, unownedPaneConfirmMs, type PlaneReading, type ResourceInputs } from '../src/master-resources.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { classifyAttention, trackFaults } from '../src/model/fault-classes.js';
import { attributeAttention, resourceStatus } from '../src/master-status.js';
import * as masterResources from '../src/master-resources.js';
import { writeFile } from 'node:fs/promises';
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


// ---- GY-1166: holders whose evidence is gone or unrecognized ------------------------------------
//
// GY-1165 recorded seven resource:agent-names instances after GY-1130, all of two shapes the
// reclaim had no path back from: a producer pane whose settled record retention had already reaped
// (produce-claude-2 idle in w1V:pG8C, no record in producers.json), and worker panes Herdr reported
// 'unknown' (six workers, among them graphyard-claude-1 in w1V:pG8F). Each profile's namespace bound
// is 1, so one leaked pane holds the profile at its bound.

const t1166 = Date.parse('2026-10-03T17:31:17.735Z');
/** The seven GY-1165 subjects: six worker profiles and one producer profile, each at concurrency 1. */
const gy1165Workers = [
  { name: 'claude-primary', principal: 'graphyard-claude-1', agentName: 'graphyard-claude-1', mode: 'launch', pane: 'w1V:pG8F' },
  { name: 'claude-secondary', principal: 'graphyard-claude-2', agentName: 'graphyard-claude-2', mode: 'launch', pane: 'w1V:pG86' },
  { name: 'claude-tertiary', principal: 'graphyard-claude-3', agentName: 'graphyard-claude-3', mode: 'launch', pane: 'w1V:pG87' },
  { name: 'claude-quaternary', principal: 'graphyard-claude-4', agentName: 'graphyard-claude-4', mode: 'launch', pane: 'w1V:pG89' },
  { name: 'claude-quinary', principal: 'graphyard-opencode-3', agentName: 'graphyard-opencode-3', mode: 'launch', pane: 'w1V:pG5Q' },
  { name: 'cursor-secondary', principal: 'graphyard-cursor-2', agentName: 'graphyard-cursor-2', mode: 'launch', pane: 'w1V:pG7B' },
];
const gy1165Producers = [{ name: 'claude-producer-2', agentName: 'produce-claude-2' }, { name: 'claude-producer-4', agentName: 'produce-claude-4' }, { name: 'claude-producer-1', agentName: 'produce-claude-1' }];
const gy1165Profiles = { workers: gy1165Workers.map(({ pane: _pane, ...profile }) => profile), reviewers: [], producers: gy1165Producers };
/** An agent as Herdr reports it, status possibly absent. */
const held = (name: string, pane: string, status?: string, runtime: string | null = 'claude'): HerdrAgent => ({ name, pane_id: pane, ...(status === undefined ? {} : { agent_status: status }), ...(runtime ? { agent: runtime } : {}) } as HerdrAgent);
/** A producer record as the ledger schema stores it; `closedAt` undefined leaves it unsettled. */
const ledgerRecord = (agentName: string, state: string, closedAt: number | undefined, pane = 'w1V:pG00'): ProducerRecord => ({
  id: randomUUID(), key: 'GY-1098', pr: 1, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, group: 'group-1', proofs: ['integration:proof'],
  profile: agentName, principal: `principal-${agentName}`, agentName, pane, requestId: randomUUID(), attempt: 1, state, outcome: {},
  requestedAt: iso((closedAt ?? t1166) - 600_000), expiresAt: iso(t1166 + 3_600_000), ...(closedAt === undefined ? {} : { closedAt: iso(closedAt), requestClosedAt: iso(closedAt) }),
} as unknown as ProducerRecord);
/** producers.json as observed: produce-claude-4 failed, produce-claude-1 pending, nothing for produce-claude-2. */
const observedProducers = (): ProducerRecord[] => [
  ledgerRecord('produce-claude-4', 'failed', t1166 - 5 * 60_000, 'w1V:pG8D'),
  ledgerRecord('produce-claude-1', 'pending', undefined, 'w1V:pG8A'),
];
const gy1165Agents = (): HerdrAgent[] => [
  held('produce-claude-2', 'w1V:pG8C', 'idle'),
  held('produce-claude-1', 'w1V:pG8A', 'working'),
  ...gy1165Workers.map((worker, index) => index % 2 ? held(worker.agentName, worker.pane, 'unknown') : held(worker.agentName, worker.pane, undefined, null)),
];
const gy1165Work = () => gy1165Workers.map(worker => workerItem(worker.principal, { startedAt: t1166 - 3_600_000, endedAt: t1166 - 20 * 60_000, state: 'finished' }));
/** Runs reclaim passes `gapMs` apart, removing each closed pane from Herdr's next report. */
async function passes(directory: string, count: number, gapMs: number, agents: HerdrAgent[], work: Work[], profiles = gy1165Profiles, start = t1166) {
  const closed: string[] = [], reports = [];
  for (let pass = 0; pass < count; pass++) reports.push(await reclaimResources(directory, profiles, { work, agents: agents.filter(entry => !closed.includes(entry.pane_id!)) },
    { tmpRoot: directory, now: start + pass * gapMs, closePane: pane => { closed.push(pane); } }));
  return { closed, reports, remaining: agents.filter(entry => !closed.includes(entry.pane_id!)) };
}
const ledgerRoot = async (name: string, producers: ProducerRecord[]) => {
  const directory = await temporaryDirectory(name);
  await mkdir(join(directory, '.graphyard'), { recursive: true });
  await saveProducerLedger(directory, { version: 1, producers });
  return directory;
};

test('unit:agent-name-reclaim-closes-pane-after-record-reaped — a producer pane whose record retention reaped is closed after two passes confirm it unowned, and the close is reported', async () => {
  const producers = observedProducers();
  const agents = [held('produce-claude-2', 'w1V:pG8C', 'idle'), held('produce-claude-1', 'w1V:pG8A', 'working')];
  const profiles = { workers: [], reviewers: [], producers: gy1165Producers };
  const reading = (input: Partial<ResourceInputs>) => inputs({ now: t1166, producers, agents, profiles, ...input });

  // REPRODUCE: the subject as recorded — the producer namespace at its bound, the holder overdue.
  assert.deepEqual(faults(reading({})), ['resource:agent-names:claude-producer-2']);
  assert.match(readResources(reading({})).find(entry => entry.id === 'agent-names:claude-producer-2')!.detail!, /produce-claude-2 \(idle, no live session, not reclaimed within 10 minutes of settling, pane w1V:pG8C\)/);
  // BASE: step 2 closed a pane only from the name's settled record (`if (!settled || …) continue`), and none is left.
  assert.equal(producers.filter(record => record.agentName === 'produce-claude-2').length, 0, 'retention reaped the only evidence the base close read');

  // CANDIDATE: first sighting, then closed by the pass a grace (60s) on; a pass just inside it closes nothing.
  const directory = await ledgerRoot('gy-1166-reaped', producers);
  const inside = await passes(await ledgerRoot('gy-1166-reaped-inside', producers), 2, finishedSessionGraceMs - 1, agents, [], profiles);
  assert.deepEqual(inside.closed, [], 'two passes less than 60s apart close nothing');
  const run = await passes(directory, 2, finishedSessionGraceMs, agents, [], profiles);
  assert.deepEqual(run.reports.map(report => report.closed.map(entry => entry.pane)), [[], ['w1V:pG8C']], 'closed once two passes at least 60s apart saw it unowned');
  assert.match(run.reports[1].closed[0].reason, /its producer session left no record$/);
  assert.deepEqual(run.remaining.map(entry => entry.pane_id), ['w1V:pG8A'], 'the pending launch on produce-claude-1 is untouched');
  const recorded = await readReclaimReports(directory);
  assert.deepEqual(recorded.at(-1)!.closed.map(entry => entry.name), ['produce-claude-2'], 'the pass records the close');
  assert.match(describeReclaim(run.reports[1])!, /closed 1 finished session\(s\) and released their names \(produce-claude-2\)/);

  // NON-RECURRENCE: the namespace is free again.
  assert.deepEqual(faults(reading({ now: t1166 + 2 * finishedSessionGraceMs, agents: run.remaining })), []);
});

test('integration:resources-reclaimed-within-bound — GY-1166: retention keeps a held name\'s evidence, and a pane with no record or no recognized status is given back inside the name bound', async () => {
  const profiles = { workers: gy1165Profiles.workers.slice(0, 1), reviewers: [], producers: gy1165Producers.slice(0, 2) };
  const settled = t1166 - ledgerRetentionMs - 120_000;
  // produce-claude-4's record crossed retention on a pass that could not read Herdr, so it was reaped before any pass saw its pane.
  const directory = await ledgerRoot('gy-1166-bound', [ledgerRecord('produce-claude-4', 'failed', settled, 'w1V:pG8D')]);
  const blind = await reclaimResources(directory, profiles, { work: [], agents: null }, { tmpRoot: directory, now: t1166 - 120_000, closePane: () => {} });
  assert.equal(blind.reaped.producer, 1);
  // produce-claude-2 settled past retention too, while its pane was still winding down.
  const kept = ledgerRecord('produce-claude-2', 'completed', settled, 'w1V:pG8C');
  await saveProducerLedger(directory, { version: 1, producers: [kept] });
  const work = [workerItem('graphyard-claude-1', { startedAt: t1166 - 3_600_000, endedAt: t1166 - 20 * 60_000, state: 'finished' })];
  const closed: string[] = [];
  const pass = async (at: number, agents: HerdrAgent[]) => reclaimResources(directory, profiles, { work, agents: agents.filter(entry => !closed.includes(entry.pane_id!)) },
    { tmpRoot: directory, now: at, closePane: pane => { closed.push(pane); } });
  const recordless = held('produce-claude-4', 'w1V:pG8D', 'idle'), unknown = held('graphyard-claude-1', 'w1V:pG8F', 'unknown');

  // First sighting: produce-claude-2 is still working, so its record — the close decision's evidence — outlives retention.
  const first = await pass(t1166 - 60_000, [held('produce-claude-2', 'w1V:pG8C', 'working'), recordless, unknown]);
  assert.deepEqual([first.closed, first.reaped.producer], [[], 0]);
  assert.deepEqual((await readProducerLedger(directory)).producers.map(entry => entry.id), [kept.id], 'the newest record on a held name is not reaped');
  // 60s on: the idle pane whose record was reaped is given back at the grace (GY-1165); the unknown
  // worker is still inside the launch bound, so it is never taken for a leak yet.
  const finishedAgents = [held('produce-claude-2', 'w1V:pG8C', 'idle'), recordless, unknown];
  const second = await pass(t1166, finishedAgents);
  assert.deepEqual(second.closed.map(entry => entry.pane), ['w1V:pG8D'], 'a pane with an unrecognized status unowned for less than unownedPaneConfirmMs is never taken for a leak');
  assert.match(second.closed[0].reason, /its producer session left no record$/);
  // 120s after the first sighting: the other two are given back, each close reported with its evidence, and the kept record reaped with its pane.
  const third = await pass(t1166 + 60_000, finishedAgents);
  assert.deepEqual(closed.sort(), ['w1V:pG8C', 'w1V:pG8D', 'w1V:pG8F']);
  const reason = (name: string) => third.closed.find(entry => entry.name === name)!.reason;
  assert.match(reason('produce-claude-2'), /its producer session completed/, 'the close read the record retention would otherwise have reaped');
  assert.match(reason('graphyard-claude-1'), /Herdr reports it unknown/);
  assert.equal(third.reaped.producer, 1);
  assert.deepEqual((await readProducerLedger(directory)).producers, []);
  assert.ok(t1166 + 60_000 - (t1166 - 60_000) === unownedPaneConfirmMs && unownedPaneConfirmMs < nameReclaimBoundMs, 'every close lands inside the name bound');
  assert.deepEqual(faults(inputs({ now: t1166 + 60_000, agents: [], work, profiles })), []);
});

test('unit:agent-name-reclaim-closes-unknown-status-holder — a worker pane Herdr reports unknown or without a status, unowned, is closed by the reclaim pass and by the loop\'s close step', async () => {
  const work = gy1165Work();
  const agents = gy1165Workers.flatMap((worker, index) => [index % 2 ? held(worker.agentName, worker.pane, 'unknown') : held(worker.agentName, worker.pane, undefined)]);
  // BASE: step 4 and closeStep recognized only idle/done/blocked (or the agentless 'unknown' shape), so every one of these was skipped.
  assert.ok(agents.every(entry => !['idle', 'done', 'blocked'].includes(entry.agent_status ?? '') && !!entry.agent));
  const directory = await ledgerRoot('gy-1166-unknown', []);
  const run = await passes(directory, 3, finishedSessionGraceMs, agents, work);
  assert.deepEqual(run.reports.map(report => report.closed.length), [0, 0, 6], 'closed once confirmed unowned past the launch bound');
  assert.match(run.reports[2].closed.find(entry => entry.name === 'graphyard-claude-2')!.reason, /holds no active assignment and Herdr reports it unknown/);
  assert.match(run.reports[2].closed.find(entry => entry.name === 'graphyard-claude-1')!.reason, /Herdr reports it with no status/);
  assert.equal(run.remaining.length, 0);

  // The loop's close step: a launch profile's pane Herdr reports 'unknown' with its runtime present, or with no status.
  const config = await loopConfig();
  const loopAgents: HerdrAgent[] = [held('graphyard-claude-1', 'pane-1', 'unknown'), held('graphyard-cursor-1', 'pane-2', undefined)];
  const closed: string[] = [], state = emptyDaemonState(config), loop = loopEffects([], loopAgents, closed);
  await runCycle(config, state, loop, () => t1166);
  await runCycle(config, state, loop, () => t1166 + 60_000);
  assert.deepEqual(closed, [], 'inside the launch bound nothing closes');
  const result = await runCycle(config, state, loop, () => t1166 + 130_000);
  assert.deepEqual(closed.sort(), ['pane-1', 'pane-2']);
  assert.ok(result.actions.some(action => action.kind === 'close' && action.state === 'done' && /Closed finished session graphyard-claude-1 \(unknown\)/.test(action.detail)));
  assert.ok(result.actions.some(action => action.kind === 'close' && action.state === 'done' && /Closed finished session graphyard-cursor-1 \(no status\)/.test(action.detail)));
  assert.ok(130_000 < nameReclaimBoundMs);

  // With the snapshot clock advancing as in production, the sighting is a wait rather than an
  // interrupted close: reconcile leaves it alone, so it opens no action:close fault, its clock is not
  // reset, the pane closes on the first cycle past launchAppearanceMs, and no sighting row outlives its pane.
  const ticking = { now: t1166 };
  const gone: HerdrAgent[] = [held('graphyard-claude-1', 'pane-1', 'unknown'), held('graphyard-cursor-1', 'pane-2', undefined)];
  const shut: string[] = [], cursor = emptyDaemonState(config), live = loopEffects([], gone, shut, () => ticking.now);
  const cycleAt = async (at: number) => { ticking.now = at; return runCycle(config, cursor, live, () => at); };
  await cycleAt(t1166);
  assert.deepEqual(Object.keys(cursor.actions).filter(key => key.startsWith('exited:')).map(key => cursor.actions[key].state), ['waiting', 'waiting']);
  // pane-2 leaves Herdr on its own before its wait ends: its sighting goes with it.
  gone.splice(1, 1);
  await cycleAt(t1166 + launchAppearanceMs + 1_000);
  assert.deepEqual(shut, ['pane-1'], 'closed on the first cycle past the launch bound, inside nameReclaimBoundMs');
  assert.ok(launchAppearanceMs + 1_000 < nameReclaimBoundMs);
  await cycleAt(t1166 + 2 * launchAppearanceMs);
  assert.deepEqual(Object.keys(cursor.actions).filter(key => key.startsWith('exited:')), [], 'no sighting row is left once its pane is closed or gone');
  assert.deepEqual(Object.keys(cursor.faults.failing).filter(key => key.startsWith('exited:') || key.startsWith('close:')), [], 'no action:close fault stands');
  assert.ok(!cursor.faults.instances.some(instance => /exited:|close:/.test(JSON.stringify(instance))), 'no close fault instance was opened');
});

test('unit:ledger-retention-keeps-record-with-live-pane — a terminal record whose name a pane still holds is not reaped until the pass closes that pane', async () => {
  const settled = t1166 - ledgerRetentionMs;
  const record = ledgerRecord('produce-claude-2', 'completed', settled, 'w1V:pG8C');
  const older = ledgerRecord('produce-claude-2', 'failed', settled - 60_000);
  const directory = await ledgerRoot('gy-1166-retention', [older, record]);
  const profiles = { workers: [], reviewers: [], producers: gy1165Producers.slice(0, 1) };
  // A pane still working on the name: never closed, and its newest record is kept past retention while it holds the name.
  const winding = await reclaimResources(directory, profiles, { work: [], agents: [held('produce-claude-2', 'w1V:pG8C', 'working')] }, { tmpRoot: directory, now: t1166, closePane: () => {} });
  assert.deepEqual(winding.closed, []);
  assert.equal(winding.reaped.producer, 1, 'only the older record, which no pane decision reads, is reaped');
  assert.deepEqual((await readProducerLedger(directory)).producers.map(entry => entry.id), [record.id], 'the newest record on a held name survives retention');
  // Finished now: first sighting keeps the record; the pass that closes the pane reaps it with it.
  const agents = [held('produce-claude-2', 'w1V:pG8C', 'idle')];
  const first = await reclaimResources(directory, profiles, { work: [], agents }, { tmpRoot: directory, now: t1166 + 60_000, closePane: () => {} });
  assert.deepEqual([first.closed.length, first.reaped.producer], [0, 0], 'seen once: kept, so the close keeps its evidence');
  const second = await reclaimResources(directory, profiles, { work: [], agents }, { tmpRoot: directory, now: t1166 + 120_000, closePane: () => {} });
  assert.deepEqual(second.closed.map(entry => entry.pane), ['w1V:pG8C']);
  assert.match(second.closed[0].reason, /its producer session completed/, 'the close read the record retention would otherwise have reaped');
  assert.equal(second.reaped.producer, 1, 'reaped in the same pass that applied the close');
  assert.deepEqual((await readProducerLedger(directory)).producers, []);
});

test('unit:agent-name-reclaim-spared-pending-launch — a young pane, a name with a pending record and a name under a live lease are never closed by the new paths', async () => {
  const directory = await ledgerRoot('gy-1166-spared', [ledgerRecord('produce-claude-1', 'pending', undefined)]);
  const leased = workerItem('graphyard-claude-2', { startedAt: t1166 - 3_600_000, state: 'running' }, { expiresAt: t1166 + 3_600_000 });
  // graphyard-claude-3 is launching: its pane stands, its runtime has not reported and its lease has not landed.
  const launching = workerItem('graphyard-claude-3', { startedAt: t1166 - 30_000, state: 'running' });
  const work = [leased, launching];
  const agents = [
    held('produce-claude-1', 'w1V:pP1', undefined, null),
    held('graphyard-claude-2', 'w1V:pW2', 'unknown'),
    held('graphyard-claude-3', 'w1V:pW3', undefined, null),
    held('graphyard-claude-1', 'w1V:pW1', 'unknown'),
  ];
  // Inside the launch bound nothing new closes, even the unowned holder.
  const young = await passes(directory, 2, finishedSessionGraceMs, agents, work);
  assert.deepEqual(young.closed, [], 'a pane seen for less than the launch bound is never closed');
  // Past it, only the unowned worker pane closes; a launch still within its own bound since starting stays too.
  const later = await reclaimResources(directory, gy1165Profiles, { work, agents }, { tmpRoot: directory, now: t1166 + 2 * finishedSessionGraceMs, closePane: () => {} });
  assert.deepEqual(later.closed.map(entry => entry.pane), ['w1V:pW1']);
  // The loop's close step spares the live lease and the young pane alike.
  const config = await loopConfig();
  const loopWork = [loopItem('GY-2', { owner: 'worker-b', epoch: 11, expiresAt: new Date(t1166 + 3_600_000).toISOString() } as Work['lease'])];
  const closed: string[] = [], state = emptyDaemonState(config), loop = loopEffects(loopWork, [held('graphyard-cursor-1', 'pane-2', 'unknown'), held('graphyard-claude-1', 'pane-1', 'unknown')], closed);
  await runCycle(config, state, loop, () => t1166);
  await runCycle(config, state, loop, () => t1166 + 60_000);
  assert.deepEqual(closed, [], 'younger than launchAppearanceMs: nothing closes');
  await runCycle(config, state, loop, () => t1166 + 130_000);
  assert.deepEqual(closed, ['pane-1'], 'graphyard-cursor-1, whose principal holds a live lease, is never closed');
  assert.equal(unownedPaneConfirmMs, launchAppearanceMs, 'the reclaim pass and the loop wait the same launch bound');
});

test('unit:resource-fault-recurrence-agent-names — GY-1165\'s seven agent-names subjects reproduce, and two reclaim passes leave none at its bound', async () => {
  const reading = (agents: HerdrAgent[], at: number, producers = observedProducers()) => inputs({ now: at, agents, producers, work: gy1165Work(), profiles: gy1165Profiles });
  const subjects = ['claude-primary', 'claude-producer-2', 'claude-quaternary', 'claude-quinary', 'claude-secondary', 'claude-tertiary', 'cursor-secondary'].map(name => `resource:agent-names:${name}`);
  assert.deepEqual(faults(reading(gy1165Agents(), t1166)).sort(), subjects, 'all seven instances reproduce');
  const directory = await ledgerRoot('gy-1166-recurrence', observedProducers());
  const run = await passes(directory, 2, unownedPaneConfirmMs, gy1165Agents(), gy1165Work());
  assert.deepEqual(run.reports[0].closed, [], 'the first pass only notes them');
  assert.equal(run.reports[1].closed.length, 7, 'the second closes every leaked holder');
  assert.deepEqual(run.remaining.map(entry => entry.name), ['produce-claude-1'], 'the pending producer launch stays');
  assert.deepEqual(faults(reading(run.remaining, t1166 + unownedPaneConfirmMs, (await readProducerLedger(directory)).producers)), [], 'zero resource-bound recurrences');

  // The loop's close step (closeStep) frees the six worker names too — 'unknown' with its runtime
  // present and no status at all — within the launch bound, and well inside nameReclaimBoundMs. The
  // base step recognized only idle/done/blocked or the agentless 'unknown' shape, so it skipped all six.
  const workerHolders = gy1165Agents().filter(entry => gy1165Workers.some(worker => worker.agentName === entry.name));
  const loop = await loopCloses(workerHolders, [t1166, t1166 + launchAppearanceMs + 1_000]);
  assert.deepEqual(loop[0], [], 'the first cycle only notes them');
  assert.deepEqual(loop[1].sort(), gy1165Workers.map(worker => worker.pane).sort(), 'the next cycle past the launch bound closes all six');
  assert.ok(launchAppearanceMs + 1_000 < nameReclaimBoundMs, 'inside the name bound');
  assert.deepEqual(faults(reading(gy1165Agents().filter(entry => !loop[1].includes(entry.pane_id!) && entry.name !== 'produce-claude-2'), t1166 + launchAppearanceMs + 1_000, (await readProducerLedger(directory)).producers)), [], 'no worker subject recurs through the loop path either');
});

test('unit:resource-fault-recurrence-reproduces-subjects — both new holder shapes join the GY-1130 subjects: after two reclaim passes none of the seven GY-1165 subjects recurs', async () => {
  // Reaped record (producer) and unrecognized status (workers: 'unknown' with a runtime, and no status at all).
  const shapes = gy1165Agents().filter(entry => entry.agent_status !== 'working');
  assert.ok(shapes.some(entry => entry.agent_status === 'idle' && entry.name === 'produce-claude-2'));
  assert.ok(shapes.some(entry => entry.agent_status === 'unknown' && entry.agent));
  assert.ok(shapes.some(entry => entry.agent_status === undefined));
  // The reaped-record shape closes two passes a grace apart; the unrecognized-status shape waits two
  // passes `unownedPaneConfirmMs` apart, since a launch whose runtime has not appeared reads alike.
  const early = await passes(await ledgerRoot('gy-1166-subjects-early', observedProducers()), 2, finishedSessionGraceMs, gy1165Agents(), gy1165Work());
  assert.deepEqual(early.closed, ['w1V:pG8C'], 'two passes one grace apart close none of the unrecognized-status workers');
  const directory = await ledgerRoot('gy-1166-subjects', observedProducers());
  // At the loop's observed cadence (7-11 minutes) the two passes still close everything, well inside retention of nothing.
  const run = await passes(directory, 2, 7 * 60_000, gy1165Agents(), gy1165Work());
  assert.deepEqual(run.closed.sort(), ['w1V:pG8C', ...gy1165Workers.map(worker => worker.pane)].sort());
  const after = inputs({ now: t1166 + 7 * 60_000, agents: run.remaining, producers: (await readProducerLedger(directory)).producers, work: gy1165Work(), profiles: gy1165Profiles });
  assert.deepEqual(faults(after), []);
  assert.ok(readResources(after).filter(entry => entry.resource === 'agent-names').every(entry => entry.state !== 'exhausted' || entry.id === 'agent-names:claude-producer-1'), 'only the profile with a pending launch reads full');

  // The unrecognized-status shape is reclaimed by the loop's close step as well: two cycles the
  // observed cadence apart leave none of the six worker subjects at its bound.
  const loop = await loopCloses(shapes.filter(entry => entry.name !== 'produce-claude-2'), [t1166, t1166 + 7 * 60_000]);
  assert.deepEqual(loop[1].sort(), gy1165Workers.map(worker => worker.pane).sort());
  assert.deepEqual(faults({ ...after, agents: gy1165Agents().filter(entry => entry.agent_status === 'working') }), []);
});

// ---- Loop harness for closeStep ----------------------------------------------------------------

/** A work item complete enough for a loop cycle (tests/exited-worker-pane.test.ts). */
function loopItem(key: string, lease: Work['lease'] = null): Work {
  const at = (offset = 0) => new Date(t1166 + offset).toISOString();
  return {
    id: `work-${key}`, key, title: 'Leaked names return', description: '', type: 'bug', priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Closed', proofs: ['unit:agent-name-reclaim-spared-pending-launch'] }], policy: { checks: ['test'], review: true }, plannedFiles: [],
    stage: lease ? 'build' : 'review', revision: 4, policyRevision: 1, createdAt: at(-7_200_000), updatedAt: at(), stageEnteredAt: at(-3_600_000), ready: true, epoch: lease?.epoch ?? 4,
    lease, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [], violations: [],
  } as unknown as Work;
}
async function loopConfig(launch: { name: string; principal: string; agentName: string }[] = [{ name: 'claude-primary', principal: 'worker-a', agentName: 'graphyard-claude-1' }, { name: 'cursor-primary', principal: 'worker-b', agentName: 'graphyard-cursor-1' }]): Promise<MasterConfig> {
  const root = await temporaryDirectory('gy-1166-loop');
  const credentials = await temporaryDirectory('gy-1166-loop-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)), credentialDirectory: credentials },
    (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  const profile = (name: string, principal: string, agentName: string) => ({ name, principal, agentName, mode: 'launch', kind: 'claude', credentialFile: '/outside/worker.token', approvals: 'auto' }) as WorkerProfile;
  return { ...await loadMasterConfig(root), workers: launch.map(entry => profile(entry.name, entry.principal, entry.agentName)) };
}
/** Runs loop cycles at each of `at`, returning the panes the close step closed after each one. */
async function loopCloses(agents: HerdrAgent[], at: number[], launch = gy1165Workers) {
  const config = await loopConfig(launch);
  const closed: string[] = [], state = emptyDaemonState(config), loop = loopEffects([], agents, closed), after: string[][] = [];
  for (const clock of at) { await runCycle(config, state, loop, () => clock); after.push([...closed]); }
  return after;
}
function loopEffects(work: Work[], agents: HerdrAgent[], closed: string[], clock = () => t1166): DaemonEffects {
  return {
    agents: () => agents.filter(entry => !closed.includes(entry.pane_id!)), credentials: async () => ({}), snapshot: async () => ({ work, now: new Date(clock()).toISOString() }),
    closeSession: pane => { closed.push(pane); }, dispatch: async () => {}, requestProof: () => {}, merge: async () => ({ result: 'merged', merged: true }),
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(t1166).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
  } as DaemonEffects;
}
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

  // 3. CANDIDATE: the idle recordless producer closes two passes the grace apart; the unknown workers,
  // which a launch whose runtime has not appeared reads like, wait `unownedPaneConfirmMs` (GY-1166).
  const closed = new Set<string>();
  const closePane = (pane: string) => { closed.add(pane); };
  const live = () => agents.filter(entry => !closed.has(entry.pane_id!));
  const first = await reclaimResources(directory, config, { work, agents: live() }, { tmpRoot: directory, now: t0, closePane });
  assert.equal(first.closed.length, 0, 'the first sighting only starts the grace clock');
  const grace = await reclaimResources(directory, config, { work, agents: live() }, { tmpRoot: directory, now: t0 + finishedSessionGraceMs, closePane });
  assert.deepEqual(grace.closed.map(entry => entry.pane), ['w1V:pG8C']);
  assert.match(grace.closed[0].reason, /left no record/);
  const early = await reclaimResources(directory, config, { work, agents: live() }, { tmpRoot: directory, now: t0 + unownedPaneConfirmMs - 1, closePane });
  assert.equal(early.closed.length, 0, 'a pass inside the launch bound closes no unknown worker');
  const second = await reclaimResources(directory, config, { work, agents: live() }, { tmpRoot: directory, now: t0 + unownedPaneConfirmMs, closePane });
  assert.deepEqual(second.closed.map(entry => entry.pane).sort(), held.map(([, , pane]) => pane).sort());

  // 4. NON-RECURRENCE: with the closed panes gone, none of the seven instances is raised.
  assert.deepEqual(faults({ ...state, now: t0 + unownedPaneConfirmMs, agents: agents.filter(entry => !closed.has(entry.pane_id!)) }), []);
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

test('integration:resources-recurrence-reproduces-gy-1272-budget-shape — one rate-limit pause and its held subjects record no resources instance; a budget spent with no pause records one', async () => {
  // GY-1272: at 06:36:13.546Z, three seconds after the loop restarted, one pause until 06:38:26.160Z
  // became six resources instances: resource:github-budget and five held subjects whose own lines
  // named the pause. Four held subjects' symptom lines are rebuilt here beside the pause.
  const at = Date.parse('2026-10-05T06:36:13.546Z');
  const until = Date.parse('2026-10-05T06:38:26.160Z');
  const held = ['installation', 'GY-711', 'GY-1052', 'GY-1241'].map(subject => ({ subject, role: 'master' as const, approvedBy: null, human: false, humanOnly: null, next: 'Clear what that reason names',
    text: `${subject}'s observe action is stalled — GitHub requests paused until ${iso(until)} after a rate/access refusal` }));
  const client = (blockedUntil: number, core: { limit: number; remaining: number } | null) => ({ blockedUntil, apiRequest: async () => {
    if (!core) throw new Error('rate limited; requests paused');
    return { resources: { core: { ...core, reset: Math.floor(until / 1000) } } };
  } });
  /** The resources-class instances the loop records from one budget reading and the held lines. */
  const instances = (github: PlaneReading, lines = held) => {
    const readings = readResources(inputs({ now: at, plane: { writable: true, writeError: null, database: null, github } }));
    return classifyAttention([...resourceAttention(readings), ...attributeAttention(lines, readings)]).filter(item => item.faultClass === 'resources').map(item => item.subject).sort();
  };

  // REPRODUCE against base: base's pause branch read the budget used to its bound by construction.
  const base = { used: 5000, bound: 5000, detail: `the GitHub client paused every request until ${iso(until)} after a rate-limit refusal; the budget is spent until then` };
  assert.deepEqual(instances(base), ['GY-1052', 'GY-1241', 'GY-711', 'installation', 'resource:github-budget'], 'base records the pause once per held subject plus the budget');

  // CANDIDATE: the same pause is the remediation under way, and records nothing in the resources class.
  const paused = (await readGitHubBudget(client(until, null), at))!;
  assert.equal(paused.used, null);
  assert.match(paused.detail!, new RegExp(`paused every request until ${iso(until).replace(/\./g, '\\.')}`));
  assert.deepEqual(instances(paused), []);
  // The pause still counts once, in the observation class, from the plane's own githubBudget.paused.
  assert.equal(classifyAttention([{ subject: 'github', text: `GitHub requests are paused until ${iso(until)}`, role: 'control plane', approvedBy: null, human: false, humanOnly: null, next: '' }])[0].faultClass, 'observation');

  // A budget GET /rate_limit reads spent with no pause in force still records the one instance.
  const spent = (await readGitHubBudget(client(at - 1, { limit: 5000, remaining: 0 }), at))!;
  assert.deepEqual([spent.used, spent.bound], [5000, 5000]);
  assert.deepEqual(instances(spent, []), ['resource:github-budget']);
});

/**
 * GY-1198: the two readings faulted on remediation the product was still performing. The loop's
 * self-upgrade owes a restart that a claim held across every cycle refuses, and the cursor keeps
 * it owed and retries it each cycle; the reclaim pass closes a pane on its own two-pass clock, at
 * one pass per cycle. Each reading now runs on the remediation's clock: the owed restart's latest
 * attempt, and the pane's first seen-unowned time.
 */
const gy1198 = (() => {
  const sha = (label: string) => label.padEnd(40, '0');
  const cycleMs = 12 * 60_000;
  // The GY-1196 loaded-revision instances, read again hours later as the live status still read them.
  const revisions = [
    { at: Date.parse('2026-10-04T11:07:12.746Z'), revision: { loaded: sha('dd13101b84ed'), checkout: sha('b289b9137069'), behind: 4, movedAt: Date.parse('2026-10-04T11:06:39Z') } },
    { at: Date.parse('2026-10-04T11:47:27.419Z'), revision: { loaded: sha('b289b9137069'), checkout: sha('6bfc6514ab1a'), behind: 7, movedAt: Date.parse('2026-10-04T11:46:54Z') } },
  ];
  /** The restart the cursor owes onto `to`, last attempted `ago` before `now`. */
  const owed = (to: string, attemptedAt: number | null, code = true) => ({ from: null, to, code, attemptedAt });
  // The agent-names instance: graphyard-claude-1 settled at 12:30Z, the reading ran at 12:41:53Z,
  // and the pass first saw the pane unowned on the cycle's pass at 12:33Z; the next pass, ~12 minutes on, closes it.
  const settled = Date.parse('2026-10-04T12:30:00.000Z'), readAt = Date.parse('2026-10-04T12:41:53.835Z'), firstSeen = Date.parse('2026-10-04T12:33:00.000Z');
  const profiles = { workers: [{ name: 'claude-primary', principal: 'graphyard-claude-1', agentName: 'graphyard-claude-1', mode: 'launch' }], reviewers: [], producers: [] };
  const pane = agent('graphyard-claude-1', 'idle', 'w1V:pHAS');
  const work = [workerItem('graphyard-claude-1', { startedAt: settled - 3_600_000, endedAt: settled, state: 'done' })];
  const names = (overrides: Partial<ResourceInputs>): ResourceInputs => ({ now: readAt, reviews: [], producers: [], agents: [pane], work, plane: null, loop: null, revision: null, disk: null, profiles, ...overrides });
  return { sha, cycleMs, revisions, owed, settled, readAt, firstSeen, pane, work, names };
})();

test('unit:loaded-revision-owed-restart-is-not-a-fault — commits behind while the cursor owes a code restart attempted within two cycle intervals is the restart under way', () => {
  const { revisions, owed, cycleMs } = gy1198;
  for (const { at, revision } of revisions) {
    // Hours on, past the move's own bound: the restart is still owed and was retried a cycle ago.
    const now = at + 4 * 3_600_000;
    for (const ago of [0, cycleMs, selfUpgradeBoundMs - 1]) {
      const input = inputs({ now, revision, upgrade: owed(revision.checkout, now - ago) });
      assert.deepEqual(faults(input), []);
      const reading = readResources(input).find(entry => entry.id === 'loaded-revision')!;
      assert.equal(reading.state, 'ok');
      assert.equal(reading.used, 0);
      assert.match(reading.detail!, new RegExp(`${revision.behind} commits behind; the self-upgrade's owed restart onto it is under way, last attempted ${new Date(now - ago).toISOString()}`));
    }
    // The cursor may name the commit abbreviated; the owed restart still matches the checkout.
    assert.deepEqual(faults(inputs({ now, revision, upgrade: owed(revision.checkout.slice(0, 12), now - cycleMs) })), []);
  }
  // A loop that spaces its cycles further apart gets two of its own intervals (GY-1255's bound).
  const { revision, at } = revisions[0];
  const loop = { state: 'running' as const, lagMs: 0, stalledAfterMs: 2 * 3_600_000, detail: '' };
  assert.deepEqual(faults(inputs({ now: at + 8 * 3_600_000, loop, revision, upgrade: owed(revision.checkout, at + 8 * 3_600_000 - 90 * 60_000) })), []);
});

test('unit:loaded-revision-stale-past-grace-faults — commits behind with no owed restart, or one not attempted within the grace, still faults with the restart remedy', () => {
  const { revisions, owed } = gy1198;
  for (const { at, revision } of revisions) {
    const now = at + 4 * 3_600_000;
    const raises = (upgrade: ResourceInputs['upgrade']) => {
      const input = inputs({ now, revision, upgrade });
      assert.deepEqual(faults(input), ['resource:loaded-revision'], JSON.stringify(upgrade));
      const item = resourceAttention(readResources(input)).find(entry => entry.subject === 'resource:loaded-revision')!;
      assert.match(item.next, /graphyard master restart/);
    };
    raises(null);
    raises(undefined);
    raises(owed(revision.checkout, now - selfUpgradeBoundMs));
    raises(owed(revision.checkout, null));
    raises(owed(revision.checkout, now - 1, false)); // a move the upgrade owes no code restart for
    raises(owed(gy1198.sha('0123456789ab'), now - 1)); // a restart owed onto another revision
    const reading = readResources(inputs({ now, revision, upgrade: owed(revision.checkout, now - selfUpgradeBoundMs) })).find(entry => entry.id === 'loaded-revision')!;
    assert.match(reading.detail!, /the self-upgrade owes a restart onto it, last attempted/);
  }
});

test('unit:agent-name-holder-with-close-under-way-not-overdue — a holder settled past the bound whose pane the pass first saw unowned within it is a reclaim under way', () => {
  const { names, readAt, firstSeen, settled } = gy1198;
  assert.ok(readAt - settled >= nameReclaimBoundMs, 'settled past the bound');
  for (const seen of [firstSeen, readAt - nameReclaimBoundMs + 1, readAt]) {
    const input = names({ reclaimSeen: { 'w1V:pHAS': new Date(seen).toISOString() } });
    assert.deepEqual(faults(input), []);
    const reading = readResources(input).find(entry => entry.id === 'agent-names:claude-primary')!;
    assert.equal(reading.overdue, 0);
    assert.equal(reading.reclaimable, 1);
    assert.match(reading.detail!, new RegExp(`no live session, reclaim under way \\(seen unowned since ${new Date(seen).toISOString()}\\)`));
  }
});

test('unit:agent-name-holder-past-seen-bound-faults — a holder seen unowned for the bound, or holding no pane the pass can close, still faults', () => {
  const { names, readAt, settled } = gy1198;
  for (const seen of [readAt - nameReclaimBoundMs, readAt - 3 * nameReclaimBoundMs]) {
    const input = names({ reclaimSeen: { 'w1V:pHAS': new Date(seen).toISOString() } });
    assert.deepEqual(faults(input), ['resource:agent-names:claude-primary']);
    assert.match(readResources(input).find(entry => entry.id === 'agent-names:claude-primary')!.detail!, /not reclaimed within 10 minutes of the reclaim pass first seeing it unowned/);
  }
  // No pane the pass can close: the settling clock still judges it, and past the bound it faults.
  const paneless = { name: 'graphyard-claude-1', agent_status: 'idle', agent: 'claude' } as HerdrAgent;
  assert.deepEqual(faults(names({ agents: [paneless], reclaimSeen: { 'w1V:pHAS': new Date(readAt).toISOString() } })), ['resource:agent-names:claude-primary']);
  // A pane the pass has not seen yet keeps the settling clock, so a holder the pass never records still faults.
  assert.deepEqual(faults(names({ reclaimSeen: {} })), ['resource:agent-names:claude-primary']);
  assert.deepEqual(faults(names({ reclaimSeen: { 'w1V:other': new Date(readAt).toISOString() } })), ['resource:agent-names:claude-primary']);
  // A sighting never spares a live lease's loss of guards: a running pane is still never a fault, a fresh settle is still under way.
  assert.deepEqual(faults(names({ now: settled + 60_000, reclaimSeen: {} })), []);
  assert.deepEqual(faults(names({ agents: [agent('graphyard-claude-1', 'working', 'w1V:pHAS')], reclaimSeen: { 'w1V:pHAS': new Date(readAt - 3 * nameReclaimBoundMs).toISOString() } })), []);
});

test('unit:resource-fault-recurrence-reproduces-gy-1196-subjects — the three GY-1196 shapes fault on the base\'s inputs and not on the candidate\'s', async () => {
  const { revisions, owed, cycleMs, names, readAt, firstSeen, sha } = gy1198;
  for (const { at, revision } of revisions) {
    // At the instant and hours on, the restart is owed onto the checkout and retried each cycle.
    for (const now of [at, at + 4 * 3_600_000]) {
      const upgrade = owed(revision.checkout, now - cycleMs);
      // REPRODUCE against base: its reading had no upgrade input, and hours on the move's own bound had passed.
      if (now !== at) assert.deepEqual(faults(inputs({ now, revision })), ['resource:loaded-revision']);
      assert.deepEqual(faults(inputs({ now, revision: { ...revision, movedAt: undefined } })), ['resource:loaded-revision'], 'the base before GY-1196 faulted at the instant too');
      // CANDIDATE: the owed restart under way is no fault.
      assert.deepEqual(faults(inputs({ now, revision, upgrade })), []);
      assert.deepEqual(faults(inputs({ now, revision: { ...revision, movedAt: undefined }, upgrade })), []);
    }
  }
  // Instance 3: graphyard-claude-1 at 11m53s of settling, the pass's first sighting 8m53s before the reading.
  assert.deepEqual(faults(names({})), ['resource:agent-names:claude-primary'], 'REPRODUCE: base judged it on its settling clock');
  assert.deepEqual(faults(names({ reclaimSeen: { 'w1V:pHAS': new Date(firstSeen).toISOString() } })), []);

  // The inputs reach the readings through master status: the cursor's owed restart and the pass's record.
  const directory = await temporaryDirectory('gy-1198-status');
  await mkdir(join(directory, '.graphyard'), { recursive: true });
  await writeFile(resourceReportFile(directory), JSON.stringify({ version: 1, reports: [], seen: { 'w1V:pHAS': new Date(firstSeen).toISOString() } }), { mode: 0o600 });
  const { revision } = revisions[1];
  const now = readAt;
  const run = (command: string, args: string[]) => command === 'ps' ? `${Math.floor((now + selfUpgradeBoundMs - Date.parse('2026-10-04T11:19:50Z')) / 1000)}\n`
    : args.includes('rev-parse') ? `${revision.checkout}\n`
    : args.includes('reflog') ? `${revision.checkout} HEAD@{${Math.floor(Date.parse('2026-10-04T11:46:54Z') / 1000)}}\n${revision.loaded} HEAD@{${Math.floor(Date.parse('2026-10-04T11:06:39Z') / 1000)}}\n`
    : args.includes('diff') ? 'src/master.ts\n' : `${revision.behind}\n`;
  const master = { url: 'http://127.0.0.1:9', hostId: 'vishrog', workers: gy1198.names({}).profiles.workers, reviewers: [], producers: [], credentialFile: join(directory, 'graphyard.token') } as unknown as MasterConfig;
  const cursor = { upgrade: { pending: { from: revision.loaded, to: revision.checkout, code: true } }, actions: { [`upgrade:${sha('release')}`]: { at: new Date(now - cycleMs).toISOString() }, 'upgrade:refused': { at: new Date(now).toISOString() } } };
  // Looked up at run time, so the base (which has no such reader) fails here as a test case.
  const owedUpgrade = (masterResources as Partial<typeof masterResources>).owedUpgrade;
  assert.equal(typeof owedUpgrade, 'function', 'master status reads the owed restart from the cursor');
  assert.deepEqual(owedUpgrade!(cursor), { from: revision.loaded, to: revision.checkout, code: true, attemptedAt: now - cycleMs }, 'the latest attempt is the upgrade action, not its refusal record');
  assert.equal(owedUpgrade!({ upgrade: { pending: null }, actions: {} }), null);
  const loop = { state: 'running' as const, lagMs: 0, stalledAfterMs: 120_000, detail: '', lock: { pid: 1, host: 'vishrog' } };
  const status = (withCursor: boolean) => resourceStatus(directory, master, { reviews: [], producers: [], agents: [gy1198.pane], work: gy1198.work, loop },
    { run, now: now + selfUpgradeBoundMs, fetcher: (async () => { throw new Error('no plane'); }) as unknown as typeof fetch, cursor: async () => withCursor ? cursor : { upgrade: { pending: null }, actions: {} } });
  const subjects = async (withCursor: boolean) => classifyAttention((await status(withCursor)).attention).filter(item => item.faultClass === 'resources').map(item => item.subject).sort();
  // At now + 30 minutes the cursor's attempt is 42 minutes old: past the grace, it faults; the pane is seen 39 minutes: overdue.
  assert.deepEqual(await subjects(true), ['resource:agent-names:claude-primary', 'resource:loaded-revision']);
  cursor.actions[`upgrade:${sha('release')}`].at = new Date(now + selfUpgradeBoundMs - cycleMs).toISOString();
  await writeFile(resourceReportFile(directory), JSON.stringify({ version: 1, reports: [], seen: { 'w1V:pHAS': new Date(now + selfUpgradeBoundMs - 60_000).toISOString() } }), { mode: 0o600 });
  assert.deepEqual(await subjects(true), [], 'with the restart retried a cycle ago and the pane freshly seen, nothing is a fault');
  assert.deepEqual(await subjects(false), ['resource:loaded-revision'], 'with no owed restart on the cursor, the loaded revision faults');
});

test('unit:resource-fault-recurrence-real-stuck-states-still-raise — an owed restart never retried, a pane seen unowned past the bound and a holder with no pane still fault', () => {
  const { revisions, owed, names, readAt } = gy1198;
  const { at, revision } = revisions[1];
  const now = at + 4 * 3_600_000;
  assert.deepEqual(faults(inputs({ now, revision, upgrade: owed(revision.checkout, now - selfUpgradeBoundMs - 1) })), ['resource:loaded-revision']);
  assert.deepEqual(faults(inputs({ now, revision, upgrade: null })), ['resource:loaded-revision']);
  assert.deepEqual(faults(names({ reclaimSeen: { 'w1V:pHAS': new Date(readAt - nameReclaimBoundMs).toISOString() } })), ['resource:agent-names:claude-primary']);
  assert.deepEqual(faults(names({ agents: [{ name: 'graphyard-claude-1', agent_status: 'done', agent: 'claude' } as HerdrAgent], reclaimSeen: {} })), ['resource:agent-names:claude-primary']);
});

/**
 * GY-1272: seven resources faults in 24 hours. Six were one event — the plane's GitHub App budget
 * spent at 06:36:13Z on 5 October 2026 — counted once for the resource and once more for each subject
 * it held (installation, GY-711, GY-1052, GY-1241, GY-1245): the report attributes each held
 * subject's symptom to the resource, and the loop tracked each under its own subject. The seventh,
 * loaded-revision at 05:29:45Z, was the self-upgrade's own checkout move read 32 seconds later by a
 * loop that had loaded 5f2df649, which predates the upgrade grace GY-1196 delivered (9961b70f5).
 * The budget's own cause, one SHA pair compared under three queries on every base move, is removed
 * in src/github.ts and replayed in tests/github-rate-budget.test.ts; here the spent budget, should
 * it recur, is one fault rather than six.
 */
const budgetConfig: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/nonexistent/coordinator.token', cliPath: '/nonexistent/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
const spentAt = Date.parse('2026-10-05T06:36:13.546Z'), pausedUntil = '2026-10-05T06:38:26.160Z';
const budgetSpent = readResources(inputs({ now: spentAt, plane: { writable: true, writeError: null, database: null,
  github: { used: 5000, bound: 5000, detail: `the GitHub client paused every request until ${pausedUntil} after a rate-limit refusal; the budget is spent until then` } } }));
const heldByBudget = ['installation', 'GY-711', 'GY-1052', 'GY-1241', 'GY-1245'];
/** What each held subject showed before the report attributed it: its own stalled read. */
const budgetSymptom = (subject: string): AttentionItem => ({ subject, text: `${subject}'s observe action is stalled — GitHub requests paused until ${pausedUntil} after a rate/access refusal`, ...agentOwner('master', 'Clear what that reason names') });
const attributeToBudget = (status: { work: any[]; attentionItems: AttentionItem[] }) => attributeAttention(status.attentionItems, budgetSpent);
const budgetReport = () => ({ reported: [...resourceAttention(budgetSpent), ...heldByBudget.map(budgetSymptom)], attribute: attributeToBudget });
const unloaded = { behind: 24, loaded: '5f2df649755cfc8f637c558a24b28a19d9c5ced7', checkout: '6b0e67da1b29e796415a00f763da73095ef9fe50', movedAt: Date.parse('2026-10-05T05:29:13.000Z') };
const unloadedReadAt = Date.parse('2026-10-05T05:29:45.052Z');

test('manual:fault-class-resources — GY-1272: one GitHub budget at its bound is one resources fault however many subjects it holds (the six 06:36:13Z instances)', () => {
  assert.equal(budgetSpent.find(reading => reading.id === 'github-budget')!.state, 'exhausted', 'the recorded reading is the budget at its bound');
  // The report still names the resource on every subject it holds: master status shows it where it is held.
  const attributed = attributeAttention([...resourceAttention(budgetSpent), ...heldByBudget.map(budgetSymptom)], budgetSpent);
  assert.deepEqual(attributed.filter(item => /is held by a registered resource at its bound: GitHub App request budget/.test(item.text)).map(item => item.subject), heldByBudget);
  // REPRODUCE against base: the loop tracked each held subject as its own resources fault, six for one bound.
  // CANDIDATE: the spent budget is one fault, on its own subject and in its own words.
  const state = emptyDaemonState(budgetConfig);
  const tracked = cycleFaults(state, [], spentAt, { config: budgetConfig, ...budgetReport() }).filter(fault => fault.faultClass === 'resources');
  assert.deepEqual(tracked.map(fault => [fault.kind, fault.subject]), [['resource-bound', 'resource:github-budget']], `one fault for the spent budget: ${JSON.stringify(tracked.map(fault => fault.subject))}`);
  assert.match(tracked[0].text, /^GitHub App request budget is at its bound: 5000 requests used of 5000 requests/);
  assert.equal(trackFaults(state.faults, tracked, iso(spentAt)).length, 1, 'one instance where the loop recorded six');
  // It stands while the budget stays spent: the next cycle opens nothing.
  assert.deepEqual(trackFaults(state.faults, cycleFaults(state, [], spentAt + 30_000, { config: budgetConfig, ...budgetReport() }), iso(spentAt + 30_000)), []);
  // Where only the held subjects were listed, the first stands for the resource: still one.
  const symptomsOnly = cycleFaults(emptyDaemonState(budgetConfig), [], spentAt, { config: budgetConfig, reported: heldByBudget.map(budgetSymptom), attribute: attributeToBudget });
  assert.deepEqual(symptomsOnly.filter(fault => fault.faultClass === 'resources').map(fault => fault.subject), ['resource:github-budget']);
});

test('manual:fault-class-resources — GY-1272: the 05:29:45Z loaded-revision instance is the upgrade\'s own move, which the loaded code read without its move time', () => {
  // REPRODUCE against the code that filed it (5f2df649, before GY-1196): no move time, every commit behind counted at once.
  const { movedAt: _, ...untimed } = unloaded;
  assert.deepEqual(faults(inputs({ now: unloadedReadAt, revision: untimed })), ['resource:loaded-revision']);
  // CANDIDATE: 32 seconds after the move is the upgrade under way; the bound still holds once it passes.
  assert.deepEqual(faults(inputs({ now: unloadedReadAt, revision: unloaded })), []);
  assert.deepEqual(faults(inputs({ now: unloaded.movedAt + selfUpgradeBoundMs, revision: unloaded })), ['resource:loaded-revision']);
});

/**
 * GY-1317: three resource:executor-liveness instances in 24 hours, each "301–302s used of 600s"
 * while the loop's own liveness verdict was 'running'. The bound is two cycle intervals
 * (run.intervalSeconds 300 → 600s) and the line warns at half of it — exactly one interval — which
 * the loop's idle cadence reaches by design: a cycle ending with nothing actionable waits the full
 * interval (cycleDelay), so the next fault-step reading lands a second or two past the line. The
 * reading now faults only when the verdict does not vouch for the lag.
 */
const livenessIntervalMs = 300_000;
const livenessLock = { id: 'lock', pid: 4242, host: 'vishrog', startedAt: '2026-10-05T00:00:00.000Z', heartbeatAt: '2026-10-05T00:00:00.000Z' };
/** The loop input as faultStep and master status pass it: loopLiveness over the cursor, read `lagMs` after cycle `cycle` completed. */
const livenessAt = (cycle: number, lagMs: number, overrides: Partial<Parameters<typeof loopLiveness>[0]> = {}) => {
  const completedAt = Date.parse('2026-10-05T16:26:24.800Z');
  return { now: completedAt + lagMs, loop: loopLiveness({ lock: livenessLock, cycle, lastCycleAt: iso(completedAt), ...overrides }, completedAt + lagMs, livenessIntervalMs) };
};
const livenessReading = (input: ResourceInputs) => readResources(input).find(reading => reading.id === 'executor-liveness')!;

test('unit:executor-liveness-idle-cadence-vouched — the instances\' shape (running, 301–302s of 600s after a full idle interval) is no low reading and no resources fault', () => {
  for (const [cycle, lagMs] of [[12494, 301_000], [12500, 302_000], [12502, 301_000]] as const) {
    const { now, loop } = livenessAt(cycle, lagMs);
    assert.equal(loop.state, 'running', 'the loop\'s own verdict is running');
    assert.equal(loop.stalledAfterMs, 600_000);
    const reading = livenessReading(inputs({ now, loop }));
    // The shape: past the one-interval line the base warned at.
    assert.ok(reading.headroom! < Math.ceil(reading.bound! / 2), `the lag ${lagMs}ms is past the old one-interval warn line`);
    assert.equal(reading.state, 'ok', `a vouched lag is within its bound: ${JSON.stringify(reading)}`);
    assert.equal(reading.used, lagMs, 'the reading keeps the true lag');
    assert.match(reading.detail!, new RegExp(`Cycle ${cycle} completed ${Math.round(lagMs / 1000)}s ago`), 'the detail names the true lag');
    assert.match(reading.detail!, /liveness verdict is running, which vouches for the lag/, 'the detail names the verdict');
    assert.deepEqual(resourceAttention(readResources(inputs({ now, loop }))).filter(item => item.subject === 'resource:executor-liveness'), []);
    assert.deepEqual(faults(inputs({ now, loop })), []);
    // As faultStep classifies the reported attention: no resource-bound fault on the resource.
    const state = emptyDaemonState(budgetConfig);
    assert.deepEqual(cycleFaults(state, [], now, { config: budgetConfig, reported: resourceAttention(readResources(inputs({ now, loop }))) })
      .filter(fault => fault.subject === 'resource:executor-liveness'), []);
  }
});

test('unit:executor-liveness-unvouched-lag-still-faults — slow, stalled, absent or a lag past the bound still raises the reading and its resources fault', () => {
  const resourceBound = (input: ResourceInputs) => cycleFaults(emptyDaemonState(budgetConfig), [], input.now, { config: budgetConfig, reported: resourceAttention(readResources(input)) })
    .filter(fault => fault.subject === 'resource:executor-liveness').map(fault => [fault.kind, fault.faultClass]);
  const expect = (input: ResourceInputs, state: 'low' | 'exhausted', verdict: LoopState) => {
    assert.equal(input.loop!.state, verdict);
    const reading = livenessReading(input);
    assert.equal(reading.state, state, `${verdict}: ${JSON.stringify(reading)}`);
    assert.match(reading.detail!, new RegExp(`liveness verdict is ${verdict}$`), 'the detail names the verdict, and vouches for nothing');
    assert.deepEqual(faults(input), ['resource:executor-liveness']);
    assert.deepEqual(resourceBound(input), [['resource-bound', 'resources']]);
  };
  // Stalled: past the stall bound with no measured cycle that explains it.
  const stalled = livenessAt(12502, 601_000);
  expect(inputs(stalled), 'exhausted', 'stalled');
  // Slow: a measured cycle past the bound explains the lag, but nothing vouches for a lag past the bound.
  const slow = livenessAt(12502, 700_000, { metrics: [{ cycle: 12502, at: '2026-10-05T16:26:24.800Z', durationMs: 650_000 }] as any });
  expect(inputs(slow), 'exhausted', 'slow');
  // Absent: no loop holds the cursor, so its verdict vouches for no lag, even one inside the bound.
  const absent = livenessAt(12502, 301_000, { lock: null });
  expect(inputs(absent), 'low', 'absent');
  // A verdict claiming running while the lag is past the stall bound does not vouch for it either.
  const { now, loop } = livenessAt(12502, 301_000);
  expect(inputs({ now, loop: { ...loop, lagMs: 601_000 } }), 'exhausted', 'running');
  // Unread: no cursor stays unknown, as before.
  assert.equal(livenessReading(inputs({ loop: null })).state, 'unknown');
});

test('integration:recurring-resources-idle-cadence-files-nothing — idle/actionable alternation opens no executor-liveness instances, while other resources faults still open theirs', () => {
  // Cycles alternate: an idle cycle waits the full interval, an actionable one 30s; each next cycle's
  // fault step reads the cursor a moment after it starts. Under the base, every idle stretch cleared
  // and recurred as one more instance on resource:executor-liveness.
  const config = budgetConfig;
  const state = emptyDaemonState(config);
  const actionable = [0, 3, 0, 0, 2, 0, 1, 0, 0, 4, 0];
  let completedAt = Date.parse('2026-10-05T10:00:00.000Z'), cycle = 12494, priorPastLine = 0;
  const opened: string[] = [];
  for (const [index, count] of actionable.entries()) {
    const readAt = completedAt + cycleDelay(livenessIntervalMs, { actionable: count }) + 1_500;
    const loop = loopLiveness({ lock: livenessLock, cycle, lastCycleAt: iso(completedAt) }, readAt, livenessIntervalMs);
    assert.equal(loop.state, 'running');
    if (loop.lagMs! > loop.stalledAfterMs / 2) priorPastLine += 1;
    // A spent GitHub budget on every other reading: a real resources fault that clears and recurs.
    const plane = index % 2 === 0 ? { writable: true, writeError: null, database: null, github: { used: 5000, bound: 5000, detail: 'spent' } } : null;
    const reported = resourceAttention(readResources(inputs({ now: readAt, loop, plane })));
    opened.push(...trackFaults(state.faults, cycleFaults(state, [], readAt, { config, reported }).filter(fault => fault.faultClass === 'resources'), iso(readAt)).map(fault => fault.subject));
    completedAt = readAt + 77_000; cycle += 1;
  }
  assert.ok(priorPastLine >= 3, `the alternation crossed the old one-interval line ${priorPastLine} times: the base's threshold`);
  assert.equal(opened.filter(subject => subject === 'resource:executor-liveness').length, 0, 'no executor-liveness instances open');
  assert.equal(state.faults.instances.filter(instance => instance.subject === 'resource:executor-liveness').length, 0, 'the fault record holds none');
  assert.equal(opened.filter(subject => subject === 'resource:github-budget').length, 6, 'the spent budget opens one instance per recurrence');
});
