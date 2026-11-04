import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { expandTypedCommand, startedAtOnce } from './helpers/launch-shell.js';
import { credentialMaskFor } from '../src/master/confinement.js';
import { launcherCoordinatorRoot, startAgentSession } from '../src/master/launch.js';
import { runConfinement } from '../src/runner/roles.js';

test('integration:hard-math-smoke — non-CLI native launch denies oracle and authority while retaining only assigned credentials', async () => {
  const base = await temporaryDirectory('hard-math-native-confinement');
  const root = join(base, 'repository'), worktree = join(base, 'assigned');
  const install = join(base, 'install'), oracle = join(base, 'oracle'), source = join(base, 'source-install');
  await mkdir(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed', '--allow-empty');
  git('worktree', 'add', '-qb', 'assigned', worktree);
  const coordinator = join(install, 'coordinator.token'), producer = join(install, 'producer.token');
  const worker = join(install, 'worker.token'), reviewer = join(install, 'reviewer', 'verdict.token');
  const oracleFile = join(oracle, 'verify.py'), sourceCredential = join(source, 'coordinator.token');
  for (const path of [coordinator, producer, worker, reviewer, oracleFile, sourceCredential]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture-only\n', { mode: 0o600 });
  }
  const config = { credentialFile: coordinator, confinement: { maskPaths: [install, oracle, source] } };
  const argv1 = process.argv[1];
  process.argv[1] = resolve('benchmarks/hard-math/runner.ts');
  try {
    assert.equal(launcherCoordinatorRoot(process.argv[1], false), null, 'documented entry cannot infer the root');
    for (const role of ['worker', 'reviewer'] as const) {
      const own = role === 'worker' ? worker : reviewer;
      const mask = credentialMaskFor(config, { credentialFile: own }, join(base, 'config-home'));
      let typed = '';
      await startAgentSession(`benchmark-${role}`, 'pi', 'pane', [], 'Boundary probe', (_command, args) => {
        if (args[0] === 'pane' && args[1] === 'run') typed = args[3];
        return startedAtOnce(args) ?? '';
      }, { directory: worktree, coordinatorRoot: root, credentialMask: mask, secretsBus: null, log: () => {}, keyringWarning: async () => null });
      const words = expandTypedCommand(typed).words;
      const end = words.indexOf('--');
      assert.ok(end > 0 && words[0].endsWith('bwrap'), 'native session launch actually carries the wrapper');
      check([...words.slice(0, end + 1)], own, role === 'worker' ? reviewer : worker);
    }
    // Headless producers use the same explicit-root path, keeping their own token only.
    const wrapper = runConfinement({ coordinatorRoot: root, credentialMask: credentialMaskFor(config, { credentialFile: producer }, join(base, 'config-home')) });
    assert.ok(wrapper);
    check([...wrapper(worktree, process.env)], producer, worker);
  } finally { process.argv[1] = argv1; }

  function check(wrapper: string[], own: string, other: string) {
    const script = 'for path do if test -r "$path"; then echo readable; else echo denied; fi; done';
    const result = spawnSync(wrapper[0], [...wrapper.slice(1), '/bin/sh', '-c', script, 'probe', coordinator, oracleFile, sourceCredential, other, own], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'denied\ndenied\ndenied\ndenied\nreadable\n');
    if (own !== producer) {
      const denied = spawnSync(wrapper[0], [...wrapper.slice(1), '/bin/sh', '-c', 'test ! -r "$1"', 'probe', producer], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(denied.status, 0, denied.stderr);
    }
  }
});

// Exercise the embedded daemon's production dispatch chain. Only external services
// (CLI claim replies, registry HTTP and Herdr transport) are controlled; dispatch,
// credential selection, review binding, confinement and filesystem probes are real.
test('integration:hard-math-smoke — embedded daemon worker and review dispatch enforce the native read boundary', async t => {
  const { daemonEffects } = await import('../src/daemon/effects-production.js');
  const { setupMaster, loadMasterConfig, saveWorkerProfile } = await import('../src/master.js');
  const { saveReviewerProfile, readReviewLedger } = await import('../src/reviewer.js');
  const { requested } = await import('./helpers/review-fleet.js');
  const { emptyRegistry } = await import('../src/model/registry.js');
  const { readFile } = await import('node:fs/promises');
  const base = await temporaryDirectory('hard-math-embedded', process.cwd());
  const root = join(base, 'repository'), assigned = join(base, 'assigned');
  const install = join(base, 'install'), oracle = join(base, 'oracle'), source = join(base, 'source-install');
  await mkdir(root);
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'seed', '--allow-empty');
  const head = git('rev-parse', 'HEAD');
  git('worktree', 'add', '-qb', 'assigned', assigned);
  // A recognized origin, served by this local repository: no network Git access.
  git('remote', 'add', 'origin', 'git@github.com:fixture/confinement.git');
  const ssh = join(base, 'fixture-ssh.sh');
  await writeFile(ssh, `#!/bin/sh\nexec git-upload-pack '${root}'\n`, { mode: 0o700 });
  git('config', 'core.sshCommand', ssh);
  const worker = join(install, 'worker.token'), producer = join(install, 'producer.token');
  const oracleFile = join(oracle, 'verify.py'), sourceCredential = join(source, 'coordinator.token');
  for (const path of [worker, producer, oracleFile, sourceCredential]) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'fixture-only-token-'.padEnd(40, 'x'), { mode: 0o600 });
  }
  const item = requested(1);
  Object.assign(item, { stage: 'ready', candidate: null, submission: null, observation: null, epoch: 0, workspaces: [], autoDispatch: undefined,
    specCheck: { policyRevision: 1, verdict: 'ready', paraphrase: 'Fixture', gaps: [], reviewer: 'spec', at: new Date().toISOString() } });
  const cli = join(base, 'fixture-cli.mjs');
  await writeFile(cli, `const command = process.argv[2];
const claim = ${JSON.stringify({ ...item, epoch: 1, lease: { owner: 'fixture-worker', epoch: 1, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } })};
if (command === 'claim') console.log(JSON.stringify(claim));
else if (command === 'worktree') console.log(JSON.stringify(${JSON.stringify({ path: assigned, branch: 'assigned' })}));
else if (['heartbeat', 'unclaim'].includes(command)) console.log('{}');
else throw new Error('Unexpected fixture CLI call: ' + command);
`);
  await setupMaster(root, { url: 'https://confinement.example', token: 'fixture-coordinator-'.padEnd(40, 'x'), cliPath: cli, credentialDirectory: install,
    run: { worktreeRoot: join(base, 'checkouts') } }, async () => Response.json({ actor: { id: 'fixture-coordinator', role: 'coordinator' }, repository: 'fixture/confinement', baseBranch: 'main' }));
  await saveWorkerProfile(root, { name: 'worker', principal: 'fixture-worker', agentName: 'fixture-worker', mode: 'launch', kind: 'pi', credentialFile: worker }, async () => ({ actor: { id: 'fixture-worker', role: 'worker' } }));
  await saveReviewerProfile(root, { name: 'reviewer', agentName: 'fixture-reviewer', kind: 'pi' });
  const config = await loadMasterConfig(root);
  config.confinement = { maskPaths: [install, oracle, source] };
  config.run.reviewerProfile = 'reviewer';
  await writeFile(join(root, '.graphyard/master.json'), JSON.stringify(config));
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/agent-registry/document')) return Response.json(emptyRegistry());
    if (url.endsWith('/review-launch')) return Response.json({ launch: 'fixture-review-launch' });
    throw new Error(`Unexpected fixture HTTP request: ${url}`);
  });
  const typed: string[] = [];
  let reviewDirectory = '';
  let readinessPolls = 0;
  const run = (command: string, args: string[]) => {
    if (command !== 'herdr') return execFileSync(command, args, { encoding: 'utf8' });
    if (args[0] === 'tab' && args[1] === 'create') {
      reviewDirectory = args.find(word => word.startsWith('GH_CONFIG_DIR='))?.slice('GH_CONFIG_DIR='.length) ?? reviewDirectory;
      return JSON.stringify({ result: { root_pane: { pane_id: 'fixture-pane', tab_id: 'fixture-tab' } } });
    }
    if (args[0] === 'pane' && args[1] === 'run') {
      typed.push(args[3]);
      readinessPolls = 0;
      return '';
    }
    // A supervised worker starts watch -> bwrap -> pi. Report the transport's
    // observed foreground, not the first program parsed from that nested argv.
    // Keep one wrapper poll so production readiness must wait for the runtime.
    if (args[0] === 'agent' && args[1] === 'get') {
      readinessPolls++;
      return JSON.stringify({ result: { agent: { agent: readinessPolls === 1 ? 'bwrap' : 'pi', agent_status: 'idle', pane_id: args[2] } } });
    }
    if (args[0] === 'pane' && args[1] === 'read') return readinessPolls <= 1 ? 'Starting runtime\n' : 'pi ready\n';
    if (args[0] === 'pane' && args[1] === 'process-info') return JSON.stringify({ result: { process_info: {
      shell_pid: 100, foreground_process_group_id: 200,
      foreground_processes: [{ argv: [readinessPolls <= 1 ? 'bwrap' : 'pi'] }],
    } } });
    if (args[0] === 'agent' && args[1] === 'rename') return JSON.stringify({ result: { agent: { agent: 'pi', agent_status: 'idle', name: args[3] } } });
    if (args[0] === 'agent' && args[1] === 'list') return JSON.stringify({ result: { agents: [] } });
    return startedAtOnce(args) ?? JSON.stringify({ result: {} });
  };
  const snapshot = () => Promise.resolve({ work: [item], now: new Date().toISOString() });
  const effects = daemonEffects(root, config, { coordinatorRoot: root, snapshot, run, mutate: async () => ({}) });
  const argv1 = process.argv[1];
  process.argv[1] = resolve('benchmarks/hard-math/runner.ts');
  try {
    await t.test('worker dispatch', async () => {
      await effects.dispatch(item, config.workers[0], [], await snapshot());
      assert.ok(readinessPolls >= 2, 'worker readiness must wait for pi after the wrapper');
      probe(typed.at(-1)!, worker, [producer, config.credentialFile, oracleFile, sourceCredential]);
    });
    await t.test('review dispatch tick', async () => {
      const review = requested(2);
      review.candidate!.sha = head; review.candidate!.baseSha = head;
      review.observation!.candidate.sha = head; review.observation!.candidate.baseSha = head;
      review.observation!.baseTip = head;
      Object.assign(review.autoDispatch!.review!, { sha: head, baseSha: head });
      const tick = await effects.dispatchTick!({ work: [review], now: new Date().toISOString() }) as import('../src/auto-dispatch.js').DispatchTick;
      assert.equal(tick.launched.length, 1, JSON.stringify(tick));
      assert.ok(readinessPolls >= 2, 'review readiness must wait for pi after the wrapper');
      const binding = join(reviewDirectory, 'review-binding.json');
      assert.ok(JSON.parse(await readFile(binding, 'utf8')).verdictToken);
      assert.equal((await readReviewLedger(root)).reviews[0].state, 'pending');
      probe(typed.at(-1)!, binding, [worker, producer, config.credentialFile, oracleFile, sourceCredential]);
    });
  } finally { process.argv[1] = argv1; }

  function probe(command: string, own: string, hidden: string[]) {
    const words = expandTypedCommand(command).words;
    const start = words.findIndex(word => word.endsWith('/bwrap') || word === 'bwrap');
    assert.ok(start >= 0, 'actual dispatch must carry confinement with non-CLI argv');
    const end = words.indexOf('--', start);
    assert.ok(end > start);
    const result = spawnSync(words[start], [...words.slice(start + 1, end + 1), '/bin/sh', '-c',
      'for path do if test -r "$path"; then echo readable; else echo denied; fi; done', 'probe', ...hidden, own], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'denied\n'.repeat(hidden.length) + 'readable\n');
  }
});
