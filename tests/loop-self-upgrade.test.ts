import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import { daemonSummary, deploymentObservationSchema, emptyDaemonState, readDaemonState, runDaemon, writeDaemonState, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { describeSelfUpgrade, heldCliPointer, holdCliAt, performSelfUpgrade, type SelfUpgradeOutcome } from '../src/daemon/upgrade.js';
import { releaseLag, promotionWait, readBaseTip, releaseLagGraceMs, upgradeRefusalAttention, type PromotionWait } from '../src/master/release-lag.js';
import { owedUpgrade, readResources, resourceAttention } from '../src/master-resources.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { executorRegistrar, readCommit, readExecutorRegistration, readExecutorRegistrations, readRelease, readRestartFence, restartExecutors, writeExecutorRegistration, type ExecutorRegistration } from '../src/executor-fleet.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { releaseGuardedEffects, staleReleaseReason, type ReleaseGuard } from '../src/executor.js';
import type { ActionRow } from '../src/model/actions.js';
import type { ExecutorEffects } from '../src/auto-dispatch.js';

/**
 * GY-437: the loop and the executors upgrade themselves to the merged release. After every merge
 * touching src/ the coordinator used to be restarted by hand; now the loop aligns its own
 * checkout with the verified deployed release between cycles — fake git and a fake supervisor
 * here — and `master status` says how far anything it runs lags the base tip. Each test is named
 * for the proof it produces: unit:loop-self-upgrade, unit:release-lag-visible and
 * unit:self-upgrade-under-load.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minute = 60_000, hour = 60 * minute;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hex = (letter: string) => letter.repeat(40);

async function fixture() {
  const root = await temporaryDirectory('loop-upgrade');
  const directory = await temporaryDirectory('loop-upgrade-credentials');
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const dispose = async () => { await rm(root, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); };
  return { root, directory, master, dispose };
}

/** A real one-commit repository, for the parts that run the shipped git reads. */
async function repository() {
  const root = await temporaryDirectory('loop-upgrade-repo');
  await writeFile(join(root, 'README.md'), 'first\n');
  git(root, 'init', '-q');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-q', '-m', 'first');
  return root;
}

/**
 * Fake git: the coordinator checkout is a detached checkout at `head`, `originTip` is what the
 * base branch's remote ref holds after a fetch, and every command is recorded so a test can
 * assert nothing touched the checkout.
 */
class FakeGit {
  head: string;
  originTip: string;
  branch: string | null = null;
  dirty = '';
  diffPaths: string[] = [];
  nextTip: string | null = null;
  checkoutTo: string | null = null;
  fetches = 0;
  /** While set, `merge-base --is-ancestor COMMIT RELEASE` answers from it, exiting 1 for "not contained" (GY-1585). */
  contains: ((commit: string, release: string) => boolean) | null = null;
  ancestryReads = 0;
  /** The commit each held snapshot directory is checked out at (GY-1585). */
  snapshots: Record<string, string> = {};
  constructor(head: string, originTip: string) { this.head = head; this.originTip = originTip; }
  run = async (command: string, args: string[]): Promise<string> => {
    assert.equal(command, 'git', `the upgrade runs git alone, asked for ${command}`);
    const rest = args.slice(2), op = rest[0], operands = rest.slice(1);
    if (op === 'rev-parse' && this.snapshots[args[1]]) return `${this.snapshots[args[1]]}\n`;
    if (op === 'rev-parse') return `${operands[0] === 'HEAD' ? this.head : this.originTip}\n`;
    if (op === 'symbolic-ref') {
      if (!this.branch) throw Object.assign(new Error('fatal: not a symbolic ref (use git branch --reason)'), { status: 1 });
      return this.branch;
    }
    if (op === 'status') return this.dirty;
    if (op === 'fetch') { this.fetches += 1; if (this.nextTip) this.originTip = this.nextTip; return ''; }
    if (op === 'diff') return `${this.diffPaths.join('\n')}\n`;
    if (op === 'checkout') { this.checkoutTo = operands[2]; this.head = operands[2]; this.branch = null; return ''; }
    if (op === 'merge-base' && operands[0] === '--is-ancestor' && this.contains) {
      this.ancestryReads += 1;
      if (this.contains(operands[1], operands[2])) return '';
      throw Object.assign(new Error('not an ancestor'), { status: 1 });
    }
    throw new Error(`fake git cannot answer: git ${rest.join(' ')}`);
  };
}

const verified = (sha: string): DaemonState['deployment'] =>
  deploymentObservationSchema.parse({ source: 'endpoint', sha, at: iso(0), reason: null, deployed: ['GY-1'], pending: [] });
const restarted = (to: string) => ({ result: 'restarted' as const, reason: null, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] });

/** `pins`: every pin of the CLI the checkout's launcher runs (GY-1585), null for a lift, with the executor restarts seen by then; `pinHeads`: the checkout's HEAD at each. */
interface UpgradeRecording { executors: (string | null)[]; self: number; persisted: number; pins: { commit: string | null; executors: number }[]; pinHeads: string[] }
const recording = (fake: FakeGit, root: string, behaviour: 'restart' | 'refuse' = 'restart'): { deps: () => Parameters<typeof performSelfUpgrade>[2]; calls: UpgradeRecording } => {
  const calls: UpgradeRecording = { executors: [], self: 0, persisted: 0, pins: [], pinHeads: [] };
  return {
    calls,
    deps: () => ({
      root,
      run: fake.run,
      restartExecutors: async to => {
        calls.executors.push(to);
        return behaviour === 'restart' ? restarted(to) : { ...restarted(to), result: 'refused' as const, reason: 'Restart refused while an executor on host-a holds a claimed action: exec-1 holds merge for GY-7' };
      },
      restartSelf: async () => { calls.self += 1; },
      persist: async () => { calls.persisted += 1; },
      holdCli: async commit => { calls.pins.push({ commit, executors: calls.executors.length }); calls.pinHeads.push(fake.head); },
      now: () => clock,
    }),
  };
};

test('unit:loop-self-upgrade — between cycles the loop checks out the verified deployed release: a src/ delivery restarts the executors and then itself, a docs-only delivery restarts nothing, and a dirty or non-detached checkout is never touched and is named instead', async () => {
  const { master, dispose } = await fixture();
  // A real checkout as deps.root: the loaded release is read from it with the shipped git.
  const checkout = await repository();
  try {
    const loaded = hex('a'), tip = hex('b'), newer = hex('c');
    const fake = new FakeGit(loaded, tip);
    fake.nextTip = tip;

    // A verified src/ delivery: the checkout moves to the base tip, the executors are restarted
    // against exactly that tip, and then the loop re-executes itself through its supervisor.
    fake.diffPaths = ['src/daemon/run.ts'];
    const src = emptyDaemonState(master);
    src.deployment = verified(tip);
    const code = recording(fake, checkout);
    const upgraded = await performSelfUpgrade(master, src, code.deps());
    assert.deepEqual({ outcome: upgraded.outcome, from: 'from' in upgraded && upgraded.from, to: 'to' in upgraded && upgraded.to, code: 'code' in upgraded && upgraded.code, self: 'self' in upgraded && upgraded.self },
      { outcome: 'upgraded', from: loaded, to: tip, code: true, self: true });
    assert.match(describeSelfUpgrade(upgraded), /checked out [0-9a-f]{12}; loaded code moved; executors restarted.*the loop re-executes itself/);
    assert.equal(fake.fetches, 1, 'the base branch was fetched once');
    assert.equal(fake.checkoutTo, tip, 'the checkout holds the new base tip');
    assert.deepEqual(code.calls.executors, [tip], 'the executors were restarted against exactly the checked-out tip, after it');
    assert.equal(code.calls.self, 1, 'and the loop re-executed itself last');
    assert.deepEqual(src.upgrade, { alignedRelease: tip, pending: null, last: { at: iso(0), from: loaded, to: tip, code: true, executors: 'restarted', self: true }, refused: null });
    assert.equal(src.release, null, 'the alignment never records a release: only a starting process records the one it loaded');
    const done = Object.values(src.actions).find(action => action.kind === 'config' && action.state === 'done');
    assert.match(done!.detail, /loaded code moved, the executors were restarted/);
    assert.ok(code.calls.persisted >= 3, 'the cursor was written as the upgrade progressed');

    // The same release is never aligned twice: the next between-cycles pass skips without a fetch.
    const again = recording(fake, checkout);
    const repeat = await performSelfUpgrade(master, src, again.deps());
    assert.equal(repeat.outcome, 'skipped');
    assert.equal(fake.fetches, 1, 'no second fetch');
    assert.deepEqual(again.calls.executors, []);

    // A newer release arrives with a docs-only diff: the checkout moves, and nothing is
    // restarted, because no running process executes what changed.
    fake.nextTip = newer;
    fake.diffPaths = ['docs/operations-reference.md', 'README.md'];
    const docs = emptyDaemonState(master);
    docs.deployment = verified(newer);
    docs.release = { commit: tip, dirty: false };
    const quiet = recording(fake, checkout);
    const docsOnly = await performSelfUpgrade(master, docs, quiet.deps());
    assert.equal(docsOnly.outcome, 'upgraded');
    assert.equal(docsOnly.outcome === 'upgraded' && docsOnly.code, false, 'a docs-only diff touches no loaded code');
    assert.equal(fake.checkoutTo, newer, 'the checkout still moves to the new tip');
    assert.deepEqual(quiet.calls.executors, [], 'the executors keep running');
    assert.equal(quiet.calls.self, 0, 'and so does the loop');
    assert.deepEqual(docs.upgrade, { alignedRelease: newer, pending: null, last: { at: iso(0), from: tip, to: newer, code: false, executors: null, self: false }, refused: null });

    // A dirty checkout is never touched: no checkout, no restart, and a refusal master status
    // names until the checkout clears.
    const dirtyState = emptyDaemonState(master);
    const dirtyTip = hex('d');
    fake.nextTip = dirtyTip;
    fake.dirty = ' M src/daemon/run.ts\n';
    dirtyState.deployment = verified(dirtyTip);
    dirtyState.release = { commit: newer, dirty: false };
    const held = recording(fake, checkout);
    const refusedDirty = await performSelfUpgrade(master, dirtyState, held.deps());
    assert.deepEqual({ outcome: refusedDirty.outcome, commit: refusedDirty.outcome === 'refused' ? refusedDirty.commit : null }, { outcome: 'refused', commit: newer });
    assert.equal(fake.checkoutTo, newer, 'the checkout was not moved');
    assert.deepEqual(held.calls.executors, [], 'and nothing was restarted');
    assert.match(dirtyState.upgrade.refused!.reason, /tracked files differ from the commit it holds/);
    const named = dirtyState.actions['upgrade:refused'];
    assert.equal(named?.state, 'failed');
    assert.match(named!.detail, /left the coordinator checkout at [0-9a-f]{12} untouched/);

    // A checkout on a branch is not a detached one: refused the same way, before anything runs.
    fake.dirty = '';
    fake.branch = 'refs/heads/main';
    const branched = emptyDaemonState(master);
    branched.deployment = verified(dirtyTip);
    const heldBranch = recording(fake, checkout);
    const refusedBranch = await performSelfUpgrade(master, branched, heldBranch.deps());
    assert.equal(refusedBranch.outcome, 'refused');
    assert.match(refusedBranch.outcome === 'refused' ? refusedBranch.reason : '', /HEAD holds refs\/heads\/main instead of standing detached/);
    assert.equal(fake.checkoutTo, newer, 'still never touched');
    fake.branch = null;

    // No verified deployment, no upgrade: not even a fetch.
    const unverified = emptyDaemonState(master);
    unverified.deployment = deploymentObservationSchema.parse({ source: 'unavailable', sha: null, at: iso(0), reason: 'no deployment endpoint', deployed: [], pending: [] });
    const idle = recording(fake, checkout);
    assert.equal((await performSelfUpgrade(master, unverified, idle.deps())).outcome, 'skipped');
    assert.equal(fake.fetches, 4, 'the skip fetched nothing: one alignment each for src, docs, dirty and branch');

    // The fleet busy: the checkout has moved, the restart is refused, the owed restarts stay on
    // the cursor, and the next pass — the claims settled — finishes them in order.
    fake.nextTip = hex('e');
    const busyTip = hex('e');
    const busy = emptyDaemonState(master);
    busy.deployment = verified(busyTip);
    busy.release = { commit: dirtyTip, dirty: false };
    fake.diffPaths = ['src/daemon/run.ts'];
    const refusedFleet = recording(fake, checkout, 'refuse');
    const blocked = await performSelfUpgrade(master, busy, refusedFleet.deps());
    assert.equal(blocked.outcome, 'pending', 'a refused fleet restart is owed, not failed (GY-916)');
    assert.match(blocked.outcome === 'pending' ? blocked.reason : '', /the executors were not restarted: .*exec-1 holds merge for GY-7/);
    assert.equal(fake.checkoutTo, busyTip, 'the checkout moved before the refused restart');
    assert.deepEqual(busy.upgrade.pending, { from: newer, to: busyTip, code: true }, 'the restarts stay owed on the cursor');
    assert.equal(busy.upgrade.alignedRelease, null, 'and the release is not marked aligned');
    const settled = recording(fake, checkout);
    const finished = await performSelfUpgrade(master, busy, settled.deps());
    assert.equal(finished.outcome, 'upgraded');
    assert.deepEqual(settled.calls.executors, [busyTip], 'the retry restarts the fleet first');
    assert.equal(settled.calls.self, 1, 'then re-executes the loop');
    assert.deepEqual(busy.upgrade.pending, null);
    assert.equal(busy.upgrade.alignedRelease, busyTip);
    assert.equal(fake.fetches, 6, 'each pass fetches the base branch it aligns with');

    // A restart still owed when a newer, docs-only tip arrives stays owed: the fleet still runs the
    // code the earlier src/ move replaced, so the docs-only move restarts it.
    const owedTip = hex('9'), owedDocsTip = hex('8');
    const owing = emptyDaemonState(master);
    fake.nextTip = owedTip;
    owing.deployment = verified(owedTip);
    fake.diffPaths = ['src/daemon/run.ts'];
    assert.equal((await performSelfUpgrade(master, owing, recording(fake, checkout, 'refuse').deps())).outcome, 'pending');
    assert.equal(owing.upgrade.pending?.code, true);
    fake.nextTip = owedDocsTip;
    owing.deployment = verified(owedDocsTip);
    fake.diffPaths = ['docs/operations-reference.md'];
    const carried = recording(fake, checkout);
    const owedDone = await performSelfUpgrade(master, owing, carried.deps());
    assert.equal(owedDone.outcome === 'upgraded' && owedDone.code, true, 'the owed restart carried over the docs-only move');
    assert.deepEqual(carried.calls.executors, [owedDocsTip], 'the fleet restarts against the newest tip');
    assert.equal(carried.calls.self, 1);
    fake.diffPaths = ['src/daemon/run.ts'];

    // A loop no supervisor unit runs cannot re-execute itself: it says so, names the release it
    // is stuck on, and never marks the alignment done silently.
    const alone = emptyDaemonState(master);
    const aloneTip = hex('f');
    fake.nextTip = aloneTip;
    alone.deployment = verified(aloneTip);
    alone.release = { commit: busyTip, dirty: false };
    let selfThrew = 0;
    const unsupervised = await performSelfUpgrade(master, alone, {
      root: '/srv/graphyard', run: fake.run,
      restartExecutors: async to => restarted(to),
      restartSelf: async () => { selfThrew += 1; throw new Error('this loop runs under no graphyard-master supervisor unit, so it cannot re-execute itself'); },
      persist: async () => {}, now: () => clock,
    });
    assert.equal(unsupervised.outcome, 'failed');
    assert.match(unsupervised.outcome === 'failed' ? unsupervised.reason : '', /could not re-execute itself through its supervisor/);
    assert.equal(selfThrew, 1);
    assert.match([...Object.values(alone.actions)].at(-1)!.detail, /keeps running [0-9a-f]{12} until its supervisor restarts it/);

    // The wiring: runDaemon performs the upgrade between the cycle and its wait, never mid-cycle —
    // through the shipped performSelfUpgrade here. The process before it loaded the first commit
    // and persisted it on the cursor; the checkout then moved (the upgrade this feature performs)
    // and a new process starts from that persisted cursor. It reports the release it loaded, never
    // the one the cursor carried over.
    const repo = await repository();
    try {
      const previous = git(repo, 'rev-parse', 'HEAD');
      const persisted = emptyDaemonState(master);
      persisted.release = { commit: previous, dirty: false };
      await writeDaemonState(master, persisted);
      git(repo, 'commit', '-q', '--allow-empty', '-m', 'the delivery the loop upgraded to');
      const moved = git(repo, 'rev-parse', 'HEAD');
      const state = await readDaemonState(repo, master);
      assert.deepEqual(state.release, { commit: previous, dirty: false }, 'the cursor carries the previous process\'s release');
      let upgradedBetweenCycles = 0;
      const effects = {
        snapshot: async () => ({ work: [], now: iso(0) }),
        agents: () => [],
        credentials: async () => ({}),
        observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'none', deployed: [], pending: [] }),
        requestSmoke: async () => {}, merge: async () => {}, recordDeployment: async () => {}, requestProof: async () => {},
        dispatch: async () => {}, recordSession: async () => {}, closeSession: () => {},
        persist: (written: DaemonState) => writeDaemonState(master, written),
        loadedRelease: readRelease(repo),
        selfUpgrade: async () => {
          upgradedBetweenCycles += 1;
          return performSelfUpgrade(master, state, { root: repo, run: async (command, args) => execFileSync(command, args, { encoding: 'utf8' }), now: () => clock });
        },
      } as unknown as DaemonEffects;
      await runDaemon(master, state, effects, { once: true, intervalMs: 20_000, identity: { pid: process.pid, host: master.hostId } });
      assert.equal(upgradedBetweenCycles, 1, 'the upgrade ran once, after the cycle completed');
      assert.deepEqual(state.release, { commit: moved, dirty: false }, 'the new process recorded the release it loaded from the moved checkout');
      assert.deepEqual(daemonSummary(state, clock, 20_000).release, { commit: moved, dirty: false }, 'and the summary master status reads reports it');
      assert.deepEqual((await readDaemonState(repo, master)).release, { commit: moved, dirty: false }, 'the persisted cursor now carries it too');
      // A loop wired without its loaded release reports none rather than inheriting a stale one.
      const unrecorded = await readDaemonState(repo, master);
      unrecorded.release = { commit: previous, dirty: false };
      await runDaemon(master, unrecorded, { ...effects, selfUpgrade: undefined, loadedRelease: undefined } as DaemonEffects, { once: true, intervalMs: 20_000, identity: { pid: process.pid, host: master.hostId } });
      assert.equal(unrecorded.release, null);
    } finally { await rm(repo, { recursive: true, force: true }); }
  } finally { await dispose(); await rm(checkout, { recursive: true, force: true }); }
});

const registration = (master: MasterConfig, name: string, commit: string, startedAt: string, overrides: Partial<ExecutorRegistration> = {}): ExecutorRegistration => ({
  version: 1, name, host: master.hostId, pid: process.pid, principal: 'graphyard-master', kinds: ['resync'], intervalSeconds: 5, root: '/srv/graphyard',
  release: { commit, dirty: false }, supervisor: { unit: `graphyard-executor@${name}.service`, restart: `systemctl --user restart graphyard-executor@${name}.service` },
  state: 'running', standDown: null, startedAt, updatedAt: startedAt, stoppedAt: null, claims: 1, lastClaim: null, inFlight: null, claiming: null, ...overrides });

const delivered = (key: string, mergeSha: string, mergedAt: string) => ({
  id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [],
  policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'done', revision: 1, policyRevision: 1,
  createdAt: iso(-4 * hour), updatedAt: iso(0), stageEnteredAt: iso(-hour), ready: false, epoch: 0, lease: null, workspaces: [],
  candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
  gates: [], violations: [], delivery: { mergedAt, mergeSha, authorizationRevision: 1 },
} as unknown as Work);

test('unit:release-lag-visible — master status reports the release the loop and each executor loaded against the base tip, and names any component more than one delivery behind for over ten minutes', async () => {
  const { directory, master, dispose } = await fixture();
  // The coordinator checkout is a real repository, so the shipped ancestry read answers: `base`
  // is what the loop and one executor still run, and two deliveries were merged after it.
  const root = await repository();
  try {
    const base = git(root, 'rev-parse', 'HEAD');
    git(root, 'commit', '-q', '--allow-empty', '-m', 'delivery one');
    const deliveryOne = git(root, 'rev-parse', 'HEAD');
    git(root, 'commit', '-q', '--allow-empty', '-m', 'delivery two');
    const deliveryTwo = git(root, 'rev-parse', 'HEAD');
    git(root, 'update-ref', 'refs/remotes/origin/main', deliveryTwo);

    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms).toISOString();
    // The loop loaded `base` two hours ago; deliveries it misses merged an hour ago and twenty
    // minutes ago — more than one behind, for over the grace window.
    const state = emptyDaemonState(master);
    state.release = { commit: base, dirty: false };
    state.lock = { id: 'lock', pid: process.pid, host: master.hostId, startedAt: ago(2 * hour), heartbeatAt: new Date(now).toISOString() };
    state.upgrade.refused = { at: ago(5 * minute), reason: 'tracked files differ from the commit it holds; it is upgraded only clean', commit: base };
    await writeFile(join(directory, 'coordinator.daemon.json'), JSON.stringify(state));
    // One executor is current; one runs the same stale release as the loop; one misses exactly
    // one delivery, which is the ordinary merge-to-verification gap and is never named.
    await writeExecutorRegistration(master, registration(master, 'exec-current', deliveryTwo, ago(30 * minute)));
    await writeExecutorRegistration(master, registration(master, 'exec-stale', base, ago(3 * hour)));
    await writeExecutorRegistration(master, registration(master, 'exec-mid', deliveryOne, ago(3 * hour)));

    const masterApi = async (path: string) => path === 'work-snapshot' ? { work: [delivered('GY-1', deliveryOne, new Date(now - hour).toISOString()), delivered('GY-2', deliveryTwo, new Date(now - 20 * minute).toISOString())], now: new Date(now).toISOString() } : { decisions: [] };
    const report = await masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' } }, { commit: base });

    // The report: what each component loaded, against the base tip, with what each is missing.
    assert.equal(report.releaseLag.baseTip, deliveryTwo);
    const rows = Object.fromEntries(report.releaseLag.components.map(row => [row.component, row]));
    assert.deepEqual({ loop: rows['loop'].release.commit, current: rows['exec-current'].release.commit, stale: rows['exec-stale'].release.commit, mid: rows['exec-mid'].release.commit },
      { loop: base, current: deliveryTwo, stale: base, mid: deliveryOne });
    assert.deepEqual(rows['loop'].behind.map(entry => entry.key), ['GY-1', 'GY-2'], 'the loop misses both deliveries');
    assert.deepEqual(rows['exec-current'].behind, [], 'a current executor misses none');
    assert.deepEqual(rows['exec-mid'].behind.map(entry => entry.key), ['GY-2'], 'one delivery behind is the ordinary gap');

    // The attention: the loop and the stale executor are named; the mid one and the current one are not.
    const lagItems = report.attentionItems.filter(item => /more than one delivery behind/.test(item.text));
    assert.deepEqual(lagItems.map(item => item.subject).sort(), ['exec-stale', 'loop']);
    const loopItem = lagItems.find(item => item.subject === 'loop')!;
    assert.match(loopItem.text, new RegExp(`The master loop runs ${base.slice(0, 12)}, more than one delivery behind the base tip ${deliveryTwo.slice(0, 12)} since`));
    assert.match(loopItem.text, /GY-1, GY-2 merged and are not in what it loads/);
    assert.equal(loopItem.role, 'master', 'the master owns the fix; no human is asked');
    assert.match(loopItem.next, /systemctl --user restart graphyard-master/);
    const staleItem = lagItems.find(item => item.subject === 'exec-stale')!;
    assert.match(staleItem.next, /systemctl --user restart graphyard-executor@exec-stale\.service/);
    assert.ok(rows['loop'].late && rows['exec-stale'].late, 'both are past the grace window');
    assert.equal(rows['exec-mid'].late, false, 'one delivery behind is never late, however long it waits');
    assert.ok(report.counts.attention >= lagItems.length, 'the lag attention is counted');

    // The refused upgrade is named beside it, with the checkout and what clears it.
    const upgradeItems = report.attentionItems.filter(item => item.subject === 'upgrade');
    assert.equal(upgradeItems.length, 1);
    assert.match(upgradeItems[0].text, /left the coordinator checkout at [0-9a-f]{12} untouched: tracked files differ/);
    assert.match(upgradeItems[0].text, /clean, detached checkout of main/);
    assert.match(upgradeItems[0].next, new RegExp(`git -C ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} status --porcelain`));

    // The grace window is real: the same two-delivery lag inside ten minutes of when it began is
    // reported as lag and raises nothing.
    const real = async (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8' });
    const young = await releaseLag(deliveryTwo, [
      { key: 'GY-1', mergeSha: deliveryOne, mergedAt: new Date(now - 8 * minute).toISOString() },
      { key: 'GY-2', mergeSha: deliveryTwo, mergedAt: new Date(now - 2 * minute).toISOString() },
    ], [{ name: 'loop', label: 'The master loop', release: { commit: base, dirty: false }, startedAt: new Date(now - 9 * minute).toISOString(), restart: 'systemctl --user restart graphyard-master' }],
      { root, run: real, now, graceMs: releaseLagGraceMs });
    assert.deepEqual(young.components[0].behind.map(entry => entry.key), ['GY-1', 'GY-2']);
    assert.equal(young.components[0].late, false, 'began nine minutes ago: not yet named');
    assert.equal(young.attention.length, 0);
    const empty = await temporaryDirectory('loop-upgrade-empty');
    try {
      assert.equal(await readBaseTip(empty, 'main', real), null, 'a checkout that never fetched reads the tip as unknown');
    } finally { await rm(empty, { recursive: true, force: true }); }
    assert.deepEqual(upgradeRefusalAttention(null, root, 'main'), [], 'no refusal, no attention');
    assert.equal(upgradeRefusalAttention({ at: iso(0), reason: 'dirty', commit: base }, root, 'main')[0].subject, 'upgrade');
  } finally { await dispose(); await rm(root, { recursive: true, force: true }); }
});

/**
 * GY-1229: steady load against the shipped restart. The queue never runs dry — every claim the
 * control plane grants is a fresh action — so only the release guard's stand-down stops an
 * executor from holding work at every check. Each executor keeps a real registration through
 * executorRegistrar, the restart is the shipped restartExecutors with its held-claim refusal and
 * fence, and its supervisor is a fake that records any unit restarted while its executor still
 * holds an action: that record, not the fake's own logic, is what "never interrupted" asserts.
 */
const loadInputs: ActionRow['inputs'] = { kind: 'dispatch', epoch: 0, target: 'implementation', priority: 1, plannedFiles: [] };

interface LoadMember {
  name: string;
  unit: string;
  pid: number;
  loaded: string;
  inFlight: ActionRow | null;
  claimed: string[];
  settled: string[];
  standReasons: string[];
  effects: ExecutorEffects & { standingDown: () => boolean };
}

async function loadFleet(master: MasterConfig, fake: FakeGit, root: string, names: string[], options: { guarded: boolean } = { guarded: true }) {
  let issued = 0;
  // The control plane's live claims, by executor: what the real restart reads to refuse.
  const claims = new Map<string, ActionRow>();
  const members = new Map<string, LoadMember>();
  const interrupted: string[] = [], restartedUnits: string[] = [];

  const boot = async (name: string, pid: number) => {
    const unit = `graphyard-executor@${name}.service`, commit = fake.head;
    const registrar = executorRegistrar(master, { name, host: master.hostId, pid, principal: 'graphyard-master', kinds: ['dispatch'], intervalSeconds: 5, root, release: { commit, dirty: false }, supervisor: unit });
    const member: LoadMember = { name, unit, pid, loaded: commit, inFlight: null, claimed: [], settled: [], standReasons: [], effects: null! };
    const base: ExecutorEffects = {
      claim: async request => {
        issued += 1;
        const action: ActionRow = { id: `load-${issued}`, kind: 'dispatch', work: `work-GY-${2000 + issued}`, key: `GY-${2000 + issued}`, inputs: loadInputs, gate: 'build', refusal: null,
          reason: 'steady load', binding: 'dispatch:0', requestedBy: 'graphyard', requestedAt: iso(0), state: 'claimed',
          claim: { executor: request.executor, host: request.host, principal: 'graphyard-master', claimedAt: iso(0), expiresAt: iso(minute), attempt: 1 }, attempts: 1, history: [] };
        claims.set(request.executor, action);
        return { action, open: 1 };
      },
      settle: async (action, result, reason) => { claims.delete(action.claim!.executor); return { action, result, reason }; },
      handlers: {},
    };
    const guard: ReleaseGuard = {
      loaded: { commit, dirty: false },
      current: () => fake.head,
      standDown: detail => { member.standReasons.push(detail.reason); return registrar.standDown(detail); },
      resumed: registrar.resumed,
      claiming: registrar.claiming,
      fenced: () => readRestartFence(master),
      abandoned: registrar.abandoned,
      claimed: action => { member.inFlight = action; member.claimed.push(action.id); return registrar.claimed(action); },
      settled: action => { member.inFlight = null; member.settled.push(action.id); return registrar.settled(); },
    };
    // The control: the same executor without the release check, claiming whatever the queue offers.
    const unguarded = {
      ...base,
      standingDown: () => false,
      claim: async (request: Parameters<ExecutorEffects['claim']>[0]) => { const claimed = await base.claim(request); if (claimed.action) await guard.claimed!(claimed.action); return claimed; },
      settle: async (action: ActionRow, result: 'done' | 'failed', reason: string) => { try { return await base.settle(action, result, reason); } finally { await guard.settled!(action, result, reason); } },
    };
    member.effects = options.guarded ? releaseGuardedEffects(base, guard) : unguarded;
    members.set(name, member);
    await registrar.started();
    return member;
  };
  for (const [index, name] of names.entries()) await boot(name, 40_000 + index);

  // The supervisor: a restarted unit's new process loads whatever the checkout holds now.
  let booting: Promise<unknown> = Promise.resolve();
  const supervisor = (command: string, args: string[]) => {
    assert.deepEqual([command, args[0], args[1]], ['systemctl', '--user', 'restart'], `the restart runs the supervisor alone, asked for ${command} ${args.join(' ')}`);
    const member = [...members.values()].find(candidate => candidate.unit === args[2]);
    assert.ok(member, `restarted a unit no executor runs: ${args[2]}`);
    restartedUnits.push(member.name);
    if (member.inFlight) interrupted.push(`${member.name} was restarted holding ${member.inFlight.id}`);
    booting = booting.then(() => delay(5)).then(() => boot(member.name, member.pid + 1000));
    return '';
  };
  // The restart's clock advances by each wait it sleeps, so its held-claim wait (GY-916) runs out at
  // once in real time: a claim the test settles only between checks is still held at the deadline.
  let skew = 0;
  const restart = (to: string) => restartExecutors(master, {
    actions: async () => ({ queue: { executors: [...claims.keys()].map(executor => ({ executor, host: master.hostId, actions: 1 })) }, actions: [...claims.values()] }),
    coordinatorCommit: to, run: supervisor, alive: () => true, now: () => Date.now() + skew,
    sleep: ms => { skew += ms; return delay(Math.min(ms, 5)).then(() => {}); }, timeoutMs: 5_000,
  });
  const member = (name: string) => members.get(name)!;
  const claim = (name: string) => member(name).effects.claim({ host: master.hostId, executor: name, kinds: ['dispatch'] });
  /** Settle the action the executor holds, then ask the never-empty queue for the next one. */
  const settleAndClaim = async (name: string) => { await member(name).effects.settle(member(name).inFlight!, 'done', 'settled'); return claim(name); };
  return { member, claim, settleAndClaim, restart, interrupted, restartedUnits, granted: () => issued };
}

const upgradeDeps = (fake: FakeGit, root: string, restart: (to: string) => ReturnType<typeof restartExecutors>) => {
  const calls = { self: 0 };
  const deps: Parameters<typeof performSelfUpgrade>[2] = { root, run: fake.run, restartExecutors: restart, restartSelf: async () => { calls.self += 1; }, persist: async () => {}, now: () => clock };
  return { deps, calls };
};

test('unit:self-upgrade-under-load — with executors holding claimed actions at each check and settling between checks, self-upgrade completes within bounded cycles without interrupting claimed actions', async () => {
  const fixtures = [await fixture(), await fixture(), await fixture()];
  const checkout = await repository();
  try {
    const loaded = hex('a'), tip = hex('b');
    const moving = () => { const fake = new FakeGit(loaded, tip); fake.nextTip = tip; fake.diffPaths = ['src/daemon/run.ts']; return fake; };
    const upgradeState = (master: MasterConfig) => {
      const state = emptyDaemonState(master);
      state.deployment = verified(tip);
      state.release = { commit: loaded, dirty: false };
      return state;
    };

    // Two executors under steady load: each holds a claimed action, and one that settles before the
    // checkout moves is granted a fresh, different action at once.
    {
      const { master } = fixtures[0];
      const fake = moving();
      const fleet = await loadFleet(master, fake, checkout, ['exec-1', 'exec-2']);
      assert.equal((await fleet.claim('exec-1')).action?.id, 'load-1');
      assert.equal((await fleet.claim('exec-2')).action?.id, 'load-2');
      assert.equal((await fleet.settleAndClaim('exec-1')).action?.id, 'load-3', 'before the move, a settled executor takes a fresh action');
      assert.deepEqual(fleet.member('exec-1').settled, ['load-1']);
      const { deps, calls } = upgradeDeps(fake, checkout, fleet.restart);
      const state = upgradeState(master);

      // Cycle 1 moves the checkout; the real restart refuses on the control plane's live claims, and the
      // owed restart is recorded pending.
      const cycle1 = await performSelfUpgrade(master, state, deps);
      assert.equal(cycle1.outcome, 'pending', 'an owed restart stays pending on the cursor, not failed');
      assert.match(cycle1.outcome === 'pending' ? cycle1.reason : '', /exec-1 holds dispatch for GY-2003/);
      assert.match(cycle1.outcome === 'pending' ? cycle1.reason : '', /exec-2 holds dispatch for GY-2002/);
      assert.equal(fake.checkoutTo, tip, 'checkout moved to base tip');
      assert.deepEqual(state.upgrade.pending, { from: loaded, to: tip, code: true });
      assert.deepEqual(fleet.restartedUnits, [], 'no unit was restarted while an action was held');

      // exec-1 settles; the queue still offers work, and the moved checkout alone refuses it.
      const granted = fleet.granted();
      assert.equal((await fleet.settleAndClaim('exec-1')).action, null, 'no new action claimed on moved checkout');
      assert.equal(fleet.granted(), granted, 'the queue granted no claim after the move');
      assert.equal(fleet.member('exec-1').effects.standingDown(), true);
      assert.deepEqual(fleet.member('exec-1').standReasons, [staleReleaseReason({ commit: loaded, dirty: false }, tip)]);
      assert.equal((await readExecutorRegistration(master, 'exec-1'))?.state, 'standing-down');
      assert.equal((await fleet.claim('exec-1')).action, null, 'a standing executor keeps claiming nothing');
      assert.equal(fleet.granted(), granted);

      // Cycle 2: only exec-2's action holds the restart now.
      const cycle2 = await performSelfUpgrade(master, state, deps);
      assert.equal(cycle2.outcome, 'pending', 'an owed restart stays pending on the cursor, not failed');
      assert.match(cycle2.outcome === 'pending' ? cycle2.reason : '', /exec-2 holds dispatch for GY-2002/);
      assert.doesNotMatch(cycle2.outcome === 'pending' ? cycle2.reason : '', /exec-1 holds/);
      assert.deepEqual(state.upgrade.pending, { from: loaded, to: tip, code: true });
      assert.deepEqual(fleet.restartedUnits, []);

      assert.equal((await fleet.settleAndClaim('exec-2')).action, null);
      assert.equal(fleet.granted(), granted, 'the queue granted no claim after the move');
      assert.equal(fleet.member('exec-2').effects.standingDown(), true);

      // Cycle 3: nothing is held, so the real restart restarts both units, waits for each to
      // register on the tip, and the loop re-executes itself.
      const cycle3 = await performSelfUpgrade(master, state, deps);
      assert.equal(cycle3.outcome, 'upgraded', cycle3.outcome === 'failed' || cycle3.outcome === 'pending' ? cycle3.reason : '');
      assert.deepEqual({ to: cycle3.outcome === 'upgraded' && cycle3.to, code: cycle3.outcome === 'upgraded' && cycle3.code, self: cycle3.outcome === 'upgraded' && cycle3.self }, { to: tip, code: true, self: true });
      assert.equal(state.upgrade.pending, null);
      assert.equal(state.upgrade.alignedRelease, tip);
      assert.equal(calls.self, 1);
      assert.deepEqual(fleet.restartedUnits.sort(), ['exec-1', 'exec-2']);
      assert.deepEqual(fleet.interrupted, [], 'no unit was restarted while its executor held an action');
      const records = await readExecutorRegistrations(master);
      assert.deepEqual(records.map(record => ({ name: record.name, state: record.state, commit: record.release.commit, inFlight: record.inFlight })),
        [{ name: 'exec-1', state: 'running', commit: tip, inFlight: null }, { name: 'exec-2', state: 'running', commit: tip, inFlight: null }], 'each executor came back on the tip');
      // The new processes run the tip, so steady load resumes on it.
      assert.equal((await fleet.claim('exec-1')).action?.id, `load-${granted + 1}`);
    }

    // The automated driver: three busy executors, one settling between checks, converge in exactly
    // one cycle per executor plus the restart — and never by the queue running dry.
    {
      const { master } = fixtures[1];
      const fake = moving();
      const fleet = await loadFleet(master, fake, checkout, ['fleet-1', 'fleet-2', 'fleet-3']);
      for (const name of ['fleet-1', 'fleet-2', 'fleet-3']) assert.ok((await fleet.claim(name)).action);
      const { deps, calls } = upgradeDeps(fake, checkout, fleet.restart);
      const state = upgradeState(master);
      const offered = fleet.granted();
      let cycles = 0, outcome: SelfUpgradeOutcome | null = null;
      while (cycles < 10) {
        cycles += 1;
        outcome = await performSelfUpgrade(master, state, deps);
        if (outcome.outcome === 'upgraded') break;
        const busy = ['fleet-1', 'fleet-2', 'fleet-3'].find(name => fleet.member(name).inFlight);
        assert.ok(busy, `refused with nothing held: ${outcome.outcome === 'failed' || outcome.outcome === 'pending' ? outcome.reason : outcome.outcome}`);
        assert.equal((await fleet.settleAndClaim(busy)).action, null, 'stale executor claims nothing on moved checkout');
        assert.ok(fleet.member(busy).effects.standingDown(), 'executor stands down on moved checkout');
      }
      assert.equal(outcome?.outcome, 'upgraded', 'self-upgrade completed');
      assert.equal(cycles, 4, 'one refused check per busy executor, then the upgrade');
      assert.equal(fleet.granted(), offered, 'the queue granted no claim after the move');
      assert.deepEqual(fleet.interrupted, [], 'no claimed action was interrupted in automated driver');
      assert.deepEqual(fleet.restartedUnits.sort(), ['fleet-1', 'fleet-2', 'fleet-3']);
      assert.equal(calls.self, 1);
    }

    // The control: the same steady load without the stand-down. Every executor that settles claims
    // again, some action is always held, and the upgrade never converges — the guard, not an empty
    // queue, is what lets it finish. The real restart still interrupts nothing.
    {
      const { master } = fixtures[2];
      const fake = moving();
      const fleet = await loadFleet(master, fake, checkout, ['ctl-1', 'ctl-2', 'ctl-3'], { guarded: false });
      for (const name of ['ctl-1', 'ctl-2', 'ctl-3']) assert.ok((await fleet.claim(name)).action);
      const { deps, calls } = upgradeDeps(fake, checkout, fleet.restart);
      const state = upgradeState(master);
      for (let cycle = 1; cycle <= 8; cycle++) {
        const outcome = await performSelfUpgrade(master, state, deps);
        assert.equal(outcome.outcome, 'pending', `cycle ${cycle} upgraded under unbounded load`);
        const name = `ctl-${(cycle % 3) + 1}`;
        assert.ok((await fleet.settleAndClaim(name)).action, 'without the guard, an executor on the moved checkout claims again');
      }
      assert.deepEqual(state.upgrade.pending, { from: loaded, to: tip, code: true });
      assert.deepEqual(fleet.restartedUnits, []);
      assert.deepEqual(fleet.interrupted, []);
      assert.equal(calls.self, 0);
    }
  } finally {
    for (const { dispose } of fixtures) await dispose();
    await rm(checkout, { recursive: true, force: true });
  }
});

/**
 * GY-1400: the loop loads a base tip only once a verified production release serves it, and its
 * promotion drive dispatches at most every 120 minutes, so two or three merges inside one window
 * leave it more than one delivery behind for up to two hours by design. Fake git: a commit
 * contains a delivery only when it is that delivery's merge or a later one in `order`.
 */
const order = [hex('a'), hex('b'), hex('c'), hex('d')];
const ancestry = async (_command: string, args: string[]) => {
  const [mergeSha, commit] = args.slice(-2);
  if (order.indexOf(mergeSha) <= order.indexOf(commit)) return '';
  throw Object.assign(new Error('not an ancestor'), { status: 1 });
};
const windowNow = Date.parse('2026-10-07T03:10:36.678Z');
const windowDeliveries = [
  { key: 'GY-1365', mergeSha: hex('b'), mergedAt: '2026-10-07T02:01:46.000Z' },
  { key: 'GY-1385', mergeSha: hex('c'), mergedAt: '2026-10-07T02:01:46.000Z' },
  { key: 'GY-1398', mergeSha: hex('d'), mergedAt: '2026-10-07T02:40:00.000Z' },
];
const windowComponents = [
  { name: 'loop', label: 'The master loop', release: { commit: hex('a'), dirty: false }, startedAt: '2026-10-07T01:53:05.000Z', restart: 'systemctl --user restart graphyard-master (the loop also upgrades itself between cycles once a delivery is verified deployed)' },
  { name: 'graphyard-master@vishrog/1', label: 'Executor graphyard-master@vishrog/1', release: { commit: hex('a'), dirty: false }, startedAt: '2026-10-07T01:53:10.000Z', restart: 'systemctl --user restart graphyard-executor@1.service' },
];
const wait = (overrides: Partial<PromotionWait> = {}): PromotionWait => ({ deployedSha: hex('a'), alignedRelease: hex('a'), pending: ['GY-1365', 'GY-1385', 'GY-1398'], nextDueAt: '2026-10-07T03:41:53.113Z', inFlight: false, ...overrides });
const lagOf = (promotion: PromotionWait | null, now = windowNow) => releaseLag(hex('d'), windowDeliveries, windowComponents, { root: '/nonexistent', run: ancestry, now, promotion });

test('unit:release-lag-promotion-grace — deliveries inside one promotion window whose promotion is not yet due leave the loop and the executors not late, and the report names nextDueAt', async () => {
  for (const promotion of [wait(), wait({ nextDueAt: '2026-10-07T02:00:00.000Z', inFlight: true })]) {
    const report = await lagOf(promotion);
    for (const row of report.components) {
      assert.deepEqual(row.behind.map(entry => entry.key), ['GY-1365', 'GY-1385', 'GY-1398'], `${row.component} still reports what it has not loaded`);
      assert.deepEqual(row.awaitingPromotion, ['GY-1365', 'GY-1385', 'GY-1398']);
      assert.equal(row.late, false, `${row.component} waits on the promotion, on schedule`);
    }
    assert.deepEqual(report.attention, [], 'no loop-liveness attention is raised');
    assert.equal(report.promotion?.nextDueAt, promotion.nextDueAt, 'the report names the promotion\'s nextDueAt');
    assert.equal(report.promotion?.onSchedule, true);
  }

  // The ordinary grace stands for what a verified release already serves: two served deliveries
  // the loop has not loaded past ten minutes are named, whatever else waits on the promotion.
  const partly = await lagOf(wait({ pending: ['GY-1398'] }));
  assert.equal(partly.components[0].late, true);
  assert.deepEqual(partly.components[0].awaitingPromotion, ['GY-1398']);
  // An overdue promotion with no candidate in validation is no longer the window.
  assert.equal((await lagOf(wait({ nextDueAt: '2026-10-07T03:00:00.000Z' }))).components[0].late, true);
  // No promotion wait on the cursor: the lag is named exactly as before.
  const unread = await lagOf(null);
  assert.ok(unread.components.every(row => row.late));
  assert.equal(unread.promotion, null);
  // An unavailable observation verified no release and lists every delivery as pending: it grants
  // no grace, however soon the promotion is due, so the lag is named exactly as with no cursor.
  const unavailable = promotionWait({ deployment: { source: 'unavailable', sha: null, pending: ['GY-1365', 'GY-1385', 'GY-1398'] }, promotion: { nextDueAt: wait().nextDueAt, inFlight: true }, upgrade: { alignedRelease: hex('a') } });
  assert.equal(unavailable, null);
  const unverified = await lagOf(unavailable);
  assert.ok(unverified.components.every(row => row.late && !row.awaitingPromotion.length));
  assert.equal(unverified.attention.length, 2);
  assert.ok(promotionWait({ deployment: { source: 'endpoint', sha: hex('a'), pending: [] }, promotion: null }));
});

test('unit:loop-lag-remedy-names-promotion — a loop aligned with the verified deployment is never told to restart: the lag text and the loaded-revision detail name the promotion and its due time', async () => {
  // On schedule: nothing is raised at all, so nothing prescribes a restart.
  assert.deepEqual((await lagOf(wait())).attention, []);
  // Overdue: still named, but the remedy is the promotion, never a host restart onto the same release.
  const overdue = wait({ nextDueAt: '2026-10-07T03:00:00.000Z' });
  const late = await lagOf(overdue);
  assert.equal(late.attention.length, 2);
  for (const item of late.attention) {
    assert.match(item.text, /runs the verified release production serves, and GY-1365, GY-1385, GY-1398 wait on the promotion due 2026-10-07T03:00:00.000Z/);
    assert.doesNotMatch(item.next!, /systemctl --user restart/);
    assert.match(item.next!, /Nothing to restart: .* already runs a{12}, the release production serves/);
    assert.match(item.next!, /the promotion due 2026-10-07T03:00:00.000Z has passed with no candidate in validation/);
  }
  // Not aligned with the deployment: the loop has a release to load, and the restart stays its remedy.
  const unaligned = await lagOf(wait({ nextDueAt: '2026-10-07T03:00:00.000Z', deployedSha: hex('d'), pending: [] }));
  assert.match(unaligned.attention.find(item => item.subject === 'loop')!.next!, /systemctl --user restart graphyard-master/);

  // The loaded-revision detail, from the same cursor, names the promotion and its due time.
  const cursor = { upgrade: { alignedRelease: hex('a'), pending: null }, deployment: { sha: hex('a'), pending: wait().pending }, promotion: { nextDueAt: wait().nextDueAt, inFlight: false }, actions: {} };
  const reading = readResources({ now: windowNow, reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, disk: null, profiles: { workers: [], reviewers: [], producers: [] },
    revision: { behind: 3, loaded: hex('a'), checkout: hex('d'), movedAt: windowNow - hour }, upgrade: owedUpgrade(cursor) }).find(entry => entry.id === 'loaded-revision')!;
  assert.match(reading.detail!, /wait on the promotion due 2026-10-07T03:41:53\.113Z: no restart is owed/);
  assert.doesNotMatch(reading.detail!, /systemctl --user restart/);
  assert.deepEqual(resourceAttention([reading]), []);
});

/**
 * GY-1585: the self-upgrade re-executed the loop onto a merged tip before the promoted release
 * served it, so the coordinator's registry selects spoke a schema the serving plane still refused
 * (400 Invalid input on every launch, 2026-10-09T11:32:44Z..11:40Z). A loaded-code move production is
 * observed not serving yet is checked out but its restarts are held, named, until a pass serves it.
 */
const releaseLagged = (served: string) => {
  const loaded = hex('a'), tip = hex('b'), newer = hex('c');
  const fake = new FakeGit(loaded, tip);
  // A history a, b, c: a release contains itself and every commit before it.
  const order = [loaded, tip, newer];
  fake.contains = (commit, release) => order.indexOf(commit) <= order.indexOf(release);
  fake.diffPaths = ['src/model/registry.ts'];
  const state = emptyDaemonState(masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/nonexistent/coordinator.token', cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] }));
  state.release = { commit: loaded, dirty: false };
  state.deployment = verified(served);
  return { loaded, tip, newer, fake, state };
};

test('unit:self-upgrade-waits-for-served-release — with production serving release A and a fetched base tip B touching loaded code, the alignment checks out B but restarts neither the executors nor itself under a waiting release-lagged stall, and the pass whose observation serves B completes the restart', async () => {
  const { master, dispose } = await fixture();
  try {
    const { loaded, tip, newer, fake, state } = releaseLagged(hex('a'));
    const { deps, calls } = recording(fake, '/srv/graphyard');
    const held = await performSelfUpgrade(master, state, deps());
    assert.equal(held.outcome, 'pending');
    assert.equal(fake.checkoutTo, tip, 'the checkout moves to the merged tip');
    assert.deepEqual(calls.executors, [], 'the executors are not restarted onto code the plane does not serve');
    assert.equal(calls.self, 0, 'nor does the loop re-execute itself');
    assert.deepEqual(state.upgrade.pending, { from: loaded, to: tip, code: true }, 'the restart stays owed on the cursor');
    assert.equal(state.upgrade.stalled?.cause, 'release-lagged');
    assert.equal(state.actions['upgrade:held']?.state, 'waiting');
    assert.equal(state.actions[`upgrade:${loaded}`]?.state, 'done', 'the release\'s own row records the checkout move, not a hold');
    assert.equal(state.upgrade.alignedRelease, null, 'the release is not aligned while its restart is held');
    // The checkout already holds B, so every CLI process the loop and the executors spawn through the
    // checkout's launcher is pinned to the release production serves for as long as the hold stands.
    assert.deepEqual(calls.pins, [{ commit: loaded, executors: 0 }], 'the spawned CLI is pinned to the served release A');
    assert.deepEqual(calls.pinHeads, [loaded], 'pinned before the checkout moves: an executor rereading the commit before a claim never sees B unpinned, so none stands down onto it');

    // Still serving A a cycle later while main moved on to C: held again on the same target, with no
    // fetch, no restart, the stall's first instant kept and the one held row refreshed, not grown.
    const since = state.upgrade.stalled!.since, attempts = state.actions['upgrade:held']!.attempts, fetchedBefore = fake.fetches;
    fake.nextTip = newer;
    assert.equal((await performSelfUpgrade(master, state, { ...deps(), now: () => clock + 5 * minute })).outcome, 'pending');
    assert.deepEqual([calls.executors, calls.self], [[], 0]);
    assert.equal(state.upgrade.stalled?.since, since);
    assert.equal(fake.fetches, fetchedBefore, 'a held target is not advanced to a newer tip while production lags');
    assert.deepEqual(state.upgrade.pending, { from: loaded, to: tip, code: true });
    assert.equal(fake.head, tip);
    assert.equal(state.actions['upgrade:held']!.attempts, attempts, 'a standing hold grows no attempts');
    assert.equal(state.actions['upgrade:held']!.at, new Date(clock + 5 * minute).toISOString(), 'its time is the latest held pass');

    // The deploy goes live serving B while main already moved on to C: the owed restart onto B
    // completes, before any newer tip is fetched, so a busy base branch cannot hold the loop forever.
    state.deployment = verified(tip);
    const fetched = fake.fetches;
    const done = await performSelfUpgrade(master, state, { ...deps(), now: () => clock + 8 * minute });
    assert.deepEqual({ outcome: done.outcome, to: 'to' in done && done.to, self: 'self' in done && done.self }, { outcome: 'upgraded', to: tip, self: true });
    assert.deepEqual(calls.executors, [tip], 'the executors restart onto exactly B');
    assert.equal(calls.self, 1, 'and the loop re-executes itself onto it');
    assert.equal(fake.fetches, fetched, 'no newer tip was fetched first');
    assert.deepEqual(calls.pins.at(-1), { commit: null, executors: 0 }, 'the pin is lifted before the executors restart onto B, so what they spawn loads B with them');
    assert.equal(state.upgrade.pending, null);
    assert.equal(state.upgrade.stalled, undefined, 'the stall retires with the restart');
    assert.equal(state.upgrade.alignedRelease, tip);
    // The hold's row is settled by the pass that lifted it, naming the release that serves the move:
    // no waiting row is left claiming production still serves A.
    assert.equal(state.actions['upgrade:held']?.state, 'done');
    assert.match(state.actions['upgrade:held']!.detail, new RegExp(`^The restart onto ${tip.slice(0, 12)} is no longer held: production serves release ${tip.slice(0, 12)}, which contains ${tip.slice(0, 12)}`));
    assert.deepEqual(Object.entries(state.actions).filter(([key, action]) => key.startsWith('upgrade:') && action.state === 'waiting'), [], 'no upgrade row is left waiting');
  } finally { await dispose(); }
});

test('unit:self-upgrade-waits-for-served-release — while the restart is held, every command the checkout\'s launcher runs loads the served release A, with the checkout\'s own entry kept as its argv, and lifting the hold returns them to the checkout\'s B', async () => {
  // A real checkout holding B with A in its history, and the shipped launcher beside it: what the
  // loop and the executors spawn through config.cliPath (watch, claim, heartbeat, push-credential).
  const root = await temporaryDirectory('held-cli');
  try {
    const cli = (release: string) => `import { z } from 'zod';\nexport const release: string = '${release}';\nconsole.log(JSON.stringify({ release, argv: process.argv[1], schema: typeof z }));\n`;
    await mkdir(join(root, 'src', 'daemon'), { recursive: true });
    await writeFile(join(root, 'src', 'cli.ts'), cli('A0'));
    await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
    git(root, 'init', '-q');
    git(root, 'add', 'src', 'package.json');
    git(root, 'commit', '-q', '-m', 'release A0, from before the hold');
    const preceding = git(root, 'rev-parse', 'HEAD');
    // A release whose loop reads the hold's cursor: its stall causes name release-lagged.
    await writeFile(join(root, 'src', 'cli.ts'), cli('A'));
    await writeFile(join(root, 'src', 'daemon', 'state.ts'), "export const upgradeStallCauses = ['checkout-failed', 'release-lagged'] as const;\n");
    git(root, 'add', 'src');
    git(root, 'commit', '-q', '-m', 'release A');
    const served = git(root, 'rev-parse', 'HEAD');
    await writeFile(join(root, 'src', 'cli.ts'), cli('B'));
    git(root, 'commit', '-q', '-am', 'tip B');
    git(root, 'checkout', '-q', '--detach');
    const tip = git(root, 'rev-parse', 'HEAD');
    await mkdir(join(root, 'bin'));
    for (const file of ['graphyard.mjs', 'held-release-hooks.mjs']) await writeFile(join(root, 'bin', file), await readFile(fileURLToPath(new URL(`../bin/${file}`, import.meta.url))));
    await symlink(fileURLToPath(import.meta.resolve('tsx')).replace(/\/node_modules\/.*$/, '/node_modules'), join(root, 'node_modules'), 'dir');
    const launch = (...args: string[]) => JSON.parse(execFileSync(process.execPath, [join(root, 'bin', 'graphyard.mjs'), ...args], { encoding: 'utf8' }));
    const run = async (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8' });
    const entry = join(root, 'src', 'cli.ts');
    assert.deepEqual(launch('status'), { release: 'B', argv: entry, schema: 'object' }, 'unpinned, the launcher runs the checkout');

    await holdCliAt(root, run, served);
    assert.equal(JSON.parse(await readFile(heldCliPointer(root), 'utf8')).commit, served);
    assert.deepEqual(launch('watch', 'GY-1', '1'), { release: 'A', argv: entry, schema: 'object' }, 'pinned, a spawned command loads release A, its argv still the checkout entry its confinement is derived from');
    assert.deepEqual(launch('heartbeat', 'GY-1', '1'), { release: 'A', argv: entry, schema: 'object' });
    assert.deepEqual(launch('master', 'run'), { release: 'A', argv: entry, schema: 'object' }, 'a loop its supervisor restarts during the hold loads A too, since A\'s loop reads the hold\'s cursor; the deliberate restart comes after the lift');
    assert.equal(git(root, 'status', '--porcelain', '--untracked-files=no'), '', 'pinning leaves the checkout clean');
    assert.equal(git(root, 'rev-parse', 'HEAD'), tip, 'and at B');
    await holdCliAt(root, run, served);
    assert.equal(launch('status').release, 'A', 'pinning the same release again keeps the pin');

    // A served release from before the hold would refuse the cursor's release-lagged stall (its
    // strict schema throws before the loop starts) and restart onto B unheld: a restarted loop runs
    // the checkout's B, which holds, while every other command still loads the served release.
    await holdCliAt(root, run, preceding);
    assert.equal(JSON.parse(await readFile(heldCliPointer(root), 'utf8')).loop, false);
    assert.deepEqual(launch('master', 'run'), { release: 'B', argv: entry, schema: 'object' }, 'a restarted loop stays on the checkout when the snapshot cannot read the hold');
    assert.deepEqual(launch('watch', 'GY-1', '1'), { release: 'A0', argv: entry, schema: 'object' }, 'spawned commands still load the served release');

    await holdCliAt(root, run, null);
    assert.deepEqual(launch('watch', 'GY-1', '1'), { release: 'B', argv: entry, schema: 'object' }, 'lifted, spawned commands load the checkout\'s B again');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:self-upgrade-waits-for-served-release — a supervised executor compares its release against the pin while one stands: the hold moving the checkout to B stands no slot down onto B, a slot started during the hold loads the served snapshot, and the lift stands it down onto B', async () => {
  const root = await temporaryDirectory('held-executor');
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'cli.ts'), 'export {};\n');
    git(root, 'init', '-q');
    git(root, 'add', 'src');
    git(root, 'commit', '-q', '-m', 'release A');
    const served = git(root, 'rev-parse', 'HEAD');
    await writeFile(join(root, 'src', 'cli.ts'), 'export const b = 1;\n');
    git(root, 'commit', '-q', '-am', 'tip B');
    const tip = git(root, 'rev-parse', 'HEAD');
    git(root, 'checkout', '-q', '--detach', served);
    const run = async (command: string, args: string[]) => execFileSync(command, args, { encoding: 'utf8' });
    // @ts-expect-error The standalone executor is a dependency-free entry point script.
    const { executorRelease, load } = await import('../scripts/graphyard-executor.mjs');
    // @ts-expect-error The launcher's hooks module is a dependency-free entry point script.
    const { heldRelease } = await import('../bin/held-release-hooks.mjs');
    const checkout = pathToFileURL(`${root}/`);

    // A slot started on the checkout before the hold loaded A; the hold pins A, then moves the checkout to B.
    const before = executorRelease(root, heldRelease(checkout), { readRelease, readCommit });
    assert.deepEqual(before.release, { commit: served, dirty: false });
    await holdCliAt(root, run, served);
    git(root, 'checkout', '-q', '--detach', tip);
    assert.equal(before.current(), served, 'the slot\'s checkout reads as the pinned A: it keeps claiming and does not stand down onto B');

    // A slot its supervisor starts during the hold loads the snapshot's modules and runs A.
    const held = heldRelease(checkout);
    assert.ok(held && held.commit === served && fileURLToPath(held.to).startsWith(join(root, '.graphyard', 'held-cli')));
    const during = executorRelease(root, held, { readRelease, readCommit });
    assert.deepEqual([during.release, during.current()], [{ commit: served, dirty: false }, served]);
    await assert.rejects(load(held), (error: Error) => error.message.includes(fileURLToPath(new URL('src/master.ts', held!.to))), 'its modules resolve inside the held snapshot, not the checkout');

    // The lift: the checkout's own commit B is what every slot compares against, so they stand down onto B.
    await holdCliAt(root, run, null);
    assert.equal(before.current(), tip);
    assert.equal(during.current(), tip);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unit:self-upgrade-waits-for-served-release — a loop its supervisor restarts during the hold runs the held snapshot of A, is recorded as running A though the checkout holds B, and still re-executes onto B once production serves it', async () => {
  const { master, dispose } = await fixture();
  try {
    const { loaded, tip, fake, state } = releaseLagged(hex('a'));
    const { deps, calls } = recording(fake, '/srv/graphyard');
    assert.equal((await performSelfUpgrade(master, state, deps())).outcome, 'pending');
    // The restarted process read its release from the checkout, at B, but loaded the snapshot's modules.
    const snapshot = join('/srv/graphyard', '.graphyard', 'held-cli', loaded.slice(0, 12));
    fake.snapshots[snapshot] = loaded;
    state.release = { commit: tip, dirty: false };
    const restarted = { ...deps(), loadedFrom: join(snapshot, 'src', 'daemon', 'upgrade.ts') };
    assert.equal((await performSelfUpgrade(master, state, restarted)).outcome, 'pending');
    assert.deepEqual(state.release, { commit: loaded, dirty: false }, 'the loop is recorded as running the served release it loaded');
    assert.deepEqual([calls.executors, calls.self], [[], 0], 'and the restart stays held');

    state.deployment = verified(tip);
    const done = await performSelfUpgrade(master, state, restarted);
    assert.deepEqual({ outcome: done.outcome, self: 'self' in done && done.self }, { outcome: 'upgraded', self: true }, 'the lifted hold re-executes it onto B rather than taking it for a loop already running B');
    assert.deepEqual(calls.executors, [tip]);
    assert.equal(calls.self, 1);

    // A loop loaded from the checkout itself keeps the release it read.
    const own = releaseLagged(hex('a'));
    own.fake.snapshots[snapshot] = loaded;
    own.state.release = { commit: tip, dirty: false };
    await performSelfUpgrade(master, own.state, { ...recording(own.fake, '/srv/graphyard').deps(), loadedFrom: '/srv/graphyard/src/daemon/upgrade.ts' });
    assert.deepEqual(own.state.release, { commit: tip, dirty: false });
  } finally { await dispose(); }
});

test('unit:upgrade-stall-names-release-lag — the held restart\'s stall, its action line and master status name the served release and the awaited commit, reading as a deliberate hold, not a stuck loop', async () => {
  const { master, dispose } = await fixture();
  try {
    const { loaded, tip, fake, state } = releaseLagged(hex('a'));
    const { deps } = recording(fake, '/srv/graphyard');
    const held = await performSelfUpgrade(master, state, deps());
    const served = loaded.slice(0, 12), awaited = tip.slice(0, 12);
    const names = new RegExp(`production serves release ${served}, which does not contain ${awaited} yet; the executors and the loop restart onto ${awaited} on the first pass whose deployment observation serves it`);
    assert.match(state.upgrade.stalled!.reason, names, 'the stall names both commits');
    assert.match(state.actions['upgrade:held']!.detail, names, 'and so does its waiting action');
    assert.match(describeSelfUpgrade(held), new RegExp(`^pending at ${awaited}: restart held: production serves release ${served}`), 'the loop\'s log line too');
    // The loaded-revision resource master status reads: within headroom, naming the held restart.
    const reading = readResources({ now: clock, reviews: [], producers: [], agents: [], work: [], plane: null, loop: null, disk: null, profiles: { workers: [], reviewers: [], producers: [] },
      revision: { behind: 1, loaded, checkout: tip, movedAt: clock - hour }, upgrade: owedUpgrade(state) }).find(entry => entry.id === 'loaded-revision')!;
    assert.equal(reading.used, 0, 'a deliberately held restart is not a fault');
    assert.match(reading.detail!, /stalled on release-lagged since 2030-01-01T12:00:00\.000Z/);
    assert.match(reading.detail!, names);
    assert.deepEqual(resourceAttention([reading]), []);
  } finally { await dispose(); }
});

test('unit:docs-only-alignment-unaffected — a move touching no loaded code completes while production still serves the earlier release: nothing restarts, nothing is held, no stall is named', async () => {
  const { master, dispose } = await fixture();
  try {
    const { loaded, tip, fake, state } = releaseLagged(hex('a'));
    fake.diffPaths = ['docs/deployment.md'];
    const { deps, calls } = recording(fake, '/srv/graphyard');
    const upgraded = await performSelfUpgrade(master, state, deps());
    assert.deepEqual(upgraded, { outcome: 'upgraded', from: loaded, to: tip, code: false, executors: null, self: false });
    assert.equal(fake.checkoutTo, tip);
    assert.deepEqual([calls.executors, calls.self], [[], 0]);
    assert.equal(state.upgrade.pending, null);
    assert.equal(state.upgrade.stalled, undefined);
    assert.equal(state.upgrade.alignedRelease, loaded);
    assert.equal(fake.ancestryReads, 0, 'a docs-only move never asks whether production serves it');
  } finally { await dispose(); }
});
