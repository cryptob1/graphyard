import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GitHub, CHECK_NAME } from '../src/github.js';
import { evaluate, Refusal, type Work, type Observation } from '../src/model.js';
import { regressionRefusals } from '../src/regression-guard.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// GY-472's blobs: the merge base holds state.ts at X, the candidate's head at Y (a partial
// change), and the landing base at Z (Y plus more). A three-way merge of the head onto the
// landing base holds exactly Z; the head blob alone does not. The base's extra edit sits apart
// from the partial change's lines, the shape git's own merge resolves to Z.
const X = 'state() {\n  read\n  hold\n  tick\n  persist\n}\n';
const Y = 'state() {\n  read\n  hold\n  tock\n  persist\n}\n';
const Z = 'state() {\n  scan\n  hold\n  tock\n  persist\n}\n';

async function fixture(restore = false) {
  const directory = await temporaryDirectory('landing-merge-result');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const bytes = (...args: string[]) => execFileSync('git', args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-b', 'main'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  const commit = (path: string, text: string, message: string) => { writeFileSync(join(directory, path), text); git('add', path); git('commit', '-m', message); return git('rev-parse', 'HEAD'); };
  const blob = (ref: string, path: string) => { try { return git('rev-parse', '--verify', `${ref}:${path}`); } catch { return null; } };
  const diff = (from: string, to: string) => git('diff', '--name-only', from, to).split('\n').filter(Boolean).map(filename => ({ filename,
    status: !blob(to, filename) ? 'removed' : !blob(from, filename) ? 'added' : 'modified', sha: blob(to, filename), additions: 1, deletions: 1, patch: '@@' }));
  const github = new GitHub({ repository: 'owner/repo', base: 'main', appId: 1234, installationId: 1, privateKey: 'unused' });
  github.controlPlaneLogin = async () => 'graphyard[bot]';
  // GY-472's actual situation as three commits: X on the merge base, Y the partial change, Z the
  // extended change on the landing base. Distinct messages keep the two Y-bearing commits
  // distinct commits (their blobs are the same by content, as blob identity is).
  const mergeBase = commit('state.ts', X, 'state at the merge base');
  const partial = commit('state.ts', Y, 'the partial change');
  const base = commit('state.ts', Z, 'the extended change');
  let bound: string;
  if (restore) {
    // The refusing variant: a head that restores X over Z. It branches after the partial change
    // (its merge base with the landing base holds Y) and binds to the merge base, which holds X.
    git('checkout', '-b', 'candidate', partial);
    commit('state.ts', X, 'restore the merge-base state');
    bound = mergeBase;
  } else {
    // GY-472: the branch carries an earlier version of the change the landing base extended.
    git('checkout', '-b', 'candidate', mergeBase);
    commit('state.ts', Y, 'carry the partial change');
    commit('planned.ts', 'planned\n', 'the planned change');
    bound = partial;
  }
  github.request = async (path, method = 'GET') => {
    assert.equal(method, 'GET', 'observation never writes repository state');
    const [route, query] = path.split('?'); const params = new URLSearchParams(query);
    if (route === '/pulls/1') return { number: 1, head: { sha: git('rev-parse', 'candidate'), ref: 'candidate', repo: { full_name: 'owner/repo' } }, base: { sha: base, ref: 'main', repo: { full_name: 'owner/repo' } }, user: { login: 'worker' }, merged: false, state: 'open', mergeable: true, draft: false };
    if (route === '/pulls/1/files') return params.get('page') === '2' ? [] : diff(base, git('rev-parse', 'candidate'));
    if (route === '/pulls/1/reviews') return [];
    if (route.endsWith('/check-runs')) return { check_runs: [] };
    if (route.endsWith('/protection')) return { required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_last_push_approval: true }, required_status_checks: { strict: false, checks: [{ context: CHECK_NAME, app_id: 1234 }] }, enforce_admins: { enabled: true }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
    if (route === '/git/ref/heads/main') return { object: { type: 'commit', sha: base } };
    if (route.startsWith('/git/blobs/')) { const sha = route.slice(11); return { sha, encoding: 'base64', content: bytes('cat-file', 'blob', sha).toString('base64') }; }
    if (route.startsWith('/commits/')) return { commit: { tree: { sha: git('rev-parse', `${route.slice(9)}^{tree}`) } } };
    if (route.startsWith('/compare/')) {
      const [from, to] = route.slice(9).split('...'); const ancestor = git('merge-base', from, to);
      // Deliberately expose endpoint differences: callers must use the supplied merge base.
      return { status: from === to ? 'identical' : ancestor === from ? 'ahead' : 'diverged', merge_base_commit: { sha: ancestor }, files: diff(from, to), commits: [], total_commits: 0 };
    }
    if (route.startsWith('/contents/')) { const sha = blob(params.get('ref')!, decodeURIComponent(route.slice(10))); if (!sha) throw new Refusal(`GitHub GET ${path} failed (404)`, 502); return { type: 'file', sha }; }
    throw new Error(`Unexpected request ${path}`);
  };
  const work = { id: 'w', key: 'GY-472', title: 'landing-merge-result', type: 'bug', description: '', priority: 0, dependencies: [], criteria: [], policy: { checks: [], review: false }, plannedFiles: ['planned.ts'], stage: 'build', revision: 1, policyRevision: 1, ready: true, epoch: 1, lease: null,
    workspaces: [{ host: 'test', path: directory, branch: 'candidate', epoch: 1, owner: 'worker' }], submission: { pr: 1, epoch: 1 }, candidate: { pr: 1, sha: git('rev-parse', 'candidate'), baseSha: bound, branch: 'candidate', author: 'worker' }, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), stageEnteredAt: new Date().toISOString() } as unknown as Work;
  return { github, work, mergeBase, partial, base, git, bytes, diff, blob, head: () => git('rev-parse', 'candidate'),
    clean: async () => {} };
}
const build = (work: Work, observation: Observation) => evaluate({ ...work, candidate: observation.candidate, observation }, [], new Date(), []).gates.find(gate => gate.name === 'build')!;

test('unit:landing-merge-result-per-file — the landing check judges each file by the three-way merge result: a subsumed partial change is no regression, a head restoring the merge-base version over the base\'s is refused', async () => {
  const f = await fixture();
  try {
    // GY-472's shape: the head's state.ts (Y) differs from the landing base's (Z), but the branch
    // carries an earlier version of the change the base extended. The three-way merge of the head
    // onto the landing base holds exactly what the base holds, so no regression is reported.
    const seen = await f.github.observe(f.work);
    assert.deepEqual(regressionRefusals(f.work, seen, []), [], 'should have no regression refusal when the base subsumes the head\'s change');
    assert.equal(build(f.work, seen).passed, true, build(f.work, seen).reasons.join('; '));
    const record = seen.landing!.files!.find(file => file.path === 'state.ts')!;
    assert.equal(record.sha, f.blob(f.partial, 'state.ts'), 'the landing record lists the head blob');
    assert.equal(record.baseSha, f.blob(f.base, 'state.ts'), 'the landing record lists the landing base blob');
    assert.equal(record.mergeSha, record.baseSha, 'the guard judged the merged result, and it is the base\'s version');
    // The refusing shape: a head that restores X over Z is still refused, and the build gate holds.
    const r = await fixture(true);
    try {
      const refused = await r.github.observe(r.work);
      const text = regressionRefusals(r.work, refused, []).join('\n');
      assert.match(text, /Landing the candidate/, text);
      assert.match(text, /state\.ts/, text);
      assert.equal(build(r.work, refused).passed, false, build(r.work, refused).reasons.join('; '));
    } finally { await r.clean(); }
  } finally { await f.clean(); }
});

test('unit:landing-gy472-fixture — the fixture reproduces GY-472\'s three commits, and the guard\'s verdict agrees with git\'s own merge', async () => {
  const f = await fixture();
  try {
    // The three commits hold three distinct blobs: X at the merge base, Y the partial change the
    // head holds, Z the extended change the landing base holds.
    assert.notEqual(f.blob(f.mergeBase, 'state.ts'), f.blob(f.partial, 'state.ts'));
    assert.notEqual(f.blob(f.partial, 'state.ts'), f.blob(f.base, 'state.ts'));
    assert.equal(f.blob(f.head(), 'state.ts'), f.blob(f.partial, 'state.ts'));
    // git's own merge of the head onto the landing base holds Z at state.ts — the shape is genuinely subsumed.
    const merged = f.git('merge-tree', '--write-tree', f.base, f.head());
    assert.equal(f.blob(merged, 'state.ts'), f.blob(f.base, 'state.ts'), 'git merge-tree holds the base version for state.ts');
    const seen = await f.github.observe(f.work);
    const record = seen.landing!.files!.find(file => file.path === 'state.ts')!;
    assert.equal(record.sha, f.blob(f.head(), 'state.ts'));
    assert.equal(record.baseSha, f.blob(f.base, 'state.ts'));
    assert.equal(record.mergeSha, record.baseSha, 'the merged result the guard judged is the base version');
    assert.deepEqual(regressionRefusals(f.work, seen, []), []);
  } finally { await f.clean(); }
});

test('manual:gy472-refusal-cleared — a landing refusal recorded before the fix, in GY-472\'s shape, clears on the next observation without a new head', async () => {
  const f = await fixture();
  try {
    const clean = await f.github.observe(f.work);
    // The stale observation GY-472 recorded: state.ts listed with the head blob and the base blob
    // and no merged result, so the old guard read a revert that a three-way merge does not make.
    const stale: Observation = { ...clean, landing: { ...clean.landing!, files: [{ path: 'state.ts', status: 'modified' as const, sha: f.blob(f.head(), 'state.ts'), baseSha: f.blob(f.base, 'state.ts'), additions: 1, deletions: 1, binary: false }] } };
    assert.equal(build(f.work, stale).passed, false);
    const work = { ...f.work, candidate: stale.candidate, observation: stale };
    const next = await f.github.observe(work, []);
    assert.deepEqual(next.candidate, stale.candidate);
    assert.equal(f.head(), stale.candidate.sha, 'no push or sync');
    assert.deepEqual(regressionRefusals(work, next, []), [], 'the refusal cleared without a new head');
    assert.equal(build(work, next).passed, true, build(work, next).reasons.join('; '));
  } finally { await f.clean(); }
});
