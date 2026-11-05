import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { withDatabase } from './helpers/postgres.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import type { Principal } from '../src/model.js';

// Every fixture item carries an E2E proof and declares the serve its trial needs.
import { repositoryPolicy, setRepositoryPolicy } from '../src/model-boundary/repository-policy.js';
setRepositoryPolicy({ ...repositoryPolicy(), e2e: { pendingOutcomes: 'non-blocking', serve: { command: 'true', url: 'http://127.0.0.1:9', readySeconds: 1 } } });

// Cross-machine lease recovery, exercised inline against the real HTTP server and Postgres
// (GY-3001: the trusted-contract scripts are deleted; the exercise lives here, in the suite).
// Two machines are modelled exactly as the fleet guide requires: distinct worker principals,
// distinct host IDs, and isolated worktrees.

const requiredCases = ['exclusive-claim', 'expiry-recovery', 'stale-owner-refused', 'isolated-worktrees'];
// The shipped safety default this exercise certifies. A candidate that shortens the lease turns a
// transient disconnect into premature reassignment, so a short lease must fail rather than pass quickly.
// Only this suite substitutes a shorter lease, against its own short-leased engine.
const requiredFences = { leaseMs: 120_000 };
// Bounds the wall-clock wait for the lease the candidate itself reports.
const recoveryBudgetMs = 600_000;
// A fence created between two candidate clock reads is bounded by those reads, so the slack this
// exercise grants a candidate is never larger than one observed window. A wider window fails the run.
const measurementWindowMs = 10_000;

/** Records each case as it runs so an interrupted exercise still reports which cases completed. */
function createInventory() {
  const cases = requiredCases.map(id => ({ id, result: 'skipped' }));
  const find = (id: string) => { const entry = cases.find(c => c.id === id); if (!entry) throw new Error(`Unknown acceptance case ${id}`); return entry; };
  let running: string | null = null;
  return {
    get cases() { return cases.map(entry => ({ ...entry })); },
    get executed() { return cases.filter(entry => entry.result !== 'skipped').length; },
    get skipped() { return cases.filter(entry => entry.result === 'skipped').length; },
    get complete() { return running === null && cases.every(entry => entry.result === 'pass'); },
    begin(id: string) {
      if (running !== null) throw new Error(`Acceptance case ${running} did not finish`);
      if (find(id).result !== 'skipped') throw new Error(`Acceptance case ${id} ran twice`);
      find(id).result = 'fail'; running = id;
    },
    pass(id: string) { if (running !== id) throw new Error(`Acceptance case ${id} was not started`); find(id).result = 'pass'; running = null; },
  };
}

// Every command an owner may only issue while holding its own current lease.
const leaseScopedCommands = ['heartbeat', 'release', 'workspace', 'submit', 'blocked'];

async function exercise(url: string, principals: unknown[], inventory = createInventory(), fences = requiredFences) {
  const operator = (principals as (Principal & { token: string })[]).find(p => p.role === 'admin');
  const workers = (principals as (Principal & { token: string })[]).filter(p => p.role === 'worker');
  assert.ok(operator && workers.length >= 2);
  const machines = workers.slice(0, 2).map((actor, index) => ({ actor, host: `acceptance-machine-${index + 1}` }));
  async function request(path: string, actor: any, data?: unknown, status = 200) {
    const response = await fetch(`${url}/api/${path}`, { method: data === undefined ? 'GET' : 'POST',
      headers: { ...(actor ? { Authorization: `Bearer ${actor.token}` } : {}), 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, status, `Unexpected status for ${path}`); return response.json();
  }
  async function create(title: string) {
    const work = await request('work', operator, { title, type: 'chore', criteria: [{ id: 'AC-1', text: 'A replacement machine recovers expired work', proofs: ['integration:herdr-recovery', 'e2e:fixture'] }] });
    return request(`work/${work.id}/ready`, operator, {});
  }
  const worktree = (machine: (typeof machines)[number], work: any, epoch: number) => ({ epoch, host: machine.host, path: `/srv/graphyard/${machine.host}/${work.key.toLowerCase()}-${epoch}`, branch: `graphyard/${work.key.toLowerCase()}-${epoch}` });
  // submit names a head: the HTTP route refuses a pull-request number before the lease fence runs.
  const staleBody = (command: string, work: any, machine: (typeof machines)[number]) => ({ heartbeat: { epoch: 1 }, release: { epoch: 1 }, blocked: { epoch: 1, reason: 'Stale owner note' },
    workspace: worktree(machine, work, 1), submit: { epoch: 1, head: 'a'.repeat(40) } } as Record<string, unknown>)[command];
  const candidateNow = async () => Date.parse((await request('status', operator)).now);
  // A fence created between two candidate clock reads runs for at most `deadline - before`, so this
  // refuses any default shorter than the requirement while granting no more slack than that window.
  function assertFence(label: string, deadline: string, before: number, after: number, minimum: number) {
    const expiresAt = Date.parse(deadline);
    assert.ok(Number.isFinite(expiresAt), `${label} reported no deadline`);
    assert.ok(after >= before && after - before <= measurementWindowMs, `${label} could not be measured within a bounded window`);
    assert.ok(expiresAt - before >= minimum, `${label} is shorter than the required ${minimum} ms safety default`);
  }
  // Wait on the candidate's own reported fences, measured by its clock, not this harness's.
  async function waitForFences(ids: string[]) {
    const started = Date.now();
    for (;;) {
      const [items, status] = await Promise.all([request('work', operator), request('status', operator)]);
      const observed = Date.parse(status.now);
      const fences = items.filter((w: any) => ids.includes(w.id)).map((w: any) => w.lease ? Date.parse(w.lease.expiresAt) : 0);
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
  const stopped = winners[0]!.machine, replacement = machines.find(m => m !== stopped);
  let work = winners[0]!.work;
  assert.equal(work.lease.owner, stopped!.actor.id); assert.equal(work.epoch, 1);
  assertFence('The claimed lease', work.lease.expiresAt, beforeRace, afterRace, fences.leaseMs);
  const history = await request(`events?work=${unsupervised.id}`, operator);
  assert.equal(history.filter((e: any) => e.kind === 'claim').length, 1);
  inventory.pass('exclusive-claim');

  inventory.begin('expiry-recovery');
  await request(`work/${unsupervised.id}/workspace`, stopped!.actor, worktree(stopped!, unsupervised, 1));
  // The live item refuses on ownership.
  assert.match((await request(`work/${unsupervised.id}/claim`, replacement!.actor, {}, 409)).error, /active owner/);
  await waitForFences([unsupervised.id]);
  // The deadline is candidate-reported; the lease must also have held on this harness's own clock.
  assert.ok(Date.now() - raceStarted >= fences.leaseMs, 'The lease fence was surrendered before its reported deadline');

  assert.match((await request(`work/${unsupervised.id}/heartbeat`, stopped!.actor, { epoch: 1 }, 409)).error, /Lease missing, expired, or superseded/);
  work = await request(`work/${unsupervised.id}/claim`, replacement!.actor, {});
  assert.equal(work.epoch, 2); assert.equal(work.lease.owner, replacement!.actor.id);
  assert.equal(work.lastAssignment.owner, replacement!.actor.id); assert.equal(work.lastAssignment.epoch, 2);
  inventory.pass('expiry-recovery');

  inventory.begin('stale-owner-refused');
  for (const command of leaseScopedCommands) {
    const refusal = await request(`work/${unsupervised.id}/${command}`, stopped!.actor, staleBody(command, unsupervised, stopped!), 409);
    assert.match(refusal.error, /Lease missing, expired, or superseded/);
  }
  assert.match((await request(`work/${unsupervised.id}/claim`, stopped!.actor, {}, 409)).error, /active owner/);
  inventory.pass('stale-owner-refused');

  inventory.begin('isolated-worktrees');
  const reserved = worktree(stopped!, unsupervised, 1), own = worktree(replacement!, unsupervised, 2);
  for (const overlapping of [{ ...own, host: reserved.host, path: `${reserved.path}/src` }, { ...own, branch: reserved.branch }])
    assert.match((await request(`work/${unsupervised.id}/workspace`, replacement!.actor, overlapping, 409)).error, /already reserved or overlaps/);
  work = await request(`work/${unsupervised.id}/workspace`, replacement!.actor, own);
  assert.deepEqual(work.workspaces.map((w: any) => [w.owner, w.host, w.path, w.epoch]),
    [[stopped!.actor.id, reserved.host, reserved.path, 1], [replacement!.actor.id, own.host, own.path, 2]]);
  inventory.pass('isolated-worktrees');

  assert.deepEqual(inventory.cases, requiredCases.map(id => ({ id, result: 'pass' })));
  return inventory.cases;
}

// A real lease is minutes long. The exercise reads it from the candidate, so a short-leased
// deployment exercises the identical recovery path within a test run once this suite states the
// lease its own engine ships; a run against the production default always requires it.
const leaseSeconds = 5;
const shortFences = { leaseMs: leaseSeconds * 1000 };
const operator: Principal = { id: 'recovery-operator', role: 'admin' };
const machines = [1, 2].map(n => ({ id: `recovery-machine-${n}`, role: 'worker' as const, token: `test-machine-${n}-${'x'.repeat(32)}` }));
let store: Store; let http: ReturnType<typeof server>; let url: string;
const identities = () => [{ ...operator, token: 'r'.repeat(32) }, ...machines];
const run = (target: string, principals: unknown[], fences?: typeof shortFences, inventory = createInventory()) => exercise(target, principals, inventory, fences);
before(async () => {
  // The suite connects over TCP, so no Unix-domain socket is needed (GY-3001): disabling it
// lets this run where socket creation is unavailable while changing nothing over TCP.

  store = await withDatabase('herdr-recovery'); await store.init();
  http = server(new Engine(store, leaseSeconds, 'owner/project'), [{ ...operator, token: 'r'.repeat(32) }, ...machines]);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); });

// Proxy the real server and weaken exactly one refusal, proving each case is not vacuous.
// `preserve` passes that many genuine refusals on the route through untouched first, so a later
// assertion is shown to carry force by itself instead of inheriting it from an earlier check on
// the same route. `refusals` reports how many refusals the run reached, which pins down where it
// stopped: a weakened run that never reached the assertion under test would prove nothing.
async function withoutRefusal(route: string, body: (weakened: string, refusals: () => number) => Promise<void>, preserve = 0) {
  let refusals = 0;
  const forging = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
    const upstream = await fetch(`${url}${req.url}`, { method: req.method, body: chunks.length ? Buffer.concat(chunks) : undefined,
      headers: Object.fromEntries(['authorization', 'content-type', 'idempotency-key'].filter(h => req.headers[h]).map(h => [h, String(req.headers[h])])) });
    const payload = await upstream.text();
    const refusal = req.url!.endsWith(route) && upstream.status === 409;
    if (refusal) refusals += 1;
    res.writeHead(refusal && refusals > preserve ? 200 : upstream.status, { 'Content-Type': 'application/json' });
    res.end(payload);
  });
  await new Promise<void>(resolve => forging.listen(0, '127.0.0.1', resolve));
  try { await body(`http://127.0.0.1:${(forging.address() as any).port}`, () => refusals); }
  finally { await new Promise<void>(resolve => forging.close(() => resolve())); }
}

test('unit:herdr-recovery — two machines recover an expired lease against the real HTTP server and Postgres', async () => {
  const result = await run(url, identities(), shortFences);
  assert.deepEqual(result, requiredCases.map((id: string) => ({ id, result: 'pass' })));
});

test('the exercise requires the shipped lease safety default', async () => {
  // Bind the certified minimums to the defaults this repository actually ships, so lowering a
  // fence in src/engine.ts fails here instead of quietly certifying the shortened deployment.
  assert.equal(requiredFences.leaseMs, new Engine(store).leaseSeconds * 1000);
  assert.deepEqual(requiredFences, { leaseMs: 120_000 });
  // A candidate whose fences are seconds long cannot produce passing evidence for the real defaults.
  await assert.rejects(run(url, identities()), /shorter than the required 120000 ms safety default/);
});

test('the lease minimum is enforced', async () => {
  await assert.rejects(run(url, identities(), { ...shortFences, leaseMs: requiredFences.leaseMs }),
    /The claimed lease is shorter than the required 120000 ms safety default/);
});

test('a candidate that lets every racing claim win cannot produce passing evidence', async () => {
  // The ledger attributes the interruption: the racing case stays failing, nothing after it ran,
  // so the run reports exactly that instead of an all-skipped or all-failed inventory.
  const inventory = createInventory();
  await withoutRefusal('/claim', async weakened =>
    assert.rejects(run(weakened, identities(), shortFences, inventory), /Expected values to be strictly equal/));
  assert.deepEqual(inventory.cases, requiredCases.map((id: string) => ({ id, result: id === 'exclusive-claim' ? 'fail' : 'skipped' })));
  assert.equal(inventory.executed, 1); assert.equal(inventory.skipped, requiredCases.length - 1); assert.equal(inventory.complete, false);
});

test('the exercise refuses to run without two distinct machine identities', async () => {
  await assert.rejects(run(url, [{ ...operator, token: 'r'.repeat(32) }, machines[0]], shortFences));
});
