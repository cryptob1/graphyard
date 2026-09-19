// Trusted HTTP harness. Run this from protected source, never from the candidate checkout.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export const requiredCases = ['anonymous-denied', 'exclusive-claim', 'stale-epoch', 'worker-proof-denied', 'dependency-blocked'];
export const mergeAuthorizationCases = ['authorized-candidate', 'broker-identity-restricted', 'revocation-identity-restricted',
  'revocation-closes-authorization', 'broker-refuses-revoked-candidate', 'concurrent-attempts-refused', 'merge-after-revocation-refused', 'provider-commit-serialized'];
// Every proof this trusted harness can produce, and the exact case inventory each one requires.
export const contracts = {
  'integration:claim-safety': { cases: requiredCases },
  'integration:merge-authorization': { cases: mergeAuthorizationCases },
};

// Judges a merge-authorization transcript produced by scripts/merge-authorization-probe.mjs.
// The probe records what the candidate did; the expectations live here, outside the candidate.
export function judgeMergeAuthorization(transcript) {
  assert.ok(Array.isArray(transcript) && transcript.length, 'Merge-authorization probe produced no transcript');
  const steps = name => transcript.filter(entry => entry.step === name);
  const only = name => { const found = steps(name); assert.equal(found.length, 1, `Expected exactly one ${name} step`); return found[0]; };
  const refused = (entry, status, pattern) => {
    assert.equal(entry.status, status, `${entry.step} returned ${entry.status}: ${entry.message}`);
    assert.match(entry.message, pattern, `${entry.step} refused for the wrong reason`);
  };
  const cases = [];

  const authorized = only('authorized-candidate');
  assert.equal(authorized.stage, 'merge'); assert.equal(authorized.gatesPassed, true); assert.equal(authorized.authorized, true);
  cases.push('authorized-candidate');

  const brokerIdentities = steps('broker-identity');
  assert.deepEqual(brokerIdentities.map(entry => entry.actor), [null, 'probe-worker', 'probe-producer', 'probe-other-producer']);
  for (const entry of brokerIdentities) refused(entry, entry.actor ? 403 : 401, entry.actor ? /Coordinator permission/ : /valid Graphyard bearer token/);
  cases.push('broker-identity-restricted');

  const revocationIdentities = steps('revocation-identity');
  assert.deepEqual(revocationIdentities.map(entry => entry.actor), [null, 'probe-worker', 'probe-other-producer', 'probe-coordinator']);
  for (const entry of revocationIdentities) refused(entry, entry.actor ? 403 : 401, entry.actor ? /operator or the trusted producer/ : /valid Graphyard bearer token/);
  refused(only('revocation-scope'), 404, /No trusted evidence matches/);
  cases.push('revocation-identity-restricted');

  const granted = only('execution-granted');
  assert.equal(granted.owner, 'probe-coordinator'); assert.equal(granted.sha, 'a'.repeat(40));
  assert.ok(Number.isSafeInteger(granted.authorizationRevision) && granted.authorizationRevision > 0);
  refused(only('frozen-during-execution'), 409, /merge execution is active/i);
  const revoked = only('revoked');
  assert.equal(revoked.stage, 'acceptance', 'a revoked candidate must leave the merge stage');
  assert.equal(revoked.execution, null, 'revocation must cancel the in-flight execution, not wait for it');
  assert.equal(revoked.authorization, null);
  assert.match(revoked.acceptanceReasons.join(' '), /previously accepted evidence was revoked/);
  assert.equal(revoked.queue, null, 'a revoked candidate must leave the merge queue rather than hold its position');
  assert.equal(revoked.ejection?.sha, 'a'.repeat(40)); assert.match(String(revoked.ejection?.reason), /was revoked on speculative tip/);
  assert.deepEqual(revoked.revocations.map(item => item.actor), ['probe-producer']);
  assert.ok(revoked.retainedEvidence >= 1, 'the revoked record must be retained for audit, not deleted');
  cases.push('revocation-closes-authorization');

  refused(only('verify-after-revocation'), 409, /missing, expired, superseded/);
  refused(only('acquire-replay-after-revocation'), 409, /expired, cancelled, fenced, or superseded/);
  refused(only('cancel-after-revocation'), 409, /missing, expired, superseded/);
  cases.push('broker-refuses-revoked-candidate');

  const concurrent = only('concurrent-attempts');
  assert.equal(concurrent.attempts.length, 8);
  for (const attempt of concurrent.attempts) refused({ ...attempt, step: 'concurrent-attempts' }, 409, /Merge authorization is no longer current/);
  const survivors = only('no-execution-survives');
  assert.equal(survivors.execution, null); assert.equal(survivors.authorization, null);
  cases.push('concurrent-attempts-refused');

  const merged = only('merge-after-revocation');
  assert.notEqual(merged.stage, 'done');
  assert.match(merged.violations.join(' '), /without a prior authorization/);
  assert.equal(merged.delivery, null);
  cases.push('merge-after-revocation-refused');

  const race = only('provider-commit-race');
  assert.deepEqual([race.commit.status, race.revoke.status].sort(), [200, 409], 'exactly one side of the commit/revocation race must win');
  if (race.commit.status === 200) {
    assert.match(race.revoke.message, /already committed this candidate/);
    assert.equal(race.revokedEvidence, 0, 'a refused late withdrawal must not claim to revoke evidence');
    assert.ok(race.committingAt);
  } else {
    assert.match(race.commit.message, /missing, expired, superseded/);
    assert.ok(race.revokedEvidence > 0, 'a winning withdrawal must cancel provider authority');
    assert.equal(race.committingAt, null);
  }
  cases.push('provider-commit-serialized');

  assert.deepEqual(cases, mergeAuthorizationCases);
  return cases.map(id => ({ id, result: 'pass' }));
}

export async function exercise(url, principals) {
  const operator = principals.find(p => p.role === 'admin');
  const workers = principals.filter(p => p.role === 'worker');
  assert.ok(operator && workers.length >= 32);
  const cases = [];
  async function request(path, actor, data, status = 200) {
    const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST',
      headers: { ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, status, `Unexpected status for ${path}`); return response.json();
  }
  const input = { title: 'Trusted acceptance probe', criteria: [{ id: 'AC-1', text: 'Claims are exclusive', proofs: ['integration:claim-safety'] }] };
  await request('work', undefined, undefined, 401); cases.push('anonymous-denied');
  let work = await request('work', operator, input);
  await request(`work/${work.id}/ready`, operator, {});
  const claims = await Promise.all(workers.slice(0, 32).map(async actor => {
    const response = await fetch(`${url}/api/work/${work.id}/claim`, { method: 'POST', headers: { Authorization: `Bearer ${actor.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: '{}', signal: AbortSignal.timeout(10_000) });
    assert.ok([200, 409].includes(response.status)); return { actor, status: response.status, work: await response.json() };
  }));
  const winners = claims.filter(c => c.status === 200); assert.equal(winners.length, 1);
  const winner = winners[0]; work = winner.work;
  assert.equal(work.lease.owner, winner.actor.id); assert.equal(work.epoch, 1);
  const history = await request(`events?work=${work.id}`, operator); assert.equal(history.filter(e => e.kind === 'claim').length, 1);
  cases.push('exclusive-claim');
  await request(`work/${work.id}/release`, winner.actor, { epoch: 1 });
  const replacement = workers.find(w => w.id !== winner.actor.id);
  work = await request(`work/${work.id}/claim`, replacement, {}); assert.equal(work.epoch, 2);
  for (const command of ['heartbeat', 'release']) await request(`work/${work.id}/${command}`, winner.actor, { epoch: 1 }, 409);
  await request(`work/${work.id}/submit`, winner.actor, { epoch: 1, pr: 1 }, 409); cases.push('stale-epoch');
  const proof = { proof: 'integration:claim-safety', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, result: 'pass', executed: 5, skipped: 0 };
  await request(`work/${work.id}/evidence`, replacement, { ...proof, trusted: true }, 400);
  work = await request(`work/${work.id}/evidence`, replacement, proof);
  assert.equal(work.evidence.at(-1).trusted, false); assert.notEqual(work.stage, 'done'); cases.push('worker-proof-denied');
  const dependent = await request('work', operator, { ...input, dependencies: [work.id] });
  await request(`work/${dependent.id}/ready`, operator, {});
  await request(`work/${dependent.id}/claim`, replacement, {}, 409); cases.push('dependency-blocked');
  assert.deepEqual(cases, requiredCases);
  return cases.map(id => ({ id, result: 'pass' }));
}
