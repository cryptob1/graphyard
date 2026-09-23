import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine, unauthorizedMergeViolation } from '../src/engine.js';
import { server } from '../src/server.js';
import { humanRequestsCommand } from '../src/cli/session-commands.js';
import { operatorCredentialRefusal, operatorOnlyDecision } from '../src/model/approval.js';
import { humanOnlyRefusal, humanOnlyRules, openHumanOnly, operatorApprovalRule, parkRule, type HumanOnlyRule, type HumanRequestRow } from '../src/model/human-request.js';
import type { Observation, Principal, Work } from '../src/model.js';
import HumanRequestsPage from '../web/pages/human-requests.js';
import type { Dashboard } from '../web/pages/dashboard.js';

/**
 * GY-102: every action the control plane will take from the operator's own credential alone is
 * on the human-facing page, and is answered there, in their signed-in session, rather than by
 * putting an admin token on a command line. The surface is derived from one rule table, so a
 * human-only action can never be silently absent from it. Each test is named for the proof it
 * produces and runs the real engine, the real routes and the real page on a disposable Postgres.
 */
const repository = 'owner/human-surface';
/** The operator: the one credential these actions are taken from. */
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['integration:claim-safety'] };
const principals = [operator, worker, coordinator, producer];
const credentials = principals.map(principal => ({ ...principal, token: `human-surface-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
// The master's own pair, as `master autonomy` provisions it: operator-agent identities, never admins.
const masterAgent = { id: 'graphyard-master-surface', token: `graphyard-master-surface-${'m'.repeat(32)}`, capabilities: ['decision:merge', 'decision:attest', 'decision:rework'] };
const approverAgent = { id: 'graphyard-approver-surface', token: `graphyard-approver-surface-${'a'.repeat(32)}`, capabilities: ['decision:approve'] };
/** Every identity the control plane runs without a person behind it. */
const agentIdentities = [
  { id: masterAgent.id, role: 'operator-agent', sessionKind: 'ai' },
  { id: approverAgent.id, role: 'operator-agent', sessionKind: 'ai' },
  coordinator, worker, producer,
];
const base = 'b'.repeat(40);
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_HUMAN_SURFACE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 82);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-human-surface-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('human_surface_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/human_surface_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  for (const agent of [masterAgent, approverAgent])
    await post(token(operator), 'operator-agents', { id: agent.id, displayName: agent.id, capabilities: agent.capabilities, scope: { repositories: [repository], workItems: ['*'] }, token: agent.token, reason: 'Onboarding provisions the master agent pair' });
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

const id = () => randomUUID();
const request = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() as any };
};
const get = async (credential: string, path: string) => { const result = await request(credential, 'GET', path); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
const post = async (credential: string, path: string, body: unknown) => { const result = await request(credential, 'POST', path, body); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
const reload = async (workId: string) => (await store.list()).find(item => item.id === workId)!;
const events = async (workId: string, kind: string) => (await store.pool.query('SELECT actor, payload FROM events WHERE work_id=$1 AND kind=$2 ORDER BY seq', [workId, kind])).rows as { actor: string; payload: any }[];
const dbNow = async () => ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString();
/** GitHub reports mergedAt to the second: the whole second the database clock is in right now. */
const wholeSecondNow = async () => new Date(Math.floor(Date.parse(await dbNow()) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const waitUntil = async (instant: number) => { while (Date.parse(await dbNow()) < instant) await delay(25); };
const head = (work: Work) => work.candidate?.sha ?? sha(work.key);
const observation = (work: Work, extra: Partial<Observation> = {}): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha: head(work), baseSha: base, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: worker.id },
  checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [{ reviewer: 'reviewer', sha: head(work), state: 'APPROVED' }],
  protected: true, mergeable: true, merged: false, mergeSha: null, baseTip: base, baseTree: '7e'.repeat(20), files: [], scopeFiles: [], at: new Date().toISOString(), ...extra });
const mergedAt = async (work: Work, mergeSha: string) => observation(work, { merged: true, mergeable: false, prState: 'closed', mergeSha, mergedAt: await wholeSecondNow(), baseTip: mergeSha, baseTree: sha(`tree-${mergeSha}`) });
/** A two-party merge decision for the observed candidate; `approvedBy` omitted leaves it requested. */
async function mergeDecision(work: Work, reason: string, requester: string, approvedBy?: string) {
  const decision = await post(requester, `work/${work.key}/decide`, { action: 'merge', input: { sha: head(work), baseSha: base, policyRevision: work.policyRevision }, reason });
  if (approvedBy) await post(approvedBy, `work/${work.key}/approve`, { decision: decision.id, reason: `Approved: ${reason}` });
  return decision.id as string;
}
/** The dashboard a page render sees: one session, one snapshot, no interactivity. */
const dashboard = (actor: Principal, work: Work[], humanOnly: HumanRequestRow[] | undefined, now: number, sent?: (id: string, command: string, body: unknown) => void) =>
  ({ work, status: { actor, ...(humanOnly ? { humanOnly } : {}) }, observedAt: now, busy: false,
    action: async (target: string, command: string, body: unknown) => { sent?.(target, command, body); }, setSelected: () => {} }) as unknown as Dashboard;

/**
 * An unproven candidate GitHub merged with no execution authorizing it, whose two-party
 * reconciliation the record then refused: the exact state GY-92, GY-94 and GY-84 stand in.
 */
async function mergedWithRefusedReconciliation() {
  const n = ++serial;
  let work = await engine.execute(operator, 'create', null, { title: `Human surface ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, id());
  work = await engine.execute(operator, 'ready', work.id, {}, id());
  work = await engine.execute(worker, 'claim', work.id, {}, id());
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'test', path: `/tmp/human-surface-${n}`, branch: `graphyard/gy-102-${n}` }, id());
  work = await engine.execute(worker, 'submit', work.id, { epoch: 1, pr: 900 + n }, id());
  // One item in the queue at a time, so no entry of another item decides this one's gates.
  await store.pool.query("UPDATE work_items SET document=document-'queue' WHERE id<>$1 AND document->>'stage'<>'done'", [work.id]);
  work = await engine.observe(work.id, work.revision, observation(work));
  const mergeSha = sha(`merge-${work.key}`);
  const merged = await mergedAt(work, mergeSha);
  const cutoff = Date.parse(merged.mergedAt!) + 1000;
  work = await engine.observe(work.id, (await reload(work.id)).revision, merged);
  assert.ok(work.violations.includes(unauthorizedMergeViolation), work.violations.join(' | '));
  await waitUntil(cutoff);
  // The master's agent pair asks for a reconciliation; the acceptance gate was open at the merge
  // cutoff, so the record refuses it and records what it lacked.
  const reconciliation = await mergeDecision(work, `Reconcile ${work.key} after the administrative merge`, masterAgent.token, approverAgent.token);
  work = await engine.observe(work.id, (await reload(work.id)).revision, { ...merged, at: new Date().toISOString() });
  const refusal = work.violations.find(entry => entry.startsWith(`Reconciliation by decision ${reconciliation} refused: `));
  assert.ok(refusal, work.violations.join(' | '));
  return { work, merged, reconciliation, mergeSha };
}

test('integration:human-only-actions-listed — an approval whose decision the server takes from the operator\'s admin credential alone is a human request with the same fields as a parked decision, refused to every agent identity the control plane runs, and listed on the human-facing page', async () => {
  const { work, merged, reconciliation } = await mergedWithRefusedReconciliation();

  // The rule is the server's, not the surface's: the engine refuses an agent-approved override of
  // that refusal in exactly the words the table carries for each of its two parties.
  const byAgents = await mergeDecision(work, `Operator authorized the administrative merge; overrides ${reconciliation}`, masterAgent.token, approverAgent.token);
  const afterAgents = await engine.observe(work.id, (await reload(work.id)).revision, { ...merged, at: new Date().toISOString() });
  assert.equal(afterAgents.delivery, undefined, 'an agent pair delivers nothing, however it cites the refusal');
  const recorded = afterAgents.violations.find(entry => entry.startsWith(`Reconciliation by decision ${byAgents} refused: `))!;
  assert.ok(recorded.includes(operatorCredentialRefusal({ id: masterAgent.id, role: 'operator-agent' })!), recorded);
  assert.ok(recorded.endsWith(` and ${approverAgent.id} is operator-agent`), recorded);

  // The approval that now waits: requested by the master's agent, approvable by nobody it runs.
  const current = await reload(work.id);
  const reason = `Operator-authorized delivery of ${work.key}, citing refused decision ${reconciliation}: the acceptance gate could only be closed after this change shipped`;
  const decision = await mergeDecision(current, reason, masterAgent.token);
  for (const agent of agentIdentities) assert.ok(humanOnlyRefusal(operatorApprovalRule.kind, agent), `${agent.id} must be refused this approval`);
  assert.equal(humanOnlyRefusal(operatorApprovalRule.kind, operator), null, 'the operator is not refused it');

  // It is listed as a human request, with the same fields as the rest of the list.
  const listed = await get(token(operator), 'human-requests');
  const row = (listed.requests as HumanRequestRow[]).find(entry => entry.request.id === decision)!;
  assert.ok(row, JSON.stringify(listed.requests));
  assert.equal(row.rule, operatorApprovalRule.kind);
  assert.deepEqual([row.work, row.id, row.title], [work.key, work.id, current.title]);
  assert.equal(row.request.needed, operatorOnlyDecision({ action: 'merge', reason }, current)!.needed);
  assert.equal(row.request.reason, reason);
  assert.equal(row.request.requestedBy, masterAgent.id);
  assert.ok(row.waitedMs >= 0 && Date.parse(row.request.at) > 0, `waited ${row.waitedMs}ms since ${row.request.at}`);
  assert.equal(row.refusal, operatorCredentialRefusal({ id: 'an agent identity', role: 'operator-agent' }));
  assert.deepEqual(row.answer.post, { command: 'approve', body: { decision }, field: 'reason', submit: `Approve and deliver ${work.key}`, decline: null });

  // The same rows ride the status read every client polls, and the CLI list prints them too.
  const status = await get(token(operator), 'status');
  assert.deepEqual((status.humanOnly as HumanRequestRow[]).map(entry => entry.request.id), (listed.requests as HumanRequestRow[]).map(entry => entry.request.id));
  const printed: any[] = [];
  await humanRequestsCommand.run({ api: (path: string) => get(token(operator), path), print: (value: any) => { printed.push(value); return value; } } as any, undefined as any);
  assert.ok(printed[0].requests.some((entry: any) => entry.needed === row.request.needed && entry.reason === reason), JSON.stringify(printed[0]));

  // And it is on the human-facing page, with the form for the operator and the refusal for an agent.
  const page = renderToStaticMarkup(createElement(HumanRequestsPage, dashboard(operator, await store.list(), status.humanOnly, Date.parse(status.now))));
  for (const shown of [work.key, row.request.needed, row.decision, `asked by ${masterAgent.id}`, `Approve and deliver ${work.key}`]) assert.ok(page.includes(shown), shown);
  const agentSession = renderToStaticMarkup(createElement(HumanRequestsPage, dashboard({ id: masterAgent.id, role: 'operator-agent' } as Principal, await store.list(), status.humanOnly, Date.parse(status.now))));
  assert.ok(!agentSession.includes(`Approve and deliver ${work.key}`), 'an agent session is shown the request, never the form');
  assert.ok(agentSession.includes(humanOnlyRefusal(row.rule, { id: masterAgent.id, role: 'operator-agent' })!), 'and is told exactly what the server would refuse this session');
});

test('integration:approve-from-page — the operator answers the approval from the page in their authenticated session: the route the card posts to applies the decision with their own attribution and reason, and the delivery that follows names them as the operator', async () => {
  const { work, merged, reconciliation } = await mergedWithRefusedReconciliation();
  const reason = `Operator-authorized delivery of ${work.key}, overriding refused reconciliation ${reconciliation}`;
  const decision = await mergeDecision(await reload(work.id), reason, masterAgent.token);
  const listed = await get(token(operator), 'human-requests');
  const row = (listed.requests as HumanRequestRow[]).find(entry => entry.request.id === decision)!;

  // Exactly what the card does: render the page, press the button, post what the row's own answer
  // names. No credential is handled anywhere but the session the operator is already signed into.
  const sent: { target: string; command: string; body: unknown }[] = [];
  renderToStaticMarkup(createElement(HumanRequestsPage, dashboard(operator, await store.list(), listed.requests, Date.parse(listed.now), (target, command, body) => sent.push({ target, command, body }))));
  const typed = 'Approved: the merge is live and proven in use; record it as the operator-authorized delivery it was';
  const answered = await post(token(operator), `work/${row.id}/${row.answer.post.command}`, { ...row.answer.post.body, [row.answer.post.field]: typed });
  assert.equal(answered.id, decision);
  assert.equal(answered.state, 'applied');
  assert.equal(answered.approvedBy, operator.id);
  assert.equal(answered.approvalReason, typed);
  assert.equal(answered.requestedBy, masterAgent.id, 'the requester is unchanged: the operator supplied the second party, nothing else');
  const approval = (await events(work.id, 'decision.approved')).find(entry => entry.payload.id === decision)!;
  assert.equal(approval.actor, operator.id);
  assert.deepEqual([approval.payload.approver.id, approval.payload.approver.role, approval.payload.reason], [operator.id, 'admin', typed]);

  // The delivery that follows is the operator's, and the approval leaves the human surface.
  const delivered = await engine.observe(work.id, (await reload(work.id)).revision, { ...merged, at: new Date().toISOString() });
  assert.equal(delivered.stage, 'done', delivered.violations.join(' | '));
  const authorization = (delivered.delivery as any).operatorAuthorization;
  assert.equal(authorization.operator, operator.id);
  assert.equal(authorization.decision, decision);
  assert.equal(authorization.refusedDecision, reconciliation);
  assert.equal(authorization.approvalReason, typed);
  assert.equal((await events(work.id, 'merge.operator-authorized'))[0].actor, operator.id);
  const after = await get(token(operator), 'human-requests');
  assert.equal((after.requests as HumanRequestRow[]).some(entry => entry.request.id === decision), false, 'an answered approval no longer waits');
});

test('unit:human-surface-derived-from-refusals — a human-only refusal added to the rule table is listed and answerable on the page with no change to the page: the surface is the table, never a list of kinds the page keeps', async () => {
  const work = (await store.list()).filter(item => item.stage !== 'done');
  assert.ok(work.length, 'the graph has open work to derive from');
  const before = openHumanOnly(work.map(item => ({ work: item })), Date.now());
  assert.equal(before.some(row => row.rule === 'deployment-key'), false);

  // A kind nobody wrote the page for: issuing a deployment key for a person, refused to every
  // session but the operator's own. Adding it to the table is the whole change.
  const rule: HumanOnlyRule = {
    kind: 'deployment-key',
    refuse: actor => actor.role === 'admin' && actor.sessionKind === 'human' ? null : `A deployment key is issued by the operator; ${actor.id} is a ${actor.role ?? 'session of unrecorded role'}`,
    open: (subject, now) => [{
      rule: 'deployment-key', work: subject.work.key, id: subject.work.id, title: subject.work.title,
      request: { id: `key-${subject.work.id}`, kind: 'deployment-key', needed: `A deployment key for ${subject.work.key}`, reason: 'The staging host will not accept the build without one', requestedBy: 'graphyard', epoch: subject.work.epoch, at: new Date(now - 90_000).toISOString() },
      waitedMs: 90_000, decision: 'issuing credentials to people',
      refusal: rule.refuse({ id: 'an agent identity', role: 'operator-agent', sessionKind: 'ai' })!,
      answer: { cli: `graphyard answer ${subject.work.key} KEY`, decline: `graphyard answer ${subject.work.key} --decline REASON`, dashboard: 'Work → Needs you → Issue', api: 'POST /api/work/KEY/answer',
        post: { command: 'answer', body: { request: `key-${subject.work.id}` }, field: 'answer', submit: `Issue the key for ${subject.work.key}`, decline: null } },
    }],
  };
  humanOnlyRules.push(rule);
  try {
    const rows = openHumanOnly(work.map(item => ({ work: item })), Date.now());
    const added = rows.filter(row => row.rule === rule.kind);
    assert.equal(added.length, work.length, 'every open item the new rule raises is listed');
    // Longest wait first, beside the rules that were already there: one list, one order.
    assert.deepEqual(rows.map(row => row.waitedMs), [...rows.map(row => row.waitedMs)].sort((a, b) => b - a));

    const sent: { target: string; command: string; body: unknown }[] = [];
    const page = renderToStaticMarkup(createElement(HumanRequestsPage, dashboard(operator, work, rows, Date.now(), (target, command, body) => sent.push({ target, command, body }))));
    const row = added[0];
    for (const shown of [row.request.needed, row.request.reason, row.answer.post.submit, row.answer.cli]) assert.ok(page.includes(shown), shown);
    // The page offers the form to the session the new rule admits and the refusal to the rest,
    // from the rule itself — it has no idea what a deployment key is.
    const refused = renderToStaticMarkup(createElement(HumanRequestsPage, dashboard(coordinator, work, rows, Date.now())));
    assert.ok(!refused.includes(row.answer.post.submit) && refused.includes(humanOnlyRefusal(rule.kind, coordinator)!), 'a refused session sees its own refusal, not the form');
    assert.equal(humanOnlyRefusal(rule.kind, coordinator), `A deployment key is issued by the operator; ${coordinator.id} is a coordinator`);
    assert.equal(humanOnlyRefusal(rule.kind, operator), null);
    // The rules that were already there are untouched by it.
    assert.deepEqual(rows.filter(entry => entry.rule !== rule.kind).map(entry => entry.request.id), before.map(entry => entry.request.id));
    assert.deepEqual(humanOnlyRules.filter(entry => entry !== rule).map(entry => entry.kind), [parkRule.kind, operatorApprovalRule.kind]);
  } finally {
    humanOnlyRules.splice(humanOnlyRules.indexOf(rule), 1);
  }
});
