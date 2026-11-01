import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { freePort } from '../src/cli/test-isolation.js';
import { applyDelivery } from '../src/repository-setup.js';
import * as onboarding from '../src/onboarding.js';
import { runTrialE2eCases } from '../src/merge-writer/e2e-trial.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { baseFailureItem, type BaseFailure } from '../src/model/base-failure.js';
import { postMergeFollowUp } from '../src/model/post-merge-review.js';
import { onboardingWorkRequest } from '../src/model/onboarding-work.js';
import { filingRefusal } from '../src/model/user-facing.js';
import { defaultRepositoryPolicy, setRepositoryPolicy } from '../src/model/repository-policy.js';
import { setProjectDelivery } from '../src/project-applications.js';

// GY-3037 AC-2: every item Graphyard files itself — a base-failure repair, a post-merge review
// follow-up, onboarding work — is accepted under the rule that every item owes an e2e proof, and
// names a case that exists on the head: the merge trial runs it against the served head.

const sha = (seed: string) => seed.repeat(40).slice(0, 40);
const servePolicy = { ...defaultRepositoryPolicy, e2e: { pendingOutcomes: 'non-blocking' as const, serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } };

const failure: BaseFailure = { test: 'the suite fails on the base', check: 'test', baseSha: sha('a'), jobId: 7, url: 'https://ci.example/run/7', raisedAt: '2026-10-31T00:00:00.000Z', blocks: [], item: null, cleared: null };
const delivered = { key: 'GY-1', title: 'Delivered item', policy: { checks: ['test'], review: true } };
const finding = { text: 'the guard reads the stale copy', path: 'src/guard.ts', line: 3, paths: ['src/guard.ts'] };
let pg: EmbeddedPostgres, store: Store, engine: Engine;
const operator = { id: 'operator', role: 'admin' as const };
before(async () => {
  const port = await freePort();
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('self-filed-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('self_filed');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/self_filed`); await store.init();
  engine = new Engine(store, 120, 'owner/project');
  engine.operatorAuthorizer = async (_db, _now, actor) => actor;
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });

const selfFiled = () => [
  ['the base-failure repair', baseFailureItem(failure, 'main')],
  ['the post-merge follow-up', postMergeFollowUp(delivered, sha('b'), finding, 0)],
  ['the onboarding item', onboardingWorkRequest(sha('c'), ['test', 'typecheck'], 'create-work-item')],
] as const;

test('unit:self-filed-items-name-a-case — a base-failure repair, a post-merge follow-up and onboarding work are each accepted and name a case that exists on the head', async () => {
  setRepositoryPolicy(servePolicy);
  setProjectDelivery({ mode: 'local', previews: 'off', candidateMaxChanges: null, productionVerification: true, applications: [], cases: {}, source: 'graphyard.json' });
  for (const [what, item] of selfFiled()) {
    assert.equal(filingRefusal(item as any), null, `${what} is accepted`);
    const created = await engine.execute(operator, 'create', null, item, randomUUID());
    assert.equal(created.type, item.type);
    const proofs = item.criteria.flatMap(criterion => criterion.proofs).filter(proof => proof.startsWith('e2e:'));
    assert.ok(proofs.length, `${what} names an e2e proof`);
    for (const proof of proofs) assert.ok(existsSync(join('e2e', 'cases', `${proof.slice('e2e:'.length)}.json`)), `${what} names a case that exists on the head: ${proof}`);
  }
});

test('unit:self-filed-items-name-a-case — onboarding writes a serve declaration and a first runnable case, including an empty cases directory, and preserves them on rerun', async () => {
  const policy = { mode: 'local' as const, mergeGate: { preMerge: [], perCandidate: [] }, candidateSchedule: null, deploy: { adapter: 'command' as const, project: null, uat: null, production: null } };
  for (const emptyDirectory of [false, true]) {
    const root = await temporaryDirectory('onboarding-first-case');
    if (emptyDirectory) await mkdir(join(root, 'e2e/cases'), { recursive: true });
    const applied = await applyDelivery(root, policy, 'node');
    assert.equal(applied.firstCase, 'e2e/cases/served-head.json');
    assert.equal(applied.wroteServe, true);
    assert.equal(await onboarding.onboardingFirstCase(root), 'served-head');
    const config = JSON.parse(await readFile(join(root, 'graphyard.json'), 'utf8'));
    setRepositoryPolicy({ ...defaultRepositoryPolicy, ...config });
    const request = onboardingWorkRequest(sha('d'), ['test'], 'served-head');
    assert.equal(filingRefusal(request), null);
    await engine.execute(operator, 'create', null, request, randomUUID());
    const results = await runTrialE2eCases({ worktree: root, mergeSha: sha('d'), proofs: ['e2e:served-head'], env: { PATH: process.env.PATH! }, scratch: root, budgetMs: 30_000, holds: async path => existsSync(join(root, path)), log: () => {} });
    assert.equal(results[0]?.failed, 0, JSON.stringify(results));
    assert.equal(results[0]?.executed, 1);
    const rerun = await applyDelivery(root, policy, 'node');
    assert.equal(rerun.firstCase, null);
    assert.equal(rerun.wroteServe, false);
    assert.deepEqual(rerun.applied, []);
  }
});

test('unit:self-filed-items-name-a-case — onboarding preserves a repository\'s own serve and existing case', async () => {
  const root = await temporaryDirectory('onboarding-existing-case');
  await mkdir(join(root, 'e2e/cases'), { recursive: true });
  await writeFile(join(root, 'e2e/cases/existing.json'), '{}');
  await writeFile(join(root, 'graphyard.json'), JSON.stringify({ e2e: servePolicy.e2e }));
  const policy = { mode: 'local' as const, mergeGate: { preMerge: [], perCandidate: [] }, candidateSchedule: null, deploy: { adapter: 'command' as const, project: null, uat: null, production: null } };
  const applied = await applyDelivery(root, policy, 'node');
  assert.equal(applied.wroteServe, false);
  assert.equal(applied.firstCase, null);
  assert.equal(await onboarding.onboardingFirstCase(root), 'existing');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'graphyard.json'), 'utf8')).e2e.serve, servePolicy.e2e.serve);
});

test('unit:self-filed-items-name-a-case — a follow-up in another repository reuses the delivered application cases', () => {
  const item = postMergeFollowUp({ ...delivered, criteria: [{ id: 'AC-1', text: 'The application works', proofs: ['e2e:application-home', 'unit:works'] }] }, sha('e'), finding, 0);
  assert.deepEqual(item.criteria[0].proofs, ['unit:post-merge-follow-up-1', 'e2e:application-home']);
});
