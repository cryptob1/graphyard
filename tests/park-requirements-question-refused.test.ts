import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import { humanRequestSchema, parkRefusal, requirementsQuestionRefusal } from '../src/model/human-request.js';
import { routedParkCommand } from '../src/cli/session-commands.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1816: GY-1814's release-soak fix sat parked under goals and priorities on a question that was
// never the operator's — its worker asked whether AC-1 should be rewritten to match GY-1762's test
// assertions or GY-1762 reversed, and only a master session noticing it unblocked the item.
// Requirement rewrites are two agent identities' decision (docs/glossary.md#who-decides): the master
// requests one, an independent approver approves it. So `park` refuses a goals-and-priorities park
// whose ask, needed text or reason asks whether a criterion is rewritten, revised or matched to
// another item's tests, naming the agent route — record the conflict with `graphyard blocked`, so
// the master requests the requirements decision — while a goals-and-priorities park about scope,
// ordering or product direction still parks, and every refusal the base classifier raises
// (GY-1395, GY-1416, GY-1692) still fires beneath the wrapper.

const repository = 'owner/park-requirements-question';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, worker].map(principal => ({ ...principal, token: `park-requirements-question-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 84;
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('park-requirements-question'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('park_requirements_question');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/park_requirements_question`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

const id = () => randomUUID();
const request = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const reload = async (workId: string) => (await store.list()).find(item => item.id === workId)!;
/** A claimed item to park on: created, readied and claimed under the worker's own credential. */
const claimed = async (n: number): Promise<Work> => {
  let work = await engine.execute(operator, 'create', null, { title: `Requirements question ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:behaves'] }] }, id());
  work = await engine.execute(operator, 'ready', work.id, {}, id());
  return engine.execute(worker, 'claim', work.id, {}, id());
};

test('unit:park-requirements-question-refused — GY-1816 AC-1: a goals-and-priorities park whose ask, needed text or reason asks whether a criterion is rewritten, revised or matched to another item\'s tests is refused naming the agent route; scope, ordering and product direction still park', async () => {
  // The ask GY-1814 parked (request 46a6f027), phrased as its worker wrote it: which yields —
  // rewriting AC-1 to match GY-1762's test assertions, or reversing GY-1762. Each field refuses alone.
  const clean = { kind: 'goals-and-priorities', needed: 'A decision the build cannot make for itself', reason: 'The item cannot pass its gates as written' };
  const questioned = [
    { ...clean, ask: 'Decide which yields: rewrite AC-1 to match GY-1762\'s test assertions, or reverse GY-1762' },
    { kind: 'goals-and-priorities', needed: 'Whether the acceptance criteria are matched to GY-1762\'s test assertions or GY-1762 is reversed', reason: clean.reason },
    { ...clean, reason: 'AC-1 and GY-1762\'s suite contradict each other as written, so one criterion must be revised before either gate can pass; the worker cannot choose' },
    // The verb-first, weakening and noun-compound wordings the same ask hides behind.
    { ...clean, reason: 'The worker asks to revise the requirements so the proof resolves, or to weaken AC-1 instead' },
    { ...clean, reason: 'The request reduces to a criteria revision, which the worker cannot make' },
    // Matching proofs to another item's tests without naming a criterion in the same sentence.
    { ...clean, ask: 'Decide whether this item\'s test assertions should match GY-1700\'s' },
    // The ordinary revision verbs (review thread PRRT_kwDOUZby-s6sl1Cc): update, amend, change, edit.
    { ...clean, ask: 'Should we update AC-1?' },
    { ...clean, ask: 'Should we amend the acceptance criterion?' },
    { ...clean, ask: 'Should we change AC-2 so the proof resolves?' },
    { ...clean, reason: 'The criteria should be edited before either gate can pass' },
    { ...clean, reason: 'AC-1 should be updated or amended, which the worker cannot decide' },
    { ...clean, reason: 'This needs a criteria amendment' },
    // A need connector between the criterion and its verb (review thread PRRT_kwDOUZby-s6smCFc).
    { ...clean, ask: 'Does AC-1 need to be rewritten?' },
    { ...clean, needed: 'Whether the requirements need to be revised' },
    { ...clean, reason: 'The criterion needs to be relaxed, or it never passes' },
    // A negated question still asks (GY-1816); GY-1819 re-homes the s6smFz9 'happens' wording to the accepted side:
    // the bare noun 'requirements' names the rewrite as work, so asking whether it happens parks.
    { ...clean, ask: 'Should AC-1 not be weakened instead?' },
    { ...clean, needed: 'Whether the criteria are no longer matched to GY-1762' },
    // A scoping qualifier between the criterion and its verb (review thread PRRT_kwDOUZby-s6smNd6).
    { ...clean, needed: 'Whether the acceptance criteria for CSV exports should be revised' },
    { ...clean, needed: 'Whether AC-1 in the current release should be weakened' },
    { ...clean, ask: 'Should the requirements for the importer be changed?' },
  ] as const;
  for (const body of questioned) {
    const refusal = parkRefusal(body)!;
    assert.match(refusal, /^Not a human-only decision: the request asks whether this item's criteria are rewritten, revised or matched to another item's tests/, JSON.stringify(body));
    assert.match(refusal, /graphyard blocked GY-N EPOCH REASON/, 'the refusal names the conflict route');
    assert.match(refusal, /graphyard master decide GY-N requirements/, 'the refusal names the requirements decision the master requests');
    assert.equal(requirementsQuestionRefusal(body), refusal);
    // The server's own composition — parse, then refuse — says the same through the endpoint.
    assert.equal(parkRefusal(humanRequestSchema.parse({ epoch: 1, ...body })), refusal);
  }

  // Scope, ordering and product direction are still the human's to set, whatever words they borrow.
  const accepted = [
    'Whether the importer rewrite also covers CSV export, or only the ledger format',
    'Whether GY-1700 lands before the release cut or after it',
    'Whether the soak gate orders GY-1762\'s suite before this item\'s tests',
    'Whether the legacy importer stays a goal this quarter',
    'Decide whether the legacy importer is still a goal before GY-12 removes it',
    'Whether the criteria work is prioritized above the docs trim',
    // A requirements rewrite named as the work being ordered (review thread PRRT_kwDOUZby-s6sl1CW): the decision is the order.
    'Whether the requirements rewrite lands before the release cut',
    // GY-1819: the bare noun names the rewrite as work, so its change-noun parks whatever its verb.
    'Whether the requirements rewrite happens',
    'Whether the criteria revision ships after GY-1700 or before it',
    'Whether the requirements update should be prioritized above the docs trim',
    // Test ordering that names "matching tests" (review thread PRRT_kwDOUZby-s6smF0P) matches nothing to anything.
    'Whether GY-1700\'s matching tests or the other tests should run first',
    'Whether the tests that match GY-1700 should run first',
    // A qualified criterion that is only ordered or met still parks.
    'Whether the criteria in the current release are prioritized above the docs trim',
    'Whether the requirements for the importer are met by the soak run',
  ] as const;
  for (const needed of accepted) assert.equal(parkRefusal({ kind: 'goals-and-priorities', needed, reason: 'the operator owns goals and priorities' }), null, needed);
  // A reason stating the requirements stay as they are (review thread PRRT_kwDOUZby-s6smF0G) asks no change.
  assert.equal(parkRefusal({ kind: 'goals-and-priorities', needed: 'Whether GY-1700 lands before the release cut', reason: 'The requirements are not changed by this scheduling decision' }), null);

  // The requirements question is scoped to the kind that claims it: other kinds keep their own rules.
  assert.equal(requirementsQuestionRefusal({ kind: 'money-or-accounts', needed: 'Whether AC-1 should be rewritten to match GY-1762\'s test assertions' }), null);
  // And every base refusal still fires beneath the wrapper, in the same words as before.
  assert.match(parkRefusal({ kind: 'money-or-accounts', needed: 'Paste a GitHub token with repo and admin:repo_hook scopes so the pilot can configure webhooks' })!, /^Not a human-only decision: .*the master's owed action, not the human's\. Agent route: /);
  assert.match(parkRefusal({ kind: 'goals-and-priorities', needed: 'master scope to widen plannedFiles to include src/master/profiles.ts', reason: 'AC-1' })!, /^A scope widening is not a human-only decision/);
  assert.equal(parkRefusal({ kind: 'goals-and-priorities', needed: 'A decision the build cannot make for itself' }), null);
});

test('unit:park-requirements-question-refused — the park endpoint refuses the criterion-rewrite question with the lease kept and the human never asked, and a product-direction park under the same kind still reaches Needs you', async () => {
  // Refused, exactly as GY-1814's worker wrote it: the endpoint answers 422 with the route, the
  // attempt keeps its lease to record the conflict with `graphyard blocked`, and nothing parks.
  const refusedWork = await claimed(1);
  const body = { epoch: refusedWork.epoch, kind: 'goals-and-priorities' as const, needed: 'Which shape the release-soak criterion takes', ask: 'Decide which yields: rewrite AC-1 to match GY-1762\'s test assertions, or reverse GY-1762', reason: 'AC-1 and GY-1762\'s suite contradict each other as written, so one criterion must be revised before either gate can pass; the worker cannot choose' };
  const refusal = parkRefusal({ kind: body.kind, needed: body.needed, ask: body.ask, reason: body.reason })!;
  const refused = await request(token(worker), 'POST', `work/${refusedWork.id}/park`, body);
  assert.deepEqual([refused.status, refused.body.error], [422, refusal], JSON.stringify(refused.body));
  const afterRefusal = await reload(refusedWork.id);
  assert.equal(afterRefusal.humanRequest ?? null, null, 'the human is never asked a requirements question');
  assert.equal(afterRefusal.lease?.owner, worker.id, 'the attempt continues: the worker records the conflict with graphyard blocked instead');
  assert.equal(afterRefusal.blocker ?? null, null);

  // Accepted under the same kind: product direction parks, ends the attempt, and reaches Needs you.
  const parkedWork = await claimed(2);
  const parked = await request(token(worker), 'POST', `work/${parkedWork.id}/park`, { epoch: parkedWork.epoch, kind: 'goals-and-priorities', needed: 'Whether the legacy importer stays a goal this quarter', ask: 'Decide whether the importer stays a goal', reason: 'The item removes it when the answer is no', recommendation: 'Go ahead as asked', why: 'The roadmap is the operator\'s call.' });
  assert.equal(parked.status, 200, JSON.stringify(parked.body));
  assert.equal(parked.body.humanRequest?.kind, 'goals-and-priorities');
  assert.equal(parked.body.humanRequest?.recommendation, 'Go ahead as asked');
  const afterPark = await reload(parkedWork.id);
  assert.equal(afterPark.humanRequest?.needed, 'Whether the legacy importer stays a goal this quarter');
  assert.equal(afterPark.lease, null, 'the park ends the attempt that asked');
  assert.match(afterPark.blocker ?? '', /^Waiting on a human-only decision/);

  // The CLI leaves the refusal to the server too: a criterion-rewrite NEEDED is not the master's
  // owed action (that route is host-doable asks alone), so `park` is posted and the server refuses.
  const posted: string[] = [];
  await routedParkCommand.run({ args: ['1', 'goals-and-priorities', 'Whether', 'AC-1', 'is', 'rewritten', '--ask', 'Decide which shape wins', '--recommend', 'Go ahead as asked', '--why', 'The item cannot pass either gate.', '--', 'the suite contradicts the criterion'], print: () => {}, api: async (path: string) => { posted.push(path); return {}; }, individualHostId: () => 'host' } as any, { id: 'w', key: 'GY-1', revision: 1 } as any);
  assert.deepEqual(posted, ['work/w/park'], 'the CLI posts the park; the server names the agent route');
});
