import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
// @ts-expect-error Dependency-free protected workflow script.
import { planCiProofs } from '../scripts/contracts.mjs';
// @ts-expect-error Dependency-free measurement script.
import { measure, parseArguments, render, main as measureMain } from '../scripts/measure-pipeline-speed.mjs';

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
  database = new EmbeddedPostgres({ databaseDir: await mkdtemp(join(tmpdir(), 'graphyard-pipeline-speed-')), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
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
  return { candidate: { ...candidate, pr: item.submission!.pr, branch: item.workspaces[0].branch, author: 'implementer' }, checks: [{ name: 'test', result: 'success', appId: 15368 }, { name: 'typecheck', result: 'success', appId: 15368 }], reviews: [], merged: false, mergeSha: null, mergeable: true, protected: true,
    files: ['src/pipeline-speed.ts'], scopeFiles: [scoped('src/pipeline-speed.ts', { baseSha: undefined })], at: new Date().toISOString(), prState: 'open', draft: false, baseTip: candidate.baseSha, baseTree: sha40('7b'), baseTipContained: true, ...extra };
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
  const root = await mkdtemp(join(tmpdir(), 'graphyard-speed-sync-'));
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
    res.end(JSON.stringify([item, shipped]));
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

test('integration:speed-auto-dispatch — one passing observation records the review request and one producer request per proof group on the exact head in the same transaction, a single dispatcher tick launches the reviewer and every producer together within the 30-second bound, and no master command is involved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-speed-dispatch-'));
  try {
    let item = await submitted('Auto-dispatched head', ['src/pipeline-speed.ts'], { producerProofs: ['manual:speed-target-met'] });
    assert.equal(item.autoDispatch?.review, null); assert.equal(item.autoDispatch?.producers.length, 0);
    const submittedAt = Date.now();
    item = await engine.observe(item.id, item.revision, observed(item, { sha: H, baseSha: B }));
    assert.ok(item.gates.find(gate => gate.name === 'build')!.passed);
    const review = item.autoDispatch!.review!;
    assert.deepEqual([review.state, review.sha, review.baseSha, review.policyRevision, review.pr], ['requested', H, B, item.policyRevision, item.submission!.pr]);
    assert.deepEqual(item.autoDispatch!.producers.map(request => [request.group, request.sha, request.state]), [['unit', H, 'requested'], ['integration', H, 'requested'], ['manual', H, 'requested']]);
    assert.deepEqual(item.autoDispatch!.producers.map(request => request.proofs), [['unit:speed-scope-diff'], ['integration:speed-regression-guard', 'integration:speed-auto-dispatch', 'integration:speed-reconcile-latency', 'integration:speed-ci-proofs', 'integration:speed-metrics'], ['manual:speed-target-met']]);
    const requested = await events(item, 'dispatch.requested');
    assert.equal(requested.length, 4); assert.ok(requested.every(event => event.actor === 'graphyard'), 'the control plane itself records the requests');
    assert.ok(requested.every(event => event.payload.details.sha === H && event.payload.details.baseSha === B));
    assert.ok((await store.events(item.id)).every(event => event.actor !== coordinator.id), 'no coordinator command touched the item');
    // The dispatcher: one tick, every request launched in parallel, each profile bound to its group.
    const token = join(directory, 'coordinator.token'); await writeFile(token, 'coordinator-token-'.padEnd(40, 'x'), { mode: 0o600 });
    const log: Parameters<typeof stubEffects>[1] = [];
    const current = item;
    const tick = await runDispatchTick(masterConfig(token), emptyDispatchCursor(masterConfig(token)), stubEffects(() => [current], log), () => Date.now());
    assert.equal(tick.launched.length, 4); assert.deepEqual(tick.refused, []); assert.deepEqual(tick.waiting, []);
    assert.deepEqual(log.map(entry => [entry.kind, entry.group, entry.profile]).sort(), [['producer', 'integration', 'producer-integration'], ['producer', 'manual', 'producer-manual'], ['producer', 'unit', 'producer-unit'], ['review', null, 'claude-reviewer']]);
    assert.ok(log.every(entry => entry.sha === H && entry.key === item.key), 'every session is launched on the exact head');
    assert.ok(Math.max(...log.map(entry => entry.at)) - submittedAt < 30_000, 'observation to every launch fits the 30-second bound');
    // A head change cancels the whole set and requests the new head afresh, still without a master.
    item = await engine.observe(item.id, item.revision, observed(item, { sha: H2, baseSha: B }));
    assert.equal(item.autoDispatch!.review!.sha, H2); assert.ok(item.autoDispatch!.producers.every(request => request.sha === H2));
    assert.equal((await events(item, 'dispatch.cancelled')).length, 4);
    // Trusted evidence for every proof of a group satisfies its request; the master routes nothing.
    for (const proof of ['unit:speed-scope-diff']) item = await engine.execute(producer, 'evidence', item.id, { proof, sha: H2, baseSha: B, policyRevision: item.policyRevision, result: 'pass', executed: 3, skipped: 0 }, randomUUID());
    assert.deepEqual(item.autoDispatch!.producers.map(request => request.group), ['integration', 'manual']);
    assert.match((await events(item, 'dispatch.satisfied')).at(-1)!.payload.details.resolution, /trusted passing evidence binds every proof: unit:speed-scope-diff \(proof-runner\)/);
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
  // The server's own loop: a 2-second tick over the store's cadence, four jobs per tick.
  const main = await read('src/server/main.ts');
  const interval = Number(main.match(/\}, (\d+)\);\s*\n\s*http\.listen/)?.[1]);
  assert.ok(interval > 0 && interval <= 60_000, `the reconciliation tick is ${interval} ms`);
  assert.match(main, /Array\.from\(\{ length: 4 \}, \(\) => processJob\(engine, github\)\)/);
  assert.match(await read('docs/protocol/github-webhook.md'), /wakes durable jobs/);
});

// ---------------------------------------------------------------------------------------------
// AC-3 — automatable proofs run as trusted CI on the published tip; manual proofs start at submit
// ---------------------------------------------------------------------------------------------

test('integration:speed-ci-proofs — every unit:* and integration:* proof an item requires is planned for the trusted CI lane from the protected registry, the manual ones are left to the producer session the control plane requests at submit, and the workflow caches dependencies, the database image and the candidate layers', async () => {
  const proofs = criteria.flatMap(criterion => criterion.proofs);
  const registry = Object.fromEntries(proofs.filter(proof => !proof.startsWith('manual:')).map(proof => [proof, { kind: proof.startsWith('unit:') ? 'unit' : 'integration', source: 'scripts/contracts.mjs' }]));
  const plan = planCiProofs(proofs, registry);
  assert.deepEqual(plan.runnable.map((entry: any) => entry.proof), proofs.filter(proof => !proof.startsWith('manual:')));
  assert.deepEqual(plan.deferred.map((entry: any) => [entry.proof, entry.reason]), [['manual:speed-ci-proofs-live', 'manual:* proofs are not automatable in CI'], ['manual:speed-target-met', 'manual:* proofs are not automatable in CI']]);
  // Until a contract reaches main it is not run as trusted CI; the plan names why, so the producer session covers it.
  assert.match(planCiProofs(['integration:speed-metrics']).deferred[0].reason, /no registered contract; a producer session must run it until one reaches main/);
  // The manual proofs the item marks producer-runnable are requested the moment the build gate passes.
  let item = await submitted('Manual proofs start at submit', ['src/pipeline-speed.ts'], { producerProofs: ['manual:speed-ci-proofs-live', 'manual:speed-target-met'] });
  item = await engine.observe(item.id, item.revision, observed(item, { sha: H, baseSha: B }));
  const manual = item.autoDispatch!.producers.find(request => request.group === 'manual')!;
  assert.deepEqual(manual.proofs, ['manual:speed-ci-proofs-live', 'manual:speed-target-met']); assert.equal(manual.sha, H);
  assert.ok(Date.now() - Date.parse(manual.requestedAt) < 30_000);
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

test('integration:speed-ci-proofs — a published queue tip is committed onto the pull-request branch, which is the push the trusted workflow runs on, so the proofs certify the exact tip the queue will land', async () => {
  const adapter = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'not-used-in-adapter-test' });
  adapter.controlPlaneLogin = async () => 'graphyard-owner-repo[bot]';
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const predictedBase = sha40('c'), tip = sha40('d');
  adapter.request = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (path === '/pulls/10') return { number: 10, state: 'open', draft: false, head: { sha: H, ref: 'graphyard/gy-54-1', repo: { full_name: 'owner/repo' } }, base: { ref: 'main', sha: B } };
    if (path === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: B } };
    if (/^\/commits\/[a-f0-9]{40}$/.test(path)) return { sha: path.slice(9), commit: { tree: { sha: `f${path.slice(10)}` }, author: { email: '1+graphyard-owner-repo[bot]@users.noreply.github.com' } }, parents: [{ sha: H }, { sha: predictedBase }], author: { login: 'graphyard-owner-repo[bot]', type: 'Bot' } };
    if (path.startsWith('/compare/')) return { status: 'ahead', files: [] };
    if (path === '/merges') return { sha: tip };
    if (path.startsWith('/git/')) return { id: 1 };
    throw new Error(`Unexpected request ${path}`);
  };
  const work = { id: 'w', key: 'GY-54', policy: { review: true, checks: ['test'] }, plannedFiles: ['src/'], submission: { pr: 10, epoch: 1 }, candidate: { sha: H, baseSha: B, pr: 10 }, policyRevision: 1, revision: 3, gates: [], violations: [], queue: { sequence: 2, enqueuedAt: new Date().toISOString(), policyRevision: 1, speculation: null } } as unknown as Work;
  const speculation = await adapter.publishSpeculativeTip(work, { id: 'w', key: 'GY-54', position: 2, size: 2, sequence: 2, enqueuedAt: new Date().toISOString(), waitMs: 0, predecessors: ['GY-53'], predictedBase, tip: null, base: { sha: B, tree: `f${B.slice(1)}` }, binding: null, current: false, publishable: true, reasons: [] } as any);
  assert.equal(speculation.tip, tip);
  const merge = calls.find(call => call.path === '/merges')!;
  assert.deepEqual(merge.body, { base: 'graphyard/gy-54-1', head: predictedBase, commit_message: 'Graphyard speculative tip for GY-54 behind GY-53' }, 'the tip is a commit on the PR branch: GitHub fires pull_request_target synchronize for it');
  assert.equal(calls.find(call => call.path === '/git/refs/graphyard/queue/gy-54')?.method, 'PATCH');
  assert.match(await read('docs/github.md'), /pushed onto the candidate branch|committed onto the pull-request branch/);
});

// ---------------------------------------------------------------------------------------------
// AC-4 — overlapping plannedFiles are not built concurrently unless an operator overrides
// ---------------------------------------------------------------------------------------------

test('integration:speed-conflict-avoidance — an item whose plannedFiles overlap a claimed or unmerged item is held from dispatch with the item ahead named in master status, the loop\'s schedule holds it, and only the operator\'s --allow-overlap dispatches over it', async () => {
  const live = await claimed('Engine work in flight', ['src/engine.ts', 'src/master.ts']);
  const held = await created('Overlaps the engine', ['src/engine.ts', 'docs/coordination.md']);
  const apart = await created('Touches nothing shared', ['web/pages/speed.tsx']);
  const inFlight = await submitted('Submitted, unmerged', ['docs/coordination.md']);
  const work = await store.list();
  const now = Date.now();
  const schedule = dispatchSchedule(work, now);
  const entry = (key: string) => schedule.order.find(item => item.key === key)!;
  assert.equal(entry(held.key).held, true); assert.equal(entry(apart.key).held, false);
  assert.equal(schedule.order.find(item => item.key === live.key), undefined, 'a claimed item is not offered');
  const hold = schedule.held.find(item => item.key === held.key)!;
  assert.deepEqual(hold.ahead.map(item => [item.key, item.paths]).sort(), [[inFlight.key, ['docs/coordination.md']], [live.key, ['src/engine.ts']]].sort());
  assert.match(hold.reason, /Held by planned-file overlap/); assert.match(hold.reason, /--allow-overlap to override/);
  assert.throws(() => assertDispatchable(held, work, new Date(now).toISOString()), new RegExp(`held by planned-file overlap with .*${live.key} \\(claimed, build\\) on src/engine\\.ts`));
  assert.doesNotThrow(() => assertDispatchable(held, work, new Date(now).toISOString(), { allowOverlap: true }));
  assert.doesNotThrow(() => assertDispatchable(apart, work, new Date(now).toISOString()));
  const status = buildMasterStatus({ work, now: new Date(now).toISOString() }, [], [], {}, {}, { pending: [], completed: [] });
  const row = status.work.find(item => item.key === held.key)!;
  assert.equal(row.overlap.held, true); assert.deepEqual(row.overlap.ahead.map(item => item.key).sort(), [inFlight.key, live.key].sort()); assert.match(row.overlap.reason!, /--allow-overlap/);
  assert.equal(status.work.find(item => item.key === apart.key)!.overlap.held, false);
  assert.deepEqual(status.schedule.held.map(item => item.key), [held.key]);
  // Once the items ahead are out of the way the hold lifts on its own.
  await store.pool.query("UPDATE work_items SET document=document||$2::jsonb WHERE id=$1", [inFlight.id, JSON.stringify({ stage: 'done', delivery: { mergedAt: new Date().toISOString(), mergeSha: sha40('1f'), authorizationRevision: 1 } })]);
  await engine.execute(implementer, 'release', live.id, { epoch: live.epoch }, randomUUID());
  assert.equal(dispatchSchedule(await store.list(), Date.now()).held.length, 0);
  const guide = await read('docs/master-agent.md');
  for (const fragment of ['## Conflict avoidance', '--allow-overlap', 'smallest planned scope first']) assert.ok(guide.includes(fragment), `docs/master-agent.md must say: ${fragment}`);
});

// ---------------------------------------------------------------------------------------------
// AC-5 — execution vs wait, rework rounds and submit→merge per item; the target over ten items
// ---------------------------------------------------------------------------------------------

test('integration:speed-metrics — the engine keeps every item\'s timeline through claim, submit, rework, reclaim and resubmit, a blocked report and a requirements revision count as hand-offs, and master status reports execution versus wait, rework rounds and submit→merge per item', async () => {
  let item = await claimed('Measured item', ['src/pipeline-speed.ts']);
  const number = ++pr;
  const attempt = item.pipeline!.attempts[0];
  assert.deepEqual([attempt.epoch, attempt.owner, attempt.end], [1, implementer.id, null]); assert.equal(item.pipeline!.submittedAt, null);
  // A blocked report is a hand-off; clearing it is not.
  item = await engine.execute(implementer, 'blocked', item.id, { epoch: 1, reason: 'plannedFiles need widening' }, randomUUID());
  item = await engine.execute(implementer, 'blocked', item.id, { epoch: 1, reason: null }, randomUUID());
  assert.deepEqual(item.pipeline!.interventions, { blocked: 1, requirements: 0 });
  item = await engine.execute(implementer, 'submit', item.id, { epoch: 1, pr: number }, randomUUID());
  const firstSubmit = item.pipeline!.submittedAt!;
  assert.equal(item.pipeline!.attempts[0].end, 'submitted'); assert.ok(item.pipeline!.attempts[0].endedAt);
  item = await engine.observe(item.id, item.revision, observed(item, { sha: H, baseSha: B }));
  // Rework: the round counts, the resubmission keeps the first submission as the clock start.
  item = await engine.execute(operator, 'rework', item.id, { reason: 'Reviewer finding', previousWorkerStopped: true }, randomUUID());
  assert.equal(item.pipeline!.reworkRounds, 1);
  item = await engine.execute(implementer, 'claim', item.id, {}, randomUUID());
  item = await engine.execute(implementer, 'workspace', item.id, { epoch: 2, host: 'machine-a', path: `/tmp/speed/${item.id}-2`, branch: item.workspaces[0].branch }, randomUUID());
  assert.equal(item.pipeline!.attempts.length, 2); assert.equal(item.pipeline!.attempts[1].epoch, 2);
  item = await engine.execute(implementer, 'submit', item.id, { epoch: 2, pr: number }, randomUUID());
  assert.equal(item.pipeline!.submittedAt, firstSubmit); assert.notEqual(item.pipeline!.resubmittedAt, firstSubmit);
  assert.equal(item.pipeline!.attempts[1].end, 'submitted');
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
  const guide = await read('docs/master-agent.md');
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
  const directory = await mkdtemp(join(tmpdir(), 'graphyard-speed-measure-'));
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
  assert.ok((await read('docs/master-agent.md')).includes('manual:speed-target-met') || (await read('docs/coordination.md')).includes('at least ten'), 'the guides say how the target is judged');
});
