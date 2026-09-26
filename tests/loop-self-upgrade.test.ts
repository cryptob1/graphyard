import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import type { Work } from '../src/model.js';
import { deploymentObservationSchema, emptyDaemonState, runDaemon, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { describeSelfUpgrade, performSelfUpgrade } from '../src/daemon/upgrade.js';
import { releaseLag, readBaseTip, releaseLagGraceMs, upgradeRefusalAttention } from '../src/master/release-lag.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import { writeExecutorRegistration, type ExecutorRegistration } from '../src/executor-fleet.js';

/**
 * GY-437: the loop and the executors upgrade themselves to the merged release. After every merge
 * touching src/ the coordinator used to be restarted by hand; now the loop aligns its own
 * checkout with the verified deployed release between cycles — fake git and a fake supervisor
 * here — and `master status` says how far anything it runs lags the base tip. Each test is named
 * for the proof it produces: unit:loop-self-upgrade and unit:release-lag-visible.
 */

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const clock = Date.parse('2030-01-01T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(clock + offsetMs).toISOString();
const minute = 60_000, hour = 60 * minute;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hex = (letter: string) => letter.repeat(40);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-loop-upgrade-'));
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-loop-upgrade-credentials-'));
  const credentialFile = join(directory, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const master: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher,
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const dispose = async () => { await rm(root, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); };
  return { root, directory, master, dispose };
}

/** A real one-commit repository, for the parts that run the shipped git reads. */
async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'graphyard-loop-upgrade-repo-'));
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
    assert.deepEqual(src.release, { commit: git(checkout, 'rev-parse', 'HEAD'), dirty: false }, 'the loaded release was read from this checkout the first time the loop looked at it');
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
    assert.equal(blocked.outcome, 'failed');
    assert.match(blocked.outcome === 'failed' ? blocked.reason : '', /the executors were not restarted: .*exec-1 holds merge for GY-7/);
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
    // through the shipped performSelfUpgrade here, which records the loaded release on the cursor.
    const repo = await repository();
    try {
      const state = emptyDaemonState(master);
      let upgradedBetweenCycles = 0;
      const effects = {
        snapshot: async () => ({ work: [], now: iso(0) }),
        agents: () => [],
        credentials: async () => ({}),
        observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(0), reason: 'none', deployed: [], pending: [] }),
        requestSmoke: async () => {}, merge: async () => {}, recordDeployment: async () => {}, requestProof: async () => {},
        dispatch: async () => {}, recordSession: async () => {}, closeSession: () => {},
        persist: async () => {},
        selfUpgrade: async () => {
          upgradedBetweenCycles += 1;
          return performSelfUpgrade(master, state, { root: repo, run: async (command, args) => execFileSync(command, args, { encoding: 'utf8' }), now: () => clock });
        },
      } as unknown as DaemonEffects;
      await runDaemon(master, state, effects, { once: true, intervalMs: 20_000, identity: { pid: process.pid, host: master.hostId } });
      assert.equal(upgradedBetweenCycles, 1, 'the upgrade ran once, after the cycle completed');
      assert.deepEqual(state.release, { commit: git(repo, 'rev-parse', 'HEAD'), dirty: false }, 'the loaded release was recorded from this checkout');
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
    const empty = await mkdtemp(join(tmpdir(), 'graphyard-loop-upgrade-empty-'));
    try {
      assert.equal(await readBaseTip(empty, 'main', real), null, 'a checkout that never fetched reads the tip as unknown');
    } finally { await rm(empty, { recursive: true, force: true }); }
    assert.deepEqual(upgradeRefusalAttention(null, root, 'main'), [], 'no refusal, no attention');
    assert.equal(upgradeRefusalAttention({ at: iso(0), reason: 'dirty', commit: base }, root, 'main')[0].subject, 'upgrade');
  } finally { await dispose(); await rm(root, { recursive: true, force: true }); }
});
