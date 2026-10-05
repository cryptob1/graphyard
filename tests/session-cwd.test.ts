// GY-866: no session Graphyard launches starts where the master starts. Every role's launch is
// built here the way the loop builds it — the real launch functions against a stubbed Herdr — and
// the pane's `--cwd`, the launch files' checkout and the runtime's recorded working folder must be
// the session's own managed checkout (or its assigned worktree, or the loop's scratch checkout for
// the sessions that have none), never the coordinator checkout. The coordinator checkout's own
// guard is exercised the way the loop and an executor run it: a dirty tree or a moved HEAD is
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
import type { ActionRow } from '../src/model/actions.js';
import { bwrapOnPath, coordinatorCheckoutRefusal, readCoordinatorCheckout, readOnlyMountWrapper } from '../src/master/profiles.js';
import { readApproverLaunches } from '../src/master/autonomy.js';
import { dataDirectory, orphanGraceMs, worktreeRoot } from '../src/install/worktree-root.js';
import { atomicPrivateWrite, dispatchWork, launchApprover, launchEscalationHandler, loadMasterConfig, readEscalationSessions, masterConfigSchema, saveProducerProfile, setupMaster, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { launchProducer, loopScratchCheckout, readProducerLedger, reclaimCheckouts } from '../src/producer.js';
import { applyResearchEvent, clearResearchRuns, type ResearchEvent } from '../src/research.js';
import { clearDiagnoses, diagnosesSettled, type DiagnosticianEffects } from '../src/daemon/diagnosis.js';
import { faultClassItem, type FaultInstance } from '../src/model/fault-classes.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import { bindReviewer, launchReview, saveReviewerProfile } from '../src/reviewer.js';
import { docsSyncMaxMs, launchDocsSync, type DocsSyncPlan } from '../src/docs-sync.js';
import { controlPlaneHandlers, type ControlPlaneEffects } from '../src/executor.js';
import { emptyDaemonState, runDaemon, type DaemonEffects } from '../src/master-daemon.js';
import type { HerdrAgent } from '../src/master/herdr.js';
import type { Runner } from '../src/runner/types.js';
import type { EscalationContext } from '../src/model/escalation-context.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

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
  return { id: 'work-866', key: 'GY-866', title: 'Sessions start in their own checkout', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
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
 * pointed at its own temporary directory. The repository holds one commit, so a release commit
 * exists for the loop's scratch checkout.
 */
async function installed(options: { research?: boolean } = {}) {
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
  await atomicPrivateWrite(join(directory, '.graphyard/master.json'), { ...config, approver: { id: 'graphyard-approver-project', credentialFile: await token('approver') }, operatorAgent: { id: 'graphyard-operator-project', credentialFile: await token('operator') }, run: { ...config.run, worktreeRoot: managed, ...(options.research ? { research: { command: 'pi' } } : {}) } });
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const head = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const fullConfig = await loadMasterConfig(directory);
  return { root: directory, head, token, config: fullConfig, cleanup: async () => {
    // The loop's scratch checkout outlives the loop, so the fixture takes it back with its managed root.
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
/**
 * A reclaim pass run long past the orphan grace keeps `directory`, while it removes a stray
 * managed directory no session owns — so the pass did run, and what it left was owned.
 */
async function survivesReclaim(root: string, config: MasterConfig, directory: string) {
  const managedRoot = worktreeRoot(root, config);
  const stray = join(managedRoot, `graphyard-approval-stray-${'0'.repeat(7)}-${'1'.repeat(8)}`);
  await mkdir(stray, { recursive: true });
  const report = await reclaimCheckouts(root, config, { now: Date.now() + 4 * orphanGraceMs });
  assert.ok(report.removed.includes(resolve(stray)), 'the reclaim pass removes a managed directory no session owns');
  return existsSync(directory) && !report.removed.includes(resolve(directory));
}

/** Effects both the loop's guard and the steps read: a snapshot over `work`, and stubs for everything else. */
function loopEffects(work: unknown[], overrides: Record<string, unknown> = {}): DaemonEffects & ControlPlaneEffects {
  const base = {
    agents: () => [] as never[],
    credentials: async (profiles: { name: string }[]) => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    workerCredentials: async () => ({}), producerCredentials: async () => ({}),
    mutate: async () => ({}), dispatchWorker: async () => ({}), launchReview: async () => ({}), launchProducer: async () => ({}), merge: async () => ({}),
    snapshot: async () => ({ work: work as Work[], now: iso(0) }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(0), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
  };
  return { ...base, ...overrides } as DaemonEffects & ControlPlaneEffects;
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

test('unit:session-cwd-own-checkout — an approver session opens its pane and starts its runtime in a managed checkout of its own, never in the coordinator checkout', async () => {
  const fixture = await installed();
  try {
    const { root, cleanup } = fixture;
    const stub = herdr();
    await launchApprover(root, work(), 'decision-1', 'claude', { agents: [], available: true }, stub.run);
    assert.equal(stub.tabs.length, 1, 'one Herdr tab is created for the approver');
    const pane = paneCwd(stub.tabs[0]);
    assert.ok(pane, 'the approver pane is created with an explicit --cwd');
    assert.ok(outsideCoordinator(pane!, root), `the approver pane opens outside the coordinator checkout, not ${pane}`);
    assert.equal(existsSync(pane!), true, 'the approver pane opens in a checkout that exists');
    const sessionCheckout = checkoutOfStem(stub.typed[0].stem);
    assert.equal(resolve(pane!), resolve(sessionCheckout!), 'the pane opens exactly where the approver checkout is');
    // What its request runs works from there: `master decisions`, `approve` and `refuse` resolve
    // the coordinator's installation from the root the tab hands it, and gh and git reads reach
    // the repository from the directory itself.
    const handed = tabEnv(stub.tabs[0], 'GRAPHYARD_REPOSITORY_ROOT');
    assert.equal(handed, root, 'the approver tab hands the session the coordinator root');
    assert.equal(realpathSync(cliRoot(pane!, { GRAPHYARD_REPOSITORY_ROOT: handed! })), realpathSync(root), 'graphyard master commands run from where the approver starts resolve the coordinator installation');
    assert.ok(obtainsCode(pane!, join(pane!, 'checkout'), fixture.head, root), 'git reads from where the approver starts reach the repository');
    // The directory is owned while the session's launch record is kept: a reclaim pass past the grace leaves it.
    assert.equal((await readApproverLaunches(root)).at(-1)?.checkout, pane, 'the launch record names the approver checkout');
    assert.ok(await survivesReclaim(root, fixture.config, pane!), 'a reclaim pass past the orphan grace leaves the approver checkout');
    await cleanup();
  } finally { await fixture.cleanup(); }
});

test('unit:session-cwd-own-checkout — an escalation handler opens its pane and starts its runtime in a managed checkout of its own, never in the coordinator checkout', async () => {
  const fixture = await installed();
  try {
    const { root, config, cleanup } = fixture;
    const stub = herdr();
    const context = { key: 'GY-866', escalation: { trigger: 'requirement-weakening' }, fingerprint: 'f'.repeat(64) } as unknown as EscalationContext;
    await launchEscalationHandler(root, config, context, 'claude', [], stub.run);
    assert.equal(stub.tabs.length, 1, 'one Herdr tab is created for the handler');
    const pane = paneCwd(stub.tabs[0]);
    assert.ok(pane, 'the escalation handler pane is created with an explicit --cwd');
    assert.ok(outsideCoordinator(pane!, root), `the escalation handler pane opens outside the coordinator checkout, not ${pane}`);
    assert.equal(existsSync(pane!), true, 'the escalation handler pane opens in a checkout that exists');
    // The one checkout the launch allocated under the managed worktree root is where it opens.
    const managedRoot = worktreeRoot(root, config);
    const allocated = (await readdir(managedRoot)).filter(name => /^graphyard-approval-/.test(name)).map(name => join(managedRoot, name));
    assert.equal(allocated.length, 1, 'the launch allocates one managed checkout for the handler');
    assert.equal(resolve(pane!), resolve(allocated[0]), 'the pane opens exactly in the checkout the handler was allocated');
    assert.equal(dirname(resolve(pane!)), resolve(managedRoot));
    assert.match(basename(pane!), /^graphyard-approval-gy-866-/i, 'the checkout is the handler\'s own, named for its item');
    assert.deepEqual(stub.pasted, [], 'the handler takes its request on its command line, never a paste');
    // `master decide` resolves the coordinator installation from where it starts with the root its tab hands it.
    const handed = tabEnv(stub.tabs[0], 'GRAPHYARD_REPOSITORY_ROOT');
    assert.equal(handed, root, 'the handler tab hands the session the coordinator root');
    assert.equal(realpathSync(cliRoot(pane!, { GRAPHYARD_REPOSITORY_ROOT: handed! })), realpathSync(root), 'graphyard master decide run from where the handler starts resolves the coordinator installation');
    assert.equal((await readEscalationSessions(root)).at(-1)?.checkout, pane, 'the handler record names its checkout');
    assert.ok(await survivesReclaim(root, config, pane!), 'a reclaim pass past the orphan grace leaves the handler checkout');
    await cleanup();
  } finally { await fixture.cleanup(); }
});

test('unit:session-cwd-own-checkout — a docs-sync session opens its pane and starts its runtime in the worktree its launcher created inside a managed checkout of its own, never in the coordinator checkout', async () => {
  const fixture = await installed();
  try {
    const { root, cleanup } = fixture;
    const stub = herdr();
    // The launcher itself creates the worktree of the reviewed head (GY-1205): git runs for real.
    const run = (command: string, args: string[], options?: unknown) => command === 'git' ? execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }) : stub.run(command, args);
    const home = await temporaryDirectory('session-cwd-claude-home');
    await saveReviewerProfile(root, { name: 'reviewer-claude', agentName: 'review-claude-1', kind: 'claude', environment: { CLAUDE_CONFIG_DIR: home } });
    const plan: DocsSyncPlan = { key: 'GY-866', pr: 866, branch: 'graphyard/gy-866-7', baseBranch: 'main', head: fixture.head, base: fixture.head, paths: ['docs/master-agent.md'] };
    await launchDocsSync(root, work(), plan, { agents: [], available: true }, run as never);
    assert.equal(stub.tabs.length, 1, 'one Herdr tab is created for the docs-sync session');
    const pane = paneCwd(stub.tabs[0]);
    assert.ok(pane, 'the docs-sync pane is created with an explicit --cwd');
    assert.ok(!resolve(pane!).startsWith(`${resolve(root)}${sep}`) && resolve(pane!) !== resolve(root), `the docs-sync pane opens outside the coordinator checkout, not ${pane}`);
    const checkout = dirname(resolve(pane!));
    assert.equal(dirname(checkout), resolve(worktreeRoot(root, fixture.config)), 'the docs-sync pane opens in a checkout under the managed worktree root');
    assert.equal(existsSync(join(pane!, 'src', 'loop.ts')), true, 'the launcher created the worktree of the reviewed head the pane opens in');
    assert.equal(resolve(checkoutOfStem(stub.typed[0].stem)!), resolve(pane!), 'the runtime starts, and reads its request, exactly where the pane opens');
    assert.equal(stub.pasted.length, 0, 'the instruction is the session\'s own first request, never pasted');
    const request = stub.typed[0].args.at(-1)!;
    assert.ok(request.includes(`You start in ${pane}`), 'the request names the worktree inside the session\'s own checkout');
    assert.ok(!request.includes(join(root, '.graphyard', 'docs-sync')), 'the request names no worktree under the coordinator checkout');
    assert.equal(tabEnv(stub.tabs[0], 'GRAPHYARD_REPOSITORY_ROOT'), root, 'the docs-sync tab hands the session the coordinator root');
    // No ledger owns the directory: the launching process holds it for the session's bounded life.
    assert.ok(docsSyncMaxMs > orphanGraceMs, 'a docs-sync session may outlive the orphan grace, so its checkout must be held');
    assert.ok(await survivesReclaim(root, fixture.config, checkout), 'a reclaim pass past the orphan grace leaves the docs-sync checkout');
    await rm(home, { recursive: true, force: true });
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

test('unit:session-cwd-own-checkout — the loop starts its diagnostician in the managed scratch checkout of the release it runs, never in the coordinator checkout', async () => {
  const fixture = await installed();
  try {
    const { root, head, config, cleanup } = fixture;
    const managedRoot = worktreeRoot(root, config);
    const started: { cwd: string; holdsRelease: boolean }[] = [];
    const runner: Runner = {
      name: 'stub',
      start: (_prompt, options) => {
        started.push({ cwd: options.cwd, holdsRelease: existsSync(join(options.cwd, 'src', 'loop.ts')) });
        return { id: 'run-1', events: [], onEvent: () => () => {}, cancel: () => {},
          result: async () => ({ ok: false as const, failure: { reason: 'cancelled' as const, detail: 'the test stub settles at once' }, payloads: [] }) };
      },
    };
    const settings = diagnosticianSettings({ diagnostician: { invariantBoundMinutes: 30 } });
    // The production wiring hands the loop's own checkout as the diagnostician's cwd; the loop must
    // replace it with the scratch checkout before the run starts.
    const diagnostician: DiagnosticianEffects = {
      settings, cwd: root,
      runner: async () => ({ runner, runtime: 'pi', model: settings.model }),
      context: async () => ({ journal: [], serverLog: [], pullRequests: [] }),
      file: async () => { throw new Error('the stub files nothing'); },
      decide: async () => { throw new Error('the stub decides nothing'); },
    };
    const state = emptyDaemonState(config);
    const instances: FaultInstance[] = ['GY-1', 'GY-2', 'GY-3'].map((subject, index) => ({ id: `blocker|${subject}|${iso(-index * 60_000)}`, kind: 'blocker', faultClass: 'stalled-gate',
      subject, text: `${subject} waits on the merge of PR #77`, at: iso(-index * 60_000), lastSeenAt: iso(0), linkedTo: 'GY-101' }));
    state.faults.instances.push(...instances);
    const input = faultClassItem({ faultClass: 'stalled-gate', recent: instances }, { threshold: 3, windowHours: 24 }, Date.parse(iso(0)));
    const recurring = { ...ready(), id: 'work-101', key: 'GY-101', stage: 'backlog', ready: false, title: input.title, description: input.description, origin: input.origin, type: 'bug' } as unknown as Work;
    try {
      await runDaemon(config, state, loopEffects([recurring], { loadedRelease: { commit: head, dirty: false }, diagnostician }), loopOptions(fixture));
      await diagnosesSettled();
    } finally { clearDiagnoses(); }
    assert.equal(started.length, 1, 'one diagnostician run starts');
    const [run] = started;
    assert.ok(outsideCoordinator(run.cwd, root) && !run.cwd.startsWith(resolve(root)), `the diagnostician does not start in the coordinator checkout (${run.cwd})`);
    assert.ok(run.cwd.startsWith(resolve(managedRoot)), `the diagnostician starts under the managed worktree root (${run.cwd})`);
    assert.match(run.cwd.split(sep).at(-2)!, /^graphyard-approval-loop-scratch-/, 'the diagnostician starts in the loop scratch checkout');
    assert.ok(run.holdsRelease, 'the scratch checkout holds the release the loop runs, so the diagnostician reads real code');
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

test('unit:session-cwd-own-checkout — the loop starts its research and triage sessions in a managed scratch checkout of the release it runs, never in the coordinator checkout', async () => {
  const fixture = await installed({ research: true });
  try {
    const { root, head, config, cleanup } = fixture;
    const managedRoot = worktreeRoot(root, config);
    const started: { prompt: string; cwd: string; tool: string; holdsRelease: boolean }[] = [];
    const runner: Runner = {
      name: 'stub',
      start: (prompt, options) => {
        // The moment the session starts is the moment its checkout must already hold the code.
        started.push({ prompt, cwd: options.cwd, tool: options.tool, holdsRelease: existsSync(join(options.cwd, 'src', 'loop.ts')) });
        return { id: 'run-1', events: [], onEvent: () => () => {}, cancel: () => {},
          result: async () => ({ ok: false as const, failure: { reason: 'cancelled' as const, detail: 'the test stub settles at once' }, payloads: [] }) };
      },
    };
    const researchEvents: unknown[] = [], triageEvents: unknown[] = [];
    // The production wiring hands the loop's own checkout as the research cwd; the loop must
    // replace it with the scratch checkout before any session starts.
    const effects = loopEffects([ready(), machineFiled()], {
      loadedRelease: { commit: head, dirty: false },
      recordResearch: async (item: Work, event: unknown) => { researchEvents.push({ key: item.key, event }); },
      recordTriage: async (item: Work, event: unknown) => { triageEvents.push({ key: item.key, event }); },
      research: { cwd: root, runner },
    });
    const logs: string[] = [];
    await runDaemon(config, emptyDaemonState(config), effects, loopOptions(fixture));
    assert.equal(started.length, 2, 'one research session and one triage session start');
    for (const run of started) {
      assert.ok(!run.cwd.startsWith(resolve(root)), `no research or triage session starts in the coordinator checkout (${run.cwd})`);
      assert.ok(run.cwd.startsWith(resolve(managedRoot)), `the session starts under the managed worktree root (${run.cwd})`);
      const name = run.cwd.split(sep).at(-2);
      assert.match(name!, /^graphyard-approval-loop-scratch-/, 'the session starts in the loop scratch checkout');
      assert.ok(run.holdsRelease, 'the scratch checkout holds the release the loop runs, so the session reads real code');
    }
    assert.equal(started[0].cwd, started[1].cwd, 'research and triage share the one scratch checkout this loop allocated');
    assert.equal(existsSync(started[0].cwd), true, 'the scratch checkout outlives the loop: research runs detached into it keep working there');
    assert.ok(researchEvents.length >= 1, 'the research run is recorded on the item');
    assert.ok(triageEvents.length === 0, 'a run that settles without a judgement records no triage judgement');
    await cleanup();
  } finally { await fixture.cleanup(); }
});

test('unit:session-cwd-own-checkout — the loop keeps its scratch checkout: a reclaim pass past the orphan grace leaves it while the loop runs and after it stops', async () => {
  const fixture = await installed({ research: true });
  try {
    const { root, head, config, cleanup } = fixture;
    const managedRoot = worktreeRoot(root, config);
    const runner: Runner = { name: 'stub', start: () => { throw new Error('no session starts in this test'); } };
    const seen: { scratch: string | null; survives: boolean }[] = [];
    // A cycle reads the snapshot first: there, with the loop running, the reclaim pass that runs
    // every cycle in production is run long past the orphan grace.
    const effects = loopEffects([], {
      loadedRelease: { commit: head, dirty: false }, research: { cwd: root, runner },
      snapshot: async () => {
        const name = (await readdir(managedRoot)).find(entry => /^graphyard-approval-loop-scratch-/.test(entry));
        const scratch = name ? join(managedRoot, name) : null;
        seen.push({ scratch, survives: !!scratch && await survivesReclaim(root, config, scratch) && existsSync(join(scratch, 'checkout', 'src', 'loop.ts')) });
        return { work: [], now: iso(0) };
      },
    });
    await runDaemon(config, emptyDaemonState(config), effects, loopOptions(fixture));
    assert.ok(seen.length >= 1, 'the loop ran at least one cycle');
    for (const cycle of seen) {
      assert.ok(cycle.scratch, 'the loop allocated its scratch checkout before its first cycle');
      assert.ok(cycle.survives, 'a reclaim pass past the orphan grace leaves the scratch checkout, with its release, while the loop runs');
    }
    assert.ok(await survivesReclaim(root, config, seen[0].scratch!), 'a reclaim pass with no loop running leaves the scratch checkout too: a detached research run may still work in it');
    await cleanup();
  } finally { await fixture.cleanup(); }
});

test('unit:session-cwd-own-checkout — a restarted loop finds the research run the loop before it detached into the scratch checkout, and adopts it', async () => {
  const fixture = await installed({ research: true });
  try {
    const { root, head, config, cleanup } = fixture;
    const started: { cwd: string; directory: string }[] = [], adopted: string[] = [];
    const pending = { id: 'run-1', events: [], onEvent: () => () => {}, cancel: () => {}, detach: () => {}, result: () => new Promise<never>(() => {}) };
    // A research run that is still working when its loop stops: its directory is in the registry
    // under the cwd it was started in, and it never settles while the test runs.
    const runner: Runner = {
      name: 'stub',
      start: (_prompt, options) => {
        const directory = join(options.runs!, 'research-run-1');
        mkdirSync(directory, { recursive: true });
        started.push({ cwd: options.cwd, directory });
        return { ...pending, directory };
      },
      adopt: (directory: string) => { adopted.push(directory); return { ...pending, directory }; },
    } as Runner;
    const item = { ...ready(), type: 'feature' } as Work;
    const events: ResearchEvent[] = [];
    const record = async (_work: Work, event: ResearchEvent) => { events.push(event); };
    try {
      await runDaemon(config, emptyDaemonState(config), loopEffects([item], { loadedRelease: { commit: head, dirty: false }, recordResearch: record, research: { cwd: root, runner } }), loopOptions(fixture));
      assert.equal(started.length, 1, 'the first loop starts one research run');
      assert.equal(existsSync(started[0].directory), true, 'the run\'s registry entry survives the loop that started it');
      // The restart: the process that started the run is gone, and the plane records it as running.
      clearResearchRuns();
      const running = { ...item, researchBrief: applyResearchEvent(item, events.find(event => event.event === 'started')!, 'graphyard-master', new Date()) } as Work;
      await runDaemon(config, emptyDaemonState(config), loopEffects([running], { loadedRelease: { commit: head, dirty: false }, recordResearch: record, research: { cwd: root, runner } }), loopOptions(fixture));
    } finally { clearResearchRuns(); }
    assert.equal(started.length, 1, 'the restarted loop starts no second run');
    assert.deepEqual(adopted, [started[0].directory], 'the restarted loop adopts the run from the registry in the same scratch checkout');
    assert.ok(!events.some(event => event.event === 'failed'), 'the run is not written off as a timeout');
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
    const escalation = state.actions['escalation:dirty-checkout'];
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

test('unit:coordinator-checkout-drift-detected — the loop checks the checkout every cycle: a tree that turns dirty under a running loop is attention, and the self-upgrade waits', async () => {
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
    assert.equal(upgrades, 0, 'the self-upgrade is skipped from the cycle the tree turned dirty');
    const escalation = state.actions['escalation:dirty-checkout'];
    assert.ok(escalation, 'the turned-dirty tree is raised as attention');
    assert.match(escalation.detail, /src\/loop\.ts/);
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
    const escalation = state.actions['escalation:dirty-checkout'];
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
      const escalation = state.actions['escalation:dirty-checkout'];
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
      if (alignments === 1 && phase === 2) { upgrades.push(phase); return { outcome: 'upgraded' as const, from: C1, to: C2, code: false, executors: null, self: false }; }
      return { outcome: 'skipped' as const, reason: 'already aligned' };
    } });
    const stopTimer = setTimeout(() => stop.fire(), 40);
    void stopTimer;
    await runDaemon(config, state, effects, { intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGTERM'], process: fakeProcess, checkout, log: () => {} });
    clearTimeout(stopTimer);
    assert.deepEqual(upgrades, [2], 'the alignment ran once on the clean checkout');
    assert.ok(alignments >= 2, 'the next cycle offered the alignment again and it found nothing to move');
    assert.equal(state.actions['escalation:dirty-checkout'], undefined, 'the alignment\u2019s own HEAD move raises no drift attention');
    assert.ok(phase >= 4, 'the loop checked the coordinator checkout on every cycle');
    await cleanup();
  } finally { await fixture.cleanup(); }
});

test('unit:coordinator-checkout-drift-detected — an executor refuses every claim on a dirty coordinator checkout, and runs once it is clean', async () => {
  const fixture = await installed();
  try {
    const { root, config, cleanup } = fixture;
    const original = await readFile(join(root, 'src', 'loop.ts'), 'utf8');
    await writeFile(join(root, 'src', 'loop.ts'), `${original}\nexport const halfFinished = true;\n`);
    await writeFile(join(root, 'tests', 'scratch.test.ts'), 'import { test } from "node:test";\n');
    const row = { id: 'a1', key: 'GY-852', work: 'w1', kind: 'dispatch', inputs: { kind: 'dispatch', target: 'implementation', epoch: 3 } } as unknown as ActionRow;
    let snapshotReads = 0;
    const dirtyHandlers = controlPlaneHandlers(() => config, loopEffects([], { snapshot: async () => { snapshotReads++; return { work: [] as Work[], now: iso(0) }; } }));
    const run = (handler: unknown, action: unknown) => (handler as (action: unknown, identity: unknown) => Promise<unknown>)(action, { id: 'exec', host: 'machine-a' });
    await assert.rejects(run(dirtyHandlers.dispatch!, row), (error: Error) => /holds uncommitted work/.test(error.message) && /src\/loop\.ts/.test(error.message));
    assert.equal(snapshotReads, 0, 'a refused executor reads nothing and runs nothing');
    await writeFile(join(root, 'src', 'loop.ts'), original);
    await rm(join(root, 'tests', 'scratch.test.ts'));
    const claimed = { key: 'GY-852', id: 'w1', lease: { epoch: 3, owner: 'graphyard-claude-1', expiresAt: iso(hour) }, plannedFiles: ['src/loop.ts'] };
    const cleanHandlers = controlPlaneHandlers(() => ({ ...config, url: '' }), loopEffects([claimed]));
    await assert.rejects(run(cleanHandlers.dispatch!, row), /no worker profile can take GY-852/, 'with a clean checkout the executor handler runs');
    await cleanup();
  } finally { await fixture.cleanup(); }
});
