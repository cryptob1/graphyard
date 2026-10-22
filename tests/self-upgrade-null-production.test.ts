import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import { emptyDaemonState, type DaemonState } from '../src/master-daemon.js';
import { performSelfUpgrade, upgradeTouchesCode, type SelfUpgradeDeps } from '../src/daemon/upgrade.js';
import { coordinatorCheckoutGuard } from '../src/daemon/run.js';

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
 * fleet. integration:self-upgrade-restarts-without-claim and unit:loaded-revision-fault-clears.
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


/** The fault's cursor: the loop runs 2cca02cd2424, production is unobserved, and the restart owed onto the checkout was last attempted two hours ago. */
function faultState(options: { owed?: boolean } = {}): DaemonState {
  const state = emptyDaemonState(master);
  state.release = { commit: loaded, dirty: false };
  state.deployment = null;
  if (options.owed !== false) {
    state.upgrade.pending = { from: loaded, to: checkout, code: true };
    state.actions[`upgrade:${loaded}`] = { kind: 'config', work: null, principal: null, state: 'waiting', detail: 'the loop did not re-execute', attempts: 3, epoch: null, cycle: 1, at: iso(faultAt - 2 * hour) };
  }
  return state;
}


/** `reload`: the cursor the process the supervisor starts records its load on, the checkout's HEAD; omitted, the re-execution loads nothing. */
function deps(fake: FakeGit, clock: { now: number }, fleet: { self: number; selfFails?: string | null }, reload?: DaemonState): SelfUpgradeDeps {
  return {
    root: '/coordinator', run: fake.run, now: () => clock.now,
    restartSelf: async () => { if (fleet.selfFails) throw new Error(fleet.selfFails); fleet.self += 1; if (reload) reload.release = { commit: fake.head, dirty: false }; },
  };
}

test('integration:self-upgrade-fires-without-verified-deployment — with production null, the loop aligns its checkout with the base tip and makes the owed restart within the bound', async () => {
  const state = faultState(), fake = new FakeGit(checkout, tip), clock = { now: faultAt };
  const fleet = { self: 0 };
  const guard = coordinatorCheckoutGuard({
    state: () => state, read: async () => ({ root: '/coordinator', commit: fake.head, modified: [], untracked: [] }),
    agents: async () => [], snapshot: async () => ({ work: [] as Work[], now: iso(clock.now) }), persist: async () => {}, now: () => clock.now, log: () => {}, applies: () => true,
  });
  // The loop aligned the checkout itself before production went unobserved: HEAD is what it expects.
  assert.equal(await guard.start(loaded), null);

  // Cycle 1: no verified deployment, yet the pass runs: the checkout moves to the base tip and the
  // owed restart is made: the loop re-executes onto it.
  const upgrade = (current: DaemonState) => performSelfUpgrade(master, current, deps(fake, clock, fleet, current));
  const first = await guard.betweenCycles(upgrade);
  assert.equal(first.refusal, null);
  assert.equal(first.upgraded?.outcome, 'upgraded', 'the owed restart is made, it is not skipped');
  assert.deepEqual(fake.checkouts, [tip], 'the checkout is aligned with the base tip');
  assert.equal(fleet.self, 1, 'the loop re-executed onto the tip');
  assert.equal(state.release?.commit, tip, 'the process the supervisor starts loads the tip');
  assert.equal(guard.expected(), tip, 'the loop\'s own move is never drift');
  assert.equal(state.upgrade.pending, null);
  assert.deepEqual({ to: state.upgrade.last?.to, self: state.upgrade.last?.self }, { to: tip, self: true });
  assert.equal(state.upgrade.alignedRelease, null, 'no verified release was aligned: none was observed');
  assert.equal(state.upgrade.stalled, undefined);

  // A later cycle on the tip it loaded restarts nothing again.
  clock.now = faultAt + 10 * minute;
  await guard.betweenCycles(upgrade);
  assert.equal(fleet.self, 1, 'one loop restart in all');

  // No restart on the cursor, but the checkout already holds the base tip the loop never loaded:
  // the pass owes the restart from what the loop loaded, and attempts it.
  const unowed = faultState({ owed: false }), still = new FakeGit(checkout, checkout), quiet = { self: 0 };
  const upgraded = await performSelfUpgrade(master, unowed, deps(still, { now: faultAt }, quiet));
  assert.equal(upgraded.outcome, 'upgraded');
  assert.equal(quiet.self, 1);
  assert.deepEqual(still.checkouts, [], 'a checkout already at the tip is not checked out again');

  // A checkout holding exactly what the loop loaded is idle: production null still skips it, with no fetch.
  const idle = faultState({ owed: false }), current = new FakeGit(loaded, tip);
  assert.deepEqual(await performSelfUpgrade(master, idle, deps(current, { now: faultAt }, { self: 0 })), { outcome: 'skipped', reason: 'no delivered item is verified deployed yet' });
  assert.deepEqual(current.checkouts, []);

  // A verified docs-only deploy moved the checkout past the loaded commit without a restart, then
  // production went unobserved: the gap holds no loaded code, so the pass that already processed it
  // leaves it idle — no fetch, no diff, no cursor write on any later cycle.
  const docs = faultState({ owed: false }), page = new FakeGit(loaded, checkout, ['docs/master-agent-reference.md']), calm = { self: 0 };
  docs.deployment = { source: 'endpoint', sha: checkout, at: iso(faultAt), reason: null, deployed: ['GY-1436'], pending: [] };
  let writes = 0;
  const docsDeps = { ...deps(page, clock, calm), persist: async () => { writes += 1; } };
  const verified = await performSelfUpgrade(master, docs, docsDeps);
  assert.deepEqual(verified, { outcome: 'upgraded', from: loaded, to: checkout, code: false, self: false });
  assert.equal(docs.release?.commit, loaded, 'a docs-only move restarts nothing, so the loaded commit stays behind the checkout');
  docs.deployment = null;
  const [fetched, persisted, recorded] = [page.fetches, writes, docs.upgrade.last];
  for (const step of [1, 2, 3]) {
    clock.now = faultAt + 30 * minute + step * 10 * minute;
    assert.deepEqual(await performSelfUpgrade(master, docs, docsDeps), { outcome: 'skipped', reason: 'no delivered item is verified deployed yet' }, `cycle ${step} is idle`);
  }
  assert.deepEqual({ fetches: page.fetches, writes, last: docs.upgrade.last }, { fetches: fetched, writes: persisted, last: recorded }, 'the docs-only gap is processed once, then stays idle');
  assert.equal(calm.self, 0);

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

test('unit:self-upgrade-processed-gap-keys-on-loaded — a docs-only pass counts as processed only when it diffed from what the loop loaded: one taken from a later commit leaves the loaded code gap owed', async () => {
  const state = faultState({ owed: false }), fake = new FakeGit(checkout, checkout), fleet = { self: 0 };
  const between = full('5eedba5e0001');
  // A failed re-execution left the loop on 2cca02cd2424, then a verified docs-only release moved the checkout from a later commit.
  state.upgrade.last = { at: iso(faultAt - hour), from: between, to: checkout, code: false, self: false };
  const upgraded = await performSelfUpgrade(master, state, deps(fake, { now: faultAt }, fleet));
  assert.equal(upgraded.outcome, 'upgraded', 'the code between the loaded commit and the checkout is still owed');
  assert.equal(fleet.self, 1);
  // Processed from the loaded commit, the same gap is idle.
  const idle = faultState({ owed: false }), page = new FakeGit(checkout, checkout, ['docs/master-agent-reference.md']);
  idle.upgrade.last = { at: iso(faultAt - hour), from: loaded, to: checkout, code: false, self: false };
  assert.equal((await performSelfUpgrade(master, idle, deps(page, { now: faultAt }, fleet))).outcome, 'skipped');
  assert.equal(page.fetches, 0);
});

test('unit:soak-self-upgrade-unverified-production — a day of between-cycles passes through the real checkout guard and self-upgrade while production comes and goes: each code move the loop has not loaded is restarted onto once within the bound, an origin outage included; fetches happen only on passes with work, a docs-only gap stays idle, one stall stands with a fixed since and retires on the restart, and loaded-revision never pins', async () => {
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
  const upgradeDeps: SelfUpgradeDeps = {
    root: '/coordinator', run: (command, args) => fake.run(command, args), now: () => clock.now,
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
  }

  // Each code move restarted onto once, within the bound of the checkout's move; the docs-only move
  // restarted nothing.
  assert.deepEqual(restarts.map(restart => ({ at: restart.at / minute, onto: restart.onto })), [{ at: 50, onto: c1.sha }, { at: 300, onto: c4.sha }]);
  for (const restart of restarts) assert.ok(restart.at - restart.movedAt < 30 * minute, `the restart onto ${restart.onto.slice(0, 12)} came ${(restart.at - restart.movedAt) / minute} min after the move`);
  assert.deepEqual(moves.map(move => ({ at: move.at / minute, to: move.to })), [{ at: 50, to: c1.sha }, { at: 180, to: c3.sha }, { at: 300, to: c4.sha }]);
  assert.equal(state.release?.commit, c4.sha);
  // Fetches: the verified passes only — no idle pass fetched, the docs-only gap included.
  assert.deepEqual(fetchCycles.map(entry => `${entry.at / minute}:${entry.reason}`), ['50:verified', '180:verified', '300:verified']);
  assert.ok(fake.fetches < cycles / 10, `${fake.fetches} fetches over ${cycles} cycles`);
  // No restart stalled: nothing holds the loop's own re-execution.
  assert.deepEqual(stalls, []);
  assert.equal(state.upgrade.stalled, undefined);
  assert.equal(state.actions[alignKey], undefined, 'no failure before a restart was ever recorded: the outage only met owed restarts');
  const keys = Object.keys(state.actions).filter(key => key.startsWith('upgrade:'));
  assert.ok(keys.length <= deploys.length + 1, `the cursor holds one upgrade action per release and one unverified: ${keys.join(', ')}`);
});

/** GY-1473's instance: the loop on 6d7d82f95808 while the checkout holds b59c79735ee2, 45 commits behind. */
const stale = full('6d7d82f95808'), current = full('b59c79735ee2'), next = full('63530ca74a00');
const staleAt = Date.parse('2026-10-07T16:18:10.000Z');

/** The loop's own re-execution, recorded: the process the supervisor starts loads the checkout. */
function claimFree(fake: FakeGit, clock: { now: number }, reload: DaemonState) {
  const fleet = { self: [] as number[] };
  const upgradeDeps: SelfUpgradeDeps = {
    root: '/coordinator', run: fake.run, now: () => clock.now,
    restartSelf: async () => { fleet.self.push(clock.now); reload.release = { commit: fake.head, dirty: false }; },
  };
  return { fleet, upgradeDeps };
}

test('integration:self-upgrade-restarts-without-claim — the between-cycles self-upgrade restarts the loop onto the checkout\'s revision on the first pass after the checkout advances, observed production or not, so the move is loaded well within 30 minutes', async () => {
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
    assert.equal(upgraded?.outcome, 'upgraded', `${shape}: the pass restarts, it waits on nothing`);
    assert.deepEqual(fleet.self, [clock.now], `${shape}: the loop re-executed once, on this pass`);
    assert.ok(fleet.self[0] - movedAt < 30 * minute, `${shape}: within the bound of the move`);
    assert.equal(state.release?.commit, current, `${shape}: the move is loaded`);
    assert.equal(state.upgrade.pending, null);
    assert.equal(state.upgrade.stalled, undefined);

    // A newly verified release then advances the checkout: the next pass moves
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

test('unit:self-upgrade-unverified-still-restarts — with production unobserved (null or unavailable), or observed on an earlier release, the owed restart completes onto the checkout\'s own head', async () => {
  for (const deployment of [null, { source: 'unavailable' as const, sha: null, at: iso(faultAt), reason: 'the endpoint did not answer', deployed: [], pending: ['GY-1581'] }]) {
    // An owed restart onto the checkout, no hold yet: the pass completes it.
    const state = faultState(), fake = new FakeGit(checkout, checkout), clock = { now: faultAt }, fleet = { self: 0 };
    state.deployment = deployment;
    const upgraded = await performSelfUpgrade(master, state, deps(fake, clock, fleet));
    assert.equal(upgraded.outcome, 'upgraded', `production ${deployment?.source ?? 'null'}: the owed restart completes`);
    assert.equal(fleet.self, 1);
    assert.equal(fake.ancestryReads, 0, 'an unobserved plane is never asked to serve the move');
    assert.equal(state.upgrade.stalled, undefined);

  }
  // GY-1982: production observed serving the loaded release, which does not contain the checkout,
  // holds nothing either: the release-lagged hold is gone.
  const observed = faultState(), fake = new FakeGit(checkout, checkout), fleet = { self: 0 };
  observed.deployment = { source: 'endpoint', sha: loaded, at: iso(faultAt), reason: null, deployed: ['GY-1580'], pending: ['GY-1581'] };
  assert.equal((await performSelfUpgrade(master, observed, deps(fake, { now: faultAt }, fleet))).outcome, 'upgraded');
  assert.equal(fleet.self, 1);
});
