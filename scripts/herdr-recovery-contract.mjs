// Trusted HTTP harness for cross-machine lease recovery. Run this from protected source, never from the candidate checkout.
// Graphyard recognises a Herdr machine only through the identities it authenticates and records, so two machines are
// modelled exactly as the fleet guide requires: distinct worker principals, distinct host IDs, and isolated worktrees.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createInventory as createCaseInventory } from './case-inventory.mjs';

export const requiredCases = ['exclusive-claim', 'expiry-recovery', 'stale-owner-refused', 'isolated-worktrees'];
// Bound to this contract's fixed inventory; see case-inventory.mjs for the ledger semantics.
export const createInventory = () => createCaseInventory(requiredCases);
// Every command an owner may only issue while holding its own current lease.
const leaseScopedCommands = ['heartbeat', 'release', 'workspace', 'submit', 'blocked'];
// The shipped safety default this contract certifies. A candidate that shortens the lease turns a
// transient disconnect into premature reassignment, so a short lease must fail rather than pass quickly.
// Only the repository's own test suite substitutes a shorter lease, against its own short-leased engine.
export const requiredFences = { leaseMs: 120_000 };
// Bounds the wall-clock wait for the lease the candidate itself reports.
const recoveryBudgetMs = 600_000;
// A fence created between two candidate clock reads is bounded by those reads, so the slack this
// contract grants a candidate is never larger than one observed window. A wider window fails the run.
const measurementWindowMs = 10_000;

export async function exercise(url, principals, inventory = createInventory(), fences = requiredFences) {
  const operator = principals.find(p => p.role === 'admin');
  const workers = principals.filter(p => p.role === 'worker');
  assert.ok(operator && workers.length >= 2);
  const machines = workers.slice(0, 2).map((actor, index) => ({ actor, host: `acceptance-machine-${index + 1}` }));
  async function request(path, actor, data, status = 200) {
    const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST',
      headers: { ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, status, `Unexpected status for ${path}`); return response.json();
  }
  async function create(title) {
    const work = await request('work', operator, { title, type: 'chore', criteria: [{ id: 'AC-1', text: 'A replacement machine recovers expired work', proofs: ['integration:herdr-recovery'] }] });
    return request(`work/${work.id}/ready`, operator, {});
  }
  const worktree = (machine, work, epoch) => ({ epoch, host: machine.host, path: `/srv/graphyard/${machine.host}/${work.key.toLowerCase()}-${epoch}`, branch: `graphyard/${work.key.toLowerCase()}-${epoch}` });
  const staleBody = (command, work, machine) => ({ heartbeat: { epoch: 1 }, release: { epoch: 1 }, blocked: { epoch: 1, reason: 'Stale owner note' },
    workspace: worktree(machine, work, 1), submit: { epoch: 1, pr: 1 } }[command]);
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
      const fences = items.filter(w => ids.includes(w.id)).map(w => w.lease ? Date.parse(w.lease.expiresAt) : 0);
      const remaining = Math.max(...fences) - observed;
      if (remaining <= 0) return;
      assert.ok(Date.now() - started + remaining < recoveryBudgetMs, 'The lease did not expire within the recovery budget');
      await delay(Math.min(remaining + 1000, 15_000));
    }
  }

  // The item recovers from an expired lease on the second machine.
  const unsupervised = await create('Cross-machine recovery after lease expiry');
  inventory.begin('exclusive-claim');
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
  inventory.pass('exclusive-claim');

  inventory.begin('expiry-recovery');
  await request(`work/${unsupervised.id}/workspace`, stopped.actor, worktree(stopped, unsupervised, 1));
  // The live item refuses on ownership.
  assert.match((await request(`work/${unsupervised.id}/claim`, replacement.actor, {}, 409)).error, /active owner/);
  await waitForFences([unsupervised.id]);
  // The deadline is candidate-reported; the lease must also have held on this harness's own clock.
  assert.ok(Date.now() - raceStarted >= fences.leaseMs, 'The lease fence was surrendered before its reported deadline');

  assert.match((await request(`work/${unsupervised.id}/heartbeat`, stopped.actor, { epoch: 1 }, 409)).error, /Lease missing, expired, or superseded/);
  work = await request(`work/${unsupervised.id}/claim`, replacement.actor, {});
  assert.equal(work.epoch, 2); assert.equal(work.lease.owner, replacement.actor.id);
  assert.equal(work.lastAssignment.owner, replacement.actor.id); assert.equal(work.lastAssignment.epoch, 2);
  inventory.pass('expiry-recovery');

  inventory.begin('stale-owner-refused');
  for (const command of leaseScopedCommands) {
    const refusal = await request(`work/${unsupervised.id}/${command}`, stopped.actor, staleBody(command, unsupervised, stopped), 409);
    assert.match(refusal.error, /Lease missing, expired, or superseded/);
  }
  assert.match((await request(`work/${unsupervised.id}/claim`, stopped.actor, {}, 409)).error, /active owner/);
  inventory.pass('stale-owner-refused');

  inventory.begin('isolated-worktrees');
  const reserved = worktree(stopped, unsupervised, 1), own = worktree(replacement, unsupervised, 2);
  for (const overlapping of [{ ...own, host: reserved.host, path: `${reserved.path}/src` }, { ...own, branch: reserved.branch }])
    assert.match((await request(`work/${unsupervised.id}/workspace`, replacement.actor, overlapping, 409)).error, /already reserved or overlaps/);
  work = await request(`work/${unsupervised.id}/workspace`, replacement.actor, own);
  assert.deepEqual(work.workspaces.map(w => [w.owner, w.host, w.path, w.epoch]),
    [[stopped.actor.id, reserved.host, reserved.path, 1], [replacement.actor.id, own.host, own.path, 2]]);
  inventory.pass('isolated-worktrees');


  assert.deepEqual(inventory.cases, requiredCases.map(id => ({ id, result: 'pass' })));
  return inventory.cases;
}
