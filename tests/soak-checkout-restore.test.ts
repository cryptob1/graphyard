import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Work } from '../src/model.js';
import { emptyDaemonState, runDaemon, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { dirtyCheckoutPaths, readCoordinatorCheckout } from '../src/master/profiles.js';
import { checkoutRestoreRefPrefix, checkoutRestoreRequestPath, loopExecutorsRequestPath, loopRestartRequestPath, readCheckoutRestoreRequest } from '../src/cli/master-checkout-restore.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1658 under the real loop for two simulated days. The loop serves the host acts a confined
 * master identity requests — `master checkout-restore`, and the confined master's `master restart`
 * and `master executors [restart]` — on every pass, the refused startup's and every cycle's alike. Each request must be carried out
 * once, its escalation settled, every dirty path preserved (untracked scratch too), its restart asked
 * until one lands (the first ask here fails), an executors request run on the host without a loop
 * restart, and
 * the restarted loops must stay settled: no request re-served, no restart asked again, no further
 * failed dirty-checkout attempt, for the rest of the days.
 */

const minute = 60_000, hour = 60 * minute, day = 24 * hour;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function installation() {
  const root = await temporaryDirectory('soak-checkout-restore');
  const credentials = join(root, 'credentials');
  await mkdir(credentials, { recursive: true, mode: 0o700 });
  const credentialFile = join(credentials, 'coordinator.token');
  await writeFile(credentialFile, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const main = join(root, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', main], { stdio: 'ignore' });
  git(main, 'config', 'user.email', 't@example.com'); git(main, 'config', 'user.name', 'T');
  await mkdir(join(main, 'src'), { recursive: true }); await mkdir(join(main, 'bin'), { recursive: true });
  await writeFile(join(main, 'bin', 'graphyard.mjs'), '#!/usr/bin/env node\n');
  await writeFile(join(main, 'src', 'loop.ts'), 'export const loop = 1;\n');
  await writeFile(join(main, '.gitignore'), '.graphyard/\n');
  git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'base');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: join(main, 'bin', 'graphyard.mjs'),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  return { main, config };
}

function effects(now: () => number): DaemonEffects {
  const iso = () => new Date(now()).toISOString();
  return {
    agents: () => [] as never[],
    credentials: async (profiles: { name: string }[]) => Object.fromEntries(profiles.map(item => [item.name, { available: true, reason: null }])),
    workerCredentials: async () => ({}), producerCredentials: async () => ({}),
    mutate: async () => ({}), dispatchWorker: async () => ({}), launchReview: async () => ({}), launchProducer: async () => ({}), merge: async () => ({}),
    snapshot: async () => ({ work: [] as Work[], now: iso() }),
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: iso(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
  } as unknown as DaemonEffects;
}

test('unit:soak-checkout-restore-served-once — over two simulated days of the real loop, each checkout-restore and confined master-restart request is served once, a failed restart is asked again until it lands, the escalation settles and stays settled, and no restarted loop serves anything again', { timeout: 600_000 }, async () => {
  const { main, config } = await installation();
  const start = Date.parse('2030-01-01T00:00:00Z');
  let clock = start;
  const now = () => clock;
  const state = emptyDaemonState(config);
  const journal: { at: number; pid: number; line: string }[] = [];
  const restarts: { at: number; pid: number; landed: boolean }[] = [];
  const reads: { at: number; pid: number; escalation: string | null; attempts: number | null }[] = [];
  // The day's plan, keyed by simulated time: hotfixes written into the checkout and the requests the
  // doctor and the master file (as `master checkout-restore` and the confined `master restart` write them).
  const request = (file: string, act: string, reason: string, requestedBy: string, args: string[] = []) => () => writeFileSync(file, JSON.stringify({ id: `r-${clock}`, act, reason, requestedAt: new Date(clock).toISOString(), requestedBy, args, outcome: null }));
  const executorRuns: { at: number; pid: number; args: string[] }[] = [];
  const plan = [
    { at: 0, act: () => writeFileSync(join(main, 'src', 'loop.ts'), 'export const loop = 2; // hotfix\n') },
    { at: 2 * hour, act: request(checkoutRestoreRequestPath(config), 'checkout-restore', 'the loop refuses its dirty checkout', 'graphyard-operator-agent') },
    { at: 20 * hour, act: () => { writeFileSync(join(main, 'src', 'fresh.ts'), 'export const fresh = 1;\n'); git(main, 'add', 'src/fresh.ts'); writeFileSync(join(main, 'src', 'fresh.ts'), 'export const fresh = 2;\n'); writeFileSync(join(main, 'scratchpad.mjs'), '// scratch\n'); } },
    { at: 22 * hour, act: request(checkoutRestoreRequestPath(config), 'checkout-restore', 'a standing pane wrote the checkout again', 'graphyard-operator-agent') },
    { at: 26 * hour, act: request(loopExecutorsRequestPath(config), 'executors', 'master executors from the confined master session', 'graphyard-master') },
    { at: 30 * hour, act: request(loopRestartRequestPath(config), 'restart', 'master restart from the confined master session', 'graphyard-master') },
    { at: 28 * hour, act: request(loopExecutorsRequestPath(config), 'executors', 'master executors restart from the confined master session', 'graphyard-master', ['restart']) },
  ];
  plan[0].act(); plan.shift();
  let failNextRestart = true, pid = 1000;
  const end = start + 2 * day;
  while (clock < end) {
    const host = new EventEmitter(), own = ++pid;
    // Each wait between passes — the refused startup's and every cycle's — is ten simulated minutes.
    const intervalMs = () => {
      clock += 10 * minute;
      for (const step of plan.filter(entry => start + entry.at <= clock)) { step.act(); plan.splice(plan.indexOf(step), 1); }
      if (clock >= end) host.emit('SIGTERM');
      return 1;
    };
    const checkout = async () => {
      const read = await readCoordinatorCheckout(main);
      const escalation = state.actions['escalation:dirty-checkout'];
      reads.push({ at: clock, pid: own, escalation: escalation?.state ?? null, attempts: escalation?.attempts ?? null });
      return read;
    };
    const restartLoop = async () => {
      const landed = !failNextRestart;
      restarts.push({ at: clock, pid: own, landed });
      if (!landed) { failNextRestart = false; throw new Error('systemctl --user restart graphyard-master.service: Failed to connect to bus'); }
      host.emit('SIGTERM');
    };
    const executors = async (args: string[]) => { executorRuns.push({ at: clock, pid: own, args }); return args[0] === 'restart' ? { host: 'machine-a', result: 'restarted' } : { host: 'machine-a', executors: [] }; };
    await runDaemon(config, state, effects(now), { intervalMs, identity: { pid: own, host: 'machine-a' }, signals: ['SIGTERM'], process: host as never, now, checkout, restartLoop, executors,
      log: line => journal.push({ at: clock, pid: own, line }) });
  }

  // Each request was carried out once: two restores, each to its own named ref, and one restart request answered.
  const served = journal.filter(entry => /\] checkout-restore (restored|clean|failed)|\] loop-restart request|\] master executors request/.test(entry.line) && !/restart (done|failed):/.test(entry.line));
  assert.equal(served.length, 5, `five requests served once each: ${served.map(entry => entry.line).join(' | ')}`);
  // The executors requests: each run once on the host, by the loop serving when it was filed, owing no loop restart.
  assert.deepEqual(executorRuns.map(entry => entry.args), [[], ['restart']], `executors runs: ${JSON.stringify(executorRuns)}`);
  assert.ok(executorRuns.every(entry => entry.at - start - (entry.args.length ? 28 : 26) * hour <= 10 * minute), 'each on the next pass after it was filed');
  assert.equal((await readCheckoutRestoreRequest(loopExecutorsRequestPath(config)))?.outcome?.state, 'executors');
  // Two restores may share a stamp's second; the ref names their commits too, so they are ordered by what they hold.
  const holds = (ref: string, path: string) => { try { git(main, 'cat-file', '-e', `${ref}:${path}`); return 1; } catch { return 0; } };
  const refs = git(main, 'for-each-ref', '--format=%(refname)', checkoutRestoreRefPrefix).split('\n').filter(Boolean).sort((a, b) => holds(a, 'src/fresh.ts') - holds(b, 'src/fresh.ts'));
  assert.equal(refs.length, 2, `one named ref per restore: ${refs.join(', ')}`);
  assert.equal(git(main, 'show', `${refs[0]}:src/loop.ts`), 'export const loop = 2; // hotfix', 'the first hotfix is saved');
  assert.equal(git(main, 'show', `${refs[1]}:src/fresh.ts`), 'export const fresh = 2;', 'the second restore saved the working file');
  assert.equal(git(main, 'show', `${refs[1]}^2:src/fresh.ts`), 'export const fresh = 1;', 'and the staged version beside it');
  assert.equal(git(main, 'show', `${refs[1]}:scratchpad.mjs`), '// scratch', 'and the untracked scratch outside the source paths');
  assert.equal(git(main, 'status', '--porcelain'), '', 'no non-ignored dirty path is left');
  assert.deepEqual(dirtyCheckoutPaths(await readCoordinatorCheckout(main)), [], 'the checkout ends the days clean');
  // The restarts: the first ask failed and was asked again on the next pass by the same loop; every
  // other request owed exactly one, and each landed loop is a new process.
  assert.deepEqual(restarts.map(entry => entry.landed), [false, true, true, true], `restarts: ${JSON.stringify(restarts)}`);
  assert.equal(restarts[0].pid, restarts[1].pid, 'the failed restart is retried by the loop that owed it');
  assert.ok(restarts[1].at - restarts[0].at <= 10 * minute, 'on its very next pass');
  assert.equal(new Set(restarts.filter(entry => entry.landed).map(entry => entry.pid)).size, 3, 'each landed restart ended a different loop');
  for (const file of [checkoutRestoreRequestPath(config), loopRestartRequestPath(config)])
    assert.equal((await readCheckoutRestoreRequest(file))?.outcome?.restart?.state, 'done', `${file}: the restarted loop recorded its restart done`);
  // The escalation: refused at startup and again after the second hotfix, settled by each restore,
  // and never failed again after the last one for the rest of the days.
  const lastRestore = restarts[3 - 1].at;
  const after = reads.filter(entry => entry.at > lastRestore);
  assert.ok(after.length >= 100 && after.at(-1)!.at - lastRestore >= day, `the days ran on ${(after.at(-1)!.at - lastRestore) / hour} hours past the last restore`);
  assert.ok(after.every(entry => entry.escalation === 'done'), 'the escalation stays settled');
  assert.equal(new Set(after.map(entry => entry.attempts)).size, 1, 'no further failed attempt is recorded');
  assert.equal(Object.keys(state.actions).filter(key => key.startsWith('escalation:dirty-checkout')).length, 1, 'one escalation row all days');
  assert.ok(!journal.some(entry => entry.at > restarts.at(-1)!.at && /checkout-restore|loop-restart|executors request|escalation failed/.test(entry.line) && !/restart done/.test(entry.line)),
    `the last restarted loop serves nothing again: ${journal.filter(entry => entry.at > restarts.at(-1)!.at && /checkout-restore|loop-restart/.test(entry.line)).map(entry => entry.line).join(' | ')}`);
  assert.ok(new Set(reads.map(entry => entry.pid)).size >= 4, 'the days ran four loop processes');
});
