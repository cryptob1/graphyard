import { test } from 'node:test';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Work } from '../src/model.js';
import type { ActionRow } from '../src/model/actions.js';
import { emptyDaemonState, runDaemon, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, workerProfileSchema, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { accountLaunch } from '../src/master/environments.js';
import { installWorkerHarness, prepareSessionHarness, sessionHarnessPlan, workerHarnessPlan } from '../src/master/harness.js';
import { coordinatorCheckoutRefusal, coordinatorCheckoutRoot, dirtyCheckoutEscalation, dirtyCheckoutLeases, dirtyCheckoutPaths, readCoordinatorCheckout, workerConfinementRefusal } from '../src/master/profiles.js';
import { controlPlaneHandlers, type ControlPlaneEffects } from '../src/executor.js';
import { grantWorkerPaths, runtimeSandboxes, workerPaths, writablePaths } from '../src/worker-sandbox.js';

// GY-857: workers are confined to their assigned worktrees, and neither the loop nor an executor
// starts, self-upgrades or restarts from a coordinator checkout holding uncommitted work — the
// two halves of the containment that was missing when worker sessions wrote half-finished files
// into the coordinator checkout by absolute path and a restart loaded them into the live loop.

const iso = (offsetMs: number) => new Date(Date.parse('2030-01-01T00:00:00Z') + offsetMs).toISOString();
const hour = 3_600_000;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const addedDirectories = (args: string[], cwd: string) => args.flatMap((arg, index) => arg === '--add-dir' ? [join(cwd, args[index + 1])] : []);
const openCodeConfined = JSON.stringify({ edit: 'allow', bash: 'allow', webfetch: 'allow', external_directory: 'deny' });

/** A coordinator checkout laid out like a Graphyard installation, with one managed assignment worktree. */
async function coordinatorFixture() {
  const root = await temporaryDirectory('checkout-guard');
  const credentials = join(root, 'credentials');
  await mkdir(credentials, { recursive: true, mode: 0o700 });
  const credentialFile = join(credentials, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const main = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', main], { stdio: 'ignore' });
  git(main, 'config', 'user.email', 't@example.com');
  git(main, 'config', 'user.name', 'T');
  await mkdir(join(main, 'src'), { recursive: true });
  await mkdir(join(main, 'bin'), { recursive: true });
  await mkdir(join(main, 'tests'), { recursive: true });
  await mkdir(join(main, '.claude'), { recursive: true });
  await writeFile(join(main, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
  await writeFile(join(main, 'src', 'loop.ts'), 'export const loop = 1;\n');
  await writeFile(join(main, 'tests', 'base.test.ts'), 'import { test } from "node:test";\n');
  await writeFile(join(main, '.gitignore'), '.graphyard/\n.claude/settings.local.json\n');
  await writeFile(join(main, '.claude', 'settings.json'), '{}\n');
  git(main, 'add', '.');
  git(main, 'commit', '-q', '-m', 'base');
  const worktree = join(main, '.graphyard', 'worktrees', 'GY-1-1');
  git(main, 'worktree', 'add', '-q', '-b', 'graphyard/gy-1-1', worktree);
  const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: join(main, 'bin', 'graphyard.mjs'),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  return { root, main, worktree, credentials, credentialFile, config, dispose: () => Promise.resolve() };
}

type Fixture = Awaited<ReturnType<typeof coordinatorFixture>>;
const workerProfiles = (fixture: Fixture): WorkerProfile[] => {
  const base = { mode: 'launch' as const, approvals: 'auto' as const, principal: 'graphyard-worker-1', credentialFile: join(fixture.credentials, 'worker.token') };
  return ([
    { ...base, name: 'claude-worker', agentName: 'graphyard-claude-1', kind: 'claude' as const, agentArgs: [], environment: {} },
    { ...base, name: 'codex-worker', agentName: 'graphyard-codex-1', kind: 'codex' as const, agentArgs: [], environment: {} },
    { ...base, name: 'opencode-worker', agentName: 'graphyard-opencode-1', kind: 'opencode' as const, agentArgs: [], environment: { OPENCODE_PERMISSION: openCodeConfined } },
  ]).map(profile => workerProfileSchema.parse(profile));
};

test('unit:worker-confined-to-worktree — every worker profile is launched with writes confined to its assigned worktree; the coordinator checkout is not writable from it', async () => {
  const fixture = await coordinatorFixture();
  try {
    const { main, worktree, config, credentials } = fixture;
    const paths = workerPaths(worktree);
    const writable = writablePaths({ ...paths, commonDir: paths.commonDir ?? join(main, '.git') });
    for (const profile of workerProfiles(fixture)) {
      // The profile as configured launches: no confinement opt-out, and the effective launch
      // grants nothing but the worktree and its Git admin directories.
      assert.equal(workerConfinementRefusal(profile), null, `${profile.name} as configured launches`);
      const launch = accountLaunch(profile, null);
      const args = grantWorkerPaths(profile.kind, launch.args, writable, worktree);
      const granted = addedDirectories(args, worktree);
      if (profile.kind === 'codex') {
        assert.equal(runtimeSandboxes.codex.mode(args), 'workspace-write', 'the codex worker keeps its workspace-write sandbox');
        assert.deepEqual(granted, writable.filter(path => path !== worktree), 'only the Git admin directories are granted beside the worktree');
        assert.ok(granted.every(path => path.endsWith('/.git') || path.includes('/.git/')), `the coordinator checkout's working files are granted to no codex worker: ${granted.join(', ')}`);
      }
      if (profile.kind === 'opencode') {
        assert.equal(JSON.parse(launch.environment.OPENCODE_PERMISSION).external_directory, 'deny', 'the opencode worker edits no path outside its worktree');
      }
      if (profile.kind !== 'claude') continue;
      // Claude Code is confined by its harness rules: both files the session reads deny writing
      // the coordinator checkout's own files, and neither names the worktree itself.
      const coordinator = coordinatorCheckoutRoot(config.cliPath);
      const rules = workerHarnessPlan({ cliPath: config.cliPath, branch: 'graphyard/gy-1-1', baseBranch: 'main', credentialHome: credentials });
      const denials = rules.deny.filter(rule => /^(Edit|Write)\(\/\//.test(rule.rule));
      for (const area of ['src', 'tests', 'scripts', 'bin', 'docs']) {
        assert.ok(denials.some(rule => rule.rule === `Edit(//${coordinator.replace(/^\//, '')}/${area}/**)`), `the worker rules deny editing ${area}/ in the coordinator checkout`);
        assert.ok(denials.some(rule => rule.rule === `Write(//${coordinator.replace(/^\//, '')}/${area}/**)`), `the worker rules deny writing ${area}/ in the coordinator checkout`);
      }
      assert.ok(rules.deny.every(rule => !rule.rule.includes(worktree)), 'no worker rule denies the assigned worktree itself');
      const written = await installWorkerHarness(config, profile, 'GY-1', { epoch: 1, path: worktree, base: 'c'.repeat(40) });
      assert.equal(written.applied, true, 'the worker rules were written into the worktree');
      const settings = JSON.parse(await readFile(join(worktree, '.claude', 'settings.local.json'), 'utf8'));
      assert.ok(settings.permissions.deny.includes(`Edit(//${coordinator.replace(/^\//, '')}/src/**)`), 'the worktree settings deny editing the coordinator checkout');
      const session = await prepareSessionHarness(main, config, { role: 'worker', kind: 'claude', profile: profile.name, branch: 'graphyard/gy-1-1', credentialFiles: [profile.credentialFile!] });
      assert.ok(session.file, 'the worker role file was written');
      const role = JSON.parse(await readFile(session.file!, 'utf8'));
      assert.ok(role.permissions.deny.includes(`Write(//${coordinator.replace(/^\//, '')}/docs/**)`), 'the role file denies writing the coordinator checkout');
      const rolePlan = sessionHarnessPlan({ role: 'worker', kind: 'claude', cliPath: config.cliPath, repository: config.repository, baseBranch: config.baseBranch, credentialHome: credentials, credentialDirectories: [], branch: 'graphyard/gy-1-1' });
      assert.ok(rolePlan.deny.some(rule => rule.rule.startsWith('Edit(//')), 'the session harness carries the coordinator checkout denials');
      // A profile that would turn the confinement off never installs a harness, so it never launches.
      await assert.rejects(installWorkerHarness(config, { ...profile, agentArgs: ['--dangerously-skip-permissions'] }, 'GY-1', { epoch: 1, path: worktree, base: 'c'.repeat(40) }), /cannot launch with --dangerously-skip-permissions/);
    }
    // The other half: each confined runtime refuses the settings that would unconfine it.
    assert.match(workerConfinementRefusal({ kind: 'codex', agentArgs: ['--sandbox', 'danger-full-access'], environment: {} })!, /workspace-write/);
    assert.match(workerConfinementRefusal({ kind: 'claude', agentArgs: ['--yolo'], environment: {} })!, /--yolo/);
    assert.match(workerConfinementRefusal({ kind: 'opencode', agentArgs: [], environment: {} })!, /external_directory/);
    assert.match(workerConfinementRefusal({ kind: 'opencode', agentArgs: [], environment: { OPENCODE_PERMISSION: '{"edit":"allow","external_directory":"allow"}' } })!, /external_directory/);
  } finally { await fixture.dispose(); }
});

/** Effects both the loop and the executor read: a snapshot over `work`, and stubs for everything else. */
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
const loopOptions = (fixture: Fixture, extra: Partial<Parameters<typeof runDaemon>[3]> = {}) => ({
  once: true, intervalMs: 5, identity: { pid: process.pid, host: 'machine-a' }, signals: [] as NodeJS.Signals[], log: () => {}, ...extra,
});

test('unit:dirty-coordinator-checkout-refused — the loop refuses to start from a dirty coordinator checkout, raises attention naming the paths and the live leases they match, skips the self-upgrade, and an executor refuses every claim', async () => {
  const fixture = await coordinatorFixture();
  try {
    const { main, config } = fixture;
    // Clean baseline: the checkout is clean, so the loop cycles and the upgrade gate passes.
    let upgrades = 0;
    const cleanState = emptyDaemonState(config);
    const clean = await runDaemon(config, cleanState, loopEffects([], { selfUpgrade: async () => { upgrades++; return { outcome: 'skipped', reason: 'nothing deployed yet' }; } }), loopOptions(fixture));
    assert.equal(clean.cycles.length, 1, 'a clean checkout starts the loop');
    assert.equal(upgrades, 1, 'the between-cycles self-upgrade runs on a clean checkout');
    assert.equal(cleanState.actions['escalation:dirty-checkout'], undefined);

    // Dirty it the way the incident was: a modified module and an untracked test. A scratch file
    // outside the source paths is nobody's code and dirties nothing.
    const original = await readFile(join(main, 'src', 'loop.ts'), 'utf8');
    await writeFile(join(main, 'src', 'loop.ts'), `${original}\nexport const halfFinished = true;\n`);
    await writeFile(join(main, 'tests', 'scratch.test.ts'), 'import { test } from "node:test";\n');
    await writeFile(join(main, 'notes.txt'), 'not source\n');
    const checkout = await readCoordinatorCheckout(main);
    assert.ok(checkout.modified.includes('src/loop.ts'), 'the modified module is read as dirty');
    assert.ok(checkout.untracked.includes('tests/scratch.test.ts'), 'the untracked test is read as uncommitted source');
    assert.equal(checkout.untracked.includes('notes.txt'), false, 'a scratch file outside the source paths is not uncommitted source');
    const dirty = dirtyCheckoutPaths(checkout);
    assert.match(coordinatorCheckoutRefusal(checkout, 'the master loop')!, /refuses to start, self-upgrade or restart/);

    // The loop: refused, with the attention naming the paths and the live leases whose planned
    // files they match — and no cycle, so no dirty code runs.
    const work = [
      { key: 'GY-852', id: 'w1', lease: { epoch: 3, owner: 'graphyard-claude-1', expiresAt: iso(hour) }, plannedFiles: ['src/loop.ts'] },
      { key: 'GY-853', id: 'w2', lease: { epoch: 1, owner: 'graphyard-codex-1', expiresAt: iso(hour) }, plannedFiles: ['web/app.ts'] },
      { key: 'GY-854', id: 'w3', lease: { epoch: 2, owner: 'graphyard-claude-2', expiresAt: iso(-hour) }, plannedFiles: ['src/loop.ts'] },
      { key: 'G-Y855', id: 'w4', lease: null, plannedFiles: ['tests/scratch.test.ts'] },
    ];
    const state = emptyDaemonState(config);
    const log: string[] = [];
    const refused = await runDaemon(config, state, loopEffects(work), loopOptions(fixture, { log: line => log.push(line) }));
    assert.deepEqual(refused.cycles, [], 'the loop cycles nothing from a dirty checkout');
    const escalation = state.actions['escalation:dirty-checkout'];
    assert.ok(escalation, 'the refusal is raised as attention on the cursor');
    assert.equal(escalation.kind, 'escalation');
    assert.match(escalation.detail, /src\/loop\.ts/);
    assert.match(escalation.detail, /tests\/scratch\.test\.ts/);
    assert.match(escalation.detail, /the master loop refuses to start, self-upgrade or restart/);
    assert.match(escalation.detail, /GY-852 epoch 3 \(graphyard-claude-1\): src\/loop\.ts/, 'the live lease whose planned files match is named');
    assert.ok(!escalation.detail.includes('GY-853'), 'a live lease matching none of the paths is not named');
    assert.ok(!escalation.detail.includes('GY-854'), 'an expired lease is not named');
    assert.ok(log.some(line => line.includes('escalation failed')), 'the refusal is logged');
    assert.deepEqual(dirtyCheckoutLeases(work, dirty, Date.parse(iso(hour - 1))).map(lease => lease.key), ['GY-852'], 'only the matching live lease is attributed');
    assert.match(dirtyCheckoutEscalation('refused', []), /^refused$/, 'with no matching lease the refusal stands alone');

    // The between-cycles gate: the self-upgrade is skipped while the checkout is dirty.
    const upgradeState = emptyDaemonState(config);
    upgrades = 0;
    await runDaemon(config, upgradeState, loopEffects(work, { selfUpgrade: async () => { upgrades++; return { outcome: 'skipped', reason: 'nothing deployed yet' }; } }), loopOptions(fixture));
    assert.equal(upgrades, 0, 'the self-upgrade never moves a dirty checkout');

    // The executor: every claim is refused with the same paths, and nothing else is read first.
    const row = { id: 'a1', key: 'GY-852', work: 'w1', kind: 'dispatch', inputs: { kind: 'dispatch', target: 'implementation', epoch: 3 } } as unknown as ActionRow;
    let snapshotReads = 0;
    const dirtyHandlers = controlPlaneHandlers(() => config, loopEffects(work, { snapshot: async () => { snapshotReads++; return { work: work as Work[], now: iso(0) }; } }));
    const run = (handler: typeof dirtyHandlers.dispatch, action: ActionRow) => (handler as (action: unknown, identity: unknown) => Promise<unknown>)(action, { id: 'exec', host: 'machine-a' });
    await assert.rejects(run(dirtyHandlers.dispatch!, row), (error: Error) => /holds uncommitted work/.test(error.message) && /src\/loop\.ts/.test(error.message));
    assert.equal(snapshotReads, 0, 'a refused executor reads nothing and runs nothing');

    // Clean again: the loop starts, and an executor's handlers run.
    await writeFile(join(main, 'src', 'loop.ts'), original);
    await rm(join(main, 'tests', 'scratch.test.ts'));
    await rm(join(main, 'notes.txt'));
    const resumed = emptyDaemonState(config);
    const resumedRun = await runDaemon(config, resumed, loopEffects([]), loopOptions(fixture));
    assert.equal(resumedRun.cycles.length, 1, 'a cleaned checkout starts the loop again');
    const cleanConfig: MasterConfig = { ...config, url: '' };
    const cleanHandlers = controlPlaneHandlers(() => cleanConfig, loopEffects(work));
    await assert.rejects(run(cleanHandlers.dispatch!, row), /no worker profile can take GY-852/, 'with a clean checkout the executor handler runs');
  } finally { await fixture.dispose(); }
});

test('unit:coordinator-guard-tests-exist — this file carries the coordinator checkout guard proofs', async () => {
  const text = await readFile(fileURLToPath(import.meta.url), 'utf8');
  for (const proof of ['unit:worker-confined-to-worktree', 'unit:dirty-coordinator-checkout-refused']) {
    assert.ok(text.includes(`'${proof}`), `${proof} is exercised in tests/coordinator-checkout-guard.test.ts`);
  }
});
