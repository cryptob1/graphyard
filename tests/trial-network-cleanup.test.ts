import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { runTrial, trialMerge, TrialCancelledError, TrialNetworkPoolError, trialNetworkPoolFault } from '../src/merge-writer/trial.js';
import { mergeOne, type MergePorts } from '../src/merge-writer/executor.js';
import { trialRefusalHeld } from '../src/model/merge-queue.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { reclaimJobLeftovers } from '../src/daemon/disk-headroom.js';
import { reportTrialNetworkFault } from '../src/daemon/control-plane.js';
import { startCheckServices, type Docker } from '../src/compose-preview.js';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master.js';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';

// GY-3316: trials leaked their preview Docker networks until Docker refused new ones ("all predefined
// address pools have been fully subnetted") and every later trial failed — returned for rework
// through no fault of its head. The Docker CLI is a stub on PATH keeping its networks in a file.

interface StubNetwork { project: string | null; containers: number }
interface StubState { networks: Record<string, StubNetwork>; poolsSpent: boolean }

async function stubDocker() {
  const directory = await temporaryDirectory('trial-network-docker', tmpdir()), state = join(directory, 'state.json');
  writeFileSync(state, JSON.stringify({ networks: {}, poolsSpent: false }));
  writeFileSync(join(directory, 'docker'), `#!${process.execPath}
const fs = require('node:fs'), file = ${JSON.stringify(state)}, args = process.argv.slice(2);
const s = JSON.parse(fs.readFileSync(file, 'utf8')), save = () => fs.writeFileSync(file, JSON.stringify(s));
const filters = args.flatMap((arg, i) => arg === '--filter' ? [args[i + 1]] : []);
const project = args.includes('-p') ? args[args.indexOf('-p') + 1] : null;
if (args[0] === 'compose') {
  if (args.includes('config')) { console.log(JSON.stringify({ name: project, services: { db: { image: 'postgres:17' } } })); process.exit(0); }
  if (args.includes('create')) {
    if (s.poolsSpent) { console.error('failed to create network ' + project + '_default: Error response from daemon: all predefined address pools have been fully subnetted'); process.exit(1); }
    s.networks[project + '_default'] = { project, containers: 1 }; save(); process.exit(0);
  }
  if (args.includes('down')) { for (const [name, n] of Object.entries(s.networks)) if (n.project === project) delete s.networks[name]; save(); }
  process.exit(0);
}
if (args[0] === 'ps') {
  const service = filters.find(f => f.startsWith('label=com.docker.compose.service='));
  const owner = filters.find(f => f.startsWith('label=com.docker.compose.project='))?.split('=').pop();
  if (service && Object.values(s.networks).some(n => n.project === owner)) console.log('abcdef1234567890');
  process.exit(0);
}
if (args[0] === 'network' && args[1] === 'ls') {
  let names = Object.keys(s.networks);
  for (const f of filters) {
    if (f.startsWith('name=')) names = names.filter(name => name.includes(f.slice(5)));
    else if (f.startsWith('label=com.docker.compose.project=')) names = names.filter(name => s.networks[name].project === f.split('=').pop());
    else names = [];
  }
  if (names.length) console.log(names.join('\\n'));
  process.exit(0);
}
if (args[0] === 'network' && args[1] === 'inspect') {
  console.log(args.slice(4).map(name => name + '\\t' + s.networks[name].containers).join('\\n')); process.exit(0);
}
if (args[0] === 'network' && args[1] === 'rm') {
  for (const name of args.slice(2)) { if (s.networks[name].containers) { console.error('network ' + name + ' has active endpoints'); process.exit(1); } delete s.networks[name]; }
  save(); process.exit(0);
}
process.exit(0);
`);
  chmodSync(join(directory, 'docker'), 0o755);
  const read = (): StubState => JSON.parse(readFileSync(state, 'utf8'));
  // The trial's services reach it as their Docker port (the trial's PATH puts node's own directory first, where a real docker may be); the sweep through PATH.
  const docker: Docker = (args, options) => new Promise((accept, refuse) => execFile(join(directory, 'docker'), args, { timeout: options.timeoutMs }, (error, stdout, stderr) =>
    error ? refuse(new Error(`docker ${args.slice(0, 2).join(' ')} failed: ${String(stderr).trim()}`)) : accept(String(stdout))));
  return { path: `${directory}:${process.env.PATH}`, docker, read, write: (next: StubState) => writeFileSync(state, JSON.stringify(next)) };
}

const identity = { GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: { ...process.env, ...identity } }).trim();
const files = {
  'graphyard.json': JSON.stringify({ delivery: { mergeGate: { perCandidate: [], preMerge: [{ check: 'db', command: 'node query.mjs', source: 'script', reason: 'fixture', services: [{ file: 'compose.yml', service: 'db', port: 5432 }] }] } } }),
  'compose.yml': 'services:\n  db:\n    image: postgres:17\n',
  'e2e/cases/fixture.json': JSON.stringify({ id: 'fixture', title: 'Fixture', target: 'any', required: false, steps: [{ kind: 'command', name: 'runs', run: 'node --eval 0' }] }),
};
async function repository() {
  const root = await temporaryDirectory('trial-network-repo', tmpdir());
  git(root, 'init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); }
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'base');
  return root;
}

/** The check's children are faked (git runs for real); the services' Compose stack runs against the stubbed Docker CLI. */
const checkRun = (outcome: 'pass' | 'fail' | 'cancel', controller?: AbortController): ChildRun => async (command, args, options = {}) => {
  if (command === 'git') return defaultChildRun(command, args, options);
  if (args[0] === '-e') return 'accepts TCP connections';
  if (outcome === 'fail') throw Object.assign(new Error('check failed'), { status: 1, stdout: 'relation does not exist', stderr: '' });
  if (outcome === 'cancel') { controller!.abort(new TrialCancelledError('the head was replaced')); throw controller!.signal.reason; }
  return 'ok';
};
const stubbed = (docker: Awaited<ReturnType<typeof stubDocker>>): typeof startCheckServices => request => startCheckServices({ ...request, docker: docker.docker });
const trial = async (root: string, docker: Awaited<ReturnType<typeof stubDocker>>, run: ChildRun, signal?: AbortSignal) => runTrial({
  root, base: await temporaryDirectory('trial-network-base', tmpdir()), mergeSha: git(root, 'rev-parse', 'HEAD'), changedFiles: ['tests/a.test.ts'], timeoutMs: 60_000, key: 'GY-19',
  cores: 2, groupSize: 1, retries: 0, memory: async () => ({ totalBytes: 64 * 2 ** 30, availableBytes: 32 * 2 ** 30 }), environment: { PATH: docker.path }, run, services: stubbed(docker), ...(signal ? { signal } : {}) });
const trialNetworks = (state: StubState) => Object.keys(state.networks).filter(name => name.startsWith('graphyard-preview-trial-'));

test('e2e:trial-network-cleanup — a trial removes the network its services created when it passes, when it fails and when it is cancelled', { timeout: 120_000 }, async () => {
  const docker = await stubDocker(), root = await repository();
  const created: string[] = [];
  const watch = (run: ChildRun): ChildRun => async (command, args, options) => {
    if (args[0] === '-e') created.push(...trialNetworks(docker.read()));
    return run(command, args, options);
  };
  const passed = await trial(root, docker, watch(checkRun('pass')));
  assert.deepEqual(passed.tests.failed, [], passed.logTail);
  const failed = await trial(root, docker, watch(checkRun('fail')));
  assert.deepEqual(failed.tests.failed, ['db']);
  const controller = new AbortController();
  // The loop drops a cancelled trial's answer at once (cycle-merge-writer `cancellableTrials`); what matters is what it leaves.
  await trial(root, docker, watch(checkRun('cancel', controller)), controller.signal).catch(() => null);
  assert.ok(controller.signal.aborted, 'the third trial was cancelled mid-check');
  assert.equal(created.length, 3, `each trial created its services' network: ${created.join(', ')}`);
  assert.ok(created.every(name => /^graphyard-preview-trial-services-gy-19-[0-9a-f]{8}_default$/.test(name)), created.join(', '));
  assert.deepEqual(trialNetworks(docker.read()), [], 'no trial network outlives its trial');
});

test('e2e:trial-network-cleanup — the leftovers sweep removes a preview-trial network no container uses, keeps one a running container uses, and the leftovers report counts the removed', { timeout: 60_000 }, async () => {
  const docker = await stubDocker();
  docker.write({ poolsSpent: false, networks: {
    'graphyard-preview-trial-services-gy-19-45301c6f_default': { project: 'graphyard-preview-trial-services-gy-19-45301c6f', containers: 0 },
    'graphyard-preview-trial-e2e-web-0a1b2c3d_default': { project: 'graphyard-preview-trial-e2e-web-0a1b2c3d', containers: 1 },
    'hello-huck_default': { project: 'hello-huck', containers: 0 },
  } });
  const run: ChildRun = (command, args, options = {}) => defaultChildRun(command, args, { ...options, env: { ...process.env, PATH: docker.path } });
  const removed = await reclaimJobLeftovers(run, { temporary: [], checkouts: [], verification: [] });
  assert.deepEqual(removed, ['network graphyard-preview-trial-services-gy-19-45301c6f_default']);
  assert.deepEqual(Object.keys(docker.read().networks).sort(), ['graphyard-preview-trial-e2e-web-0a1b2c3d_default', 'hello-huck_default'], 'a network in use and one not Graphyard\'s stay');

  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/project', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [] });
  let clock = Date.parse('2030-04-01T23:55:00Z'), swept = false;
  const effects: DaemonEffects = {
    snapshot: async () => ({ work: [], now: new Date(clock).toISOString() }),
    agents: () => [], credentials: async () => ({}), closeSession: () => {}, dispatch: async () => {}, persist: async () => {}, dispatchTick: async () => {}, recordSession: async () => {},
    // One sweep removes them; the next finds nothing left.
    reclaimJobLeftovers: async () => swept ? [] : (swept = true, [...removed, 'container graphyard-trial-a']),
    leftoverDisk: async () => ({ trialRuns: null, worktrees: null, trialCheckouts: null, trialImages: null, buildCache: null }),
  };
  const state = emptyDaemonState(config);
  await runCycle(config, state, effects, Date.now, undefined, () => {});
  clock += 10 * 60_000;
  await runCycle(config, state, effects, Date.now, undefined, () => {});
  assert.equal(state.leftovers.report?.day, '2030-04-01');
  assert.equal(state.leftovers.report?.counts.networks, 1, 'the report counts the removed network');
  assert.equal(state.leftovers.report?.counts.reclaimed, 1, 'the container is counted as before');
});

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'worker', role: 'worker' };
const coordinator: Principal = { id: 'coordinator', role: 'coordinator' };

test('e2e:trial-network-cleanup — a trial whose network Docker refuses for spent address pools records a trial-host fault naming the preview networks; the head stays queued, not reworked', { timeout: 300_000 }, async () => {
  const docker = await stubDocker();
  docker.write({ poolsSpent: true, networks: Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`graphyard-preview-trial-services-gy-${index}-0000000${index % 10}_default`, { project: null, containers: 0 }])) });
  const root = await repository();
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '-b', 'graphyard/gy-1-1');
  writeFileSync(join(root, 'query.mjs'), 'console.log("ok");\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'query');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-q', '--detach', base);
  const trials: Parameters<MergePorts['record']>[1][] = [];
  let store: Store | undefined, http: ReturnType<typeof server> | undefined;
  try {
    store = await withDatabase('trial-network-cleanup'); await store.init();
    const engine = new Engine(store, 120, 'owner/proofs');
    engine.gitRunner = gitRunnerFor(root); engine.baseBranch = 'main';
    const token = 'fixture-coordinator-' + 'x'.repeat(32);
    http = server(engine, [{ ...coordinator, token }]);
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    let work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'query', criteria: [{ id: 'AC-1', text: 'Queries', proofs: ['unit:queries', 'e2e:fixture'] }] }, randomUUID());
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
        return { mergeSha: merged.mergeSha, files: ['query.mjs'] };
      },
      trial: async mergeSha => runTrial({ root, base: await temporaryDirectory('trial-network-pool-root', tmpdir()), mergeSha, baseTip: base, changedFiles: ['query.mjs'], key: 'GY-19',
        timeoutMs: 60_000, environment: { PATH: docker.path }, run: checkRun('pass'), services: stubbed(docker) }) as never,
      push: async () => { throw new Error('a trial-host fault never pushes'); },
      holds: async () => false,
      record: async (item, event) => {
        if (event.kind === 'trial') trials.push(event);
        const answer = await fetch(`${url}/api/work/${item.id}/merge-record`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(event) });
        assert.equal(answer.status, 200, await answer.text());
      },
    };
    const failed = await mergeOne(ports, work).then(() => null, (error: unknown) => error);
    assert.ok(failed instanceof TrialNetworkPoolError, `a trial-host fault, not a red verdict: ${String(failed)}`);
    assert.equal(trialNetworkPoolFault(failed), '30', 'the fault names the preview networks on the host');
    assert.equal(trialNetworkPoolFault(new Error(failed.message)), '30', 'the count survives the detached run\'s process boundary as its message');
    const recorded = trials.at(-1) as { outcome?: string; reason?: string } | undefined;
    assert.equal(recorded?.outcome, 'host-failure', 'the trial records no verdict on the head');
    assert.match(recorded?.reason ?? '', /^Trial-host fault: Docker could not create the trial's network \(all predefined address pools have been fully subnetted\)/);
    const current: Work = (await store.workDocument(work.id))!;
    assert.equal(current.reworkRequested, false, 'no new head is asked for');
    assert.equal(trialRefusalHeld(current.candidate, current.mergeLedger), null, 'the head is not refused as a failed trial');
    assert.notEqual(current.mergeLedger?.state, 'refused');
    assert.equal(current.blocker, null, 'nothing parks the item');
  } finally {
    if (http) await new Promise<void>(resolve => http!.close(() => resolve()));
    if (store) await store.close();
  }

  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: 'owner/hwd-backend', baseBranch: 'main', hostId: 'machine-a', masterAgentName: 'graphyard-master-hwd', workers: [] });
  const lines: string[] = [];
  const cycle = { state: emptyDaemonState(config), effects: {} as DaemonEffects, clock: Date.now(), log: (line: string) => lines.push(line), config };
  for (let pass = 0; pass < 3; pass++) await reportTrialNetworkFault(cycle, '30');
  const attention = lines.filter(line => /attention failed: Graphyard fault: merge trials cannot create a Docker network/.test(line));
  assert.equal(attention.length, 1, 'one attention line across cycles');
  assert.match(attention[0]!, /30 Graphyard preview networks/, 'it names the leaked network count');
});
