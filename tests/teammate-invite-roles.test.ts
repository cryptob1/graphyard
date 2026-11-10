import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal, Work } from '../src/model.js';
import { createContext } from '../src/cli/context.js';
import { inviteCommand } from '../src/cli/invite.js';
import { HumanSignIn, signInLinkTtlMs } from '../src/server/auth.js';
import { canTypeIntoMasterPane } from '../src/server/principals.js';
import { signInDatabase } from './helpers/sign-in-database.js';
import { localRequest } from './helpers/local-request.js';

// GY-3215: the operator invites teammates as their own human principals. A viewer reads; a maintainer
// also files work under their own name; neither answers a human-only decision; revoking ends a session at once.
test('e2e:teammate-invite-roles — invited viewer and maintainer sign in as themselves with roles, and revoking ends the session', async () => {
  const database = await signInDatabase();
  const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
  const worker: Principal = { id: 'worker', role: 'worker', sessionKind: 'ai' };
  const coordinator: Principal = { id: 'loop', role: 'coordinator', sessionKind: 'ai' };
  const token = (actor: Principal) => `${actor.id}-${'x'.repeat(32)}`;
  const engine = new Engine(database.store, 120, 'owner/project');
  engine.gitRunner = null;
  const http = server(engine, [operator, worker, coordinator].map(actor => ({ ...actor, token: token(actor) })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const call = (method: string, path: string, bearer: string, body?: unknown) => localRequest(url, `/api/${path}`, { method, body, headers: { 'Idempotency-Key': randomUUID(), Authorization: `Bearer ${bearer}` } });
  // The CLI as the operator runs it, against this server with the operator's own credential.
  const saved = { url: process.env.GRAPHYARD_URL, token: process.env.GRAPHYARD_TOKEN, file: process.env.GRAPHYARD_TOKEN_FILE };
  Object.assign(process.env, { GRAPHYARD_URL: url, GRAPHYARD_TOKEN: token(operator) }); delete process.env.GRAPHYARD_TOKEN_FILE;
  const cli = async (id: string, ...args: string[]) => {
    const printed: any[] = [];
    const context = await createContext('invite', id, args, false);
    await inviteCommand.run({ ...context, print: async (value: unknown) => { printed.push(value); } } as any, undefined);
    return printed[0];
  };
  try {
    // The operator invites a viewer and a maintainer; each redeems its own one-time link.
    const sessions: Record<string, { token: string; actor: Principal }> = {};
    for (const [name, role] of [['vera@example.com', 'viewer'], ['mo-gh', 'maintainer']]) {
      const invite = await cli(name, '--role', role);
      assert.equal(invite.teammate, name); assert.equal(invite.role, role);
      const code = new URL(invite.invite).hash.replace('#sign-in=', '');
      const opened = await call('POST', 'sign-in', '', { code });
      assert.equal(opened.status, 200, JSON.stringify(opened.body));
      assert.equal(opened.body.actor.id, name);
      assert.equal((await call('POST', 'sign-in', '', { code })).status, 401, 'the invite link is single use');
      sessions[role] = opened.body;
      // The stored expiry is the 90-day session, far past the link's ten minutes; a request with the clock past ten minutes still authenticates.
      const stored = await database.store.pool.query(`SELECT expires_at FROM human_sign_in_sessions WHERE actor->>'id'=$1`, [name]);
      assert.ok(stored.rows[0].expires_at.getTime() - Date.now() > 80 * 86_400_000, 'the session outlives the invite link by far');
      const later = new HumanSignIn(database.store, () => Date.now() + signInLinkTtlMs + 60_000);
      assert.equal((await later.authenticate(opened.body.token))?.id, name);
    }
    const { viewer, maintainer } = sessions;

    // Both read the board.
    for (const session of [viewer, maintainer]) assert.equal((await call('GET', 'work-snapshot', session.token)).status, 200);

    // The maintainer files an item attributed to them; the viewer is refused.
    const item = { type: 'chore', title: 'Filed by a teammate', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works', 'e2e:fixture'] }], owner: 'mo-gh' };
    const filed = await call('POST', 'work', maintainer.token, item);
    assert.equal(filed.status, 200, JSON.stringify(filed.body));
    const history = await database.store.pool.query('SELECT actor FROM events WHERE work_id=$1 ORDER BY seq LIMIT 1', [filed.body.id]);
    assert.equal(history.rows[0].actor, 'mo-gh');
    assert.equal((await call('POST', 'work', viewer.token, item)).status, 403);

    // Both are refused a human-only decision.
    let work: Work = await engine.execute(operator, 'create', null, { type: 'chore', title: 'Needs an account', criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:works', 'e2e:fixture'] }] }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    const parked = await call('POST', `work/${work.id}/park`, token(worker), { epoch: work.epoch, kind: 'money-or-accounts', needed: 'A provider account', reason: 'The proof needs a paid account', recommendation: 'Approve', why: 'Nothing else unblocks the item.' });
    assert.equal(parked.status, 200, JSON.stringify(parked.body));
    for (const session of [viewer, maintainer]) {
      const answered = await call('POST', `work/${work.id}/answer`, session.token, { request: parked.body.humanRequest.id, outcome: 'provided', answer: 'Opened it' });
      assert.equal(answered.status, 403, JSON.stringify(answered.body));
    }

    // The Master page predicate.
    assert.equal(canTypeIntoMasterPane(maintainer.actor), true);
    assert.equal(canTypeIntoMasterPane(viewer.actor), false);
    assert.equal(canTypeIntoMasterPane(operator), true);

    // Revoking the maintainer refuses its next request at once.
    const revoked = await cli('revoke', 'mo-gh');
    assert.equal(revoked.sessionsEnded, 1);
    assert.equal((await call('GET', 'work-snapshot', maintainer.token)).status, 401);
    assert.equal((await call('GET', 'work-snapshot', viewer.token)).status, 200);

    // Nobody but the operator issues an invite, and no invite takes a configured principal's name.
    for (const bearer of [token(worker), token(coordinator), viewer.token, maintainer.token])
      assert.notEqual((await call('POST', 'invites', bearer, { name: 'eve', role: 'maintainer' })).status, 200);
    assert.equal((await call('POST', 'invites', token(operator), { name: 'operator', role: 'maintainer' })).status, 409);
  } finally {
    for (const [name, value] of [['GRAPHYARD_URL', saved.url], ['GRAPHYARD_TOKEN', saved.token], ['GRAPHYARD_TOKEN_FILE', saved.file]] as const) if (value === undefined) delete process.env[name]; else process.env[name] = value;
    await new Promise<void>(resolve => http.close(() => resolve()));
    await database.close();
  }
});
