import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { runCycle } from '../src/daemon/cycle.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import { daemonEffects, type DaemonEffects } from '../src/daemon/effects.js';
import { masterConfigSchema } from '../src/master.js';
import { assertDispatchable } from '../src/master/dispatch.js';
import { leaseCommands } from '../src/cli/lease.js';
import { requestWorkerVerification } from '../src/cli/worker-verification.js';
import type { CliContext } from '../src/cli/context.js';
import type { Principal, Work } from '../src/model.js';
// GY-3037: the fixtures file items carrying an e2e proof; the serve declaration the trial would use.
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// GY-3335: a finished head blocked only by a host fault is resubmitted when the fault clears,
// without waiting for a worker slot. The 2026-11-14 host move left nine items with finished work
// committed whose complete failed on the missing trial image; each worker blocked, and after the
// master unblocked them every item waited hours for a brand-new worker session only to run
// complete on the unchanged head. Here a worker whose complete fails on a stubbed trial-host
// fault blocks naming its committed head; after master unblock, with the worker role at its
// concurrency limit, the loop submits that exact head itself (GY-3576: with no host verification;
// the merge trial decides), and the item reaches review without any worker launch. A blocker that
// names no finished head sends the item to a worker as today.

const operator: Principal = { id: 'human-operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const coordinator: Principal = { id: 'loop-coordinator', role: 'coordinator' };
const hostFault = "Trial-host fault: the trial's install step could not fetch from registry.example, rerun included; this is the trial host's network, not the head's";
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let store: Store, engine: Engine, fixtureRoot: string, checkout: string, baseTip: string;
/** The finished head of each scenario's attempt, on its own branch in the shared object store. */
const heads = new Map<string, { head: string; worktree: string; branch: string }>();

async function commit(cwd: string, path: string, text: string, message: string) {
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), text); git(cwd, 'add', '--', path); git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

let config: ReturnType<typeof masterConfigSchema.parse>;
before(async () => {
  fixtureRoot = await realpath(await temporaryDirectory('unblock-resubmits'));
  const origin = join(fixtureRoot, 'origin.git'); checkout = join(fixtureRoot, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  await commit(checkout, 'README.md', '# Fixture\n', 'base');
  git(checkout, 'push', '-q', 'origin', 'main');
  baseTip = git(checkout, 'rev-parse', 'refs/remotes/origin/main');

  store = await withDatabase('unblock-resubmits-finished-head'); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', repository: 'owner/project',
    credentialFile: join(fixtureRoot, 'coordinator.token'), cliPath: '/bin/graphyard', hostId: 'test-host', baseBranch: 'main',
    githubAppId: 1234, masterAgentName: 'master',
    // One worker: the role's whole concurrency is the one profile, so an agent running under its
    // name is the role at its limit, and nothing can launch until it ends.
    workers: [{ name: 'worker-1', principal: 'graphyard-worker-1', agentName: 'gy-worker-1', mode: 'launch', kind: 'codex', credentialFile: join(fixtureRoot, 'worker-1.token') }],
    run: { masterHeartbeatMinutes: 240 } });
});
after(async () => { if (store) await store.close(); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

/** An item claimed by the worker with its workspace registered on a real worktree of its own branch. */
async function assigned(n: number): Promise<Work> {
  let w = await engine.execute(operator, 'create', null, { type: 'bug', title: `Finished head ${n}`, criteria: [{ id: 'AC-1', text: 'The finished head is resubmitted', proofs: ['integration:unblock-resubmits-finished-head', 'e2e:unblock-resubmits-finished-head'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  const pulled = await engine.pullAssignment(worker, { work: w.id }, randomUUID());
  assert.equal(pulled.assigned?.id, w.id, JSON.stringify(pulled.refused));
  w = pulled.assigned!;
  const branch = `graphyard/gy-${n}-1`, worktree = join(checkout, '.graphyard', 'worktrees', `GY-${n}-1`);
  git(checkout, 'worktree', 'add', '-q', '-b', branch, worktree);
  git(worktree, 'config', 'user.email', 't@example.com'); git(worktree, 'config', 'user.name', 'T');
  // A change in the store is a sensitive delta under the test process's policy, so the resubmitted
  // head owes its review before the merge: the item's next stage after the loop's submission is
  // review, as for any sensitive head.
  const head = await commit(worktree, `src/store/finished-${n}.ts`, `export const finished = ${n};\n`, `finished change ${n}`);
  heads.set(w.key, { head, worktree, branch });
  return engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test-host', path: worktree, branch }, randomUUID());
}

/** The worker's own complete: the private verification, here refused by the stubbed trial-host fault. */
async function completeRefusedByHostFault(w: Work) {
  const { head, worktree } = heads.get(w.key)!;
  const context = { repositoryRoot: () => worktree, api: async () => { throw new Error(hostFault); }, print: (value: unknown) => value } as unknown as CliContext;
  await assert.rejects(requestWorkerVerification(context, w, { mode: 'complete', head, epoch: 1 }), /Trial-host fault/);
}

/** `blocked --finished` the way the worker's CLI sends it, from `cwd` (its worktree by default). */
async function blockFinished(w: Work, reason: string, finished = true, cwd?: string) {
  const { worktree } = heads.get(w.key)!;
  const context = { args: ['1', ...(finished ? ['--finished'] : []), reason], api: async (path: string, data: unknown) => {
    assert.match(path, new RegExp(`^work/${w.id}/blocked$`));
    return engine.execute(worker, 'blocked', w.id, data, randomUUID());
  }, print: (value: unknown) => value } as unknown as CliContext;
  const command = leaseCommands.find(entry => entry.name === 'blocked')!;
  const previous = process.cwd();
  process.chdir(cwd ?? worktree);
  try { return await command.run(context, w) as unknown as Work; } finally { process.chdir(previous); }
}

const readWork = async (id: string) => (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
const unblock = (w: Work) => engine.execute(operator, 'unblock', w.id, { reason: 'the trial host is repaired' }, randomUUID());

/**
 * One loop cycle over `work`: the production resubmit effect wired to the real engine, a worker role the busy flag fills or frees, and a dispatch that would
 * launch a worker. Answers what the control plane was asked, what the loop recorded, and which
 * items a worker launch was offered for.
 */
async function cycle(work: Work[], options: { busy: boolean }) {
  const state = emptyDaemonState(config);
  const posts: { path: string; body: any }[] = [], launches: string[] = [];
  const mutate = async (path: string, data: unknown) => {
    posts.push({ path, body: data });
    const [, id, command] = path.split('/');
    return engine.execute(coordinator, command as never, id, data, randomUUID());
  };
  const production = daemonEffects(checkout, () => config, { snapshot: async () => ({ work, now: new Date().toISOString() }), mutate });
  const effects: DaemonEffects = {
    snapshot: async () => ({ work, now: new Date().toISOString() }),
    agents: () => options.busy ? [{ name: 'gy-worker-1', pane_id: 'p-busy', agent_status: 'working' } as never] : [],
    credentials: async () => ({}), closeSession: () => {},
    dispatch: async (item: Work) => { launches.push(item.key); },
    persist: async () => {},
    resubmit: production.resubmit!,
  };
  await runCycle(config, state, effects, () => Date.now());
  return { state, posts, launches };
}

test('integration:unblock-resubmits-finished-head — a finished head blocked only by a host fault is resubmitted by the loop without any worker launch; the item reaches review', async () => {
  const w = await assigned(1), { head, branch } = heads.get(w.key)!;
  // The worker's complete fails on the trial-host fault, not the change; its blocker names the head it finished at.
  await completeRefusedByHostFault(w);
  const blocked = await blockFinished(w, `complete failed: ${hostFault}`);
  assert.equal(blocked.blocker, `complete failed: ${hostFault}`);
  assert.equal(blocked.lease, null, 'the blocker ends the attempt');
  assert.deepEqual({ ...blocked.finishedBlockerHead, at: '…' }, { head, epoch: 1, branch, owner: 'implementer', at: '…', reason: `complete failed: ${hostFault}` });
  assert.throws(() => assertDispatchable(blocked, [blocked], new Date().toISOString()), /without a blocker/);

  const unblocked = await unblock(blocked);
  assert.equal(unblocked.blocker, null);
  assert.equal(unblocked.finishedBlockerHead?.head, head, 'the unblock keeps the finished-head record');
  assert.throws(() => assertDispatchable(unblocked, [unblocked], new Date().toISOString()), /waits for the loop to resubmit the finished head/);

  // With the worker role at its concurrency limit, an ordinary ready item cannot launch either —
  // the limit is real — while the finished head needs no worker at all.
  const ordinary = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Ordinary ready item', criteria: [{ id: 'AC-1', text: 'Anything', proofs: ['integration:unblock-resubmits-finished-head', 'e2e:unblock-resubmits-finished-head'] }] }, randomUUID());
  await engine.execute(operator, 'ready', ordinary.id, {}, randomUUID());
  const run = await cycle([await readWork(w.id), await readWork(ordinary.id)], { busy: true });

  assert.deepEqual(run.launches, [], 'no worker launch: not for the finished head, and not for the ordinary item the full role holds back');
  const post = run.posts.find(entry => entry.path === `work/${w.id}/resubmit`);
  assert.ok(post, 'the loop submitted through the control plane');
  assert.equal(post.body.head, head);

  const submitted = await readWork(w.id);
  assert.equal(submitted.finishedBlockerHead, null, 'the record is spent');
  assert.equal(submitted.submission?.epoch, 2);
  assert.ok(submitted.submission!.pr > 0, 'the submission carries its change number');
  assert.equal(submitted.candidate?.sha, head);
  assert.equal(submitted.candidate?.author, 'implementer', 'the candidate stays the worker\'s, never the loop\'s');
  assert.equal(submitted.candidate?.branch, branch);
  assert.equal(submitted.observation?.source, 'control-plane');
  assert.equal(submitted.observation?.baseTip, baseTip);
  assert.equal(submitted.lease, null);
  assert.equal(submitted.epoch, 2, 'the resubmission is the next attempt of the same item');
  assert.equal(submitted.pipeline?.attempts.at(-1)?.end, 'submitted');
  assert.equal(submitted.stage, 'review');
  assert.ok(submitted.gates.some(gate => gate.name === 'review' && !gate.passed), 'every gate after the submission stands as for any other');
  assert.equal(run.state.actions[`resubmit:${w.id}:${head}:1`]?.state, 'done');
  const events = (await store.pool.query(`SELECT payload FROM events WHERE work_id=$1 AND kind='resubmit'`, [w.id])).rows;
  assert.equal(events.length, 1, 'the resubmission is on the item\'s history');
});

test('integration:unblock-resubmits-finished-head — a blocker that names no finished head sends the item to a worker as today', async () => {
  const w = await assigned(3);
  await blockFinished(w, 'the staging database is unreachable', false);
  const blocked = await readWork(w.id);
  assert.equal(blocked.finishedBlockerHead ?? null, null, 'a plain blocker records no head');
  const unblocked = await unblock(blocked);
  assert.doesNotThrow(() => assertDispatchable(unblocked, [unblocked], new Date().toISOString()));

  const run = await cycle([unblocked], { busy: false });
  assert.deepEqual(run.launches, [w.key], 'the item goes to a worker as today');
  assert.equal(run.posts.length, 0, 'the loop resubmits nothing');
});

test('unit:unblock-resubmits-finished-head — blocked --finished runs from the attempt\'s own worktree; resubmit is the loop\'s alone and only a recorded head', async () => {
  const w = await assigned(4);
  // Outside the attempt's worktree, --finished names no head and refuses rather than record one.
  await assert.rejects(blockFinished(w, 'complete failed elsewhere', true, fixtureRoot), /--finished records the head this attempt finished at/);
  assert.equal((await readWork(w.id)).blocker, null, 'nothing was recorded');

  // Only the loop may resubmit, and only the head the item's record names — on either path.
  const blocked = await blockFinished(w, `complete failed: ${hostFault}`);
  await unblock(blocked);
  const { head } = heads.get(w.key)!;
  await assert.rejects(engine.execute(worker, 'resubmit', w.id, { head }, randomUUID()), /Only the loop resubmits a finished head/);
  await assert.rejects(engine.execute(coordinator, 'resubmit', w.id, { head: 'f'.repeat(40) }, randomUUID()), /names no finished head/);
  assert.equal((await readWork(w.id)).finishedBlockerHead?.head, head, 'a refused resubmission spends no record');
});
