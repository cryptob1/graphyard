import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, type spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { createRailwayContext, project } from 'railway/iac';
import railway, { releaseBranches } from '../.railway/railway.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { commands } from '../src/cli/index.js';
import {
  apiSuite, assessProductionServing, assessPromotion, commandSuite, cut, deployToUat, endpointSuite, gitIn, itemsFromCommits, ledgerStatus, productionBranch, promote, readLedger,
  runZeroTouchSuite, servedRevision, uatBranch, validateAndRecord, zeroTouchScenario, type ReleaseCandidate, type Suite,
} from '../src/release-candidate.js';
import { loadCases, parseCase, type ReleaseContract } from '../src/e2e/case.js';
import * as e2eCase from '../src/e2e/case.js';
import { e2eSuite, type E2eReport } from '../src/e2e/runner.js';
import type { HoldRecord } from '../src/release-holds.js';
import { readRecords } from '../src/release-candidate.js';
import { defaultPromoteEveryMinutes, promotionCycle, promotionReads, promotionReadWindows, promotionStatus, type PromotionLedger, type PromotionReads, type PromotionRun } from '../src/daemon/deployment.js';
import type { MasterConfig } from '../src/master.js';
import { promotionStateSchema, type PromotionState } from '../src/daemon/state.js';
import { defaultDeliverySpeedTargets, deliverySpeed, deliverySpeedBreaches } from '../src/flow-analytics.js';

const run = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A bare origin and a working clone of it, with main carrying one Graphyard branch merge. */
async function repository() {
  const root = await temporaryDirectory('release-candidate');
  const origin = join(root, 'origin.git'), work = join(root, 'work');
  run(root, 'init', '-q', '--bare', '-b', 'main', origin);
  run(root, 'clone', '-q', origin, work);
  for (const [key, value] of [['user.name', 'test'], ['user.email', 'test@example.test'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) run(work, 'config', key, value);
  run(work, 'commit', '-q', '--allow-empty', '-m', 'initial');
  run(work, 'push', '-q', 'origin', 'HEAD:main');
  return { origin, work, git: gitIn(work), merge: (key: string, pr: number) => mergeItem(work, key, pr) };
}
/** Merge an item's branch into main the way GitHub does, and push main. */
function mergeItem(work: string, key: string, pr: number) {
  const branch = `graphyard/${key.toLowerCase()}-1`;
  run(work, 'checkout', '-q', '-b', branch, 'origin/main');
  run(work, 'commit', '-q', '--allow-empty', '-m', `${key} change`);
  run(work, 'checkout', '-q', '--detach', 'origin/main');
  run(work, 'merge', '-q', '--no-ff', branch, '-m', `Merge pull request #${pr} from owner/${branch}`, '-m', `${key}: the change`);
  run(work, 'push', '-q', 'origin', 'HEAD:main');
  run(work, 'fetch', '-q', 'origin');
  return run(work, 'rev-parse', 'HEAD');
}
const remoteRef = (origin: string, ref: string) => { try { return run(origin, 'rev-parse', '--verify', '-q', ref); } catch { return null; } };

/**
 * A UAT (or production) deployment that serves the given commits in turn, answering `/healthz` in
 * the server's real shape: the build commit in `commit`, and `revision` left `unknown` because a
 * Railway build stamps no GRAPHYARD_BUILD_REVISION.
 */
function deployment(serving: (string | null)[]) {
  let probes = 0; const seen: string[] = [];
  const fetcher = (async (url: URL | string) => {
    const path = new URL(String(url)).pathname; seen.push(path);
    if (path === '/healthz') { const sha = serving[Math.min(probes++, serving.length - 1)]; return new Response(JSON.stringify({ ok: true, version: '0.1.0', revision: 'unknown', schema: 3, commit: sha ?? 'unknown' })); }
    return new Response('ok');
  }) as typeof fetch;
  return { fetcher, seen };
}
/** A UAT control plane's work API, in memory: create (idempotent by key), list, board and status. */
function uatApi(options: { dropFromList?: boolean } = {}) {
  const work: any[] = []; const byKey = new Map<string, any>(); const calls: { method: string; path: string; auth: string | null; key: string | null }[] = [];
  const fetcher = (async (url: URL | string, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname, method = init.method ?? 'GET', headers = new Headers(init.headers);
    calls.push({ method, path, auth: headers.get('authorization'), key: headers.get('idempotency-key') });
    if (headers.get('authorization') !== 'Bearer uat-token') return new Response('{"error":"unauthorized"}', { status: 401 });
    if (path === '/api/work' && method === 'POST') {
      const key = headers.get('idempotency-key')!;
      if (!byKey.has(key)) { const item = { id: `id-${work.length + 1}`, key: `UAT-${work.length + 1}`, ...JSON.parse(String(init.body)) }; work.push(item); byKey.set(key, item); }
      return new Response(JSON.stringify(byKey.get(key)), { status: 201 });
    }
    if (path === '/api/work') return new Response(JSON.stringify(options.dropFromList ? [] : work));
    if (path === '/api/board' || path === '/api/status') return new Response('{}');
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetcher, work, calls };
}
const someCandidate = (sha = 'c'.repeat(40)): ReleaseCandidate => ({ id: '20261001T120000Z', sha, cutAt: '2026-10-01T12:00:00.000Z', trigger: 'manual', since: null, items: [] });
const recordingSuite = (name: string, passed: boolean, urls: string[]): Suite => ({ name, run: async url => { urls.push(url); return { name, passed, detail: passed ? 'ok' : `${name} assertion failed` }; } });
const at = (iso: string) => () => new Date(iso);
const program = (environment: string) => railway(createRailwayContext({ environment }), project) as any;
const serviceOf = async (environment: string) => (await program(environment)).resources.find((resource: any) => resource.address === 'service.graphyard');

test('integration:release-candidate-cut — a candidate is cut from main\'s tip on schedule or on demand, recorded with its exact SHA and delivered items, and merges keep flowing', async () => {
  const repo = await repository();
  const first = repo.merge('GY-11', 101), second = repo.merge('GY-12', 102);
  const result = cut(repo.git, { base: 'main', trigger: 'schedule', now: new Date('2026-10-01T12:00:00.123Z'), push: true });
  assert.ok(result.cut);
  assert.equal(result.candidate.id, '20261001T120000Z');
  assert.equal(result.candidate.sha, second, 'the candidate is main\'s exact tip');
  assert.equal(result.candidate.trigger, 'schedule');
  assert.deepEqual(result.candidate.items, [{ key: 'GY-12', mergeSha: second, pr: 102 }, { key: 'GY-11', mergeSha: first, pr: 101 }]);
  assert.equal(remoteRef(repo.origin, 'refs/tags/rc/20261001T120000Z^{commit}'), second, 'the record is published as a tag on the exact SHA');
  assert.equal(remoteRef(repo.origin, 'refs/heads/main'), second, 'cutting moves nothing on main');

  // Cutting writes a tag, never a branch rule: main keeps accepting merges while the candidate is under test.
  const third = repo.merge('GY-13', 103);
  assert.equal(remoteRef(repo.origin, 'refs/heads/main'), third);
  assert.equal(readLedger(repo.git).candidates[0].sha, second, 'the candidate stays frozen at its SHA');
  const again = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-01T13:00:00Z'), push: true });
  assert.ok(again.cut);
  assert.equal(again.candidate.sha, third); assert.equal(again.candidate.trigger, 'manual');
  const unchanged = cut(repo.git, { base: 'main', trigger: 'schedule', now: new Date('2026-10-01T14:00:00Z'), push: true });
  assert.equal(unchanged.cut, false, 'a tip that is already a candidate is not cut twice');

  assert.deepEqual(itemsFromCommits([{ sha: 'a'.repeat(40), subject: 'GY-7: squash merged (#70)', body: '' }, { sha: 'b'.repeat(40), subject: 'docs touch', body: '' }]),
    [{ key: 'GY-7', mergeSha: 'a'.repeat(40), pr: 70 }], 'a commit naming no item is not a delivery');
  assert.deepEqual(itemsFromCommits([{ sha: 'd'.repeat(40), subject: 'Merge pull request #80 from owner/graphyard/gy-8-1', body: 'Follows graphyard/gy-5-2' }]).map(item => item.key), ['GY-8'],
    'the merged branch in the subject names the item, not a branch the body mentions');

  const release = commands.find(command => command.name === 'release');
  assert.ok(release?.help.some(line => line.includes('release cut')), 'graphyard release cut is a registered command');
  assert.equal(commands.filter(command => command.name === 'release').length, 1, 'one entry answers release');
  // The same word still gives up a worker's lease: a work key routes to the lease release.
  const calls: [string, unknown][] = []; const printed: unknown[] = [];
  const api = async (path: string, data?: unknown) => { calls.push([path, data]); return path === 'work/GY-7' ? { id: 'w-1', key: 'GY-7' } : { released: true }; };
  await release!.run({ id: 'GY-7', args: ['3'], api, print: (value: unknown) => printed.push(value) } as any, undefined);
  // The item is read alone by its key, never by downloading the fleet (GY-1377).
  assert.deepEqual(calls, [['work/GY-7', undefined], ['work/w-1/release', { epoch: 3 }]]);
  assert.deepEqual(printed, [{ released: true }]);
  const workflow = await readFile(new URL('../.github/workflows/release-candidate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /schedule:\s*\n\s*- cron:/); assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /release cut --trigger/);
  assert.doesNotMatch(workflow, /protection|merge_group|git push/, 'the workflow never touches main\'s merge path');
});

test('integration:uat-deploys-candidate — the candidate SHA is deployed to Railway uat, which has its own database and no repository credential, and the suites run against it', async () => {
  const repo = await repository();
  const sha = repo.merge('GY-21', 201);
  const { candidate } = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-01T12:00:00Z'), push: true }) as any;
  repo.merge('GY-22', 202);
  const deployed = deployToUat(repo.git, candidate.id, 'main');
  assert.deepEqual(deployed, { candidate: candidate.id, sha, branch: uatBranch });
  assert.equal(remoteRef(repo.origin, `refs/heads/${uatBranch}`), sha, 'UAT tracks the candidate SHA, not main\'s newer tip');

  const urls: string[] = [];
  const uat = deployment([null, sha, sha]);
  const result = await validateAndRecord(repo.git, candidate.id, 'https://uat.example.test', [endpointSuite(['/healthz?strict', '/'], uat.fetcher), recordingSuite('long', true, urls)],
    { base: 'main', push: true, timeoutMs: 60_000, fetcher: uat.fetcher, sleep: async () => {}, now: at('2026-10-01T12:30:00Z') });
  assert.equal(result.record.result, 'passed');
  assert.equal(result.record.deployedSha, sha);
  assert.deepEqual(result.record.suites.map(suite => suite.name), ['endpoints', 'long']);
  assert.deepEqual(urls, ['https://uat.example.test'], 'the long suite runs against the UAT deployment');
  assert.equal(remoteRef(repo.origin, `refs/tags/rc-uat/${candidate.id}^{commit}`), sha);
  assert.equal(ledgerStatus(readLedger(repo.git))[0].uat?.result, 'passed');

  // The deployment is read from the real /healthz shape: `commit`, not the unstamped `revision`.
  assert.equal(servedRevision({ revision: 'unknown', commit: sha }), sha);
  assert.equal(servedRevision({ revision: sha.toUpperCase() }), sha, 'a stamped revision counts only when no commit is reported');
  assert.equal(servedRevision({ revision: 'unknown', commit: 'unknown' }), null);

  // The api suite drives UAT's own API with a UAT principal: create, idempotent replay, list, board, status.
  const api = uatApi();
  const driven = await apiSuite('uat-token', api.fetcher).run('https://uat.example.test', candidate);
  assert.equal(driven.passed, true, driven.detail);
  assert.equal(api.work.length, 1, 'the replayed create returned the same item');
  assert.match(api.work[0].title, new RegExp(`${candidate.id} at ${sha.slice(0, 12)}`));
  assert.deepEqual(api.calls.map(call => `${call.method} ${call.path}`), ['POST /api/work', 'POST /api/work', 'GET /api/work', 'GET /api/board', 'GET /api/status']);
  assert.ok(api.calls.every(call => call.auth === 'Bearer uat-token'));
  assert.deepEqual([...new Set(api.calls.filter(call => call.method === 'POST').map(call => call.key))], [`release-candidate-uat:${candidate.id}`]);
  const lost = await apiSuite('uat-token', uatApi({ dropFromList: true }).fetcher).run('https://uat.example.test', candidate);
  assert.equal(lost.passed, false); assert.match(lost.detail, /does not list the created item/);
  const refusedToken = await apiSuite('wrong', uatApi().fetcher).run('https://uat.example.test', candidate);
  assert.equal(refusedToken.passed, false); assert.match(refusedToken.detail, /answered 401/);

  // A command suite receives the UAT URL it must test, and never the release token that files follow-ups.
  const out = join(await temporaryDirectory('release-candidate-suite'), 'url');
  const previous = process.env.GRAPHYARD_TOKEN; process.env.GRAPHYARD_TOKEN = 'release-secret';
  try {
    const command = await commandSuite('cli', `printf '%s|%s' "$GRAPHYARD_UAT_URL" "\${GRAPHYARD_TOKEN:-}" > ${JSON.stringify(out)}`).run('https://uat.example.test', someCandidate());
    assert.equal(command.passed, true); assert.equal(await readFile(out, 'utf8'), 'https://uat.example.test|');
  } finally { if (previous === undefined) delete process.env.GRAPHYARD_TOKEN; else process.env.GRAPHYARD_TOKEN = previous; }
  const workflow = await readFile(new URL('../.github/workflows/release-candidate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /release validate .* --api/, 'the workflow runs the api suite against UAT');
  assert.match(workflow, /GRAPHYARD_UAT_TOKEN: \$\{\{ secrets\.GRAPHYARD_UAT_TOKEN \}\}/);
  assert.doesNotMatch(workflow, /--suite "long=npm test"/, 'no suite runs against the runner\'s own checkout in UAT\'s name');

  // UAT that never serves the candidate is a failed validation, never a pass attributed to it.
  const other = await repository();
  other.merge('GY-23', 203);
  const stale = cut(other.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-01T12:00:00Z'), push: true }) as any;
  const wrong = deployment(['f'.repeat(40)]);
  const refused = await validateAndRecord(other.git, stale.candidate.id, 'https://uat.example.test', [recordingSuite('long', true, [])],
    { base: 'main', push: true, timeoutMs: 0, fetcher: wrong.fetcher, sleep: async () => {} });
  assert.equal(refused.record.result, 'failed'); assert.match(refused.record.suites[0].detail, /not candidate/);

  const uatService = await serviceOf('uat'), production = await serviceOf('production');
  assert.equal(uatService.source.branch, releaseBranches.uat);
  assert.deepEqual(Object.keys(uatService.variables).filter(name => name.startsWith('GITHUB_')), [], 'UAT holds no GitHub credential that could write to the production repository');
  assert.ok('DATABASE_URL' in uatService.variables && (await program('uat')).resources.some((resource: any) => /^database\.Postgres(-\w+)?$/.test(resource.address)), 'UAT runs on its environment\'s own Postgres');
  assert.ok('GITHUB_APP_ID' in production.variables, 'production keeps its App');
});

test('integration:promote-exact-sha — production deploys only a UAT-passed candidate by its exact SHA, and verification records that SHA', async () => {
  const repo = await repository();
  const sha = repo.merge('GY-31', 301);
  const { candidate } = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-01T12:00:00Z'), push: true }) as any;
  const unvalidated = promote(repo.git, candidate.id, { base: 'main', push: true, now: new Date() });
  assert.equal(unvalidated.promoted, false); assert.match(unvalidated.refusals![0], /no UAT validation record/);
  assert.equal(remoteRef(repo.origin, `refs/heads/${productionBranch}`), null, 'nothing reaches production before UAT passes');

  deployToUat(repo.git, candidate.id, 'main');
  const uat = deployment([sha]);
  await validateAndRecord(repo.git, candidate.id, 'https://uat.example.test', [recordingSuite('long', true, [])], { base: 'main', push: true, timeoutMs: 0, fetcher: uat.fetcher });
  const newer = repo.merge('GY-32', 302);
  const promoted = promote(repo.git, candidate.id, { base: 'main', push: true, now: new Date('2026-10-01T13:00:00Z') });
  assert.deepEqual(promoted, { promoted: true, candidate: candidate.id, sha, branch: productionBranch });
  assert.equal(remoteRef(repo.origin, `refs/heads/${productionBranch}`), sha, 'production gets the candidate\'s exact SHA, not main\'s tip');
  assert.notEqual(sha, newer);
  const ledger = readLedger(repo.git);
  assert.deepEqual(ledger.production.map(record => record.sha), [sha]);
  assert.deepEqual(assessProductionServing(sha, ledger.production), { verified: true, reason: null, candidate: candidate.id, sha });
  assert.equal(assessProductionServing(newer, ledger.production).verified, false, 'a production serving main\'s tip is not a promoted candidate');

  // The next candidate's items are measured from what production runs.
  const next = cut(repo.git, { base: 'main', trigger: 'schedule', now: new Date('2026-10-01T14:00:00Z'), push: true }) as any;
  assert.deepEqual(next.candidate.since, { id: candidate.id, sha });
  assert.deepEqual(next.candidate.items.map((item: any) => item.key), ['GY-32']);

  // Promotion is leased on the last promoted SHA: a production branch moved by hand is refused, not overwritten.
  deployToUat(repo.git, next.candidate.id, 'main');
  await validateAndRecord(repo.git, next.candidate.id, 'https://uat.example.test', [recordingSuite('long', true, [])], { base: 'main', push: true, timeoutMs: 0, fetcher: deployment([newer]).fetcher });
  const handMoved = run(repo.work, 'rev-list', '--max-parents=0', 'HEAD');
  run(repo.work, 'push', '-q', '--force', 'origin', `${handMoved}:refs/heads/${productionBranch}`);
  assert.throws(() => promote(repo.git, next.candidate.id, { base: 'main', push: true, now: new Date('2026-10-01T15:00:00Z') }), /stale info|rejected/);
  assert.equal(remoteRef(repo.origin, `refs/heads/${productionBranch}`), handMoved);

  assert.equal((await serviceOf('production')).source.branch, releaseBranches.production, 'production no longer auto-deploys main');
  const config = await readFile(new URL('../.railway/railway.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(config, /branch: "main"/);
});

test('integration:failed-candidate-fix-forward — a failed candidate files one follow-up naming the suite and SHA, leaves its deliveries alone, and the next cut proceeds', async () => {
  const repo = await repository();
  const sha = repo.merge('GY-41', 401);
  const { candidate } = cut(repo.git, { base: 'main', trigger: 'schedule', now: new Date('2026-10-01T12:00:00Z'), push: true }) as any;
  deployToUat(repo.git, candidate.id, 'main');
  const filed: { item: any; requestId: string }[] = [];
  const file = async (item: any, requestId: string) => { filed.push({ item, requestId }); return 'GY-900'; };
  const uat = deployment([sha]);
  const result = await validateAndRecord(repo.git, candidate.id, 'https://uat.example.test', [recordingSuite('endpoints', true, []), recordingSuite('long', false, [])],
    { base: 'main', push: true, timeoutMs: 0, fetcher: uat.fetcher, file });
  assert.equal(result.record.result, 'failed');
  assert.equal(result.followUp, 'GY-900');
  assert.equal(filed.length, 1, 'exactly one follow-up item');
  assert.match(filed[0].item.title, new RegExp(`${candidate.id} failed UAT suite long at ${sha.slice(0, 12)}`));
  assert.match(filed[0].item.description, new RegExp(sha)); assert.match(filed[0].item.description, /GY-41.*stay delivered/);
  assert.equal(filed[0].requestId, `release-candidate-follow-up:${candidate.id}`, 'a retried filing is idempotent');
  assert.ok(!('plannedFiles' in filed[0].item) && !('reopen' in filed[0].item), 'the follow-up is new work; the included delivery is not reworked');

  await assert.rejects(validateAndRecord(repo.git, candidate.id, 'https://uat.example.test', [], { base: 'main', push: true, timeoutMs: 0, fetcher: uat.fetcher, file }), /already validated/);
  assert.equal(filed.length, 1, 'a second validation files nothing');
  const refused = promote(repo.git, candidate.id, { base: 'main', push: true, now: new Date() });
  assert.equal(refused.promoted, false); assert.match(refused.refusals!.join(' '), /failed UAT \(long\)/);
  assert.equal(remoteRef(repo.origin, `refs/heads/${productionBranch}`), null);

  // A filing that fails still records the verdict; `release follow-up` files it later.
  const flaky = await repository();
  const flakySha = flaky.merge('GY-42', 402);
  const flakyCut = cut(flaky.git, { base: 'main', trigger: 'schedule', now: new Date('2026-10-01T12:00:00Z'), push: true }) as any;
  const unfiled = await validateAndRecord(flaky.git, flakyCut.candidate.id, 'https://uat.example.test', [recordingSuite('long', false, [])],
    { base: 'main', push: true, timeoutMs: 0, fetcher: deployment([flakySha]).fetcher, file: async () => { throw new Error('coordinator unreachable'); } });
  assert.equal(unfiled.record.result, 'failed'); assert.equal(unfiled.followUp, null); assert.match(unfiled.filingError!, /unreachable/);

  // Fix forward: the fix merges to main and the next cut proceeds, carrying both.
  const fix = repo.merge('GY-900', 402);
  const next = cut(repo.git, { base: 'main', trigger: 'schedule', now: new Date('2026-10-01T18:00:00Z'), push: true }) as any;
  assert.ok(next.cut); assert.equal(next.candidate.sha, fix);
  assert.deepEqual(next.candidate.items.map((item: any) => item.key), ['GY-900', 'GY-41'], 'nothing reached production, so the failed candidate\'s delivery rides the next one');
  const status = ledgerStatus(readLedger(repo.git));
  assert.deepEqual(status.map(entry => [entry.id, entry.uat?.result ?? null, entry.uat?.followUp ?? null]), [[next.candidate.id, null, null], [candidate.id, 'failed', 'GY-900']]);
});

test('unit:release-candidate-e2e-suite — UAT runs every case targeted at uat as the e2e suite of release validate; a failing case fails the candidate and its follow-up names the case and step', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release-candidate.yml', import.meta.url), 'utf8');
  const validateStep = workflow.slice(workflow.indexOf('node bin/graphyard.mjs release validate'), workflow.indexOf('- name: Record the E2E case runs'));
  assert.match(validateStep, /--suite 'e2e=node --import tsx --eval "import\(\\"\.\/src\/e2e\/runner\.ts\\"\)\.then\(m => m\.runE2eSuite\(\)\)"'/, 'the uat job runs the e2e suite inside release validate');
  assert.match(validateStep, /GRAPHYARD_UAT_TOKEN: \$\{\{ secrets\.GRAPHYARD_UAT_TOKEN \}\}/, 'the runner reads UAT\'s token from the uat environment secret');
  assert.match(validateStep, /UAT_URL: \$\{\{ vars\.UAT_URL \}\}/);
  const recordStep = workflow.slice(workflow.indexOf('- name: Record the E2E case runs'), workflow.indexOf('\n  promote:\n'));
  assert.match(recordStep, /e2e record "\$RUNNER_TEMP\/e2e-report\.json"/, 'a later step records the report');
  // GY-1614: the release filing credential holds only intent:create, which /api/scenarios refuses, so recording holds its own.
  assert.match(recordStep, /GRAPHYARD_TOKEN: \$\{\{ secrets\.GRAPHYARD_E2E_RECORD_TOKEN \}\}/, 'recording uses its own credential');
  assert.doesNotMatch(recordStep, /GRAPHYARD_RELEASE_TOKEN \}\}/, 'recording never uses the intent:create filing credential');
  assert.match(validateStep, /GRAPHYARD_TOKEN: \$\{\{ secrets\.GRAPHYARD_RELEASE_TOKEN \}\}/, 'filing keeps the release credential');
  assert.match(workflow, /- name: Record the E2E case runs[^]*?continue-on-error: true/, 'recording never decides promotion');
  const shipped = await loadCases(new URL('..', import.meta.url).pathname);
  assert.ok(shipped.filter(entry => entry.definition.target === 'uat').length >= 5, 'the shipped cases run on UAT');

  // Against UAT serving the candidate: one case targeted at uat fails its second step, and a case targeted at any is not run.
  const repo = await repository();
  const sha = repo.merge('GY-51', 501);
  const { candidate } = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-01T12:00:00Z'), push: true }) as any;
  const asked: string[] = [];
  const uat = (async (url: URL | string, init: RequestInit = {}) => {
    const path = new URL(String(url)).pathname; asked.push(`${init.method ?? 'GET'} ${path} ${new Headers(init.headers).get('authorization') ?? ''}`.trim());
    if (path === '/healthz') return new Response(JSON.stringify({ ok: true, commit: sha, revision: 'unknown' }));
    if (path === '/api/board') return new Response(JSON.stringify({ groups: { backlog: [] } }));
    return new Response('{"error":"broken"}', { status: 500 });
  }) as typeof fetch;
  const file = (id: string, target: string, steps: unknown[]) => ({ file: `e2e/cases/${id}.json`, definition: parseCase(`e2e/cases/${id}.json`, JSON.stringify({ id, title: id, target, required: true, steps })) });
  const cases = [
    file('board-reads', 'uat', [{ kind: 'http', method: 'GET', path: '/api/board', status: 200, expect: [{ path: 'groups.backlog', type: 'array' }] }]),
    file('tests-read', 'uat', [{ kind: 'http', method: 'GET', path: '/api/board', status: 200 }, { kind: 'http', name: 'read the tests', method: 'GET', path: '/api/tests', status: 200 }]),
    file('local-only', 'any', [{ kind: 'http', method: 'GET', path: '/api/never', status: 200 }]),
  ];
  const filed: any[] = [];
  const result = await validateAndRecord(repo.git, candidate.id, 'https://uat.example.test', [recordingSuite('endpoints', true, []), e2eSuite(cases, 'uat-token', { fetcher: uat })],
    { base: 'main', push: true, timeoutMs: 0, fetcher: uat, file: async item => { filed.push(item); return 'GY-951'; } });
  assert.equal(result.record.result, 'failed');
  const e2e = result.record.suites.find(suite => suite.name === 'e2e')!;
  assert.equal(e2e.passed, false);
  assert.equal(e2e.detail, '1 of 2 E2E cases failed: case tests-read failed at step 2 (read the tests): expected status 200, got 500: {"error":"broken"}');
  assert.ok(asked.every(line => !line.includes('/api/never')), 'a case targeted at any does not run on UAT');
  assert.ok(asked.filter(line => line.includes('/api/')).every(line => line.endsWith('Bearer uat-token')), 'cases drive UAT with the UAT token');
  assert.equal(filed.length, 1);
  assert.match(filed[0].title, /failed UAT suite e2e/);
  assert.match(filed[0].description, /case tests-read failed at step 2 \(read the tests\)/, 'the follow-up names the failing case and step');
  const refused = promote(repo.git, candidate.id, { base: 'main', push: true, now: new Date() });
  assert.equal(refused.promoted, false); assert.match(refused.refusals!.join(' '), /failed UAT \(e2e\)/, 'a failing case blocks promotion like any suite');

  // The workflow's own suite command, run the way release validate runs every --suite: through
  // commandSuite in a child process. The detail it writes reaches the record and the follow-up.
  const suiteCommand = validateStep.match(/--suite '(e2e=[^']+)'/)![1].slice('e2e='.length);
  const root = await temporaryDirectory('release-candidate-e2e');
  await mkdir(join(root, 'e2e/cases'), { recursive: true });
  for (const entry of cases) await writeFile(join(root, entry.file), JSON.stringify(entry.definition));
  // UAT runs in its own process: release validate runs suite commands synchronously, as the workflow does.
  const uatProcess = spawn(process.execPath, ['--input-type=module', '-e', `
    import { createServer } from 'node:http';
    let serving = process.argv[1];
    const server = createServer((request, response) => {
      const path = new URL(request.url, 'http://uat').pathname;
      if (request.method === 'PUT') { serving = path.slice(1); return response.end(); }
      const body = path === '/healthz' ? { ok: true, commit: serving } : path === '/api/board' && request.headers.authorization === 'Bearer uat-token' ? { groups: { backlog: [] } } : { error: 'broken' };
      response.writeHead(path === '/healthz' || 'groups' in body ? 200 : 500, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));`, sha], { stdio: ['ignore', 'pipe', 'inherit'] });
  const served = `http://127.0.0.1:${(await once(uatProcess.stdout!, 'data', { signal: AbortSignal.timeout(20_000) }))[0].toString().trim()}`;
  const saved = { token: process.env.GRAPHYARD_UAT_TOKEN, root: process.env.GRAPHYARD_E2E_ROOT };
  Object.assign(process.env, { GRAPHYARD_UAT_TOKEN: 'uat-token', GRAPHYARD_E2E_ROOT: root });
  try {
    await fetch(`${served}/${repo.merge('GY-52', 502)}`, { method: 'PUT' });
    const { candidate: second } = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-02T12:00:00Z'), push: true }) as any;
    const viaCommand: any[] = [];
    const real = await validateAndRecord(repo.git, second.id, served, [commandSuite('e2e', suiteCommand, 120_000)],
      { base: 'main', push: true, timeoutMs: 0, file: async item => { viaCommand.push(item); return 'GY-952'; } });
    assert.equal(real.record.result, 'failed');
    assert.equal(real.record.suites[0].detail, '1 of 2 E2E cases failed: case tests-read failed at step 2 (read the tests): expected status 200, got 500: {"error":"broken"}', 'the command path keeps the case and step');
    assert.equal(viaCommand.length, 1);
    assert.match(viaCommand[0].description, /e2e — 1 of 2 E2E cases failed: case tests-read failed at step 2 \(read the tests\)/, 'the follow-up release validate files names the failing case and step');
  } finally {
    for (const [key, value] of [['GRAPHYARD_UAT_TOKEN', saved.token], ['GRAPHYARD_E2E_ROOT', saved.root]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    uatProcess.kill();
  }

  // The same cases all passing pass the suite; no case targeted at uat is a failure, never a vacuous pass.
  const passing = await e2eSuite(cases.slice(0, 1), 'uat-token', { fetcher: uat }).run('https://uat.example.test', candidate);
  assert.deepEqual(passing, { name: 'e2e', passed: true, detail: `1 E2E case passed against UAT serving ${sha}` });
  const none = await e2eSuite(cases.slice(2), 'uat-token', { fetcher: uat }).run('https://uat.example.test', candidate);
  assert.equal(none.passed, false); assert.match(none.detail, /no E2E case targets uat/);
});

/** A scratch checkout holding the given case files and, unless null, a contract. */
async function contractCheckout(cases: Record<string, unknown>, contract: unknown) {
  const root = await temporaryDirectory('release-contract');
  await mkdir(join(root, 'e2e/cases'), { recursive: true });
  for (const [name, content] of Object.entries(cases)) await writeFile(join(root, 'e2e/cases', name), typeof content === 'string' ? content : JSON.stringify(content));
  if (contract !== null) await writeFile(join(root, 'e2e/contract.json'), typeof contract === 'string' ? contract : JSON.stringify(contract));
  return root;
}
const contractCase = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `Case ${id}`, target: 'uat', required: true, steps: [{ kind: 'http', method: 'GET', path: `/api/${id}`, status: 200 }], ...extra });

test('unit:e2e-release-contract-precut — e2e/contract.json binds each required outcome to its cases; the pre-cut check refuses a missing, invalid, non-uat or optional bound case and an unbound required case, naming each, and the cut step runs it', async () => {
  const { checkContract, checkRepositoryContract, inspectCases, parseContract } = e2eCase;
  // The shipped contract binds all five shipped cases, each required and targeted at uat.
  const shipped = await checkRepositoryContract(new URL('..', import.meta.url).pathname);
  assert.deepEqual(shipped.refusals, []); assert.equal(shipped.passed, true);
  const bound = new Set(shipped.outcomes.flatMap(outcome => outcome.cases));
  const cases = await loadCases(new URL('..', import.meta.url).pathname);
  for (const id of ['sign-in', 'create-work-item', 'board', 'work-item-detail', 'tests-page']) {
    assert.ok(bound.has(id), `the shipped contract binds ${id}`);
    assert.equal(cases.find(entry => entry.definition.id === id)?.definition.required, true, `${id} is required`);
  }
  assert.equal(parseCase('e2e/cases/x.json', JSON.stringify({ ...contractCase('x'), required: undefined })).required, false, 'a case is optional unless it declares required');

  // Every kind of broken binding is refused, each naming its outcome and case.
  const broken = await contractCheckout({
    'good.json': contractCase('good'), 'anywhere.json': contractCase('anywhere', { target: 'any' }), 'optional.json': contractCase('optional', { required: false }),
    'malformed.json': { ...contractCase('malformed'), steps: [] }, 'stray.json': contractCase('stray'),
  }, { outcomes: [
    { id: 'checkout', title: 'A customer checks out', criteria: ['The order is placed'], cases: ['good', 'missing', 'anywhere'] },
    { id: 'browse', title: 'A customer browses', cases: ['optional', 'malformed'] },
  ] });
  const refused = await checkRepositoryContract(broken);
  assert.equal(refused.passed, false);
  assert.deepEqual(refused.refusals.map(line => line.replace(/: e2e\/cases.*$/, '')), [
    'outcome checkout binds case missing, which does not exist under e2e/cases/',
    'outcome checkout binds case anywhere, which targets any, not uat',
    'outcome browse binds case optional, which is not required',
    'outcome browse binds case malformed, which is invalid',
    'required case stray (e2e/cases/stray.json) is bound to no outcome',
  ]);
  assert.match(refused.refusals[3], /malformed, which is invalid: e2e\/cases\/malformed\.json: steps: /);
  // A malformed contract, or none, is itself a refusal; duplicate outcomes are refused by the schema.
  assert.match((await checkRepositoryContract(await contractCheckout({ 'good.json': contractCase('good') }, '{ nope'))).refusals[0], /e2e\/contract\.json: \(contract\): not valid JSON/);
  assert.equal((await checkRepositoryContract(await contractCheckout({ 'good.json': contractCase('good') }, null))).passed, false);
  assert.throws(() => parseContract(JSON.stringify({ outcomes: [{ id: 'a', title: 'A', cases: ['good'] }, { id: 'a', title: 'A again', cases: ['good'] }] })), /outcomes\.1\.id: outcome a is declared twice/);
  assert.throws(() => parseContract(JSON.stringify({ outcomes: [{ id: 'Bad/Id', title: 'A', cases: ['good'] }] })), /outcomes\.0\.id: an id is lower-case/);

  // The pass: every bound case is valid, uat and required, and every required case is bound — a case may prove two outcomes.
  const passing = await contractCheckout({ 'good.json': contractCase('good'), 'shared.json': contractCase('shared'), 'extra.json': contractCase('extra', { required: false }) },
    { outcomes: [{ id: 'checkout', title: 'A customer checks out', cases: ['good', 'shared'] }, { id: 'refund', title: 'A customer is refunded', cases: ['shared'] }] });
  assert.deepEqual(await checkRepositoryContract(passing), { passed: true, outcomes: [{ id: 'checkout', cases: ['good', 'shared'] }, { id: 'refund', cases: ['shared'] }], refusals: [] });
  assert.equal(checkContract(parseContract(await readFile(join(passing, 'e2e/contract.json'), 'utf8')), await inspectCases(passing)).passed, true);

  // `graphyard release contract` is the check; it exits non-zero on a refusal.
  const release = commands.find(command => command.name === 'release')!;
  assert.ok(release.help.some(line => line.includes('release contract')));
  const printed: any[] = [];
  const exitCode = process.exitCode;
  try {
    await release.run({ id: 'contract', args: [], repositoryRoot: () => broken, print: (value: unknown) => printed.push(value) } as any, undefined);
    assert.equal(process.exitCode, 1); assert.equal(printed[0].refusals.length, 5);
    process.exitCode = exitCode;
    await release.run({ id: 'contract', args: [], repositoryRoot: () => passing, print: (value: unknown) => printed.push(value) } as any, undefined);
    assert.equal(process.exitCode, exitCode); assert.equal(printed[1].passed, true);
  } finally { process.exitCode = exitCode; }

  // The workflow's cut step runs the check before `release cut`, so a broken binding fails before any rc/ tag is written.
  const workflow = await readFile(new URL('../.github/workflows/release-candidate.yml', import.meta.url), 'utf8');
  const cutStep = workflow.slice(workflow.indexOf('- name: Cut a release candidate'), workflow.indexOf('  soak:'));
  assert.ok(cutStep.indexOf('node bin/graphyard.mjs release contract') > 0 && cutStep.indexOf('node bin/graphyard.mjs release contract') < cutStep.indexOf('node bin/graphyard.mjs release cut'), 'the pre-cut check precedes the cut');
  assert.match(cutStep, /set -euo pipefail/, 'a refusal fails the step');

  // Optional cases run in UAT and are reported, but never fail release validate.
  const repo = await repository();
  const sha = repo.merge('GY-61', 601);
  const { candidate } = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-01T12:00:00Z'), push: true }) as any;
  const uat = (async (url: URL | string) => new URL(String(url)).pathname === '/healthz' ? new Response(JSON.stringify({ commit: sha })) : new URL(String(url)).pathname === '/api/optional' ? new Response('{}', { status: 500 }) : new Response('{}')) as typeof fetch;
  let report: E2eReport | null = null;
  const result = await validateAndRecord(repo.git, candidate.id, 'https://uat.example.test', [e2eSuite([
    { file: 'e2e/cases/good.json', definition: parseCase('e2e/cases/good.json', JSON.stringify(contractCase('good'))) },
    { file: 'e2e/cases/optional.json', definition: parseCase('e2e/cases/optional.json', JSON.stringify(contractCase('optional', { required: false }))) },
  ], 'uat-token', { fetcher: uat, report: async written => { report = written; } })], { base: 'main', push: true, timeoutMs: 0, fetcher: uat });
  assert.equal(result.record.result, 'passed', JSON.stringify(result.record.suites));
  assert.equal(report!.cases.find(entry => entry.id === 'optional')!.verdict, 'failed', 'the optional case ran and its failure is reported');
  assert.match(result.record.suites[0].detail, /optional, not blocking: optional failed/);
});

test('unit:e2e-release-holds-per-risk — a failing candidate files one hold per failed outcome with its cases, steps and criteria; a repeat failure attaches; a fold needs an independent approver; a hold clears only on a newer served candidate', async () => {
  // GY-1378's release holds module, loaded here so that without it this case fails on its own.
  const { foldHolds, foldRecord, holdTagPrefix, releaseHolds } = await import('../src/release-holds.js');
  const { parseContract } = e2eCase;
  const contract: ReleaseContract = parseContract(JSON.stringify({ outcomes: [
    { id: 'alpha', title: 'Customers sign in', criteria: ['A customer reaches their account'], cases: ['a1', 'a2'] },
    { id: 'beta', title: 'Customers pay', criteria: ['A payment is taken once'], cases: ['b1'] },
    { id: 'gamma', title: 'Customers get receipts', cases: ['g1'] },
  ] }));
  const cases = ['a1', 'a2', 'b1', 'g1'].map(id => ({ file: `e2e/cases/${id}.json`, definition: parseCase(`e2e/cases/${id}.json`, JSON.stringify(contractCase(id))) }));
  const repo = await repository();
  const filed: { item: any; requestId: string }[] = [];
  const file = async (item: any, requestId: string) => { filed.push({ item, requestId }); return `GY-${700 + filed.length}`; };
  /** Validate the next candidate against UAT serving it, with each case answering `answers[ID]` call by call. */
  async function validateNext(key: string, pr: number, now: string, answers: Record<string, number[]>, extra: Suite[] = []) {
    const sha = repo.merge(key, pr);
    const { candidate } = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date(now), push: true }) as any;
    const calls = new Map<string, number>();
    const uat = (async (url: URL | string) => {
      const path = new URL(String(url)).pathname;
      if (path === '/healthz') return new Response(JSON.stringify({ commit: sha }));
      const id = path.slice(5), n = calls.get(id) ?? 0; calls.set(id, n + 1);
      const statuses = answers[id] ?? [200];
      return new Response('{}', { status: statuses[Math.min(n, statuses.length - 1)] });
    }) as typeof fetch;
    let report: E2eReport | null = null;
    const result = await validateAndRecord(repo.git, candidate.id, 'https://uat.example.test', [...extra, e2eSuite(cases, 'uat-token', { fetcher: uat, report: async written => { report = written; } })],
      { base: 'main', push: true, timeoutMs: 0, fetcher: uat, file, now: () => new Date(Date.parse(now) + 1_800_000),
        holds: releaseHolds(repo.git, { contract, report: async () => report, file, push: true, now: () => new Date(Date.parse(now) + 1_800_000) }) });
    return { candidate, sha, result, holds: foldHolds(readRecords<HoldRecord>(repo.git, holdTagPrefix)) };
  }

  // Candidate 1: a2 flakes, b1 fails and stops the run (g1 unrun), and a runner outage fails a suite no case explains.
  const first = await validateNext('GY-71', 701, '2026-10-01T12:00:00Z', { a2: [500, 200], b1: [503] }, [recordingSuite('container-recovery', false, [])]);
  assert.equal(first.result.record.result, 'failed');
  assert.deepEqual(first.result.record.holds, [{ kind: 'open', outcome: 'alpha', hold: 'alpha', item: 'GY-701' }, { kind: 'open', outcome: 'beta', hold: 'beta', item: 'GY-702' }], 'one hold per failed outcome, none for the unrun gamma');
  assert.deepEqual(filed.map(entry => entry.requestId), [`release-hold:alpha:${first.candidate.id}`, `release-hold:beta:${first.candidate.id}`, `release-candidate-follow-up:${first.candidate.id}`]);
  assert.match(filed[0].item.title, new RegExp(`Release hold: outcome alpha failed UAT on candidate ${first.candidate.id} at ${first.sha.slice(0, 12)}`));
  assert.match(filed[0].item.description, /Failed cases: a2 flaky at step 1 \(GET \/api\/a2\): expected status 200, got 500/);
  assert.match(filed[0].item.description, /Unmet criteria: A customer reaches their account\./);
  assert.match(filed[0].item.description, /evidence decision on this item/);
  assert.match(filed[1].item.description, /Failed cases: b1 failed at step 1 \(GET \/api\/b1\): expected status 200, got 503/);
  // The incident is an ordinary follow-up naming only the suite no case explains, never a hold.
  assert.match(filed[2].item.title, /failed UAT suite container-recovery/); assert.doesNotMatch(filed[2].item.description, /e2e —/);
  assert.equal(first.result.record.followUp, 'GY-703');
  assert.deepEqual(first.result.record.e2e!.cases.map(entry => [entry.case, entry.verdict]), [['a1', 'passed'], ['a2', 'flaky'], ['b1', 'failed'], ['g1', 'unrun']]);
  assert.deepEqual(first.holds.map(hold => [hold.outcome, hold.state, hold.item, hold.cases.map(entry => `${entry.case}:${entry.verdict}`)]), [['alpha', 'open', 'GY-701', ['a2:flaky']], ['beta', 'open', 'GY-702', ['b1:failed']]]);
  assert.deepEqual(first.holds[1].cases[0].failingStep, { index: 0, name: 'GET /api/b1', reason: 'expected status 200, got 503: {}' });
  assert.deepEqual(first.holds[1].criteria, ['A payment is taken once']);

  // Candidate 2: b1 fails again — attached to beta's open hold, not filed again — and a1, a2 pass, so alpha clears on this newer served candidate.
  const second = await validateNext('GY-72', 702, '2026-10-01T14:00:00Z', { b1: [500] });
  assert.deepEqual(second.result.record.holds, [{ kind: 'attach', outcome: 'beta', hold: 'beta', item: 'GY-702' }, { kind: 'clear', outcome: 'alpha', hold: 'alpha', item: 'GY-701' }]);
  assert.equal(filed.length, 3, 'a repeat failure files nothing new; the e2e failure is answered by the hold, so no follow-up either');
  assert.equal(second.result.followUp, null);
  const [alpha, beta] = second.holds;
  assert.deepEqual([alpha.state, alpha.cleared], ['cleared', { candidate: second.candidate.id, sha: second.sha }]);
  assert.deepEqual(beta.cases.map(entry => [entry.case, entry.candidate, entry.sha]), [['b1', first.candidate.id, first.sha], ['b1', second.candidate.id, second.sha]], 'both failures of the outcome hang under one hold');
  assert.equal(beta.state, 'open');

  // Candidate 3: UAT never serves it, so nothing is attributed to it and beta stays held.
  const thirdSha = repo.merge('GY-73', 703);
  const third = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-01T16:00:00Z'), push: true }) as any;
  const wrong = deployment([second.sha]);
  const unserved = await validateAndRecord(repo.git, third.candidate.id, 'https://uat.example.test', [], { base: 'main', push: true, timeoutMs: 0, fetcher: wrong.fetcher, file,
    holds: releaseHolds(repo.git, { contract, push: true, file, report: async () => ({ runId: `rc-${third.candidate.id}`, url: 'https://uat.example.test', environment: 'uat', sha: thirdSha, startedAt: '', finishedAt: '', passed: 4, failed: 0,
      cases: cases.map(entry => ({ id: entry.definition.id, title: '', file: entry.file, outcome: 'pass', verdict: 'passed', required: true, durationMs: 1, attempts: 1, attemptResults: [], executed: 1, failingStep: null })) } as E2eReport) }) });
  assert.equal(unserved.record.result, 'failed'); assert.deepEqual(unserved.record.holds, []);
  assert.equal(foldHolds(readRecords<HoldRecord>(repo.git, holdTagPrefix))[1].state, 'open', 'a hold clears only on a candidate UAT served at its exact SHA');

  // Candidate 4 passes every case at its served SHA: beta clears.
  const fourth = await validateNext('GY-74', 704, '2026-10-01T18:00:00Z', {});
  assert.equal(fourth.result.record.result, 'passed');
  assert.deepEqual(fourth.result.record.holds, [{ kind: 'clear', outcome: 'beta', hold: 'beta', item: 'GY-702' }]);
  assert.ok(fourth.holds.every(hold => hold.state === 'cleared'));

  // Folding two outcomes' holds into one is a recorded decision with an independent approver, never automatic.
  const at = '2026-10-02T12:00:00.000Z', c = (id: string, sha: string) => ({ case: id, verdict: 'failed' as const, candidate: '20261002T120000Z', sha, runId: 'rc-20261002T120000Z', attempts: 2, failingStep: null });
  const open: HoldRecord[] = [
    { kind: 'open', outcome: 'alpha', hold: 'alpha', candidate: '20261002T120000Z', sha: '5'.repeat(40), at, cases: [c('a1', '5'.repeat(40))], item: 'GY-801' },
    { kind: 'open', outcome: 'beta', hold: 'beta', candidate: '20261002T120000Z', sha: '5'.repeat(40), at, cases: [c('b1', '5'.repeat(40))], item: 'GY-802' },
  ];
  const holds = foldHolds(open);
  const decision = { id: 'fold-1', action: 'fold', state: 'applied', input: { outcome: 'alpha', into: 'beta' }, requestedBy: 'master-agent', approvedBy: 'approver-agent' };
  assert.throws(() => foldRecord(holds, { ...decision, state: 'requested', approvedBy: null }, new Date()), /needs an applied fold decision with an independent approver/);
  assert.throws(() => foldRecord(holds, { ...decision, approvedBy: 'master-agent' }, new Date()), /approved by its own requester/);
  assert.throws(() => foldRecord(holds, { ...decision, input: { outcome: 'alpha', into: 'gamma' } }, new Date()), /Outcome gamma has no open release hold/);
  assert.throws(() => foldRecord(holds, decision, new Date(), 'beta'), /folds outcome alpha, not beta/);
  const fold = foldRecord(holds, decision, new Date('2026-10-02T13:00:00Z'));
  assert.deepEqual(fold.decision, { id: 'fold-1', requestedBy: 'master-agent', approvedBy: 'approver-agent' });
  const folded = foldHolds([...open, fold]);
  assert.deepEqual(folded.map(hold => [hold.outcome, hold.state, hold.foldedInto]), [['alpha', 'folded', 'beta'], ['beta', 'open', null]]);
  assert.deepEqual(folded[1].outcomes, ['beta', 'alpha']); assert.deepEqual(folded[1].cases.map(entry => entry.case), ['b1', 'a1']);
  assert.throws(() => foldRecord(folded, decision, new Date()), /already share one hold/);
});

test('unit:release-candidate-zero-touch-suite — every release candidate runs the zero-touch onboarding scenario at its exact SHA as a required suite of its UAT validation, so a scenario that fails, naming the step that needed a person, fails the candidate and blocks its promotion', async () => {
  const workflow = await readFile(new URL('../.github/workflows/release-candidate.yml', import.meta.url), 'utf8');
  const uat = workflow.slice(workflow.indexOf('\n  uat:\n'), workflow.indexOf('\n  promote:\n'));
  // The uat job checks out the candidate's exact SHA and installs it; release validate runs the scenario there as a suite of its record.
  assert.match(uat, /- uses: actions\/checkout@v4\n\s+with: \{ ref: '\$\{\{ env\.CANDIDATE_SHA \}\}'/);
  assert.match(uat, /- run: npm ci\n/);
  const validate = uat.slice(uat.indexOf('node bin/graphyard.mjs release validate'), uat.indexOf('- name: Record the E2E case runs'));
  assert.match(validate, /--suite 'zero-touch=node --import tsx --eval "import\(\\"\.\/src\/release-candidate\.ts\\"\)\.then\(m => m\.runZeroTouchSuite\(\)\)"'/, 'release validate runs the zero-touch suite');
  assert.doesNotMatch(uat.slice(0, uat.indexOf('node bin/graphyard.mjs release validate')), /continue-on-error/);
  assert.match(workflow.slice(workflow.indexOf('\n  promote:\n')), /needs: \[candidate, uat\]\n\s+if: needs\.uat\.result == 'success'/, 'promotion follows only a passed UAT validation');
  assert.equal(zeroTouchScenario, 'tests/zero-touch-onboarding.test.ts');
  assert.match(await readFile(new URL(`../${zeroTouchScenario}`, import.meta.url), 'utf8'), /test\('unit:zero-touch-onboarding — /, 'the suite runs the zero-touch scenario');

  // The suite runs the scenario through the test runner on this checkout; its failing step becomes the suite's detail.
  const runs: string[][] = [];
  let outcome = { status: 1, stdout: '✖ failing tests:\n\ntest at tests/zero-touch-onboarding.test.ts:1:1\n✖ unit:zero-touch-onboarding\n  AssertionError [ERR_ASSERTION]: no human step but the one App approval: a person had to merge on GitHub: #1 merged by hand\n' };
  const fake = ((program: string, args: string[]) => { runs.push([program, ...args]); return { ...outcome, stderr: '', signal: null }; }) as unknown as typeof spawnSync;
  const scratch = await temporaryDirectory('release-candidate-zero-touch'), detailFile = join(scratch, 'detail');
  const exitCode = process.exitCode, written = process.stdout.write;
  (process.stdout as any).write = () => true;
  let failed, passed;
  try {
    failed = runZeroTouchSuite({ GRAPHYARD_SUITE_DETAIL: detailFile }, fake);
    outcome = { status: 0, stdout: '✔ unit:zero-touch-onboarding\n' };
    passed = runZeroTouchSuite({}, fake);
  } finally { (process.stdout as any).write = written; process.exitCode = exitCode; }
  assert.deepEqual(runs[0], [process.execPath, '--import', 'tsx', 'tests/helpers/run-tests.ts', zeroTouchScenario]);
  assert.equal(failed.passed, false);
  assert.equal(failed.detail, `${zeroTouchScenario} failed: AssertionError [ERR_ASSERTION]: no human step but the one App approval: a person had to merge on GitHub: #1 merged by hand`);
  assert.equal((await readFile(detailFile, 'utf8')).trim(), failed.detail, 'release validate reads the detail the suite wrote');
  assert.equal(passed.passed, true);

  // As a suite of the candidate's record: a failed scenario fails the candidate, its follow-up names the suite and the step, and promotion is refused.
  const repo = await repository();
  const sha = repo.merge('GY-71', 701);
  const { candidate } = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-01T12:00:00Z'), push: true }) as any;
  const filed: any[] = [];
  const scenario = (result: { passed: boolean; detail: string }): Suite => ({ name: 'zero-touch', run: async () => ({ name: 'zero-touch', ...result }) });
  const record = await validateAndRecord(repo.git, candidate.id, 'https://uat.example.test', [scenario(failed)],
    { base: 'main', push: true, timeoutMs: 60_000, fetcher: deployment([sha]).fetcher, sleep: async () => {}, file: async item => { filed.push(item); return 'GY-971'; } });
  assert.equal(record.record.result, 'failed');
  assert.match(filed[0].title, /failed UAT suite zero-touch/);
  assert.match(filed[0].description, /a person had to merge on GitHub/, 'the follow-up names the step that needed a person');
  const refused = promote(repo.git, candidate.id, { base: 'main', push: true, now: new Date() });
  assert.equal(refused.promoted, false); assert.match(refused.refusals!.join(' '), /failed UAT \(zero-touch\)/, 'a failing scenario blocks promotion');
  const next = repo.merge('GY-72', 702);
  const { candidate: second } = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-02T12:00:00Z'), push: true }) as any;
  const green = await validateAndRecord(repo.git, second.id, 'https://uat.example.test', [scenario(passed)],
    { base: 'main', push: true, timeoutMs: 60_000, fetcher: deployment([next]).fetcher, sleep: async () => {}, file: async item => { filed.push(item); return 'GY-972'; } });
  assert.equal(green.record.result, 'passed', JSON.stringify(green.record.suites));
});

// GY-1488: merged→production p90 was 243 minutes because candidates were cut every two hours and a
// failed one cost another two. The loop now cuts the next candidate as soon as the last concludes.
const promoSha = (seed: string) => seed.repeat(40).slice(0, 40);
function promotionStub(ledger: PromotionLedger, runs: PromotionRun[]) {
  const state = { ledger, runs, dispatches: 0 };
  const reads: PromotionReads = { ledger: async () => state.ledger, runs: async () => state.runs, dispatch: async () => { state.dispatches++; } };
  return { state, reads };
}

test('unit:continuous-promotion — the next candidate is cut as soon as none is in flight and main has moved, held while one is in flight, never re-cut after a failure until main moves past it, and spaced by the 10-minute minimum gap; the cron is only a fallback', async () => {
  const T = Date.parse('2026-10-07T12:00:00Z'), min = 60_000, iso = (at: number) => new Date(at).toISOString();
  const PROMOTED = promoSha('a'), A = promoSha('b'), B = promoSha('c'), C = promoSha('d');
  assert.equal(defaultPromoteEveryMinutes, 10);
  const every = defaultPromoteEveryMinutes;
  const cycle = async (previous: PromotionState | null, reads: PromotionReads, now: number) => {
    const result = await promotionCycle(previous, reads, { now, everyMinutes: every, intervalMs: 20_000 });
    return { ...result, state: promotionStateSchema.parse(result.state) };
  };

  // Idle with new commits: a candidate concluded 3 minutes ago (after a 25-minute run), main has moved; dispatched at once, not two hours later.
  const { state: stub, reads } = promotionStub({ mainSha: A, promotedSha: PROMOTED, promotedAt: iso(T - 3 * min), behind: 2 },
    [{ status: 'completed', createdAt: iso(T - 28 * min), event: 'workflow_dispatch', headSha: PROMOTED }]);
  let result = await cycle(null, reads, T);
  assert.equal(result.dispatched, true);
  assert.equal(result.state.cutSha, A);

  // In flight: main moves again while the candidate is in validation; nothing more is dispatched however long it runs.
  stub.ledger = { ...stub.ledger, mainSha: B, behind: 3 };
  stub.runs = [{ status: 'in_progress', createdAt: iso(T + 5_000), event: 'workflow_dispatch', headSha: A }, ...stub.runs];
  let state = result.state;
  for (let now = T + 20_000; now < T + 25 * min; now += 20_000) {
    result = await cycle(state, reads, now); state = result.state;
    assert.equal(result.dispatched, false);
  }
  assert.equal(state.inFlight, true);
  assert.match(state.reason ?? '', /in validation/);

  // Failure: the candidate of A concludes without promoting; main still holds A, so A is never cut again.
  stub.ledger = { ...stub.ledger, mainSha: A, behind: 2 };
  stub.runs = stub.runs.map((run, index) => index === 0 ? { ...run, status: 'completed' } : run);
  for (let now = T + 25 * min; now < T + 40 * min; now += 20_000) {
    result = await cycle(state, reads, now); state = result.state;
    assert.equal(result.dispatched, false, 'a failed candidate is not cut again while main is unchanged');
  }
  assert.equal(state.inFlight, false);
  assert.match(state.reason ?? '', /did not promote it; the next is dispatched as soon as main moves past it/);
  assert.equal(state.nextDueAt, null);
  // Main moves past the failed candidate: the next is dispatched within a ledger read window, not after a fixed interval.
  stub.ledger = { ...stub.ledger, mainSha: B, behind: 3 };
  let dispatchedAt: number | null = null;
  for (let now = T + 40 * min; now < T + 50 * min && dispatchedAt === null; now += 20_000) {
    result = await cycle(state, reads, now); state = result.state;
    if (result.dispatched) dispatchedAt = now;
  }
  assert.ok(dispatchedAt !== null && dispatchedAt - (T + 40 * min) <= promotionReadWindows(20_000).ledgerMs, 'dispatched as soon as main moved past the failed candidate');
  assert.equal(state.cutSha, B);
  assert.equal(stub.dispatches, 2);

  // Minimum gap: a candidate that fails within a minute of its cut, with main already moved, waits out the 10-minute gap.
  const failedAt = dispatchedAt!;
  stub.runs = [{ status: 'completed', createdAt: iso(failedAt + 5_000), event: 'workflow_dispatch', headSha: B }, ...stub.runs];
  stub.ledger = { ...stub.ledger, mainSha: C, behind: 4 };
  let next: number | null = null;
  for (let now = failedAt + 20_000; now < failedAt + 20 * min && next === null; now += 20_000) {
    result = await cycle(state, reads, now); state = result.state;
    if (result.dispatched) next = now;
    else if (now - failedAt < every * min) assert.match(state.reason ?? '', /no sooner than 10 minute/);
  }
  assert.ok(next !== null && next - failedAt >= every * min && next - failedAt < every * min + 2 * min, `the next cut waited out the gap (${next === null ? 'none' : (next - failedAt) / min} min)`);
  assert.equal(stub.dispatches, 3);

  // Success: the candidate of C promotes; the ledger is re-read the cycle it concludes, so production at main dispatches nothing.
  stub.runs = [{ status: 'in_progress', createdAt: iso(next! + 5_000), event: 'workflow_dispatch', headSha: C }, ...stub.runs];
  result = await cycle(state, reads, next! + 11 * min); state = result.state;
  assert.equal(state.inFlight, true);
  stub.runs = stub.runs.map((run, index) => index === 0 ? { ...run, status: 'completed' } : run);
  stub.ledger = { mainSha: C, promotedSha: C, promotedAt: iso(next! + 25 * min), behind: 0 };
  result = await cycle(state, reads, next! + 25 * min); state = result.state;
  assert.equal(result.dispatched, false);
  assert.equal(state.promotedSha, C, 'the concluded candidate\'s promotion is read at once');
  assert.match(state.reason ?? '', /nothing to promote/);

  // The workflow's cron stays, only as a fallback: no more often than every six hours.
  const workflow = await readFile(new URL('../.github/workflows/release-candidate.yml', import.meta.url), 'utf8');
  assert.match(workflow, /- cron: '0 \*\/6 \* \* \*'/);
  assert.match(workflow, /fallback/);
});

test('unit:promotion-latency-target — master status judges merged→production p50/p90 against a 45-minute p90 target', () => {
  assert.equal(defaultDeliverySpeedTargets.mergedToProductionP90Ms, 45 * 60_000);
  const now = Date.parse('2026-10-07T12:00:00Z'), hour = 3_600_000, iso = (at: number) => new Date(at).toISOString();
  // Ten items merged an hour ago, promoted after 40 (within) or 60 minutes (over the target).
  const item = (index: number, promotedAfterMs: number) => ({
    id: `id-${index}`, key: `GY-${index}`, stage: 'done', createdAt: iso(now - 5 * hour), closure: null,
    delivery: { mergedAt: iso(now - 2 * hour), mergedAtRepository: iso(now - 2 * hour) },
    releaseDeliveries: [{ environment: 'production', verifiedAt: iso(now - 2 * hour + promotedAfterMs) }],
  }) as any;
  const within = deliverySpeed(Array.from({ length: 10 }, (_, index) => item(index, 40 * 60_000)), { now, productionEnvironment: 'production' });
  assert.equal(within.targets.mergedToProductionP90Ms, 45 * 60_000);
  assert.equal(within.mergedToProduction['7d'].p50Ms, 40 * 60_000);
  assert.equal(within.mergedToProduction['7d'].p90Ms, 40 * 60_000);
  assert.deepEqual(deliverySpeedBreaches(within).filter(breach => breach.measure === 'mergedToProduction'), []);
  const slow = deliverySpeed(Array.from({ length: 10 }, (_, index) => item(index, hour)), { now, productionEnvironment: 'production' });
  assert.match(deliverySpeedBreaches(slow).find(breach => breach.measure === 'mergedToProduction')?.text ?? '', /p90 is 1h over 7 days \(10 items\), above the 45 min target/);
});

// GY-1491: a candidate carrying every merge since the last promotion implicates all of them when it
// fails and holds back everything behind it. Each candidate now carries at most 10.
test('unit:release-candidate-pr-cap — a backlog of 23 merges is cut into candidates of 10, 10 and 3 in merge order; a failed candidate\'s successor starts after it; the loop cuts the queued merges as soon as a capped candidate concludes; master status shows each candidate\'s PR count and queue', async () => {
  // Imported here, not at the top, so the file still loads (and this test fails as a case) without GY-1491.
  const { defaultMaxPrs, maxPrsFrom } = await import('../src/release-candidate.js') as Record<string, any>;
  assert.equal(defaultMaxPrs, 10);
  assert.equal(maxPrsFrom(undefined), 10); assert.equal(maxPrsFrom('4'), 4);
  assert.throws(() => maxPrsFrom('0'), /positive integer/);
  const repo = await repository();
  repo.merge('GY-1', 1);
  const first = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-07T10:00:00Z'), push: true }) as any;
  assert.ok(first.cut); assert.equal(first.candidate.from, null, 'the first candidate has nothing to start after');
  const merges = Array.from({ length: 23 }, (_, index) => repo.merge(`GY-${100 + index}`, 100 + index));
  const keys = (candidate: any) => candidate.items.map((item: any) => item.key);
  const series = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `GY-${100 + from + index}`).reverse();

  // The first ten merges in merge order, cut at the tenth; thirteen stay queued behind it.
  const a = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-07T11:00:00Z'), push: true }) as any;
  assert.ok(a.cut);
  assert.equal(a.candidate.sha, merges[9], 'cut at the 10th merge, not main\'s tip');
  assert.deepEqual([a.candidate.prs, a.candidate.queued], [10, 13]);
  assert.deepEqual(a.candidate.from, { id: first.candidate.id, sha: first.candidate.sha });
  assert.deepEqual(keys(a.candidate).slice(0, 10), series(0, 10));
  assert.equal(run(repo.origin, 'rev-parse', `refs/tags/rc/${a.candidate.id}^{commit}`), merges[9], 'the tag sits on the capped commit');

  // It fails UAT: its successor starts after it, carrying the next ten, and its own deliveries ride along unpromoted.
  const failed = await validateAndRecord(repo.git, a.candidate.id, 'https://uat.example.test', [recordingSuite('long', false, [])],
    { base: 'main', push: true, timeoutMs: 0, fetcher: deployment([merges[9]]).fetcher, file: async () => 'GY-999' });
  assert.equal(failed.record.result, 'failed');
  const b = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-07T12:00:00Z'), push: true }) as any;
  assert.equal(b.candidate.sha, merges[19]);
  assert.deepEqual([b.candidate.prs, b.candidate.queued], [10, 3]);
  assert.deepEqual(b.candidate.from, { id: a.candidate.id, sha: merges[9] }, 'the failed candidate\'s successor starts after it');
  assert.deepEqual(keys(b.candidate).slice(0, 20), series(0, 20), 'nothing was promoted, so promoting it would bring the failed candidate\'s deliveries too');

  // The last three reach main's tip, and a tip already cut is not cut again.
  const c = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-07T13:00:00Z'), push: true }) as any;
  assert.equal(c.candidate.sha, merges[22]);
  assert.deepEqual([c.candidate.prs, c.candidate.queued], [3, 0]);
  const again = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-07T14:00:00Z'), push: true }) as any;
  assert.equal(again.cut, false);
  const listed = ledgerStatus(readLedger(repo.git));
  assert.deepEqual(listed.slice(0, 3).map(entry => [entry.prs, entry.queued]), [[3, 0], [10, 3], [10, 13]], 'release status lists each candidate\'s PR count and queue at its cut');

  // A configured cap: four merges after the last candidate, at most two each.
  for (let index = 0; index < 4; index++) repo.merge(`GY-${200 + index}`, 200 + index);
  const small = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-07T15:00:00Z'), push: true, maxPrs: 2 }) as any;
  assert.deepEqual([small.candidate.prs, small.candidate.queued], [2, 2]);

  // The loop reads the newest candidates with what is queued behind each on main now, for master status.
  const config = { repository: 'owner/repo', baseBranch: 'main' } as MasterConfig;
  const reads = promotionReads(config, repo.work, (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), true)!;
  const ledger = await reads.ledger();
  assert.deepEqual(ledger.candidates!.map(entry => [entry.id, entry.prs, entry.queued]),
    [[small.candidate.id, 2, 2], [c.candidate.id, 3, 4], [b.candidate.id, 10, 7], [a.candidate.id, 10, 17], [first.candidate.id, 2, 27]]);

  // A capped candidate concludes with main unmoved since its dispatch: the queued merges are dispatched at once rather than waiting for a new merge.
  const T = Date.parse('2026-10-07T16:00:00Z'), min = 60_000, iso = (at: number) => new Date(at).toISOString();
  const MAIN = promoSha('e'), CAPPED = promoSha('f');
  const older = { id: '20261007T120000Z', sha: promoSha('d'), cutAt: iso(T - 4 * 60 * min), prs: 10, queued: 23 };
  // The runner stamps cutAt by its own clock: one behind the loop's dispatch stamp changes nothing, as the candidate is told by its id.
  const cappedLedger = (cutAt: number): PromotionLedger => ({ mainSha: MAIN, promotedSha: promoSha('a'), promotedAt: null, behind: 23,
    candidates: [{ id: '20261007T160100Z', sha: CAPPED, cutAt: iso(cutAt), prs: 10, queued: 13 }, older] });
  const { state: stub, reads: loopReads } = promotionStub(cappedLedger(T - 5 * min), [{ status: 'in_progress', createdAt: iso(T), event: 'workflow_dispatch', headSha: MAIN }]);
  const previous = promotionStateSchema.parse({ checkedAt: iso(T), mainSha: MAIN, promotedSha: promoSha('a'), promotedAt: null, behind: 23, ledgerReadAt: iso(T), inFlight: true,
    runsReadAt: iso(T), dispatchedAt: iso(T), lastDispatchAt: iso(T), cutSha: MAIN, candidates: [older], candidateAtDispatch: older.id, nextDueAt: null, reason: null });
  stub.runs = [{ ...stub.runs[0], status: 'completed' }];
  const concluded = await promotionCycle(previous, loopReads, { now: T + 30 * min, everyMinutes: 10, intervalMs: 20_000 });
  assert.equal(concluded.dispatched, true, 'the merges queued behind a capped candidate go out once it concludes');
  assert.match(concluded.state.reason ?? '', /13 merge\(s\) queued behind candidate 20261007T160100Z/);
  const report = promotionStatus(promotionStateSchema.parse(concluded.state));
  assert.deepEqual(report.candidates, [{ id: '20261007T160100Z', sha: CAPPED, prs: 10, queued: 13, soak: null }, { id: older.id, sha: older.sha, prs: 10, queued: 23, soak: null }]);
  assert.equal(concluded.state.candidateAtDispatch, '20261007T160100Z', 'the dispatch records the candidate it follows');
  // An older candidate's queue is not this run's: a run that cut nothing waits for main to move, as before.
  stub.ledger = { ...cappedLedger(T), candidates: [older] };
  stub.runs = [{ status: 'completed', createdAt: iso(T), event: 'workflow_dispatch', headSha: MAIN }];
  const uncut = await promotionCycle(previous, loopReads, { now: T + 30 * min, everyMinutes: 10, intervalMs: 20_000 });
  assert.equal(uncut.dispatched, false);
  assert.match(uncut.state.reason ?? '', /did not promote it/);
  // Nor does the queued run's own conclusion chain another dispatch when that run too cut nothing.
  stub.ledger = cappedLedger(T);
  stub.runs = [{ status: 'completed', createdAt: iso(T + 30 * min), event: 'workflow_dispatch', headSha: MAIN }];
  const settled = await promotionCycle({ ...promotionStateSchema.parse(concluded.state), inFlight: true }, loopReads, { now: T + 130 * min, everyMinutes: 10, intervalMs: 20_000 });
  assert.equal(settled.dispatched, false, 'the candidate the last dispatch followed is not followed twice');
});

// GY-1513: a candidate promoted about 8 minutes into its run, but the run stayed in progress ~17
// minutes more for the advisory soak and timing-budget suites, and the loop cut nothing until it
// concluded. The soak now runs in a workflow of its own, dispatched with the candidate's SHA.
/** One soak run as the loop keeps it; imported lazily below so this file still loads without GY-1513. */
type SoakRun = { sha: string; status: string; conclusion: string | null; createdAt: string; url: string | null };
const soakExports = async () => await import('../src/daemon/deployment.js') as unknown as { soakWorkflow: string; soakRuns: (listed: unknown) => SoakRun[]; promotionInFlightReadMs: (intervalMs: number) => number };
/** The soak's ledger record (rc-soak/ID) as src/release-candidate.ts keeps it, imported lazily for the same reason. */
type LedgerSoakRecord = { id: string; sha: string; result: 'passed' | 'failed' | 'cancelled'; at: string; run: string | null; report: string | null };
const ledgerExports = async () => await import('../src/release-candidate.js') as unknown as { soakTagPrefix: string;
  recordSoak: (git: ReturnType<typeof gitIn>, id: string, input: { sha: string; result: LedgerSoakRecord['result']; run: string | null; report: string | null; base: string; now: Date; push: boolean }) => { recorded: boolean; record: LedgerSoakRecord } };
const workflowJob = (workflow: string, id: string) => {
  const start = workflow.indexOf(`\n  ${id}:\n`);
  assert.ok(start >= 0, `the workflow declares job ${id}`);
  const rest = workflow.slice(start + 1), next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
};

test('unit:soak-runs-outside-release-run — release-candidate-soak.yml runs the soak and timing-budget steps unchanged for the exact SHA each release run cut, started by that run in a concurrency group of its own; release-candidate.yml has no long-suites job', async () => {
  const { soakWorkflow, soakRuns } = await soakExports();
  const release = await readFile(new URL('../.github/workflows/release-candidate.yml', import.meta.url), 'utf8');
  const soak = await readFile(new URL(`../.github/workflows/${soakWorkflow}`, import.meta.url), 'utf8');
  assert.equal(soakWorkflow, 'release-candidate-soak.yml');
  assert.doesNotMatch(release, /^ {2}long-suites:$/m, 'the release run has no long-suites job');
  assert.doesNotMatch(release, /ci-tests\.mjs release-candidate|npm test|bubblewrap|timing-report/, 'nothing of the soak runs in the release run');
  // The release run starts the soak with the SHA its candidate job cut or pinned, and does not wait for it.
  const starter = workflowJob(release, 'soak');
  assert.match(starter, /^ {4}needs: candidate$/m);
  assert.match(starter, /^ {4}if: needs\.candidate\.outputs\.sha != ''$/m);
  assert.match(starter, /^ {6}CANDIDATE_SHA: \$\{\{ needs\.candidate\.outputs\.sha \}\}$/m);
  assert.match(starter, /^ {6}actions: write$/m, 'only the dispatch is granted');
  assert.match(starter, /gh workflow run release-candidate-soak\.yml --repo "\$GITHUB_REPOSITORY" --ref main -f sha="\$CANDIDATE_SHA" -f candidate="\$\{\{ needs\.candidate\.outputs\.id \}\}"/);
  for (const id of ['uat', 'promote']) assert.doesNotMatch(workflowJob(release, id).match(/^ {4}needs: .*$/m)![0], /soak/, `${id} never waits for the soak`);
  // So the release run concludes with promote, the last job whose verdict counts.
  assert.match(workflowJob(release, 'promote'), /^ {4}needs: \[candidate, uat\]$/m);

  // The soak workflow: dispatched with a sha, never on a pull request, push or schedule, in a group of its own per SHA.
  const on = soak.slice(soak.indexOf('\non:\n') + 1, soak.indexOf('\npermissions:'));
  assert.match(on, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}sha:\n[\s\S]*?required: true/m);
  assert.doesNotMatch(on, /pull_request|push|schedule/);
  assert.match(soak, /^run-name: Soak \$\{\{ inputs\.candidate \|\| 'pinned' \}\} \$\{\{ inputs\.sha \}\}$/m, 'the run name carries the SHA master status matches it by');
  assert.match(soak, /^concurrency:\n(?: {2}#.*\n)* {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ inputs\.sha \}\}\n {2}cancel-in-progress: false$/m);
  assert.notEqual(soak.match(/^name: (.*)$/m)![1], release.match(/^name: (.*)$/m)![1], 'its group never shares the release run\'s workflow name');
  // Its one job is today's long-suites job, steps unchanged, only now reading the dispatched SHA.
  const job = workflowJob(soak, 'long-suites');
  const steps = [...job.matchAll(/^ {6}- (?:name: (.*)|uses: (\S+)|run: (.*))$/gm)].map(match => match[1] ?? match[2] ?? match[3]);
  assert.deepEqual(steps, ['Refuse anything but a full commit SHA', 'actions/checkout@v4', 'actions/setup-node@v4', 'npm ci', 'Install bubblewrap (the soak confines every simulated launch in real namespaces)',
    'Run the release-candidate test files', 'Summarise the timing-dependent assertions', 'actions/upload-artifact@v4'], 'the soak and timing-budget steps are today\'s, in order');
  for (const line of ['node scripts/ci-tests.mjs release-candidate --suite timing-budget --out "$RUNNER_TEMP/timing-budget-tests.txt"', 'export GRAPHYARD_TIMING_SLACK=1.5 GRAPHYARD_TIMING_RECORD="$RUNNER_TEMP/timing/release-candidate.jsonl"',
    'npm test -- --files-from "$RUNNER_TEMP/timing-budget-tests.txt" --test-concurrency=1 --durations "$RUNNER_TEMP/timing/durations-timing-budget.jsonl" 2>&1 | tee "$RUNNER_TEMP/timing/test-timing-budget.log" || status=1',
    'npm test -- --files-from "$RUNNER_TEMP/soak-tests.txt" --durations "$RUNNER_TEMP/timing/durations-soak.jsonl" 2>&1 | tee "$RUNNER_TEMP/timing/test-soak.log" || status=1',
    "with: { ref: '${{ env.CANDIDATE_SHA }}', persist-credentials: false }"]) assert.ok(job.includes(line), `the soak job keeps: ${line}`);
  assert.match(job, /^ {6}CANDIDATE_SHA: \$\{\{ inputs\.sha \}\}$/m);
  assert.match(job, /^ {4}timeout-minutes: 60$/m);
});

test('unit:soak-verdict-still-recorded — the soak\'s verdict and timing report stay advisory: its run records them on the candidate\'s ledger record (rc-soak/ID), release status and master status list them beside the candidate, running while the run is, and promotion never reads them', async () => {
  const { soakWorkflow, soakRuns } = await soakExports();
  const release = await readFile(new URL('../.github/workflows/release-candidate.yml', import.meta.url), 'utf8');
  const soak = await readFile(new URL(`../.github/workflows/${soakWorkflow}`, import.meta.url), 'utf8');
  // Advisory: the UAT record takes no soak suite, so a soak failure never blocks promotion.
  assert.doesNotMatch(workflowJob(release, 'uat'), /--suite '(soak|long-suites|timing)/);
  // The timing report and its artifact are on the soak's run, whatever the suites' verdict.
  assert.match(soak, /- name: Summarise the timing-dependent assertions\n {8}if: always\(\)\n {8}run: npx tsx tests\/helpers\/timing-report\.ts/);
  assert.match(soak, /name: graphyard-release-candidate-timing/);
  // The soak run then records its verdict, itself and the report's name on the candidate's record, whatever the verdict, for a cut candidate only.
  const record = workflowJob(soak, 'record');
  assert.match(record, /^ {4}needs: long-suites$/m);
  assert.match(record, /^ {4}if: \$\{\{ always\(\) && inputs\.candidate != '' \}\}$/m);
  assert.match(record, /^ {6}SOAK_RESULT: \$\{\{ needs\.long-suites\.result \}\}$/m);
  assert.match(record, /^ {6}contents: write$/m, 'the record is a tag pushed to the repository');
  assert.match(record, /node bin\/graphyard\.mjs release soak "\$\{\{ inputs\.candidate \}\}" --sha "\$CANDIDATE_SHA" --result "\$SOAK_RESULT" --run "\$GITHUB_SERVER_URL\/\$GITHUB_REPOSITORY\/actions\/runs\/\$GITHUB_RUN_ID" --report graphyard-release-candidate-timing/);
  assert.match((await readFile(new URL('../src/cli/release.ts', import.meta.url), 'utf8')), /release soak ID --sha SHA --result success\|failure\|cancelled \[--run URL\] \[--report NAME\]/, 'the release CLI documents the subcommand');

  // The record on the ledger: the candidate's exact SHA, once, never a promotion input.
  const { recordSoak, soakTagPrefix } = await ledgerExports();
  const repo = await repository();
  repo.merge('GY-51', 501);
  const cutResult = cut(repo.git, { base: 'main', trigger: 'manual', now: new Date('2026-10-08T03:00:00Z'), push: true }) as any;
  const candidate = cutResult.candidate, runUrl = 'https://github.test/owner/repo/actions/runs/77';
  assert.throws(() => recordSoak(repo.git, candidate.id, { sha: promoSha('9'), result: 'passed', run: runUrl, report: null, base: 'main', now: new Date(), push: true }), /not the soaked/);
  const recorded = recordSoak(repo.git, candidate.id, { sha: candidate.sha, result: 'failed', run: runUrl, report: 'graphyard-release-candidate-timing', base: 'main', now: new Date('2026-10-08T03:30:00Z'), push: true });
  assert.equal(recorded.recorded, true);
  assert.deepEqual(readRecords<LedgerSoakRecord>(repo.git, soakTagPrefix), [{ id: candidate.id, sha: candidate.sha, result: 'failed', at: '2026-10-08T03:30:00.000Z', run: runUrl, report: 'graphyard-release-candidate-timing' }]);
  assert.equal(remoteRef(repo.origin, `refs/tags/${soakTagPrefix}${candidate.id}^{commit}`), candidate.sha, 'the record is pushed, on the candidate\'s commit');
  assert.equal(recordSoak(repo.git, candidate.id, { sha: candidate.sha, result: 'passed', run: null, report: null, base: 'main', now: new Date(), push: true }).recorded, false, 'a re-run records nothing over the first verdict');
  assert.deepEqual(ledgerStatus(readLedger(repo.git))[0].soak, { result: 'failed', at: '2026-10-08T03:30:00.000Z', run: runUrl, report: 'graphyard-release-candidate-timing' }, 'release status lists it');
  assert.doesNotMatch(assessPromotion(candidate, null, null).refusals.join('; '), /soak/i, 'promotion reads the UAT record and nothing of the soak');
  // The loop's ledger read carries the record to master status, which shows it once no run of that SHA is running — and after the run has rolled off GitHub's list.
  const gitReads = promotionReads({ repository: 'owner/repo', baseBranch: 'main' } as MasterConfig, repo.work, (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), true)!;
  const ledgerRead = await gitReads.ledger();
  assert.deepEqual(ledgerRead.candidates![0].soak, { result: 'failed', at: '2026-10-08T03:30:00.000Z', run: runUrl });
  const fromRecord = promotionStatus(promotionStateSchema.parse((await promotionCycle(null, { ...gitReads, runs: async () => [], dispatch: async () => {}, soaks: async () => [] }, { now: Date.parse('2026-10-08T04:00:00Z'), everyMinutes: 10 })).state));
  assert.deepEqual(fromRecord.candidates[0].soak, { state: 'failed', at: '2026-10-08T03:30:00.000Z', url: runUrl });

  // The soak runs, as gh lists them, by the SHA their run name carries.
  const T = Date.parse('2026-10-08T03:00:00Z'), min = 60_000, iso = (at: number) => new Date(at).toISOString();
  const A = promoSha('b'), B = promoSha('c');
  const listed = soakRuns([
    { status: 'in_progress', conclusion: '', createdAt: iso(T + 9 * min), displayTitle: `Soak 20261008T0309Z ${B}`, url: 'https://github.test/runs/2' },
    { status: 'completed', conclusion: 'failure', createdAt: iso(T), displayTitle: `Soak 20261008T0300Z ${A.toUpperCase()}`, url: 'https://github.test/runs/1' },
    { status: 'completed', conclusion: 'success', createdAt: iso(T), displayTitle: 'Soak without a sha' },
  ]);
  assert.deepEqual(listed.map(run => [run.sha, run.status, run.conclusion]), [[B, 'in_progress', null], [A, 'completed', 'failure']]);

  const soaks: SoakRun[] = listed;
  let soakReads = 0;
  const candidates = [{ id: '20261008T0309Z', sha: B, cutAt: iso(T + 9 * min), prs: 1, queued: 0 }, { id: '20261008T0300Z', sha: A, cutAt: iso(T), prs: 2, queued: 1 }];
  const reads: PromotionReads = { ledger: async () => ({ mainSha: B, promotedSha: B, promotedAt: iso(T + 17 * min), behind: 0, candidates }), runs: async () => [], dispatch: async () => {},
    soaks: async () => { soakReads++; return soaks; } };
  // B promoted, production runs main, and its soak still runs: master status shows it running for B's SHA.
  let state = promotionStateSchema.parse((await promotionCycle(null, reads, { now: T + 18 * min, everyMinutes: 10, intervalMs: 20_000 })).state);
  let status = promotionStatus(state);
  assert.equal(status.inFlight, false, 'the soak is not a candidate in validation');
  assert.deepEqual(status.candidates.map(candidate => [candidate.id, candidate.soak?.state ?? null]), [['20261008T0309Z', 'running'], ['20261008T0300Z', 'failed']]);
  assert.equal(status.candidates[0].soak?.url, 'https://github.test/runs/2');
  // It is re-read while it runs, so its conclusion shows even with nothing left to promote.
  soaks[0] = { ...soaks[0], status: 'completed', conclusion: 'success' };
  state = promotionStateSchema.parse((await promotionCycle(state, reads, { now: T + 40 * min, everyMinutes: 10, intervalMs: 20_000 })).state);
  assert.equal(promotionStatus(state).candidates[0].soak?.state, 'passed');
  // A running run outranks the record (a re-run of the same SHA); the record outranks a concluded run's own words.
  const withRecord = { ...state, candidates: state.candidates!.map((candidate, index) => index === 0 ? { ...candidate, soak: { result: 'failed', at: iso(T + 35 * min), run: 'https://github.test/runs/9' } } : candidate) };
  assert.deepEqual(promotionStatus(promotionStateSchema.parse(withRecord)).candidates[0].soak, { state: 'failed', at: iso(T + 35 * min), url: 'https://github.test/runs/9' });
  assert.equal(promotionStatus(promotionStateSchema.parse({ ...withRecord, soaks: [{ ...soaks[0], status: 'in_progress', conclusion: null }] })).candidates[0].soak?.state, 'running');
  // Once none runs and every recent candidate has its soak, the loop stops reading them.
  const settled = soakReads;
  state = promotionStateSchema.parse((await promotionCycle(state, reads, { now: T + 60 * min, everyMinutes: 10, intervalMs: 20_000 })).state);
  assert.equal(soakReads, settled);
  // A failed soak read is advisory: the last read stands and the cycle reports no failure.
  const failing = await promotionCycle({ ...state, soaks: [{ ...soaks[0], status: 'in_progress', conclusion: null }], soaksReadAt: null }, { ...reads, soaks: async () => { throw new Error('gh: rate limited'); } }, { now: T + 61 * min, everyMinutes: 10 });
  assert.equal(failing.failure, null);
  assert.equal(promotionStatus(failing.state).candidates[0].soak?.state, 'running');

  // The loop reads the soak workflow only where the repository has one.
  const root = await temporaryDirectory('soak-reads'), config = { repository: 'o/r', baseBranch: 'main' } as MasterConfig;
  const calls: string[][] = [];
  const child = (async (command: string, args: string[]) => { calls.push([command, ...args]); return JSON.stringify([{ status: 'queued', conclusion: null, createdAt: iso(T), displayTitle: `Soak pinned ${A}`, url: null }]); }) as any;
  assert.equal(promotionReads(config, root, child, true)!.soaks, undefined);
  await mkdir(join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(join(root, '.github', 'workflows', soakWorkflow), 'name: soak\n');
  assert.deepEqual(await promotionReads(config, root, child, true)!.soaks!(), [{ sha: A, status: 'queued', conclusion: null, createdAt: iso(T), url: null }]);
  assert.deepEqual(calls.at(-1), ['gh', 'run', 'list', '--repo', 'o/r', '--workflow', soakWorkflow, '--limit', '20', '--json', 'status,conclusion,createdAt,displayTitle,url']);
});

test('unit:promotion-ignores-running-soak — with main ahead of production, the next candidate is dispatched within one loop interval of the release run concluding while that candidate\'s soak still runs', async () => {
  const T = Date.parse('2026-10-08T03:00:00Z'), min = 60_000, interval = 20_000, iso = (at: number) => new Date(at).toISOString();
  const PROMOTED = promoSha('a'), A = promoSha('b'), B = promoSha('c');
  assert.equal(typeof (await soakExports()).soakRuns, 'function', 'the loop reads the soak workflow apart from the release runs');
  const soaks: SoakRun[] = [];
  const { state: stub, reads: base } = promotionStub({ mainSha: A, promotedSha: PROMOTED, promotedAt: iso(T - 30 * min), behind: 1 }, []);
  const reads: PromotionReads = { ...base, soaks: async () => soaks };
  const cycle = async (previous: PromotionState | null, now: number) => {
    const result = await promotionCycle(previous, reads, { now, everyMinutes: defaultPromoteEveryMinutes, intervalMs: interval });
    return { ...result, state: promotionStateSchema.parse(result.state) };
  };
  let result = await cycle(null, T);
  assert.equal(result.dispatched, true);
  // The release run cuts A, starts A's soak, and promotes A about 8 minutes in; B merges meanwhile.
  stub.runs = [{ status: 'in_progress', createdAt: iso(T + 5_000), event: 'workflow_dispatch', headSha: A }];
  soaks.push({ sha: A, status: 'in_progress', conclusion: null, createdAt: iso(T + 30_000), url: null });
  stub.ledger = { ...stub.ledger, mainSha: B, behind: 2, candidates: [{ id: 'rc-a', sha: A, cutAt: iso(T + 10_000), prs: 1, queued: 1 }] };
  let state = result.state, now = T;
  while ((now += interval) < T + 8 * min) {
    result = await cycle(state, now); state = result.state;
    assert.equal(result.dispatched, false, 'held while the release run validates A');
  }
  assert.equal(state.inFlight, true);
  // In flight, the runs are read once an interval (GY-1513), not once a minute: the conclusion is what the next dispatch waits for.
  assert.equal((await soakExports()).promotionInFlightReadMs(interval), interval);
  assert.deepEqual(promotionReadWindows(interval), { ledgerMs: 5 * 60_000, runsMs: 60_000 }, 'nothing in flight, once a minute still, and the windows keep their shape');
  const lastRead = now - interval;
  assert.equal(state.runsReadAt, iso(lastRead), 'the last cycle read the runs');
  // The release run concludes at promote one second after that read; A's soak runs on for another ~17 minutes.
  const concluded = lastRead + 1_000;
  stub.runs = [{ ...stub.runs[0], status: 'completed' }];
  stub.ledger = { ...stub.ledger, promotedSha: A, promotedAt: iso(concluded), behind: 1 };
  let dispatchedAt: number | null = null;
  for (now = lastRead + interval; now < concluded + 25 * min && dispatchedAt === null; now += interval) {
    result = await cycle(state, now); state = result.state;
    if (result.dispatched) dispatchedAt = now;
  }
  assert.ok(dispatchedAt !== null, 'the next candidate is dispatched while A soaks');
  assert.ok(dispatchedAt - concluded <= interval, `dispatched within one loop interval of the release run concluding (${(dispatchedAt - concluded) / 1000}s)`);
  assert.ok(dispatchedAt - Date.parse(state.lastDispatchAt!) < defaultPromoteEveryMinutes * min || state.lastDispatchAt === iso(dispatchedAt), 'inside the minimum gap: a promoting run is followed at once');
  assert.equal(soaks[0].status, 'in_progress', 'A\'s soak was still running');
  assert.equal(state.cutSha, B);
  assert.equal(stub.dispatches, 2);
  assert.equal(promotionStatus(state).candidates[0].soak?.state, 'running', 'master status shows A soaking beside B\'s cut');
});
