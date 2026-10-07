import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { GitHub } from '../src/github.js';
import type { Observation, Principal, ScopeFile, Work } from '../src/model.js';
import { classifyScope, regressionRefusals } from '../src/regression-guard.js';
import { parseLocalScopeDiff } from '../src/sync.js';
import { managedInstructions } from '../src/repository-setup.js';
import { assertDispatchable, buildMasterStatus, dispatchSchedule, managedMasterInstructions, masterConfigSchema, type MasterConfig } from '../src/master.js';
import { emptyDispatchCursor, runDispatchTick, type DispatchEffects } from '../src/auto-dispatch.js';
import { acceptedMergeAt, beginAttempt, endAttempt, endLapsedAttempt, nearestRankPercentiles, pipelineSpeed, pipelineSpeedSummary, recordIntervention, recordRework, recordSubmission, speedTarget, type PipelineTimeline } from '../src/pipeline-speed.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
// @ts-expect-error Dependency-free protected workflow script.
import { planCiProofs } from '../scripts/contracts.mjs';
// @ts-expect-error Dependency-free measurement script.
import { measure, parseArguments, render, main as measureMain } from '../scripts/measure-pipeline-speed.mjs';
import { readMasterGuide } from './helpers/master-guide.js';
// A namespace import, so a proof run against code without the stage breakdown fails in its test case, not at load.
import * as flowAnalytics from '../src/flow-analytics.js';
import type { DeliveryStage, DeliveryStageMove } from '../src/flow-analytics.js';

// GY-54: pipeline speed. Each test is named for the proof it produces — integration:speed-regression-guard
// and unit:speed-scope-diff (AC-1), integration:speed-auto-dispatch and integration:speed-reconcile-latency
// (AC-2), integration:speed-ci-proofs (AC-3), integration:speed-conflict-avoidance (AC-4) and
// integration:speed-metrics (AC-5). manual:speed-ci-proofs-live and manual:speed-target-met are producer
// sessions against the live control plane; the metrics tests show them where to read.

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const launcher = join(repositoryRoot, 'bin/graphyard.mjs');
const read = (path: string) => readFile(join(repositoryRoot, path), 'utf8');
const sha40 = (label: string) => label.replace(/[^a-f0-9]/g, '0').padEnd(40, 'f').slice(0, 40);
const H = sha40('a1'), H2 = sha40('a2'), B = sha40('b1');

const operator: Principal = { id: 'operator', role: 'admin', sessionKind: 'human' };
const implementer: Principal = { id: 'implementer', role: 'worker' };
const producer: Principal = { id: 'proof-runner', role: 'producer', proofs: ['unit:*', 'integration:*', 'manual:*'] };
const coordinator: Principal = { id: 'master', role: 'coordinator' };
let database: EmbeddedPostgres, store: Store, engine: Engine;
let http: ReturnType<typeof server>, url: string;
let pr = 540;
const github = { config: { repository: 'owner/project', appId: 1234, installationId: 1, base: 'main' } } as unknown as GitHub;
before(async () => {
  const port = Number(process.env.GRAPHYARD_PIPELINE_SPEED_TEST_PORT ?? Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 20);
  database = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('pipeline-speed'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await database.initialise(); await database.start(); await database.createDatabase('graphyard_test');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/graphyard_test`); await store.init();
  engine = new Engine(store, [15368], 120, 'owner/project');
  engine.submissionObserver = null;
  process.env.GITHUB_WEBHOOK_SECRET = 'pipeline-speed-webhook-secret';
  http = server(engine, [{ ...operator, token: 'o'.repeat(32) }, { ...implementer, token: 'w'.repeat(32) }, { ...producer, token: 'p'.repeat(32) }, { ...coordinator, token: 'm'.repeat(32) }], github);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as any).port}`;
});
after(async () => { if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (database) await database.stop(); });

const reload = async (item: Work) => (await store.list()).find(entry => entry.id === item.id)!;
const events = async (item: Work, kind: string) => (await store.events(item.id)).filter(event => event.kind === kind).reverse();
const criteria = [
  { id: 'AC-1', text: 'Guard', proofs: ['integration:speed-regression-guard', 'unit:speed-scope-diff'] },
  { id: 'AC-2', text: 'Dispatch', proofs: ['integration:speed-auto-dispatch', 'integration:speed-reconcile-latency'] },
  { id: 'AC-3', text: 'CI', proofs: ['integration:speed-ci-proofs', 'manual:speed-ci-proofs-live'] },
  { id: 'AC-5', text: 'Metrics', proofs: ['integration:speed-metrics', 'manual:speed-target-met'] },
];
async function created(title: string, plannedFiles = ['src/pipeline-speed.ts'], extra: Record<string, unknown> = {}) {
  const item = await engine.execute(operator, 'create', null, { title, plannedFiles, criteria, ...extra }, randomUUID());
  return engine.execute(operator, 'ready', item.id, {}, randomUUID());
}
async function claimed(title: string, plannedFiles?: string[], extra?: Record<string, unknown>) {
  let item = await created(title, plannedFiles, extra);
  item = await engine.execute(implementer, 'claim', item.id, {}, randomUUID());
  return engine.execute(implementer, 'workspace', item.id, { epoch: item.epoch, host: 'machine-a', path: `/tmp/speed/${item.id}-${item.epoch}`, branch: `graphyard/${item.key.toLowerCase()}-1` }, randomUUID());
}
async function submitted(title: string, plannedFiles?: string[], extra?: Record<string, unknown>) {
  const item = await claimed(title, plannedFiles, extra);
  return engine.execute(implementer, 'submit', item.id, { epoch: item.epoch, pr: ++pr }, randomUUID());
}
const scoped = (path: string, overrides: Partial<ScopeFile> = {}): ScopeFile => ({ path, status: 'modified', sha: sha40('5'), additions: 2, deletions: 2, binary: false, baseSha: sha40('4'), ...overrides });
function observed(item: Work, candidate: { sha: string; baseSha: string }, extra: Partial<Observation> = {}): Observation {
  return { candidate: { ...candidate, pr: item.submission!.pr, branch: (item.workspaces.find(entry => entry.epoch === item.submission!.epoch) ?? item.workspaces[0]).branch, author: 'implementer' }, checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    // GY-883: a public API path keeps the item in the high lane, whose full path still demands the producer proofs and dispatch cadence this file measures.
    files: ['src/server/routes/pipeline-speed.ts'], scopeFiles: [scoped('src/server/routes/pipeline-speed.ts', { baseSha: undefined })], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true, ...extra };
}

// ---------------------------------------------------------------------------------------------
// AC-1 — the regression guard and sync remove the most common rework round
// ---------------------------------------------------------------------------------------------

test('unit:speed-scope-diff — the local sync diff and the provider observation classify the same change identically: a revert outside plannedFiles is refused by both, naming the delivered item that shipped it; in-scope, new and generated files pass both', () => {
  const plannedFiles = ['src/pipeline-speed.ts', 'tests/'];
  // git diff --raw -z / --numstat -z against the fetched base tip, exactly as sync reads them.
  const raw = [`:100644 100644 ${sha40('4')} ${sha40('5')} M`, 'src/pipeline-speed.ts', `:000000 100644 ${'0'.repeat(40)} ${sha40('6')} A`, 'tests/pipeline-speed.test.ts',
    `:100644 100644 ${sha40('8')} ${sha40('9')} M`, 'src/engine.ts', `:100644 000000 ${sha40('c')} ${'0'.repeat(40)} D`, 'src/conflicts.ts', `:100644 100644 ${sha40('d')} ${sha40('e')} M`, 'docs/README.md', ''].join('\0');
  const numstat = ['3\t1\tsrc/pipeline-speed.ts', '40\t0\ttests/pipeline-speed.test.ts', '0\t12\tsrc/engine.ts', '0\t80\tsrc/conflicts.ts', '2\t2\tdocs/README.md', ''].join('\0');
  const local = parseLocalScopeDiff(raw, numstat);
  assert.deepEqual(local.map(file => [file.path, file.status, file.baseSha]), [['src/pipeline-speed.ts', 'modified', sha40('4')], ['tests/pipeline-speed.test.ts', 'added', null], ['src/engine.ts', 'modified', sha40('8')], ['src/conflicts.ts', 'removed', sha40('c')], ['docs/README.md', 'modified', sha40('d')]]);
  // The provider observation carries the same records; the classifier is the same function.
  const provider: ScopeFile[] = local.map(file => ({ ...file }));
  const generated = ['docs/README.md'];
  const verdict = (files: ScopeFile[]) => classifyScope(plannedFiles, files, generated).map(finding => [finding.path, finding.kind, finding.refused]);
  const expected = [['src/pipeline-speed.ts', 'in-scope', false], ['tests/pipeline-speed.test.ts', 'in-scope', false], ['src/engine.ts', 'reverted', true], ['src/conflicts.ts', 'deleted', true], ['docs/README.md', 'generated', false]];
  assert.deepEqual(verdict(local), expected); assert.deepEqual(verdict(provider), expected);
  // The refusal names each file and the delivered item whose planned files shipped it.
  const shipped = [{ key: 'GY-66', stage: 'done', plannedFiles: ['src/conflicts.ts', 'src/master.ts'], delivery: { mergeSha: sha40('66') } }, { key: 'GY-61', stage: 'done', plannedFiles: ['src/engine.ts'], delivery: { mergeSha: sha40('61') } }] as unknown as Work[];
  const refusals = regressionRefusals({ key: 'GY-54', plannedFiles }, { scopeFiles: provider }, shipped, generated);
  assert.equal(refusals.length, 3, refusals.join('\n'));
  assert.match(refusals[0], /2 files outside its planned files/);
  assert.match(refusals.join('\n'), /src\/engine\.ts: removes 12 lines[^\n]*\(shipped by GY-61\)/);
  assert.match(refusals.join('\n'), /src\/conflicts\.ts: deleted[^\n]*\(shipped by GY-66\)/);
  // A file outside scope that matches the base is not a change at all, and a new file is never a regression.
  assert.deepEqual(classifyScope(plannedFiles, [scoped('src/master.ts', { sha: sha40('f'), baseSha: sha40('f') }), scoped('src/brand-new.ts', { status: 'added', baseSha: null })], []).map(finding => [finding.kind, finding.refused]), [['matches-base', false], ['new', false]]);
  assert.deepEqual(regressionRefusals({ key: 'GY-54', plannedFiles }, { scopeFiles: [scoped('src/pipeline-speed.ts', { baseSha: undefined })] }, shipped, generated), []);
});

test('integration:speed-regression-guard — complete refuses a candidate whose diff against its base reverts files outside its scope, naming the files and the shipped work, records nothing, and accepts the same head once the diff is in scope', async () => {
  const shipped = await submitted('Shipped conflicts module', ['src/conflicts.ts']);
  await store.pool.query("UPDATE work_items SET document=document||$2::jsonb WHERE id=$1", [shipped.id, JSON.stringify({ stage: 'done', delivery: { mergedAt: new Date().toISOString(), mergeSha: sha40('66'), authorizationRevision: 1 } })]);
  const item = await claimed('Guarded submission', ['src/pipeline-speed.ts', 'tests/']);
  const number = ++pr;
  const regressed: Observation = { ...observed({ ...item, submission: { epoch: 1, pr: number } } as Work, { sha: H, baseSha: B }), files: ['src/pipeline-speed.ts', 'src/conflicts.ts', 'src/engine.ts'],
    scopeFiles: [scoped('src/pipeline-speed.ts', { baseSha: undefined }), scoped('src/conflicts.ts', { status: 'removed', sha: null }), scoped('src/engine.ts', { additions: 0, deletions: 9 })] };
  await assert.rejects(engine.execute(implementer, 'submit', item.id, { epoch: 1, pr: number }, randomUUID(), { observation: regressed }), (error: any) => {
    assert.equal(error.status, 409);
    assert.match(error.message, new RegExp(`Submission refused for ${item.key}: Candidate changes 2 files outside its planned files`));
    assert.match(error.message, new RegExp(`src/conflicts\\.ts: deleted; the base branch still holds it \\(shipped by ${shipped.key}\\)`));
    assert.match(error.message, /src\/engine\.ts: removes 9 lines/);
    return true;
  });
  const after = await reload(item);
  assert.equal(after.submission, null, 'a refused submission is not recorded'); assert.equal(after.pipeline?.submittedAt, null, 'and starts no submit→merge clock');
  assert.equal((await events(item, 'submit')).length, 0);
  // The same worker, same PR, in-scope diff: accepted, and the timeline starts.
  const clean: Observation = { ...regressed, files: ['src/pipeline-speed.ts', 'tests/pipeline-speed.test.ts'], scopeFiles: [scoped('src/pipeline-speed.ts', { baseSha: undefined }), scoped('tests/pipeline-speed.test.ts', { status: 'added', baseSha: undefined })] };
  const accepted = await engine.execute(implementer, 'submit', item.id, { epoch: 1, pr: number }, randomUUID(), { observation: clean });
  assert.deepEqual(accepted.submission, { epoch: 1, pr: number }); assert.equal(accepted.lease, null, 'complete ends the lease in the same transaction');
  assert.ok(accepted.pipeline?.submittedAt); assert.equal(accepted.pipeline?.attempts[0].end, 'submitted');
  // An observation without a base comparison never passes the guard: the refusal is fail-closed.
  const uncompared = await claimed('Uncompared submission');
  await assert.rejects(engine.execute(implementer, 'submit', uncompared.id, { epoch: 1, pr: ++pr }, randomUUID(), { observation: { ...observed({ ...uncompared, submission: { epoch: 1, pr } } as Work, { sha: H, baseSha: B }), scopeFiles: undefined } }), /has not been compared against the base branch tip/);
});

// A bare origin with a shipped module, a worker branch that re-resolved that module while merging
// main, and the fake control plane the CLI reads the item from.
async function syncFixture(plannedFiles: string[]) {
  const root = await temporaryDirectory('speed-sync');
  const origin = join(root, 'origin.git'), main = join(root, 'main'), branch = join(root, 'branch');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, main], { stdio: 'ignore' });
  for (const cwd of [main]) { git(cwd, 'config', 'user.email', 't@example.com'); git(cwd, 'config', 'user.name', 'T'); }
  await writeFile(join(main, 'README.md'), '# Fixture\n'); await writeFile(join(main, 'conflicts.ts'), 'export const probe = 1;\n'); await writeFile(join(main, 'speed.ts'), 'export const speed = 0;\n');
  git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'base'); git(main, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, branch], { stdio: 'ignore' }); git(branch, 'config', 'user.email', 't@example.com'); git(branch, 'config', 'user.name', 'T');
  git(branch, 'checkout', '-q', '-b', 'graphyard/gy-1-1');
  const item = { id: 'w1', key: 'GY-1', stage: 'build', ready: true, plannedFiles, dependencies: [], workspaces: [{ epoch: 1, host: 'h', path: branch, branch: 'graphyard/gy-1-1' }], observation: null, submission: null } as unknown as Work;
  const shipped = { id: 'w9', key: 'GY-66', stage: 'done', plannedFiles: ['conflicts.ts'], workspaces: [], delivery: { mergeSha: '', mergedAt: '' } } as unknown as Work;
  const http = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/status') return res.end(JSON.stringify({ actor: { id: 'worker-a', role: 'worker' }, baseBranch: 'main' }));
    if (req.url === '/api/work-snapshot') return res.end(JSON.stringify({ now: new Date().toISOString(), work: [item, shipped] }));
    res.end(JSON.stringify(req.url === '/api/work/GY-1' ? item : [item, shipped]));
  });
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_URL: `http://127.0.0.1:${(http.address() as any).port}`, GRAPHYARD_TOKEN: 'test-only' };
  for (const name of ['GRAPHYARD_TOKEN_FILE', 'GRAPHYARD_REQUEST_ID', 'HERDR_ENV', 'GRAPHYARD_HERDR_AGENT_KIND', 'GRAPHYARD_GENERATED_FILES']) delete env[name];
  const sync = () => exec(process.execPath, [launcher, 'sync', 'GY-1'], { cwd: branch, env }).then(result => ({ code: 0, output: JSON.parse(result.stdout) }), (error: any) => ({ code: error.code as number, output: JSON.parse(error.stdout) }));
  return { root, main, branch, git, shipped, sync, close: () => new Promise<void>(resolve => http.close(() => resolve())) };
}

test('integration:speed-regression-guard — sync performs the canonical main integration (fetch, merge, never rebase) and the self-check against the fetched tip: a re-resolved file outside plannedFiles is refused with the restore command, and the push is cleared once it matches main again', async () => {
  const fixture = await syncFixture(['speed.ts']);
  const { main, branch, git, shipped, sync } = fixture;
  try {
    await writeFile(join(branch, 'speed.ts'), 'export const speed = 1;\n'); git(branch, 'add', '.'); git(branch, 'commit', '-q', '-m', 'speed');
    // Meanwhile GY-66 ships a change to conflicts.ts on main.
    await writeFile(join(main, 'conflicts.ts'), 'export const probe = 2; // shipped by GY-66\n'); git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'GY-66'); git(main, 'push', '-q', 'origin', 'main');
    (shipped as any).delivery.mergeSha = git(main, 'rev-parse', 'HEAD');
    const merged = await sync();
    assert.equal(merged.code, 0, JSON.stringify(merged.output));
    assert.equal(merged.output.merged, true); assert.equal(merged.output.ok, true); assert.equal(merged.output.base, 'origin/main');
    assert.equal(merged.output.baseTip, git(main, 'rev-parse', 'HEAD'));
    assert.equal(git(branch, 'rev-list', '--merges', '--count', 'HEAD'), '1', 'the integration is a merge commit, never a rebase');
    assert.deepEqual(merged.output.files.map((entry: any) => [entry.path, entry.kind]), [['speed.ts', 'in-scope']]);
    assert.match(merged.output.next, /Push, then complete GY-1 EPOCH PR/);
    // The worker "resolves" the shipped module back to its own version and commits: the self-check refuses before any push.
    await writeFile(join(branch, 'conflicts.ts'), 'export const probe = 1;\n'); git(branch, 'add', '.'); git(branch, 'commit', '-q', '-m', 'bad resolution');
    const refused = await sync();
    assert.equal(refused.code, 1); assert.equal(refused.output.ok, false);
    assert.deepEqual(refused.output.refused.map((line: string) => line.split(':')[0]), ['conflicts.ts']);
    assert.match(refused.output.refused[0], /^conflicts\.ts: differs from the base branch tip \(\+1 −1\)$/);
    assert.match(refused.output.next, new RegExp(`git checkout ${refused.output.baseTip.slice(0, 12)} -- PATH`)); assert.match(refused.output.next, /Do not push until it reports ok/);
    git(branch, 'checkout', refused.output.baseTip, '--', 'conflicts.ts'); git(branch, 'commit', '-q', '-m', 'restore');
    const restored = await sync();
    assert.equal(restored.code, 0); assert.equal(restored.output.ok, true); assert.deepEqual(restored.output.refused, []);
    assert.equal(git(branch, 'status', '--porcelain'), '');
  } finally { await fixture.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('integration:speed-regression-guard — the generated worker instructions require sync before every push, forbid re-resolving files outside plannedFiles, and make complete the last action', async () => {
  const instructions = managedInstructions('# Repo\n', 'https://graphyard.example');
  for (const fragment of ['Run `sync GY-N` before every push', 'never rebase', 'Files outside plannedFiles must match\norigin/BASE byte-for-byte', 'never re-resolve a merge in favour of your\nbranch', 'Only an operator can widen plannedFiles', 'Submit the PR with `complete GY-N EPOCH PR_NUMBER`', 'refused, naming the files and the shipped work they belong to', 'Make `complete` your last action'])
    assert.ok(instructions.includes(fragment), `the generated worker instructions must say: ${fragment}`);
  assert.ok((await read('AGENTS.md')).includes('Run `sync GY-N` before every push'), 'this repository carries the generated block');
  const coordination = await read('docs/coordination.md');
  assert.ok(coordination.includes('## Refuse candidates that revert shipped code outside their scope'));
  assert.ok(coordination.includes('graphyard sync'));
});

// ---------------------------------------------------------------------------------------------
// AC-2 — the server requests review and proof on the exact head; observation latency is seconds
// ---------------------------------------------------------------------------------------------

function masterConfig(credentialFile: string): MasterConfig {
  return masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile, cliPath: launcher, repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-project',
    reviewer: { appId: 5678, installationId: 91011, slug: 'graphyard-reviewer', credentialFile: join(credentialFile, '..', 'reviewer.json'), boundAt: new Date().toISOString() }, reviewers: [{ name: 'claude-reviewer', agentName: 'review-claude-1', kind: 'claude' }],
    producers: [{ name: 'producer-unit', principal: 'proof-runner', agentName: 'produce-unit', kind: 'claude', credentialFile: join(credentialFile, '..', 'producer-unit.token') },
      { name: 'producer-integration', principal: 'proof-runner-b', agentName: 'produce-integration', kind: 'claude', credentialFile: join(credentialFile, '..', 'producer-integration.token') },
      { name: 'producer-manual', principal: 'proof-runner-c', agentName: 'produce-manual', kind: 'claude', credentialFile: join(credentialFile, '..', 'producer-manual.token') }] });
}
function stubEffects(items: () => Work[], log: { kind: string; key: string; sha: string; group: string | null; profile: string; at: number }[]): DispatchEffects {
  const reviews: any[] = [], producers: any[] = [];
  return {
    snapshot: async () => ({ work: items(), now: new Date().toISOString() }), agents: () => [],
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    reconcileReviews: async () => ({ reviews }), reconcileProducers: async () => ({ producers }),
    launchReview: async (item, request, profile) => { log.push({ kind: 'review', key: item.key, sha: request.sha, group: null, profile: profile.name, at: Date.now() }); reviews.push({ requestId: request.id, state: 'pending', requestedAt: new Date().toISOString() }); },
    launchProducer: async (item, request, profile) => { log.push({ kind: 'producer', key: item.key, sha: request.sha, group: request.group ?? null, profile: profile.name, at: Date.now() }); producers.push({ requestId: request.id, state: 'pending', requestedAt: new Date().toISOString() }); },
    persist: async () => {},
  };
}

test('integration:speed-auto-dispatch — one passing observation records the review request on the exact head in the same transaction and no producer request (GitHub delivery), a single dispatcher tick launches the reviewer within the 30-second bound, and no master command is involved', async () => {
  const directory = await temporaryDirectory('speed-dispatch');
  try {
    let item = await submitted('Auto-dispatched head', ['src/server/routes/pipeline-speed.ts'], { producerProofs: ['manual:speed-target-met'] });
    assert.equal(item.autoDispatch?.review, null); assert.equal(item.autoDispatch?.producers.length, 0);
    const submittedAt = Date.now();
    item = await engine.observe(item.id, item.revision, observed(item, { sha: H, baseSha: B }));
    assert.ok(item.gates.find(gate => gate.name === 'build')!.passed);
    // GitHub delivery (GY-1235): proofs gate nothing, so the reviewer is asked at once and no producer is requested.
    const review = item.autoDispatch!.review!;
    assert.deepEqual([review.state, review.sha, review.baseSha, review.policyRevision, review.pr], ['requested', H, B, item.policyRevision, item.submission!.pr]);
    assert.deepEqual(item.autoDispatch!.producers, []);
    const requested = await events(item, 'dispatch.requested');
    assert.equal(requested.length, 1); assert.equal(requested[0].actor, 'graphyard', 'the control plane itself records the request');
    assert.equal(requested[0].payload.details.sha, H); assert.equal(requested[0].payload.details.baseSha, B);
    assert.ok((await store.events(item.id)).every(event => event.actor !== coordinator.id), 'no coordinator command touched the item');
    // The dispatcher: one tick launches the reviewer on the exact head.
    const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const log: Parameters<typeof stubEffects>[1] = [];
    const effects = stubEffects(() => [item], log), cursor = emptyDispatchCursor(masterConfig(token));
    const tick = await runDispatchTick(masterConfig(token), cursor, effects, () => Date.now());
    assert.deepEqual(tick.launched.map(entry => [entry.kind, entry.profile, entry.sha]), [['review', 'claude-reviewer', H]]); assert.deepEqual(tick.refused, []); assert.deepEqual(tick.waiting, []);
    assert.ok(log.every(entry => entry.sha === H && entry.key === item.key), 'the session is launched on the exact head');
    assert.ok(Math.max(...log.map(entry => entry.at)) - submittedAt < 30_000, 'observation to launch fits the 30-second bound');
    // A head change cancels the review and requests the new head afresh, still without a master.
    item = await engine.observe(item.id, item.revision, observed(item, { sha: H2, baseSha: B }));
    assert.equal(item.autoDispatch!.review!.sha, H2); assert.deepEqual(item.autoDispatch!.producers, []);
    assert.deepEqual((await events(item, 'dispatch.cancelled')).map(event => event.payload.details.kind), ['review']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('integration:speed-reconcile-latency — a GitHub webhook delivery wakes the item\'s reconciliation job at once and is deduplicated, a finished observation is polled again within 20 s (45 s after a failure), and the server tick is 2 s, so submit→observation is seconds and polling never exceeds 60 s', async () => {
  const item = await submitted('Reconciled quickly');
  const job = async () => (await store.pool.query('SELECT available_at, generation, EXTRACT(EPOCH FROM (available_at - clock_timestamp()))*1000 AS due_in_ms FROM jobs WHERE work_id=$1', [item.id])).rows[0];
  assert.ok(await job(), 'submission enqueues the integration job');
  // Every other item's job is parked so the store hands out this one (a webhook wakes them all).
  const parkOthers = () => store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour' WHERE work_id<>$1", [item.id]);
  await parkOthers();
  // Park the job an hour out, as a long backoff would; the webhook brings it forward to now.
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour' WHERE work_id=$1", [item.id]);
  const before = await job();
  const secret = process.env.GITHUB_WEBHOOK_SECRET!;
  const deliver = (delivery: string, payload: unknown) => {
    const raw = JSON.stringify(payload);
    return fetch(`${url}/api/github/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Delivery': delivery, 'X-Hub-Signature-256': `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}` }, body: raw });
  };
  const payload = { action: 'synchronize', repository: { full_name: 'owner/project' }, pull_request: { number: item.submission!.pr } };
  const delivery = randomUUID();
  const accepted = await deliver(delivery, payload);
  assert.equal(accepted.status, 202); assert.deepEqual(await accepted.json(), { accepted: true });
  const woken = await job();
  assert.ok(Number(woken.due_in_ms) <= 0, `the job is due now, not in ${woken.due_in_ms} ms`); assert.equal(Number(woken.generation), Number(before.generation) + 1);
  await parkOthers();
  assert.equal((await store.takeJob())?.work_id, item.id, 'the tick can take it immediately');
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour', token=NULL, locked_until=NULL WHERE work_id=$1", [item.id]);
  const replayed = await deliver(delivery, payload);
  assert.equal(replayed.status, 202); assert.ok(Number((await job()).due_in_ms) > 3_000_000, 'a replayed delivery ID wakes nothing');
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour', token=NULL, locked_until=NULL WHERE work_id=$1", [item.id]);
  const own = await deliver(randomUUID(), { ...payload, check_run: { app: { id: github.config.appId } } });
  assert.deepEqual(await own.json(), { accepted: true, ignored: 'own check' });
  assert.equal((await deliver(randomUUID(), { ...payload, repository: { full_name: 'other/repo' } })).status, 403);
  assert.equal((await fetch(`${url}/api/github/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Delivery': randomUUID(), 'X-Hub-Signature-256': 'sha256=bad' }, body: JSON.stringify(payload) })).status, 401);
  // Polling cadence: after a successful observation the job returns within 20 s; after an error within 45 s; a retry in 2 s.
  await store.pool.query('UPDATE jobs SET available_at=now(), token=NULL, locked_until=NULL WHERE work_id=$1', [item.id]);
  const taken = (await store.takeJob())!;
  await store.finishJob(item.id, taken.token);
  const settled = Number((await job()).due_in_ms); assert.ok(settled > 0 && settled <= 20_000, `success re-polls within 20 s, not ${settled} ms`);
  await store.pool.query('UPDATE jobs SET available_at=now() WHERE work_id=$1', [item.id]);
  const failed = (await store.takeJob())!; await store.finishJob(item.id, failed.token, 'provider unavailable');
  const errored = Number((await job()).due_in_ms); assert.ok(errored > 20_000 && errored <= 45_000, `a failure re-polls within 45 s, not ${errored} ms`);
  await store.pool.query('UPDATE jobs SET available_at=now() WHERE work_id=$1', [item.id]);
  const retried = (await store.takeJob())!; await store.finishJob(item.id, retried.token, undefined, true);
  const retry = Number((await job()).due_in_ms); assert.ok(retry <= 2_000, `a requested retry is due within 2 s, not ${retry} ms`);
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour', token=NULL, locked_until=NULL WHERE work_id=$1", [item.id]);
  // A webhook wakes only the pull requests it names; a push to the base branch wakes every job.
  await deliver(randomUUID(), { ...payload, pull_request: { number: item.submission!.pr + 1000 } });
  assert.ok(Number((await job()).due_in_ms) > 3_000_000, 'a delivery about another pull request wakes nothing here');
  await deliver(randomUUID(), { repository: { full_name: 'owner/project' }, check_run: { head_sha: 'e'.repeat(40), pull_requests: [{ number: item.submission!.pr }], app: { id: -1 } } });
  assert.ok(Number((await job()).due_in_ms) <= 0, 'a check run linked to this pull request wakes it');
  await store.pool.query("UPDATE jobs SET available_at=now()+interval '1 hour' WHERE work_id=$1", [item.id]);
  await deliver(randomUUID(), { repository: { full_name: 'owner/project' }, ref: 'refs/heads/main', after: 'f'.repeat(40) });
  assert.ok(Number((await job()).due_in_ms) <= 0, 'a push to the base branch wakes every job');
  // The server's own loop: a 2-second tick over the store's cadence, and the observation workers
  // beside it (GY-492), which claim up to GRAPHYARD_OBSERVATION_CONCURRENCY due jobs at once.
  const main = await read('src/server/main.ts');
  const interval = Number(main.match(/\}, (\d+)\);\s*\n\s*http\.listen/)?.[1]);
  assert.ok(interval > 0 && interval <= 60_000, `the reconciliation tick is ${interval} ms`);
  assert.match(main, /startObservationWorkers\(engine, github, capacity\.concurrency\)/);
  assert.match(main, /GRAPHYARD_OBSERVATION_CONCURRENCY/);
  assert.match(main, /Promise\.all\(Array\.from\(\{ length: Math\.max\(1, Math\.floor\(concurrency\)\) \}, worker\)\)/);
  assert.match(await read('docs/protocol/github-webhook.md'), /wakes durable jobs/);
});

// ---------------------------------------------------------------------------------------------
// AC-3 — automatable proofs run as trusted CI on the published tip; manual proofs start at submit
// ---------------------------------------------------------------------------------------------

test('integration:speed-ci-proofs — every unit:* and integration:* proof an item requires is planned for the trusted CI lane from the protected registry, the manual ones are deferred from CI and no producer is requested at submit, and the workflow caches dependencies, the database image and the candidate layers', async () => {
  const proofs = criteria.flatMap(criterion => criterion.proofs);
  const registry = Object.fromEntries(proofs.filter(proof => !proof.startsWith('manual:')).map(proof => [proof, { kind: proof.startsWith('unit:') ? 'unit' : 'integration', source: 'scripts/contracts.mjs' }]));
  const plan = planCiProofs(proofs, registry);
  assert.deepEqual(plan.runnable.map((entry: any) => entry.proof), proofs.filter(proof => !proof.startsWith('manual:')));
  assert.deepEqual(plan.deferred.map((entry: any) => [entry.proof, entry.reason]), [['manual:speed-ci-proofs-live', 'manual:* proofs are not automatable in CI'], ['manual:speed-target-met', 'manual:* proofs are not automatable in CI']]);
  // Until a contract reaches main it is not run as trusted CI; the plan names why, so the producer session covers it.
  assert.match(planCiProofs(['integration:speed-metrics']).deferred[0].reason, /no registered contract; a producer session must run it until one reaches main/);
  // Under GitHub delivery proofs gate nothing: even manual proofs the item marks producer-runnable request no producer.
  let item = await submitted('Manual proofs start at submit', ['src/server/routes/pipeline-speed.ts'], { producerProofs: ['manual:speed-ci-proofs-live', 'manual:speed-target-met'] });
  item = await engine.observe(item.id, item.revision, observed(item, { sha: H, baseSha: B }));
  assert.deepEqual(item.autoDispatch!.producers, []);
  // The workflow: candidate pushes (including Graphyard's own tip publication) plan, exercise in parallel, publish through the CI producer.
  const workflow = await read('.github/workflows/acceptance.yml');
  assert.match(workflow, /pull_request_target:\n\s+types: \[opened, reopened, synchronize\]\n\s+branches: \[main\]/);
  assert.match(workflow, /run: node scripts\/enumerate-ci-proofs\.mjs/);
  assert.match(workflow, /with: \{ node-version: '24', cache: npm \}/, 'npm dependencies are cached');
  assert.match(workflow, /key: docker-image-postgres-17-alpine/, 'the isolated database image is cached');
  assert.match(workflow, /cache-from: type=gha,scope=acceptance-\$\{\{ needs\.plan\.outputs\.pr \}\}/, 'candidate image layers are cached per pull request');
  assert.match(workflow, /include: \$\{\{ fromJSON\(needs\.plan\.outputs\.proofs\) \}\}/, 'one job per proof, in parallel');
  assert.match(workflow, /publish-acceptance\.mjs --candidate-run reports/);
  assert.ok(!/GRAPHYARD_(CI_)?PRODUCER_TOKEN/.test(workflow.slice(workflow.indexOf('  exercise:'), workflow.indexOf('  publish:'))), 'the exercise job holds no producer credential');
  const docs = await read('docs/github.md');
  for (const fragment of ['### Proofs in CI', 'pull_request_target', 'cached', 'Manual proofs stay producer sessions']) assert.ok(docs.includes(fragment), `docs/github.md must say: ${fragment}`);
});

// ---------------------------------------------------------------------------------------------
// AC-4 — overlapping plannedFiles are built concurrently: dispatch is optimistic
// ---------------------------------------------------------------------------------------------

test('integration:speed-conflict-avoidance — an item whose plannedFiles overlap a claimed or unmerged item is dispatchable at once, the loop\'s schedule offers it, and master status records what it runs beside', async () => {
  const live = await claimed('Engine work in flight', ['src/engine.ts', 'src/master.ts']);
  const overlapping = await created('Overlaps the engine', ['src/engine.ts', 'docs/coordination.md']);
  const apart = await created('Touches nothing shared', ['web/pages/speed.tsx']);
  const inFlight = await submitted('Submitted, unmerged', ['docs/coordination.md']);
  const work = await store.list();
  const now = Date.now();
  const schedule = dispatchSchedule(work, now);
  assert.ok(schedule.order.some(item => item.key === overlapping.key) && schedule.order.some(item => item.key === apart.key), 'both are offered');
  assert.equal(schedule.order.find(item => item.key === live.key), undefined, 'a claimed item is not offered');
  assert.doesNotThrow(() => assertDispatchable(overlapping, work, new Date(now).toISOString()));
  assert.doesNotThrow(() => assertDispatchable(apart, work, new Date(now).toISOString()));
  const status = buildMasterStatus({ work, now: new Date(now).toISOString() }, [], [], {}, {}, { pending: [], completed: [] });
  const row = status.work.find(item => item.key === overlapping.key)!;
  assert.deepEqual(row.overlap.concurrent.map(item => [item.key, item.paths]).sort(), [[inFlight.key, ['docs/coordination.md']], [live.key, ['src/engine.ts']]].sort());
  assert.deepEqual(status.work.find(item => item.key === apart.key)!.overlap.concurrent, []);
  const guide = await readMasterGuide();
  for (const fragment of ['## Conflict avoidance', 'optimistic', 'smallest planned scope first']) assert.ok(guide.includes(fragment), `docs/master-agent.md must say: ${fragment}`);
});

// ---------------------------------------------------------------------------------------------
// AC-5 — execution vs wait, rework rounds and submit→merge per item; the target over ten items
// ---------------------------------------------------------------------------------------------

test('integration:speed-metrics — the engine keeps every item\'s timeline through claim, submit, rework, reclaim and resubmit, a blocked report and a requirements revision count as hand-offs, and master status reports execution versus wait, rework rounds and submit→merge per item', async () => {
  let item = await claimed('Measured item', ['src/pipeline-speed.ts']);
  const number = ++pr;
  const attempt = item.pipeline!.attempts[0];
  assert.deepEqual([attempt.epoch, attempt.owner, attempt.end], [1, implementer.id, null]); assert.equal(item.pipeline!.submittedAt, null);
  // A null report is no hand-off; a blocked report is one, and ends its attempt (GY-1008).
  item = await engine.execute(implementer, 'blocked', item.id, { epoch: 1, reason: null }, randomUUID());
  assert.deepEqual(item.pipeline!.interventions, { blocked: 0, requirements: 0 });
  item = await engine.execute(implementer, 'blocked', item.id, { epoch: 1, reason: 'plannedFiles need widening' }, randomUUID());
  assert.deepEqual(item.pipeline!.interventions, { blocked: 1, requirements: 0 });
  assert.equal(item.pipeline!.attempts[0].end, 'released'); assert.ok(item.pipeline!.attempts[0].endedAt);
  item = await engine.execute(operator, 'unblock', item.id, { reason: 'Widened' }, randomUUID());
  item = await engine.execute(implementer, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(implementer, 'workspace', item.id, { epoch: 2, host: 'machine-a', path: `/tmp/speed/${item.id}-2`, branch: `graphyard/${item.key.toLowerCase()}-2` }, randomUUID());
  item = await engine.execute(implementer, 'submit', item.id, { epoch: 2, pr: number }, randomUUID());
  const firstSubmit = item.pipeline!.submittedAt!;
  assert.equal(item.pipeline!.attempts[1].end, 'submitted'); assert.ok(item.pipeline!.attempts[1].endedAt);
  item = await engine.observe(item.id, item.revision, observed(item, { sha: H, baseSha: B }));
  // Rework: the round counts, the resubmission keeps the first submission as the clock start.
  item = await engine.execute(operator, 'rework', item.id, { reason: 'Reviewer finding', previousWorkerStopped: true }, randomUUID());
  assert.equal(item.pipeline!.reworkRounds, 1);
  item = await engine.execute(implementer, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(implementer, 'workspace', item.id, { epoch: 3, host: 'machine-a', path: `/tmp/speed/${item.id}-3`, branch: item.workspaces.at(-1)!.branch }, randomUUID());
  assert.equal(item.pipeline!.attempts.length, 3); assert.equal(item.pipeline!.attempts[2].epoch, 3);
  item = await engine.execute(implementer, 'submit', item.id, { epoch: 3, pr: number }, randomUUID());
  assert.equal(item.pipeline!.submittedAt, firstSubmit); assert.notEqual(item.pipeline!.resubmittedAt, firstSubmit);
  assert.equal(item.pipeline!.attempts[2].end, 'submitted');
  // A requirements revision of an item under way is a hand-off too.
  item = await engine.execute(operator, 'requirements', item.id, { expectedPolicyRevision: item.policyRevision, reason: 'Add a proof', criteria: item.criteria.map(({ id, text, proofs }) => ({ id, text, proofs })), dependencies: [], plannedFiles: item.plannedFiles, exclusiveResources: [], producerProofs: [] }, randomUUID());
  assert.deepEqual(item.pipeline!.interventions, { blocked: 1, requirements: 1 });
  // In flight: execution is the leased time, wait is the rest, submit→merge is not known yet.
  const inFlight = pipelineSpeed(item, Date.now());
  assert.equal(inFlight.measured, true); assert.equal(inFlight.reworkRounds, 1); assert.equal(inFlight.submitToMergeMs, null);
  assert.ok(inFlight.sinceSubmitMs! >= 0 && inFlight.executionMs! >= 0 && inFlight.waitMs! >= 0 && inFlight.openMs === inFlight.executionMs! + inFlight.waitMs!);
  assert.equal(inFlight.routine, false, 'a blocked report and a requirements revision are hand-offs');
  // Delivered: the merge on the repository clock ends the clock.
  const mergedAt = new Date(Date.parse(firstSubmit) + 25 * 60_000).toISOString();
  await store.pool.query("UPDATE work_items SET document=document||$2::jsonb WHERE id=$1", [item.id, JSON.stringify({ stage: 'done', delivery: { mergedAt: new Date(Date.parse(mergedAt) + 5000).toISOString(), mergedAtRepository: mergedAt, repositoryClockOffsetMs: -5000, mergeSha: sha40('9'), authorizationRevision: 1 } })]);
  item = await reload(item);
  const delivered = pipelineSpeed(item, Date.now() + 3_600_000);
  assert.equal(acceptedMergeAt(item), mergedAt);
  assert.equal(delivered.submitToMergeMs, 25 * 60_000); assert.equal(delivered.sinceSubmitMs, null); assert.equal(delivered.mergedAt, mergedAt);
  assert.equal(delivered.executionMs, item.pipeline!.attempts.reduce((total, entry) => total + Date.parse(entry.endedAt!) - Date.parse(entry.claimedAt), 0));
  assert.equal(delivered.openMs, Date.parse(mergedAt) - Date.parse(item.pipeline!.attempts[0].claimedAt));
  // Master status carries the per-item figures and the summary.
  const status = buildMasterStatus({ work: await store.list(), now: new Date().toISOString() }, [], [], {}, {}, { pending: [], completed: [] });
  const open = status.work.find(row => row.key !== item.key && row.stage !== 'done');
  assert.ok(open && 'speed' in open && typeof open.speed.reworkRounds === 'number', 'every open row reports its speed');
  assert.equal(status.speed.measured >= 1, true); assert.ok(status.speed.items.some(entry => entry.key === item.key && entry.submitToMergeMs === 25 * 60_000 && entry.routine === false));
  assert.equal(status.speed.met, null); assert.match(status.speed.reason!, /the target is judged over at least 10/);
  assert.deepEqual(status.speed.target, speedTarget);
  // Lease expiry ends an attempt with the lease's own deadline, whether reconciliation or a replacement claim sees it first.
  let lapsed = await claimed('Lapsed attempt', ['src/pipeline-speed.ts']);
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease,expiresAt}',to_jsonb($2::text)) WHERE id=$1", [lapsed.id, new Date(Date.now() - 60_000).toISOString()]);
  await engine.reconcile();
  lapsed = await reload(lapsed);
  assert.equal(lapsed.pipeline!.attempts[0].end, 'expired'); assert.ok(Date.parse(lapsed.pipeline!.attempts[0].endedAt!) <= Date.now());
  const released = await engine.execute(implementer, 'release', (await claimed('Released attempt')).id, { epoch: 1 }, randomUUID());
  assert.equal(released.pipeline!.attempts[0].end, 'released');
  // A requirements revision is refused while the lease is live, so the attempt it discards has always
  // lapsed: it ends at the lease's deadline, not at the revision instant, and execution stops there.
  let revised = await claimed('Revised under a lapsed lease', ['src/pipeline-speed.ts']);
  const revision = { expectedPolicyRevision: revised.policyRevision, reason: 'Add a proof', criteria: revised.criteria.map(({ id, text, proofs }) => ({ id, text, proofs })), dependencies: [], plannedFiles: revised.plannedFiles, exclusiveResources: [], producerProofs: [] };
  await assert.rejects(engine.execute(operator, 'requirements', revised.id, revision, randomUUID()), /Stop and release the active worker before revising requirements/);
  assert.equal((await reload(revised)).pipeline!.attempts[0].endedAt, null, 'a refused revision ends nothing');
  const deadline = new Date(Date.parse(revised.pipeline!.attempts[0].claimedAt) + 1).toISOString();
  await store.pool.query("UPDATE work_items SET document=jsonb_set(document,'{lease,expiresAt}',to_jsonb($2::text)) WHERE id=$1", [revised.id, deadline]);
  revised = await engine.execute(operator, 'requirements', revised.id, revision, randomUUID());
  assert.equal(revised.lease, null); assert.deepEqual(revised.pipeline!.interventions, { blocked: 0, requirements: 1 });
  assert.deepEqual([revised.pipeline!.attempts[0].end, revised.pipeline!.attempts[0].endedAt], ['expired', deadline]);
  assert.equal(pipelineSpeed(revised, Date.now()).executionMs, 1, 'execution stops at the deadline, not at the revision');
  // Whichever command records a lapse, the attempt never ends after the instant that recorded it.
  const clamped = { pipeline: undefined } as unknown as Work;
  beginAttempt(clamped, { epoch: 1, owner: 'w' }, new Date('2026-09-20T10:00:00Z'));
  endLapsedAttempt(clamped, { epoch: 1, expiresAt: '2026-09-20T10:02:00Z' }, new Date('2026-09-20T10:00:30Z'));
  assert.deepEqual([clamped.pipeline!.attempts[0].end, clamped.pipeline!.attempts[0].endedAt], ['expired', '2026-09-20T10:00:30.000Z']);
  assert.equal(pipelineSpeed(clamped, Date.parse('2026-09-20T10:02:00Z')).executionMs, 30_000);
  endLapsedAttempt(clamped, { epoch: 1, expiresAt: '2026-09-20T10:05:00Z' }, new Date('2026-09-20T10:06:00Z'));
  assert.equal(clamped.pipeline!.attempts[0].endedAt, '2026-09-20T10:00:30.000Z', 'an ended attempt is not reopened');
  // The guides say where to read it.
  const guide = await readMasterGuide();
  for (const fragment of ['## Pipeline speed', 'speed.submitToMerge', 'executionMs', 'waitMs', 'reworkRounds', 'interventions', 'scripts/measure-pipeline-speed.mjs', '30 minutes', '60 minutes']) assert.ok(guide.includes(fragment), `docs/master-agent.md must document: ${fragment}`);
  assert.ok((await read('docs/coordination.md')).includes('## Ship in under thirty minutes'));
  assert.ok((await read('docs/protocol/pipeline-speed.md')).includes('`pipeline`'));
});

function delivered(key: string, submitToMergeMinutes: number, overrides: { reworkRounds?: number; blocked?: number; executionMinutes?: number; mergedAt?: string } = {}): Work {
  const mergedAt = overrides.mergedAt ?? '2026-09-20T12:00:00.000Z';
  const submittedAt = new Date(Date.parse(mergedAt) - submitToMergeMinutes * 60_000).toISOString();
  const claimedAt = new Date(Date.parse(submittedAt) - (overrides.executionMinutes ?? 20) * 60_000).toISOString();
  const pipeline: PipelineTimeline = { attempts: [{ epoch: 1, owner: 'w', claimedAt, endedAt: submittedAt, end: 'submitted' }], submittedAt, resubmittedAt: submittedAt, reworkRounds: overrides.reworkRounds ?? 0, interventions: { blocked: overrides.blocked ?? 0, requirements: 0 } };
  return { id: `id-${key}`, key, stage: 'done', delivery: { mergedAt, mergeSha: sha40('1'), authorizationRevision: 1 }, pipeline, createdAt: claimedAt } as unknown as Work;
}

test('integration:speed-metrics — the periodic measurement summarizes submit→merge p50/p90 over routine deliveries, judges the target only once ten are measured, never counts deliveries that predate the timeline, splits before and after a named delivery, and records the report', async () => {
  // The pure timeline helpers behind the engine hooks.
  const probe = { key: 'GY-p', stage: 'build', submission: null, lease: null } as unknown as Work;
  beginAttempt(probe, { epoch: 1, owner: 'w' }, new Date('2026-09-20T10:00:00Z'));
  beginAttempt(probe, { epoch: 2, owner: 'w' }, new Date('2026-09-20T10:10:00Z'));
  assert.deepEqual(probe.pipeline!.attempts.map(entry => [entry.epoch, entry.end]), [[1, 'expired'], [2, null]], 'a claim over a still-open attempt closes it as expired');
  endAttempt(probe, 2, 'released', '2026-09-20T09:00:00Z');
  assert.equal(probe.pipeline!.attempts[1].endedAt, '2026-09-20T10:10:00.000Z', 'an end before the claim is clamped to the claim');
  endAttempt(probe, 2, 'expired', new Date('2026-09-20T11:00:00Z'));
  assert.equal(probe.pipeline!.attempts[1].end, 'released', 'a second end is ignored');
  recordRework(probe, new Date('2026-09-20T11:00:00Z')); recordIntervention(probe, 'requirements');
  assert.equal(probe.pipeline!.reworkRounds, 0, 'rework before any submission is not a rework round'); assert.equal(probe.pipeline!.interventions.requirements, 1);
  (probe as any).submission = { epoch: 2, pr: 1 }; recordSubmission(probe, 2, new Date('2026-09-20T11:30:00Z')); recordRework(probe, new Date('2026-09-20T12:00:00Z'));
  assert.equal(probe.pipeline!.reworkRounds, 1);
  assert.deepEqual(pipelineSpeed({ key: 'GY-legacy', stage: 'done', delivery: { mergedAt: '2026-09-20T12:00:00Z' } } as unknown as Work, Date.now()).measured, false);
  assert.deepEqual(nearestRankPercentiles([50, 10, 40, 20, 30]), { count: 5, p50Ms: 30, p90Ms: 50 });
  assert.deepEqual(nearestRankPercentiles([]), { count: 0, p50Ms: 0, p90Ms: 0 });

  const now = Date.parse('2026-09-21T00:00:00Z');
  const routine = Array.from({ length: 10 }, (_, i) => delivered(`GY-${100 + i}`, 12 + i * 2, { mergedAt: new Date(Date.parse('2026-09-20T12:00:00Z') + i * 60_000).toISOString() }));
  const slow = delivered('GY-200', 240, { reworkRounds: 3, blocked: 1, mergedAt: '2026-09-20T12:30:00.000Z' });
  const legacy = { id: 'legacy', key: 'GY-1', stage: 'done', delivery: { mergedAt: '2026-09-20T11:00:00.000Z', mergeSha: sha40('2'), authorizationRevision: 1 } } as unknown as Work;
  const openItem = { id: 'open', key: 'GY-300', stage: 'review', pipeline: routine[0].pipeline } as unknown as Work;
  const summary = pipelineSpeedSummary([...routine, slow, legacy, openItem], now);
  assert.equal(summary.measured, 11); assert.equal(summary.unmeasured, 1, 'the legacy delivery is reported, never counted');
  assert.equal(summary.routine.count, 10);
  assert.deepEqual(summary.routine.submitToMerge, { count: 10, p50Ms: 20 * 60_000, p90Ms: 28 * 60_000 });
  assert.deepEqual(summary.submitToMerge, { count: 11, p50Ms: 22 * 60_000, p90Ms: 30 * 60_000 });
  assert.deepEqual(summary.reworkRounds, { median: 0, p90: 0, distribution: { '0': 10, '2+': 1 } });
  assert.deepEqual(summary.interventions, { items: 1, blocked: 1, requirements: 0 });
  assert.equal(summary.execution.totalMs, 11 * 20 * 60_000); assert.ok(summary.execution.share! > 0 && summary.execution.share! < 1);
  assert.equal(summary.met, true); assert.equal(summary.reason, null);
  assert.deepEqual(summary.items.map(entry => entry.key).slice(0, 3), ['GY-100', 'GY-101', 'GY-102'], 'items are ordered by merge time');
  // Nine routine deliveries judge nothing; a slow tenth misses with the reason.
  const nine = pipelineSpeedSummary(routine.slice(1), now);
  assert.equal(nine.met, null); assert.match(nine.reason!, /9 routine deliveries measured; the target is judged over at least 10/);
  const missed = pipelineSpeedSummary([...routine.slice(2), delivered('GY-201', 200), delivered('GY-202', 90)], now);
  assert.equal(missed.met, false); assert.match(missed.reason!, /p90 90 min exceeds 60 min/);
  assert.equal(pipelineSpeedSummary([...routine.slice(1), delivered('GY-201', 200)], now).met, true, 'one outlier in ten is inside the p90');
  const reworked = pipelineSpeedSummary(routine.map(item => ({ ...item, pipeline: { ...item.pipeline!, reworkRounds: 1 } }) as Work).concat(slow, delivered('GY-202', 10, { reworkRounds: 1 })), now);
  assert.equal(reworked.reworkRounds.median, 1); assert.equal(reworked.met, true, 'a median of one rework round is within target');
  // Windows and splits: the measurement script reports before and after a delivery landed.
  assert.equal(pipelineSpeedSummary([...routine, slow], now, { until: '2026-09-20T12:05:00Z' }).measured, 5);
  const report = measure([...routine, slow, legacy], now, parseArguments(['--split', 'GY-104,GY-300', '--since', '2026-09-20T00:00:00Z']), pipelineSpeedSummary);
  assert.equal(report.overall.measured, 11);
  assert.deepEqual(report.splits.map((split: any) => [split.key, split.before?.measured ?? null, split.after?.measured ?? null, split.reason]), [['GY-104', 4, 7, null], ['GY-300', null, null, 'GY-300 is not a work item']]);
  assert.match(render(report), /^Overall: 11 measured \(10 routine, 1 unmeasured\); submit→merge p50 22 min p90 30 min; routine p50 20 min p90 28 min; rework median 0 p90 0; hand-offs on 1 item\(s\); execution share \d+%; target met/);
  assert.throws(() => parseArguments(['--since', 'yesterday']), /ISO 8601/); assert.throws(() => parseArguments(['--bogus']), /Unknown argument/);
  // The script end to end against a snapshot server, recording the report.
  const snapshot = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/work-snapshot' && req.headers.authorization === 'Bearer reader-token') return res.end(JSON.stringify({ now: new Date(now).toISOString(), work: [...routine, slow, legacy] }));
    res.statusCode = 401; res.end('{}');
  });
  await new Promise<void>(resolve => snapshot.listen(0, '127.0.0.1', resolve));
  const directory = await temporaryDirectory('speed-measure');
  const previous = { url: process.env.GRAPHYARD_URL, token: process.env.GRAPHYARD_TOKEN, file: process.env.GRAPHYARD_TOKEN_FILE };
  const logged: string[] = []; const log = console.log;
  try {
    process.env.GRAPHYARD_URL = `http://127.0.0.1:${(snapshot.address() as any).port}`; process.env.GRAPHYARD_TOKEN = 'reader-token'; delete process.env.GRAPHYARD_TOKEN_FILE;
    console.log = (line: string) => { logged.push(String(line)); };
    const recorded = await measureMain(['--record', directory, '--split', 'GY-104']);
    assert.equal(recorded.overall.met, true); assert.equal(recorded.splits[0].after.measured, 7);
    const files = await readdir(directory);
    assert.equal(files.length, 1); assert.deepEqual(JSON.parse(await readFile(join(directory, files[0]), 'utf8')).overall, recorded.overall);
    assert.match(logged.join('\n'), /Overall: 11 measured/); assert.match(logged.join('\n'), /GY-104 landed/);
    process.env.GRAPHYARD_TOKEN = 'wrong';
    await assert.rejects(measureMain([]), /refused the work snapshot \(401\)/);
  } finally {
    console.log = log;
    process.env.GRAPHYARD_URL = previous.url; process.env.GRAPHYARD_TOKEN = previous.token; if (previous.file) process.env.GRAPHYARD_TOKEN_FILE = previous.file;
    if (previous.url === undefined) delete process.env.GRAPHYARD_URL; if (previous.token === undefined) delete process.env.GRAPHYARD_TOKEN;
    await new Promise<void>(resolve => snapshot.close(() => resolve())); await rm(directory, { recursive: true, force: true });
  }
  // The live measurement for manual:speed-target-met reads the same summary from master status.
  assert.ok((await readMasterGuide()).includes('manual:speed-target-met') || (await read('docs/coordination.md')).includes('at least ten'), 'the guides say how the target is judged');
});

// ---------------------------------------------------------------------------------------------
// GY-1382 — the stage that holds ready→merged and merged→production
// ---------------------------------------------------------------------------------------------
const hourMs = 3_600_000, stageNow = Date.parse('2026-10-06T12:00:00.000Z');
const ago = (hours: number) => new Date(stageNow - hours * hourMs).toISOString();
type StageFixture = { key: string; ready: number; claim: number; submit: number; merged: number; promoted: number | null; moves: [number, DeliveryStageMove['to']][] };
/** One item's path as hours ago: ready, first claim, first submit, the step moves, the merge and the promotion. */
function stageItem(fixture: StageFixture): Work {
  return { id: `id-${fixture.key}`, key: fixture.key, stage: 'done', createdAt: ago(fixture.ready),
    delivery: { mergedAt: ago(fixture.merged), mergeSha: sha40(fixture.key), authorizationRevision: 1 },
    releaseDeliveries: fixture.promoted === null ? [] : [{ environment: 'production', policyRevision: 1, releaseId: 'r', releaseRevision: 1, generation: 1, verifiedAt: ago(fixture.promoted), interval: { from: ago(fixture.merged), to: ago(fixture.promoted) } }] } as unknown as Work;
}
/** A slow review: submitted, CI, review with a rework round, proof, merge, and promotion. */
const reviewHeld = (key: string, reviewHours: number, promoted: number | null = 0.5): StageFixture => {
  const submit = 12 + reviewHours;
  return { key, ready: submit + 3, claim: submit + 2, submit, merged: 1, promoted, moves: [
    [submit + 2, 'build'], [submit - 0.25, 'validate'], [submit - 0.5, 'review'], [submit - 0.5 - reviewHours / 2, 'build'], [submit - 1 - reviewHours / 2, 'validate'],
    [submit - 1.5 - reviewHours / 2, 'review'], [3, 'prove'], [2, 'merge'], [1, 'deploy']] };
};
/** The reads master status makes, served from fixtures: ready, claim and submit events, and the steps drill-down two items a page. */
function stageMaster(fixtures: StageFixture[], calls: string[] = []) {
  return async (path: string) => {
    calls.push(path);
    const params = new URLSearchParams(path.slice(path.indexOf('?') + 1));
    if (path.startsWith('events?')) {
      const kinds = (params.get('kind') ?? '').split(',');
      const events = fixtures.flatMap(f => [['ready', f.ready], ['claim', f.claim], ['submit', f.submit]].filter(([kind]) => kinds.includes(kind as string))
        .map(([kind, hours]) => ({ work_id: `id-${f.key}`, kind, created_at: ago(hours as number) })));
      return { events: events.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)), page: { hasMore: false, nextCursor: null } };
    }
    if (path.startsWith('analytics/flow/drilldown?')) {
      assert.equal(params.get('metric'), 'steps');
      const [instant, cursor] = (params.get('key') ?? '').split(' ');
      const ordered = [...fixtures].sort((a, b) => a.key.localeCompare(b.key));
      const start = cursor ? ordered.findIndex(f => f.key === cursor.slice('after:'.length)) + 1 : 0, page = ordered.slice(start, start + 2);
      const rows = page.flatMap(f => f.moves.filter(([hours]) => Date.parse(ago(hours)) >= Date.parse(instant)).map(([hours, to]) => ({ workKey: f.key, bucket: to, observedAt: ago(hours), detail: `x to ${to}` })));
      return { rows, next: start + 2 < ordered.length ? `${instant} after:${page.at(-1)!.key}` : null, coverage: { truncated: false, toCovered: ago(0), statement: null } };
    }
    throw new Error(`unexpected read ${path}`);
  };
}
const noSections = { mark: (section: string, route: string | null, error: unknown) => { if (section !== 'rework causes') throw new Error(`${section} ${route}: ${error}`); } };

test('unit:delivery-stage-breakdown — master status reports p50 and p90 per stage over 24 hours and 7 days, and one item\'s stages sum to its ready→production time', async () => {
  // One item, hour by hour: ready 0, claim 1, submit 3; CI to 3.5, review to 5, rework to 6, CI to 6.5, review to 7, proof to 8, merge at 9; promoted at 12.
  const at = (hours: number) => hours * hourMs;
  const moves: DeliveryStageMove[] = [[0.5, 'outside'], [1, 'build'], [3.1, 'validate'], [3.3, 'test'], [3.5, 'review'], [5, 'build'], [5.5, 'outside'], [6, 'validate'], [6.5, 'review'], [7, 'prove'], [8, 'merge'], [9, 'deploy']]
    .map(([hours, to]) => ({ at: at(hours as number), to: to as DeliveryStageMove['to'] }));
  const one = flowAnalytics.itemDeliveryStages({ readyAt: 0, claimedAt: at(1), submittedAt: at(3), mergedAt: at(9), promotedAt: at(12), moves });
  assert.deepEqual(one, { ready: at(1), implementation: at(2), build: at(1), review: at(3), proof: at(1), merge: at(1), production: at(3) });
  assert.equal(flowAnalytics.deliveryStages.reduce((sum, stage) => sum + one[stage]!, 0), at(12), 'the stages partition ready→production');
  // Out-of-order instants are clamped between their neighbours, so the stages still sum exactly.
  const skewed = flowAnalytics.itemDeliveryStages({ readyAt: at(2), claimedAt: at(1), submittedAt: at(10), mergedAt: at(9), promotedAt: at(8), moves });
  assert.equal(flowAnalytics.deliveryStages.reduce((sum, stage) => sum + skewed[stage]!, 0), at(7));
  assert.equal(skewed.production, 0);
  // Pending promotion: the pre-merge stages sum to ready→merged and production is pending.
  const pending = flowAnalytics.itemDeliveryStages({ readyAt: 0, claimedAt: at(1), submittedAt: at(3), mergedAt: at(9), promotedAt: null, moves });
  assert.equal(pending.production, null);
  assert.equal(flowAnalytics.deliveryStages.reduce((sum, stage) => sum + (pending[stage] ?? 0), 0), at(9));

  // Over the board, through master status's own reads: three items in the last day, one two days ago.
  const fixtures = [reviewHeld('GY-901', 4), reviewHeld('GY-902', 8), reviewHeld('GY-903', 2, null), { ...reviewHeld('GY-904', 6), ready: 60, claim: 59, submit: 58, merged: 48, promoted: 47,
    moves: [[57.75, 'validate'], [57, 'review'], [50, 'prove'], [49, 'merge'], [48, 'deploy']] as StageFixture['moves'] }];
  const calls: string[] = [];
  const work = [...fixtures.map(stageItem), { ...stageItem({ ...reviewHeld('GY-905', 1), submit: 0 }), stage: 'build', delivery: undefined } as unknown as Work];
  const { report } = await flowAnalytics.speedSections({}, stageMaster(fixtures, calls), { work, now: new Date(stageNow).toISOString() }, { root: await temporaryDirectory('delivery-stages'), sections: noSections });
  assert.ok(calls.some(path => path.startsWith('events?') && new URLSearchParams(path.slice(7)).get('kind') === 'claim,submit'), 'first claims and submits are read');
  assert.equal(calls.filter(path => path.startsWith('analytics/flow/drilldown?')).length, 2, 'the steps drill-down is paged to its end');
  const stages = report.stages!;
  assert.deepEqual(Object.keys(stages.windows), ['24h', '7d']);
  assert.deepEqual(Object.keys(stages.windows['7d'].stages), ['ready', 'implementation', 'build', 'review', 'proof', 'merge', 'production']);
  assert.deepEqual({ measured: stages.windows['24h'].measured, unmeasured: stages.windows['24h'].unmeasured }, { measured: 3, unmeasured: 0 });
  assert.equal(stages.windows['7d'].measured, 4);
  // Review with its rework round is 10h, 12h and 16h over the last day (8h waiting plus the round); GY-904 adds 7h over the week.
  const review = (window: '24h' | '7d') => ({ count: stages.windows[window].stages.review.count, p50: stages.windows[window].stages.review.p50Ms! / hourMs, p90: stages.windows[window].stages.review.p90Ms! / hourMs });
  assert.deepEqual(review('24h'), { count: 3, p50: 12, p90: 15.2 });
  assert.deepEqual(review('7d'), { count: 4, p50: 11, p90: 14.8 });
  assert.deepEqual({ ready: stages.windows['24h'].stages.ready.p50Ms, implementation: stages.windows['24h'].stages.implementation.p50Ms, build: stages.windows['24h'].stages.build.p50Ms }, { ready: hourMs, implementation: 2 * hourMs, build: hourMs });
  // The pending promotion has no production time; the promoted ones took 0.5h.
  assert.deepEqual({ count: stages.windows['24h'].stages.production.count, p90: stages.windows['24h'].stages.production.p90Ms }, { count: 2, p90: 0.5 * hourMs });
  // Every promoted item's stages sum to its ready→production time.
  for (const fixture of fixtures.filter(f => f.promoted !== null)) {
    const own = flowAnalytics.itemDeliveryStages({ readyAt: Date.parse(ago(fixture.ready)), claimedAt: Date.parse(ago(fixture.claim)), submittedAt: Date.parse(ago(fixture.submit)), mergedAt: Date.parse(ago(fixture.merged)),
      promotedAt: Date.parse(ago(fixture.promoted!)), moves: fixture.moves.map(([hours, to]) => ({ at: Date.parse(ago(hours)), to })) });
    assert.equal(flowAnalytics.deliveryStages.reduce((sum, stage) => sum + own[stage]!, 0), (fixture.ready - fixture.promoted!) * hourMs, fixture.key);
  }
  // An item whose first submit was never read is unmeasured and said so, never guessed.
  const partial = flowAnalytics.deliveryStageBreakdown(fixtures.map(stageItem), { claimedAt: new Map(fixtures.map(f => [`id-${f.key}`, ago(f.claim)])), submittedAt: new Map([[`id-GY-901`, ago(fixtures[0].submit)]]),
    moves: new Map(fixtures.map(f => [f.key, f.moves.map(([hours, to]) => ({ at: Date.parse(ago(hours)), to }))])), movesCoveredUntil: stageNow, movesFrom: 0 }, { now: stageNow });
  assert.deepEqual({ measured: partial.windows['7d'].measured, unmeasured: partial.windows['7d'].unmeasured }, { measured: 1, unmeasured: 3 });
  assert.match(partial.statements.join(' '), /3 items merged over 7 days have no stage breakdown/);
});

test('unit:delivery-dominant-stage — the delivery-speed attention names the stage holding the largest share of the p90 and the items most delayed in it, and its next step names that stage', async () => {
  // Ten items whose review rounds hold them 1–10h, against 1h ready, 2h implementation, 1h build, 1h proof and 1h merge each.
  const fixtures = Array.from({ length: 10 }, (_, index) => reviewHeld(`GY-${910 + index}`, index + 1));
  const { report, attention } = await flowAnalytics.speedSections({}, stageMaster(fixtures), { work: fixtures.map(stageItem), now: new Date(stageNow).toISOString() }, { root: await temporaryDirectory('delivery-dominant'), sections: noSections });
  const dominant = report.stages!.dominant.readyToMerged!;
  assert.equal(dominant.stage, 'review');
  assert.deepEqual(dominant.items.map(item => item.key), ['GY-919', 'GY-918', 'GY-917']);
  assert.equal(attention.length, 1);
  assert.match(attention[0].text, /^Ready→merged into main p90 is .* above the 2h target; slowest: GY-919 .*; the largest share of the p90 is held in review \(with rework rounds\) \(\d+% of the slowest tenth's time\), most delayed there: GY-919 \d+(\.\d)?h, GY-918/);
  assert.match(attention[0].next, /^Remove what holds items in review \(with rework rounds\): find what held GY-919, GY-918, GY-917 there/);
  // A different hold is named as such: the same items waiting for a claim instead.
  const unclaimed = fixtures.map((fixture, index) => ({ ...fixture, ready: fixture.ready + 10 * (index + 1) }));
  const waiting = await flowAnalytics.speedSections({}, stageMaster(unclaimed), { work: unclaimed.map(stageItem), now: new Date(stageNow).toISOString() }, { root: await temporaryDirectory('delivery-dominant'), sections: noSections });
  assert.equal(waiting.report.stages!.dominant.readyToMerged!.stage, 'ready' satisfies DeliveryStage);
  assert.deepEqual(waiting.report.stages!.dominant.readyToMerged!.items.map(item => item.key), ['GY-919', 'GY-918', 'GY-917']);
  assert.match(waiting.attention[0].next, /^Remove what holds items in ready \(until claim\)/);
  // Merged→production is one stage: its breach names it with the items longest awaiting promotion.
  const slowPromotion = fixtures.map(fixture => ({ ...fixture, ready: fixture.ready + 30, claim: fixture.claim + 30, submit: fixture.submit + 30, merged: 31, moves: fixture.moves.map(([hours, to]) => [hours + 30, to] as [number, DeliveryStageMove['to']]) }));
  const promotion = await flowAnalytics.speedSections({}, stageMaster(slowPromotion), { work: slowPromotion.map(stageItem), now: new Date(stageNow).toISOString() }, { root: await temporaryDirectory('delivery-dominant'), sections: noSections });
  assert.match(promotion.attention.find(item => item.text.startsWith('Merged→promoted'))!.text, /held in merged→production \(100% of the slowest tenth's time\), most delayed there: GY-910 30\.5h/);
  // Without a stage breakdown (its reads failed), the line stays the slowest items alone.
  const plain = flowAnalytics.deliverySpeed(fixtures.map(stageItem), { now: stageNow });
  assert.equal(flowAnalytics.deliverySpeedBreaches(plain)[0].stage, null);
  assert.doesNotMatch(flowAnalytics.deliverySpeedBreaches(plain)[0].text, /largest share/);
});
