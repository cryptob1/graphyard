import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
import { hostDoableAsk, humanOnlyRefusal, humanOnlyRules, humanRequestSchema, openHumanOnly, operatorApprovalRule, parkRefusal, parkRule, type HumanOnlyRule, type HumanRequestRow } from '../src/model/human-request.js';
import { humanAsk, shortAskIssues } from '../src/model/human-ask.js';
import { parkArgs, parkCommand, routedParkCommand, sessionCommands } from '../src/cli/session-commands.js';
import { nextActor } from '../src/model/board.js';
import { plainLines } from '../web/item-page.js';
import WorkCard from '../web/components/work-card.js';
import type { Observation, Principal, Work } from '../src/model.js';
import HumanRequestsPage, { RequestCard } from '../web/pages/human-requests.js';
import type { Dashboard } from '../web/pages/dashboard.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

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
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('human-surface'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
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
 * A candidate GitHub merged before its review gate passed (GY-1235: an unapproved head), whose
 * two-party reconciliation the record then refused: the exact state GY-92, GY-94 and GY-84 stand in.
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
  work = await engine.observe(work.id, work.revision, observation(work, { reviews: [] }));
  const mergeSha = sha(`merge-${work.key}`);
  const merged = await mergedAt(work, mergeSha);
  const cutoff = Date.parse(merged.mergedAt!) + 1000;
  work = await engine.observe(work.id, (await reload(work.id)).revision, merged);
  assert.ok(work.violations.includes(unauthorizedMergeViolation), work.violations.join(' | '));
  await waitUntil(cutoff);
  // The master's agent pair asks for a reconciliation; the review gate was open at the merge
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
  const reason = `Operator-authorized delivery of ${work.key}, citing refused decision ${reconciliation}: the review gate could only be closed after this change shipped`;
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
  assert.deepEqual(row.answer.post, { command: 'approve', body: { decision }, field: 'reason', submit: `Approve and deliver ${work.key}`, decline: { body: { action: 'refuse', decision }, submit: 'Decline' } });

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

test('integration:decline-from-page — the operator declines an operator-only approval with one button on the card (GY-1041): the route it posts to records their considered refusal, and the approval leaves the human surface without delivering', async () => {
  const { work, merged, reconciliation } = await mergedWithRefusedReconciliation();
  const reason = `Operator-authorized delivery of ${work.key}, overriding refused reconciliation ${reconciliation}`;
  const decision = await mergeDecision(await reload(work.id), reason, masterAgent.token);
  const listed = await get(token(operator), 'human-requests');
  const row = (listed.requests as HumanRequestRow[]).find(entry => entry.request.id === decision)!;
  assert.deepEqual(row.choices!.map(choice => [choice.label, choice.declines]), [[`Approve and deliver ${work.key}`, false], ['Decline', true]], 'the card offers Decline beside Approve, as a park request does');
  assert.match(row.answer.decline, new RegExp(`master refuse ${work.key} ${decision} REASON$`), 'the terminal equivalent is the operator\'s own refusal, not the requester\'s withdrawal');
  const page = renderToStaticMarkup(createElement(HumanRequestsPage, dashboard(operator, await store.list(), listed.requests, Date.parse(listed.now))));
  assert.ok(page.includes('>Decline</button>'), 'the Decline button is on the operator\'s card');

  const decline = row.choices!.find(choice => choice.declines)!;
  const typed = 'Declined: the refused reconciliation stands until the review gate passes on its own';
  const declined = await post(token(operator), `work/${row.id}/${row.answer.post.command}`, { ...decline.body, [decline.note!]: typed });
  assert.equal(declined.id, decision);
  assert.equal(declined.state, 'refused');
  const recorded = (await events(work.id, 'decision.declined')).find(entry => entry.payload.id === decision)!;
  assert.deepEqual([recorded.actor, recorded.payload.reason, recorded.payload.requestedBy], [operator.id, typed, masterAgent.id]);
  const observed = await engine.observe(work.id, (await reload(work.id)).revision, { ...merged, at: new Date().toISOString() });
  assert.equal(observed.delivery, undefined, 'a declined approval delivers nothing');
  const after = await get(token(operator), 'human-requests');
  assert.equal((after.requests as HumanRequestRow[]).some(entry => entry.request.id === decision), false, 'a declined approval no longer waits');
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

/** A worker's item, claimed at epoch 1 and parked with `body` through the real route. */
async function parked(body: Record<string, unknown>) {
  const n = ++serial;
  let work = await engine.execute(operator, 'create', null, { title: `Short ask ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:behaves'] }] }, id());
  work = await engine.execute(operator, 'ready', work.id, {}, id());
  work = await engine.execute(worker, 'claim', work.id, {}, id());
  await post(token(worker), `work/${work.id}/park`, { epoch: 1, kind: 'money-or-accounts', ...body });
  return reload(work.id);
}
/**
 * What a reader sees in rendered markup: a closed <details> shows only its summary, and tags and
 * attributes are not text.
 */
const visibleText = (markup: string) => markup
  .replace(/<details(?![^>]*\bopen)[^>]*>\s*<summary[^>]*>(.*?)<\/summary>.*?<\/details>/gs, ' $1 ')
  .replace(/<textarea[^>]*>.*?<\/textarea>/gs, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ').trim();
const occurrences = (text: string, part: string) => text.split(part).length - 1;
/** A worker's note in agent shorthand, 150 words: what used to be the card. */
const agentNote = Array.from({ length: 15 }, (_, index) => `Resume graphyard/gy-1384-${index} at 5bc497ab7c62 then graphyard unseal GY-1384 under GH_CONFIG_DIR.`).join(' ');

test('unit:human-request-short-ask — a park carries a short human ask apart from its agent detail: ASK, STEPS and WHY are bounded and refuse agent shorthand naming it, and a request without them leads with the first sentence of NEEDED', async () => {
  const ok = { epoch: 1, kind: 'money-or-accounts', needed: 'A repository and an admin token', reason: 'The pilot needs both' };
  const refused = (extra: Record<string, unknown>) => { const parsed = humanRequestSchema.safeParse({ ...ok, ...extra }); assert.equal(parsed.success, false, JSON.stringify(extra)); return parsed.error!.issues.map(issue => issue.message).join(' | '); };
  // The limits: one sentence of at most 140 characters, at most 5 steps of at most 160, a why of at most 200.
  assert.match(refused({ ask: `Create ${'a'.repeat(140)}` }), /ASK is 147 characters; keep it to 140/);
  assert.match(refused({ ask: 'Create the repository. Then paste the token' }), /ASK is one sentence/);
  assert.match(refused({ ask: 'Create it', steps: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'] }), /STEPS has 6 lines; keep it to 5/);
  assert.match(refused({ ask: 'Create it', steps: ['x'.repeat(161)] }), /STEP 1 is 161 characters; keep it to 160/);
  assert.match(refused({ ask: 'Create it', why: 'w'.repeat(201) }), /WHY is 201 characters; keep it to 200/);
  // Agent shorthand is refused in ASK and STEPS, naming the offending text, so it goes in REASON.
  assert.match(refused({ ask: 'Review head 5bc497ab7c62 on GitHub' }), /ASK names a commit sha \(5bc497ab7c62\); put it in REASON/);
  assert.match(refused({ ask: 'Merge graphyard/gy-1384-2 into main' }), /ASK names a branch name \(graphyard\/gy-1384-2\)/);
  assert.match(refused({ ask: 'Create it', steps: ['Run graphyard unseal GY-1384 on the host'] }), /STEP 1 names a graphyard or gh command \(graphyard unseal GY-1384/);
  assert.match(refused({ ask: 'Create it', steps: ['Sign in', 'Run gh auth login as the admin'] }), /STEP 2 names a graphyard or gh command \(gh auth/);
  assert.match(refused({ ask: 'Create it', steps: ['Edit src/model/human-request.ts'] }), /STEP 1 names a file path \(src\/model\/human-request.ts\)/);
  assert.match(refused({ ask: 'Put the token in ~/.config/gh/hosts.yml' }), /ASK names a file path \(~\/.config\/gh\/hosts.yml\)/);
  // A plain note passes, links included; WHY is plain words and not policed for shorthand.
  const note = { ask: 'Create the install-proof repository and give the pilot an admin token', steps: ['Open github.com/new and create cryptob1/graphyard-install-proof as private', 'Create a classic token with repo and admin scopes', 'Paste the token in the box below'], why: 'The setup walk has to run against a fresh repository that you own.' };
  assert.equal(humanRequestSchema.safeParse({ ...ok, ...note }).success, true, JSON.stringify(shortAskIssues(note)));
  assert.equal(humanRequestSchema.safeParse(ok).success, true, 'a request recorded without an ask still parses');

  // The CLI takes them as flags beside NEEDED and REASON, requires ASK and refuses shorthand before it posts.
  assert.deepEqual(parkArgs(['A', 'repository', '--ask', note.ask, '--step', note.steps[0], '--step', note.steps[1], '--why', note.why]),
    { needed: 'A repository', choices: undefined, ask: note.ask, steps: note.steps.slice(0, 2), why: note.why });
  assert.throws(() => parkArgs(['A', 'repository', '--ask']), /--ask needs its text/);
  const posted: unknown[] = [];
  const run = (args: string[]) => parkCommand.run({ args: ['1', 'money-or-accounts', ...args], print: () => {}, api: async (_path: string, data?: unknown) => { posted.push(data); return {}; }, individualHostId: () => 'host' } as any, { id: 'w', key: 'GY-1', revision: 1 } as any);
  await assert.rejects(run(['A', 'repository', '--', 'Needed for the pilot']), /--ask ASK/);
  await assert.rejects(run(['A', 'repository', '--ask', 'Check out 5bc497ab7c62', '--', 'Needed']), /ASK names a commit sha \(5bc497ab7c62\)/);
  assert.equal(posted.length, 0, 'nothing is posted for a refused ask');

  // The route keeps them on the request; the agent detail stays as it was.
  const work = await parked({ needed: agentNote, reason: agentNote, ...note });
  assert.deepEqual([work.humanRequest!.ask, work.humanRequest!.steps, work.humanRequest!.why, work.humanRequest!.reason], [note.ask, note.steps, note.why, agentNote]);
  assert.equal((await request(token(worker), 'POST', `work/${(await parked({ needed: 'x', reason: 'y' })).id}/park`, { ...ok, ask: 'Open 5bc497ab7c62' })).status, 400, 'the route refuses shorthand too');

  // Fallback: an open request recorded before asks existed leads with the first sentence of NEEDED.
  const legacy = await parked({ needed: 'Approve the paid GitHub Team plan. Then resume graphyard/gy-1384-2 at 5bc497ab7c62 with graphyard unseal GY-1384.', reason: agentNote });
  assert.equal(legacy.humanRequest!.ask, undefined);
  assert.equal(humanAsk(legacy.humanRequest!), 'Approve the paid GitHub Team plan.');
  assert.equal(nextActor(legacy, 'needs-you', Date.now()).does, 'Approve the paid GitHub Team plan.');
  const row = openHumanOnly([{ work: legacy }], Date.now())[0];
  const card = renderToStaticMarkup(createElement(RequestCard, { row, refusal: null, busy: false, open: () => {}, answer: async () => {} }));
  assert.match(card, /<h3>Approve the paid GitHub Team plan\.<\/h3>/);
  assert.ok(!visibleText(card).includes('graphyard unseal'), 'the rest of NEEDED is detail for agents');
});

test('unit:human-request-card-render — each human request renders once per surface: the ask as its heading, its steps numbered, why in one line, then the choices, with the agent detail folded under a closed "Details for agents"', async () => {
  const note = { ask: 'Create the install-proof repository and give the pilot an admin token', steps: ['Create a private repository named graphyard-install-proof', 'Paste an admin token for it in the box below'], why: 'The setup walk needs a fresh repository that you own.' };
  assert.equal(agentNote.split(/\s+/).length, 150);
  const work = await parked({ needed: agentNote, reason: agentNote, ...note });
  const rows = (await get(token(operator), 'human-requests')).requests as HumanRequestRow[];
  const row = rows.find(entry => entry.id === work.id)!;

  // The Needs you page.
  const page = renderToStaticMarkup(createElement(HumanRequestsPage, dashboard(operator, [work], [row], Date.now())));
  const card = page.slice(page.indexOf('<div class="card human-request">'));
  const seen = visibleText(card);
  assert.ok(seen.split(' ').length < 80, `${seen.split(' ').length} visible words: ${seen}`);
  assert.equal(occurrences(seen, note.ask), 1, 'the ask once');
  assert.match(card, new RegExp(`<h3>${note.ask}</h3><ol class="human-steps"><li>${note.steps[0]}</li><li>${note.steps[1]}</li></ol><p class="human-why">${note.why}</p>`), 'heading, numbered steps, then why');
  assert.ok(card.indexOf(note.why) < card.indexOf(row.choices![0].label), 'the choices follow');
  assert.ok(!seen.includes('graphyard unseal') && !seen.includes('5bc497ab') && !seen.includes('Who acts next'), 'no agent detail and no restatement in view');
  assert.match(card, /<details class="agent-details"><summary class="muted">Details for agents<\/summary>/, 'the detail is collapsed, closed by default');
  assert.ok(card.includes(agentNote.slice(0, 30)), 'and still there for the next agent');

  // The work card (overview and Work page): the ask once as its line, "You" as who acts, no reason.
  const now = Date.now();
  assert.deepEqual(nextActor(work, 'needs-you', now), { who: 'You', does: note.ask });
  const row2 = visibleText(renderToStaticMarkup(createElement(WorkCard, { item: work, now, onOpen: () => {}, group: 'needs-you' })));
  assert.equal(occurrences(row2, note.ask), 1, row2);
  assert.ok(!row2.includes('graphyard unseal'), row2);
  // The item page's "what is left" points at the card rather than restating the blocker's detail.
  const ready = work.gates.find(gate => gate.name === 'ready')!;
  assert.ok(ready.reasons.some(reason => reason.includes('graphyard unseal')), 'the blocker keeps the detail for agents');
  assert.deepEqual(plainLines(ready).filter(line => line.includes('graphyard unseal')), []);
});

// GY-1416: two parks this week asked the human for what the host could do — GY-1365 the revert
// approver variables install derives from the reviewer App saved here, GY-1384 a repository the
// host's own gh login administers. Their NEEDED texts, as the ledger records them, are replayed.
const hostDoableReplays = {
  'GY-1365': 'Register or choose the revert approver GitHub App (the reviewer App serves; it must differ from the control-plane App), install it on the repository, set GRAPHYARD_REVERT_APPROVER_APP_ID, GRAPHYARD_REVERT_APPROVER_INSTALLATION_ID and GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY (or _PRIVATE_KEY_FILE) on the production control plane via scripts/provision-railway.mjs operator input, and redeploy',
  'GY-1384': 'Operator-run pilot access for cryptob1/graphyard-install-proof: (1) make the repository reachable (it returns 404 to the public API and to this worker\'s repo-scoped App token) and run the pilot under a gh login with ADMIN viewerPermission on it (setup-from-zero step 1 HUMAN); (2) create and install the Graphyard GitHub App and the reviewer App on that repository, approving any GitHub Mobile Confirm access prompt (steps 4-5 HUMAN); (3) finish /login for the fresh Claude/Codex agent environments (step 8 HUMAN). Alternatively, re-scope AC-1 to a walk an agent identity can complete.',
} as const;

test('unit:park-refuses-host-doable — park refuses a NEEDED an agent identity on the host can do (a repository its gh login administers, a deployment variable derived from saved credentials, a credential the host holds), naming the master\'s route, and records it as the master\'s owed action; the three human-only decisions still park', async () => {
  const refused = [
    ['GY-1365 replay', 'money-or-accounts', hostDoableReplays['GY-1365'], 'deployment-variable', 'graphyard master setup --apply'],
    ['GY-1384 replay', 'money-or-accounts', hostDoableReplays['GY-1384'], 'repository', 'gh repo create OWNER/NAME'],
    ['a repository to create', 'money-or-accounts', 'Create the repository owner/install-proof on GitHub, empty, private', 'repository', 'gh repo create OWNER/NAME'],
    ['a credential the host holds', 'credentials-for-people', 'Paste a GitHub token with repo and admin:repo_hook scopes so the pilot can configure webhooks', 'host-credential', 'gh auth token'],
    ['a derived variable by phrase', 'money-or-accounts', 'Set the deployment variables for the reviewer App on Railway and redeploy', 'deployment-variable', 'graphyard master setup --apply'],
  ] as const;
  for (const [label, kind, needed, cls, command] of refused) {
    const ask = hostDoableAsk(needed);
    assert.equal(ask?.class, cls, label);
    const refusal = parkRefusal({ needed })!;
    assert.match(refusal, /^Not a human-only decision: .*the master's owed action, not the human's\. Agent route: /, label);
    assert.ok(refusal.includes(command), `${label}: the refusal names ${command}`);
    // The server refuses it, and the item never reaches the human: the worker keeps its lease.
    const n = ++serial;
    let work = await engine.execute(operator, 'create', null, { title: `Host-doable ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['unit:behaves'] }] }, id());
    work = await engine.execute(operator, 'ready', work.id, {}, id());
    work = await engine.execute(worker, 'claim', work.id, {}, id());
    const response = await request(token(worker), 'POST', `work/${work.id}/park`, { epoch: 1, kind, needed, reason: 'as recorded', ask: 'Do the thing' });
    assert.deepEqual([response.status, response.body.error], [422, refusal], label);
    assert.equal((await reload(work.id)).humanRequest ?? null, null, `${label} never parks`);
    // The CLI records the same ask as the master's owed action, a blocker naming the route, instead of a park.
    const posted: { path: string; data: any }[] = [], printed: any[] = [];
    await routedParkCommand.run({ args: ['1', kind, ...needed.split(' '), '--ask', 'Do the thing', '--', 'as recorded'], print: (value: unknown) => { printed.push(value); }, api: async (path: string, data?: unknown) => { posted.push({ path, data }); return {}; }, individualHostId: () => 'host' } as any, { id: work.id, key: work.key, revision: work.revision } as any);
    assert.deepEqual(posted.map(entry => entry.path), [`work/${work.id}/blocked`], `${label}: recorded, not parked`);
    assert.equal(posted[0].data.epoch, 1);
    assert.match(posted[0].data.reason, /^Owed master action \(a park refused as host-doable, GY-1416\): /);
    assert.ok(posted[0].data.reason.includes(command) && posted[0].data.reason.includes(needed.slice(0, 40)), `${label}: the owed action names its command and the ask`);
    assert.deepEqual([printed[0].parked, printed[0].refusal, printed[0].owedAction.owner, printed[0].owedAction.class], [false, refusal, 'master', cls]);
  }
  assert.ok(sessionCommands.includes(routedParkCommand) && !sessionCommands.includes(parkCommand), 'graphyard park is the routed command');

  // Still the human's: goals and priorities, money or paid accounts, credentials issued to people.
  const accepted = [
    ['goals-and-priorities', 'Decide whether the legacy importer is still a goal before GY-12 removes it'],
    ['money-or-accounts', 'Approve a Hetzner cx22 server at 4.51 EUR a month for the live-install proof'],
    ['money-or-accounts', 'Open a paid Railway team plan for the staging environment'],
    ['credentials-for-people', 'Issue a dashboard sign-in for the new teammate who reviews releases'],
    ['credentials-for-people', 'Give the new contractor a GitHub token scoped to the docs repository'],
  ] as const;
  for (const [kind, needed] of accepted) {
    assert.equal(parkRefusal({ needed }), null, needed);
    const work = await parked({ kind, needed, reason: 'a decision only the operator makes' });
    assert.equal(work.humanRequest?.kind, kind, `${needed} parks`);
    // The CLI passes it straight to park.
    const posted: string[] = [];
    await routedParkCommand.run({ args: ['1', kind, ...needed.split(' '), '--ask', 'Decide it', '--', 'why'], print: () => {}, api: async (path: string) => { posted.push(path); return {}; }, individualHostId: () => 'host' } as any, { id: 'w', key: 'GY-1', revision: 1 } as any);
    assert.deepEqual(posted, ['work/w/park'], needed);
  }
});
