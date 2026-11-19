import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultChildRun } from '../src/child-runner.js';
import { runTrial, trialMerge, trialSandboxFault, TrialSandboxFaultError } from '../src/merge-writer/trial.js';
import { trialContainerLaunch } from '../src/merge-writer/trial-container.js';
import { trialAppArmorProfilePath } from '../src/merge-writer/trial-apparmor.js';
import { provisionTrialAppArmor, trialAppArmorPlan } from '../src/install/trial-image.js';
import type { AdapterContext } from '../src/install/adapters.js';
import { setupFromZeroChecks, setupLine } from '../src/setup-from-zero.js';
import { mergeOne, baseFailurePrefix, type MergePorts } from '../src/merge-writer/executor.js';
import { trialRefusalHeld } from '../src/model/merge-queue.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { reportTrialSandboxFault } from '../src/daemon/control-plane.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';

// GY-3339: on an AppArmor host (Ubuntu 26.04) Docker's docker-default profile denied the nested
// bubblewrap sandbox trial tests start ("Failed to make / slave"), and apparmor=unconfined is denied a
// user namespace ("setting up uid map"). Install loads a dedicated unconfined profile with userns, trial
// containers run under it, doctor says when a nested sandbox still cannot start, and a trial whose
// nested sandbox is denied is a trial-host fault, never a verdict on the head or a base failure.

const slave = 'bwrap: Failed to make / slave: Permission denied';
const uidMap = 'bwrap: setting up uid map: Permission denied';

/** A host whose AppArmor answer is `enabled`, and a docker stub on PATH: create refuses the trial profile until the stub apparmor_parser loaded it; start prints STUB_SANDBOX_ERROR. */
async function host(enabled: boolean) {
  const root = await temporaryDirectory('trial-apparmor', tmpdir());
  const bin = join(root, 'bin'), log = join(root, 'docker.log'), loaded = join(root, 'loaded');
  await mkdir(bin);
  await writeFile(join(root, 'enabled'), enabled ? 'Y\n' : 'N\n');
  await writeFile(join(bin, 'docker'), `#!/bin/sh
echo "$*" >> '${log}'
case " $* " in
  *" create "*) case " $* " in *apparmor=graphyard-trial*) [ -f '${loaded}' ] || { echo "docker: Error response from daemon: AppArmor enabled on system but the graphyard-trial profile could not be loaded." >&2; exit 125; } ;; esac ;;
  *" start "*) [ -n "$STUB_SANDBOX_ERROR" ] && { echo "$STUB_SANDBOX_ERROR" >&2; exit 1; } ;;
esac
exit 0
`);
  await writeFile(join(bin, 'apparmor_parser'), `#!/bin/sh\necho "$*" >> '${log}.parser'\ntouch '${loaded}'\n`);
  await chmod(join(bin, 'docker'), 0o755); await chmod(join(bin, 'apparmor_parser'), 0o755);
  process.env.GRAPHYARD_APPARMOR_ENABLED_FILE = join(root, 'enabled');
  process.env.PATH = `${bin}:${process.env.PATH!.split(':').filter(entry => entry !== bin).join(':')}`;
  return { root, log, loaded, createArgs: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(line => / create /.test(line)) };
}

/** A transport that runs sudo's command from PATH, recording each command and its input. */
const stubTransport = (calls: { program: string; args: string[]; input?: string }[]) => ({ transport: {
  description: 'stub', putFile: async () => {},
  exec: async (program: string, args: string[], options: { input?: string } = {}) => {
    calls.push({ program, args, input: options.input });
    const [command, ...rest] = program === 'sudo' ? args.filter(arg => arg !== '-n') : [program, ...args];
    if (command === 'tee') return { stdout: '', stderr: '', code: 0 };
    execFileSync(command!, rest, { env: process.env });
    return { stdout: '', stderr: '', code: 0 };
  },
} } as unknown as AdapterContext);

test('e2e:trial-container-apparmor — on an AppArmor host install plans and loads the dedicated trial profile and trial containers run under it; without AppArmor neither happens', async () => {
  const apparmor = await host(true);
  const [action] = trialAppArmorPlan();
  assert.equal(action?.id, 'provider.trial-apparmor');
  assert.match(action!.command!, /profile graphyard-trial flags=\(unconfined\) \{\s+userns,\s+\}/);
  assert.match(action!.command!, new RegExp(`sudo apparmor_parser -r -W ${trialAppArmorProfilePath}`));
  const calls: { program: string; args: string[]; input?: string }[] = [];
  await provisionTrialAppArmor(stubTransport(calls), true, () => null);
  assert.deepEqual(calls.map(call => [call.program, ...call.args].join(' ')), [`sudo -n tee ${trialAppArmorProfilePath}`, `sudo -n apparmor_parser -r -W ${trialAppArmorProfilePath}`]);
  const written = calls[0]!.input!;
  const rerun: typeof calls = [];
  await provisionTrialAppArmor(stubTransport(rerun), true, () => written);
  assert.deepEqual(rerun, [], 'a profile already written with this text is not written or loaded again, so no sudo is needed');
  await provisionTrialAppArmor(stubTransport(rerun), true, () => `${written}# edited\n`);
  assert.equal(rerun.length, 2, 'a profile with other text is written and loaded again');
  assert.match(calls[0]!.input!, /flags=\(unconfined\)/); assert.match(calls[0]!.input!, /^\s+userns,$/m);
  assert.ok(existsSync(apparmor.loaded), 'the stub apparmor_parser loaded the profile');

  const [command, ...args] = trialContainerLaunch({ image: 'graphyard-trial:local', mounts: [], network: 'none' });
  execFileSync(command!, [...args, 'true'], { cwd: '/', env: process.env });
  const [created] = await apparmor.createArgs();
  assert.match(created!, /--security-opt=apparmor=graphyard-trial /);
  assert.doesNotMatch(created!, /apparmor=unconfined/);

  const plain = await host(false);
  assert.deepEqual(trialAppArmorPlan(), []);
  calls.length = 0;
  await provisionTrialAppArmor(stubTransport(calls));
  assert.deepEqual(calls, [], 'nothing is loaded without AppArmor');
  const [again, ...rest] = trialContainerLaunch({ image: 'graphyard-trial:local', mounts: [], network: 'none' });
  execFileSync(again!, [...rest, 'true'], { cwd: '/', env: process.env });
  const [createdPlain] = await plain.createArgs();
  assert.ok(createdPlain, 'the trial container was created');
  assert.doesNotMatch(createdPlain!, /--security-opt=apparmor/);
});

const doctorLines = async (root: string) => (await setupFromZeroChecks({ root, status: null, environments: root, sandbox: () => null, loopCode: null, systemctl: () => '', platform: 'darwin' }))
  .filter(check => check.id === 'trial-apparmor').map(setupLine);

test('e2e:trial-container-apparmor — doctor prints a FAIL line naming AppArmor and the fix when the profile is not loaded or the nested sandbox is denied, PASS when it starts', async () => {
  const apparmor = await host(true);
  const [notLoaded] = await doctorLines(apparmor.root);
  assert.match(notLoaded!, /^FAIL trial-apparmor: AppArmor .*graphyard-trial profile could not be loaded.*\(fix: rerun graphyard up, which writes the graphyard-trial AppArmor profile .*apparmor_parser -r -W/);
  await writeFile(apparmor.loaded, '');
  for (const denied of [slave, uidMap]) {
    process.env.STUB_SANDBOX_ERROR = denied;
    try {
      const [line] = await doctorLines(apparmor.root);
      assert.ok(line!.startsWith('FAIL trial-apparmor: AppArmor denies a nested sandbox'), line);
      assert.ok(line!.includes(denied), line);
      assert.match(line!, /\(fix: rerun graphyard up/);
    } finally { delete process.env.STUB_SANDBOX_ERROR; }
  }
  assert.deepEqual(await doctorLines(apparmor.root), ['PASS trial-apparmor: merge-trial containers start nested sandboxes under the graphyard-trial AppArmor profile']);
  const plain = await host(false);
  assert.deepEqual(await doctorLines(plain.root), [], 'no AppArmor, no line');
});

const identity = {
  GIT_AUTHOR_NAME: 'Someone', GIT_AUTHOR_EMAIL: 'someone@example.com',
  GIT_COMMITTER_NAME: 'Someone', GIT_COMMITTER_EMAIL: 'someone@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const write = async (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), content); }
};
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker', role: 'worker' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator' };
const config = (repository: string) => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
  repository, baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-game', workers: [], upstream: { url: 'https://upstream.example', credentialFile: '/outside/upstream.token' } });

test('e2e:trial-container-apparmor — a trial whose nested sandbox AppArmor denies is a trial-host fault: no verdict on the head, no base failure, reported upstream once', { timeout: 300_000 }, async () => {
  const root = await temporaryDirectory('trial-apparmor-fault', tmpdir());
  git(root, 'init', '-q', '-b', 'main');
  await write(root, { 'package.json': JSON.stringify({ name: 'site', private: true, scripts: { build: 'node build.mjs', test: 'node -e 0' } }), 'build.mjs': 'console.log("built");\n',
    'e2e/cases/fixture.json': JSON.stringify({ id: 'fixture', title: 'Fixture', target: 'any', required: false, steps: [{ kind: 'command', name: 'builds', run: 'node --eval 0' }] }) });
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'graphyard/gy-1-1');
  // The head's build starts a nested sandbox, which the trial host's AppArmor denies.
  await write(root, { 'build.mjs': `console.error(${JSON.stringify(slave)});\nprocess.exit(1);\n` });
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'sandbox');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '--detach', base);
  let attempts = 0;
  const trials: Parameters<MergePorts['record']>[1][] = [];
  let store: Store | undefined, http: ReturnType<typeof server> | undefined;
  try {
    store = await withDatabase('trial-apparmor-fault'); await store.init();
    const engine = new Engine(store, 120, 'owner/proofs');
    engine.gitRunner = gitRunnerFor(root); engine.baseBranch = 'main';
    const token = 'fixture-coordinator-' + 'x'.repeat(32);
    http = server(engine, [{ ...coordinator, token }]);
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    let work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'sandbox', criteria: [{ id: 'AC-1', text: 'Builds', proofs: ['unit:builds', 'e2e:fixture'] }] }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'fixture', path: root, branch: 'graphyard/gy-1-1' }, randomUUID());
    work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, head }, randomUUID());
    const ports: MergePorts = {
      baseBranch: 'main', now: Date.now,
      fetch: async () => base,
      merge: async headSha => {
        const merged = await trialMerge(async args => git(root, ...args), { head: headSha, baseTip: base });
        assert.ok('mergeSha' in merged);
        return { mergeSha: merged.mergeSha, files: ['build.mjs'] };
      },
      // The trial's children run here directly, not in the trial container.
      trial: async mergeSha => runTrial({ root, base: await temporaryDirectory('trial-apparmor-root', tmpdir()), mergeSha, baseTip: base, changedFiles: ['build.mjs'],
        timeoutMs: 120_000, environment: { PATH: process.env.PATH! }, run: (command, args, { wrapper: _wrapper, ...options } = {}) => defaultChildRun(command, args, options), onAttempt: () => { attempts++; } }) as never,
      push: async () => { throw new Error('a trial-host fault never pushes'); },
      holds: async () => false,
      record: async (item, event) => {
        if (event.kind === 'trial') trials.push(event);
        const answer = await fetch(`${url}/api/work/${item.id}/merge-record`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(event) });
        assert.equal(answer.status, 200, await answer.text());
      },
    };
    const failed = await mergeOne(ports, work).then(() => null, (error: unknown) => error);
    assert.ok(failed instanceof TrialSandboxFaultError, `a trial-host fault, not a red verdict: ${String(failed)}`);
    assert.ok(trialSandboxFault(new Error(failed.message)), 'the fault survives the detached run\'s process boundary as its message');
    assert.match(failed.message, /AppArmor.*rerun graphyard up/);
    assert.equal(attempts, 1, 'the trial is not retried');
    const recorded = trials.at(-1) as { outcome?: string; reason?: string } | undefined;
    assert.equal(recorded?.outcome, 'host-failure', 'the trial records no verdict on the head');
    assert.match(recorded?.reason ?? '', /^Trial-host fault: a nested sandbox could not start/);
    assert.ok(!trials.some(event => JSON.stringify(event).includes(baseFailurePrefix)), 'no base failure');
    const current: Work = (await store.workDocument(work.id))!;
    assert.equal(current.reworkRequested, false);
    assert.equal(trialRefusalHeld(current.candidate, current.mergeLedger), null, 'the head is not refused');
    assert.notEqual(current.mergeLedger?.state, 'refused');
  } finally {
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    if (store) await store.close();
  }

  const filed: string[] = [];
  const cycle = { state: emptyDaemonState(config('owner/game')), effects: { fileUpstream: async (_input: unknown, key: string) => { filed.push(key); return { key: 'GY-900' }; } } as unknown as DaemonEffects, clock: Date.now(), log: () => {}, config: config('owner/game') };
  for (let round = 0; round < 3; round++) await reportTrialSandboxFault(cycle);
  assert.deepEqual(filed, ['trial-sandbox-fault:owner/game'], 'filed upstream once');
});
