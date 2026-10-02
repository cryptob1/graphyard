import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import type { Principal, Work } from '../src/model.js';
import { GitHub } from '../src/github.js';
import { issuePushCredential } from '../src/server/push-credential.js';
import { credentialFailure, refreshWorkerCredential, revokeInstallationToken, sweepExpiredWorkerCredentials, withdrawWorkerCredential, workerPushPermissions, writeWorkerCredential, type MintedPushCredential } from '../src/worker-credential.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1066: the four review threads of GY-999 (PR #530) filed as follow-ups — a worker token is
// never minted from a merge-queue bypass App, the lease is checked again after the mint, a token
// is kept until GitHub confirms its revocation, and an ssh refusal needs GitHub context.

const token = (label: string) => `ghs_${label}`.padEnd(40, '0');
const worker: Principal = { id: 'worker-a', role: 'worker' } as Principal;
const mode = (path: string) => statSync(path).mode & 0o777;
function item(overrides: Partial<Work> = {}): Work {
  const at = new Date().toISOString();
  return { id: 'work-999', key: 'GY-999', title: 'Sandboxed workers can push', description: '', type: 'bug', priority: 0, dependencies: [], plannedFiles: ['src/'],
    criteria: [{ id: 'AC-1', text: 'Push credential', proofs: ['unit:worker-session-scoped-push-credential'] }],
    policy: { checks: ['test'], review: true }, stage: 'ready', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at, ready: true, epoch: 3,
    lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }], violations: [], ...overrides } as Work;
}

test('GY-1066 — "Permission denied (publickey)" is a credential failure only alongside GitHub or git context', () => {
  assert.ok(credentialFailure('git push: git@github.com: Permission denied (publickey).'));
  assert.equal(credentialFailure('ssh deploy@staging.example.net failed: Permission denied (publickey).'), false);
});

test('GY-1066 — no worker token from a merge-queue bypass App, the lease checked again after the mint, and a token kept until GitHub confirms its revocation', async () => {
  const realFetch = globalThis.fetch;
  const directory = await temporaryDirectory('push-credential-followups');
  try {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    let rules: unknown = [], ruleset: unknown = null, mints = 0, revokeStatus = 204;
    const revocations: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const target = String(url);
      if (target.includes('/rules/branches/')) return new Response(JSON.stringify(rules), { status: 200 });
      if (/\/rulesets\/\d+$/.test(target)) return ruleset ? new Response(JSON.stringify(ruleset), { status: 200 }) : new Response('{"message":"Not Found"}', { status: 404 });
      if (target.endsWith('/installation/token')) { revocations.push(String((init?.headers as Record<string, string>).Authorization)); return new Response(null, { status: revokeStatus }); }
      if (!target.endsWith('/access_tokens')) throw new Error(`unexpected request ${target}`);
      if (!init?.body) return new Response(JSON.stringify({ token: token('client'), expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {} }), { status: 201 });
      mints++;
      return new Response(JSON.stringify({ token: token(`mint${mints}`), expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: workerPushPermissions }), { status: 201 });
    }) as typeof fetch;

    // 1. A merge queue that lets this App bypass it — or whose bypass cannot be read — mints nothing.
    const github = new GitHub({ repository: 'owner/project', base: 'main', appId: 1234, installationId: 5678, privateKey });
    rules = [{ type: 'merge_queue', ruleset_id: 77, parameters: {} }];
    ruleset = { id: 77, bypass_actors: [{ actor_id: 1234, actor_type: 'Integration', bypass_mode: 'pull_request' }] };
    await assert.rejects(github.mintPushToken(), /App 1234 is a bypass actor of the merge queue on main \(ruleset 77\)/);
    ruleset = { id: 77, current_user_can_bypass: 'pull_requests_only' };
    await assert.rejects(github.mintPushToken(), /may bypass the merge queue on main \(ruleset 77: pull_requests_only\)/);
    ruleset = null;
    await assert.rejects(github.mintPushToken(), /bypass actors of the merge queue on main \(ruleset 77\) cannot be read/);
    assert.equal(mints, 0, 'nothing is minted from a bypass App');
    ruleset = { id: 77, current_user_can_bypass: 'never', bypass_actors: [{ actor_id: 9, actor_type: 'Integration', bypass_mode: 'always' }] };
    assert.equal((await github.mintPushToken()).token, token('mint1'), 'a queue this App cannot bypass leaves the worker its credential');
    rules = [];
    assert.equal((await github.mintPushToken()).token, token('mint2'), 'a base with no merge queue (a user-owned repository) is unaffected');

    // 2. The lease moves while GitHub mints: nothing is answered, and the fresh token is revoked.
    const now = new Date();
    const leased = item({ stage: 'build', epoch: 4, lease: { owner: 'worker-a', epoch: 4, expiresAt: new Date(now.getTime() + 120_000).toISOString() }, lastAssignment: { owner: 'worker-a', epoch: 4, claimedAt: now.toISOString() } });
    const moves: Record<string, Work> = {
      submitted: { ...leased, submission: { epoch: 4, pr: 9 } } as Work,
      superseded: { ...leased, epoch: 5, lease: { owner: 'worker-b', epoch: 5, expiresAt: leased.lease!.expiresAt } } as Work,
      released: { ...leased, lease: null } as Work,
    };
    for (const [name, moved] of Object.entries(moves)) {
      let reads = 0;
      const services = { engine: { store: { list: async () => [reads++ === 0 ? leased : moved] } }, github, repository: 'owner/project' } as unknown as Parameters<typeof issuePushCredential>[0];
      const revoked: string[] = [];
      await assert.rejects(issuePushCredential(services, worker, 'GY-999', { epoch: 4 }, now, async value => { revoked.push(value); }), /was submitted|Lease missing, expired, or superseded/, name);
      assert.deepEqual(revoked, [token(`mint${mints}`)], `the token minted for a ${name} lease is revoked`);
    }
    const kept = { engine: { store: { list: async () => [leased] } }, github, repository: 'owner/project' } as unknown as Parameters<typeof issuePushCredential>[0];
    assert.equal((await issuePushCredential(kept, worker, 'GY-999', { epoch: 4 }, now, async () => { throw new Error('a held lease revokes nothing'); })).token, token(`mint${mints}`));

    // 3. Revocation is confirmed only by GitHub's 204 (or a 401: the token no longer authenticates).
    revokeStatus = 204; await revokeInstallationToken(token('a'));
    revokeStatus = 401; await revokeInstallationToken(token('b'));
    for (const status of [500, 429, 403]) { revokeStatus = status; await assert.rejects(revokeInstallationToken(token('c')), new RegExp(`HTTP ${status}`)); }
    assert.equal(revocations.length, 5);

    // A withdrawal GitHub does not confirm keeps the token to retry; the session's own files go.
    const session = join(directory, 'GY-999-4');
    const minted: MintedPushCredential = { key: 'GY-999', epoch: 4, repository: 'owner/project', token: token('session'), tokenExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(), leaseBound: new Date(Date.now() - 60_000).toISOString(), permissions: workerPushPermissions };
    await writeWorkerCredential(session, minted);
    const failing = async () => { throw new Error('HTTP 502'); };
    assert.equal(await withdrawWorkerCredential(session, failing), 'retained');
    assert.equal(existsSync(join(session, 'token')), false, 'the session can no longer read the token');
    assert.equal(existsSync(join(session, 'credential.json')), false);
    assert.equal(mode(join(session, 'revoke.json')), 0o600, 'the token still to revoke is kept 0600');
    // The sweep retries it: still refused, it stays; confirmed, the directory goes.
    assert.deepEqual(await sweepExpiredWorkerCredentials(directory, new Date(), failing), []);
    assert.equal(existsSync(session), true);
    const swept: string[] = [];
    assert.deepEqual(await sweepExpiredWorkerCredentials(directory, new Date(), async value => { swept.push(value); }), [session]);
    assert.deepEqual(swept, [token('session')]);
    assert.equal(existsSync(session), false);
    // Once GitHub's own expiry of the token has passed, nothing is left to revoke.
    await writeWorkerCredential(session, minted);
    assert.equal(await withdrawWorkerCredential(session, failing), 'retained');
    assert.equal(await withdrawWorkerCredential(session, failing, new Date(Date.parse(minted.tokenExpiresAt) + 1)), 'withdrawn');
    assert.equal(existsSync(session), false);

    // A refresh whose old token GitHub does not confirm revoking keeps it and retries at the next refresh.
    const live = { ...minted, expiresAt: new Date(Date.now() + 60_000).toISOString(), leaseBound: new Date(Date.now() + 3_600_000).toISOString() };
    await writeWorkerCredential(session, live);
    assert.equal(await refreshWorkerCredential(session, async () => ({ ...live, token: token('second') }), { revoke: failing }), 'refreshed');
    assert.equal(JSON.parse(await readFile(join(session, 'revoke.json'), 'utf8'))[0].token, token('session'));
    const retried: string[] = [];
    assert.equal(await refreshWorkerCredential(session, async () => ({ ...live, token: token('third') }), { revoke: async value => { retried.push(value); } }), 'refreshed');
    assert.deepEqual(retried, [token('session'), token('second')]);
    assert.equal(existsSync(join(session, 'revoke.json')), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});
