import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { allocateManagedCheckout, assertOutsideWorktrees, diskExhaustion, diskExhaustionMessage, loadMasterConfig, managedRootStatus, masterRunSchema, reclaimAdvice, saveProducerProfile, sessionHarnessPlan, setupMaster, sharedGitDirectory, worktreeRootAttention, writeFailure, type MasterRun } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { launchProducer, producerPrompt, readProducerLedger, reclaimCheckouts, reconcileProducers, producerIdleGraceMs, type ProducerBinding } from '../src/producer.js';
import { bindReviewer, launchReview, readReviewLedger, reconcileReviews, reviewIdleGraceMs, reviewPrompt, saveReviewerProfile } from '../src/reviewer.js';
import { allocateSessionCheckout, dataDirectory, defaultWorktreeRoot, inspectWorktreeRoot, orphanGraceMs, probeFilesystem, reclaimCommand, reclaimSessionCheckouts, removeSessionCheckout, sessionCheckout, sweepAbandonedRoots, verifyWorktreeRoot, worktreeRoot, worktreeRootBudgetBytes, worktreeRootMinFreeBytes, type FilesystemProbe } from '../src/install/worktree-root.js';

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
    return JSON.stringify({ result: args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
}
const promptOf = (calls: string[][]) => calls.find(args => args[0] === 'agent' && args[1] === 'prompt')![3];

/** A managed repository with one commit, a bound reviewer, a reviewer profile and two producer profiles, its worktree root under `managed`. */
async function installation(run: Partial<MasterRun> = {}) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'graphyard-managed-root-')));
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
    const produceStart = produceCalls.find(args => args[0] === 'agent' && args[1] === 'start')!;
    assert.deepEqual(produceStart.slice(produceStart.indexOf('--add-dir')), ['--add-dir', produced.checkout, '--add-dir', sharedGitDirectory(root)]);
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
    const reviewStart = reviewCalls.find(args => args[0] === 'agent' && args[1] === 'start')!;
    assert.deepEqual(reviewStart.slice(reviewStart.indexOf('--add-dir')), ['--add-dir', reviewed.checkout, '--add-dir', sharedGitDirectory(root)]);
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
      reviewPrompt(config, { ...binding, author: 'implementer' }, elsewhere), reviewPrompt(config, { ...binding, author: 'implementer' })]) assert.equal(text.includes('/tmp'), false, 'a generated prompt never names /tmp');
    assert.ok(producerPrompt({ repository: 'owner/project', cliPath: launcher }, binding, { principal: 'proof-runner' }).includes(resolve(homedir(), '.local/share/graphyard/worktrees')), 'a previewed prompt names the default root');
    const sources = fileURLToPath(new URL('../src/', import.meta.url));
    for (const file of ['producer.ts', 'reviewer.ts', 'master.ts', 'master-daemon.ts', 'auto-dispatch.ts', 'harness.ts', 'install/worktree-root.ts']) {
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
    const broken = (_command: string, args: string[]) => { if (args[0] === 'agent') throw new Error('herdr agent start failed'); return herdr()(_command, args); };
    const unlucky = request();
    await assert.rejects(launchProducer(root, producing('GY-109', unlucky), unlucky, { ...config.producers[0], agentName: 'produce-gy-109' }, [], new Date().toISOString(), { run: broken, filesystem: durable }), /herdr agent start failed/);
    await assert.rejects(launchReview(root, work('GY-110'), 'reviewer-a', [], new Date().toISOString(), { run: broken, mint, filesystem: durable }), /herdr agent start failed/);
    assert.deepEqual(await readdir(managed).catch(() => []), [], 'every resolved or failed launch is gone from the root');

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
    assert.equal(existsSync(managed), false, 'an installation with no session leaves no directory behind');
  } finally { await cleanup(); }
});

test('integration:worktree-root-preflight — setup refuses a tmpfs or a volume without the configured room, and master status asks for a reclaim before the volume or quota is exhausted', async () => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'graphyard-root-preflight-')));
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
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'graphyard-exhaustion-')));
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
    const exhausted = (_command: string, args: string[]) => { if (args[0] === 'agent') throw Object.assign(new Error('Command failed: herdr agent start'), { stderr: 'write error: No space left on device\n' }); return herdr()(_command, args); };
    await assert.rejects(launchProducer(root, producing('GY-88', asked), asked, config.producers[0], [], new Date().toISOString(), { run: exhausted, filesystem: durable }), (error: Error) => {
      assert.match(error.message, new RegExp(`^Launching the GY-88 producer session \\(Command failed: herdr agent start\\) failed because the volume is full \\(ENOSPC\\) at ${managed}/graphyard-proof-gy-88-aaaaaaa-[0-9a-f]{8}: `));
      assert.ok(error.message.endsWith(reclaimAdvice)); return true;
    });
    await assert.rejects(launchReview(root, work('GY-88'), 'reviewer-a', [], new Date().toISOString(), { run: exhausted, mint: async () => ({ token: 'ghs_session_token_value', expiresAt: future(3_000_000) }), filesystem: durable }),
      new RegExp(`^Error: Launching the GY-88 reviewer session .* failed because the volume is full \\(ENOSPC\\) at ${managed}/graphyard-review-gy-88-aaaaaaa-[0-9a-f]{8}: .*graphyard master run --once`));
    assert.equal(existsSync(managed), false);
  } finally { await cleanup(); }

  // And the loop records it that way: an action that failed for want of room carries its own
  // output, the condition, the path and the reclaim command — once.
  const credentials = await realpath(await mkdtemp(join(tmpdir(), 'graphyard-exhaustion-loop-')));
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
