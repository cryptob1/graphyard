import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { backlogCounts, machineKind, overdueTriage, triageDeadlineMs, untriaged, type TriageJudgement } from '../src/model/machine-backlog.js';
import { clearTriageRuns, triageRetryMs, triageSettled, triageStep, triageTool, untriagedAttention } from '../src/triage.js';
import { researchSettings } from '../src/research.js';
import { neededDecision, routineDecision } from '../src/daemon/decisions.js';
import { decisionInputs, decisionPrecondition } from '../src/model/approval.js';
import { graphyardTools } from '../integrations/pi/index.js';
import type { Run, RunEvent, RunOptions, RunResult, Runner } from '../src/runner/types.js';

// GY-402: nothing judged the loop's own backlog items — 170 review follow-ups and the recurring
// fault items sat unreleased for good. Each is now triaged within a day by a triage session, a
// closure only once an approver agrees, and one still untriaged past the day is raised as attention.

const NOW = Date.parse('2026-09-26T12:00:00Z');
const hours = (count: number) => new Date(NOW - count * 3_600_000).toISOString();
function item(key: string, title: string, createdAt: string, overrides: Partial<Work> = {}): Work {
  return { id: `id-${key}`, key, title, description: '1. Finding with no thread: src/a.ts — the retry is unbounded', type: 'chore', priority: 2, dependencies: [], plannedFiles: [], criteria: [{ id: 'AC-1', text: 'Addressed', proofs: ['manual:review-followups-triaged'] }],
    policy: { checks: ['test'], review: true }, stage: 'backlog', ready: false, revision: 1, policyRevision: 1, createdAt, updatedAt: createdAt, stageEnteredAt: createdAt, epoch: 0, lease: null, workspaces: [],
    candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [], ...overrides } as unknown as Work;
}
const stale = item('GY-396', 'Follow-ups from the approved review of GY-259 (PR #217)', hours(30));
const fresh = item('GY-401', 'Follow-ups from the approved review of GY-259 (PR #217)', hours(2), { origin: { reviewFollowUps: { parent: 'GY-259', findings: [{ path: 'src/a.ts', text: 'src/a.ts — the retry is unbounded' }] } } });
const fault = item('GY-373', 'Recurring action:dispatch faults: 4 in 24 hours', hours(48), { type: 'bug' });
const operator = item('GY-410', 'An operator item', hours(72), { description: '' });
const delivered = item('GY-300', 'The fix', hours(90), { stage: 'done' });

test('unit:machine-backlog-triaged — an untriaged follow-up older than 24 hours raises an attention item naming the triage step; one inside the day, a judged one and an operator item raise none', () => {
  const work = [stale, fresh, fault, operator, delivered];
  assert.equal(triageDeadlineMs, 24 * 3_600_000);
  assert.deepEqual(work.map(machineKind), ['review-follow-up', 'review-follow-up', 'recurring-fault', null, null]);
  const attention = untriagedAttention({ work, now: new Date(NOW).toISOString() });
  assert.deepEqual(attention.map(entry => entry.subject), ['GY-373', 'GY-396'], 'the fault item and the stale follow-up, oldest first');
  const followUp = attention.find(entry => entry.subject === 'GY-396')!;
  assert.match(followUp.text, /GY-396 is a machine-filed review follow-up item untriaged for 30h, past the 24h bound: the triage step has not judged it/);
  assert.match(followUp.text, /release with a priority, close with a reason, or merge into another item/);
  assert.equal(followUp.role, 'master');
  assert.equal(followUp.human, false, 'no human is asked: the triage step is an agent role');
  assert.match(followUp.next, /triage step judges GY-396/);
  // Judged items leave triage; a refused closure is judged again, its clock restarting at the refusal.
  const released = { ...stale, ready: true, stage: 'ready', triage: { judgement: { outcome: 'release', priority: 1, reason: 'real' }, state: 'applied', by: 'master', at: hours(1) } } as Work;
  const proposed = { ...stale, triage: { judgement: { outcome: 'close', reason: 'noise' }, state: 'proposed', by: 'master', at: hours(1) } } as Work;
  const refused = { ...stale, triage: { judgement: { outcome: 'close', reason: 'noise' }, state: 'refused', by: 'master', at: hours(25) } } as Work;
  assert.equal(untriaged(released), false);
  assert.equal(untriaged(proposed), false);
  assert.equal(untriaged(refused), true);
  assert.deepEqual(overdueTriage([released, proposed, refused], NOW).map(entry => entry.key), ['GY-396']);
  assert.equal(untriagedAttention({ work: [released, proposed], now: new Date(NOW).toISOString() }).length, 0);
  // master status and the dashboard count them apart from the operator's own backlog.
  assert.deepEqual(backlogCounts(work, NOW), { operator: 1, machineUntriaged: 3, machineProposed: 0, overdue: 2 });
});

/** A runner that answers each start with `answer`, recording what it was asked. */
function fakeRunner(answer: (work: string) => TriageJudgement | null) {
  const starts: { prompt: string; options: RunOptions<unknown> }[] = [];
  const runner: Runner = {
    name: 'pi',
    start<T>(prompt: string, options: RunOptions<T>): Run<T> {
      starts.push({ prompt, options: options as RunOptions<unknown> });
      const key = /triage agent for owner\/project\. The master loop filed (GY-\d+)/.exec(prompt)![1]!;
      const judgement = answer(key);
      const result: RunResult<T> = judgement ? { ok: true, tool: triageTool, payload: options.validate(judgement), payloads: [] } : { ok: false, failure: { reason: 'timeout', detail: 'no answer' }, payloads: [] };
      const events: RunEvent[] = [];
      return { id: key, events, onEvent: () => () => {}, cancel: () => {}, result: () => Promise.resolve(result) };
    },
  };
  return { runner, starts };
}

test('unit:machine-backlog-triaged — the triage step judges each machine-filed item awaiting triage through the typed triage tool, and a proposed closure becomes a close decision for the approver', async t => {
  t.after(clearTriageRuns);
  const work = [stale, fresh, fault, operator, delivered];
  const recorded: { key: string; judgement: TriageJudgement }[] = [];
  const { runner, starts } = fakeRunner(key => key === 'GY-396' ? { outcome: 'close', ref: 'GY-300', reason: 'GY-300 bounded the retry' } : { outcome: 'release', priority: 1, reason: 'Recurring dispatch faults are real work' });
  const actions = triageStep({ work, clock: NOW, settings: researchSettings({ research: {} }), config: { repository: 'owner/project' }, cwd: process.cwd(), runner, record: async (item, body) => { recorded.push({ key: item.key, judgement: body.judgement }); } });
  // Oldest first, bounded concurrency; the operator's own item is never triaged.
  assert.deepEqual(actions.map(action => action.work), ['GY-373', 'GY-396']);
  assert.equal(starts[0]!.options.tool, triageTool);
  assert.equal(starts[0]!.options.env?.GRAPHYARD_PI_ROLE, 'triage');
  assert.match(starts[1]!.prompt, /release it with a priority .*close it with a reason, naming as ref the delivered item that already fixed it.*merge it into another open item/);
  assert.match(starts[1]!.prompt, /GY-300 The fix/, 'the delivered items it may name are listed');
  await triageSettled();
  assert.deepEqual(recorded.map(entry => [entry.key, entry.judgement.outcome]), [['GY-373', 'release'], ['GY-396', 'close']]);
  // The Pi extension registers only the triage tool for the triage role, and checks the priority bound.
  const [tool] = graphyardTools('triage');
  assert.equal(tool!.name, triageTool);
  await assert.rejects(tool!.execute('call', { outcome: 'release', priority: 9, reason: 'x' } as never), /at most 4/);

  // A proposed closure is the close decision the loop requests, which only an approver applies.
  const at = hours(1);
  const proposed = { ...stale, triage: { judgement: { outcome: 'close', ref: 'GY-300', reason: 'GY-300 bounded the retry' }, state: 'proposed', by: 'master', at } } as Work;
  const decision = routineDecision(proposed, { autoMerge: true }, NOW);
  assert.deepEqual(decision && { action: decision.action, binding: decision.binding, input: decision.input }, { action: 'close', binding: `triage:${at}`, input: { kind: 'superseded', ref: 'GY-300', reason: 'Already fixed by GY-300: GY-300 bounded the retry', triageAt: at } });
  assert.doesNotThrow(() => decisionInputs.close.parse(decision!.input));
  assert.equal(decisionPrecondition('close', decision!.input, proposed), null);
  assert.match(decisionPrecondition('close', { ...decision!.input, triageAt: hours(2) }, proposed)!, /no proposed triage closure/);
  const merge = { ...stale, triage: { judgement: { outcome: 'merge', into: 'GY-401', reason: 'the same findings' }, state: 'proposed', by: 'master', at } } as Work;
  assert.deepEqual(neededDecision(merge, { autoMerge: true })?.input, { kind: 'duplicate', ref: 'GY-401', reason: 'Merged into GY-401 by triage: the same findings', triageAt: at });
  assert.equal(neededDecision(stale, { autoMerge: true }), null, 'an item awaiting triage needs a judgement, not a decision');
});

test('unit:machine-backlog-triaged — a failed triage run backs off on the loop clock alone, from the first step that sees the failure (GY-431)', async t => {
  t.after(clearTriageRuns);
  const { runner, starts } = fakeRunner(() => null);
  // The loop's clock is years from the wall clock: a back-off stamped with Date.now() would never, or always, retry.
  const base = Date.parse('2031-01-01T00:00:00Z');
  const step = (clock: number) => triageStep({ work: [stale], clock, settings: researchSettings({ research: {} }), config: { repository: 'owner/project' }, cwd: process.cwd(), runner, record: async () => {} });
  assert.deepEqual(step(base).map(action => action.work), ['GY-396']);
  await triageSettled();
  const seen = base + 5 * 60_000;
  assert.deepEqual(step(seen), [], 'the failure is stamped with this step\'s clock');
  assert.deepEqual(step(seen + triageRetryMs - 1), [], 'still backing off');
  assert.deepEqual(step(seen + triageRetryMs).map(action => action.work), ['GY-396'], 'judged again once the back-off has passed on the loop clock');
  assert.equal(starts.length, 2);
});
