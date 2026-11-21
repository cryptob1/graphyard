import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { defaultChildRun, type ChildRun } from '../src/child-runner.js';
import { trialContainerLaunch } from '../src/merge-writer/trial-container.js';
import { trialFloorAttention, trialStartOrder, type TrialLoad } from '../src/merge-writer/trial-load.js';
import { runTrial, TrialHostFaultError, trialHostFaultPrefix, trialTemporaryRoot, trialTemporaryRootReport } from '../src/merge-writer/trial.js';
import { verificationStep } from '../src/merge-writer/worker-verification.js';
import { workerVerificationPump } from '../src/daemon/worker-verification.js';
import { requestWorkerVerification } from '../src/cli/worker-verification.js';
import { createContext } from '../src/cli/context.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { withDatabase } from './helpers/postgres.js';

// GY-3332: on rexera-remote /tmp is a 15.7 GB tmpfs, under the 30 GB disk floor. Every merge and gate
// trial made its scratch there, waited forever on the floor while holding its place in the queue,
// and every worker's `complete` yielded to it and hung with no output. Here the real admission
// launcher runs against stand-in docker and df: a volume's free space is the `.avail` file in it.
const proof = 'e2e:trial-admission-no-silent-starve';
const small = 15_700_000_000;

const fakeDocker = (log: string) => `#!/bin/sh
echo "$*" >> ${JSON.stringify(log)}
case "$3" in
  start) for name; do :; done; echo $$ > ${JSON.stringify(log)}."$name"; exec sleep 60 ;;
  rm) for name; do :; done; kill "$(cat ${JSON.stringify(log)}."$name")" 2>/dev/null; exit 0 ;;
esac
exit 0
`;
const fakeDf = `#!/bin/sh
for path; do :; done
echo Avail
if [ -f "$path/.avail" ]; then cat "$path/.avail"; else echo 100000000000; fi
`;

async function machine(label: string) {
  const base = await temporaryDirectory(label, process.cwd());
  const bin = join(base, 'bin'), log = join(base, 'docker.log'), slots = join(base, 'slots'), children: ChildProcess[] = [];
  await mkdir(bin); await mkdir(join(base, 'hwmon'));
  await writeFile(join(bin, 'docker'), fakeDocker(log)); await writeFile(join(bin, 'df'), fakeDf);
  await chmod(join(bin, 'docker'), 0o755); await chmod(join(bin, 'df'), 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin` };
  const load = (order: number, bounds: Partial<TrialLoad> = {}): TrialLoad => ({ slots, cap: 6, order, hotCelsius: 95, floorBytes: 30e9, hwmon: join(base, 'hwmon'),
    pressureBoundSeconds: 600, ...bounds });
  const volume = async (name: string, free?: number) => {
    const path = join(base, name);
    await mkdir(path, { recursive: true });
    if (free !== undefined) await writeFile(join(path, '.avail'), `${free}\n`);
    return path;
  };
  const words = (mounts: string[], spec: TrialLoad) => trialContainerLaunch({ image: 'graphyard-trial:local', mounts: mounts.map(path => [path, path, false]), network: 'none', load: spec });
  const launch = (mounts: string[], spec: TrialLoad) => {
    const [program, ...rest] = words(mounts, spec);
    const child = spawn(program!, [...rest, 'sleep', '600'], { cwd: base, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let said = '';
    child.stderr!.on('data', chunk => { said += chunk; });
    children.push(child);
    return { child, said: () => said, ended: new Promise<number | null>(resolve => child.once('close', resolve)) };
  };
  const docker = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n');
  const started = async () => (await docker()).filter(line => line.includes(' start ')).length;
  const until = async (condition: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
    for (let waited = 0; !(await condition()); waited += 50) {
      assert.ok(waited < ms, what);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const close = async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      const gone = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); await gone;
    }
  };
  return { base, env, slots, load, volume, words, launch, docker, started, until, close };
}

test(`${proof} — with a gate start waiting on the load check and every slot free, a verification start is admitted and runs`, async () => {
  const host = await machine('starve-order');
  try {
    const gate = host.launch([await host.volume('gate-tmp', small)], host.load(trialStartOrder.gate));
    await host.until(() => gate.said().includes('waiting: '), 'the gate start waits on the disk floor');
    assert.match(gate.said(), /is under the disk floor: 15\.7 GB free of the 30\.0 GB kept free/, 'the wait names the reading');
    host.launch([await host.volume('verify')], host.load(trialStartOrder.verification));
    await host.until(async () => await host.started() === 1, 'the verification start runs beside the waiting gate start');
    assert.ok(!gate.said().includes('starting'), 'the gate start still waits');
  } finally { await host.close(); }
});

test(`${proof} — a start whose load wait passes its bound fails as a trial-host fault naming the reading, with no verdict on its head`, { timeout: 120_000 }, async () => {
  const host = await machine('starve-bound');
  const root = await host.volume('repository'), short = await host.volume('short', small), durable = await host.volume('durable');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node -e 0' } }));
  git('add', '-A'); git('commit', '-q', '-m', 'base');
  const sha = git('rev-parse', 'HEAD');
  // The trial's own boundary is swapped for the real launcher on a volume under the floor, bound to two seconds.
  const said: string[] = [];
  const run: ChildRun = (command, args, { wrapper, ...options } = {}) => {
    if (!wrapper) return defaultChildRun(command, args, options);
    return defaultChildRun(command, args, { ...options, env: { ...options.env, PATH: `${host.env.PATH}:${options.env?.PATH ?? ''}` }, onStderr: chunk => said.push(chunk),
      wrapper: host.words([short], host.load(trialStartOrder.merge, { pressureBoundSeconds: 2 })) });
  };
  let attempts = 0;
  try {
    const failed = await runTrial({ root, base: await host.volume('sessions'), mergeSha: sha, baseTip: sha, changedFiles: ['package.json'], timeoutMs: 60_000,
      environment: { PATH: process.env.PATH! }, run, temporaryRoots: [durable], checkoutRoots: [], onAttempt: () => { attempts++; } }).then(() => null, (error: unknown) => error);
    assert.ok(failed instanceof TrialHostFaultError, `a trial-host fault, not a verdict: ${String(failed)}`);
    assert.ok(failed.message.startsWith(trialHostFaultPrefix), 'the merge writer reads it as a trial-host fault: the head stays queued, never refused');
    assert.match(failed.message, /waited \d+s to start and gave up: .*short is under the disk floor: 15\.7 GB free/);
    assert.equal(attempts, 1, 'a host fault is not retried');
    assert.equal(await host.started(), 0, 'nothing reached Docker');
    assert.match(said.join(''), /waiting: .*under the disk floor/);
  } finally { await host.close(); }
});

test(`${proof} — a verification start that must wait prints the reason through verify's output within seconds and keeps waiting its turn (GY-3390)`, { timeout: 120_000 }, async t => {
  const host = await machine('starve-complete');
  const store = await withDatabase('starve-complete');
  await store.init(); t.after(() => store.close());
  const root = await host.volume('worktree');
  const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  git('init', '-q'); git('commit', '-q', '--allow-empty', '-m', 'fixture'); git('branch', 'graphyard/test');
  const engine = new Engine(store, 600, 'owner/project'); engine.gitRunner = null;
  const operator = { id: 'operator', role: 'admin' as const, sessionKind: 'human' as const };
  const worker = { id: 'worker', role: 'worker' as const, token: 'worker-' + 'w'.repeat(32) };
  const coordinator = { id: 'host', role: 'coordinator' as const, token: 'host-' + 'h'.repeat(32) };
  engine.principals = [operator, worker, coordinator];
  let work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Waits', criteria: [{ id: 'AC-1', text: 'Says why', proofs: ['unit:waits', 'e2e:fixture'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'test', path: root, branch: 'graphyard/test' }, randomUUID());
  const http = server(engine, [worker, coordinator]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); return new Promise<void>(resolve => http.close(() => resolve())); });
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const mutate = async (path: string, body: unknown) => (await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${coordinator.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  // One slot on this machine, held by a running merge trial: the verification start must wait for it.
  const occupant = host.launch([await host.volume('merge')], host.load(trialStartOrder.merge, { cap: 1 }));
  await host.until(async () => await host.started() === 1, 'the merge trial holds the only slot');
  const allocation = await host.volume('verify');
  let taken = false;
  const pump = workerVerificationPump(root, () => 'test', mutate, () => 'main', undefined, async (_root, _work, _input, _base, _parent, progress) => {
    taken = true;
    await verificationStep('true', [], { env: host.env, timeoutMs: 8_000, wrapper: host.words([allocation], host.load(trialStartOrder.verification, { cap: 1, pressureBoundSeconds: 2 })) }, progress!);
    throw new Error('the start never ran');
  });
  const shown: { at: number; line: string }[] = [];
  t.mock.method(console, 'error', (line: unknown) => { shown.push({ at: Date.now(), line: String(line) }); });
  const saved = { url: process.env.GRAPHYARD_URL, token: process.env.GRAPHYARD_TOKEN, file: process.env.GRAPHYARD_TOKEN_FILE };
  process.env.GRAPHYARD_URL = url; process.env.GRAPHYARD_TOKEN = worker.token; delete process.env.GRAPHYARD_TOKEN_FILE;
  try {
    const context = await createContext('verify', work.key, [], false);
    context.repositoryRoot = () => root;
    const at = Date.now();
    const answer = requestWorkerVerification(context, work, { mode: 'verify', epoch: 1 }).then(() => null, (error: unknown) => error);
    for (let tries = 0; tries < 100 && !taken; tries++) { await pump(); if (!taken) await new Promise(resolve => setTimeout(resolve, 50)); }
    await host.until(() => shown.some(entry => entry.line.includes('waiting: the machine-wide cap of 1 trial containers is reached')), 'verify prints why the start waits', 10_000);
    const waiting = shown.find(entry => entry.line.includes('waiting: '))!;
    assert.ok(waiting.at - at < 6_000, `within seconds, not at the bound: ${waiting.at - at} ms`);
    const failed = await answer;
    // Only the run's own deadline (8 s here) ends the wait: a full cap is no trial-host fault, however long the pressure bound.
    assert.ok(failed instanceof Error, 'the run ends at its own deadline');
    assert.doesNotMatch(failed.message, /gave up|Trial-host fault/);
    assert.equal(await host.started(), 1, 'the waiting verification never reached Docker');
    assert.equal(occupant.child.exitCode, null, 'the running trial is untouched');
  } finally {
    process.env.GRAPHYARD_URL = saved.url; process.env.GRAPHYARD_TOKEN = saved.token;
    if (saved.file !== undefined) process.env.GRAPHYARD_TOKEN_FILE = saved.file;
    if (saved.url === undefined) delete process.env.GRAPHYARD_URL;
    if (saved.token === undefined) delete process.env.GRAPHYARD_TOKEN;
    await host.close();
  }
});

test(`${proof} — with /tmp a tmpfs under the disk floor, merge and gate trials start with their temporary and HOME directories on the durable root; doctor names the root and its fix`, async () => {
  const host = await machine('starve-tmpfs');
  const tmpfs = await host.volume('tmp', small), durable = await host.volume('durable');
  const volatile = (path: string) => path === tmpfs ? 'tmpfs' : null;
  // Only the two roots exist for the choice: the fixture's folder sits inside a checkout, whose package.json would poison both.
  const exists = (path: string) => path === tmpfs || path === durable;
  const root = trialTemporaryRoot(join(host.base, 'session'), [tmpfs, durable], exists, volatile);
  assert.equal(root, durable, 'a memory-backed /tmp is passed over for the durable root');
  try {
    for (const who of ['merge', 'gate'] as const) {
      const temporary = await mkdtemp(join(root, 'gy-t')), home = await mkdtemp(join(root, 'gy-h'));
      host.launch([temporary, home], host.load(trialStartOrder[who]));
    }
    await host.until(async () => await host.started() === 2, 'the merge and gate trials start without waiting');
    const mounts = (await host.docker()).filter(line => line.includes(' create ')).flatMap(line => [...line.matchAll(/src=([^,]+),dst=([^, ]+)(,readonly)?/g)].filter(match => !match[3]).map(match => match[1]!));
    assert.ok(mounts.length >= 4 && mounts.every(path => path.startsWith(durable + '/')), `every writable mount is on the durable root: ${mounts.join(' ')}`);
    assert.ok(!mounts.some(path => path.startsWith(tmpfs)), 'nothing is on the tmpfs');
    const fits = trialTemporaryRootReport(host.base, { roots: [tmpfs, durable], exists, volatile, size: () => 200e9 });
    assert.equal(fits.path, durable);
    assert.equal(fits.status, 'pass');
    assert.deepEqual(fits.skipped, [`${tmpfs} is a tmpfs, so trials do not use it`]);
    const tooSmall = trialTemporaryRootReport(host.base, { roots: [tmpfs, durable], exists, volatile, size: () => 20e9 });
    assert.equal(tooSmall.status, 'fail');
    assert.match(tooSmall.fix ?? '', /20\.0 GB in all, under the 30\.0 GB disk floor.*lower run\.diskFloorGb/);
  } finally { await host.close(); }
});

test(`${proof} — a start that does wait on the disk floor shows one attention line in master status, gone once it stops`, async () => {
  const host = await machine('starve-attention');
  try {
    assert.deepEqual(trialFloorAttention(host.slots), []);
    const first = host.launch([await host.volume('a', small)], host.load(trialStartOrder.merge));
    const second = host.launch([await host.volume('b', small)], host.load(trialStartOrder.gate));
    await host.until(() => first.said().includes('waiting: ') && second.said().includes('waiting: '), 'both starts wait on the floor');
    const lines = trialFloorAttention(host.slots);
    assert.equal(lines.length, 1, 'one line, however many starts wait');
    assert.match(lines[0]!.text, /^2 trial start\(s\) wait on the disk floor: .* is under the disk floor: 15\.7 GB free/);
    await host.close();
    assert.deepEqual(trialFloorAttention(host.slots), [], 'a stopped start leaves no line');
  } finally { await host.close(); }
});
