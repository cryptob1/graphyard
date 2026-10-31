import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { proofPreview } from '../src/coordination.js';
import { neededRework } from '../src/daemon/rework.js';
import { mergeQueue } from '../src/merge-writer/executor.js';
import { evaluate } from '../src/model/gates.js';
import { dueHumanProofs, humanProofRows, physicalCheckRefusal } from '../src/model/human-proof.js';
import type { HumanRequestRow } from '../src/model/human-request.js';
import { actionAccount, nextAction } from '../src/model/next-action.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-2986: a human: proof holds a head until a person's answer on Needs you proves it for that
// exact commit. Driven over a real control plane: the loop's request, the person's answer.

const H = 'a'.repeat(40), B = 'b'.repeat(40), H2 = 'd'.repeat(40);
const proof = 'human:receipt-prints';
const text = 'A receipt prints on the shop printer';
const human: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const agentAdmin: Principal = { id: 'agent-admin', role: 'admin', sessionKind: 'ai' };
const loop: Principal = { id: 'graphyard-master', role: 'coordinator' };
const credentials = [human, agentAdmin, loop].map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const tokenOf = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;

let pg: EmbeddedPostgres, store: Store, http: ReturnType<typeof server>, url: string;
before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 2986;
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('human-proof-pg'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('human_proof_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/human_proof_test`); await store.init();
  const engine = new Engine(store, 120, 'owner/project'); engine.submissionObserver = null; engine.directMergeEnvironment = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pg) await pg.stop(); });

async function post(principal: Principal, path: string, body: unknown, key = randomUUID()) {
  const response = await fetch(`${url}/api/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${tokenOf(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}
const rows = async (id: string) => {
  const response = await fetch(`${url}/api/human-requests`, { headers: { Authorization: `Bearer ${tokenOf(human)}` } });
  return ((await response.json() as { requests: HumanRequestRow[] }).requests).filter(row => row.id === id);
};
const stored = async (id: string) => {
  const work = (await store.pool.query('SELECT document FROM work_items WHERE id=$1', [id])).rows[0].document as Work;
  return work;
};
const head = (sha: string) => ({ sha, baseSha: B, pr: 0, branch: 'graphyard/gy-1-1', author: 'worker-1' });
const observation = (sha: string) => ({ source: 'control-plane', at: new Date().toISOString(), candidate: head(sha), checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: false,
  files: ['docs/notes.md'], scopeFiles: [{ path: 'docs/notes.md', status: 'modified', sha: 'e'.repeat(40), additions: 1, deletions: 0, binary: false }], baseTip: B, baseTipContained: true, mergeBase: B });
/** A submitted, observed head whose only owed thing is the person's check. */
async function submitted(key: string): Promise<Work> {
  const now = new Date().toISOString();
  const work = { id: randomUUID(), key, title: `Item ${key}`, description: 'No user-facing change: a test item.', type: 'chore', priority: 1, dependencies: [],
    criteria: [{ id: 'AC-1', text, proofs: [proof] }], policy: { checks: ['test'], review: true }, stage: 'review', revision: 3, policyRevision: 1, createdAt: now, updatedAt: now, stageEnteredAt: now, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'h', path: '/w', branch: 'graphyard/gy-1-1', epoch: 1, owner: 'worker-1' }], candidate: head(H), submission: { epoch: 1, pr: 0 }, reworkRequested: false,
    scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [], implementers: ['worker-1'], observation: observation(H) } as unknown as Work;
  Object.assign(work, evaluate(work, [work], new Date()));
  await store.pool.query('INSERT INTO work_items(id, document) VALUES ($1,$2)', [work.id, JSON.stringify(work)]);
  return work;
}
const reasons = (work: Work) => work.gates.find(gate => gate.name === 'review')!.reasons;

test('unit:human-proof-request-and-answer — create refuses a human: proof whose criterion names nothing physical', async () => {
  assert.match(physicalCheckRefusal([{ id: 'AC-1', text: 'The wording feels right', proofs: [proof] }])!, /^AC-1 names a human: proof but nothing physical/);
  assert.equal(physicalCheckRefusal([{ id: 'AC-1', text, proofs: [proof] }]), null);
  const refused = await post(human, 'work', { title: 'Check', type: 'chore', criteria: [{ id: 'AC-1', text: 'Should we ship this', proofs: [proof] }], policy: { checks: ['test'], review: true } });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body), /nothing physical/);
  const filed = await post(human, 'work', { title: 'Check', type: 'chore', criteria: [{ id: 'AC-1', text, proofs: [proof] }], policy: { checks: ['test'], review: true } });
  assert.equal(filed.status, 200, JSON.stringify(filed.body));
  assert.deepEqual(filed.body.proofGaps, [], 'no producer is owed for a person\'s check');
});

test('unit:human-proof-request-and-answer — the head waits at its gate with one Needs you request naming the steps and commit; a pass proves it for that commit and the item merges', async () => {
  const work = await submitted('GY-9101');
  assert.deepEqual(reasons(work), [`${proof} waits for a person's pass on Needs you for commit ${H.slice(0, 12)}`]);
  assert.equal(actionAccount(work, [work], new Date()).wait?.kind, 'human', 'the wait is a person\'s, not a review to request');
  assert.deepEqual(mergeQueue([work], {}, Date.now()).due, [], 'the merge writer leaves the head alone');
  assert.deepEqual(dueHumanProofs(work), [proof], 'the loop owes the request');

  const body = { proof, sha: H, baseSha: B, url: 'https://preview.example/GY-9101/' };
  assert.equal((await post(loop, `work/${work.id}/human-proof-request`, body)).status, 200);
  assert.equal((await post(loop, `work/${work.id}/human-proof-request`, body)).status, 200);
  const [row, ...others] = await rows(work.id);
  assert.equal(others.length, 0, 'the same check asked again is one request');
  assert.equal(row.request.ask, text);
  assert.deepEqual(row.request.steps, [`Open ${body.url}`, `Make this check on commit ${H.slice(0, 12)}`, 'Record pass or fail with a note saying what you saw']);
  assert.match(row.request.needed, new RegExp(H));
  assert.deepEqual(dueHumanProofs(await stored(work.id)), [], 'once asked, nothing more is owed');

  const answer = { request: row.request.id, outcome: 'pass', note: 'Printed clean on the shop printer' };
  assert.equal((await post(agentAdmin, `work/${work.id}/human-proof`, answer)).status, 403, 'an agent holding an admin credential touched no device');
  const passed = await post(human, `work/${work.id}/human-proof`, answer);
  assert.equal(passed.status, 200, JSON.stringify(passed.body));
  const proven = await stored(work.id);
  assert.deepEqual(reasons(proven), [], 'the gate passes');
  assert.equal(proofPreview(proven).find(entry => entry.proof === proof)?.status, 'passed');
  const [evidence] = proven.evidence;
  assert.deepEqual([evidence.sha, evidence.trusted, evidence.result, evidence.producer], [H, true, 'pass', human.id]);
  assert.equal(proven.humanProofs![0].answer!.note, answer.note);
  assert.deepEqual(mergeQueue([proven], {}, Date.now()).due.map(item => item.key), ['GY-9101'], 'the item merges');
  assert.deepEqual(await rows(work.id), [], 'the request is answered');
});

test('unit:human-proof-request-and-answer — a fail returns the item to rework with the note; a new head asks again', async () => {
  const work = await submitted('GY-9102');
  await post(loop, `work/${work.id}/human-proof-request`, { proof, sha: H, baseSha: B });
  const [row] = await rows(work.id);
  const previewed = { ...await stored(work.id), preview: { state: 'running', sha: H, path: '/preview/GY-9102' } } as unknown as Work;
  assert.equal(humanProofRows(previewed, 'refused', Date.now())[0].request.steps![0], 'Open /preview/GY-9102/', 'a preview that came up after the ask is linked');
  assert.equal((await post(human, `work/${work.id}/human-proof`, { request: row.request.id, outcome: 'fail', note: 'The receipt came out blank' })).status, 200);
  const failed = await stored(work.id);
  assert.match(reasons(failed)[0], /failed a person's check.*The receipt came out blank/);
  assert.equal(nextAction(failed, [failed], new Date())?.kind, 'request-rework');
  assert.match(neededRework(failed)!.reason, /The receipt came out blank/);
  assert.deepEqual(mergeQueue([failed], {}, Date.now()).due, []);
  assert.deepEqual(dueHumanProofs(failed), [], 'the failed head is not asked again');

  const fresh = { ...failed, candidate: head(H2), observation: observation(H2) } as unknown as Work;
  Object.assign(fresh, evaluate(fresh, [fresh], new Date()));
  assert.deepEqual(reasons(fresh), [`${proof} waits for a person's pass on Needs you for commit ${H2.slice(0, 12)}`], 'the pass or fail of the old head binds no new one');
  assert.deepEqual(dueHumanProofs(fresh), [proof]);
  assert.equal(neededRework(fresh), null);
});
