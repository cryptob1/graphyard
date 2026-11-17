import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRegistryMutation } from '../src/model-boundary/registry.js';
import { chooseSession, emptyRegistry, foldObservations, proposedRuntimes } from '../src/model/registry.js';
import { detectLoggedOut } from '../src/master/logged-out.js';

// GY-3441: on lumina-investor muse spent every reviewer attempt on GY-22 failing with missing Meta
// credentials, and was still chosen first because it is on another provider than the implementer.
// Its error is now read as a logout: the account is held for the reviewer role under it, the review
// runs on the next eligible account even on the implementer's provider, and a new login lifts it.
const HOST = 'host-a';
const said = 'bwrap exited with code 1: missing meta credentials: run `muse login` or set META_API_KEY, or save credentials at /home/agent/.config/muse/auth.json';
const diversity = { work: 'GY-22', provider: 'anthropic' };

function fleet(at: string) {
  return applyRegistryMutation(emptyRegistry(), 'apply', {
    runtimes: proposedRuntimes.filter(entry => entry.name === 'muse' || entry.name === 'claude'),
    models: [{ name: 'meta', id: 'meta-default', provider: 'meta' }, { name: 'opus', id: 'opus', provider: 'anthropic' }],
    accounts: [{ name: 'claude-a', runtime: 'claude', model: 'opus', credential: { host: HOST, home: '/home/claude-a' } },
      { name: 'muse', runtime: 'muse', model: 'meta', credential: { host: HOST, home: '/home/muse' } }],
    roles: [{ name: 'reviewer', accounts: ['claude-a', 'muse'], concurrency: 2 }], reason: 'fixture',
  }, { actor: 'operator', at }).registry;
}
const quota = (loggedIn: boolean | null, identity?: string | null) => ({ loggedIn, state: 'available' as const, usage: [], resetsAt: null, ...(identity === undefined ? {} : { identity }) });

test('integration:reviewer-credential-failure-holds — a reviewer session ending on missing credentials holds that account, the next review runs on another account, and a new login or passing probe lifts the hold', () => {
  const at = new Date().toISOString(), now = Date.parse(at);
  const registry = fleet(at);
  foldObservations(registry, { host: HOST, observations: [{ account: 'claude-a', quota: quota(true, 'anthropic:a') }, { account: 'muse', quota: quota(null, 'meta:old') }] }, { actor: 'master', at });
  assert.equal((chooseSession(registry, { role: 'reviewer', host: HOST }, now, diversity) as any).account?.name, 'muse', 'muse is chosen first: it is not on the implementer\'s provider');

  // muse's own missing-credentials error is read as a logout and held for the account, with the error as the reason.
  const reason = detectLoggedOut(`${said}\n`);
  assert.equal(reason, said);
  foldObservations(registry, { host: HOST, observations: [{ account: 'muse', quota: { ...quota(false), reason: reason!, session: 'login' } }] }, { actor: 'master', at });
  const next = chooseSession(registry, { role: 'reviewer', host: HOST }, now, diversity);
  assert.equal(next.account?.name, 'claude-a', 'the next review launches on claude-a though it shares the implementer\'s provider');
  assert.ok(next.skipped.some(entry => entry.account === 'muse' && entry.reason.includes('muse is not logged in') && entry.reason.includes('missing meta credentials')), JSON.stringify(next.skipped));

  // A probe that reads the same login does not lift it; one that reads another login does.
  foldObservations(registry, { host: HOST, observations: [{ account: 'muse', quota: quota(true, 'meta:old') }] }, { actor: 'master', at });
  assert.equal(chooseSession(registry, { role: 'reviewer', host: HOST }, now, diversity).account?.name, 'claude-a', 'the same login stays held');
  foldObservations(registry, { host: HOST, observations: [{ account: 'muse', quota: quota(true, null) }] }, { actor: 'master', at });
  assert.equal(chooseSession(registry, { role: 'reviewer', host: HOST }, now, diversity).account?.name, 'claude-a', 'an unreadable login stays held');
  foldObservations(registry, { host: HOST, observations: [{ account: 'muse', quota: quota(true, 'meta:new') }] }, { actor: 'master', at });
  assert.equal(chooseSession(registry, { role: 'reviewer', host: HOST }, now, diversity).account?.name, 'muse', 'a changed login lifts the hold');

  // Held again, a passing probe of the account (its smoke test) lifts it too.
  foldObservations(registry, { host: HOST, observations: [{ account: 'muse', quota: { ...quota(false), reason: said, session: 'login' } }] }, { actor: 'master', at });
  assert.equal(chooseSession(registry, { role: 'reviewer', host: HOST }, now, diversity).account?.name, 'claude-a');
  foldObservations(registry, { host: HOST, observations: [{ account: 'muse', quota: quota(true, 'meta:new'), smoke: { result: 'pass', reason: null } }] }, { actor: 'master', at });
  assert.equal(chooseSession(registry, { role: 'reviewer', host: HOST }, now, diversity).account?.name, 'muse', 'a passing probe lifts the hold');
});
