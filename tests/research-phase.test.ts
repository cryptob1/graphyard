import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Work } from '../src/model.js';
import { createSchema } from '../src/model/work.js';
import { applyResearchAnswer, applyResearchEvent, clearResearchRuns, currentResearch, requirementsRevision, researchBriefSchema, researchHold, researchHoldGraceMs, researchRework,
  researchSettings, researchSettled, researchStep, researchTool, type ResearchBrief, type ResearchEvent, type ResearchSettings } from '../src/research.js';
import type { Run, RunEvent, RunOptions, RunResult, Runner } from '../src/runner/types.js';
import { neededDecision } from '../src/daemon/decisions.js';
import { masterRunSchema, workerPrompt } from '../src/master.js';
import { reviewPrompt } from '../src/reviewer.js';
import { graphyardTools } from '../integrations/pi/index.js';
import HumanRequestsPage, { researchQuestionRows } from '../web/pages/human-requests.js';

// GY-259: research before build. A cheap Pi session, started by the loop through the GY-169
// runner, records a brief on the item as a typed tool result; its product questions go to the
// operator in Graphyard; the worker and reviewer start from the brief; and nothing about it ever
// holds the item past its bound. The runner here is a fake: it records what it was started with
// and resolves the way the scenario says a Pi run would.

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const brief: ResearchBrief = {
  existingCode: [{ path: 'src/runner/pi.ts', note: 'the GY-169 headless runner to start the session through' }],
  patterns: [{ pattern: 'Design doc before implementation (RFC process)', source: 'https://github.com/rust-lang/rfcs' }],
  risks: ['a research run that never ends must not hold dispatch'],
  approach: 'Add a loop step before dispatch that records the brief through a coordinator route.',
  questions: [{ question: 'Should the brief be shown on the item page?', why: 'Operators decide from the page.', recommendation: 'Yes, collapsed under the criteria' }],
};

function item(overrides: Partial<Work> = {}): Work {
  return {
    id: overrides.id ?? '11111111-1111-4111-8111-111111111111', key: 'GY-1', title: 'Research phase', description: 'Research before build', type: 'feature', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'A research step runs before build.', proofs: ['unit:research-brief-recorded'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/research.ts'], stage: 'ready', revision: 3, policyRevision: 1,
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), stageEnteredAt: new Date(NOW).toISOString(), ready: true,
    epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
    ...overrides,
  } as Work;
}

/** A Pi stand-in: records every start and settles as its scenario says, emitting the events it is given. */
function fakeRunner(scenario: (prompt: string, options: RunOptions<unknown>) => RunResult<unknown> | Promise<RunResult<unknown>> | 'never', events: RunEvent[] = []) {
  const starts: { prompt: string; options: RunOptions<unknown> }[] = [];
  const runner: Runner = {
    name: 'pi',
    start<T>(prompt: string, options: RunOptions<T>): Run<T> {
      starts.push({ prompt, options: options as RunOptions<unknown> });
      const listeners = new Set<(event: RunEvent) => void>(), seen: RunEvent[] = [];
      let resolve!: (result: RunResult<T>) => void, done = false;
      const result = new Promise<RunResult<T>>(settle => { resolve = settle; });
      const finish = (outcome: RunResult<T>) => { if (!done) { done = true; resolve(outcome); } };
      const run: Run<T> = {
        id: `run-${starts.length}`, events: seen,
        onEvent(listener) { for (const event of seen) listener(event); listeners.add(listener); return () => { listeners.delete(listener); }; },
        cancel(reason = 'cancelled') { finish({ ok: false, failure: { reason: 'cancelled', detail: reason }, payloads: [] }); },
        result: () => result,
      };
      queueMicrotask(async () => {
        for (const event of events) { seen.push(event); for (const listener of listeners) listener(event); }
        const outcome = scenario(prompt, options as RunOptions<unknown>);
        if (outcome === 'never') return;
        const settled = await outcome;
        // The runner's validation is the control plane's own check of the tool payload.
        if (settled.ok) { try { finish({ ...settled, payload: options.validate(settled.payload), payloads: settled.payloads.map(options.validate) } as RunResult<T>); } catch (error) { finish({ ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }); } }
        else finish(settled as RunResult<T>);
      });
      return run;
    },
  };
  return { runner, starts };
}
const submitted = (payload: unknown): RunResult<unknown> => ({ ok: true, tool: researchTool, payload, payloads: [payload] });

/** The control plane as the step sees it: each event applied to the stored item by the server's own transition. */
function plane(items: Work[], clock = () => NOW) {
  const events: { key: string; event: ResearchEvent }[] = [];
  const record = async (work: Work, event: ResearchEvent) => {
    const stored = items.find(entry => entry.id === work.id)!;
    events.push({ key: work.key, event });
    applyResearchEvent(stored, event, 'graphyard-master', new Date(clock()));
    return stored;
  };
  return { events, record };
}
const settings = (overrides: Partial<ResearchSettings> = {}): ResearchSettings => ({ ...researchSettings({}), ...overrides });
const step = (items: Work[], runner: Runner, record: (work: Work, event: ResearchEvent) => Promise<unknown>, clock = NOW, configured = settings()) =>
  researchStep({ items, clock, settings: configured, config: { repository: 'owner/project' }, cwd: process.cwd(), runner, record });

test('unit:research-brief-recorded — the loop researches a feature on the configured cheap model through the runner and stores the brief with every section; bug and chore items skip it unless opted in', async t => {
  t.after(clearResearchRuns);
  // The research model is a master.json setting whose default is the Z.AI GLM flash account.
  assert.equal(masterRunSchema.parse({}).research, undefined);
  const defaults = researchSettings(masterRunSchema.parse({ research: {} }));
  assert.equal(defaults.model, 'zai/glm-5.3-flash');
  assert.equal(defaults.timeoutMinutes, 15);
  assert.equal(researchSettings(masterRunSchema.parse({ pi: { command: 'pi-zai' }, research: { model: 'zai/glm-4.5-air' } })).command, 'pi-zai', 'the research account defaults to the Pi wrapper run.pi names');
  assert.throws(() => masterRunSchema.parse({ research: { timeoutMinutes: 0 } }), 'the time limit is bounded');

  const feature = item(), bug = item({ id: '22222222-2222-4222-8222-222222222222', key: 'GY-2', type: 'bug' }), chore = item({ id: '33333333-3333-4333-8333-333333333333', key: 'GY-3', type: 'chore' });
  const optedIn = item({ id: '44444444-4444-4444-8444-444444444444', key: 'GY-4', type: 'bug', research: true });
  const optedOut = item({ id: '55555555-5555-4555-8555-555555555555', key: 'GY-5', research: false });
  const items = [feature, bug, chore, optedIn, optedOut];
  const { runner, starts } = fakeRunner(() => submitted(brief));
  const { events, record } = plane(items);
  const first = await step(items, runner, record);
  assert.deepEqual([...first.held].sort(), [feature.id, optedIn.id].sort(), 'dispatch waits on exactly the items being researched');
  assert.deepEqual(starts.length, 2, 'one session each for the feature and the opted-in bug; the plain bug, the chore and the opted-out feature are not researched');
  assert.equal(starts[0].options.tool, researchTool, 'the submission is the typed research tool');
  assert.equal(starts[0].options.env?.GRAPHYARD_PI_ROLE, 'research', 'the Pi extension registers only the research tool for it');
  assert.equal(starts[0].options.timeoutMs, 15 * 60_000);
  assert.match(starts[0].prompt, /read-only and nobody reads it/);
  assert.match(starts[0].prompt, /A research step runs before build/, 'the session is given the criteria it researches');
  assert.deepEqual(events.filter(entry => entry.key === 'GY-1').map(entry => entry.event.event), ['started'], 'the run is recorded as started before it launches');
  assert.equal(researchHold(feature, NOW), true, 'while it runs within its bound, dispatch holds the item');

  await researchSettled();
  assert.deepEqual(events.filter(entry => entry.key === 'GY-1').map(entry => entry.event.event), ['started', 'recorded']);
  const stored = currentResearch(feature)!;
  assert.equal(stored.state, 'recorded');
  assert.equal(stored.model, 'zai/glm-5.3-flash');
  assert.equal(stored.revision, requirementsRevision(feature));
  assert.deepEqual(stored.brief, { existingCode: brief.existingCode, patterns: brief.patterns, risks: brief.risks, approach: brief.approach }, 'existing code, prior art with sources, risks and the approach are stored');
  assert.equal(stored.questions.length, 1, 'and the product questions');
  for (const skipped of [bug, chore, optedOut]) assert.equal(skipped.researchBrief, undefined, `${skipped.key} (${skipped.type}${skipped.research === false ? ', opted out' : ''}) is not researched`);
  assert.equal(researchHold(feature, NOW), false, 'a recorded brief holds nothing');

  // One run per requirements revision: the next cycle starts nothing, and a changed criterion starts one.
  const again = await step(items, runner, record);
  assert.equal(starts.length, 2);
  assert.equal(again.held.size, 0);
  assert.throws(() => applyResearchEvent(feature, { event: 'started', revision: requirementsRevision(feature), runtime: 'pi', model: 'm', timeoutMs: 1000, tokenBudget: 1000 }, 'x', new Date(NOW)), /one run per revision/);
  feature.criteria = [...feature.criteria, { id: 'AC-2', text: 'Questions go to Graphyard.', proofs: ['unit:product-questions-in-graphyard'] }];
  await step([feature], runner, record);
  assert.equal(starts.length, 3, 'new requirements are researched afresh');
  await researchSettled();

  // The brief is a typed tool result: the Pi extension's tool, and the control plane's re-validation.
  const tools = graphyardTools('research');
  assert.deepEqual(tools.map(tool => tool.name), [researchTool]);
  assert.deepEqual((await tools[0].execute('call-1', brief)).details, brief);
  await assert.rejects(tools[0].execute('call-2', { ...brief, approach: undefined }), /input\.approach is required/);
  assert.equal(researchBriefSchema.safeParse({ ...brief, risks: 'none' }).success, false);
  assert.deepEqual(graphyardTools(undefined).map(tool => tool.name), ['graphyard_decide', 'graphyard_submit_evidence'], 'the other roles are unchanged');
  assert.equal(createSchema.parse({ title: 't', type: 'chore', research: true, criteria: [{ id: 'AC-1', text: 'x', proofs: ['unit:x'] }] }).research, true, 'the intent opts an item in');
});

test('unit:product-questions-in-graphyard — each product question is a goals-and-priorities request under Needs you with a recommendation and a deadline; build is not held, and a differing late answer requests rework', async t => {
  t.after(clearResearchRuns);
  const feature = item();
  const { runner } = fakeRunner(() => submitted(brief));
  const { record } = plane([feature]);
  await step([feature], runner, record);
  await researchSettled();
  const [question] = currentResearch(feature)!.questions;
  assert.equal(question.kind, 'goals-and-priorities');
  assert.equal(question.question, brief.questions[0].question);
  assert.equal(question.why, brief.questions[0].why);
  assert.equal(question.recommendation, 'Yes, collapsed under the criteria');
  assert.equal(Date.parse(question.deadline) - Date.parse(question.at), 4 * 3_600_000, 'the deadline defaults to four hours');
  assert.equal(question.answer, null);

  // Build is not held: the item is dispatchable on the very next cycle, on the recommendation.
  const next = await step([feature], runner, record);
  assert.equal(next.held.size, 0);
  assert.equal(researchHold(feature, NOW), false);
  const launch = workerPrompt({ cliPath: '/repo/bin/graphyard.mjs' }, feature, { principal: 'worker-1' }, 1);
  assert.match(launch, /Should the brief be shown on the item page\? — provisional \(the operator has not answered; deadline [^)]+\): Yes, collapsed under the criteria/, 'the worker builds on the recommendation, marked provisional');

  // Under Needs you: the question, why, the recommendation and the deadline, answered in Graphyard.
  const rows = researchQuestionRows([feature], NOW + 60_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision, 'goals and priorities');
  assert.equal(rows[0].request.needed, question.question);
  assert.match(rows[0].request.reason, /Recommended: Yes, collapsed under the criteria/);
  assert.match(rows[0].request.reason, new RegExp(question.deadline.replace(/[.]/g, '\\.')));
  assert.deepEqual(rows[0].answer.post, { command: 'research-answer', body: { question: question.id }, field: 'answer', submit: 'Answer for GY-1', decline: null });
  const page = (actor: object) => renderToStaticMarkup(createElement(HumanRequestsPage, { work: [feature], status: { humanOnly: [], actor }, observedAt: NOW, action: async () => {}, busy: false, setSelected: () => {} } as never));
  const operator = page({ id: 'operator', role: 'admin', sessionKind: 'human' });
  assert.match(operator, /Needs you <span[^>]*>1<\/span>/);
  assert.match(operator, /Should the brief be shown on the item page\?/);
  assert.match(operator, /Answer for GY-1/, 'the operator answers it on the page');
  assert.match(page({ id: 'master', role: 'coordinator' }), /This session cannot answer it: Only the human operator answers a human-only request/, 'an agent identity is refused, never asked in chat');

  // An agreeing answer changes nothing; answering before the item is built changes nothing either.
  const agreed = applyResearchAnswer(structuredClone(feature), { question: question.id, answer: 'As recommended' }, 'operator', new Date(NOW));
  assert.equal(agreed.answer!.differs, false);
  const early = structuredClone(feature);
  applyResearchAnswer(early, { question: question.id, answer: 'No, keep it off the page' }, 'operator', new Date(NOW));
  Object.assign(early, { epoch: 1, submission: { epoch: 1, pr: 7 }, candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 7, branch: 'b', author: 'w' } });
  assert.equal(researchRework(early), null, 'a head launched after the answer carried it in its brief');
  assert.throws(() => applyResearchAnswer(early, { question: question.id, answer: 'again' }, 'operator', new Date(NOW)), /already answered/);

  // A differing answer after the head was built on the recommendation: added to the brief, and a rework decision.
  Object.assign(feature, { epoch: 1, lease: null, submission: { epoch: 1, pr: 7 }, stage: 'review',
    candidate: { sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), pr: 7, branch: 'graphyard/gy-1-1', author: 'worker-1' } });
  const late = applyResearchAnswer(feature, { question: question.id, answer: 'No, keep it off the page' }, 'operator', new Date(NOW + 5 * 3_600_000));
  assert.deepEqual({ differs: late.answer!.differs, inFlight: late.answer!.inFlight, epoch: late.answer!.epoch }, { differs: true, inFlight: true, epoch: 1 });
  assert.equal(currentResearch(feature)!.questions[0].answer!.text, 'No, keep it off the page', 'the answer is added to the brief');
  assert.deepEqual(researchQuestionRows([feature], NOW), [], 'an answered question leaves Needs you');
  const rework = neededDecision(feature, { autoMerge: true });
  assert.equal(rework?.action, 'rework');
  assert.match(rework!.reason, /answered "No, keep it off the page", not the provisional "Yes, collapsed under the criteria"/);
  assert.equal(rework!.binding, `${'a'.repeat(40)}:research:${question.id.slice(0, 8)}`);
  feature.reworkRequested = true;
  assert.equal(researchRework(feature), null, 'once requested, the round is the worker\'s');
  Object.assign(feature, { reworkRequested: false, epoch: 2, submission: { epoch: 2, pr: 7 }, candidate: { ...feature.candidate!, sha: 'c'.repeat(40) } });
  assert.equal(researchRework(feature), null, 'the next attempt built on the answer, so it is not sent back again');
});

test('unit:worker-and-reviewer-get-brief — the worker\'s launch request and the reviewer\'s prompt both carry the brief and the product decisions', async t => {
  t.after(clearResearchRuns);
  const feature = item();
  const { runner } = fakeRunner(() => submitted(brief));
  const { record } = plane([feature]);
  await step([feature], runner, record);
  await researchSettled();
  const worker = workerPrompt({ cliPath: '/repo/bin/graphyard.mjs' }, feature, { principal: 'worker-1' }, 1);
  assert.match(worker, /Start from the research brief a research session recorded for GY-1 \(the whole brief is researchBrief in node \/repo\/bin\/graphyard\.mjs status GY-1\)/);
  assert.match(worker, /src\/runner\/pi\.ts \(the GY-169 headless runner to start the session through\)/);
  assert.match(worker, /Design doc before implementation \(RFC process\) \[https:\/\/github\.com\/rust-lang\/rfcs\]/);
  assert.match(worker, /a research run that never ends must not hold dispatch/);
  assert.match(worker, /Recommended approach: Add a loop step before dispatch/);
  assert.match(worker, /Product decisions: Should the brief be shown on the item page\? — provisional/);

  const [question] = currentResearch(feature)!.questions;
  applyResearchAnswer(feature, { question: question.id, answer: 'No, keep it off the page' }, 'operator', new Date(NOW));
  const answeredWorker = workerPrompt({ cliPath: '/repo/bin/graphyard.mjs' }, feature, { principal: 'worker-1' }, 1);
  assert.match(answeredWorker, /Should the brief be shown on the item page\? — answered by the operator: No, keep it off the page/);

  const binding = { key: 'GY-1', pr: 7, sha: 'a'.repeat(40), baseSha: 'b'.repeat(40), policyRevision: 1 };
  const review = reviewPrompt({ repository: 'owner/project' }, binding, undefined, undefined, feature.criteria, undefined, undefined, feature);
  assert.match(review, /Check the change against its recommended approach: Add a loop step before dispatch/);
  assert.match(review, /against the operator's answered product questions: Should the brief be shown on the item page\? — answered by the operator: No, keep it off the page\. A change that contradicts an answered question does not meet what the operator asked for and is BLOCKING/);
  assert.doesNotMatch(reviewPrompt({ repository: 'owner/project' }, binding, undefined, undefined, feature.criteria), /research brief/, 'an item without a brief is reviewed as before');
  assert.doesNotMatch(workerPrompt({ cliPath: '/repo/bin/graphyard.mjs' }, item({ type: 'bug' }), { principal: 'worker-1' }, 1), /research brief/);
});

test('unit:research-never-blocks — a timed-out, failed, over-budget or unrecordable run is recorded and the item proceeds to build without a brief', async t => {
  t.after(clearResearchRuns);
  // The timeout path: the runner stops the run at its bound, the failure is recorded, and the next cycle dispatches.
  const timedOut = item();
  const timeout = fakeRunner(() => ({ ok: false, failure: { reason: 'timeout', detail: 'no terminal event within 900s; the run was stopped' }, payloads: [] }));
  const plain = plane([timedOut]);
  const first = await step([timedOut], timeout.runner, plain.record);
  assert.ok(first.held.has(timedOut.id));
  await researchSettled();
  assert.deepEqual(plain.events.map(entry => entry.event.event), ['started', 'failed']);
  assert.equal(currentResearch(timedOut)!.state, 'failed');
  assert.deepEqual(currentResearch(timedOut)!.failure, { reason: 'timeout', detail: 'no terminal event within 900s; the run was stopped; build proceeds without a brief' });
  const after = await step([timedOut], timeout.runner, plain.record);
  assert.equal(after.held.size, 0, 'the timed-out item proceeds to build');
  assert.equal(timeout.starts.length, 1, 'and is not researched again at the same requirements');
  assert.match(workerPrompt({ cliPath: 'cli' }, timedOut, { principal: 'w' }, 1), /did not produce a brief \(timeout: .*\); start from the criteria/);

  // A run the loop lost (it restarted under it) stops holding at its bound, and its failure is recorded.
  const lost = item({ id: '66666666-6666-4666-8666-666666666666', key: 'GY-6' });
  applyResearchEvent(lost, { event: 'started', revision: requirementsRevision(lost), runtime: 'pi', model: 'zai/glm-5.3-flash', timeoutMs: 15 * 60_000, tokenBudget: 200_000 }, 'graphyard-master', new Date(NOW));
  const never = fakeRunner(() => 'never');
  const lostPlane = plane([lost]);
  assert.equal((await step([lost], never.runner, lostPlane.record, NOW + 60_000)).held.has(lost.id), true, 'within its bound it holds');
  const bound = NOW + 15 * 60_000 + researchHoldGraceMs;
  assert.equal(researchHold(lost, bound), false);
  const expired = await step([lost], never.runner, lostPlane.record, bound);
  assert.equal(expired.held.size, 0);
  assert.equal(currentResearch(lost)!.state, 'failed');
  assert.equal(currentResearch(lost)!.failure!.reason, 'timeout');
  assert.equal(never.starts.length, 0, 'no second run for the same requirements');

  // A run that overruns its token budget is stopped and recorded as such.
  const chatty = item({ id: '77777777-7777-4777-8777-777777777777', key: 'GY-7' });
  const verbose = fakeRunner(() => 'never', [{ kind: 'message', at: new Date(NOW).toISOString(), role: 'assistant', text: 'x'.repeat(8_000), stopReason: null, error: null }]);
  const chattyPlane = plane([chatty]);
  await step([chatty], verbose.runner, chattyPlane.record, NOW, settings({ tokenBudget: 1_000 }));
  await researchSettled();
  assert.equal(currentResearch(chatty)!.state, 'failed');
  assert.equal(currentResearch(chatty)!.failure!.reason, 'token-budget');
  assert.match(currentResearch(chatty)!.failure!.detail, /over its 1000-token budget/);

  // A malformed submission is a failure, not a brief.
  const malformed = item({ id: '88888888-8888-4888-8888-888888888888', key: 'GY-8' });
  const bad = fakeRunner(() => submitted({ approach: 'only this' }));
  const badPlane = plane([malformed]);
  await step([malformed], bad.runner, badPlane.record);
  await researchSettled();
  assert.equal(currentResearch(malformed)!.state, 'failed');
  assert.equal(currentResearch(malformed)!.brief, null);

  // A plane that cannot record the run starts none and holds nothing.
  const unrecorded = item({ id: '99999999-9999-4999-8999-999999999999', key: 'GY-9' });
  const refused = fakeRunner(() => submitted(brief));
  const result = await step([unrecorded], refused.runner, async () => { throw new Error('Graphyard refused work/GY-9/research (503)'); });
  assert.equal(result.held.size, 0);
  assert.equal(refused.starts.length, 0);
  assert.match(result.actions[0].detail, /was not started, so it is built without a brief/);
  // Disabled research holds nothing either.
  assert.equal((await step([item({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', key: 'GY-10' })], refused.runner, async () => undefined, NOW, settings({ enabled: false }))).held.size, 0);
});
