import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { headlessWorkers } from './helpers/headless-workers.js';
import { loadMasterConfig } from '../src/master/config.js';
import { runAutonomyCommand } from '../src/master/autonomy.js';
import type { Principal, Work } from '../src/model.js';
import { emptyDaemonState, daemonStateSchema, writeDaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { masterStatusReport } from '../src/cli/master-status.js';
import type { DaemonEffects } from '../src/daemon/effects.js';

const admin: Principal = { id: 'fixture-admin', role: 'admin' };
const worker: Principal = { id: 'worker-a', role: 'worker' };
const token = (id: string) => `${id}-token-${'x'.repeat(32)}`;
const cli = resolve('bin/graphyard.mjs');
const exec = promisify(execFile);

test('e2e:lease-survives-message-and-unblock — a headless rework holder syncs messages with its own epoch and completes after a full lease period', async () => {
  const f = await headlessWorkers('lease-survives-message', 40);
  try {
    await f.configure([{ name: 'first', kind: 'codex' }]);
    const work = await f.readyItem('GY-9700');
    await f.dispatch(work);
    await f.submitted(work.id, 1);
    const config = await loadMasterConfig(f.root);
    const credentialFile = join(await temporaryDirectory('lease-survives-credentials'), 'operator.token');
    await writeFile(credentialFile, token(admin.id), { mode: 0o600 });
    config.operatorAgent = { id: admin.id, credentialFile };
    const master = (command: string, ...args: string[]) => runAutonomyCommand(f.root, config, command, args, {
      coordinator: async path => (await f.api(admin, 'GET', path)).body,
      readSecret: async () => '', agents: () => [], daemonLock: async () => null,
    });
    await master('rework', work.key, 'Exercise a successor on the same branch');
    await f.configure([{ name: 'second', kind: 'codex', wait: true }]);
    const launched = await f.dispatch(await f.stored(work.id));
    assert.equal(launched.epoch, 2);
    const before = await f.stored(work.id);
    assert.equal(before.workspaces[0].branch, before.workspaces[1].branch, 'rework reuses the submitted branch');
    await master('message', work.key, 'Keep this change small');
    await master('unblock', work.key, 'The dependency is available');
    // No command from the agent during this interval: watch alone renews the lease.
    await new Promise(resolve => setTimeout(resolve, 41_000));
    const live = await f.stored(work.id);
    assert.equal(live.lease?.epoch, 2);
    assert.ok(Date.parse(live.lease!.expiresAt) > Date.now());
    assert.ok(Date.parse(live.lease!.expiresAt) > Date.parse(before.lease!.expiresAt));
    const cwd = (await f.started('second')).cwd;
    const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_URL: f.url, GRAPHYARD_TOKEN: token(worker.id), GRAPHYARD_HOST_ID: f.hostId };
    delete env.GRAPHYARD_TOKEN_FILE;
    const result = await exec(process.execPath, [cli, 'sync', work.key], { cwd, env });
    const synced = JSON.parse(result.stdout);
    assert.equal(synced.ok, true);
    assert.equal(synced.messages[0].text, 'Keep this change small');
    const acknowledged = await f.stored(work.id);
    assert.equal(acknowledged.messages![0].acknowledged?.epoch, 2);
    assert.equal(acknowledged.messages![0].acknowledged?.by, worker.id);
    assert.equal(acknowledged.lease?.epoch, 2);
    const stale = await f.api(worker, 'POST', `work/${work.id}/heartbeat`, { epoch: 1 });
    assert.equal(stale.status, 409, 'the server still refuses a superseded epoch');
    await writeFile(join(f.homes.get('second')!, 'release'), '');
    const completed = await f.submitted(work.id, 2);
    assert.equal(completed.pipeline?.attempts.at(-1)?.end, 'submitted');
  } finally {
    // Release a waiting stub even when the regression assertion fails.
    const home = f.homes.get('second');
    if (home) { await writeFile(join(home, 'release'), ''); await new Promise(resolve => setTimeout(resolve, 6000)); }
    await f.stop();
  }
});

test('e2e:lease-survives-message-and-unblock — two headless lease-refusal exits produce one attention line and no third launch', async () => {
  const f = await headlessWorkers('lease-loss-retry');
  try {
    // The reported failure: a stale epoch is refused, the agent prints that refusal and exits 0.
    const afterWait = `const refused = await fetch(process.env.GRAPHYARD_URL + '/api/work/' + key + '/heartbeat', {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.GRAPHYARD_TOKEN, 'Content-Type': 'application/json', 'Idempotency-Key': key + ':' + epoch + ':stale' }, body: JSON.stringify({ epoch: Number(epoch) + 1 }) });
      console.log(await refused.text()); process.exit(0);`;
    await f.configure([{ name: 'lost', kind: 'codex', wait: true, afterWait }]);
    const work = await f.readyItem('GY-9701');
    const config = await loadMasterConfig(f.root);
    let launches = 0;
    let lastRun = '';
    const launch = async (item: Work) => { launches++; const run = await f.dispatch(item); lastRun = run.run; return run; };
    const effects: DaemonEffects = {
      agents: () => [], credentials: async () => ({ launch: { available: true, reason: null } }),
      snapshot: async () => ({ work: [await f.stored(work.id)], now: new Date().toISOString() }),
      closeSession: () => {}, persist: async () => {},
      sessionScreen: async () => (await f.runLog(work, lastRun)).body.lines.map((line: { text: string }) => line.text).join('\n'),
      dispatch: launch,
    };
    let state = emptyDaemonState(config);
    await launch(work);
    const end = async () => {
      await writeFile(join(f.homes.get('lost')!, 'release'), '');
      for (let i = 0; i < 300; i++) {
        if ((await f.runLog(work, lastRun)).body.ended) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.fail('headless run did not end');
    };
    await end();
    // A fresh home keeps the retry mid-work until this test releases it.
    await f.configure([{ name: 'lost', kind: 'codex', wait: true, afterWait }]);
    await runCycle(config, state, effects);
    assert.equal(launches, 2, 'one retry is allowed');
    await end();
    await runCycle(config, state, effects);
    state = daemonStateSchema.parse(JSON.parse(JSON.stringify(state)));
    for (let i = 0; i < 3; i++) await runCycle(config, state, effects);
    assert.equal(launches, 2, 'the second lease-loss exit stops dispatch, including after restart');
    await writeDaemonState(config, state);
    const report = await masterStatusReport(f.root, config, async path => (await f.api(admin, 'GET', path)).body, async () => '');
    const attention = report.attention.filter(line => line.subject === work.key);
    assert.equal(attention.length, 1);
    assert.match(attention[0].text, /GY-9701.*lease loss.*twice/);
    assert.match(attention[0].text, /master rework GY-9701 REASON/);
  } finally { await f.stop(); }
});

test('e2e:lease-survives-message-and-unblock — missing, expired and superseded leases stop after two consecutive endings even with progress', async () => {
  const { workerLaunchHealth } = await import('../src/daemon/worker-launch-health.js');
  const { advanceFailureRuns, failureHeld } = await import('../src/daemon/repeated-failure.js');
  const { masterConfigSchema } = await import('../src/master.js');
  const config = masterConfigSchema.parse({ version: 1, url: 'http://localhost:1', credentialFile: '/outside/coordinator.token', cliPath: cli,
    repository: 'owner/project', baseBranch: 'main', hostId: 'test', masterAgentName: 'master', workers: [] });
  for (const cause of ['missing', 'expired', 'superseded'] as const) {
    const state = emptyDaemonState(config), clock = Date.now();
    for (let epoch = 1; epoch <= 2; epoch++) {
      const at = new Date(clock - 600_000).toISOString();
      const item = { id: cause, key: 'GY-9702', epoch, stage: 'build', submission: null,
        lease: cause === 'missing' ? null : { owner: worker.id, epoch: cause === 'superseded' ? epoch + 1 : epoch, expiresAt: new Date(clock + (cause === 'expired' ? -1000 : 60_000)).toISOString() },
        workspaces: [{ epoch, host: 'test', path: '/fixture', branch: 'graphyard/fixture' }], gates: [],
      } as unknown as Work;
      const session = { id: `worker-a:${epoch}`, epoch, kind: 'implementation', principal: worker.id, host: 'test', runtime: 'codex', state: 'finished', startedAt: at, initialHead: 'a'.repeat(40) } as const;
      await workerLaunchHealth({ config, state, clock, effects: { persist: async () => {}, sessionScreen: () => '', worktreeState: async () => ({ head: 'b'.repeat(40), dirty: null }) } } as unknown as import('../src/daemon/cycle.js').Cycle,
        item, session as import('../src/model/sessions.js').SessionHandle);
      advanceFailureRuns(state, [item], []);
      assert.equal(failureHeld(state.failureRuns[item.id]), epoch === 2, cause);
    }
  }
});
