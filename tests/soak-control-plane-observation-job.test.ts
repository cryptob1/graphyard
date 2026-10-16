import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { MergerSettings } from '../src/merger-mode.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { CHECK_NAME, GitHub, processJob } from '../src/github.js';
import type { Observation } from '../src/model.js';
import type { Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1835 (review of 3b7408170110, B5): the observation worker's own job — `processJob`, the
 * App-backed server's pass — run across cycles, two control-plane candidates, a person-opened pull
 * request, a base tip that moves and a checkout that loses its base ref, keeps the system
 * invariants the merger promises: an unchanged control-plane candidate is written exactly once per
 * cycle and never more, GitHub is asked for no pull request, review or check run for it (and a
 * local observation failure never falls into the GitHub recovery that publishes and dequeues), a
 * person-opened pull request GitHub merges is still observed and delivered at once, and a failing
 * observation is retried at its bounded cadence with the failure standing on the job record.
 */

const APP = 1234, CI = 15368, REPOSITORY = 'owner/project';
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** GitHub's REST surface at the fetch level, as much of it as a person-opened pull request reads. */
class Api {
  main = sha('main-1');
  pulls = new Map<number, { head: string; branch: string; merged?: string | null }>();
  requests: { method: string; path: string }[] = [];
  open(pr: number, head: string, branch: string, merged?: string | null) { this.pulls.set(pr, { head, branch, merged }); }
  private body(method: string, path: string): unknown {
    if (method !== 'GET') return { id: 12 };
    const [route, query = ''] = path.replace(`/repos/${REPOSITORY}`, '').split('?'); const params = new URLSearchParams(query);
    if (route === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: this.main } };
    if (route === '/commits' && params.get('sha') === 'main') return [{ sha: this.main, parents: [{ sha: sha('root') }], commit: { message: 'base', tree: { sha: sha(`tree-${this.main}`) } } }];
    if (route === '/commits' && params.get('path')) return [];
    let match = /^\/pulls\/(\d+)$/.exec(route);
    if (match) {
      const pr = this.pulls.get(Number(match[1])) ?? { head: sha(`unknown-${match[1]}`), branch: 'graphyard/unknown' };
      return { number: Number(match[1]), state: pr.merged ? 'closed' : 'open', draft: false, merged: !!pr.merged, mergeable: !pr.merged, merge_commit_sha: pr.merged ?? null, merged_at: pr.merged ? new Date(Date.now() - 3_600_000).toISOString() : null, user: { login: 'implementer', id: 7 },
        head: { sha: pr.head, ref: pr.branch, repo: { full_name: REPOSITORY } }, base: { sha: this.main, ref: 'main', repo: { full_name: REPOSITORY } } };
    }
    if (/^\/pulls\/(\d+)\/reviews$/.test(route)) return [];
    const files = /^\/pulls\/(\d+)\/files$/.exec(route);
    if (files) {
      const head = this.pulls.get(Number(files[1]))?.head ?? sha(`unknown-${files[1]}`);
      return params.get('page') !== '1' ? [] : [{ filename: 'src/person.ts', status: 'modified', sha: sha(`blob-src/person.ts-${head}`), additions: 3, deletions: 1, patch: '@@' }];
    }
    if (/^\/commits\/[a-f0-9]{40}\/check-runs$/.test(route)) return { check_runs: params.get('check_name') ? [] : [{ id: 1, name: 'test', status: 'completed', conclusion: 'success', app: { id: CI } }] };
    if (/^\/commits\/[a-f0-9]{40}\/status$/.test(route)) return { statuses: [], total_count: 0 };
    match = /^\/commits\/([a-f0-9]{40})$/.exec(route);
    if (match) return { sha: match[1], parents: [], commit: { tree: { sha: sha(`tree-${match[1]}`) }, message: 'change' }, author: { login: 'implementer' } };
    match = /^\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/.exec(route);
    if (match) return { status: match[1] === match[2] ? 'identical' : 'diverged', ahead_by: 1, total_commits: 1, commits: [{ sha: match[2] }], files: [{ filename: 'src/person.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }] };
    if (route.endsWith('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: APP }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    if (route === '/rules/branches/main') return [];
    if (route === '/check-runs' || /^\/check-runs\/\d+$/.test(route)) return { id: 12 };
    if (/^\/contents\/.+/.test(route)) {
      const ref = new URLSearchParams(query).get('ref') ?? '';
      return { type: 'file', sha: sha(`blob-${decodeURIComponent(route.slice(10))}-${ref}`), path: decodeURIComponent(route.slice(10)) };
    }
    throw new Error(`Unexpected request ${method} ${path}`);
  }
  fetch = async (url: unknown, options: any = {}): Promise<Response> => {
    const method = options.method ?? 'GET'; const path = String(url).replace('https://api.github.com', '');
    if (path === '/graphql') return new Response(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (!path.startsWith(`/repos/${REPOSITORY}`)) throw new Error(`Unexpected request ${method} ${path}`);
    this.requests.push({ method, path: path.replace(`/repos/${REPOSITORY}`, '') });
    return new Response(JSON.stringify(this.body(method, path)), { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4900', 'x-ratelimit-reset': String(Math.ceil(Date.now() / 1000) + 3000), 'x-ratelimit-resource': 'core' } });
  };
  client() {
    const github = new GitHub({ repository: REPOSITORY, base: 'main', appId: APP, installationId: 2, privateKey: 'not-used' });
    Object.assign(github, { token: 'fixture-token', expires: Date.now() + 3_600_000, fetch: this.fetch });
    github.controlPlaneLogin = async () => 'graphyard-owner-project[bot]';
    return github;
  }
  count(kind: 'pulls' | 'reviews' | 'check-runs', pr?: number) {
    const patterns = {
      pulls: pr ? new RegExp(`^/pulls/${pr}$`) : /^\/pulls\/\d+$/,
      reviews: /^\/pulls\/\d+\/reviews/,
      'check-runs': /check-runs/,
    } as const;
    return this.requests.filter(request => request.method === 'GET' && patterns[kind].test(request.path)).length;
  }
}

let fixtureRoot: string, checkout: string;
let postgres: InstanceType<typeof EmbeddedPostgres>, store: Store, engine: Engine, api: Api;
const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1836;

async function commit(cwd: string, path: string, text: string, message: string) {
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(cwd, path, '..'), { recursive: true });
  await writeFile(join(cwd, path), text); git(cwd, 'add', '--', path); git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}
/** An item claimed by the worker on its own linked worktree, with one commit there. */
async function claimed(n: number) {
  let w = await engine.execute(operator, 'create', null, { title: `Observed ${n}`, plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, randomUUID());
  w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
  const pulled = await engine.pullAssignment(worker, { work: w.id }, randomUUID());
  assert.equal(pulled.assigned?.id, w.id, JSON.stringify(pulled.refused));
  const branch = `graphyard/gy-${n}-1`, worktree = join(checkout, '.graphyard', 'worktrees', `GY-${n}-1`);
  git(checkout, 'worktree', 'add', '-q', '-b', branch, worktree, 'refs/remotes/origin/main');
  git(worktree, 'config', 'user.email', 't@example.com'); git(worktree, 'config', 'user.name', 'T');
  const head = await commit(worktree, `src/item-${n}.ts`, `export const item = ${n};\n`, `item ${n}`);
  w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: worktree, branch }, randomUUID());
  return { w, head };
}
/** Every job due now; only the named items' jobs when any are given, the rest pushed out an hour. */
const due = async (...ids: string[]) => {
  if (ids.length) {
    await store.pool.query("UPDATE jobs SET available_at=now() + interval '1 hour' WHERE locked_until IS NULL OR locked_until<now()");
    await store.pool.query('UPDATE jobs SET available_at=now() WHERE work_id::text = ANY($1)', [ids]);
  } else {
    await store.pool.query('UPDATE jobs SET available_at=now() WHERE locked_until IS NULL OR locked_until<now()');
  }
};
const workOf = async (id: string) => (await store.workDocument(id))!;
const revisionOf = async (id: string) => (await workOf(id))!.revision;
const jobs = async () => (await store.pool.query('SELECT work_id::text, error, deferred_reason, available_at > now() AS later FROM jobs ORDER BY work_id')).rows as { work_id: string; error: string | null; deferred_reason: string | null; later: boolean }[];
const setMerger = (merger: 'github' | 'control-plane', reason: string) => new MergerSettings(store).change(operator, { merger, reason }, randomUUID());
/** One observation cycle: the worker claims due jobs until none is due, and no job is claimed twice. */
async function cycle(github: ReturnType<Api['client']>, bound = 12) {
  await due();
  let claims = 0;
  while (await processJob(engine, github)) { claims++; assert.ok(claims <= bound, 'a cycle claims each due job once, never spins'); }
  return claims;
}

before(async () => {
  fixtureRoot = await realpath(await temporaryDirectory('soak-control-plane-observation-job'));
  const origin = join(fixtureRoot, 'origin.git'); checkout = join(fixtureRoot, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  await commit(checkout, 'README.md', '# Fixture\n', 'base');
  git(checkout, 'push', '-q', 'origin', 'main');
  postgres = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('soak-control-plane-observation-job-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await postgres.initialise(); await postgres.start(); await postgres.createDatabase('soak_control_plane_observation_job');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/soak_control_plane_observation_job`); await store.init();
  engine = new Engine(store, [CI], 120, REPOSITORY);
  engine.submissionObserver = null; engine.directMergeEnvironment = null;
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  // The person-opened pull request merges straight to main: the window owns that merge.
  engine.directMergeEnvironment = { since: new Date(Date.now() - 86_400_000).toISOString(), until: null, reason: 'test repository merges straight into main', setBy: 'environment', enabledAt: new Date(Date.now() - 86_400_000).toISOString(), source: 'environment', event: null };
  await setMerger('control-plane', 'the soak runs the control plane as the merge writer');
  api = new Api();
});
after(async () => { if (store) await store.close(); if (postgres) await postgres.stop(); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

test('soak:control-plane-observation-job — processJob run across cycles over control-plane candidates, a person-opened pull request, a moving base tip and a lost base ref keeps one write per candidate per cycle, asks GitHub for nothing a control-plane candidate owes, delivers a merged person-opened pull request at once, and retries a local failure at its bounded cadence with no GitHub recovery', async () => {
  // Two candidates the control plane submitted and observed itself (change numbers, no pull request).
  const first = await claimed(1), second = await claimed(2);
  for (const { w, head } of [first, second]) await engine.execute(worker, 'submit', w.id, { epoch: 1, head }, randomUUID());
  const ids = [first.w.id, second.w.id], heads = [first.head, second.head];
  const tip = () => git(checkout, 'rev-parse', 'refs/remotes/origin/main');

  const github = api.client();
  // The main guard reads main's own CI once per engine and interval, before the first claim; that
  // read is one of the GitHub reads the merger keeps, and it runs here, ahead of every measured pass.
  await cycle(github);
  assert.deepEqual(await Promise.all(ids.map(async id => (await workOf(id)).observation?.source)), ['control-plane', 'control-plane'], 'both candidates observed from the checkout');

  // Steady state over six cycles: one claim and exactly one write per candidate per cycle, no
  // errors, and not one GitHub request across the whole phase.
  const beforeRequests = api.requests.length;
  for (let round = 0; round < 6; round++) {
    const revisionsBefore = await Promise.all(ids.map(revisionOf));
    assert.equal(await cycle(github), 2, `cycle ${round}: one claim per candidate`);
    const rows = await jobs();
    assert.equal(rows.length, 2, 'one job row per candidate, never a duplicate');
    for (const row of rows) { assert.equal(row.error, null, `no observation failed: ${row.error}`); assert.equal(row.deferred_reason, null); }
    for (const [index, id] of ids.entries()) {
      const item = await workOf(id);
      assert.equal(item.observation?.source, 'control-plane');
      assert.equal(item.observation?.candidate.sha, heads[index], 'observed at the head it submitted');
      assert.equal(item.observation?.baseTip, tip());
      assert.equal(await revisionOf(id), revisionsBefore[index] + 1, `candidate ${index + 1}: one save in cycle ${round}, no churn beyond the observation`);
    }
    assert.equal(api.requests.length, beforeRequests, `cycle ${round} polled GitHub for a control-plane candidate: ${JSON.stringify(api.requests.slice(beforeRequests))}`);
  }

  // The base tip moves and a person-opened pull request joins: the candidates re-observe once at
  // the new tip, and GitHub is asked for neither of them, while the person-opened pull request is
  // observed from GitHub as today.
  await commit(checkout, 'src/base.ts', 'export const base = 2;\n', 'base moves');
  git(checkout, 'push', '-q', 'origin', 'main');
  const tip1 = tip(); api.main = tip1;
  await setMerger('github', 'the person opens their pull request while GitHub merges');
  const person = await claimed(3);
  api.open(88, person.head, 'graphyard/gy-3-1');
  engine.submissionObserver = async () => ({
    source: undefined,
    candidate: { sha: person.head, baseSha: tip1, pr: 88, branch: 'graphyard/gy-3-1', author: 'implementer' },
    checks: [], reviews: [], prState: 'open', draft: false, merged: false, mergeSha: null, mergeable: true, conflicting: false,
    protected: false, requiredChecks: [], conversations: { required: false, unresolved: [] },
    files: ['src/person.ts'], scopeFiles: [], baseTip: tip1, baseTree: sha(`tree-${tip1}`), baseTipContained: false, baseTipAncestor: false,
    at: new Date().toISOString(),
  } as Observation);
  try { await engine.execute(worker, 'submit', person.w.id, { epoch: 1, pr: 88 }, randomUUID()); }
  finally { engine.submissionObserver = null; }
  await setMerger('control-plane', 'the control plane is the merge writer again');
  const number1 = (await workOf(first.w.id)).candidate!.pr, number2 = (await workOf(second.w.id)).candidate!.pr;
  const movedFrom = await Promise.all(ids.map(revisionOf));
  assert.equal(await cycle(github), 3, 'the moved tip observes both candidates and the person-opened pull request once');
  assert.deepEqual(await Promise.all(ids.map(revisionOf)), movedFrom.map(revision => revision + 1), 'the moved tip is one save per candidate');
  for (const id of ids) assert.equal((await workOf(id)).observation?.baseTip, tip1);
  assert.equal(api.count('pulls', number1), 0, 'GitHub was asked for no control-plane candidate\'s change number');
  assert.equal(api.count('pulls', number2), 0, 'GitHub was asked for no control-plane candidate\'s change number');
  assert.ok(api.count('pulls', 88) >= 1, 'the person-opened pull request is observed from GitHub');

  // GitHub merges the person-opened pull request: its own job observes the merge and delivers it
  // at once, with the merge commit, while the control-plane candidates keep their one write.
  const mergeCommit = sha('merge-88');
  api.open(88, person.head, 'graphyard/gy-3-1', mergeCommit);
  const deliveredFrom = await Promise.all(ids.map(revisionOf));
  assert.equal(await cycle(github), 3, 'both candidates and the merged pull request are claimed once');
  assert.deepEqual(await Promise.all(ids.map(revisionOf)), deliveredFrom.map(revision => revision + 1), 'one save per candidate in the delivery cycle');
  const delivered = await workOf(person.w.id);
  assert.equal(delivered.stage, 'done', `the person-opened pull request was delivered: ${JSON.stringify(delivered.gates)}`);
  assert.equal(delivered.observation?.merged, true);
  assert.equal(delivered.delivery?.mergeSha, mergeCommit);
  assert.equal((await jobs()).find(row => row.work_id === person.w.id) ?? null, null, 'the delivered item\'s job is retired');

  // The checkout loses both base refs while its HEAD still resolves: each failing observation is a
  // local failure — GitHub is asked for nothing, the recovery that publishes and dequeues never
  // runs, the failure stands on the job record, and the retry is bounded.
  git(checkout, 'checkout', '-q', '--detach');
  git(checkout, 'update-ref', '-d', 'refs/remotes/origin/main'); git(checkout, 'update-ref', '-d', 'refs/heads/main');
  const failedFrom = await Promise.all(ids.map(revisionOf));
  const failureRequests = api.requests.length;
  assert.equal(await cycle(github), 2, 'each failing job is claimed once');
  const failedRows = await jobs();
  assert.equal(failedRows.length, 2);
  for (const id of ids) {
    assert.match(failedRows.find(row => row.work_id === id)!.error ?? '', /holds no refs\/remotes\/origin\/main or refs\/heads\/main/, 'the local failure stands on the job record');
    assert.equal(await revisionOf(id), failedFrom[ids.indexOf(id)], 'a failing observation saves nothing');
  }
  assert.equal(api.requests.length, failureRequests, 'the failures asked GitHub for nothing: no publish, no dequeue, no read');
  assert.ok(failedRows.every(row => row.later), 'each failed job is retried at its bounded cadence, not at once');

  // The ref comes back: the next cycle observes again from the checkout and clears the errors.
  git(checkout, 'update-ref', 'refs/remotes/origin/main', tip1);
  await cycle(github);
  const restored = await jobs();
  for (const id of ids) {
    assert.equal(restored.find(row => row.work_id === id)!.error, null, 'the recovery cleared the error');
    assert.equal((await workOf(id)).observation?.source, 'control-plane', 'observed from the checkout again');
  }
  assert.equal(api.requests.length, failureRequests, 'the recovery asked GitHub for nothing either');
});
