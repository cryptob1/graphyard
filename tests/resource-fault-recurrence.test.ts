import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMasterConfig, setupMaster, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { launchAppearanceMs } from '../src/daemon/effects.js';
import type { Work } from '../src/model.js';
import type { ReviewRecord } from '../src/reviewer.js';
import { readProducerLedger, saveProducerLedger, type ProducerRecord } from '../src/producer.js';
import { describeReclaim, finishedSessionGraceMs, ledgerRetentionMs, loadedRevision, nameReclaimBoundMs, readReclaimReports, readResources, reclaimResources, resourceAttention, stuckSessionMs, unownedPaneConfirmMs, type ResourceInputs } from '../src/master-resources.js';
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

  // CANDIDATE: first sighting, then a pass 60s on (still confirming the launch bound), then closed.
  const directory = await ledgerRoot('gy-1166-reaped', producers);
  const run = await passes(directory, 3, finishedSessionGraceMs, agents, [], profiles);
  assert.deepEqual(run.reports.map(report => report.closed.map(entry => entry.pane)), [[], [], ['w1V:pG8C']], 'closed only once two passes at least 60s apart saw it unowned past the launch bound');
  assert.match(run.reports[2].closed[0].reason, /no producer record holds the name \(its record was reaped or never written\) and Herdr reports it idle/);
  assert.deepEqual(run.remaining.map(entry => entry.pane_id), ['w1V:pG8A'], 'the pending launch on produce-claude-1 is untouched');
  const recorded = await readReclaimReports(directory);
  assert.deepEqual(recorded.at(-1)!.closed.map(entry => entry.name), ['produce-claude-2'], 'the pass records the close');
  assert.match(describeReclaim(run.reports[2])!, /closed 1 finished session\(s\) and released their names \(produce-claude-2\)/);

  // NON-RECURRENCE: the namespace is free again.
  assert.deepEqual(faults(reading({ now: t1166 + 2 * finishedSessionGraceMs, agents: run.remaining })), []);
});

test('integration:resources-reclaimed-within-bound — GY-1166: retention and the reclaim of a pane with no recognized status both land inside the name bound', async () => {
  // A producer session settled; Herdr could not be read on the pass that crossed retention, so its record was reaped before any pass saw the pane.
  const settled = t1166 - ledgerRetentionMs - 60_000;
  const directory = await ledgerRoot('gy-1166-bound', [ledgerRecord('produce-claude-2', 'completed', settled)]);
  const profiles = { workers: gy1165Profiles.workers.slice(0, 1), reviewers: [], producers: gy1165Producers.slice(0, 1) };
  const blind = await reclaimResources(directory, profiles, { work: [], agents: null }, { tmpRoot: directory, now: t1166 - 60_000, closePane: () => {} });
  assert.equal(blind.reaped.producer, 1);
  assert.deepEqual((await readProducerLedger(directory)).producers, []);
  // The pane on the reaped name, and a worker pane Herdr reports 'unknown', are both given back within nameReclaimBoundMs of the first sighting.
  const agents = [held('produce-claude-2', 'w1V:pG8C', 'idle'), held('graphyard-claude-1', 'w1V:pG8F', 'unknown')];
  const work = [workerItem('graphyard-claude-1', { startedAt: t1166 - 3_600_000, endedAt: t1166 - 20 * 60_000, state: 'finished' })];
  const run = await passes(directory, 2, 2 * finishedSessionGraceMs, agents, work, profiles);
  assert.deepEqual(run.closed.sort(), ['w1V:pG8C', 'w1V:pG8F']);
  assert.ok(2 * finishedSessionGraceMs < nameReclaimBoundMs, 'the close lands inside the name bound');
  assert.deepEqual(faults(inputs({ now: t1166 + 2 * finishedSessionGraceMs, agents: run.remaining, work, profiles })), []);
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
  // Neither shape is closed before two passes `unownedPaneConfirmMs` apart confirmed it unowned: a
  // pass one grace on still only notes them, since a launch whose runtime has not appeared reads alike.
  const early = await passes(await ledgerRoot('gy-1166-subjects-early', observedProducers()), 2, finishedSessionGraceMs, gy1165Agents(), gy1165Work());
  assert.deepEqual(early.closed, [], 'two passes one grace apart close none of the new shapes');
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
function loopEffects(work: Work[], agents: HerdrAgent[], closed: string[]): DaemonEffects {
  return {
    agents: () => agents.filter(entry => !closed.includes(entry.pane_id!)), credentials: async () => ({}), snapshot: async () => ({ work, now: new Date(t1166).toISOString() }),
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

  // 2. BASE: the base pass closed a worker pane only when Herdr reported idle, done or blocked, and a
  // reviewer or producer pane only when a ledger record settled on its name. Each holder fails one of
  // those gates, so two passes the grace apart closed none of them and the faults re-raised every pass.
  const baseFinished = ['idle', 'done', 'blocked'];
  assert.ok(held.every(([, principal]) => !baseFinished.includes(agents.find(entry => entry.name === principal)!.agent_status!)), 'every worker pane is outside the base\'s finished statuses');
  assert.equal((await readProducerLedger(directory)).producers.filter(record => record.agentName === 'produce-claude-2').length, 0, 'the producer pane has no record to settle on');

  // 3. CANDIDATE: two passes the unowned-pane confirmation apart close all seven panes, and nothing
  // earlier: none has a settled record Herdr reports finished, so each waits `unownedPaneConfirmMs` (GY-1166).
  const closed = new Set<string>();
  const closePane = (pane: string) => { closed.add(pane); };
  const first = await reclaimResources(directory, config, { work, agents }, { tmpRoot: directory, now: t0, closePane });
  assert.equal(first.closed.length, 0, 'the first sighting only starts the grace clock');
  const early = await reclaimResources(directory, config, { work, agents }, { tmpRoot: directory, now: t0 + unownedPaneConfirmMs - 1, closePane });
  assert.equal(early.closed.length, 0, 'a pass inside the grace closes nothing');
  const second = await reclaimResources(directory, config, { work, agents }, { tmpRoot: directory, now: t0 + unownedPaneConfirmMs, closePane });
  assert.deepEqual(second.closed.map(entry => entry.pane).sort(), [...held.map(([, , pane]) => pane), 'w1V:pG8C'].sort());
  assert.match(second.closed.find(entry => entry.pane === 'w1V:pG8C')!.reason, /no producer record holds the name/);

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
