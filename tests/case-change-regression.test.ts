import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { emptyDaemonState, runCycle, type DaemonEffects } from '../src/master-daemon.js';
import { masterConfigSchema } from '../src/master.js';
import { clearDrafts, type AcceptanceEffects } from '../src/daemon/acceptance.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import type { Goal } from '../src/model/goal.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';

// GY-1806 regression: GY-1800 blocked three times (seq 2590616, 2591382, 2591855) because its requested case change on
// GOAL-1 (candidate-batches-five) reached no approver: the real loop never launched a judgement, so the implementer
// waited on a human. This file imports only code that exists on the base, so it runs there and observes that failure.
const minute = 60_000, start = Date.parse('2026-10-14T15:13:00Z');
const config = () => masterConfigSchema.parse({ version: 1, url: 'http://127.0.0.1:1', credentialFile: '/nonexistent/gy-1806-regression.token', cliPath: 'bin/graphyard.mjs',
  repository: 'owner/case-change', baseBranch: 'main', githubAppId: 15368, hostId: 'regression-host', masterAgentName: 'graphyard-master-regression', workers: [], run: { intervalSeconds: 120 } });
const requested = { id: 'change-gy-1800', work: 'GY-1800', cases: ['candidate-batches-five'], reason: 'the save entries read variable -> path', requestedBy: 'implementer', requestedAt: '2026-10-14T15:12:00Z', state: 'requested', judgedBy: null, judgedAt: null, judgement: null };

test('unit:gy-1800-case-change-reaches-approver — the real loop gives GY-1800\'s requested case change to an approver run and posts the verdict, with no human step', { timeout: 60_000 }, async () => {
  clearDrafts();
  const goal = { id: 'id-GOAL-1', key: 'GOAL-1', statement: 'Candidates are small', stage: 'planning', revision: 1, caseChanges: [structuredClone(requested)], acceptance: null } as unknown as Goal;
  const prompts: string[] = [], posted: string[] = [];
  const runner: Runner = { name: 'stub', start<T>(prompt: string, options: RunOptions<T>) {
    prompts.push(prompt);
    const parsed = options.validate({ goal: 'GOAL-1', verdict: 'approve', reason: 'only the save entries moved' });
    const result: RunResult<T> = { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] };
    return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
  } };
  const acceptance = { settings: { ...diagnosticianSettings({}), enabled: true }, cwd: '/nowhere', goals: async () => [structuredClone(goal)],
    runner: async () => ({ runner, runtime: 'stub', model: 'primary' }),
    judgeCaseChange: async (target: Goal, entry: { id: string }) => { posted.push(entry.id); goal.caseChanges[0].state = 'approved'; return goal; } } as unknown as AcceptanceEffects;
  let now = start;
  const effects = { agents: () => [], herdr: () => ({ agents: [], available: true }), credentials: async () => ({}),
    snapshot: async () => ({ work: [], now: new Date(now).toISOString() }),
    closeSession: () => {}, dispatch: async () => {}, persist: async () => {},
    observeDeployment: async () => ({ source: 'endpoint', sha: 'ba607f8a809ed20fea15387e1934425cacbfef9f', at: new Date(now).toISOString(), reason: null, deployed: [], pending: [] }),
    recordDeployment: async () => {}, acceptance } as unknown as DaemonEffects;
  const state = emptyDaemonState(config());
  for (let cycle = 0; cycle < 60 && !posted.length; cycle++, now += 2 * minute) {
    await runCycle(config(), state, effects, () => now);
    for (let tick = 0; tick < 20; tick++) await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(prompts.length > 0, 'no approver run was launched for GY-1800\'s requested case change: it waits on a human');
  assert.deepEqual(posted, [requested.id], 'the approver\'s verdict on the change is posted by the loop');
});
