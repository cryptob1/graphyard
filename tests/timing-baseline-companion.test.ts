import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { awaitScopeOutcome } from '../src/cli/session-commands.js';
import { applyScopeDecision } from '../src/engine.js';
import { GitHub, CHECK_NAME } from '../src/github.js';
import { evaluate, Refusal, type Work, type Observation } from '../src/model.js';
import { decideScopeRequest, redecidableScopeRefusal, scopeRequestOutcome } from '../src/model/scope.js';
import { timingBaselineCompanion, timingBaselinePath } from '../src/model/timing-companion.js';
import { regressionRefusals } from '../src/regression-guard.js';
import { localScopeFindings } from '../src/sync.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-1023: a change that adds a test file records that file's line in the timing baseline CI
// balances its shards by. The baseline is an implied scope companion of the test: sync, complete and
// the planned-files gate accept the lines of the change's own test files without a widening, and
// refuse, naming them, the lines of anyone else's. Each test is named for the proof it produces.

const baseline = (files: Record<string, number>) => `${JSON.stringify({ schema: 1, commit: 'a'.repeat(40), runs: [{ run: 1, durationMs: 100 }], files }, null, 2)}\n`;
const shipped = { 'tests/a.test.ts': 1200, 'tests/b.test.ts': 800 };

async function fixture(plannedFiles = ['src/thing.ts']) {
  const directory = await temporaryDirectory('timing-companion');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  const write = (path: string, text: string) => { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), text); git('add', path); };
  const commit = (files: Record<string, string>) => { for (const [path, text] of Object.entries(files)) write(path, text); git('commit', '-m', Object.keys(files).join(' ')); return git('rev-parse', 'HEAD'); };
  const root = commit({ 'src/thing.ts': 'export const thing = 1;\n', 'tests/a.test.ts': 'a\n', 'tests/b.test.ts': 'b\n', [timingBaselinePath]: baseline(shipped) });
  let base = root;
  git('checkout', '-b', 'candidate', root);
  let head = root;
  const blob = (ref: string, path: string) => { try { return git('rev-parse', '--verify', `${ref}:${path}`); } catch { return null; } };
  const diff = (from: string, to: string) => git('diff', '--name-only', from, to).split('\n').filter(Boolean).map(filename => ({ filename,
    status: !blob(to, filename) ? 'removed' : !blob(from, filename) ? 'added' : 'modified', sha: blob(to, filename), additions: 1, deletions: 1, patch: '@@' }));
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'unused' });
  github.controlPlaneLogin = async () => 'graphyard[bot]';
  github.request = async (path, method = 'GET') => {
    assert.equal(method, 'GET', 'observation never writes repository state');
    const [route, query] = path.split('?'); const params = new URLSearchParams(query);
    if (route === '/pulls/1') return { number: 1, head: { sha: head, ref: 'candidate', repo: { full_name: 'owner/repo' } }, base: { sha: base, ref: 'main', repo: { full_name: 'owner/repo' } }, user: { login: 'worker' }, merged: false, state: 'open', mergeable: true, draft: false };
    if (route === '/pulls/1/files') return params.get('page') === '2' ? [] : diff(git('merge-base', base, head), head);
    if (route === '/pulls/1/reviews') return [];
    if (route.endsWith('/check-runs')) return { check_runs: [] };
    if (route.endsWith('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    if (route === '/git/ref/heads/main') return { object: { type: 'commit', sha: base } };
    if (route.startsWith('/git/blobs/')) return { content: Buffer.from(execFileSync('git', ['cat-file', 'blob', route.slice(11)], { cwd: directory })).toString('base64'), encoding: 'base64' };
    if (route.startsWith('/commits/')) return { commit: { tree: { sha: git('rev-parse', `${route.slice(9)}^{tree}`) } } };
    if (route.startsWith('/compare/')) {
      const [from, to] = route.slice(9).split('...'); const ancestor = git('merge-base', from, to);
      return { status: from === to ? 'identical' : ancestor === from ? 'ahead' : 'diverged', merge_base_commit: { sha: ancestor }, files: diff(from, to), commits: [], total_commits: 0 };
    }
    if (route.startsWith('/contents/')) { const sha = blob(params.get('ref')!, decodeURIComponent(route.slice(10))); if (!sha) throw new Refusal(`GitHub GET ${path} failed (404)`, 502); return { type: 'file', sha }; }
    throw new Error(`Unexpected request ${path}`);
  };
  const work = () => ({ id: 'w', key: 'GY-1023', title: 'timing companion', type: 'bug', description: '', priority: 0, dependencies: [], criteria: [], policy: { checks: [], review: false }, plannedFiles: [...plannedFiles], stage: 'build', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'test', path: directory, branch: 'candidate', epoch: 1, owner: 'worker' }], submission: { pr: 1, epoch: 1 }, candidate: { pr: 1, sha: head, baseSha: root, branch: 'candidate', author: 'worker' }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString() }) as unknown as Work;
  // `graphyard sync`'s own judgement: the local diff against the base tip, blobs read through git.
  const sync = async (planned = plannedFiles) => localScopeFindings(planned, git('diff', '--raw', '-M', '-z', '--no-abbrev', base, 'HEAD'), git('diff', '--numstat', '-M', '-z', base, 'HEAD'), [],
    async sha => { try { return git('cat-file', 'blob', sha) + '\n'; } catch { return null; } });
  return {
    git, root,
    candidate: (files: Record<string, string>) => { head = commit(files); },
    advanceMain: (files: Record<string, string>) => { git('checkout', '-q', 'main'); base = commit(files); git('checkout', '-q', 'candidate'); },
    observe: async (edit: (item: Work) => void = () => {}) => { const item = work(); edit(item); const seen = await github.observe(item); return { item, seen }; },
    sync,
  };
}
const build = (work: Work, observation: Observation) => evaluate({ ...work, candidate: observation.candidate, observation }, [], new Date(), []).gates.find(gate => gate.name === 'build')!;

test('unit:timing-baseline-implied-companion — a change adding tests/new-thing.test.ts records only its own line without a widening', async () => {
  const f = await fixture();
  f.candidate({ 'src/thing.ts': 'export const thing = 2;\n', 'tests/new-thing.test.ts': 'new\n', [timingBaselinePath]: baseline({ ...shipped, 'tests/new-thing.test.ts': 450 }) });
  // sync: the baseline is the test's companion, not an out-of-scope rewrite.
  const local = await f.sync();
  const entry = local.find(finding => finding.path === timingBaselinePath)!;
  assert.equal(entry.kind, 'companion');
  assert.equal(entry.refused, false);
  assert.match(entry.detail, /"tests\/new-thing\.test\.ts" \(added\)/);
  assert.deepEqual(local.filter(finding => finding.refused), []);
  // complete and the planned-files gate: the control plane's observation reads the same lines.
  const { item, seen } = await f.observe();
  assert.equal(seen.scopeFiles!.find(file => file.path === timingBaselinePath)!.companion!.allowed, true);
  assert.deepEqual(regressionRefusals(item, seen, []), [], 'complete submits the head');
  assert.equal(build(item, seen).reasons.some(reason => reason.includes(timingBaselinePath)), false, build(item, seen).reasons.join('; '));
  assert.deepEqual(item.plannedFiles, ['src/thing.ts'], 'no planned-files widening');
  // Main records another file's line after the candidate bound its base: where it lands, the merge result still adds only this change's line.
  f.advanceMain({ 'tests/0.test.ts': '0\n', [timingBaselinePath]: baseline({ 'tests/0.test.ts': 300, ...shipped }) });
  const moved = await f.observe();
  assert.deepEqual(regressionRefusals(moved.item, moved.seen, []), [], regressionRefusals(moved.item, moved.seen, []).join('; '));
});

test('unit:timing-baseline-implied-companion — removing or altering lines of test files the change did not touch is refused, naming the lines', async () => {
  const f = await fixture();
  f.candidate({ 'tests/new-thing.test.ts': 'new\n', [timingBaselinePath]: baseline({ 'tests/b.test.ts': 9999, 'tests/new-thing.test.ts': 450 }) });
  const local = await f.sync();
  const entry = local.find(finding => finding.path === timingBaselinePath)!;
  assert.equal(entry.refused, true);
  assert.equal(entry.kind, 'rewritten');
  assert.match(entry.detail, /"tests\/a\.test\.ts" \(removed\)/);
  assert.match(entry.detail, /"tests\/b\.test\.ts" \(altered\)/);
  assert.doesNotMatch(entry.detail, /new-thing/);
  const { item, seen } = await f.observe();
  const refusals = regressionRefusals(item, seen, []).join('\n');
  assert.match(refusals, /tests\/helpers\/timing-baseline\.json: differs from the base branch tip.*"tests\/a\.test\.ts" \(removed\).*"tests\/b\.test\.ts" \(altered\)/);
  assert.equal(build(item, seen).passed, false);
  // The recorded runs are not a test file's line either.
  assert.match(timingBaselineCompanion(baseline(shipped), baseline(shipped).replace('"durationMs": 100', '"durationMs": 5'), ['tests/new-thing.test.ts']).detail, /recorded runs/);
  // A baseline with no test file of the change behind it implies nothing.
  assert.equal(timingBaselineCompanion(baseline(shipped), baseline({ ...shipped, 'tests/new-thing.test.ts': 450 }), []).allowed, false);
});

test('unit:timing-baseline-scope-request-granted — scope-request for the baseline is granted without an operator when the change adds a test file', async () => {
  const criteria = [{ id: 'AC-1', text: 'The thing works; a test covers it.' }];
  const request = { paths: [timingBaselinePath] };
  const planned = decideScopeRequest({ plannedFiles: ['src/thing.ts', 'tests/new-thing.test.ts'], criteria }, request);
  assert.equal(planned.state, 'approved', planned.reason);
  assert.match(planned.reason, /records the timing line of a test file this item adds or changes/);
  const observed = decideScopeRequest({ plannedFiles: ['src/thing.ts'], criteria, observation: { files: ['src/thing.ts', 'tests/new-thing.test.ts'] } }, request);
  assert.equal(observed.state, 'approved', observed.reason);
  const directory = decideScopeRequest({ plannedFiles: ['src/thing.ts', 'tests/thing/'], criteria }, request);
  assert.equal(directory.state, 'approved', directory.reason);
  // No test file behind it: still the operator's call.
  const untested = decideScopeRequest({ plannedFiles: ['src/thing.ts'], criteria }, request);
  assert.equal(untested.state, 'refused');
  // Only the baseline file is implied: neither its directory nor another helper rides along.
  assert.equal(decideScopeRequest({ plannedFiles: ['tests/new-thing.test.ts'], criteria }, { paths: ['tests/helpers/'] }).state, 'refused');
  assert.equal(decideScopeRequest({ plannedFiles: ['src/thing.ts', 'tests/new-thing.test.ts'], criteria }, { paths: [timingBaselinePath, 'tests/helpers/run-tests.ts'] }).state, 'refused');
  // A refusal recorded before the item planned its test is decided again once it does.
  const refusal = { epoch: 1, paths: [timingBaselinePath], reason: 'record the new test file timing line', requestedBy: 'worker', at: '2026-09-30T00:00:00Z',
    decision: { state: 'refused' as const, reason: untested.reason, at: '2026-09-30T00:00:01Z', decidedBy: 'graphyard', waitedMs: 1000, paths: [timingBaselinePath], requestedBy: 'worker', requestedAt: '2026-09-30T00:00:00Z' } };
  assert.equal(redecidableScopeRefusal({ plannedFiles: ['src/thing.ts', 'tests/new-thing.test.ts'], criteria, blocker: `Scope request refused: ${untested.reason}`, scopeRequest: refusal }), true);
  // The worker reads the grant from its own `scope-request --wait`: approved, though plannedFiles are unchanged.
  const ask = { epoch: 1, paths: [timingBaselinePath], reason: 'record the new test file timing line', requestedBy: 'worker', at: new Date().toISOString() };
  const work = { id: 'w', key: 'GY-1023', plannedFiles: ['src/thing.ts', 'tests/new-thing.test.ts'], criteria, blocker: null, lease: { epoch: 1, owner: 'worker', expiresAt: new Date(Date.now() + 600_000).toISOString() }, scopeRequest: ask } as unknown as Work;
  assert.equal(applyScopeDecision(work, ask, new Date()).state, 'approved');
  assert.deepEqual(work.plannedFiles, ['src/thing.ts', 'tests/new-thing.test.ts']);
  const outcome = scopeRequestOutcome(work, { epoch: 1, at: ask.at, paths: ask.paths }, Date.now());
  assert.equal(outcome.state, 'approved', outcome.text);
  assert.match(outcome.text, /tests\/helpers\/timing-baseline\.json is granted as an implied companion and stays outside plannedFiles/);
  const heard = await awaitScopeOutcome({ api: async () => ({ work: [work], now: new Date().toISOString() }) }, work, 1, { waitMs: 0 });
  assert.equal(heard.state, 'approved', heard.text);
  assert.match(heard.text, /you keep your lease: continue the work/);
  // A grant for another ask of the attempt is not this one's.
  assert.notEqual(scopeRequestOutcome(work, { epoch: 1, at: new Date(Date.parse(ask.at) - 1000).toISOString(), paths: ask.paths }, Date.now()).state, 'approved');
});

test('unit:timing-baseline-implied-companion — a scope request granted for the baseline keeps it outside plannedFiles, so foreign lines are still refused', async () => {
  const planned = ['src/thing.ts', 'tests/new-thing.test.ts'];
  const f = await fixture(planned);
  f.candidate({ 'tests/new-thing.test.ts': 'new\n', [timingBaselinePath]: baseline({ 'tests/b.test.ts': 9999, 'tests/new-thing.test.ts': 450 }) });
  let granted: Work | undefined;
  const { item, seen } = await f.observe(work => {
    work.scopeRequest = { epoch: 1, paths: [timingBaselinePath], reason: 'record the new test file timing line', requestedBy: 'worker', at: new Date().toISOString() };
    const decision = applyScopeDecision(work, work.scopeRequest, new Date());
    assert.equal(decision.state, 'approved', decision.reason);
    assert.match(decision.reason, /stays outside plannedFiles/);
    granted = work;
  });
  assert.deepEqual(granted!.plannedFiles, planned, 'the implied grant widens nothing');
  assert.equal(granted!.scopeRequest, null);
  assert.match(regressionRefusals(item, seen, []).join('\n'), /timing-baseline\.json: differs from the base branch tip.*"tests\/a\.test\.ts" \(removed\).*"tests\/b\.test\.ts" \(altered\)/);
  assert.equal(build(item, seen).passed, false);
  const local = (await f.sync(granted!.plannedFiles)).find(finding => finding.path === timingBaselinePath)!;
  assert.equal(local.refused, true, local.detail);
  // The same grant still lets the change write its own line.
  assert.deepEqual(decideScopeRequest({ plannedFiles: planned, criteria: [] }, { paths: [timingBaselinePath] }).companions, [timingBaselinePath]);
  // A baseline the criteria name is ordinary scope and is planned in full.
  assert.deepEqual(decideScopeRequest({ plannedFiles: planned, criteria: [{ id: 'AC-1', text: `Rebalance ${timingBaselinePath}` }] }, { paths: [timingBaselinePath] }).companions, []);
});
