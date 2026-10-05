import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import type { NextActionKind } from '../src/model/next-action.js';
import { classifyAttention, trackFaults, type FaultRecord } from '../src/model/fault-classes.js';
import { allocateManagedCheckout, assertOutsideWorktrees, diskExhaustion, diskExhaustionMessage, loadMasterConfig, managedRootStatus, masterRunSchema, reclaimAdvice, saveProducerProfile, sessionHarnessPlan, setupMaster, sharedGitDirectory, worktreeRootAttention, writeFailure, masterConfigSchema, type MasterConfig, type MasterRun, type WorkerProfile } from '../src/master.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { daemonSummary } from '../src/daemon/run.js';
import { cycleFaults } from '../src/daemon/faults.js';
import { memoryActionKey } from '../src/daemon/cycle-dispatch.js';
import { emptyDispatchCursor, launchingKinds, runDispatchTick, runExecutorTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { hostMemoryAttention, hostMemoryFloor, hostMemoryHold, memoryConsumers, memoryRecoveryMarginBytes, type HostMemoryReading } from '../src/master-resources.js';
import { acquireVerificationSlot, defaultVerificationSlots, heavyCommand, heldSlots, verificationBin, verificationEnvironment, verificationSlotsDirectory, withVerificationPath } from '../src/master/verification-slots.js';
import { sessionSlotsGrant } from '../src/master/harness.js';
import { accountLaunch } from '../src/master/environments.js';
import { grantWorkerPaths, verifyWorkerSandbox } from '../src/worker-sandbox.js';
import { launchProducer, producerPrompt, readProducerLedger, reclaimCheckouts, reconcileProducers, producerIdleGraceMs, type ProducerBinding } from '../src/producer.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, reviewIdleGraceMs, reviewPrompt, saveReviewerProfile } from '../src/reviewer.js';
import { allocateSessionCheckout, dataDirectory, defaultWorktreeRoot, inspectWorktreeRoot, orphanGraceMs, probeFilesystem, reclaimCommand, reclaimSessionCheckouts, removeSessionCheckout, sessionCheckout, sweepAbandonedRoots, verifyWorktreeRoot, worktreeRoot, worktreeRootBudgetBytes, worktreeRootMinFreeBytes, type FilesystemProbe } from '../src/install/worktree-root.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// Each test is named for the proof it produces: integration:managed-worktree-root,
// integration:ephemeral-checkout-reclaim, integration:worktree-root-preflight and
// unit:disk-exhaustion-message. The suite's own scratch space is the system temporary directory,
// which is a tmpfs on some hosts, so the volume a launch sees is injected: a durable one unless a
// case is about refusing a volatile one.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const coordinatorStatus = (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch;
const H = 'a'.repeat(40), B = 'b'.repeat(40);
const durable: FilesystemProbe = async path => ({ probed: path, volatile: null, freeBytes: 200e9 });
const memory: FilesystemProbe = async path => ({ probed: path, volatile: 'tmpfs', freeBytes: 200e9 });
const free = (bytes: number): FilesystemProbe => async path => ({ probed: path, volatile: null, freeBytes: bytes });
const future = (ms: number) => new Date(Date.now() + ms).toISOString();

function herdr(calls: string[][] = []) {
  let pane = 0;
  return (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'tab') { pane++; return JSON.stringify({ result: { type: 'tab_created', root_pane: { pane_id: `pane-${pane}`, tab_id: `tab-${pane}` }, tab: { tab_id: `tab-${pane}` } } }); }
    return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
}
// Since GY-93 the request is the session's own first message: the last argument of its command
// line, which since GY-121 the shell reads from the request file the typed line references.
const launchOf = (calls: string[][]) => expandTypedCommand(calls.find(args => args[0] === 'pane' && args[1] === 'run')![3]);
const promptOf = (calls: string[][]) => launchOf(calls).args.at(-1)!;

/** A managed repository with one commit, a bound reviewer, a reviewer profile and two producer profiles, its worktree root under `managed`. */
async function installation(run: Partial<MasterRun> = {}) {
  const scratch = await realpath(await temporaryDirectory('managed-root'));
  const root = join(scratch, 'repository'), credentialDirectory = join(scratch, 'credentials'), managed = join(scratch, 'data', 'worktrees');
  await mkdir(root); await mkdir(credentialDirectory, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main'); git('remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(root, 'README.md'), 'managed worktree root\n');
  git('add', 'README.md'); git('-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.test', 'commit', '-q', '-m', 'initial');
  await setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, herdrWorkspace: 'workspace', run: { worktreeRoot: managed, ...run } }, coordinatorStatus, { probe: durable });
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentialDirectory, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'reviewer-a', agentName: 'review-a', kind: 'codex' });
  const credential = join(credentialDirectory, 'producer.token'); await writeFile(credential, 'producer-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const verify = (id: string) => async () => ({ actor: { id, role: 'producer', proofs: ['unit:*', 'integration:*'] } });
  await saveProducerProfile(root, { name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'codex', credentialFile: credential }, verify('proof-runner'));
  return { scratch, root, managed, git, cleanup: () => rm(scratch, { recursive: true, force: true }) };
}

let serial = 0;
function request(proofs = ['integration:managed-worktree-root']) {
  return { id: `request-${++serial}`, kind: 'producer', sha: H, baseSha: B, policyRevision: 2, pr: 88, group: 'integration', proofs, state: 'requested', requestedAt: new Date().toISOString(), reason: 'r' } as any;
}
function work(key: string, overrides: Partial<Work> = {}): Work {
  const candidate = { sha: H, baseSha: B, pr: 88, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
  return { id: `id-${key}`, key, title: 'Managed worktree root', description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:managed-worktree-root'] }], policy: { checks: ['test'], review: true }, stage: 'review', revision: 3, policyRevision: 2,
    createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 88 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    blocker: null, gates: [], violations: [], implementers: ['implementer'],
    observation: { at: new Date().toISOString(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], prState: 'open', draft: false },
    ...overrides } as unknown as Work;
}
const producing = (key: string, asked: any) => work(key, { autoDispatch: { review: null, producers: [asked], history: [] } } as any);

/** What a session does with the directory it was given: a registered detached worktree, an install inside it, an evidence file beside it. */
async function occupy(git: (...args: string[]) => string, directory: string) {
  git('worktree', 'add', '--detach', join(directory, 'checkout'), 'HEAD');
  await mkdir(join(directory, 'checkout', 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(join(directory, 'checkout', 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');
  await writeFile(join(directory, 'proof.evidence.json'), '{}\n');
}
const registered = (git: (...args: string[]) => string) => git('worktree', 'list', '--porcelain');

test('integration:managed-worktree-root — producer and reviewer checkouts are allocated under the one configured root, outside every worktree, and nothing names the temporary directory', async () => {
  const { root, managed, scratch, git, cleanup } = await installation();
  try {
    const config = await loadMasterConfig(root);
    assert.equal(worktreeRoot(root, config), managed, 'the configured root is the root');

    // A producer session: its directory sits directly under the root, exists before the session
    // starts, is the only path beside the Git directory a sandboxed runtime may write, and is the
    // path its prompt names for the worktree and for every evidence file.
    const asked = request(), produceCalls: string[][] = [];
    const produced = await launchProducer(root, producing('GY-88', asked), asked, config.producers[0], [], new Date().toISOString(), { run: herdr(produceCalls), filesystem: durable });
    assert.equal(dirname(produced.checkout), managed);
    assert.match(produced.checkout, /\/graphyard-proof-gy-88-aaaaaaa-[0-9a-f]{8}$/);
    assert.ok(existsSync(produced.checkout));
    assert.equal((await readProducerLedger(root)).producers[0].checkout, produced.checkout, 'the session record owns the checkout');
    const produceStart = launchOf(produceCalls).args;
    assert.deepEqual(produceStart.slice(produceStart.indexOf('--add-dir'), -1), ['--add-dir', produced.checkout, '--add-dir', await sharedGitDirectory(root), '--add-dir', join(managed, '.verification-slots')]);
    assert.equal(launchOf(produceCalls).stem, join(produced.checkout, '.graphyard/launch/produce-a'), 'the request file lives in the session\'s own checkout');
    const producerText = promptOf(produceCalls);
    assert.ok(producerText.includes(`git worktree add --detach ${join(produced.checkout, 'checkout')} ${H}`));
    assert.ok(producerText.includes(join(produced.checkout, 'integration-managed-worktree-root.evidence.json')));
    assert.match(producerText, /never under a temporary directory/);

    // A reviewer session: the same root, the same rule, and a harness that lets it check the head
    // out at that one path only.
    const reviewCalls: string[][] = [];
    const reviewed = await launchReview(root, work('GY-89'), 'reviewer-a', [], new Date().toISOString(), { run: herdr(reviewCalls), mint: async () => ({ token: 'ghs_session_token_value', expiresAt: future(3_000_000) }), filesystem: durable });
    assert.equal(dirname(reviewed.checkout), managed);
    assert.match(reviewed.checkout, /\/graphyard-review-gy-89-aaaaaaa-[0-9a-f]{8}$/);
    assert.equal((await readReviewLedger(root)).reviews[0].checkout, reviewed.checkout);
    const reviewStart = launchOf(reviewCalls).args;
    assert.deepEqual(reviewStart.slice(reviewStart.indexOf('--add-dir'), -1), ['--add-dir', reviewed.checkout, '--add-dir', await sharedGitDirectory(root), '--add-dir', join(managed, '.verification-slots')]);
    assert.ok(promptOf(reviewCalls).includes(`git worktree add --detach ${join(reviewed.checkout, 'checkout')} ${H}`));
    const plan = sessionHarnessPlan({ role: 'reviewer', kind: 'claude', cliPath: launcher, repository: 'owner/project', baseBranch: 'main', credentialHome: scratch, credentialDirectories: [], pr: 88, checkout: join(reviewed.checkout, 'checkout') });
    assert.ok(plan.allow.some(entry => entry.rule === `Bash(git worktree add --detach ${join(reviewed.checkout, 'checkout')}:*)`), 'a reviewer may add a worktree at its allocated path and nowhere else');
    assert.ok(!plan.allow.some(entry => entry.rule === 'Bash(git worktree add:*)'));

    // Still outside every worktree, and still enforced by assertOutsideWorktrees: both allocated
    // directories pass it, and a root placed inside the repository, inside an assignment worktree
    // or inside a session's own registered checkout is refused before anything is created there.
    await assertOutsideWorktrees(root, produced.checkout, 'An ephemeral checkout');
    await assertOutsideWorktrees(root, reviewed.checkout, 'An ephemeral checkout');
    const assignment = join(root, '.graphyard/worktrees/GY-88-1');
    git('worktree', 'add', '-q', '-b', 'graphyard/gy-88-1', assignment, 'HEAD');
    await occupy(git, produced.checkout);
    for (const inside of [join(root, 'proofs'), join(assignment, 'proofs'), join(produced.checkout, 'checkout', 'nested')]) {
      const misplaced = { ...config, run: { ...config.run, worktreeRoot: inside } };
      await assert.rejects(allocateManagedCheckout(root, misplaced, 'proof', 'GY-88', H, randomUUID(), durable), /The managed worktree root must be outside every worktree of the repository/);
      assert.equal(existsSync(inside), false, 'a refused root is never created');
    }
    await assert.rejects(setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory: join(scratch, 'credentials'), run: { worktreeRoot: join(root, 'proofs') } }, coordinatorStatus, { probe: durable }), /outside every worktree/);
    assert.throws(() => masterRunSchema.parse({ worktreeRoot: 'relative/root' }), /absolute path/);

    // The default: inside the installation's data directory, one root per installation, never
    // derived from the temporary directory or from a variable a session runtime repoints.
    assert.equal(dataDirectory({}), resolve(homedir(), '.local/share/graphyard'));
    assert.equal(dataDirectory({ GRAPHYARD_DATA_HOME: '/srv/graphyard', XDG_DATA_HOME: '/elsewhere', TMPDIR: '/elsewhere' }), '/srv/graphyard');
    assert.equal(dataDirectory({ XDG_DATA_HOME: '/account/home', TMPDIR: '/scratch' }), resolve(homedir(), '.local/share/graphyard'));
    assert.throws(() => dataDirectory({ GRAPHYARD_DATA_HOME: 'relative' }), /absolute path/);
    const fallback = defaultWorktreeRoot(root, 'owner/project', { GRAPHYARD_DATA_HOME: '/srv/graphyard' });
    assert.match(fallback, /^\/srv\/graphyard\/worktrees\/project-[0-9a-f]{12}$/);
    assert.notEqual(fallback, defaultWorktreeRoot(join(scratch, 'second-clone'), 'owner/project', { GRAPHYARD_DATA_HOME: '/srv/graphyard' }), 'two clones never reclaim each other\'s checkouts');
    assert.equal(worktreeRoot(root, { repository: 'owner/project', run: {} }, { GRAPHYARD_DATA_HOME: '/srv/graphyard' }), fallback);

    // No generated prompt and no code path hardcodes /tmp: a prompt for a root elsewhere never
    // mentions it, and the sources that place checkouts hold no such literal.
    const binding: ProducerBinding = { key: 'GY-88', id: 'id', pr: 88, sha: H, baseSha: B, policyRevision: 2, group: 'integration', proofs: ['integration:managed-worktree-root'], requestId: 'request-1', branch: 'graphyard/gy-88-1' };
    const elsewhere = sessionCheckout('/srv/graphyard/worktrees/project-0123456789ab', 'proof', 'GY-88', H, randomUUID());
    for (const text of [producerPrompt(config, binding, { principal: 'proof-runner' }, elsewhere), producerPrompt({ repository: 'owner/project', cliPath: launcher }, binding, { principal: 'proof-runner' }),
      reviewPrompt(config, binding, elsewhere), reviewPrompt(config, binding)]) assert.equal(text.includes('/tmp'), false, 'a generated prompt never names /tmp');
    assert.ok(producerPrompt({ repository: 'owner/project', cliPath: launcher }, binding, { principal: 'proof-runner' }).includes(join(dataDirectory(process.env), 'worktrees')), 'a previewed prompt names the default root the environment configures');
    const sources = fileURLToPath(new URL('../src/', import.meta.url));
    // master.ts and master-daemon.ts re-export their modules under master/ and daemon/ (GY-177).
    const split = async (directory: string) => (await readdir(join(sources, directory))).filter(name => name.endsWith('.ts')).map(name => `${directory}/${name}`);
    for (const file of ['producer.ts', 'reviewer.ts', 'master.ts', ...await split('master'), 'master-daemon.ts', ...await split('daemon'), 'auto-dispatch.ts', 'harness.ts', 'install/worktree-root.ts']) {
      const code = (await readFile(join(sources, file), 'utf8')).split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
      assert.doesNotMatch(code, /['"`]\/tmp\b|tmpdir\(\)/, `${file} places nothing under the temporary directory`);
    }
  } finally { await cleanup(); }
});

test('integration:ephemeral-checkout-reclaim — every checkout is removed when its session resolves, dependency directory included, and a reclaim pass takes back what a dead session left', async () => {
  const { root, managed, git, cleanup } = await installation();
  try {
    const config = await loadMasterConfig(root);
    const gone = (directory: string) => { assert.equal(existsSync(directory), false, `${directory} is removed`); assert.equal(registered(git).includes(directory), false, `${directory} is no longer a registered worktree`); };

    // Producer sessions, one per way a session resolves.
    const launchedAt = Date.now();
    const produce = async (key: string) => {
      const asked = request();
      const launched = await launchProducer(root, producing(key, asked), asked, { ...config.producers[0], agentName: `produce-${key.toLowerCase()}` }, [], new Date().toISOString(), { run: herdr(), filesystem: durable });
      await occupy(git, launched.checkout);
      assert.ok(registered(git).includes(join(launched.checkout, 'checkout')) && existsSync(join(launched.checkout, 'checkout/node_modules/left-pad/index.js')));
      return { asked, checkout: launched.checkout };
    };
    const passing = { id: 'ev', proof: 'integration:managed-worktree-root', sha: H, baseSha: B, policyRevision: 2, producer: 'proof-runner', trusted: true, result: 'pass', executed: 3, skipped: 0, at: new Date().toISOString() };
    const settle = (item: Work, options: { agents?: any[] | null; now?: number } = {}) => reconcileProducers(root, config, [item], options.agents === undefined ? [{ name: 'someone-else', agent_status: 'working' }] as any : options.agents, { run: herdr(), now: () => new Date(options.now ?? launchedAt + 1000) });
    const stateOf = async (checkout: string) => (await readProducerLedger(root)).producers.find(record => record.checkout === checkout)!.state;

    const completed = await produce('GY-101');
    await settle(producing('GY-101', completed.asked), { agents: [{ name: 'produce-gy-101', agent_status: 'working' }] as any });
    assert.equal(await stateOf(completed.checkout), 'pending', 'a live session keeps its checkout');
    assert.ok(existsSync(completed.checkout));
    await settle({ ...producing('GY-101', completed.asked), evidence: [passing] } as any);
    assert.equal(await stateOf(completed.checkout), 'completed'); gone(completed.checkout);

    const cancelled = await produce('GY-102');
    await settle(producing('GY-102', { ...cancelled.asked, state: 'cancelled', resolution: 'withdrawn' }));
    assert.equal(await stateOf(cancelled.checkout), 'cancelled'); gone(cancelled.checkout);

    const failed = await produce('GY-103');
    await settle(producing('GY-103', failed.asked), { agents: [] }); await settle(producing('GY-103', failed.asked), { agents: [], now: launchedAt + 1000 + producerIdleGraceMs });
    assert.equal(await stateOf(failed.checkout), 'failed'); gone(failed.checkout);

    const expired = await produce('GY-104');
    await settle(producing('GY-104', expired.asked), { now: launchedAt + (config.run.producerTimeoutMinutes + 1) * 60_000 });
    assert.equal(await stateOf(expired.checkout), 'expired'); gone(expired.checkout);

    // Reviewer sessions, the same four ways.
    const mint = async () => ({ token: 'ghs_session_token_value', expiresAt: future(3_000_000) });
    const review = async (key: string) => {
      const launched = await launchReview(root, work(key), 'reviewer-a', [], new Date().toISOString(), { run: herdr(), mint, filesystem: durable });
      await occupy(git, launched.checkout);
      return launched.checkout;
    };
    const reviewState = async (checkout: string) => (await readReviewLedger(root)).reviews.find(record => record.checkout === checkout)!.state;
    const verdict = { state: 'APPROVED', reviewer: 'graphyard-reviewer[bot]', reviewId: 7, submittedAt: new Date().toISOString() };
    const reconcile = (item: Work, options: { observe?: () => any; now?: number; agents?: any[] } = {}) => reconcileReviews(root, config, { run: herdr(), observe: options.observe ?? (() => null), work: [item], agents: options.agents ?? [{ name: 'review-a', agent_status: 'working' }] as any, now: () => new Date(options.now ?? Date.now()) });

    const approved = await review('GY-105');
    await reconcile(work('GY-105')); assert.equal(await reviewState(approved), 'pending'); assert.ok(existsSync(approved), 'a live review keeps its checkout');
    await reconcile(work('GY-105'), { observe: () => verdict }); assert.equal(await reviewState(approved), 'completed'); gone(approved);
    const stale = await review('GY-106');
    await reconcile(work('GY-106', { candidate: { sha: 'c'.repeat(40), baseSha: B, pr: 88, branch: 'graphyard/gy-106-1', author: 'implementer' } } as any)); assert.equal(await reviewState(stale), 'cancelled'); gone(stale);
    const silent = await review('GY-107');
    await reconcile(work('GY-107'), { agents: [] }); await reconcile(work('GY-107'), { agents: [], now: Date.now() + reviewIdleGraceMs + 1000 }); assert.equal(await reviewState(silent), 'failed'); gone(silent);
    const lapsed = await review('GY-108');
    await reconcile(work('GY-108'), { now: Date.now() + 3_600_000 }); assert.equal(await reviewState(lapsed), 'expired'); gone(lapsed);

    // A launch that never became a session leaves nothing behind either.
    const broken = (_command: string, args: string[]) => { if (args[0] === 'pane' && args[1] === 'run') throw new Error('herdr pane run failed'); return herdr()(_command, args); };
    const unlucky = request();
    await assert.rejects(launchProducer(root, producing('GY-109', unlucky), unlucky, { ...config.producers[0], agentName: 'produce-gy-109' }, [], new Date().toISOString(), { run: broken, filesystem: durable }), /herdr pane run failed/);
    await assert.rejects(launchReview(root, work('GY-110'), 'reviewer-a', [], new Date().toISOString(), { run: broken, mint, filesystem: durable }), /herdr pane run failed/);
    assert.deepEqual(await readdir(managed).catch(() => []), ['.verification-slots'], 'every resolved or failed launch is gone from the root; the host verification lock directory stays');

    // A session that died with its master: a checkout no record owns. One live session is left
    // pending beside it, and a directory that is not Graphyard's sits in the same root.
    const live = await produce('GY-111');
    const dead = await allocateSessionCheckout(managed, 'proof', 'GY-112', H, randomUUID()), deadReview = await allocateSessionCheckout(managed, 'review', 'GY-113', H, randomUUID());
    await occupy(git, dead.directory); await occupy(git, deadReview.directory);
    await mkdir(join(managed, 'operator-notes')); await writeFile(join(managed, 'operator-notes/keep.txt'), 'not a checkout\n');
    const early = await reclaimCheckouts(root, config, { probe: durable });
    assert.deepEqual(early.removed, [], 'a directory allocated moments ago may belong to a launch still being recorded');
    assert.equal(early.scanned, 3);
    const pass = await reclaimCheckouts(root, config, { now: Date.now() + orphanGraceMs + 1000, probe: durable });
    assert.deepEqual(pass.removed.sort(), [dead.directory, deadReview.directory].sort()); assert.deepEqual(pass.kept, [live.checkout]); assert.deepEqual(pass.errors, []);
    gone(dead.directory); gone(deadReview.directory);
    assert.ok(existsSync(join(live.checkout, 'checkout/node_modules/left-pad/index.js')), 'a pending session is never reclaimed');
    assert.ok(existsSync(join(managed, 'operator-notes/keep.txt')), 'only a Graphyard session directory is ever removed');
    await assert.rejects(removeSessionCheckout(root, managed, join(managed, 'operator-notes')), /Refusing to remove/);
    await assert.rejects(removeSessionCheckout(root, managed, dirname(managed)), /Refusing to remove/);

    // Default roots are neighbours in the data directory. One whose checkout is gone never runs a
    // pass again, so a pass sweeps what it left — only when it holds nothing at all.
    const data = join(dirname(dirname(managed)), 'shared-data'), mine = defaultWorktreeRoot(root, 'owner/project', { GRAPHYARD_DATA_HOME: data });
    const abandoned = join(dirname(mine), 'project-000000000000'), occupied = join(dirname(mine), 'project-111111111111'), fresh = join(dirname(mine), 'project-222222222222');
    const left = await allocateSessionCheckout(abandoned, 'proof', 'GY-1', H, randomUUID()), held = await allocateSessionCheckout(occupied, 'proof', 'GY-2', H, randomUUID());
    await allocateSessionCheckout(occupied, 'review', 'GY-2', H, randomUUID()); await allocateSessionCheckout(fresh, 'proof', 'GY-3', H, randomUUID());
    await writeFile(join(held.directory, 'proof.evidence.json'), '{}\n');
    const later = Date.now() + orphanGraceMs + 1000;
    assert.deepEqual((await reclaimSessionCheckouts(root, mine, [], { now: Date.now(), probe: durable, environment: { GRAPHYARD_DATA_HOME: data } })).swept, [], 'nothing is abandoned inside the grace period');
    assert.deepEqual(await sweepAbandonedRoots(managed, { now: later, environment: { GRAPHYARD_DATA_HOME: data } }), [], 'a configured root has no neighbours to sweep');
    const old = new Date(Date.now() - orphanGraceMs - 60_000);
    for (const path of [left.directory, abandoned, ...(await readdir(occupied)).map(name => join(occupied, name)), occupied]) await utimes(path, old, old);
    assert.deepEqual((await reclaimSessionCheckouts(root, mine, [], { probe: durable, environment: { GRAPHYARD_DATA_HOME: data } })).swept, [abandoned]);
    assert.equal(existsSync(abandoned), false); assert.ok(existsSync(join(held.directory, 'proof.evidence.json')), 'a root that holds a file is never swept'); assert.ok(existsSync(fresh));
    await rm(data, { recursive: true, force: true });

    // The durable loop runs the same pass, and its summary says what it took back.
    const orphan = await allocateSessionCheckout(managed, 'proof', 'GY-114', H, randomUUID());
    await occupy(git, orphan.directory);
    await utimes(orphan.directory, old, old);
    const state = emptyDaemonState(config);
    const effects: DaemonEffects = { snapshot: async () => ({ work: [], now: new Date().toISOString() }), agents: () => [], credentials: async () => ({}), closePane: () => {}, dispatch: async () => ({}), observeDeployment: async () => null,
      recordDeployment: async () => ({}), merge: async () => ({}), requestProof: () => {}, requestSmoke: () => {}, persist: async () => {},
      reclaim: async () => ({ root, at: new Date().toISOString(), applied: true, scanned: 0, idleMs: 0, removed: [], kept: [], freeBefore: 50e9, freeAfter: 50e9, freedBytes: 0, errors: [], checkouts: await reclaimCheckouts(root, config, { probe: free(1e9) }) }) } as unknown as DaemonEffects;
    const cycle = await runCycle(config, state, effects);
    gone(orphan.directory);
    assert.equal(state.reclaim!.checkouts, 1); assert.equal(state.reclaim!.rootFreeBytes, 1e9);
    assert.match(cycle.actions.find(action => action.kind === 'reclaim')!.detail, new RegExp(`Reclaimed 1 ephemeral checkout\\(s\\) no live session owned from ${managed}`));
    let passes = 0;
    await runCycle(config, state, { ...effects, reclaim: async () => { passes++; return (effects.reclaim as any)(); } } as DaemonEffects);
    assert.equal(passes, 1, 'a root below its minimum is reclaimed on every cycle, not on the ten-minute cadence');

    // No checkout outlives its session record: every record that is not pending has no directory,
    // and every directory under the root belongs to a record that is.
    const records = [...(await readProducerLedger(root)).producers, ...(await readReviewLedger(root)).reviews];
    assert.equal(records.length, 9); assert.ok(records.every(record => record.checkout));
    for (const record of records.filter(entry => entry.state !== 'pending')) gone(record.checkout!);
    const pending = records.filter(record => record.state === 'pending').map(record => record.checkout!);
    assert.deepEqual((await readdir(managed)).filter(name => name.startsWith('graphyard-')).map(name => join(managed, name)), pending);
    assert.deepEqual(pending, [live.checkout]);
    assert.doesNotMatch(registered(git), /graphyard-(proof|review)-gy-1(0\d|1[0234])-(?!.*gy-111)/);
    // And the last one goes when its session does, taking the emptied root with it.
    await settle({ ...producing('GY-111', live.asked), evidence: [passing] } as any);
    gone(live.checkout);
    await rm(join(managed, 'operator-notes'), { recursive: true });
    const last = await allocateSessionCheckout(managed, 'proof', 'GY-115', H, randomUUID());
    await removeSessionCheckout(root, managed, last.directory);
    assert.deepEqual(await readdir(managed), ['.verification-slots'], 'an installation with no session leaves nothing behind but the host verification lock directory (GY-612)');
    assert.deepEqual(await readdir(join(managed, '.verification-slots')), [], 'and that holds no slot');
  } finally { await cleanup(); }
});

test('integration:worktree-root-preflight — setup refuses a tmpfs or a volume without the configured room, and master status asks for a reclaim before the volume or quota is exhausted', async () => {
  const scratch = await realpath(await temporaryDirectory('root-preflight'));
  try {
    const root = join(scratch, 'repository'), credentialDirectory = join(scratch, 'credentials'), managed = join(scratch, 'data/worktrees');
    await mkdir(root); execFileSync('git', ['init', '-q', '-b', 'main', root]); execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], { cwd: root });
    const setup = (run: Partial<MasterRun>, probe: FilesystemProbe) => setupMaster(root, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory, run: { worktreeRoot: managed, ...run } }, coordinatorStatus, { probe });

    // A tmpfs is refused with the reason and the remedy, before setup writes anything.
    await assert.rejects(setup({}, memory), (error: Error) => {
      assert.match(error.message, new RegExp(`The managed worktree root ${managed} is on a tmpfs`));
      assert.match(error.message, /held in memory and lost at the next boot/);
      assert.match(error.message, /Set run\.worktreeRoot in \.graphyard\/master\.json \(or GRAPHYARD_DATA_HOME\) to a directory on durable storage/);
      return true;
    });
    assert.equal(existsSync(join(root, '.graphyard/master.json')), false, 'a refused setup made no changes');
    assert.equal(existsSync(credentialDirectory), false);

    // Durable storage must also have the configured minimum free, and the minimum is configurable.
    assert.equal(worktreeRootMinFreeBytes({ run: {} }), 2e9); assert.equal(worktreeRootMinFreeBytes({ run: { worktreeRootMinFreeGb: 40 } }), 40e9);
    assert.equal(worktreeRootBudgetBytes({ run: {} }), 10e9); assert.equal(worktreeRootBudgetBytes({ run: { worktreeRootBudgetGb: 3 } }), 3e9);
    await assert.rejects(setup({}, free(1.2e9)), /has 1\.2 GB free, below the required 2\.0 GB\. Free space on that volume, point run\.worktreeRoot at a larger one, or lower run\.worktreeRootMinFreeGb/);
    await assert.rejects(setup({ worktreeRootMinFreeGb: 40 }, free(30e9)), /has 30\.0 GB free, below the required 40\.0 GB/);
    assert.equal(existsSync(join(root, '.graphyard/master.json')), false);
    const accepted = await setup({ worktreeRootMinFreeGb: 1 }, free(1.2e9));
    assert.deepEqual(accepted.worktreeRoot, { path: managed, freeBytes: 1.2e9, minFreeBytes: 1e9, configured: true });
    assert.equal(existsSync(managed), false, 'setup verifies the root without creating it');
    const config = await loadMasterConfig(root);
    assert.deepEqual([config.run.worktreeRoot, config.run.worktreeRootMinFreeGb], [managed, 1]);

    // The kernel's own answer: a root that does not exist yet is judged by its nearest existing
    // ancestor, and a memory-backed volume is recognised as one.
    const measured = await probeFilesystem(join(scratch, 'not/created/yet'));
    assert.equal(measured.probed, scratch); assert.equal(typeof measured.freeBytes, 'number');
    assert.equal(existsSync(join(scratch, 'not')), false);
    if (process.platform === 'linux' && existsSync('/dev/shm')) {
      const shared = await probeFilesystem('/dev/shm/graphyard-worktrees');
      if (shared.volatile) await assert.rejects(verifyWorktreeRoot('/dev/shm/graphyard-worktrees', { minFreeBytes: 1 }), /is on a (tmpfs|ramfs) \(\/dev\/shm\)/);
    }
    await assert.rejects(verifyWorktreeRoot('relative/root', { minFreeBytes: 1, probe: durable }), /absolute path/);
    assert.deepEqual(await verifyWorktreeRoot(managed, { minFreeBytes: 2e9, probe: free(null as any) }), { path: managed, probed: managed, freeBytes: null, minFreeBytes: 2e9 }, 'a volume that cannot be measured is not refused for it');

    // Every launch repeats the preflight: a volume fills, and a configuration is edited.
    await assert.rejects(allocateManagedCheckout(root, config, 'proof', 'GY-88', H, randomUUID(), memory), /is on a tmpfs/);
    await assert.rejects(allocateManagedCheckout(root, config, 'review', 'GY-88', H, randomUUID(), free(0.5e9)), /has 0\.5 GB free, below the required 1\.0 GB/);
    assert.equal(existsSync(managed), false);

    // master status: nothing while the root is healthy, and an attention item — owned by the
    // master, naming the reclaim command — while writes still succeed.
    const owned = await allocateManagedCheckout(root, config, 'proof', 'GY-88', H, randomUUID(), durable), unowned = await allocateManagedCheckout(root, config, 'review', 'GY-88', H, randomUUID(), durable);
    const sessions = [{ state: 'pending', checkout: owned.directory }, { state: 'completed', checkout: unowned.directory }];
    const healthy = await managedRootStatus(root, config, sessions, { probe: free(80e9), usage: async () => 0.4e9 });
    assert.deepEqual(healthy.attention, []);
    assert.deepEqual({ ...healthy.health }, { path: managed, exists: true, volatile: null, freeBytes: 80e9, minFreeBytes: 1e9, usedBytes: 0.4e9, budgetBytes: 10e9, checkouts: 2, unowned: 1, low: false, overBudget: false });

    const low = await managedRootStatus(root, config, sessions, { probe: free(0.7e9), usage: async () => 0.4e9 });
    assert.equal(low.attention.length, 1);
    assert.equal(low.attention[0].subject, 'disk'); assert.equal(low.attention[0].role, 'master'); assert.equal(low.attention[0].human, false);
    assert.match(low.attention[0].text, new RegExp(`0\\.7 GB free on the managed worktree root ${managed}, below the configured 1\\.0 GB minimum; it holds 2 ephemeral checkout\\(s\\), 1 owned by no live session\\. Reclaim them before the volume fills`));
    assert.match(low.attention[0].next, /^graphyard master run --once removes every ephemeral checkout no live session owns/);
    assert.ok(low.attention[0].next.includes(reclaimCommand));

    // A quota is invisible in the volume's free space, so the root's own size is held to a budget.
    const quota = await managedRootStatus(root, { ...config, run: { ...config.run, worktreeRootBudgetGb: 5 } }, sessions, { probe: free(300e9), usage: async () => 4.1e9 });
    assert.equal(quota.health.overBudget, true); assert.equal(quota.health.low, false);
    assert.match(quota.attention[0].text, /holds 4\.1 GB of its 5\.0 GB budget \(run\.worktreeRootBudgetGb\) in 2 ephemeral checkout\(s\), 1 owned by no live session\. Reclaim them before the quota is exhausted/);
    assert.match(quota.attention[0].next, /graphyard master run --once/);
    assert.deepEqual((await managedRootStatus(root, { ...config, run: { ...config.run, worktreeRootBudgetGb: 5 } }, sessions, { probe: free(300e9), usage: async () => 3.9e9 })).attention, [], 'below four fifths of the budget nothing is raised');

    // A configuration that predates this check, or was edited onto a tmpfs, is said so too.
    const volatile = await managedRootStatus(root, config, sessions, { probe: memory, usage: async () => 0 });
    assert.match(volatile.attention[0].text, /is on a tmpfs: every proof and review checkout is held in memory/);
    assert.match(volatile.attention[0].next, /Set run\.worktreeRoot in \.graphyard\/master\.json to an absolute path on durable storage/);
    assert.deepEqual(worktreeRootAttention({ ...low.health, volatile: 'tmpfs' }).map(item => /graphyard master run --once/.test(item.next)), [true, true]);

    // The real measurement of a real root, and a root that does not exist yet.
    const real = await inspectWorktreeRoot(managed, { minFreeBytes: 1, budgetBytes: 10e9 }, [owned.directory]);
    assert.equal(real.checkouts, 2); assert.equal(real.unowned, 1); assert.equal(typeof real.usedBytes, 'number'); assert.ok(real.usedBytes! < 1e9);
    const absent = await inspectWorktreeRoot(join(scratch, 'never-created'), { minFreeBytes: 1, budgetBytes: 10e9 }, [], { probe: durable });
    assert.deepEqual([absent.exists, absent.checkouts, absent.usedBytes], [false, 0, 0]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('unit:disk-exhaustion-message — a write that failed for want of room is reported as disk exhaustion naming the path and the reclaim command, wherever in the loop it failed', async () => {
  const quota = Object.assign(new Error("EDQUOT: disk quota exceeded, mkdir '/data/worktrees/graphyard-proof-gy-88-aaaaaaa-0123abcd'"), { code: 'EDQUOT', path: '/data/worktrees/graphyard-proof-gy-88-aaaaaaa-0123abcd' });
  const full = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
  const child = Object.assign(new Error('Command failed: git worktree add'), { stderr: 'pwd: write error: Disk quota exceeded\n' });
  const unrelated = new Error('connect ECONNREFUSED 127.0.0.1:5432');

  // The message: the condition, the path, the reclaim command.
  assert.equal(reclaimCommand, 'graphyard master run --once');
  assert.ok(reclaimAdvice.includes(`${reclaimCommand} reclaims immediately, ephemeral proof and review checkouts included`));
  assert.equal(diskExhaustionMessage(quota), `the host's disk quota is exhausted (EDQUOT) at /data/worktrees/graphyard-proof-gy-88-aaaaaaa-0123abcd: ${reclaimAdvice}`);
  assert.equal(diskExhaustionMessage(full, '/data/worktrees'), `the volume is full (ENOSPC) at /data/worktrees: ${reclaimAdvice}`, 'a caller that knows the path names it');
  assert.equal(diskExhaustionMessage(child, '/repo/.graphyard/worktrees/GY-88-1'), `the host's disk quota is exhausted (EDQUOT) at /repo/.graphyard/worktrees/GY-88-1: ${reclaimAdvice}`, 'a child command\'s output is the same condition');
  assert.equal(diskExhaustionMessage(Object.assign(new Error('rename failed'), { code: 'ENOSPC', dest: '/data/ledger.json' })), `the volume is full (ENOSPC) at /data/ledger.json: ${reclaimAdvice}`);
  assert.equal(diskExhaustionMessage(full), `the volume is full (ENOSPC): ${reclaimAdvice}`);
  assert.equal(diskExhaustionMessage(unrelated), null); assert.equal(diskExhaustion(unrelated), null);

  // writeFailure: the action, then that message; the code and the cause survive, and any other failure is left exactly as it is.
  const wrapped = writeFailure(quota, 'Allocating a proof checkout under the managed worktree root', '/data/worktrees') as Error & { code?: string; cause?: unknown };
  assert.equal(wrapped.message, `Allocating a proof checkout under the managed worktree root failed because the host's disk quota is exhausted (EDQUOT) at /data/worktrees: ${reclaimAdvice}`);
  assert.match(wrapped.message, /graphyard master run --once/);
  assert.equal(wrapped.code, 'EDQUOT'); assert.equal(wrapped.cause, quota);
  assert.match(writeFailure(quota, 'Removing the ephemeral checkout').message, /\(EDQUOT\) at \/data\/worktrees\/graphyard-proof-gy-88-aaaaaaa-0123abcd: /, 'the path the system call reported is named when the caller gives none');
  assert.equal(writeFailure(unrelated, 'Writing the cursor'), unrelated);

  // A real write into a place that cannot take it is reported through the same path: the
  // allocation under the managed root, and the reclaim pass.
  const scratch = await realpath(await temporaryDirectory('exhaustion'));
  try {
    const orphan = await allocateSessionCheckout(scratch, 'proof', 'GY-88', H, randomUUID());
    const refusing = () => { throw quota; };
    const pass = await reclaimSessionCheckouts(scratch, scratch, [], { now: Date.now() + orphanGraceMs + 1000, probe: durable, failure: writeFailure, run: refusing });
    assert.deepEqual(pass.errors, [], 'a git failure never stops the directory from being removed');
    assert.equal(existsSync(orphan.directory), false);
    const stuck = await allocateSessionCheckout(scratch, 'review', 'GY-88', H, randomUUID());
    const failing = await reclaimSessionCheckouts(scratch, scratch, [], { now: Date.now() + orphanGraceMs + 1000, probe: durable,
      failure: (error, action, path) => writeFailure(Object.assign(new Error('write error: No space left on device'), { original: error }), action, path), run: () => '' });
    assert.deepEqual(failing.errors, []); assert.equal(existsSync(stuck.directory), false);
  } finally { await rm(scratch, { recursive: true, force: true }); }

  // A session launch that runs out of room — Herdr's own output says so, nothing else does — is
  // reported as that, names the checkout it was launching into, and leaves no checkout behind.
  const { root, managed, cleanup } = await installation();
  try {
    const config = await loadMasterConfig(root), asked = request();
    const exhausted = (_command: string, args: string[]) => { if (args[0] === 'pane' && args[1] === 'run') throw Object.assign(new Error('Command failed: herdr pane run'), { stderr: 'write error: No space left on device\n' }); return herdr()(_command, args); };
    await assert.rejects(launchProducer(root, producing('GY-88', asked), asked, config.producers[0], [], new Date().toISOString(), { run: exhausted, filesystem: durable }), (error: Error) => {
      assert.match(error.message, new RegExp(`^Launching the GY-88 producer session \\(Command failed: herdr pane run\\) failed because the volume is full \\(ENOSPC\\) at ${managed}/graphyard-proof-gy-88-aaaaaaa-[0-9a-f]{8}: `));
      assert.ok(error.message.endsWith(reclaimAdvice)); return true;
    });
    await assert.rejects(launchReview(root, work('GY-88'), 'reviewer-a', [], new Date().toISOString(), { run: exhausted, mint: async () => ({ token: 'ghs_session_token_value', expiresAt: future(3_000_000) }), filesystem: durable }),
      new RegExp(`^Error: Launching the GY-88 reviewer session .* failed because the volume is full \\(ENOSPC\\) at ${managed}/graphyard-review-gy-88-aaaaaaa-[0-9a-f]{8}: .*graphyard master run --once`));
    assert.deepEqual(await readdir(managed).catch(() => []), ['.verification-slots'], 'no checkout is left behind, only the host verification lock directory');
  } finally { await cleanup(); }

  // And the loop records it that way: an action that failed for want of room carries its own
  // output, the condition, the path and the reclaim command — once.
  const credentials = await realpath(await temporaryDirectory('exhaustion-loop'));
  try {
    const token = join(credentials, 'coordinator.token'); await writeFile(token, coordinatorToken, { mode: 0o600 });
    const config = { version: 1, url: 'https://graphyard.example', credentialFile: token, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'host', masterAgentName: 'master', autoMerge: true, mergeMethod: 'merge',
      workers: [{ name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: token, agentArgs: [], approvals: 'auto', environment: {} }], reviewers: [], producers: [], run: masterRunSchema.parse({}) } as any;
    const ready = work('GY-88', { ready: true, stage: 'ready', epoch: 0, candidate: null, submission: null, observation: null, gates: [{ name: 'ready', passed: true, reasons: [] }] } as any);
    const base = { snapshot: async () => ({ work: [ready], now: new Date().toISOString() }), agents: () => [], credentials: async () => ({ launch: { available: true, reason: null } }), closePane: () => {}, observeDeployment: async () => null,
      recordDeployment: async () => ({}), merge: async () => ({}), requestProof: () => {}, requestSmoke: () => {}, persist: async () => {} };
    const once = (detail: string) => assert.equal(detail.split(reclaimAdvice).length, 2, 'the explanation is given exactly once');
    const direct = await runCycle(config, emptyDaemonState(config), { ...base, dispatch: async () => { throw quota; } } as unknown as DaemonEffects);
    const failed = direct.actions.find(action => action.kind === 'dispatch' && action.state === 'failed')!;
    assert.match(failed.detail, /Dispatch of GY-88 to launch failed/);
    assert.ok(failed.detail.includes(`the host's disk quota is exhausted (EDQUOT) at /data/worktrees/graphyard-proof-gy-88-aaaaaaa-0123abcd: ${reclaimAdvice}`)); once(failed.detail);
    const already = await runCycle(config, emptyDaemonState(config), { ...base, dispatch: async () => { throw wrapped; } } as unknown as DaemonEffects);
    const reported = already.actions.find(action => action.kind === 'dispatch' && action.state === 'failed')!;
    assert.ok(reported.detail.includes('at /data/worktrees: ')); once(reported.detail);
    const reclaiming = await runCycle(config, emptyDaemonState(config), { ...base, snapshot: async () => ({ work: [], now: new Date().toISOString() }), dispatch: async () => ({}), reclaim: async () => { throw child; } } as unknown as DaemonEffects);
    const reclaim = reclaiming.actions.find(action => action.kind === 'reclaim')!;
    assert.match(reclaim.detail, /Worktree reclamation failed: Command failed: git worktree add — the host's disk quota is exhausted \(EDQUOT\): /); once(reclaim.detail);
  } finally { await rm(credentials, { recursive: true, force: true }); }
});

/**
 * GY-612: concurrent agent test runs exhausted host memory. On a 62 GB host fourteen full suites
 * and five `tsc --noEmit` runs were live at once and available memory fell to one or two gigabytes.
 * unit:host-verification-slots bounds heavy verification runs per host; unit:dispatch-defers-on-host-memory
 * holds new launches while the host is below its memory floor and resumes them once it recovers.
 */

const GiB = 2 ** 30;

// ---- AC-1 --------------------------------------------------------------------------------------

test('unit:host-verification-slots — heavy verification runs started by a session take a host-wide slot: more runs than slots never exceed the bound at once, the rest wait saying on what, and all complete', async () => {
  const scratch = await temporaryDirectory('slots');
  try {
    // The bound: max(2, floor(total GB / 8)), overridable per host.
    assert.equal(defaultVerificationSlots(62 * GiB), 7);
    assert.equal(defaultVerificationSlots(8 * GiB), 2, 'never fewer than two');
    assert.equal(heavyCommand('tsc', ['--noEmit']), true);
    assert.equal(heavyCommand('npx', ['tsc', '--noEmit']), true);
    assert.equal(heavyCommand('npx', ['vite', 'build']), false);
    assert.equal(heavyCommand('tsc', ['--version']), false);

    // The session harness's environment: a lock directory under the managed worktree root, the bound,
    // and the wrapper directory first on PATH. A fake `tsc` stands in for the real one after it.
    const managedRoot = join(scratch, 'managed'), fakeBin = join(scratch, 'fake-bin'), log = join(scratch, 'runs.log');
    await mkdir(fakeBin, { recursive: true });
    // It holds its slot until the test opens the gate, so how many runs wait never depends on how fast five wrappers start.
    await writeFile(join(fakeBin, 'tsc'), `#!/bin/sh\necho "start $$" >> "$RUN_LOG"\nwhile [ ! -e "$RUN_GATE" ]; do sleep 0.05; done\necho "end $$" >> "$RUN_LOG"\n`);
    await chmod(join(fakeBin, 'tsc'), 0o755);
    const environment = verificationEnvironment(managedRoot, { PATH: [fakeBin, process.env.PATH].join(delimiter), GRAPHYARD_VERIFICATION_SLOTS: '2' });
    const directory = verificationSlotsDirectory(managedRoot);
    assert.equal(environment.GRAPHYARD_VERIFICATION_SLOTS_DIR, directory);
    assert.equal(environment.GRAPHYARD_VERIFICATION_SLOTS, '2');
    assert.equal(environment.PATH.split(delimiter)[0], verificationBin);
    assert.ok(existsSync(join(verificationBin, 'tsc')) && existsSync(join(verificationBin, 'npx')));
    assert.ok(!existsSync(managedRoot), 'nothing is written under the managed root at launch');

    // Five runs, two slots: `tsc --noEmit` as a session types it, through the wrapper on its PATH.
    const runs = 5, gate = join(scratch, 'gate'), stderrs: string[] = Array(runs).fill('');
    const waitPattern = /waits for a host verification slot: all 2 under .+ are held by tsc --noEmit \(pid \d+/;
    const finished = Promise.all(Array.from({ length: runs }, (_, index) => new Promise<{ code: number | null; stderr: string }>(done => {
      const child = spawn('tsc', ['--noEmit'], { env: { ...process.env, ...environment, RUN_LOG: log, RUN_GATE: gate }, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', chunk => { stderrs[index] += chunk; });
      child.on('close', code => done({ code, stderr: stderrs[index] }));
    })));
    // Two runs hold the slots and the other three wait, saying so; only then do the holders finish.
    const deadline = Date.now() + 30_000;
    while (stderrs.filter(stderr => waitPattern.test(stderr)).length < runs - 2 && Date.now() < deadline) await new Promise(done => setTimeout(done, 50));
    const heldWhileWaiting = heldSlots(directory).length;
    await writeFile(gate, '');
    const outcomes = await finished;
    assert.equal(heldWhileWaiting, 2, 'the bound is held while the others wait');
    assert.deepEqual(outcomes.map(outcome => outcome.code), Array(runs).fill(0), 'every run completes');
    const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => line.split(' ')[0]);
    let running = 0, peak = 0;
    for (const event of events) { running += event === 'start' ? 1 : -1; peak = Math.max(peak, running); }
    assert.equal(events.filter(event => event === 'start').length, runs);
    assert.equal(events.filter(event => event === 'end').length, runs);
    assert.equal(peak, 2, 'no more than the bound ran at once, and the bound was used');
    const waited = outcomes.filter(outcome => waitPattern.test(outcome.stderr));
    assert.equal(waited.length, runs - 2, 'each run that waited said it waits, on what, and who holds the slots');
    assert.deepEqual(heldSlots(directory), [], 'every slot is given back');

    // A slot whose owner died is taken back by the next run rather than held forever.
    await mkdir(join(directory, 'slot-0'));
    await writeFile(join(directory, 'slot-0', 'owner.json'), JSON.stringify({ pid: 999_999_999, label: 'npm test', cwd: '/gone', at: new Date().toISOString() }));
    const taken = await acquireVerificationSlot({ directory, slots: 1, label: 'npm test', alive: pid => pid === process.pid, pollMs: 10 });
    assert.equal(taken.slot, 0);
    assert.equal(heldSlots(directory)[0].owner?.pid, process.pid);
    taken.release();

    // In one process too: more acquisitions than slots, never more than the bound held at once.
    let held = 0, most = 0; const lines: string[] = [];
    await Promise.all(Array.from({ length: 4 }, async (_, index) => {
      const slot = await acquireVerificationSlot({ directory, slots: 2, label: `run ${index}`, pollMs: 5, onWait: line => lines.push(line) });
      held++; most = Math.max(most, held);
      await new Promise(done => setTimeout(done, 30));
      held--; slot.release();
    }));
    assert.equal(most, 2);
    assert.ok(lines.some(line => line.includes('waits for a host verification slot')));
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test('unit:host-verification-slots — a sandboxed session is granted the lock directory, and an account PATH keeps the wrappers first', async () => {
  const scratch = await temporaryDirectory('slots-grant');
  try {
    // Codex under workspace-write refuses `mkdir slot-N` outside its grants, and the run would go
    // ahead unbounded: every session role grants the lock directory, created before launch.
    const managedRoot = join(scratch, 'managed'), directory = verificationSlotsDirectory(managedRoot), worktree = join(scratch, 'worktree');
    const settings = { repository: 'owner/project', run: { worktreeRoot: managedRoot } } as unknown as MasterConfig;
    assert.deepEqual(sessionSlotsGrant(scratch, settings), [], 'a launch never creates the managed root itself');
    await mkdir(managedRoot);
    const grant = sessionSlotsGrant(scratch, settings);
    assert.deepEqual(grant, [directory]);
    assert.deepEqual(sessionSlotsGrant(scratch, settings), [directory], 'an existing lock directory is granted again');
    assert.ok(existsSync(directory), 'the lock directory exists before the sandbox is asked to grant it');

    // Reviewer and producer: the reach accountLaunch adds to the Codex sandbox.
    const launch = accountLaunch({ kind: 'codex', approvals: 'auto', agentArgs: [], environment: {} }, null, { writable: ['/checkout', ...grant] });
    assert.equal(launch.args[launch.args.indexOf('--sandbox') + 1], 'workspace-write');
    assert.ok(launch.args.some((arg, index) => arg === '--add-dir' && launch.args[index + 1] === directory), `reviewer/producer launch grants ${directory}: ${launch.args.join(' ')}`);

    // Worker: its writable paths are granted and proved by the sandbox probe before it starts.
    const args = grantWorkerPaths('codex', ['--sandbox', 'workspace-write'], [worktree, ...grant], worktree);
    const probed: string[][] = [];
    verifyWorkerSandbox({ kind: 'codex', args }, worktree, [worktree, ...grant], (command, probeArgs) => { probed.push(probeArgs); return 'writable\n'; });
    assert.ok(probed[0].some(arg => arg.includes(`${JSON.stringify(directory)}="write"`)), 'the probe checks the lock directory is writable inside the sandbox');
    assert.ok(probed[0].includes(directory), 'and writes into it');

    // An account environment's own PATH never drops the wrappers.
    const harness = verificationEnvironment(managedRoot, { PATH: '/usr/bin' });
    const tab = withVerificationPath(harness, { PATH: '/account/bin:/usr/bin', OTHER: 'x' });
    assert.deepEqual(tab.PATH.split(delimiter), [verificationBin, '/account/bin', '/usr/bin']);
    assert.equal(tab.OTHER, 'x');
    assert.equal(withVerificationPath(harness, {}).PATH, harness.PATH);
    assert.equal(withVerificationPath({}, { PATH: '/account/bin' }).PATH, '/account/bin', 'no slots, no wrappers');
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

// ---- AC-2 --------------------------------------------------------------------------------------

const at = Date.parse('2026-09-26T11:50:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const low: HostMemoryReading = { totalBytes: 62 * GiB, availableBytes: 2 * GiB, consumers: memoryConsumers([[14, 'node'], [5.7, 'claude'], [2.8, 'opencode'], [1, 'postgres']].map(([gb, command]) => `${Math.round(Number(gb) * 1024 * 1024)} ${command}`).join('\n')) };
const recovered: HostMemoryReading = { totalBytes: 62 * GiB, availableBytes: 20 * GiB };
const worker = { name: 'worker-a', principal: 'agent-a', agentName: 'agent-worker-a', mode: 'launch', kind: 'codex', credentialFile: '/nonexistent', agentArgs: [], environment: {} } as unknown as WorkerProfile;
const config = masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:9', credentialFile: '/nonexistent/coordinator.json', cliPath: '/nonexistent/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [worker],
  producers: [{ name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'claude', credentialFile: '/nonexistent/producer-a.token' }],
  reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' }], reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: '/nonexistent/reviewer.json', boundAt: iso(at) } }) as MasterConfig;
const ready = { id: 'work-ready', key: 'GY-44', title: 'Ready', description: '', type: 'feature', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:x'] }],
  policy: { checks: ['test'], review: true }, plannedFiles: ['src/ready.ts'], stage: 'ready', revision: 1, policyRevision: 1, createdAt: iso(at), updatedAt: iso(at), stageEnteredAt: iso(at), ready: true, epoch: 0,
  lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
  gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [] } as unknown as Work;
function loopEffects(log: string[], memory: () => HostMemoryReading): DaemonEffects {
  return {
    agents: () => [], credentials: async profiles => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: [ready], now: iso(at) }), closeSession: () => {}, dispatch: async item => { log.push(`dispatch:${item.key}`); },
    requestProof: () => {}, merge: async () => ({ result: 'merge requested' }), recordDeployment: async () => {}, requestSmoke: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: iso(at), reason: 'not configured', deployed: [], pending: [] }) as any,
    persist: async () => {}, hostMemory: async () => memory(),
  } as DaemonEffects;
}
/** A submitted head with open producer requests, as the control plane raises them at the build gate. */
function submitted(): Work {
  const sha = 'a1'.padEnd(40, 'f'), baseSha = 'b1'.padEnd(40, 'f'), candidate = { sha, baseSha, pr: 64, branch: 'graphyard/gy-64-1', author: 'implementer' };
  const item = { id: 'work-64', key: 'GY-64', title: 'Submitted', description: '', type: 'feature', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Proof', proofs: ['unit:memory-proof'] }], policy: { checks: ['test'], review: true, reviewProvider: 'github' }, stage: 'review', revision: 7, policyRevision: 1,
    createdAt: iso(at), updatedAt: iso(at), stageEnteredAt: iso(at), ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 64 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: ['src/a.ts'], scopeFiles: [], at: iso(at), prState: 'open', draft: false, baseTip: baseSha, baseTree: '7b'.padEnd(40, 'f'), baseTipContained: true },
    blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'build', passed: true, reasons: [] }], violations: [] } as unknown as Work;
  reconcileAutoDispatch(item, [item], new Date(at));
  return item;
}

test('unit:dispatch-defers-on-host-memory — below the memory floor the loop defers new launches with a recorded reason, raises one resources attention item naming the top consumers, and resumes once memory recovers', async () => {
  assert.equal(hostMemoryFloor(62 * GiB), 62 * GiB * 0.1, '10% of total on a large host');
  assert.equal(hostMemoryFloor(16 * GiB), 4 * GiB, '4 GB on a small one');
  let memory = low;
  const log: string[] = [];
  const state = emptyDaemonState(config);

  // Low: nothing is dispatched, and the deferral is recorded with its reason and consumers.
  await runCycle(config, state, loopEffects(log, () => memory));
  assert.deepEqual(log, [], 'no worker is launched while the host is below its floor');
  const deferred = state.actions[memoryActionKey];
  assert.match(deferred.detail, /^Launches deferred: host machine-a has 2\.0 GB of 62\.0 GB memory available, below its 6\.2 GB floor, so new session launches on it are deferred until memory recovers; top consumers: node 14\.0 GB, claude 5\.7 GB, opencode 2\.8 GB, postgres 1\.0 GB$/);
  assert.equal(state.memory?.low, true);
  assert.equal(daemonSummary(state, at, 30_000, 'machine-a').memory?.low, true, 'master status reads it from the loop');

  // One `resources` attention item, naming the top consumers, from master status and from the loop's fault tracking.
  const attention = classifyAttention(hostMemoryAttention(state.memory));
  assert.equal(attention.length, 1);
  assert.equal(attention[0].faultClass, 'resources');
  assert.match(attention[0].text, /top consumers: node 14\.0 GB, claude 5\.7 GB/);
  const faults = cycleFaults(state, [ready], at, { config }).filter(fault => fault.faultClass === 'resources');
  assert.deepEqual(faults.map(fault => fault.kind), ['memory-pressure']);
  // The fault stands as one instance for the whole dip even as the consumers' ranking moves between
  // cycles (GY-612): a fault is its wording, so the fault's wording carries no consumer list — the
  // attention item keeps it — and trackFaults opens nothing new on the reshuffle.
  const record: FaultRecord = { instances: [], open: {}, failing: {} };
  trackFaults(record, faults, iso(at));
  state.memory = { ...state.memory!, consumers: [...state.memory!.consumers].reverse() };
  const opened = trackFaults(record, cycleFaults(state, [ready], at + 60_000, { config }).filter(fault => fault.faultClass === 'resources'), iso(at + 60_000));
  assert.deepEqual(opened.map(instance => instance.kind), [], 'the moved consumer ranking reopens nothing');
  assert.equal(record.instances.length, 1, 'one memory-pressure instance stands for the whole dip');

  // Still low: still deferred, and the crossing is not recorded again.
  await runCycle(config, state, loopEffects(log, () => memory));
  assert.deepEqual(log, []);
  assert.equal(state.actions[memoryActionKey].attempts, deferred.attempts);

  // Producer and reviewer launches wait on it too, with the same reason.
  const item = submitted(), launched: string[] = [];
  const dispatchEffects: DispatchEffects = {
    snapshot: async () => ({ work: [item], now: iso(at) }), agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews: [] }), reconcileProducers: async () => ({ producers: [] }),
    launchReview: async () => { launched.push('review'); }, launchProducer: async () => { launched.push('producer'); },
    persist: async () => {}, hostMemory: async () => memory,
  };
  const tick = await runDispatchTick(config, emptyDispatchCursor(config), dispatchEffects, () => at);
  assert.equal(launched.length, 0, 'no reviewer or producer is launched');
  assert.ok(tick.waiting.length > 0 && tick.waiting.every(wait => /below its 6\.2 GB floor, so new session launches on it are deferred/.test(wait.reason)));
  // The executor claims no launching row meanwhile: the rows wait in the queue without failing.
  const claims: NextActionKind[][] = [];
  const idle = await runExecutorTick({ id: 'executor-a', host: 'machine-a' }, { claim: async request => { claims.push(request.kinds); return { action: null }; }, settle: async () => {},
    handlers: { dispatch: async () => 'launched', 'request-review': async () => 'launched', resync: async () => 'resynced' }, launchHold: () => hostMemoryHold('machine-a', async () => memory, () => at) });
  assert.deepEqual(claims, [['resync']]);
  assert.ok(claims[0].every(kind => !launchingKinds.includes(kind)));
  assert.match(idle.reason, /launches none: host machine-a has 2\.0 GB/);

  // Barely back over the floor is not recovered: the deferral lifts only past the margin, so a host hovering at it does not flap.
  memory = { totalBytes: 62 * GiB, availableBytes: hostMemoryFloor(62 * GiB) + memoryRecoveryMarginBytes / 2 };
  await runCycle(config, state, loopEffects(log, () => memory));
  assert.deepEqual(log, [], 'still deferred just above the floor');
  assert.equal(state.actions[memoryActionKey].attempts, deferred.attempts, 'no resumption is recorded inside the margin');

  // Recovered: the loop resumes launching and says so, and the attention clears.
  memory = recovered;
  await runCycle(config, state, loopEffects(log, () => memory));
  assert.deepEqual(log, ['dispatch:GY-44']);
  assert.match(state.actions[memoryActionKey].detail, /^Launches resumed: host machine-a has 20\.0 GB of 62\.0 GB memory available again, above its 6\.2 GB floor \(deferred since /);
  assert.equal(state.memory?.low, false);
  assert.deepEqual(hostMemoryAttention(state.memory), []);
  launched.length = 0;
  await runDispatchTick(config, emptyDispatchCursor(config), dispatchEffects, () => at);
  assert.ok(launched.includes('producer'), 'producer launches resume');
  claims.length = 0;
  await runExecutorTick({ id: 'executor-a', host: 'machine-a' }, { claim: async request => { claims.push(request.kinds); return { action: null }; }, settle: async () => {},
    handlers: { dispatch: async () => 'launched', resync: async () => 'resynced' }, launchHold: () => hostMemoryHold('machine-a', async () => memory, () => at) });
  assert.ok(claims[0].includes('dispatch'), 'the executor claims dispatch rows again');
});
