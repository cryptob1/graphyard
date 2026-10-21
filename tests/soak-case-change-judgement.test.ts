import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { acceptanceEffects, clearDrafts, type AcceptanceEffects } from '../src/daemon/acceptance.js';
import { caseChangeJudgementsSettled, clearCaseChangeJudgements } from '../src/daemon/case-change-judge.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import type { CaseChange, Goal } from '../src/model/goal.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';

/**
 * GY-1806. GY-1800 blocked three times because its requested case change (GOAL-1) reached no approver. The
 * loop now launches the approver's judgement of every requested case change and posts the verdict. That step
 * runs for every goal on every cycle, so this soak runs the real loop (runCycle) over a simulated day with
 * an open goal, a goal in planning and a delivered goal (a delivered goal still protects its cases), several
 * changes on each, a run that answers nothing, a run that names the wrong goal and a refused post. Each change
 * is judged once and posted once however many cycles pass, a failed run or post waits its interval, a goal
 * judges one change at a time, no session runs past the goal count, no step fails, and every invariant holds.
 */
const minute = 60_000, hour = 60 * minute, start = Date.parse('2026-10-13T00:00:00Z'), step = 2 * minute;
const config = (): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:1', credentialFile: '/nonexistent/gy-1806-soak.token', cliPath: 'bin/graphyard.mjs',
  repository: 'owner/case-change', baseBranch: 'main', githubAppId: 15368, hostId: 'soak-host', masterAgentName: 'graphyard-master-soak', workers: [], run: { intervalSeconds: 120 } });

let counter = 0;
const change = (work: string, requestedAt: number): CaseChange => ({ id: `change-${++counter}`, work, cases: [`case-${counter}`], reason: 'the save entries read variable -> path', requestedBy: 'implementer', requestedAt: new Date(requestedAt).toISOString(), state: 'requested', judgedBy: null, judgedAt: null, judgement: null });
const goal = (key: string, stage: string, ...caseChanges: CaseChange[]) => ({ id: `id-${key}`, key, statement: `statement of ${key}`, stage, revision: 1, caseChanges, acceptance: null } as unknown as Goal);

function runner(answer: (prompt: string) => unknown, live: { now: number; peak: number }): Runner {
  return { name: 'stub', start<T>(prompt: string, options: RunOptions<T>) {
    live.now++; live.peak = Math.max(live.peak, live.now);
    let result: RunResult<T>;
    try { const parsed = options.validate(answer(prompt)); result = { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] }; }
    catch (error) { result = { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
    return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => { live.now--; return result; } };
  } };
}

test('unit:soak-case-change-judgement — a simulated day of the real loop: every requested case change, of an open, a planning and a delivered goal, is judged once and posted once, failed runs and posts wait their interval, one change per goal at a time, no step fails', { timeout: 120_000 }, async () => {
  clearDrafts(); clearCaseChangeJudgements();
  const live = { now: 0, peak: 0 };
  const open = goal('GOAL-1', 'planning', change('GY-1800', start), change('GY-1801', start + 30 * minute));
  const delivered = goal('GOAL-2', 'delivered', change('GY-1810', start + hour));
  const silent = goal('GOAL-3', 'acceptance-drafting', change('GY-1820', start + 2 * hour));
  const idle = goal('GOAL-4', 'delivered');
  const goals = [open, delivered, silent, idle];
  let now = start;
  const prompts: { at: number; goal: string; item: string }[] = [], posts: { at: number; change: string; ok: boolean }[] = [];
  let postFailed = false;
  const acceptance = { settings: { ...diagnosticianSettings({}), enabled: true }, cwd: '/nowhere', goals: async () => goals.map(entry => structuredClone(entry)),
    runner: async () => ({ runner: runner(prompt => {
      const target = /goal "(GOAL-\d)"/.exec(prompt)![1], item = /did not implement (GY-\d+)/.exec(prompt)![1];
      prompts.push({ at: now, goal: target, item });
      // GOAL-3's change is answered with the wrong goal for the first two attempts (each a primary and a fallback run), then correctly.
      if (target === 'GOAL-3' && prompts.filter(entry => entry.goal === 'GOAL-3').length <= 4) return { goal: 'GOAL-9', verdict: 'approve', reason: 'wrong goal' };
      return { goal: target, verdict: 'approve', reason: `only the save entries of ${item} moved` };
    }, live), runtime: 'stub', model: 'primary' }),
    judgeCaseChange: async (target: Goal, entry: CaseChange) => {
      // The first post of the day is refused once; the verdict is posted again, never judged again.
      const ok = postFailed || target.key !== 'GOAL-1';
      if (!postFailed && target.key === 'GOAL-1') postFailed = true;
      posts.push({ at: now, change: entry.id, ok });
      if (!ok) throw new Error('Graphyard refused goals/GOAL-1/case-change-approve (503)');
      const held = goals.find(candidate => candidate.key === target.key)!;
      held.caseChanges.find(candidate => candidate.id === entry.id)!.state = 'approved';
      return held;
    } } as unknown as AcceptanceEffects;
  const effects = {
    agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [], now: new Date(now).toISOString() }),
    closeSession: () => {}, dispatch: async () => {}, persist: async () => {},
    observeDeployment: async () => ({ source: 'endpoint', sha: 'ba607f8a809ed20fea15387e1934425cacbfef9f', at: new Date(now).toISOString(), reason: null, deployed: [], pending: [] }),
    recordDeployment: async () => {}, acceptance,
  } as unknown as DaemonEffects;
  const state = emptyDaemonState(config());
  const violations: string[] = [];
  for (let cycle = 0; now < start + 24 * hour; cycle++, now += step) {
    // A change is requested late in the day on the delivered goal: it is judged too.
    if (now === start + 10 * hour) delivered.caseChanges.push(change('GY-1830', now));
    await runCycle(config(), state, effects, () => now);
    await caseChangeJudgementsSettled();
    for (const check of state.invariants.report) if (!check.holds) violations.push(`cycle ${cycle}: ${check.invariant} — ${check.reading}`);
    assert.deepEqual(Object.keys(state.actions).filter(key => key.startsWith('isolated:')), [], `cycle ${cycle}: a failure reached an isolation record`);
    assert.ok(live.peak <= 5, `cycle ${cycle}: ${live.peak} judgement sessions at once for five changes`);
  }
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  for (const entry of goals) assert.deepEqual(entry.caseChanges.filter(candidate => candidate.state === 'requested'), [], `${entry.key}: every requested change was judged`);
  const okPosts = posts.filter(entry => entry.ok).map(entry => entry.change);
  assert.equal(okPosts.length, 5, 'five changes, five accepted verdicts');
  assert.equal(new Set(okPosts).size, 5, 'no change was posted twice');
  // The refused post was repeated after its interval with the same verdict: only GOAL-3 took more than one run.
  const failed = posts.find(entry => !entry.ok)!, retried = posts.find(entry => entry.change === failed.change && entry.ok)!;
  assert.ok(retried.at > failed.at, 'a refused post is repeated on a later cycle');
  const runsOf = (target: string, item?: string) => prompts.filter(entry => entry.goal === target && (!item || entry.item === item));
  assert.equal(runsOf('GOAL-1').length, 2, 'one run per change; the refused post reused its verdict');
  assert.equal(runsOf('GOAL-2').length, 2, 'the delivered goal\'s two changes were judged, one run each');
  const silentRuns = runsOf('GOAL-3');
  assert.equal(silentRuns.length, 5, 'two wrong-goal attempts of two runs each, then a judgement');
  assert.ok(silentRuns[2].at > silentRuns[0].at && silentRuns[4].at > silentRuns[2].at, 'an attempt that returned no judgement is repeated on a later cycle');
  assert.equal(runsOf('GOAL-4').length, 0, 'a goal with no requested change launches nothing');
});

test('unit:case-change-goals-include-delivered — the loop reads every goal, a delivered one included, so its requested case change reaches the approver', async () => {
  const paths: string[] = [];
  const effects = acceptanceEffects(config(), '/nowhere', { asCoordinator: async (path: string) => { paths.push(path); return { goals: [] }; } } as never);
  await effects.goals();
  assert.deepEqual(paths, ['goals'], 'goals?open=1 would drop the delivered goals that still protect cases');
});
