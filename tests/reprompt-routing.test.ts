import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { idleLeaseMs } from '../src/daemon/cycle-sessions.js';
import { promptTarget } from '../src/daemon/effects.js';
import { masterConfigSchema, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';
import type { SessionHandle, SessionHandleInput } from '../src/model/sessions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-852: The loop's re-prompt of an idle worker reaches that worker's own pane, never another
 * item's session. Profiles reuse agent names across sessions, so a re-prompt resolved by agent
 * name alone can land on whichever session holds the name now — on 2026-09-26 the one re-prompt
 * for idle GY-589 was delivered to the pane of the GY-831-4 session that held the name.
 *
 * AC-1: unit:reprompt-own-pane — a re-prompt (and every paste the loop sends to a running session)
 * is addressed by the pane and session id recorded for the exact item and epoch it concerns,
 * and is refused, with a recorded reason, when that pane now belongs to another item, epoch or session.
 * A test launches two items' sessions under profiles that share an agent name across attempts and
 * asserts each re-prompt reaches only its own item's pane.
 *
 * AC-2: unit:reprompt-pane-gone — when the recorded pane is gone, the loop ends the attempt as
 * idle and redispatches it instead of pasting into any other pane. The item creates tests/reprompt-routing.test.ts.
 *
 * The tests drive the loop's own cycle (`runCycle`) against the production effects contract: the
 * paste target is what the production `promptTarget` derives from the agent the loop selected, the
 * session handles are the shape the loop's own writes produce — the stable `principal:epoch` id
 * the dispatch registered, which carries no epoch because a launch write cannot record one
 * (engine.ts), and whose pane the launcher wrote once the runtime started.
 */
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minutes = (count: number) => count * 60_000;
const sharedName = 'shared-agent';

async function setup() {
  const directory = await temporaryDirectory('reprompt');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  // Two launch profiles that share one agent name: the name each profile's next session reuses,
  // which is why a paste resolved by name has another item's pane under it.
  const workers = [['alpha', 'alpha-principal'], ['beta', 'beta-principal']].map(([name, principal]) =>
    ({ name, principal, agentName: sharedName, mode: 'launch', kind: 'claude', credentialFile: join(directory, `${name}.token`), agentArgs: [], environment: {} }) as unknown as WorkerProfile);
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', herdrWorkspace: 'w1',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers });
  return { directory, master };
}

function held(id: string, key: string, principal: string, epoch: number, overrides: Partial<Work> = {}): Work {
  return {
    id, key, title: `Follow-ups for ${key}`, description: '', type: 'feature', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/a.ts'], stage: 'build', revision: 3, policyRevision: 1,
    createdAt: iso(-minutes(600)), updatedAt: iso(0), stageEnteredAt: iso(-minutes(300)), ready: true, epoch,
    lease: { owner: principal, epoch, expiresAt: iso(minutes(600)) },
    lastAssignment: { owner: principal, epoch, claimedAt: iso(-minutes(300)) },
    workspaces: [{ host: 'machine-a', path: `/srv/worktrees/${key}-${epoch}`, epoch, owner: principal, branch: `graphyard/${key.toLowerCase()}-${epoch}` }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }], violations: [],
    ...overrides,
  } as Work;
}

/** The handle the loop itself records: the stable `principal:epoch` id, no epoch on the write, the pane written once the runtime started. */
const handle = (principal: string, epoch: number, pane: string | null, overrides: Partial<SessionHandle> = {}): SessionHandle => ({
  id: `${principal}:${epoch}`, kind: 'implementation', principal, epoch: null, runtime: 'claude', host: 'machine-a',
  workspace: 'w1', tab: null, pane, agentName: sharedName, role: null, head: null, attach: pane ? `herdr pane attach ${pane} --workspace w1` : null,
  transcript: null, subject: 'work', startedAt: iso(-minutes(30)), updatedAt: iso(-minutes(1)), endedAt: null, state: 'running', outcome: null, ...overrides,
});

interface Harness {
  log: { targets: (string | null)[]; texts: string[]; sessions: SessionHandleInput[]; closed: string[]; capacity: Record<string, unknown>[]; preserved: number[] };
  effects: DaemonEffects;
  listing: HerdrAgent[];
  available: boolean;
}

function harness(items: { current: Work[] }, agents: () => HerdrAgent[], available = true): Harness {
  const log = { targets: [] as (string | null)[], texts: [] as string[], sessions: [] as SessionHandleInput[], closed: [] as string[], capacity: [] as Record<string, unknown>[], preserved: [] as number[] };
  const listing = agents;
  const effects: DaemonEffects = {
    agents: listing,
    herdr: () => ({ agents: listing(), available }),
    credentials: async profiles => Object.fromEntries(profiles.map(entry => [entry.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: items.current, now: iso(0) }),
    closeSession: pane => { log.closed.push(pane); },
    dispatch: async () => {},
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    requestSmoke: () => {},
    persist: async () => {},
    // The target is what the production effect derives: the pane of the agent the loop selected,
    // never its name alone — this is the assertion surface for AC-1.
    promptSession: (agent, text) => { log.targets.push(promptTarget(agent)); log.texts.push(text); },
    recordSession: async (_work, recorded) => { log.sessions.push(recorded); },
    reportCapacity: async (work, event) => { log.capacity.push(event); items.current = items.current.map(entry => entry.id === work.id ? { ...entry, lease: null, containmentQuarantine: null } as Work : entry); return items.current[0]; },
    preserveWork: async (_work, epoch) => { log.preserved.push(epoch); return { state: 'committed', commit: 'a'.repeat(40), branch: 'graphyard/gy-252-1', detail: 'kept as WIP' }; },
  };
  return { log, effects, listing: listing(), available };
}

test('unit:reprompt-own-pane — each re-prompt reaches only its own item\'s pane when profiles share an agent name', async () => {
  const { directory, master } = await setup();
  try {
    // Two items held by the two profiles, each session the pane its own handle records, both
    // sharing the one agent name: resolving either re-prompt by name has both panes under it.
    const mine = held('work-252', 'GY-252', 'alpha-principal', 1, { blocker: 'waiting on a decision', sessions: [handle('alpha-principal', 1, 'w1:pMine')] });
    const other = held('work-456', 'GY-456', 'beta-principal', 1, { blocker: 'waiting on a decision', sessions: [handle('beta-principal', 1, 'w1:pB')] });
    const items = { current: [mine, other] };
    const listing: HerdrAgent[] = [
      { name: sharedName, pane_id: 'w1:pMine', agent_status: 'idle', agent: 'claude' },
      { name: sharedName, pane_id: 'w1:pB', agent_status: 'idle', agent: 'claude' },
    ];
    const { log, effects } = harness(items, () => listing);
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    assert.equal(log.targets.length, 0, 'a worker waiting on its blocker is not prompted');

    // Both blockers clear while both leases are live: the next cycle tells each worker in its own
    // pane — GY-252's re-prompt in w1:pMine and GY-456's in w1:pB — although the agent name both
    // listings share resolves to the first pane for either profile.
    items.current = [held('work-252', 'GY-252', 'alpha-principal', 1, { sessions: [handle('alpha-principal', 1, 'w1:pMine')] }),
      held('work-456', 'GY-456', 'beta-principal', 1, { sessions: [handle('beta-principal', 1, 'w1:pB')] })];
    await runCycle(master, state, effects, () => clock + 30_000);
    assert.deepEqual(log.targets.sort(), ['w1:pB', 'w1:pMine'], 'each re-prompt is addressed by the pane its own item records');
    assert.deepEqual(log.targets.sort(), [...new Set(log.targets)].sort(), 'no pane received another item\'s re-prompt');
    assert.deepEqual(log.texts.filter(text => text.includes('GY-252')).length, 1, 'GY-252 was re-prompted once');
    assert.match(log.texts.find(text => text.includes('GY-252'))!, /On GY-252 \(epoch 1\) its blocker/);
    assert.deepEqual(log.texts.filter(text => text.includes('GY-456')).length, 1, 'GY-456 was re-prompted once');
    assert.match(log.texts.find(text => text.includes('GY-456'))!, /On GY-456 \(epoch 1\) its blocker/);
    assert.equal(log.closed.length, 0, 'no pane was closed');

    // The resolution is never prompted twice.
    await runCycle(master, state, effects, () => clock + 60_000);
    assert.equal(log.targets.length, 2, 'no second re-prompt for the same resolution');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:reprompt-own-pane — a pane the item records for another of its sessions is refused, with a recorded reason', async () => {
  const { directory, master } = await setup();
  try {
    // A freshly dispatched attempt whose coordinates the launcher has not recorded yet: the name
    // listing is the only address there is, and it resolves to the pane the item still records
    // for its previous attempt's session. That paste is refused, with the reason, on the record.
    const item = { current: [held('work-252', 'GY-252', 'alpha-principal', 2, { blocker: 'waiting on a decision', lastAssignment: { owner: 'alpha-principal', epoch: 2, claimedAt: iso(-minutes(300)) },
      sessions: [handle('alpha-principal', 1, 'w1:pOld', { state: 'running' }), handle('alpha-principal', 2, null)] })] };
    const listing: HerdrAgent[] = [{ name: sharedName, pane_id: 'w1:pOld', agent_status: 'idle', agent: 'claude' }];
    const { log, effects } = harness(item, () => listing);
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    assert.equal(log.targets.length, 0, 'a worker waiting on its blocker is not prompted');

    // The blocker clears: the resolution cannot be pasted into the pane the name now holds, and
    // the refusal is recorded with its reason.
    item.current = [held('work-252', 'GY-252', 'alpha-principal', 2, { lastAssignment: { owner: 'alpha-principal', epoch: 2, claimedAt: iso(-minutes(300)) },
      sessions: [handle('alpha-principal', 1, 'w1:pOld', { state: 'running' }), handle('alpha-principal', 2, null)] })];
    await runCycle(master, state, effects, () => clock + 30_000);
    assert.equal(log.targets.length, 0, 'nothing is pasted into the pane of the attempt before this one');
    const refused = Object.values(state.actions).find(action => action.state === 'failed' && /pane w1:pOld is recorded for GY-252's session alpha-principal:1, not for the attempt this paste concerns/.test(action.detail));
    assert.ok(refused, `the refusal is recorded with its reason: ${JSON.stringify(Object.values(state.actions).map(action => action.detail))}`);

    // Once the launcher records this attempt's pane, the re-prompt is delivered there.
    item.current = [held('work-252', 'GY-252', 'alpha-principal', 2, { lastAssignment: { owner: 'alpha-principal', epoch: 2, claimedAt: iso(-minutes(300)) },
      sessions: [handle('alpha-principal', 1, 'w1:pOld', { state: 'running' }), handle('alpha-principal', 2, 'w1:pNew')] })];
    listing[0] = { name: sharedName, pane_id: 'w1:pNew', agent_status: 'idle', agent: 'claude' };
    await runCycle(master, state, effects, () => clock + 30_000);
    assert.deepEqual(log.targets, ['w1:pNew'], 'the re-prompt reaches the pane this attempt\'s own handle records');
    assert.match(log.texts[0], /On GY-252 \(epoch 2\) its blocker/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:reprompt-pane-gone — a recorded pane gone from the runtime ends the attempt as idle, pasting into no other pane', async () => {
  const { directory, master } = await setup();
  try {
    const item = { current: [held('work-252', 'GY-252', 'alpha-principal', 1, { sessions: [handle('alpha-principal', 1, 'w1:pMine')] })] };
    const listing: HerdrAgent[] = [{ name: sharedName, pane_id: 'w1:pMine', agent_status: 'idle', agent: 'claude' }];
    const { log, effects } = harness(item, () => listing);
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    assert.ok(state.actions['idle:work-252:1']?.state === 'waiting', 'the idle attempt is marked');

    // Still its own pane, the re-prompt reaches it once.
    await runCycle(master, state, effects, () => clock + minutes(31));
    assert.deepEqual(log.targets, ['w1:pMine'], 'the idle re-prompt reaches the recorded pane');
    assert.match(log.texts[0], /holds GY-252 \(epoch 1\) with no open blocker or scope request/);

    // The pane dies, and the profile's agent name is taken by another item's live session — the
    // shape the GY-589 incident delivered: the idle re-prompt resolved by name would paste there.
    // The other session is production-shaped: its item holds a lease, and its handle names its pane.
    item.current = [...item.current, held('work-456', 'GY-456', 'beta-principal', 1, { blocker: 'waiting on a decision', sessions: [handle('beta-principal', 1, 'w1:pOther')] })];
    listing.splice(0, listing.length, { name: sharedName, pane_id: 'w1:pOther', agent_status: 'idle', agent: 'claude' } as HerdrAgent);
    await runCycle(master, state, effects, () => clock + minutes(33));
    assert.deepEqual(log.targets, ['w1:pMine'], 'nothing is pasted into the pane the reassigned name holds');
    assert.deepEqual(log.closed.filter(pane => pane !== 'w1:pMine'), [], 'the other item\'s pane is not closed');
    assert.equal(log.capacity.length, 0, 'the attempt is not ended before its post-re-prompt quiet bound passes');

    await runCycle(master, state, effects, () => clock + minutes(63));
    assert.deepEqual(log.targets, ['w1:pMine'], 'still nothing pasted anywhere else');
    assert.deepEqual(log.closed.filter(pane => pane !== 'w1:pMine'), [], 'the pane the name now holds is never closed (the attempt\'s own dead pane may be)');
    assert.deepEqual(log.preserved, [1], 'the attempt keeps what it left, on its branch');
    assert.equal(log.capacity.length, 1, 'the attempt ends on the record, which frees the item for a new attempt');
    assert.equal(log.capacity[0].cause, 'interrupted');
    assert.match(String(log.capacity[0].reason), /its pane w1:pMine has been gone from the runtime since .*, so it cannot be re-prompted, and its agent name is no address/);
    const reclaim = state.actions['resume:reclaim:work-252:1'];
    assert.equal(reclaim?.state, 'done');
    assert.match(reclaim.detail, /keeping the attempt's branch/);
    // The reclaim ends the attempt on the record. In the same cycle the exited-session sweep may
    // also close the attempt's own dead pane, and the two handle writes are unordered (the
    // reclaim's is fire-and-forget), so the reclaim's write is matched, not ordered last.
    const reclaimHandle = log.sessions.filter(entry => entry.id === 'alpha-principal:1' && /closed as failed: idle with a live lease/.test(entry.outcome ?? ''));
    assert.equal(reclaimHandle.length, 1, `the reclaim closed the attempt's handle: ${JSON.stringify(log.sessions.map(entry => entry.outcome))}`);
    assert.equal(reclaimHandle[0].state, 'finished');
    assert.ok(log.closed.every(pane => pane === 'w1:pMine'), 'only the attempt\'s own dead pane was ever closed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:reprompt-pane-gone — a runtime that cannot be read says nothing about a pane being gone', async () => {
  const { directory, master } = await setup();
  try {
    const item = { current: [held('work-252', 'GY-252', 'alpha-principal', 1, { sessions: [handle('alpha-principal', 1, 'w1:pMine')] })] };
    const { log, effects } = harness(item, () => [], false);
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    await runCycle(master, state, effects, () => clock + minutes(31));
    await runCycle(master, state, effects, () => clock + minutes(63));
    assert.deepEqual(log.targets, [], 'nothing is pasted on an unreadable runtime');
    assert.deepEqual(log.capacity, [], 'and no attempt is ended on a listing the runtime did not answer');
    assert.deepEqual(log.closed, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
