import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import type { FaultInstance } from '../src/model/fault-classes.js';
import { backlogCounts, machineKind, overdueTriage, triageDeadlineMs, untriaged, type TriageJudgement } from '../src/model/machine-backlog.js';
import { clearTriageRuns, triageSettled, triageStep, triageTool, untriagedAttention } from '../src/triage.js';
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

test('unit:triage-concurrency-setting — run.research.triageConcurrency sets how many machine-filed items are triaged at once, defaulting to two', async t => {
  t.after(clearTriageRuns);
  const backlog = Array.from({ length: 6 }, (_, index) => item(`GY-5${index}0`, `Follow-ups from the approved review of GY-4${index} (PR #${index})`, hours(30 + index)));
  const release = () => ({ outcome: 'release' as const, priority: 2, reason: 'real work' });
  const step = (research: unknown) => triageStep({ work: backlog, clock: NOW, settings: researchSettings({ research }), config: { repository: 'owner/project' }, cwd: process.cwd(), runner: fakeRunner(release).runner, record: async () => {} });
  assert.equal(researchSettings({ research: {} }).triageConcurrency, 2);
  assert.equal(step({}).length, 2, 'two at once by default');
  await triageSettled(); clearTriageRuns();
  assert.equal(step({ triageConcurrency: 5 }).length, 5, 'the setting raises it');
  await triageSettled();
  assert.throws(() => researchSettings({ research: { triageConcurrency: 0 } }));
});

// GY-1448: an approver refused triage's closure of GY-1447, and every later triage pass proposed the
// same closure with a fresh judgement time, binding a new close decision and another approver session.
const refusedAt = hours(1);
const refusedClosure = (overrides: Partial<Work> = {}) => item('GY-1447', 'Recurring action:dispatch faults: 4 in 24 hours', hours(48), { type: 'bug', updatedAt: refusedAt,
  triage: { judgement: { outcome: 'close', ref: 'GY-1427', reason: 'GY-1427 fixed it' }, state: 'refused', by: 'graphyard', at: refusedAt, decision: 'd-1', refusal: 'GY-1427 fixed only the dispatch half; rescope this item to the rest' }, ...overrides } as Partial<Work>);

test('unit:triage-refused-closure-not-reproposed — the closure an approver refused, proposed again on unchanged evidence, is never recorded, so no close decision is requested across repeated triage passes', async t => {
  t.after(clearTriageRuns);
  const work = refusedClosure();
  const recorded: TriageJudgement[] = [];
  const { runner, starts } = fakeRunner(() => ({ outcome: 'close', ref: 'GY-1427', reason: 'GY-1427 fixed it, again' }));
  const step = (items: Work[], clock = NOW) => triageStep({ work: items, clock, settings: researchSettings({ research: {} }), config: { repository: 'owner/project' }, cwd: process.cwd(), runner, record: async (_, body) => { recorded.push(body.judgement); } });
  assert.equal(neededDecision(work, { autoMerge: true }), null, 'a refused closure needs no decision');
  assert.deepEqual(step([work]).map(action => action.state), ['started']);
  await triageSettled();
  assert.equal(recorded.length, 0, 'the repeated closure is dropped unrecorded, so the item never carries a proposed closure');
  for (const clock of [NOW + 6 * 60_000, NOW + 12 * 60_000, NOW + 3_600_000]) {
    const actions = step([work], clock);
    assert.deepEqual(actions.map(action => action.state), ['held'], 'later passes start no session for it');
    assert.match(actions[0]!.detail, /proposed again the closure \(superseded of GY-1427\) the approver refused .*requests no close decision/);
    await triageSettled();
  }
  assert.equal(starts.length, 1);
  assert.equal(recorded.length, 0);
  assert.equal(neededDecision(work, { autoMerge: true }), null);
  // A merge into the refused ref is the same closure (duplicate of GY-1427) only when the refusal was of a merge.
  const merged = refusedClosure({ triage: { judgement: { outcome: 'merge', into: 'GY-1427', reason: 'same' }, state: 'refused', by: 'graphyard', at: refusedAt, refusal: 'no' } } as Partial<Work>);
  clearTriageRuns(); starts.length = 0;
  const mergeAgain = fakeRunner(() => ({ outcome: 'merge', into: 'GY-1427', reason: 'same again' }));
  triageStep({ work: [merged], clock: NOW, settings: researchSettings({ research: {} }), config: { repository: 'owner/project' }, cwd: process.cwd(), runner: mergeAgain.runner, record: async (_, body) => { recorded.push(body.judgement); } });
  await triageSettled();
  assert.equal(recorded.length, 0);
  // Once the item's evidence changes after the refusal, triage judges it again and a closure it proposes is recorded.
  clearTriageRuns();
  const changed = refusedClosure({ updatedAt: hours(0.5), description: 'Amended: the dispatch half is fixed by GY-1427, and so is the rest' });
  assert.deepEqual(step([changed]).map(action => action.state), ['started']);
  await triageSettled();
  assert.deepEqual(recorded.map(judgement => judgement.outcome), ['close']);
});

test('unit:triage-sees-closure-refusal — triage judging an item whose closure was refused is told the refusal, and its release or a closure on new evidence is recorded', async t => {
  t.after(clearTriageRuns);
  const recorded: TriageJudgement[] = [];
  const run = (answer: TriageJudgement) => {
    clearTriageRuns();
    const { runner, starts } = fakeRunner(() => answer);
    triageStep({ work: [refusedClosure()], clock: NOW, settings: researchSettings({ research: {} }), config: { repository: 'owner/project' }, cwd: process.cwd(), runner, record: async (_, body) => { recorded.push(body.judgement); } });
    return starts;
  };
  const starts = run({ outcome: 'release', priority: 2, reason: 'rescoped to the half GY-1427 left' });
  const prompt = starts[0]!.prompt;
  assert.match(prompt, /No judgement of it stands/);
  assert.match(prompt, /proposed closing it \(superseded of GY-1427\) and the independent approver refused that closure at \S+: "GY-1427 fixed only the dispatch half; rescope this item to the rest"\./);
  assert.match(prompt, /Do not propose that closure \(superseded of GY-1427\) again/);
  assert.match(prompt, /release it with a priority, rescoped to the work it still names, or close or merge it on a different ref the refusal did not weigh/);
  await triageSettled();
  assert.deepEqual(recorded, [{ outcome: 'release', priority: 2, reason: 'rescoped to the half GY-1427 left' }], 'a release follows the refusal');
  run({ outcome: 'close', ref: 'GY-1440', reason: 'GY-1440 fixed the rest, delivered after the refusal' });
  await triageSettled();
  assert.deepEqual(recorded.at(-1), { outcome: 'close', ref: 'GY-1440', reason: 'GY-1440 fixed the rest, delivered after the refusal' }, 'a closure naming new evidence is recorded');
  const proposed = refusedClosure({ triage: { judgement: recorded.at(-1)!, state: 'proposed', by: 'graphyard', at: NOW.toString() } } as Partial<Work>);
  assert.equal(neededDecision(proposed, { autoMerge: true })?.input?.ref, 'GY-1440');
  // A judgement never refused carries no refusal into the prompt.
  clearTriageRuns();
  const fresh = fakeRunner(() => null);
  triageStep({ work: [stale], clock: NOW, settings: researchSettings({ research: {} }), config: { repository: 'owner/project' }, cwd: process.cwd(), runner: fresh.runner, record: async () => {} });
  assert.doesNotMatch(fresh.starts[0]!.prompt, /approver refused/);
  await triageSettled();
});

// GY-1632: triage released machine-filed GY-1628 at P1 and a worker was dispatched to re-implement
// GY-1618, although every instance GY-1628 listed predated GY-1618's landing.
test('unit:triage-pre-landing-instances-close — a recurring-fault item whose instances all predate a delivered same-class item\'s landing is proposed closed as covered by it, with no session run', async t => {
  t.after(clearTriageRuns);
  const origin = (instances: string[]) => ({ faultClass: { class: 'resources', threshold: 3, windowHours: 24, count: instances.length, detectedAt: hours(1), instances: instances.map((at, index) => ({ id: `resource-bound|tmp-inodes|${index}`, kind: 'resource-bound', subject: 'resource:tmp-inodes', at })) } });
  const filed = item('GY-1628', 'Recurring resources faults: 3 in 24 hours', hours(1), { type: 'bug', origin: origin([hours(9), hours(7), hours(4)]) } as Partial<Work>);
  const fix = item('GY-1618', 'Stop the /tmp inode leak', hours(20), { stage: 'done', delivery: { mergedAt: hours(3), mergeSha: 'a'.repeat(40), authorizationRevision: 1 } } as Partial<Work>);
  const answered = item('GY-1610', 'Recurring resources faults: 4 in 24 hours', hours(20), { stage: 'done', origin: origin([hours(19)]), closure: { kind: 'duplicate', ref: 'GY-1618', reason: 'answered', by: 'master', at: hours(18), from: 'backlog' } } as Partial<Work>);
  const recorded: { key: string; judgement: TriageJudgement }[] = [];
  const { runner, starts } = fakeRunner(() => ({ outcome: 'release', priority: 1, reason: 'real work' }));
  const step = (work: Work[], faultInstances: FaultInstance[] = [], linked: Record<string, string> = {}) => triageStep({ work, clock: NOW, settings: researchSettings({ research: {} }), config: { repository: 'owner/project' }, cwd: process.cwd(), runner, record: async (entry, body) => { recorded.push({ key: entry.key, judgement: body.judgement }); }, faults: { instances: faultInstances, linked } });
  const actions = step([filed, fix, answered]);
  await triageSettled();
  assert.equal(starts.length, 0, 'no triage session runs, so nothing can release it to a worker');
  assert.equal(actions[0]!.state, 'done');
  assert.match(actions[0]!.detail, /close machine-filed GY-1628 as covered by delivered GY-1618.*no worker is dispatched/);
  assert.equal(recorded.length, 1);
  const judgement = recorded[0]!.judgement;
  assert.deepEqual([recorded[0]!.key, judgement.outcome, judgement.outcome === 'close' ? judgement.ref : null], ['GY-1628', 'close', 'GY-1618'], 'the closure proposal names the delivered item');
  assert.match(judgement.reason, /Covered by GY-1618.*predates that landing/);
  // The proposal becomes the close decision the approver judges, never a release.
  const proposed = { ...filed, triage: { judgement, state: 'proposed', by: 'master', at: hours(0) } } as Work;
  assert.deepEqual(routineDecision(proposed, { autoMerge: true }, NOW)?.input, { kind: 'superseded', ref: 'GY-1618', reason: `Already fixed by GY-1618: ${judgement.reason}`, triageAt: hours(0) });

  // One instance after the landing: the item is judged by a session as before.
  clearTriageRuns(); recorded.length = 0;
  const recurred = { ...filed, origin: origin([hours(9), hours(2)]) } as Work;
  step([recurred, fix, answered]);
  await triageSettled();
  assert.equal(starts.length, 1);
  assert.deepEqual(recorded.map(entry => entry.judgement.outcome), ['release']);

  // Its origin all predates the landing, but the loop linked a later recurrence to the open item:
  // closing it would suppress that recurrence, so a session judges it instead.
  clearTriageRuns(); recorded.length = 0;
  const instance = (at: string, linkedTo: string | null): FaultInstance => ({ id: `resource-bound|tmp-inodes|${at}`, kind: 'resource-bound', faultClass: 'resources', subject: 'resource:tmp-inodes', text: 'tmp inodes at bound', at, lastSeenAt: at, linkedTo });
  step([filed, fix, answered], [instance(hours(2), 'GY-1628'), instance(hours(1), 'GY-1999')]);
  await triageSettled();
  assert.equal(starts.length, 2, 'a post-landing instance linked to the item keeps it from closing as covered');
  assert.deepEqual(recorded.map(entry => entry.judgement.outcome), ['release']);
  // Linked instances that all predate the landing still close it as covered.
  clearTriageRuns(); recorded.length = 0;
  step([filed, fix, answered], [instance(hours(5), 'GY-1628')]);
  await triageSettled();
  assert.equal(starts.length, 2);
  assert.deepEqual(recorded.map(entry => [entry.key, entry.judgement.outcome]), [['GY-1628', 'close']]);
  // The post-landing instance was pruned from the record past its retention bound: the record's newest
  // linked time for the item still keeps it from closing as covered.
  clearTriageRuns(); recorded.length = 0;
  step([filed, fix, answered], [], { 'GY-1628': hours(2) });
  await triageSettled();
  assert.equal(starts.length, 3, 'a pruned post-landing link still keeps the item from closing as covered');
  assert.deepEqual(recorded.map(entry => entry.judgement.outcome), ['release']);
});

test('unit:triage-overtaken-closure-withdrawn — a covered-by-delivery closure awaiting its approver is withdrawn once a post-landing instance is linked to the item, including after the record prunes it', async t => {
  t.after(clearTriageRuns);
  const origin = { faultClass: { class: 'resources', threshold: 3, windowHours: 24, count: 1, detectedAt: hours(1), instances: [{ id: 'resource-bound|tmp-inodes|0', kind: 'resource-bound', subject: 'resource:tmp-inodes', at: hours(9) }] } };
  const judgement: TriageJudgement = { outcome: 'close', ref: 'GY-1618', reason: 'Covered by GY-1618' };
  const filed = item('GY-1628', 'Recurring resources faults: 3 in 24 hours', hours(1), { type: 'bug', origin, triage: { judgement, state: 'proposed', by: 'master', at: hours(1) } } as Partial<Work>);
  const fix = item('GY-1618', 'Stop the /tmp inode leak', hours(20), { stage: 'done', delivery: { mergedAt: hours(3), mergeSha: 'a'.repeat(40), authorizationRevision: 1 } } as Partial<Work>);
  const withdrawn: { key: string; triageAt: string; reason: string }[] = [];
  const { runner, starts } = fakeRunner(() => ({ outcome: 'release', priority: 1, reason: 'real work' }));
  const step = (instances: FaultInstance[], linked: Record<string, string> = {}) => triageStep({ work: [filed, fix], clock: NOW, settings: researchSettings({ research: {} }), config: { repository: 'owner/project' }, cwd: process.cwd(), runner,
    record: async () => { throw new Error('nothing is recorded'); }, faults: { instances, linked }, withdraw: async (entry, body) => { withdrawn.push({ key: entry.key, ...body }); } });
  const instance = (at: string): FaultInstance => ({ id: `resource-bound|tmp-inodes|${at}`, kind: 'resource-bound', faultClass: 'resources', subject: 'resource:tmp-inodes', text: 'tmp inodes at bound', at, lastSeenAt: at, linkedTo: 'GY-1628' });
  // Only pre-landing instances linked: the proposal stands.
  assert.deepEqual(step([instance(hours(5))], { 'GY-1628': hours(5) }), []);
  await triageSettled();
  assert.equal(withdrawn.length, 0);
  // A post-landing instance linked while the proposal awaits its approver withdraws it.
  const actions = step([instance(hours(2))], { 'GY-1628': hours(2) });
  await triageSettled();
  assert.deepEqual(actions.map(action => action.state), ['withdrawn']);
  assert.deepEqual(withdrawn.map(entry => [entry.key, entry.triageAt]), [['GY-1628', hours(1)]]);
  assert.match(withdrawn[0]!.reason, /first seen at .*after GY-1618 landed.*returns to triage/);
  // The instance pruned past retention: the record's newest linked time still withdraws it.
  step([], { 'GY-1628': hours(2) });
  await triageSettled();
  assert.equal(withdrawn.length, 2);
  assert.equal(starts.length, 0, 'a proposed item is not judged by a session while it awaits its approver');
});
