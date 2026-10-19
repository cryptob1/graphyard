import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import { daemonSummary, deploymentObservationSchema, emptyDaemonState, readDaemonState, runDaemon, writeDaemonState, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { describeSelfUpgrade, heldCliPointer, holdCliAt, checkoutState, performSelfUpgrade, recoverMovedHead, upgradeTouchesCode } from '../src/daemon/upgrade.js';
import { releaseLag, promotionWait, readBaseTip, releaseLagGraceMs, upgradeRefusalAttention, type PromotionWait } from '../src/master/release-lag.js';
import { owedUpgrade, readResources, resourceAttention } from '../src/master-resources.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { readRelease } from '../src/protocol-version.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance (GY-1694): the 2030-01-01 clock is passed as now: () => clock to performSelfUpgrade/readResources and 2026-10-07 is releaseLag's explicit now; the Date.now() tests build their own relative fixtures.

/**
 * GY-437: the loop upgrades itself to the merged release. After every merge
 * touching src/ the coordinator used to be restarted by hand; now the loop aligns its own
 * checkout with the verified deployed release between cycles — fake git and a fake supervisor
 * here — and `master status` says how far anything it runs lags the base tip. Each test is named
 * for the proof it produces: unit:loop-self-upgrade, unit:release-lag-visible and
 * unit:self-upgrade-restarts-loop-only.
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

/** `pins`: every pin of the CLI the checkout's launcher runs (GY-1585), null for a lift, with the loop restarts seen by then; `pinHeads`: the checkout's HEAD at each. */
interface UpgradeRecording { self: number; persisted: number; pins: { commit: string | null; self: number }[]; pinHeads: string[] }
const recording = (fake: FakeGit, root: string): { deps: () => Parameters<typeof performSelfUpgrade>[2]; calls: UpgradeRecording } => {
  const calls: UpgradeRecording = { self: 0, persisted: 0, pins: [], pinHeads: [] };
  return {
    calls,
    deps: () => ({
      root,
      run: fake.run,
      restartSelf: async () => { calls.self += 1; },
      persist: async () => { calls.persisted += 1; },
      holdCli: async commit => { calls.pins.push({ commit, self: calls.self }); calls.pinHeads.push(fake.head); },
      now: () => clock,
    }),
  };
};

test('unit:loop-self-upgrade — between cycles the loop checks out the verified deployed release: a src/ delivery restarts the loop itself, a docs-only delivery restarts nothing, a dirty checkout is never touched and is upgraded by snapshot instead, and a non-detached one is never touched and is named', async () => {
  const { master, dispose } = await fixture();
  // A real checkout as deps.root: the loaded release is read from it with the shipped git.
  const checkout = await repository();
  try {
    const loaded = hex('a'), tip = hex('b'), newer = hex('c');
    const fake = new FakeGit(loaded, tip);
    fake.nextTip = tip;

    // A verified src/ delivery: the checkout moves to the base tip, and the loop re-executes itself
    // through its supervisor.
    fake.diffPaths = ['src/daemon/run.ts'];
    const src = emptyDaemonState(master);
    src.deployment = verified(tip);
    const code = recording(fake, checkout);
    const upgraded = await performSelfUpgrade(master, src, code.deps());
    assert.deepEqual({ outcome: upgraded.outcome, from: 'from' in upgraded && upgraded.from, to: 'to' in upgraded && upgraded.to, code: 'code' in upgraded && upgraded.code, self: 'self' in upgraded && upgraded.self },
      { outcome: 'upgraded', from: loaded, to: tip, code: true, self: true });
    assert.match(describeSelfUpgrade(upgraded), /checked out [0-9a-f]{12}; loaded code moved; the loop re-executes itself/);
    assert.equal(fake.fetches, 1, 'the base branch was fetched once');
    assert.equal(fake.checkoutTo, tip, 'the checkout holds the new base tip');
    assert.equal(code.calls.self, 1, 'the loop re-executed itself');
    assert.deepEqual(src.upgrade, { alignedRelease: tip, pending: null, last: { at: iso(0), from: loaded, to: tip, code: true, self: true }, refused: null });
    assert.equal(src.release, null, 'the alignment never records a release: only a starting process records the one it loaded');
    const done = Object.values(src.actions).find(action => action.kind === 'config' && action.state === 'done');
    assert.match(done!.detail, /loaded code moved$/);
    assert.ok(code.calls.persisted >= 3, 'the cursor was written as the upgrade progressed');

    // The same release is never aligned twice: the next between-cycles pass skips without a fetch.
    const again = recording(fake, checkout);
    const repeat = await performSelfUpgrade(master, src, again.deps());
    assert.equal(repeat.outcome, 'skipped');
    assert.equal(fake.fetches, 1, 'no second fetch');
    assert.equal(again.calls.self, 0);

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
    assert.equal(quiet.calls.self, 0, 'the loop keeps running');
    assert.deepEqual(docs.upgrade, { alignedRelease: newer, pending: null, last: { at: iso(0), from: tip, to: newer, code: false, self: false }, refused: null });

    // A dirty checkout is never touched — no checkout — and holds nothing back (GY-1773): the tip
    // is snapshotted under .graphyard/held-cli, the launcher pinned to it before anything restarts,
    // the loop restarts onto it, and the cursor names the checkout left behind.
    const dirtyState = emptyDaemonState(master);
    const dirtyTip = hex('d');
    fake.nextTip = dirtyTip;
    fake.dirty = ' M src/daemon/run.ts\n';
    fake.diffPaths = ['src/daemon/run.ts'];
    dirtyState.deployment = verified(dirtyTip);
    dirtyState.release = { commit: newer, dirty: false };
    const held = recording(fake, checkout);
    const snapshotted = await performSelfUpgrade(master, dirtyState, held.deps());
    assert.deepEqual({ outcome: snapshotted.outcome, to: 'to' in snapshotted && snapshotted.to, left: 'left' in snapshotted && snapshotted.left }, { outcome: 'upgraded', to: dirtyTip, left: { checkout: newer, dirty: ['src/daemon/run.ts'] } });
    assert.equal(fake.checkoutTo, newer, 'the checkout was not moved');
    assert.deepEqual(held.calls.pins, [{ commit: dirtyTip, self: 0 }], 'the launcher is pinned to a snapshot of the tip before anything restarts');
    assert.equal(held.calls.self, 1, 'the loop restarts onto it');
    assert.deepEqual(dirtyState.upgrade.snapshot, { at: iso(0), commit: dirtyTip, checkout: newer, dirty: ['src/daemon/run.ts'] }, 'the cursor names the checkout left behind with its dirty paths');
    assert.equal(dirtyState.upgrade.refused, null, 'nothing is refused');
    assert.equal(dirtyState.actions['upgrade:refused'], undefined);

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

    // A loop no supervisor unit runs cannot re-execute itself: it says so, names the release it
    // is stuck on, and never marks the alignment done silently.
    const alone = emptyDaemonState(master);
    const aloneTip = hex('f');
    fake.nextTip = aloneTip;
    alone.deployment = verified(aloneTip);
    alone.release = { commit: dirtyTip, dirty: false };
    let selfThrew = 0;
    const unsupervised = await performSelfUpgrade(master, alone, {
      root: '/srv/graphyard', run: fake.run,
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

test('unit:self-upgrade-restarts-loop-only — a loaded-code move restarts the loop through its supervisor once and nothing else: no command names an executor or runs master executors restart, and no executor unit is written', async () => {
  const { master, dispose } = await fixture();
  const units = await temporaryDirectory('loop-upgrade-units');
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = units;
  try {
    const loaded = hex('a'), tip = hex('b');
    const fake = new FakeGit(loaded, tip);
    fake.nextTip = tip;
    fake.diffPaths = ['src/daemon/run.ts'];
    const commands: string[] = [];
    const run = fake.run;
    fake.run = async (command, args) => { commands.push([command, ...args].join(' ')); return run(command, args); };
    const state = emptyDaemonState(master);
    state.deployment = verified(tip);
    const { deps, calls } = recording(fake, '/srv/graphyard');
    const upgraded = await performSelfUpgrade(master, state, deps());
    assert.deepEqual({ outcome: upgraded.outcome, self: 'self' in upgraded && upgraded.self, code: 'code' in upgraded && upgraded.code }, { outcome: 'upgraded', self: true, code: true });
    assert.ok(!('executors' in upgraded), 'the outcome names no executor restart');
    assert.equal(calls.self, 1, 'the loop restarted once, through its supervisor');
    assert.equal(state.upgrade.last?.executors, undefined, 'the cursor records no executor restart');

    // A moved HEAD the loop adopts restarts the loop alone too.
    const moved = new FakeGit(tip, hex('c'));
    moved.contains = () => true;
    moved.diffPaths = ['src/daemon/run.ts'];
    const movedRun = moved.run;
    moved.run = async (command, args) => { commands.push([command, ...args].join(' ')); return movedRun(command, args); };
    const adopting = emptyDaemonState(master);
    adopting.deployment = deploymentObservationSchema.parse({ source: 'endpoint', sha: hex('c'), at: iso(0), reason: null, deployed: ['GY-1'], pending: [] });
    const adopted = recording(moved, '/srv/graphyard');
    const recovered = await recoverMovedHead(master, adopting, loaded, tip, adopted.deps());
    assert.deepEqual({ outcome: recovered.outcome, self: 'self' in recovered && recovered.self }, { outcome: 'upgraded', self: true });
    assert.equal(adopted.calls.self, 1);

    assert.ok(commands.length > 0 && commands.every(command => command.startsWith('git ')), `only git runs beside the restart: ${commands.join('; ')}`);
    assert.ok(!commands.some(command => /executor|systemctl/.test(command)), 'nothing names an executor, master executors restart or a systemctl restart');
    const written = await readdir(join(units, 'systemd', 'user')).catch(() => [] as string[]);
    assert.deepEqual(written.filter(name => name.includes('graphyard-executor')), [], 'no executor unit is written');
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previous;
    await rm(units, { recursive: true, force: true });
    await dispose();
  }
});

const delivered = (key: string, mergeSha: string, mergedAt: string) => ({
  id: `work-${key}`, key, title: `Item ${key}`, description: '', type: 'feature', priority: 2, dependencies: [], criteria: [],
  policy: { checks: ['test'], review: true }, plannedFiles: ['src/'], stage: 'done', revision: 1, policyRevision: 1,
  createdAt: iso(-4 * hour), updatedAt: iso(0), stageEnteredAt: iso(-hour), ready: false, epoch: 0, lease: null, workspaces: [],
  candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
  gates: [], violations: [], delivery: { mergedAt, mergeSha, authorizationRevision: 1 },
} as unknown as Work);

test('unit:release-lag-visible — master status reports the release the loop loaded against the base tip, and names it when it is more than one delivery behind for over ten minutes', async () => {
  const { directory, master, dispose } = await fixture();
  // The coordinator checkout is a real repository, so the shipped ancestry read answers: `base`
  // is what the loop still runs, and two deliveries were merged after it.
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

    const masterApi = async (path: string) => path === 'work-snapshot' ? { work: [delivered('GY-1', deliveryOne, new Date(now - hour).toISOString()), delivered('GY-2', deliveryTwo, new Date(now - 20 * minute).toISOString())], now: new Date(now).toISOString() } : { decisions: [] };
    const report = await masterStatusReport(root, master, masterApi, { actor: { id: 'coordinator-1' } }, { commit: base });

    // The report: what each component loaded, against the base tip, with what each is missing.
    assert.equal(report.releaseLag.baseTip, deliveryTwo);
    const rows = Object.fromEntries(report.releaseLag.components.map(row => [row.component, row]));
    assert.deepEqual(Object.keys(rows), ['loop'], 'the loop is the one component reported');
    assert.equal(rows['loop'].release.commit, base);
    assert.deepEqual(rows['loop'].behind.map(entry => entry.key), ['GY-1', 'GY-2'], 'the loop misses both deliveries');

    // The attention: the loop is named.
    const lagItems = report.attentionItems.filter(item => /more than one delivery behind/.test(item.text));
    assert.deepEqual(lagItems.map(item => item.subject), ['loop']);
    const loopItem = lagItems.find(item => item.subject === 'loop')!;
    assert.match(loopItem.text, new RegExp(`The master loop runs ${base.slice(0, 12)}, more than one delivery behind the base tip ${deliveryTwo.slice(0, 12)} since`));
    assert.match(loopItem.text, /GY-1, GY-2 merged and are not in what it loads/);
    assert.equal(loopItem.role, 'master', 'the master owns the fix; no human is asked');
    assert.match(loopItem.next, /systemctl --user restart graphyard-master/);
    assert.ok(rows['loop'].late, 'it is past the grace window');
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
 * GY-1400: the loop loads a base tip only once a verified production release serves it, and its
 * promotion drive dispatches at most every 120 minutes, so two or three merges inside one window
 * leave it more than one delivery behind for up to two hours by design. Fake git: a commit
 * contains a delivery only when it is that delivery's merge or a later one in `order`.
 */
const order = [hex('a'), hex('b'), hex('c'), hex('d')];
const ancestry = async (_command: string, args: string[]) => {
  // One `rev-list --right-only --ignore-missing COMMIT...MERGE …` per component (GY-1776): a merge
  // is listed exactly when the commit does not contain it, with the history between them.
  assert.deepEqual(args.slice(2, 5), ['rev-list', '--right-only', '--ignore-missing']);
  const listed = new Set<string>();
  for (const range of args.slice(5)) {
    const [commit, mergeSha] = range.split('...');
    if (!order.includes(commit) || !order.includes(mergeSha)) continue; // --ignore-missing drops the range
    for (let index = order.indexOf(commit) + 1; index <= order.indexOf(mergeSha); index++) listed.add(order[index]);
  }
  return [...listed].join('\n');
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

test('unit:self-upgrade-waits-for-served-release — while the restart is held, every command the checkout\'s launcher runs loads the served release A, with the checkout\'s own entry kept as its argv, and lifting the hold returns them to the checkout\'s B', async () => {
  // A real checkout holding B with A in its history, and the shipped launcher beside it: what the
  // loop spawns through config.cliPath (watch, claim, heartbeat, push-credential).
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

test('unit:docs-only-alignment-unaffected — a move touching no loaded code completes while production still serves the earlier release: nothing restarts, nothing is held, no stall is named', async () => {
  const { master, dispose } = await fixture();
  try {
    const { loaded, tip, fake, state } = releaseLagged(hex('a'));
    fake.diffPaths = ['docs/deployment.md'];
    const { deps, calls } = recording(fake, '/srv/graphyard');
    const upgraded = await performSelfUpgrade(master, state, deps());
    assert.deepEqual(upgraded, { outcome: 'upgraded', from: loaded, to: tip, code: false, self: false });
    assert.equal(fake.checkoutTo, tip);
    assert.equal(calls.self, 0);
    assert.equal(state.upgrade.pending, null);
    assert.equal(state.upgrade.stalled, undefined);
    assert.equal(state.upgrade.alignedRelease, loaded);
    assert.equal(fake.ancestryReads, 0, 'a docs-only move never asks whether production serves it');
  } finally { await dispose(); }
});

test('unit:gy-1773-quoted-porcelain-paths — a dirty loaded file whose name Git quotes is still named by its real path, so it counts as loaded code', async () => {
  const status = ' M "src/a b.ts"\n M "src/caf\\303\\251.ts"\nR  "old.txt" -> "src/n\\"q.ts"\n';
  const state = await checkoutState('/repo', async (_command, args) => args.includes('status') ? status : 'abc123\n');
  assert.deepEqual(state.dirtyPaths, ['src/a b.ts', 'src/café.ts', 'old.txt', 'src/n"q.ts'], 'both paths of a rename, the quoted destination unquoted (GY-1773)');
  assert.equal(upgradeTouchesCode(state.dirtyPaths), true);
});
