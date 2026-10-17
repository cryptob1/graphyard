import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema, DispatchReservedError } from '../src/master.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import type { DaemonState } from '../src/daemon/state.js';
import type { MergerMode } from '../src/merger-mode.js';
import { cycleFailureCeilingMs } from '../src/daemon/liveness.js';
import type { StepStallRemedyOutcome } from '../src/stall-remedies.js';
import type { DaemonEffects } from '../src/daemon/effects.js';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';

// The modules under test are imported inside each test, so a run against code without them fails
// its cases rather than the file (graphyard verify's exercise).
const load = async () => ({ S: await import('../src/daemon/step-stalls.js'), R: await import('../src/stall-remedies.js') });

// GY-1854: a loop step or dispatcher call that fails with the same normalised signature on three
// consecutive cycles is recorded as one stall; a bound remedy (unknown profile, 401 credential,
// merge-record idempotency reuse) is applied once and verified; an unbound stall wakes the master
// session with the signature as its task and the call backs off to once per five minutes.

/** A fixed epoch-milli clock the tests advance by hand; no calendar is constructed and no wall clock is read. */
let clock = 49_000_000_000;
const tick = (ms: number) => { clock += ms; return clock; };
const state = (): DaemonState => emptyDaemonState(masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/coordinator.token', cliPath: '/outside/graphyard.mjs', repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'test-host', masterAgentName: 'master-test', workers: [] }));
const loopConfig = () => masterConfigSchema.parse({ version: 1, url: 'http://localhost', credentialFile: '/outside/coordinator.token', cliPath: '/outside/graphyard.mjs', repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'test-host', masterAgentName: 'master-test', workers: [] });
/** Credential ports whose coordinator credential the plane refuses: the one 401 the loop never renews. */
const coordinatorRefused = () => ({ coordinator: '/outside/coordinator.token', profiles: [], authenticate: async () => ({ state: 'refused' as const, principal: null, detail: '401' }),
  issued: async () => [], adopt: async () => { throw new Error('nothing is adopted'); }, renewDeployKey: async () => { throw new Error('no key is renewed'); }, reachWithDeployKey: async () => {} });
const snapshot = async () => ({ work: [] as never[], now: new Date(clock).toISOString() }) as never;

test('unit:stall-signature-normalisation — two failures of one cause sign the same however its ids, shas and numbers differ, and any other change signs differently', async () => {
  const { S, R } = await load();
  const first = 'Worker launch failed: the worktree for GY-42 epoch 7 could not be created: fatal: unable to read a37b4c1d8e2f00112233445566778899aabbccdd';
  const again = 'Worker launch failed: the worktree for GY-99 epoch 12 could not be created: fatal: unable to read ff11ee22dd33cc44bb55aa66778899aabbccddee';
  assert.equal(S.stallSignature('dispatch', new Error(first)), S.stallSignature('dispatch', new Error(again)));
  // Every number is taken out, so item keys, epochs and counts never split one cause.
  assert.equal(S.stallSignature('dispatch', first), S.stallSignature('dispatch', again));
  assert.equal(S.stallSignature('snapshot', first), S.stallSignature('snapshot', again));
  // A different step, or any other change in the fault, signs differently.
  assert.notEqual(S.stallSignature('snapshot', first), S.stallSignature('dispatch', first));
  assert.notEqual(S.stallSignature('dispatch', first), S.stallSignature('dispatch', 'Worker launch failed: no push credential could be minted'));
  // UUIDs, multi-line text and the signature's own bound are normalised too.
  assert.equal(S.stallSignature('merge', 'intent 123e4567-e89b-12d3-a456-426614174000 was\nnever  pushed'), S.stallSignature('merge', 'intent 999e4567-e89b-12d3-a456-426614174099 was never pushed'));
  assert.ok(S.stallSignature('dispatch', 'x'.repeat(5000)).length <= S.stallSignatureMax, 'a signature never outgrows its bound');
  // A 401 stays its own token, so the credential refusal a remedy binds to survives the number pass.
  assert.match(S.stallSignature('dispatch', 'the control plane answered HTTP 401 for GY-3 epoch 2'), /<unauthorized>/);
  assert.equal(S.stallSignature('dispatch', 'the control plane answered HTTP 401 for GY-3 epoch 2'), S.stallSignature('dispatch', 'the control plane answered HTTP 401 for GY-4 epoch 3'));
  // A long all-digit run is a number, never a commit id: a millisecond count signs N like any number.
  assert.equal(S.stallSignature('dispatch', 'the read took 1734567890123ms and failed'), 'dispatch: the read took Nms and failed');
  assert.notEqual(S.stallSignature('dispatch', 'unable to read a37b4c1'), S.stallSignature('dispatch', 'unable to read 1234567'), 'a hex id and a digit run of the same length sign differently');
});

test('unit:stall-remedy-registry — the three seen signatures bind their remedies, and nothing else binds', async () => {
  const { S, R } = await load();
  assert.equal(R.stepStallRemedyRegistry.length, 3);
  const profile = R.stepStallRemedy(S.stallSignature('dispatch', 'launch profile worker-x is not a configured agent environment; run master environments --apply'));
  assert.equal(profile?.kind, 'profile-unknown');
  assert.match(profile!.remedy, /master environments --apply/);
  // The review launch boundary's own refusal (src/reviewer.ts launchReview, GY-1850), plain and backed off, binds the same remedy.
  assert.equal(R.stepStallRemedy(S.stallSignature(S.reviewLaunchStep, 'Unknown reviewer profile reviewer-x'))?.kind, 'profile-unknown');
  assert.equal(R.stepStallRemedy(S.stallSignature(S.reviewLaunchStep, 'Unknown reviewer profile reviewer-x: refused 3 launches in a row (last at 2026-10-17T07:00:00.000Z); backing off to one attempt every 5 minutes until the profiles change — write them with graphyard master environments --apply'))?.kind, 'profile-unknown');
  const credential = R.stepStallRemedy(S.stallSignature('dispatch', 'the control plane answered HTTP 401: credential not valid'));
  assert.equal(credential?.kind, 'credential-401');
  assert.match(credential!.remedy, /credential the install issued for its principal, or the merge writer's deploy key/);
  const ledger = R.stepStallRemedy(S.stallSignature('merge', 'Merge of GY-7 head aabbcc was refused a record key reused with different input; that key is never sent again'));
  assert.equal(ledger?.kind, 'merge-record-idempotency');
  assert.match(ledger!.remedy, /adopt the server's merge ledger/);
  // The same refusal raised by any other module — delegation, agent registry, proof grants,
  // delivery — is no merge-writer stall: it binds nothing and wakes the master.
  assert.equal(R.stepStallRemedy(S.stallSignature('delegation', 'Graphyard refused delegation (409): Idempotency key reused with different input')), null, 'a non-merge step never runs the merge-writer remedy');
  assert.equal(R.stepStallRemedy(S.stallSignature('delivery', 'Idempotency key reused with different input')), null);
  assert.equal(R.stepStallRemedy(S.stallSignature('snapshot', 'the control plane timed out after 5000ms')), null);
  // A throw from the port is a recorded refusal, never a crash of the step that applied it.
  const refused = await R.applyStepStallRemedy('credential-401', async () => { throw new Error('no port'); });
  assert.deepEqual(refused, { outcome: 'refused', verified: false, detail: 'credential-401 remedy was refused: no port' });
});

test('unit:loop-step-stall-remedied — three consecutive cycles with one signature are one stall, its bound remedy is applied once and verified, and a clean cycle ends the run', async () => {
  const { S, R } = await load();
  const loop = state();
  const failing = { kind: 'dispatch', state: 'failed', detail: 'Worker launch failed: no push credential could be minted for GY-42 epoch 7 (HTTP 401)' } as const;
  // Two cycles failing the same way are not a stall yet.
  assert.equal(S.noteCycleStalls(loop, [failing], 1, tick(1)).notes.length, 1);
  assert.equal(S.noteCycleStalls(loop, [failing], 2, tick(1)).notes.length, 1);
  const runs = Object.values(loop.stepStalls);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].stalledAt, null);
  // The third consecutive cycle records one stall, bound to the 401 credential remedy.
  const third = S.noteCycleStalls(loop, [failing], 3, tick(1));
  assert.equal(third.notes.length, 1);
  assert.equal(third.notes[0].stalled, true, 'the third consecutive cycle is the one stall');
  assert.equal(third.notes[0].bound?.kind, 'credential-401');
  const run = Object.values(loop.stepStalls)[0];
  assert.ok(run.stalledAt);
  // A fourth failure records no second stall.
  assert.equal(S.noteCycleStalls(loop, [failing], 4, tick(1)).notes[0].stalled, false);

  // Its remedy is applied once and verified, and applied nothing the second sweep.
  let attempts = 0;
  const runner = async (): Promise<StepStallRemedyOutcome> => { attempts += 1; return { outcome: 'applied', verified: true, detail: 'the fresh credential authenticates' }; };
  const applied = await S.remedyStalledSteps(loop, runner, tick(1));
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].record, { kind: 'credential-401', at: new Date(clock).toISOString(), outcome: 'applied', verified: true, detail: 'the fresh credential authenticates' });
  assert.deepEqual(await S.remedyStalledSteps(loop, runner, tick(1)), [], 'one attempt per run: the second sweep applies nothing');
  assert.equal(attempts, 1);
  assert.equal(Object.values(loop.stepStalls)[0].remedy?.verified, true);

  // One clean cycle inside the window is the hold working, not the fault clearing: the standing
  // run is kept, and the window's expiry plus a quiet cycle is what ends it.
  assert.deepEqual(S.noteCycleStalls(loop, [], 5, tick(1)), { notes: [], cleared: 0 }, 'a quiet cycle inside the window keeps the stall the loop is holding');
  assert.deepEqual(S.noteCycleStalls(loop, [], 6, tick(S.stallBackoffMs + 1)), { notes: [], cleared: 1 }, 'a quiet cycle past the window ends the run, its stall and its remedy');
  assert.equal(Object.keys(loop.stepStalls).length, 0);
  for (const cycle of [6, 7]) S.noteCycleStalls(loop, [failing], cycle, tick(1));
  assert.equal(Object.values(loop.stepStalls)[0].stalledAt, null);
  assert.equal(S.noteCycleStalls(loop, [failing], 8, tick(1)).notes[0].stalled, true, 'a new run stalls on its own three cycles');
});

test('unit:stall-counts-one-failure-per-cycle — several actions of one signature in a cycle are that cycle\u2019s one failure, a gap restarts the run, and alternating failed-cycle causes never accumulate', async () => {
  const { S, R } = await load();
  const loop = state();
  const failed = (key: string): { kind: 'dispatch'; state: 'failed'; detail: string } =>
    ({ kind: 'dispatch', state: 'failed', detail: `Dispatch of ${key} to worker-a failed: the control plane answered HTTP 401 for ${key} epoch 1` });
  // Three affected work items in ONE cycle sign one signature and count one failure, not three.
  const one = S.noteCycleStalls(loop, [failed('GY-1'), failed('GY-2'), failed('GY-3')], 1, tick(1));
  assert.equal(one.notes.length, 3, 'every action is noted');
  assert.equal(one.notes.every(note => note.counted === (note === one.notes[0])), true, 'only the first note of the cycle counts');
  assert.equal(Object.values(loop.stepStalls)[0].count, 1, 'one cycle, one failure');
  assert.equal(Object.values(loop.stepStalls)[0].stalledAt, null, 'three items in one cycle are not three cycles');
  for (const cycle of [2, 3]) S.noteCycleStalls(loop, [failed('GY-1'), failed('GY-2')], cycle, tick(1));
  assert.equal(Object.values(loop.stepStalls)[0].count, 3);
  assert.ok(Object.values(loop.stepStalls)[0].stalledAt, 'three consecutive cycles with the signature are one stall, however many items failed each');

  // A cycle that ends without the step failing ends the run; a later failure starts a new run that
  // carries neither the stall nor its applied remedy.
  const remedied = Object.values(loop.stepStalls)[0];
  remedied.remedy = { kind: 'credential-401', at: new Date(clock).toISOString(), outcome: 'applied', verified: true, detail: 're-issued once' };
  assert.equal(S.noteStepsSucceeded(loop, 4), 1, 'the clean cycle clears the run');
  const fresh = S.noteStepFailure(loop, 'dispatch', failed('GY-1').detail, tick(1), 9);
  assert.equal(fresh.run.count, 1);
  assert.equal(fresh.run.remedy, null, 'a new run applies its own remedy');
  assert.equal(fresh.run.stalledAt, null);

  // Alternating whole-cycle failures — one call failing on even cycles, another on odd ones —
  // never reach the bound: a failed cycle ends the runs of the calls it did not fail in, exactly
  // as the loop's failed-cycle branch records them (note the failing call, then end the rest).
  const alternated = state();
  const snapshotFailure = 'the control plane timed out after 5000ms', mergeFailure = 'the merge record was refused';
  const first = S.noteStepFailure(alternated, 'snapshot', snapshotFailure, tick(1), 1);
  S.noteStepsSucceeded(alternated, 1);
  const second = S.noteStepFailure(alternated, 'merge', mergeFailure, tick(1), 2);
  S.noteStepsSucceeded(alternated, 2);
  const againFirst = S.noteStepFailure(alternated, 'snapshot', snapshotFailure, tick(1), 3);
  S.noteStepsSucceeded(alternated, 3);
  const fourthFirst = S.noteStepFailure(alternated, 'snapshot', snapshotFailure, tick(1), 4);
  S.noteStepsSucceeded(alternated, 4);
  const thirdFirst = S.noteStepFailure(alternated, 'merge', mergeFailure, tick(1), 5);
  S.noteStepsSucceeded(alternated, 5);
  assert.equal(first.run.count, 1);
  assert.equal(second.run.count, 1);
  assert.equal(againFirst.run.count, 1, 'the snapshot run was ended by the cycle that failed in merge');
  assert.equal(fourthFirst.run.count, 2, 'two consecutive cycles with one call count two failures');
  assert.equal(thirdFirst.run.count, 1, 'a fresh merge run starts at one after the snapshot cycles ended it');
  assert.ok(!Object.values(alternated.stepStalls).some(run => run.stalledAt), 'alternating causes never record a stall');
});

test('unit:loop-step-stall-unbound-wakes-master — an unbound stall and a refused remedy wake the master session with the signature, step and stall as the task, once per run', async () => {
  const { S, R } = await load();
  const loop = state();
  const failing = { kind: 'refresh', state: 'failed', detail: 'the control plane timed out after 5000ms reading /api/status' } as const;
  for (const cycle of [1, 2, 3]) S.noteCycleStalls(loop, [failing], cycle, tick(1));
  const [stall] = Object.values(loop.stepStalls);
  assert.equal(R.stepStallRemedy(stall.signature), null, 'no remedy binds to a base refresh timeout');
  const subjects = S.stallWakeSubjects(loop, 'graphyard.mjs');
  assert.equal(subjects.length, 1);
  assert.ok(subjects[0].key.length <= 60, `the subject fits the master session's key bound (${subjects[0].key})`);
  assert.equal(subjects[0].key, S.stallSubjectKey(stall.signature));
  const task = S.stallWakeTask(stall, 'graphyard.mjs');
  assert.equal(subjects[0].detail, task);
  assert.match(task, /refresh call failed with one signature on 3 consecutive cycles/);
  assert.match(task, /stands stalled since/);
  assert.match(task, /Signature: refresh: the control plane timed out after Nms/);
  assert.match(task, /master status/);
  // The task is stable while the run stands: the digest machinery wakes the session once per run,
  // never again per backed-off attempt of the standing stall, so the live count stays out of it.
  S.noteCycleStalls(loop, [failing], 4, tick(1));
  assert.equal(S.stallWakeSubjects(loop, 'graphyard.mjs')[0].detail, task, 'a backed-off reattempt of the standing stall changes no wake');

  // A bound remedy that was refused wakes the master too, and its task names the attempt.
  const held = state();
  const credential = { kind: 'dispatch', state: 'failed', detail: 'the control plane answered HTTP 401 for GY-9 epoch 1' } as const;
  for (const cycle of [1, 2, 3]) S.noteCycleStalls(held, [credential], cycle, tick(1));
  const refused = await S.remedyStalledSteps(held, S.stallRemedyRunner(loopConfig, () => held, snapshot, () => '/outside', coordinatorRefused), tick(1));
  assert.equal(refused.length, 1);
  assert.equal(refused[0].record.outcome, 'refused');
  assert.match(refused[0].record.detail, /outside the loop's authority/);
  const woken = S.stallWakeSubjects(held, 'graphyard.mjs');
  assert.equal(woken.length, 1);
  assert.match(woken[0].detail, /credential-401 remedy was applied once at .* and refused/);
  // The refused-remedy task is stable too: the standing stall never re-wakes per cycle.
  const refusedTask = woken[0].detail;
  for (const cycle of [4, 5]) S.noteCycleStalls(held, [credential], cycle, tick(S.stallBackoffMs + 1));
  assert.equal(S.stallWakeSubjects(held, 'graphyard.mjs')[0].detail, refusedTask, 'the count and the last error stay on the cursor, out of the wake');
});

test('unit:stall-backoff-five-minutes — a stalled call is attempted once per five minutes, inside the window the count stands, and the loop retry converges to the same bound', async () => {
  const { S, R } = await load();
  // The loop's own failing-call schedule converges to exactly the stall bound: once per five minutes.
  assert.equal(cycleFailureCeilingMs, S.stallBackoffMs);

  const loop = state();
  const failing = 'Worker launch failed: no push credential could be minted for GY-42 epoch 7 (HTTP 401)';
  S.noteStepFailure(loop, 'dispatch', failing, tick(0), 1);
  S.noteStepFailure(loop, 'dispatch', failing, tick(60_000), 2);
  const third = S.noteStepFailure(loop, 'dispatch', failing, tick(60_000), 3);
  assert.equal(third.stalled, true);
  assert.equal(Math.abs(Date.parse(third.run.nextAttemptAt!) - (clock + S.stallBackoffMs)), 0, 'the stall arms one five-minute window from its recording');

  // The hold the owning steps consult: inside the window the call is held, past it the call is due.
  const inside = S.stallHold(loop, 'dispatch', clock + 1_000);
  assert.ok(inside, 'the stall holds its call inside the window');
  assert.equal(inside!.step, 'dispatch');
  assert.equal(inside!.until, Date.parse(third.run.nextAttemptAt!));
  assert.match(inside!.reason, new RegExp(S.stallHoldMarker));
  assert.match(inside!.reason, /attempted again at/);
  assert.equal(S.stallHold(loop, 'merge', clock + 1_000), null, 'another step\u2019s stall holds only its own call');
  assert.equal(S.stallHold(loop, 'dispatch', clock + S.stallBackoffMs), null, 'past the window the call is due again');

  // A failure inside the window is that window's one attempt still failing: the count stands.
  const counted = S.noteStepFailure(loop, 'dispatch', failing, clock + 1_000, 4);
  assert.equal(counted.counted, false, 'a failure inside the window does not advance the run');
  assert.equal(counted.run.count, S.stallCycleBound);
  assert.equal(counted.run.lastError, failing, 'the window keeps the run truthful about its last error');
  assert.equal(Date.parse(counted.run.nextAttemptAt!), Date.parse(third.run.nextAttemptAt!), 'the window itself does not move');

  // Past the window the call is attempted again: the count advances and the window re-arms.
  const later = S.noteStepFailure(loop, 'dispatch', failing, clock + S.stallBackoffMs, 5);
  assert.equal(later.counted, true);
  assert.equal(later.run.count, S.stallCycleBound + 1);
  assert.equal(Math.abs(Date.parse(later.run.nextAttemptAt!) - (clock + 2 * S.stallBackoffMs)), 0);

  // The hold answer is the tracker speaking, never a fault to count: a hold text is noted as nothing.
  const holdText = `${S.stallHoldMarker}: the dispatch call stands stalled and is attempted again later`;
  assert.equal(S.isStallHold(holdText), true);
  assert.equal(S.isStallHold(failing), false);
  const held = S.noteStepFailure(loop, 'dispatch', holdText, clock + S.stallBackoffMs + 60_000, 6);
  assert.equal(held.counted, false);
  assert.equal(held.stalled, false);
  assert.equal(Object.values(loop.stepStalls)[0].count, S.stallCycleBound + 1, 'the hold moved no count');
  const heldCycle = S.noteCycleStalls(loop, [{ kind: 'dispatch', state: 'failed', detail: `Dispatch of GY-7 to worker-a failed: ${holdText}` }], 5, tick(1));
  assert.deepEqual(heldCycle, { notes: [], cleared: 0 }, 'a cycle\u2019s hold answers are not noted as failures, and the standing run is kept');
});

test('unit:held-effects-gate-the-call — while a step\u2019s stall stands inside its window the owning call is not attempted: the dispatcher\u2019s launch is refused before any claim, the merge writer starts no new merge, and past the window each is due again', async () => {
  const { S, R } = await load();
  const loop = state();
  const failing = 'Graphyard refused /api/work/work-7/claim (502): upstream unavailable';
  for (const attempt of [1, 2, 3]) S.noteStepFailure(loop, 'dispatch', failing, tick(attempt), attempt);
  const mergeFail = 'Merge of GY-7 head ' + 'a'.repeat(40) + ' failed before it was recorded';
  for (const attempt of [1, 2, 3]) S.noteStepFailure(loop, 'merge', mergeFail, tick(attempt), attempt);
  const now = () => clock;

  let dispatches = 0, mergers = 0;
  // Every cursor write is kept, and the launch reads the newest at the instant it is made: the
  // admission that arms the window must already be on it.
  const cursors: string[] = [];
  const persist = async (state: DaemonState) => { cursors.push(JSON.stringify(state.stepStalls)); };
  const effects = {
    dispatch: async () => {
      dispatches += 1;
      const persisted = JSON.parse(cursors.at(-1) ?? '{}') as Record<string, { attemptAt: string | null; nextAttemptAt: string | null }>;
      const live = Object.values(loop.stepStalls).find(entry => entry.step === 'dispatch')!;
      assert.equal(persisted[live.signature]?.attemptAt, live.attemptAt, 'the admission is on the cursor before the launch is made');
      assert.equal(persisted[live.signature]?.nextAttemptAt, live.nextAttemptAt, 'and so is the window it armed');
      return {};
    },
    mergeWriter: { merger: async (): Promise<MergerMode> => { mergers += 1; return 'control-plane'; } },
  } as unknown as DaemonEffects;
  const held = S.stallHeldEffects(effects, () => loop, now, persist);
  assert.notEqual(held.dispatch, (effects as { dispatch?: unknown }).dispatch, 'the dispatch port is wrapped');

  // Inside the window: the launch is refused cleanly, as a dispatch another dispatcher holds is —
  // the item is the held resource, the marker is carried, and the raw port is never invoked.
  const work = { key: 'GY-7' } as never;
  const refusal = await held.dispatch!(work, {} as never, [] as never, {} as never).then(() => null, error => error as DispatchReservedError);
  assert.ok(refusal instanceof DispatchReservedError);
  assert.equal(refusal!.resource, 'work');
  assert.match(refusal!.message, new RegExp(S.stallHoldMarker));
  assert.equal(dispatches, 0, 'the call itself was not attempted inside the window');
  assert.equal(held.mergeWriter!.admit!(), false, 'the merge writer starts no new merge inside the window');
  assert.equal(await held.mergeWriter!.merger(), 'control-plane', 'the recorded merger every other step reads (the shadow gate among them) is left as it is');
  assert.equal(mergers, 1);

  // Other effects pass through untouched.
  assert.equal(held.snapshot, (effects as { snapshot?: unknown }).snapshot);

  // Past the window: both calls are due, and the ports read as themselves again.
  clock += S.stallBackoffMs + 1;
  await held.dispatch!(work, {} as never, [] as never, {} as never);
  assert.equal(dispatches, 1, 'past the window the call is attempted');
  assert.equal(held.mergeWriter!.admit!(), true, 'past the window a new merge is admitted');
  // The admission arms the next window: a second call before it ends is held, however late the
  // admitted attempt settles, so the call is attempted once per window.
  const again = await held.dispatch!(work, {} as never, [] as never, {} as never).then(() => null, error => error as DispatchReservedError);
  assert.ok(again instanceof DispatchReservedError, 'a second launch inside the new window is held');
  assert.equal(dispatches, 1);
  assert.equal(held.mergeWriter!.admit!(), false, 'a second merge inside the new window is held');
  const run = Object.values(loop.stepStalls).find(entry => entry.step === 'dispatch')!;
  assert.ok(run.attemptAt, 'the admission is on the run until the attempt reports');
  // Restart from the boundary: a process that dies right after the admission, before any later
  // cursor write, reloads the cursor the admission wrote — and the window stands armed on it, so the
  // launch is held, never made a second time at once.
  assert.equal(cursors.length, 1, 'one cursor write for the one admission (the held calls wrote nothing)');
  const reloaded: DaemonState = { ...state(), stepStalls: JSON.parse(cursors[0]) };
  const restarted = S.stallHeldEffects(effects, () => reloaded, now, persist);
  const afterRestart = await restarted.dispatch!(work, {} as never, [] as never, {} as never).then(() => null, error => error as DispatchReservedError);
  assert.ok(afterRestart instanceof DispatchReservedError, 'the restarted loop reads the armed window and holds the launch');
  assert.equal(dispatches, 1, 'no second launch inside the persisted window');
  assert.equal(cursors.length, 1, 'a held launch writes no cursor');
  // The admitted attempt's failure, recorded a cycle later, counts as that window's one failure and
  // keeps the window its admission armed.
  const window = run.nextAttemptAt;
  const counted = S.noteStepFailure(loop, 'dispatch', failing, clock + 30_000, 40);
  assert.equal(counted.run.count, 4, 'the attempt\u2019s failure counts');
  assert.equal(counted.run.attemptAt, null);
  assert.equal(counted.run.nextAttemptAt, window, 'the window the admission armed stands');
  assert.equal(counted.stalled, false, 'the standing stall is not recorded again');

  // A loop wired without the ports is held nothing: the wrap is transparent.
  const bare = S.stallHeldEffects({} as DaemonEffects, () => loop, now);
  assert.equal(bare.dispatch, undefined);
  assert.equal(bare.mergeWriter, undefined);
});

test('unit:stall-remedy-ports — the profile write is judged from its report, and the ledger adoption adopts the server fold, clears only the refused attempt\u2019s own marker, and verifies a fresh key', async () => {
  const { S, R } = await load();
  assert.deepEqual(S.profileRemedyOutcome({ applied: true, profiles: [{ role: 'worker', profile: 'a', action: 'added' }], skipped: [], next: 'Profiles use the 1 logged-in environment(s)' }),
    { outcome: 'applied', verified: true, detail: '1 profile change(s) written: Profiles use the 1 logged-in environment(s)' });
  const skipped = S.profileRemedyOutcome({ applied: true, profiles: [{ role: 'worker', profile: 'a', action: 'added' }], skipped: [{ reason: 'authenticates no role, not worker' }], next: 'x' });
  assert.equal(skipped.verified, false, 'a credential skipped unread is unverified');
  assert.match(skipped.detail, /1 credential\(s\) skipped/);
  assert.equal(S.profileRemedyOutcome({ applied: true, profiles: [], next: 'x' }).outcome, 'unchanged');

  const refused = { key: 'GY-7', head: 'a'.repeat(40), at: new Date(clock).toISOString() };
  const markerAt = (startedAt: string) => ({ key: 'GY-7', id: 'id-7', head: 'a'.repeat(40), startedAt });

  // The refused attempt's own marker — the item and head it names, started before the refusal was
  // recorded — is the one stale marker the remedy clears.
  const loop = state();
  loop.mergeWriter.inFlight = markerAt(new Date(clock - 60_000).toISOString());
  const adoption = S.mergeLedgerAdoption(loop, [{ key: 'GY-7', id: 'id-7', mergeLedger: { events: 4 } }, { key: 'GY-8', id: 'id-8', mergeLedger: { events: 1 } }], refused);
  assert.equal(adoption.outcome, 'applied');
  assert.equal(adoption.verified, true, 'the adoption verified against the ledger it read back, with no replay standing');
  assert.match(adoption.detail, /GY-7 \(4 events\)/);
  assert.match(adoption.detail, /cleared/);
  assert.match(adoption.detail, /no replay of its writes stands/);
  assert.equal(loop.mergeWriter.inFlight, null, 'the refused attempt\u2019s stale in-flight marker is cleared, so the next flight mints a fresh attempt id');

  // A marker naming another item, or one started after the refusal was recorded — a live or newer
  // flight of the same item — is never cleared from the remedy.
  const others = state();
  others.mergeWriter.inFlight = { key: 'GY-9', id: 'id-9', head: 'b'.repeat(40), startedAt: new Date(clock - 60_000).toISOString() };
  S.mergeLedgerAdoption(others, [{ key: 'GY-7', id: 'id-7', mergeLedger: { events: 4 } }], refused);
  assert.equal(others.mergeWriter.inFlight?.key, 'GY-9', 'another item\u2019s in-flight merge stands');
  const newer = state();
  newer.mergeWriter.inFlight = markerAt(new Date(clock + 60_000).toISOString());
  S.mergeLedgerAdoption(newer, [{ key: 'GY-7', id: 'id-7', mergeLedger: { events: 4 } }], refused);
  assert.equal(newer.mergeWriter.inFlight?.key, 'GY-7', 'a later attempt\u2019s in-flight marker stands');

  // A replay of the item\u2019s writes standing means the refused key could be sent once more: unverified.
  const replaying = state();
  replaying.mergeWriter.unconfirmed = [{ key: 'GY-7', id: 'id-7', attempt: 'attempt-1', write: 0, event: { kind: 'intent' }, sentAt: refused.at, replays: 1, lastError: 'the reply was lost' }];
  const unverified = S.mergeLedgerAdoption(replaying, [{ key: 'GY-7', id: 'id-7', mergeLedger: { events: 4 } }], refused);
  assert.equal(unverified.verified, false);
  assert.match(unverified.detail, /a replay of its writes still stands/);

  // An item the fold names nothing for is adopted unverified; no refused action to read refuses the remedy.
  const unread = S.mergeLedgerAdoption(state(), [{ key: 'GY-9', id: 'id-9', mergeLedger: { events: 2 } }], refused);
  assert.equal(unread.outcome, 'applied');
  assert.equal(unread.verified, false, 'an item the fold names nothing for is adopted unverified');
  const nothing = S.mergeLedgerAdoption(state(), [], null);
  assert.equal(nothing.outcome, 'refused');
  assert.match(nothing.detail, /No failed merge action carrying a reused record key/);
});

test('unit:stall-runner-finds-the-refused-merge — the loop\u2019s ports read the refused attempt from the newest failed merge action and refuse the credential kind', async () => {
  const { S, R } = await load();
  const loop = state();
  const head = 'a'.repeat(40);
  loop.actions['merge-writer:GY-7:' + head] = { kind: 'merge', work: 'GY-7', principal: null, state: 'failed',
    detail: `Merge of GY-7 head ${head} was refused a record key reused with different input; that key is never sent again: the item's merge ledger is adopted and the head is tried again under a new attempt id`,
    attempts: 1, epoch: null, cycle: 3, at: new Date(clock).toISOString() };
  loop.mergeWriter.inFlight = { key: 'GY-7', id: 'id-7', head, startedAt: new Date(clock - 60_000).toISOString() };
  const work = [{ key: 'GY-7', id: 'id-7', mergeLedger: { events: 4 } }];
  const runner = S.stallRemedyRunner(loopConfig, () => loop, async () => ({ work, now: new Date(clock).toISOString() }) as never, () => '/outside');
  const outcome = await R.applyStepStallRemedy('merge-record-idempotency', runner);
  assert.equal(outcome.outcome, 'applied');
  assert.equal(outcome.verified, true);
  assert.equal(loop.mergeWriter.inFlight, null);
  assert.match(outcome.detail, /Adopted the server's merge ledger for GY-7/);

  // A refused coordinator credential is the one 401 outside the loop's authority: a recorded refusal.
  const refusedKind = await R.applyStepStallRemedy('credential-401', S.stallRemedyRunner(loopConfig, () => state(), snapshot, () => '/outside', coordinatorRefused));
  assert.equal(refusedKind.outcome, 'refused');
  assert.match(refusedKind.detail, /coordinator credential .* outside the loop's authority/);
});

test('unit:stall-record-bounded — the cursor keeps the newest runs and drops what only a recovered history would read', async () => {
  const { S, R } = await load();
  const loop = state();
  // Distinct causes spelled without digits: every number is normalised away, so only the words differ.
  for (let index = 0; index < S.retainedStepStalls + 10; index++) S.noteStepFailure(loop, 'dispatch', `cause ${'_'.repeat(index + 1)} of many`, tick(1), 1);
  assert.equal(Object.keys(loop.stepStalls).length, S.retainedStepStalls);
  assert.ok(!Object.keys(loop.stepStalls).some(signature => signature.includes('cause _ of many')), 'the oldest run is the first dropped');
  assert.ok(Object.keys(loop.stepStalls).some(signature => signature.includes(`cause ${'_'.repeat(S.retainedStepStalls + 10)} of many`)), 'the newest run is kept');
});

test('unit:stall-credential-renewal — the 401 remedy renews a refused profile credential from the one the install issued for its principal and reads it back, renews the deploy key for a merge stall, and never renews the coordinator credential', async () => {
  const { S } = await load();
  const home = await temporaryDirectory('gy-1854-credentials');
  {
    const coordinator = 'c'.repeat(40), issued = 'w'.repeat(40), stale = 's'.repeat(40);
    for (const folder of ['master', 'workers', 'profile']) await mkdir(join(home, folder), { recursive: true });
    const write = (file: string, token: string) => writeFile(file, `${token}\n`, { mode: 0o600 });
    await write(join(home, 'master', 'coordinator.token'), coordinator);
    await write(join(home, 'workers', 'worker-a.token'), issued);
    await write(join(home, 'profile', 'worker-a.token'), stale);
    const config = masterConfigSchema.parse({ version: 1, url: 'https://plane.example', credentialFile: join(home, 'master', 'coordinator.token'), cliPath: '/outside/graphyard.mjs', repository: 'owner/gy-1854-renewal', baseBranch: 'main', githubAppId: 1234, hostId: 'test-host', masterAgentName: 'master-test',
      workers: [{ name: 'worker-a', principal: 'worker-a', agentName: 'agent-worker-a', mode: 'launch', kind: 'claude', credentialFile: join(home, 'profile', 'worker-a.token') }] });
    // The plane, as /api/status answers each bearer: the coordinator and the issued worker token authenticate, anything else is 401.
    const actors: Record<string, string> = { [coordinator]: 'master', [issued]: 'worker-a' };
    let coordinatorRefused = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: { headers: Record<string, string> }) => {
      const token = init.headers.Authorization.replace('Bearer ', '');
      const actor = token === coordinator && coordinatorRefused ? undefined : actors[token];
      return actor ? new Response(JSON.stringify({ actor: { id: actor, role: actor === 'master' ? 'coordinator' : 'worker' } }), { status: 200 }) : new Response('{}', { status: 401 });
    }) as typeof fetch;
    try {
      const ports = S.hostCredentialPorts(config, home);
      const dispatchStall = { step: 'dispatch', signature: 'dispatch: Graphyard refused /api/work/work-N/claim (<unauthorized>)' } as never;
      const renewed = await S.renewHostCredentials(dispatchStall, ports);
      assert.equal(renewed.outcome, 'applied', renewed.detail);
      assert.equal(renewed.verified, true, renewed.detail);
      assert.match(renewed.detail, /Renewed worker-a from .*workers\/worker-a\.token; read back: worker-a ok/);
      assert.equal((await readFile(join(home, 'profile', 'worker-a.token'), 'utf8')).trim(), issued, 'the profile now holds the issued credential');
      assert.equal((await stat(join(home, 'profile', 'worker-a.token'))).mode & 0o777, 0o600, 'and keeps it private');
      // Nothing refused any more: the remedy changes nothing and verifies nothing, so the stall wakes the master.
      const unchanged = await S.renewHostCredentials(dispatchStall, ports);
      assert.equal(unchanged.outcome, 'unchanged');
      assert.equal(unchanged.verified, false);
      // A principal with no issued credential that authenticates is refused, never minted.
      await write(join(home, 'profile', 'worker-a.token'), stale);
      await write(join(home, 'workers', 'worker-a.token'), stale);
      const missing = await S.renewHostCredentials(dispatchStall, ports);
      assert.equal(missing.outcome, 'refused');
      assert.match(missing.detail, /no credential issued on this host authenticates as worker-a/);
      // The coordinator's own credential is outside the loop's authority.
      coordinatorRefused = true;
      const coordinatorOutcome = await S.renewHostCredentials(dispatchStall, ports);
      assert.equal(coordinatorOutcome.outcome, 'refused');
      assert.match(coordinatorOutcome.detail, /outside the loop's authority/);
    } finally { globalThis.fetch = original; }

    // A merge stall renews the merge writer's deploy key and verifies it reaches the repository.
    let renewals = 0, reach: Error | null = null;
    const keyPorts = { coordinator: 'coordinator', profiles: [], issued: async () => [], adopt: async () => {},
      authenticate: async () => ({ state: 'ok' as const, principal: 'master', detail: 'authenticated' }),
      renewDeployKey: async () => { renewals += 1; return '/install/deploy-key'; }, reachWithDeployKey: async () => { if (reach) throw reach; } };
    const mergeStall = { step: 'merge', signature: 'merge: git push answered <unauthorized>' } as never;
    const key = await S.renewHostCredentials(mergeStall, keyPorts);
    assert.deepEqual([key.outcome, key.verified, renewals], ['applied', true, 1]);
    reach = new Error('Permission denied (publickey)');
    const unreached = await S.renewHostCredentials(mergeStall, keyPorts);
    assert.deepEqual([unreached.outcome, unreached.verified], ['applied', false]);
    assert.match(unreached.detail, /does not reach the repository: Permission denied/);
  }
});

test('unit:held-effects-hold-any-stalled-call — a stalled step whose failing call is any loop effect (the host reclaim) is held at that call: inside the window it is not made, past it once, and an answer lets it go', async () => {
  const { S } = await load();
  const loop = state();
  let calls = 0, failing = true;
  const cursors: string[] = [];
  const effects = { reclaim: async () => {
    calls += 1;
    // An admitted call reads its own admission on the cursor: the window it armed is written before it is made.
    const standing = Object.values(loop.stepStalls).find(run => run.step === 'reclaim' && run.stalledAt);
    if (standing) assert.equal((JSON.parse(cursors.at(-1) ?? '{}') as Record<string, { attemptAt: string | null }>)[standing.signature]?.attemptAt, standing.attemptAt, 'the admission is persisted before the admitted call');
    if (failing) throw new Error('EACCES: permission denied, rmdir /var/tmp/held'); return { at: 'now' };
  } } as unknown as DaemonEffects;
  const held = S.stallHeldEffects(effects, () => loop, () => clock, async state => { cursors.push(JSON.stringify(state.stepStalls)); });
  // One cycle of the reclaim step: the call, and the failed row it records from the thrown error.
  const cycle = async (index: number) => {
    const actions: { kind: 'reclaim'; state: 'failed' | 'done'; detail: string }[] = [];
    try { await held.reclaim!([], clock); actions.push({ kind: 'reclaim', state: 'done', detail: 'reclaimed' }); }
    catch (error) { actions.push({ kind: 'reclaim', state: 'failed', detail: `Worktree reclamation failed: ${(error as Error).message}` }); }
    return S.noteCycleStalls(loop, actions, index, clock);
  };
  for (const index of [1, 2, 3]) { tick(60_000); await cycle(index); }
  const [run] = Object.values(loop.stepStalls);
  assert.ok(run.stalledAt, 'three consecutive cycles are one stall');
  assert.deepEqual(run.calls, [{ call: 'reclaim', async: true, resource: null }], 'the stall names the effect its failed actions carry');
  assert.equal(calls, 3);
  // Inside the window the call is not made: the hold answers, as a rejection, and is never counted.
  for (const index of [4, 5, 6, 7]) { tick(60_000); await cycle(index); }
  assert.equal(calls, 3, 'the reclaim is not attempted inside its five-minute window');
  assert.equal(Object.values(loop.stepStalls)[0].count, 3, 'a held cycle counts nothing');
  // Past the window the call is made once, and its failure is that window's one failure.
  tick(60_000); await cycle(8);
  assert.equal(calls, 4, 'past the window the call is attempted once');
  assert.equal(cursors.length, 1, 'the one admission wrote the cursor once; held calls wrote nothing');
  assert.equal(Object.values(loop.stepStalls)[0].count, 4);
  tick(60_000); await cycle(9);
  assert.equal(calls, 4, 'the admission arms the next window');
  // The window's admitted call answers: the run lets it go and the next clean cycle ends it.
  failing = false;
  tick(S.stallBackoffMs); await cycle(10);
  assert.equal(calls, 5);
  assert.deepEqual(loop.stepStalls, {}, 'the answered call ends the run, never re-forming it');
  // A failure is matched to its call however short its text — `EACCES` alone is carried by the
  // row that quotes it, as a whole, never as the inside of a longer word — and a sync failure is
  // held as a throw. Only a hold's own answer, or a failure with no text, names nothing.
  assert.equal(S.detailCarries('Worktree reclamation failed: EACCES', 'EACCES'), true);
  assert.equal(S.detailCarries('Session listing failed: EACCESS denied', 'EACCES'), false, 'the inside of a longer word is not the failure');
  assert.equal(S.detailCarries('Dispatch failed: Graphyard refused /api/work (502): upstream unavailable; retried', 'Graphyard refused /api/work (502): upstream unavailable'), true);
  const sync = S.stallHeldEffects({ agents: () => { throw new Error('EACCES'); } } as unknown as DaemonEffects, () => loop, () => clock);
  const failed = (detail: string) => [{ kind: 'session' as const, state: 'failed' as const, detail }];
  for (const index of [11, 12, 13]) { tick(60_000); try { sync.agents!(); } catch (error) { S.noteCycleStalls(loop, failed(`Session listing failed: ${(error as Error).message}`), index, clock); } }
  const syncRun = Object.values(loop.stepStalls)[0];
  assert.deepEqual(syncRun.calls, [{ call: 'agents', async: false, resource: null }], 'a six-character failure names its call');
  assert.throws(() => sync.agents!(), new RegExp(S.stallHoldMarker), 'a call that failed synchronously is held as a throw');
  S.noteCallFailure(loop, 'agents', new Error(''), false);
  S.noteCallFailure(loop, 'agents', `${S.stallHoldMarker}: held`, false);
  const empty = S.noteCycleStalls(loop, failed('Session listing failed: '), 14, tick(S.stallBackoffMs + 60_000));
  assert.deepEqual(empty.notes[0].run.calls, [], 'a failure with no text, or a hold, names no call');
});

test('unit:loop-step-stall-reviewer-profile — the launch boundary\u2019s recorded unknown-reviewer-profile refusal is the review-launch step\u2019s failure, binds the profile remedy, and the remedy verifies only once the named profile is configured', async () => {
  const { S } = await load();
  const { recordReviewerProfileRefusal, readReviewerProfileRefusal, clearReviewerProfileRefusal } = await import('../src/reviewer.js');
  const directory = await temporaryDirectory('gy-1854-reviewer-profile-');
  const config = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: join(directory, 'coordinator.token'), cliPath: 'graphyard', repository: 'owner/project', baseBranch: 'main', githubAppId: 1, hostId: 'host', masterAgentName: 'master-test', workers: [] });
  assert.deepEqual(await S.readReviewerProfileFailures(config), [], 'no refusal recorded, nothing owed');
  // The real launch boundary's record, written as launchReview writes it.
  await recordReviewerProfileRefusal(config, 'reviewer-x', clock);
  const owed = await S.readReviewerProfileFailures(config);
  assert.deepEqual(owed, [{ kind: S.reviewLaunchStep, state: 'failed', detail: 'Unknown reviewer profile reviewer-x' }]);
  // Profiles the record no longer matches owe nothing: the missing name was written.
  assert.deepEqual(S.reviewerProfileFailures(await readReviewerProfileRefusal(config), { workers: [], reviewers: [{ name: 'reviewer-x' } as never] }), []);
  // Three consecutive cycles of the owed failure are one stall bound to the profile remedy.
  const loop = state();
  for (const cycle of [1, 2, 3]) S.noteCycleStalls(loop, owed, cycle, clock + cycle * 60_000);
  const stall = Object.values(loop.stepStalls)[0];
  assert.equal(stall.step, S.reviewLaunchStep);
  assert.ok(stall.stalledAt, 'three cycles are one stall');
  const write = { applied: true, profiles: [{ name: 'claude' }], skipped: [], next: 'wrote the profiles' };
  const runner = (configured: string[]) => S.stallRemedyRunner(() => config, () => loop, async () => ({ work: [], now: '' }) as never, () => directory, undefined,
    () => ({ apply: async () => write, configured: async () => ({ reviewers: configured.map(name => ({ name })) as never }) }));
  // A write that leaves the named profile unconfigured is unverified, whatever else it wrote.
  const missed = await runner(['claude'])('profile-unknown', stall);
  assert.equal(missed.verified, false);
  assert.match(missed.detail, /reviewer profile reviewer-x is still not configured/);
  // Applied once through the stall step, verified against the configuration it produced.
  const records = await S.remedyStalledSteps(loop, runner(['reviewer-x']), clock + 4 * 60_000);
  assert.equal(records.length, 1);
  assert.equal(records[0].record.kind, 'profile-unknown');
  assert.equal(records[0].record.verified, true);
  assert.equal((await S.remedyStalledSteps(loop, runner(['reviewer-x']), clock + 5 * 60_000)).length, 0, 'never applied twice for the run');
  assert.equal(S.stallNeedsMaster(loop.stepStalls[stall.signature]), false, 'a verified remedy needs no master');
  // The launch that gets past the lookup clears the record, and the run ends with it.
  await clearReviewerProfileRefusal(config);
  assert.deepEqual(await S.readReviewerProfileFailures(config), []);
});

test('unit:stall-holds-the-failing-invocation — a stalled call is held per resource: pane A failing never holds pane B, B answering never lets A go, quiet cycles without A keep its stall, and A is attempted once per window', async () => {
  const { S } = await load();
  const loop = state();
  let failingA = true;
  const prompted: string[] = [];
  const held = S.stallHeldEffects({ promptSession: async (agent: { pane_id: string }) => { prompted.push(agent.pane_id); if (agent.pane_id === 'A' && failingA) throw new Error('pane A is gone'); } } as unknown as DaemonEffects, () => loop, () => clock);
  const cycle = async (index: number, panes: string[]) => {
    const actions: { kind: 'wake'; state: 'failed' | 'done'; detail: string }[] = [];
    for (const pane of panes) {
      try { await held.promptSession!({ pane_id: pane } as never, 'wake'); actions.push({ kind: 'wake', state: 'done', detail: `woke ${pane}` }); }
      catch (error) { actions.push({ kind: 'wake', state: 'failed', detail: `The wake was not delivered: ${(error as Error).message}` }); }
    }
    return S.noteCycleStalls(loop, actions, index, clock);
  };
  const made = (pane: string) => prompted.filter(entry => entry === pane).length;
  for (const index of [1, 2, 3]) { tick(60_000); await cycle(index, ['A', 'B']); }
  const signature = Object.keys(loop.stepStalls)[0];
  assert.ok(loop.stepStalls[signature].stalledAt, 'three cycles of A failing are one stall');
  assert.deepEqual(loop.stepStalls[signature].calls, [{ call: 'promptSession', async: true, resource: 'A' }], 'the stall holds the invocation that failed: pane A');
  // Inside the window A is held and B is prompted every cycle, never held by A's stall.
  for (const index of [4, 5, 6, 7]) { tick(60_000); await cycle(index, ['A', 'B']); }
  assert.equal(made('A'), 3, 'A is not attempted inside its window');
  assert.equal(made('B'), 7, 'B is prompted on every cycle');
  // Past the window, cycles that prompt only B: B answering lets nothing of A go, and the quiet cycles keep A's stall.
  for (const index of [8, 9, 10, 11, 12, 13, 14]) { tick(60_000); await cycle(index, ['B']); }
  assert.ok(loop.stepStalls[signature]?.stalledAt, 'quiet cycles without A keep its stall: A was never retried');
  assert.deepEqual(loop.stepStalls[signature].calls.map(entry => entry.resource), ['A'], 'B answering never lets A go');
  // A prompted again: admitted once, its failure continues the run rather than starting another.
  tick(60_000); await cycle(15, ['A', 'B']);
  assert.equal(made('A'), 4, 'past the window A is attempted once');
  assert.equal(loop.stepStalls[signature].count, 4, 'the admitted attempt counts on the standing run');
  tick(60_000); await cycle(16, ['A', 'B']);
  assert.equal(made('A'), 4, 'the admission arms the next window');
  // A answers at the next window: its stall lets it go and the next clean cycle ends the run.
  failingA = false;
  tick(S.stallBackoffMs); await cycle(17, ['A', 'B']);
  assert.equal(made('A'), 5);
  tick(60_000); await cycle(18, ['B']);
  assert.deepEqual(loop.stepStalls, {}, 'A answering ends its run');
});

test('unit:stall-overflow-still-stalls — recurring failures past the cursor bound still reach three cycles: 101 distinct signatures all stall, and a cycle failing more ways than the cursor keeps folds the rest into one overflow stall', async () => {
  const { S } = await load();
  const words = (index: number) => `cause ${'_'.repeat(index + 1)} of many`;
  {
    const loop = state();
    for (const cycle of [1, 2, 3]) S.noteCycleStalls(loop, Array.from({ length: 101 }, (_, index) => ({ kind: 'dispatch', state: 'failed' as const, detail: words(index) })), cycle, tick(60_000));
    const runs = Object.values(loop.stepStalls);
    assert.equal(runs.length, 101, 'every recurring signature keeps its run');
    assert.ok(runs.every(run => run.stalledAt && run.count === 3), 'every one of them, the 101st included, is one stall after three cycles');
  }
  {
    const loop = state();
    // A standing stall from before is kept behind the cycle's own runs, never ahead of them.
    const total = S.retainedStepStalls + 25;
    for (const cycle of [1, 2, 3]) S.noteCycleStalls(loop, Array.from({ length: total }, (_, index) => ({ kind: index % 2 ? 'dispatch' : 'reclaim', state: 'failed' as const, detail: words(index) })), cycle, tick(60_000));
    const runs = Object.values(loop.stepStalls);
    assert.ok(runs.length <= S.retainedStepStalls, `the cursor stays bounded: ${runs.length}`);
    const overflow = runs.find(run => run.step === S.overflowStep);
    assert.ok(overflow?.stalledAt, 'the folded overflow recurs every cycle, so it stalls like any other signature');
    assert.match(overflow.signature, /more distinct failing signatures in one cycle than the N the cursor keeps a run for, from the steps dispatch, reclaim/);
    assert.equal(runs.filter(run => run.step !== S.overflowStep && run.stalledAt).length, S.retainedStepStalls - 1, 'every kept signature stalls too');
    assert.ok(S.stallNeedsMaster(overflow), 'no remedy binds the overflow: it wakes the master session');
  }
});

test('unit:stall-wake-acknowledges-only-delivered — a wake beside a failed cycle names at most twenty stalls and acknowledges only those, so the twenty-first is delivered by the next', async () => {
  const { S } = await load();
  const { wakeMasterForStalls } = await import('../src/daemon/cycle-master.js');
  const loop = state(), config = loopConfig();
  loop.master.agentName = 'master-test'; loop.master.pane = 'pane-master'; loop.master.startedAt = new Date(clock).toISOString();
  for (const cycle of [1, 2, 3]) S.noteCycleStalls(loop, Array.from({ length: 21 }, (_, index) => ({ kind: 'snapshot-read', state: 'failed' as const, detail: `unbound ${'_'.repeat(index + 1)} refusal` })), cycle, tick(60_000));
  assert.equal(S.stallWakeSubjects(loop, config.cliPath).length, 21);
  const prompts: string[] = [];
  const effects = { agents: () => [], herdr: async () => ({ agents: [{ name: 'master-test', pane_id: 'pane-master', agent: 'claude', agent_status: 'idle' }], available: true }),
    masterSession: { launch: async () => { throw new Error('never launched'); } }, promptSession: async (_agent: unknown, text: string) => { prompts.push(text); }, persist: async () => {} } as unknown as DaemonEffects;
  const first = await wakeMasterForStalls(config, loop, effects, () => clock);
  assert.equal(first.length, 20, 'one wake carries twenty subjects');
  const missing = S.stallWakeSubjects(loop, config.cliPath).filter(subject => !first.includes(subject.key));
  assert.equal(missing.length, 1);
  assert.equal(loop.master.subjects[missing[0].key], undefined, 'the subject the wake did not name is not acknowledged');
  tick(60_000);
  const second = await wakeMasterForStalls(config, loop, effects, () => clock);
  assert.deepEqual(second, [missing[0].key], 'the next wake delivers the twenty-first');
  assert.ok(prompts[1].includes(missing[0].key));
  assert.deepEqual(await wakeMasterForStalls(config, loop, effects, () => tick(60_000)), [], 'every stall delivered once: nothing more to wake');
});

test('unit:stall-wake-leaves-a-dialog-to-the-step — a wake beside a failed cycle never types into a dialog on the master pane: it sends nothing and acknowledges nothing, so the step answers or holds the dialog and delivers the wake', async () => {
  const { S } = await load();
  const { wakeMasterForStalls } = await import('../src/daemon/cycle-master.js');
  const loop = state(), config = loopConfig();
  loop.master.agentName = 'master-test'; loop.master.pane = 'pane-master'; loop.master.startedAt = new Date(clock).toISOString();
  for (const cycle of [1, 2, 3]) S.noteCycleStalls(loop, [{ kind: 'snapshot-read', state: 'failed' as const, detail: 'unbound refusal' }], cycle, tick(60_000));
  const prompts: string[] = [];
  let screen = 'Do you want to proceed?\n❯ 1. Yes\n  2. No\nEsc to cancel';
  const effects = { agents: () => [], herdr: async () => ({ agents: [{ name: 'master-test', pane_id: 'pane-master', agent: 'claude', agent_status: 'idle' }], available: true }),
    sessionOutput: () => screen, masterSession: { launch: async () => { throw new Error('never launched'); } }, promptSession: async (_agent: unknown, text: string) => { prompts.push(text); }, persist: async () => {} } as unknown as DaemonEffects;
  assert.deepEqual(await wakeMasterForStalls(config, loop, effects, () => clock), [], 'a dialog on the pane holds the wake');
  assert.equal(prompts.length, 0, 'nothing is typed into the dialog');
  assert.deepEqual(loop.master.subjects, {}, 'nothing is acknowledged');
  screen = '> ';
  tick(60_000);
  assert.equal((await wakeMasterForStalls(config, loop, effects, () => clock)).length, 1, 'a clear pane receives the wake');
});

test('unit:stall-remedy-written-before-it-runs — the remedy attempt is on the cursor before its mutation runs, so a process ending during it restarts into a remedied run that wakes the master and is never applied twice', async () => {
  const { S } = await load();
  const loop = state();
  for (const cycle of [1, 2, 3]) S.noteStepFailure(loop, 'dispatch', 'Graphyard refused /api/work (401): unauthorized', tick(60_000), cycle);
  const signature = Object.keys(loop.stepStalls)[0];
  let cursor = '';
  const persist = async (written: DaemonState) => { cursor = JSON.stringify(written); };
  let runs = 0;
  // The process ends during the renewal: the runner never returns.
  const dying = async () => { runs += 1; assert.equal((JSON.parse(cursor) as DaemonState).stepStalls[signature].remedy?.outcome, 'started', 'the attempt is written before the mutation runs'); return new Promise<StepStallRemedyOutcome>(() => {}); };
  void S.remedyStalledSteps(loop, dying, clock, persist);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(runs, 1);
  // The restart reads the cursor written before the mutation.
  const restarted = JSON.parse(cursor) as DaemonState;
  const applied = await S.remedyStalledSteps(restarted, async () => { runs += 1; return { outcome: 'applied', verified: true, detail: 'renewed again' }; }, tick(60_000), persist);
  assert.deepEqual(applied, [], 'a run whose attempt was started is never remedied again');
  assert.equal(runs, 1);
  const stall = restarted.stepStalls[signature];
  assert.ok(S.stallNeedsMaster(stall), 'an attempt that never reported wakes the master session');
  assert.match(S.stallWakeTask(stall, '/outside/graphyard.mjs'), /remedy was started once at .* and never reported/);
  // A write that fails applies nothing: the run stays unremedied for the next cycle.
  const other = state();
  for (const cycle of [1, 2, 3]) S.noteStepFailure(other, 'dispatch', 'Graphyard refused /api/work (401): unauthorized', tick(60_000), cycle);
  const refusedWrite = await S.remedyStalledSteps(other, async () => { runs += 1; return { outcome: 'applied', verified: true, detail: 'renewed' }; }, clock, async () => { throw new Error('disk full'); });
  assert.deepEqual(refusedWrite, []);
  assert.equal(runs, 1, 'no mutation runs before its attempt is durable');
  assert.equal(Object.values(other.stepStalls)[0].remedy, null);
});

test('unit:stall-sync-admission-durable — a call that fails synchronously is made only once its admitted window is on the cursor, so a write that fails or a process ending before it admits nothing more', async () => {
  const { S } = await load();
  const loop = state();
  let calls = 0, release: (() => void) | null = null, refuse = false;
  const writes: string[] = [];
  const persist = (written: DaemonState) => { writes.push(JSON.stringify(written.stepStalls)); return refuse ? Promise.reject(new Error('disk full')) : new Promise<void>(resolve => { release = resolve; }); };
  const held = S.stallHeldEffects({ agents: () => { calls += 1; throw new Error('EACCES'); } } as unknown as DaemonEffects, () => loop, () => clock, persist);
  const failed = (detail: string) => [{ kind: 'session' as const, state: 'failed' as const, detail }];
  const cycle = (index: number) => { try { held.agents!(); } catch (error) { S.noteCycleStalls(loop, failed(`Session listing failed: ${(error as Error).message}`), index, clock); } };
  for (const index of [1, 2, 3]) { tick(60_000); cycle(index); }
  assert.equal(calls, 3);
  const signature = Object.keys(loop.stepStalls)[0];
  // Past the window the admitting invocation answers the hold while the window is written: nothing is made yet.
  tick(S.stallBackoffMs); cycle(4);
  assert.equal(calls, 3, 'the admission is not acted on before it is durable');
  assert.equal(writes.length, 1);
  const admitted = loop.stepStalls[signature].attemptAt;
  assert.ok(admitted && (JSON.parse(writes[0]) as Record<string, { attemptAt: string }>)[signature].attemptAt === admitted, 'the write carries the armed window');
  // A restart before the write lands would read the old cursor and admit once — the old process made no call, so the window has one attempt.
  tick(60_000); cycle(5);
  assert.equal(calls, 3, 'still not made while the write is in flight');
  release!(); await new Promise(resolve => setImmediate(resolve));
  tick(60_000); cycle(6);
  assert.equal(calls, 4, 'once the window is on the cursor the call is made once');
  tick(60_000); cycle(7);
  assert.equal(calls, 4, 'and only once per window');
  // A write that fails admits nothing for that window.
  refuse = true;
  tick(S.stallBackoffMs); cycle(8);
  await new Promise(resolve => setImmediate(resolve));
  for (const index of [9, 10, 11]) { tick(60_000); cycle(index); }
  assert.equal(calls, 4, 'a refused write leaves the call held until the window passes');
});

test('unit:stall-kept-while-admitted-attempt-runs — a launch admitted by a standing stall that runs past its window keeps the stall and its remedy until it settles, and its failure counts on the same run', async () => {
  const { S } = await load();
  const loop = state();
  for (const cycle of [1, 2, 3]) S.noteStepFailure(loop, 'dispatch', 'Graphyard refused /api/work (401): unauthorized', tick(60_000), cycle);
  const signature = Object.keys(loop.stepStalls)[0];
  await S.remedyStalledSteps(loop, async () => ({ outcome: 'applied', verified: true, detail: 'renewed' }), clock);
  tick(S.stallBackoffMs);
  assert.equal(S.admitStalledCall(loop, 'dispatch', clock).hold, null, 'past the window the launch is admitted');
  // The admitted launch runs beside the loop for twelve minutes: every cycle meanwhile is quiet.
  for (let cycle = 4; cycle < 16; cycle++) S.noteCycleStalls(loop, [], cycle, tick(60_000));
  const standing = loop.stepStalls[signature];
  assert.ok(standing?.stalledAt, 'the stall stands while its admitted attempt has not settled');
  assert.equal(standing.remedy?.outcome, 'applied', 'its one remedy is kept');
  // The launch fails: the same run counts on, never forming a second stall or remedy.
  const note = S.noteCycleStalls(loop, [{ kind: 'dispatch', state: 'failed', detail: 'Graphyard refused /api/work (401): unauthorized' }], 16, tick(60_000)).notes[0];
  assert.equal(note.stalled, false, 'no second stall is recorded');
  assert.equal(note.run.count, 4);
  assert.deepEqual(await S.remedyStalledSteps(loop, async () => { throw new Error('applied twice'); }, clock), []);
});

test('unit:stall-signature-overflow-invocations-held — ten panes sharing one signature from one effect are all held after the third cycle, every invocation past the eighth included, and the record stays within its bound', async () => {
  const { S } = await load();
  const { stepStallSchema } = await import('../src/daemon/state.js');
  const loop = state();
  // Ten distinct panes fail the one effect with the same normalised refusal: the text names no
  // pane, so every invocation signs the same and the run is shared by more than the list names.
  const panes = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
  const prompted: string[] = [];
  const held = S.stallHeldEffects({ promptSession: async (agent: { pane_id: string }) => { prompted.push(agent.pane_id); throw new Error('the pane session is gone'); } } as unknown as DaemonEffects, () => loop, () => clock,
    async written => { for (const run of Object.values(written.stepStalls)) stepStallSchema.parse(run); });
  const cycle = async (index: number) => {
    const actions: { kind: 'wake'; state: 'failed' | 'done'; detail: string }[] = [];
    for (const pane of panes) {
      try { await held.promptSession!({ pane_id: pane } as never, 'wake'); actions.push({ kind: 'wake', state: 'done', detail: `woke ${pane}` }); }
      catch (error) { actions.push({ kind: 'wake', state: 'failed', detail: `The wake was not delivered: ${(error as Error).message}` }); }
    }
    return S.noteCycleStalls(loop, actions, index, clock);
  };
  const made = (pane: string) => prompted.filter(entry => entry === pane).length;
  for (const index of [1, 2, 3]) { tick(60_000); await cycle(index); }
  const signature = Object.keys(loop.stepStalls)[0];
  assert.ok(loop.stepStalls[signature].stalledAt, 'three consecutive cycles are one stall');
  // The ten invocations outgrew the bound the list names: the hold is the call's own, one entry
  // naming no resource, so the ninth and tenth are held by the same stall the first eight are.
  assert.deepEqual(loop.stepStalls[signature].calls, [{ call: 'promptSession', async: true, resource: null }]);
  // After the third cycle every pane is held, the ninth and tenth included: nothing is invoked
  // again before the five-minute backoff elapses.
  for (const index of [4, 5, 6, 7]) { tick(60_000); await cycle(index); }
  assert.deepEqual(panes.map(made), [3, 3, 3, 3, 3, 3, 3, 3, 3, 3], 'no pane, the ninth and tenth included, is invoked again inside the window');
  assert.equal(loop.stepStalls[signature].count, 3, 'a held cycle counts nothing');
  // Past the window exactly one invocation of the call is admitted; the other nine, the overflow
  // past the eighth included, wait out the window its admission armed.
  tick(S.stallBackoffMs + 1); await cycle(8);
  assert.deepEqual(panes.map(made), [4, 3, 3, 3, 3, 3, 3, 3, 3, 3], 'past the window one invocation of the call is made, once');
  tick(60_000); await cycle(9);
  assert.deepEqual(panes.map(made), [4, 3, 3, 3, 3, 3, 3, 3, 3, 3], 'the admission arms the next window: the rest stay held');
  // Every persisted record the writes carried stayed within the schema's bound.
  for (const run of Object.values(loop.stepStalls)) assert.equal(stepStallSchema.parse(run).calls.length, 1);
});

test('unit:stall-signature-overflow-records-once — twelve items sharing one signature still record one stall at three cycles, apply its bound remedy once and wake the master once, exactly as eight do', async () => {
  const { S } = await load();
  const failed = (item: string): { kind: 'dispatch'; state: 'failed'; detail: string } =>
    ({ kind: 'dispatch', state: 'failed', detail: `Dispatch of ${item} to worker-a failed: the control plane answered HTTP 401 for ${item} epoch 1` });
  const sharing = (items: string[]) => {
    const loop = state();
    for (const cycle of [1, 2]) S.noteCycleStalls(loop, items.map(failed), cycle, tick(60_000));
    const third = S.noteCycleStalls(loop, items.map(failed), 3, tick(60_000));
    return { loop, third, signature: Object.keys(loop.stepStalls)[0] };
  };
  const eight = sharing(['GY-1', 'GY-2', 'GY-3', 'GY-4', 'GY-5', 'GY-6', 'GY-7', 'GY-8']);
  const twelve = sharing(['GY-1', 'GY-2', 'GY-3', 'GY-4', 'GY-5', 'GY-6', 'GY-7', 'GY-8', 'GY-9', 'GY-10', 'GY-11', 'GY-12']);
  // Every resource is noted, but the shared signature is one run, and its stall is recorded once,
  // at the third cycle, bound to the same remedy — exactly as with eight or fewer.
  for (const one of [eight, twelve]) {
    assert.equal(Object.keys(one.loop.stepStalls).length, 1, 'one run for the one shared signature');
    assert.equal(one.third.notes.filter(note => note.stalled).length, 1, 'the stall is recorded once, at the third cycle');
    assert.equal(one.loop.stepStalls[one.signature].count, 3);
    assert.equal(one.third.notes[0].bound?.kind, 'credential-401', 'the stall binds its remedy');
  }
  assert.equal(eight.third.notes.length, 8);
  assert.equal(twelve.third.notes.length, 12, 'every sharing resource is noted, and still only one stall');
  // Its bound remedy is applied once: one attempt for the whole shared signature, never per
  // resource, and the second sweep applies nothing.
  let attempts = 0;
  const runner = async (): Promise<StepStallRemedyOutcome> => { attempts += 1; return { outcome: 'refused' as const, verified: false, detail: 'outside the loop\'s authority' }; };
  assert.equal((await S.remedyStalledSteps(eight.loop, runner, tick(1))).length, 1);
  assert.equal((await S.remedyStalledSteps(twelve.loop, runner, tick(1))).length, 1);
  assert.equal(attempts, 2, 'one attempt per run');
  assert.deepEqual(await S.remedyStalledSteps(eight.loop, runner, tick(1)), [], 'the second sweep applies nothing');
  assert.deepEqual(await S.remedyStalledSteps(twelve.loop, runner, tick(1)), []);
  assert.equal(attempts, 2);
  // A refused remedy wakes the master session once, with the one signature as the subject.
  for (const one of [eight, twelve]) {
    const subjects = S.stallWakeSubjects(one.loop, 'graphyard.mjs');
    assert.equal(subjects.length, 1, 'one wake for the shared signature');
    assert.equal(subjects[0].key, S.stallSubjectKey(one.signature));
    assert.match(subjects[0].detail, /dispatch call failed with one signature on 3 consecutive cycles/);
  }
});
