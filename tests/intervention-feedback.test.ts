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
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import { standingEscalations, type Observation, type Principal, type Work } from '../src/model.js';
import { interventionKinds, interventionPolicyFromEnv, type Intervention, type InterventionKind, type InterventionReport } from '../src/model/interventions.js';
import { foldInterventions, openPatternItems, readInterventionLedger } from '../src/interventions.js';
import { interventionSummary } from '../src/cli/intervention-status.js';
import InterventionsPage from '../web/pages/interventions.js';
import { views } from '../web/pages/index.js';
import type { Dashboard } from '../web/pages/dashboard.js';

// GY-98: every operator intervention is product feedback. Each test is named for the proof it
// produces and runs the real engine and HTTP server on a disposable Postgres: the interventions
// are driven through the same commands production uses, then read back as typed signals.
const repository = 'owner/feedback';
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const approver: Principal = { id: 'approver-admin', role: 'admin', sessionKind: 'ai' };
const coordinator: Principal = { id: 'master-loop', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'implementer', role: 'worker', sessionKind: 'ai' };
const reader: Principal = { id: 'auditor', role: 'reader', sessionKind: 'human' };
const credentials = [operator, approver, coordinator, worker, reader].map(principal => ({ ...principal, token: `feedback-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const base = 'b'.repeat(40);
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_INTERVENTION_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 32);
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-interventions-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('interventions_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/interventions_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials, null, undefined, { env: { ...process.env, GRAPHYARD_INTERVENTION_PATTERN_THRESHOLD: '3', GRAPHYARD_INTERVENTION_PATTERN_WINDOW_DAYS: '7' } });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

const id = () => randomUUID();
const call = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown, key: string = randomUUID()) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${credential}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as any };
};
const ok = async (credential: string, method: 'GET' | 'POST', path: string, body?: unknown, key?: string) => {
  const result = await call(credential, method, path, body, key);
  assert.equal(result.status, 200, result.text);
  return result.body;
};
const reload = async (workId: string) => (await store.list()).find(item => item.id === workId)!;
const dbNow = async () => ((await store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date).toISOString();
const report = (query = 'window=7', credential = token(coordinator)) => ok(credential, 'GET', `interventions?${query}`) as Promise<InterventionReport & { ledger: { rows: number; truncated: boolean } }>;
const observation = (work: Work, extra: Partial<Observation> = {}): Observation => ({ clockOffset: { min: 0, max: 0 }, candidate: { sha: sha(work.key), baseSha: base, pr: work.submission!.pr, branch: work.workspaces[0].branch, author: worker.id },
  checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [], protected: true, mergeable: true, merged: false, mergeSha: null,
  baseTip: base, baseTree: '7e'.repeat(20), files: [], scopeFiles: [], at: new Date().toISOString(), ...extra });

async function created(title: string, extra: Record<string, unknown> = {}) {
  const n = ++serial;
  const work = await engine.execute(operator, 'create', null, { title: `${title} ${n}`, plannedFiles: [`src/${title}.ts`], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:behaves'] }], ...extra }, id());
  return engine.execute(operator, 'ready', work.id, {}, id());
}
async function claimed(title: string) {
  let work = await created(title);
  work = await engine.execute(worker, 'claim', work.id, {}, id());
  return engine.execute(worker, 'workspace', work.id, { epoch: work.epoch, host: 'feedback-host', path: `/tmp/feedback/${work.id}`, branch: `graphyard/${work.key.toLowerCase()}-${work.epoch}` }, id());
}
async function submitted(title: string) {
  let work = await claimed(title);
  work = await engine.execute(worker, 'submit', work.id, { epoch: work.epoch, pr: 500 + serial }, id());
  return engine.observe(work.id, work.revision, observation(work));
}
/** A delivered item, as the record leaves it after an observed authorized merge, at `mergedAt`. */
async function delivered(title: string, mergedAt: string) {
  const work = await created(title);
  await store.pool.query(`UPDATE work_items SET document=document || jsonb_build_object('stage','done','stageEnteredAt',$2::text,'delivery',jsonb_build_object('mergedAt',$2::text,'mergeSha',$3::text,'authorizationRevision',1)) WHERE id=$1`, [work.id, mergedAt, sha(`merge-${work.key}`)]);
  return reload(work.id);
}
const decide = (credential: string, work: Work, body: Record<string, unknown>) => ok(credential, 'POST', `work/${work.key}/decide`, body);
const approve = (credential: string, work: Work, decision: string, reason: string) => ok(credential, 'POST', `work/${work.key}/approve`, { decision, reason });
const ofKind = (list: Intervention[], kind: InterventionKind, key: string) => list.filter(entry => entry.kind === kind && entry.work?.key === key);
const hoursAgo = (hours: number, from = Date.now()) => new Date(from - hours * 3_600_000).toISOString();

test('integration:intervention-signals-recorded — one intervention of each kind is driven through the real commands and read back as a typed signal: the kind, what was blocked, how long it waited, which item and stage, and what resolved it', async () => {
  // rework: a submitted candidate the master decides to send back, approved by an independent agent.
  const reworked = await submitted('rework');
  const decision = await decide(token(operator), reworked, { action: 'rework', input: { previousWorkerStopped: true }, reason: 'The candidate reverts the regression guard; send it back' });
  await delay(30);
  const applied = await approve(token(approver), reworked, decision.id, 'The reviewer finding stands');
  assert.equal(applied.state, 'applied', JSON.stringify(applied));

  // scope-widening: a worker asks for a path its item does not imply; the loop refuses; the operator widens.
  const widened = await claimed('scope');
  await engine.execute(worker, 'scope', widened.id, { epoch: widened.epoch, paths: ['src/store/schema.ts'], reason: 'The registry lives under src/store/' }, id());
  const refused = await engine.execute(coordinator, 'autoscope', widened.id, { epoch: widened.epoch }, id());
  assert.equal(refused.scopeDecision?.state, 'refused');
  await delay(30);
  await engine.execute(operator, 'requirements', widened.id, { expectedPolicyRevision: refused.policyRevision, criteria: refused.criteria, dependencies: refused.dependencies, plannedFiles: [...refused.plannedFiles, 'src/store/schema.ts'], exclusiveResources: [], producerProofs: [], reason: 'The registry is where the table goes' }, id());

  // bypass: an unproven candidate merged administratively; the record refuses the reconciliation and the operator owns the delivery.
  const bypassed = await submitted('bypass');
  const mergeSha = sha(`merge-${bypassed.key}`);
  const mergedAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  const merged = observation(bypassed, { merged: true, mergeable: false, prState: 'closed', mergeSha, mergedAt, baseTip: mergeSha, baseTree: sha(`tree-${mergeSha}`) });
  let current = await engine.observe(bypassed.id, (await reload(bypassed.id)).revision, merged);
  while (Date.parse(await dbNow()) < Date.parse(mergedAt) + 1000) await delay(25);
  const first = await decide(token(operator), current, { action: 'merge', input: { sha: sha(bypassed.key), baseSha: base, policyRevision: current.policyRevision }, reason: 'Reconcile after the administrative merge' });
  await approve(token(approver), current, first.id, 'Approved');
  current = await engine.observe(bypassed.id, (await reload(bypassed.id)).revision, { ...merged, at: new Date().toISOString() });
  assert.ok(current.violations.some(entry => entry.startsWith(`Reconciliation by decision ${first.id} refused`)), current.violations.join(' | '));
  const owning = await decide(token(operator), current, { action: 'merge', input: { sha: sha(bypassed.key), baseSha: base, policyRevision: current.policyRevision }, reason: `Operator authorized the administrative merge, overriding refused reconciliation ${first.id}` });
  await approve(token(approver), current, owning.id, 'Approved');
  current = await engine.observe(bypassed.id, (await reload(bypassed.id)).revision, { ...merged, at: new Date().toISOString() });
  assert.equal(current.stage, 'done');

  // containment-settlement and escalation: a fence whose supervisor vanished; the lapse escalates, a
  // declared human resolves it, and the operator's stopped-worker rework discards the fence.
  const fenced = await claimed('fence');
  const settlementHash = createHash('sha256').update(randomUUID().replaceAll('-', '').padEnd(64, '9').slice(0, 64)).digest('hex');
  await engine.execute(worker, 'quarantine', fenced.id, { epoch: fenced.epoch, settlementHash }, id());
  await store.pool.query(`UPDATE work_items SET document=jsonb_set(document,'{lease,expiresAt}',to_jsonb($2::text)) WHERE id=$1`, [fenced.id, new Date(Date.now() - 600_000).toISOString()]);
  await engine.reconcile();
  let lost = await reload(fenced.id);
  assert.deepEqual(standingEscalations(lost).map(entry => entry.trigger), ['lease-loss']);
  await delay(30);
  lost = await engine.execute(operator, 'resolve', fenced.id, { trigger: 'lease-loss', expectedRevision: lost.revision, reason: 'The host rebooted; nothing else ran' }, id());
  await engine.execute(operator, 'rework', fenced.id, { reason: 'Supervisor stopped by hand after the reboot', previousWorkerStopped: true }, id());

  // session-nudge: the loop re-prompted a reviewer session that had shown no activity, and records it.
  const nudged = await submitted('nudge');
  const since = hoursAgo(0.25);
  const recorded = await ok(token(coordinator), 'POST', 'interventions', { kind: 'session-nudge', work: nudged.key, blocked: 'reviewer session graphyard-reviewer-nudge showed no activity for 15 minutes', since, resolution: 're-prompted once with its own request' });
  assert.equal(recorded.kind, 'session-nudge'); assert.equal(recorded.source, 'recorded'); assert.equal(recorded.work.key, nudged.key);

  // human-only-decision: the worker parks the item on a decision only a human may make; the human answers.
  const parked = await claimed('human');
  await ok(token(worker), 'POST', `work/${parked.key}/park`, { epoch: parked.epoch, kind: 'money-or-accounts', needed: 'a Railway account for the proof environment', reason: 'The proof runs against a deployed environment' });
  await delay(30);
  const request = (await reload(parked.id)).humanRequest!;
  await ok(token(operator), 'POST', `work/${parked.key}/answer`, { request: request.id, outcome: 'provided', answer: 'Use the shared staging account' });

  const { interventions } = await report('window=7');
  const one = (kind: InterventionKind, key: string) => { const found = ofKind(interventions, kind, key); assert.equal(found.length, 1, `${kind} on ${key}: ${JSON.stringify(found)}`); return found[0]; };
  for (const entry of interventions) {
    assert.ok(interventionKinds.includes(entry.kind), entry.kind);
    assert.ok(entry.blocked.length > 0 && entry.requestedAt && typeof entry.waitedMs === 'number', JSON.stringify(entry));
    if (entry.resolvedAt) { assert.ok(entry.resolvedBy && entry.resolution !== null, JSON.stringify(entry)); assert.ok(Date.parse(entry.resolvedAt) >= Date.parse(entry.requestedAt)); assert.equal(entry.waitedMs, Date.parse(entry.resolvedAt) - Date.parse(entry.requestedAt)); }
  }
  const rework = one('rework', reworked.key);
  assert.match(rework.blocked, new RegExp(`^candidate ${sha(reworked.key).slice(0, 12)} \\(PR #${reworked.submission!.pr}\\)$`));
  assert.equal(rework.stage, 'review'); assert.equal(rework.trigger, 'decision');
  assert.equal(rework.resolvedBy, operator.id); assert.match(rework.resolution!, /send it back \[decision .* approved by approver-admin/);
  assert.ok(rework.waitedMs >= 30, 'the wait runs from the decision request to the applied rework');
  assert.deepEqual(rework.sources.map(source => source.kind), ['decision.requested', 'rework']);
  assert.equal(rework.id, `rework:${reworked.id}:${decision.id}`, 'a stable id, so a pattern links the same instance every reading');

  const scope = one('scope-widening', widened.key);
  assert.equal(scope.blocked, 'files outside plannedFiles: src/store/schema.ts'); assert.equal(scope.stage, 'build'); assert.equal(scope.trigger, 'refused-by-loop');
  assert.equal(scope.requestedAt, refused.scopeDecision!.requestedAt); assert.equal(scope.resolvedBy, operator.id); assert.equal(scope.resolution, 'The registry is where the table goes');
  assert.ok(scope.waitedMs >= 30); assert.deepEqual(scope.sources.map(source => source.kind), ['scope', 'autoscope', 'requirements']);

  const bypass = one('bypass', bypassed.key);
  assert.match(bypass.blocked, new RegExp(`^guarded merge of ${mergeSha.slice(0, 12)}: .*gate acceptance had not passed`));
  assert.equal(bypass.trigger, 'operator-authorized'); assert.equal(bypass.requestedAt, new Date(mergedAt).toISOString());
  assert.equal(bypass.resolvedBy, operator.id); assert.match(bypass.resolution!, /authorized it outside the guarded path/);
  assert.deepEqual(bypass.sources.map(source => source.kind), ['merge.reconciliation.refused', 'merge.operator-authorized']);

  const escalation = one('escalation', fenced.key);
  assert.equal(escalation.trigger, 'lease-loss'); assert.match(escalation.blocked, /lost lease epoch 1/); assert.ok(['build', 'ready'].includes(escalation.stage!), String(escalation.stage));
  assert.equal(escalation.resolvedBy, operator.id); assert.equal(escalation.resolution, 'The host rebooted; nothing else ran'); assert.ok(escalation.waitedMs >= 30);
  const settlement = one('containment-settlement', fenced.key);
  assert.equal(settlement.blocked, 'containment fence of epoch 1'); assert.equal(settlement.trigger, 'rework'); assert.equal(settlement.resolvedBy, operator.id);
  assert.equal(settlement.requestedAt, escalation.requestedAt, 'the fence became a concern when the lease was lost');
  assert.deepEqual(settlement.sources.map(source => source.kind), ['quarantine', 'rework']);
  assert.equal(one('rework', fenced.key).trigger, 'direct');

  const nudge = one('session-nudge', nudged.key);
  assert.equal(nudge.source, 'recorded'); assert.equal(nudge.requestedAt, since); assert.equal(nudge.stage, 'review');
  assert.ok(nudge.waitedMs >= 15 * 60_000 - 1000 && nudge.waitedMs < 16 * 60_000, String(nudge.waitedMs));
  assert.equal(nudge.resolvedBy, coordinator.id); assert.equal(nudge.resolution, 're-prompted once with its own request');
  assert.equal(nudge.id, recorded.id);

  const human = one('human-only-decision', parked.key);
  assert.equal(human.trigger, 'money-or-accounts'); assert.equal(human.blocked, 'a Railway account for the proof environment'); assert.equal(human.stage, 'build');
  assert.equal(human.requestedAt, request.at); assert.equal(human.resolvedBy, operator.id); assert.equal(human.resolution, 'provided: Use the shared staging account'); assert.ok(human.waitedMs >= 30);
  assert.deepEqual(human.sources.map(source => source.kind), ['human.requested', 'human.answered']);

  // Nothing here is prose read back from a blocker: every signal names its ledger rows, and a
  // scope request the loop approved on its own, or a fence the worker settled itself, is no signal.
  assert.ok(interventions.every(entry => entry.source === 'recorded' || entry.sources.length > 0));
  const own = await claimed('self-settled');
  await engine.execute(worker, 'scope', own.id, { epoch: own.epoch, paths: ['docs/onboarding.md'], reason: 'The guide changes' }, id());
  assert.equal((await engine.execute(coordinator, 'autoscope', own.id, { epoch: own.epoch }, id())).scopeDecision?.state, 'approved');
  assert.deepEqual(ofKind((await report('window=7')).interventions, 'scope-widening', own.key), []);
  // The per-item read, and the roles: a reader may read, a worker may not record, an operator agent is refused.
  assert.deepEqual((await report(`window=7&work=${fenced.key}`, token(reader))).interventions.map(entry => entry.kind).sort(), ['containment-settlement', 'escalation', 'rework']);
  assert.equal((await call(token(worker), 'POST', 'interventions', { kind: 'session-nudge', blocked: 'x', resolution: 'y' })).status, 403);
});

test('integration:intervention-report — over a seeded ledger the report answers what the product is making people do by hand, and where: the rate per delivery, the breakdown by kind and stage, the trend across the window and the items that cost the most attention, through the API, the CLI and the dashboard', async () => {
  const now = Date.now();
  // Four deliveries inside the 7-day window, one older; interventions seeded with their own instants.
  const shipped = await Promise.all([hoursAgo(20, now), hoursAgo(50, now), hoursAgo(100, now), hoursAgo(140, now)].map(at => delivered('shipped', at)));
  await delivered('older-delivery', hoursAgo(25 * 24, now));
  const costly = await created('costly'), other = await created('other');
  const seed = (work: Work | null, kind: InterventionKind, stage: string, blocked: string, since: string, at: string, resolution = 'settled by hand') => {
    const recorded = { id: randomUUID(), kind, work: work ? { id: work.id, key: work.key, title: work.title } : null, stage, blocked, since, at, resolution, recordedBy: operator.id };
    return store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work?.id ?? null, operator.id, 'intervention.recorded', JSON.stringify(recorded)]);
  };
  await seed(costly, 'rework', 'review', 'candidate a (PR #1)', hoursAgo(30, now), hoursAgo(28, now));
  await seed(costly, 'rework', 'review', 'candidate b (PR #1)', hoursAgo(10, now), hoursAgo(9, now));
  await seed(other, 'rework', 'review', 'candidate c (PR #2)', hoursAgo(60, now), hoursAgo(59.5, now));
  await seed(costly, 'scope-widening', 'build', 'files outside plannedFiles: docs/x.md', hoursAgo(80, now), hoursAgo(79, now));
  await seed(other, 'scope-widening', 'build', 'files outside plannedFiles: src/y.ts', hoursAgo(120, now), hoursAgo(119.9, now));
  await seed(null, 'session-nudge', 'review', 'approver session showed no activity', hoursAgo(5.5, now), hoursAgo(5, now));
  await seed(other, 'human-only-decision', 'build', 'a provider account', hoursAgo(12 * 24, now), hoursAgo(11 * 24, now));
  const week = await report('window=7');
  const seeded = week.interventions.filter(entry => entry.source === 'recorded' && ([costly.key, other.key].includes(entry.work?.key ?? '') || (!entry.work && entry.blocked === 'approver session showed no activity')));
  assert.equal(seeded.length, 6, 'the six signals inside the window; the 11-day-old one is outside it');
  assert.ok(week.deliveries >= 4 && week.total >= 6);
  assert.equal(week.ratePerDelivery, Number((week.total / week.deliveries).toFixed(2)));
  const kind = (name: InterventionKind) => week.byKind.find(entry => entry.kind === name)!;
  assert.ok(kind('rework').count >= 3 && kind('scope-widening').count >= 2 && kind('session-nudge').count >= 1);
  assert.ok(week.byStage.find(entry => entry.stage === 'review')!.count >= 4 && week.byStage.find(entry => entry.stage === 'build')!.count >= 2);
  const pair = week.byKindAndStage.find(entry => entry.kind === 'rework' && entry.stage === 'review')!;
  assert.ok(pair.count >= 3 && pair.waitedMs >= 3.5 * 3_600_000, JSON.stringify(pair));
  // The trend: one bucket per day, oldest first, every bucket inside the window, and the sums add up.
  assert.equal(week.trend.length, 7);
  assert.ok(week.trend.every((bucket, index) => index === 0 || bucket.from >= week.trend[index - 1].to));
  assert.equal(week.trend.reduce((total, bucket) => total + bucket.interventions, 0), week.interventions.filter(entry => entry.requestedAt >= week.window.from).length);
  assert.equal(week.trend.reduce((total, bucket) => total + bucket.deliveries, 0), week.deliveries);
  // The items that cost the most attention: the costly item first, with its kinds and its wait.
  const top = week.costliest.find(entry => entry.key === costly.key)!;
  assert.deepEqual({ count: top.count, kinds: top.kinds, waitedMs: top.waitedMs }, { count: 3, kinds: { rework: 2, 'scope-widening': 1 }, waitedMs: 4 * 3_600_000 });
  assert.ok(week.costliest.indexOf(top) < week.costliest.findIndex(entry => entry.key === other.key), 'ordered by attention');
  assert.equal(week.window.days, 7); assert.deepEqual(week.policy, { threshold: 3, windowDays: 7 });
  // A wider window admits the older signal and the older delivery; a kind filter narrows.
  const month = await report('window=30');
  assert.ok(month.total >= week.total + 1 && month.deliveries >= week.deliveries + 1);
  assert.ok(month.trend.length === 5 && month.trend.every(bucket => Date.parse(bucket.to) - Date.parse(bucket.from) === 7 * 86_400_000));
  assert.ok((await report('window=7&kind=rework')).interventions.every(entry => entry.kind === 'rework'));
  assert.equal((await call(token(coordinator), 'GET', 'interventions?window=12')).status, 400);

  // The CLI: master status carries the same reading, with its rate and costliest items.
  const summary = (await interventionSummary(async (path: string) => ok(token(coordinator), 'GET', path))).summary as { ratePerDelivery: number; costliest: { key: string }[]; byKind: { kind: string }[]; error: null };
  assert.equal(summary.error, null); assert.equal(summary.ratePerDelivery, week.ratePerDelivery);
  assert.equal(summary.costliest[0].key, top.key);
  assert.ok(summary.byKind.some(entry => entry.kind === 'rework'));

  // The dashboard: the page is registered beside Shipped and renders the report.
  const view = views.find(entry => entry.id === 'interventions')!;
  assert.equal(view.section, 'shipped');
  const dashboard = { api: async () => week, status: { actor: operator }, busy: false, setBusy() {}, setError() {}, setSelected() {}, work: await store.list(), initialReport: week } as unknown as Dashboard;
  const markup = renderToStaticMarkup(createElement(InterventionsPage, dashboard));
  for (const needle of ['Per delivery', `<strong>${week.ratePerDelivery}</strong>`, top.key, 'rework decision', 'scope widening', 'Record judgement', 'Items that cost the most attention'].concat(['By kind and stage', 'Costliest items', 'Patterns', 'Judgement about delivered work', 'Recent interventions', 'Intervention metrics'].map(section => `aria-label="${section}"`)))
    assert.ok(markup.includes(needle), needle);
});

test('integration:recurring-intervention-becomes-work — when one kind of intervention at one stage crosses the configured threshold in the window, Graphyard opens a work item naming the pattern, its frequency, the items it affected and the attention it cost, linking the instances; once, and not again while it is open', async () => {
  const policy = interventionPolicyFromEnv({ GRAPHYARD_INTERVENTION_PATTERN_THRESHOLD: '3', GRAPHYARD_INTERVENTION_PATTERN_WINDOW_DAYS: '7' });
  assert.deepEqual(policy, { threshold: 3, windowDays: 7 });
  const stage = 'acceptance';
  const affected = await Promise.all(['pattern-a', 'pattern-b', 'pattern-c'].map(title => created(title)));
  const nudge = (work: Work, minutes: number) => ok(token(coordinator), 'POST', 'interventions', { kind: 'session-nudge', work: work.key, stage, blocked: `producer session for ${work.key} showed no activity`, since: hoursAgo(minutes / 60), resolution: 're-prompted once' });
  // Patterns the earlier tests left over the threshold (reworks at review, widenings at build) open their items first.
  const flushed = (await openPatternItems(engine, policy)).opened;
  assert.ok(flushed.every(work => work.origin?.pattern?.kind !== 'session-nudge'), flushed.map(work => work.title).join('; '));
  const before = (await store.list()).length;
  await nudge(affected[0], 20); await nudge(affected[1], 10);
  assert.deepEqual((await ok(token(coordinator), 'POST', 'interventions/patterns')).opened, [], 'two is under the threshold');
  const third = await nudge(affected[2], 30);
  const crossed = (await report('window=7')).patterns.find(entry => entry.kind === 'session-nudge' && entry.stage === stage)!;
  assert.deepEqual({ count: crossed.count, crossed: crossed.crossed, work: crossed.work }, { count: 3, crossed: true, work: null }, 'the report shows the threshold crossed before the item exists');

  // The server's own detection (the tick runs openPatternItems every minute) opens exactly one item.
  const opened = (await openPatternItems(engine, policy)).opened;
  assert.equal(opened.length, 1);
  const item = await reload(opened[0].id);
  assert.equal(item.title, 'Recurring session nudge interventions at the acceptance stage: 3 in 7 days');
  assert.equal(item.type, 'bug'); assert.equal(item.stage, 'backlog');
  const origin = item.origin!.pattern!;
  assert.deepEqual({ kind: origin.kind, stage: origin.stage, threshold: origin.threshold, count: origin.count, days: origin.window.days, items: [...origin.items].sort() },
    { kind: 'session-nudge', stage, threshold: 3, count: 3, days: 7, items: affected.map(work => work.key).sort() });
  assert.ok(Math.abs(origin.waitedMs - 60 * 60_000) < 5000, `the attention the instances cost, 20 + 10 + 30 minutes: ${origin.waitedMs}`);
  assert.deepEqual(origin.instances.map(instance => instance.id).sort(), [...(await report('window=7')).interventions.filter(entry => entry.kind === 'session-nudge' && entry.stage === stage).map(entry => entry.id)].sort(), 'the instances are linked by their ids');
  assert.ok(origin.instances.every(instance => instance.sources.length === 1 && instance.sources[0].kind === 'intervention.recorded'), 'each instance names its ledger row');
  assert.ok(origin.instances.some(instance => instance.id === third.id && instance.work === affected[2].key));
  for (const needle of ['3 session nudge interventions were needed at the acceptance stage', 'Frequency: 3 in 7 days', 'Attention cost: 60 min waited in total, 20 min per intervention', `Items affected: ${origin.items.join(', ')}`, `- ${third.id}: ${affected[2].key}`])
    assert.ok(item.description.includes(needle), needle);
  assert.equal((await store.list()).length, before + 1);
  assert.equal((await store.pool.query("SELECT actor FROM events WHERE work_id=$1 AND kind='create'", [item.id])).rows[0].actor, 'graphyard', 'the control plane opened it');
  // The report now names the item for the pattern, and master status raises nothing for it.
  const named = (await report('window=7')).patterns.find(entry => entry.kind === 'session-nudge' && entry.stage === stage)!;
  assert.equal(named.work?.key, item.key);
  assert.deepEqual((await interventionSummary(async (path: string) => ok(token(coordinator), 'GET', path))).attentionItems, []);

  // Not again while it is open: the route, the function and a fourth instance all leave it at one.
  assert.deepEqual((await ok(token(coordinator), 'POST', 'interventions/patterns')).opened, []);
  await nudge(affected[0], 5);
  assert.deepEqual((await openPatternItems(engine, policy)).opened, []);
  assert.equal((await store.list()).filter(work => work.origin?.pattern?.kind === 'session-nudge').length, 1);
  // Once the item is delivered, the instances it linked never count again: only new ones open the next.
  await store.pool.query(`UPDATE work_items SET document=document || '{"stage":"done"}' WHERE id=$1`, [item.id]);
  assert.deepEqual((await openPatternItems(engine, policy)).opened, [], 'one unlinked instance is under the threshold');
  await nudge(affected[1], 5); await nudge(affected[2], 5);
  const again = (await openPatternItems(engine, policy)).opened;
  assert.equal(again.length, 1); assert.equal(again[0].origin!.pattern!.count, 3);
  assert.ok(again[0].origin!.pattern!.instances.every(instance => !origin.instances.some(linked => linked.id === instance.id)), 'no instance is linked twice');
  assert.equal((await ok(token(reader), 'GET', `work`)).length, before + 2);
  assert.equal((await call(token(worker), 'POST', 'interventions/patterns')).status, 403);
});

test('integration:operator-judgement-as-input — the operator records judgement about delivered work against the item or the page it concerns; it appears in the report as first-class input and becomes a work item with the same standing as a failed gate', async () => {
  const shipped = await delivered('judged', hoursAgo(2));
  const aboutItem = await ok(token(operator), 'POST', 'judgements', { work: shipped.key, verdict: 'confusing', text: 'The dashboard shows the merge queue position before the item is even reviewed' });
  const aboutPage = await ok(token(coordinator), 'POST', 'judgements', { page: 'docs/dashboard.md', verdict: 'not-good-enough', text: 'The page never says what a proof is' });
  assert.deepEqual({ verdict: aboutItem.verdict, work: aboutItem.work.key, page: aboutItem.page, by: aboutItem.by, item: aboutItem.item }, { verdict: 'confusing', work: shipped.key, page: null, by: operator.id, item: null });
  assert.equal(aboutPage.page, 'docs/dashboard.md'); assert.equal(aboutPage.work, null);
  assert.equal((await call(token(operator), 'POST', 'judgements', { verdict: 'confusing', text: 'about nothing' })).status, 400, 'a judgement names the item or the page');
  assert.equal((await call(token(reader), 'POST', 'judgements', { page: 'x', verdict: 'confusing', text: 'y' })).status, 403);
  assert.equal((await call(token(operator), 'POST', 'judgements', { work: 'GY-999999', verdict: 'confusing', text: 'y' })).status, 404);
  // In the report, beside the interventions, newest first.
  const listed = (await report('window=7')).judgements;
  assert.deepEqual(listed.slice(0, 2).map(judgement => judgement.id), [aboutPage.id, aboutItem.id]);
  assert.equal(listed.find(judgement => judgement.id === aboutItem.id)!.work!.title, shipped.title);
  assert.deepEqual((await report(`window=7&work=${shipped.key}`)).judgements.map(judgement => judgement.id), [aboutItem.id]);
  // Turned into an item: its own words, the judgement as its origin, one item per judgement.
  const item: Work = await ok(token(operator), 'POST', `judgements/${aboutItem.id}/work`, {});
  assert.equal(item.stage, 'backlog'); assert.equal(item.type, 'bug'); assert.equal(item.priority, 1);
  assert.equal(item.title, `${shipped.key} (${shipped.title}) is confusing: The dashboard shows the merge queue position before the item is even reviewed`);
  assert.match(item.description, /same standing as a failed gate/);
  assert.deepEqual(item.origin!.judgement, { id: aboutItem.id, verdict: 'confusing', work: shipped.key, page: null, by: operator.id, at: aboutItem.at });
  assert.deepEqual(item.criteria.map(criterion => criterion.proofs), [[`manual:judgement-${aboutItem.id.slice(0, 8)}-review`]]);
  assert.equal((await ok(token(operator), 'POST', `judgements/${aboutItem.id}/work`, {})).id, item.id, 'one item per judgement');
  const shaped: Work = await ok(token(operator), 'POST', `judgements/${aboutPage.id}/work`, { title: 'Explain proofs on the dashboard page', plannedFiles: ['docs/dashboard.md'], criteria: [{ id: 'AC-1', text: 'docs/dashboard.md defines a proof where it first uses the word', proofs: ['manual:docs-review'] }] });
  assert.deepEqual({ title: shaped.title, plannedFiles: shaped.plannedFiles, proofs: shaped.criteria[0].proofs }, { title: 'Explain proofs on the dashboard page', plannedFiles: ['docs/dashboard.md'], proofs: ['manual:docs-review'] });
  assert.equal((await call(token(coordinator), 'POST', `judgements/${aboutPage.id}/work`, {})).status, 403, 'creating work is operator intent');
  assert.equal((await call(token(operator), 'POST', `judgements/${randomUUID()}/work`, {})).status, 404);
  // The report links each judgement to the item it became, and the item is ordinary backlog the loop releases and dispatches.
  const linked = (await report('window=7')).judgements;
  assert.equal(linked.find(judgement => judgement.id === aboutItem.id)!.item!.key, item.key);
  assert.equal(linked.find(judgement => judgement.id === aboutPage.id)!.item!.key, shaped.key);
  assert.equal((await engine.execute(operator, 'ready', item.id, {}, id())).ready, true);
  // The dashboard offers the form to an operator and the item link once it exists; a reader sees neither.
  const page = (actor: Principal, data: unknown) => renderToStaticMarkup(createElement(InterventionsPage, { api: async () => data, status: { actor }, busy: false, setBusy() {}, setError() {}, setSelected() {}, work: [], initialReport: data } as unknown as Dashboard));
  const rendered = page(operator, await report('window=7'));
  assert.match(rendered, /Record judgement/); assert.ok(rendered.includes(item.key) && rendered.includes('is confusing'), 'the judgement and the item it became');
  const readerView = page(reader, await report('window=7'));
  assert.doesNotMatch(readerView, /Record judgement/); assert.doesNotMatch(readerView, /Turn into an item/);
});

test('unit:intervention-fold-reads-only-typed-rows — the fold reads the ledger kinds it names and nothing else, keeps ids stable across readings, and reports an open signal until its item no longer waits', async () => {
  const { rows, truncated } = await readInterventionLedger(store.pool, { limit: 5 });
  assert.equal(rows.length, 5); assert.equal(truncated, true);
  assert.ok(rows.every((row, index) => index === 0 || row.seq > rows[index - 1].seq), 'ledger order');
  const all = await readInterventionLedger(store.pool);
  const work = await store.list();
  const first = foldInterventions(all.rows, work, await dbNow()), second = foldInterventions(all.rows, work, await dbNow());
  assert.deepEqual(first.interventions.map(entry => entry.id), second.interventions.map(entry => entry.id));
  assert.equal(new Set(first.interventions.map(entry => entry.id)).size, first.interventions.length, 'ids are unique');
  // An open signal: a parked item still waiting on its human.
  const waiting = await claimed('waiting');
  await ok(token(worker), 'POST', `work/${waiting.key}/park`, { epoch: waiting.epoch, kind: 'credentials-for-people', needed: 'a GitHub seat for the reviewer', reason: 'The reviewer identity is a person' });
  const open = ofKind((await report('window=7')).interventions, 'human-only-decision', waiting.key)[0];
  assert.deepEqual({ resolvedAt: open.resolvedAt, resolvedBy: open.resolvedBy, trigger: open.trigger }, { resolvedAt: null, resolvedBy: null, trigger: 'credentials-for-people' });
  assert.ok(open.waitedMs >= 0 && open.waitedMs < 60_000);
  assert.ok((await report('window=7')).open >= 1);
});
