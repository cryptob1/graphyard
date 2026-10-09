import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import { emptyDaemonState, type DaemonState } from '../src/master-daemon.js';
import { performSelfUpgrade, upgradeTouchesCode, type SelfUpgradeDeps } from '../src/daemon/upgrade.js';
import { coordinatorCheckoutGuard } from '../src/daemon/run.js';
import { loadedRevision as revisionOf, owedUpgrade, selfUpgradeBoundMs, readResources, resourceAttention, type ResourceInputs } from '../src/master-resources.js';
import type { ExecutorRestartResult } from '../src/executor-fleet.js';

/**
 * GY-1445: the between-cycles self-upgrade waited on a verified production deployment, so with the
 * production observation null it skipped every pass — even the restart it already owed — and the
 * loaded-revision resource pinned at its bound (the 2026-10-07T09:28:59Z fault: loaded
 * 2cca02cd2424, checkout 02ba2078f1ce, 81 commits behind). Fake git and a fake supervisor here; each
 * test is named for the proof it produces: integration:self-upgrade-fires-without-verified-deployment,
 * unit:loaded-revision-names-last-restart-attempt and unit:loaded-revision-exception-rules.
 *
 * GY-1473: the GY-1469 instances (loaded 6d7d82f95808, checkout b59c79735ee2, 45 commits behind,
 * refiring from 16:18 to 19:06Z on 2026-10-07): the restart onto the checkout must not wait on the
 * fleet. integration:self-upgrade-restarts-without-claim, integration:self-upgrade-with-claim-loads
 * and unit:loaded-revision-fault-clears.
 */

const full = (prefix: string) => prefix.padEnd(40, '0');
const loaded = full('2cca02cd2424'), checkout = full('02ba2078f1ce'), tip = full('10e715db6551');
const faultAt = Date.parse('2026-10-07T09:28:59.761Z');
const minute = 60_000, hour = 60 * minute;
const iso = (at: number) => new Date(at).toISOString();
/** Where a failure before any restart attempt is recorded (`alignKey` in src/daemon/upgrade.ts). */
const alignKey = 'upgrade:align';

const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/nonexistent/coordinator.token', cliPath: '/nonexistent/bin/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });

/** A clean, detached coordinator checkout at `head`; a fetch finds `originTip` on the base branch. */
class FakeGit {
  dirty = '';
  checkouts: string[] = [];
  fetches = 0;
  /** While set, every fetch fails with it: origin unreachable. */
  fetchFails: string | null = null;
  ancestryReads = 0;
  constructor(public head: string, public originTip: string, public diffPaths = ['src/daemon/run.ts']) {}
  run = async (command: string, args: string[]): Promise<string> => {
    assert.equal(command, 'git');
    const [op, ...operands] = args.slice(2);
    if (op === 'rev-parse') return `${operands[0] === 'HEAD' ? this.head : this.originTip}\n`;
    if (op === 'symbolic-ref') throw Object.assign(new Error('fatal: not a symbolic ref'), { status: 1 });
    if (op === 'status') return this.dirty;
    if (op === 'fetch') { this.fetches += 1; if (this.fetchFails) throw new Error(this.fetchFails); return ''; }
    if (op === 'diff') return `${this.diffPaths.join('\n')}\n`;
    if (op === 'checkout') { this.head = operands[2]; this.checkouts.push(operands[2]); return ''; }
    // GY-1585: every ancestry read answers "not contained", so only an observed plane could hold a restart.
    if (op === 'merge-base') { this.ancestryReads += 1; throw Object.assign(new Error('not an ancestor'), { status: 1 }); }
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

/** `reload`: the cursor the process the supervisor starts records its load on, the checkout's HEAD; omitted, the re-execution loads nothing. */
function deps(fake: FakeGit, clock: { now: number }, fleet: { held: boolean; self: number; executors: string[]; selfFails?: string | null }, reload?: DaemonState): SelfUpgradeDeps {
  return {
    root: '/coordinator', run: fake.run, now: () => clock.now,
    restartExecutors: async to => { fleet.executors.push(to); return fleet.held ? refusedExecutors(to) : restartedExecutors(to); },
    restartSelf: async () => { if (fleet.selfFails) throw new Error(fleet.selfFails); fleet.self += 1; if (reload) reload.release = { commit: fake.head, dirty: false }; },
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
  const upgrade = (current: DaemonState) => performSelfUpgrade(master, current, deps(fake, clock, fleet, current));
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

  // Cycle 2, ten minutes in: the claims still hold, the pass retries and records it, and the loop
  // still waits on the fleet (GY-1473: for fifteen minutes of refusal at most).
  clock.now = faultAt + 10 * minute;
  assert.equal((await guard.betweenCycles(upgrade)).upgraded?.outcome, 'pending');
  assert.equal(state.actions['upgrade:none']?.at, iso(clock.now));
  reading = loadedRevision(state, { behind: 85, loaded, checkout: tip, movedAt: moved }, clock.now);
  assert.equal(reading.used, 0, 'cycle 2 stays within headroom');
  assert.equal(fleet.self, 0, 'the loop waits on the fleet first');

  // Cycle 3, twenty minutes in: the claims still hold, so the loop re-executes onto the tip by itself;
  // the executor restart stays owed on the cursor.
  clock.now = faultAt + 20 * minute;
  const alone = (await guard.betweenCycles(upgrade)).upgraded;
  assert.deepEqual({ outcome: alone?.outcome, self: alone?.outcome === 'pending' && alone.self }, { outcome: 'pending', self: true });
  assert.equal(fleet.self, 1, 'the loop restart completed within the bound with the claims still held');
  assert.equal(state.release?.commit, tip, 'the process the supervisor starts loads the tip');
  assert.deepEqual(state.upgrade.pending, { from: checkout, to: tip, code: true }, 'the executor restart stays owed');
  assert.equal(loadedRevision(state, { behind: 0, loaded: tip, checkout: tip }, clock.now).used, 0);

  // The claims settle 25 minutes in: the fleet restarts, and the loop, already on the tip, does not re-execute again.
  fleet.held = false;
  clock.now = faultAt + 25 * minute;
  const done = await guard.betweenCycles(upgrade);
  assert.equal(done.upgraded?.outcome, 'upgraded');
  assert.equal(fleet.self, 1, 'one loop restart in all');
  assert.equal(state.upgrade.pending, null);
  assert.deepEqual({ to: state.upgrade.last?.to, self: state.upgrade.last?.self }, { to: tip, self: false });
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

test('unit:loaded-revision-fetch-failure-is-no-restart-attempt — an origin outage never refreshes the owed restart\'s attempt clock: a restart owed onto the commit the checkout holds is still attempted, and one that cannot be attempted counts once the bound passes', async () => {
  const revision = { behind: 81, loaded, checkout, movedAt: faultAt - 3 * hour };

  // Owed onto the commit the checkout holds: every failing fetch still attempts the restart, and it completes when the claims settle.
  const state = faultState(), fake = new FakeGit(checkout, tip), clock = { now: faultAt };
  const fleet = { held: true, self: 0, executors: [] as string[] };
  fake.fetchFails = 'fatal: unable to access \'https://github.com/owner/project/\': Could not resolve host: github.com';
  for (let step = 0; step < 4; step++) {
    clock.now = faultAt + step * 10 * minute;
    assert.equal((await performSelfUpgrade(master, state, deps(fake, clock, fleet, state))).outcome, 'pending', `cycle ${step + 1} attempts the restart`);
    assert.equal(state.actions['upgrade:none']?.at, iso(clock.now), 'the attempt is the restart\'s');
    assert.equal(loadedRevision(state, revision, clock.now).used, 0);
  }
  assert.equal(fleet.executors.length, 4, 'every cycle of the outage attempted the executor restart');
  assert.equal(state.upgrade.stalled?.cause, 'executors-refused', 'the stall names what holds the restart, not the outage');
  assert.equal(state.actions[alignKey], undefined);
  fleet.held = false;
  clock.now = faultAt + 40 * minute;
  assert.equal((await performSelfUpgrade(master, state, deps(fake, clock, fleet))).outcome, 'upgraded', 'the restart completes with origin still unreachable');
  assert.equal(fleet.self, 1);
  assert.deepEqual(fake.checkouts, [], 'nothing was checked out without a fetch');

  // Owed onto a commit the checkout does not hold: no restart can be attempted, so the outage is
  // recorded apart from the release's attempts, and once the bound passes the resource counts.
  const stranded = faultState(), away = new FakeGit(checkout, tip), held = { held: false, self: 0, executors: [] as string[] };
  stranded.upgrade.pending = { from: loaded, to: tip, code: true };
  stranded.actions['upgrade:none'] = { ...stranded.actions[`upgrade:${loaded}`] };
  delete stranded.actions[`upgrade:${loaded}`];
  const attempted = faultAt - 5 * minute;
  stranded.actions['upgrade:none'].at = iso(attempted);
  away.fetchFails = fake.fetchFails;
  const strandedRevision = { ...revision, checkout: tip };
  for (let step = 0; step < 5; step++) {
    clock.now = faultAt + step * 10 * minute;
    const outcome = await performSelfUpgrade(master, stranded, deps(away, clock, held));
    assert.equal(outcome.outcome, 'failed');
    assert.match(outcome.outcome === 'failed' ? outcome.reason : '', /base branch could not be fetched/);
  }
  assert.deepEqual(held.executors, [], 'no restart was attempted');
  assert.equal(stranded.actions['upgrade:none']?.at, iso(attempted), 'the release\'s attempt clock never moved');
  assert.deepEqual({ state: stranded.actions[alignKey]?.state, attempts: stranded.actions[alignKey]?.attempts }, { state: 'failed', attempts: 5 });
  assert.deepEqual({ cause: stranded.upgrade.stalled?.cause, since: stranded.upgrade.stalled?.since, at: stranded.upgrade.stalled?.at }, { cause: 'fetch-failed', since: iso(faultAt), at: iso(clock.now) });
  const counted = loadedRevision(stranded, strandedRevision, clock.now);
  assert.equal(counted.used, 81, 'forty minutes of failing fetches past the last attempt: the commits behind count');
  assert.match(counted.detail!, /owes a restart onto it, last attempted 2026-10-07T09:23:59\.761Z.*stalled on fetch-failed since 2026-10-07T09:28:59\.761Z/);
  assert.match(resourceAttention([counted])[0].text, /stalled on fetch-failed/);
});

test('unit:self-upgrade-observed-production-keeps-promotion-wait — production observed serving none of the awaited deliveries is not unverified: while the loop runs the release production serves and the promotion is on schedule, the checkout ahead of the loop waits on it, with no fetch and no restart', async () => {
  const state = faultState({ owed: false }), fake = new FakeGit(checkout, tip), fleet = { held: false, self: 0, executors: [] as string[] };
  state.deployment = { source: 'endpoint', sha: loaded, at: iso(faultAt), reason: null, deployed: [], pending: ['GY-1436', 'GY-1437'] };
  state.promotion = { checkedAt: iso(faultAt), mainSha: tip, promotedSha: loaded, promotedAt: null, behind: 2, ledgerReadAt: null, inFlight: false, runsReadAt: null, dispatchedAt: null, lastDispatchAt: null, nextDueAt: iso(faultAt + 30 * minute), reason: null };
  assert.deepEqual(await performSelfUpgrade(master, state, deps(fake, { now: faultAt }, fleet)), { outcome: 'skipped', reason: 'no delivered item is verified deployed yet' });
  assert.deepEqual({ fetches: fake.fetches, checkouts: fake.checkouts, executors: fleet.executors, self: fleet.self }, { fetches: 0, checkouts: [], executors: [], self: 0 });
  // The same cursor with production unobservable is the gap GY-1445 closes.
  state.deployment = { source: 'unavailable', sha: null, at: iso(faultAt), reason: 'the production endpoint did not answer', deployed: [], pending: ['GY-1436', 'GY-1437'] };
  assert.equal((await performSelfUpgrade(master, state, deps(fake, { now: faultAt }, fleet))).outcome, 'upgraded');
  assert.equal(fleet.self, 1);
});

test('unit:self-upgrade-processed-gap-keys-on-loaded — a docs-only pass counts as processed only when it diffed from what the loop loaded: one taken from a later commit leaves the loaded code gap owed', async () => {
  const state = faultState({ owed: false }), fake = new FakeGit(checkout, checkout), fleet = { held: false, self: 0, executors: [] as string[] };
  const between = full('5eedba5e0001');
  // A failed re-execution left the loop on 2cca02cd2424, then a verified docs-only release moved the checkout from a later commit.
  state.upgrade.last = { at: iso(faultAt - hour), from: between, to: checkout, code: false, executors: null, self: false };
  const upgraded = await performSelfUpgrade(master, state, deps(fake, { now: faultAt }, fleet));
  assert.equal(upgraded.outcome, 'upgraded', 'the code between the loaded commit and the checkout is still owed');
  assert.equal(fleet.self, 1);
  // Processed from the loaded commit, the same gap is idle.
  const idle = faultState({ owed: false }), page = new FakeGit(checkout, checkout, ['docs/master-agent-reference.md']);
  idle.upgrade.last = { at: iso(faultAt - hour), from: loaded, to: checkout, code: false, executors: null, self: false };
  assert.equal((await performSelfUpgrade(master, idle, deps(page, { now: faultAt }, fleet))).outcome, 'skipped');
  assert.equal(page.fetches, 0);
});

test('unit:soak-self-upgrade-unverified-production — a day of between-cycles passes through the real checkout guard and self-upgrade while production comes and goes: each code move the loop has not loaded is restarted onto once within the bound, claims held and an origin outage included; fetches happen only on passes with work, a docs-only gap stays idle, one stall stands with a fixed since and retires on the restart, and loaded-revision never pins', async () => {
  const cycleMs = 2 * minute, dayMs = 8 * hour, start = faultAt;
  // The base branch: a linear history of merges, each one commit with the paths it changed.
  const history: { sha: string; files: string[]; at: number }[] = [{ sha: full('c0c0c0c0c0c0'), files: [], at: start - hour }];
  const merge = (label: string, at: number, files: string[]) => ({ sha: full(label), files, at });
  const merges = [
    merge('c1c1c1c1c1c1', 40 * minute, ['src/daemon/run.ts']), merge('c2c2c2c2c2c2', 90 * minute, ['docs/delivery.md']),
    merge('c3c3c3c3c3c3', 150 * minute, ['docs/master-agent-reference.md']), merge('c4c4c4c4c4c4', 4 * hour, ['src/master-resources.ts']),
    merge('c5c5c5c5c5c5', 6 * hour, ['docs/glossary.md']),
  ];
  const [c0] = history, [c1, , c3, c4] = merges;
  const index = (sha: string) => history.findIndex(commit => commit.sha === sha);
  const between = (from: string, to: string) => history.slice(index(from) + 1, index(to) + 1);
  // Production: a deploy observed at each listed offset, unobservable inside each window.
  const deploys = [{ at: 50 * minute, sha: c1.sha }, { at: 3 * hour, sha: c3.sha }, { at: 5 * hour, sha: c4.sha }];
  const dark = [{ from: 54 * minute, to: 3 * hour }, { from: 3 * hour + 10 * minute, to: 5 * hour }, { from: 5 * hour + 4 * minute, to: dayMs }];
  const heldClaims = [{ from: 50 * minute, to: 60 * minute }, { from: 5 * hour, to: 5 * hour + 20 * minute }];
  const outage = { from: 5 * hour + 6 * minute, to: 5 * hour + 40 * minute };
  const within = (windows: { from: number; to: number }[], elapsed: number) => windows.some(window => elapsed >= window.from && elapsed < window.to);

  const state = emptyDaemonState(master);
  state.release = { commit: c0.sha, dirty: false };
  state.upgrade.alignedRelease = c0.sha;
  const clock = { now: start };
  const fake = new FakeGit(c0.sha, c0.sha);
  const base = fake.run;
  fake.run = async (command, args) => {
    const [op, ...operands] = args.slice(2);
    if (op === 'fetch') { fake.fetches += 1; if (fake.fetchFails) throw new Error(fake.fetchFails); fake.originTip = history.at(-1)!.sha; return ''; }
    if (op === 'diff') { const [from, to] = operands[1].split('..'); return `${between(from, to).flatMap(commit => commit.files).join('\n')}\n`; }
    if (op === 'checkout') { moves.push({ at: clock.now - start, to: operands[2] }); }
    return base(command, args);
  };
  const moves: { at: number; to: string }[] = [];
  const restarts: { at: number; onto: string; movedAt: number }[] = [];
  const attempts: number[] = [];
  const upgradeDeps: SelfUpgradeDeps = {
    root: '/coordinator', run: (command, args) => fake.run(command, args), now: () => clock.now,
    restartExecutors: async to => { attempts.push(clock.now - start); return within(heldClaims, clock.now - start) ? refusedExecutors(to) : restartedExecutors(to); },
    // The supervisor starts a new process that loads the checkout's commit.
    restartSelf: async () => { restarts.push({ at: clock.now - start, onto: fake.head, movedAt: moves.at(-1)!.at }); state.release = { commit: fake.head, dirty: false }; },
  };
  const guard = coordinatorCheckoutGuard({
    state: () => state, read: async () => ({ root: '/coordinator', commit: fake.head, modified: [], untracked: [] }),
    agents: async () => [], snapshot: async () => ({ work: [] as Work[], now: iso(clock.now) }), persist: async () => {}, now: () => clock.now, log: () => {}, applies: () => true,
  });
  assert.equal(await guard.start(c0.sha), null);

  const fetchCycles: { at: number; reason: string }[] = [];
  const stalls: { cause: string; since: string }[] = [];
  let deployed = 0, cycles = 0;
  for (let elapsed = 0; elapsed < dayMs; elapsed += cycleMs) {
    clock.now = start + elapsed;
    cycles += 1;
    while (merges.length && merges[0].at <= elapsed) history.push(merges.shift()!);
    while (deployed < deploys.length && deploys[deployed].at <= elapsed) deployed += 1;
    const serving = deployed ? deploys[deployed - 1].sha : c0.sha;
    state.deployment = within(dark, elapsed)
      ? { source: 'unavailable', sha: null, at: iso(clock.now), reason: 'the production endpoint did not answer', deployed: [], pending: ['GY-1'] }
      : { source: 'endpoint', sha: serving, at: iso(clock.now), reason: null, deployed: ['GY-1'], pending: [] };
    fake.fetchFails = within([outage], elapsed) ? 'fatal: unable to access \'https://github.com/owner/project/\': Could not resolve host: github.com' : null;

    // What makes this pass worth a fetch: a restart owed, a release newly verified, or an unverified checkout holding code the loop never loaded.
    const loadedNow = state.release!.commit!, owedBefore = !!state.upgrade.pending;
    const verifiedNew = state.deployment.source === 'endpoint' && state.upgrade.alignedRelease !== state.deployment.sha;
    const unloadedCode = state.deployment.source === 'unavailable' && upgradeTouchesCode(between(loadedNow, fake.head).flatMap(commit => commit.files));
    const fetchesBefore = fake.fetches;
    const { refusal, upgraded } = await guard.betweenCycles(current => performSelfUpgrade(master, current, upgradeDeps));
    assert.equal(refusal, null, `+${elapsed / minute} min: the loop's own moves are never drift`);
    if (fake.fetches > fetchesBefore) {
      assert.equal(fake.fetches, fetchesBefore + 1, 'one fetch per pass at most');
      assert.ok(owedBefore || verifiedNew || unloadedCode, `+${elapsed / minute} min: fetched on a pass with no work (${upgraded?.outcome})`);
      fetchCycles.push({ at: elapsed, reason: owedBefore ? 'owed' : verifiedNew ? 'verified' : 'unloaded' });
    }

    // The named stall: one at a time, its since fixed while its cause stands.
    const stalled = state.upgrade.stalled;
    if (stalled) {
      const prior = stalls.at(-1);
      if (prior?.cause === stalled.cause && prior.since !== '') assert.equal(stalled.since, prior.since, `+${elapsed / minute} min: the stall keeps its since`);
      else stalls.push({ cause: stalled.cause, since: stalled.since });
    } else if (stalls.at(-1)?.since) stalls.push({ cause: 'retired', since: '' });

    // loaded-revision, as master status reads it: never pinned at the bound.
    const head = fake.head, loadedAfter = state.release!.commit!;
    const behind = between(loadedAfter, head).filter(commit => upgradeTouchesCode(commit.files)).length;
    const movedAt = moves.length ? start + moves.at(-1)!.at : start;
    const reading = loadedRevision(state, { behind, loaded: loadedAfter, checkout: head, movedAt }, clock.now);
    assert.equal(reading.used, 0, `+${elapsed / minute} min: loaded-revision pinned: ${reading.detail}`);
  }

  // Each code move restarted onto once, within the bound of the checkout's move; the docs-only move
  // restarted nothing. The second stretch of held claims outlasts the fleet wait (GY-1473), so the
  // loop re-executes onto c4 by itself at +316 min, and the fleet restart at +320 does not repeat it.
  assert.deepEqual(restarts.map(restart => ({ at: restart.at / minute, onto: restart.onto })), [{ at: 60, onto: c1.sha }, { at: 316, onto: c4.sha }]);
  for (const restart of restarts) assert.ok(restart.at - restart.movedAt < 30 * minute, `the restart onto ${restart.onto.slice(0, 12)} came ${(restart.at - restart.movedAt) / minute} min after the move`);
  assert.deepEqual(moves.map(move => ({ at: move.at / minute, to: move.to })), [{ at: 50, to: c1.sha }, { at: 180, to: c3.sha }, { at: 300, to: c4.sha }]);
  assert.equal(state.release?.commit, c4.sha);
  // Every cycle a claim held the restart was an attempt, inside the outage too.
  assert.deepEqual(attempts.map(at => at / minute), [50, 52, 54, 56, 58, 60, 300, 302, 304, 306, 308, 310, 312, 314, 316, 318, 320]);
  // Fetches: the verified passes, the owed retries — no idle pass fetched, the docs-only gap included.
  assert.deepEqual(fetchCycles.map(entry => `${entry.at / minute}:${entry.reason}`), ['50:verified', '52:owed', '54:owed', '56:owed', '58:owed', '60:owed', '180:verified', '300:verified',
    '302:owed', '304:owed', '306:owed', '308:owed', '310:owed', '312:owed', '314:owed', '316:owed', '318:owed', '320:owed']);
  assert.ok(fake.fetches <= 18 && fake.fetches < cycles / 10, `${fake.fetches} fetches over ${cycles} cycles`);
  // The stall: one row per held stretch, retired by the restart that completed it.
  assert.deepEqual(stalls, [{ cause: 'executors-refused', since: iso(start + 50 * minute) }, { cause: 'retired', since: '' }, { cause: 'executors-refused', since: iso(start + 300 * minute) }, { cause: 'retired', since: '' }]);
  assert.equal(state.upgrade.stalled, undefined);
  assert.equal(state.actions[alignKey], undefined, 'no failure before a restart was ever recorded: the outage only met owed restarts');
  const keys = Object.keys(state.actions).filter(key => key.startsWith('upgrade:'));
  assert.ok(keys.length <= deploys.length + 1, `the cursor holds one upgrade action per release and one unverified: ${keys.join(', ')}`);
});

/** GY-1473's instance: the loop on 6d7d82f95808 while the checkout holds b59c79735ee2, 45 commits behind. */
const stale = full('6d7d82f95808'), current = full('b59c79735ee2'), next = full('63530ca74a00');
const staleAt = Date.parse('2026-10-07T16:18:10.000Z');

/** A fleet with no executor claim at all: every restart it is asked for restarts, with nothing held. */
function claimFree(fake: FakeGit, clock: { now: number }, reload: DaemonState) {
  const fleet = { claims: [] as string[], executors: [] as string[], self: [] as number[] };
  const upgradeDeps: SelfUpgradeDeps = {
    root: '/coordinator', run: fake.run, now: () => clock.now,
    restartExecutors: async to => { fleet.executors.push(to); return fleet.claims.length ? refusedExecutors(to) : restartedExecutors(to); },
    restartSelf: async () => { fleet.self.push(clock.now); reload.release = { commit: fake.head, dirty: false }; },
  };
  return { fleet, upgradeDeps };
}

test('integration:self-upgrade-restarts-without-claim — with no executor holding a claim, the between-cycles self-upgrade restarts the loop onto the checkout\'s revision on the first pass after the checkout advances, observed production or not, so the move is loaded well within 30 minutes', async () => {
  for (const shape of ['unobserved', 'observed-aligned'] as const) {
    const state = emptyDaemonState(master), clock = { now: staleAt };
    state.release = { commit: stale, dirty: false };
    // The checkout advanced to `current` under the running loop, which has not loaded it.
    const fake = new FakeGit(current, current);
    if (shape === 'observed-aligned') {
      // Production observed, its release already aligned: the GY-1469 shape, no restart on the cursor.
      state.deployment = { source: 'endpoint', sha: current, at: iso(clock.now), reason: null, deployed: ['GY-1445'], pending: [] };
      state.upgrade.alignedRelease = current;
    }
    const { fleet, upgradeDeps } = claimFree(fake, clock, state);
    const guard = coordinatorCheckoutGuard({
      state: () => state, read: async () => ({ root: '/coordinator', commit: fake.head, modified: [], untracked: [] }),
      agents: async () => [], snapshot: async () => ({ work: [] as Work[], now: iso(clock.now) }), persist: async () => {}, now: () => clock.now, log: () => {}, applies: () => true,
    });
    assert.equal(await guard.start(stale), null);
    const movedAt = clock.now;
    clock.now = movedAt + 5 * minute;
    const { refusal, upgraded } = await guard.betweenCycles(current => performSelfUpgrade(master, current, upgradeDeps));
    assert.equal(refusal, null);
    assert.equal(upgraded?.outcome, 'upgraded', `${shape}: the pass restarts, it does not wait for a claim`);
    assert.deepEqual(fleet.executors, [current], `${shape}: the fleet restart targets the checkout`);
    assert.deepEqual(fleet.self, [clock.now], `${shape}: the loop re-executed once, on this pass`);
    assert.ok(fleet.self[0] - movedAt < 30 * minute, `${shape}: within the bound of the move`);
    assert.equal(state.release?.commit, current, `${shape}: the move is loaded`);
    assert.equal(state.upgrade.pending, null);
    assert.equal(state.upgrade.stalled, undefined);
    assert.equal(loadedRevision(state, { behind: 0, loaded: current, checkout: current }, clock.now).used, 0);

    // A newly verified release then advances the checkout, still with no claim: the next pass moves
    // it and restarts onto it. (Unobserved, an idle checkout is never fetched (GY-1445): only the
    // checkout's own HEAD is the move there.)
    if (shape === 'unobserved') continue;
    fake.originTip = next;
    clock.now += 5 * minute;
    state.deployment = { ...state.deployment!, sha: next, at: iso(clock.now) };
    const again = await guard.betweenCycles(current => performSelfUpgrade(master, current, upgradeDeps));
    assert.equal(again.upgraded?.outcome, 'upgraded', `${shape}: the advance is restarted onto`);
    assert.deepEqual(fake.checkouts, [next]);
    assert.equal(state.release?.commit, next);
    assert.equal(fleet.self.length, 2);
  }
});

test('integration:self-upgrade-with-claim-loads — with an executor claim held on every cycle, the each-cycle retry re-executes the loop onto the checkout within the bound, so the loaded revision reaches the checkout HEAD; the executor restart stays owed and completes once the claim settles, without a second loop restart', async () => {
  const state = emptyDaemonState(master), clock = { now: staleAt };
  state.release = { commit: stale, dirty: false };
  const fake = new FakeGit(current, current);
  const { fleet, upgradeDeps } = claimFree(fake, clock, state);
  fleet.claims.push('graphyard-master@host-a/3 holds dispatch for GY-1439');
  const guard = coordinatorCheckoutGuard({
    state: () => state, read: async () => ({ root: '/coordinator', commit: fake.head, modified: [], untracked: [] }),
    agents: async () => [], snapshot: async () => ({ work: [] as Work[], now: iso(clock.now) }), persist: async () => {}, now: () => clock.now, log: () => {}, applies: () => true,
  });
  assert.equal(await guard.start(stale), null);
  const { fleetWaitMs } = await import('../src/daemon/upgrade.js') as { fleetWaitMs?: number };
  assert.equal(fleetWaitMs, selfUpgradeBoundMs / 2, 'the fleet wait is half the loaded-revision bound, as its reclaim text says');
  const movedAt = clock.now, cycleMs = 5 * minute;
  const outcomes: string[] = [];
  // Every cycle for an hour, the claim held throughout.
  for (let elapsed = cycleMs; elapsed <= hour; elapsed += cycleMs) {
    clock.now = movedAt + elapsed;
    const { upgraded } = await guard.betweenCycles(current => performSelfUpgrade(master, current, upgradeDeps));
    outcomes.push(`${elapsed / minute}:${upgraded?.outcome}${upgraded?.outcome === 'pending' && upgraded.self ? '+self' : ''}`);
    const loadedNow = state.release!.commit!;
    const reading = loadedRevision(state, { behind: loadedNow === current ? 0 : 45, loaded: loadedNow, checkout: current, movedAt }, clock.now);
    assert.equal(reading.used, 0, `+${elapsed / minute} min: ${reading.detail}`);
  }
  assert.equal(fleet.executors.length, 12, 'the executor restart was retried every cycle');
  assert.equal(fleet.self.length, 1, 'the loop re-executed once, not every cycle');
  assert.ok(fleet.self[0] - movedAt < 30 * minute, `the loop loaded the checkout ${(fleet.self[0] - movedAt) / minute} min after the move`);
  assert.equal(state.release?.commit, current, 'the loaded revision reached the checkout HEAD while the claim was held');
  assert.deepEqual(outcomes.slice(0, 4), ['5:pending', '10:pending', '15:pending', '20:pending+self']);
  assert.ok(outcomes.slice(4).every(outcome => outcome.endsWith(':pending')), outcomes.join(', '));
  assert.deepEqual(state.upgrade.pending, { from: stale, to: current, code: true }, 'the executor restart stays owed');
  assert.equal(state.upgrade.stalled?.cause, 'executors-refused');

  // The claim settles: the fleet restarts onto the checkout and the loop, already on it, is not restarted again.
  fleet.claims.length = 0;
  clock.now += cycleMs;
  const done = await guard.betweenCycles(current => performSelfUpgrade(master, current, upgradeDeps));
  assert.deepEqual(done.upgraded?.outcome === 'upgraded' && { self: done.upgraded.self, to: done.upgraded.to }, { self: false, to: current });
  assert.equal(fleet.self.length, 1);
  assert.equal(state.upgrade.pending, null);
  assert.equal(state.upgrade.stalled, undefined);

  // A loop that cannot reach its supervisor keeps the failure named; the next pass retries.
  const broken = emptyDaemonState(master);
  broken.release = { commit: stale, dirty: false };
  broken.upgrade.pending = { from: stale, to: current, code: true };
  broken.upgrade.stalled = { cause: 'executors-refused', reason: 'held', since: iso(staleAt - 20 * minute), at: iso(staleAt - 5 * minute) };
  const failing = await performSelfUpgrade(master, broken, { ...upgradeDeps, restartExecutors: async to => refusedExecutors(to), restartSelf: async () => { throw new Error('Failed to connect to bus'); } });
  assert.equal(failing.outcome, 'failed');
  assert.equal(broken.upgrade.stalled?.cause, 'supervisor-unreachable');
  assert.deepEqual(broken.upgrade.pending, { from: stale, to: current, code: true }, 'still owed for the next pass');
});

test('unit:loaded-revision-fault-clears — once the self-upgrade\'s restart lands (a claim held throughout), the loaded-revision reading, read from the real reflog and process start, raises no resource-bound attention on any later cycle, and it fires again only when a new unloaded move ages past the 30-minute bound with no restart attempted', async () => {
  const sec = (at: number) => Math.floor(at / 1000);
  const loop = { start: staleAt - 6 * hour };
  /** The checkout's HEAD reflog, newest first: each move and when it happened. */
  const reflog: { sha: string; at: number }[] = [{ sha: current, at: staleAt - 2 * hour }, { sha: stale, at: staleAt - 8 * hour }];
  const run = (command: string, args: string[]): string => {
    if (command === 'ps') return `${sec(clock.now) - sec(loop.start)}\n`;
    const [op, ...operands] = args.slice(2);
    if (op === 'rev-parse') return `${reflog[0].sha}\n`;
    if (op === 'reflog') return reflog.map(move => `${move.sha} HEAD@{${sec(move.at)}}`).join('\n');
    if (op === 'diff') return 'src/daemon/run.ts\n';
    if (op === 'rev-list') return operands.at(-1)!.startsWith(stale) ? '45\n' : '3\n';
    throw new Error(`fake cannot answer: ${command} ${args.join(' ')}`);
  };
  const clock = { now: staleAt };
  const state = emptyDaemonState(master);
  state.release = { commit: stale, dirty: false };
  const attention = () => {
    const revision = revisionOf('/coordinator', 4242, run, clock.now);
    assert.ok(revision, 'the reading resolves');
    const reading = loadedRevision(state, revision, clock.now);
    return { reading, attention: resourceAttention([reading]) };
  };

  // The fault as it stood: 45 commits behind, the move two hours old, no restart attempted.
  let read = attention();
  assert.equal(read.reading.used, 45);
  assert.deepEqual(read.attention.map(item => item.subject), ['resource:loaded-revision']);

  // The self-upgrade's passes, a claim held on every one: the restart it completes starts a new
  // process after the move, which loads the checkout HEAD.
  const fake = new FakeGit(current, current);
  const upgradeDeps: SelfUpgradeDeps = {
    root: '/coordinator', run: fake.run, now: () => clock.now,
    restartExecutors: async to => refusedExecutors(to),
    restartSelf: async () => { loop.start = clock.now + 20_000; state.release = { commit: fake.head, dirty: false }; },
  };
  let landed: number | null = null;
  for (let cycle = 0; cycle < 24; cycle++) {
    clock.now = staleAt + minute + cycle * 5 * minute;
    await performSelfUpgrade(master, state, upgradeDeps);
    if (landed === null && state.release?.commit === current) landed = clock.now;
    clock.now += 30_000;
    if (landed === null) continue;
    const revision = revisionOf('/coordinator', 4242, run, clock.now);
    assert.deepEqual({ loaded: revision?.loaded, behind: revision?.behind }, { loaded: current, behind: 0 }, `cycle ${cycle}: the loop runs the checkout HEAD`);
    read = attention();
    assert.equal(read.reading.used, 0, `cycle ${cycle}: ${read.reading.detail}`);
    assert.deepEqual(read.attention, [], `cycle ${cycle}: the fault stays clear`);
  }
  assert.ok(landed !== null && landed - staleAt <= 30 * minute, 'the restart landed within the bound with the claim held');

  // A new move onto unloaded code: within the bound it is the self-upgrade's to make, and nothing fires.
  const movedAt = clock.now + minute;
  reflog.unshift({ sha: next, at: movedAt });
  clock.now = movedAt + 29 * minute;
  read = attention();
  assert.equal(read.reading.used, 0, read.reading.detail!);
  assert.deepEqual(read.attention, []);
  // Past the bound with no restart attempted, it fires again, naming the new move.
  clock.now = movedAt + 31 * minute;
  read = attention();
  assert.equal(read.reading.used, 3);
  assert.deepEqual(read.attention.map(item => item.subject), ['resource:loaded-revision']);
  assert.match(read.reading.detail!, /the checkout is at 63530ca74a00/);
});

test('unit:self-upgrade-unverified-still-restarts — with production unobserved (null or unavailable), the owed restart completes onto the checkout\'s own head, even one a release-lagged hold left owed: the served-release gate never pins the loop on stale code', async () => {
  for (const deployment of [null, { source: 'unavailable' as const, sha: null, at: iso(faultAt), reason: 'the endpoint did not answer', deployed: [], pending: ['GY-1581'] }]) {
    // An owed restart onto the checkout, no hold yet: the pass completes it.
    const state = faultState(), fake = new FakeGit(checkout, checkout), clock = { now: faultAt }, fleet = { held: false, self: 0, executors: [] as string[] };
    state.deployment = deployment;
    const upgraded = await performSelfUpgrade(master, state, deps(fake, clock, fleet));
    assert.equal(upgraded.outcome, 'upgraded', `production ${deployment?.source ?? 'null'}: the owed restart completes`);
    assert.deepEqual(fleet.executors, [checkout]);
    assert.equal(fleet.self, 1);
    assert.equal(fake.ancestryReads, 0, 'an unobserved plane is never asked to serve the move');
    assert.equal(state.upgrade.stalled, undefined);

    // A restart held while production was observed on an earlier release, then the plane went
    // unobserved: the owed restart onto the checkout's own head completes on the next pass.
    const lagged = faultState(), same = new FakeGit(checkout, checkout), quiet = { held: false, self: 0, executors: [] as string[] };
    lagged.upgrade.stalled = { cause: 'release-lagged', reason: `restart held: production serves release ${loaded.slice(0, 12)}, which does not contain ${checkout.slice(0, 12)} yet`, since: iso(faultAt - hour), at: iso(faultAt - minute) };
    lagged.deployment = deployment;
    const resumed = await performSelfUpgrade(master, lagged, deps(same, clock, quiet));
    assert.equal(resumed.outcome, 'upgraded', `production ${deployment?.source ?? 'null'}: the held restart completes once the plane is unobserved`);
    assert.deepEqual(quiet.executors, [checkout]);
    assert.equal(quiet.self, 1);
    assert.equal(lagged.upgrade.pending, null);
    assert.equal(lagged.upgrade.stalled, undefined);
  }
});
