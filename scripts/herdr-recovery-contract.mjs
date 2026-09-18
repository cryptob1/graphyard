// Trusted HTTP harness for cross-machine lease recovery. Run this from protected source, never from the candidate checkout.
// Graphyard recognises a Herdr machine only through the identities it authenticates and records, so two machines are
// modelled exactly as the fleet guide requires: distinct worker principals, distinct host IDs, and isolated worktrees.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const requiredCases = ['exclusive-claim', 'expiry-recovery', 'stale-owner-refused', 'isolated-worktrees', 'supervised-fence-recovery'];
// Every command an owner may only issue while holding its own current lease. `rereview` is lease-scoped
// for workers too: a superseded owner must not be able to reset review state and requeue integration work.
const leaseScopedCommands = ['heartbeat', 'release', 'workspace', 'submit', 'blocked', 'quarantine', 'launch', 'rereview'];
// The shipped safety defaults this contract certifies. A candidate that shortens either fence turns a
// transient disconnect into premature reassignment, so short fences must fail rather than pass quickly.
// Only the repository's own test suite substitutes shorter fences, against its own short-fenced engine.
export const requiredFences = { leaseMs: 120_000, launchAuthorityMs: 120_000 };
// Bounds the wall-clock wait for the lease and launch fences the candidate itself reports.
const recoveryBudgetMs = 600_000;
// A fence created between two candidate clock reads is bounded by those reads, so the slack this
// contract grants a candidate is never larger than one observed window. A wider window fails the run.
const measurementWindowMs = 10_000;

export async function exercise(url, principals, fences = requiredFences) {
  const operator = principals.find(p => p.role === 'admin');
  const workers = principals.filter(p => p.role === 'worker');
  assert.ok(operator && workers.length >= 2);
  const machines = workers.slice(0, 2).map((actor, index) => ({ actor, host: `acceptance-machine-${index + 1}` }));
  const settlementToken = randomBytes(32).toString('hex');
  const settlementHash = createHash('sha256').update(settlementToken).digest('hex');
  const recovery = { reason: 'Supervised machine stopped; recovering on the second machine', previousWorkerStopped: true };
  const cases = [];
  async function request(path, actor, data, status = 200) {
    const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST',
      headers: { ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, status, `Unexpected status for ${path}`); return response.json();
  }
  async function create(title) {
    const work = await request('work', operator, { title, criteria: [{ id: 'AC-1', text: 'A replacement machine recovers expired work', proofs: ['integration:herdr-recovery'] }] });
    return request(`work/${work.id}/ready`, operator, {});
  }
  const worktree = (machine, work, epoch) => ({ epoch, host: machine.host, path: `/srv/graphyard/${machine.host}/${work.key.toLowerCase()}-${epoch}`, branch: `graphyard/${work.key.toLowerCase()}-${epoch}` });
  const staleBody = (command, work, machine) => ({ heartbeat: { epoch: 1 }, release: { epoch: 1 }, blocked: { epoch: 1, reason: 'Stale owner note' }, rereview: { epoch: 1 },
    workspace: worktree(machine, work, 1), submit: { epoch: 1, pr: 1 }, quarantine: { epoch: 1, settlementHash }, launch: { epoch: 1, settlementHash } }[command]);
  const candidateNow = async () => Date.parse((await request('status', operator)).now);
  // A fence created between two candidate clock reads runs for at most `deadline - before`, so this
  // refuses any default shorter than the requirement while granting no more slack than that window.
  function assertFence(label, deadline, before, after, minimum) {
    const expiresAt = Date.parse(deadline);
    assert.ok(Number.isFinite(expiresAt), `${label} reported no deadline`);
    assert.ok(after >= before && after - before <= measurementWindowMs, `${label} could not be measured within a bounded window`);
    assert.ok(expiresAt - before >= minimum, `${label} is shorter than the required ${minimum} ms safety default`);
  }
  // Wait on the candidate's own reported fences, measured by its clock, not this harness's.
  async function waitForFences(ids) {
    const started = Date.now();
    for (;;) {
      const [items, status] = await Promise.all([request('work', operator), request('status', operator)]);
      const observed = Date.parse(status.now);
      const fences = items.filter(w => ids.includes(w.id)).flatMap(w => [w.lease ? Date.parse(w.lease.expiresAt) : 0, w.containmentQuarantine?.launchExpiresAt ? Date.parse(w.containmentQuarantine.launchExpiresAt) : 0]);
      const remaining = Math.max(...fences) - observed;
      if (remaining <= 0) return;
      assert.ok(Date.now() - started + remaining < recoveryBudgetMs, 'Lease and launch fences did not expire within the recovery budget');
      await delay(Math.min(remaining + 1000, 15_000));
    }
  }

  // One item recovers from a plain expired lease; the other from a supervised worker that
  // established containment, acknowledged launch, and then stopped without settling.
  const unsupervised = await create('Cross-machine recovery after lease expiry');
  const supervised = await create('Cross-machine recovery after supervised worker loss');
  const beforeRace = await candidateNow(), raceStarted = Date.now();
  const contested = await Promise.all(machines.flatMap(machine => Array.from({ length: 8 }, async () => {
    const response = await fetch(`${url}/api/work/${unsupervised.id}/claim`, { method: 'POST', headers: { Authorization: `Bearer ${machine.actor.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: '{}', signal: AbortSignal.timeout(10_000) });
    assert.ok([200, 409].includes(response.status)); return { machine, status: response.status, work: await response.json() };
  })));
  const afterRace = await candidateNow();
  const winners = contested.filter(c => c.status === 200);
  assert.equal(winners.length, 1);
  const stopped = winners[0].machine, replacement = machines.find(m => m !== stopped);
  let work = winners[0].work;
  assert.equal(work.lease.owner, stopped.actor.id); assert.equal(work.epoch, 1);
  assertFence('The claimed lease', work.lease.expiresAt, beforeRace, afterRace, fences.leaseMs);
  const history = await request(`events?work=${unsupervised.id}`, operator);
  assert.equal(history.filter(e => e.kind === 'claim').length, 1);
  cases.push('exclusive-claim');

  await request(`work/${unsupervised.id}/workspace`, stopped.actor, worktree(stopped, unsupervised, 1));
  await request(`work/${supervised.id}/claim`, stopped.actor, {});
  await request(`work/${supervised.id}/workspace`, stopped.actor, worktree(stopped, supervised, 1));
  await request(`work/${supervised.id}/quarantine`, stopped.actor, { epoch: 1, settlementHash });
  const beforeLaunch = await candidateNow(), launchStarted = Date.now();
  const launched = await request(`work/${supervised.id}/launch`, stopped.actor, { epoch: 1, settlementHash });
  const afterLaunch = await candidateNow();
  const fence = launched.containmentQuarantine;
  assertFence('Launch authority', fence.launchExpiresAt, beforeLaunch, afterLaunch, fences.launchAuthorityMs);
  // The candidate reports both endpoints of this fence, so its own clock must also span the default.
  assert.ok(Date.parse(fence.launchExpiresAt) - Date.parse(fence.launchAcknowledgedAt) >= fences.launchAuthorityMs, 'Launch authority is shorter than the required safety default');
  // The live item refuses on ownership; the supervised item refuses on its containment fence first.
  assert.match((await request(`work/${unsupervised.id}/claim`, replacement.actor, {}, 409)).error, /active owner/);
  assert.match((await request(`work/${supervised.id}/claim`, replacement.actor, {}, 409)).error, /quarantined by unverified containment/);
  // Recovery itself is fenced: an operator must not clear containment and hand epoch 2 to another
  // machine while the stopped machine's supervisor may still exercise its launch authority.
  assert.match((await request(`work/${supervised.id}/rework`, operator, recovery, 409)).error, /remains fenced/);
  // Surrendering the lease is not enough. Launch authority alone must keep recovery refused.
  await request(`work/${supervised.id}/release`, stopped.actor, { epoch: 1 });
  assert.match((await request(`work/${supervised.id}/rework`, operator, recovery, 409)).error, /remains fenced/);
  await waitForFences([unsupervised.id, supervised.id]);
  // Deadlines are candidate-reported; these fences must also have held on this harness's own clock.
  assert.ok(Date.now() - raceStarted >= fences.leaseMs, 'The lease fence was surrendered before its reported deadline');
  assert.ok(Date.now() - launchStarted >= fences.launchAuthorityMs, 'Launch authority was surrendered before its reported deadline');

  assert.match((await request(`work/${unsupervised.id}/heartbeat`, stopped.actor, { epoch: 1 }, 409)).error, /Lease missing, expired, or superseded/);
  work = await request(`work/${unsupervised.id}/claim`, replacement.actor, {});
  assert.equal(work.epoch, 2); assert.equal(work.lease.owner, replacement.actor.id);
  assert.equal(work.lastAssignment.owner, replacement.actor.id); assert.equal(work.lastAssignment.epoch, 2);
  cases.push('expiry-recovery');

  for (const command of leaseScopedCommands) {
    const refusal = await request(`work/${unsupervised.id}/${command}`, stopped.actor, staleBody(command, unsupervised, stopped), 409);
    assert.match(refusal.error, /Lease missing, expired, or superseded/);
  }
  assert.match((await request(`work/${unsupervised.id}/claim`, stopped.actor, {}, 409)).error, /active owner/);
  cases.push('stale-owner-refused');

  const reserved = worktree(stopped, unsupervised, 1), own = worktree(replacement, unsupervised, 2);
  for (const overlapping of [{ ...own, host: reserved.host, path: `${reserved.path}/src` }, { ...own, branch: reserved.branch }])
    assert.match((await request(`work/${unsupervised.id}/workspace`, replacement.actor, overlapping, 409)).error, /already reserved or overlaps/);
  work = await request(`work/${unsupervised.id}/workspace`, replacement.actor, own);
  assert.deepEqual(work.workspaces.map(w => [w.owner, w.host, w.path, w.epoch]),
    [[stopped.actor.id, reserved.host, reserved.path, 1], [replacement.actor.id, own.host, own.path, 2]]);
  cases.push('isolated-worktrees');

  assert.match((await request(`work/${supervised.id}/claim`, replacement.actor, {}, 409)).error, /quarantined by unverified containment/);
  await request(`work/${supervised.id}/rework`, operator, recovery);
  assert.match((await request(`work/${supervised.id}/settle`, stopped.actor, { epoch: 1, settlementToken }, 409)).error, /Containment quarantine is missing/);
  work = await request(`work/${supervised.id}/claim`, replacement.actor, {});
  assert.equal(work.epoch, 2); assert.equal(work.lease.owner, replacement.actor.id); assert.equal(work.containmentQuarantine, null);
  work = await request(`work/${supervised.id}/workspace`, replacement.actor, worktree(replacement, supervised, 2));
  assert.equal(work.workspaces.length, 2);
  cases.push('supervised-fence-recovery');

  assert.deepEqual(cases, requiredCases);
  return cases.map(id => ({ id, result: 'pass' }));
}
