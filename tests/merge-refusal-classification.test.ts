import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { GuardRefusalError, StaleCarriedApprovalError, assertMergeCandidate, assertMergeProtection, assertQueuedLanding, mergeWork, repostCarriedApproval } from '../src/master/merge.js';
import type { MasterConfig } from '../src/master/profiles.js';
import { mergeStep, repeatedMergeRefusalMs } from '../src/daemon/cycle-delivery.js';
import { candidateKey } from '../src/daemon/reconcile.js';
import { emptyDaemonState } from '../src/daemon/state.js';
import type { Cycle } from '../src/daemon/cycle.js';
import { neededDecision } from '../src/daemon/decisions.js';
import type { Evidence, Observation, Principal, Work } from '../src/model.js';

// GY-904: only a typed, deterministic guard refusal may reach the repeated-refusal handling that
// clears a carry or asks for rework. Transport, credential and control-plane failures stay
// retryable operational failures on the ordinary merge backoff, so a stable outage never ejects
// an otherwise valid candidate for a rework no implementation change could repair. Each test is
// named for the boundary it pins.

const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const at = '2026-09-28T08:00:00.000Z';
const config = { repository: 'owner/project', baseBranch: 'main' } as MasterConfig;
const validProtection = { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };

function work(overrides: Partial<Work> = {}) {
  const candidate = { sha: sha40('a1'), baseSha: sha40('b1'), pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' };
  const queue = { sequence: 1, enqueuedAt: at, policyRevision: 1,
    speculation: { ref: 'refs/graphyard/queue/gy-42', tip: candidate.sha, base: candidate.baseSha, baseTree: sha40('e1'), predecessors: [], policyRevision: 1, publishedAt: at } };
  return { id: 'work-id', key: 'GY-42', queue, title: 'Refusal classification', description: '', type: 'chore', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['integration:x'] }], policy: { checks: ['test'], review: true }, plannedFiles: [], stage: 'merge', revision: 9, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 1, lease: null, workspaces: [], candidate, submission: { epoch: 1, pr: 42 }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [{ name: 'merge', passed: true, reasons: [] }], violations: [], mergeAuthorization: { sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1, at }, ...overrides } as Work;
}

const observed = (work: Work) => ({ at: new Date().toISOString(), candidate: { sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, pr: 42, branch: 'graphyard/gy-42-1', author: 'worker' } } as any);

test('unit:guard-refusals-typed — every deterministic refusal the guarded merge gives is a GuardRefusalError, and a StaleCarriedApprovalError is one of them', async () => {
  assert.ok(new StaleCarriedApprovalError('gone') instanceof GuardRefusalError);
  // A candidate without a current all-gates-passing authorization, and one whose pull request
  // still requires conversation resolution, are refused by the record itself.
  assert.throws(() => assertMergeCandidate(work({ mergeAuthorization: null })), (error: unknown) => error instanceof GuardRefusalError && /does not have a current all-gates-passing merge authorization/.test((error as Error).message));
  assert.throws(() => assertMergeProtection({ ...validProtection, required_status_checks: { ...validProtection.required_status_checks, strict: true } }, config, work()), (error: unknown) => error instanceof GuardRefusalError && /requires branches to be up to date/.test((error as Error).message));
  assert.throws(() => assertMergeProtection({ ...validProtection, enforce_admins: { enabled: false } }, config, work()), (error: unknown) => error instanceof GuardRefusalError && /protection changed/.test((error as Error).message));
  // A candidate with no published merge-queue tip, and one whose base advanced outside the queue.
  await assert.rejects(assertQueuedLanding(work({ queue: null }), { sha: sha40('a1'), baseSha: sha40('b1') }, 'main', 'owner/project', (() => '{}') as never), (error: unknown) => error instanceof GuardRefusalError && /no published merge-queue tip/.test((error as Error).message));
  const moved = work();
  const reads = [JSON.stringify({ object: { type: 'commit', sha: sha40('99') } }), JSON.stringify({ commit: { tree: { sha: sha40('77') } } })];
  await assert.rejects(assertQueuedLanding(moved, { sha: moved.candidate!.sha, baseSha: moved.candidate!.baseSha }, 'main', 'owner/project', (() => reads.shift()!) as never),
    (error: unknown) => error instanceof GuardRefusalError && /advanced outside the merge queue/.test((error as Error).message));
});

test('unit:guard-refusals-typed — a carried approval never re-posts over a changed verdict, and that refusal is typed', async () => {
  const work = { key: 'GY-2', candidate: { sha: sha40('d1'), baseSha: sha40('b1'), pr: 2, branch: 'graphyard/gy-2-1', author: 'worker' } } as Work;
  const carried = { carried: true as const, provider: 'github' as const, reviewer: 'graphyard-reviewer[bot]', sha: sha40('a1'), reviewId: 900, originalSha: sha40('a1'), reason: 'carried' };
  const reviews = [{ id: 900, user: { login: 'graphyard-reviewer[bot]' }, commit_id: sha40('a1'), state: 'DISMISSED' }, { id: 902, user: { login: 'graphyard-reviewer[bot]' }, commit_id: sha40('d1'), state: 'CHANGES_REQUESTED' }];
  const error = await repostCarriedApproval({ repository: 'owner/project', reviewer: { slug: 'graphyard-reviewer', appId: 77, installationId: 78, credentialFile: '/x', boundAt: at } } as MasterConfig, work, carried,
    { run: () => JSON.stringify(reviews), mint: async () => ({ token: 't' }), fetcher: (async () => { throw new Error('nothing may be posted'); }) as unknown as typeof fetch }).catch((error: unknown) => error);
  assert.ok(error instanceof GuardRefusalError && !(error instanceof StaleCarriedApprovalError), String(error));
  assert.match((error as Error).message, /requested changes after approving/);
});

// A fake store for the merge step, as tests/master.test.ts brokers it: every read returns the
// item, shaped by `override` for that numbered read (the record may move between reads).
function broker(item: Work, override: (read: number) => Partial<Work> = () => ({})) {
  let reads = 0;
  const snapshot = async () => ({ work: [{ ...item, ...override(++reads) }], now: new Date(Date.now() + reads * 1000).toISOString() });
  const enqueue = async (latest: Work, authorization: { sha: string }) => ({ enqueue: { sha: authorization.sha, at: new Date().toISOString() }, key: latest.key });
  return { snapshot, enqueue };
}
const githubReads = (candidate: Work) => (_command: string, args: string[]) => {
  if (args[1] === 'view') return JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefName: 'main', state: 'OPEN', isDraft: false });
  if (args[1]?.includes('/git/ref/heads/')) return JSON.stringify({ object: { type: 'commit', sha: candidate.candidate!.baseSha } });
  throw new Error(`the merge step makes no other GitHub call: ${args.join(' ')}`);
};

test('unit:guard-refusals-typed — the broker judges the candidate on GitHub and refuses typed, while a GitHub read that fails throws an operational error the loop retries', async () => {
  const candidate = work({ observation: observed(work()) });
  // A pull request retargeted off the managed base is a judgement about the candidate: typed.
  const retargeted = broker(candidate);
  await assert.rejects(mergeWork(config, candidate, retargeted.snapshot, retargeted.enqueue, () => JSON.stringify({ headRefOid: candidate.candidate!.sha, baseRefName: 'release', state: 'OPEN', isDraft: false })),
    (error: unknown) => error instanceof GuardRefusalError && /changed on GitHub before merge/.test((error as Error).message));
  // A gate that fails between the GitHub read and the request is the record's judgement: typed.
  const escalated = broker(candidate, read => read > 1 ? { escalations: [{ trigger: 'security-concern', reason: 'Unreviewed dependency change', at: new Date().toISOString(), actor: 'product-lead' }] } as Partial<Work> : {});
  await assert.rejects(mergeWork(config, candidate, escalated.snapshot, escalated.enqueue, githubReads(candidate)),
    (error: unknown) => error instanceof GuardRefusalError && /no longer qualifies/.test((error as Error).message));
  // `gh` itself failing — the same 503 on every attempt — is no judgement at all: the error stays
  // operational, so the loop keeps it on the merge backoff and never acts on it as a refusal.
  const outage = broker(candidate);
  const failed = await mergeWork(config, candidate, outage.snapshot, outage.enqueue, () => { throw new Error('gh: could not read repos/owner/project/pulls/42 (HTTP 503)'); }).catch((error: unknown) => error);
  assert.ok(failed instanceof Error && !(failed instanceof GuardRefusalError), String(failed));
  assert.match((failed as Error).message, /HTTP 503/);
});

// ---- Engine integration: a real Postgres, the daemon boundary ----------------------------------

const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'agent-a', role: 'worker' };
const producer: Principal = { id: 'ci-runner', role: 'producer', proofs: ['unit:queue', 'integration:docs'] };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let pr = 700;
before(async () => {
  const port = Number(process.env.GRAPHYARD_REFUSAL_CLASS_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1001);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-refusal-class-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project'); engine.controlPlaneAppId = 1234;
});
after(async () => { if (store) await store.close(); if (database) await database.stop(); });

const reload = async (work: Work) => (await store.list()).find(item => item.id === work.id)!;
const treeOf = (sha: string) => sha40(`7${sha.slice(0, 2)}`);
async function submitted(title = 'Refusal class') {
  let work = await engine.execute(operator, 'create', null, { title, plannedFiles: ['src/queue.ts'], criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:queue', 'integration:docs'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'machine-a', path: `/tmp/refusal/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-1` }, randomUUID());
  return engine.execute(worker, 'submit', work.id, { epoch: 1, pr: ++pr }, randomUUID());
}
function tip(work: Work, candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { ...candidate, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ id: 41, reviewer: 'graphyard-reviewer[bot]', sha: candidate.sha, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: treeOf(candidate.baseSha), baseTipContained: true,
    files: ['src/queue.ts'], scopeFiles: [], at: new Date().toISOString(), ...extra };
}
async function validated(work: Work, candidate: { sha: string; baseSha: string }) {
  let observed = await engine.observe(work.id, work.revision, tip(work, candidate));
  observed = await engine.execute(producer, 'evidence', observed.id, { proof: 'unit:queue', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1, result: 'pass', executed: 3, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['src/queue.ts'] }, randomUUID());
  return engine.execute(producer, 'evidence', observed.id, { proof: 'integration:docs', sha: candidate.sha, baseSha: candidate.baseSha, policyRevision: 1, result: 'pass', executed: 2, skipped: 0, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, scopeFiles: ['docs/'] }, randomUUID());
}

test('unit:operational-merge-failure-not-acted — a guarded merge failing on a stable transport error past ten minutes is retried on the backoff and never forces rework; the same reason typed as a guard refusal is acted on once', async () => {
  const main = sha40('61'), headA = sha40('62');
  let item = await submitted('Operational outage');
  item = await validated(item, { sha: headA, baseSha: main });
  // The loop's view: every gate passes, so the guarded merge is retried on its short pause.
  const view = (work: Work) => ({ ...work, stage: 'merge', gates: work.gates.map(entry => ({ ...entry, passed: true, reasons: [] })), violations: [] }) as Work;
  let clock = Date.parse('2031-05-01T09:00:00Z');
  const master = { url: 'https://graphyard.example', repository: 'owner/project', autoMerge: true } as MasterConfig;
  const state = emptyDaemonState(master);
  const reported: { reason: string; since: string }[] = [];
  const outage = 'gh: could not read repos/owner/project/pulls (HTTP 503)';
  const guard = `${item.key} merge refused: the base branch main advanced outside the merge queue`;
  let failure: Error = new Error(outage);
  const effects = {
    snapshot: async () => ({ work: [view(await reload(item))], now: new Date(clock).toISOString() }),
    persist: async () => {},
    merge: async (): Promise<unknown> => { throw failure; },
    refuseMerge: async (work: Work, text: string, since: string) => { reported.push({ reason: text, since }); return engine.execute({ id: 'master', role: 'coordinator' }, 'mergerefused', work.id, { sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: work.policyRevision, reason: text, since }, randomUUID()); },
  };
  const cycle = async () => {
    state.cycle++;
    const open = [view(await reload(item))], performed: Cycle['performed'] = [];
    await mergeStep({ config: master, state, effects, now: () => clock, performed, open, isolate: async (_kind: unknown, _item: unknown, _name: unknown, body: () => Promise<unknown>) => body() } as unknown as Cycle);
    return performed;
  };
  const repeated = () => Object.entries(state.actions).filter(([key]) => key.includes(':repeated'));
  const start = clock;
  // Ten minutes of the same operational failure: attempts accumulate on the backoff, but nothing
  // is reported to the control plane and no rework decision is armed.
  while (clock - start < repeatedMergeRefusalMs + 5 * 61_000) { await cycle(); clock += 61_000; }
  assert.deepEqual([reported.length, repeated().length], [0, 0], 'an operational outage is never acted on as a refusal');
  const attempts = state.actions[candidateKey('merge', view(item))].attempts;
  assert.ok(attempts > 5, `the merge is retried on the backoff (${attempts} attempts)`);
  item = await reload(item);
  assert.equal(item.mergeRefusal, undefined, 'the candidate is never marked for rework over an outage');

  // The outage ends and the gate itself refuses, typed: the same bound now applies to the
  // refusal's own reason, and the loop acts on it without a hand action.
  failure = new GuardRefusalError(guard);
  const typedAt = clock;
  while (!reported.length && clock - typedAt < 2 * repeatedMergeRefusalMs) { await cycle(); clock += 61_000; }
  assert.equal(reported.length, 1, 'a typed guard refusal past ten minutes is reported once');
  assert.match(reported[0].reason, new RegExp(guard.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(reported[0].since, new Date(typedAt).toISOString(), 'the refusal is dated from the first typed attempt that gave this reason');
  const [attention] = repeated();
  assert.equal(attention[1].kind, 'escalation'); assert.equal(attention[1].state, 'done');
  assert.match(attention[1].detail, /marks candidate .* for a rework decision the approver judges/);
  item = await reload(item);
  assert.deepEqual([item.mergeRefusal?.action, item.mergeRefusal?.sha], ['rework', headA]);
  const decision = neededDecision(item, { autoMerge: true });
  assert.deepEqual([decision?.action, decision?.binding], ['rework', `${headA}:merge-refused`]);
  // Acted on once for this candidate and reason.
  for (let pass = 0; pass < 3; pass++) { await cycle(); clock += 61_000; }
  assert.equal(reported.length, 1);
});
