import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema } from '../src/master.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import type { DaemonState } from '../src/daemon/state.js';
import { noteCycleStalls, noteStepFailure, remedyStalledSteps, retainedStepStalls, stallBackoffMs, stallCycleBound, stallSignature, stallSignatureMax, stallSubjectKey, stallWakeSubjects, stallWakeTask } from '../src/daemon/step-stalls.js';
import { cycleFailureCeilingMs } from '../src/daemon/liveness.js';
import { applyStepStallRemedy, stepStallRemedy, stepStallRemedyRegistry, type StepStallRemedyOutcome } from '../src/stall-remedies.js';
import { dispatchStallSignature } from '../src/master/dispatch.js';
import { mergeLedgerAdoption, profileRemedyOutcome, stallRemedyRunner } from '../src/daemon/run.js';

// GY-1854: a loop step or dispatcher call that fails with the same normalised signature on three
// consecutive cycles is recorded as one stall; a bound remedy (unknown profile, 401 credential,
// merge-record idempotency reuse) is applied once and verified; an unbound stall wakes the master
// session with the signature as its task and the call backs off to once per five minutes.

/** A fixed epoch-milli clock the tests advance by hand; no calendar is constructed and no wall clock is read. */
let clock = 49_000_000_000;
const tick = (ms: number) => { clock += ms; return clock; };
const state = (): DaemonState => emptyDaemonState(masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/outside/graphyard.mjs', repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'test-host', masterAgentName: 'master-test', workers: [] }));
const snapshot = async () => ({ work: [] as never[], now: new Date(clock).toISOString() }) as never;

test('unit:stall-signature-normalisation — two failures of one cause sign the same however its ids, shas and numbers differ, and any other change signs differently', () => {
  const first = 'Worker launch failed: the worktree for GY-42 epoch 7 could not be created: fatal: unable to read a37b4c1d8e2f00112233445566778899aabbccdd';
  const again = 'Worker launch failed: the worktree for GY-99 epoch 12 could not be created: fatal: unable to read ff11ee22dd33cc44bb55aa66778899aabbccddee';
  assert.equal(stallSignature('dispatch', new Error(first)), stallSignature('dispatch', new Error(again)));
  // Every number is taken out, so item keys, epochs and counts never split one cause.
  assert.equal(stallSignature('dispatch', first), stallSignature('dispatch', again));
  assert.equal(stallSignature('snapshot', first), stallSignature('snapshot', again));
  // A different step, or any other change in the fault, signs differently.
  assert.notEqual(stallSignature('snapshot', first), stallSignature('dispatch', first));
  assert.notEqual(stallSignature('dispatch', first), stallSignature('dispatch', 'Worker launch failed: no push credential could be minted'));
  // UUIDs, multi-line text and the signature's own bound are normalised too.
  assert.equal(stallSignature('merge', 'intent 123e4567-e89b-12d3-a456-426614174000 was\nnever  pushed'), stallSignature('merge', 'intent 999e4567-e89b-12d3-a456-426614174099 was never pushed'));
  assert.ok(stallSignature('dispatch', 'x'.repeat(5000)).length <= stallSignatureMax, 'a signature never outgrows its bound');
  // A 401 stays its own token, so the credential refusal a remedy binds to survives the number pass.
  assert.match(stallSignature('dispatch', 'the control plane answered HTTP 401 for GY-3 epoch 2'), /<unauthorized>/);
  assert.equal(stallSignature('dispatch', 'the control plane answered HTTP 401 for GY-3 epoch 2'), stallSignature('dispatch', 'the control plane answered HTTP 401 for GY-4 epoch 3'));
});

test('unit:stall-remedy-registry — the three seen signatures bind their remedies, and nothing else binds', async () => {
  assert.equal(stepStallRemedyRegistry.length, 3);
  const profile = stepStallRemedy(stallSignature('dispatch', 'launch profile worker-x is not a configured agent environment; run master environments --apply'));
  assert.equal(profile?.kind, 'profile-unknown');
  assert.match(profile!.remedy, /master environments --apply/);
  const credential = stepStallRemedy(stallSignature('dispatch', 'the control plane answered HTTP 401: credential not valid'));
  assert.equal(credential?.kind, 'credential-401');
  assert.match(credential!.remedy, /bootstrap path/);
  const ledger = stepStallRemedy(stallSignature('merge', '{"error":"Idempotency key reused with different input"}'));
  assert.equal(ledger?.kind, 'merge-record-idempotency');
  assert.match(ledger!.remedy, /adopt the server's merge ledger/);
  assert.equal(stepStallRemedy(stallSignature('snapshot', 'the control plane timed out after 5000ms')), null);
  // A throw from the port is a recorded refusal, never a crash of the step that applied it.
  const refused = await applyStepStallRemedy('credential-401', async () => { throw new Error('no port'); });
  assert.deepEqual(refused, { outcome: 'refused', verified: false, detail: 'credential-401 remedy was refused: no port' });
});

test('unit:loop-step-stall-remedied — three consecutive cycles with one signature are one stall, its bound remedy is applied once and verified, and a clean cycle ends the run', async () => {
  const loop = state();
  const failing = { kind: 'dispatch', state: 'failed', detail: 'Worker launch failed: no push credential could be minted for GY-42 epoch 7 (HTTP 401)' } as const;
  // Two cycles failing the same way are not a stall yet.
  assert.equal(noteCycleStalls(loop, [failing], 1, tick(1)).length, 1);
  assert.equal(noteCycleStalls(loop, [failing], 2, tick(1)).length, 1);
  const runs = Object.values(loop.stepStalls);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].stalledAt, null);
  // The third consecutive cycle records one stall, bound to the 401 credential remedy.
  const third = noteCycleStalls(loop, [failing], 3, tick(1));
  assert.equal(third.length, 1);
  assert.equal(third[0].stalled, true, 'the third consecutive cycle is the one stall');
  assert.equal(third[0].bound?.kind, 'credential-401');
  const run = Object.values(loop.stepStalls)[0];
  assert.ok(run.stalledAt);
  // A fourth failure records no second stall.
  assert.equal(noteCycleStalls(loop, [failing], 4, tick(1))[0].stalled, false);

  // Its remedy is applied once and verified, and applied nothing the second sweep.
  let attempts = 0;
  const runner = async (): Promise<StepStallRemedyOutcome> => { attempts += 1; return { outcome: 'applied', verified: true, detail: 'the fresh credential authenticates' }; };
  const applied = await remedyStalledSteps(loop, runner, tick(1));
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].record, { kind: 'credential-401', at: new Date(clock).toISOString(), outcome: 'applied', verified: true, detail: 'the fresh credential authenticates' });
  assert.deepEqual(await remedyStalledSteps(loop, runner, tick(1)), [], 'one attempt per run: the second sweep applies nothing');
  assert.equal(attempts, 1);
  assert.equal(Object.values(loop.stepStalls)[0].remedy?.verified, true);

  // One clean cycle breaks the consecutive chain: the run, its stall and its remedy are cleared,
  // and a fresh run of the same signature stalls only after three more consecutive cycles.
  assert.deepEqual(noteCycleStalls(loop, [], 5, tick(1)), []);
  assert.equal(Object.keys(loop.stepStalls).length, 0);
  for (const cycle of [6, 7]) noteCycleStalls(loop, [failing], cycle, tick(1));
  assert.equal(Object.values(loop.stepStalls)[0].stalledAt, null);
  assert.equal(noteCycleStalls(loop, [failing], 8, tick(1))[0].stalled, true, 'a new run stalls on its own three cycles');
});

test('unit:loop-step-stall-unbound-wakes-master — an unbound stall and a refused remedy wake the master session with the signature, last error, step and count as the task', async () => {
  const loop = state();
  const failing = { kind: 'refresh', state: 'failed', detail: 'the control plane timed out after 5000ms reading /api/status' } as const;
  for (const cycle of [1, 2, 3]) noteCycleStalls(loop, [failing], cycle, tick(1));
  const [stall] = Object.values(loop.stepStalls);
  assert.equal(stepStallRemedy(stall.signature), null, 'no remedy binds to a base refresh timeout');
  const subjects = stallWakeSubjects(loop, 'graphyard.mjs');
  assert.equal(subjects.length, 1);
  assert.ok(subjects[0].key.length <= 60, `the subject fits the master session's key bound (${subjects[0].key})`);
  assert.equal(subjects[0].key, stallSubjectKey(stall.signature));
  const task = stallWakeTask(stall, 'graphyard.mjs');
  assert.equal(subjects[0].detail, task);
  assert.match(task, /3 consecutive cycles failed the refresh call/);
  assert.match(task, /Signature: refresh: the control plane timed out after Nms/);
  assert.match(task, /Last error: the control plane timed out after 5000ms/);
  assert.match(task, /master status/);

  // A bound remedy that was refused wakes the master too, and its task names the attempt.
  const held = state();
  const credential = { kind: 'dispatch', state: 'failed', detail: 'the control plane answered HTTP 401 for GY-9 epoch 1' } as const;
  for (const cycle of [1, 2, 3]) noteCycleStalls(held, [credential], cycle, tick(1));
  const refused = await remedyStalledSteps(held, stallRemedyRunner(() => ({ url: 'http://localhost' }), () => held, snapshot, () => '/outside'), tick(1));
  assert.equal(refused.length, 1);
  assert.equal(refused[0].record.outcome, 'refused');
  assert.match(refused[0].record.detail, /no port that re-issues a refused credential/);
  const woken = stallWakeSubjects(held, 'graphyard.mjs');
  assert.equal(woken.length, 1);
  assert.match(woken[0].detail, /credential-401 remedy was applied once at .* and refused/);

  // A verified remedy that has stood through a second full run of failures needs the master too:
  // each later attempt is one five-minute window apart, and the task carries the grown count.
  assert.equal(stallWakeSubjects(loop, 'graphyard.mjs').length, 1);
  for (const cycle of [4, 5, 6]) noteCycleStalls(loop, [failing], cycle, tick(stallBackoffMs + 1));
  const aged = Object.values(loop.stepStalls)[0];
  assert.equal(aged.count, 6);
  assert.match(stallWakeTask(aged, 'graphyard.mjs'), /6 consecutive cycles/);
});

test('unit:stall-backoff-five-minutes — a stalled call is attempted once per five minutes, inside the window the count stands, and the loop retry converges to the same bound', () => {
  // The loop's own failing-call schedule converges to exactly the stall bound: once per five minutes.
  assert.equal(cycleFailureCeilingMs, stallBackoffMs);

  const loop = state();
  const failing = 'Worker launch failed: no push credential could be minted for GY-42 epoch 7 (HTTP 401)';
  noteStepFailure(loop, 'dispatch', failing, tick(0), 1);
  noteStepFailure(loop, 'dispatch', failing, tick(60_000), 2);
  const third = noteStepFailure(loop, 'dispatch', failing, tick(60_000), 3);
  assert.equal(third.stalled, true);
  assert.equal(Math.abs(Date.parse(third.run.nextAttemptAt!) - (clock + stallBackoffMs)), 0, 'the stall arms one five-minute window from its recording');

  // A failure inside the window is that window's one attempt still failing: the count stands.
  const inside = noteStepFailure(loop, 'dispatch', failing, tick(1_000), 4);
  assert.equal(inside.run.count, stallCycleBound);
  assert.equal(inside.run.lastError, failing, 'the window keeps the run truthful about its last error');
  assert.equal(Date.parse(inside.run.nextAttemptAt!), Date.parse(third.run.nextAttemptAt!), 'the window itself does not move');

  // Past the window the call is attempted again: the count advances and the window re-arms.
  const later = noteStepFailure(loop, 'dispatch', failing, clock + stallBackoffMs, 5);
  assert.equal(later.run.count, stallCycleBound + 1);
  assert.equal(Math.abs(Date.parse(later.run.nextAttemptAt!) - (clock + 2 * stallBackoffMs)), 0);
});

test('unit:dispatcher-failures-sign-the-same — the dispatcher signs its failures exactly as the loop signs a step, and its failed actions reach the same stall', () => {
  const error = new Error('Worker launch failed: the worktree for GY-42 epoch 7 could not be created: fatal: unable to read a37b4c1d8e2f00112233445566778899aabbccdd');
  assert.equal(dispatchStallSignature(error), stallSignature('dispatch', error.message));
  // The loop feeds the failed dispatch action it reads on the cursor through the same signature.
  const loop = state();
  noteCycleStalls(loop, [{ kind: 'dispatch', state: 'failed', detail: error.message }], 1, tick(0));
  noteCycleStalls(loop, [{ kind: 'dispatch', state: 'failed', detail: 'Worker launch failed: the worktree for GY-42 epoch 9 could not be created: fatal: unable to read ff11ee22dd33cc44bb55aa66778899aabbccddee' }], 2, tick(0));
  const third = noteCycleStalls(loop, [{ kind: 'dispatch', state: 'failed', detail: 'Worker launch failed: the worktree for GY-42 epoch 11 could not be created: fatal: unable to read 1234abcd1234abcd1234abcd1234abcd1234abcd' }], 3, tick(0));
  assert.equal(third.length, 1);
  assert.equal(third[0].stalled, true, 'three dispatcher failures of one cause are one stall');
  assert.equal(Object.keys(loop.stepStalls)[0], dispatchStallSignature(error));
});

test('unit:stall-remedy-ports — the profile write is judged from its report, and the ledger adoption reads the server fold back and clears the stale merge', () => {
  assert.deepEqual(profileRemedyOutcome({ applied: true, profiles: [{ role: 'worker', profile: 'a', action: 'added' }], skipped: [], next: 'Profiles use the 1 logged-in environment(s)' }),
    { outcome: 'applied', verified: true, detail: '1 profile change(s) written: Profiles use the 1 logged-in environment(s)' });
  const skipped = profileRemedyOutcome({ applied: true, profiles: [{ role: 'worker', profile: 'a', action: 'added' }], skipped: [{ reason: 'authenticates no role, not worker' }], next: 'x' });
  assert.equal(skipped.verified, false, 'a credential skipped unread is unverified');
  assert.match(skipped.detail, /1 credential\(s\) skipped/);
  assert.equal(profileRemedyOutcome({ applied: true, profiles: [], next: 'x' }).outcome, 'unchanged');

  const loop = state();
  loop.mergeWriter.inFlight = { key: 'GY-7', id: 'id-7', head: 'a'.repeat(40), startedAt: new Date(clock).toISOString() };
  const adoption = mergeLedgerAdoption(loop, [{ key: 'GY-7', mergeLedger: { events: 4 } }, { key: 'GY-8', mergeLedger: { events: 1 } }], "Handling merge writer in the merge step threw: GY-7's record was refused: {\"error\":\"Idempotency key reused with different input\"}");
  assert.equal(adoption.outcome, 'applied');
  assert.equal(adoption.verified, true, 'the adoption verified against the ledger it read back');
  assert.match(adoption.detail, /GY-7 .*4 events.*fresh key/);
  assert.equal(loop.mergeWriter.inFlight, null, 'the stale in-flight merge is cleared, so the next attempt records under a fresh key');
  const unread = mergeLedgerAdoption(state(), [{ key: 'GY-9', mergeLedger: { events: 2 } }], 'refused with different input for GY-404');
  assert.equal(unread.verified, false, 'an item the fold names nothing for is adopted unverified');
});

test('unit:stall-runner-refuses-credential-kind — the 401 remedy through the loop runner is a recorded refusal naming the master session', async () => {
  const loop = state();
  const outcome = await applyStepStallRemedy('credential-401', stallRemedyRunner(() => ({ url: 'http://localhost' }), () => loop, snapshot, () => '/outside'));
  assert.equal(outcome.outcome, 'refused');
  assert.equal(outcome.verified, false);
  assert.match(outcome.detail, /master session runs the install's bootstrap path/);
});

test('unit:stall-record-bounded — the cursor keeps the newest runs and drops what only a recovered history would read', () => {
  const loop = state();
  // Distinct causes spelled without digits: every number is normalised away, so only the words differ.
  for (let index = 0; index < retainedStepStalls + 10; index++) noteStepFailure(loop, 'dispatch', `cause ${'_'.repeat(index + 1)} of many`, tick(1), 1);
  assert.equal(Object.keys(loop.stepStalls).length, retainedStepStalls);
  assert.ok(!Object.keys(loop.stepStalls).some(signature => signature.includes('cause _ of many')), 'the oldest run is the first dropped');
  assert.ok(Object.keys(loop.stepStalls).some(signature => signature.includes(`cause ${'_'.repeat(retainedStepStalls + 10)} of many`)), 'the newest run is kept');
});
