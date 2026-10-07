import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import { emptyDaemonState, type DaemonState } from '../src/master-daemon.js';
import { performSelfUpgrade, type SelfUpgradeDeps } from '../src/daemon/upgrade.js';
import { coordinatorCheckoutGuard } from '../src/daemon/run.js';
import { owedUpgrade, readResources, resourceAttention, type ResourceInputs } from '../src/master-resources.js';
import type { ExecutorRestartResult } from '../src/executor-fleet.js';

/**
 * GY-1445: the between-cycles self-upgrade waited on a verified production deployment, so with the
 * production observation null it skipped every pass — even the restart it already owed — and the
 * loaded-revision resource pinned at its bound (the 2026-10-07T09:28:59Z fault: loaded
 * 2cca02cd2424, checkout 02ba2078f1ce, 81 commits behind). Fake git and a fake supervisor here; each
 * test is named for the proof it produces: integration:self-upgrade-fires-without-verified-deployment,
 * unit:loaded-revision-names-last-restart-attempt and unit:loaded-revision-exception-rules.
 */

const full = (prefix: string) => prefix.padEnd(40, '0');
const loaded = full('2cca02cd2424'), checkout = full('02ba2078f1ce'), tip = full('10e715db6551');
const faultAt = Date.parse('2026-10-07T09:28:59.761Z');
const minute = 60_000, hour = 60 * minute;
const iso = (at: number) => new Date(at).toISOString();

const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/nonexistent/coordinator.token', cliPath: '/nonexistent/bin/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });

/** A clean, detached coordinator checkout at `head`; a fetch finds `originTip` on the base branch. */
class FakeGit {
  dirty = '';
  checkouts: string[] = [];
  fetches = 0;
  constructor(public head: string, public originTip: string, public diffPaths = ['src/daemon/run.ts']) {}
  run = async (command: string, args: string[]): Promise<string> => {
    assert.equal(command, 'git');
    const [op, ...operands] = args.slice(2);
    if (op === 'rev-parse') return `${operands[0] === 'HEAD' ? this.head : this.originTip}\n`;
    if (op === 'symbolic-ref') throw Object.assign(new Error('fatal: not a symbolic ref'), { status: 1 });
    if (op === 'status') return this.dirty;
    if (op === 'fetch') { this.fetches += 1; return ''; }
    if (op === 'diff') return `${this.diffPaths.join('\n')}\n`;
    if (op === 'checkout') { this.head = operands[2]; this.checkouts.push(operands[2]); return ''; }
    throw new Error(`fake git cannot answer: git ${args.slice(2).join(' ')}`);
  };
}

const refusedExecutors = (to: string): ExecutorRestartResult => ({ result: 'refused', reason: 'Restart refused while an executor on host-a holds a claimed action: graphyard-master@host-a/3 holds dispatch for GY-1439', coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] });
const restartedExecutors = (to: string): ExecutorRestartResult => ({ result: 'restarted', reason: null, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] });

/** The fault's cursor: the loop runs 2cca02cd2424, production is unobserved, and the restart owed onto the checkout was last attempted two hours ago. */
function faultState(options: { owed?: boolean } = {}): DaemonState {
  const state = emptyDaemonState(master);
  state.release = { commit: loaded, dirty: false };
  state.deployment = null;
  if (options.owed !== false) {
    state.upgrade.pending = { from: loaded, to: checkout, code: true };
    state.actions[`upgrade:${loaded}`] = { kind: 'config', work: null, principal: null, state: 'waiting', detail: 'the executors were not restarted', attempts: 3, epoch: null, cycle: 1, at: iso(faultAt - 2 * hour) };
  }
  return state;
}

const loadedRevision = (state: DaemonState, revision: NonNullable<ResourceInputs['revision']>, now: number) => readResources({ now, reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, disk: null,
  profiles: { workers: [], reviewers: [], producers: [] }, revision, upgrade: owedUpgrade(state) }).find(reading => reading.id === 'loaded-revision')!;

function deps(fake: FakeGit, clock: { now: number }, fleet: { held: boolean; self: number; executors: string[]; selfFails?: string | null }): SelfUpgradeDeps {
  return {
    root: '/coordinator', run: fake.run, now: () => clock.now,
    restartExecutors: async to => { fleet.executors.push(to); return fleet.held ? refusedExecutors(to) : restartedExecutors(to); },
    restartSelf: async () => { if (fleet.selfFails) throw new Error(fleet.selfFails); fleet.self += 1; },
  };
}

test('integration:self-upgrade-fires-without-verified-deployment — with production null and every executor holding a claim, the loop aligns its checkout with the base tip and attempts the owed restart each cycle within the bound, and the loaded-revision resource returns to headroom', async () => {
  const state = faultState(), fake = new FakeGit(checkout, tip), clock = { now: faultAt };
  const fleet = { held: true, self: 0, executors: [] as string[] };
  const guard = coordinatorCheckoutGuard({
    state: () => state, read: async () => ({ root: '/coordinator', commit: fake.head, modified: [], untracked: [] }),
    agents: async () => [], snapshot: async () => ({ work: [] as Work[], now: iso(clock.now) }), persist: async () => {}, now: () => clock.now, log: () => {}, applies: () => true,
  });
  // The loop aligned the checkout itself before production went unobserved: HEAD is what it expects.
  assert.equal(await guard.start(loaded), null);

  // The fault as it stood: owed, unattempted for two hours, pinned at the bound.
  const moved = faultAt - 3 * hour;
  const before = loadedRevision(state, { behind: 81, loaded, checkout, movedAt: moved }, clock.now);
  assert.equal(before.used, 81, 'the fault pins the resource at 81 commits behind');

  // Cycle 1: no verified deployment, yet the pass runs: the checkout moves to the base tip and the
  // owed restart is attempted, refused on the held claims, and recorded.
  const upgrade = (current: DaemonState) => performSelfUpgrade(master, current, deps(fake, clock, fleet));
  const first = await guard.betweenCycles(upgrade);
  assert.equal(first.refusal, null);
  assert.equal(first.upgraded?.outcome, 'pending', 'the owed restart waits on the claims, it is not skipped');
  assert.deepEqual(fake.checkouts, [tip], 'the checkout is aligned with the base tip');
  assert.deepEqual(fleet.executors, [tip], 'the executor restart was attempted against the tip');
  assert.deepEqual(state.upgrade.pending, { from: checkout, to: tip, code: true });
  assert.equal(state.actions['upgrade:none']?.state, 'waiting');
  assert.equal(state.actions['upgrade:none']?.at, iso(faultAt), 'the attempt is recorded at this cycle');
  assert.equal(guard.expected(), tip, 'the loop\'s own move is never drift');
  let reading = loadedRevision(state, { behind: 85, loaded, checkout: tip, movedAt: moved }, clock.now);
  assert.equal(reading.used, 0, 'the restart attempted within the bound returns the resource to headroom');
  assert.match(reading.detail!, /owed restart onto it is under way, last attempted 2026-10-07T09:28:59\.761Z/);
  assert.deepEqual(resourceAttention([reading]), []);

  // Cycles 2 and 3, ten minutes apart: the claims still hold, every pass retries and records it.
  for (const step of [1, 2]) {
    clock.now = faultAt + step * 10 * minute;
    assert.equal((await guard.betweenCycles(upgrade)).upgraded?.outcome, 'pending');
    assert.equal(state.actions['upgrade:none']?.at, iso(clock.now));
    reading = loadedRevision(state, { behind: 85, loaded, checkout: tip, movedAt: moved }, clock.now);
    assert.equal(reading.used, 0, `cycle ${step + 1} stays within headroom`);
  }
  assert.equal(fleet.self, 0, 'the loop re-executes last, once the fleet is restarted');

  // The claims settle 25 minutes in, inside the 30-minute bound: the fleet restarts and the loop re-executes.
  fleet.held = false;
  clock.now = faultAt + 25 * minute;
  const done = await guard.betweenCycles(upgrade);
  assert.equal(done.upgraded?.outcome, 'upgraded');
  assert.equal(fleet.self, 1, 'the loop restart was attempted within the bound');
  assert.equal(state.upgrade.pending, null);
  assert.deepEqual({ to: state.upgrade.last?.to, self: state.upgrade.last?.self }, { to: tip, self: true });
  assert.equal(state.upgrade.alignedRelease, null, 'no verified release was aligned: none was observed');
  assert.equal(state.upgrade.stalled, undefined);
  // The process the supervisor starts loads the tip: nothing is behind.
  assert.equal(loadedRevision(state, { behind: 0, loaded: tip, checkout: tip }, clock.now).used, 0);

  // No restart on the cursor, but the checkout already holds the base tip the loop never loaded:
  // the pass owes the restart from what the loop loaded, and attempts it.
  const unowed = faultState({ owed: false }), still = new FakeGit(checkout, checkout), quiet = { held: false, self: 0, executors: [] as string[] };
  const upgraded = await performSelfUpgrade(master, unowed, deps(still, { now: faultAt }, quiet));
  assert.equal(upgraded.outcome, 'upgraded');
  assert.deepEqual(quiet.executors, [checkout]);
  assert.equal(quiet.self, 1);
  assert.deepEqual(still.checkouts, [], 'a checkout already at the tip is not checked out again');

  // A checkout holding exactly what the loop loaded is idle: production null still skips it, with no fetch.
  const idle = faultState({ owed: false }), current = new FakeGit(loaded, tip);
  assert.deepEqual(await performSelfUpgrade(master, idle, deps(current, { now: faultAt }, { held: false, self: 0, executors: [] })), { outcome: 'skipped', reason: 'no delivered item is verified deployed yet' });
  assert.deepEqual(current.checkouts, []);

  // A verified docs-only deploy moved the checkout past the loaded commit without a restart, then
  // production went unobserved: the gap holds no loaded code, so the pass that already processed it
  // leaves it idle — no fetch, no diff, no cursor write on any later cycle.
  const docs = faultState({ owed: false }), page = new FakeGit(loaded, checkout, ['docs/master-agent-reference.md']), calm = { held: false, self: 0, executors: [] as string[] };
  docs.deployment = { source: 'endpoint', sha: checkout, at: iso(faultAt), reason: null, deployed: ['GY-1436'], pending: [] };
  let writes = 0;
  const docsDeps = { ...deps(page, clock, calm), persist: async () => { writes += 1; } };
  const verified = await performSelfUpgrade(master, docs, docsDeps);
  assert.deepEqual(verified, { outcome: 'upgraded', from: loaded, to: checkout, code: false, executors: null, self: false });
  assert.equal(docs.release?.commit, loaded, 'a docs-only move restarts nothing, so the loaded commit stays behind the checkout');
  docs.deployment = null;
  const [fetched, persisted, recorded] = [page.fetches, writes, docs.upgrade.last];
  for (const step of [1, 2, 3]) {
    clock.now = faultAt + 30 * minute + step * 10 * minute;
    assert.deepEqual(await performSelfUpgrade(master, docs, docsDeps), { outcome: 'skipped', reason: 'no delivered item is verified deployed yet' }, `cycle ${step} is idle`);
  }
  assert.deepEqual({ fetches: page.fetches, writes, last: docs.upgrade.last }, { fetches: fetched, writes: persisted, last: recorded }, 'the docs-only gap is processed once, then stays idle');
  assert.deepEqual({ executors: calm.executors, self: calm.self }, { executors: [], self: 0 });

  // The same docs-only gap first met unverified: one pass processes it without restarting anything, then it stays idle.
  const fresh = faultState({ owed: false }), gap = new FakeGit(checkout, checkout, ['docs/master-agent-reference.md']);
  const once = await performSelfUpgrade(master, fresh, deps(gap, clock, calm));
  assert.equal(once.outcome, 'upgraded');
  assert.equal(gap.fetches, 1);
  for (const step of [1, 2]) assert.equal((await performSelfUpgrade(master, fresh, deps(gap, clock, calm))).outcome, 'skipped', `unverified cycle ${step} is idle`);
  assert.equal(gap.fetches, 1, 'no fetch repeats per cycle');
  // A later move onto code the loop never loaded is new work again.
  gap.head = tip; gap.originTip = tip; gap.diffPaths = ['src/daemon/run.ts'];
  assert.equal((await performSelfUpgrade(master, fresh, deps(gap, clock, calm))).outcome, 'upgraded');
  assert.equal(calm.self, 1);
});

test('unit:loaded-revision-names-last-restart-attempt — a restart owed that cannot complete records one named stall with its cause and latest attempt, shown beside the loaded and checkout revisions, and a later successful attempt retires it', async () => {
  const state = faultState({ owed: false }), fake = new FakeGit(checkout, checkout), clock = { now: faultAt };
  const fleet = { held: false, self: 0, executors: [] as string[], selfFails: 'systemctl --user restart graphyard-master.service: Failed to connect to bus: No medium found' as string | null };
  const revision = { behind: 81, loaded, checkout, movedAt: faultAt - 3 * hour };

  // The supervisor unit is unreachable: the restart fails and the cause is named.
  const failed = await performSelfUpgrade(master, state, deps(fake, clock, fleet));
  assert.equal(failed.outcome, 'failed');
  assert.deepEqual(state.upgrade.stalled, { cause: 'supervisor-unreachable', reason: 'the loop could not re-execute itself through its supervisor: systemctl --user restart graphyard-master.service: Failed to connect to bus: No medium found', since: iso(faultAt), at: iso(faultAt) });
  let reading = loadedRevision(state, revision, clock.now);
  assert.equal(reading.used, 81, 'a restart that cannot complete still counts');
  assert.match(reading.detail!, /^the loop loaded 2cca02cd2424; the checkout is at 02ba2078f1ce; the self-upgrade's restart is stalled on supervisor-unreachable since 2026-10-07T09:28:59\.761Z, last attempted 2026-10-07T09:28:59\.761Z: .*Failed to connect to bus/);
  const [attention] = resourceAttention([reading]);
  assert.match(attention.text, /stalled on supervisor-unreachable/, 'the attention master status shows names the cause');

  // The next cycle retries: one stall, the same since, a later attempt.
  clock.now = faultAt + 5 * minute;
  assert.equal((await performSelfUpgrade(master, state, deps(fake, clock, fleet))).outcome, 'failed');
  assert.deepEqual({ since: state.upgrade.stalled?.since, at: state.upgrade.stalled?.at }, { since: iso(faultAt), at: iso(clock.now) });
  assert.match(loadedRevision(state, revision, clock.now).detail!, /since 2026-10-07T09:28:59\.761Z, last attempted 2026-10-07T09:33:59\.761Z/);

  // A dirty checkout is a different cause: the stall is renamed and starts again.
  fake.originTip = tip;
  fake.dirty = ' M src/daemon/run.ts\n';
  clock.now = faultAt + 10 * minute;
  assert.equal((await performSelfUpgrade(master, state, deps(fake, clock, fleet))).outcome, 'refused');
  assert.deepEqual({ cause: state.upgrade.stalled?.cause, since: state.upgrade.stalled?.since }, { cause: 'checkout-dirty', since: iso(clock.now) });
  assert.match(loadedRevision(state, revision, clock.now).detail!, /stalled on checkout-dirty/);

  // Executors refused on held claims: the stall names the claim, and the retry keeps it within headroom.
  fake.dirty = '';
  fleet.held = true;
  clock.now = faultAt + 15 * minute;
  assert.equal((await performSelfUpgrade(master, state, deps(fake, clock, fleet))).outcome, 'pending');
  assert.equal(state.upgrade.stalled?.cause, 'executors-refused');
  reading = loadedRevision(state, { ...revision, checkout: tip }, clock.now);
  assert.equal(reading.used, 0);
  assert.match(reading.detail!, /under way.*stalled on executors-refused .*holds dispatch for GY-1439/);

  // A loop built with no executor restart at all is not refused by anyone: the cause says it is unavailable.
  const bare = faultState({ owed: false }), bareGit = new FakeGit(checkout, checkout);
  const { restartExecutors: _omitted, ...withoutExecutors } = deps(bareGit, clock, fleet);
  assert.equal((await performSelfUpgrade(master, bare, withoutExecutors)).outcome, 'failed');
  assert.equal(bare.upgrade.stalled?.cause, 'executors-unavailable');

  // A later attempt that completes retires the stall, and the detail names none.
  fleet.held = false;
  fleet.selfFails = null;
  clock.now = faultAt + 20 * minute;
  assert.equal((await performSelfUpgrade(master, state, deps(fake, clock, fleet))).outcome, 'upgraded');
  assert.equal(state.upgrade.stalled, undefined, 'the stall is retired');
  assert.equal(owedUpgrade(state), null, 'nothing is owed or stalled');
  assert.doesNotMatch(loadedRevision(state, { ...revision, checkout: tip }, clock.now).detail!, /stalled/);
});

test('unit:loaded-revision-exception-rules — the promotion grace counts nothing only for a loop running the release production verifiably serves, and the owed-restart exception holds only for an attempt within the bound', () => {
  const revision = { behind: 81, loaded, checkout, movedAt: faultAt - 3 * hour };
  const now = faultAt;
  const cursor = (overrides: Record<string, unknown>) => ({ upgrade: { alignedRelease: loaded, pending: null }, actions: {}, ...overrides }) as Parameters<typeof owedUpgrade>[0];
  const reading = (upgrade: ResourceInputs['upgrade']) => readResources({ now, reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, disk: null,
    profiles: { workers: [], reviewers: [], producers: [] }, revision, upgrade }).find(entry => entry.id === 'loaded-revision')!;

  // Branch 1, the promotion grace: the loop loaded the release production verifiably serves, and
  // what it has not loaded waits on a promotion not yet due — nothing counts.
  const serving = cursor({ deployment: { source: 'endpoint', sha: loaded, pending: ['GY-1436', 'GY-1437'] }, promotion: { nextDueAt: iso(now + 30 * minute), inFlight: false } });
  const graced = reading(owedUpgrade(serving));
  assert.equal(graced.used, 0);
  assert.match(graced.detail!, /runs the verified release production serves, and GY-1436, GY-1437 wait on the promotion due/);
  // The promotion overdue with nothing in validation, or production serving another release: it counts.
  assert.equal(reading(owedUpgrade(cursor({ deployment: { source: 'endpoint', sha: loaded, pending: ['GY-1436'] }, promotion: { nextDueAt: iso(now - minute), inFlight: false } }))).used, 81);
  assert.equal(reading(owedUpgrade(cursor({ deployment: { source: 'endpoint', sha: tip, pending: ['GY-1436'] }, promotion: { nextDueAt: iso(now + 30 * minute), inFlight: false } }))).used, 81);
  // The fault's shape: production null (or unavailable) proves no served release, so no grace.
  for (const deployment of [null, { source: 'unavailable', sha: null, pending: ['GY-1436'] }]) {
    const unproven = reading(owedUpgrade(cursor({ deployment, promotion: { nextDueAt: iso(now + 30 * minute), inFlight: true } })));
    assert.equal(unproven.used, 81, 'a loop that cannot prove it serves the verified release gets no promotion grace');
  }

  // Branch 2, the owed restart: production null, a restart owed onto this checkout, attempted within the bound — nothing counts.
  const owed = (attemptedAt: number, to = checkout) => cursor({ deployment: null, upgrade: { alignedRelease: null, pending: { from: loaded, to, code: true } }, actions: { 'upgrade:none': { at: iso(attemptedAt) } } });
  const retrying = reading(owedUpgrade(owed(now - 5 * minute)));
  assert.equal(retrying.used, 0);
  assert.match(retrying.detail!, /owed restart onto it is under way, last attempted 2026-10-07T09:23:59\.761Z and retried each cycle until 2026-10-07T09:53:59\.761Z/);
  // Attempted past the bound, owed onto another revision, or owed for no loaded code: it counts.
  const lapsed = reading(owedUpgrade(owed(now - 31 * minute)));
  assert.equal(lapsed.used, 81);
  assert.match(lapsed.detail!, /owes a restart onto it, last attempted 2026-10-07T08:57:59\.761Z/);
  assert.equal(reading(owedUpgrade(owed(now - 5 * minute, tip))).used, 81);
  assert.equal(reading({ from: loaded, to: checkout, code: false, attemptedAt: now - 5 * minute }).used, 81);
  // Nothing owed and nothing proven: the fault reads exactly as it did, 81 commits behind.
  assert.equal(reading(owedUpgrade(cursor({ deployment: null }))).used, 81);
});
