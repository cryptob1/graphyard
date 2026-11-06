import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { emptyDaemonState } from '../src/daemon/state.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { loopRestartRequestPath, runDaemon } from '../src/daemon/run.js';
import { masterConfigSchema } from '../src/master.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-3165: the loop adopts a newly served release only once it has run `run.handoverMinutes`
// (default 15), so serves landing inside that window batch into one restart onto the newest.

const start = Date.parse('2030-07-01T00:00:00Z');
const minute = 60_000;

/** A loop checkout whose HEAD is what the deploy unit serves; `serve` commits `file` and records the new tip as served. */
async function checkout() {
  const root = await temporaryDirectory('loop-handover');
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  await mkdir(join(root, '.graphyard'), { recursive: true });
  const serve = async (file: string) => {
    await mkdir(join(root, file, '..'), { recursive: true });
    await writeFile(join(root, file), `${file} ${Math.random()}\n`);
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', file]);
    const tip = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await writeFile(join(root, '.graphyard', 'deploy.json'), JSON.stringify({ tip, failed: null, reason: null, at: new Date().toISOString() }));
    return tip;
  };
  const loaded = await serve('src/app.ts');
  return { root, serve, loaded };
}

/** Runs the loop on a fake clock that advances a minute per sleep; `tick(minutes)` runs before each check. Returns the restart times and log. */
async function run(root: string, loaded: string, run: Record<string, unknown>, tick: (minutes: number) => Promise<void> = async () => {}, stopAfter = 40) {
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(root, 'coordinator.token'), cliPath: join(root, 'bin/graphyard.mjs'),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', workers: [], run });
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}), snapshot: async () => ({ work: [], now: new Date(start).toISOString() }),
    closeSession: () => {}, dispatch: async () => {}, decisions: async () => ({ decisions: [] }), persist: async () => {}, loadedRelease: { commit: loaded, dirty: false } } as unknown as DaemonEffects;
  let clock = start;
  const restarts: number[] = [], logs: string[] = [], host = new EventEmitter() as unknown as NodeJS.Process;
  await runDaemon(config, emptyDaemonState(config), effects, { intervalMs: 20_000, identity: { pid: process.pid, host: 'machine-a' }, signals: ['SIGUSR2'], process: host,
    now: () => clock, log: line => logs.push(line), root, deployUnit: () => null,
    delay: async () => { clock += minute; if ((clock - start) / minute >= stopAfter) host.emit('SIGUSR2'); else await tick((clock - start) / minute); },
    restartLoop: async () => { restarts.push((clock - start) / minute); host.emit('SIGUSR2'); } });
  return { restarts, logs, config };
}

test('unit:handover-batched-window — serves inside the handover window wait, log one pending handover and batch into one restart onto the newest when the window opens; a configured window and a master restart request are honoured', { timeout: 60_000 }, async () => {
  // Three serves inside the default 15-minute window: one restart at minute 15, onto the third.
  const { root, serve, loaded } = await checkout();
  await serve('src/one.ts');
  let newest = '';
  const batched = await run(root, loaded, {}, async at => { if (at === 4) await serve('src/two.ts'); if (at === 9) newest = await serve('src/three.ts'); });
  assert.deepEqual(batched.restarts, [15], 'the loop restarts once, when its 15-minute window opens');
  const pending = batched.logs.filter(line => line.includes('a handover is pending'));
  assert.equal(pending.length, 1, 'the pending handover is logged once');
  assert.match(pending[0]!, /once it has run 15 minute\(s\), at 2030-07-01T00:15:00\.000Z/);
  const restarted = batched.logs.filter(line => line.includes('restarting through the supervisor unit'));
  assert.equal(restarted.length, 1);
  assert.ok(restarted[0]!.includes(`serves ${newest.slice(0, 12)}`), 'the restart is onto the newest served release, not the first');

  // A configured window is the bound.
  const short = await checkout();
  await short.serve('src/one.ts');
  assert.deepEqual((await run(short.root, short.loaded, { handoverMinutes: 5 })).restarts, [5], 'run.handoverMinutes sets the window');

  // A confined master's restart request does not wait for the window.
  const requested = await checkout();
  const { config } = await run(requested.root, requested.loaded, {}, async () => {}, 1);
  await writeFile(loopRestartRequestPath(config), '');
  const asked = await run(requested.root, requested.loaded, {});
  assert.deepEqual(asked.restarts, [0], 'a requested restart happens at once');
  assert.equal(asked.logs.filter(line => line.includes('a handover is pending')).length, 0);
});

test('unit:handover-window-open-restarts — a loop older than its handover window restarts at once onto a release served then, core files or not', { timeout: 60_000 }, async () => {
  for (const file of ['src/daemon/run.ts', 'src/merge-writer/executor.ts', 'src/batch-gate/gate.ts', 'src/app.ts']) {
    const { root, serve, loaded } = await checkout();
    const { restarts, logs } = await run(root, loaded, {}, async at => { if (at === 20) await serve(file); });
    assert.deepEqual(restarts, [20], `a release changing ${file} served at minute 20 is adopted at that check`);
    assert.equal(logs.filter(line => line.includes('a handover is pending')).length, 0, 'nothing waits, so no pending handover is logged');
  }
});
