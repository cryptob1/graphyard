import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { masterConfigSchema, type WorkerProfile } from '../src/master.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import type { Principal, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-2875 AC-1: plannedFiles is only a hint. Nothing requests, widens, derives, splits, researches,
 * triages or judges an item: a head that changes files outside the item's planned files is
 * accepted as it stands, and an item planned on twelve source files is dispatched whole.
 */
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let pg: EmbeddedPostgres, store: Store, engine: Engine, root: string, head: string;

async function commit(cwd: string, path: string, text: string, message: string) {
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), text); git(cwd, 'add', '--', path); git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}
before(async () => {
  root = await realpath(await temporaryDirectory('planned-files-hint'));
  const origin = join(root, 'origin.git'), checkout = join(root, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  await commit(checkout, 'src/planned.ts', 'export const planned = 1;\n', 'base');
  git(checkout, 'push', '-q', 'origin', 'main');
  const worktree = join(checkout, '.graphyard', 'worktrees', 'GY-1-1');
  git(checkout, 'worktree', 'add', '-q', '-b', 'graphyard/gy-1-1', worktree);
  git(worktree, 'config', 'user.email', 't@example.com'); git(worktree, 'config', 'user.name', 'T');
  // The head changes nothing it planned: only files outside its plannedFiles.
  await commit(worktree, 'src/elsewhere.ts', 'export const elsewhere = 1;\n', 'outside the plan');
  head = await commit(worktree, 'docs/unplanned.md', '# Unplanned\n', 'docs outside the plan');
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2875;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('planned-files-hint-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('planned_files_hint');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/planned_files_hint`); await store.init();
  engine = new Engine(store, 120, 'owner/project'); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); if (root) await rm(root, { recursive: true, force: true }); });

const retired = ['scopeRequest', 'carriedScopeRequest', 'heldGroundings', 'scopeDecision', 'parent', 'children', 'researchBrief', 'decomposition', 'split', 'research', 'triage', 'pendingFollowUps', 'blockerProbe'];
const events = async (id: string) => (await store.pool.query('SELECT kind FROM events WHERE work_id=$1', [id])).rows.map(row => row.kind as string);
const judged = /^(scope|decomposition|research|triage|decision|blocker)\./;

test('unit:planned-files-only-a-hint — a head outside the item\'s plannedFiles is accepted with no scope request, hold, blocker or decision', async () => {
  let w = await engine.execute(operator, 'create', null, { title: 'Hinted', plannedFiles: ['src/planned.ts'], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:planned-files-only-a-hint'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  const pulled = await engine.pullAssignment(worker, { work: w.id }, randomUUID());
  assert.equal(pulled.assigned?.id, w.id, JSON.stringify(pulled.refused));
  await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: '/tmp/planned-files-hint', branch: 'graphyard/gy-1-1' }, randomUUID());
  const submitted = await engine.execute(worker, 'submit', w.id, { epoch: 1, head }, randomUUID());
  assert.equal(submitted.candidate?.sha, head, 'the head is the candidate');
  assert.equal(submitted.submission?.epoch, 1, 'the submission is accepted');
  assert.deepEqual([...submitted.observation?.files ?? []].sort(), ['docs/unplanned.md', 'src/elsewhere.ts'], 'every changed file is outside the plan');
  assert.equal(submitted.blocker, null, 'no blocker');
  assert.equal(submitted.humanRequest ?? null, null, 'no human request');
  assert.equal(submitted.violations.length, 0, 'no violation');
  for (const field of retired) assert.equal(field in submitted, false, `no ${field}`);
  assert.ok(!submitted.gates.some(gate => gate.reasons.some(reason => /scope|planned/i.test(reason))), 'no gate holds it on its scope');
  assert.deepEqual((await events(w.id)).filter(kind => judged.test(kind)), [], 'nothing requested, widened or judged it');
});

test('unit:planned-files-only-a-hint — an item with twelve planned source files is dispatched whole on the next cycle, with no decomposition or research record', async () => {
  const planned = Array.from({ length: 12 }, (_, index) => `src/module-${index + 1}.ts`);
  let w = await engine.execute(operator, 'create', null, { title: 'Broad', plannedFiles: planned, criteria: [1, 2, 3, 4, 5, 6].map(n => ({ id: `AC-${n}`, text: `Behaviour ${n}`, proofs: [`unit:broad-${n}`] })) }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  const directory = await temporaryDirectory('planned-files-hint-loop');
  const credential = join(directory, 'token');
  await writeFile(credential, 'token-'.padEnd(40, 'x'), { mode: 0o600 });
  const profile: WorkerProfile = { name: 'codex-a', principal: 'codex-a', agentName: 'agent-codex-a', mode: 'launch', kind: 'codex', credentialFile: credential, agentArgs: [], approvals: 'auto', environment: {} };
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: credential, cliPath: fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url)),
    repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [profile] });
  const dispatched: Work[] = [];
  const effects: DaemonEffects = {
    agents: () => [], credentials: async items => Object.fromEntries(items.map(item => [item.name, { available: true, reason: null }])),
    snapshot: async () => ({ work: (await store.list()).filter(item => item.id === w.id), now: new Date().toISOString() }),
    closeSession: () => {}, dispatch: async item => { dispatched.push(item); },
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date().toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, persist: async () => {},
  };
  const state = emptyDaemonState(config);
  try {
    await runCycle(config, state, effects, Date.now, undefined, () => {});
    assert.deepEqual(dispatched.map(item => item.key), [w.key], 'the item itself is offered to a worker on the next cycle');
    const after = (await store.list()).find(item => item.id === w.id)!;
    assert.equal(after.criteria.length, 6, 'whole: every criterion stays on the one item');
    for (const field of retired) assert.equal(field in after, false, `no ${field}`);
    assert.equal((await store.list()).length, 2, 'no child item was filed');
    assert.deepEqual(Object.keys(state.actions).filter(key => /^(decomposition|research|triage):/.test(key)), [], 'the loop ran no split or research');
    assert.deepEqual((await events(w.id)).filter(kind => judged.test(kind)), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
