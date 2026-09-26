import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Work } from '../src/model.js';
import { applyResearchEvent, clearResearchRuns, currentResearch, requirementsRevision, researchSettings, researchSettled, researchStep, researchTool, type ResearchBrief, type ResearchEvent } from '../src/research.js';
import { researchOn } from '../src/daemon/cycle-dispatch.js';
import { piEvent, defaultPiModel } from '../src/runner/pi.js';
import type { Run, RunEvent, RunOptions, RunResult, Runner } from '../src/runner/types.js';
import { humanOnlyRefusal, openHumanOnly, researchQuestionRule } from '../src/model/human-request.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// GY-401: follow-ups from the approved review of GY-259. Research runs by default, in a detached
// checkout of its own that is discarded when the run settles; the budget counts the tokens the
// runtime itself reports; and the research brief's product questions are derived on the server,
// beside the human-only rule table, so humanOnly carries them everywhere.

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const brief: ResearchBrief = {
  existingCode: [{ path: 'src/research.ts', note: 'the step under test' }],
  patterns: [], risks: [], approach: 'Keep the step; brief the worker.',
  questions: [{ question: 'Which checkout should research read?', why: 'The loop checkout must stay untouched.', recommendation: 'A detached throwaway worktree' }],
};

function item(overrides: Partial<Work> = {}): Work {
  return {
    id: overrides.id ?? '12121212-1212-4212-8212-121212121212', key: 'GY-11', title: 'Follow-up', description: 'Review follow-up', type: 'feature', priority: 1,
    dependencies: [], criteria: [{ id: 'AC-1', text: 'Addressed.', proofs: ['unit:x'] }],
    policy: { checks: ['test'], review: true }, plannedFiles: ['src/research.ts'], stage: 'ready', revision: 3, policyRevision: 1,
    createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), stageEnteredAt: new Date(NOW).toISOString(), ready: true,
    epoch: 0, lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], observation: null, blocker: null, gates: [], violations: [],
    ...overrides,
  } as Work;
}

/** A Pi stand-in: records every start, streams its events, and settles as its scenario says. */
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
        if (settled.ok) { try { finish({ ...settled, payload: options.validate(settled.payload), payloads: settled.payloads.map(options.validate) } as RunResult<T>); } catch (error) { finish({ ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }); } }
        else finish(settled as RunResult<T>);
      });
      return run;
    },
  };
  return { runner, starts };
}
const submitted = (payload: unknown): RunResult<unknown> => ({ ok: true, tool: researchTool, payload, payloads: [payload] });

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
const settings = (overrides: Partial<ReturnType<typeof researchSettings>> = {}) => ({ ...researchSettings({}), ...overrides });

test('unit:research-on-by-default — an unconfigured loop researches features; only an explicit enabled:false turns the step off', async t => {
  t.after(clearResearchRuns);
  assert.equal(researchSettings(undefined).enabled, true, 'the parsed settings are on with no config at all');
  assert.equal(researchOn(undefined), true, 'a loop with no run.research key researches by default (GY-401 finding 1)');
  assert.equal(researchOn({ research: { model: defaultPiModel } }), true, 'a key that only tunes keeps the step on');
  assert.equal(researchOn({ research: { enabled: false } }), false, 'an explicit enabled:false is the one way off');
  assert.equal(researchOn({ pi: { command: 'pi-zai' } }), true, 'the Pi wrapper alone does not turn it off');
});

test('unit:research-detached-checkout — each run reads a detached checkout of its own, discarded when the run settles', async t => {
  t.after(clearResearchRuns);
  const feature = item();
  const dir = await mkdtemp(join(tmpdir(), 'graphyard-research-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const disposed: string[] = [];
  const checkouts: string[] = [];
  const { runner, starts } = fakeRunner(() => submitted(brief));
  const { record } = plane([feature]);
  const step = await researchStep({ items: [feature], clock: NOW, settings: settings(), config: { repository: 'owner/project' },
    checkout: async work => { checkouts.push(`${dir}-${work.key}-${checkouts.length}`); return { cwd: checkouts.at(-1)!, dispose: () => { disposed.push(checkouts.at(-1)!); } }; },
    runner, record });
  assert.deepEqual([...step.held], [feature.id]);
  assert.equal(starts.length, 1);
  assert.equal(starts[0].options.cwd, checkouts[0], 'the run reads the detached checkout, not the caller\'s');
  assert.deepEqual(disposed, [], 'the checkout outlives the running session');
  await researchSettled();
  assert.deepEqual(disposed, [checkouts[0]], 'the checkout is discarded once the brief is recorded');
  assert.equal(currentResearch(feature)!.state, 'recorded');

  // A checkout that cannot be created starts no run and records no start: research never blocks.
  const unbriefed = item({ id: '13131313-1313-4313-8313-131313131313', key: 'GY-12' });
  const refused = fakeRunner(() => submitted(brief));
  const failed = await researchStep({ items: [unbriefed], clock: NOW, settings: settings(), config: { repository: 'owner/project' },
    checkout: async () => { throw new Error('git worktree add failed: not a working tree'); }, runner: refused.runner, record: plane([unbriefed]).record });
  assert.equal(refused.starts.length, 0);
  assert.equal(failed.held.size, 0);
  assert.match(failed.actions[0].detail, /was not started, so it is built without a brief: git worktree add failed/);

  // A plane that refuses the start still gets its checkout back.
  const returned: string[] = [];
  const held = item({ id: '14141414-1414-4414-8414-141414141414', key: 'GY-13' });
  const refusing = fakeRunner(() => submitted(brief));
  const result = await researchStep({ items: [held], clock: NOW, settings: settings(), config: { repository: 'owner/project' },
    checkout: async () => ({ cwd: `${dir}-refused`, dispose: () => { returned.push('refused'); } }),
    runner: refusing.runner, record: async () => { throw new Error('Graphyard refused work/GY-13/research (503)'); } });
  assert.equal(refusing.starts.length, 0);
  assert.equal(result.held.size, 0);
  assert.deepEqual(returned, ['refused'], 'the detached checkout is discarded when the run is never recorded');
});

test('unit:research-budget-uses-reported-usage — the runner reports a message call\'s token usage and the budget counts it over the estimate', async t => {
  // The parser: usage arrives as bare numbers or { tokens }, or not at all.
  const at = new Date(NOW).toISOString();
  const usageOn = (record: any) => { const event = piEvent(record, at); return event?.kind === 'message' ? event.usage : 'not-a-message'; };
  assert.deepEqual(piEvent({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], usage: { input: 400, output: 120 } } }, at),
    { kind: 'message', at, role: 'assistant', text: 'hi', stopReason: null, error: null, usage: { input: 400, output: 120 } });
  assert.deepEqual(usageOn({ type: 'message_end', message: { role: 'assistant', content: [], usage: { input: { tokens: 30 }, output: { tokens: 5 } } } }), { input: 30, output: 5 });
  assert.equal(usageOn({ type: 'message_end', message: { role: 'assistant', content: [] } }), undefined, 'a runtime that reports nothing reports no usage');
  assert.equal(usageOn({ type: 'message_end', message: { role: 'assistant', content: [], usage: {} } }), undefined);

  // The budget: reported usage counts as tokens streamed; text without usage stays an estimate.
  t.after(clearResearchRuns);
  const usage = item({ id: '15151515-1515-4515-8515-151515151515', key: 'GY-14' });
  const chatty = fakeRunner(() => 'never', [
    { kind: 'message', at, role: 'assistant', text: 'x', stopReason: null, error: null, usage: { input: 700, output: 200 } },
    { kind: 'message', at, role: 'assistant', text: 'y', stopReason: null, error: null, usage: { input: 600, output: 100 } },
  ]);
  const usagePlane = plane([usage]);
  await researchStep({ items: [usage], clock: NOW, settings: settings({ tokenBudget: 1_000 }), config: { repository: 'owner/project' }, cwd: process.cwd(), runner: chatty.runner, record: usagePlane.record });
  await researchSettled();
  assert.equal(currentResearch(usage)!.state, 'failed');
  assert.equal(currentResearch(usage)!.failure!.reason, 'token-budget');
  assert.match(currentResearch(usage)!.failure!.detail, /over its 1000-token budget/, '1600 reported tokens cross the 1000 budget');

  const estimated = item({ id: '16161616-1616-4616-8616-161616161616', key: 'GY-15' });
  const quiet = fakeRunner(() => 'never', [{ kind: 'message', at, role: 'assistant', text: 'x'.repeat(8_000), stopReason: null, error: null }]);
  const estimatedPlane = plane([estimated]);
  await researchStep({ items: [estimated], clock: NOW, settings: settings({ tokenBudget: 1_000 }), config: { repository: 'owner/project' }, cwd: process.cwd(), runner: quiet.runner, record: estimatedPlane.record });
  await researchSettled();
  assert.equal(currentResearch(estimated)!.failure!.reason, 'token-budget', 'the characters-over-four estimate still bounds a runtime that reports nothing');
});

test('unit:research-questions-in-human-only — the server\'s human-only list derives research questions beside the rule table', async t => {
  const feature = item();
  const revision = requirementsRevision(feature);
  applyResearchEvent(feature, { event: 'started', revision, runtime: 'pi', model: defaultPiModel, timeoutMs: 900_000, tokenBudget: 200_000 }, 'graphyard-master', new Date(NOW));
  applyResearchEvent(feature, { event: 'recorded', revision, brief, questionDeadlineMs: 4 * 3_600_000 }, 'graphyard-master', new Date(NOW));
  const rows = openHumanOnly([{ work: feature }], NOW + 60_000);
  assert.equal(rows.length, 1, 'the rule table itself yields the research question — no client-side merge');
  assert.equal(rows[0].rule, researchQuestionRule);
  assert.equal(rows[0].decision, 'goals and priorities');
  assert.equal(rows[0].request.needed, brief.questions[0].question);
  assert.match(rows[0].request.reason, /Recommended: A detached throwaway worktree/);
  assert.deepEqual(rows[0].answer.post, { command: 'research-answer', body: { question: rows[0].request.id }, field: 'answer', submit: 'Answer for GY-11', decline: null });
  assert.match(humanOnlyRefusal(researchQuestionRule, { id: 'master', role: 'coordinator', sessionKind: 'ai' })!, /Only the human operator answers/);
  assert.equal(humanOnlyRefusal(researchQuestionRule, { id: 'operator', role: 'admin', sessionKind: 'human' }), null);
});
