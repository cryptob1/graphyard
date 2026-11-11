import { runtimeSandboxes } from '../src/worker-sandbox.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dispatchWork, loadMasterConfig, setupMaster, type WorkerProfile } from '../src/master.js';
import type { Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { registryFixture } from './helpers/registry-fixture.js';
import { readySpecCheck } from './helpers/spec-check.js';

import { releaseWorkerLaunch, accountStartFailurePath } from '../src/master/dispatch.js';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const coordinatorToken = 'coordinator-token-'.padEnd(40, 'x');
const workerToken = 'worker-token-'.padEnd(40, 'x');
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A repository laid out like a Graphyard checkout: an origin, the main clone, and a managed linked worktree. */
async function linkedWorktree(name = 'GY-1-1') {
  const root = await realpath(await temporaryDirectory('sandbox'));
  const origin = join(root, 'origin.git'), main = join(root, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, main], { stdio: 'ignore' });
  git(main, 'config', 'user.email', 't@example.com'); git(main, 'config', 'user.name', 'T');
  await writeFile(join(main, 'README.md'), '# Fixture\n'); git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'base'); git(main, 'push', '-q', 'origin', 'main');
  const worktree = join(main, '.graphyard/worktrees', name);
  git(main, 'worktree', 'add', '-q', '-b', `graphyard/${name.toLowerCase()}`, worktree);
  git(worktree, 'config', 'user.email', 't@example.com'); git(worktree, 'config', 'user.name', 'T');
  return { root, main, worktree, gitDir: join(main, '.git/worktrees', name), commonDir: join(main, '.git') };
}
async function dispatchFixture() {
  const fixture = await linkedWorktree('GY-7-1');
  const credentialDirectory = await temporaryDirectory('sandbox-credentials');
  const credential = join(credentialDirectory, 'worker.token'); await writeFile(credential, workerToken, { mode: 0o600 });
  git(fixture.main, 'remote', 'set-url', 'origin', 'https://github.com/owner/project.git');
  await setupMaster(fixture.main, { url: 'https://graphyard.example', token: coordinatorToken, cliPath: launcher, credentialDirectory }, (async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 }))) as typeof fetch);
  const profile: WorkerProfile = { name: 'launch', principal: 'worker-a', agentName: 'eng-a', mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} };
  const item = { id: 'id-GY-7', key: 'GY-7', title: 'GY-7', description: '', type: 'feature', priority: 2, dependencies: [], criteria: [{ id: 'AC-1', text: 'Specified work', proofs: ['e2e:fixture'] }], policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString(), ready: true, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false,
    scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [],
    // GY-2992: a released feature dispatches only with its spec check reported; this fixture stands after it did.
    specCheck: readySpecCheck(new Date().toISOString()) } as unknown as Work;
  return { ...fixture, profile, item, cleanup: async () => { await rm(fixture.root, { recursive: true, force: true }); await rm(credentialDirectory, { recursive: true, force: true }); } };
}

for (const kind of ['codex', 'pi']) test(`unit:tests/sandbox-probe-parks.test.ts — ${kind} probe blocks once without failing accounts and waits for unblock`, async t => {
  // Give Pi a test sandbox so its probe runs through the injected executor without nesting bwrap.
  if (kind === 'pi') t.mock.method(runtimeSandboxes.pi, 'mode', () => 'workspace-write');
  const fixture = await dispatchFixture();
  try {
    const master = await loadMasterConfig(fixture.main);
    const profile = { ...fixture.profile, kind } as WorkerProfile;
    master.workers = [profile];
    await writeFile(join(fixture.main, '.graphyard/master.json'), JSON.stringify(master));
    const registry = registryFixture(master.hostId!, [kind]);
    const observations = t.mock.fn(registry.client.observe!);
    registry.client.observe = observations;
    const state = emptyDaemonState(master);
    const item = fixture.item;
    item.description = 'Change src/master/dispatch.ts';
    const commands: string[][] = [];
    let launches = 0;
    const deps: DaemonEffects = {
      snapshot: async () => ({ work: [item], now: new Date().toISOString() }),
      agents: () => [], credentials: async () => ({ [profile.name]: { available: true, reason: null } }),
      closeSession: () => {}, persist: async () => {},
      dispatch: async () => {
        launches++;
        return dispatchWork(fixture.main, item, profile, [], async () => { throw new Error('No runtime should start'); }, [item],
          async () => ({ epoch: 3, path: fixture.worktree, base: 'c'.repeat(40) }),
          async (root, key, epoch, name, blocker) => {
            assert.ok(blocker);
            // Exercise the production CLI adapter using the claimed worker identity.
            await releaseWorkerLaunch(root, key, epoch, name, blocker, async (_command, args, options) => {
              commands.push(args);
              assert.equal(options?.env?.GRAPHYARD_TOKEN_FILE, profile.credentialFile);
              return '';
            });
            item.epoch = 3;
            item.blocker = blocker;
            item.ready = false;
          }, 1, new Date().toISOString(), { probe: registry.probe, sandbox: () => {
            throw Object.assign(new Error('probe refused'), { status: 3, stdout: `unwritable\t${fixture.gitDir}\tRead-only file system\n`, stderr: '' });
          } });
      },
    };
    await runCycle(master, state, deps);
    assert.equal(launches, 1);
    assert.equal(commands.length, 1, JSON.stringify(state.actions));
    assert.deepEqual(commands[0].slice(1, 4), ['blocked', item.key, '3']);
    assert.ok(item.blocker!.includes(fixture.gitDir));
    assert.match(item.blocker!, /Read-only file system/);
    assert.equal(registry.sessions().length, 1, 'no fallback account');
    assert.ok(registry.sessions()[0].endedAt, 'selected slot returned');
    assert.equal(existsSync(accountStartFailurePath(master)), false);
    assert.equal(observations.mock.callCount(), 0, 'no account is marked failed or held');
    assert.deepEqual(state.failureRuns, {}, 'host fault is not a runtime failure');
    for (let cycle = 0; cycle < 3; cycle++) await runCycle(master, state, deps);
    assert.equal(launches, 1, 'blocked item is not dispatched again');
    item.blocker = null; item.ready = true;
    await runCycle(master, state, deps);
    assert.equal(launches, 2, 'unblocking permits another dispatch');
  } finally { await fixture.cleanup(); }
});
