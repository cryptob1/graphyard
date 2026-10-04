import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { evaluate, exerciseRefusal, type Evidence, type Observation, type Principal, type Work } from '../src/model.js';
import { producerPrompt, proofOutcome } from '../src/producer.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { openProducerRequest, reconcileAutoDispatch } from '../src/model/dispatch.js';
import { actionAccount, nextAction } from '../src/model/next-action.js';
import { neededDecision, rescopeOutcomes, routineDecision } from '../src/daemon/decisions.js';
import { describeDispatch } from '../src/master/status.js';
import { unansweredRequestAttention } from '../src/cli/unanswered-requests.js';

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

// GY-817: a mechanical proof recorded as not exercising its criterion is answered with a rework
// request carrying the producer's finding, as a failing proof is — never left as a producer
// request no executor launches. Pure: the item is built by hand and graded by the real evaluator.
const CI_APP = 15368, clock = new Date('2026-09-26T12:00:00.000Z');
const ago = (minutes: number) => new Date(clock.getTime() - minutes * 60_000).toISOString();
const UNIT = 'unit:tmp-reclaim', MUTATION = 'the guarded unlink in reclaimTmp()';
function unexercisedItem(options: { finding?: boolean } = {}): Work {
  const finding = exerciseRefusal({ key: 'GY-421', criteria: [{ id: 'AC-3', text: 'x', proofs: [UNIT] }] } as unknown as Work, [], { proof: UNIT, result: 'pass', exercise: { criterion: 'AC-3', behaviour: MUTATION, result: 'pass', executed: 3 } })!;
  const record = { id: '00000000-0000-4000-8000-000000000001', proof: UNIT, sha: head, baseSha: base, policyRevision: 1, producer: 'proof-runner', trusted: false, result: 'pass', executed: 3, skipped: 0, at: ago(5),
    exercise: { criterion: 'AC-3', behaviour: MUTATION, result: 'pass', executed: 3 }, unexercised: finding } as Evidence;
  const observation: Observation = { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: 421, branch: 'graphyard/gy-421-1', author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: CI_APP }, { name: 'typecheck', result: 'success', appId: CI_APP }], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null,
    files: ['src/tmp.ts'], scopeFiles: [], at: ago(1), prState: 'open', draft: false, baseTip: base, baseTipContained: true } as Observation;
  const work = { id: '22222222-3333-4444-8555-666666666666', key: 'GY-421', title: 'Unexercised fixture', description: '', type: 'bug', priority: 2, dependencies: [],
    criteria: [{ id: 'AC-3', text: 'An old tsx directory is reclaimed', proofs: [UNIT] }], policy: { checks: ['test', 'typecheck'], review: true }, plannedFiles: ['src/'], producerProofs: [],
    stage: 'build', revision: 5, policyRevision: 1, createdAt: ago(120), updatedAt: ago(5), stageEnteredAt: ago(60), ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'machine-a', path: '/tmp/gy-421', branch: 'graphyard/gy-421-1', epoch: 1, owner: 'agent-a' }], implementers: ['agent-a'], lastAssignment: { owner: 'agent-a', epoch: 1 },
    candidate: observation.candidate, submission: { epoch: 1, pr: 421 }, evidence: options.finding === false ? [] : [record], observation,
    gates: [], violations: [], blocker: null, queue: null, queueSequence: 0, queueHistory: [] } as unknown as Work;
  const graded = evaluate(work, [work], clock, [CI_APP]);
  const copy = structuredClone({ ...work, stage: graded.stage, gates: graded.gates, violations: graded.violations });
  reconcileAutoDispatch(copy, [copy], clock);
  return copy;
}

test('unit:nonexercising-proof-reworks a unit proof recorded as not exercising its criterion names request-rework and the loop requests that rework', () => {
  const work = unexercisedItem();
  assert.ok(openProducerRequest(work, 'unit'), 'the unit request stands, as it did on GY-421');
  const action = nextAction(work, [work], clock)!;
  assert.equal(action.kind, 'request-rework', `a rework, not a producer dispatch no executor launches: ${action.reason}`);
  assert.equal(action.inputs.kind, 'request-rework');
  const detail = action.inputs.kind === 'request-rework' ? action.inputs.detail : '';
  for (const named of [UNIT, 'AC-3', MUTATION]) assert.ok(detail.includes(named), `the detail names ${named}: ${detail}`);
  assert.match(detail, /survived/);
  assert.deepEqual(action.inputs.kind === 'request-rework' ? [action.inputs.pr, action.inputs.sha] : [], [421, head]);
  // The loop's decision input is the rework a failing proof gets, carrying the producer's finding.
  const decision = neededDecision(work, { autoMerge: true })!;
  assert.equal(decision.action, 'rework');
  assert.equal(decision.binding, `${head}:proof:unexercised:${UNIT}`);
  for (const named of [UNIT, 'AC-3', MUTATION]) assert.ok(decision.reason.includes(named), `the decision names ${named}: ${decision.reason}`);
  // Without the finding the same head is a proof dispatch: only the recorded finding reroutes it.
  const plain = unexercisedItem({ finding: false });
  const dispatch = nextAction(plain, [plain], clock)!;
  assert.equal(dispatch.kind, 'dispatch');
  assert.equal(neededDecision(plain, { autoMerge: true }), null);
});

test('unit:nonexercising-proof-named master status names the item as awaiting rework for a non-exercising proof, not an unanswered producer request', () => {
  const work = unexercisedItem();
  const request = openProducerRequest(work, 'unit')!;
  const session = { requestId: request.id, producer: 'p-1', profile: 'producer-a', agentName: 'producer-a-1', state: 'completed', attempt: 1, requestedAt: ago(51),
    resolution: `evidence does not exercise its criterion: ${work.evidence[0].unexercised}` };
  const dispatch = describeDispatch(work, { pending: [], completed: [] }, { producers: { pending: [], completed: [session] }, failures: [] }, clock.getTime());
  const [item, ...rest] = unansweredRequestAttention([{ key: work.key, dispatch: dispatch as any }]);
  assert.equal(rest.length, 0);
  assert.match(item.text, /^GY-421 is awaiting rework for a non-exercising proof: /);
  for (const named of [UNIT, 'AC-3', MUTATION]) assert.ok(item.text.includes(named), `the attention names ${named}: ${item.text}`);
  assert.doesNotMatch(item.text, /stood unanswered|Producer request for/);
  // A producer session that settled with no finding is still the unanswered request it was.
  const plain = describeDispatch(work, { pending: [], completed: [] }, { producers: { pending: [], completed: [session] }, failures: [] }, clock.getTime());
  const bare = { ...plain!, producers: plain!.producers.map(({ unexercised: _unexercised, ...entry }: any) => entry) };
  assert.match(unansweredRequestAttention([{ key: work.key, dispatch: bare as any }])[0].text, /^Producer request for unit proofs for GY-421 has stood unanswered/);
});

// GY-1177: the stripped-tree run removes the criterion's behaviour wherever it lives, and a
// nonexercising finding is resolved at the proof-criterion binding instead of looping rework.
test('unit:exercise-covers-base-behaviour the producer may remove a criterion\'s behaviour from the base code carrying it, and a pass beside that failing run is trusted', async () => {
  const prompt = producerPrompt({ repository: 'owner/project', cliPath: '/cli.mjs' }, { key: 'GY-1', pr: 1, ...binding, group: 'unit', proofs: [UNIT], checkout: '/managed/proof/GY-1' }, { principal: producer.id });
  const flat = prompt.replace(/\s+/g, ' ');
  assert.match(flat, /remove the behaviour the criterion the proof is attached to describes wherever it lives/);
  assert.match(flat, /the base code carrying it/);
  assert.doesNotMatch(flat, /revert or stub exactly the lines of the change/, 'the mutation is no longer confined to the change\'s lines');
  assert.match(flat, /A pass beside such a failing stripped run is trusted whichever of the two you removed/);
  const docs = await readFile(new URL('../docs/master-agent.md', import.meta.url), 'utf8');
  const start = docs.indexOf('### Proofs must exercise their criterion');
  const section = docs.slice(start, docs.indexOf('\n### ', start + 1)).replace(/\*\*/g, '').replace(/\s+/g, ' ');
  for (const phrase of ['wherever it lives', 'the base code carrying it', 'predates the change', 'A pass beside such a failing stripped run is trusted'])
    assert.ok(section.includes(phrase), `docs state ${phrase}`);
  // A preserved invariant: behaviour the base already carried, removed from the base code, fails the proof — trusted.
  const work = { key: 'GY-1132', criteria: [{ id: 'AC-2', text: 'A failing row yields to others during its retryAt backoff', proofs: [UNIT] }] } as unknown as Work;
  assert.equal(exerciseRefusal(work, [work], { proof: UNIT, result: 'pass', exercise: { criterion: 'AC-2', behaviour: 'the retryAt backoff exclusion in the base claim order', result: 'fail', executed: 3 } }), null);
});

const COVER = 'unit:tmp-reclaim-covered';
function withCover(options: { cover?: 'trusted' | 'missing' | 'failed' } = {}): Work {
  const work = unexercisedItem();
  work.criteria = [{ id: 'AC-3', text: 'An old tsx directory is reclaimed', proofs: [UNIT, COVER] }];
  if (options.cover !== 'missing') work.evidence.push({ id: '00000000-0000-4000-8000-000000000002', proof: COVER, sha: head, baseSha: base, policyRevision: 1, producer: 'proof-runner', trusted: true,
    result: options.cover === 'failed' ? 'fail' : 'pass', executed: 2, skipped: 0, at: ago(4), ...(options.cover === 'failed' ? {} : { exercise: { criterion: 'AC-3', behaviour: 'the age check in reclaimTmp()', result: 'fail', executed: 2 } }) } as Evidence);
  const graded = evaluate(work, [work], clock, [CI_APP]);
  const copy = structuredClone({ ...work, stage: graded.stage, gates: graded.gates, violations: graded.violations });
  reconcileAutoDispatch(copy, [copy], clock);
  return copy;
}

test('unit:nonexercising-finding-names-remedy the rework and the acceptance refusal name the criterion\'s statement and both remedies', () => {
  const work = unexercisedItem();
  const remedies = (text: string, where: string) => {
    for (const named of [UNIT, 'AC-3', MUTATION, 'An old tsx directory is reclaimed']) assert.ok(text.includes(named), `${where} names ${named}: ${text}`);
    assert.match(text, /make unit:tmp-reclaim's test fail when that statement is removed \(strengthen the test/, `${where} names the strengthen remedy`);
    assert.match(text, /re-bind AC-3 to a proof that asserts it/, `${where} names the re-bind remedy`);
  };
  const action = nextAction(work, [work], clock)!;
  assert.equal(action.kind, 'request-rework');
  remedies(action.inputs.kind === 'request-rework' ? action.inputs.detail : '', 'the planner\'s rework');
  const decision = neededDecision(work, { autoMerge: true })!;
  assert.equal(decision.action, 'rework');
  remedies(decision.reason, 'the loop\'s rework decision');
  const acceptance = work.gates.find(gate => gate.name === 'acceptance')!;
  const refusal = acceptance.reasons.find(reason => reason.startsWith(`AC-3: ${UNIT} needs trusted passing evidence`))!;
  assert.ok(refusal, `acceptance refuses on ${UNIT}: ${acceptance.reasons.join(' | ')}`);
  remedies(refusal, 'the acceptance refusal');
  // A proof with no finding keeps the plain refusal.
  const plain = unexercisedItem({ finding: false });
  assert.doesNotMatch(plain.gates.find(gate => gate.name === 'acceptance')!.reasons.join(' '), /Remedy/);
});

test('unit:covered-criterion-rescopes-dead-proof a criterion its other proofs already prove re-scopes the dead proof instead of reworking production', () => {
  const work = withCover();
  const decision = neededDecision(work, { autoMerge: true })!;
  assert.equal(decision.action, 'requirements', `a re-scope, not a production round: ${decision.reason}`);
  assert.deepEqual((decision.input as { criteria: Work['criteria'] }).criteria, [{ id: 'AC-3', text: 'An old tsx directory is reclaimed', proofs: [COVER] }], 'only the dead proof is retired from the criterion');
  for (const named of [UNIT, COVER, 'AC-3', 'retire']) assert.ok(decision.reason.includes(named), `the re-scope names ${named}: ${decision.reason}`);
  assert.equal(decision.binding, `${head}:rescope:AC-3:${UNIT}`);
  // It attests nothing about a worker, so the loop requests it with the worker's lease standing or not.
  assert.equal(routineDecision(work, { autoMerge: true }, clock.getTime())?.action, 'requirements');
  // The planner waits on the re-scope rather than naming a rework or a producer relaunch.
  const account = actionAccount(work, [work], clock);
  assert.equal(account.action, null, `no rework or producer relaunch is named: ${JSON.stringify(account.action)}`);
  assert.match(account.wait?.detail ?? '', /the loop requests the criterion re-scope: .*retire unit:tmp-reclaim from AC-3/);
  // Covering proofs that are missing or failed prove nothing: the finding stays the worker's to rework.
  for (const cover of ['missing', 'failed'] as const) {
    const uncovered = withCover({ cover });
    const reworked = neededDecision(uncovered, { autoMerge: true })!;
    assert.equal(reworked.action, 'rework', `with the covering proof ${cover} the change is reworked: ${reworked.reason}`);
  }
  // A criterion with no other proof has nothing covering it.
  assert.equal(neededDecision(unexercisedItem(), { autoMerge: true })!.action, 'rework');
  // Refused: the approver judged the covering proofs do not assert the statement, so the finding
  // returns to the worker as rework naming the remedy — never the same re-scope waited on for ever.
  const input = { expectedPolicyRevision: work.policyRevision, criteria: (decision.input as { criteria: Work['criteria'] }).criteria, dependencies: [], plannedFiles: work.plannedFiles };
  const refusedHistory = [{ action: 'requirements', state: 'refused', input }];
  const refused = rescopeOutcomes(work, refusedHistory);
  assert.deepEqual(refused, { refused: [UNIT], applied: null }, 'the refused re-scope is read from the decision history');
  const reworked = neededDecision(work, { autoMerge: true }, [], refused)!;
  assert.equal(reworked.action, 'rework', `a refused re-scope returns the head as rework: ${reworked.reason}`);
  assert.match(reworked.reason, /An approver refused retiring it from the criterion/);
  assert.match(reworked.reason, /re-bind AC-3 to a proof that asserts it/);
  assert.equal(routineDecision(work, { autoMerge: true }, clock.getTime(), null, [], refused)?.action, 'rework');
  // A refusal at another policy revision, a pending one, or one retiring another proof does not stand.
  for (const other of [[{ ...refusedHistory[0], input: { ...input, expectedPolicyRevision: work.policyRevision + 1 } }], [{ ...refusedHistory[0], state: 'requested' }],
    [{ ...refusedHistory[0], input: { ...input, criteria: [{ ...input.criteria[0], proofs: [UNIT] }] } }]])
    assert.deepEqual(rescopeOutcomes(work, other).refused, []);
  // Applied: the engine records the narrowing as requirement-weakening, which holds the merge gate;
  // it was the loop's own re-scope, already judged, so the loop asks for its resolution as well.
  const narrowed = structuredClone(work);
  narrowed.criteria = input.criteria;
  narrowed.escalations = [{ trigger: 'requirement-weakening', reason: 'Requirement revision retires no criterion and narrows proofs for AC-3', at: ago(1), actor: 'graphyard-master-operator' }] as Work['escalations'];
  const appliedHistory = [{ id: 'rescope-1', action: 'requirements', state: 'applied', input, reason: decision.reason }];
  const outcomes = rescopeOutcomes(narrowed, appliedHistory);
  assert.deepEqual(outcomes, { refused: [], applied: { id: 'rescope-1' } });
  const resolve = routineDecision(narrowed, { autoMerge: true }, clock.getTime(), null, [], outcomes)!;
  assert.equal(resolve.action, 'resolve', 'the narrowing the approved re-scope raised is resolved, never left for a person');
  assert.deepEqual(resolve.input, { trigger: 'requirement-weakening' });
  assert.match(resolve.reason, /re-scope decision rescope-1/);
  // A narrowing no re-scope made — another revision applied since, or one that is no re-scope — is not the loop's to resolve.
  for (const other of [[...appliedHistory, { id: 'later', action: 'requirements', state: 'applied', input, reason: 'A master narrowed it' }], [{ ...appliedHistory[0], reason: 'A master narrowed it' }]])
    assert.notEqual(neededDecision(narrowed, { autoMerge: true }, [], rescopeOutcomes(narrowed, other))?.action, 'resolve');
});
