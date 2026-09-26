import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ciConcurrencyAdvisories, protectionPlan, readWorkflow, readWorkflows, type WorkflowFile } from '../src/protection.js';
import type { Work } from '../src/model.js';

// A superseded pull-request run must stop holding an Actions runner (GY-295): every base refresh and
// rework push otherwise adds a full run while the older ones keep the concurrent-runner limit, and
// every item waits in Test. Runs on main are never cancelled. One case per proof:
// unit:ci-cancels-superseded-runs, unit:onboarding-ci-concurrency-advisory.

// The subset of GitHub's expression language the concurrency keys use: context paths, string and
// number literals, `!`, `==`, `!=`, `&&`, `||` (both yield an operand, as in Actions), parentheses
// and format(). Evaluating the keys, rather than matching their text, is what shows which runs
// share a group and which of those cancel.
function evaluate(expression: string, context: Record<string, unknown>): unknown {
  const tokens = [...expression.matchAll(/\s*('(?:[^']|'')*'|\d+|==|!=|&&|\|\||[!(),]|[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)/gy)].map(match => match[1]);
  assert.equal(tokens.join('').length, expression.replace(/\s+/g, '').length, `unsupported expression: ${expression}`);
  let at = 0;
  const peek = () => tokens[at], take = () => tokens[at++];
  const or = (): unknown => { let left = and(); while (peek() === '||') { take(); const right = and(); left = left ? left : right; } return left; };
  const and = (): unknown => { let left = compare(); while (peek() === '&&') { take(); const right = compare(); left = left ? right : left; } return left; };
  const compare = (): unknown => {
    const left = unary();
    if (peek() !== '==' && peek() !== '!=') return left;
    const equal = take() === '==', right = unary();
    return (String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase()) === equal;
  };
  const unary = (): unknown => peek() === '!' ? (take(), !unary()) : primary();
  const primary = (): unknown => {
    const token = take();
    if (token === '(') { const value = or(); assert.equal(take(), ')'); return value; }
    if (token.startsWith("'")) return token.slice(1, -1).replace(/''/g, "'");
    if (/^\d+$/.test(token)) return Number(token);
    if (token === 'true' || token === 'false') return token === 'true';
    if (token === 'null') return null;
    if (peek() === '(') {
      take(); const args: unknown[] = [];
      while (peek() !== ')') { args.push(or()); if (peek() === ',') take(); }
      take();
      assert.equal(token, 'format', `unsupported function ${token}`);
      return String(args[0]).replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index) + 1] ?? ''));
    }
    return token.split('.').reduce<any>((value, key) => value?.[key] ?? null, context);
  };
  const value = or();
  assert.equal(at, tokens.length, `trailing tokens in ${expression}`);
  return value;
}
/** A workflow value: literal text with `${{ }}` interpolations, or one bare expression. */
function interpolate(value: string, context: Record<string, unknown>) {
  const whole = value.match(/^\$\{\{(.*)\}\}$/s);
  if (whole && !whole[1].includes('}}')) return evaluate(whole[1], context);
  return value.replace(/\$\{\{(.*?)\}\}/g, (_, expression) => String(evaluate(expression, context) ?? ''));
}

type Run = { event: string; ref: string; runId: string; pr?: number; inputs?: Record<string, string> };
function concurrencyOf(workflowName: string, concurrency: { group: string | null; cancelInProgress: string | null }, run: Run) {
  const context = { github: { workflow: workflowName, event_name: run.event, ref: run.ref, run_id: run.runId, event: run.pr ? { pull_request: { number: run.pr } } : {} }, inputs: run.inputs ?? {} };
  const cancel = concurrency.cancelInProgress === null ? false : interpolate(concurrency.cancelInProgress, context);
  return { group: String(interpolate(concurrency.group ?? '', context)), cancel: cancel === true || cancel === 'true' };
}
/** Whether a later run of this workflow cancels an earlier one: same group, and the later run cancels in progress. (A pending run in the group is replaced even without it.) */
const supersedes = (earlier: { group: string }, later: { group: string; cancel: boolean }) => earlier.group === later.group;
const cancelsRunning = (earlier: { group: string }, later: { group: string; cancel: boolean }) => earlier.group === later.group && later.cancel;

test('unit:ci-cancels-superseded-runs — every pull_request-triggered workflow cancels superseded runs, and runs on main are never cancelled', async () => {
  const workflows = readWorkflows();
  const byPath = new Map(workflows.map(file => [file.path, file]));
  for (const required of ['.github/workflows/ci.yml', '.github/workflows/helm.yml']) assert.ok(byPath.has(required), `${required} exists`);
  const pullRequestWorkflows = workflows.filter(file => readWorkflow(file.text).pullRequest);
  assert.ok(pullRequestWorkflows.some(file => file.path.endsWith('/ci.yml')) && pullRequestWorkflows.some(file => file.path.endsWith('/helm.yml')), 'ci.yml and helm.yml run on pull requests');
  for (const path of ['.github/workflows/ci.yml', '.github/workflows/helm.yml']) {
    const { concurrency } = readWorkflow(byPath.get(path)!.text);
    assert.ok(concurrency?.group?.startsWith('${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}'), `${path} groups its runs per pull request: ${concurrency?.group}`);
    assert.equal(concurrency?.cancelInProgress, "${{ github.event_name == 'pull_request' }}", `${path} cancels in progress for pull_request events only`);
  }
  for (const file of pullRequestWorkflows) {
    const workflow = readWorkflow(file.text);
    const name = file.text.match(/^name:\s*(.+)$/m)?.[1].trim() ?? file.path;
    assert.ok(workflow.concurrency, `${file.path} declares a workflow-level concurrency group`);
    const event = /^\s{2}pull_request_target:/m.test(file.text) ? 'pull_request_target' : 'pull_request';
    const head = (pr: number, runId: string, inputs?: Record<string, string>): Run => ({ event, ref: `refs/pull/${pr}/merge`, runId, pr, inputs });
    const older = concurrencyOf(name, workflow.concurrency!, head(7, '100')), newer = concurrencyOf(name, workflow.concurrency!, head(7, '101'));
    assert.ok(cancelsRunning(older, newer), `${file.path}: a newer head of pull request 7 cancels the run for the older one (${older.group} / ${newer.group}, cancel ${newer.cancel})`);
    assert.ok(!supersedes(older, concurrencyOf(name, workflow.concurrency!, head(8, '102'))), `${file.path}: another pull request never cancels pull request 7`);
    if (workflow.push) {
      // Pushes to main, and to a merge-queue ref, are each their own run: neither a running nor a
      // pending one is ever cancelled by the next push or by a pull request.
      for (const ref of ['refs/heads/main', 'refs/heads/gh-readonly-queue/main/pr-7-abc']) {
        for (const eventName of ['push', 'merge_group']) {
          const first = concurrencyOf(name, workflow.concurrency!, { event: eventName, ref, runId: '200' });
          const second = concurrencyOf(name, workflow.concurrency!, { event: eventName, ref, runId: '201' });
          assert.equal(first.cancel, false, `${file.path}: a ${eventName} run on ${ref} never cancels in progress`);
          assert.ok(!supersedes(first, second), `${file.path}: a later ${eventName} to ${ref} never shares the earlier run's group (${first.group})`);
          assert.ok(!supersedes(first, newer), `${file.path}: a pull request never shares a ${eventName} run's group on ${ref}`);
        }
      }
    }
  }
  // The advisory graphyard master protection gives a managed repository is silent on this one.
  assert.deepEqual(ciConcurrencyAdvisories(['test', 'typecheck', 'chart'], workflows), []);
});

// One branch's finding must never fail another branch's check (GY-435): the secrets job scans the
// checked-out history, never every fetched branch (--all). On a pull_request the checkout is the
// merge ref refs/pull/N/merge, whose history is exactly the base branch's full history plus
// base..HEAD — the pull request's own history, base range included; on a push to main, HEAD is
// main and its full history is scanned. Proof: unit:secrets-scan-pr-scoped.
test('unit:secrets-scan-pr-scoped — the secrets scan\u2019s log options exclude --all and cover the pull request\u2019s own history (base full history plus base..HEAD), and the scan passes the ignore file', async () => {
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const jobStart = ci.indexOf('\n  secrets:');
  assert.ok(jobStart >= 0, 'ci.yml has a secrets job');
  const job = ci.slice(jobStart + 1).match(/^  secrets:\n([\s\S]*?)\n  \S/)?.[1];
  assert.ok(job, 'the secrets job block is readable');
  const scans = [...job.matchAll(/^\s+.*gitleaks git .*$/gm)].map(match => match[0]);
  assert.ok(scans.length >= 1, 'the secrets job runs gitleaks over Git history');
  for (const scan of scans) {
    assert.doesNotMatch(scan, /--all|--branches|--tags|--remotes/, `the scan never names another fetched branch: ${scan}`);
    assert.match(scan, /--gitleaks-ignore-path "?\$?GITHUB_WORKSPACE"?\/\.github\/gitleaksignore\.txt|--gitleaks-ignore-path \.github\/gitleaksignore\.txt/, `the scan passes the ignore file: ${scan}`);
  }
  // A pull_request checkout is refs/pull/N/merge: HEAD is the merge commit, and git log over it
  // walks exactly the base branch's full history plus base..HEAD. --log-opts=HEAD therefore names
  // the base range the criterion asks the scan to include, without ever reading other branches.
  const pullRequestScan = scans[0];
  assert.match(pullRequestScan, /--log-opts=HEAD\b/, `the pull-request scan is taken over HEAD, whose history spans the base range: ${pullRequestScan}`);
});

const openWork = (checks: string[], overrides: Partial<Work> = {}) => ({ id: 'work-id', key: 'GY-42', stage: 'review', policy: { checks, review: true }, ...overrides } as unknown as Work);
const protection = { required_pull_request_reviews: { required_approving_review_count: 1, require_last_push_approval: true, dismiss_stale_reviews: true }, required_status_checks: { strict: false, checks: [{ context: 'Graphyard / merge', app_id: 1234 }] }, enforce_admins: { enabled: true } };
const config = { repository: 'owner/project', baseBranch: 'main', githubAppId: 1234 };

test('unit:onboarding-ci-concurrency-advisory — onboarding recommends cancelling superseded pull-request runs, and master protection reports a required check whose workflow lacks cancel-in-progress', async () => {
  const onboarding = await readFile(new URL('../docs/onboarding.md', import.meta.url), 'utf8');
  assert.match(onboarding, /CI workflows should cancel superseded pull-request runs/);
  assert.ok(onboarding.includes('${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}'), 'onboarding gives the per-pull-request group');
  assert.ok(onboarding.includes("cancel-in-progress: ${{ github.event_name == 'pull_request' }}"), 'onboarding cancels for pull_request events only');
  assert.match(onboarding, /runs on main are never cancelled/);
  assert.match(onboarding, /`graphyard master protection` lists each required check whose workflow lacks cancel-in-progress under `advisories`/);

  const uncancelled: WorkflowFile = { path: '.github/workflows/ci.yml', text: 'name: CI\non:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  unit:\n    name: test\n    runs-on: ubuntu-latest\n  typecheck:\n    runs-on: ubuntu-latest\n' };
  const cancelled: WorkflowFile = { path: '.github/workflows/lint.yml', text: "name: Lint\non: [pull_request]\nconcurrency:\n  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\njobs:\n  lint:\n    runs-on: ubuntu-latest\n" };
  const jobLevel: WorkflowFile = { path: '.github/workflows/e2e.yml', text: 'name: E2E\non:\n  pull_request:\njobs:\n  e2e:\n    concurrency:\n      group: e2e-${{ github.ref }}\n      cancel-in-progress: true\n    runs-on: ubuntu-latest\n' };
  const pushOnly: WorkflowFile = { path: '.github/workflows/nightly.yml', text: 'name: Nightly\non:\n  push:\n    branches: [main]\njobs:\n  soak:\n    runs-on: ubuntu-latest\n' };
  const workflows = [uncancelled, cancelled, jobLevel, pushOnly];

  const plan = protectionPlan(protection, config, [openWork(['test', 'typecheck', 'lint', 'e2e', 'soak']), openWork(['deploy'], { key: 'GY-9', stage: 'done' } as any)], undefined, workflows);
  assert.deepEqual(plan.advisories, [
    'Required check test runs in .github/workflows/ci.yml (job unit), which never cancels superseded pull-request runs; add a concurrency group per pull request with cancel-in-progress for pull_request events, so a run for a superseded head stops holding an Actions runner',
    'Required check typecheck runs in .github/workflows/ci.yml (job typecheck), which never cancels superseded pull-request runs; add a concurrency group per pull request with cancel-in-progress for pull_request events, so a run for a superseded head stops holding an Actions runner',
  ], 'the advisory names each required check (by job name or id) whose pull-request workflow lacks cancel-in-progress; cancelling workflows, job-level concurrency, push-only workflows and checks of done items are silent');
  assert.equal(plan.consistent, true, 'an advisory is never a blocker or a change: protection itself stays consistent');
  assert.deepEqual(plan.blockers, []);
  const off: WorkflowFile = { ...cancelled, text: cancelled.text.replace(/cancel-in-progress: .*/, 'cancel-in-progress: false') };
  assert.equal(ciConcurrencyAdvisories(['lint'], [off]).length, 1, 'cancel-in-progress: false is no cancellation');
  assert.equal(ciConcurrencyAdvisories(['lint'], [{ ...cancelled, text: cancelled.text.replace(/concurrency:\n(?: {2}.*\n)+/, 'concurrency: lint-group\n') }]).length, 1, 'a bare group without cancel-in-progress only queues');
});
