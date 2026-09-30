import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Principal, Work } from '../src/model.js';
import type { Intervention, InterventionPolicy } from '../src/model/interventions.js';
import { cataloguedCause, detectRecurringCauses, draftPrevention, retroCause, retroStanding, type RetroArtefact } from '../src/model/retro-synthesis.js';
import { judgeRetroArtefact, readRetroArtefacts, synthesizeRetro } from '../src/retro-synthesis.js';
import { withRetroStanding } from '../src/cli/work.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-970: repeated refusal and rework causes are drafted into prevention artefacts for independent
// approval, and an approved artefact applies through its governed registry, recording what it closes.
const repository = 'owner/retro';
const operator: Principal = { id: 'retro-operator', role: 'admin', sessionKind: 'human' };
const approver: Principal = { id: 'retro-approver', role: 'admin', sessionKind: 'ai' };
const coordinator: Principal = { id: 'retro-master', role: 'coordinator', sessionKind: 'ai' };
const worker: Principal = { id: 'retro-worker', role: 'worker', sessionKind: 'ai' };
const credentials = [operator, approver, coordinator, worker].map(principal => ({ ...principal, token: `retro-${principal.id}-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(credential => credential.id === principal.id)!.token;
const policy: InterventionPolicy = { threshold: 3, windowDays: 7 };
let database: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_RETRO_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 970);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('retro'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('retro_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/retro_test`); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  http = server(engine, credentials, null, undefined, { env: { ...process.env, GRAPHYARD_INTERVENTION_PATTERN_THRESHOLD: '3', GRAPHYARD_INTERVENTION_PATTERN_WINDOW_DAYS: '7' } });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

const call = async (principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) => {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as any };
};
const workCount = async () => Number((await store.pool.query('SELECT count(*) FROM work_items')).rows[0].count);

/** A claimed item its operator sends back for `reason`: one rework intervention in the ledger. */
async function reworked(reason: string) {
  const n = ++serial;
  let work: Work = await engine.execute(operator, 'create', null, { title: `retro item ${n}`, plannedFiles: [`src/retro-${n}.ts`], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:behaves'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  await engine.execute(operator, 'rework', work.id, { reason, previousWorkerStopped: true }, randomUUID());
  return work;
}
const outOfScope = (n: number) => `Candidate changes ${n} files outside its planned files that must match the base branch byte-for-byte; run graphyard sync GY-${40 + n}, restore each file from origin/<base>, and push again`;

const at = (hoursAgo: number) => new Date(Date.parse('2026-09-30T12:00:00.000Z') - hoursAgo * 3_600_000).toISOString();
const signal = (id: string, fields: Partial<Intervention>): Intervention => ({ id, kind: 'rework', source: 'ledger', work: { id, key: `GY-${id}`, title: '' }, stage: 'build', blocked: 'candidate aaaaaaaaaaaa (PR #1)',
  requestedAt: at(1), resolvedAt: at(0.5), waitedMs: 1_800_000, resolvedBy: 'master', resolution: null, sources: [{ seq: 1, kind: 'rework' }], ...fields });
const now = at(0);

test('unit:retro-synthesis-drafts-prevention — refusal and rework causes group by cause, and a cause below the threshold drafts nothing', () => {
  // The same declared refusal, worded for different items, is one cause.
  assert.equal(retroCause(signal('1', { resolution: outOfScope(2) }))?.cause, 'build/out-of-scope-count');
  assert.equal(retroCause(signal('2', { resolution: outOfScope(5) }))?.cause, 'build/out-of-scope-count');
  // A reviewer's recurring reason matches no declared shape: its wording, minus heads and keys, is the cause.
  const first = retroCause(signal('3', { resolution: 'Reviewer: GY-12 at 0123456789ab swallows the error from readConfig' }))!;
  const second = retroCause(signal('4', { resolution: 'Reviewer: GY-99 at fedcba987654 swallows the error from readConfig' }))!;
  assert.equal(first.family, 'rework'); assert.equal(first.cause, second.cause); assert.match(first.cause, /^reason\//);
  // A scope refusal the loop recorded is a refusal cause; an intervention that is neither is not read.
  assert.equal(retroCause(signal('5', { kind: 'scope-widening', resolution: 'widened', trigger: 'refused-by-loop' }))?.cause, 'trigger/refused-by-loop');
  assert.equal(retroCause(signal('6', { kind: 'session-nudge', resolution: 're-prompted a quiet reviewer' })), null);
  assert.equal(retroCause(signal('7', { resolution: 'rework authorized' })), null);

  const two = [signal('a', { resolution: outOfScope(1) }), signal('b', { resolution: outOfScope(2) })];
  assert.deepEqual(detectRecurringCauses(two, [], policy, now), []);
  // Outside the window an instance never counts.
  assert.deepEqual(detectRecurringCauses([...two, signal('c', { resolution: outOfScope(3), requestedAt: at(24 * 8) })], [], policy, now), []);
});

test('unit:retro-synthesis-drafts-prevention — a cause past the threshold drafts the artefacts that would prevent it: criteria wording, a mechanical check, a producer-method correction, a fault-catalogue entry', () => {
  const scope = detectRecurringCauses([1, 2, 3].map(n => signal(`s${n}`, { resolution: outOfScope(n) })), [], policy, now);
  assert.equal(scope.length, 1);
  assert.equal(scope[0].count, 3); assert.equal(scope[0].threshold, 3); assert.deepEqual(scope[0].instances.map(instance => instance.id), ['s1', 's2', 's3']);
  const scopeDrafts = draftPrevention(scope[0]);
  assert.deepEqual(scopeDrafts.map(draft => [draft.kind, draft.target]), [['standards-update', 'criteria-wording'], ['mechanical-check', 'checks'], ['fault-catalogue-entry', 'fault-catalogue']]);
  assert.equal(scopeDrafts[1].check?.id, 'retro-build-out-of-scope-count');
  assert.equal(scopeDrafts[2].entry?.faultClass, 'scope'); assert.equal(scopeDrafts[2].entry?.cause, 'build/out-of-scope-count');
  for (const draft of scopeDrafts) assert.match(draft.proposal, /3 instances of .* in 7 days \(threshold 3\): GY-s1 \(s1\)/);

  // A recurring acceptance refusal corrects the producers' method.
  const proof = detectRecurringCauses([1, 2, 3].map(n => signal(`p${n}`, { kind: 'escalation', resolution: `Trusted integration:example evidence from agent-${n} is no longer independent: agent-${n} has since held an assignment on GY-${n}` })), [], policy, now);
  assert.deepEqual(draftPrevention(proof[0]).map(draft => draft.kind), ['producer-method', 'fault-catalogue-entry']);
  assert.equal(draftPrevention(proof[0])[1].entry?.faultClass, 'proof');

  // A recurring review finding becomes a coding-standards update quoting it.
  const review = detectRecurringCauses([1, 2, 3].map(n => signal(`r${n}`, { resolution: `Reviewer on GY-${n}: the new route skips the operator-agent guard` })), [], policy, now);
  const standard = draftPrevention(review[0])[0];
  assert.equal(standard.kind, 'standards-update'); assert.equal(standard.target, 'coding-standards');
  assert.match(standard.proposal, /the new route skips the operator-agent guard/);
});

test('unit:retro-synthesis-drafts-prevention — synthesis records its drafts in the ledger for independent approval, applies nothing and files no work item', async () => {
  for (const n of [1, 2, 3]) await reworked(outOfScope(n));
  const before = await workCount();
  // The server's route runs the same synthesis; only a coordinator or an admin may run it.
  assert.equal((await call(worker, 'POST', 'retro/synthesize')).status, 403);
  const run = await call(coordinator, 'POST', 'retro/synthesize');
  assert.equal(run.status, 200, run.text);
  const drafted: RetroArtefact[] = run.body.drafted;
  assert.deepEqual(drafted.map(artefact => artefact.kind), ['standards-update', 'mechanical-check', 'fault-catalogue-entry']);
  assert.ok(drafted.every(artefact => artefact.state === 'drafted' && artefact.approval === null && artefact.application === null && artefact.pattern.cause === 'build/out-of-scope-count' && artefact.pattern.count === 3));
  // Never filed as dispatchable work, and nothing applied: every registry still stands at revision 0.
  assert.equal(await workCount(), before);
  assert.equal((await store.pool.query("SELECT count(*) FROM events WHERE kind='create' AND created_at > now() - interval '1 minute' AND actor='graphyard'")).rows[0].count, '0');
  const report = await call(coordinator, 'GET', 'retro');
  assert.equal(report.body.drafted, 3);
  assert.deepEqual(report.body.standing.map((registry: any) => [registry.registry, registry.revision]), [['requirements', 0], ['checks', 0], ['catalogue', 0]]);
  // A draft waiting for its judgement is not drafted again, however often the synthesis runs.
  assert.deepEqual((await synthesizeRetro(store, policy)).drafted, []);
});

test('unit:retro-artefact-governed-application — an independent approval applies the artefact at its registry\'s next revision and records the pattern it closes', async () => {
  const [standards, check, entry] = (await readRetroArtefacts(store.pool)).filter(artefact => artefact.pattern.cause === 'build/out-of-scope-count');
  // Neither the synthesis' own identity nor a coordinator or a worker judges a draft.
  const self = await judgeRetroArtefact(store, { id: 'graphyard', role: 'admin', sessionKind: 'ai' }, repository, standards.id, 'approve', 'mine').then(() => null, error => error);
  assert.match(String(self?.message), /Self-approval refused/);
  assert.equal((await call(coordinator, 'POST', `retro/${standards.id}/approve`, { reason: 'fine' })).status, 403);
  assert.equal((await call(worker, 'POST', `retro/${standards.id}/approve`, { reason: 'fine' })).status, 403);

  const applied = await call(approver, 'POST', `retro/${standards.id}/approve`, { reason: 'The out-of-scope refusal keeps recurring; the wording closes it' });
  assert.equal(applied.status, 200, applied.text);
  assert.equal(applied.body.state, 'applied');
  assert.deepEqual(applied.body.application, { registry: 'requirements', revision: 1, path: 'requirements revision' });
  assert.deepEqual(applied.body.approval.closes, { cause: 'build/out-of-scope-count', fingerprint: standards.pattern.fingerprint, instances: standards.pattern.instances.map(instance => instance.id) });
  assert.equal(applied.body.approval.by, approver.id);
  // The check is registered and the catalogue updated the same way, each in its own registry.
  assert.deepEqual((await judgeRetroArtefact(store, approver, repository, check.id, 'approve', 'register it')).application, { registry: 'checks', revision: 1, path: 'check registration' });
  assert.deepEqual((await judgeRetroArtefact(store, approver, repository, entry.id, 'approve', 'catalogue it')).application, { registry: 'catalogue', revision: 1, path: 'catalogue update' });
  // A judged artefact is never judged again.
  assert.equal((await call(approver, 'POST', `retro/${standards.id}/approve`, { reason: 'again' })).status, 409);

  const artefacts = await readRetroArtefacts(store.pool);
  assert.deepEqual(retroStanding(artefacts).map(registry => [registry.registry, registry.revision, registry.entries.length]), [['requirements', 1, 1], ['checks', 1, 1], ['catalogue', 1, 1]]);
  assert.equal(cataloguedCause('build/out-of-scope-count', artefacts)?.id, entry.id);
  // In force: the session reading its item reads the applied requirements and checks beside it.
  const shown = await withRetroStanding({ key: 'GY-1' }, async path => (await call(worker, 'GET', path)).body);
  assert.deepEqual(shown.retroStanding.map((registry: any) => [registry.registry, registry.revision, registry.entries.map((item: any) => item.id)]), [['requirements', 1, [standards.id]], ['checks', 1, [check.id]], ['catalogue', 1, [entry.id]]]);
  assert.deepEqual(await withRetroStanding({ key: 'GY-1' }, async () => { throw new Error('404'); }), { key: 'GY-1' });
});

test('unit:retro-artefact-governed-application — a closed pattern is never delivered twice: its instances never draft again, a refusal closes them too, and a recurrence after application names the artefact that did not hold', async () => {
  // The instances the applied artefacts closed stay closed.
  assert.deepEqual((await synthesizeRetro(store, policy)).drafted, []);

  // A new cause is drafted, refused, and its instances closed by the refusal.
  for (const n of [1, 2, 3]) await reworked(`Reviewer on GY-${n}: the migration drops the index the dashboard reads`);
  const drafted = (await synthesizeRetro(store, policy)).drafted;
  assert.deepEqual(drafted.map(artefact => artefact.kind), ['standards-update', 'fault-catalogue-entry']);
  for (const artefact of drafted) assert.equal((await judgeRetroArtefact(store, approver, repository, artefact.id, 'refuse', 'Not a standards matter')).state, 'refused');
  assert.deepEqual((await synthesizeRetro(store, policy)).drafted, []);
  assert.equal(retroStanding(await readRetroArtefacts(store.pool)).find(registry => registry.registry === 'requirements')!.revision, 1);

  // The applied cause recurs past the threshold with new instances: one new draft set, naming what did not hold.
  const applied = (await readRetroArtefacts(store.pool)).filter(artefact => artefact.state === 'applied').map(artefact => artefact.id).sort();
  for (const n of [4, 5, 6]) await reworked(outOfScope(n));
  const again = (await synthesizeRetro(store, policy)).drafted;
  assert.equal(again.length, 3);
  assert.equal(again[0].pattern.count, 3);
  assert.deepEqual([...again[0].pattern.recurredAfter].sort(), applied);
  assert.match(again[0].proposal, /recurred after .* was applied, so the earlier prevention did not hold/);
  const approved = await judgeRetroArtefact(store, approver, repository, again[0].id, 'approve', 'Tighten the wording');
  assert.equal(approved.application?.revision, 2);
});
