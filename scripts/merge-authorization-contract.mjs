// Trusted merge-authorization contract. Run this from protected source, never from the candidate
// checkout. The scenario needs an observed GitHub candidate, and Graphyard deliberately exposes no
// client-controlled route that invents one, so the candidate is started through the protected
// launcher in merge-authorization-server.mjs: it supplies provider observations over a separately
// authenticated control port while every authorization decision under test is driven through the
// candidate's own HTTP API by merge-authorization-probe.mjs. The probe records only what it
// observes; every expectation lives here, in the judge, outside the candidate process.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createInventory as createCaseInventory } from './case-inventory.mjs';
import { mergeAuthorizationPrincipals, probeMergeAuthorization } from './merge-authorization-probe.mjs';

export const requiredCases = ['authorized-candidate', 'broker-identity-restricted', 'revocation-identity-restricted',
  'revocation-closes-authorization', 'broker-refuses-revoked-candidate', 'concurrent-attempts-refused', 'merge-after-revocation-refused', 'provider-commit-serialized'];
// Bound to this contract's fixed inventory; see case-inventory.mjs for the ledger semantics.
export const createInventory = () => createCaseInventory(requiredCases);

// Describes the candidate the runner starts for this contract. The harness directory is mounted
// read-only and the launcher replaces the image entrypoint; candidate code and the protected
// judge never share a process, and the control token never reaches the candidate's API clients.
export function candidate({ harness }) {
  const principals = mergeAuthorizationPrincipals(), controlToken = randomBytes(32).toString('hex');
  return {
    principals,
    env: { GRAPHYARD_SOURCE_ROOT: '/app', GRAPHYARD_PROBE_CONTROL_TOKEN: controlToken },
    ports: { api: 4310, control: 4311 },
    args: ['-v', `${harness}:/harness:ro`, '--entrypoint', 'node'],
    command: ['--import', 'tsx', '/harness/merge-authorization-server.mjs'],
    exercise: (urls, inventory) => exercise(urls.api, principals, inventory, { url: urls.control, token: controlToken }),
  };
}

export async function exercise(url, principals, inventory = createInventory(), control) {
  assert.ok(control?.url && control?.token, 'The merge-authorization contract needs the protected launcher control endpoint');
  return judgeMergeAuthorization(await probeMergeAuthorization({ url, controlUrl: control.url, controlToken: control.token, principals }), inventory);
}

// Judges a merge-authorization transcript produced by scripts/merge-authorization-probe.mjs.
// The probe records what the candidate did; the expectations live here, outside the candidate.
export function judgeMergeAuthorization(transcript, inventory = createInventory()) {
  assert.ok(Array.isArray(transcript) && transcript.length, 'Merge-authorization probe produced no transcript');
  const steps = name => transcript.filter(entry => entry.step === name);
  const only = name => { const found = steps(name); assert.equal(found.length, 1, `Expected exactly one ${name} step`); return found[0]; };
  const refused = (entry, status, pattern) => {
    assert.equal(entry.status, status, `${entry.step} returned ${entry.status}: ${entry.message}`);
    assert.match(entry.message, pattern, `${entry.step} refused for the wrong reason`);
  };
  // Each case is judged in order and recorded as it completes, so a failing transcript still
  // names the case that failed and the ones that were never reached.
  const cases = { push(id) { inventory.pass(id); } };
  const judging = id => inventory.begin(id);

  judging('authorized-candidate');
  const authorized = only('authorized-candidate');
  assert.equal(authorized.stage, 'merge'); assert.equal(authorized.gatesPassed, true); assert.equal(authorized.authorized, true);
  cases.push('authorized-candidate');

  judging('broker-identity-restricted');
  const brokerIdentities = steps('broker-identity');
  assert.deepEqual(brokerIdentities.map(entry => entry.actor), [null, 'probe-worker', 'probe-producer', 'probe-other-producer']);
  for (const entry of brokerIdentities) refused(entry, entry.actor ? 403 : 401, entry.actor ? /Coordinator permission/ : /valid Graphyard bearer token/);
  cases.push('broker-identity-restricted');

  judging('revocation-identity-restricted');
  const revocationIdentities = steps('revocation-identity');
  assert.deepEqual(revocationIdentities.map(entry => entry.actor), [null, 'probe-worker', 'probe-other-producer', 'probe-coordinator']);
  for (const entry of revocationIdentities) refused(entry, entry.actor ? 403 : 401, entry.actor ? /operator or the trusted producer/ : /valid Graphyard bearer token/);
  refused(only('revocation-scope'), 404, /No trusted evidence matches/);
  cases.push('revocation-identity-restricted');

  judging('revocation-closes-authorization');
  const requested = only('merge-requested');
  assert.equal(requested.requestedBy, 'probe-coordinator'); assert.equal(requested.sha, 'a'.repeat(40));
  assert.equal(requested.execution, null, 'GitHub executes the merge: the request grants no execution');
  assert.equal(only('not-frozen-by-request').status, 200, 'a merge request freezes nothing on the record');
  const revoked = only('revoked');
  assert.equal(revoked.stage, 'acceptance', 'a revoked candidate must leave the merge stage');
  assert.equal(revoked.execution, null);
  assert.equal(revoked.authorization, null);
  assert.match(revoked.acceptanceReasons.join(' '), /previously accepted evidence was revoked/);
  assert.equal(revoked.queue, null, 'a revoked candidate must leave the merge queue rather than hold its position');
  assert.equal(revoked.ejection?.sha, 'a'.repeat(40)); assert.match(String(revoked.ejection?.reason), /was revoked on speculative tip/);
  // Both accepted runs — the one before the request and the one recorded after it — are withdrawn.
  assert.deepEqual(revoked.revocations.map(item => item.actor), ['probe-producer', 'probe-producer']);
  assert.ok(revoked.retainedEvidence >= 2, 'the revoked records must be retained for audit, not deleted');
  cases.push('revocation-closes-authorization');

  judging('broker-refuses-revoked-candidate');
  refused(only('request-after-revocation'), 409, /Merge authorization is no longer current/);
  refused(only('execution-request-refused'), 400, /grants no merge executions/);
  const removed = steps('removed-execution-route');
  assert.deepEqual(removed.map(entry => entry.route), ['merge-verify', 'merge-commit', 'merge-cancel']);
  for (const entry of removed) assert.equal(entry.status, 404, `${entry.route} must not exist: GitHub executes merges`);
  cases.push('broker-refuses-revoked-candidate');

  judging('concurrent-attempts-refused');
  const concurrent = only('concurrent-attempts');
  assert.equal(concurrent.attempts.length, 8);
  for (const attempt of concurrent.attempts) refused({ ...attempt, step: 'concurrent-attempts' }, 409, /Merge authorization is no longer current/);
  const survivors = only('no-execution-survives');
  assert.equal(survivors.execution, null); assert.equal(survivors.authorization, null);
  cases.push('concurrent-attempts-refused');

  judging('merge-after-revocation-refused');
  const merged = only('merge-after-revocation');
  assert.notEqual(merged.stage, 'done');
  assert.match(merged.violations.join(' '), /without a prior authorization/);
  assert.equal(merged.delivery, null);
  cases.push('merge-after-revocation-refused');

  judging('provider-commit-serialized');
  const race = only('provider-commit-race');
  assert.equal(race.revoke.status, 200, 'withdrawal is never refused for a merge GitHub holds');
  assert.ok(race.revokedEvidence > 0, 'the withdrawal revoked the evidence');
  if (race.request.status !== 200) assert.match(race.request.message, /Merge authorization is no longer current/);
  assert.equal(race.execution, null, 'no execution exists on either side of the race');
  assert.notEqual(race.mergedStage, 'done', 'a merge GitHub lands after the withdrawal is never delivered');
  assert.match(race.mergedViolations.join(' '), /without a prior authorization/);
  cases.push('provider-commit-serialized');

  assert.ok(inventory.complete, 'every merge-authorization case must be judged exactly once');
  return inventory.cases;
}
