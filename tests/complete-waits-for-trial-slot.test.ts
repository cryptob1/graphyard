import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { withDatabase } from './helpers/postgres.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { createContext } from '../src/cli/context.js';
import { completeCommand } from '../src/cli/complete.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { trialContainerLaunch } from '../src/merge-writer/trial-container.js';
import { trialLoad, type TrialLoad } from '../src/merge-writer/trial-load.js';
import { verificationStep } from '../src/merge-writer/worker-verification.js';
import { workerVerificationPump } from '../src/daemon/worker-verification.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3390: complete GY-3386 failed twice with "the trial container waited 600s to start and gave up:
// the machine-wide cap of 12 trial containers is reached", and the worker blocked. A full cap is
// capacity, not a fault: complete waits its turn, then verifies and submits. Here the real CLI
// complete, control plane, host pump and admission launcher run with stand-in docker and df, and
// every trial slot on the machine is held by another start.
const proof = 'e2e:complete-waits-for-trial-slot';

test(`${proof} — with every trial slot taken, complete waits past any give-up, then verifies and records the submission with no blocker`, { timeout: 120_000 }, async t => {
  const base = await realpath(await temporaryDirectory('complete-slot', process.cwd()));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8' }).trim();
  const origin = join(base, 'origin.git'), checkout = join(base, 'checkout'), worktree = join(checkout, '.graphyard', 'worktrees', 'GY-1-1');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  await writeFile(join(checkout, 'README.md'), '# Fixture\n'); git(checkout, 'add', 'README.md'); git(checkout, 'commit', '-q', '-m', 'base');
  git(checkout, 'push', '-q', 'origin', 'HEAD:main'); git(checkout, 'fetch', '-q', 'origin');
  git(checkout, 'worktree', 'add', '-q', '-b', 'graphyard/gy-1-1', worktree);
  await writeFile(join(checkout, '.git', 'info', 'exclude'), '.graphyard/\n');
  await writeFile(join(worktree, 'app.txt'), 'change\n'); git(worktree, 'add', 'app.txt'); git(worktree, 'commit', '-q', '-m', 'change');
  const head = git(worktree, 'rev-parse', 'HEAD');

  // Stand-in docker: every container start succeeds at once. The machine's only slot is held by another start.
  const bin = join(base, 'bin'), hwmon = join(base, 'hwmon'), slots = join(base, 'slots'), log = join(base, 'docker.log');
  await mkdir(bin); await mkdir(hwmon); await mkdir(slots);
  await writeFile(join(bin, 'docker'), `#!/bin/sh\necho "$*" >> ${JSON.stringify(log)}\nexit 0\n`);
  await writeFile(join(bin, 'df'), '#!/bin/sh\necho Avail\necho 100000000000\n');
  await chmod(join(bin, 'docker'), 0o755); await chmod(join(bin, 'df'), 0o755);
  const started = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(line => line.includes(' start ')).length;
  // Its own process group: the lock is dropped only once the sleep that inherited it is gone too.
  const occupant = spawn('flock', [join(slots, 'slot-0'), 'sleep', '600'], { stdio: 'ignore', detached: true });
  const free = () => { try { process.kill(-occupant.pid!, 'SIGKILL'); } catch { /* already gone */ } };
  t.after(free);
  const until = async (condition: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
    for (let waited = 0; !(await condition()); waited += 50) {
      assert.ok(waited < ms, what);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  await until(() => spawnSync('flock', ['-n', join(slots, 'slot-0'), 'true']).status !== 0, 'another start holds the only slot');
  // The verification's own load, on this machine's one slot. Any give-up a slot wait could carry is
  // shortened to 2 s (the base gave up after 600 s), so a wait that ends on its own shows here in seconds.
  const load: TrialLoad = Object.assign(await trialLoad(checkout, 'verification'), { slots, cap: 1, hwmon }, { waitBoundSeconds: 2 });
  const wrapper = trialContainerLaunch({ image: 'graphyard-trial:local', mounts: [[base, base, false]], network: 'none', load });

  const store = await withDatabase('complete-waits-for-trial-slot');
  await store.init(); t.after(() => store.close());
  const engine = new Engine(store, 600, 'owner/project');
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  const operator = { id: 'operator', role: 'admin' as const, sessionKind: 'human' as const };
  const worker = { id: 'worker', role: 'worker' as const, token: 'worker-' + 'w'.repeat(32) };
  const coordinator = { id: 'host', role: 'coordinator' as const, token: 'host-' + 'h'.repeat(32) };
  engine.principals = [operator, worker, coordinator];
  let work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Waits its turn', criteria: [{ id: 'AC-1', text: 'Waits', proofs: ['unit:waits', 'e2e:fixture'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'test', path: worktree, branch: 'graphyard/gy-1-1' }, randomUUID());
  const http = server(engine, [worker, coordinator]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => { http.closeAllConnections(); return new Promise<void>(resolve => http.close(() => resolve())); });
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const mutate = async (path: string, body: unknown) => (await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${coordinator.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  let taken = false;
  const pump = workerVerificationPump(checkout, () => 'test', mutate, () => 'main', undefined, async (_root, item, input, _base, _parent, progress) => {
    taken = true;
    await verificationStep('true', [], { env: { PATH: `${bin}:/usr/bin:/bin` }, timeoutMs: 60_000, wrapper }, progress!);
    return { record: { key: item.key, head: input.head, clean: true, at: new Date().toISOString(), ran: [], outstanding: [] }, rerun: { flaked: [], baseFailures: [] } } as never;
  });

  const shown: string[] = [];
  t.mock.method(console, 'error', (line: unknown) => { shown.push(String(line)); });
  const saved = { url: process.env.GRAPHYARD_URL, token: process.env.GRAPHYARD_TOKEN, file: process.env.GRAPHYARD_TOKEN_FILE };
  process.env.GRAPHYARD_URL = url; process.env.GRAPHYARD_TOKEN = worker.token; delete process.env.GRAPHYARD_TOKEN_FILE;
  try {
    const context = await createContext('complete', work.key, ['1', '--head', head], false);
    context.repositoryRoot = () => worktree;
    const printed: any[] = [];
    context.print = value => { printed.push(value); };
    let settled = false;
    const completed = completeCommand.run(context, work).then(() => null, (error: unknown) => error).finally(() => { settled = true; });
    for (let tries = 0; tries < 100 && !taken; tries++) { await pump(); if (!taken) await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.ok(taken, 'the host took the verification');
    await until(() => shown.some(line => line.includes('waiting: the machine-wide cap of 1 trial containers is reached')), 'complete shows why it waits', 10_000);
    await new Promise(resolve => setTimeout(resolve, 5_000));
    assert.equal(settled, false, `complete is still waiting its turn past the give-up, not failed: ${String(settled && await completed)}`);
    assert.equal(await started(), 0, 'the waiting verification has not started a container');
    assert.ok(!shown.some(line => line.includes('gave up')), 'no give-up is printed');

    free();
    const failed = await completed;
    assert.equal(failed, null, `complete succeeds once a slot frees: ${String(failed)}`);
    assert.equal(await started(), 1, 'the verification started and finished in the freed slot');
    const recorded = (await store.list()).find(entry => entry.id === work.id)!;
    assert.equal(recorded.submission?.epoch, 1, 'the submission is recorded');
    assert.equal(recorded.candidate?.sha, head, 'its head is the candidate');
    assert.equal(recorded.lease, null, 'complete ended the lease');
    assert.equal(recorded.blocker, null, 'the item records no blocker');
    assert.equal(printed.length, 1);
  } finally {
    process.env.GRAPHYARD_URL = saved.url; process.env.GRAPHYARD_TOKEN = saved.token;
    if (saved.file !== undefined) process.env.GRAPHYARD_TOKEN_FILE = saved.file;
    if (saved.url === undefined) delete process.env.GRAPHYARD_URL;
    if (saved.token === undefined) delete process.env.GRAPHYARD_TOKEN;
  }
});
