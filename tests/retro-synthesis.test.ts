import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { Store } from '../src/store.js';
import type { Observation, Principal, Work } from '../src/model.js';
import type { Intervention, InterventionPolicy } from '../src/model/interventions.js';
import { cataloguedCause, classifyGateRefusals, detectRecurringCauses, draftPrevention, retroApprovalConflict, retroCause, retroCheckRefusals, retroStanding, runRetroCheck, type RetroArtefact } from '../src/model/retro-synthesis.js';
import { ensureRetroIndex, judgeRetroArtefact, readAppliedRetroChecks, readRetroArtefacts, retroLedgerLimit, retroReads, synthesizeRetro } from '../src/retro-synthesis.js';
import { withRetroStanding } from '../src/cli/work.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { advisoryLocks } from '../src/store/locks.js';
import { events } from '../src/store/tables/work.js';

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
  assert.match(scopeDrafts[1].check!.id, /^retro-build-out-of-scope-count-[0-9a-f]{8}$/); assert.equal(scopeDrafts[1].check?.rule, 'planned-files');
  // A redraft of the same cause from other instances registers a distinct check.
  const later = detectRecurringCauses([4, 5, 6].map(n => signal(`s${n}`, { resolution: outOfScope(n) })), [], policy, now);
  assert.notEqual(draftPrevention(later[0])[1].check!.id, scopeDrafts[1].check!.id);
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

test('unit:retro-artefact-governed-application — retro checks judge the item\'s own candidate with the scope and documentation matchers the gates use, and only agent sessions judge drafts', async () => {
  const work = { plannedFiles: ['src/area/**', 'src/one.ts'], documentation: { paths: ['packages/*/README.md'] }, policy: { checks: ['test', 'typecheck'] } };
  const file = (path: string, fields: Record<string, unknown> = {}) => ({ path, status: 'modified' as const, sha: 'c'.repeat(40), baseSha: 'd'.repeat(40), additions: 1, deletions: 1, binary: false, ...fields });
  const observed = (scopeFiles: ReturnType<typeof file>[], extra: Partial<Observation> = {}) => ({ files: scopeFiles.map(entry => entry.path), checks: [], conflicting: false, scopeFiles, ...extra });
  // A planned directory scope, a documentation glob and a new file sync accepts all pass; a rewrite outside them is named.
  assert.equal(runRetroCheck('planned-files', work, observed([file('src/area/deep/a.ts'), file('src/one.ts'), file('packages/web/README.md'), file('src/new.ts', { status: 'added', baseSha: null })])), null);
  assert.match(String(runRetroCheck('planned-files', work, observed([file('src/area/a.ts'), file('src/other.ts')]))), /1 file\(s\) outside plannedFiles: src\/other\.ts$/);
  // Without scopeFiles, the changed paths are judged with the same matchers.
  assert.equal(runRetroCheck('planned-files', work, { files: ['src/area/x/y.ts', 'packages/api/README.md'], checks: [], conflicting: false }), null);
  assert.match(String(runRetroCheck('planned-files', work, { files: ['packages/api/src/index.ts'], checks: [], conflicting: false })), /packages\/api\/src\/index\.ts/);
  // Only a check the item's policy requires that failed on its head refuses; one still running or not required does not.
  assert.equal(runRetroCheck('checks-passed', work, observed([], { checks: [{ name: 'lint', result: 'failure', appId: 1 }, { name: 'test', result: 'pending', appId: 1 }] })), null);
  assert.match(String(runRetroCheck('checks-passed', work, observed([], { checks: [{ name: 'typecheck', result: 'failure', appId: 1 }] }))), /failed required checks on its head: typecheck/);
  // An item requiring no checks — an empty list or none at all — is never refused by a failed check it does not require.
  const failedLint = observed([], { checks: [{ name: 'lint', result: 'failure', appId: 1 }] });
  assert.equal(runRetroCheck('checks-passed', { ...work, policy: { checks: [] } }, failedLint), null);
  assert.equal(runRetroCheck('checks-passed', { ...work, policy: null }, failedLint), null);
  assert.equal(runRetroCheck('checks-passed', { plannedFiles: work.plannedFiles }, failedLint), null);

  // A principal declaring no session kind fails closed; an operator agent is an agent identity.
  const draft = { id: 'draft-1', draftedBy: 'drafter' };
  assert.match(String(retroApprovalConflict(draft, { id: 'legacy', role: 'admin' })), /declares no AI session/);
  assert.match(String(retroApprovalConflict(draft, { id: 'person', role: 'admin', sessionKind: 'human' })), /human session/);
  assert.equal(retroApprovalConflict(draft, { id: 'agent', role: 'admin', sessionKind: 'ai' }), null);
  assert.equal(retroApprovalConflict(draft, { id: 'operator-agent', role: 'operator-agent' }), null);

  // A declared cause outside the specialised branches still drafts its prevention once catalogued, so its recurrence is recorded.
  const ready = detectRecurringCauses([1, 2, 3].map(n => signal(`d${n}`, { kind: 'escalation', resolution: `Dependency GY-${n} is unfinished` })), [], policy, now)[0];
  assert.equal(ready.cause, 'ready/dependency');
  assert.deepEqual(draftPrevention(ready).map(entry => [entry.kind, entry.target]), [['standards-update', 'criteria-wording'], ['fault-catalogue-entry', 'fault-catalogue']]);
  const catalogued = { ...ready, catalogued: { cause: ready.cause, entry: 'retro-ready-dependency', artefact: 'a', faultClass: 'decision' as const, meaning: 'm' } };
  assert.deepEqual(draftPrevention(catalogued).map(entry => entry.kind), ['standards-update']);

  // Only a server without the route reads as no registries: a message that merely mentions 404 is an error.
  await assert.rejects(withRetroStanding({ key: 'GY-1' }, async () => { throw Object.assign(new Error('{"error":"GY-404 is locked"}'), { status: 500 }); }), /GY-404 is locked/);
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
  // The route drafted under the identity that asked for the synthesis.
  assert.equal(standards.draftedBy, coordinator.id);
  // Neither the drafting identity, a human session, an identity that recorded the instances, a coordinator nor a worker judges a draft.
  const refused = (principal: Principal) => judgeRetroArtefact(store, principal, repository, standards.id, 'approve', 'mine').then(() => null, error => error);
  assert.match(String((await refused({ id: coordinator.id, role: 'admin', sessionKind: 'ai' }))?.message), /Self-approval refused/);
  const human = await call(operator, 'POST', `retro/${standards.id}/approve`, { reason: 'fine' });
  assert.equal(human.status, 403); assert.match(human.text, /human session/);
  assert.match(String((await refused({ id: operator.id, role: 'admin', sessionKind: 'ai' }))?.message), /recorded instances of the pattern/);
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
  assert.deepEqual(await withRetroStanding({ key: 'GY-1' }, async () => { throw Object.assign(new Error('{"error":"Not found"}'), { status: 404 }); }), { key: 'GY-1' });
  // Any other failure to read the registries in force is an error, not an item without them.
  await assert.rejects(withRetroStanding({ key: 'GY-1' }, async () => { throw Object.assign(new Error('{"error":"timeout"}'), { status: 500 }); }), /timeout/);
});

/** A claimed item with its workspace registered, and the observation of a candidate changing `files` on its branch. */
async function claimedWithCandidate(plannedFiles: string[]) {
  const n = ++serial;
  let work: Work = await engine.execute(operator, 'create', null, { title: `retro submit ${n}`, plannedFiles, criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:behaves'] }] }, randomUUID());
  work = await engine.execute(operator, 'ready', work.id, {}, randomUUID());
  work = await engine.execute(worker, 'claim', work.id, {}, randomUUID());
  const branch = `graphyard/${work.key.toLowerCase()}-1`;
  work = await engine.execute(worker, 'workspace', work.id, { epoch: 1, host: 'retro-host', path: `/tmp/retro/${work.id}`, branch }, randomUUID());
  const observe = (files: string[], extra: Partial<Observation> = {}): Observation => ({ candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 9000 + n, branch, author: 'retro-worker' },
    checks: [], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true, files, scopeFiles: [], at: new Date().toISOString(), ...extra });
  return { work, pr: 9000 + n, observe };
}

test('unit:retro-artefact-governed-application — an applied check runs on every submission and refuses one that fails it; an applied catalogue entry files later instances of its cause under its fault class', async () => {
  const artefacts = await readRetroArtefacts(store.pool);
  const check = artefacts.find(artefact => artefact.state === 'applied' && artefact.kind === 'mechanical-check')!;
  const entry = artefacts.find(artefact => artefact.state === 'applied' && artefact.kind === 'fault-catalogue-entry')!;

  // Check registration: the submit command runs the registered check against the observed candidate.
  const { work, pr, observe } = await claimedWithCandidate(['src/retro-planned.ts']);
  const refusal = await engine.execute(worker, 'submit', work.id, { epoch: 1, pr }, randomUUID(), { observation: observe(['src/retro-planned.ts', 'src/retro-elsewhere.ts']) }).then(() => null, error => error);
  assert.match(String(refusal?.message), new RegExp(`retro check ${check.check!.id} .*outside plannedFiles: src/retro-elsewhere\\.ts`));
  assert.equal((await engine.execute(worker, 'submit', work.id, { epoch: 1, pr }, randomUUID(), { observation: observe(['src/retro-planned.ts']) })).submission?.pr, pr);
  // Unregistered, the same candidate is not refused by it, and each rule judges what it names.
  const unregistered = artefacts.filter(artefact => artefact.id !== check.id);
  assert.deepEqual(retroCheckRefusals({ plannedFiles: ['src/a.ts'] }, observe(['src/b.ts']), unregistered), []);
  const ruled = (rule: 'merges-onto-base' | 'checks-passed') => [{ ...check, check: { ...check.check!, rule } }];
  assert.equal(retroCheckRefusals({ plannedFiles: [] }, observe([], { conflicting: true }), ruled('merges-onto-base')).length, 1);
  assert.equal(retroCheckRefusals({ plannedFiles: [] }, observe([]), ruled('merges-onto-base')).length, 0);
  assert.equal(retroCheckRefusals({ plannedFiles: [], policy: { checks: ['test'] } }, observe([], { checks: [{ name: 'test', result: 'failure', appId: 1 }] }), ruled('checks-passed')).length, 1);
  // The submit transaction reads only the checks in force, never the whole retro ledger.
  assert.deepEqual((await readAppliedRetroChecks(store.pool)).map(artefact => artefact.id), artefacts.filter(artefact => artefact.state === 'applied' && artefact.kind === 'mechanical-check').map(artefact => artefact.id));
  assert.equal(retroCheckRefusals({ plannedFiles: ['docs/'] }, observe(['docs/a.md']), [check]).length, 0);

  // Catalogue update: the intervention report files every instance of the catalogued cause under its entry and fault class.
  const report = await call(operator, 'GET', 'interventions?window=7');
  assert.equal(report.status, 200, report.text);
  const filed = report.body.interventions.filter((item: any) => item.catalogue);
  assert.ok(filed.length >= 3);
  assert.ok(filed.every((item: any) => item.catalogue.entry === entry.entry!.id && item.catalogue.faultClass === 'scope' && /outside its planned files/.test(item.resolution)));
  assert.deepEqual(report.body.catalogued.map((tally: any) => [tally.entry, tally.faultClass, tally.count]), [[entry.entry!.id, 'scope', filed.length]]);
  // On an item's own gate refusals, as the session reads its item.
  const gates = [{ name: 'build', passed: false, reasons: [outOfScope(4)] }, { name: 'review', passed: false, reasons: ['Outstanding change requests must be resolved through a new review'] }];
  assert.deepEqual(classifyGateRefusals(gates, artefacts).map(found => [found.gate, found.entry, found.faultClass]), [['build', entry.entry!.id, 'scope']]);
  const shown = await withRetroStanding({ key: 'GY-1', gates }, async path => (await call(worker, 'GET', path)).body);
  assert.deepEqual(shown.retroCatalogued.map((found: any) => [found.gate, found.entry, found.faultClass]), [['build', entry.entry!.id, 'scope']]);
  // In detection: a recurrence is counted against the entry, and no second catalogue entry is drafted for it.
  const recurrence = detectRecurringCauses([7, 8, 9].map(n => signal(`c${n}`, { resolution: outOfScope(n) })), artefacts, policy, now);
  assert.equal(recurrence[0].catalogued?.entry, entry.entry!.id);
  assert.deepEqual(draftPrevention(recurrence[0]).map(draft => draft.kind), ['standards-update', 'mechanical-check']);
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
  // Catalogued already: the recurrence is counted against the entry, so no second catalogue entry is drafted.
  assert.deepEqual(again.map(artefact => artefact.kind), ['standards-update', 'mechanical-check']);
  assert.equal(again[0].pattern.count, 3);
  assert.equal(again[0].pattern.catalogued?.faultClass, 'scope');
  assert.deepEqual([...again[0].pattern.recurredAfter].sort(), applied);
  assert.match(again[0].proposal, /recurred after .* was applied, so the earlier prevention did not hold/);
  const approved = await judgeRetroArtefact(store, approver, repository, again[0].id, 'approve', 'Tighten the wording');
  assert.equal(approved.application?.revision, 2);
});

test('unit:retro-artefact-governed-application — judgement revalidates an operator agent under its own lock, concurrent approvals apply at distinct revisions, and unjudged drafts survive a burst of judged ones', async () => {
  // Two review causes, each drafting a requirements update for the same registry.
  for (const n of [1, 2, 3]) await reworked(`Reviewer on GY-${n}: the handler leaks the connection on timeout`);
  for (const n of [1, 2, 3]) await reworked(`Reviewer on GY-${n}: the migration lacks a down step`);
  const drafted = (await synthesizeRetro(store, policy)).drafted;
  const updates = drafted.filter(artefact => artefact.registry === 'requirements');
  assert.equal(updates.length, 2);

  // An operator agent is read again inside the transaction: revoked, or stripped of decision:approve, it judges nothing.
  const agent: Principal = { id: 'retro-operator-agent', role: 'operator-agent', capabilities: ['decision:approve'], scope: { repositories: [repository], workItems: [] } } as Principal;
  const revoked = async () => { throw Object.assign(new Error('Operator-agent credential is revoked or expired'), { status: 401 }); };
  await assert.rejects(judgeRetroArtefact(store, agent, repository, updates[0].id, 'approve', 'fine', revoked), /revoked or expired/);
  await assert.rejects(judgeRetroArtefact(store, agent, repository, updates[0].id, 'approve', 'fine', async () => ({ ...agent, capabilities: [] } as Principal)), /Capability decision:approve is required/);
  await assert.rejects(judgeRetroArtefact(store, agent, repository, updates[0].id, 'approve', 'fine'), /authorization is unavailable/);
  assert.equal((await readRetroArtefacts(store.pool)).find(artefact => artefact.id === updates[0].id)?.state, 'drafted');

  // Concurrent approvals in one registry are serialised by the coordination lock: each takes its own revision.
  const before = retroStanding(await readRetroArtefacts(store.pool)).find(registry => registry.registry === 'requirements')!.revision;
  const approved = await Promise.all(updates.map(update => judgeRetroArtefact(store, approver, repository, update.id, 'approve', 'closes it', async () => agent)));
  assert.deepEqual(approved.map(entry => entry.application!.revision).sort(), [before + 1, before + 2]);

  // A burst of judged drafts newer than an unjudged one never pushes it out of the reading.
  const waiting = randomUUID();
  const pattern = { ...updates[0].pattern, cause: 'reason/waiting-for-judgement' };
  await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [coordinator.id, 'retro.drafted', JSON.stringify({ id: waiting, at: now, draft: { kind: 'standards-update', registry: 'requirements', target: 'coding-standards', title: 'Waiting', proposal: 'Waiting' }, pattern })]);
  const burst = Array.from({ length: retroLedgerLimit + 1 }, () => randomUUID());
  await store.pool.query(`INSERT INTO events(work_id,actor,kind,payload) SELECT NULL, $2, 'retro.drafted', jsonb_build_object('id', id, 'at', $3::text, 'draft', $4::jsonb, 'pattern', $5::jsonb) FROM unnest($1::text[]) AS id`,
    [burst, coordinator.id, now, JSON.stringify({ kind: 'standards-update', registry: 'requirements', target: 'coding-standards', title: 'Burst', proposal: 'Burst' }), JSON.stringify(pattern)]);
  await store.pool.query(`INSERT INTO events(work_id,actor,kind,payload) SELECT NULL, $2, 'retro.refused', jsonb_build_object('id', id, 'refusal', jsonb_build_object('by', $2::text, 'at', $3::text, 'reason', 'burst')) FROM unnest($1::text[]) AS id`, [burst, approver.id, now]);
  // A judgement row without an id never turns the unjudged predicate NULL for every draft.
  await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [approver.id, 'retro.refused', JSON.stringify({ refusal: { by: approver.id, at: now, reason: 'no id' } })]);
  const read = await readRetroArtefacts(store.pool);
  assert.equal(read.find(artefact => artefact.id === waiting)?.state, 'drafted');
  assert.equal(read.filter(artefact => artefact.refusal?.reason === 'burst').length, retroLedgerLimit + 1);

  // The boot migration never builds the index (a plain build would hold the ledger's writes); it is
  // built CONCURRENTLY after startup, once, by one replica, and a build left INVALID is rebuilt (follow-up 24).
  assert.doesNotMatch(events.ddl, /INDEX[^;]*events_retro_id/);
  const holder = await store.pool.connect();
  try {
    await holder.query('SELECT pg_advisory_lock($1)', [advisoryLocks.retroIndex]);
    assert.equal(await ensureRetroIndex(store.pool), 'building elsewhere');
  } finally { await holder.query('SELECT pg_advisory_unlock($1)', [advisoryLocks.retroIndex]); holder.release(); }
  assert.equal(await ensureRetroIndex(store.pool), 'built');
  assert.equal(await ensureRetroIndex(store.pool), 'present');
  await store.pool.query("UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'events_retro_id'::regclass");
  assert.equal(await ensureRetroIndex(store.pool), 'built');
  assert.equal((await store.pool.query("SELECT indisvalid FROM pg_index WHERE indexrelid = 'events_retro_id'::regclass")).rows[0].indisvalid, true);

  // Over thousands of judged retro rows, the applied-check read and the unjudged-draft probe go by
  // payload id through events_retro_id, never a scan of every retro row (follow-ups 18, 19, 22, 23).
  await store.pool.query('ANALYZE events');
  const plan = async (sql: string, params: unknown[] = []) => (await store.pool.query(`EXPLAIN ${sql}`, params)).rows.map(row => row['QUERY PLAN']).join('\n');
  const applied = await plan(retroReads.appliedChecks);
  assert.match(applied, /events_retro_id/, applied);
  const artefacts = await plan(retroReads.artefacts, [['retro.drafted', 'retro.applied', 'retro.refused'], retroLedgerLimit]);
  assert.match(artefacts, /events_retro_id/, artefacts);
});
