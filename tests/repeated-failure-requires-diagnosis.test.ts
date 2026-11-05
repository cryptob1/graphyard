import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema, workerPrompt, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { daemonStateSchema, emptyDaemonState, type DaemonState } from '../src/daemon/state.js';
import { runCycle } from '../src/daemon/cycle.js';
import { type DaemonEffects } from '../src/daemon/effects.js';
import { masterCauses } from '../src/daemon/master-stalled-delivery.js';
import { trialFailurePrefix } from '../src/model/rework-ground.js';
import type { Work } from '../src/model.js';

const proof = 'unit:repeated-failure-requires-diagnosis';
// Reached dynamically, so this file loads on a base without the module and each case fails on its own.
const repeated = () => import('../src/daemon/repeated-failure.js');
const observedAt = '2030-01-01T12:00:00.000Z', clock = Date.parse(observedAt);
const minute = (n: number) => new Date(clock - 3_600_000 + n * 60_000).toISOString();
const worker = { name: 'codex-a', principal: 'graphyard-codex-a', agentName: 'builder-a', mode: 'launch', kind: 'codex', credentialFile: '/srv/codex-a.token', agentArgs: [], approvals: 'auto', environment: {} } as WorkerProfile;
const config: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/srv/graphyard/coordinator.token', cliPath: '/srv/graphyard/bin/graphyard.mjs',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'coordinator-host', masterAgentName: 'master', workers: [worker] });

/** A submitted item sent back by the loop's rework of a standing verdict: a review refusal. */
function item(epoch: number, rework: Work['lastRework'], overrides: Partial<Work> = {}): Work {
  const at = minute(0);
  return {
    id: 'id-GY-9', key: 'GY-9', title: 'Flaky widget', description: '', type: 'bug', priority: 1, dependencies: [], criteria: [{ id: 'AC-1', text: 'Works', proofs: ['unit:x'] }],
    policy: { checks: ['test'], review: true }, stage: 'build', revision: 1, policyRevision: 1, createdAt: at, updatedAt: at, stageEnteredAt: at,
    ready: true, epoch, lease: null, workspaces: [], candidate: { sha: 'a'.repeat(40) }, submission: { epoch, pr: 1 }, reworkRequested: true, lastRework: rework,
    pipeline: { attempts: [], submittedAt: minute(1), resubmittedAt: null }, scenarioRequirements: [], evidence: [], observation: null, blocker: null,
    gates: [{ name: 'ready', passed: true, reasons: [] }, { name: 'review', passed: false, reasons: [] }], violations: [], ...overrides,
  } as unknown as Work;
}
const verdict = (n: number, sha: string) => ({ reason: `GY-9: review-codex-${n} requested changes on ${sha.slice(0, 12)}: BLOCKING: tests/widget.test.ts:${40 + n} still fails at ${minute(n)} for graphyard-codex-a`, binding: `${sha}:verdict:review-codex-${n}`, at: minute(10 * n) });

test(`${proof} — signature strips SHAs, ids, numbers, timestamps and account names; kinds stay apart`, async () => {
  const { failureSignature, normalizeFailureReason } = await repeated();
  const a = `trial failed: tests 3 failed on ${'b'.repeat(40)} at 2030-01-01T10:00:00.000Z for graphyard-codex-a (run 1f2e3d4c-aaaa-bbbb-cccc-0123456789ab)`;
  const b = `trial failed:   tests 7 failed on ${'c'.repeat(40)} at 2030-01-02T11:30:05Z for builder-a (run 9f2e3d4c-aaaa-bbbb-cccc-0123456789cd)`;
  const accounts = ['graphyard-codex-a', 'builder-a', 'codex-a'];
  assert.equal(normalizeFailureReason(a, accounts), normalizeFailureReason(b, accounts));
  assert.equal(normalizeFailureReason('decaded   faced'), 'decaded faced', 'words of hex letters are kept');
  assert.equal(failureSignature('trial', a, accounts), failureSignature('trial', b, accounts));
  assert.notEqual(failureSignature('trial', a, accounts), failureSignature('review', a, accounts));
  assert.notEqual(failureSignature('trial', a, accounts), failureSignature('trial', 'trial failed: build failed', accounts));
  assert.match(failureSignature('launch', a), /^launch:[0-9a-f]{64}$/);
});

test(`${proof} — the second equal failure wakes the master once and asks the next worker for a diagnosis; the third holds the item; a master rework resumes it`, async () => {
  const sha1 = '1'.repeat(40), sha2 = '2'.repeat(40), sha3 = '3'.repeat(40);
  let work = [item(1, verdict(1, sha1))], now = clock;
  const dispatched: { epoch: number; diagnosis: string }[] = [], wakes: string[] = [];
  const effects: DaemonEffects = {
    agents: () => [{ name: 'master', pane_id: 'pM', agent_status: 'working' }],
    credentials: async () => ({ [worker.name]: { available: true, reason: null } }), snapshot: async () => ({ work, now: new Date(now).toISOString() }),
    closeSession: () => {}, persist: async () => {},
    dispatch: async (entry, _profile, _agents, _snapshot, options) => { dispatched.push({ epoch: entry.epoch, diagnosis: options?.diagnosis ?? '' }); return {}; },
    masterSession: { wake: async (_target, text) => { wakes.push(text); }, launch: async () => assert.fail('the master is visible') },
  };
  let state: DaemonState = emptyDaemonState(config);
  const cycle = async () => { now += 60_000; await runCycle(config, state, effects, () => now); };
  const repeatWakes = () => wakes.filter(text => text.includes('GY-9: the same review refusal'));

  await cycle();
  assert.equal(state.failureRuns['id-GY-9'].count, 1);
  assert.deepEqual(dispatched.at(-1), { epoch: 1, diagnosis: '' }, 'one failure is retried as before');

  work = [item(2, verdict(2, sha2))];
  await cycle();
  assert.equal(state.failureRuns['id-GY-9'].count, 2);
  const prompt = dispatched.at(-1)!.diagnosis;
  assert.match(prompt, /same review refusal/);
  assert.match(prompt, /widget\.test\.ts:41/); assert.match(prompt, /widget\.test\.ts:42/);
  assert.match(prompt, /Before changing any code, state your diagnosis of why it failed twice and the different approach/);
  assert.match(workerPrompt(config, work[0], worker, 3, null, null, null, null, null, prompt), /state your diagnosis/, 'the worker prompt carries the section');
  assert.equal(repeatWakes().length, 1, 'the second equal failure wakes the master');
  assert.match(repeatWakes()[0], /widget\.test\.ts:41[\s\S]*widget\.test\.ts:42/, 'with both reasons');

  // The run survives a restart and wakes nobody again.
  state = daemonStateSchema.parse(JSON.parse(JSON.stringify(state)));
  await cycle(); await cycle();
  assert.equal(state.failureRuns['id-GY-9'].count, 2);
  assert.equal(repeatWakes().length, 1, 'one wake per run');

  work = [item(3, verdict(3, sha3))];
  const before = dispatched.length;
  await cycle(); await cycle();
  assert.equal(state.failureRuns['id-GY-9'].count, 3);
  assert.equal(dispatched.length, before, 'the third equal failure stops dispatch');
  assert.equal(repeatWakes().length, 2);
  assert.match(repeatWakes()[1], /a third time; the loop stopped dispatching it\. Decide/);

  // The master decides with its own rework: the run ends and the item dispatches again.
  work = [item(4, { reason: 'Try the retry-free fixture instead', binding: null, at: new Date(now + 30_000).toISOString() })];
  await cycle();
  assert.equal(state.failureRuns['id-GY-9'].count, 0);
  assert.deepEqual(dispatched.at(-1), { epoch: 4, diagnosis: '' });
});

test(`${proof} — a different signature or a success of the same kind ends the run; per-failure causes give way to the run's one cause`, async () => {
  const { advanceFailureRuns, diagnosisSection } = await repeated();
  const state = emptyDaemonState(config), accounts = ['graphyard-codex-a'];
  const trial = (head: string, reason: string, intentAt: string) => ({ key: 'GY-9', state: 'refused', head, baseTip: null, mergeSha: null, risk: null, intentAt, pushedAt: null, observedTip: null, refusal: { kind: 'merge', reason }, events: 2 }) as unknown as Work['mergeLedger'];
  const refused = (n: number, reason = `${trialFailurePrefix}: tests ${n} failed`) => item(n, null, { mergeLedger: trial(String(n).repeat(40), reason, minute(n)) });
  advanceFailureRuns(state, [refused(1)], accounts);
  advanceFailureRuns(state, [refused(2)], accounts);
  assert.equal(state.failureRuns['id-GY-9'].count, 2);
  assert.ok(diagnosisSection(state.failureRuns['id-GY-9']).includes('merge trial refusal'));
  state.actions['early-exit:id-GY-9'] = { kind: 'dispatch', work: 'GY-9', principal: null, epoch: 2, state: 'failed', detail: 'GY-9 epoch 2: worker exited', attempts: 1, cycle: 1, at: minute(2) } as DaemonState['actions'][string];
  const causes = masterCauses([refused(2)], state.actions, state.failureRuns).filter(cause => !cause.quiet);
  assert.equal(causes.length, 1, 'the run replaces the per-failure causes');
  assert.match(causes[0].key, /^repeat:/);
  delete state.actions['early-exit:id-GY-9'];

  advanceFailureRuns(state, [refused(3, `${trialFailurePrefix}: build failed`)], accounts);
  assert.equal(state.failureRuns['id-GY-9'].count, 1, 'a different signature starts a new run');
  advanceFailureRuns(state, [refused(4, `${trialFailurePrefix}: build failed`)], accounts);
  assert.equal(state.failureRuns['id-GY-9'].count, 2);
  const pushed = refused(4, `${trialFailurePrefix}: build failed`);
  pushed.mergeLedger = { ...pushed.mergeLedger!, state: 'pushed', refusal: null };
  advanceFailureRuns(state, [pushed], accounts);
  assert.equal(state.failureRuns['id-GY-9'].count, 0, 'a pushed merge ends a trial run');
  advanceFailureRuns(state, [refused(4, `${trialFailurePrefix}: build failed`)], accounts);
  assert.equal(state.failureRuns['id-GY-9'].count, 0, 'an occurrence already counted is not counted again');
  advanceFailureRuns(state, [{ ...pushed, stage: 'done' } as Work], accounts);
  assert.equal(state.failureRuns['id-GY-9'], undefined, 'a done item drops its run');
});
