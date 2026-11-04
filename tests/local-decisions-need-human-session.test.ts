import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { signInDatabase } from './helpers/sign-in-database.js';
import { localRequest } from './helpers/local-request.js';

// The local viewer reads; it never acts. Every mutation and every human-only decision still needs
// a signed-in human session, and an agent's credential neither answers one nor obtains a session.
test('integration:local-decisions-need-human-session — an anonymous local mutation or human-only decision is refused; a signed-in human answers; an agent credential is still refused', async () => {
  const database = await signInDatabase(3092);
  const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
  const agentAdmin: Principal = { id: 'master', role: 'admin', sessionKind: 'ai' };
  const coordinator: Principal = { id: 'loop', role: 'coordinator', sessionKind: 'ai' };
  const worker: Principal = { id: 'worker', role: 'worker', sessionKind: 'ai' };
  const token = (actor: Principal) => `${actor.id}-${'x'.repeat(32)}`;
  const engine = new Engine(database.store, 120, 'owner/project');
  engine.gitRunner = null;
  const http = server(engine, [operator, agentAdmin, coordinator, worker].map(actor => ({ ...actor, token: token(actor) })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const post = (path: string, body: unknown, bearer?: string) => localRequest(url, `/api/${path}`, { method: 'POST', body, headers: { 'Idempotency-Key': randomUUID(), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) } });
  try {
    let work: Work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Needs an account', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works', 'e2e:fixture'] }] }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    const parked = await post(`work/${work.id}/park`, { epoch: work.epoch, kind: 'money-or-accounts', needed: 'A provider account', reason: 'The proof needs a paid account', recommendation: 'Approve', why: 'Nothing else unblocks the item.' }, token(worker));
    assert.equal(parked.status, 200, JSON.stringify(parked.body));
    const answer = { request: parked.body.humanRequest.id, outcome: 'provided', answer: 'Opened it' };

    // Anonymous, from this machine: reads pass, every write and decision is refused.
    assert.equal((await localRequest(url, `/api/work/${work.id}`)).status, 200);
    for (const [path, body] of [[`work/${work.id}/answer`, answer], ['work', { type: 'chore', title: 'Anonymous', criteria: [{ id: 'AC-1', text: 'x', proofs: ['unit:x'] }] }], [`work/${work.id}/close`, { reason: 'anonymous' }], ['sign-in-links', {}]] as const) {
      const refused = await post(path, body);
      assert.equal(refused.status, 401, `${path}: ${JSON.stringify(refused.body)}`);
    }

    // Agent credentials: refused for the human-only decision, and never issued a human session.
    for (const agent of [agentAdmin, coordinator]) {
      assert.equal((await post(`work/${work.id}/answer`, answer, token(agent))).status, 403, agent.id);
      assert.equal((await post('sign-in-links', {}, token(agent))).status, 403, agent.id);
    }

    // The signed-in human: a one-time link opens the session that answers.
    const link = await post('sign-in-links', {}, token(operator));
    const session = await post('sign-in', { code: link.body.code });
    assert.match(session.body.token, /^gyh_/);
    const answered = await post(`work/${work.id}/answer`, answer, session.body.token);
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(answered.body.humanRequest, null);
    assert.equal(answered.body.humanRequests.at(-1).answer.by, 'operator');
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); await database.close(); }
});
