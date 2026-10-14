import { test } from 'node:test';
import assert from 'node:assert/strict';

/** GY-1774 rework: a nested phase waits under the step's budget, and a call's key tells a different hold, mark or end apart. */
const helper = () => import('../src/daemon/step-budget.js');

test('unit:step-calls-bounded — triage: a nested acceptance or planner phase that does not answer is carried and joined next cycle, never started twice and never holding the phase after it', async () => {
  const { boundedPhase } = await helper();
  const state = { cycle: 1, actions: {} as Record<string, any>, faults: {} };
  const cycle = { state, now: () => Date.now(), performed: [] as unknown[], effects: { persist: async () => {} } } as any;
  let starts = 0, release!: () => void;
  const slow = () => { starts++; return new Promise<void>(resolve => { release = resolve; }); };
  const started = Date.now();
  await boundedPhase(cycle, 'triage', 'acceptance', () => 60, slow);
  assert.ok(Date.now() - started < 1_000, 'the step goes on past the slow phase');
  const row = state.actions['carried:triage:acceptance'];
  assert.equal(row.state, 'waiting');
  assert.match(row.detail, /stays owed and is retried next cycle/);
  state.cycle = 2;
  await boundedPhase(cycle, 'triage', 'acceptance', () => 60, slow);
  assert.equal(starts, 1, 'the retry joined the run in flight');
  release();
  await new Promise(resolve => setTimeout(resolve, 5));
  await boundedPhase(cycle, 'triage', 'acceptance', () => 60, async () => { starts++; });
  assert.equal(state.actions['carried:triage:acceptance'].state, 'done', 'a phase that ran through retires the row');
});

test('unit:step-calls-applied-once — differing holds, idle and active marks, and ends are different calls; a repeat of one is the same call', async () => {
  const { callKey } = await helper();
  const hold = (reason: string, at = 'a') => ['account-1', { at, reason, role: 'worker', profile: 'p', work: 'GY-1', resetsAt: null }];
  assert.notEqual(callKey('holdAccount', hold('quota')), callKey('holdAccount', hold('rate limit')));
  assert.equal(callKey('holdAccount', hold('quota', 'a')), callKey('holdAccount', hold('quota', 'b')));
  const session = { work: 'GY-1', trigger: 'blocked', launchedAt: 't', agentName: 'h' };
  assert.notEqual(callKey('markEscalation', [{ ...session, idleSince: 'x' }]), callKey('markEscalation', [session]));
  assert.equal(callKey('markEscalation', [{ ...session, idleSince: 'x' }]), callKey('markEscalation', [{ ...session, idleSince: 'y' }]));
  assert.notEqual(callKey('endEscalation', [session, 'finished', null]), callKey('endEscalation', [session, 'dropped', null]));
});

test('unit:step-calls-bounded — triage: a phase starts nothing once the step budget is spent, and a finished handle record supersedes the owed running one', async () => {
  const { boundedPhase, supersedeOwed, owedWrite } = await helper();
  const state = { cycle: 1, actions: {} as Record<string, any>, faults: {} };
  const cycle = { state, now: () => Date.now(), performed: [] as unknown[], effects: { persist: async () => {} } } as any;
  let starts = 0;
  await boundedPhase(cycle, 'triage', 'planner', () => 0, async () => { starts++; });
  assert.equal(starts, 0, 'the spent budget started no phase');
  assert.equal(state.actions['carried:triage:planner'].state, 'waiting');
  const { StepCallCarriedError } = await helper();
  await owedWrite(cycle, 'handle:1:h:running', { kind: 'session', work: 'GY-1' }, 'Recording h running', 'recordSession', async () => { throw new StepCallCarriedError(`the sessions step's 10000 ms per-call bound passed before h's recordSession call answered; the call stays owed and is retried next cycle`, true); });
  assert.equal(state.actions['owed:handle:1:h:running'].state, 'waiting');
  await supersedeOwed(cycle, 'handle:1:h:running', 'the finished record');
  assert.equal(state.actions['owed:handle:1:h:running'].state, 'done');
  assert.match(state.actions['owed:handle:1:h:running'].detail, /superseded/);
});
