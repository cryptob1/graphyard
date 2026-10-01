import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Validation, type ValidationCandidate, type ValidationRequest } from '../src/validation.js';
import { changedPaths, classifyPath, matchesGlob, type ReuseDecision } from '../src/evidence-reuse.js';
import { redactString, type ReplayRecord } from '../src/evidence-replay.js';
import { defineScenario } from '../src/scenarios.js';
import { server } from '../src/server.js';
import { currentEvidence } from '../src/model.js';
import type { Principal, ScopeFile, Work } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * D6 acceptance checks of the turnkey delivery roadmap, one test per check, named
 * "D6-N": scoped evidence reuse, the durable attempt order, replay coverage and the
 * redaction and retention rules on replay, plus the cost/duration analytics they feed.
 * Everything runs against a disposable real Postgres database.
 */
const operator: Principal = { id: 'operator', role: 'admin' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const runner: Principal = { id: 'runner', role: 'worker' };
const collector: Principal = { id: 'collector', role: 'producer', proofs: [] };
const builder: Principal = { id: 'builder', role: 'producer' };
const reader: Principal = { id: 'auditor', role: 'reader' };
const principals = [operator, worker, runner, collector, builder, reader];
const attestationPublicKey = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
const sha = (label: string) => label.repeat(40).slice(0, 40);
const heads = { one: sha('1'), two: sha('2'), three: sha('3') }, base = sha('b');
const digest = `sha256:${'c'.repeat(64)}`, inputs = `sha256:${'d'.repeat(64)}`, otherInputs = `sha256:${'e'.repeat(64)}`, otherArtifact = `sha256:${'f'.repeat(64)}`;
const blob = (label: string) => label.repeat(40).slice(0, 40);
let pg: EmbeddedPostgres, store: Store, engine: Engine, validation: Validation;
let serial = 0;

before(async () => {
  const port = Number(process.env.GRAPHYARD_REUSE_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 17);
  pg = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('reuse'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pg.initialise(); await pg.start(); await pg.createDatabase('reuse_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/reuse_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'test/repository'); validation = new Validation(engine, principals, 'test/repository');
});
after(async () => { if (store) await store.close(); if (pg) await pg.stop(); });
const id = () => randomUUID();
async function current(workId: string) { return (await store.list()).find(w => w.id === workId)!; }
async function request(requestId: string): Promise<ValidationRequest> { return (await store.pool.query('SELECT document FROM validation_requests WHERE id=$1', [requestId])).rows[0].document; }
async function events(kind: string) { return (await store.pool.query('SELECT payload FROM events WHERE kind=$1 ORDER BY seq', [kind])).rows.map(r => r.payload); }
const file = (path: string, label: string | null, status: ScopeFile['status'] = 'modified'): ScopeFile => ({ path, status, sha: label === null ? null : blob(label), additions: 1, deletions: 0, binary: false });
/** The head's diff against the base as GitHub reports it: product code plus a guide. */
const filesOne = [file('src/app.ts', 'a'), file('docs/guide.md', 'g')];

type Fixture = { n: number; w: Work; c: ValidationCandidate; r: ValidationRequest; proof: string; environment: { id: string; revision: number }; runnerRef: { id: string; revision: number }; collectorRef: { id: string; revision: number }; builderRef: { id: string; revision: number }; bundle: { id: string; revision: number }; scenario: { id: string; revision: number; hash: string }; policy: { id: string; revision: number } };
async function observe(w: Work, head: string, files: ScopeFile[] | undefined, extra: Record<string, unknown> = {}) {
  return engine.observe(w.id, w.revision, { candidate: { sha: head, baseSha: base, pr: w.submission!.pr, branch: `graphyard/reuse-${w.submission!.pr}`, author: 'implementer' }, checks: [{ name: 'test', appId: 15368, result: 'success' }, { name: 'typecheck', appId: 15368, result: 'success' }], reviews: [{ reviewer: 'other', sha: head, state: 'APPROVED' }], merged: false, mergeSha: null, protected: true, mergeable: true, files: files?.map(f => f.path) ?? [], at: new Date().toISOString(), ...(files ? { scopeFiles: files } : {}), ...extra });
}
async function attest(f: { builderRef: { id: string; revision: number }; w: Work }, head: string, options: { inputs?: string; artifact?: string } = {}) {
  const w = await current(f.w.id);
  return await validation.attestBuild(builder, { registration: f.builderRef, workId: w.id, expectedWorkRevision: w.revision, sourceSha: head, baseSha: base, buildInputsDigest: options.inputs ?? inputs, artifacts: [{ service: 'api', digest: options.artifact ?? digest }], provenanceUrl: 'https://ci.example.test/build/1' }, id()) as any;
}
async function fixture(options: { artifactStorage?: 'external' | 'postgres'; requiredArtifacts?: string[]; files?: ScopeFile[]; policy?: Record<string, unknown> } = {}): Promise<Fixture> {
  const n = ++serial;
  const environment = { id: `preview-${n}`, revision: 1 }, runnerRef = { id: `runner-${n}`, revision: 1 }, collectorRef = { id: `collector-${n}`, revision: 1 }, builderRef = { id: `builder-${n}`, revision: 1 }, bundle = { id: `bundle-${n}`, revision: 1 }, proof = `e2e:scenario-${n}`, policy = { id: `reuse-${n}`, revision: 1 };
  collector.proofs!.push(proof);
  const scenario = await defineScenario(store, operator, { id: `scenario-${n}`, title: 'Behavior', purpose: 'Prove behavior', steps: ['Execute'], expected: ['Correct'], environment: environment.id, runner: 'playwright', testPath: 'tests/behavior.spec.ts' }, id());
  await validation.define(operator, { kind: 'environment', id: environment.id, expectedRevision: 0, repository: 'test/repository', url: 'https://preview.example.test', instance: `instance-${n}`, immutable: true, services: ['api'], resources: [`test-account-${n}`] }, id());
  for (const [ref, actor, role] of [[runnerRef, runner, 'runner'], [collectorRef, collector, 'collector'], [builderRef, builder, 'builder']] as const) await validation.define(operator, { kind: 'registration', id: ref.id, expectedRevision: 0, principalId: actor.id, role, environment, adapterVersion: 'test-v1', proofs: role === 'collector' ? [proof] : [], enabled: true, ...(role === 'runner' ? { executionHost: 'unix:///var/run/docker.sock', attestationPublicKey, executionNetwork: 'gy-isolated' } : {}) }, id());
  await validation.define(operator, { kind: 'bundle', id: bundle.id, expectedRevision: 0, scenario: scenario.id, scenarioRevision: scenario.revision, scenarioHash: scenario.hash, digest, runnerImageDigest: inputs }, id());
  await validation.define(operator, { kind: 'reuse', id: policy.id, expectedRevision: 0, environment, enabled: true, freshnessSeconds: 3600,
    relevant: { dependencies: ['package.json'], lockfiles: ['package-lock.json', '**/yarn.lock'], buildInputs: ['Dockerfile', 'tsconfig.json'], configuration: ['config/**', '.env.example'], migrations: ['migrations/**'], services: { api: ['src/**'] } },
    ignorable: ['docs/**', 'README.md', '*.md'], ...options.policy }, id());
  let w = await engine.execute(operator, 'create', null, { title: `Reuse fixture ${n}`, criteria: [{ id: 'AC-1', text: 'Behavior is proven', proofs: [proof] }] }, id());
  w = await engine.execute(operator, 'ready', w.id, {}, id()); w = await engine.execute(worker, 'claim', w.id, {}, id());
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: `/tmp/reuse-${n}`, branch: `graphyard/reuse-${n}` }, id());
  w = await engine.execute(worker, 'submit', w.id, { epoch: 1, pr: n }, id());
  w = await observe(w, heads.one, options.files ?? filesOne);
  const build = await attest({ builderRef, w }, heads.one);
  const c = await validation.createCandidate(operator, { workId: w.id, expectedWorkRevision: (await current(w.id)).revision, proof, environment, bundle, buildAttestationId: build.id, requiredArtifacts: options.requiredArtifacts ?? ['report'], artifactStorage: options.artifactStorage ?? 'external' }, id()) as ValidationCandidate;
  const r = await validation.createRequest(operator, { candidateId: c.id, expectedWorkRevision: (await current(w.id)).revision, runner: runnerRef, collector: collectorRef, deadline: new Date(Date.now() + 600_000).toISOString(), maxAttempts: 3 }, id()) as ValidationRequest;
  return { n, w, c, r, proof, environment, runnerRef, collectorRef, builderRef, bundle, scenario, policy };
}
async function start(f: Fixture, requestId = f.r.id) {
  const d: any = await validation.dispatch(runner, { registration: f.runnerRef }, id()); assert.equal(d.request?.id, requestId, d.reason);
  const command = { requestId, attemptId: d.attempt.id as string, epoch: d.attempt.epoch as number };
  await validation.runnerCommand(runner, 'ack', command, id());
  await validation.collectionAuthority(collector, command); return command;
}
function report(f: Fixture, command: { requestId: string; attemptId: string; epoch: number }, overrides: Record<string, unknown> = {}) {
  return { ...command, execution: 'completed', behavior: 'passed', executed: 2, skipped: 0, inventoryComplete: true, target: { instance: `instance-${f.n}`, artifacts: [{ service: 'api', digest }], measurement: 'provider', coversEntireRun: true, attribution: 'matched' }, bundleDigest: digest, runnerImageDigest: inputs, artifacts: [{ name: 'report', digest, url: 'https://private.example.test/report' }], artifactState: 'verified', executionSettled: true, exercise: { behaviour: 'the change under test', result: 'fail', executed: 1 }, ...overrides };
}
/** Execute the fixture's queued request to a passing, settled result. */
async function pass(f: Fixture, overrides: Record<string, unknown> = {}) {
  const command = await start(f);
  const result: any = await validation.result(collector, report(f, command, overrides), id());
  assert.equal(result.passed, true, result.reasons.join('; ')); return command;
}
/** Move the head, attest the new build and ask for reuse. */
async function moveHead(f: Fixture, head: string, files: ScopeFile[] | undefined, build: { inputs?: string; artifact?: string } = {}) {
  const w = await observe(await current(f.w.id), head, files);
  await validation.reconcile();
  return { w: await current(w.id), build: await attest(f, head, build) };
}
async function decide(f: Fixture, head: string, files: ScopeFile[] | undefined, build: { inputs?: string; artifact?: string } = {}) {
  const moved = await moveHead(f, head, files, build);
  return await validation.reuse.decide(operator, { workId: moved.w.id, expectedWorkRevision: moved.w.revision, proof: f.proof, policy: f.policy, buildAttestationId: moved.build.id }, id()) as ReuseDecision;
}
async function newRequest(f: Fixture, candidateId: string) {
  const w = await current(f.w.id);
  return await validation.createRequest(operator, { candidateId, expectedWorkRevision: w.revision, runner: f.runnerRef, collector: f.collectorRef, deadline: new Date(Date.now() + 600_000).toISOString(), maxAttempts: 3 }, id()) as ValidationRequest;
}
const acceptance = (w: Work) => w.gates.find(g => g.name === 'acceptance')!;
const playwrightDocument = (executions: boolean) => ({ format: 'graphyard-playwright-v1', declared: [{ id: 'a'.repeat(64), expected: 'passed', location: { file: 'tests/behavior.spec.ts', line: 1, column: 1 } }, { id: 'b'.repeat(64), expected: 'passed', location: { file: 'tests/behavior.spec.ts', line: 9, column: 1 } }],
  executions: executions ? [{ id: 'a'.repeat(64), status: 'passed', retry: 0 }, { id: 'b'.repeat(64), status: 'passed', retry: 0 }] : [], steps: [], errors: 0, overflow: false, status: 'passed' });
const upload = (command: { requestId: string; attemptId: string; epoch: number }, name: string, document: unknown) => ({ ...command, name, mediaType: 'application/json', bytes: Buffer.from(JSON.stringify(document)).toString('base64'), capturePolicy: 'approved-test-data-only' });

test('D6 glob and classification: relevant categories win, ignorable paths are named, everything else is unknown', () => {
  assert.ok(matchesGlob('docs/**', 'docs/a/b.md') && matchesGlob('**/yarn.lock', 'yarn.lock') && matchesGlob('**/yarn.lock', 'packages/x/yarn.lock') && matchesGlob('*.md', 'README.md'));
  assert.ok(!matchesGlob('*.md', 'docs/README.md') && !matchesGlob('src/*', 'src/a/b.ts') && !matchesGlob('docs/**', 'docs'));
  const policy = { relevant: { dependencies: ['package.json'], lockfiles: ['**/yarn.lock'], buildInputs: ['Dockerfile'], configuration: ['config/**'], migrations: ['migrations/**'], services: { api: ['src/**', 'docs/api/**'] } }, ignorable: ['docs/**', '*.md'] };
  assert.deepEqual(classifyPath(policy, 'docs/api/openapi.md'), { classification: 'relevant', category: 'services.api' }, 'a relevant pattern wins over an ignorable one');
  assert.deepEqual(classifyPath(policy, 'docs/guide.md'), { classification: 'ignorable', category: null });
  assert.deepEqual(classifyPath(policy, 'scripts/deploy.sh'), { classification: 'unknown', category: null });
  assert.deepEqual(classifyPath(policy, 'migrations/001.sql'), { classification: 'relevant', category: 'migrations' });
  assert.deepEqual(changedPaths([{ path: 'a', sha: '1' }, { path: 'b', sha: '2' }, { path: 'gone', sha: null }], [{ path: 'a', sha: '1' }, { path: 'b', sha: '3' }, { path: 'c', sha: '4' }, { path: 'd', sha: null }]),
    [{ path: 'b', change: 'modified' }, { path: 'c', change: 'added' }, { path: 'd', change: 'removed' }, { path: 'gone', change: 'reverted' }]);
});

test('D6-1 relevant dependency and configuration changes invalidate reuse; an ignorable change is reused with exact binding', async () => {
  const f = await fixture(); const command = await pass(f);
  const before = await current(f.w.id);
  assert.equal(acceptance(before).passed, true, acceptance(before).reasons.join('; '));
  assert.equal(before.validation![f.proof].attemptId, command.attemptId);
  assert.equal((await request(f.r.id)).attempts[0].sequence, 1, 'dispatch takes the durable sequence');
  // A dependency change: refused, recorded, and nothing is selected for the new head.
  const dependency = await decide(f, heads.two, [...filesOne, file('package.json', 'p')]);
  assert.equal(dependency.outcome, 'refused'); assert.match(dependency.reasons.join('\n'), /package\.json \(added\) is a relevant dependencies change/);
  assert.equal(dependency.of?.sequence, 1); assert.equal(dependency.candidateId, null);
  let w = await current(f.w.id);
  assert.equal(acceptance(w).passed, false, 'the pass for the previous head does not carry over by itself');
  assert.equal(currentEvidence(w, f.proof), undefined);
  // A configuration change on the same head: refused as configuration, whatever the ignorable docs beside it.
  const configuration = await decide(f, heads.two, [...filesOne, file('config/app.yaml', 'y'), file('docs/guide.md', 'h')]);
  assert.match(configuration.reasons.join('\n'), /config\/app\.yaml \(added\) is a relevant configuration change/);
  assert.ok(!configuration.reasons.some(r => r.includes('docs/guide.md')), 'the ignorable path is not a reason');
  // Only the guide changed: granted. The derived candidate is bound to the executed attempt.
  const granted = await decide(f, heads.two, [file('src/app.ts', 'a'), file('docs/guide.md', 'h')]);
  assert.equal(granted.outcome, 'granted', granted.reasons.join('; '));
  assert.deepEqual(granted.applicability.changed, [{ path: 'docs/guide.md', change: 'modified', classification: 'ignorable', category: null }]);
  assert.equal(granted.applicability.artifactsIdentical, true); assert.equal(granted.applicability.buildInputsIdentical, true);
  w = await current(f.w.id);
  const evidence = currentEvidence(w, f.proof)!;
  assert.ok(evidence, 'the reused pass is current for the new head');
  assert.equal(evidence.sha, heads.two); assert.equal(evidence.producer, collector.id); assert.equal(evidence.trusted, true);
  assert.equal(evidence.reuse?.decisionId, granted.id); assert.equal(evidence.reuse?.sourceSha, heads.one); assert.equal(evidence.reuse?.sequence, 1);
  assert.deepEqual(evidence.validation, { candidateId: granted.candidateId, requestId: f.r.id, attemptId: command.attemptId });
  assert.equal(acceptance(w).passed, true, acceptance(w).reasons.join('; '));
  const derived = (await store.pool.query('SELECT document FROM validation_candidates WHERE id=$1', [granted.candidateId])).rows[0].document as ValidationCandidate;
  assert.equal(derived.sourceSha, heads.two); assert.deepEqual(derived.reuse?.of, { candidateId: f.c.id, requestId: f.r.id, attemptId: command.attemptId, sequence: 1 });
  // The derived candidate is attributable like an executed one: the same artifact digests run, while the manifest
  // (which binds the source SHA) and the signature differ from the executed candidate's only in manifest and source.
  assert.equal(derived.digestHash, f.c.digestHash); assert.ok(derived.manifestHash && derived.manifestHash !== f.c.manifestHash);
  assert.ok(derived.signature && derived.signature !== f.c.signature);
  assert.deepEqual(Object.entries(derived.signatureComponents!).filter(([k, v]) => f.c.signatureComponents![k as keyof typeof f.c.signatureComponents] !== v).map(([k]) => k).sort(), ['manifest', 'source']);
  // Reconciliation keeps the reused selection: the derived candidate's pins are current.
  await validation.reconcile(true);
  w = await current(f.w.id); assert.ok(currentEvidence(w, f.proof), 'reuse survives reconciliation');
  assert.equal((await events('validation.reuse-granted')).filter(e => e.details.decision.id === granted.id).length, 1);
  assert.equal((await events('validation.reuse-refused')).length >= 2, true);
  // The same decision with the same key returns the receipt; a retry of the executed request is refused.
  await assert.rejects(validation.operatorCommand(operator, 'retry', { requestId: f.r.id, epoch: 1, reason: 'again' }, id()), /Retry needs settled prior execution|no longer matches/);
  // Once the head moves past the reused selection, reconciliation withdraws the binding exactly once.
  await moveHead(f, heads.three, [file('src/app.ts', 'a'), file('docs/guide.md', 'i')]);
  const withdrawn = (await events('validation.superseded')).filter(e => e.request.id === f.r.id).length;
  await validation.reconcile(); await validation.reconcile(true);
  assert.equal((await events('validation.superseded')).filter(e => e.request.id === f.r.id).length, withdrawn, 'a superseded request with nothing bound is not recorded again on every tick');
  assert.equal((await current(f.w.id)).validation![f.proof].attemptId, undefined);
  // Declared build inputs differ: refused even though every path is ignorable.
  const builds = await decide(f, heads.three, [file('src/app.ts', 'a'), file('docs/guide.md', 'i')], { inputs: otherInputs });
  assert.equal(builds.outcome, 'refused'); assert.match(builds.reasons.join('\n'), /Declared build inputs differ/);
  assert.equal(builds.applicability.buildInputsIdentical, false);
  // A differing artifact manifest is refused by the default policy and accepted by an explicitly scoped one.
  const artifacts = await decide(f, heads.three, [file('src/app.ts', 'a'), file('docs/guide.md', 'i')], { artifact: otherArtifact });
  assert.match(artifacts.reasons.join('\n'), /Built artifacts differ and the reuse policy requires identical artifacts/);
  await validation.define(operator, { kind: 'reuse', id: f.policy.id, expectedRevision: 1, environment: f.environment, enabled: true, freshnessSeconds: 3600, artifacts: 'scoped',
    relevant: { dependencies: ['package.json'], lockfiles: ['package-lock.json'], buildInputs: ['Dockerfile'], configuration: ['config/**'], migrations: ['migrations/**'], services: { api: ['src/**'] } }, ignorable: ['docs/**'] }, id());
  f.policy = { id: f.policy.id, revision: 2 };
  const scoped = await decide(f, heads.three, [file('src/app.ts', 'a'), file('docs/guide.md', 'i')], { artifact: otherArtifact });
  assert.equal(scoped.outcome, 'granted', scoped.reasons.join('; ')); assert.equal(scoped.applicability.artifactsIdentical, false);
  assert.equal(currentEvidence(await current(f.w.id), f.proof)?.sha, heads.three);
  // Revoking the executed pass withdraws every record derived from it: the reused evidence for the later heads falls with it.
  w = await engine.execute(operator, 'revoke', f.w.id, { proof: f.proof, sha: heads.one, baseSha: base, policyRevision: 1, reason: 'Attributed to the wrong artifact' }, id());
  assert.equal(currentEvidence(w, f.proof), undefined);
  assert.ok(w.evidence.filter(e => e.reuse).every(e => e.revocation?.reason === 'Attributed to the wrong artifact'), 'every derived record is annotated, not deleted');
  assert.equal(acceptance(w).passed, false);
});

test('GY-135: a pass with no failing run against the stripped tree is never carried onto a new head', async () => {
  const f = await fixture(); await pass(f);
  // A pass trusted before the exercise rule: the same record with its stripped run erased.
  const stored = await current(f.w.id), legacy = stored.evidence.at(-1)!;
  delete legacy.exercise;
  await store.pool.query('UPDATE work_items SET document=$2 WHERE id=$1', [stored.id, JSON.stringify(stored)]);
  const decision = await decide(f, heads.two, [file('src/app.ts', 'a'), file('docs/guide.md', 'h')]);
  assert.equal(decision.outcome, 'refused'); assert.equal(decision.evidenceId, null);
  assert.match(decision.reasons.join('\n'), new RegExp(`${f.proof} does not exercise AC-1: it passed, but no run of it against a tree with the criterion's behaviour removed was recorded`));
  assert.equal(acceptance(await current(f.w.id)).passed, false);
});
test('D6-2 requirement, scenario, proof policy, bundle, environment, freshness and independence changes invalidate reuse when source is unchanged', async () => {
  // Requirement revision: the pass at policy v1 cannot stand for v2 even with no file changed.
  const f = await fixture(); await pass(f);
  let w = await current(f.w.id);
  w = await engine.execute(operator, 'requirements', w.id, { expectedPolicyRevision: w.policyRevision, criteria: [{ id: 'AC-1', text: 'Behavior is proven, revised', proofs: [f.proof] }], dependencies: [], plannedFiles: [], exclusiveResources: [], reason: 'Wording revised' }, id());
  assert.equal(w.policyRevision, 2);
  const revised = await decide(f, heads.two, [file('src/app.ts', 'a'), file('docs/guide.md', 'h')]);
  assert.equal(revised.outcome, 'refused'); assert.match(revised.reasons.join('\n'), /Requirement or proof policy revision changed \(attempt at v1, work at v2\)/);
  // Approved bundle revision: a new revision of the bundle the attempt executed is no longer current.
  const g = await fixture(); await pass(g);
  await validation.define(operator, { kind: 'bundle', id: g.bundle.id, expectedRevision: 1, scenario: g.scenario.id, scenarioRevision: g.scenario.revision, scenarioHash: g.scenario.hash, digest, runnerImageDigest: inputs }, id());
  const bundle = await decide(g, heads.two, [file('src/app.ts', 'a'), file('docs/guide.md', 'h')]);
  assert.equal(bundle.outcome, 'refused'); assert.match(bundle.reasons.join('\n'), /approved oracle bundle revision the attempt executed is no longer current/);
  // Environment revision: the target scope the attempt ran against is superseded, and the reuse policy itself pins a revision.
  const h = await fixture(); await pass(h);
  await validation.define(operator, { kind: 'environment', id: h.environment.id, expectedRevision: 1, repository: 'test/repository', url: 'https://preview.example.test', instance: `instance-${h.n}-b`, immutable: true, services: ['api'], resources: [`test-account-${h.n}`] }, id());
  const moved = await moveHead(h, heads.two, [file('src/app.ts', 'a'), file('docs/guide.md', 'h')]).catch(e => e);
  assert.ok(moved instanceof Error, 'the builder registration is bound to the superseded environment revision, so the new build itself refuses');
  assert.match(moved.message, /Definition missing or authorization generation superseded/);
  // Scenario pin: a work item whose requirement pins a newer scenario revision does not accept a pass for the old one.
  const k = await fixture(); await pass(k);
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{scenarioRequirements,0,hash}',to_jsonb('0'::text||repeat('1',63))) WHERE id=$1", [k.w.id]);
  const scenario = await decide(k, heads.two, [file('src/app.ts', 'a'), file('docs/guide.md', 'h')]);
  assert.equal(scenario.outcome, 'refused'); assert.match(scenario.reasons.join('\n'), /Scenario revision, hash or environment changed/);
  // Freshness: the newest pass is older than the policy allows.
  const m = await fixture({ policy: { freshnessSeconds: 60 } }); await pass(m);
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{evidence,0,at}',to_jsonb($2::text)) WHERE id=$1", [m.w.id, new Date(Date.now() - 120_000).toISOString()]);
  const stale = await decide(m, heads.two, [file('src/app.ts', 'a'), file('docs/guide.md', 'h')]);
  assert.equal(stale.outcome, 'refused'); assert.match(stale.reasons.join('\n'), /older than the policy freshness of 60s/);
  // A granted reuse inherits the freshness bound, so it expires with the original observation.
  const n = await fixture({ policy: { freshnessSeconds: 60 } }); await pass(n);
  const fresh = await decide(n, heads.two, [file('src/app.ts', 'a'), file('docs/guide.md', 'h')]);
  assert.equal(fresh.outcome, 'granted', fresh.reasons.join('; '));
  const evidence = (await current(n.w.id)).evidence.find(e => e.id === fresh.evidenceId)!;
  assert.ok(Date.parse(evidence.expiresAt!) <= Date.parse(evidence.reuse!.observedAt) + 60_000, 'reused evidence expires with the policy freshness');
  assert.equal(currentEvidence(await current(n.w.id), n.proof, new Date(Date.now() + 120_000)), undefined, 'and is not current past it');
  // Independence: a collector that later held an assignment cannot have its pass reused.
  const p = await fixture(); await pass(p);
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{implementers}',to_jsonb(ARRAY['implementer','collector'])) WHERE id=$1", [p.w.id]);
  const dependent = await decide(p, heads.two, [file('src/app.ts', 'a'), file('docs/guide.md', 'h')]);
  assert.equal(dependent.outcome, 'refused'); assert.match(dependent.reasons.join('\n'), /requires a producer identity distinct from its implementers/);
  // A disabled policy, a policy for another environment, and a non-operator are refused outright.
  const q = await fixture(); await pass(q);
  const qMoved = await moveHead(q, heads.two, [file('src/app.ts', 'a'), file('docs/guide.md', 'h')]);
  await assert.rejects(validation.reuse.decide(collector, { workId: qMoved.w.id, expectedWorkRevision: qMoved.w.revision, proof: q.proof, policy: q.policy, buildAttestationId: qMoved.build.id }, id()), /Operator/);
  await assert.rejects(validation.reuse.decide(operator, { workId: qMoved.w.id, expectedWorkRevision: qMoved.w.revision, proof: q.proof, policy: p.policy, buildAttestationId: qMoved.build.id }, id()), /environment differs/);
  await validation.define(operator, { kind: 'reuse', id: q.policy.id, expectedRevision: 1, environment: q.environment, enabled: false, freshnessSeconds: 3600, relevant: { dependencies: [], lockfiles: [], buildInputs: [], configuration: [], migrations: [], services: { api: ['src/**'] } }, ignorable: ['**'] }, id());
  await assert.rejects(validation.reuse.decide(operator, { workId: qMoved.w.id, expectedWorkRevision: (await current(q.w.id)).revision, proof: q.proof, policy: { id: q.policy.id, revision: 2 }, buildAttestationId: qMoved.build.id }, id()), /disabled/);
  // A reuse policy must scope every service of its environment.
  await assert.rejects(validation.define(operator, { kind: 'reuse', id: `reuse-bad-${q.n}`, expectedRevision: 0, environment: q.environment, enabled: true, freshnessSeconds: 3600, relevant: { dependencies: [], lockfiles: [], buildInputs: [], configuration: [], migrations: [], services: {} }, ignorable: [] }, id()), /must scope every service/);
});

test('D6-3 newer blocked, timed-out, unmeasured or incomplete attempts prevent fallback; delayed older results cannot override the newest attempt', async () => {
  // A passed first attempt, then a second request whose attempt times out: the newest attempt wins.
  const f = await fixture(); await pass(f);
  const ignorable = [file('src/app.ts', 'a'), file('docs/guide.md', 'h')];
  let moved = await moveHead(f, heads.two, ignorable);
  const c2 = await validation.createCandidate(operator, { workId: moved.w.id, expectedWorkRevision: moved.w.revision, proof: f.proof, environment: f.environment, bundle: f.bundle, buildAttestationId: moved.build.id, requiredArtifacts: ['report'], artifactStorage: 'external' }, id()) as ValidationCandidate;
  const r2 = await newRequest(f, c2.id);
  let w = await current(f.w.id);
  const queued = await validation.reuse.decide(operator, { workId: w.id, expectedWorkRevision: w.revision, proof: f.proof, policy: f.policy, buildAttestationId: moved.build.id }, id()) as ReuseDecision;
  assert.equal(queued.outcome, 'refused'); assert.match(queued.reasons.join('\n'), /is queued; a newer queued or running attempt prevents fallback/);
  const first = (await request(f.r.id)).attempts[0].sequence!;
  const d: any = await validation.dispatch(runner, { registration: f.runnerRef }, id()); assert.equal(d.request.id, r2.id); assert.ok(d.attempt.sequence > first, 'the sequence is global and monotone');
  await validation.runnerCommand(runner, 'ack', { requestId: r2.id, attemptId: d.attempt.id, epoch: 1 }, id());
  // The runner's lease lapses: a timed-out attempt, unsettled.
  await store.pool.query("UPDATE validation_requests SET document=jsonb_set(document,'{attempts,0,expiresAt}',to_jsonb('2000-01-01T00:00:00Z'::text)) WHERE id=$1", [r2.id]); await validation.reconcile();
  assert.equal((await request(r2.id)).state, 'expired');
  w = await current(f.w.id);
  const timedOut = await validation.reuse.decide(operator, { workId: w.id, expectedWorkRevision: w.revision, proof: f.proof, policy: f.policy, buildAttestationId: moved.build.id }, id()) as ReuseDecision;
  assert.equal(timedOut.outcome, 'refused'); assert.equal(timedOut.of?.sequence, d.attempt.sequence); assert.equal(timedOut.of?.state, 'expired');
  assert.match(timedOut.reasons.join('\n'), /Newest attempt 1 of request .* is expired; only a settled, accepted pass can be reused/);
  // Settle, retry, and let the retried attempt report unmeasured behavior: still no fallback to sequence 1.
  await validation.operatorCommand(operator, 'settle', { requestId: r2.id, epoch: 1, reason: 'Verified no process', settlementEvidence: 'https://tests.example.test/settlement' }, id());
  await validation.operatorCommand(operator, 'retry', { requestId: r2.id, epoch: 1, reason: 'Run again' }, id());
  const command = await start(f, r2.id);
  assert.equal((await request(r2.id)).attempts[1].sequence, d.attempt.sequence + 1, 'a retry takes the next sequence');
  const unmeasured: any = await validation.result(collector, report(f, command, { behavior: 'unmeasured' }), id());
  assert.equal(unmeasured.accepted, true); assert.equal(unmeasured.passed, false);
  w = await current(f.w.id);
  const afterUnmeasured = await validation.reuse.decide(operator, { workId: w.id, expectedWorkRevision: w.revision, proof: f.proof, policy: f.policy, buildAttestationId: moved.build.id }, id()) as ReuseDecision;
  assert.equal(afterUnmeasured.outcome, 'refused'); assert.equal(afterUnmeasured.of?.sequence, d.attempt.sequence + 1);
  assert.match(afterUnmeasured.reasons.join('\n'), /not passed: Execution and behavior must both pass/);
  // A delayed result for the older request cannot regain authority: it is rejected, and the sequence order is unchanged.
  const late: any = await validation.result(collector, report(f, { requestId: f.r.id, attemptId: (await request(f.r.id)).attempts[0].id, epoch: 1 }), id());
  assert.equal(late.accepted, false); assert.match(late.reasons.join('\n'), /does not hold the current live acknowledged attempt|newer validation selection supersedes/);
  const order = (await store.pool.query('SELECT seq,request_id FROM validation_attempts WHERE work_id=$1 ORDER BY seq', [f.w.id])).rows;
  assert.deepEqual(order.map(r => [Number(r.seq), r.request_id]), [[first, f.r.id], [d.attempt.sequence, r2.id], [d.attempt.sequence + 1, r2.id]]);
  // A later failure supersedes a reused pass: grant reuse on a fresh item, then run a live attempt for the same head that fails.
  const g = await fixture(); await pass(g);
  const granted = await decide(g, heads.two, ignorable); assert.equal(granted.outcome, 'granted', granted.reasons.join('; '));
  assert.equal(acceptance(await current(g.w.id)).passed, true);
  const live = await newRequest(g, granted.candidateId!);
  w = await current(g.w.id); assert.equal(acceptance(w).passed, false, 'a newer queued attempt withdraws the reused pass');
  assert.equal(currentEvidence(w, g.proof), undefined);
  const liveCommand = await start(g, live.id);
  const failed: any = await validation.result(collector, report(g, liveCommand, { behavior: 'failed' }), id()); assert.equal(failed.passed, false);
  w = await current(g.w.id); assert.equal(acceptance(w).passed, false); assert.equal(currentEvidence(w, g.proof)?.result, 'fail');
  const again = await decide(g, heads.two, ignorable);
  assert.equal(again.outcome, 'refused'); assert.match(again.reasons.join('\n'), /not passed/);
  assert.equal(again.of?.sequence, (await request(live.id)).attempts[0].sequence);
});

test('D6-4 unknown scope never widens evidence applicability', async () => {
  // A path the policy names neither as relevant nor as ignorable is unknown and refuses.
  const f = await fixture(); await pass(f);
  const unknown = await decide(f, heads.two, [file('src/app.ts', 'a'), file('docs/guide.md', 'g'), file('scripts/deploy.sh', 's')]);
  assert.equal(unknown.outcome, 'refused'); assert.equal(unknown.applicability.scopeKnown, true);
  assert.deepEqual(unknown.applicability.changed, [{ path: 'scripts/deploy.sh', change: 'added', classification: 'unknown', category: null }]);
  assert.match(unknown.reasons.join('\n'), /scripts\/deploy\.sh \(added\) is not covered by the reuse policy; unknown scope never widens applicability/);
  // A file reverted to the base between the heads is a change, even though the new diff no longer lists it.
  const reverted = await decide(f, heads.two, [file('src/app.ts', 'a')]);
  assert.deepEqual(reverted.applicability.changed, [{ path: 'docs/guide.md', change: 'reverted', classification: 'ignorable', category: null }]);
  assert.equal(reverted.outcome, 'granted', reverted.reasons.join('; '));
  // A removal of a relevant file is a relevant change.
  const removed = await decide(f, heads.three, [file('src/app.ts', null, 'removed')]);
  assert.equal(removed.outcome, 'refused'); assert.match(removed.reasons.join('\n'), /src\/app\.ts \(removed\) is a relevant services\.api change/);
  // No file comparison on the new head: missing scope falls back to exact binding.
  const g = await fixture(); await pass(g);
  const missing = await decide(g, heads.two, undefined);
  assert.equal(missing.outcome, 'refused'); assert.equal(missing.applicability.scopeKnown, false);
  assert.match(missing.reasons.join('\n'), /were not independently observed; missing scope falls back to exact source binding/);
  // No file comparison on the executed head either: the candidate snapshot is null and the same fallback applies.
  const k = await fixture();
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{observation}',(document->'observation') - 'scopeFiles') WHERE id=$1", [k.w.id]);
  const kw = await current(k.w.id);
  const kBuild = await attest(k, heads.one);
  const bare = await validation.createCandidate(operator, { workId: kw.id, expectedWorkRevision: kw.revision, proof: k.proof, environment: k.environment, bundle: k.bundle, buildAttestationId: kBuild.id, requiredArtifacts: ['report'], artifactStorage: 'external' }, id()) as ValidationCandidate;
  assert.equal(bare.files, null);
  const bareRequest = await newRequest(k, bare.id);
  const bareCommand = await start(k, bareRequest.id);
  const passed: any = await validation.result(collector, report(k, bareCommand), id()); assert.equal(passed.passed, true);
  const exact = await decide(k, heads.two, [file('docs/guide.md', 'h')]);
  assert.equal(exact.outcome, 'refused'); assert.equal(exact.applicability.scopeKnown, false);
  // A reuse policy that ignores everything still cannot cover a relevant change or widen a missing snapshot.
  await validation.define(operator, { kind: 'reuse', id: k.policy.id, expectedRevision: 1, environment: k.environment, enabled: true, freshnessSeconds: 3600, relevant: { dependencies: [], lockfiles: [], buildInputs: [], configuration: [], migrations: [], services: { api: ['src/**'] } }, ignorable: ['**'] }, id());
  k.policy = { id: k.policy.id, revision: 2 };
  const wide = await decide(k, heads.two, [file('docs/guide.md', 'h')]);
  assert.equal(wide.outcome, 'refused', 'the executed head has no snapshot, so no policy widens it');
  assert.equal(wide.applicability.scopeKnown, false);
});

test('D6-5 replay reports coverage and cannot authorize current live behavior by itself', async () => {
  const f = await fixture({ artifactStorage: 'postgres', requiredArtifacts: ['inventory', 'report'] });
  const command = await start(f);
  const inventory: any = await validation.uploadArtifact(collector, upload(command, 'inventory', playwrightDocument(false)), id());
  const executed: any = await validation.uploadArtifact(collector, upload(command, 'report', playwrightDocument(true)), id());
  const artifacts = [{ name: 'inventory', digest: inventory.digest, url: inventory.url }, { name: 'report', digest: executed.digest, url: executed.url }];
  const result: any = await validation.result(collector, report(f, command, { artifacts, measurements: { durationMs: 4200, cpuSeconds: 3.5, cost: { amount: 0.02, currency: 'USD', basis: 'observed', source: 'runner-host-metering' } } }), id());
  assert.equal(result.passed, true, result.reasons.join('; '));
  const before = await current(f.w.id);
  const replay = await validation.replay.replay(reader, { requestId: f.r.id, attemptId: command.attemptId }) as ReplayRecord;
  assert.equal(replay.outcome, 'consistent', JSON.stringify(replay.differences));
  assert.equal(replay.coverage.inventory.status, 'covered'); assert.equal(replay.coverage.behavior.status, 'covered'); assert.equal(replay.coverage.artifactIntegrity.status, 'covered');
  for (const dimension of ['bundleIdentity', 'targetAttribution', 'settlement', 'deploymentHealth'] as const) assert.equal(replay.coverage[dimension].status, 'not-covered', dimension);
  assert.match(replay.coverage.deploymentHealth.reason, /never establishes current live behavior or deployment health/);
  assert.equal(replay.verification?.executed, 2); assert.equal(replay.recorded?.executed, 2); assert.equal(replay.authorizes, 'nothing'); assert.equal(replay.liveVerification, 'not-established');
  assert.equal(replay.cost.artifactsRead, 2); assert.ok(replay.cost.bytesRead > 0 && replay.cost.durationMs >= 0); assert.equal(replay.sequence, (await request(f.r.id)).attempts[0].sequence);
  assert.deepEqual(replay.artifacts.map(a => [a.name, a.read, a.integrity]), [['inventory', true, 'verified'], ['report', true, 'verified']]);
  assert.ok(!JSON.stringify(replay).includes('tests/behavior.spec.ts'), 'artifact contents are not exported');
  // Nothing about the work changed: no evidence, selection or gate moved because of the replay.
  const after = await current(f.w.id);
  assert.equal(after.evidence.length, before.evidence.length); assert.deepEqual(after.validation, before.validation); assert.equal(after.revision, before.revision);
  // Replay after the head moves and the pass is no longer current: the record is unchanged in meaning and still authorizes nothing.
  await observe(after, heads.two, [file('src/app.ts', 'z')]); await validation.reconcile();
  const later = await validation.replay.replay(operator, { requestId: f.r.id, attemptId: command.attemptId }) as ReplayRecord;
  assert.equal(later.outcome, 'consistent'); assert.equal(acceptance(await current(f.w.id)).passed, false, 'a clean replay does not stand in for live verification of the new head');
  assert.equal((await validation.replay.replays()).replays.length >= 2, true);
  assert.equal((await events('validation.replayed')).filter(e => e.replay.id === replay.id).length, 1);
  // A collector's report that disagrees with its own retained artifacts is an inconsistent replay.
  const g = await fixture({ artifactStorage: 'postgres', requiredArtifacts: ['inventory', 'report'] });
  const gCommand = await start(g);
  const gInventory: any = await validation.uploadArtifact(collector, upload(gCommand, 'inventory', playwrightDocument(false)), id());
  const gReport: any = await validation.uploadArtifact(collector, upload(gCommand, 'report', { ...playwrightDocument(true), executions: [{ id: 'a'.repeat(64), status: 'failed', retry: 0 }, { id: 'b'.repeat(64), status: 'passed', retry: 0 }], status: 'failed' }), id());
  const claimed: any = await validation.result(collector, report(g, gCommand, { artifacts: [{ name: 'inventory', digest: gInventory.digest, url: gInventory.url }, { name: 'report', digest: gReport.digest, url: gReport.url }] }), id());
  assert.equal(claimed.passed, true, 'the control plane accepts the collector\'s dimensions; replay is what re-derives them from the retained files');
  const contradiction = await validation.replay.replay(reader, { requestId: g.r.id, attemptId: gCommand.attemptId }) as ReplayRecord;
  assert.equal(contradiction.outcome, 'inconsistent'); assert.match(contradiction.differences.join('\n'), /Replayed verdict failed but the collector reported behavior passed/);
  // Without the instrumentation — no retained inventory — a clean-looking replay is unmeasured.
  const h = await fixture({ artifactStorage: 'postgres', requiredArtifacts: ['report'] });
  const hCommand = await start(h);
  const hReport: any = await validation.uploadArtifact(collector, upload(hCommand, 'report', playwrightDocument(true)), id());
  const hResult: any = await validation.result(collector, report(h, hCommand, { artifacts: [{ name: 'report', digest: hReport.digest, url: hReport.url }] }), id()); assert.equal(hResult.passed, true);
  const unmeasured = await validation.replay.replay(reader, { requestId: h.r.id, attemptId: hCommand.attemptId }) as ReplayRecord;
  assert.equal(unmeasured.outcome, 'unmeasured'); assert.equal(unmeasured.verification, null);
  assert.equal(unmeasured.coverage.inventory.status, 'unmeasured'); assert.match(unmeasured.coverage.inventory.reason, /lack the instrumentation to replay: inventory was never retained/);
  assert.equal(unmeasured.coverage.artifactIntegrity.status, 'covered', 'what was read is still verified');
  // Only audit credentials replay.
  await assert.rejects(validation.replay.replay(collector, { requestId: h.r.id, attemptId: hCommand.attemptId }), /audit credential/);
  await assert.rejects(validation.replay.replay(runner, { requestId: h.r.id, attemptId: hCommand.attemptId }), /audit credential/);
  // Analytics: observed timings, runner-reported measurements as observed cost, unavailable cost for attempts that reported none, and reuse/replay counts.
  const analytics = await validation.replay.analytics();
  const group = analytics.groups.find(g => g.proof === f.proof)!;
  assert.equal(group.attempts, 1); assert.equal(group.outcomes.passed, 1); assert.equal(group.runner, f.runnerRef.id); assert.equal(group.environment, f.environment.id);
  assert.equal(group.observed.totalMs.samples, 1); assert.equal(group.observed.executionMs.samples, 1); assert.equal(group.observed.collectionMs.samples, 1); assert.equal(group.observed.queueMs.samples, 1);
  assert.deepEqual(group.cost.observed, { attempts: 1, amounts: { USD: 0.02 } }); assert.equal(group.cost.unavailable, 0); assert.equal(group.reported.durationMs.p50Ms, 4200); assert.equal(group.reported.cpuSeconds.p50Ms, 3.5);
  const other = analytics.groups.find(g => g.proof === h.proof)!;
  assert.equal(other.cost.unavailable, 1); assert.equal(other.reported.durationMs.samples, 0);
  assert.ok(analytics.reuse.decisions >= 1 && analytics.reuse.granted >= 1 && analytics.reuse.refused >= 1);
  assert.ok(analytics.reuse.supersededByLiveRun >= 1 && analytics.reuse.contradictedByLaterFailure >= 1, 'the D6-3 grant that a later live failure contradicted is counted as false reuse');
  assert.ok(analytics.reuse.avoidedExecutions >= 1); assert.ok(analytics.reuse.refusalReasons['relevant-change'] >= 1 && analytics.reuse.refusalReasons['unknown-scope'] >= 1);
  assert.ok(analytics.replays.total >= 4 && analytics.replays.outcomes.inconsistent >= 1 && analytics.replays.outcomes.unmeasured >= 1);
  assert.match(analytics.caveat, /No group is ranked against another/);
  assert.ok(!('ranking' in analytics));
  // The measurement schema is strict: a cost without a basis is refused rather than counted.
  const k = await fixture({ artifactStorage: 'external' }); const kCommand = await start(k);
  await assert.rejects(validation.result(collector, report(k, kCommand, { measurements: { cost: { amount: 1, currency: 'USD', source: 'guess' } } }), id()), /basis|Invalid/);
  const withBasis: any = await validation.result(collector, report(k, kCommand, { measurements: { cost: { amount: 1.5, currency: 'EUR', basis: 'estimated', source: 'rate-card' } } }), id());
  assert.equal(withBasis.passed, true);
  const estimated = (await validation.replay.analytics()).groups.find(g => g.proof === k.proof)!;
  assert.deepEqual(estimated.cost.estimated, { attempts: 1, amounts: { EUR: 1.5 } }); assert.equal(estimated.cost.observed.attempts, 0); assert.equal(estimated.cost.unavailable, 0);
});

test('D6-6 redaction and retention rules apply to replay inputs and exports', async () => {
  assert.equal(redactString('Authorization: Bearer abc.def token=ghp_abcdefghijklmnopqrstuvwxyz012345 at https://user:hunter2@host/x'), 'Authorization: Bearer [redacted] token=[redacted] at https://[redacted]@host/x');
  assert.equal(redactString('password: hunter2 api_key=k-123 secret: s'), 'password: [redacted] api_key=[redacted] secret: [redacted]');
  // Credential-shaped samples are assembled at runtime so no literal in this file matches a secret scanner.
  const segment = (claims: Record<string, string>) => Buffer.from(JSON.stringify(claims)).toString('base64url');
  const jwtShaped = [segment({ alg: 'HS256' }), segment({ sub: '1234567890' }), 'a'.repeat(43)].join('.');
  const awsShaped = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
  assert.equal(redactString(`${jwtShaped} ok ${awsShaped}`), '[redacted] ok [redacted]');
  assert.equal(redactString('nothing secret here'), 'nothing secret here');
  const f = await fixture({ artifactStorage: 'postgres', requiredArtifacts: ['inventory', 'report'] });
  const command = await start(f);
  const inventory: any = await validation.uploadArtifact(collector, upload(command, 'inventory', playwrightDocument(false)), id());
  const executed: any = await validation.uploadArtifact(collector, upload(command, 'report', playwrightDocument(true)), id());
  const result: any = await validation.result(collector, report(f, command, { artifacts: [{ name: 'inventory', digest: inventory.digest, url: inventory.url }, { name: 'report', digest: executed.digest, url: executed.url }] }), id());
  assert.equal(result.passed, true);
  // Expired retention: the artifact is not read, the replay is unmeasured, and the record says why.
  await store.pool.query("UPDATE validation_artifacts SET expires_at='2000-01-01' WHERE id=$1", [inventory.id]);
  const expired = await validation.replay.replay(operator, { requestId: f.r.id, attemptId: command.attemptId }) as ReplayRecord;
  assert.equal(expired.outcome, 'unmeasured');
  assert.deepEqual(expired.artifacts.map(a => [a.name, a.read, a.reason]), [['inventory', false, 'Artifact retention expired'], ['report', true, null]]);
  assert.equal(expired.cost.artifactsRead, 1); assert.match(expired.coverage.inventory.reason, /inventory — Artifact retention expired/);
  assert.equal(await validation.expireArtifacts(), 1);
  const swept = await validation.replay.replay(operator, { requestId: f.r.id, attemptId: command.attemptId }) as ReplayRecord;
  assert.equal(swept.artifacts[0].reason, 'Artifact is expired; no bytes were retained');
  // Tampered bytes fail their digest: the artifact is read but not trusted, and integrity is reported.
  await store.pool.query("UPDATE validation_artifacts SET bytes=$2 WHERE id=$1", [executed.id, Buffer.from(JSON.stringify({ ...playwrightDocument(true), tampered: true }))]);
  const tampered = await validation.replay.replay(operator, { requestId: f.r.id, attemptId: command.attemptId }) as ReplayRecord;
  assert.equal(tampered.artifacts[1].integrity, 'failed'); assert.equal(tampered.coverage.artifactIntegrity.status, 'unmeasured'); assert.equal(tampered.outcome, 'unmeasured');
  // Every string in the export passes the redaction rule, and artifact bytes never appear in the record or the ledger.
  const g = await fixture({ artifactStorage: 'postgres', requiredArtifacts: ['inventory', 'report'] });
  const gCommand = await start(g);
  const marker = 'ghp_' + 'z'.repeat(30);
  const gInventory: any = await validation.uploadArtifact(collector, upload(gCommand, 'inventory', playwrightDocument(false)), id());
  const gReport: any = await validation.uploadArtifact(collector, upload(gCommand, 'report', { ...playwrightDocument(true), declared: [{ id: 'a'.repeat(64), expected: 'passed', location: { file: `tests/${marker}.spec.ts`, line: 1, column: 1 } }, { id: 'b'.repeat(64), expected: 'passed', location: { file: 'tests/behavior.spec.ts', line: 9, column: 1 } }] }), id());
  await validation.result(collector, report(g, gCommand, { artifacts: [{ name: 'inventory', digest: gInventory.digest, url: gInventory.url }, { name: 'report', digest: gReport.digest, url: gReport.url }] }), id());
  const redacted = await validation.replay.replay({ id: 'operator', role: 'admin' }, { requestId: g.r.id, attemptId: gCommand.attemptId }) as ReplayRecord;
  const exported = JSON.stringify(redacted), ledger = JSON.stringify(await events('validation.replayed'));
  assert.ok(!exported.includes(marker) && !ledger.includes(marker), 'a credential-shaped string inside an artifact never reaches the export or the ledger');
  assert.ok(!exported.includes('"declared"') && !exported.includes('"executions"'), 'parsed documents are not exported');
  assert.equal(redacted.redaction.artifactBytesExported, false);
  // The listing is paged newest first and carries the same redacted records.
  const page = await validation.replay.replays();
  assert.equal(page.replays[0].id, redacted.id); assert.ok(!JSON.stringify(page).includes(marker));
  const decisions = await validation.reuse.decisions();
  assert.ok(decisions.decisions.length >= 1 && decisions.decisions.every(d => ['granted', 'refused'].includes(d.outcome)));
});

test('D6 HTTP routes derive authority from the credential: reuse is operator-only, replay is audit-only, analytics and listings are readable', async () => {
  const f = await fixture({ artifactStorage: 'postgres', requiredArtifacts: ['report'] });
  const command = await start(f);
  const stored: any = await validation.uploadArtifact(collector, upload(command, 'report', playwrightDocument(true)), id());
  const result: any = await validation.result(collector, report(f, command, { artifacts: [{ name: 'report', digest: stored.digest, url: stored.url }] }), id()); assert.equal(result.passed, true);
  const moved = await moveHead(f, heads.two, [file('src/app.ts', 'a'), file('docs/guide.md', 'h')]);
  const configuredReviewers = process.env.GRAPHYARD_MAX_REVIEWERS; process.env.GRAPHYARD_MAX_REVIEWERS = '6';
  let http: ReturnType<typeof server>;
  try { http = server(engine, principals.map(p => ({ ...p, token: `${p.id}-token-${'x'.repeat(32)}` }))); }
  finally { if (configuredReviewers === undefined) delete process.env.GRAPHYARD_MAX_REVIEWERS; else process.env.GRAPHYARD_MAX_REVIEWERS = configuredReviewers; }
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(http.address() as any).port}`;
  const call = async (actor: Principal, path: string, body?: unknown) => { const response = await fetch(`${url}/api/${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${actor.id}-token-${'x'.repeat(32)}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() }, body: body ? JSON.stringify(body) : undefined }); return { status: response.status, body: await response.json() as any }; };
  try {
    const decision = { workId: moved.w.id, expectedWorkRevision: moved.w.revision, proof: f.proof, policy: f.policy, buildAttestationId: moved.build.id };
    assert.equal((await call(worker, 'validation/reuse', decision)).status, 403);
    assert.equal((await call(collector, 'validation/reuse', decision)).status, 403);
    const granted = await call(operator, 'validation/reuse', decision); assert.equal(granted.status, 200); assert.equal(granted.body.outcome, 'granted', JSON.stringify(granted.body.reasons));
    assert.equal((await call(reader, 'validation/reuse')).body.decisions[0].id, granted.body.id);
    assert.equal((await call(collector, 'validation/replay', { requestId: f.r.id, attemptId: command.attemptId })).status, 403);
    assert.equal((await call(runner, 'validation/replay', { requestId: f.r.id, attemptId: command.attemptId })).status, 403);
    const replayed = await call(reader, 'validation/replay', { requestId: f.r.id, attemptId: command.attemptId }); assert.equal(replayed.status, 200); assert.equal(replayed.body.authorizes, 'nothing');
    assert.equal((await call(worker, 'validation/replays')).body.replays[0].id, replayed.body.id);
    const analytics = await call(worker, 'validation/analytics'); assert.equal(analytics.status, 200); assert.ok(analytics.body.groups.some((g: any) => g.proof === f.proof)); assert.ok(analytics.body.reuse.granted >= 1);
    const definitions = await call(reader, 'validation/definitions'); assert.ok(definitions.body.definitions.some((d: any) => d.kind === 'reuse' && d.id === f.policy.id));
  } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
});
