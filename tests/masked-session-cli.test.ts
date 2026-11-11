import { test } from './helpers/loop-state.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { credentialMaskFor, coordinatorConfinement, sessionMountNamespaceWorks } from '../src/master/confinement.js';
import { LauncherUnavailableError, loadMasterConfig, setupMaster } from '../src/master.js';
import type { Work } from '../src/model.js';
import { emptyDispatchCursor } from '../src/dispatch/cursor.js';
import { runDispatchTick } from '../src/dispatch/tick.js';
import { cliUnreachableRefusal, launchReview, readReviewLedger, saveReviewerProfile } from '../src/reviewer.js';
import { fleet, requested } from './helpers/review-fleet.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2995: a self-deployed install runs its CLI from a checkout under the operator config home
// (~/.config/graphyard/<install>/deploy/build, the launcher at bin/graphyard.mjs), and its
// reviewer sessions authenticate through a binding directory under it too
// (<install>/reviewers/sessions/<id>, the session's GH_CONFIG_DIR). GY-1856's credential mask
// masked the config home wholesale and kept only runtime login homes, so every reviewer and
// reviewer such an install launched found an empty tmpfs where its CLI and its own binding
// should be: it could never post a verdict, went idle, and the loop relaunched it. The mask now
// keeps the launcher's deploy checkout read-only and the session's own binding directory
// writable, and a launch whose sandbox still cannot reach the CLI its prompt names is refused
// before any session starts, named as configuration attention instead of relaunched.

const ownToken = 'review-session-token-'.padEnd(48, 'x');
const coordinatorSecret = 'coordinator-secret-'.padEnd(48, 'x');
const appSecret = 'reviewer-app-secret-'.padEnd(44, 'x');
const siblingSecret = 'other-install-secret-'.padEnd(48, 'x');

/** A coordinator checkout, a reviewer session checkout outside the config home, and an install whose CLI and reviewer credentials live under the config home. */
function maskedFixture(base: string) {
  const root = join(base, 'coordinator');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  for (const args of [['config', 'user.email', 't@l'], ['config', 'user.name', 'T'], ['remote', 'add', 'origin', 'https://github.com/owner/project.git'], ['add', '.'], ['commit', '-m', 'one']])
    spawnSync('git', ['-C', root, ...args]);
  const checkout = join(base, 'managed', 'review-gy-2995');
  mkdirSync(checkout, { recursive: true });
  // The install under the config home: its deploy checkout with the CLI launcher, its coordinator
  // credential, its reviewer App credential, and the session's own binding directory.
  const configHome = join(base, 'config-home'), install = join(configHome, 'acme-graphyard');
  const deployCheckout = join(install, 'deploy', 'build'), cli = join(deployCheckout, 'bin', 'graphyard.mjs');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, [
    '#!/usr/bin/env node',
    'import { readFileSync } from "node:fs";',
    'const binding = JSON.parse(readFileSync(`${process.env.GH_CONFIG_DIR}/review-binding.json`, "utf8"));',
    'console.log(`POSTED ${binding.token} to ${binding.url}`);',
    '',
  ].join('\n'));
  writeFileSync(join(deployCheckout, 'package.json'), '{"name":"deploy","private":true}\n');
  const sessionDirectory = join(install, 'reviewers', 'sessions', 'review-1');
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(join(sessionDirectory, 'review-binding.json'), JSON.stringify({ token: ownToken, url: 'https://graphyard.example' }), { mode: 0o600 });
  const coordinatorCredential = join(install, 'masters', 'coordinator.token');
  const appCredential = join(install, 'reviewers', 'reviewer-app.json');
  const siblingCredential = join(configHome, 'other-install', 'tokens', 'other.token');
  for (const [file, secret] of [[coordinatorCredential, coordinatorSecret], [appCredential, appSecret], [siblingCredential, siblingSecret]] as [string, string][]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, secret, { mode: 0o600 });
  }
  const runtimeHome = join(base, 'runtime-home');
  mkdirSync(runtimeHome, { recursive: true });
  return { root, checkout, configHome, install, deployCheckout, cli, sessionDirectory, coordinatorCredential, appCredential, siblingCredential, runtimeHome };
}

test('integration:masked-session-reaches-own-cli — under the reviewer mask a session whose install runs its CLI from under the config home executes that CLI and reads its own binding, while every other credential under the config home stays unreadable', async () => {
  const base = await temporaryDirectory('masked session own cli');
  try {
    // The session shape the reviewer launches share: the binding directory is the
    // session's GH_CONFIG_DIR, the launcher sits in the install's deploy checkout, and the working
    // directory is a managed checkout outside the config home.
    const f = maskedFixture(base);
    const config = { cliPath: f.cli, credentialFile: f.coordinatorCredential };
    const mask = credentialMaskFor(config, { credentialFile: f.sessionDirectory, runtimeHomes: [f.runtimeHome] }, f.configHome);
    assert.deepEqual(mask.cli, [f.deployCheckout], 'the mask keeps the deploy checkout the CLI runs from');
    assert.ok(mask.own.includes(f.sessionDirectory), 'the mask keeps the session\'s own binding directory');
    const confinement = await coordinatorConfinement({ kind: 'pi', args: [], coordinatorRoot: f.root, sessionDirectory: f.checkout, platform: 'linux', mountNamespaceWorks: true, bwrap: 'bwrap', credentialMask: mask });
    assert.ok(confinement, 'the launch carries a confinement');
    if (process.platform !== 'linux') return;
    assert.ok(await sessionMountNamespaceWorks(), 'mount namespaces work on this Linux host');
    const probe = [
      // The session posts its verdict: it executes the CLI its prompt names, reading its own binding.
      'GH_CONFIG_DIR="$2" node "$1" || echo CLI-FAILED',
      // Its own binding directory is its scratch, and its runtime login home stays.
      'touch "$2/scratch" && echo OWN-DIR-WRITABLE || echo OWN-DIR-READONLY',
      'touch "$7/probe" && echo LOGIN-WRITABLE || echo LOGIN-DENIED',
      // The CLI checkout is code: readable, never writable.
      'test -w "$1" && echo CLI-WRITABLE || echo CLI-READ-ONLY',
      // Every other credential under the config home stays hidden.
      'for path in "$3" "$4" "$5"; do test -r "$path" && echo "READABLE $path" || echo "DENIED $path"; done',
      'test -e "$6/acme-graphyard/masters" || echo MASTERS-GONE',
    ].join('\n');
    const launched = spawnSync(confinement.wrapper[0], [...confinement.wrapper.slice(1, -1), '/bin/sh', '-c', probe, 'sh',
      f.cli, f.sessionDirectory, f.coordinatorCredential, f.appCredential, f.siblingCredential, f.configHome, f.runtimeHome],
      { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' });
    assert.equal(launched.status, 0, `the confined probe ran: ${launched.stderr}`);
    const output = launched.stdout + '\n' + launched.stderr;
    assert.ok(launched.stdout.includes(`POSTED ${ownToken} to https://graphyard.example`), `the CLI executed and posted from the session's own binding: ${output.slice(0, 400)}`);
    for (const marker of ['OWN-DIR-WRITABLE', 'LOGIN-WRITABLE', 'CLI-READ-ONLY', 'DENIED', 'MASTERS-GONE'])
      assert.ok(launched.stdout.includes(marker), `${marker}: ${output.slice(0, 400)}`);
    assert.ok(!launched.stdout.includes('CLI-FAILED'), `the CLI ran: ${output.slice(0, 400)}`);
    // No secret value is reachable: every read the probe attempted, and its output, hold none.
    for (const secret of [coordinatorSecret, appSecret, siblingSecret]) assert.ok(!output.includes(secret), 'no secret value appears in the probe output');
    assert.ok(!output.includes('READABLE'), 'no masked credential is readable');
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('unit:masked-cli-refusal-judges-the-sandbox — the refusal names a launcher the host has lost or one the mask would not keep, and stays null while the sandbox reaches the CLI', async () => {
  const base = await temporaryDirectory('masked cli refusal');
  try {
    // The masked config home, with the install's deploy checkout under it.
    const configHome = join(base, 'config-home');
    const deployCheckout = join(configHome, 'acme', 'deploy', 'build'), cli = join(deployCheckout, 'bin', 'graphyard.mjs');
    await mkdir(dirname(cli), { recursive: true });
    await writeFile(cli, '#!/usr/bin/env node\n');
    const kept = credentialMaskFor({ cliPath: cli, credentialFile: join(configHome, 'masters', 'c.token') }, {}, configHome);
    assert.equal(cliUnreachableRefusal({ cliPath: cli }, kept), null, 'a launcher the mask keeps is reachable');
    // A launcher outside the config home is reachable wherever it exists.
    const outside = join(base, 'outside', 'bin', 'graphyard.mjs');
    await mkdir(dirname(outside), { recursive: true });
    await writeFile(outside, '#!/usr/bin/env node\n');
    assert.equal(cliUnreachableRefusal({ cliPath: outside }, kept), null, 'a launcher outside the config home is reachable');
    // Lost: the deploy checkout removed while the config still names it.
    const gone = join(configHome, 'gone', 'bin', 'graphyard.mjs');
    const lost = cliUnreachableRefusal({ cliPath: gone }, credentialMaskFor({ cliPath: gone }, {}, configHome));
    assert.match(lost!, /is not on this host/);
    assert.match(lost!, /restore the deploy checkout/);
    // Not kept: a mask that hides the config home without keeping the launcher.
    const refused = cliUnreachableRefusal({ cliPath: cli }, { configHome, extraPaths: [], own: [], cli: [] });
    assert.match(refused!, /sits under the masked config home and this launch's sandbox would not keep it/);
    // No absolute CLI path named at all.
    assert.match(cliUnreachableRefusal({ cliPath: 'relative/graphyard.mjs' }, kept)!, /names no absolute CLI path/);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

/** A master whose install runs its CLI from a deploy checkout beside its credentials, with one reviewer profile and a base tip. */
async function cliMaster(label: string) {
  const root = await temporaryDirectory(label), credentials = await temporaryDirectory(`${label}-cred`);
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['-C', root, 'remote', 'add', 'origin', 'https://github.com/owner/project.git']);
  const deployCheckout = join(credentials, 'acme-graphyard', 'deploy', 'build');
  const cli = join(deployCheckout, 'bin', 'graphyard.mjs');
  mkdirSync(dirname(cli), { recursive: true });
  writeFileSync(cli, '#!/usr/bin/env node\n');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  spawnSync('git', ['-C', root, 'add', '.']);
  spawnSync('git', ['-C', root, 'commit', '-m', 'one']);
  spawnSync('git', ['-C', root, 'update-ref', 'refs/remotes/origin/main', spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()]);
  const coordinator = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: cli, credentialDirectory: credentials }, coordinator as typeof fetch);
  await saveReviewerProfile(root, { name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' });
  return { root, credentials, cli, deployCheckout, config: await loadMasterConfig(root) };
}

const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);

/** A control-plane-observed candidate: a review is owed to it, and its launch needs a reviewer App or GitHub. */
function planeWork(clock: number, type: 'bug' | 'feature'): Work {
  const H = sha40('c1'), B = sha40('b1');
  const candidate = { sha: H, baseSha: B, pr: 2995, branch: 'graphyard/gy-2995-1', author: 'implementer' };
  const at = new Date(clock).toISOString();
  return {
    id: '5f0d2b6e-1c4b-4a2a-9e1f-000000299500', key: 'GY-2995', title: 'Masked sessions reach their own CLI', description: '', type, priority: 0, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Posts', proofs: ['integration:masked-session-reaches-own-cli'] }],
    policy: { checks: [], review: true }, stage: 'review', revision: 1, policyRevision: 1,
    createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null,
    workspaces: [], candidate, submission: { epoch: 1, pr: 2995 }, reworkRequested: false, scenarioRequirements: [], evidence: [],
    observation: { source: 'control-plane', candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
      files: ['src/a.ts'], scopeFiles: [], at, prState: 'open', draft: false, baseTip: B, baseTree: sha40('7b'), baseTipContained: true },
    blocker: null, gates: [], violations: [],
  } as unknown as Work;
}

test('integration:masked-session-missing-cli-refused — a review launch whose sandbox cannot reach the CLI the prompt names are refused before any session starts', async () => {
  const clock = 1_700_000_000_000;
  const master = await cliMaster('masked-cli-refused');
  const calls: string[][] = [];
  const run = (_command: string, args: string[]) => { calls.push(args); return JSON.stringify({ result: {} }); };
  try {
    // The deploy checkout is gone (a failed upgrade removed it); the config still names the launcher.
    rmSync(master.deployCheckout, { recursive: true, force: true });
    const review = planeWork(clock, 'bug');
    await assert.rejects(
      launchReview(master.root, review, 'claude-reviewer', [], new Date(clock).toISOString(), { run, now: () => new Date(clock) }),
      (error: unknown) => {
        assert.ok(error instanceof LauncherUnavailableError, 'the refusal is the launcher-unavailable configuration fault');
        assert.match((error as Error).message, /unavailable/);
        assert.match((error as Error).message, /restore the deploy checkout/);
        return true;
      });
    // Nothing started: no Herdr pane, no session directory material, no pending review record.
    assert.deepEqual(calls, [], 'no Herdr call was made');
    const sessions = join(master.credentials, 'acme-graphyard', 'reviewers', 'sessions');
    assert.ok(!existsSync(sessions) || readdirSync(sessions).length === 0, 'no reviewer session directory was written');
    assert.equal((await readReviewLedger(master.root)).reviews.length, 0, 'the review reservation was given back');

  } finally { await rm(master.root, { recursive: true, force: true }); await rm(master.credentials, { recursive: true, force: true }); }
});

test('unit:masked-cli-refusal-waits-not-fails — the dispatcher turns the refusal into a wait that names the fix, counting no failure and recording no refusal', async () => {
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }, 'claude-reviewer');
  try {
    const config = await loadMasterConfig(host.root);
    const items = [requested(1)];
    const refusal = 'the CLI the prompt names (node /gone/graphyard.mjs) is not on this host, so no session could post its verdict; restore the deploy checkout it names, or set cliPath with graphyard master setup';
    const effects = {
      ...host.effects(() => items, () => config),
      launchReview: async () => { throw new LauncherUnavailableError(refusal); },
    } as Parameters<typeof runDispatchTick>[2];
    const cursor = emptyDispatchCursor(config);
    for (const _tick of [1, 2]) {
      const tick = await runDispatchTick(config, cursor, effects, Date.now);
      assert.deepEqual(tick.refused, [], 'no launch is counted as refused');
      const waits = tick.waiting.filter(entry => entry.kind === 'review');
      assert.equal(waits.length, 1, 'the request waits, naming the refusal');
      assert.match(waits[0].reason, /is not on this host/);
      assert.deepEqual(cursor.failures, {}, 'the cursor records no failure, so no backoff or limit ever applies');
    }
  } finally { await host.cleanup(); }
});
