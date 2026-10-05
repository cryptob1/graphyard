import { test } from 'node:test';
import assert from 'node:assert/strict';
import { overdueTriage, type TriageJudgement } from '../src/model/machine-backlog.js';
import { clearTriageRuns, triageSettled, triageStep, triageTool } from '../src/triage.js';
import { researchSettings } from '../src/research.js';
import type { Work } from '../src/model.js';
import type { Run, RunOptions, RunResult, Runner } from '../src/runner/types.js';

// GY-845 held review follow-ups on their parent until it shipped; GY-1249 retired the filing, so
// no follow-up item is created any more. Follow-up items filed before then are still triaged, and
// one whose parent has not shipped is still not judged until it does.

function releasingRunner() {
  const asked: string[] = [];
  const runner: Runner = {
    name: 'pi',
    start<T>(prompt: string, options: RunOptions<T>): Run<T> {
      const key = /The master loop filed (GY-\d+)/.exec(prompt)![1]!;
      asked.push(key);
      const judgement: TriageJudgement = { outcome: 'release', priority: 2, reason: 'real work' };
      const result: RunResult<T> = { ok: true, tool: triageTool, payload: options.validate(judgement), payloads: [] };
      return { id: key, events: [], onEvent: () => () => {}, cancel: () => {}, result: () => Promise.resolve(result) };
    },
  };
  return { runner, asked };
}

test('unit:triage-skips-unshipped-parent — triage never judges a follow-up whose parent has not shipped, nor raises it as overdue; once the parent ships it is judged', async t => {
  t.after(clearTriageRuns);
  const day = 30 * 3_600_000, now = Date.parse('2026-09-30T12:00:00Z'), old = new Date(now - day).toISOString();
  const base = { type: 'chore', priority: 2, plannedFiles: [], criteria: [], policy: { checks: ['test'], review: true }, ready: false, revision: 1, policyRevision: 1, createdAt: old, updatedAt: old, stageEnteredAt: old, epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], description: '' };
  const item = (key: string, title: string, overrides: Partial<Work> = {}) => ({ ...base, id: `id-${key}`, key, title, stage: 'backlog', dependencies: [], ...overrides }) as unknown as Work;
  const review = item('GY-900', 'Still in review', { stage: 'review' });
  const landed = item('GY-901', 'Landed', { stage: 'done', closure: null });
  const waiting = item('GY-910', 'Follow-ups from the approved review of GY-900 (PR #9)', { origin: { reviewFollowUps: { parent: 'GY-900', findings: [{ path: 'src/a.ts', text: 'src/a.ts — waits' }] } }, dependencies: ['id-GY-900'] });
  const due = item('GY-911', 'Follow-ups from the approved review of GY-901 (PR #9)', { origin: { reviewFollowUps: { parent: 'GY-901', findings: [{ path: 'src/b.ts', text: 'src/b.ts — due' }] } } });
  const work = [review, landed, waiting, due];
  const recorded: string[] = [];
  const { runner, asked } = releasingRunner();
  const actions = triageStep({ work, clock: now, settings: researchSettings({ research: {} }), config: { repository: 'owner/project' }, cwd: process.cwd(), runner, record: async entry => { recorded.push(entry.key); } });
  await triageSettled();
  assert.deepEqual(actions.map(action => action.work), ['GY-911']);
  assert.deepEqual(asked, ['GY-911'], 'no triage session is started for the follow-up of the unshipped parent');
  assert.deepEqual(recorded, ['GY-911']);
  assert.deepEqual(overdueTriage(work, now).map(entry => entry.key), ['GY-911'], 'a follow-up waiting on its parent is not overdue');
  clearTriageRuns();
  // Once the parent ships, its follow-up is judged like any other.
  const shippedWork = [{ ...review, stage: 'done', closure: null } as Work, landed, waiting];
  const later = triageStep({ work: shippedWork, clock: now, settings: researchSettings({ research: {} }), config: { repository: 'owner/project' }, cwd: process.cwd(), runner, record: async () => {} });
  await triageSettled();
  assert.deepEqual(later.map(action => action.work), ['GY-910']);
});
