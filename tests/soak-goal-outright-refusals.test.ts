import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChildProcessError } from '../src/child-runner.js';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { recordGoal, type Goal } from '../src/model/goal.js';
import { RefusedResponse } from '../src/model/refusal.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';
import type { AcceptanceEffects } from '../src/daemon/acceptance.js';
import type { PlannerEffects } from '../src/daemon/planner.js';
import type { Principal } from '../src/model.js';

/**
 * GY-1661: the goal pipeline's outright refusals over two simulated days of the real loop's cycles,
 * five minutes apart. Five goals: an acceptance draft whose `gh pr create` GitHub refuses 403 (the
 * real open path), one whose draft post the control plane refuses 409, a plan release refused 403
 * throughout, one refused 401 until the operator restores the credential on the second morning, and
 * one meeting a 502 for its first hour. After every cycle the system invariants hold; a draft refused
 * outright costs one paid run an hour, never an open every ten minutes; an outright-refused release
 * is asked once an hour and released once its refusal lifts, while the 502 is asked every ten minutes.
 */
const minute = 60_000, hour = 60 * minute, days = 2, cycleMs = 5 * minute;
const root = fileURLToPath(new URL('..', import.meta.url));
const master: Principal = { id: 'soak-refusal-master', role: 'coordinator', sessionKind: 'ai' };
const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: 'graphyard', repository: 'owner/refusals', baseBranch: 'main',
  githubAppId: 1234, hostId: 'vishrog', masterAgentName: 'graphyard-master-refusals', workers: [] });
const refused = (status: number) => new RefusedResponse(`Graphyard refused goals (${status}): refused`, status, { error: 'refused' });
const caseOf = (id: string) => ({ id, title: `The ${id} outcome is reachable`, description: 'A customer reads the board.', tags: ['api'], target: 'uat', required: true,
  steps: [{ kind: 'http', name: 'read the board', method: 'GET', path: '/api/board', status: 200, expect: [{ path: 'groups.backlog', type: 'array' }] }] });

test('unit:soak-invariants-hold — over two days goal steps GitHub or the control plane refuses with 401, 403 or 409 are retried hourly, never every ten minutes, a lifted refusal releases once, a 502 still retries in ten minutes, and every invariant holds', { timeout: 300_000 }, async () => {
  const { acceptanceRetryMs, clearDrafts, draftsSettled, openAcceptancePullRequest } = await import('../src/daemon/acceptance.js');
  const { clearPlans, planRetryMs, planStepRetryMs, plansSettled } = await import('../src/daemon/planner.js');
  clearDrafts(); clearPlans();
  const start = Date.parse('2026-10-10T00:00:00Z');
  let now = start;
  const goal = (name: string, stage: Goal['stage']) => {
    const recorded = recordGoal({ statement: `Customers can use ${name}`, users: ['Customers'], constraints: [], deployTarget: 'uat then production' }, `GOAL-${name.toUpperCase()}`, { actor: master, at: new Date(start).toISOString() });
    return { ...recorded, stage, ...(stage === 'planned' ? { merged: { pr: 1, mergeSha: 'b'.repeat(40) } } : {}) } as unknown as Goal;
  };
  const goals = new Map<string, Goal>(Object.entries({ ghOpen: goal('ghopen', 'acceptance-drafting'), post409: goal('post', 'acceptance-drafting'),
    release403: goal('forbidden', 'planned'), release401: goal('lapsed', 'planned'), release502: goal('gateway', 'planned') }));
  const nameOf = (target: Goal) => [...goals].find(([, entry]) => entry.id === target.id)![0];

  // The acceptance role drafts at once; the gh path runs the real open, whose pull request create GitHub refuses.
  const runs: { goal: string; at: number }[] = [], opens: { goal: string; at: number }[] = [], posts: { goal: string; at: number }[] = [], closes: number[] = [];
  const runner: Runner = {
    name: 'soak',
    start<T>(_prompt: string, options: RunOptions<T>) {
      const result: RunResult<T> = (() => { const payload = options.validate(pendingDraft!); return { ok: true as const, tool: options.tool, payload, payloads: [payload] }; })();
      return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
    },
  };
  let pendingDraft: unknown = null;
  const scratch = await mkdtemp(join(tmpdir(), 'soak-gy-1661-'));
  const child = async (command: string, args: string[]) => {
    if (command === 'git' && args.includes('worktree') && args.includes('add')) { await mkdir(args[args.length - 2]!, { recursive: true }); return ''; }
    if (command === 'git' && args.includes('rev-parse')) return `${'c'.repeat(40)}\n`;
    if (command === 'gh' && args[1] === 'list') return '[]';
    if (command === 'gh' && args[1] === 'create') throw new ChildProcessError('gh', args, { stdout: '', stderr: 'pull request create failed: GraphQL: Resource not accessible by integration (createPullRequest)\n', status: 1, signal: null, timedOut: false });
    return '';
  };
  const acceptance: AcceptanceEffects = {
    settings: diagnosticianSettings({}), cwd: root,
    goals: async () => [...goals.values()].filter(entry => entry.stage === 'acceptance-drafting'),
    runner: async (_role, attempt, target) => {
      runs.push({ goal: nameOf(target), at: now });
      pendingDraft = { goal: target.key, outcomes: [{ id: `${nameOf(target).toLowerCase()}-${runs.length}`, title: 'A customer sees the board', criteria: ['The board answers'], case: caseOf(`${nameOf(target).toLowerCase()}-${runs.length}`) }] };
      return { runner, runtime: 'soak', model: attempt };
    },
    open: async (target, draft) => {
      opens.push({ goal: nameOf(target), at: now });
      if (nameOf(target) === 'ghOpen') return openAcceptancePullRequest(child as never, '/outside/root', scratch, config, target, draft);
      return { pr: 1000 + opens.length, branch: `graphyard/${target.key.toLowerCase()}`, head: 'c'.repeat(40) };
    },
    draft: async target => { posts.push({ goal: nameOf(target), at: now }); throw refused(409); },
    judge: async target => target,
    pullRequest: async () => ({ state: 'open', mergeSha: null, head: null }),
    land: async () => { throw new Error('nothing is landed'); },
    close: async pr => { closes.push(pr); },
    closed: async target => target,
  };

  // The 403 never lifts; the 401 lifts on the second morning; the 502 answers after an hour.
  const releases: { goal: string; at: number; ok: boolean }[] = [];
  const answers: Record<string, (at: number) => number | null> = { release403: () => 403, release401: at => at < start + 30 * hour ? 401 : null, release502: at => at < start + hour ? 502 : null };
  const planner: PlannerEffects = {
    settings: diagnosticianSettings({}), cwd: root,
    goals: async () => [...goals.values()].filter(entry => entry.stage === 'planned' || entry.stage === 'delivering'),
    runner: async () => { throw new Error('no plan is run for a planned goal'); },
    plan: async target => target, invalid: async target => target, judge: async target => target,
    release: async target => {
      const name = nameOf(target), status = answers[name]!(now);
      releases.push({ goal: name, at: now, ok: status === null });
      if (status !== null) throw refused(status);
      const released = { ...target, stage: 'delivering', items: [], revision: target.revision + 1 } as unknown as Goal;
      goals.set(name, released);
      return released;
    },
    deliver: async target => target,
  };

  const effects = { agents: () => [], credentials: async () => ({}), snapshot: async () => ({ work: [], now: new Date(now).toISOString() }), closeSession: () => {}, dispatch: async () => {}, requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable', sha: null, at: new Date(now).toISOString(), reason: 'not configured', deployed: [], pending: [] }), recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    acceptance, planner } as unknown as DaemonEffects;
  const state = emptyDaemonState(config), violations: string[] = [];
  try {
    for (let cycle = 0; now < start + days * 24 * hour; cycle++, now += cycleMs) {
      await runCycle(config, state, effects, () => now);
      await draftsSettled(); await plansSettled();
      for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.reading}`);
    }
  } finally { await rm(scratch, { recursive: true, force: true }); clearDrafts(); clearPlans(); }
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');

  // A draft refused outright, by GitHub through gh or by the control plane, is dropped and drafted again an hour on: one paid run, one open an hour.
  const spaced = (entries: { at: number }[], gap: number, what: string) => entries.slice(1).forEach((entry, index) => assert.ok(entry.at - entries[index]!.at >= gap, `${what} again after ${(entry.at - entries[index]!.at) / minute} minutes`));
  for (const name of ['ghOpen', 'post409']) {
    const drafted = runs.filter(entry => entry.goal === name), opened = opens.filter(entry => entry.goal === name);
    assert.ok(drafted.length >= days * 24 * hour / (acceptanceRetryMs + cycleMs) - 2 && drafted.length <= days * 24 * hour / acceptanceRetryMs + 1, `${name} drafted about once an hour: ${drafted.length}`);
    spaced(drafted, acceptanceRetryMs, `${name} drafted`);
    assert.equal(opened.length, drafted.length, `${name} opened each draft once, never every ten minutes`);
    assert.match(state.actions[`acceptance:${goals.get(name)!.id}`]!.detail, /can never be opened: .*dropped and drafted again in an hour/s);
  }
  assert.equal(posts.length, opens.filter(entry => entry.goal === 'post409').length, 'each 409 post was posted once');
  assert.deepEqual(closes, opens.flatMap((entry, index) => entry.goal === 'post409' ? [1001 + index] : []), 'every pull request opened for a refused post was closed');

  // A release refused outright is asked once an hour; a lifted refusal releases once; a 502 is asked every ten minutes.
  const asked = (name: string) => releases.filter(entry => entry.goal === name);
  spaced(asked('release403'), planRetryMs, 'the 403 release was asked');
  assert.ok(asked('release403').length <= days * 24 * hour / planRetryMs + 1, `the 403 release is bounded: ${asked('release403').length}`);
  assert.ok(asked('release403').every(entry => !entry.ok));
  assert.match(state.actions[`planner:${goals.get('release403')!.id}`]!.detail, /refused it outright, so it is asked again in an hour/);
  spaced(asked('release401'), planRetryMs, 'the 401 release was asked');
  assert.deepEqual(asked('release401').filter(entry => entry.ok).length, 1, 'the lifted 401 released once');
  assert.ok(asked('release401').at(-1)!.ok && asked('release401').at(-1)!.at - (start + 30 * hour) <= planRetryMs + cycleMs, 'within an hour of the refusal lifting');
  assert.equal(goals.get('release401')!.stage, 'delivering');
  const gateway = asked('release502');
  assert.ok(gateway.length >= 6 && gateway.length <= 8 && gateway.at(-1)!.ok, `the 502 was asked every ten minutes until it answered: ${gateway.length}`);
  spaced(gateway, planStepRetryMs, 'the 502 release was asked');
  assert.equal(Object.keys(state.actions).filter(key => key.startsWith('acceptance:') || key.startsWith('planner:')).length, 5, 'one action per goal');
});
