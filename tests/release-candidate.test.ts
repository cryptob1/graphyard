import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { createRailwayContext, project } from 'railway/iac';
import railway, { releaseBranches } from '../.railway/railway.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { commands } from '../src/cli/index.js';
import {
  apiSuite, assessProductionServing, commandSuite, cut, deployToUat, endpointSuite, gitIn, itemsFromCommits, ledgerStatus, productionBranch, promote, readLedger,
  servedRevision, uatBranch, validateAndRecord, type ReleaseCandidate, type Suite,
} from '../src/release-candidate.js';
import { loadCases, parseCase, type ReleaseContract } from '../src/e2e/case.js';
import * as e2eCase from '../src/e2e/case.js';
import { e2eSuite, type E2eReport } from '../src/e2e/runner.js';
import type { HoldRecord } from '../src/release-holds.js';
import { readRecords } from '../src/release-candidate.js';

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
  const api = async (path: string, data?: unknown) => { calls.push([path, data]); return path === 'work' ? [{ id: 'w-1', key: 'GY-7' }] : { released: true }; };
  await release!.run({ id: 'GY-7', args: ['3'], api, print: (value: unknown) => printed.push(value) } as any, undefined);
  assert.deepEqual(calls, [['work', undefined], ['work/w-1/release', { epoch: 3 }]]);
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
  assert.match(workflow, /e2e record "\$RUNNER_TEMP\/e2e-report\.json"/, 'a later step records the report with the release credential');
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
  const cutStep = workflow.slice(workflow.indexOf('- name: Cut a release candidate'), workflow.indexOf('long-suites:'));
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
