import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { masterInstructions } from '../src/master.js';
import type { Principal, Work } from '../src/model.js';
import { signInDatabase } from './helpers/sign-in-database.js';
import { localRequest } from './helpers/local-request.js';

// GY-3415: an owner who approves in the master chat is handed the item's dashboard link, where they answer signed in.
test('integration:human-answer-link — a master answer on a human-only request is refused naming the item dashboard link from the install URL; the master prompt says to hand it to the owner', async () => {
  const database = await signInDatabase();
  const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
  const master: Principal = { id: 'master', role: 'operator-agent', sessionKind: 'ai', scope: { repositories: ['owner/project'], workItems: ['*'] } };
  const agentAdmin: Principal = { id: 'master-admin', role: 'admin', sessionKind: 'ai' };
  const worker: Principal = { id: 'worker', role: 'worker', sessionKind: 'ai' };
  const token = (actor: Principal) => `${actor.id}-${'x'.repeat(32)}`;
  const engine = new Engine(database.store, 120, 'owner/project');
  engine.gitRunner = null;
  const http = server(engine, [operator, master, agentAdmin, worker].map(actor => ({ ...actor, token: token(actor) })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const post = (path: string, body: unknown, bearer: string) => localRequest(url, `/api/${path}`, { method: 'POST', body, headers: { 'Idempotency-Key': randomUUID(), Authorization: `Bearer ${bearer}` } });
  try {
    let work: Work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Needs an account', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works', 'e2e:fixture'] }] }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    const parked = await post(`work/${work.id}/park`, { epoch: work.epoch, kind: 'money-or-accounts', needed: 'A provider account', reason: 'The proof needs a paid account', recommendation: 'Approve', why: 'Nothing else unblocks the item.' }, token(worker));
    assert.equal(parked.status, 200, JSON.stringify(parked.body));
    const answer = { request: parked.body.humanRequest.id, outcome: 'provided', answer: 'Owner approved in chat' };

    for (const agent of [master, agentAdmin]) {
      const refused = await post(`work/${work.key}/answer`, answer, token(agent));
      assert.equal(refused.status, 403, agent.id);
      assert.ok(String(refused.body.error).includes(`${url}/#${work.key}`), `${agent.id}: the refusal names the item link: ${JSON.stringify(refused.body)}`);
      assert.match(String(refused.body.error), /signed in/);
    }
    assert.match(masterInstructions, /approve in this chat/);
    assert.match(masterInstructions, /Give the owner that link/);
    assert.match(masterInstructions, /\/#GY-N/);
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); await database.close(); }
});
