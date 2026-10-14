import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { clearDrafts, type AcceptanceEffects } from '../src/daemon/acceptance.js';
import { caseChangeJudgementsSettled, caseChangeStep, clearCaseChangeJudgements, requestedCaseChanges } from '../src/daemon/case-change-judge.js';
import { diagnosticianSettings } from '../src/runner/payloads.js';
import type { Cycle } from '../src/daemon/cycle.js';
import type { CaseChange, Goal } from '../src/model/goal.js';
import type { RunOptions, RunResult, Runner } from '../src/runner/types.js';

// GY-1806: GY-1800 blocked three times because its requested case change (GOAL-1) was routed to no approver:
// the loop now launches the approver's judgement of a requested change and posts the verdict itself.
const change = (state: CaseChange['state'], id = randomUUID()): CaseChange => ({ id, work: 'GY-1800', cases: ['candidate-batches-five'], reason: 'the save entries read variable -> path', requestedBy: 'implementer', requestedAt: '2026-10-14T15:37:51Z', state, judgedBy: null, judgedAt: null, judgement: null });
const goalWith = (...caseChanges: CaseChange[]) => ({ id: 'goal-id', key: 'GOAL-1', statement: 'Candidates are small', stage: 'planning', caseChanges, acceptance: null } as unknown as Goal);

function runner(answer: () => unknown, prompts: string[]): Runner {
  return { name: 'stub', start<T>(prompt: string, options: RunOptions<T>) {
    prompts.push(prompt);
    let result: RunResult<T>;
    try { const parsed = options.validate(answer()); result = { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] }; }
    catch (error) { result = { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
    return { id: randomUUID(), events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
  } };
}

test('unit:case-change-judged-by-loop — a requested case change is judged by the approver run and posted, once, with no human step', async () => {
  clearDrafts(); clearCaseChangeJudgements();
  const prompts: string[] = [], posted: string[] = [], notes: string[] = [];
  const pending = change('requested');
  const goal = goalWith(change('approved'), pending);
  assert.deepEqual(requestedCaseChanges(goal).map(entry => entry.id), [pending.id], 'only a requested change waits for a judge');
  let verdict: unknown = { goal: 'GOAL-1', verdict: 'approve', reason: 'Only the save entries moved' };
  const acceptance = { settings: diagnosticianSettings({}), cwd: '/nowhere', runner: async () => ({ runner: runner(() => verdict, prompts), runtime: 'stub', model: 'primary' }),
    judgeCaseChange: async (target: Goal, entry: CaseChange, judgement: { verdict: string }) => { posted.push(`${target.key} ${entry.id} ${judgement.verdict}`); return target; } } as unknown as AcceptanceEffects;
  let clock = Date.parse('2026-10-14T16:00:00Z');
  const step = async (advance = 6 * 60_000) => { clock += advance; await caseChangeStep({ config: { repository: 'owner/repo' }, clock } as unknown as Cycle, acceptance, goal, async (_goal, outcome, detail) => { notes.push(`${outcome}: ${detail}`); }); await caseChangeJudgementsSettled(); };

  await step();
  assert.equal(prompts.length, 1, 'the approver run is launched without anyone asking');
  assert.match(prompts[0], /did not request it and did not implement GY-1800/);
  assert.deepEqual(posted, [], 'the verdict is posted on the next cycle');
  await step();
  assert.deepEqual(posted, [`GOAL-1 ${pending.id} approve`]);
  assert.match(notes.at(-1)!, /approved GY-1800's case change/);

  // A run that names the wrong goal returns no judgement: it is tried again next cycle, not posted.
  posted.length = 0; prompts.length = 0;
  verdict = { goal: 'GOAL-9', verdict: 'approve', reason: 'wrong goal' };
  await step(); await step();
  assert.deepEqual(posted, []); assert.match(notes.at(-1)!, /returned no judgement/);
  const runs = prompts.length;
  await step(60_000); assert.ok(prompts.length > runs, 'a failed run is launched again the next cycle');

  // Two requested changes of one goal are both launched in one cycle.
  clearCaseChangeJudgements(); prompts.length = 0; posted.length = 0; verdict = { goal: 'GOAL-1', verdict: 'approve', reason: 'ok' };
  const second = { ...change('requested'), id: 'second-change', work: 'GY-1801' } as CaseChange;
  goal.caseChanges.push(second);
  await step();
  assert.equal(prompts.length, 2, 'every requested change is launched within one cycle');
});
