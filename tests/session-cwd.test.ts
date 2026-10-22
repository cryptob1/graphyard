// GY-866: no session Graphyard launches starts where the master starts. Every role's launch is
// built here the way the loop builds it — the real launch functions against a stubbed Herdr — and
// the pane's `--cwd`, the launch files' checkout and the runtime's recorded working folder must be
// the session's own managed checkout (or its assigned worktree, or the loop's scratch checkout for
// the sessions that have none), never the coordinator checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { bwrapOnPath, readOnlyMountWrapper } from '../src/master/profiles.js';
import { dataDirectory, worktreeRoot } from '../src/install/worktree-root.js';
import { atomicPrivateWrite, dispatchWork, loadMasterConfig, saveProducerProfile, setupMaster, type WorkerProfile } from '../src/master.js';
import { launchProducer, readProducerLedger } from '../src/producer.js';
import { bindReviewer, launchReview, saveReviewerProfile } from '../src/reviewer.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), B = sha40('b1');
const at = '2026-09-24T10:00:00.000Z';
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
