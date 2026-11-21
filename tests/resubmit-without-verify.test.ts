import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Engine } from '../src/engine.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { daemonEffects, type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master.js';
import { acquireVerificationSlot, heldSlots, setStrictCap, slotsDirectoryVariable } from '../src/master/verification-slots.js';
import { trialHotCelsius } from '../src/merge-writer/trial-load.js';
import type { Principal, Work } from '../src/model.js';
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3576: finished hotfixes for the pipeline itself sat 10-47 hours behind a host verification
// run the loop made before resubmitting, which the merge trial repeats anyway. The loop now posts
// the recorded finished head at once and the merge trial decides. Here every heavy-job slot is
// held, and one cycle still submits the head a blocked worker named, with no verification run.
const proof = 'integration:resubmit-without-verify';

test(`${proof} — with every heavy-job slot held, the loop submits a recorded finished head in the same cycle`, { timeout: 60_000 }, async t => {
  const base = await realpath(await temporaryDirectory('resubmit-without-verify'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const origin = join(base, 'origin.git'), checkout = join(base, 'checkout'), branch = 'graphyard/gy-1-1', worktree = join(checkout, '.graphyard', 'worktrees', 'GY-1-1');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  await writeFile(join(checkout, 'README.md'), '# Fixture\n'); git(checkout, 'add', 'README.md'); git(checkout, 'commit', '-q', '-m', 'base');
  git(checkout, 'push', '-q', 'origin', 'HEAD:main'); git(checkout, 'fetch', '-q', 'origin');
  git(checkout, 'worktree', 'add', '-q', '-b', branch, worktree);
  // A store change is sensitive, so the submitted head owes review next.
  await mkdir(join(worktree, 'src', 'store'), { recursive: true });
  await writeFile(join(worktree, 'src', 'store', 'finished.ts'), 'export const finished = 1;\n'); git(worktree, 'add', 'src/store/finished.ts'); git(worktree, 'commit', '-q', '-m', 'finished change');
  const head = git(worktree, 'rev-parse', 'HEAD');

  const store = await withDatabase('resubmit-without-verify');
  await store.init(); t.after(() => store.close());
  const engine = new Engine(store, 600, 'owner/project');
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  const operator: Principal = { id: 'operator', role: 'admin' }, worker: Principal = { id: 'worker', role: 'worker' }, coordinator: Principal = { id: 'loop', role: 'coordinator' };
  let work = await engine.execute(operator, 'create', null, { type: 'bug', title: 'Finished hotfix', criteria: [{ id: 'AC-1', text: 'Submitted at once', proofs: [proof, 'e2e:resubmit-without-verify'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'test', path: worktree, branch }, randomUUID());
  // The worker's complete failed on a host fault; its blocker names the head it finished at.
  work = await engine.execute(worker, 'blocked', work.id, { epoch: 1, reason: 'complete failed: the trial host has no image', finishedHead: head }, randomUUID());
  assert.equal(work.finishedBlockerHead?.head, head);
  work = await engine.execute(operator, 'unblock', work.id, { reason: 'the trial host is repaired' }, randomUUID());

  // Every heavy-job slot on this host is held by another project's job.
  // GY-3585: the sensor this fixture reads is its own and reads hot, as the host's did when the test failed.
  const slots = join(base, 'heavy-jobs'), hwmon = join(base, 'hwmon'), saved = process.env[slotsDirectoryVariable];
  await mkdir(join(hwmon, 'hwmon0'), { recursive: true });
  await writeFile(join(hwmon, 'hwmon0', 'name'), 'k10temp\n'); await writeFile(join(hwmon, 'hwmon0', 'temp1_input'), `${trialHotCelsius * 1000}\n`);
  process.env[slotsDirectoryVariable] = slots;
  // The other job holds its slot before the cap stands: a strict cap starts nothing on a hot CPU, this fixture included.
  const other = await acquireVerificationSlot({ directory: slots, label: 'merge trial (other project)', project: 'other', hwmon });
  setStrictCap(slots, { value: 1, until: new Date(Date.now() + 3_600_000).toISOString() }, 'test');
  t.after(() => { other.release(); if (saved === undefined) delete process.env[slotsDirectoryVariable]; else process.env[slotsDirectoryVariable] = saved; });

  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/project',
    credentialFile: join(base, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test', baseBranch: 'main', githubAppId: 1234, masterAgentName: 'master',
    workers: [{ name: 'worker-1', principal: 'graphyard-worker-1', agentName: 'gy-worker-1', mode: 'launch', kind: 'codex', credentialFile: join(base, 'worker-1.token') }],
    run: { masterHeartbeatMinutes: 240 } });
  const posts: { path: string; body: unknown }[] = [], launches: string[] = [];
  const asLoop = async (path: string, data: unknown) => { posts.push({ path, body: data }); const [, id, command] = path.split('/'); return engine.execute(coordinator, command as never, id, data, randomUUID()); };
  const snapshot = async () => ({ work: [work], now: new Date().toISOString() });
  const production = daemonEffects(checkout, () => config, { snapshot, mutate: asLoop });
  const effects: DaemonEffects = {
    snapshot, agents: () => [], credentials: async () => ({}), closeSession: () => {},
    dispatch: async (item: Work) => { launches.push(item.key); },
    persist: async () => {},
    resubmit: production.resubmit!,
  };
  const state = emptyDaemonState(config);
  // One cycle: it settles its own launches, so the resubmission has finished when it returns.
  await runCycle(config, state, effects, () => Date.now());

  assert.deepEqual(posts, [{ path: `work/${work.id}/resubmit`, body: { head } }], 'the loop posts the recorded head and nothing else');
  assert.deepEqual(heldSlots(slots).map(entry => entry.owner?.label), ['merge trial (other project)'], 'no heavy-job slot was taken');
  assert.equal(state.actions[`resubmit:${work.id}:${head}:1`]?.state, 'done', state.actions[`resubmit:${work.id}:${head}:1`]?.detail);
  assert.deepEqual(launches, [], 'no worker launch');
  assert.deepEqual(Object.values(state.actions).filter(action => /verif/i.test(action.detail)).map(action => action.detail), [], 'master status shows no worker verification for the item');
  const submitted = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [work.id])).rows[0].document as Work;
  assert.equal(submitted.candidate?.sha, head, 'the recorded head is the candidate');
  assert.equal(submitted.candidate?.author, 'worker');
  assert.equal(submitted.finishedBlockerHead, null);
  assert.equal(submitted.stage, 'review', 'review, proofs and the merge trial follow as for any submission');
});
