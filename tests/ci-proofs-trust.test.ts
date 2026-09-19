import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { ciProducerRuntime } from '../src/model/ci-proofs.js';
import { currentEvidence, type Observation, type Principal, type Work } from '../src/model.js';
// @ts-expect-error Dependency-free protected workflow script.
import { observeCiRun, publishCiReport } from '../scripts/publish-acceptance.mjs';
// @ts-expect-error Dependency-free protected workflow script.
import { planFromControlPlane } from '../scripts/enumerate-ci-proofs.mjs';
// @ts-expect-error Dependency-free protected workflow script.
import { contract } from '../scripts/contracts.mjs';

// The control plane's own trust boundary for CI-produced evidence: the CI producer principal,
// the automatable families, the job GitHub reports for the evidence commit, and attempt order.
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const ci: Principal = { id: 'ci-proofs', role: 'producer', runtime: ciProducerRuntime, proofs: ['unit:*', 'integration:*'] };
const acceptance: Principal = { id: 'trusted-acceptance', role: 'producer', proofs: ['integration:claim-safety'] };
const principals = [operator, worker, ci, acceptance];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(32)}`]));
const head = 'a'.repeat(40), base = 'b'.repeat(40), repository = 'owner/project';

let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let pullRequest = 100;
// The check runs GitHub would report, keyed by job id. Every test states what the App reads.
const checkRuns = new Map<number, Record<string, unknown>>();
let githubReads: string[] = [];
const github = {
  config: { repository, base: 'main', appId: 7001, installationId: 1, privateKey: 'unused' },
  request: async (path: string) => {
    githubReads.push(path);
    const match = path.match(/^\/check-runs\/(\d+)$/);
    const run = match && checkRuns.get(Number(match[1]));
    if (!run) throw new Error(`Not found: ${path}`);
    return structuredClone(run);
  },
  reviewRepository: async () => null, reviewPermissions: async () => ({}), permissionReport: () => null,
};
const checkRun = (jobId: number, overrides: Record<string, unknown> = {}) => ({ id: jobId, head_sha: head, status: 'completed', conclusion: 'success', name: 'integration:claim-safety', details_url: `https://github.com/${repository}/actions/runs/900/job/${jobId}`, app: { id: 15368 }, ...overrides });

before(async () => {
  const port = Number(process.env.GRAPHYARD_CI_PROOFS_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 19);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-ci-proofs-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('ci_proofs_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/ci_proofs_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository);
  http = server(engine, principals.map(p => ({ ...p, token: tokens.get(p.id)! })), github as any);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

async function call(path: string, actor: Principal, data?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${tokens.get(actor.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: data === undefined ? undefined : JSON.stringify(data) });
  return { status: response.status, body: await response.json() as any };
}
/** A submitted item whose candidate the control plane has observed at `head`. */
async function candidate(proofs = ['integration:claim-safety', 'unit:ci-proofs-enumeration', 'manual:ci-proofs-docs']) {
  let work = await engine.execute(operator, 'create', null, { title: 'CI proofs fixture', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'CI certifies the automatable proofs', proofs }] }, randomUUID()) as Work;
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'machine-a', path: `/tmp/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}` }, randomUUID());
  work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, pr: ++pullRequest }, randomUUID());
  const observation: Observation = { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null, files: ['src/changed.ts'], scopeFiles: [], at: new Date().toISOString() };
  return engine.observe(work.id, work.revision, observation);
}
const binding = (jobId: number, runId = '900', runAttempt = 1) => ({ provider: 'github-actions', repository, runId, runAttempt, jobId });
const evidence = (proof: string, jobId: number, overrides: Record<string, unknown> = {}) => ({ proof, sha: head, baseSha: base, policyRevision: 1, result: 'pass', executed: 5, skipped: 0, ciRun: binding(jobId), ...overrides });

// ---------------------------------------------------------------------------
// integration:ci-proofs-trust
// ---------------------------------------------------------------------------
test('integration:ci-proofs-trust CI evidence outside the automatable families is refused, whatever the CI producer is granted', async () => {
  const work = await candidate();
  checkRuns.set(1, checkRun(1, { name: 'manual:ci-proofs-docs' }));
  const manual = await call(`work/${work.id}/evidence`, ci, evidence('manual:ci-proofs-docs', 1));
  assert.equal(manual.status, 403); assert.match(manual.body.error, /accepted only for unit:\* and integration:\* proofs; manual:ci-proofs-docs needs a producer session/);
  // A manual:* grant made to the CI producer is inert: the lane is closed by family before authority is consulted.
  const granted = await call('proof-grants/ci-proofs/grant', operator, { patterns: ['manual:*'], reason: 'Misconfiguration under test' });
  assert.equal(granted.status, 200);
  const stillRefused = await call(`work/${work.id}/evidence`, ci, evidence('manual:ci-proofs-docs', 1));
  assert.equal(stillRefused.status, 403);
  await call('proof-grants/ci-proofs/revoke', operator, { patterns: ['manual:*'], reason: 'Restore the CI lane' });
  checkRuns.set(2, checkRun(2, { name: 'e2e:deploy-smoke' }));
  const smoke = await call(`work/${work.id}/evidence`, ci, evidence('e2e:deploy-smoke', 2));
  assert.equal(smoke.status, 403); assert.match(smoke.body.error, /e2e:deploy-smoke needs a producer session/);
  // An ungranted automatable proof is refused too, never stored untrusted.
  await call('proof-grants/ci-proofs/revoke', operator, { patterns: ['unit:*'], reason: 'Narrow the lane under test' });
  checkRuns.set(3, checkRun(3, { name: 'unit:ci-proofs-enumeration' }));
  const ungranted = await call(`work/${work.id}/evidence`, ci, evidence('unit:ci-proofs-enumeration', 3));
  assert.equal(ungranted.status, 403); assert.match(ungranted.body.error, /not granted unit:ci-proofs-enumeration/);
  await call('proof-grants/ci-proofs/grant', operator, { patterns: ['unit:*'], reason: 'Restore the CI lane' });
  const item = (await engine.store.list()).find(w => w.id === work.id)!;
  assert.equal(item.evidence.length, 0, 'a refused CI record is never stored');
});

test('integration:ci-proofs-trust only the CI producer may carry a run binding, and it must carry one', async () => {
  const work = await candidate();
  checkRuns.set(10, checkRun(10));
  const foreign = await call(`work/${work.id}/evidence`, acceptance, evidence('integration:claim-safety', 10));
  assert.equal(foreign.status, 403); assert.match(foreign.body.error, /only from the CI producer principal/);
  const untrustedWorker = await call(`work/${work.id}/evidence`, worker, evidence('integration:claim-safety', 10));
  assert.equal(untrustedWorker.status, 403);
  const { ciRun: _omitted, ...bare } = evidence('integration:claim-safety', 10);
  const unbound = await call(`work/${work.id}/evidence`, ci, bare);
  assert.equal(unbound.status, 400); assert.match(unbound.body.error, /must name the workflow job/);
  // The other producer still publishes through its own lane, unaffected.
  const session = await call(`work/${work.id}/evidence`, acceptance, bare);
  assert.equal(session.status, 200); assert.equal(session.body.evidence.at(-1).trusted, true); assert.equal(session.body.evidence.at(-1).ciRun, undefined);
});

test('integration:ci-proofs-trust the control plane reads the job back from GitHub and accepts only a completed job on the evidence commit with the claimed conclusion', async () => {
  const work = await candidate();
  githubReads = [];
  checkRuns.set(20, checkRun(20, { head_sha: 'e'.repeat(40) }));
  const elsewhere = await call(`work/${work.id}/evidence`, ci, evidence('integration:claim-safety', 20));
  assert.equal(elsewhere.status, 403); assert.match(elsewhere.body.error, /ran on eeee.*not on the evidence commit aaaa/);
  assert.deepEqual(githubReads, ['/check-runs/20']);
  checkRuns.set(21, checkRun(21, { conclusion: 'failure' }));
  const forgedPass = await call(`work/${work.id}/evidence`, ci, evidence('integration:claim-safety', 21));
  assert.equal(forgedPass.status, 403); assert.match(forgedPass.body.error, /concluded failure; a pass result/);
  checkRuns.set(22, checkRun(22, { app: { id: 99 } }));
  assert.match((await call(`work/${work.id}/evidence`, ci, evidence('integration:claim-safety', 22))).body.error, /not published by GitHub Actions/);
  checkRuns.set(23, checkRun(23, { details_url: `https://github.com/${repository}/actions/runs/901/job/23` }));
  assert.match((await call(`work/${work.id}/evidence`, ci, evidence('integration:claim-safety', 23))).body.error, /belongs to workflow run 901, not run 900/);
  checkRuns.set(24, checkRun(24, { status: 'in_progress', conclusion: null }));
  assert.match((await call(`work/${work.id}/evidence`, ci, evidence('integration:claim-safety', 24))).body.error, /has not completed/);
  const unknown = await call(`work/${work.id}/evidence`, ci, evidence('integration:claim-safety', 25));
  assert.equal(unknown.status, 503); assert.match(unknown.body.error, /could not be read from GitHub/);
  // A failing job publishes a failing record: it is trusted and it supersedes nothing it should not.
  const failed = await call(`work/${work.id}/evidence`, ci, evidence('integration:claim-safety', 21, { result: 'fail' }));
  assert.equal(failed.status, 200);
  assert.equal(failed.body.evidence.at(-1).trusted, true); assert.equal(failed.body.evidence.at(-1).result, 'fail');
  assert.deepEqual(failed.body.evidence.at(-1).ciRun, { ...binding(21), headSha: head, job: 'integration:claim-safety', conclusion: 'failure', verifiedAt: failed.body.evidence.at(-1).ciRun.verifiedAt });
  // The passing job's record is accepted, trusted, carries the verified binding, and satisfies the proof.
  checkRuns.set(26, checkRun(26));
  const accepted = await call(`work/${work.id}/evidence`, ci, evidence('integration:claim-safety', 26, { ciRun: binding(26, '900', 2) }));
  assert.equal(accepted.status, 200);
  const record = accepted.body.evidence.at(-1);
  assert.equal(record.producer, 'ci-proofs'); assert.equal(record.trusted, true);
  assert.deepEqual(record.ciRun, { ...binding(26, '900', 2), headSha: head, job: 'integration:claim-safety', conclusion: 'success', verifiedAt: record.ciRun.verifiedAt });
  const item = (await engine.store.list()).find(w => w.id === work.id)!;
  assert.equal(currentEvidence(item, 'integration:claim-safety')?.id, record.id);
  assert.ok(!item.gates.find(gate => gate.name === 'acceptance')!.reasons.some(reason => reason.includes('integration:claim-safety')));
});

test('integration:ci-proofs-trust a re-run of an older attempt cannot overwrite a newer result', async () => {
  const work = await candidate();
  checkRuns.set(30, checkRun(30, { conclusion: 'failure' })); checkRuns.set(31, checkRun(31)); checkRuns.set(32, checkRun(32, { details_url: `https://github.com/${repository}/actions/runs/901/job/32` }));
  const first = await call(`work/${work.id}/evidence`, ci, evidence('integration:claim-safety', 31, { ciRun: binding(31, '900', 2) }));
  assert.equal(first.status, 200);
  // Attempt 1 of the same run reporting after attempt 2: refused, not stored where selection would prefer it.
  const older = await call(`work/${work.id}/evidence`, ci, evidence('integration:claim-safety', 30, { result: 'fail', ciRun: binding(30, '900', 1) }));
  assert.equal(older.status, 409); assert.match(older.body.error, /older than the recorded run 900 attempt 2/);
  // The same attempt twice under a fresh idempotency key is a duplicate, not a newer result.
  const duplicate = await call(`work/${work.id}/evidence`, ci, evidence('integration:claim-safety', 31, { ciRun: binding(31, '900', 2) }));
  assert.equal(duplicate.status, 409); assert.match(duplicate.body.error, /already recorded/);
  // A later run supersedes; an earlier run then cannot come back.
  const newer = await call(`work/${work.id}/evidence`, ci, evidence('integration:claim-safety', 32, { ciRun: binding(32, '901', 1) }));
  assert.equal(newer.status, 200);
  const replay = await call(`work/${work.id}/evidence`, ci, evidence('integration:claim-safety', 31, { ciRun: binding(31, '900', 3) }));
  assert.equal(replay.status, 409); assert.match(replay.body.error, /older than the recorded run 901 attempt 1/);
  const item = (await engine.store.list()).find(w => w.id === work.id)!;
  assert.deepEqual(item.evidence.map(entry => entry.ciRun!.runId), ['900', '901']);
  assert.equal(currentEvidence(item, 'integration:claim-safety')?.ciRun?.runId, '901');
});

test('integration:ci-proofs-trust the CI producer has no capability beyond publishing CI evidence', async () => {
  const work = await candidate();
  checkRuns.set(60, checkRun(60));
  assert.equal((await call(`work/${work.id}/evidence`, ci, evidence('integration:claim-safety', 60))).status, 200);
  // Not revocation, not deployment observation, not the validation protocol — whatever its grants cover.
  const revoke = await call(`work/${work.id}/revoke`, ci, { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: 1, reason: 'Attempted by the CI lane' });
  assert.equal(revoke.status, 403); assert.match(revoke.body.error, /CI-produced evidence only; revocation/);
  const deployment = await call('production-observations', ci, { provider: 'railway' });
  assert.equal(deployment.status, 403); assert.match(deployment.body.error, /deployment observation/);
  for (const path of ['validation/artifacts', 'validation/define', 'validation/result', 'validation/reuse', 'validation/replay']) {
    const refused = await call(path, ci, {});
    assert.equal(refused.status, 403, path); assert.match(refused.body.error, /the validation protocol/);
  }
  // Reads stay open to it: the plan and the reporter need status, work and its own authority.
  assert.equal((await call('status', ci)).status, 200);
  assert.equal((await call('proof-grants', ci)).status, 200);
  // The other producer keeps every lane its role and grants allow.
  const session = await call(`work/${work.id}/revoke`, acceptance, { proof: 'integration:claim-safety', sha: head, baseSha: base, policyRevision: 1, reason: 'Withdrawn by the session producer' });
  assert.equal(session.status, 200);
});

test('integration:ci-proofs-trust CI evidence is refused when no GitHub integration can read the job', async () => {
  const port = Number(process.env.GRAPHYARD_CI_PROOFS_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 19);
  const detached = new Engine(new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/ci_proofs_test`), [15368], 120, repository);
  const offline = server(detached, principals.map(p => ({ ...p, token: tokens.get(p.id)! })), null);
  await new Promise<void>(resolve => offline.listen(0, '127.0.0.1', resolve));
  try {
    const work = await candidate();
    const response = await fetch(`http://127.0.0.1:${(offline.address() as any).port}/api/work/${work.id}/evidence`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.get('ci-proofs')}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(evidence('integration:claim-safety', 40)) });
    assert.equal(response.status, 503); assert.match((await response.json() as any).error, /GitHub integration is required to verify CI-produced evidence/);
  } finally { await new Promise<void>(resolve => offline.close(() => resolve())); await detached.store.close(); }
});

// ---------------------------------------------------------------------------
// integration:ci-proofs-workflow — the protected scripts drive the real control plane
// ---------------------------------------------------------------------------
test('integration:ci-proofs-workflow the plan, reporter and control plane agree on one candidate: evidence lands trusted with the job binding', async () => {
  const work = await candidate();
  // The scripts require a credential-free HTTPS origin; the fetcher maps it onto the test server.
  const origin = 'https://graphyard.test/';
  const controlPlane = (input: string, init?: RequestInit) => fetch(input.replace('https://graphyard.test', url), init);
  const plan = await planFromControlPlane({ url: origin, token: tokens.get('ci-proofs'), pr: work.submission!.pr, head, waitMs: 0, intervalMs: 1, fetcher: controlPlane, sleep: async () => {} });
  assert.deepEqual(plan.work, { id: work.id, key: work.key, pr: work.submission!.pr, policyRevision: 1, head, base });
  assert.deepEqual(plan.proofs.map((entry: any) => entry.proof), ['integration:claim-safety', 'unit:ci-proofs-enumeration']);
  assert.deepEqual(plan.deferred.map((entry: any) => entry.proof), ['manual:ci-proofs-docs']);
  // The exercise job's report, as prepare-acceptance.mjs and run-acceptance.mjs would write it for this plan.
  const expected = { repository, harnessCommit: 'c'.repeat(40), runId: '900', runAttempt: '1', workId: plan.work.id, pr: String(plan.work.pr), policyRevision: String(plan.work.policyRevision) };
  const report = { repository, pr: plan.work.pr, workId: plan.work.id, sha: plan.work.head, baseSha: plan.work.base, policyRevision: plan.work.policyRevision, testedTree: 'd'.repeat(40), harnessCommit: expected.harnessCommit, runId: '900', runAttempt: '1',
    schema: 1, proof: 'integration:claim-safety', result: 'pass', cases: contract('integration:claim-safety').requiredCases.map((id: string) => ({ id, result: 'pass' })), executed: 5, skipped: 0 };
  const run = { id: 900, run_attempt: 1, repository: { full_name: repository }, head_sha: head, status: 'in_progress', conclusion: null, event: 'pull_request_target' };
  const job = { id: 50, name: 'integration:claim-safety', run_attempt: 1, head_sha: head, status: 'completed', conclusion: 'success', html_url: `https://github.com/${repository}/actions/runs/900/job/50` };
  const actions = async (input: string) => new Response(JSON.stringify(input.includes('/jobs') ? { jobs: [job] } : run));
  const ci = await observeCiRun(expected, report, 'workflow-token', actions);
  checkRuns.set(50, checkRun(50));
  await publishCiReport(report, { url: origin, token: tokens.get('ci-proofs'), expected: { ...expected, proof: report.proof }, ci }, controlPlane);
  const item = (await engine.store.list()).find(w => w.id === work.id)!;
  const record = currentEvidence(item, 'integration:claim-safety')!;
  assert.equal(record.producer, 'ci-proofs'); assert.equal(record.trusted, true);
  assert.equal(record.url, `https://github.com/${repository}/actions/runs/900/attempts/1`);
  assert.deepEqual(record.artifacts, [{ kind: 'log', label: 'GitHub Actions job integration:claim-safety', availability: 'external', url: job.html_url }]);
  assert.deepEqual(record.ciRun, { provider: 'github-actions', repository, runId: '900', runAttempt: 1, jobId: 50, headSha: head, job: 'integration:claim-safety', conclusion: 'success', verifiedAt: record.ciRun!.verifiedAt });
  // Publishing the same attempt again is idempotent through the reporter's key, not a second record.
  await publishCiReport(report, { url: origin, token: tokens.get('ci-proofs'), expected: { ...expected, proof: report.proof }, ci }, controlPlane);
  assert.equal((await engine.store.list()).find(w => w.id === work.id)!.evidence.length, 1);
});
