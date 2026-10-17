import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masterConfigSchema, DispatchReservedError } from '../src/master.js';
import { emptyDaemonState } from '../src/master-daemon.js';
import type { DaemonState } from '../src/daemon/state.js';
import { isStallHold, noteCycleStalls, noteStepFailure, noteStepsSucceeded, remedyStalledSteps, retainedStepStalls, stallBackoffMs, stallCycleBound, stallHold, stallHoldMarker, stallSignature, stallSignatureMax, stallSubjectKey, stallWakeSubjects, stallWakeTask } from '../src/daemon/step-stalls.js';
import type { MergerMode } from '../src/merger-mode.js';
import { cycleFailureCeilingMs } from '../src/daemon/liveness.js';
import { applyStepStallRemedy, stepStallRemedy, stepStallRemedyRegistry, type StepStallRemedyOutcome } from '../src/stall-remedies.js';
import { mergeLedgerAdoption, profileRemedyOutcome, stallHeldEffects, stallRemedyRunner } from '../src/daemon/run.js';
import type { DaemonEffects } from '../src/daemon/effects.js';

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
  // A long all-digit run is a number, never a commit id: a millisecond count signs N like any number.
  assert.equal(stallSignature('dispatch', 'the read took 1734567890123ms and failed'), 'dispatch: the read took Nms and failed');
  assert.notEqual(stallSignature('dispatch', 'unable to read a37b4c1'), stallSignature('dispatch', 'unable to read 1234567'), 'a hex id and a digit run of the same length sign differently');
});

test('unit:stall-remedy-registry — the three seen signatures bind their remedies, and nothing else binds', async () => {
  assert.equal(stepStallRemedyRegistry.length, 3);
  const profile = stepStallRemedy(stallSignature('dispatch', 'launch profile worker-x is not a configured agent environment; run master environments --apply'));
  assert.equal(profile?.kind, 'profile-unknown');
  assert.match(profile!.remedy, /master environments --apply/);
  const credential = stepStallRemedy(stallSignature('dispatch', 'the control plane answered HTTP 401: credential not valid'));
  assert.equal(credential?.kind, 'credential-401');
  assert.match(credential!.remedy, /bootstrap path/);
  const ledger = stepStallRemedy(stallSignature('merge', 'Merge of GY-7 head aabbcc was refused a record key reused with different input; that key is never sent again'));
  assert.equal(ledger?.kind, 'merge-record-idempotency');
  assert.match(ledger!.remedy, /adopt the server's merge ledger/);
  // The same refusal raised by any other module — delegation, agent registry, proof grants,
  // delivery — is no merge-writer stall: it binds nothing and wakes the master.
  assert.equal(stepStallRemedy(stallSignature('delegation', 'Graphyard refused delegation (409): Idempotency key reused with different input')), null, 'a non-merge step never runs the merge-writer remedy');
  assert.equal(stepStallRemedy(stallSignature('delivery', 'Idempotency key reused with different input')), null);
  assert.equal(stepStallRemedy(stallSignature('snapshot', 'the control plane timed out after 5000ms')), null);
  // A throw from the port is a recorded refusal, never a crash of the step that applied it.
  const refused = await applyStepStallRemedy('credential-401', async () => { throw new Error('no port'); });
  assert.deepEqual(refused, { outcome: 'refused', verified: false, detail: 'credential-401 remedy was refused: no port' });
});

test('unit:loop-step-stall-remedied — three consecutive cycles with one signature are one stall, its bound remedy is applied once and verified, and a clean cycle ends the run', async () => {
  const loop = state();
  const failing = { kind: 'dispatch', state: 'failed', detail: 'Worker launch failed: no push credential could be minted for GY-42 epoch 7 (HTTP 401)' } as const;
  // Two cycles failing the same way are not a stall yet.
  assert.equal(noteCycleStalls(loop, [failing], 1, tick(1)).notes.length, 1);
  assert.equal(noteCycleStalls(loop, [failing], 2, tick(1)).notes.length, 1);
  const runs = Object.values(loop.stepStalls);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].stalledAt, null);
  // The third consecutive cycle records one stall, bound to the 401 credential remedy.
  const third = noteCycleStalls(loop, [failing], 3, tick(1));
  assert.equal(third.notes.length, 1);
  assert.equal(third.notes[0].stalled, true, 'the third consecutive cycle is the one stall');
  assert.equal(third.notes[0].bound?.kind, 'credential-401');
  const run = Object.values(loop.stepStalls)[0];
  assert.ok(run.stalledAt);
  // A fourth failure records no second stall.
  assert.equal(noteCycleStalls(loop, [failing], 4, tick(1)).notes[0].stalled, false);

  // Its remedy is applied once and verified, and applied nothing the second sweep.
  let attempts = 0;
  const runner = async (): Promise<StepStallRemedyOutcome> => { attempts += 1; return { outcome: 'applied', verified: true, detail: 'the fresh credential authenticates' }; };
  const applied = await remedyStalledSteps(loop, runner, tick(1));
  assert.equal(applied.length, 1);
  assert.deepEqual(applied[0].record, { kind: 'credential-401', at: new Date(clock).toISOString(), outcome: 'applied', verified: true, detail: 'the fresh credential authenticates' });
  assert.deepEqual(await remedyStalledSteps(loop, runner, tick(1)), [], 'one attempt per run: the second sweep applies nothing');
  assert.equal(attempts, 1);
  assert.equal(Object.values(loop.stepStalls)[0].remedy?.verified, true);

  // One clean cycle inside the window is the hold working, not the fault clearing: the standing
  // run is kept, and the window's expiry plus a quiet cycle is what ends it.
  assert.deepEqual(noteCycleStalls(loop, [], 5, tick(1)), { notes: [], cleared: 0 }, 'a quiet cycle inside the window keeps the stall the loop is holding');
  assert.deepEqual(noteCycleStalls(loop, [], 6, tick(stallBackoffMs + 1)), { notes: [], cleared: 1 }, 'a quiet cycle past the window ends the run, its stall and its remedy');
  assert.equal(Object.keys(loop.stepStalls).length, 0);
  for (const cycle of [6, 7]) noteCycleStalls(loop, [failing], cycle, tick(1));
  assert.equal(Object.values(loop.stepStalls)[0].stalledAt, null);
  assert.equal(noteCycleStalls(loop, [failing], 8, tick(1)).notes[0].stalled, true, 'a new run stalls on its own three cycles');
});

test('unit:stall-counts-one-failure-per-cycle — several actions of one signature in a cycle are that cycle\u2019s one failure, a gap restarts the run, and alternating failed-cycle causes never accumulate', () => {
  const loop = state();
  const failed = (key: string): { kind: 'dispatch'; state: 'failed'; detail: string } =>
    ({ kind: 'dispatch', state: 'failed', detail: `Dispatch of ${key} to worker-a failed: the control plane answered HTTP 401 for ${key} epoch 1` });
  // Three affected work items in ONE cycle sign one signature and count one failure, not three.
  const one = noteCycleStalls(loop, [failed('GY-1'), failed('GY-2'), failed('GY-3')], 1, tick(1));
  assert.equal(one.notes.length, 3, 'every action is noted');
  assert.equal(one.notes.every(note => note.counted === (note === one.notes[0])), true, 'only the first note of the cycle counts');
  assert.equal(Object.values(loop.stepStalls)[0].count, 1, 'one cycle, one failure');
  assert.equal(Object.values(loop.stepStalls)[0].stalledAt, null, 'three items in one cycle are not three cycles');
  for (const cycle of [2, 3]) noteCycleStalls(loop, [failed('GY-1'), failed('GY-2')], cycle, tick(1));
  assert.equal(Object.values(loop.stepStalls)[0].count, 3);
  assert.ok(Object.values(loop.stepStalls)[0].stalledAt, 'three consecutive cycles with the signature are one stall, however many items failed each');

  // A cycle that ends without the step failing ends the run; a later failure starts a new run that
  // carries neither the stall nor its applied remedy.
  const remedied = Object.values(loop.stepStalls)[0];
  remedied.remedy = { kind: 'credential-401', at: new Date(clock).toISOString(), outcome: 'applied', verified: true, detail: 're-issued once' };
  assert.equal(noteStepsSucceeded(loop, 4), 1, 'the clean cycle clears the run');
  const fresh = noteStepFailure(loop, 'dispatch', failed('GY-1').detail, tick(1), 9);
  assert.equal(fresh.run.count, 1);
  assert.equal(fresh.run.remedy, null, 'a new run applies its own remedy');
  assert.equal(fresh.run.stalledAt, null);

  // Alternating whole-cycle failures — one call failing on even cycles, another on odd ones —
  // never reach the bound: a failed cycle ends the runs of the calls it did not fail in, exactly
  // as the loop's failed-cycle branch records them (note the failing call, then end the rest).
  const alternated = state();
  const snapshotFailure = 'the control plane timed out after 5000ms', mergeFailure = 'the merge record was refused';
  const first = noteStepFailure(alternated, 'snapshot', snapshotFailure, tick(1), 1);
  noteStepsSucceeded(alternated, 1);
  const second = noteStepFailure(alternated, 'merge', mergeFailure, tick(1), 2);
  noteStepsSucceeded(alternated, 2);
  const againFirst = noteStepFailure(alternated, 'snapshot', snapshotFailure, tick(1), 3);
  noteStepsSucceeded(alternated, 3);
  const fourthFirst = noteStepFailure(alternated, 'snapshot', snapshotFailure, tick(1), 4);
  noteStepsSucceeded(alternated, 4);
  const thirdFirst = noteStepFailure(alternated, 'merge', mergeFailure, tick(1), 5);
  noteStepsSucceeded(alternated, 5);
  assert.equal(first.run.count, 1);
  assert.equal(second.run.count, 1);
  assert.equal(againFirst.run.count, 1, 'the snapshot run was ended by the cycle that failed in merge');
  assert.equal(fourthFirst.run.count, 2, 'two consecutive cycles with one call count two failures');
  assert.equal(thirdFirst.run.count, 1, 'a fresh merge run starts at one after the snapshot cycles ended it');
  assert.ok(!Object.values(alternated.stepStalls).some(run => run.stalledAt), 'alternating causes never record a stall');
});

test('unit:loop-step-stall-unbound-wakes-master — an unbound stall and a refused remedy wake the master session with the signature, step and stall as the task, once per run', async () => {
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
  assert.match(task, /refresh call failed with one signature on 3 consecutive cycles/);
  assert.match(task, /stands stalled since/);
  assert.match(task, /Signature: refresh: the control plane timed out after Nms/);
  assert.match(task, /master status/);
  // The task is stable while the run stands: the digest machinery wakes the session once per run,
  // never again per backed-off attempt of the standing stall, so the live count stays out of it.
  noteCycleStalls(loop, [failing], 4, tick(1));
  assert.equal(stallWakeSubjects(loop, 'graphyard.mjs')[0].detail, task, 'a backed-off reattempt of the standing stall changes no wake');

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
  // The refused-remedy task is stable too: the standing stall never re-wakes per cycle.
  const refusedTask = woken[0].detail;
  for (const cycle of [4, 5]) noteCycleStalls(held, [credential], cycle, tick(stallBackoffMs + 1));
  assert.equal(stallWakeSubjects(held, 'graphyard.mjs')[0].detail, refusedTask, 'the count and the last error stay on the cursor, out of the wake');
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

  // The hold the owning steps consult: inside the window the call is held, past it the call is due.
  const inside = stallHold(loop, 'dispatch', clock + 1_000);
  assert.ok(inside, 'the stall holds its call inside the window');
  assert.equal(inside!.step, 'dispatch');
  assert.equal(inside!.until, Date.parse(third.run.nextAttemptAt!));
  assert.match(inside!.reason, new RegExp(stallHoldMarker));
  assert.match(inside!.reason, /attempted again at/);
  assert.equal(stallHold(loop, 'merge', clock + 1_000), null, 'another step\u2019s stall holds only its own call');
  assert.equal(stallHold(loop, 'dispatch', clock + stallBackoffMs), null, 'past the window the call is due again');

  // A failure inside the window is that window's one attempt still failing: the count stands.
  const counted = noteStepFailure(loop, 'dispatch', failing, clock + 1_000, 4);
  assert.equal(counted.counted, false, 'a failure inside the window does not advance the run');
  assert.equal(counted.run.count, stallCycleBound);
  assert.equal(counted.run.lastError, failing, 'the window keeps the run truthful about its last error');
  assert.equal(Date.parse(counted.run.nextAttemptAt!), Date.parse(third.run.nextAttemptAt!), 'the window itself does not move');

  // Past the window the call is attempted again: the count advances and the window re-arms.
  const later = noteStepFailure(loop, 'dispatch', failing, clock + stallBackoffMs, 5);
  assert.equal(later.counted, true);
  assert.equal(later.run.count, stallCycleBound + 1);
  assert.equal(Math.abs(Date.parse(later.run.nextAttemptAt!) - (clock + 2 * stallBackoffMs)), 0);

  // The hold answer is the tracker speaking, never a fault to count: a hold text is noted as nothing.
  const holdText = `${stallHoldMarker}: the dispatch call stands stalled and is attempted again later`;
  assert.equal(isStallHold(holdText), true);
  assert.equal(isStallHold(failing), false);
  const held = noteStepFailure(loop, 'dispatch', holdText, clock + stallBackoffMs + 60_000, 6);
  assert.equal(held.counted, false);
  assert.equal(held.stalled, false);
  assert.equal(Object.values(loop.stepStalls)[0].count, stallCycleBound + 1, 'the hold moved no count');
  const heldCycle = noteCycleStalls(loop, [{ kind: 'dispatch', state: 'failed', detail: `Dispatch of GY-7 to worker-a failed: ${holdText}` }], 5, tick(1));
  assert.deepEqual(heldCycle, { notes: [], cleared: 0 }, 'a cycle\u2019s hold answers are not noted as failures, and the standing run is kept');
});

test('unit:held-effects-gate-the-call — while a step\u2019s stall stands inside its window the owning call is not attempted: the dispatcher\u2019s launch is refused before any claim, the merge writer starts no new merge, and past the window each is due again', async () => {
  const loop = state();
  const failing = 'Graphyard refused /api/work/work-7/claim (502): upstream unavailable';
  for (const attempt of [1, 2, 3]) noteStepFailure(loop, 'dispatch', failing, tick(attempt), attempt);
  const mergeFail = 'Merge of GY-7 head ' + 'a'.repeat(40) + ' failed before it was recorded';
  for (const attempt of [1, 2, 3]) noteStepFailure(loop, 'merge', mergeFail, tick(attempt), attempt);
  const now = () => clock;

  let dispatches = 0, mergers = 0;
  const effects = {
    dispatch: async () => { dispatches += 1; return {}; },
    mergeWriter: { merger: async (): Promise<MergerMode> => { mergers += 1; return 'control-plane'; } },
  } as unknown as DaemonEffects;
  const held = stallHeldEffects(effects, () => loop, now);
  assert.notEqual(held.dispatch, (effects as { dispatch?: unknown }).dispatch, 'the dispatch port is wrapped');

  // Inside the window: the launch is refused cleanly, as a dispatch another dispatcher holds is —
  // the item is the held resource, the marker is carried, and the raw port is never invoked.
  const work = { key: 'GY-7' } as never;
  const refusal = await held.dispatch!(work, {} as never, [] as never, {} as never).then(() => null, error => error as DispatchReservedError);
  assert.ok(refusal instanceof DispatchReservedError);
  assert.equal(refusal!.resource, 'work');
  assert.match(refusal!.message, new RegExp(stallHoldMarker));
  assert.equal(dispatches, 0, 'the call itself was not attempted inside the window');
  assert.equal(await held.mergeWriter!.merger(), 'github', 'the merge writer starts no new merge inside the window');
  assert.equal(mergers, 0, 'the recorded merger is not even read while held');

  // Other effects pass through untouched.
  assert.equal(held.snapshot, (effects as { snapshot?: unknown }).snapshot);

  // Past the window: both calls are due, and the ports read as themselves again.
  clock += stallBackoffMs + 1;
  await held.dispatch!(work, {} as never, [] as never, {} as never);
  assert.equal(dispatches, 1, 'past the window the call is attempted');
  assert.equal(await held.mergeWriter!.merger(), 'control-plane');
  assert.equal(mergers, 1);

  // A loop wired without the ports is held nothing: the wrap is transparent.
  const bare = stallHeldEffects({} as DaemonEffects, () => loop, now);
  assert.equal(bare.dispatch, undefined);
  assert.equal(bare.mergeWriter, undefined);
});

test('unit:stall-remedy-ports — the profile write is judged from its report, and the ledger adoption adopts the server fold, clears only the refused attempt\u2019s own marker, and verifies a fresh key', () => {
  assert.deepEqual(profileRemedyOutcome({ applied: true, profiles: [{ role: 'worker', profile: 'a', action: 'added' }], skipped: [], next: 'Profiles use the 1 logged-in environment(s)' }),
    { outcome: 'applied', verified: true, detail: '1 profile change(s) written: Profiles use the 1 logged-in environment(s)' });
  const skipped = profileRemedyOutcome({ applied: true, profiles: [{ role: 'worker', profile: 'a', action: 'added' }], skipped: [{ reason: 'authenticates no role, not worker' }], next: 'x' });
  assert.equal(skipped.verified, false, 'a credential skipped unread is unverified');
  assert.match(skipped.detail, /1 credential\(s\) skipped/);
  assert.equal(profileRemedyOutcome({ applied: true, profiles: [], next: 'x' }).outcome, 'unchanged');

  const refused = { key: 'GY-7', head: 'a'.repeat(40), at: new Date(clock).toISOString() };
  const markerAt = (startedAt: string) => ({ key: 'GY-7', id: 'id-7', head: 'a'.repeat(40), startedAt });

  // The refused attempt's own marker — the item and head it names, started before the refusal was
  // recorded — is the one stale marker the remedy clears.
  const loop = state();
  loop.mergeWriter.inFlight = markerAt(new Date(clock - 60_000).toISOString());
  const adoption = mergeLedgerAdoption(loop, [{ key: 'GY-7', id: 'id-7', mergeLedger: { events: 4 } }, { key: 'GY-8', id: 'id-8', mergeLedger: { events: 1 } }], refused);
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
  mergeLedgerAdoption(others, [{ key: 'GY-7', id: 'id-7', mergeLedger: { events: 4 } }], refused);
  assert.equal(others.mergeWriter.inFlight?.key, 'GY-9', 'another item\u2019s in-flight merge stands');
  const newer = state();
  newer.mergeWriter.inFlight = markerAt(new Date(clock + 60_000).toISOString());
  mergeLedgerAdoption(newer, [{ key: 'GY-7', id: 'id-7', mergeLedger: { events: 4 } }], refused);
  assert.equal(newer.mergeWriter.inFlight?.key, 'GY-7', 'a later attempt\u2019s in-flight marker stands');

  // A replay of the item\u2019s writes standing means the refused key could be sent once more: unverified.
  const replaying = state();
  replaying.mergeWriter.unconfirmed = [{ key: 'GY-7', id: 'id-7', attempt: 'attempt-1', write: 0, event: { kind: 'intent' }, sentAt: refused.at, replays: 1, lastError: 'the reply was lost' }];
  const unverified = mergeLedgerAdoption(replaying, [{ key: 'GY-7', id: 'id-7', mergeLedger: { events: 4 } }], refused);
  assert.equal(unverified.verified, false);
  assert.match(unverified.detail, /a replay of its writes still stands/);

  // An item the fold names nothing for is adopted unverified; no refused action to read refuses the remedy.
  const unread = mergeLedgerAdoption(state(), [{ key: 'GY-9', id: 'id-9', mergeLedger: { events: 2 } }], refused);
  assert.equal(unread.outcome, 'applied');
  assert.equal(unread.verified, false, 'an item the fold names nothing for is adopted unverified');
  const nothing = mergeLedgerAdoption(state(), [], null);
  assert.equal(nothing.outcome, 'refused');
  assert.match(nothing.detail, /No failed merge action carrying a reused record key/);
});

test('unit:stall-runner-finds-the-refused-merge — the loop\u2019s ports read the refused attempt from the newest failed merge action and refuse the credential kind', async () => {
  const loop = state();
  const head = 'a'.repeat(40);
  loop.actions['merge-writer:GY-7:' + head] = { kind: 'merge', work: 'GY-7', principal: null, state: 'failed',
    detail: `Merge of GY-7 head ${head} was refused a record key reused with different input; that key is never sent again: the item's merge ledger is adopted and the head is tried again under a new attempt id`,
    attempts: 1, epoch: null, cycle: 3, at: new Date(clock).toISOString() };
  loop.mergeWriter.inFlight = { key: 'GY-7', id: 'id-7', head, startedAt: new Date(clock - 60_000).toISOString() };
  const work = [{ key: 'GY-7', id: 'id-7', mergeLedger: { events: 4 } }];
  const runner = stallRemedyRunner(() => ({ url: 'http://localhost' }), () => loop, async () => ({ work, now: new Date(clock).toISOString() }) as never, () => '/outside');
  const outcome = await applyStepStallRemedy('merge-record-idempotency', runner);
  assert.equal(outcome.outcome, 'applied');
  assert.equal(outcome.verified, true);
  assert.equal(loop.mergeWriter.inFlight, null);
  assert.match(outcome.detail, /Adopted the server's merge ledger for GY-7/);

  // The credential kind the loop holds no port for is a recorded refusal naming the master session.
  const refusedKind = await applyStepStallRemedy('credential-401', stallRemedyRunner(() => ({ url: 'http://localhost' }), () => state(), snapshot, () => '/outside'));
  assert.equal(refusedKind.outcome, 'refused');
  assert.match(refusedKind.detail, /master session runs the install's bootstrap path/);
});

test('unit:stall-record-bounded — the cursor keeps the newest runs and drops what only a recovered history would read', () => {
  const loop = state();
  // Distinct causes spelled without digits: every number is normalised away, so only the words differ.
  for (let index = 0; index < retainedStepStalls + 10; index++) noteStepFailure(loop, 'dispatch', `cause ${'_'.repeat(index + 1)} of many`, tick(1), 1);
  assert.equal(Object.keys(loop.stepStalls).length, retainedStepStalls);
  assert.ok(!Object.keys(loop.stepStalls).some(signature => signature.includes('cause _ of many')), 'the oldest run is the first dropped');
  assert.ok(Object.keys(loop.stepStalls).some(signature => signature.includes(`cause ${'_'.repeat(retainedStepStalls + 10)} of many`)), 'the newest run is kept');
});
