// Trusted HTTP harness for cross-machine lease recovery. Run this from protected source, never from the candidate checkout.
// Graphyard recognises a Herdr machine only through the identities it authenticates and records, so two machines are
// modelled exactly as the fleet guide requires: distinct worker principals, distinct host IDs, and isolated worktrees.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const requiredCases = ['exclusive-claim', 'expiry-recovery', 'stale-owner-refused', 'isolated-worktrees', 'supervised-fence-recovery'];
// Every command an owner may only issue while holding its own current lease.
const leaseScopedCommands = ['heartbeat', 'release', 'workspace', 'submit', 'blocked', 'quarantine', 'launch'];
// Bounds the wall-clock wait for the lease and launch fences the candidate itself reports.
const recoveryBudgetMs = 600_000;

export async function exercise(url, principals) {
  const operator = principals.find(p => p.role === 'admin');
  const workers = principals.filter(p => p.role === 'worker');
  assert.ok(operator && workers.length >= 2);
  const machines = workers.slice(0, 2).map((actor, index) => ({ actor, host: `acceptance-machine-${index + 1}` }));
  const settlementToken = randomBytes(32).toString('hex');
  const settlementHash = createHash('sha256').update(settlementToken).digest('hex');
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
  const staleBody = (command, work, machine) => ({ heartbeat: { epoch: 1 }, release: { epoch: 1 }, blocked: { epoch: 1, reason: 'Stale owner note' },
    workspace: worktree(machine, work, 1), submit: { epoch: 1, pr: 1 }, quarantine: { epoch: 1, settlementHash }, launch: { epoch: 1, settlementHash } }[command]);
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
  const contested = await Promise.all(machines.flatMap(machine => Array.from({ length: 8 }, async () => {
    const response = await fetch(`${url}/api/work/${unsupervised.id}/claim`, { method: 'POST', headers: { Authorization: `Bearer ${machine.actor.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: '{}', signal: AbortSignal.timeout(10_000) });
    assert.ok([200, 409].includes(response.status)); return { machine, status: response.status, work: await response.json() };
  })));
  const winners = contested.filter(c => c.status === 200);
  assert.equal(winners.length, 1);
  const stopped = winners[0].machine, replacement = machines.find(m => m !== stopped);
  let work = winners[0].work;
  assert.equal(work.lease.owner, stopped.actor.id); assert.equal(work.epoch, 1);
  const history = await request(`events?work=${unsupervised.id}`, operator);
  assert.equal(history.filter(e => e.kind === 'claim').length, 1);
  cases.push('exclusive-claim');

  await request(`work/${unsupervised.id}/workspace`, stopped.actor, worktree(stopped, unsupervised, 1));
  await request(`work/${supervised.id}/claim`, stopped.actor, {});
  await request(`work/${supervised.id}/workspace`, stopped.actor, worktree(stopped, supervised, 1));
  await request(`work/${supervised.id}/quarantine`, stopped.actor, { epoch: 1, settlementHash });
  const launched = await request(`work/${supervised.id}/launch`, stopped.actor, { epoch: 1, settlementHash });
  assert.ok(launched.containmentQuarantine.launchExpiresAt);
  // The live item refuses on ownership; the supervised item refuses on its containment fence first.
  assert.match((await request(`work/${unsupervised.id}/claim`, replacement.actor, {}, 409)).error, /active owner/);
  assert.match((await request(`work/${supervised.id}/claim`, replacement.actor, {}, 409)).error, /quarantined by unverified containment/);
  await waitForFences([unsupervised.id, supervised.id]);

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
  await request(`work/${supervised.id}/rework`, operator, { reason: 'Supervised machine stopped; recovering on the second machine', previousWorkerStopped: true });
  assert.match((await request(`work/${supervised.id}/settle`, stopped.actor, { epoch: 1, settlementToken }, 409)).error, /Containment quarantine is missing/);
  work = await request(`work/${supervised.id}/claim`, replacement.actor, {});
  assert.equal(work.epoch, 2); assert.equal(work.lease.owner, replacement.actor.id); assert.equal(work.containmentQuarantine, null);
  work = await request(`work/${supervised.id}/workspace`, replacement.actor, worktree(replacement, supervised, 2));
  assert.equal(work.workspaces.length, 2);
  cases.push('supervised-fence-recovery');

  assert.deepEqual(cases, requiredCases);
  return cases.map(id => ({ id, result: 'pass' }));
}
