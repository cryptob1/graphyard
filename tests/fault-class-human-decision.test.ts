import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import { docsHeadroom, docsTrimItem, docsWordBudgetOf, type DocsWordCount } from '../src/model/documentation.js';
import { humanOnlyRefusal, openHumanRequests, parkRefusal, parkRule, parkedOnHuman, type HumanDecisionKind } from '../src/model/human-request.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1366 names this file for its proof: manual:fault-class-human-decision. The master loop filed 3
// human-decision faults in 24 hours (5–6 October 2026). Each instance, as the ledger records its park
// (`graphyard status GY-N`, humanRequest / humanRequests), judged:
//
//   - GY-1292, goals-and-priorities: AVOIDABLE. The loop's own docs-trim item demanded both the
//     5%-headroom target and that everything documented stay documented. Once tightening ran out
//     the two conflicted, and the worker asked which wins: the question the operator already
//     answered on GY-1070 ("cut hard", 2026-10-02) and had been asked on GY-998 before it. The
//     trim item now carries that answer in its own criterion, so it never asks again.
//   - GY-1313, money-or-accounts: NECESSARY. Every criterion needed production to hold a Railway
//     account token; opening an account and issuing its token is the operator's alone.
//   - GY-1365, money-or-accounts: judged NECESSARY then, HOST-DOABLE since GY-1416. What remained was
//     the revert approver variables, and install derives them from the reviewer App registration
//     saved on the host: the master sets them (`master setup --apply`), so its park is refused.
//
// The necessary one stays human: the second test parks it exactly as recorded and shows every agent
// identity the control plane runs is refused the answer, and only the operator's declared human
// session answers it. GY-1365's park, replayed, is refused with the master's route.

const instances = [
  { id: 'human-request|GY-1292|2026-10-05T13:45:14.659Z', subject: 'GY-1292', kind: 'goals-and-priorities', verdict: 'avoidable',
    reason: 'asked again for a decision already made: the docs-trim criterion conflicted with itself, and the operator had answered which half wins on GY-1070' },
  { id: 'human-request|GY-1313|2026-10-05T20:04:06.126Z', subject: 'GY-1313', kind: 'money-or-accounts', verdict: 'necessary',
    reason: 'a Railway account API token on the production service: an account and its credential only the operator holds',
    needed: 'A Railway account or team API token with deployment read on the cryptob1/graphyard production service, set as RAILWAY_API_TOKEN in the graphyard production environment\'s variables (Railway dashboard, or railway variables --service graphyard --set RAILWAY_API_TOKEN=...)' },
  { id: 'human-request|GY-1365|2026-10-06T10:05:59.816Z', subject: 'GY-1365', kind: 'money-or-accounts', verdict: 'host-doable',
    reason: 'the revert approver variables are derived from the reviewer App registration saved on the host, so the master sets them with master setup --apply (GY-1416)',
    needed: 'Register or choose the revert approver GitHub App (the reviewer App serves; it must differ from the control-plane App), install it on the repository, set GRAPHYARD_REVERT_APPROVER_APP_ID, GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID and GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY (or _PRIVATE_KEY_FILE) on the production control plane via scripts/provision-railway.mjs operator input, and redeploy' },
] as const;

test('manual:fault-class-human-decision — GY-1292: the docs-trim item the loop files carries the operator\'s answer to the question its worker parked on, so it is not asked again', () => {
  assert.deepEqual(instances.map(instance => instance.verdict), ['avoidable', 'necessary', 'host-doable'], 'each instance is judged, with its reason');
  // The set GY-1292 was filed for: 11,712 of 12,000 words on origin/main, largest pages as its description named them.
  const budget = docsWordBudgetOf({ paths: ['docs/', 'README.md'], wordBudget: { total: 12_000, perPage: 1_200 } })!;
  const count: DocsWordCount = { 'docs/master-agent.md': 959, 'docs/master-agent-reference.md': 841, 'docs/operations-reference.md': 815, 'docs/master-agent-sessions.md': 804, 'docs/onboarding.md': 804, 'README.md': 7_489 };
  const headroom = docsHeadroom(count, budget);
  assert.equal(headroom.total, 11_712);
  const item = docsTrimItem(headroom, 'origin/main');
  const criterion = item.criteria[0].text;
  // The park (request 0ae1de16): 12,236 words after a fact-preserving trim, and AC-1 forbade dropping
  // documentation, so the worker offered: drop named detail, reword test-pinned phrases, or revise
  // the limit. On the base the criterion still forbids the first; on the candidate it allows it.
  assert.match(criterion, /totals at most 11400 words \(at least 5% under the 12000-word budget\)/, 'the target is kept, not relaxed');
  assert.doesNotMatch(criterion, /every behaviour, command, configuration and API documented before the change is still documented after it/, 'the criterion no longer demands what the target cannot coexist with');
  assert.match(criterion, /detail-level documentation may be dropped to reach it/, 'the trade-off the worker asked about is the criterion\'s own');
  assert.match(criterion, /what remains stays accurate to the code, and every CLI command and HTTP route documented before the change stays named at least once/, 'the operator\'s floor from GY-1070 is kept');
  assert.doesNotMatch(item.description, /do not remove any documented behaviour/, 'the description no longer contradicts the criterion');
  assert.match(item.description, /drop detail-level documentation: the target wins, so this needs no human decision/);
});

// Every identity the control plane runs without a person behind it, and the operator's own session.
const repository = 'owner/human-decision';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['integration:claim-safety'] };
const adminAgent: Principal = { id: 'approver-admin', role: 'admin', sessionKind: 'ai' };
const undeclaredAdmin: Principal = { id: 'undeclared-admin', role: 'admin' };
const credentials = [operator, worker, coordinator, producer, adminAgent, undeclaredAdmin].map(principal => ({ ...principal, token: `human-decision-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const masterAgent = { id: 'graphyard-master-decision', token: `graphyard-master-decision-${'m'.repeat(32)}`, capabilities: ['decision:merge', 'decision:attest', 'decision:rework'] };
const approverAgent = { id: 'graphyard-approver-decision', token: `graphyard-approver-decision-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;

before(async () => {
  const port = Number(process.env.GRAPHYARD_HUMAN_DECISION_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 47);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('human-decision'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('human_decision_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/human_decision_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [masterAgent, approverAgent])
    await call(token(operator), 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding provisions the master agent pair' }, 200);
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

async function call(credential: string, method: 'GET' | 'POST', path: string, body: unknown, status: number) {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${text}`);
  return JSON.parse(text) as any;
}
const reload = async (workId: string) => (await store.list()).find(item => item.id === workId)!;

test('manual:fault-class-human-decision — GY-1313 and GY-1365: the necessary decision, parked as recorded, is refused to every agent identity and answered only in the operator\'s own human session', async () => {
  const agents = [
    { label: 'worker', credential: token(worker), actor: worker },
    { label: 'master loop', credential: token(coordinator), actor: coordinator },
    { label: 'proof producer', credential: token(producer), actor: producer },
    { label: 'admin credential in an agent session', credential: token(adminAgent), actor: adminAgent },
    { label: 'admin credential with no declared session', credential: token(undeclaredAdmin), actor: undeclaredAdmin },
    { label: 'master agent', credential: masterAgent.token, actor: { id: masterAgent.id, role: 'operator-agent', sessionKind: 'ai' } },
    { label: 'approver agent', credential: approverAgent.token, actor: { id: approverAgent.id, role: 'operator-agent', sessionKind: 'ai' } },
  ];
  // GY-1416: the host-doable one is refused before it reaches the human, naming the master's route; the attempt keeps its lease.
  for (const instance of instances.filter(entry => entry.verdict === 'host-doable')) {
    let work: Work = await engine.execute(operator, 'create', null, { title: `${instance.subject} replay`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    const refused = await call(token(worker), 'POST', `work/${work.key}/park`, { epoch: work.epoch, kind: instance.kind satisfies HumanDecisionKind, needed: instance.needed, reason: instance.reason }, 422);
    assert.equal(refused.error, parkRefusal({ needed: instance.needed! }));
    assert.match(refused.error, /graphyard master setup --apply/);
    work = await reload(work.id);
    assert.equal(parkedOnHuman(work), false, `${instance.subject} never reaches the human`);
    assert.equal(work.lease?.owner, worker.id);
  }
  for (const instance of instances.filter(entry => entry.verdict === 'necessary')) {
    let work: Work = await engine.execute(operator, 'create', null, { title: `${instance.subject} replay`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, randomUUID());
    work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
    work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
    await call(token(worker), 'POST', `work/${work.key}/park`, { epoch: work.epoch, kind: instance.kind satisfies HumanDecisionKind, needed: instance.needed, reason: instance.reason }, 200);
    work = await reload(work.id);
    assert.ok(parkedOnHuman(work), `${instance.subject} is parked`);
    assert.equal(work.lease, null, 'the park ends the attempt\'s lease');
    const request = work.humanRequest!;
    const [row] = openHumanRequests([work], Date.now());
    assert.equal(row.request.needed, instance.needed, 'the human sees exactly what is needed');

    for (const agent of agents) {
      const refused = await call(agent.credential, 'POST', `work/${work.key}/answer`, { request: request.id, outcome: 'provided', answer: 'done' }, 403);
      assert.equal(refused.error, humanOnlyRefusal(parkRule.kind, agent.actor), `${agent.label} is refused in the rule's own words`);
      assert.ok(parkedOnHuman(await reload(work.id)), `${instance.subject} still waits after the ${agent.label} tried to answer`);
    }

    await call(token(operator), 'POST', `work/${work.key}/answer`, { request: request.id, outcome: 'provided', answer: 'Provided in the operator\'s own session' }, 200);
    const answered = await reload(work.id);
    assert.equal(parkedOnHuman(answered), false, 'the operator\'s own session answers it');
    assert.equal(answered.humanRequests!.at(-1)!.answer!.by, operator.id);
    assert.equal(answered.blocker, null, 'a provided answer returns the item to the loop');
  }
});
