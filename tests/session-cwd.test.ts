// GY-866: no session Graphyard launches starts where the master starts. Every role's launch is
// built here the way the loop builds it — the real launch functions against a stubbed Herdr — and
// the pane's `--cwd`, the launch files' checkout and the runtime's recorded working folder must be
// the session's own managed checkout (or its assigned worktree, or the loop's scratch checkout for
// the sessions that have none), never the coordinator checkout. The coordinator checkout's own
// guard is exercised the way the loop runs it: a dirty tree or a moved HEAD is
// attention naming the paths, the HEAD and the sessions whose panes point at the checkout, and
// nothing self-upgrades or claims from it until it is clean and back at the commit the loop runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { bwrapOnPath, coordinatorCheckoutRefusal, readCoordinatorCheckout, readOnlyMountWrapper } from '../src/master/profiles.js';
import { dataDirectory, worktreeRoot } from '../src/install/worktree-root.js';
import { atomicPrivateWrite, dispatchWork, loadMasterConfig, masterConfigSchema, saveProducerProfile, setupMaster, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { launchProducer, readProducerLedger } from '../src/producer.js';
import { bindReviewer, launchReview, saveReviewerProfile } from '../src/reviewer.js';
import { emptyDaemonState, runDaemon, type DaemonEffects } from '../src/master-daemon.js';
import type { HerdrAgent } from '../src/master/herdr.js';
import type { Runner } from '../src/runner/types.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// Time-bomb allowance (GY-1694): the 2030-01-01 iso() instants are judged against the stub snapshot's own now iso(0) (lease expiry, fault ages, observedAt); Date.now() only mints tokens, stamps observations and runs reclaim.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1'), C1 = sha40('c1'), C2 = sha40('d2');
const at = '2026-09-24T10:00:00.000Z';
const hour = 3_600_000;
const iso = (offsetMs: number) => new Date(Date.parse('2030-01-01T00:00:00Z') + offsetMs).toISOString();
const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const mint = async () => ({ token: 'ghs_review_session_token', expiresAt: new Date(Date.now() + 3_500_000).toISOString() });

function observation(candidate: { sha: string; baseSha: string }): Work['observation'] {
  return { candidate: { ...candidate, pr: 866, branch: 'graphyard/gy-866-7', author: 'implementer' }, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/a.ts'], scopeFiles: [], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true } as Work['observation'];
}
function work(overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 866, branch: 'graphyard/gy-866-7', author: 'implementer' };
  return { id: 'work-866', key: 'GY-866', title: 'Sessions start in their own checkout', description: '', type: 'feature', priority: 0, dependencies: [], 
    criteria: [{ id: 'AC-1', text: 'Own checkout', proofs: ['unit:session-cwd-own-checkout'] }],
    policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1,
    lease: null, workspaces: [{ host: 'h', path: '/w/gy-866', branch: 'graphyard/gy-866-7', epoch: 1, owner: 'implementer' }], candidate, submission: { epoch: 1, pr: 866 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: observation(candidate), blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: ['Independent approval of the current commit is required'] }], violations: [], ...overrides } as Work;
}
const ready = () => work({ stage: 'ready', lease: null, submission: null, candidate: null, observation: null, gates: [{ name: 'ready', passed: true, reasons: [] }] });
/** A machine-filed backlog item awaiting triage (GY-402). */
const machineFiled = (): Work => ({ ...ready(), id: 'work-901', key: 'GY-901', title: 'Recurring flaky faults: test shard', stage: 'backlog', ready: false,
  origin: { faultClass: 'flaky-shard' }, createdAt: iso(0) } as unknown as Work);

/**
 * A master installed in a throwaway repository — the coordinator checkout of these tests — with
 * its credentials beside it, an approver and an operator-agent, and the managed worktree root
 * pointed at its own temporary directory. The repository holds one commit.
 */
async function installed() {
  const directory = await temporaryDirectory('session-cwd');
  const credentials = await temporaryDirectory('session-cwd-credentials');
  execFileSync('git', ['init', '-q', '-b', 'main', directory]);
  await writeFile(join(directory, '.gitignore'), '.graphyard/\n');
  await mkdir(join(directory, 'src'), { recursive: true });
  await mkdir(join(directory, 'tests'), { recursive: true });
  await mkdir(join(directory, 'bin'), { recursive: true });
  await writeFile(join(directory, 'src', 'loop.ts'), 'export const loop = 1;\n');
  await writeFile(join(directory, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], { stdio: 'ignore' });
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await setupMaster(directory, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: join(directory, 'bin', 'graphyard.mjs'), credentialDirectory: credentials, herdrWorkspace: 'wC' }, coordinatorStatus as typeof fetch);
  await bindReviewer(directory, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentials, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  const token = async (name: string) => { const file = join(credentials, `${name}.token`); await writeFile(file, `${name}-token-`.padEnd(40, 'x'), { mode: 0o600 }); return file; };
  const config = await loadMasterConfig(directory);
  // Session checkouts go to a durable root of the fixture's own, outside the data directory's shared
  // worktrees/, so a reclaim pass never sweeps the neighbouring roots every other run left there.
  await mkdir(join(dataDirectory(), 'session-cwd'), { recursive: true });
  const managed = await temporaryDirectory('root', join(dataDirectory(), 'session-cwd'));
  await atomicPrivateWrite(join(directory, '.graphyard/master.json'), { ...config, approver: { id: 'graphyard-approver-project', credentialFile: await token('approver') }, operatorAgent: { id: 'graphyard-operator-project', credentialFile: await token('operator') }, run: { ...config.run, worktreeRoot: managed } });
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const head = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const fullConfig = await loadMasterConfig(directory);
  return { root: directory, head, token, config: fullConfig, cleanup: async () => {
    await rm(managed, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
    await rm(credentials, { recursive: true, force: true });
  } };
}

/** A Herdr stub whose runtimes start at once; it records every `tab create` line and every expanded launch. */
function herdr() {
  const typed: ReturnType<typeof expandTypedCommand>[] = [], tabs: string[][] = [], pasted: string[] = [];
  let panes = 0;
  const run = (_command: string, args: string[]) => {
    if (args[0] === 'tab' && args[1] === 'create') { panes++; tabs.push(args); return JSON.stringify({ result: { root_pane: { pane_id: `pane-${panes}`, tab_id: `tab-${panes}` } } }); }
    if (args[0] === 'pane' && args[1] === 'run') typed.push(expandTypedCommand(args[3]));
    if (args[0] === 'agent' && args[1] === 'prompt') pasted.push(args[3]);
    return startedAtOnce(args) ?? JSON.stringify({ result: {} });
  };
  return { run, typed, tabs, pasted };
}
const paneCwd = (tab: string[]) => { const index = tab.indexOf('--cwd'); return index >= 0 ? tab[index + 1] : null; };
/** The checkout the launch files were written in: the stem's path before its `.graphyard/launch/` segment. */
const checkoutOfStem = (stem: string | null) => stem && stem.includes(`${sep}.graphyard${sep}launch${sep}`) ? stem.slice(0, stem.indexOf(`${sep}.graphyard${sep}launch${sep}`)) : null;
/** Outside the coordinator checkout: another tree altogether, or Graphyard's own managed area under `.graphyard/`. */
const outsideCoordinator = (path: string, coordinatorRoot: string) => {
  const directory = resolve(path), base = resolve(coordinatorRoot);
  return directory !== base && (!directory.startsWith(`${base}${sep}`) || directory.startsWith(`${base}${sep}.graphyard${sep}`));
};

/**
 * What the session's request does first, from where it starts: reach the repository and add the
 * detached worktree of the head it judges at the path it was allocated. The fixture's origin is
 * not reachable, so the head is the commit the repository already holds.
 */
const obtainsCode = (start: string, worktree: string, commit: string, coordinatorRoot?: string) => {
  const wrapper = (coordinatorRoot && process.platform === 'linux' && bwrapOnPath()) ? readOnlyMountWrapper({ coordinatorRoot, sessionDirectory: start }) : [];
  const cmd = [...wrapper, 'git', 'worktree', 'add', '--detach', '--quiet', worktree, commit];
  execFileSync(cmd[0], cmd.slice(1), { cwd: start, stdio: 'ignore' });
  return existsSync(join(worktree, 'src', 'loop.ts'));
};

/** The value a Herdr `tab create` line sets for `name` with `--env`. */
const tabEnv = (tab: string[], name: string) => tab.flatMap((arg, index) => tab[index - 1] === '--env' && arg.startsWith(`${name}=`) ? [arg.slice(name.length + 1)] : []).at(-1) ?? null;
const contextModule = fileURLToPath(new URL('../src/cli/context.ts', import.meta.url));
/**
 * The root a `graphyard master` command resolves its installation from, run where the session
 * starts with the environment its tab sets: the CLI's own resolution, in a process of its own.
 */
const cliRoot = (start: string, environment: Record<string, string>) => execFileSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e',
  `const { createContext } = await import(${JSON.stringify(contextModule)}); console.log((await createContext('master', undefined, [], false)).repositoryRoot());`],
  { cwd: start, encoding: 'utf8', env: { ...process.env, ...environment } }).trim();
/** Effects both the loop's guard and the steps read: a snapshot over `work`, and stubs for everything else. */
function loopEffects(work: unknown[], overrides: Record<string, unknown> = {}): DaemonEffects {
  const base = {
    agents: () => [] as never[],
    credentials: async (profiles: { name: string }[]) => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    workerCredentials: async () => ({}), producerCredentials: async () => ({}),
    mutate: async () => ({}), dispatchWorker: async () => ({}), launchReview: async () => ({}), launchProducer: async () => ({}), merge: async () => ({}),
    snapshot: async () => ({ work: work as Work[], now: iso(0) }),
    closeSession: () => {}, dispatch: async () => {},
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, persist: async () => {},
  };
  return { ...base, ...overrides } as DaemonEffects;
}
const loopOptions = (fixture: { root: string }, extra: Partial<Parameters<typeof runDaemon>[3]> = {}) => ({
  once: true, intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: [] as NodeJS.Signals[], log: () => {}, ...extra,
});

test('unit:session-cwd-own-checkout — a reviewer session opens its pane and starts its runtime in its own managed checkout, never in the coordinator checkout', async () => {
  const fixture = await installed();
  try {
    const { root, head, cleanup } = fixture;
    const home = await temporaryDirectory('session-cwd-claude-home');
    try {
      const stub = herdr();
      await saveReviewerProfile(root, { name: 'reviewer-claude', agentName: 'review-claude-1', kind: 'claude', environment: { CLAUDE_CONFIG_DIR: home } });
      await launchReview(root, work(), 'reviewer-claude', [], new Date().toISOString(), { run: stub.run, mint, requestId: 'review-request' });
      assert.equal(stub.tabs.length, 1, 'one Herdr tab is created for the review');
      const pane = paneCwd(stub.tabs[0]);
      assert.ok(pane, 'the reviewer pane is created with an explicit --cwd');
      assert.ok(outsideCoordinator(pane!, root), `the reviewer pane opens outside the coordinator checkout, not ${pane}`);
      const sessionCheckout = checkoutOfStem(stub.typed[0].stem);
      assert.ok(sessionCheckout, 'the launch files are written in a checkout of their own');
      assert.ok(outsideCoordinator(sessionCheckout!, root), 'the launch files live outside the coordinator checkout');
      assert.equal(resolve(pane!), resolve(sessionCheckout!), 'the pane opens exactly where the session checkout is');
      assert.ok(obtainsCode(pane!, join(pane!, 'checkout'), head, root), 'the git fetch and git worktree add its request runs from where it starts reach the repository');
      // The process-level folder the runtime starts in is the session checkout too: the launch's
      // cwd is what the folder-trust step records, and it records the checkout and only it.
      const projects = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).projects as Record<string, { hasTrustDialogAccepted?: boolean }>;
      assert.equal(projects[realpathSync(resolve(sessionCheckout!))]?.hasTrustDialogAccepted, true, 'the runtime starts in the session checkout');
      assert.equal(projects[realpathSync(resolve(root))], undefined, 'the coordinator checkout is never recorded as the folder the runtime starts in');
    } finally { await rm(home, { recursive: true, force: true }); }
    await cleanup();
  } finally { await fixture.cleanup(); }
});

test('unit:session-cwd-own-checkout — a producer session opens its pane and starts its runtime in its own managed checkout, never in the coordinator checkout', async () => {
  const fixture = await installed();
  try {
    const { root, head, config, cleanup } = fixture;
    const home = await temporaryDirectory('session-cwd-producer-home');
    try {
      const stub = herdr();
      const proof = 'integration:session-cwd-producer';
      await saveProducerProfile(root, { name: 'producer-claude', principal: 'proof-runner', agentName: 'produce-claude', kind: 'claude', credentialFile: await fixture.token('producer'), environment: { CLAUDE_CONFIG_DIR: home } },
        async () => ({ actor: { id: 'proof-runner', role: 'producer', proofs: ['unit:*', 'integration:*'] } }));
      const request = { id: 'produce-request', kind: 'producer', sha: H, baseSha: B, policyRevision: 1, pr: 866, group: 'integration', proofs: [proof], state: 'requested', requestedAt: new Date().toISOString(), reason: 'r' } as any;
      const item = work({ criteria: [{ id: 'AC-1', text: 'Own checkout', proofs: [proof] }], implementers: ['implementer'], autoDispatch: { review: null, producers: [request], history: [] } } as Partial<Work>);
      const profile = (await loadMasterConfig(root)).producers.find(entry => entry.name === 'producer-claude')!;
      const launched = await launchProducer(root, item, request, profile, [], new Date().toISOString(), { run: stub.run });
      assert.equal(stub.tabs.length, 1, 'one Herdr tab is created for the producer');
      const pane = paneCwd(stub.tabs[0]);
      assert.ok(pane, 'the producer pane is created with an explicit --cwd');
      assert.ok(outsideCoordinator(pane!, root), `the producer pane opens outside the coordinator checkout, not ${pane}`);
      assert.equal(dirname(resolve(launched.checkout)), resolve(worktreeRoot(root, config)), 'the producer checkout sits under the managed worktree root');
      assert.equal((await readProducerLedger(root)).producers[0].checkout, launched.checkout, 'the session record owns that checkout');
      assert.equal(resolve(pane!), resolve(launched.checkout), 'the pane opens exactly in the producer\'s managed checkout');
      assert.equal(resolve(checkoutOfStem(stub.typed[0].stem)!), resolve(launched.checkout), 'the launch files are written in that checkout');
      // The runtime's own working folder is the checkout too: the folder-trust step records it and only it.
      const projects = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')).projects as Record<string, { hasTrustDialogAccepted?: boolean }>;
      assert.equal(projects[realpathSync(resolve(launched.checkout))]?.hasTrustDialogAccepted, true, 'the runtime starts in the producer checkout');
      assert.equal(projects[realpathSync(resolve(root))], undefined, 'the coordinator checkout is never recorded as the folder the runtime starts in');
      assert.ok(obtainsCode(pane!, join(launched.checkout, 'checkout'), head, root), 'the git fetch and git worktree add its request runs from where it starts reach the repository');
    } finally { await rm(home, { recursive: true, force: true }); }
    await cleanup();
  } finally { await fixture.cleanup(); }
});

test('unit:session-cwd-own-checkout — a worker session opens its pane in its assigned worktree, never in the coordinator checkout', async () => {
  const fixture = await installed();
  try {
    const { root, cleanup } = fixture;
    const stub = herdr();
    const profile: WorkerProfile = { name: 'worker-oc', principal: 'worker-a', agentName: 'eng-oc', mode: 'launch', kind: 'opencode', credentialFile: await fixture.token('worker'), agentArgs: [], approvals: 'auto', environment: {} };
    const assigned = await temporaryDirectory('session-cwd-worktree');
    try {
      await dispatchWork(root, ready(), profile, [], stub.run, [ready()], async () => ({ epoch: 4, path: assigned, base: 'c'.repeat(40) }), async () => {}, 5_000);
      assert.equal(stub.tabs.length, 1, 'one Herdr tab is created for the worker');
      const pane = paneCwd(stub.tabs[0]);
      assert.ok(pane, 'the worker pane is created with an explicit --cwd');
      assert.equal(resolve(pane!), resolve(assigned), 'the worker pane opens in its assigned worktree');
      assert.ok(outsideCoordinator(pane!, root), 'the assigned worktree is outside the coordinator checkout');
    } finally { await rm(assigned, { recursive: true, force: true }); }
    await cleanup();
  } finally { await fixture.cleanup(); }
});

test('unit:coordinator-checkout-drift-detected — the loop cycles nothing from a dirty coordinator checkout and raises attention naming the paths', async () => {
  const fixture = await installed();
  try {
    const { root, config, cleanup } = fixture;
    const original = await readFile(join(root, 'src', 'loop.ts'), 'utf8');
    await writeFile(join(root, 'src', 'loop.ts'), `${original}\nexport const halfFinished = true;\n`);
    await writeFile(join(root, 'tests', 'scratch.test.ts'), 'import { test } from "node:test";\n');
    const checkout = await readCoordinatorCheckout(root);
    assert.match(coordinatorCheckoutRefusal(checkout, 'the master loop')!, /refuses to start, self-upgrade or restart/);
    let upgrades = 0;
    const state = emptyDaemonState(config);
    const refused = await runDaemon(config, state, loopEffects([], { selfUpgrade: async () => { upgrades++; return { outcome: 'skipped' as const, reason: 'nothing deployed yet' }; } }), loopOptions(fixture));
    assert.deepEqual(refused.cycles, [], 'the loop cycles nothing from a dirty checkout');
    assert.equal(upgrades, 0, 'the self-upgrade never runs from a dirty checkout');
    const escalation = state.actions['attention:dirty-checkout'];
    assert.ok(escalation, 'the refusal is raised as attention');
    assert.match(escalation.detail, /src\/loop\.ts/);
    assert.match(escalation.detail, /tests\//, 'the untracked test directory is named');
    // Clean again: the loop starts, and the refusal stops describing anything.
    await writeFile(join(root, 'src', 'loop.ts'), original);
    await rm(join(root, 'tests', 'scratch.test.ts'));
    const resumed = await runDaemon(config, emptyDaemonState(config), loopEffects([], { selfUpgrade: async () => { upgrades++; return { outcome: 'skipped' as const, reason: 'nothing deployed yet' }; } }), loopOptions(fixture));
    assert.equal(resumed.cycles.length, 1, 'a cleaned checkout starts the loop');
    assert.equal(upgrades, 1, 'the self-upgrade runs again on a clean checkout');
    await cleanup();
  } finally { await fixture.cleanup(); }
});

test('unit:coordinator-checkout-drift-detected — the loop checks the checkout every cycle: a tree that turns dirty under a running loop is attention, and the self-upgrade still runs (GY-1773: a dirty tree is upgraded by snapshot, never a reason to wait)', async () => {
  const fixture = await installed();
  try {
    const { config, cleanup } = fixture;
    let cycle = 0;
    const checkout = async () => {
      cycle++;
      // The startup read sees a clean checkout at C1; the cycle's own guard reads the tree the
      // attempt half-finished.
      return cycle === 1 ? { root: fixture.root, commit: C1, modified: [] as string[], untracked: [] as string[] }
        : { root: fixture.root, commit: C1, modified: ['src/loop.ts'], untracked: ['tests/scratch.test.ts'] };
    };
    let upgrades = 0;
    const state = emptyDaemonState(config);
    await runDaemon(config, state, loopEffects([], { selfUpgrade: async () => { upgrades++; return { outcome: 'skipped' as const, reason: 'nothing deployed yet' }; } }),
      loopOptions(fixture, { checkout }));
    // GY-1773: the dirty tree used to skip the self-upgrade here, and left the loop on stale code
    // for as long as it stood; it is escalated as before, and the upgrade runs — from a dirty tree
    // it snapshots the merged commit under .graphyard/held-cli and restarts onto that.
    assert.equal(upgrades, 1, 'the self-upgrade runs from the cycle the tree turned dirty: a dirty tree holds it back no longer');
    const escalation = state.actions['attention:dirty-checkout'];
    assert.ok(escalation, 'the turned-dirty tree is raised as attention');
    assert.match(escalation.detail, /src\/loop\.ts/);
    assert.match(escalation.detail, /The self-upgrade is not held by it: a merged release restarts the loop onto a held snapshot of it, the checkout left where it stands/, 'and says the upgrade is not held by it');
    await cleanup();
  } finally { await fixture.cleanup(); }
});

test('unit:coordinator-checkout-drift-detected — a HEAD that moves under a running loop is attention naming the HEAD and the sessions whose panes point at the checkout, and nothing self-upgrades from it', async () => {
  const fixture = await installed();
  try {
    const { root, config, cleanup } = fixture;
    let phase = 0;
    const checkout = async () => {
      phase++;
      return { root, commit: phase === 1 ? C1 : C2, modified: [] as string[], untracked: [] as string[] };
    };
    let upgrades = 0;
    const agents: HerdrAgent[] = [
      { name: 'review-claude-1', pane_id: 'wC:p1', agent: 'claude', cwd: root },
      { name: 'produce-claude-2', pane_id: 'wC:p2', agent: 'claude', cwd: join(root, '.graphyard', 'checkouts', 'graphyard-review-gy-1-abcdef1-12345678') },
      { name: 'eng-oc', pane_id: 'wC:p3', agent: 'opencode', cwd: undefined },
    ];
    const state = emptyDaemonState(config);
    await runDaemon(config, state, loopEffects([], { agents: async () => agents, selfUpgrade: async () => { upgrades++; return { outcome: 'skipped' as const, reason: 'nothing deployed yet' }; } }),
      loopOptions(fixture, { checkout }));
    assert.equal(upgrades, 0, 'the self-upgrade is skipped while HEAD is not the commit the loop runs');
    const escalation = state.actions['attention:dirty-checkout'];
    assert.ok(escalation, 'the moved HEAD is raised as attention');
    assert.match(escalation.detail, new RegExp(`moved from ${C1.slice(0, 12)} to ${C2.slice(0, 12)}`), 'the attention names the HEAD it expects and the HEAD it found');
    assert.ok(escalation.detail.includes('review-claude-1 (pane wC:p1'), 'the session whose pane points at the checkout is named');
    assert.ok(escalation.detail.includes(`cwd ${root}`), 'the pane cwd is named');
    assert.ok(!escalation.detail.includes('produce-claude-2'), 'a session in its own managed checkout is not named');
    await cleanup();
  } finally { await fixture.cleanup(); }
});

test('unit:coordinator-checkout-drift-detected — during a Herdr outage the drifted checkout is still attention, with its sessions reported unknown, and the loop keeps running', async () => {
  const fixture = await installed();
  try {
    const { root, config, cleanup } = fixture;
    let phase = 0;
    const checkout = async () => {
      phase++;
      return { root, commit: phase === 1 ? C1 : C2, modified: [] as string[], untracked: [] as string[] };
    };
    for (const agents of [async () => null, async () => { throw new Error('herdr is not running'); }]) {
      phase = 0;
      let upgrades = 0;
      const state = emptyDaemonState(config);
      const result = await runDaemon(config, state, loopEffects([], { agents, selfUpgrade: async () => { upgrades++; return { outcome: 'skipped' as const, reason: 'nothing deployed yet' }; } }),
        loopOptions(fixture, { checkout }));
      assert.equal(result.cycles.length + result.failed.length, 1, 'the loop ran its cycle and the guard after it did not end the loop on the unreadable inventory');
      assert.equal(upgrades, 0, 'nothing self-upgrades from the moved HEAD');
      const escalation = state.actions['attention:dirty-checkout'];
      assert.ok(escalation, 'the moved HEAD is raised as attention while Herdr is down');
      assert.match(escalation.detail, new RegExp(`moved from ${C1.slice(0, 12)} to ${C2.slice(0, 12)}`));
      assert.match(escalation.detail, /sessions whose panes point at it are unknown/);
    }
    await cleanup();
  } finally { await fixture.cleanup(); }
});

test('unit:coordinator-checkout-drift-detected — the loop\u2019s own alignment is the one HEAD move it sanctions: the next cycle expects the HEAD the alignment left behind', async () => {
  const fixture = await installed();
  try {
    const { config, cleanup } = fixture;
    let phase = 0;
    const stop = { fire: () => {} };
    const fakeProcess = { on: (event: string, handler: () => void) => { if (event === 'SIGTERM') stop.fire = handler; }, off: () => {} } as unknown as NodeJS.Process;
    const checkout = async () => {
      phase++;
      // startup, cycle 1's guard, the alignment's own read, then cycle 2's guard — the commit the
      // alignment left behind reads as expected from then on.
      // reads 1-2 are the startup read and cycle 1's guard at the loaded commit; read 3 is the alignment's own read of the commit it moved to.
      return { root: fixture.root, commit: phase <= 2 ? C1 : C2, modified: [] as string[], untracked: [] as string[] };
    };
    const upgrades: number[] = [];
    let alignments = 0;
    const state = emptyDaemonState(config);
    const effects = loopEffects([], { selfUpgrade: async () => {
      alignments++;
      if (alignments === 1 && phase === 2) { upgrades.push(phase); return { outcome: 'upgraded' as const, from: C1, to: C2, code: false, self: false }; }
      return { outcome: 'skipped' as const, reason: 'already aligned' };
    } });
    const stopTimer = setTimeout(() => stop.fire(), 40);
    void stopTimer;
    await runDaemon(config, state, effects, { intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGTERM'], process: fakeProcess, checkout, log: () => {} });
    clearTimeout(stopTimer);
    assert.deepEqual(upgrades, [2], 'the alignment ran once on the clean checkout');
    assert.ok(alignments >= 2, 'the next cycle offered the alignment again and it found nothing to move');
    assert.equal(state.actions['attention:dirty-checkout'], undefined, 'the alignment\u2019s own HEAD move raises no drift attention');
    assert.ok(phase >= 4, 'the loop checked the coordinator checkout on every cycle');
    await cleanup();
  } finally { await fixture.cleanup(); }
});

for (const ending of ['failed', 'threw', 'foreign'] as const) {
  test(`unit:coordinator-checkout-drift-detected — an alignment that moves HEAD and then ${ending === 'threw' ? 'throws' : 'fails'} ${ending === 'foreign' ? 'to a commit its cursor does not name is still drift' : 'is not reported as drift on the next cycle'}`, async () => {
    const fixture = await installed();
    try {
      const { config, cleanup } = fixture;
      let phase = 0;
      const stop = { fire: () => {} };
      const fakeProcess = { on: (event: string, handler: () => void) => { if (event === 'SIGTERM') stop.fire = handler; }, off: () => {} } as unknown as NodeJS.Process;
      // reads 1-2 are the startup read and cycle 1's guard at the loaded commit; from read 3 on the
      // checkout stands at C2, where the alignment checked it out before its restart failed.
      const checkout = async () => { phase++; return { root: fixture.root, commit: phase <= 2 ? C1 : C2, modified: [] as string[], untracked: [] as string[] }; };
      let alignments = 0;
      const state = emptyDaemonState(config);
      const effects = loopEffects([], { selfUpgrade: async (current: typeof state) => {
        alignments++;
        if (alignments === 1) {
          // performSelfUpgrade records the cursor and checks out before the restarts it can fail.
          if (ending !== 'foreign') current.upgrade.last = { at: new Date().toISOString(), from: C1, to: C2, code: true, self: false };
          if (ending === 'threw') throw new Error('the self restart could not be made');
          return { outcome: 'failed' as const, reason: 'the loop restart is unavailable outside the graphyard-master unit' };
        }
        return { outcome: 'skipped' as const, reason: 'already aligned' };
      } });
      const stopTimer = setTimeout(() => stop.fire(), 40);
      await runDaemon(config, state, effects, { intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGTERM'], process: fakeProcess, checkout, log: () => {} });
      clearTimeout(stopTimer);
      assert.ok(phase >= 4, 'the loop checked the coordinator checkout on later cycles');
      const escalation = state.actions['attention:dirty-checkout'];
      if (ending === 'foreign') {
        assert.ok(escalation, 'a HEAD the cursor does not name stays drift');
        assert.match(escalation.detail, new RegExp(`moved from ${C1.slice(0, 12)} to ${C2.slice(0, 12)}`));
      } else {
        assert.equal(escalation, undefined, 'the alignment\u2019s own HEAD move raises no drift attention, whatever its restart answered');
        assert.ok(alignments >= 2, 'later cycles offered the alignment again: nothing blocked it');
      }
      await cleanup();
    } finally { await fixture.cleanup(); }
  });
}

