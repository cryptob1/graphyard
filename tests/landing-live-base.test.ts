import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitHub, CHECK_NAME } from '../src/github.js';
import { evaluate, Refusal, type Work, type Observation } from '../src/model.js';
import { regressionRefusals } from '../src/regression-guard.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

async function fixture() {
  const directory = await temporaryDirectory('landing-live-base');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  const commit = (path: string, text: string) => { writeFileSync(join(directory, path), text); git('add', path); git('commit', '-m', path); return git('rev-parse', 'HEAD'); };
  const blob = (ref: string, path: string) => { try { return git('rev-parse', '--verify', `${ref}:${path}`); } catch { return null; } };
  const diff = (from: string, to: string) => git('diff', '--name-only', from, to).split('\n').filter(Boolean).map(filename => ({ filename,
    status: !blob(to, filename) ? 'removed' : !blob(from, filename) ? 'added' : 'modified', sha: blob(to, filename), additions: 1, deletions: 1, patch: '@@' }));
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'unused' });
  github.controlPlaneLogin = async () => 'graphyard[bot]';
  const calls: string[] = [];
  github.request = async (path, method = 'GET') => {
    assert.equal(method, 'GET', 'observation never writes repository state'); calls.push(path);
    const [route, query] = path.split('?'); const params = new URLSearchParams(query);
    if (route === '/pulls/1') return { number: 1, head: { sha: head, ref: 'candidate', repo: { full_name: 'owner/repo' } }, base: { sha: base, ref: 'main', repo: { full_name: 'owner/repo' } }, user: { login: 'worker' }, merged: false, state: 'open', mergeable: true, draft: false };
    if (route === '/pulls/1/files') return params.get('page') === '2' ? [] : diff(base, head);
    if (route === '/pulls/1/reviews') return [];
    if (route.endsWith('/check-runs')) return { check_runs: [] };
    if (route.endsWith('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    if (route === '/git/ref/heads/main') return { object: { type: 'commit', sha: base } };
    if (route.startsWith('/commits/')) return { commit: { tree: { sha: git('rev-parse', `${route.slice(9)}^{tree}`) } } };
    if (route.startsWith('/compare/')) {
      const [from, to] = route.slice(9).split('...'); const ancestor = git('merge-base', from, to);
      // Deliberately expose endpoint differences: callers must use the supplied merge base.
      return { status: from === to ? 'identical' : ancestor === from ? 'ahead' : 'diverged', merge_base_commit: { sha: ancestor }, files: diff(from, to), commits: [], total_commits: 0 };
    }
    if (route.startsWith('/contents/')) { const sha = blob(params.get('ref')!, decodeURIComponent(route.slice(10))); if (!sha) throw new Refusal(`GitHub GET ${path} failed (404)`, 502); return { type: 'file', sha }; }
    throw new Error(`Unexpected request ${path}`);
  };
  const root = commit('A', 'old\n');
  const base = commit('A', 'shipped\n');
  git('checkout', '-b', 'candidate', root);
  let head = commit('B', 'candidate\n');
  const work = { id: 'w', key: 'GY-855', title: 'landing-live-base', type: 'bug', description: '', priority: 0, dependencies: [], criteria: [], policy: { checks: [], review: false }, plannedFiles: ['B'], stage: 'build', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'test', path: directory, branch: 'candidate', epoch: 1, owner: 'worker' }], submission: { pr: 1, epoch: 1 }, candidate: { pr: 1, sha: head, baseSha: root, branch: 'candidate', author: 'worker' }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString() } as unknown as Work;
  return { github, work, calls, root, base, git, diff, blob, head: () => head,
    revert: () => { git('merge', '--no-edit', base); head = commit('A', 'old\n'); },
    clean: async () => {} };
}
const build = (work: Work, observation: Observation) => evaluate({ ...work, candidate: observation.candidate, observation }, [], new Date(), []).gates.find(gate => gate.name === 'build')!;

test('unit:landing-check-three-way-live-base — main changes unrelated file, candidate built on old base, no regression', async () => {
  const f = await fixture();
  try {
    // GY-472's shape: the candidate was built on root, where A read 'old', and main has since
    // changed A to 'shipped'. A three-way merge of the head onto the live base inherits main's
    // A, so the candidate is not refused for reverting a file it never touched, and its landing
    // record lists only its own change.
    const seen = await f.github.observe(f.work);
    assert.deepEqual(regressionRefusals(f.work, seen, []), [], 'should have no regression refusal when main changed an unrelated file');
    assert.deepEqual(seen.landing!.files!.map(file => file.path), ['B']);
    // The same shape where the head really restores old A is a revert: it is still refused,
    // and the build gate holds the candidate.
    f.revert();
    const refused = await f.github.observe(f.work);
    assert.match(regressionRefusals(f.work, refused, []).join('\n'), /A: .*differs from the base branch tip/);
    assert.equal(build(f.work, refused).passed, false, build(f.work, refused).reasons.join('; '));
  } finally { await f.clean(); }
});

test('unit:landing-live-base-refusal-clears — refusal clears on re-observation without new head', async () => {
  const f = await fixture();
  try {
    const clean = await f.github.observe(f.work);
    // Simulate a stale observation that incorrectly has a refusal for A
    const stale = { ...clean, landing: { ...clean.landing!, files: [{ path: 'A', status: 'modified' as const, sha: f.blob(f.head(), 'A'), baseSha: f.blob(f.base, 'A'), additions: 1, deletions: 1, binary: false }], carried: [], foreign: [], landed: [], examined: [] } };
    assert.equal(build(f.work, stale).passed, false);
    const work = { ...f.work, candidate: stale.candidate, observation: stale };
    const next = await f.github.observe(work, []);
    assert.deepEqual(next.candidate, stale.candidate);
    assert.equal(f.head(), stale.candidate.sha, 'no push or sync');
    assert.equal(build(work, next).passed, true, build(work, next).reasons.join('; '));
    assert.deepEqual(regressionRefusals(work, next, []), []);
  } finally { await f.clean(); }
});
