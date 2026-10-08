import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { dispatchWork, launchLeaseKeepAlive, masterConfigSchema, setupMaster, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, storeAction } from '../src/master-daemon.js';
import { launchHeldByLease, launchingSession, lostAfterReports, observeSessions } from '../src/model/session-state.js';
import type { SessionHandle } from '../src/model/sessions.js';
import type { Work } from '../src/model.js';
import { startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1287: four session-liveness faults in 24 hours on 5 October 2026 shared one cause — the
// launch window between a worker launch's lease claim and its watch supervisor's first heartbeat
// was kept alive by nothing. GY-717 epoch 49 was claimed at 09:24:12.858 and lapsed at exactly
// 09:26:12.858, never renewed; its supervisor met "Lease missing, expired, or superseded" at
// 09:27:20 (instance 1), the lapse stood as a lease-loss escalation (instance 3), and the retry
// under the advanced epoch counted as a second fault (instance 2). GY-1235's launch registered its
// session at 09:25:35 with no pane yet, and the session report closed it as lost while that launch
// went on to hold the lease (instance 4). Each is reproduced here as the base behaved and shown
// not to recur.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');
const lapsed = '{"error":"Lease missing, expired, or superseded; claim the task again"}';

function item(key: string, overrides: Partial<Work> = {}): Work {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return {
    id: `id-${key}`, key, title: key, description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides,
  } as Work;
}
const launchProfile = (name: string, credentialFile: string): WorkerProfile => ({ name, principal: `${name}-principal`, agentName: `agent-${name}`, mode: 'launch', kind: 'codex', credentialFile, agentArgs: [], approvals: 'auto', environment: {} });

async function installation() {
  const root = await temporaryDirectory('launch-window'); const credentials = await temporaryDirectory('launch-window-credentials');
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
  const credential = join(credentials, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: credentials }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  return { root, credential, cleanup: async () => { await rm(root, { recursive: true, force: true }); await rm(credentials, { recursive: true, force: true }); } };
}

/** The control plane's lease as the launch meets it: claimed for `leaseMs`, renewed only while live, released only while live. */
function leasedClaims(root: string, leaseMs: number) {
  let lease: { epoch: number; expiresAt: number } | null = null;
  const live = () => !!lease && lease.expiresAt > Date.now();
  const record = { renewals: 0, released: [] as string[], lapsed: false };
  const prepare = async (_root: string, key: string) => { lease = { epoch: 1, expiresAt: Date.now() + leaseMs }; return { epoch: 1, path: join(root, `assigned-${key}`), base: 'c'.repeat(40) }; };
  const renew = async () => { if (!live()) { record.lapsed = true; throw new Error(lapsed); } lease!.expiresAt = Date.now() + leaseMs; record.renewals++; };
  const release = async (_root: string, key: string, epoch: number) => { if (!live()) { record.lapsed = true; throw new Error(lapsed); } lease = null; record.released.push(`${key}@${epoch}`); };
  return { live, record, prepare, renew, release };
}

/** A Herdr on a busy host: opening the tab takes `slowMs`. The supervisor's first heartbeat runs as the command line reaches the pane. */
function slowHerdr(claims: ReturnType<typeof leasedClaims>, slowMs: number, exits = false) {
  const supervisor: boolean[] = [];
  const run = async (_command: string, args: string[]) => {
    const json = (result: unknown) => JSON.stringify({ result });
    if (args[0] === 'tab' && args[1] === 'create') { await sleep(slowMs); return json({ type: 'tab_created', root_pane: { pane_id: 'pane-1', tab_id: 'tab-1' }, tab: { tab_id: 'tab-1' } }); }
    if (args[0] === 'agent' && args[1] === 'list') return json({ agents: [] });
    if (args[0] === 'pane' && args[1] === 'run') {
      supervisor.push(claims.live());
      // The supervisor that meets a lapsed lease exits back to the shell, as GY-717 epoch 49's did.
      if (exits && !claims.live()) throw new Error(`the claude runtime exited back to the shell in pane pane-1 before it was ready; it last printed: "graphyard: establishing containment for GY-717 epoch 1 | ${lapsed}"`);
    }
    if (args[0] === 'pane' && args[1] === 'close') return json({});
    if (args[0] === 'pane' && args[1] === 'list') return json({ panes: [] });
    return startedAtOnce(args) ?? json({});
  };
  return { run, supervisor };
}

test('unit:launch-lease-keepalive — GY-717 instances 1 and 3: a launch slower than the lease keeps it alive until its supervisor takes over, so no lapse and no lease-loss', async () => {
  const fixture = await installation();
  try {
    const leaseMs = 150, slowMs = 500, profile = launchProfile('one', fixture.credential);
    // Base: nothing renews the lease between the claim and the supervisor, so a slow launch outlives it.
    const base = leasedClaims(fixture.root, leaseMs), baseHerdr = slowHerdr(base, slowMs, true);
    const failed = await dispatchWork(fixture.root, item('GY-717'), profile, [], baseHerdr.run, [item('GY-717')], base.prepare, base.release, 1, new Date().toISOString(), { supervisor: () => false }).then(() => null, error => error);
    assert.deepEqual(baseHerdr.supervisor, [false], 'without renewal the supervisor meets a lapsed lease (instance 1)');
    assert.ok(failed, 'and the launch fails');
    assert.equal(base.record.lapsed, true, 'the epoch lapsed unreleased: the lapse the control plane raises lease-loss for (instance 3)');
    // The release that meets a lease already gone hands nothing back: it no longer reads as a stranded epoch.
    assert.doesNotMatch(failed.message, /could not release epoch/);

    // Candidate: the launch renews its claim until the supervisor's first heartbeat.
    const kept = leasedClaims(fixture.root, leaseMs), keptHerdr = slowHerdr(kept, slowMs, true);
    await dispatchWork(fixture.root, item('GY-717'), launchProfile('two', fixture.credential), [], keptHerdr.run, [item('GY-717')], kept.prepare, kept.release, 1, new Date().toISOString(), { supervisor: () => false, renew: kept.renew, renewIntervalMs: 40 });
    assert.deepEqual(keptHerdr.supervisor, [true], 'the supervisor finds the lease it was launched under');
    assert.equal(kept.record.lapsed, false, 'the lease never lapsed, so no lease-loss is raised');
    assert.ok(kept.record.renewals >= 3, `the launch renewed it while it prepared (${kept.record.renewals})`);
    const after = kept.record.renewals; await sleep(150);
    assert.equal(kept.record.renewals, after, 'and stopped once the supervisor owned the session');

    // A launch that fails after the claim still releases a live epoch, so nothing is left to lapse.
    const released = leasedClaims(fixture.root, leaseMs), releasedHerdr = slowHerdr(released, slowMs, false);
    const refused = async (command: string, args: string[]) => { if (args[0] === 'pane' && args[1] === 'run') { await releasedHerdr.run(command, args); throw new Error('the runtime refused to start'); } return releasedHerdr.run(command, args); };
    await assert.rejects(dispatchWork(fixture.root, item('GY-718'), launchProfile('three', fixture.credential), [], refused, [item('GY-718')], released.prepare, released.release, 1, new Date().toISOString(), { supervisor: () => false, renew: released.renew, renewIntervalMs: 40 }), /refused to start/);
    assert.deepEqual(released.record.released, ['GY-718@1']);
    assert.equal(released.record.lapsed, false);
  } finally { await fixture.cleanup(); }
});

// GY-1373: the keep-alive started only once the worktree was built. On 6 October 2026 building
// GY-1373's worktree on a loaded host outlasted the 120 s lease, so every launch from epoch 1 met
// "Lease missing, expired, or superseded" minting its push credential and failed before any
// session started. The renewal now starts at the claim, while the worktree is still being built.
test('unit:launch-lease-keepalive — GY-1373: a worktree slower than the lease is built under a renewed claim, so the credential is minted on a live lease', async () => {
  const fixture = await installation();
  try {
    const leaseMs = 150, worktreeMs = 500;
    const slowWorktree = (claims: ReturnType<typeof leasedClaims>, reportsClaim: boolean) => async (root: string, key: string, profile: string, run?: unknown, claimBy?: number, onClaimed?: (epoch: number) => void) => {
      const prepared = await claims.prepare(root, key);
      if (reportsClaim) onClaimed?.(prepared.epoch);
      await sleep(worktreeMs);
      return prepared;
    };
    const mint = (claims: ReturnType<typeof leasedClaims>) => async () => { if (!claims.live()) throw new Error(`Worker launch failed: no push credential could be minted (${lapsed})`); };
    // Base: a preparer whose claim the launch does not hear of — renewal starts after the worktree, too late.
    const base = leasedClaims(fixture.root, leaseMs), baseHerdr = slowHerdr(base, 0);
    await assert.rejects(dispatchWork(fixture.root, item('GY-1373'), launchProfile('one', fixture.credential), [], baseHerdr.run, [item('GY-1373')], slowWorktree(base, false), base.release, 1, new Date().toISOString(), { supervisor: () => false, renew: base.renew, renewIntervalMs: 40, credential: mint(base) }), /Lease missing, expired, or superseded/);
    // Candidate: the claim is renewed from the moment it is held.
    const kept = leasedClaims(fixture.root, leaseMs), keptHerdr = slowHerdr(kept, 0);
    await dispatchWork(fixture.root, item('GY-1373'), launchProfile('two', fixture.credential), [], keptHerdr.run, [item('GY-1373')], slowWorktree(kept, true), kept.release, 1, new Date().toISOString(), { supervisor: () => false, renew: kept.renew, renewIntervalMs: 40, credential: mint(kept) });
    assert.equal(kept.record.lapsed, false, 'the lease never lapsed while the worktree was built');
    assert.ok(kept.record.renewals >= 5, `renewed while the worktree was built (${kept.record.renewals})`);
    assert.deepEqual(keptHerdr.supervisor, [true], 'and the supervisor finds the lease it was launched under');
  } finally { await fixture.cleanup(); }
});

test('unit:launch-lease-keepalive — the keep-alive renews at once and on its interval, survives a failed renewal, and lands nothing after it is stopped', async () => {
  let beats = 0, failing = true;
  const keepAlive = launchLeaseKeepAlive(async () => { beats++; if (failing) { failing = false; throw new Error('503'); } await sleep(20); }, 30);
  await sleep(100);
  const stopping = keepAlive.stop(); const at = beats; await stopping; await sleep(80);
  assert.ok(at >= 3, `renewed at once and again after a failure (${at})`);
  assert.equal(beats, at, 'nothing renews after stop');
  await launchLeaseKeepAlive(null).stop();
});

test('unit:dispatch-failure-run — GY-717 instance 2: an item\'s dispatch failures across the epochs its own failed claims advanced are one fault, and a success ends the run', () => {
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: '/outside/graphyard.mjs', repository: 'owner/project', baseBranch: 'main', githubAppId: 1, hostId: 'host-1', masterAgentName: 'm', workers: [] });
  const state = emptyDaemonState(config);
  const fail = (epoch: number, at: string, detail: string) => storeAction(state, `dispatch:id-717:${epoch}`, { kind: 'dispatch', work: 'GY-717', principal: 'graphyard-cursor-2', epoch, state: 'failed', detail, attempts: 1, cycle: 1, at });
  fail(48, '2026-10-05T09:27:21.599Z', `Dispatch of GY-717 to claude-quaternary failed: ${lapsed}`);
  // The failed launch's claim advanced the item to epoch 49, so the retry writes a new row.
  fail(49, '2026-10-05T09:27:55.918Z', 'Dispatch of GY-717 to claude-quaternary failed: The agent registry answered 503: Startup validation has not completed; retry shortly');
  assert.equal(state.faults.instances.filter(entry => entry.kind === 'action:dispatch').length, 1, 'one run of one item\'s dispatch is one instance (the base counted two)');
  assert.deepEqual(Object.keys(state.faults.failing), ['dispatch:id-717:49'], 'the run moved onto the current row');
  storeAction(state, 'dispatch:id-717:49', { kind: 'dispatch', work: 'GY-717', principal: 'graphyard-codex-1', epoch: 49, state: 'done', detail: 'Dispatched GY-717', attempts: 2, cycle: 2, at: '2026-10-05T09:29:59.596Z' });
  assert.deepEqual(state.faults.failing, {}, 'a success ends the run');
  fail(50, '2026-10-05T10:00:00.000Z', 'Dispatch of GY-717 failed again later');
  assert.equal(state.faults.instances.filter(entry => entry.kind === 'action:dispatch').length, 2, 'a failure after that success is a new instance');
  // Another item's run is its own.
  storeAction(state, 'dispatch:id-1235:0', { kind: 'dispatch', work: 'GY-1235', principal: 'p', epoch: 0, state: 'failed', detail: 'x', attempts: 1, cycle: 3, at: '2026-10-05T10:00:01.000Z' });
  assert.equal(state.faults.instances.filter(entry => entry.kind === 'action:dispatch').length, 3);
});

test('unit:launch-held-session — GY-1235 instance 4: a worker handle with no pane yet whose attempt holds its lease is a launch preparing, not a lost session', () => {
  const now = new Date('2026-10-05T09:29:36.650Z'), clock = now.getTime();
  // Registered at 09:25:35 with no pane or name; the launch claimed epoch 1 at 09:25:57 and kept its lease.
  const handle: SessionHandle = { id: 'graphyard-cursor-1:1', kind: 'implementation', principal: 'graphyard-cursor-1', runtime: 'cursor', host: 'vishrog', workspace: 'w1V', tab: null,
    pane: null, agentName: null, role: null, head: null, attach: null, transcript: null, subject: 'GY-1235: s', startedAt: '2026-10-05T09:25:35.024Z', updatedAt: '2026-10-05T09:25:35.024Z', endedAt: null,
    state: 'running', outcome: null } as unknown as SessionHandle;
  const leased = { epoch: 1, owner: 'graphyard-cursor-1', expiresAt: new Date(clock + 90_000).toISOString() };
  const work = (lease: Work['lease'], sessions = [handle]) => [{ id: 'w', key: 'GY-1235', lease, sessions } as unknown as Work];
  const twice = (all: Work[]) => {
    const first = observeSessions(all, [], new Date(clock - 40_000), { hostId: 'vishrog' });
    const missed = first.entries.map(entry => ({ ...entry }));
    const withMiss = all.map(entry => ({ ...entry, sessions: entry.sessions!.map(session => ({ ...session, missedReports: missed.find(row => row.id === session.id)?.missedReports ?? 0 })) })) as Work[];
    return observeSessions(withMiss, [], now, { hostId: 'vishrog', firstMissed: first.missing });
  };
  // Base: with nothing holding it, the handle was past the launch grace and two reports closed it as
  // lost. Since GY-1532 the item's own fact ends it instead, on the first report: an implementation
  // handle whose attempt holds no lease is over, so it is ended with that reason rather than lost.
  const over = observeSessions(work(null), [], new Date(clock - 40_000), { hostId: 'vishrog' });
  assert.equal(over.entries[0]?.closed, 'ended', 'the base closed GY-1235\'s handle as lost; its attempt holding no lease now ends it');
  assert.match(over.entries[0]!.outcome!, /no longer reports session graphyard-cursor-1:1 \(registered with no pane or name to match\): attempt 1 of GY-1235 ended \(released, blocked, parked or lapsed\) and GY-1235 holds no lease, so the session is over$/);
  assert.equal(lostAfterReports, 2);
  // A handle its live lease does not hold — it has a pane the runtime never lists — is missed and held
  // (GY-1532): counted, not shown running, and ended by its attempt's end rather than lost.
  const unlisted = twice(work(leased, [{ ...handle, pane: 'w1V:p1' }])).entries[0];
  assert.deepEqual([unlisted?.missedReports, unlisted?.closed], [lostAfterReports, null], 'a live attempt whose pane stays unlisted is held, never lost');
  // Candidate: the attempt's live lease under the handle's principal and epoch holds it open.
  assert.deepEqual(twice(work(leased)).entries, [], 'a launch held by its lease is not missed');
  assert.equal(launchHeldByLease({ lease: leased }, handle, clock), true);
  assert.equal(launchingSession({ lease: leased }, handle, clock), true, 'master status reads it as launching, not lost or unseen');
  // Anything else is still missed and lost: an expired lease, another principal's or epoch's, a handle with a pane or one already observed.
  for (const [lease, other] of [
    [{ ...leased, expiresAt: new Date(clock - 1).toISOString() }, handle],
    [{ ...leased, owner: 'someone-else' }, handle],
    [{ ...leased, epoch: 2 }, handle],
    [leased, { ...handle, pane: 'w1V:p1' }],
    [leased, { ...handle, observed: 'working' }],
  ] as [Work['lease'], SessionHandle][]) assert.equal(launchHeldByLease({ lease }, other, clock), false, JSON.stringify({ lease, pane: other.pane, observed: other.observed }));
  // Once the lease has lapsed the attempt is over (GY-1532): the first report ends the handle with the lapse, where the base lost it after two.
  const lapsed = observeSessions(work({ ...leased, expiresAt: new Date(clock - 60_000).toISOString() }), [], now, { hostId: 'vishrog' });
  assert.equal(lapsed.entries[0]?.closed, 'ended', 'once the lease is gone the handle is ended with the lapse');
  assert.match(lapsed.entries[0]!.outcome!, /attempt 1 of GY-1235 ended with its lease expired at 2026-10-05T09:28:36\.650Z, so the session is over$/);
});
