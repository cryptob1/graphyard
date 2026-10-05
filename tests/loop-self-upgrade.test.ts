import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import { daemonSummary, deploymentObservationSchema, emptyDaemonState, readDaemonState, runDaemon, writeDaemonState, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { describeSelfUpgrade, performSelfUpgrade, type SelfUpgradeOutcome } from '../src/daemon/upgrade.js';
import { releaseLag, readBaseTip, releaseLagGraceMs, upgradeRefusalAttention } from '../src/master/release-lag.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { readRelease, writeExecutorRegistration, type ExecutorRegistration } from '../src/executor-fleet.js';
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
  constructor(head: string, originTip: string) { this.head = head; this.originTip = originTip; }
  run = async (command: string, args: string[]): Promise<string> => {
    assert.equal(command, 'git', `the upgrade runs git alone, asked for ${command}`);
    const rest = args.slice(2), op = rest[0], operands = rest.slice(1);
    if (op === 'rev-parse') return `${operands[0] === 'HEAD' ? this.head : this.originTip}\n`;
    if (op === 'symbolic-ref') {
      if (!this.branch) throw Object.assign(new Error('fatal: not a symbolic ref (use git branch --reason)'), { status: 1 });
      return this.branch;
    }
    if (op === 'status') return this.dirty;
    if (op === 'fetch') { this.fetches += 1; if (this.nextTip) this.originTip = this.nextTip; return ''; }
    if (op === 'diff') return `${this.diffPaths.join('\n')}\n`;
    if (op === 'checkout') { this.checkoutTo = operands[2]; this.head = operands[2]; this.branch = null; return ''; }
    throw new Error(`fake git cannot answer: git ${rest.join(' ')}`);
  };
}

const verified = (sha: string): DaemonState['deployment'] =>
  deploymentObservationSchema.parse({ source: 'endpoint', sha, at: iso(0), reason: null, deployed: ['GY-1'], pending: [] });
const restarted = (to: string) => ({ result: 'restarted' as const, reason: null, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] });

interface UpgradeRecording { executors: (string | null)[]; self: number; persisted: number }
const recording = (fake: FakeGit, root: string, behaviour: 'restart' | 'refuse' = 'restart'): { deps: () => Parameters<typeof performSelfUpgrade>[2]; calls: UpgradeRecording } => {
  const calls: UpgradeRecording = { executors: [], self: 0, persisted: 0 };
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

test('unit:self-upgrade-under-load — with executors holding claimed actions at each check and settling between checks, self-upgrade completes within bounded cycles without interrupting claimed actions', async () => {
  const { master, dispose } = await fixture();
  const checkout = await repository();
  try {
    const loaded = hex('a'), tip = hex('b');
    const fake = new FakeGit(loaded, tip);
    fake.nextTip = tip;
    fake.diffPaths = ['src/daemon/run.ts'];

    // Fixture: executors that each hold a claimed action at every check before the checkout moves.
    // On a moved checkout they stop new claims through the real executor transition (releaseGuardedEffects),
    // settle held claims between checks (a different action each time), and are never interrupted.
    const mockAction = (id: string, key: string, kind: 'dispatch' = 'dispatch'): ActionRow => ({
      id, kind, work: `work-${key}`, key, inputs: { kind: 'dispatch', epoch: 0, target: 'implementation', priority: 1, plannedFiles: [] } as any,
      gate: 'build', refusal: null, reason: 'test', binding: `${kind}:0`, requestedBy: 'test', requestedAt: iso(0),
      state: 'claimed', claim: { executor: 'exec', host: master.hostId, claimedAt: iso(0), expiresAt: iso(60_000), principal: 'master', attempt: 1 }, attempts: 0, history: [],
    });

    interface LoadExecutor {
      name: string;
      loaded: { commit: string; dirty: boolean };
      inFlight: ActionRow | null;
      interrupted: boolean;
      settled: string[];
      standingReasons: string[];
      guarded: ReturnType<typeof releaseGuardedEffects>;
    }

    const createExecutor = (name: string, initialAction: ActionRow | null): LoadExecutor => {
      const exec: Partial<LoadExecutor> = {
        name,
        loaded: { commit: loaded, dirty: false },
        inFlight: null,
        interrupted: false,
        settled: [],
        standingReasons: [],
      };
      let availableAction = initialAction;
      const baseEffects: ExecutorEffects = {
        claim: async () => {
          const action = availableAction;
          availableAction = null;
          return { action, open: action ? 0 : 1 };
        },
        settle: async (action, result, reason) => ({ action, result, reason }),
        handlers: {},
      };
      const guard: ReleaseGuard = {
        loaded: exec.loaded!,
        current: () => fake.head,
        standDown: (detail) => { exec.standingReasons!.push(detail.reason); },
        claimed: (action) => { exec.inFlight = action; },
        settled: (action) => {
          exec.inFlight = null;
          exec.settled!.push(action.id);
        },
      };
      exec.guarded = releaseGuardedEffects(baseEffects, guard);
      return exec as LoadExecutor;
    };

    const action1 = mockAction('act-1', 'GY-1052', 'dispatch');
    const action2 = mockAction('act-2', 'GY-528', 'dispatch');
    const exec1 = createExecutor('exec-1', action1);
    const exec2 = createExecutor('exec-2', action2);
    const executors = [exec1, exec2];

    // Before self-upgrade runs, while checkout is at `loaded`, both executors claim their actions:
    const claimed1 = await exec1.guarded.claim({ host: master.hostId, executor: 'exec-1', kinds: ['dispatch'] });
    assert.equal(claimed1.action?.id, 'act-1');
    assert.equal(exec1.inFlight?.id, 'act-1');
    assert.equal(exec1.guarded.standingDown(), false);

    const claimed2 = await exec2.guarded.claim({ host: master.hostId, executor: 'exec-2', kinds: ['dispatch'] });
    assert.equal(claimed2.action?.id, 'act-2');
    assert.equal(exec2.inFlight?.id, 'act-2');
    assert.equal(exec2.guarded.standingDown(), false);

    let selfRestarts = 0;
    const restartedTipExecutors: string[] = [];

    const deps = {
      root: checkout,
      run: fake.run,
      restartExecutors: async (to: string) => {
        // At every check, if any executor holds a claimed action in flight, restart is refused.
        // It must NEVER interrupt a claimed action.
        const held = executors.filter(e => e.inFlight !== null).map(e => ({
          name: e.name, host: master.hostId, key: e.inFlight!.key, kind: e.inFlight!.kind, id: e.inFlight!.id, since: iso(0),
        }));
        if (held.length > 0) {
          return {
            result: 'refused' as const,
            reason: `Restart refused while an executor holds a claimed action: ${held.map(h => `${h.name} holds ${h.kind} for ${h.key}`).join('; ')}`,
            coordinator: { commit: to },
            held,
            restarted: [],
            unsupervised: [],
            forgotten: [],
          };
        }
        for (const exec of executors) {
          if (exec.inFlight !== null) exec.interrupted = true;
          exec.loaded.commit = to;
        }
        restartedTipExecutors.push(to);
        return {
          result: 'restarted' as const,
          reason: null,
          coordinator: { commit: to },
          held: [],
          restarted: executors.map(e => ({
            name: e.name, unit: `${e.name}.service`, pid: { before: 1, after: 2 },
            release: { before: { commit: loaded, dirty: false }, after: { commit: to, dirty: false } },
            registered: true, waitedMs: 10,
          })),
          unsupervised: [],
          forgotten: [],
        };
      },
      restartSelf: async () => { selfRestarts += 1; },
      persist: async () => {},
      now: () => clock,
    };

    const state = emptyDaemonState(master);
    state.deployment = verified(tip);
    state.release = { commit: loaded, dirty: false };

    // Cycle 1: performSelfUpgrade moves the checkout to tip.
    // Check 1: both exec-1 and exec-2 hold actions claimed under steady load. Check 1 refuses restart.
    const cycle1 = await performSelfUpgrade(master, state, deps);
    assert.equal(cycle1.outcome, 'failed');
    assert.match(cycle1.outcome === 'failed' ? cycle1.reason : '', /exec-1 holds dispatch for GY-1052/);
    assert.equal(fake.checkoutTo, tip, 'checkout moved to base tip');
    assert.deepEqual(state.upgrade.pending, { from: loaded, to: tip, code: true });
    assert.equal(exec1.interrupted, false, 'act-1 was not interrupted');
    assert.equal(exec2.interrupted, false, 'act-2 was not interrupted');

    // Between Check 1 and Check 2:
    // exec-1 settles act-1 cleanly.
    await exec1.guarded.settle(claimed1.action!, 'done', 'settled');
    assert.equal(exec1.inFlight, null);
    assert.deepEqual(exec1.settled, ['act-1']);

    // exec-1 asks for next claim, but checkout has moved to tip:
    // exercises real executor transition through releaseGuardedEffects (stands down, claims nothing).
    const next1 = await exec1.guarded.claim({ host: master.hostId, executor: 'exec-1', kinds: ['dispatch'] });
    assert.equal(next1.action, null, 'no new action claimed on moved checkout');
    assert.equal(exec1.guarded.standingDown(), true, 'exec-1 stands down on moved checkout');
    assert.equal(exec1.standingReasons.length, 1);
    assert.equal(exec1.standingReasons[0], staleReleaseReason({ commit: loaded, dirty: false }, tip));

    // exec-2 is STILL running act-2 (different action holding check 2):
    assert.equal(exec2.inFlight?.id, 'act-2');
    assert.equal(exec2.guarded.standingDown(), false);

    // Cycle 2: performSelfUpgrade retries finish(pending) on moved checkout.
    // Check 2: exec-2 holds act-2 (GY-528) - a different action each time. Check 2 refuses restart.
    const cycle2 = await performSelfUpgrade(master, state, deps);
    assert.equal(cycle2.outcome, 'failed');
    assert.match(cycle2.outcome === 'failed' ? cycle2.reason : '', /exec-2 holds dispatch for GY-528/);
    assert.deepEqual(state.upgrade.pending, { from: loaded, to: tip, code: true });
    assert.equal(exec1.interrupted, false);
    assert.equal(exec2.interrupted, false);

    // Between Check 2 and Check 3:
    // exec-2 settles act-2 cleanly.
    await exec2.guarded.settle(claimed2.action!, 'done', 'settled');
    assert.equal(exec2.inFlight, null);
    assert.deepEqual(exec2.settled, ['act-2']);

    // exec-2 asks for next claim, exercises real executor transition on moved checkout:
    const next2 = await exec2.guarded.claim({ host: master.hostId, executor: 'exec-2', kinds: ['dispatch'] });
    assert.equal(next2.action, null, 'no new action claimed on moved checkout');
    assert.equal(exec2.guarded.standingDown(), true, 'exec-2 stands down on moved checkout');
    assert.equal(exec2.standingReasons.length, 1);
    assert.equal(exec2.standingReasons[0], staleReleaseReason({ commit: loaded, dirty: false }, tip));

    // Cycle 3: performSelfUpgrade retries finish(pending).
    // Check 3: held claims have settled, both executors stand down on moved checkout.
    // Restart succeeds, loop re-executes itself.
    const cycle3 = await performSelfUpgrade(master, state, deps);
    assert.equal(cycle3.outcome, 'upgraded');
    assert.deepEqual({ to: cycle3.outcome === 'upgraded' && cycle3.to, code: cycle3.outcome === 'upgraded' && cycle3.code, self: cycle3.outcome === 'upgraded' && cycle3.self },
      { to: tip, code: true, self: true });
    assert.equal(state.upgrade.pending, null);
    assert.equal(state.upgrade.alignedRelease, tip);
    assert.deepEqual(restartedTipExecutors, [tip]);
    assert.equal(selfRestarts, 1);
    assert.deepEqual(exec1.settled, ['act-1']);
    assert.deepEqual(exec2.settled, ['act-2']);
    assert.equal(exec1.interrupted, false, 'no claimed action was interrupted');
    assert.equal(exec2.interrupted, false, 'no claimed action was interrupted');
    assert.equal(exec1.loaded.commit, tip, 'exec-1 restarted on tip');
    assert.equal(exec2.loaded.commit, tip, 'exec-2 restarted on tip');

    // Also drive automated loop over the fixture asserting completion within bounded cycles:
    const autoFake = new FakeGit(loaded, tip);
    autoFake.nextTip = tip;
    autoFake.diffPaths = ['src/daemon/run.ts'];
    const autoState = emptyDaemonState(master);
    autoState.deployment = verified(tip);
    autoState.release = { commit: loaded, dirty: false };

    const autoActions = [
      mockAction('f-1', 'GY-1001', 'dispatch'),
      mockAction('f-2', 'GY-1002', 'dispatch'),
      mockAction('f-3', 'GY-1003', 'dispatch'),
    ];

    interface AutoFleetMember {
      name: string;
      loaded: { commit: string; dirty: boolean };
      inFlight: ActionRow | null;
      interrupted: boolean;
      settled: string[];
      guarded: ReturnType<typeof releaseGuardedEffects>;
    }

    const autoFleet: AutoFleetMember[] = autoActions.map((act, i) => {
      const name = `fleet-${i + 1}`;
      const loadedRelease = { commit: loaded, dirty: false };
      const member: Partial<AutoFleetMember> = {
        name,
        loaded: loadedRelease,
        inFlight: null,
        interrupted: false,
        settled: [],
      };
      let available: ActionRow | null = act;
      const baseEffects: ExecutorEffects = {
        claim: async () => {
          const a = available;
          available = null;
          return { action: a, open: a ? 0 : 1 };
        },
        settle: async (a, res, r) => ({ a, res, r }),
        handlers: {},
      };
      const guard: ReleaseGuard = {
        loaded: loadedRelease,
        current: () => autoFake.head,
        standDown: () => {},
        claimed: (a) => { member.inFlight = a; },
        settled: (a) => {
          member.inFlight = null;
          member.settled!.push(a.id);
        },
      };
      member.guarded = releaseGuardedEffects(baseEffects, guard);
      return member as AutoFleetMember;
    });

    // All executors in fleet claim an action before upgrade starts:
    for (const member of autoFleet) {
      const claimResult = await member.guarded.claim({ host: master.hostId, executor: member.name, kinds: ['dispatch'] });
      assert.ok(claimResult.action);
      assert.ok(member.inFlight);
      assert.equal(member.guarded.standingDown(), false);
    }

    let autoSelfRestarts = 0;
    const autoDeps = {
      root: checkout,
      run: autoFake.run,
      restartExecutors: async (to: string) => {
        const held = autoFleet.filter(e => e.inFlight !== null).map(e => ({ name: e.name, host: master.hostId, key: e.inFlight!.key, kind: e.inFlight!.kind, id: e.inFlight!.id, since: iso(0) }));
        if (held.length > 0) {
          return { result: 'refused' as const, reason: `Restart refused: ${held.map(h => `${h.name} holds ${h.key}`).join(', ')}`, coordinator: { commit: to }, held, restarted: [], unsupervised: [], forgotten: [] };
        }
        for (const e of autoFleet) {
          if (e.inFlight !== null) e.interrupted = true;
          e.loaded.commit = to;
        }
        return { result: 'restarted' as const, reason: null, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] };
      },
      restartSelf: async () => { autoSelfRestarts += 1; },
      persist: async () => {},
      now: () => clock,
    };

    let cycles = 0;
    let finalOutcome: SelfUpgradeOutcome | null = null;
    const boundedCycleBound = 5;

    while (cycles < boundedCycleBound) {
      cycles++;
      const res = await performSelfUpgrade(master, autoState, autoDeps);
      if (res.outcome === 'upgraded') {
        finalOutcome = res;
        break;
      }
      // Between checks: held claims settle one by one (different action each time),
      // and exercise the real executor transition on the moved checkout:
      for (const e of autoFleet) {
        if (e.inFlight) {
          const action = e.inFlight;
          await e.guarded.settle(action, 'done', 'settled');
          const next = await e.guarded.claim({ host: master.hostId, executor: e.name, kinds: ['dispatch'] });
          assert.equal(next.action, null, 'stale executor claims nothing on moved checkout');
          assert.ok(e.guarded.standingDown(), 'executor stands down on moved checkout');
          break;
        }
      }
    }

    assert.equal(finalOutcome?.outcome, 'upgraded', 'self-upgrade completed');
    assert.ok(cycles <= boundedCycleBound, `completed within a bounded number of cycles: took ${cycles}`);
    assert.ok(autoFleet.every(e => !e.interrupted), 'no claimed action was interrupted in automated driver');
    assert.deepEqual(autoFleet.flatMap(e => e.settled).sort(), ['f-1', 'f-2', 'f-3']);
    assert.equal(autoSelfRestarts, 1);
  } finally { await dispose(); await rm(checkout, { recursive: true, force: true }); }
});

