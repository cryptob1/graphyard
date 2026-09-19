// Trusted HTTP harness. Run this from protected source, never from the candidate checkout.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export const requiredCases = ['anonymous-denied', 'exclusive-claim', 'stale-epoch', 'worker-proof-denied', 'dependency-blocked'];

// Records each case as it runs so an interrupted exercise still reports which cases
// completed, which one failed, and which never executed. A started case counts as
// failing until it finishes, so a throw anywhere keeps the failure attributed.
export function createInventory() {
  const cases = requiredCases.map(id => ({ id, result: 'skipped' }));
  const find = id => { const entry = cases.find(c => c.id === id); if (!entry) throw new Error(`Unknown acceptance case ${id}`); return entry; };
  let running = null;
  return {
    get cases() { return cases.map(entry => ({ ...entry })); },
    get executed() { return cases.filter(entry => entry.result !== 'skipped').length; },
    get skipped() { return cases.filter(entry => entry.result === 'skipped').length; },
    get complete() { return running === null && cases.every(entry => entry.result === 'pass'); },
    begin(id) {
      if (running !== null) throw new Error(`Acceptance case ${running} did not finish`);
      if (find(id).result !== 'skipped') throw new Error(`Acceptance case ${id} ran twice`);
      find(id).result = 'fail'; running = id;
    },
    pass(id) { if (running !== id) throw new Error(`Acceptance case ${id} was not started`); find(id).result = 'pass'; running = null; },
  };
}

export async function exercise(url, principals, inventory = createInventory()) {
  const operator = principals.find(p => p.role === 'admin');
  const workers = principals.filter(p => p.role === 'worker');
  assert.ok(operator && workers.length >= 32);
  async function request(path, actor, data, status = 200) {
    const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST',
      headers: { ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, status, `Unexpected status for ${path}`); return response.json();
  }
  const input = { title: 'Trusted acceptance probe', criteria: [{ id: 'AC-1', text: 'Claims are exclusive', proofs: ['integration:claim-safety'] }] };
  inventory.begin('anonymous-denied');
  await request('work', undefined, undefined, 401); inventory.pass('anonymous-denied');
  inventory.begin('exclusive-claim');
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
  inventory.pass('exclusive-claim');
  inventory.begin('stale-epoch');
  await request(`work/${work.id}/release`, winner.actor, { epoch: 1 });
  const replacement = workers.find(w => w.id !== winner.actor.id);
  work = await request(`work/${work.id}/claim`, replacement, {}); assert.equal(work.epoch, 2);
  for (const command of ['heartbeat', 'release']) await request(`work/${work.id}/${command}`, winner.actor, { epoch: 1 }, 409);
  await request(`work/${work.id}/submit`, winner.actor, { epoch: 1, pr: 1 }, 409); inventory.pass('stale-epoch');
  inventory.begin('worker-proof-denied');
  const proof = { proof: 'integration:claim-safety', sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1, result: 'pass', executed: 5, skipped: 0 };
  await request(`work/${work.id}/evidence`, replacement, { ...proof, trusted: true }, 400);
  work = await request(`work/${work.id}/evidence`, replacement, proof);
  assert.equal(work.evidence.at(-1).trusted, false); assert.notEqual(work.stage, 'done'); inventory.pass('worker-proof-denied');
  inventory.begin('dependency-blocked');
  const dependent = await request('work', operator, { ...input, dependencies: [work.id] });
  await request(`work/${dependent.id}/ready`, operator, {});
  await request(`work/${dependent.id}/claim`, replacement, {}, 409); inventory.pass('dependency-blocked');
  assert.deepEqual(inventory.cases, requiredCases.map(id => ({ id, result: 'pass' })));
  return inventory.cases;
}
