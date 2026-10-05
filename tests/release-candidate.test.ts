import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRailwayContext, project } from 'railway/iac';
import railway, { releaseBranches } from '../.railway/railway.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { commands } from '../src/cli/index.js';
import {
  apiSuite, assessProductionServing, commandSuite, cut, deployToUat, endpointSuite, gitIn, itemsFromCommits, ledgerStatus, productionBranch, promote, readLedger,
  servedRevision, uatBranch, validateAndRecord, type ReleaseCandidate, type Suite,
} from '../src/release-candidate.js';

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
