import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { MergerSettings, recordedMergerMode } from '../src/merger-mode.js';
import { gitRunnerFor } from '../src/merge-writer/local-observation.js';
import { CHECK_NAME, GitHub, observationThroughputStatus, processJob } from '../src/github.js';
import { diagnosticianEffects, diagnosisPrompt } from '../src/daemon/diagnosis.js';
import { doctorEffects, doctorPrompt } from '../src/daemon/doctor.js';
import { doctorCommandVerdict } from '../integrations/pi/index.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import { workerHarnessPlan } from '../src/master/harness.js';
import { masterConfigSchema } from '../src/master/profiles.js';
import { ReconciliationRetry } from '../src/model.js';
import type { GitHubBudget } from '../src/github.js';
import type { DiagnosisInput, DiagnosisSubject } from '../src/daemon/diagnosis.js';
import type { Observation, Work } from '../src/model.js';
import type { Principal } from '../src/model.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

/**
 * GY-1835: under the control-plane merger nothing polls GitHub for an item's pull request or
 * checks, and the master doctor reads the control plane instead of `gh pr view`. An item's head,
 * merge and verdicts are then the control plane's own records (GY-1523), so the server's
 * observation pass observes such a candidate from the checkout and asks GitHub for no pull
 * request, review or check run, while a pull request a person opened is still observed and github
 * mode reads exactly as before; the diagnostician's reads and prompt, and a control-plane worker's
 * own harness, follow the recorded merger; and master status carries the hour's GitHub request
 * count, so the drop is measurable. Each test is named for the proof it produces.
 */

const APP = 1234, CI = 15368, REPOSITORY = 'owner/project';
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const operator: Principal = { id: 'human-operator', role: 'admin', sessionKind: 'human' };
const worker: Principal = { id: 'implementer', role: 'worker' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * GitHub's REST surface at the fetch level, as much of it as an observation reads, with every
 * request recorded by path: the polling the merger forbids is counted where it would happen, at
 * the pull-request, review and check-run endpoints themselves.
 */
class Api {
  main = sha('main-1');
  pulls = new Map<number, { head: string; branch: string; merged?: string | null }>();
  /** Ancestor shas the fixture answers `ahead` for, keyed by head: a base the head's history holds. */
  ancestryOf = new Map<string, Set<string>>();
  requests: { method: string; path: string }[] = [];
  open(pr: number, head: string, branch: string, merged?: string | null) { this.pulls.set(pr, { head, branch, merged }); }
  private body(method: string, path: string): unknown {
    if (method !== 'GET') return { id: 12 };
    const [route, query = ''] = path.replace(`/repos/${REPOSITORY}`, '').split('?'); const params = new URLSearchParams(query);
    if (route === '/git/ref/heads/main') return { ref: 'refs/heads/main', object: { type: 'commit', sha: this.main } };
    if (route === '/commits' && params.get('path')) return [];
    if (route === '/commits' && params.get('sha') === 'main') return [{ sha: this.main, parents: [{ sha: sha('root') }], commit: { message: 'base', tree: { sha: sha(`tree-${this.main}`) } } }];
    let match = /^\/pulls\/(\d+)$/.exec(route);
    if (match) {
      const pr = this.pulls.get(Number(match[1])) ?? { head: sha(`unknown-${match[1]}`), branch: 'graphyard/unknown' };
      return { number: Number(match[1]), state: pr.merged ? 'closed' : 'open', draft: false, merged: !!pr.merged, mergeable: !pr.merged, merge_commit_sha: pr.merged ?? null, merged_at: pr.merged ? new Date(Date.now() - 3_600_000).toISOString() : null, user: { login: 'implementer', id: 7 },
        head: { sha: pr.head, ref: pr.branch, repo: { full_name: REPOSITORY } }, base: { sha: this.main, ref: 'main', repo: { full_name: REPOSITORY } } };
    }
    if (/^\/pulls\/(\d+)\/reviews$/.test(route)) return [];
    const files = /^\/pulls\/(\d+)\/files$/.exec(route);
    if (files) {
      // The file's blob is the one the head holds, so the reverted-delivery check (GY-93) finds the
      // merge's content on the base and asks for no history.
      const head = this.pulls.get(Number(files[1]))?.head ?? sha(`unknown-${files[1]}`);
      return params.get('page') !== '1' ? [] : [{ filename: 'src/person.ts', status: 'modified', sha: sha(`blob-src/person.ts-${head}`), additions: 3, deletions: 1, patch: '@@' }];
    }
    if (/^\/commits\/[a-f0-9]{40}\/check-runs$/.test(route)) return { check_runs: params.get('check_name') ? [] : [{ id: 1, name: 'test', status: 'completed', conclusion: 'success', app: { id: CI } }] };
    if (/^\/commits\/[a-f0-9]{40}\/status$/.test(route)) return { statuses: [], total_count: 0 };
    if (/^\/contents\/.+/.test(route)) {
      // A blob read (GY-863's ancestry questions, the reverted-delivery check): the file exists at
      // every ref this fixture serves, at a stable sha per (path, ref).
      const ref = new URLSearchParams(query).get('ref') ?? '';
      return { type: 'file', sha: sha(`blob-${decodeURIComponent(route.slice(10))}-${ref}`), path: decodeURIComponent(route.slice(10)) };
    }
    match = /^\/commits\/([a-f0-9]{40})$/.exec(route);
    if (match) return { sha: match[1], parents: [], commit: { tree: { sha: sha(`tree-${match[1]}`) }, message: 'change' }, author: { login: 'implementer' } };
    match = /^\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/.exec(route);
    if (match) return { status: match[1] === match[2] ? 'identical' : this.ancestryOf.get(match[2])?.has(match[1]) ? 'ahead' : 'diverged', ahead_by: 1, total_commits: 1, commits: [{ sha: match[2] }], files: [{ filename: 'src/person.ts', status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }] };
    if (route.endsWith('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: APP }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    if (route === '/rules/branches/main') return [];
    if (route === '/check-runs' || /^\/check-runs\/\d+$/.test(route)) return { id: 12 };
    throw new Error(`Unexpected request ${method} ${path}`);
  }
  fetch = async (url: unknown, options: any = {}): Promise<Response> => {
    const method = options.method ?? 'GET'; const path = String(url).replace('https://api.github.com', '');
    // The one GraphQL read an observation makes (the review threads protection requires resolved):
    // none stand in this fixture.
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
  /** How many requests a kind has taken: pull requests, their reviews, and check runs. */
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
/** The first test's two candidates, by id: the control-plane one and the person-opened one. */
let controlPlaneItem = '', personItem = '';
const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 1835;

/** One commit in a worktree, as a worker makes it. */
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
/** Every claimable job due now, and only the named items' jobs when any are given. */
const due = async (...ids: string[]) => {
  await store.pool.query("UPDATE jobs SET available_at=now() + interval '1 hour' WHERE locked_until IS NULL OR locked_until<now()");
  if (ids.length) await store.pool.query('UPDATE jobs SET available_at=now() WHERE work_id::text = ANY($1)', [ids]);
};
const workOf = async (id: string) => (await store.workDocument(id))!;
const setMerger = (merger: 'github' | 'control-plane', reason: string) => new MergerSettings(store).change(operator, { merger, reason }, randomUUID());
/** Control-plane is the shipped default (GY-1833): a set to the recorded mode is refused, so set it only when it differs. */
const setMergerUnlessRecorded = async (merger: 'github' | 'control-plane', reason: string) => {
  if ((await recordedMergerMode(store.pool)).merger !== merger) await setMerger(merger, reason);
};

before(async () => {
  fixtureRoot = await realpath(await temporaryDirectory('github-polling-control-plane'));
  const origin = join(fixtureRoot, 'origin.git'); checkout = join(fixtureRoot, 'checkout');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['clone', '-q', origin, checkout], { stdio: 'ignore' });
  git(checkout, 'config', 'user.email', 't@example.com'); git(checkout, 'config', 'user.name', 'T');
  await commit(checkout, 'README.md', '# Fixture\n', 'base');
  git(checkout, 'push', '-q', 'origin', 'main');
  postgres = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('github-polling-control-plane-db'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await postgres.initialise(); await postgres.start(); await postgres.createDatabase('github_polling_control_plane');
  store = new Store(`postgres://graphyard:testing-only@127.0.0.1:${port}/github_polling_control_plane`); await store.init();
  engine = new Engine(store, [CI], 120, REPOSITORY);
  engine.submissionObserver = null; engine.directMergeEnvironment = null;
  engine.gitRunner = gitRunnerFor(checkout); engine.baseBranch = 'main';
  await setMergerUnlessRecorded('control-plane', 'the control plane is the merge writer');
  api = new Api();
});
after(async () => { if (store) await store.close(); if (postgres) await postgres.stop(); if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true }); });

test('unit:no-github-polling-control-plane — with the merger set to control-plane, a reconcile and an observation pass over items whose observation source is control-plane issue no GitHub pull-request, review or check-run request, while a pull request opened by a person is still observed; in github mode the requests are as today', async () => {
  // One candidate the control plane submitted and observed itself (a change number, no pull
  // request), and one whose pull request a person opened and GitHub observed.
  const local = await claimed(1);
  await engine.execute(worker, 'submit', local.w.id, { epoch: 1, head: local.head }, randomUUID());
  await setMerger('github', 'the person opens their pull request while GitHub merges');
  const person = await claimed(2);
  const tip = git(checkout, 'rev-parse', 'refs/remotes/origin/main');
  const observation = (head: string): Observation => ({
    source: undefined,
    candidate: { sha: head, baseSha: tip, pr: 77, branch: 'graphyard/gy-2-1', author: 'implementer' },
    checks: [], reviews: [], prState: 'open', draft: false, merged: false, mergeSha: null, mergeable: false, conflicting: false,
    protected: false, requiredChecks: [], conversations: { required: false, unresolved: [] },
    files: ['src/person.ts'], scopeFiles: [], baseTip: tip, baseTree: sha(`tree-${tip}`), baseTipContained: false, baseTipAncestor: false,
    at: new Date().toISOString(),
  });
  engine.submissionObserver = async () => observation(person.head);
  try { await engine.execute(worker, 'submit', person.w.id, { epoch: 1, pr: 77 }, randomUUID()); }
  finally { engine.submissionObserver = null; }
  api.open(77, person.head, 'graphyard/gy-2-1');
  await setMerger('control-plane', 'the control plane is the merge writer again');
  const localId = local.w.id, personId = person.w.id;
  controlPlaneItem = localId; personItem = personId;
  assert.equal((await workOf(localId)).observation?.source, 'control-plane');
  assert.equal((await workOf(personId)).observation?.source ?? null, null, 'the person-opened pull request is GitHub\'s reading');

  const github = api.client();
  // The main guard reads main's own CI once per engine and interval, before the first claim; that
  // read is one of the GitHub reads the merger keeps, and it runs here, ahead of every measured pass.
  await due();
  while (await processJob(engine, github)) { /* claim nothing: the guard warms alone */ }
  const flat = () => ({ pulls: api.count('pulls'), reviews: api.count('reviews'), checks: api.count('check-runs') });

  // The reconcile pass reads the record alone: however many items it evaluates, GitHub is not asked.
  await due();
  const before = flat();
  await engine.reconcile();
  assert.deepEqual(flat(), before, 'the reconcile pass asked GitHub for nothing');

  // The observation pass over the control-plane candidate observes it from the checkout and asks
  // GitHub for no pull request, review or check run — and it is observed again all the same.
  await due(localId);
  const localAt = (await workOf(localId)).observation!.at;
  await processJob(engine, github);
  const afterLocal = flat();
  assert.deepEqual(afterLocal, before, `the control-plane candidate polled GitHub: ${JSON.stringify(api.requests.slice(before.pulls && 0).slice(-8))}`);
  const observedLocally = await workOf(localId);
  assert.ok(Date.parse(observedLocally.observation!.at) > Date.parse(localAt), 'the candidate was observed again from the checkout');
  assert.equal(observedLocally.observation!.source, 'control-plane', 'the observation is still the control plane\'s own');
  assert.equal(observedLocally.observation!.candidate.sha, local.head, 'at the head it submitted');
  assert.equal(observedLocally.observation!.baseTip, tip, 'against the base tip of the moment');

  // A pull request a person opened is still observed under the same merger: its job reads the
  // pull request, its reviews and its checks, and saves what GitHub answered.
  await due(personId);
  await processJob(engine, github);
  assert.ok(api.count('pulls', 77) >= 1, 'the person-opened pull request was read');
  const observedPerson = await workOf(personId);
  assert.ok(observedPerson.observation, `the person-opened pull request was observed: ${JSON.stringify((await store.pool.query('SELECT error, deferred_reason FROM jobs')).rows)}`);
  assert.equal(observedPerson.observation!.source ?? null, null, 'its observation is still GitHub\'s, never the checkout\'s');

  // With GitHub the recorded merger again, the same pass reads both candidates as it always did:
  // the control-plane candidate is read from GitHub too, whatever becomes of the reading.
  await setMerger('github', 'GitHub merges again');
  await due(localId);
  const githubBefore = flat();
  await processJob(engine, github);
  assert.ok(api.count('pulls') > githubBefore.pulls || api.count('reviews') > githubBefore.reviews || api.count('check-runs') > githubBefore.checks,
    'in github mode the observation pass reads GitHub as today, control-plane candidate included');
});

test('unit:doctor-reads-control-plane — under the control-plane merger the doctor reads the control plane: its allowlist excludes `gh pr view` and its request names `graphyard status`, and master status reports the hour\'s GitHub request count', async () => {
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard',
    repository: REPOSITORY, baseBranch: 'main', githubAppId: APP, hostId: 'machine-a', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers: [] });
  const settings = diagnosticianSettings(config.run);
  const input: DiagnosisInput = {
    subject: 'GY-7', kind: 'recurring', faultClass: 'stalled-gate', meaning: 'a gate waits on a reading nobody refreshes',
    item: { key: 'GY-7', title: 'Recurring stalled-gate faults', description: '' },
    instances: [], journal: [], serverLog: [], pullRequests: [{ number: 77, state: JSON.stringify({ state: 'open' }) }], openItems: [],
  } as unknown as DiagnosisInput;
  const subject: DiagnosisSubject = { id: 'GY-7', kind: 'recurring', faultClass: 'stalled-gate', work: null, instances: [] };

  // The diagnostician's context follows the recorded merger: under control-plane it runs no
  // `gh pr view` for the pull requests the instances name; with GitHub the merger it reads each.
  for (const merger of ['control-plane', 'github'] as const) {
    const ran: string[][] = [];
    const effects = diagnosticianEffects(config, '/fixture', async (method, path) => {
      assert.equal(method, 'GET'); assert.equal(path, 'merger');
      return { merger };
    }, async (command, args) => { ran.push([command, ...args]); return '[]'; });
    const context = await effects.context(subject, [77, 78]);
    if (merger === 'control-plane') {
      assert.deepEqual(ran.filter(args => args[0] === 'gh'), [], `the diagnostician polled GitHub under the control-plane merger: ${JSON.stringify(ran)}`);
      assert.deepEqual(context.pullRequests, [], 'no pull-request state is read');
      const prompt = diagnosisPrompt({ ...config, merger }, input);
      assert.doesNotMatch(prompt, /gh pr view/, 'the doctor\'s request names no `gh pr view`');
      assert.match(prompt, /graphyard status|\/bin\/graphyard" status GY-N|node \/bin\/graphyard status GY-N/);
      assert.match(prompt, /master status/, 'the doctor\'s request names `master status`');
      assert.match(prompt, /and the control plane \(node \/bin\/graphyard status GY-N, node \/bin\/graphyard master status\)\./, 'the read list is exactly the control-plane reads');
    } else {
      assert.deepEqual(ran.filter(args => args[0] === 'gh').map(args => args.slice(0, 3)), [['gh', 'pr', 'view'], ['gh', 'pr', 'view']], 'with GitHub the merger, each named pull request is read as before');
      assert.equal(context.pullRequests.length, 2, 'both readings are given to the session');
      assert.match(diagnosisPrompt({ ...config, merger }, input), /gh pr view N/, 'the github-mode read list keeps the pull-request read');
    }
  }

  // The loop doctor follows the merger the same way (B4, review of 3b7408170110): its effects read
  // the recorded merger as the operator agent, its request names no `gh pr view` under the
  // control-plane merger, and the session environment narrows its guard's gh reads with it.
  const doctorConfig = { ...config, operatorAgent: { id: 'operator-agent', credentialFile: '/outside/operator.token' } };
  for (const merger of ['control-plane', 'github'] as const) {
    const doctor = doctorEffects(doctorConfig, '/fixture', async (method, path) => {
      assert.equal(method, 'GET'); assert.equal(path, 'merger');
      return { merger };
    });
    assert.equal(await doctor.merger!(), merger, 'the doctor reads the recorded merger the way the diagnostician does');
    assert.equal(await doctorEffects(doctorConfig, '/fixture', async () => { throw new Error('refused'); }).merger!(), 'github', 'an unreadable merger keeps the github reads');
    const prompt = doctorPrompt({ repository: REPOSITORY, cliPath: '/bin/graphyard', merger }, { items: [], faults: [] });
    const guard = (line: string, env?: Record<string, string>): string => {
      const verdict = doctorCommandVerdict(line, { cwd: '/fixture', cli: '/bin/graphyard', env: env ?? {} });
      return verdict.allow ? '' : verdict.reason;
    };
    if (merger === 'control-plane') {
      assert.doesNotMatch(prompt, /gh pr view/, 'the doctor\'s request names no `gh pr view` under the control-plane merger');
      assert.match(prompt, /the control plane \(node \/bin\/graphyard status GY-N, node \/bin\/graphyard master status, node \/bin\/graphyard master decisions GY-N\)\./, 'the read list is exactly the control-plane reads');
      for (const line of ['gh pr view 12', 'gh pr list', 'gh pr checks 12', 'gh pr diff 12']) {
        assert.notEqual(guard(line, { GRAPHYARD_MERGER: 'control-plane' }), '', `\`${line}\` is outside the doctor's allowlist under the control-plane merger`);
      }
      assert.equal(guard('gh run view 3', { GRAPHYARD_MERGER: 'control-plane' }), '', 'workflow-run reads stand under the control-plane merger');
      assert.equal(guard('gh issue view 3', { GRAPHYARD_MERGER: 'control-plane' }), '', 'issue reads stand under the control-plane merger');
      assert.equal(guard('node /bin/graphyard status GY-7', { GRAPHYARD_MERGER: 'control-plane' }), '', 'the control-plane reads are sanctioned');
      assert.equal(guard('git log -1', { GRAPHYARD_MERGER: 'control-plane' }), '', 'git reads stand');
    } else {
      assert.match(prompt, /master decisions GY-N, gh pr view\)\./, 'the github-mode request keeps the pull-request read');
      assert.equal(guard('gh pr view 12'), '', 'with GitHub the merger, the pull-request read stands');
    }
  }

  // master status reports the hour's GitHub request count, so the drop is measurable.
  const status = observationThroughputStatus({ githubBudget: {
    remaining: 4100, limit: 5000, resetAt: new Date(Date.now() + 1_800_000).toISOString(), reserve: 500, belowReserve: false, exhaustsBeforeReset: false,
    lastHour: { requests: 12, byKind: [{ kind: 'pull', requests: 7 }, { kind: 'check-runs', requests: 5 }] },
  } as Partial<GitHubBudget> & Record<string, unknown> } as never, { work: [], now: new Date().toISOString() });
  assert.deepEqual(status.budget?.lastHour, { requests: 12, byKind: [{ kind: 'pull', requests: 7 }, { kind: 'check-runs', requests: 5 }] },
    'master status carries the hour\'s GitHub request count and what it was spent on');

  // A control-plane worker's own harness allows no `gh pr` command: the session opens no pull
  // request, it submits its head; with GitHub the merge writer the rules stand as before.
  const base = { cliPath: '/bin/graphyard', branch: 'graphyard/gy-9-1', baseBranch: 'main', credentialHome: '/creds', key: 'GY-9', epoch: 1 };
  const control = workerHarnessPlan({ ...base, mergeWriter: 'control-plane' });
  assert.deepEqual(control.allow.filter(rule => rule.rule.startsWith('Bash(gh pr')), [], 'the control-plane worker harness allows no pull-request command');
  const githubWorker = workerHarnessPlan({ ...base, mergeWriter: 'github' });
  for (const command of ['gh pr create', 'gh pr view', 'gh pr checks']) {
    assert.ok(githubWorker.allow.some(rule => rule.rule === `Bash(${command}:*)`), `${command} is allowed in github mode`);
    assert.ok(!control.allow.some(rule => rule.rule === `Bash(${command}:*)`), `${command} is not allowed under the control-plane merger`);
  }
});

test('unit:control-plane-observation-unheld — with a GitHub permission shortfall standing, a control-plane candidate is still observed from the checkout while a person-opened pull request waits on the hold; with GitHub the merger the hold stops the control-plane candidate too (review of 3b7408170110, B1)', async () => {
  const github = api.client();
  github.permissionShortfall = () => 'App 1234 installation is suspended; restore it at https://github.com/apps/graphyard';
  await setMerger('control-plane', 'the control plane is the merge writer');
  const heldRow = async (id: string) => (await store.pool.query('SELECT held_reason FROM jobs WHERE work_id=$1', [id])).rows[0];

  // The control-plane branch is decided before the GitHub permission hold: the checkout answers
  // what the suspended App cannot, and the job is not held for a permission it does not need.
  const before = (await workOf(controlPlaneItem)).observation!.at;
  await due(controlPlaneItem);
  await processJob(engine, github);
  assert.equal((await heldRow(controlPlaneItem)).held_reason, null, 'the control-plane candidate is not held for a permission it does not need');
  assert.ok(Date.parse((await workOf(controlPlaneItem)).observation!.at) > Date.parse(before), 'it was observed from the checkout despite the shortfall');

  // A pull request GitHub observes is stopped by the same shortfall, as today.
  await due(personItem);
  await processJob(engine, github);
  assert.match((await heldRow(personItem)).held_reason ?? '', /suspended/, 'the person-opened pull request waits on the GitHub permission hold');

  // With GitHub the merger, the hold stops the control-plane candidate as any other read would be.
  await setMerger('github', 'GitHub merges again');
  await due(controlPlaneItem);
  await processJob(engine, github);
  assert.match((await heldRow(controlPlaneItem)).held_reason ?? '', /suspended/, 'with GitHub the merger the hold stands');
});

test('unit:control-plane-observation-local-failure — a control-plane observation that fails locally is retried and finished with no GitHub request: the recovery that publishes and dequeues never names the locally allocated number (review of 3b7408170110, B2)', async () => {
  await setMerger('control-plane', 'the control plane is the merge writer');
  // The B1 test held this job in github mode; release it, as a released hold would be.
  await store.pool.query('UPDATE jobs SET held_until=NULL, unobserved=0 WHERE work_id=$1', [controlPlaneItem]);
  const github = api.client();
  try {
    // A concurrent save, the common failure: the bounded no-save retry stands, and GitHub is asked for nothing.
    const failing = engine as unknown as Record<string, unknown>;
    failing.observeControlPlaneCandidate = async () => { throw new ReconciliationRetry('Work or job ownership changed before publication; retry', 409); };
    const requestsBefore = api.requests.length;
    await due(controlPlaneItem);
    await processJob(engine, github);
    assert.equal(api.requests.length, requestsBefore, 'the failed local observation asked GitHub for nothing');
    const retried = (await store.pool.query('SELECT error, deferred_reason FROM jobs WHERE work_id=$1', [controlPlaneItem])).rows[0];
    assert.equal(retried.error, null, 'a retry is not an error');
    assert.match(retried.deferred_reason ?? '', /no observation saved 1 of 3 times/, 'the bounded no-save retry stands');

    // Any other local failure ends on the job record — still without the recovery's publish and dequeue.
    failing.observeControlPlaneCandidate = async () => { throw new Error('the checkout holds no refs/remotes/origin/main or refs/heads/main'); };
    await due(controlPlaneItem);
    await processJob(engine, github);
    assert.equal(api.requests.length, requestsBefore, 'neither failure asked GitHub for anything');
    assert.match((await store.pool.query('SELECT error FROM jobs WHERE work_id=$1', [controlPlaneItem])).rows[0].error ?? '', /holds no refs/, 'the failure stands on the job record');
  } finally { delete (engine as unknown as Record<string, unknown>).observeControlPlaneCandidate; }
});

test('unit:control-plane-observation-landed-peers — a landed person-opened peer is reconciled from GitHub and delivered, a landed control-plane peer is read from the checkout, and the reconcile asks GitHub for neither (review of 3b7408170110, B3)', async () => {
  const tip0 = git(checkout, 'rev-parse', 'refs/remotes/origin/main');
  // A control-plane candidate whose branch a person merges to main themselves: its head is an
  // ancestor of the tip the next candidates land on, and its item still records it open.
  const landedLocal = await claimed(3);
  await engine.execute(worker, 'submit', landedLocal.w.id, { epoch: 1, head: landedLocal.head }, randomUUID());
  git(checkout, 'merge', '--no-ff', 'graphyard/gy-3-1', '-m', 'land 3');
  git(checkout, 'push', '-q', 'origin', 'main');
  const tip1 = git(checkout, 'rev-parse', 'refs/remotes/origin/main');
  api.main = tip1;
  api.ancestryOf.set(tip1, new Set([tip0, landedLocal.head]));

  // A person-opened pull request GitHub has merged while its item still records it unlanded —
  // GY-744's peer, which the reconcile owes a delivery at once. The person merges straight to
  // main, so the direct-merge window owns that merge.
  engine.directMergeEnvironment = { since: new Date(Date.now() - 86_400_000).toISOString(), until: null, reason: 'test repository merges straight into main', setBy: 'environment', enabledAt: new Date(Date.now() - 86_400_000).toISOString(), source: 'environment', event: null };
  await setMerger('github', 'the person merges their pull request while GitHub is the writer');
  const mergedPerson = await claimed(4);
  api.open(88, mergedPerson.head, 'graphyard/gy-4-1', tip1);
  api.ancestryOf.set(mergedPerson.head, new Set([tip0, tip1, landedLocal.head]));
  // GitHub's merge of pull request 88 puts its head in main's history: the fixture answers the
  // ancestry questions the merge makes true.
  api.ancestryOf.set(tip1, new Set([tip0, landedLocal.head, mergedPerson.head]));
  const openObservation = (head: string, pr: number, branch: string, baseTip: string): Observation => ({
    source: undefined,
    candidate: { sha: head, baseSha: tip0, pr, branch, author: 'implementer' },
    checks: [], reviews: [], prState: 'open', draft: false, merged: false, mergeSha: null, mergeable: true, conflicting: false,
    protected: false, requiredChecks: [], conversations: { required: false, unresolved: [] },
    files: ['src/person.ts'], scopeFiles: [], baseTip, baseTree: sha(`tree-${baseTip}`), baseTipContained: false, baseTipAncestor: false,
    at: new Date().toISOString(),
  });
  engine.submissionObserver = async () => openObservation(mergedPerson.head, 88, 'graphyard/gy-4-1', tip0);
  try { await engine.execute(worker, 'submit', mergedPerson.w.id, { epoch: 1, pr: 88 }, randomUUID()); }
  finally { engine.submissionObserver = null; }
  // A pull-request submission binds no observation (the integration pass reads it first): the item's
  // standing reading is saved the way the loop's first poll would, at the stale tip, so the item
  // still records it unlanded.
  const submitted4 = await workOf(mergedPerson.w.id);
  await engine.observe(mergedPerson.w.id, submitted4.revision, openObservation(mergedPerson.head, 88, 'graphyard/gy-4-1', tip0));
  assert.equal((await workOf(mergedPerson.w.id)).observation?.merged ?? false, false, 'the merged person-opened pull request is still recorded unlanded');

  // The observing item: a person-opened pull request whose branch carries both heads, so its own
  // observation's landing names both peers landed.
  const observing = await (async () => {
    let w = await engine.execute(operator, 'create', null, { title: 'Observed 5', plannedFiles: ['src/'], criteria: [{ id: 'AC-1', text: 'Behaves', proofs: ['integration:claim-safety'] }] }, randomUUID());
    w = await engine.execute(operator, 'ready', w.id, {}, randomUUID());
    const pulled = await engine.pullAssignment(worker, { work: w.id }, randomUUID());
    assert.equal(pulled.assigned?.id, w.id, JSON.stringify(pulled.refused));
    const branch = 'graphyard/gy-5-1', worktree = join(checkout, '.graphyard', 'worktrees', 'GY-5-1');
    git(checkout, 'worktree', 'add', '-q', '-b', branch, worktree, mergedPerson.head);
    git(worktree, 'config', 'user.email', 't@example.com'); git(worktree, 'config', 'user.name', 'T');
    const head = await commit(worktree, 'src/item-5.ts', 'export const item = 5;\n', 'item 5');
    w = await engine.execute(worker, 'workspace', w.id, { epoch: 1, host: 'test', path: worktree, branch }, randomUUID());
    return { w, head };
  })();
  api.open(89, observing.head, 'graphyard/gy-5-1');
  api.ancestryOf.set(observing.head, new Set([tip0, tip1, landedLocal.head, mergedPerson.head]));
  engine.submissionObserver = async () => openObservation(observing.head, 89, 'graphyard/gy-5-1', tip1);
  try { await engine.execute(worker, 'submit', observing.w.id, { epoch: 1, pr: 89 }, randomUUID()); }
  finally { engine.submissionObserver = null; }
  await setMerger('control-plane', 'the control plane is the merge writer again');

  // The observing item's job: its landing names both peers landed; the reconcile reads the
  // control-plane peer from the checkout and the person-opened peer from GitHub.
  const github = api.client();
  const number3 = (await workOf(landedLocal.w.id)).candidate!.pr;
  const revision3 = (await workOf(landedLocal.w.id)).revision;
  await due(observing.w.id);
  await processJob(engine, github);

  // The landed person-opened peer: read from GitHub by the reconcile and delivered at once (GY-744).
  assert.ok(api.count('pulls', 88) >= 2, `the reconcile read the landed person-opened pull request from GitHub: ${JSON.stringify(api.requests.slice(-6))}`);
  const delivered = await workOf(mergedPerson.w.id);
  assert.equal(delivered.stage, 'done', `the person-opened peer was delivered by the reconcile: ${JSON.stringify(delivered.gates)}`);
  assert.equal(delivered.observation?.merged, true);
  assert.equal(delivered.delivery?.mergeSha, tip1);

  // The landed control-plane peer: read from the checkout. GitHub was asked for its change number
  // exactly once — the landing check's own landedOn question — and the reconcile added no read.
  assert.equal(api.count('pulls', number3), 1, 'the reconcile asked GitHub for the control-plane peer no pull request: the one read is the landing check\'s own');
  const local = await workOf(landedLocal.w.id);
  assert.equal(local.observation?.source, 'control-plane', 'its observation is still the checkout\'s');
  assert.equal(local.observation?.baseTip, tip1, 'it advanced to the tip the merge made');
  assert.equal(local.revision, revision3 + 1, 'one save: the reconcile\'s local reading');
});
