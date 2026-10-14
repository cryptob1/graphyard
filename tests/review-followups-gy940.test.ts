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
 * GY-940 — the four follow-ups the approved review of GY-852 (PR #425) filed, each a way a
 * vanished pane or a reused agent name still let one session's paste, answer or slot reach
 * another session, or let a dead attempt hold its item for ever:
 *
 * 1. A reviewer or producer session whose recorded pane has disappeared is never answered through
 *    the reusable agent name's new holder; the name is the fallback only for a launch that
 *    recorded no pane at all.
 * 2. A waiting attempt whose blocker or scope request clears after its recorded pane has
 *    disappeared is ended on a stable absence — one listing miss starts a bound instead of ending
 *    the attempt, a reappearance cancels it, and the attempt is handed on only once the absence
 *    has stood past it — not held for ever behind a name the absence checks now believe.
 * 3. A pane that vanishes while the worker was still active starts the gone-pane reclaim bound
 *    itself, though no idle marker was ever created.
 * 4. A pane the name resolves to is refused while the attempt's own handle exists but records no
 *    pane yet: the resolution cannot be verified, and the pane may be another item's. A handle
 *    that never records one has its cleared wait reclaimed on the same bounded path, so the
 *    refusal cannot hold the item for ever.
 */
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T00:00:00Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minutes = (count: number) => count * 60_000;
const sharedName = 'agent-alpha', reviewerName = 'reviewer-agent';

/** The destructive rm prompt a blocked session sits at (2026-09-25): answering it is the mis-bind's payoff. */
const dangerousRm = [
  '● Bash(rm -rf /srv/worktrees/GY-940-1/*)',
  '  ⎿  Running…',
  '',
  '╭──────────────────────────────────────────────────────────────╮',
  '│ Bash command                                                 │',
  '│                                                              │',
  '│   rm -rf /srv/worktrees/GY-940-1/*                           │',
  '│   Clear the worktree before regenerating it                  │',
  '│                                                              │',
  '│ Dangerous rm operation on statically-unresolvable target:    │',
  '│ /srv/worktrees/GY-940-1/*                                    │',
  '│                                                              │',
  '│ Do you want to proceed?                                      │',
  '│ ❯ 1. Yes                                                     │',
  '│   2. No                                                      │',
  '╰──────────────────────────────────────────────────────────────╯',
  '   Esc to cancel',
].join('\n').replaceAll('│', ' ');

async function setup() {
  const directory = await temporaryDirectory('gy940');
  const credentialFile = join(directory, 'coordinator.token'), worker = join(directory, 'worker.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await writeFile(worker, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const profile = { name: 'alpha', principal: 'alpha-principal', agentName: sharedName, mode: 'launch', kind: 'claude', credentialFile: worker, agentArgs: [], environment: {} } as unknown as WorkerProfile;
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', herdrWorkspace: 'w1',
    masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [profile] });
  return { directory, master };
}

function held(id: string, key: string, principal: string, epoch: number, overrides: Partial<Work> = {}): Work {
  return {
    id, key, title: `Follow-ups for ${key}`, description: '', type: 'feature', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/a.ts'], stage: 'build', revision: 3, policyRevision: 1,
    createdAt: iso(-minutes(600)), updatedAt: iso(0), stageEnteredAt: iso(-minutes(300)), ready: true, epoch,
    lease: { owner: principal, epoch, expiresAt: iso(minutes(600)) },
    lastAssignment: { owner: principal, epoch, claimedAt: iso(-minutes(20)) },
    workspaces: [{ host: 'machine-a', path: `/srv/worktrees/${key}-${epoch}`, epoch, owner: principal, branch: `graphyard/${key.toLowerCase()}-${epoch}` }],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: false, reasons: ['Worker has not submitted implementation for this attempt'] }], violations: [],
    ...overrides,
  } as Work;
}

/** The handle the loop itself records: the stable `principal:epoch` id, its pane written once the runtime started. */
const implHandle = (principal: string, epoch: number, pane: string | null, overrides: Partial<SessionHandle> = {}): SessionHandle => ({
  id: `${principal}:${epoch}`, kind: 'implementation', principal, epoch: null, runtime: 'claude', host: 'machine-a',
  workspace: 'w1', tab: null, pane, agentName: sharedName, role: null, head: null, attach: pane ? `herdr pane attach ${pane} --workspace w1` : null,
  transcript: null, subject: 'work', startedAt: iso(-minutes(30)), updatedAt: iso(-minutes(1)), endedAt: null, state: 'running', outcome: null, ...overrides,
});

const reviewHandle = (id: string, pane: string | null, overrides: Partial<SessionHandle> = {}): SessionHandle => ({
  id, kind: 'review', principal: 'coordinator', epoch: null, runtime: 'claude', host: 'machine-a', agentName: reviewerName,
  role: 'review', head: 'a'.repeat(40), workspace: 'w1', tab: null, pane, attach: pane ? `herdr pane attach ${pane} --workspace w1` : null,
  transcript: null, subject: 'GY-940: review', startedAt: iso(-minutes(10)), updatedAt: iso(-minutes(1)), endedAt: null, state: 'running', outcome: null, ...overrides,
});

function harness(items: { current: Work[] }, listing: () => HerdrAgent[], extra: Partial<DaemonEffects> = {}, available = true) {
  const log = { targets: [] as (string | null)[], keys: [] as string[][], sessions: [] as SessionHandleInput[], closed: [] as string[], capacity: [] as Record<string, unknown>[], preserved: [] as number[] };
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
    promptSession: (agent, text) => { log.targets.push(promptTarget(agent)); },
    recordSession: async (_work, recorded) => { log.sessions.push(recorded); },
    // The control plane ends the attempt on this record, which frees the item for the next dispatch.
    reportCapacity: async (work, event) => { log.capacity.push(event); items.current = items.current.map(entry => entry.id === work.id ? { ...entry, lease: null, containmentQuarantine: null } as Work : entry); return items.current[0]; },
    preserveWork: async (_work, epoch) => { log.preserved.push(epoch); return { state: 'committed', commit: 'b'.repeat(40), branch: 'graphyard/gy-940-1', detail: 'kept as WIP' }; },
    ...extra,
  };
  return { log, effects };
}

test('unit:gy940-reviewer-pane-gone — a reviewer session whose recorded pane vanished is never answered through the name\'s new holder', async () => {
  const { directory, master } = await setup();
  try {
    // The reviewer's recorded pane is gone and its reusable agent name now holds another blocked
    // session: answering that one would send the original request's continuation into it.
    const item = { current: [held('work-940', 'GY-940', 'alpha-principal', 1, { lease: null, sessions: [reviewHandle('review-request-1', 'w1:pGone')] })] };
    const listing: HerdrAgent[] = [{ name: reviewerName, pane_id: 'w1:pOther', agent_status: 'blocked', agent: 'claude' }];
    const { log, effects } = harness(item, () => listing, {
      sessionOutput: () => dangerousRm,
      answerSession: (_agent, keys) => { log.keys.push(keys); },
      launchedSessions: async () => [{ role: 'reviewer', record: 'review-1', profile: 'reviewer-a', agentName: reviewerName, pane: 'w1:pGone', work: 'GY-940', requestId: 'review-request-1' }],
    });
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    assert.deepEqual(log.keys, [], 'the other session\'s destructive prompt is not declined');
    assert.deepEqual(log.targets, [], 'and no continuation is pasted into the pane the name now holds');
    assert.deepEqual(log.sessions.filter(entry => entry.id === 'review-request-1'), [], 'and the original request\'s handle carries no answer');

    // A launch that recorded no pane at all still resolves by name — the sanctioned fallback:
    // the name's holder is the only address there is, and its prompt is answered.
    const unrecorded = { current: [held('work-940', 'GY-940', 'alpha-principal', 1, { lease: null, sessions: [reviewHandle('review-request-2', null)] })] };
    const fallback = harness(unrecorded, () => listing, {
      launchedSessions: async () => [{ role: 'reviewer', record: 'review-2', profile: 'reviewer-a', agentName: reviewerName, pane: null, work: 'GY-940', requestId: 'review-request-2' }],
    });
    fallback.effects.sessionOutput = () => dangerousRm;
    fallback.effects.answerSession = (_agent, keys) => { fallback.log.keys.push(keys); };
    await runCycle(master, emptyDaemonState(master), fallback.effects, () => clock);
    assert.deepEqual(fallback.log.keys, [['2']], 'the name-fallback launch\'s destructive prompt is declined');
    assert.deepEqual(fallback.log.targets, ['w1:pOther'], 'and its continuation reaches the only session the name holds');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:gy940-wait-resolved-pane-gone — a wait that clears after the attempt\'s pane vanished ends the attempt instead of holding the item', async () => {
  const { directory, master } = await setup();
  try {
    const item = { current: [held('work-940', 'GY-940', 'alpha-principal', 1, { blocker: 'waiting on a decision', sessions: [implHandle('alpha-principal', 1, 'w1:pMine')] })] };
    // The recorded pane is gone and the reusable agent name is held by another live session, so
    // the name-based absence recovery believes this attempt alive and settles nothing.
    const listing: HerdrAgent[] = [{ name: sharedName, pane_id: 'w1:pOther', agent_status: 'idle', agent: 'claude' }];
    const { log, effects } = harness(item, () => listing);
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    assert.equal(state.actions['resume:blocker:work-940:1']?.state, 'waiting', 'what the attempt waits on is marked');
    assert.equal(log.capacity.length, 0, 'a waiting attempt is not ended');

    // The blocker clears: the recorded pane is still gone, so the resolution cannot be delivered.
    // One listing miss is not ownership truth (the inventory and its availability check are
    // separate reads, and listings transiently drop panes), so the first observation only starts
    // the reclaim bound; the attempt stands, and nothing is pasted into the name's holder.
    item.current = [held('work-940', 'GY-940', 'alpha-principal', 1, { sessions: [implHandle('alpha-principal', 1, 'w1:pMine')] })];
    await runCycle(master, state, effects, () => clock + 30_000);
    assert.deepEqual(log.targets, [], 'nothing is pasted into the pane the reassigned name holds');
    assert.deepEqual(log.preserved, [], 'one listing miss does not end the attempt');
    assert.equal(log.capacity.length, 0, 'the attempt stands while the absence is young');
    const bound = state.actions['idle:work-940:1'];
    assert.equal(bound?.state, 'waiting', 'the first gone-pane observation starts the reclaim bound');
    assert.match(bound.detail, /its pane w1:pMine has been gone from the runtime since this cycle while its cleared wait stood undelivered/);

    // The pane is listed again — even while its session sits on a runtime prompt — so the absence
    // the bound was started on no longer stands, and the bound is cancelled, not served later.
    listing[0] = { name: sharedName, pane_id: 'w1:pMine', agent_status: 'blocked', agent: 'claude' };
    await runCycle(master, state, effects, () => clock + minutes(2));
    assert.equal(state.actions['idle:work-940:1'], undefined, 'the reappearance cancelled the reclaim bound');
    assert.equal(log.capacity.length, 0, 'and the attempt was not ended behind it');

    // The pane goes away again: the bound starts afresh from the new observation, not the old one.
    listing[0] = { name: sharedName, pane_id: 'w1:pOther', agent_status: 'idle', agent: 'claude' };
    await runCycle(master, state, effects, () => clock + minutes(3));
    // Read afresh: the cancellation assertion above narrowed the direct lookup to undefined.
    const restarted = (key => state.actions[key])('idle:work-940:1');
    assert.equal(restarted?.state, 'waiting', 'the bound restarted with the new absence');
    assert.equal(restarted.at, iso(minutes(3)), 'dated from the new observation, not the first one');
    assert.equal(log.capacity.length, 0, 'still not ended while the new absence is young');

    // The absence stands past the bound on a later cycle: the attempt ends and the item goes to a
    // new attempt; nothing is closed and the name's holder is never touched.
    await runCycle(master, state, effects, () => clock + minutes(6));
    assert.deepEqual(log.targets, [], 'nothing is pasted into the pane the reassigned name holds');
    assert.deepEqual(log.preserved, [1], 'the attempt keeps what it left, on its branch');
    assert.equal(log.capacity.length, 1, 'the attempt ends on the record, which frees the item for a new attempt');
    assert.equal(log.capacity[0].cause, 'interrupted');
    assert.match(String(log.capacity[0].reason), /its pane w1:pMine has been gone from the runtime since .*, so the cleared wait cannot be delivered to it, and its agent name is no address/);
    // The stable absence also satisfies 1g's exited-session confirmation, so the attempt's own dead
    // pane may be closed there; the pane the reused name now holds never is.
    assert.ok(log.closed.every(pane => pane === 'w1:pMine'), `only the attempt's own dead pane was ever closed, never the name's holder: ${JSON.stringify(log.closed)}`);
    const reclaim = state.actions['resume:reclaim:work-940:1'];
    assert.equal(reclaim?.state, 'done');
    assert.match(reclaim.detail, /keeping the attempt's branch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:gy940-active-pane-gone-reclaim — a pane that vanishes while the worker is active starts the reclaim bound itself', async () => {
  const { directory, master } = await setup();
  try {
    // The pane vanished while the session was working, so no idle marker was ever created, and the
    // profile's agent name is held by another session, so the name-based absence recovery is suppressed.
    const item = { current: [held('work-940', 'GY-940', 'alpha-principal', 1, { sessions: [implHandle('alpha-principal', 1, 'w1:pMine')] })] };
    const listing: HerdrAgent[] = [{ name: sharedName, pane_id: 'w1:pOther', agent_status: 'working', agent: 'claude' }];
    const { log, effects } = harness(item, () => listing);
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    const idle = state.actions['idle:work-940:1'];
    assert.equal(idle?.state, 'waiting', 'the first gone-pane observation is recorded');
    assert.match(idle.detail, /its pane w1:pMine has been gone from the runtime since this cycle while its session held the lease/);
    assert.equal(log.capacity.length, 0, 'the bound has not run yet');

    await runCycle(master, state, effects, () => clock + minutes(10));
    assert.equal(log.capacity.length, 0, 'still inside the bound the attempt stands');

    await runCycle(master, state, effects, () => clock + minutes(31));
    assert.deepEqual(log.targets, [], 'nothing is pasted into the pane the reassigned name holds');
    assert.deepEqual(log.preserved, [1], 'the attempt keeps what it left, on its branch');
    assert.equal(log.capacity.length, 1, 'past the bound the attempt is handed to a new one');
    assert.equal(log.capacity[0].cause, 'interrupted');
    assert.match(String(log.capacity[0].reason), /its pane w1:pMine has been gone from the runtime since .*, so it cannot be re-prompted, and its agent name is no address/);
    assert.ok(log.closed.every(pane => pane === 'w1:pMine'), `only the attempt's own dead pane was ever closed, never the name's holder: ${JSON.stringify(log.closed)}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:gy940-unrecorded-pane-unverified — a pane the name resolves to is refused while the attempt\'s handle records none', async () => {
  const { directory, master } = await setup();
  try {
    // The attempt's handle exists but its coordinate write has not completed: the name listing is
    // all the address there is, and it resolves to a pane no session of this item holds — the
    // fresh cross-item case, which must be unverifiable rather than approved.
    const item = { current: [held('work-940', 'GY-940', 'alpha-principal', 2, { blocker: 'waiting on a decision', sessions: [implHandle('alpha-principal', 2, null)] })] };
    const listing: HerdrAgent[] = [{ name: sharedName, pane_id: 'w1:pForeign', agent_status: 'idle', agent: 'claude' }];
    const { log, effects } = harness(item, () => listing);
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    assert.equal(state.actions['resume:blocker:work-940:2']?.state, 'waiting', 'what the attempt waits on is marked');
    assert.deepEqual(log.targets, [], 'a worker waiting on its blocker is not prompted');

    // The blocker clears: the pane the name holds cannot be verified as this attempt's, so the
    // resolution is refused with its reason and pasted nowhere.
    item.current = [held('work-940', 'GY-940', 'alpha-principal', 2, { sessions: [implHandle('alpha-principal', 2, null)] })];
    await runCycle(master, state, effects, () => clock + 30_000);
    assert.deepEqual(log.targets, [], 'nothing is pasted into the pane the name happens to hold');
    const refused = Object.values(state.actions).find(action => action.state === 'failed'
      && /pane w1:pForeign cannot be verified as GY-940's session alpha-principal:2: its handle records no pane yet/.test(action.detail));
    assert.ok(refused, `the unverifiable resolution is refused on the record: ${JSON.stringify(Object.values(state.actions).map(action => action.detail))}`);

    // Once the launcher records this attempt's pane, the re-prompt is delivered there.
    item.current = [held('work-940', 'GY-940', 'alpha-principal', 2, { sessions: [implHandle('alpha-principal', 2, 'w1:pReal')] })];
    listing[0] = { name: sharedName, pane_id: 'w1:pReal', agent_status: 'idle', agent: 'claude' };
    await runCycle(master, state, effects, () => clock + 60_000);
    assert.deepEqual(log.targets, ['w1:pReal'], 'the re-prompt reaches the pane this attempt\'s own handle records');
    assert.match(String(log.capacity), /^$/, 'no attempt was ended: the session was reachable all along');

    // The recovery stands: the bound the unverifiable handle started was cancelled by the
    // delivery, so the attempt is never reclaimed for it afterwards.
    await runCycle(master, state, effects, () => clock + minutes(10));
    assert.equal(state.actions['resume:reclaim:work-940:2'], undefined, 'no reclaim was ever started for this attempt');
    assert.match(state.actions['idle:work-940:2']?.detail ?? '', /has shown no activity since this cycle/, 'only the ordinary idle marker stands, not the unverifiable bound');
    assert.match(String(log.capacity), /^$/, 'and the attempt stands');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('unit:gy940-unverifiable-handle-reclaim — a handle that never records a pane has its cleared wait reclaimed on a bounded path', async () => {
  const { directory, master } = await setup();
  try {
    // The attempt's handle exists but its coordinate write has failed for good: the name's
    // holder is listed every cycle, so the name-based absence recovery sees a live session,
    // and the refusal below would stand for ever without a bound.
    const item = { current: [held('work-940', 'GY-940', 'alpha-principal', 2, { blocker: 'waiting on a decision', sessions: [implHandle('alpha-principal', 2, null)] })] };
    const listing: HerdrAgent[] = [{ name: sharedName, pane_id: 'w1:pForeign', agent_status: 'idle', agent: 'claude' }];
    const { log, effects } = harness(item, () => listing);
    const state = emptyDaemonState(master);
    await runCycle(master, state, effects, () => clock);
    assert.equal(state.actions['resume:blocker:work-940:2']?.state, 'waiting', 'what the attempt waits on is marked');

    // The blocker clears: the resolution is refused — the name's holder cannot be verified as
    // this attempt's — and the first unverifiable observation only starts the reclaim bound.
    item.current = [held('work-940', 'GY-940', 'alpha-principal', 2, { sessions: [implHandle('alpha-principal', 2, null)] })];
    await runCycle(master, state, effects, () => clock + 30_000);
    assert.deepEqual(log.targets, [], 'nothing is pasted into the pane the name happens to hold');
    const refused = Object.values(state.actions).find(action => action.state === 'failed'
      && /pane w1:pForeign cannot be verified as GY-940's session alpha-principal:2: its handle records no pane yet/.test(action.detail));
    assert.ok(refused, `the unsafe paste is still refused on the record: ${JSON.stringify(Object.values(state.actions).map(action => action.detail))}`);
    assert.deepEqual(log.preserved, [], 'the first unverifiable observation does not end the attempt');
    const bound = state.actions['idle:work-940:2'];
    assert.equal(bound?.state, 'waiting', 'the unverifiable handle starts the reclaim bound');
    assert.match(bound.detail, /its handle alpha-principal:2 records no pane yet/);

    // Still unverifiable past the bound: the attempt is handed to a new one that keeps its
    // branch — the wait can never be delivered, and the lease no longer holds the item.
    await runCycle(master, state, effects, () => clock + minutes(5));
    assert.deepEqual(log.targets, [], 'nothing is ever pasted into the pane the name holds');
    assert.deepEqual(log.preserved, [2], 'the attempt keeps what it left, on its branch');
    assert.equal(log.capacity.length, 1, 'the bounded reclaim ends the attempt on the record');
    assert.equal(log.capacity[0].cause, 'interrupted');
    assert.match(String(log.capacity[0].reason), /its handle alpha-principal:2 has recorded no pane since .*, so the cleared wait cannot be verified deliverable to it, and its agent name is no address/);
    assert.deepEqual(log.closed, [], 'no pane is closed: none is verifiably this attempt\'s');
    const reclaim = state.actions['resume:reclaim:work-940:2'];
    assert.equal(reclaim?.state, 'done');
    assert.match(reclaim.detail, /keeping the attempt's branch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
