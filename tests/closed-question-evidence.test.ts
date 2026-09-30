import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { currentEvidence, type Observation, type Principal, type Work } from '../src/model.js';
import { configuredResponder, responderConfigSchema, type Responder, type ResponderRequest } from '../src/closed-question.js';
import { accuracyStudy, type StudyCase } from '../src/model/closed-question.js';
import { httpClosedQuestionJudge, judgeClosedQuestions } from '../src/producer.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-109: a mechanical criterion is judged by a calibrated typed answer instead of a producer
// session. The control plane binds the declared state to the exact candidate, asks the configured
// responder, and records the answer as evidence a reader can re-run; an unsure answer escalates,
// and no answer is ever an approval. Each test is named for the proof it produces.
const repository = 'owner/closed-question';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['integration:*'], sessionKind: 'ai' };
const credentials = [operator, implementer, coordinator, producer].map(principal => ({ ...principal, token: `closed-question-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const master = { id: 'master-operator', token: `master-operator-${'m'.repeat(32)}`, capabilities: ['intent:create', 'intent:ready', 'intent:unblock', 'policy:requirements', 'decision:attest'] };
const approver = { id: 'approver-agent', token: `approver-agent-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
const head = 'e'.repeat(40), base = 'f'.repeat(40);
const flagFile = 'src/cli/flags.ts', flagSource = "export const flags = ['--dry-run', '--json'];\n";
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let pr = 700;

/** The responder under test: answers what it is told to, and keeps every request it was given. */
const asked: ResponderRequest[] = [];
let reply = { answer: 'yes', probability: 0.97 };
const responder: Responder = { id: 'in-house-judge', version: '2026.09.1', threshold: 0.9, exclude: { sources: ['pull-request-body', 'comments'], paths: ['vendor/'] }, ask: async request => { asked.push(request); return reply; } };
/** The candidate's tree, as GitHub's contents API returns it. */
const github = {
  config: { repository, reviewerApps: [], appId: 4109 },
  request: async (path: string) => {
    const match = path.match(/^\/contents\/(.+)\?ref=([a-f0-9]{40})$/);
    if (match && decodeURIComponent(match[1]) === flagFile && match[2] === head) return { type: 'file', encoding: 'base64', content: Buffer.from(flagSource).toString('base64') };
    throw new Error(`unexpected GitHub read ${path}`);
  },
};

const call = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const ok = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const result = await call(credential, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
};
const reload = async (id: string) => (await store.list()).find(item => item.id === id)!;
const events = async (work: Work) => (await store.pool.query('SELECT actor, kind, payload FROM events WHERE work_id=$1 ORDER BY seq', [work.id])).rows;
const acceptance = (work: Work) => work.gates.find(gate => gate.name === 'acceptance')!.reasons;

const flagQuestion = {
  criterion: 'AC-1', proof: 'integration:flag-declared', question: `Does ${flagFile} declare the --json flag the criterion requires?`,
  criteria: ['yes', 'no', 'cannot tell'], pass: 'yes', state: [{ kind: 'file', path: flagFile }, { kind: 'changed-files' }, { kind: 'criterion' }],
};
const input = (title: string, extra: Record<string, unknown> = {}) => ({
  title, plannedFiles: [flagFile],
  criteria: [
    { id: 'AC-1', text: 'The CLI declares a --json flag', proofs: ['integration:flag-declared'] },
    { id: 'AC-2', text: 'An auditor reviews the output format', proofs: ['manual:format-audit'] },
  ],
  closedQuestions: [flagQuestion], ...extra,
});
function observation(work: Work): Observation {
  return { clockOffset: { min: 0, max: 0 }, candidate: { sha: head, baseSha: base, pr: work.submission!.pr, branch: work.workspaces.at(-1)!.branch, author: 'implementer' },
    checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }],
    reviews: [{ reviewer: 'independent-reviewer', sha: head, state: 'APPROVED' }], protected: true, mergeable: true,
    merged: false, mergeSha: null, files: [flagFile], scopeFiles: [], at: new Date().toISOString() };
}
async function claimed(title: string, extra: Record<string, unknown> = {}) {
  let work = await engine.execute(operator, 'create', null, input(title, extra), randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(implementer, 'claim', work.id, {}, randomUUID());
  return engine.execute(implementer, 'workspace', work.id, { epoch: work.epoch, host: 'closed-question-host', path: `/tmp/closed-question/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, randomUUID());
}
async function candidate(title: string, extra: Record<string, unknown> = {}) {
  let work = await claimed(title, extra);
  work = await engine.execute(implementer, 'submit', work.id, { epoch: work.epoch, pr: ++pr }, randomUUID());
  return engine.observe(work.id, work.revision, observation(work));
}
const judge = (principal: Principal, work: Work, proof: string) => call(token(principal), 'POST', `work/${work.key}/closed-question`, { proof, sha: head, baseSha: base, policyRevision: work.policyRevision });

before(async () => {
  const port = Number(process.env.GRAPHYARD_CLOSED_QUESTION_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 109);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('closed-question'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('closed_question_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/closed_question_test`); await store.init();
  engine = new Engine(store, [15368], 300, repository); engine.submissionObserver = null;
  http = server(engine, credentials, github as any, undefined, { responder });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [master, approver])
    await ok(token(operator), 'POST', 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding provisions agent identities' });
});
after(async () => { http?.close(); await store?.close(); await database?.stop(); });

test('integration:closed-question-evidence — one criterion is judged end to end by asking its question against the bound state, and the record carries every field a reader needs to re-run it', async () => {
  reply = { answer: 'yes', probability: 0.97 };
  let work = await candidate('closed question evidence');
  assert.ok(acceptance(work).some(reason => reason.startsWith('AC-1: integration:flag-declared needs trusted passing evidence')), 'unproven before the answer');
  assert.ok((work.autoDispatch?.producers ?? []).some(request => request.state === 'requested' && request.proofs?.includes('integration:flag-declared')), 'a producer session is requested until the question is answered');
  asked.length = 0;

  // The loop's producer launcher puts the question to the control plane before any session starts.
  const judged = await judgeClosedQuestions(work, { proofs: ['integration:flag-declared'] }, httpClosedQuestionJudge(url, token(producer), { key: work.key, sha: head, baseSha: base, policyRevision: work.policyRevision }));
  assert.deepEqual(judged, { decided: ['integration:flag-declared'], escalated: [], remaining: [] }, 'a decided proof leaves nothing for a producer session to do');
  assert.equal(asked.length, 1, 'the responder was asked exactly once');

  work = await reload(work.id);
  const evidence = work.evidence.filter(entry => entry.proof === 'integration:flag-declared');
  assert.equal(evidence.length, 1);
  const [record] = evidence;
  // The binding: exact candidate and policy, attributed to the responder, trusted as a decided verdict.
  assert.equal(record.sha, head); assert.equal(record.baseSha, base); assert.equal(record.policyRevision, work.policyRevision);
  assert.equal(record.producer, 'responder:in-house-judge');
  assert.equal(record.trusted, true); assert.equal(record.result, 'pass'); assert.equal(record.executed, 1); assert.equal(record.skipped, 0);
  // Every field: the question, the criteria offered, the state hash, the responder and version, the answer, its probability, the threshold.
  const answer = record.closedQuestion!;
  assert.equal(answer.question, flagQuestion.question);
  assert.deepEqual(answer.criteria, ['yes', 'no', 'cannot tell']);
  assert.equal(answer.pass, 'yes');
  assert.equal(answer.criterion, 'AC-1');
  assert.match(answer.stateHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(answer.state.map(part => [part.kind, part.path ?? null]), [['file', flagFile], ['changed-files', null], ['criterion', null]]);
  assert.deepEqual(answer.responder, { id: 'in-house-judge', version: '2026.09.1' });
  assert.equal(answer.answer, 'yes');
  assert.equal(answer.probability, 0.97);
  assert.equal(answer.threshold, 0.9);
  assert.equal(answer.verdict, 'decided');
  assert.equal(answer.escalation, undefined);

  // Any reader can re-run it: the same state, assembled independently, hashes to the recorded value,
  // and it is exactly what the responder was given.
  const state = [['file', flagFile, flagSource], ['changed-files', null, flagFile], ['criterion', null, 'The CLI declares a --json flag']];
  assert.equal(answer.stateHash, createHash('sha256').update(JSON.stringify(state)).digest('hex'));
  assert.equal(asked[0].stateHash, answer.stateHash);
  assert.deepEqual(asked[0].state.map(part => part.text), [flagSource, flagFile, 'The CLI declares a --json flag']);
  assert.equal(answer.state[0].sha256, createHash('sha256').update(flagSource).digest('hex'));
  assert.deepEqual(asked[0].criteria, ['yes', 'no', 'cannot tell']);

  // The gate is satisfied by the answer, and the producer request for the proof is withdrawn.
  assert.equal(currentEvidence(work, 'integration:flag-declared')?.id, record.id);
  assert.ok(!acceptance(work).some(reason => reason.startsWith('AC-1:')), acceptance(work).join('\n'));
  assert.ok(!(work.autoDispatch?.producers ?? []).some(request => request.state === 'requested' && request.proofs?.includes('integration:flag-declared')), 'no producer session is requested for a decided proof');
  const recorded = (await events(work)).find(row => row.kind === 'closed-question.answered');
  assert.equal(recorded.actor, producer.id);
  assert.equal(recorded.payload.details.evidence.closedQuestion.stateHash, answer.stateHash);

  // Asking again for the same head replays the recorded judgement instead of asking twice.
  const again = await judgeClosedQuestions(work, { proofs: ['integration:flag-declared'] }, httpClosedQuestionJudge(url, token(producer), { key: work.key, sha: head, baseSha: base, policyRevision: work.policyRevision }));
  assert.deepEqual(again.decided, ['integration:flag-declared']);
  assert.equal(asked.length, 1);
  assert.equal((await reload(work.id)).evidence.filter(entry => entry.proof === 'integration:flag-declared').length, 1);
});

test('integration:low-confidence-escalates — an answer below the threshold is never a verdict: the gate stays unsatisfied and the escalation names the probability', async () => {
  // An ambiguous case: the responder leans "yes" but is not sure.
  reply = { answer: 'yes', probability: 0.62 };
  let work = await candidate('ambiguous closed question');
  const response = await judge(coordinator, work, 'integration:flag-declared');
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.verdict, 'escalated');
  assert.equal(response.body.escalation.path, 'producer-session');
  assert.match(response.body.escalation.reason, /probability 0\.62 \(below the threshold 0\.9\)/);

  work = await reload(work.id);
  const record = work.evidence.find(entry => entry.proof === 'integration:flag-declared')!;
  // Recorded alongside, as what prompted the escalation — and untrusted, so it decides nothing.
  assert.equal(record.trusted, false);
  assert.equal(record.closedQuestion!.verdict, 'escalated');
  assert.equal(record.closedQuestion!.probability, 0.62);
  assert.equal(record.closedQuestion!.threshold, 0.9);
  assert.match(record.closedQuestion!.escalation!.reason, /0\.62/);
  assert.equal(currentEvidence(work, 'integration:flag-declared'), undefined);
  assert.ok(acceptance(work).some(reason => reason.startsWith('AC-1: integration:flag-declared needs trusted passing evidence')), 'the gate is not satisfied');
  const escalated = (await events(work)).find(row => row.kind === 'closed-question.escalated');
  assert.match(escalated.payload.details.evidence.closedQuestion.escalation.reason, /probability 0\.62/);

  // The launcher keeps the proof on its ordinary path: the producer session is launched for it.
  const judged = await judgeClosedQuestions(work, { proofs: ['integration:flag-declared'] }, httpClosedQuestionJudge(url, token(producer), { key: work.key, sha: head, baseSha: base, policyRevision: work.policyRevision }));
  assert.deepEqual(judged.decided, []);
  assert.deepEqual(judged.remaining, ['integration:flag-declared']);
  assert.match(judged.escalated[0].reason, /probability 0\.62/);

  // Even a record forged to claim trust cannot turn an unsure answer into a verdict.
  const forged = { ...record, id: randomUUID(), trusted: true, result: 'pass' as const, closedQuestion: { ...record.closedQuestion!, verdict: 'decided' as const } };
  assert.equal(currentEvidence({ ...work, evidence: [...work.evidence, forged] }, 'integration:flag-declared'), undefined, 'probability below the recorded threshold never counts');

  // A question may raise the threshold, never lower it below the responder's floor.
  reply = { answer: 'yes', probability: 0.85 };
  const lowered = await candidate('lowered threshold', { closedQuestions: [{ ...flagQuestion, threshold: 0.5 }] });
  const refused = await judge(coordinator, lowered, 'integration:flag-declared');
  assert.equal(refused.body.verdict, 'escalated', JSON.stringify(refused.body));
  assert.equal(refused.body.evidence.closedQuestion.threshold, 0.9);
});

test('integration:answer-is-evidence-not-approval — an answer cannot satisfy a two-party decision, stand in for a human-only decision, or approve a scope widening the criteria do not name', async () => {
  reply = { answer: 'yes', probability: 0.99 };
  asked.length = 0;

  // 1. A two-party decision. manual:format-audit is established only by an approved attest decision.
  const auditQuestion = { ...flagQuestion, criterion: 'AC-2', proof: 'manual:format-audit', question: 'Is the output format documented?' };
  let work = await candidate('two-party decision', { closedQuestions: [flagQuestion, auditQuestion] });
  const requested = await call(master.token, 'POST', `work/${work.key}/decide`, { action: 'attest', input: { proof: 'manual:format-audit', sha: head, baseSha: base, policyRevision: work.policyRevision, result: 'pass', executed: 1, skipped: 0 }, reason: 'The audit is due' });
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  const twoParty = await judge(coordinator, work, 'manual:format-audit');
  assert.equal(twoParty.status, 409);
  assert.match(twoParty.body.error, /established only by an approved attest decision — a two-party decision an answer never satisfies/);
  const decisions = await ok(master.token, 'GET', `work/${work.key}/decisions`);
  assert.equal(decisions.decisions.find((entry: any) => entry.id === requested.body.id).state, 'requested', 'the decision still waits for its independent approver');
  // Nor does a record that reached the item by any other route count for it.
  work = await reload(work.id);
  const smuggled = { id: randomUUID(), proof: 'manual:format-audit', sha: head, baseSha: base, policyRevision: work.policyRevision, producer: 'responder:in-house-judge', trusted: true, result: 'pass' as const, executed: 1, skipped: 0, at: new Date().toISOString(),
    closedQuestion: { criterion: 'AC-2', question: auditQuestion.question, criteria: auditQuestion.criteria, pass: 'yes', stateHash: 'a'.repeat(64), state: [], responder: { id: 'in-house-judge', version: '2026.09.1' }, answer: 'yes', probability: 0.99, threshold: 0.9, verdict: 'decided' as const } };
  assert.equal(currentEvidence({ ...work, evidence: [...work.evidence, smuggled] }, 'manual:format-audit'), undefined, 'an answer never stands in for the attest decision');
  assert.ok(acceptance(work).some(reason => reason.startsWith('AC-2: manual:format-audit')));

  // 2. A human-only decision. The worker parks the item on one; no answer resumes it.
  const parked = await claimed('human-only decision');
  await ok(token(implementer), 'POST', `work/${parked.key}/park`, { epoch: parked.epoch, kind: 'money-or-accounts', reason: 'The proof needs a paid sandbox account', needed: 'A sandbox account for the payment provider' });
  const human = await judge(coordinator, parked, 'integration:flag-declared');
  assert.equal(human.status, 409);
  assert.match(human.body.error, /waits on a human-only decision \(money-or-accounts\); an answer never stands in for one/);
  const stillParked = await reload(parked.id);
  assert.ok(stillParked.humanRequest && !stillParked.humanRequest.answer, 'the human request stays open');
  assert.match(stillParked.blocker!, /Waiting on a human-only decision/);

  // 3. A scope widening the criteria do not name. The worker asks for a path no criterion implies.
  const scoped = await claimed('scope widening');
  await ok(token(implementer), 'POST', `work/${scoped.key}/scope`, { epoch: scoped.epoch, paths: ['src/billing/ledger.ts'], reason: 'The flag also needs the ledger' });
  const scope = await judge(coordinator, scoped, 'integration:flag-declared');
  assert.equal(scope.status, 409);
  assert.match(scope.body.error, /open scope request its criteria do not name .*an answer never approves a scope widening/);
  const unwidened = await reload(scoped.id);
  assert.deepEqual(unwidened.plannedFiles, [flagFile], 'plannedFiles are unchanged');
  assert.deepEqual(unwidened.scopeRequest?.paths, ['src/billing/ledger.ts'], 'the scope request stays open for an operator');

  assert.equal(asked.length, 0, 'the responder was never asked in any of the three');
  // And the route has no field through which an answer could be attached to a decision.
  const attached = await call(token(coordinator), 'POST', `work/${work.key}/closed-question`, { proof: 'integration:flag-declared', sha: head, baseSha: base, policyRevision: work.policyRevision, decision: requested.body.id });
  assert.equal(attached.status, 400);
});

test('the responder is replaceable by a local command, and state an untrusted party authors is excluded by configuration', async () => {
  // A local responder: any program that reads the request on stdin and writes the answer on stdout.
  const script = "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const r=JSON.parse(s);process.stdout.write(JSON.stringify({answer:r.state[0].text.includes('--json')?'yes':'no',probability:0.95}))})";
  const local = configuredResponder(responderConfigSchema.parse({ kind: 'command', id: 'local-rules', version: '1', command: [process.execPath, '-e', script] }));
  assert.deepEqual(local.exclude.sources, ['pull-request-body', 'comments'], 'untrusted sources are excluded unless an operator admits them');
  assert.deepEqual(await local.ask({ question: 'q', criteria: ['yes', 'no'], state: [{ kind: 'file', path: flagFile, text: flagSource }], stateHash: 'h' }), { answer: 'yes', probability: 0.95 });

  // A question asked against the pull request body is refused before the responder sees anything.
  asked.length = 0;
  const work = await candidate('untrusted state', { closedQuestions: [{ ...flagQuestion, state: [{ kind: 'pull-request-body' }] }] });
  const refused = await judge(coordinator, work, 'integration:flag-declared');
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /pull-request-body is excluded by the responder configuration: an untrusted party may author it/);
  const vendored = await candidate('excluded path', { closedQuestions: [{ ...flagQuestion, state: [{ kind: 'file', path: 'vendor/lib.js' }] }] });
  assert.match((await judge(coordinator, vendored, 'integration:flag-declared')).body.error, /vendor\/lib\.js is excluded/);
  assert.equal(asked.length, 0);
  // Workers ask nothing: only the loop, a producer or an admin may request a judgement.
  assert.equal((await judge(implementer, work, 'integration:flag-declared')).status, 403);
});

test('the accuracy study recommends adoption only from this repository\'s own outcomes', () => {
  const cases = (count: number, wrong = 0): StudyCase[] => Array.from({ length: count }, (_, index) => ({ key: `GY-${index + 1}`, sha: String(index).padStart(40, '0'), proof: 'integration:x', known: 'pass', session: 'pass', answer: index < wrong ? 'fail' : 'pass', probability: 0.95 }));
  assert.equal(accuracyStudy(cases(19), 0.9).recommendation, 'refuse', 'fewer than twenty past candidates never recommends adoption');
  const adopted = accuracyStudy(cases(24), 0.9);
  assert.equal(adopted.recommendation, 'adopt', adopted.reason);
  assert.deepEqual([adopted.agreement, adopted.disagreement, adopted.confidentWrong.length], [24, 0, 0]);
  const wrong = accuracyStudy(cases(24, 1), 0.9);
  assert.equal(wrong.recommendation, 'refuse');
  assert.equal(wrong.confidentWrong[0].key, 'GY-1');
  assert.match(wrong.reason, /1 confident answer\(s\) were wrong \(GY-1 integration:x/);
});
