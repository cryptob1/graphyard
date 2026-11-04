import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HumanSignIn, maxSignInLinks, maxSignInSessions, signInLinkTtlMs, signInSessionTtlMs } from '../src/server/auth.js';
import { signInDatabase } from './helpers/sign-in-database.js';
import { signInProcess } from './helpers/sign-in-process.js';

test('integration:signin-session-survives-restart — persisted digests authenticate after process restart, until expiry or sign-out', async () => {
  const database = await signInDatabase();
  let http = await signInProcess(database.url);
  const call = (path: string, token: string, body?: object) => fetch(http.url + '/api/' + path, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    const link = await (await call('sign-in-links', 'test-human-operator', {})).json() as { code: string };
    const session = await (await call('sign-in', '', { code: link.code })).json() as { token: string; actor: object; expiresAt: string };
    assert.equal((await call('sign-in', '', { code: link.code })).status, 401);
    const rows = (await database.store.pool.query('SELECT * FROM human_sign_in_sessions')).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token_hash, createHash('sha256').update(session.token).digest('hex'));
    assert.deepEqual(rows[0].actor, session.actor);
    assert.equal(rows[0].expires_at.toISOString(), session.expiresAt);
    assert.ok(!JSON.stringify(rows).includes(session.token));
    await http.close();
    http = await signInProcess(database.url);
    assert.equal((await call('status', session.token)).status, 200);
    assert.equal((await call('sign-out', session.token, {})).status, 200);
    assert.equal((await database.store.pool.query('SELECT * FROM human_sign_in_sessions')).rowCount, 0);
    assert.equal((await call('status', session.token)).status, 401);

    const nextLink = await (await call('sign-in-links', 'test-human-operator', {})).json() as { code: string };
    const next = await (await call('sign-in', '', { code: nextLink.code })).json() as { token: string };
    await database.store.pool.query("UPDATE human_sign_in_sessions SET expires_at=clock_timestamp()-interval '1 second'");
    assert.equal((await call('status', next.token)).status, 401);

    let now = Date.now();
    const table = new HumanSignIn(database.store, () => now);
    const issuer = { id: 'operator', role: 'admin', sessionKind: 'human' } as const;
    for (const principal of [{ ...issuer, role: 'worker' as const }, { ...issuer, sessionKind: 'ai' as const }, { id: 'operator', role: 'admin' as const }])
      assert.throws(() => table.issue(principal, true), /Only the operator|human session/);
    assert.throws(() => table.issue(issuer, false), /Only the operator/);
    const old = table.issue(issuer, true);
    now += signInLinkTtlMs;
    await assert.rejects(table.redeem(old.code), /expired/);
    const evictedLink = table.issue(issuer, true);
    for (let i = 0; i < maxSignInLinks; i++) table.issue(issuer, true);
    await assert.rejects(table.redeem(evictedLink.code), /expired/);
    const first = await table.redeem(table.issue(issuer, true).code);
    assert.equal(Date.parse(first.expiresAt), now + signInSessionTtlMs);
    now++;
    // Concurrent redeemers share the database cap, even from separate server instances.
    const other = new HumanSignIn(database.store, () => now);
    const attempts = await Promise.allSettled(Array.from({ length: maxSignInSessions }, (_, i) => {
      const owner = i % 2 ? table : other;
      return owner.redeem(owner.issue(issuer, true).code);
    }));
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, maxSignInSessions - 1);
    const refused = attempts.filter(result => result.status === 'rejected');
    assert.equal(refused.length, 1);
    assert.match(refused[0].reason.message, /session sign-in limit/);
    assert.equal((await database.store.pool.query('SELECT * FROM human_sign_in_sessions')).rowCount, maxSignInSessions);
    assert.deepEqual(await other.authenticate(first.token), first.actor);
    for (const result of attempts) if (result.status === 'fulfilled')
      assert.deepEqual(await other.authenticate(result.value.token), result.value.actor);
    await other.signOut(first.token);
    const replacement = await table.redeem(table.issue(issuer, true).code);
    assert.deepEqual(await other.authenticate(replacement.token), replacement.actor);
    now += signInSessionTtlMs;
    assert.equal(await other.authenticate(replacement.token), null);
    const fresh = await other.redeem(other.issue(issuer, true).code);
    assert.deepEqual(await table.authenticate(fresh.token), fresh.actor);
    assert.equal((await database.store.pool.query('SELECT * FROM human_sign_in_sessions')).rowCount, 1);
  } finally { await http.close(); await database.close(); }
});
