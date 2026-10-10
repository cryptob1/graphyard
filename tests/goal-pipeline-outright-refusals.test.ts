import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordGoal, type Goal } from '../src/model/goal.js';
import { ReconciliationRetry, Refusal, RefusedResponse } from '../src/model/refusal.js';
import type { AcceptanceEffects } from '../src/daemon/acceptance.js';
import type { PlannerEffects } from '../src/daemon/planner.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';
import type { Principal } from '../src/model.js';
import { ChildProcessError } from '../src/child-runner.js';

// GY-1661 AC-1: a plan release or an acceptance draft the control plane (or GitHub) refuses outright,
// for authority (401, 403), the current state (409) or the input (422), is never asked again every ten
// minutes: the acceptance draft is dropped as unopenable and drafted again in an hour, and the plan
// release is asked again only after planRetryMs, its note naming the outright refusal.
/** The loop's modules, loaded inside each test so a tree without refusedOutright fails as a test case, not as a file that cannot load. */
const loop = async () => ({ ...await import('../src/daemon/acceptance.js'), ...await import('../src/daemon/planner.js') });
const root = fileURLToPath(new URL('..', import.meta.url));
const master: Principal = { id: 'refusal-master', role: 'coordinator', sessionKind: 'ai' };
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/bin/graphyard', repository: 'owner/refusals', baseBranch: 'main',
  githubAppId: 1234, hostId: 'machine-a', masterAgentName: 'graphyard-master-refusals', autoMerge: true, mergeMethod: 'merge', workers: [] });
const refused = (status: number) => new RefusedResponse(`Graphyard refused goals (${status}): not for you`, status, { error: 'not for you' });
/** A `gh` or `git` child GitHub refused, as the acceptance open path's ChildRun rejects with it. */
const childFailure = (command: 'gh' | 'git', stderr: string, timedOut = false) => new ChildProcessError(command, ['pr', 'create'], { stdout: '', stderr, status: timedOut ? null : 1, signal: null, timedOut, timeoutMs: 1000 });
/** What GitHub's CLIs print when GitHub refuses them outright, by the status they stand for. */
const ghRefusals: [number, 'gh' | 'git', string][] = [
  [401, 'gh', 'HTTP 401: Bad credentials (https://api.github.com/graphql)\n'],
  [401, 'gh', 'pull request create failed: GraphQL: Bad credentials\n'],
  [403, 'gh', 'HTTP 403: Resource not accessible by integration (https://api.github.com/repos/owner/refusals/pulls)\n'],
  [403, 'gh', 'pull request create failed: GraphQL: Resource not accessible by integration (createPullRequest)\n'],
  [409, 'gh', 'gh: Reference update failed (HTTP 409)\n'],
  [403, 'git', 'remote: Permission to owner/refusals.git denied to graphyard-bot.\nfatal: unable to access \'https://github.com/owner/refusals.git/\': The requested URL returned error: 403\n'],
  [403, 'git', 'ERROR: Permission to owner/refusals.git denied to deploy-key.\nfatal: Could not read from remote repository.\n'],
];

function stubRunner(respond: () => unknown): Runner {
  return {
    name: 'stub',
    start<T>(_prompt: string, options: RunOptions<T>) {
      let result: RunResult<T>;
      try { const parsed = options.validate(respond()); result = { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] }; }
      catch (error) { result = { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
      return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
    },
  };
}
const caseOf = (id: string) => ({ id, title: `The ${id} outcome is reachable`, description: 'A customer reads the board.', tags: ['api'], target: 'uat', required: true,
  steps: [{ kind: 'http', name: 'read the board', method: 'GET', path: '/api/board', status: 200, expect: [{ path: 'groups.backlog', type: 'array' }] }] });
const draftOf = (goal: string) => ({ goal, outcomes: [{ id: 'refusal-outcome', title: 'A customer sees the board', criteria: ['The board answers'], case: caseOf('refusal-outcome') }] });

test('unit:goal-pipeline-outright-refusals — 401, 403, 409 and 422 are outright refusals; a reconciliation retry and a 502 are not', async () => {
  const { refusedOutright } = await loop();
  for (const status of [401, 403, 409, 422]) {
    assert.equal(refusedOutright(refused(status)), true, `a ${status} response is refused outright`);
    assert.equal(refusedOutright(new Refusal('refused', status)), true, `a ${status} refusal is refused outright`);
  }
  for (const status of [400, 404, 429, 500, 502, 503]) assert.equal(refusedOutright(refused(status)), false, `a ${status} response is retried`);
  assert.equal(refusedOutright(new ReconciliationRetry('re-read the state', 409)), false, 'a reconciliation retry may pass once the state is re-read');
  assert.equal(refusedOutright(new Error('gh pr create: HTTP 502')), false);
});

test('unit:goal-pipeline-outright-refusals — a gh or git child GitHub refused with 401, 403 or 409 is refused outright; a 502, a network failure or a timeout is not', async () => {
  const { childRefusalStatus, refusedOutright } = await loop();
  for (const [status, command, stderr] of ghRefusals) {
    assert.equal(childRefusalStatus(childFailure(command, stderr)), status, stderr);
    assert.equal(refusedOutright(childFailure(command, stderr)), true, `${command} refused with ${status} is refused outright`);
  }
  for (const stderr of ['HTTP 502: Bad Gateway (https://api.github.com/graphql)\n', 'error connecting to api.github.com\n', 'fatal: unable to access \'https://github.com/owner/refusals.git/\': Could not resolve host: github.com\n'])
    assert.equal(refusedOutright(childFailure('gh', stderr)), false, `retried: ${stderr}`);
  assert.equal(refusedOutright(childFailure('gh', 'HTTP 403: Resource not accessible by integration\n', true)), false, 'a timed-out child was not answered');
  assert.equal(refusedOutright(new ChildProcessError('npm', ['test'], { stdout: '', stderr: 'HTTP 403', status: 1, signal: null, timedOut: false })), false, 'only gh and git speak for GitHub');
});

test('unit:goal-pipeline-outright-refusals — an acceptance draft whose gh pull request open GitHub refuses with 401, 403 or 409 is dropped and drafted again only after an hour, not reopened every ten minutes', async () => {
  const { acceptanceRetryMs, acceptanceStep, acceptanceStepRetryMs, clearDrafts, draftsSettled, openAcceptancePullRequest } = await loop();
  for (const [status, command, stderr] of ghRefusals) {
    clearDrafts();
    const goal = recordGoal({ statement: 'Customers can read the board', users: ['Customers'], constraints: [], deployTarget: 'uat then production' }, `GOAL-GH-${status}-${command}`, { actor: master, at: new Date().toISOString() });
    let runs = 0, opens = 0;
    // The real open path, whose git and gh calls answer as GitHub refusing the push (git) or the pull request (gh).
    const scratch = await mkdtemp(join(tmpdir(), 'gy-1661-open-'));
    const child = async (cmd: string, args: string[]) => {
      if (cmd === 'git' && args.includes('worktree') && args.includes('add')) { await mkdir(args[args.length - 2]!, { recursive: true }); return ''; }
      if (cmd === 'git' && args.includes('rev-parse')) return `${'c'.repeat(40)}\n`;
      if (cmd === 'git' && args.includes('push') && command === 'git') throw childFailure('git', stderr);
      if (cmd === 'gh' && args[1] === 'list') return '[]';
      if (cmd === 'gh' && args[1] === 'create') throw childFailure('gh', stderr);
      return '';
    };
    const fx: AcceptanceEffects = {
      settings: diagnosticianSettings({}), cwd: root,
      goals: async () => [goal],
      runner: async (_role, attempt) => ({ runner: stubRunner(() => { runs++; return draftOf(goal.key); }), runtime: 'stub', model: attempt }),
      open: async (target, draft) => { opens++; return openAcceptancePullRequest(child as never, '/outside/root', scratch, config, target, draft); },
      draft: async target => target,
      judge: async target => target,
      pullRequest: async () => ({ state: 'open', mergeSha: null, head: null }),
      land: async () => { throw new Error('nothing is landed'); },
      close: async () => {},
      closed: async target => target,
    };
    const state = emptyDaemonState(config);
    let clock = Date.parse('2026-10-10T00:00:00Z');
    const cycle = async (advance: number) => {
      clock += advance;
      await acceptanceStep({ config, state, effects: { acceptance: fx, persist: async () => {} }, now: () => clock, clock, performed: [], isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() } as unknown as Cycle);
      await draftsSettled();
    };
    try {
      await cycle(60_000); await cycle(60_000);
      assert.equal(opens, 1, 'the draft was opened once');
      assert.match(state.actions[`acceptance:${goal.id}`].detail, /can never be opened: Command failed: .*dropped and drafted again in an hour/s, `${command} refused with ${status}`);
      for (let minutes = 0; minutes < 50; minutes += 10) await cycle(acceptanceStepRetryMs);
      assert.equal(opens, 1, `a ${command} ${status} is not opened again every ten minutes`);
      assert.equal(runs, 1, 'and the dropped draft is not drafted again before the hour');
      await cycle(acceptanceRetryMs - 50 * 60_000 + 60_000);
      assert.equal(runs, 2, 'an hour on, a new draft is launched');
    } finally { await rm(scratch, { recursive: true, force: true }); }
  }
  clearDrafts();
});

test('unit:goal-pipeline-outright-refusals — an acceptance draft whose open or post is refused with 401, 403 or 409 is dropped as unopenable and drafted again only after an hour', async () => {
  const { acceptanceRetryMs, acceptanceStep, acceptanceStepRetryMs, clearDrafts, draftsSettled } = await loop();
  for (const [step, status] of [['open', 401], ['open', 403], ['open', 409], ['post', 401], ['post', 403], ['post', 409]] as const) {
    clearDrafts();
    const goal = recordGoal({ statement: 'Customers can read the board', users: ['Customers'], constraints: [], deployTarget: 'uat then production' }, `GOAL-${step}-${status}`, { actor: master, at: new Date().toISOString() });
    let runs = 0, opens = 0, posts = 0;
    const closes: number[] = [];
    const fx: AcceptanceEffects = {
      settings: diagnosticianSettings({}), cwd: root,
      goals: async () => [goal],
      runner: async (_role, attempt) => ({ runner: stubRunner(() => { runs++; return draftOf(goal.key); }), runtime: 'stub', model: attempt }),
      open: async () => { opens++; if (step === 'open') throw refused(status); return { pr: 900 + opens, branch: `graphyard/${goal.key.toLowerCase()}`, head: 'c'.repeat(40) }; },
      draft: async () => { posts++; throw refused(status); },
      judge: async target => target,
      pullRequest: async () => ({ state: 'open', mergeSha: null, head: null }),
      land: async () => { throw new Error('nothing is landed'); },
      close: async pr => { closes.push(pr); },
      closed: async target => target,
    };
    const state = emptyDaemonState(config);
    let clock = Date.parse('2026-10-10T00:00:00Z');
    const cycle = async (advance: number) => {
      clock += advance;
      await acceptanceStep({ config, state, effects: { acceptance: fx, persist: async () => {} }, now: () => clock, clock, performed: [], isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() } as unknown as Cycle);
      await draftsSettled();
    };
    await cycle(60_000);
    assert.equal(runs, 1, 'the role drafts once');
    await cycle(60_000);
    const action = state.actions[`acceptance:${goal.id}`];
    assert.equal(action.state, 'failed');
    assert.match(action.detail, new RegExp(`can never be opened: Graphyard refused goals \\(${status}\\).*dropped and drafted again in an hour`), `${step} refused with ${status}`);
    if (step === 'post') assert.deepEqual(closes, [901], 'the pull request opened for a draft refused outright is closed');
    const tried = opens + posts;
    // Not every ten minutes: nothing is opened, posted or drafted again before the hour.
    for (let minutes = 0; minutes < 50; minutes += 10) await cycle(acceptanceStepRetryMs);
    assert.equal(opens + posts, tried, `a ${status} on the ${step} is not asked again every ten minutes`);
    assert.equal(runs, 1, 'and the dropped draft is not drafted again before the hour');
    await cycle(acceptanceRetryMs - 50 * 60_000 + 60_000);
    assert.equal(runs, 2, 'an hour on, a new draft is launched');
  }
  clearDrafts();
});

test('unit:goal-pipeline-outright-refusals — a plan release refused with 401, 403 or 409 is asked again only after planRetryMs, naming the outright refusal; a 502 still retries in ten minutes', async () => {
  const { clearPlans, plannerStep, planRetryMs, plansSettled, planStepRetryMs } = await loop();
  for (const status of [401, 403, 409, 502]) {
    clearPlans();
    const recorded = recordGoal({ statement: 'Customers can read the board', users: ['Customers'], constraints: [], deployTarget: 'uat then production' }, `GOAL-R${status}`, { actor: master, at: new Date().toISOString() });
    // The release step reads only the goal's stage and identity: an approved plan awaiting release.
    const goal = { ...recorded, stage: 'planned', merged: { pr: 1, mergeSha: 'b'.repeat(40) } } as unknown as Goal;
    const releases: number[] = [];
    const fx: PlannerEffects = {
      settings: diagnosticianSettings({}), cwd: root,
      goals: async () => [goal],
      runner: async () => { throw new Error('no run is launched for a planned goal'); },
      plan: async target => target, invalid: async target => target, judge: async target => target,
      release: async () => { releases.push(clock); throw refused(status); },
      deliver: async target => target,
    };
    const state = emptyDaemonState(config);
    let clock = Date.parse('2026-10-10T00:00:00Z');
    const step = async (advance: number) => {
      clock += advance;
      await plannerStep({ config, state, effects: { planner: fx, persist: async () => {} }, now: () => clock, clock, snapshot: { work: [] }, performed: [], isolate: async (_k: string, _i: unknown, _n: string, body: () => Promise<unknown>) => body() } as unknown as Cycle);
      await plansSettled();
    };
    await step(60_000);
    assert.equal(releases.length, 1);
    const detail = state.actions[`planner:${goal.id}`].detail;
    if (status === 502) {
      assert.match(detail, /it is asked again in ten minutes/);
      await step(planStepRetryMs);
      assert.equal(releases.length, 2, 'a failure that is not a refusal is asked again in ten minutes');
      continue;
    }
    assert.match(detail, new RegExp(`Could not release ${goal.key}'s approved plan: Graphyard refused goals \\(${status}\\).*refused it outright, so it is asked again in an hour`));
    for (let minutes = 0; minutes < 50; minutes += 10) await step(planStepRetryMs);
    assert.equal(releases.length, 1, `a release refused with ${status} is not asked again every ten minutes`);
    await step(planRetryMs - 50 * 60_000);
    assert.equal(releases.length, 2, 'it is asked again once planRetryMs has passed');
  }
  clearPlans();
});
