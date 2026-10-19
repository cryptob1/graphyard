import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readWorkflow } from '../src/protection.js';

// A superseded pull-request run must stop holding an Actions runner (GY-295): every base refresh and
// rework push otherwise adds a full run while the older ones keep the concurrent-runner limit, and
// every item waits in Test. Runs on main are never cancelled (unit:ci-cancels-superseded-runs).

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
  const directory = join(process.cwd(), '.github', 'workflows');
  const workflows = readdirSync(directory).filter(name => /\.ya?ml$/.test(name)).sort().map(name => ({ path: `.github/workflows/${name}`, text: readFileSync(join(directory, name), 'utf8') }));
  assert.ok(!workflows.some(file => file.path.endsWith('/ci.yml')), 'GY-2009: ci.yml is gone');
  const pullRequestWorkflows = workflows.filter(file => readWorkflow(file.text).pullRequest);
  assert.equal(pullRequestWorkflows.length, 0, 'no remaining workflow runs on pull_request; the merge writer trial is the gate');
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
});
