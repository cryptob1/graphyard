import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withDatabase } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import type { Principal } from '../src/model.js';
import { syncWork } from '../src/cli/workspace.js';
import type { CliContext } from '../src/cli/context.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// The fixtures here file items, and every item owes an e2e proof; they declare the serve one needs.
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

/**
 * GY-3266: a requirements revision on a leased item is queued and reaches the worker at its next
 * sync, instead of being refused. The revision is recorded at once (history, criteria) and the
 * lease stays; sync and status print the revised criteria with what changed; complete is refused
 * naming the revision until the worker's sync acknowledges it, and accepted after it — judged
 * against the revised criteria.
 */
const repository = 'owner/project';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const id = () => randomUUID();
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let store: Store, engine: Engine, fixtureRoot: string, checkout: string;

async function commit(cwd: string, path: string, text: string, message: string) {
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), text); git(cwd, 'add', '--', path); git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

before(async () => {
  fixtureRoot = await realpath(await temporaryDirectory('requirements-while-leased'));
  const origin = join(fixtureRoot, 'origin.git'); checkout = join(fixtureRoot, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  await commit(checkout, 'README.md', '# Fixture\n', 'base');
  git(checkout, 'push', '-q', 'origin', 'main');
  store = await withDatabase('requirements-while-leased'); await store.init();
  engine = new Engine(store, 120, repository);
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
});
after(async () => { if (store) await store.close(); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

const initial = [{ id: 'AC-1', text: 'The first criteria text', proofs: ['unit:requirements-while-leased', 'e2e:fixture'] }];
const revised = [
  { id: 'AC-1', text: 'The revised criteria text', proofs: ['unit:requirements-while-leased', 'e2e:fixture'] },
  { id: 'AC-2', text: 'A criterion the revision adds', proofs: ['unit:requirements-while-leased'] },
];

/** An item claimed by the worker with its workspace registered and a head committed on the branch. */
async function leased(n: number) {
  let work = await engine.execute(operator, 'create', null, { type: 'chore', title: `Requirements while leased ${n}`, criteria: initial }, id());
  work = await engine.execute(operator, 'ready', work.id, {}, id());
  work = await engine.execute(worker, 'claim', work.id, {}, id());
  const branch = `graphyard/gy-${n}-${work.lease!.epoch}`;
  const workspace = join(fixtureRoot, `${n}`);
  execFileSync('git', ['-C', checkout, 'worktree', 'add', '-q', '-b', branch, workspace]);
  git(workspace, 'config', 'user.email', 't@example.com'); git(workspace, 'config', 'user.name', 'T');
  await commit(workspace, 'src/change.ts', `export const change = ${n};\n`, 'change');
  const sha = git(workspace, 'rev-parse', 'HEAD');
  work = await engine.execute(worker, 'workspace', work.id, { epoch: work.lease!.epoch, host: 'test', path: workspace, branch }, id());
  return { work: work!, sha, branch, workspace };
}

test('integration:requirements-while-leased — a revision under a live lease is recorded at once, keeps the lease, and reaches the worker at its next sync; complete refuses naming the revision before it and is accepted against the revised criteria after it', async () => {
  const { work, sha } = await leased(1);
  const epoch = work.lease!.epoch;
  const revisedAt = await engine.execute(operator, 'requirements', work.id, { expectedPolicyRevision: work.policyRevision, reason: 'The operator widens the item under way', criteria: revised, dependencies: [], exclusiveResources: [] }, id());
  // The revision is recorded at once: criteria and one history event, with the lease kept.
  assert.deepEqual(revisedAt.criteria, revised);
  assert.equal(revisedAt.policyRevision, 2);
  assert.equal(revisedAt.lease?.epoch, epoch, 'the live lease stays with its epoch');
  assert.equal(revisedAt.lease?.owner, worker.id);
  assert.ok(Date.parse(revisedAt.lease!.expiresAt) > Date.now(), 'the lease is still live');
  assert.equal((await store.pool.query("SELECT count(*)::int AS count FROM events WHERE work_id=$1 AND kind='requirements'", [work.id])).rows[0].count, 1, 'the revision is one history event');
  // Status prints the revised criteria with what changed.
  assert.deepEqual(revisedAt.unsyncedRevision?.changed, ['AC-1 changed: The revised criteria text', 'AC-2 added: A criterion the revision adds']);
  assert.equal(revisedAt.unsyncedRevision?.policyRevision, 2);
  // Complete before that sync is refused naming the revision.
  await assert.rejects(engine.execute(worker, 'submit', work.id, { epoch, head: sha }, id()), /Requirements were revised under this attempt \(policy revision 2\) and not synced yet: run sync GY-\d+/);
  // The worker's sync acknowledges the revision (its heartbeat names the policy revision)…
  const synced = await engine.execute(worker, 'heartbeat', work.id, { epoch, syncedPolicyRevision: 2 }, id());
  assert.equal(synced.unsyncedRevision ?? null, null, 'the sync acknowledged the revision');
  // …and one after it is accepted and reviewed against the revised criteria.
  const submitted = await engine.execute(worker, 'submit', work.id, { epoch, head: sha }, id());
  assert.equal(submitted.submission?.epoch, epoch);
  assert.ok(Number.isInteger(submitted.submission!.pr) && submitted.submission!.pr > 0, 'the accepted submission binds a change number');
  assert.equal(submitted.candidate?.sha, sha);
  assert.equal(submitted.lease, null, 'the accepted submission still ends the lease');
  assert.deepEqual(submitted.criteria, revised, 'the submitted head is judged against the revised criteria');
});

test('integration:requirements-while-leased — a sync that names a superseded revision is refused, a fresh claim starts under the current criteria, and a revision under a lapsed lease still discards it', async () => {
  const { work } = await leased(2);
  const epoch = work.lease!.epoch;
  const revisedAt = await engine.execute(operator, 'requirements', work.id, { expectedPolicyRevision: work.policyRevision, reason: 'First revision', criteria: revised, dependencies: [], exclusiveResources: [] }, id());
  // A second revision lands after the worker read the first: the ack naming the stale revision names itself.
  const twice = await engine.execute(operator, 'requirements', work.id, { expectedPolicyRevision: revisedAt.policyRevision, reason: 'Second revision', criteria: [{ id: 'AC-1', text: 'The twice-revised criteria text', proofs: ['unit:requirements-while-leased', 'e2e:fixture'] }], dependencies: [], exclusiveResources: [] }, id());
  assert.equal(twice.policyRevision, 3);
  await assert.rejects(engine.execute(worker, 'heartbeat', work.id, { epoch, syncedPolicyRevision: 2 }, id()), /Policy revision changed; the sync named 2, GY-\d+ is at 3/);
  // The lease lapses; the next claim starts under the current criteria with nothing to sync, and its submission is accepted.
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(document, '{lease,expiresAt}', to_jsonb($2::text)) WHERE id=$1`, [work.id, new Date(Date.now() - 1000).toISOString()]);
  const branch = `graphyard/gy-2-${epoch + 1}`;
  const workspace = join(fixtureRoot, '2b');
  execFileSync('git', ['-C', checkout, 'worktree', 'add', '-q', '-b', branch, workspace]);
  git(workspace, 'config', 'user.email', 't@example.com'); git(workspace, 'config', 'user.name', 'T');
  const next = await commit(workspace, 'src/next.ts', 'export const next = true;\n', 'the reclaimed attempt');
  const reclaimed = await engine.execute(worker, 'claim', work.id, {}, id());
  assert.equal(reclaimed.unsyncedRevision ?? null, null, 'a fresh claim clears the unsynced revision');
  assert.equal(reclaimed.lease!.epoch, epoch + 1);
  await engine.execute(worker, 'workspace', work.id, { epoch: epoch + 1, host: 'test', path: workspace, branch }, id());
  const submitted = await engine.execute(worker, 'submit', work.id, { epoch: epoch + 1, head: next }, id());
  assert.equal(submitted.candidate?.sha, next, 'no sync is owed by an attempt that claimed the revised criteria');
  // A revision under a lapsed lease discards the lease as before, with no revision queued.
  const lapsed = await leased(3);
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(document, '{lease,expiresAt}', to_jsonb($2::text)) WHERE id=$1`, [lapsed.work.id, new Date(Date.now() - 1000).toISOString()]);
  const after = await engine.execute(operator, 'requirements', lapsed.work.id, { expectedPolicyRevision: lapsed.work.policyRevision, reason: 'A lapsed lease is discarded', criteria: revised, dependencies: [], exclusiveResources: [] }, id());
  assert.equal(after.lease, null, 'the lapsed lease is discarded');
  assert.equal(after.unsyncedRevision ?? null, null, 'no revision is queued without a live lease');
});

test('unit:requirements-while-leased — sync acknowledges a queued revision with a heartbeat naming the policy revision and prints the revised criteria with what changed', async () => {
  const root = await realpath(await temporaryDirectory('requirements-while-leased-sync'));
  const cwd = process.cwd();
  const calls: { path: string; body: unknown }[] = [];
  try {
    const origin = join(root, 'origin.git'), clone = join(root, 'clone');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'ignore' });
    git(clone, 'config', 'user.email', 't@example.com'); git(clone, 'config', 'user.name', 'T');
    await commit(clone, 'README.md', '# Fixture\n', 'base'); git(clone, 'push', '-q', 'origin', 'main');
    git(clone, 'checkout', '-q', '-b', 'graphyard/gy-9-1');
    await commit(clone, 'src/x.ts', 'export const x = 1;\n', 'work');
    const work = { id: 'id-9', key: 'GY-9', policyRevision: 4, criteria: revised,
      unsyncedRevision: { policyRevision: 4, at: new Date().toISOString(), by: operator.id, changed: ['AC-2 added: A criterion the revision adds'] },
      workspaces: [{ epoch: 1, branch: 'graphyard/gy-9-1', host: 'h', path: clone, owner: worker.id }], lease: null };
    const printed: any[] = [];
    process.chdir(clone);
    await syncWork({ api: async (path: string, body?: unknown) => {
      if (path === 'status') return { baseBranch: 'main', mergeWriter: { merger: 'control-plane' } };
      calls.push({ path, body }); return {};
    }, print: (value: unknown) => printed.push(value), base: 'http://graphyard.test', args: [] } as unknown as CliContext, work);
    assert.deepEqual(calls, [{ path: 'work/id-9/heartbeat', body: { epoch: 1, syncedPolicyRevision: 4 } }], 'the merge done, sync acknowledges the revision under the workspace epoch');
    assert.deepEqual(printed[0].requirements, { policyRevision: 4, changed: ['AC-2 added: A criterion the revision adds'], criteria: revised });
    assert.match(printed[0].next, /complete GY-9 EPOCH --head/);
  } finally { process.chdir(cwd); await rm(root, { recursive: true, force: true }); }
});
