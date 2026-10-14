import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import { emptyDaemonState, type DaemonState } from '../src/master-daemon.js';
import { performSelfUpgrade, type SelfUpgradeDeps } from '../src/daemon/upgrade.js';
import { coordinatorCheckoutGuard } from '../src/daemon/run.js';
import { owedUpgrade, readResources, resourceAttention, type ResourceInputs } from '../src/master-resources.js';
import type { ExecutorRestartResult } from '../src/executor-fleet.js';

// GY-1464: manual:fault-class-resources (resource:loaded-revision at its bound three times on 7 October 2026).
//
// GY-1445 finished the owed restart only while production was unobservable. With production
// observed — serving none of the awaited deliveries, or a release the loop had already aligned —
// the pass skipped whenever no restart sat on the cursor, so a checkout holding code the loop never
// loaded (a re-execution that failed or never ended the process, a move the loop did not make) pinned
// the loop on stale code until the next promotion: 81, 55 and 45 commits behind. The candidate owes
// the restart onto the checkout's own HEAD in every leg, except the promotion wait the reading
// itself excuses. Fake git and a fake supervisor, as in tests/self-upgrade-null-production.test.ts.

const full = (prefix: string) => prefix.padEnd(40, '0');
const minute = 60_000, hour = 60 * minute;
const iso = (at: number) => new Date(at).toISOString();

const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/nonexistent/coordinator.token', cliPath: '/nonexistent/bin/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });

/** The three instances on GY-1464, as their readings name them. */
const instances = [
  { at: '2026-10-07T09:28:59.761Z', loaded: full('2cca02cd2424'), checkout: full('02ba2078f1ce'), behind: 81 },
  { at: '2026-10-07T11:39:34.239Z', loaded: full('02ba2078f1ce'), checkout: full('6d7d82f95808'), behind: 55 },
  { at: '2026-10-07T16:18:10.878Z', loaded: full('6d7d82f95808'), checkout: full('b59c79735ee2'), behind: 45 },
];

/** A clean, detached coordinator checkout at `head`; a fetch finds `originTip` on the base branch. */
class FakeGit {
  checkouts: string[] = [];
  fetches = 0;
  constructor(public head: string, public originTip: string, public diffPaths = ['src/daemon/upgrade.ts']) {}
  run = async (command: string, args: string[]): Promise<string> => {
    assert.equal(command, 'git');
    const [op, ...operands] = args.slice(2);
    if (op === 'rev-parse') return `${operands[0] === 'HEAD' ? this.head : this.originTip}\n`;
    if (op === 'symbolic-ref') throw Object.assign(new Error('fatal: not a symbolic ref'), { status: 1 });
    if (op === 'status') return '';
    if (op === 'fetch') { this.fetches += 1; return ''; }
    if (op === 'diff') return `${this.diffPaths.join('\n')}\n`;
    if (op === 'checkout') { this.head = operands[2]; this.checkouts.push(operands[2]); return ''; }
    throw new Error(`fake git cannot answer: git ${args.slice(2).join(' ')}`);
  };
}

const executorResult = (to: string, held: boolean): ExecutorRestartResult => held
  ? { result: 'refused', reason: 'Restart refused while an executor on host-a holds a claimed action', coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] }
  : { result: 'restarted', reason: null, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] };

function deps(fake: FakeGit, clock: { now: number }, fleet: { held: boolean; self: number; executors: string[] }): SelfUpgradeDeps {
  return {
    root: '/coordinator', run: fake.run, now: () => clock.now,
    restartExecutors: async to => { fleet.executors.push(to); return executorResult(to, fleet.held); },
    restartSelf: async () => { fleet.self += 1; },
  };
}

const loadedRevision = (state: DaemonState, revision: NonNullable<ResourceInputs['revision']>, now: number) => readResources({ now, reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, disk: null,
  profiles: { workers: [], reviewers: [], producers: [] }, revision, upgrade: owedUpgrade(state) }).find(reading => reading.id === 'loaded-revision')!;

/**
 * An instance's cursor: the loop runs `loaded`, its checkout already holds `checkout`, nothing is
 * owed on the cursor, and production is observed in the given shape.
 */
function instanceState(instance: typeof instances[number], shape: 'awaiting' | 'aligned' | 'served-overdue'): DaemonState {
  const state = emptyDaemonState(master), at = Date.parse(instance.at);
  state.release = { commit: instance.loaded, dirty: false };
  if (shape === 'awaiting') {
    // Production serves the checkout's release, but none of the deliveries the loop awaits.
    state.deployment = { source: 'endpoint', sha: instance.checkout, at: instance.at, reason: null, deployed: [], pending: ['GY-1450'] };
  } else if (shape === 'aligned') {
    // A verified release the loop aligned onto, whose re-execution never ended the process.
    state.deployment = { source: 'endpoint', sha: instance.checkout, at: instance.at, reason: null, deployed: ['GY-1445'], pending: [] };
    state.upgrade.alignedRelease = instance.checkout;
    state.upgrade.last = { at: iso(at - 2 * hour), from: instance.loaded, to: instance.checkout, code: true, executors: 'restarted', self: true };
  } else {
    // Production serves what the loop loaded, and the promotion that would serve the rest is overdue.
    state.deployment = { source: 'endpoint', sha: instance.loaded, at: instance.at, reason: null, deployed: [], pending: ['GY-1450'] };
    state.promotion = { checkedAt: instance.at, mainSha: instance.checkout, promotedSha: instance.loaded, promotedAt: null, behind: instance.behind, ledgerReadAt: null, inFlight: false, runsReadAt: null, dispatchedAt: null, lastDispatchAt: null, nextDueAt: iso(at - hour), reason: null };
  }
  return state;
}

test('manual:fault-class-resources — GY-1464: each loaded-revision instance, with production observed, is reproduced at its bound and the self-upgrade restarts the loop onto the checkout\'s own HEAD within the bound, so the reading returns to headroom', async () => {
  for (const instance of instances) {
    for (const shape of ['awaiting', 'aligned', 'served-overdue'] as const) {
      const label = `${instance.at} (${shape})`, faultAt = Date.parse(instance.at);
      const state = instanceState(instance, shape), fake = new FakeGit(instance.checkout, instance.checkout), clock = { now: faultAt };
      const fleet = { held: true, self: 0, executors: [] as string[] };
      const revision = { behind: instance.behind, loaded: instance.loaded, checkout: instance.checkout, movedAt: faultAt - 3 * hour };

      // The instance as it stood: no restart owed or attempted, the reading at its bound.
      const before = loadedRevision(state, revision, clock.now);
      assert.equal(before.used, instance.behind, `${label}: the fault reproduces at ${instance.behind} commits behind`);
      assert.equal(resourceAttention([before]).length, 1, `${label}: the reading is attention`);

      const guard = coordinatorCheckoutGuard({
        state: () => state, read: async () => ({ root: '/coordinator', commit: fake.head, modified: [], untracked: [] }),
        agents: async () => [], snapshot: async () => ({ work: [] as Work[], now: iso(clock.now) }), persist: async () => {}, now: () => clock.now, log: () => {}, applies: () => true,
      });
      // The loop already stood behind this checkout when the cycle began: HEAD is what it expects.
      assert.equal(await guard.start(instance.loaded), null);
      const upgrade = (current: DaemonState) => performSelfUpgrade(master, current, deps(fake, clock, fleet));

      // The base skipped this pass; the candidate owes the restart onto the checkout's HEAD and
      // attempts it, with no fetch and no move: production's promotion still decides the tip.
      const first = await guard.betweenCycles(upgrade);
      assert.equal(first.upgraded?.outcome, 'pending', `${label}: the owed restart is attempted, not skipped`);
      assert.deepEqual(fleet.executors, [instance.checkout], `${label}: the executor restart targets the checkout's HEAD`);
      assert.deepEqual({ fetches: fake.fetches, checkouts: fake.checkouts }, { fetches: 0, checkouts: [] }, `${label}: the checkout stays where it stands`);
      assert.deepEqual(state.upgrade.pending, { from: instance.loaded, to: instance.checkout, code: true });
      assert.equal(guard.expected(), instance.checkout);
      let reading = loadedRevision(state, revision, clock.now);
      assert.equal(reading.used, 0, `${label}: the restart attempted within the bound is the upgrade under way`);
      assert.match(reading.detail!, /owed restart onto it is under way/);

      // The claims settle ten minutes in: the fleet restarts and the loop re-executes onto the checkout.
      fleet.held = false;
      clock.now = faultAt + 10 * minute;
      const done = await guard.betweenCycles(upgrade);
      assert.equal(done.upgraded?.outcome, 'upgraded', `${label}: the restart completes`);
      assert.equal(fleet.self, 1, `${label}: the loop re-executed once`);
      assert.equal(state.upgrade.pending, null);
      assert.equal(state.upgrade.stalled, undefined);
      assert.deepEqual(fake.checkouts, [], `${label}: the checkout was never moved`);

      // The process the supervisor starts loads the checkout: nothing is behind, and nothing repeats.
      state.release = { commit: instance.checkout, dirty: false };
      reading = loadedRevision(state, { behind: 0, loaded: instance.checkout, checkout: instance.checkout }, clock.now + 25 * minute);
      assert.equal(reading.used, 0, `${label}: the instance does not recur`);
      clock.now = faultAt + 20 * minute;
      assert.equal((await performSelfUpgrade(master, state, deps(fake, clock, fleet))).outcome, 'skipped', `${label}: a loop running its checkout is idle`);
      assert.equal(fleet.self, 1);
    }
  }
});

test('manual:fault-class-resources — GY-1464: the restart owed while production is observed holds exactly where the reading excuses the lag: a loop running the release production serves with the promotion on schedule waits, a docs-only gap already processed stays idle', async () => {
  const instance = instances[2], faultAt = Date.parse(instance.at);
  const revision = { behind: instance.behind, loaded: instance.loaded, checkout: instance.checkout, movedAt: faultAt - 3 * hour };

  // The promotion on schedule: the reading counts nothing and the pass owes no restart.
  const waiting = instanceState(instance, 'served-overdue'), fake = new FakeGit(instance.checkout, instance.checkout), fleet = { held: false, self: 0, executors: [] as string[] };
  waiting.promotion = { ...waiting.promotion!, nextDueAt: iso(faultAt + 30 * minute) };
  assert.equal(loadedRevision(waiting, revision, faultAt).used, 0);
  assert.deepEqual(await performSelfUpgrade(master, waiting, deps(fake, { now: faultAt }, fleet)), { outcome: 'skipped', reason: 'no delivered item is verified deployed yet' });
  // Once the promotion falls overdue the reading counts again, and so the pass restarts.
  const overdue = faultAt + 31 * minute;
  assert.equal(loadedRevision(waiting, revision, overdue).used, instance.behind);
  assert.equal((await performSelfUpgrade(master, waiting, deps(fake, { now: overdue }, fleet))).outcome, 'upgraded');
  assert.equal(fleet.self, 1);

  // A docs-only gap the loop already processed from what it loaded restarts nothing, cycle after cycle.
  const docs = instanceState(instance, 'awaiting'), page = new FakeGit(instance.checkout, instance.checkout, ['docs/operations.md']), calm = { held: false, self: 0, executors: [] as string[] };
  const first = await performSelfUpgrade(master, docs, deps(page, { now: faultAt }, calm));
  assert.deepEqual(first, { outcome: 'upgraded', from: instance.loaded, to: instance.checkout, code: false, executors: null, self: false });
  for (const step of [1, 2, 3]) assert.equal((await performSelfUpgrade(master, docs, deps(page, { now: faultAt + step * 10 * minute }, calm))).outcome, 'skipped');
  assert.deepEqual({ executors: calm.executors, self: calm.self, fetches: page.fetches }, { executors: [], self: 0, fetches: 0 });

  // A verified release whose tip the checkout already holds, but the loop never loaded: restarted, not up to date.
  const verified = emptyDaemonState(master), tipped = new FakeGit(instance.checkout, instance.checkout), quiet = { held: false, self: 0, executors: [] as string[] };
  verified.release = { commit: instance.loaded, dirty: false };
  verified.deployment = { source: 'endpoint', sha: instance.checkout, at: instance.at, reason: null, deployed: ['GY-1445'], pending: [] };
  const aligned = await performSelfUpgrade(master, verified, deps(tipped, { now: faultAt }, quiet));
  assert.equal(aligned.outcome, 'upgraded');
  assert.deepEqual({ executors: quiet.executors, self: quiet.self, aligned: verified.upgrade.alignedRelease }, { executors: [instance.checkout], self: 1, aligned: instance.checkout });
});
