import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import type { Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { evaluateLandability } from '../src/model/landability.js';
import { reconcileAutoDispatch } from '../src/model/dispatch.js';
import { foldMergeLedger, mergeTrialKind } from '../src/model/merge-ledger.js';
import type { Observation, Work } from '../src/model/work.js';

// GY-1528: mode parity. One fixture item runs through evaluate (the landability verdict, and the
// engine's own submit operation below) and dispatch (the auto-dispatch reconciliation). Under the github merger its
// outputs equal the snapshot recorded on this head, so the old gates stay exactly as they were
// until their code is deleted; under the control-plane merger each switched behaviour is named.

const at = Date.parse('2030-06-01T00:00:00Z');
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const head = sha('parity-head'), base = sha('parity-base');

function fixture(source: 'control-plane' | null): Work {
  const candidate = { sha: head, baseSha: base, pr: 7, branch: 'graphyard/gy-1-1', author: 'worker' };
  const scoped = (path: string) => ({ path, status: 'modified' as const, sha: sha(path), baseSha: sha(`base:${path}`), additions: 1, deletions: 1, binary: false });
  const observation = { ...(source ? { source } : {}), candidate, checks: [{ name: 'test', result: 'success', appId: 15368 }], reviews: [], merged: false, mergeSha: null,
    mergeable: true, protected: true, files: ['src/app.ts', 'src/other.ts'], at: new Date(at).toISOString(), baseTip: base, scopeFiles: ['src/app.ts', 'src/other.ts'].map(scoped) } as unknown as Observation;
  const ledger = foldMergeLedger([
    { kind: 'merge.intent', payload: { key: 'GY-1', head, baseTip: base, mergeSha: sha('parity-merge'), risk: 'normal', at: new Date(at).toISOString() } },
    { kind: mergeTrialKind, payload: { head, baseTip: base, mergeSha: sha('parity-merge'), proofs: { 'unit:item-works': { executed: 3, failed: 0 }, 'integration:item-holds': { executed: 1, failed: 0 } } } },
  ])['GY-1'];
  return {
    id: 'parity', key: 'GY-1', title: 'parity fixture', type: 'feature', description: '', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works', 'integration:item-holds', 'manual:item-looks', 'e2e:item-ships'] }],
    policy: { checks: ['test'], review: true }, stage: 'build', revision: 3, policyRevision: 1, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: 'graphyard/gy-1-1', epoch: 1, owner: 'worker' }], submission: { epoch: 1, pr: 7 }, candidate, reworkRequested: false,
    scenarioRequirements: [], blocker: null, gates: [], violations: [], createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(), stageEnteredAt: new Date(at).toISOString(),
    evidence: [{ id: 'e1', proof: 'unit:item-works', result: 'fail', trusted: true, executed: 3, skipped: 0, failed: 1, producer: 'producer-a', sha: head, baseSha: base, policyRevision: 1, at: new Date(at).toISOString() }],
    autoDispatch: { review: null, history: [], producers: [{ id: 'p1', kind: 'producer', group: 'unit', proofs: ['integration:item-holds'], sha: head, baseSha: base, policyRevision: 1, requestedAt: new Date(at).toISOString(), state: 'requested', reason: 'prove it' }] },
    observation, mergeLedger: ledger,
  } as unknown as Work;
}

/** The fixture through evaluate and dispatch, as plain data. */
function run(source: 'control-plane' | null) {
  const work = fixture(source), now = new Date(at);
  const verdict = evaluateLandability(work, [work], now);
  const evaluate = verdict.verdict === 'refused' ? verdict.reasons : [];
  const dispatched = structuredClone(work);
  const dispatch = reconcileAutoDispatch(dispatched, [dispatched], now).map(entry => ({ event: entry.event, kind: entry.request.kind, resolution: entry.request.resolution ?? null }));
  return { evaluate, dispatch, producers: dispatched.autoDispatch!.producers.length };
}

/** The github-mode outputs, recorded on this head (GY-1528). */
const recorded = {
  evaluate: [
    { gate: 'build', reason: `AC-1: unit:item-works failed on ${head.slice(0, 12)} (trusted evidence from producer-a); the head returns to its worker before review` },
    { gate: 'acceptance', reason: 'AC-1: unit:item-works needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy' },
    { gate: 'acceptance', reason: 'AC-1: integration:item-holds needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy' },
    { gate: 'acceptance', reason: 'AC-1: manual:item-looks needs trusted passing evidence, with skipped = 0, for this candidate and policy' },
    { gate: 'acceptance', reason: 'AC-1: e2e:item-ships needs trusted passing evidence, with executed > 0 and skipped = 0, for this candidate and policy' },
  ],
  dispatch: [
    { event: 'dispatch.requested', kind: 'review', resolution: null },
    { event: 'dispatch.satisfied', kind: 'producer', resolution: 'trusted evidence failed for unit:item-works (producer-a); the next head is requested afresh' },
  ],
  producers: 0,
};

test('unit:mode-parity-github-snapshot — under the github merger the fixture\'s evaluate and dispatch outputs equal the snapshot recorded on this head; under the control-plane merger each switched behaviour is named', () => {
  assert.deepEqual(run(null), recorded);
  const switched = run('control-plane');
  const named: Record<string, boolean> = {
    'producer evidence: the stray producer failure refuses no build': !switched.evaluate.some(entry => /trusted evidence from/.test(entry.reason)),
    'acceptance from the merge ledger trial: unit and integration proofs pass on its counts': !switched.evaluate.some(entry => /unit:|integration:/.test(entry.reason)),
    'manual attestations only for sensitive risk, e2e judged by the trial like unit and integration (GY-2965)': !switched.evaluate.some(entry => /manual:/.test(entry.reason)),
    'producer sessions: the standing request is withdrawn and none is opened': switched.producers === 0 && switched.dispatch.filter(entry => entry.kind === 'producer').every(entry => entry.event === 'dispatch.cancelled'),
  };
  for (const [behaviour, holds] of Object.entries(named)) assert.ok(holds, `control-plane switches off ${behaviour}: ${JSON.stringify(switched)}`);
});

// ---- The engine's own submit, in both modes -------------------------------------------------------

const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let pg: EmbeddedPostgres | undefined, store: Store | undefined, fixtureRoot: string | undefined;
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

/** A coordinator-like checkout whose base holds src/app.ts and src/other.ts, and a worker head in its object store that changes both. */
async function checkoutWithHead(root: string, branch: string) {
  const origin = join(root, 'origin.git'), checkout = join(root, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  const write = async (cwd: string, files: Record<string, string>, message: string) => {
    for (const [path, text] of Object.entries(files)) { await mkdir(join(cwd, path, '..'), { recursive: true }); await writeFile(join(cwd, path), text); git(cwd, 'add', '--', path); }
    git(cwd, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', message);
    return git(cwd, 'rev-parse', 'HEAD');
  };
  await write(checkout, { 'src/app.ts': 'export const app = 1;\n', 'src/other.ts': 'export const other = 1;\n' }, 'base');
  git(checkout, 'push', '-q', 'origin', 'main');
  const worktree = join(checkout, '.graphyard', 'worktrees', 'parity');
  git(checkout, 'worktree', 'add', '-q', '-b', branch, worktree);
  const changed = await write(worktree, { 'src/app.ts': 'export const app = 2;\n', 'src/other.ts': 'export const other = 2;\n' }, 'change');
  return { checkout, head: changed, baseTip: git(checkout, 'rev-parse', 'refs/remotes/origin/main') };
}

test('unit:mode-parity-github-snapshot — the engine\'s own submit of the fixture: under the control-plane merger it accepts the head the shared object store holds', async () => {
  fixtureRoot = await realpath(await temporaryDirectory('mode-parity'));
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1528;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('mode-parity-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('mode_parity_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/mode_parity_test`); await store.init();
  const engine = new Engine(store, 120, 'owner/project');
  engine.directMergeEnvironment = null; engine.baseBranch = 'main';
  const assigned = async (branch: string) => {
    let w = await engine.execute(operator, 'create', null, { type: 'chore',  title: 'parity fixture', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:item-works'] }] }, randomUUID());
    w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
    const pulled = await engine.pullAssignment(worker, { work: w.id }, randomUUID());
    assert.equal(pulled.assigned?.id, w.id, JSON.stringify(pulled.refused));
    return engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/w/${branch}`, branch }, randomUUID());
  };

  // control-plane: the head, observed from the shared object store, is accepted.
  const branch = 'graphyard/gy-2-1';
  const repo = await checkoutWithHead(fixtureRoot, branch);
  engine.gitRunner = gitRunnerFor(repo.checkout);
  const plane = await assigned(branch);
  const submitted = await engine.execute(worker, 'submit', plane.id, { epoch: 1, head: repo.head }, randomUUID());
  assert.equal(submitted.observation?.source, 'control-plane');
  assert.deepEqual(submitted.observation?.scopeFiles?.map(file => file.path).sort(), ['src/app.ts', 'src/other.ts'], 'the observation reads the files the head changes');
  assert.deepEqual([submitted.candidate?.sha, submitted.candidate?.baseSha, submitted.submission?.epoch], [repo.head, repo.baseTip, 1], 'control-plane: the head is submitted');
});
