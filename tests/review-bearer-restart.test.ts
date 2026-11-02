import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import type { Work } from '../src/model.js';
import type { AgentRegistry, FleetSession } from '../src/model/registry.js';
import { settleSessions } from '../src/model/registry-sessions.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

const H = 'a'.repeat(40), B = 'b'.repeat(40), M = 'c'.repeat(40);
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const fresh = () => randomBytes(32).toString('hex');
const now = () => new Date().toISOString();
const expiresAt = () => new Date(Date.now() + 3_600_000).toISOString();
function item(key: string): Work {
  const candidate = { sha: H, baseSha: B, pr: 7, branch: 'graphyard/gy-7-1', author: 'implementer' };
  return { id: randomUUID(), key, title: key, description: '', type: 'feature', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works'] }], policy: { checks: ['test'], review: true },
    stage: 'review', revision: 3, policyRevision: 1, createdAt: now(), updatedAt: now(), stageEnteredAt: now(), ready: true, epoch: 1, lease: null,
    workspaces: [], candidate, submission: { epoch: 1, pr: 7 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['implementer'],
    observation: { source: 'control-plane', at: now(), candidate, checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
      files: ['src/example.ts'], baseTip: B, baseTipContained: true },
  } as Work;
}

test('integration:review-bearer-restart — original launch bearers survive a real server process restart and retain only their original authority', async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 195;
  const pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('review-bearer-restart-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  let store: Store | undefined, child: ChildProcess | undefined, url = '';
  const database = `postgres://graphyard:testing-only@127.0.0.1:${port}/review_restart`;
  async function start() {
    child = fork(new URL('./helpers/review-restart-server.ts', import.meta.url), [database], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const [ready] = await once(child, 'message'); url = ready.url; return ready.pid as number;
  }
  async function stop() { const exited = once(child!, 'exit'); child!.send('stop'); await exited; child = undefined; }
  async function post(token: string, path: string, body: unknown) {
    const response = await fetch(`${url}/api/work/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
  const read = async (work: Work) => (await store!.pool.query('SELECT document FROM work_items WHERE id=$1', [work.id])).rows[0].document as Work;
  const put = async (work: Work) => store!.pool.query('INSERT INTO work_items(id,document) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET document=$2', [work.id, JSON.stringify(work)]);
  const launch = (token: string, extra = {}) => ({ reviewer: 'reviewer', head: H, baseTip: B, tokenHash: hash(token), expiresAt: expiresAt(), ...extra });
  const verdict = (token: string, sha = H) => ({ token, sha, event: 'APPROVE', body: 'AC-1 met.' });
  try {
    await pg.initialise(); await pg.start(); await pg.createDatabase('review_restart');
    store = new Store(database); await store.init();
    const firstPid = await start();
    const ordinary = item('GY-1'), delivered = item('GY-2'), spec = item('GY-3');
    delivered.stage = 'done'; delivered.delivery = { mergeSha: M, mergedAt: now(), authorizationRevision: 1 }; delivered.postMergeReview = 'owed';
    for (const work of [ordinary, delivered, spec]) await put(work);
    const ordinaryToken = fresh(), deliveredToken = fresh(), specToken = fresh();
    assert.equal((await post('restart-test-master', `${ordinary.id}/review-launch`, launch(ordinaryToken))).status, 200);
    assert.equal((await post('restart-test-master', `${delivered.id}/review-launch`, launch(deliveredToken, { head: M, postMerge: true }))).status, 200);
    assert.equal((await post('restart-test-master', `${spec.id}/spec-check-launch`, { reviewer: 'checker', tokenHash: hash(specToken), expiresAt: expiresAt(), policyRevision: 1 })).status, 200);
    await stop(); assert.notEqual(await start(), firstPid, 'HTTP server is a new OS process using the same real Postgres');
    assert.equal((await post(ordinaryToken, `${ordinary.id}/review-verdict`, verdict(ordinaryToken, M))).status, 409, 'restart recovered authentication; the wrong head still fails');
    assert.equal((await post(ordinaryToken, `${ordinary.id}/review-verdict`, verdict(fresh()))).status, 403, 'body token must match');
    assert.equal((await post(ordinaryToken, `${delivered.id}/review-verdict`, verdict(ordinaryToken, M))).status, 403, 'a bearer cannot post to a different launch');
    assert.equal((await post('restart-test-worker', `${ordinary.id}/review-launch`, launch(fresh()))).status, 403, 'workers cannot issue trusted launch credentials');
    assert.equal((await post(specToken, `${spec.id}/spec-check`, { token: fresh(), verdict: 'ready', paraphrase: 'Build the feature.' })).status, 403);
    assert.equal((await post(ordinaryToken, `${spec.id}/claim`, {})).status, 403, 'review token grants no worker authority');
    const approved = await post(ordinaryToken, `${ordinary.id}/review-verdict`, verdict(ordinaryToken));
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal((await post(deliveredToken, `${delivered.id}/review-verdict`, verdict(deliveredToken, M))).status, 200);
    const revised = await read(spec); revised.policyRevision = 2; await put(revised);
    assert.equal((await post(specToken, `${spec.id}/spec-check`, { token: specToken, verdict: 'ready', paraphrase: 'Build the feature.', gaps: [] })).status, 200);
    assert.equal((await read(spec)).specCheck!.policyRevision, 1, 'the check keeps the launch revision, never the newer requirements');
    assert.equal((await read(delivered)).postMergeReview, 'reviewed');
    assert.equal((await read(delivered)).stage, 'done', 'a delivered item is never reopened');
    assert.deepEqual((await read(ordinary)).observation!.reviews.map(r => [r.reviewer, r.sha, r.state]), [['reviewer', H, 'APPROVED']]);
    assert.equal((await store.pool.query("SELECT count(*) FROM events WHERE work_id=$1 AND kind='review.verdict'", [ordinary.id])).rows[0].count, '1');
    await stop(); await start();
    for (const [work, token] of [[ordinary, ordinaryToken], [delivered, deliveredToken], [spec, specToken]] as const)
      assert.equal((await post(token, `${work.id}/review-verdict`, verdict(token))).status, 401, 'spent tokens stay spent after another restart');

    // Expiry, replacement and revocation are authoritative launch facts, not a process cache.
    for (const kind of ['expired', 'replaced', 'revoked', 'implemented', 'requested'] as const) {
      const work = item(`GY-${kind}`); await put(work); const token = fresh();
      assert.equal((await post('restart-test-master', `${work.id}/review-launch`, launch(token, { ...(kind === 'expired' ? { expiresAt: new Date(Date.now() - 1000).toISOString() } : {}), ...(kind === 'implemented' ? { reviewer: 'implementer' } : {}), ...(kind === 'requested' ? { reviewer: 'master' } : {}) }))).status, 200);
      if (kind === 'replaced') assert.equal((await post('restart-test-master', `${work.id}/review-launch`, launch(fresh()))).status, 200);
      if (kind === 'revoked') { const revoked = await read(work); revoked.reviewLaunch = null; await put(revoked); }
      await stop(); await start();
      const response = await post(token, `${work.id}/review-verdict`, verdict(token));
      assert.equal(response.status, ['implemented', 'requested'].includes(kind) ? 403 : 401, `${kind}: ${JSON.stringify(response.body)}`);
      const stored = await read(work); assert.equal(stored.observation!.reviews.length, 0);
      if (kind === 'implemented' || kind === 'requested') {
        assert.ok(stored.reviewLaunch!.refused);
        assert.equal((await post(token, `${work.id}/review-verdict`, verdict(token))).status, 401, 'refusal revokes the bearer immediately');
      }
    }
    for (const kind of ['expired', 'replaced', 'revoked'] as const) {
      const work = item(`GY-spec-${kind}`); await put(work); const token = fresh();
      const registration = { reviewer: 'checker', tokenHash: hash(token), expiresAt: kind === 'expired' ? new Date(Date.now() - 1000).toISOString() : expiresAt(), policyRevision: 1 };
      assert.equal((await post('restart-test-master', `${work.id}/spec-check-launch`, registration)).status, 200);
      if (kind === 'replaced') assert.equal((await post('restart-test-master', `${work.id}/spec-check-launch`, { ...registration, tokenHash: hash(fresh()) })).status, 200);
      if (kind === 'revoked') { const revoked = await read(work); revoked.specCheckLaunch = null; await put(revoked); }
      await stop(); await start();
      assert.equal((await post(token, `${work.id}/spec-check`, { token, verdict: 'ready', paraphrase: 'Build the feature.' })).status, 401, `spec check ${kind}`);
      const unusable = await read(work);
      assert.equal(unusable.specCheck, undefined, 'a missing verdict supplies no readiness or approval');
      if (kind === 'expired' || kind === 'revoked') {
        const session = { id: kind, role: 'reviewer', work: work.key, selectedAt: new Date(Date.now() - 30 * 60_000).toISOString(), endedAt: null } as FleetSession;
        const registry = { sessions: [session] } as AgentRegistry;
        assert.equal(settleSessions(registry, [unusable], now()).length, 1, 'normal reconciliation releases an unusable checker');
        assert.ok(session.endedAt);
        assert.equal((await read(work)).specCheck, undefined, 'releasing capacity never manufactures a verdict');
      }
    }
    assert.equal((await post(fresh(), `${ordinary.id}/review-verdict`, verdict(fresh()))).status, 401);
  } finally { if (child) await stop(); if (store) await store.close(); await pg.stop(); }
});
