import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { exerciseRefusal, type Principal, type Work } from '../src/model.js';
import { producerPrompt, proofOutcome } from '../src/producer.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-135: a proof that passes against an unchanged tree proves nothing. A pass is trusted only
// beside the producer's run of the same proof failing against a tree with its criterion's
// behaviour removed; anything else is recorded as not exercising its criterion.

const operator: Principal = { id: 'operator', role: 'admin' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['integration:*', 'unit:*'] };
const principals = [operator, producer];
const tokens = new Map(principals.map(p => [p.id, `${p.id}-${'t'.repeat(32)}`]));
const head = 'c'.repeat(40), base = 'd'.repeat(40);
const PROOF = 'integration:exercised', OTHER = 'unit:exercised-too';
const BEHAVIOUR = 'the lease expiry check in claim()';

let database: EmbeddedPostgres, store: Store, engine: Engine;
let http: ReturnType<typeof server>, url: string;
const id = () => randomUUID();

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 135;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('exercise'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('exercise_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/exercise_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  http = server(engine, principals.map(p => ({ ...p, token: tokens.get(p.id)! })));
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

const create = () => engine.execute(operator, 'create', null, { title: 'Exercise fixture', criteria: [
  { id: 'AC-1', text: 'An expired lease cannot claim', proofs: [PROOF] },
  { id: 'AC-2', text: 'Something else holds', proofs: [OTHER] },
] }, id()) as Promise<Work>;
// Submitted over the producer's own HTTP route, exactly as `graphyard evidence KEY FILE` does.
async function submit(work: Work, body: Record<string, unknown>) {
  const response = await fetch(`${url}/api/work/${work.id}/evidence`, { method: 'POST',
    headers: { Authorization: `Bearer ${tokens.get(producer.id)}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() },
    body: JSON.stringify({ proof: PROOF, sha: head, baseSha: base, policyRevision: work.policyRevision, result: 'pass', executed: 4, skipped: 0, ...body }) });
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json() as Work).evidence.at(-1)!;
}
const refusals = async (work: Work) => (await store.pool.query("SELECT payload FROM events WHERE work_id=$1 AND kind='evidence.exercise.refused' ORDER BY seq", [work.id])).rows.map(row => row.payload.details);
const binding = { sha: head, baseSha: base, policyRevision: 1 };

test('integration:non-discriminating-proof-refused a proof that passes against the tree with its behaviour removed is refused, not trusted', async () => {
  const work = await create();
  const evidence = await submit(work, { exercise: { criterion: 'AC-1', behaviour: BEHAVIOUR, result: 'pass', executed: 4 } });
  assert.equal(evidence.trusted, false);
  assert.equal(evidence.result, 'pass', 'the outcome is kept as submitted; only its trust is withheld');
  assert.match(evidence.unexercised!, /does not exercise AC-1/);
  assert.match(evidence.unexercised!, /recorded as not exercising its criterion rather than as passing/);
  assert.deepEqual(evidence.exercise, { criterion: 'AC-1', behaviour: BEHAVIOUR, result: 'pass', executed: 4 });
  // The producer ledger reports the proof as not exercising, not as passing or merely untrusted.
  const stored = (await store.list()).find(item => item.id === work.id)!;
  assert.equal(proofOutcome(stored, binding, PROOF), 'unexercised');
  const [refused] = await refusals(work);
  assert.equal(refused.proof, PROOF);
  assert.equal(refused.reason, evidence.unexercised);
});

test('integration:non-discriminating-proof-refused a pass with no run against a stripped tree is refused as not exercising', async () => {
  const work = await create();
  const evidence = await submit(work, {});
  assert.equal(evidence.trusted, false);
  assert.match(evidence.unexercised!, new RegExp(`^${PROOF} does not exercise AC-1: .*no run of it against a tree with the criterion's behaviour removed was recorded`));
  // A run that executed nothing, or that names a criterion the proof is not attached to, shows nothing either.
  assert.match((await submit(work, { exercise: { criterion: 'AC-1', behaviour: BEHAVIOUR, result: 'fail', executed: 0 } })).unexercised!, /no case ran against the tree/);
  const misattached = await submit(work, { exercise: { criterion: 'AC-2', behaviour: BEHAVIOUR, result: 'fail', executed: 4 } });
  assert.equal(misattached.trusted, false);
  assert.match(misattached.unexercised!, /names AC-2 .* but it is attached to AC-1/);
  assert.equal((await refusals(work)).length, 3);
});

test('integration:non-discriminating-proof-refused a discriminating proof is trusted', async () => {
  const work = await create();
  const evidence = await submit(work, { exercise: { criterion: 'AC-1', behaviour: BEHAVIOUR, result: 'fail', executed: 4 } });
  assert.equal(evidence.trusted, true);
  assert.equal(evidence.unexercised, undefined);
  assert.deepEqual(evidence.exercise, { criterion: 'AC-1', behaviour: BEHAVIOUR, result: 'fail', executed: 4 });
  const stored = (await store.list()).find(item => item.id === work.id)!;
  assert.equal(proofOutcome(stored, binding, PROOF), 'pass');
  assert.deepEqual(await refusals(work), []);
  // A failing outcome needs no stripped run: it is trusted as the failure it reports.
  const failed = await submit(work, { proof: OTHER, result: 'fail', executed: 2 });
  assert.equal(failed.trusted, true);
  assert.equal(failed.unexercised, undefined);
});

test('integration:non-discriminating-proof-refused the producer is told to record the stripped run and docs state how a non-exercising proof is reported', async () => {
  const prompt = producerPrompt({ repository: 'owner/project', cliPath: '/cli.mjs' }, { key: 'GY-1', pr: 1, ...binding, group: 'integration', proofs: [PROOF], checkout: '/managed/proof/GY-1' }, { principal: producer.id });
  assert.match(prompt, /A proof that passes against an unchanged tree proves nothing/);
  assert.match(prompt, /"exercise":\{"criterion":"<the criterion id, such as AC-1>","behaviour":/);
  assert.match(prompt, /git worktree add --detach \/managed\/proof\/GY-1\/exercise/);
  const docs = await readFile(new URL('../docs/master-agent.md', import.meta.url), 'utf8');
  const start = docs.indexOf('### Proofs must exercise their criterion');
  assert.ok(start >= 0, 'docs/master-agent.md has the section');
  // The section up to the next heading, read as prose: line breaks and emphasis are presentation.
  const section = docs.slice(start, docs.indexOf('\n### ', start + 1)).replace(/\*\*/g, '').replace(/\s+/g, ' ');
  for (const phrase of ['"exercise"', 'criterion', 'behaviour', 'recorded as not exercising its criterion rather than as passing', 'unexercised', 'evidence.exercise.refused'])
    assert.ok(section.includes(phrase), `docs state ${phrase}`);
});

test('unit:refusal-names-criterion-and-behaviour the refusal names the proof, the criterion and the removed behaviour', () => {
  const work = { key: 'GY-1', id: 'w', stage: 'build', plannedFiles: [], criteria: [{ id: 'AC-1', text: 'x', proofs: [PROOF] }, { id: 'AC-2', text: 'y', proofs: [OTHER] }] } as unknown as Work;
  const reason = exerciseRefusal(work, [work], { proof: PROOF, result: 'pass', exercise: { criterion: 'AC-1', behaviour: BEHAVIOUR, result: 'pass', executed: 3 } })!;
  for (const named of [PROOF, 'AC-1', BEHAVIOUR]) assert.ok(reason.includes(named), `${named} appears in: ${reason}`);
  assert.ok(!reason.includes('AC-2'), 'only the criterion the proof is attached to is named');
  // A proof attached to one criterion may leave it out of its run; the refusal still names it.
  const derived = exerciseRefusal(work, [work], { proof: PROOF, result: 'pass', exercise: { behaviour: BEHAVIOUR, result: 'pass', executed: 3 } })!;
  for (const named of [PROOF, 'AC-1', BEHAVIOUR]) assert.ok(derived.includes(named), `${named} appears in: ${derived}`);
  // A proof attached to several criteria must say which one its run exercises.
  const shared = { ...work, criteria: [{ id: 'AC-1', text: 'x', proofs: [PROOF] }, { id: 'AC-3', text: 'z', proofs: [PROOF] }] } as unknown as Work;
  const unnamed = exerciseRefusal(shared, [shared], { proof: PROOF, result: 'pass', exercise: { behaviour: BEHAVIOUR, result: 'fail', executed: 3 } })!;
  for (const named of [PROOF, 'AC-1, AC-3', BEHAVIOUR]) assert.ok(unnamed.includes(named), `${named} appears in: ${unnamed}`);
  assert.equal(exerciseRefusal(shared, [shared], { proof: PROOF, result: 'pass', exercise: { criterion: 'AC-3', behaviour: BEHAVIOUR, result: 'fail', executed: 3 } }), null);
  // The same three are what the control plane records for the worker to act on.
  assert.equal(exerciseRefusal(work, [work], { proof: PROOF, result: 'pass', exercise: { criterion: 'AC-1', behaviour: BEHAVIOUR, result: 'fail', executed: 3 } }), null);
  assert.equal(exerciseRefusal(work, [work], { proof: PROOF, result: 'fail' }), null);
  assert.equal(exerciseRefusal(work, [work], { proof: 'integration:unattached', result: 'pass' }), null, 'a proof attached to no criterion has none to exercise');
});

test('unit:refusal-names-criterion-and-behaviour the recorded reason carries all three', async () => {
  const work = await create();
  const evidence = await submit(work, { exercise: { criterion: 'AC-1', behaviour: BEHAVIOUR, result: 'pass', executed: 2 } });
  for (const named of [PROOF, 'AC-1', BEHAVIOUR]) assert.ok(evidence.unexercised!.includes(named), `${named} appears in the evidence record`);
  const [refused] = await refusals(work);
  for (const named of [PROOF, 'AC-1', BEHAVIOUR]) assert.ok(refused.reason.includes(named), `${named} appears in the ledger reason`);
  assert.deepEqual({ proof: refused.proof, criteria: refused.criteria, behaviour: refused.behaviour }, { proof: PROOF, criteria: ['AC-1'], behaviour: BEHAVIOUR });
});
