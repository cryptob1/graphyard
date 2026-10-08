import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import { loadMasterConfig, saveProducerProfile, setupMaster } from '../src/master.js';
import { launchProducer, readProducerLedger } from '../src/producer.js';
import { bindReviewer, launchReview, readReviewLedger, saveReviewerProfile } from '../src/reviewer.js';
import { sessionWritablePaths, type SandboxExec } from '../src/worker-sandbox.js';
import type { FilesystemProbe } from '../src/install/worktree-root.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1507: Codex reviewer and producer launches granted the common .git directory, so the Codex
// sandbox could not even start (`bwrap: Can't create file <common>/.git`) and every session died at
// its first command. They now get a worker's narrow Git grants, and the sandbox probe runs first.

const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const coordinatorStatus = (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch;
const H = 'a'.repeat(40), B = 'b'.repeat(40);
const durable: FilesystemProbe = async path => ({ probed: path, volatile: null, freeBytes: 200e9 });
const mint = async () => ({ token: 'ghs_session_token_value', expiresAt: new Date(Date.now() + 3_000_000).toISOString() });

function herdr(calls: string[][]) {
  let pane = 0;
  return (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'tab') { pane++; return JSON.stringify({ result: { type: 'tab_created', root_pane: { pane_id: `pane-${pane}`, tab_id: `tab-${pane}` }, tab: { tab_id: `tab-${pane}` } } }); }
    return startedAtOnce(args) ?? JSON.stringify({ result: args[0] === 'pane' && args[1] === 'list' ? { panes: [] } : {} });
  };
}
const launchArgs = (calls: string[][]) => expandTypedCommand(calls.find(args => args[0] === 'pane' && args[1] === 'run')![3]).args;
const granted = (args: string[]) => args.flatMap((arg, index) => arg === '--add-dir' ? [args[index + 1]] : []);

/** A coordinator checkout that is itself a linked worktree of a main clone, with Codex reviewer and producer profiles. */
async function installation() {
  const scratch = await realpath(await temporaryDirectory('session-grant'));
  const main = join(scratch, 'main'), root = join(scratch, 'coordinator'), credentials = join(scratch, 'credentials'), managed = join(scratch, 'data', 'worktrees');
  await mkdir(main); await mkdir(credentials, { mode: 0o700 });
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(main, 'init', '-q', '-b', 'main'); git(main, 'remote', 'add', 'origin', 'https://github.com/owner/project.git');
  await writeFile(join(main, 'README.md'), 'session grant\n');
  git(main, 'add', 'README.md'); git(main, '-c', 'user.name=Graphyard', '-c', 'user.email=graphyard@example.test', 'commit', '-q', '-m', 'initial');
  git(main, 'worktree', 'add', '-q', '--detach', root, 'HEAD');
  const common = git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  await mkdir(join(common, 'refs', 'remotes'), { recursive: true });
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'workspace', run: { worktreeRoot: managed } }, coordinatorStatus, { probe: durable });
  await bindReviewer(root, { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', privateKey, credentialDirectory: join(credentials, 'reviewers') }, async () => ({ repository: 'owner/project', permissions: { metadata: 'read', contents: 'read', pull_requests: 'write' } }));
  await saveReviewerProfile(root, { name: 'reviewer-a', agentName: 'review-a', kind: 'codex' });
  const token = join(credentials, 'producer.token'); await writeFile(token, 'producer-token-'.padEnd(40, 'x'), { mode: 0o600 });
  await saveProducerProfile(root, { name: 'producer-a', principal: 'proof-runner', agentName: 'produce-a', kind: 'codex', credentialFile: token, concurrency: 1 }, async () => ({ actor: { id: 'proof-runner', role: 'producer', proofs: ['unit:*', 'integration:*'] } }));
  return { scratch, main, root, common, git, cleanup: () => rm(scratch, { recursive: true, force: true }) };
}

let serial = 0;
const request = () => ({ id: `request-${++serial}`, kind: 'producer', sha: H, baseSha: B, policyRevision: 2, pr: 88, group: 'integration', proofs: ['integration:session-grant'], state: 'requested', requestedAt: new Date().toISOString(), reason: 'r' }) as any;
function work(key: string, asked?: unknown): Work {
  const candidate = { sha: H, baseSha: B, pr: 88, branch: `graphyard/${key.toLowerCase()}-1`, author: 'implementer' };
  return { id: `id-${key}`, key, title: 'Session grant', description: '', type: 'bug', priority: 1, dependencies: [], plannedFiles: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:session-grant'] }], policy: { checks: ['test'], review: true }, stage: 'review', revision: 3, policyRevision: 2,
    createdAt: '', updatedAt: '', stageEnteredAt: '', ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 88 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    blocker: null, gates: [], violations: [], implementers: ['implementer'],
    observation: { at: new Date().toISOString(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files: [], scopeFiles: [], prState: 'open', draft: false },
    ...(asked ? { autoDispatch: { review: null, producers: [asked], history: [] } } : {}) } as unknown as Work;
}

test('unit:review-producer-launch-git-grant — reviewer and producer Codex launches grant the narrow Git paths, never the common Git directory', async () => {
  const { root, main, common, git, cleanup } = await installation();
  try {
    const config = await loadMasterConfig(root);
    const reviewCalls: string[][] = [];
    const reviewed = await launchReview(root, work('GY-1'), 'reviewer-a', [], new Date().toISOString(), { run: herdr(reviewCalls), mint, filesystem: durable, sandbox: null });
    const asked = request(), produceCalls: string[][] = [];
    const produced = await launchProducer(root, work('GY-2', asked), asked, config.producers[0], [], new Date().toISOString(), { run: herdr(produceCalls), filesystem: durable, sandbox: null });
    for (const [role, calls, checkout] of [['reviewer', reviewCalls, reviewed.checkout], ['producer', produceCalls, produced.checkout]] as const) {
      const args = launchArgs(calls), grants = granted(args);
      assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write', `the ${role} runs under the Codex workspace-write sandbox`);
      assert.ok(!grants.includes(common), `no ${role} --add-dir is the common Git directory ${common}: ${grants.join(' ')}`);
      assert.ok(!grants.includes(join(main, '.git')) && !grants.includes(join(root, '.git')), `nor any .git directory: ${grants.join(' ')}`);
      assert.ok(grants.includes(checkout), `the ${role} checkout is granted`);
      assert.ok(grants.includes(join(common, 'objects')), `the ${role} writes objects`);
      assert.ok(grants.includes(join(common, 'refs', 'remotes')), `the ${role} writes remote-tracking refs`);
      assert.ok(grants.includes(join(common, 'worktrees')), `the ${role} registers its detached worktree`);
      assert.ok(!grants.includes(git(root, 'rev-parse', '--absolute-git-dir')), `the coordinator's own admin directory is never the ${role}'s`);
    }
    assert.match(launchArgs(reviewCalls).at(-1)!, /git fetch --no-write-fetch-head origin/, 'the fetch writes nothing into the ungranted common Git directory');

    // A linked-worktree checkout's own admin directory is granted, with objects, and the common directory is not.
    const linked = join(reviewed.checkout, 'checkout');
    git(main, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
    const paths = sessionWritablePaths(linked, common);
    assert.ok(paths.includes(git(linked, 'rev-parse', '--absolute-git-dir')), `the checkout's own git dir is granted: ${paths.join(' ')}`);
    assert.ok(paths.includes(join(common, 'objects')));
    assert.ok(!paths.includes(common));
  } finally { await cleanup(); }
});

test('integration:review-launch-sandbox-probe — a reviewer or producer whose sandbox cannot write a granted path is refused at launch, naming the runtime and the path', async () => {
  const { root, common, cleanup } = await installation();
  try {
    const config = await loadMasterConfig(root);
    const refused = join(common, 'objects');
    const probes: { command: string; args: string[] }[] = [];
    const failing: SandboxExec = (command, args) => { probes.push({ command, args }); return `unwritable\t${refused}\tbwrap: Can't create file ${refused}/.git: Read-only file system\n`; };

    const reviewCalls: string[][] = [];
    await assert.rejects(launchReview(root, work('GY-3'), 'reviewer-a', [], new Date().toISOString(), { run: herdr(reviewCalls), mint, filesystem: durable, sandbox: failing }),
      (error: Error) => error.message.includes('Reviewer launch failed') && error.message.includes('codex sandbox') && error.message.includes(refused));
    assert.equal(probes[0].command, 'codex');
    assert.equal(probes[0].args[0], 'sandbox', 'the runtime\'s own sandbox probe ran');
    assert.ok(probes[0].args.includes(refused), 'and it was asked to write every granted path');
    assert.ok(!reviewCalls.some(args => args[0] === 'tab'), 'no reviewer session was started');
    assert.equal((await readReviewLedger(root)).reviews.filter(review => review.state === 'pending' && review.pane).length, 0);

    const asked = request(), produceCalls: string[][] = [];
    await assert.rejects(launchProducer(root, work('GY-4', asked), asked, config.producers[0], [], new Date().toISOString(), { run: herdr(produceCalls), filesystem: durable, sandbox: failing }),
      (error: Error) => error.message.includes('Producer launch failed') && error.message.includes('codex sandbox') && error.message.includes(refused));
    assert.equal(probes.length, 2);
    assert.ok(!produceCalls.some(args => args[0] === 'tab'), 'no producer session was started');
    assert.equal((await readProducerLedger(root)).producers.filter(producer => producer.pane).length, 0);

    // A probe that passes lets the launch go ahead.
    const passing: SandboxExec = (command, args) => { probes.push({ command, args }); return 'writable\n'; };
    const started = await launchReview(root, work('GY-5'), 'reviewer-a', [], new Date().toISOString(), { run: herdr([]), mint, filesystem: durable, sandbox: passing });
    assert.ok(started.pane);
    assert.equal(probes.length, 3);
  } finally { await cleanup(); }
});
