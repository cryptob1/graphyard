import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDaemonState, runDaemon, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { retainedStepStalls, stallBackoffMs, stallCycleBound, stallSubjectKey, stallWakeSubjects } from '../src/daemon/step-stalls.js';
import { daemonSummary } from '../src/daemon/run.js';
import type { StepStallRemedyKind } from '../src/stall-remedies.js';
import type { Work } from '../src/model.js';
import type { HerdrAgent } from '../src/master/herdr.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { clearReviewerProfileRefusal, readReviewerProfileRefusal, recordReviewerProfileRefusal, reviewerProfileRefusalLimit, reviewerProfileRetryMs } from '../src/reviewer.js';

// GY-1854 over simulated days. The real loop (runDaemon, cycling on its own wake, its chosen wait
// pacing the driver's simulated clock) runs two days whose every cycle repeats the same failing
// call, because the stall step and the stall wake run every cycle: one day the dispatcher's launch
// fails the same plane-wide refusal on every attempt, and one day the merge writer's record write
// is refused as a reused idempotency key on every attempt — the stall whose bound remedy is the
// loop's own ledger adoption. After every cycle every system invariant holds, no step fails beyond
// the day's scripted one, and across each day:
//
// - the day records exactly one stall, once — never a second record while it stands — and the
//   cursor's stepStalls stay bounded (one row, far under the retained bound);
// - the failing call is attempted at most once per five minutes while the stall stands: the
//   dispatcher's launch is refused before any claim and the merge writer starts no new merge
//   inside the window;
// - the bound remedy is applied exactly once for the run and verified;
// - the master session is woken for the stall once per run, never once per cycle and never again
//   per backed-off attempt, and nothing records the hold's own answer as a failure;
// - an admitted call reads its own admission on the cursor: the window it armed is written before
//   the call is made, so a restart from that boundary holds the call rather than repeating it.
//
// Two more days fail at the cycle's own credential read, before the master-session step ever
// runs: one the same unbound way every cycle, one with a 401 whose remedy the loop refuses because
// the refused credential is the coordinator's. Each wakes the master once, beside the failed
// cycles, and retries the read once per five minutes.

const minute = 60_000, hour = 60 * minute, interval = 2 * minute, dayMs = Number(process.env.SOAK_DAY_MS ?? 8 * hour);
const start = Date.parse('2026-10-15T00:00:00.000Z');
const head = 'a'.repeat(40), baseTip = 'b'.repeat(40), mergeSha = 'c'.repeat(40);
const masterAgentName = 'graphyard-master-stalls';
const config = (files: { coordinator: string; worker: string } = { coordinator: '/outside/coordinator.token', worker: '/outside/worker-a.token' }): MasterConfig => masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: files.coordinator, cliPath: 'graphyard',
  repository: 'owner/project', baseBranch: 'main', githubAppId: 1234, hostId: 'soak-host', masterAgentName,
  workers: [{ name: 'worker-a', principal: 'worker-a', agentName: 'agent-worker-a', mode: 'launch', kind: 'claude', credentialFile: files.worker }],
  run: { intervalSeconds: interval / 1000, masterSessionMinutes: 720 } });

/** A claimable item the day never delivers, so its dispatch is offered on every cycle. */
const claimable = (now: number): Work => ({
  id: 'work-7', key: 'GY-7', title: 'Dispatch stall soak', description: '', type: 'feature', priority: 0, dependencies: [],
  criteria: [], policy: { checks: [], review: false }, plannedFiles: [],
  stage: 'ready', revision: 1, policyRevision: 1, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  stageEnteredAt: new Date(now).toISOString(), ready: true, epoch: 0,
  lease: null, workspaces: [], candidate: null, submission: null, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null, gates: [], violations: [],
} as unknown as Work);

/** A submitted candidate the day never merges, so the merge writer offers it on every cycle. */
const submitted = (now: number): Work => ({
  id: 'work-7', key: 'GY-7', title: 'Merge stall soak', description: '', type: 'feature', priority: 0, dependencies: [],
  criteria: [{ id: 'AC-1', text: 'Proven', proofs: ['unit:wait'] }], policy: { checks: ['test'], review: false }, plannedFiles: ['src/a.ts'],
  stage: 'test', revision: 2, policyRevision: 1, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  stageEnteredAt: new Date(now).toISOString(), ready: true, epoch: 1,
  lease: null, workspaces: [], submission: { epoch: 1, pr: 7 }, reworkRequested: false, scenarioRequirements: [], evidence: [], blocker: null,
  candidate: { sha: head, baseSha: baseTip, pr: 7, branch: 'graphyard/gy-7-1', author: 'implementer' },
  gates: [{ name: 'build', passed: true }, { name: 'review', passed: true }, { name: 'test', passed: true }], violations: [],
  observation: { candidate: { sha: head, baseSha: baseTip, pr: 7, branch: 'graphyard/gy-7-1', author: 'implementer' }, checks: [], reviews: [], protected: true, mergeable: true, merged: false, prState: 'open', draft: false, source: 'control-plane', at: new Date(now).toISOString(), baseTip, baseTree: 'tree', files: ['src/a.ts'], scopeFiles: [] },
  // The server's folded ledger the adoption reads back: four events, nothing open to reconcile.
  mergeLedger: { key: 'GY-7', state: 'refused', head, mergeSha, baseTip, risk: 'ordinary', intentAt: new Date(now).toISOString(), pushedAt: null, observedTip: null, refusal: { kind: 'merge', reason: 'earlier round', at: new Date(now).toISOString() }, events: 4 },
} as unknown as Work);

const masterSession = (): HerdrAgent => ({ name: masterAgentName, pane_id: 'pane-master', agent: 'claude', agent_status: 'idle' });

interface Day {
  cycles: number;
  launches: number[];
  landed: number[];
  reclaims: number[];
  credentialReads: number[];
  records: number[];
  prompts: string[];
  remedies: StepStallRemedyKind[];
  remedyHistory: string[];
  waits: number[];
  cursorStalls: string;
  cursorMergeWriter: string;
  logs: string[];
  /** The dispatcher's review launches the launch boundary refused for the unknown profile, and the ones that found it. */
  reviewRefusals: number[];
  reviewsLanded: number[];
  /** Each profile write the remedy made. */
  profileWrites: number[];
  state: DaemonState;
}

/**
 * One day of the real loop: runDaemon cycles on the simulated clock until the day is over, its own
 * chosen wait pacing each cycle through the wake the driver answers. The master session is adopted
 * from Herdr and woken through promptSession; `dispatch` answers for every launch attempt, the
 * merge writer's `record` for every record write, and `snapshot` for every cycle read — the merge
 * writer's read carrying the day's one submitted item, whose ledger the adoption reads back. Every
 * cursor write is kept, so the day can assert the bookkeeping a restart would read, and each
 * finished cycle is judged as it ends.
 */
async function runDay(options: { dispatchFailure?: string; mergeRecordFailure?: string; withMergeWriter?: boolean; reclaimFailure?: string;
  /** The day's credential read and launch answer by the worker's credential file: refused (401) until it holds the issued token. */
  credentials?: { coordinator: string; worker: string; good: string };
  /** The cycle's own credential read fails this way on every cycle from `after` milliseconds into the day: the cycle fails before its master-session step. */
  credentialFailure?: { text: string; after: number };
  /** The dispatcher beside the loop launches a review asking for this reviewer profile after every cycle; the profile remedy's write configures it when `writes`. */
  reviewerProfile?: { name: string; writes: boolean } }): Promise<Day> {
  const files = options.credentials ?? (options.reviewerProfile ? await (async () => {
    const directory = await temporaryDirectory('gy-1854-soak-reviewer-');
    return { coordinator: join(directory, 'coordinator.token'), worker: join(directory, 'worker-a.token') };
  })() : undefined);
  const dayConfig = () => config(files);
  const result: Day = { cycles: 0, launches: [], landed: [], reclaims: [], credentialReads: [], records: [], prompts: [], remedies: [], remedyHistory: [], waits: [], cursorStalls: 'null', cursorMergeWriter: 'null', logs: [], reviewRefusals: [], reviewsLanded: [], profileWrites: [], state: emptyDaemonState(dayConfig()) };
  // The reviewer profiles the day's configuration carries: the remedy's write adds the asked-for one when the day says it does.
  const reviewers: string[] = [];
  /**
   * One review launch of the dispatcher beside the loop, through the launch boundary's own record
   * (GY-1850): a configured profile launches and clears the record; an unknown one is refused and
   * counted — after three refusals in a row the boundary attempts it once per five minutes.
   */
  const launchReview = async () => {
    const profile = options.reviewerProfile!.name, at = now;
    if (reviewers.includes(profile)) { await clearReviewerProfileRefusal(dayConfig()); result.reviewsLanded.push(at - start); return; }
    const known = await readReviewerProfileRefusal(dayConfig());
    if (known && known.refusals >= reviewerProfileRefusalLimit && at - Date.parse(known.at) < reviewerProfileRetryMs) return;
    await recordReviewerProfileRefusal(dayConfig(), profile, at);
    result.reviewRefusals.push(at - start);
  };
  let now = start;
  let stop = () => {};
  const effects: DaemonEffects = {
    agents: () => [],
    herdr: () => ({ agents: [masterSession()], available: true }),
    masterSession: { launch: async () => { throw new Error('the day adopts its master session and never launches one'); }, adopt: async () => null },
    promptSession: async (_agent, text) => { result.prompts.push(text); },
    credentials: async profiles => {
      // The loop's own credential read every cycle: the plane refuses a stale worker credential (401), which fails the cycle at this call.
      result.credentialReads.push(now - start);
      if (options.credentialFailure && now - start >= options.credentialFailure.after) throw new Error(options.credentialFailure.text);
      if (options.credentials && (await readFile(options.credentials.worker, 'utf8')).trim() !== options.credentials.good) throw new Error('Graphyard refused /api/status for worker-a (401): credential not valid');
      return Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }]));
    },
    snapshot: async () => ({ work: [options.withMergeWriter ? submitted(now) : claimable(now)], now: new Date(now).toISOString() }),
    closeSession: () => {},
    dispatch: async (_work, profile) => {
      result.launches.push(now - start);
      // A launch a standing stall admitted reads its own admission on the cursor: the window it armed was written before the launch was made.
      const standing = Object.values(result.state.stepStalls).find(run => run.step === 'dispatch' && run.stalledAt);
      if (standing) assert.equal((JSON.parse(result.cursorStalls) as Record<string, { attemptAt: string | null }>)[standing.signature]?.attemptAt, standing.attemptAt, `the admission at +${Math.round((now - start) / minute)}min is on the cursor before the launch`);
      if (options.credentials && (await readFile(profile.credentialFile!, 'utf8')).trim() === options.credentials.good) { result.landed.push(now - start); return {}; }
      throw new Error(options.dispatchFailure ?? 'no dispatch was due');
    },
    ...(options.reclaimFailure ? { reclaim: async () => { result.reclaims.push(now - start); throw new Error(options.reclaimFailure); } } : {}),
    requestProof: () => {},
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: new Date(now).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {}, requestSmoke: () => {},
    ...(options.withMergeWriter ? {
      mergeWriter: {
        baseBranch: 'main', retrials: 1, now: () => now,
        fetch: async () => baseTip,
        merge: async () => ({ mergeSha, files: ['src/a.ts'] }),
        trial: async () => { throw new Error('the day\u2019s record is refused before any trial runs'); },
        push: async () => 'pushed' as const,
        holds: async () => false,
        record: async () => { result.records.push(now - start); throw new Error(options.mergeRecordFailure ?? 'Idempotency key reused with different input'); },
        merger: async () => 'control-plane' as const,
      },
    } : {}),
    persist: async state => {
      // The cursor slices the stall bookkeeping asserts read back, kept small: stringify only them.
      result.cursorStalls = JSON.stringify(state.stepStalls);
      result.cursorMergeWriter = JSON.stringify(state.mergeWriter);
    },
  };
  const runOptions = {
    intervalMs: interval, identity: { pid: process.pid, host: 'soak-host' }, now: () => now,
    log: (line: string) => result.logs.push(line),
    checkout: async () => ({ root: '/outside/repo', commit: 'c'.repeat(40), modified: [] as string[], untracked: [] as string[] }),
    checkoutRestore: async () => [],
    // The loop also listens for unhandledRejection and uncaughtException on this host: only the
    // stop signal's handler is the one the day's end calls.
    process: { on: (signal: string, handler: () => void) => { if (signal === 'SIGTERM') stop = handler; }, off: () => {} } as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
    // The profile remedy writes the day's profiles as master environments --apply would, and the configuration read back is the day's.
    stallProfiles: () => ({
      apply: async () => { result.profileWrites.push(now - start); if (options.reviewerProfile?.writes) reviewers.push(options.reviewerProfile.name); return { applied: true, profiles: [{ name: 'worker-a' }], skipped: [], next: 'wrote the worker and reviewer profiles from the logged-in environments' }; },
      configured: async () => ({ reviewers: reviewers.map(name => ({ name })) as MasterConfig['reviewers'] }),
    }),
    // A failed cycle's backoff is waited out on the same simulated clock.
    delay: async (wait: number) => { await runOptions.wake.sleep(wait); },
    wake: { sleep: async (wait: number) => {
      result.waits.push(wait);
      if (options.reviewerProfile) await launchReview();
      judge(`cycle at +${Math.round((now - start) / minute)}min`);
      // The remedy attempt the run carries is written once and never re-written: its record is
      // snapshotted each cycle, so a second application would show here as a change.
      result.remedyHistory.push(JSON.stringify(Object.values(result.state.stepStalls).map(run => run.remedy).filter(Boolean)));
      now += wait;
      if (now - start >= dayMs) stop();
      return ['soak-tick'];
    } },
  };
  const judge = (phase: string) => {
    if (process.env.SOAK_TRACE) console.error('SOAK cycle', result.cycles, phase, 'waits', result.waits.at(-1));
    result.cycles += 1;
    for (const check of result.state.invariants.report) assert.ok(check.holds, `${phase}: ${check.invariant} — ${check.reading}`);
    assert.deepEqual(Object.keys(result.state.actions).filter(key => key.startsWith('isolated:')), [], `${phase}: no step isolated a failure`);
    // The day's scripted failures are the only ones: the dispatch refusal, the merge record the
    // plane refuses as reused, and the one deployment line an unconfigured endpoint answers with.
    const scripted = (action: { kind: string; detail: string }) => action.kind === 'dispatch' || action.kind === 'merge' || (action.kind === 'reclaim' && !!options.reclaimFailure)
      || (action.kind === 'deployment' && /unverified: not configured/.test(action.detail));
    const failed = Object.values(result.state.actions).filter(action => action.state === 'failed' && !scripted(action));
    assert.deepEqual(failed.map(action => `${action.kind}: ${action.detail}`), [], `${phase}: no step but the day's scripted ones failed`);
  };
  now += interval;
  await runDaemon(dayConfig(), result.state, effects, runOptions);
  assert.ok(now - start >= dayMs - interval, `the day ran its hours (${Math.round((now - start) / hour)}h of ${dayMs / hour}h, ${result.cycles} cycles)`);
  if (process.env.SOAK_TRACE) {
    console.error('SOAK failures', JSON.stringify(result.state.failures.last), 'unhandled', result.state.failures.unhandled);
    for (const line of result.logs.filter(line => /failed/.test(line)).slice(0, 5)) console.error('SOAK LOG', line.slice(0, 220));
  }
  return result;
}

/** The stall the day recorded. */
const stallOf = (day: Day) => Object.values(day.state.stepStalls)[0];

test('unit:soak-step-stalls-dispatch-hold — a day of dispatches refused the same way: one stall, the launch attempted once per five minutes while it stands, the master woken once, every invariant holding', { timeout: 600_000 }, async () => {
  const result = await runDay({ dispatchFailure: 'Graphyard refused /api/work/work-7/claim (502): upstream unavailable' });
  const standing = stallOf(result);
  assert.ok(standing, 'the day recorded the stall');
  assert.equal(Object.keys(result.state.stepStalls).length, 1, 'one signature, one run, one stall — the record stays bounded');
  assert.match(standing.signature, /^dispatch: Dispatch of GY-N to worker-a failed: Graphyard refused .*upstream unavailable/, 'the run is signed by the step and the normalised refusal');
  assert.ok(standing.stalledAt, 'the run reached three consecutive cycles and stands stalled');

  // The launch is attempted on every cycle until the stall stands, and from the stall on it is
  // attempted only at whole windows: every gap between attempts is the five-minute window or more,
  // and never more than a window and a cycle.
  const stalledFrom = Date.parse(standing.stalledAt!) - start;
  const after = result.launches.filter(at => at >= stalledFrom);
  assert.ok(after.length >= 3, `the stalled call is attempted again after its window (${after.length} attempt(s))`);
  const gaps = after.slice(1).map((at, index) => at - after[index]);
  assert.ok(gaps.length > 0, 'the day runs several windows past the stall');
  assert.ok(gaps.every(gap => gap >= stallBackoffMs), `every attempt past the stall waits a full five-minute window: ${gaps.map(gap => Math.round(gap / minute)).join(', ')} min`);
  assert.ok(gaps.every(gap => gap < 2 * stallBackoffMs + interval), `the window is not overshot by more than a cycle: ${gaps.map(gap => Math.round(gap / minute)).join(', ')} min`);
  // Bounded: a stalled call is attempted once per window, not once per cycle — the day's launches
  // are a fraction of its cycles.
  assert.ok(result.cycles >= dayMs / minute, `the day cycled through its hours (${result.cycles} cycles)`);
  assert.ok(result.launches.length <= 4 + dayMs / stallBackoffMs, `${result.launches.length} launches over ${result.cycles} cycles is once per window, not once per cycle`);

  // The count grows only by the window's attempts: every launch but the day's last (whose failure
  // the day ends before the next cycle reports it) is the one failure of its window.
  assert.equal(standing.count, result.launches.length - 1);
  assert.ok(!Object.keys(result.state.actions).some(key => result.state.actions[key]!.state === 'failed' && /held to its five-minute window/.test(result.state.actions[key]!.detail)), 'no failed action records a hold');

  // The master session is woken for the unbound stall exactly once while it stands, by key, and
  // never again per backed-off attempt.
  const subject = stallSubjectKey(standing.signature);
  const stallWakes = result.prompts.filter(prompt => prompt.includes(subject));
  assert.equal(stallWakes.length, 1, `one wake per run: ${result.prompts.filter(prompt => prompt.includes('stall:')).length} stall prompt(s) over the day`);
  assert.match(stallWakes[0], /Changed subjects/);

  // No bound remedy applies to a plane-wide refusal, so none ran.
  assert.deepEqual(result.remedyHistory.filter(entry => entry !== '[]'), [], 'an unbound stall runs no remedy');

  // The bookkeeping the day moved is what a restart would read: the last cursor write carries the
  // standing stall exactly as the live state holds it.
  assert.deepEqual(JSON.parse(result.cursorStalls), result.state.stepStalls, 'the persisted stepStalls are the live ones');
  assert.ok(Object.keys(result.state.stepStalls).length <= retainedStepStalls);
});

test('unit:soak-step-stalls-remedy-once — a day of merge records refused as reused keys: the bound remedy is applied once and verified, the merge is started once per five minutes while the stall stands, the master is woken once, every invariant holding', { timeout: 600_000 }, async () => {
  const result = await runDay({ mergeRecordFailure: 'Idempotency key reused with different input', withMergeWriter: true });
  const standing = stallOf(result);
  assert.ok(standing, 'the day recorded the stall');
  assert.equal(Object.keys(result.state.stepStalls).length, 1, 'one signature, one run, one stall — the record stays bounded');
  assert.match(standing.signature, /^merge: Merge of GY-N head <sha> was refused a record key reused with different input/, 'the run is signed by the merge step and the writer\u2019s own wording');
  assert.ok(standing.stalledAt, 'the run reached three consecutive cycles and stands stalled');

  // The stall binds the loop's own ledger adoption, and the remedy is applied exactly once for
  // the run and verified against the ledger it read back — however many cycles follow.
  assert.equal(standing.remedy?.kind, 'merge-record-idempotency');
  assert.equal(standing.remedy?.outcome, 'applied');
  assert.equal(standing.remedy?.verified, true, 'the adoption verified against the folded ledger the snapshot carries');
  assert.ok(result.remedyHistory.some(entry => entry !== '[]'), 'the day carried a remedy attempt');
  assert.equal(new Set(result.remedyHistory.filter(entry => entry !== '[]')).size, 1, 'the remedy attempt is written once and never re-written over the day');

  // The merge is started on every cycle until the stall stands, and from the stall on only at
  // whole windows: the writer's admit answers false inside the window, so the refused
  // key is attempted once per five minutes.
  const stalledFrom = Date.parse(standing.stalledAt!) - start;
  const after = result.records.filter(at => at >= stalledFrom);
  assert.ok(after.length >= 3, `the stalled write is attempted again after its window (${after.length} attempt(s))`);
  const gaps = after.slice(1).map((at, index) => at - after[index]);
  assert.ok(gaps.length > 0, 'the day runs several windows past the stall');
  assert.ok(gaps.every(gap => gap >= stallBackoffMs), `every write past the stall waits a full five-minute window: ${gaps.map(gap => Math.round(gap / minute)).join(', ')} min`);
  assert.ok(result.records.length <= 4 + dayMs / stallBackoffMs, `${result.records.length} writes over ${result.cycles} cycles is once per window, not once per cycle`);

  // The count grows only by the window's attempts, and stays a truthful, bounded count.
  assert.ok(standing.count >= stallCycleBound, 'the run counted its three forming cycles');
  assert.ok(standing.count <= result.records.length, 'the run counts record attempts, never more');

  // A verified remedy that has stood through a second full run of failures wakes the master —
  // once per run, with the remedy's recorded outcome named, never once per cycle.
  const subject = stallSubjectKey(standing.signature);
  const stallWakes = result.prompts.filter(prompt => prompt.includes(subject));
  assert.ok(stallWakes.length >= 1, 'the standing stall reaches the master session');
  assert.equal(stallWakes.length, 1, `one wake per run: ${stallWakes.length} stall prompt(s) over the day`);
  assert.match(stallWakes[0], /Changed subjects/);
  // The task the wake names by key: the signature, the step and the remedy's one recorded outcome,
  // and master status serves the stall under that same key.
  const task = stallWakeSubjects(result.state, 'graphyard').find(entry => entry.key === subject)!;
  assert.match(task.detail, /merge-record-idempotency remedy was applied once/);
  assert.ok(task.detail.includes(standing.signature), 'the signature is the task');
  const served = daemonSummary(result.state, start + dayMs, interval).stepStalls.find(row => row.subject === subject);
  assert.equal(served?.needsMaster, true, 'master status serves the stall under the key the wake names');

  // The bookkeeping the day moved is what a restart would read.
  const stalls = JSON.parse(result.cursorStalls) as Record<string, { remedy: { verified: boolean } }>;
  assert.deepEqual(stalls, JSON.parse(JSON.stringify(result.state.stepStalls)), 'the persisted stepStalls are the live ones');
  assert.equal(stalls[Object.keys(stalls)[0]].remedy.verified, true, 'the remedy attempt survives the cursor write');
  const inFlight = JSON.parse(result.cursorMergeWriter) as { inFlight: { key: string; head: string } | null };
  assert.ok(inFlight.inFlight === null || (inFlight.inFlight.key === 'GY-7' && inFlight.inFlight.head === head), 'the in-flight row names the day\u2019s own merge, never a stale refused attempt');
});

test('unit:soak-step-stalls-call-hold — a day whose host reclaim throws the same six-character error every cycle: one stall, the reclaim call itself made at most once per five minutes while it stands, the master woken once, every invariant holding', { timeout: 600_000 }, async () => {
  // The failure is the bare errno: a text as short as a call can fail with still names its call.
  const result = await runDay({ reclaimFailure: 'EACCES' });
  const standing = Object.values(result.state.stepStalls).find(run => run.step === 'reclaim');
  assert.ok(standing?.stalledAt, 'the day recorded the reclaim stall');
  assert.equal(standing.signature, 'reclaim: Worktree reclamation failed: EACCES');
  assert.equal(Object.values(result.state.stepStalls).filter(run => run.step === 'reclaim').length, 1, 'one signature, one run, one stall');
  assert.deepEqual(standing.calls, [{ call: 'reclaim', async: true }], 'the stall holds the effect its failed rows carry, however short the failure text');
  // The call itself — not just its bookkeeping — is made once per window from the stall on.
  const stalledFrom = Date.parse(standing.stalledAt!) - start;
  const after = result.reclaims.filter(at => at >= stalledFrom);
  const gaps = after.slice(1).map((at, index) => at - after[index]);
  assert.ok(gaps.length >= 3, `the day runs several windows past the stall (${after.length} reclaim call(s))`);
  assert.ok(gaps.every(gap => gap >= stallBackoffMs), `every reclaim past the stall waits a full window: ${gaps.map(gap => Math.round(gap / minute)).join(', ')} min`);
  assert.ok(result.reclaims.length <= 4 + dayMs / stallBackoffMs, `${result.reclaims.length} reclaim calls over ${result.cycles} cycles is once per window, not once per cycle`);
  assert.ok(result.cycles > 2 * result.reclaims.length, 'the loop kept cycling between the held calls');
  // The held cycles count nothing: the count is the reclaims the run saw fail.
  assert.ok(standing.count <= result.reclaims.length, 'the run counts reclaim attempts, never held cycles');
  const subject = stallSubjectKey(standing.signature);
  assert.equal(result.prompts.filter(prompt => prompt.includes(subject)).length, 1, 'one master wake for the run');
  assert.deepEqual(JSON.parse(result.cursorStalls), JSON.parse(JSON.stringify(result.state.stepStalls)), 'the persisted stepStalls are the live ones');
});

/**
 * The install's credential files for a credential day — the coordinator's, the worker profile's
 * (stale) and the one the install issued for the worker — and the plane's /api/status, the one
 * port the production 401 remedy reads through: the issued worker token authenticates, the stale
 * one is 401, and the coordinator's token authenticates unless the day refuses it. The directory
 * is the shared helper's, removed after the file's tests whatever their outcome.
 */
async function credentialDay(options: { coordinatorRefused: boolean }, run: (files: { coordinator: string; worker: string; good: string }) => Promise<Day>): Promise<{ result: Day; files: { coordinator: string; worker: string; good: string }; statusReads: number }> {
  const home = await temporaryDirectory('gy-1854-soak');
  const coordinatorToken = 'c'.repeat(40), issued = 'w'.repeat(40), stale = 's'.repeat(40);
  for (const folder of ['master', 'workers', 'profile']) await mkdir(join(home, folder), { recursive: true });
  const files = { coordinator: join(home, 'master', 'coordinator.token'), worker: join(home, 'profile', 'worker-a.token'), good: issued };
  await writeFile(files.coordinator, `${coordinatorToken}\n`, { mode: 0o600 });
  await writeFile(join(home, 'workers', 'worker-a.token'), `${issued}\n`, { mode: 0o600 });
  await writeFile(files.worker, `${stale}\n`, { mode: 0o600 });
  const original = globalThis.fetch;
  let statusReads = 0;
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    if (!String(url).endsWith('/api/status')) throw new Error(`the day reads only /api/status, not ${url}`);
    statusReads += 1;
    const actors: Record<string, string> = { [issued]: 'worker-a', ...(options.coordinatorRefused ? {} : { [coordinatorToken]: 'master' }) };
    const actor = actors[(init?.headers?.Authorization ?? '').replace('Bearer ', '')];
    return actor ? new Response(JSON.stringify({ actor: { id: actor } }), { status: 200 }) : new Response('{}', { status: 401 });
  }) as typeof fetch;
  try { return { result: await run(files), files, statusReads }; }
  finally { globalThis.fetch = original; }
}

test('unit:soak-step-stalls-credential-renewed — a day whose worker credential the plane refuses (401): the production remedy renews it once from the credential the install issued, verifies it, the launch lands and the stall ends, the master never woken', { timeout: 600_000 }, async () => {
  const { result, files, statusReads } = await credentialDay({ coordinatorRefused: false }, files => runDay({ credentials: files }));
  {
    const stalls = result.remedyHistory.filter(entry => entry !== '[]');
    assert.ok(stalls.length, 'the day stalled and carried a remedy attempt');
    const [record] = JSON.parse(stalls[0]) as { kind: string; outcome: string; verified: boolean; detail: string }[];
    assert.equal(record.kind, 'credential-401');
    assert.equal(record.outcome, 'applied', record.detail);
    assert.equal(record.verified, true, record.detail);
    assert.match(record.detail, /Renewed worker-a from .*workers\/worker-a\.token/);
    assert.equal(new Set(stalls).size, 1, 'the remedy is written once and never re-applied');
    assert.ok(statusReads <= 6, `the remedy ran once: ${statusReads} status read(s)`);
    assert.equal((await readFile(files.worker, 'utf8')).trim(), files.good, 'the profile holds the renewed credential');
    // The renewed credential lands the launch, and the run ends — never re-formed.
    assert.ok(result.landed.length >= 1, 'a launch landed with the renewed credential');
    assert.equal(result.landed.length, result.launches.length, 'no launch was made with the refused credential: every one landed');
    // The credential read failed the cycle on exactly the three cycles that formed the stall; the renewal ended it.
    assert.equal(result.logs.filter(line => /failed in .*credential not valid/.test(line)).length, stallCycleBound, 'three failed cycles, then none');
    assert.deepEqual(result.state.stepStalls, {}, 'the stall ends once its call lands');
    assert.equal(result.prompts.filter(prompt => prompt.includes('stall:')).length, 0, 'a verified renewal wakes no master');
  }
});

/** The read the day's failed cycles retried: once per five-minute window from the stall on, never once per cycle. */
function assertReadBounded(result: Day, stalledFrom: number, what: string) {
  const after = result.credentialReads.filter(at => at >= stalledFrom);
  const gaps = after.slice(1).map((at, index) => at - after[index]);
  assert.ok(gaps.length >= 3, `the day runs several windows past the stall (${after.length} ${what} read(s))`);
  assert.ok(gaps.every(gap => gap >= stallBackoffMs), `every ${what} read past the stall waits a full window: ${gaps.map(gap => Math.round(gap / minute)).join(', ')} min`);
  assert.ok(after.length <= 2 + (dayMs - stalledFrom) / stallBackoffMs, `${after.length} ${what} reads from the stall on is once per window, not once per cycle`);
  assert.ok(result.cycles - after.length >= 0 && result.credentialReads.length === result.cycles, 'every cycle that ran made its one read: the held cycles are not run at all, since the read fails the cycle before anything else');
}

test('unit:soak-step-stalls-failed-cycle-wake — a day whose credential read fails the same unbound way on every cycle, before the master-session step ever runs: three failed cycles are one stall, the master is woken for it exactly once beside the failed cycles, and the read is retried once per five minutes', { timeout: 600_000 }, async () => {
  // The first cycles complete and adopt the live master; from ten minutes in, the cycle's own
  // credential read fails every cycle, so no later cycle reaches the master-session step.
  const result = await runDay({ credentialFailure: { text: 'Graphyard refused /api/status (503): upstream unavailable', after: 10 * minute } });
  const standing = Object.values(result.state.stepStalls).find(run => run.step === 'credentials');
  assert.ok(standing?.stalledAt, 'the day recorded the stall of the failing read');
  assert.equal(standing.signature, 'credentials: Graphyard refused /api/status (N): upstream unavailable');
  assert.equal(Object.keys(result.state.stepStalls).length, 1, 'one signature, one run, one stall');
  assert.equal(standing.remedy, null, 'no remedy binds to a plane-wide refusal');
  assert.ok(result.logs.filter(line => /failed in .*upstream unavailable/.test(line)).length >= stallCycleBound, 'the cycles failed at the read');
  assert.ok(!result.logs.some(line => /stall wake was not delivered/.test(line)), result.logs.find(line => /stall wake was not delivered/.test(line)));
  // The wake: exactly one, beside a failed cycle, naming the stall's subject key — not one per
  // failed cycle, and not none because the master-session step never ran again.
  const subject = stallSubjectKey(standing.signature);
  const stallWakes = result.prompts.filter(prompt => prompt.includes(subject));
  assert.equal(stallWakes.length, 1, `one wake per run: ${stallWakes.length} stall prompt(s) over the day`);
  assert.match(stallWakes[0], /Changed subjects/);
  assert.ok(Object.values(result.state.actions).some(action => action.kind === 'wake' && action.state === 'done' && /beside the failed cycle/.test(action.detail) && action.detail.includes(subject)), 'the wake is recorded as delivered beside the failed cycle');
  assert.equal(result.state.master.agentName, masterAgentName, 'the live master is the one woken');
  assert.equal(result.state.master.subjects[subject] !== undefined, true, 'the wake digest holds the subject, so no later failed cycle wakes it again');
  // Bounded retries: from the stall on, the read is made once per window.
  assertReadBounded(result, Date.parse(standing.stalledAt!) - start, 'credential');
  assert.ok(result.cycles >= 2 * (dayMs / hour), `the loop kept cycling (${result.cycles} cycles)`);
  assert.deepEqual(JSON.parse(result.cursorStalls), JSON.parse(JSON.stringify(result.state.stepStalls)), 'the persisted stepStalls are the live ones');
});

test('unit:soak-step-stalls-coordinator-refused — a day whose coordinator credential the plane refuses: the 401 remedy is refused once (renewing it is outside the loop\u2019s authority, nothing is rotated), the master is woken once beside the failed cycles, and the read is retried once per five minutes', { timeout: 600_000 }, async () => {
  const { result, files } = await credentialDay({ coordinatorRefused: true }, files => runDay({ credentials: files }));
  const standing = Object.values(result.state.stepStalls).find(run => run.step === 'credentials');
  assert.ok(standing?.stalledAt, 'the day recorded the stall of the refused read');
  assert.match(standing.signature, /^credentials: Graphyard refused \/api\/status for worker-a \(<unauthorized>\)/);
  // The remedy ran once and was refused: the coordinator's credential is the operator's to rotate.
  assert.equal(standing.remedy?.kind, 'credential-401');
  assert.equal(standing.remedy?.outcome, 'refused', standing.remedy?.detail);
  assert.match(standing.remedy!.detail, /coordinator credential .* outside the loop's authority/);
  assert.equal(new Set(result.remedyHistory.filter(entry => entry !== '[]')).size, 1, 'the refusal is recorded once and never re-attempted');
  assert.equal((await readFile(files.worker, 'utf8')).trim(), 's'.repeat(40), 'nothing was renewed: the refusal came before any profile credential was touched');
  assert.equal(result.launches.length, 0, 'no launch was made: the day never completed a cycle past the read');
  // The refused remedy wakes the master exactly once, beside the failed cycles.
  const subject = stallSubjectKey(standing.signature);
  const stallWakes = result.prompts.filter(prompt => prompt.includes(subject));
  assert.equal(stallWakes.length, 1, `one wake per run: ${stallWakes.length} stall prompt(s) over the day`);
  assert.match(stallWakeSubjects(result.state, 'graphyard').find(entry => entry.key === subject)!.detail, /credential-401 remedy was applied once at .* and refused/);
  assert.equal(result.state.master.adopted, true, 'the listed master session was adopted for the wake, as the step would have adopted it');
  assertReadBounded(result, Date.parse(standing.stalledAt!) - start, 'credential');
});

test('unit:soak-step-stalls-reviewer-profile — a day whose review launches ask for an unknown reviewer profile: three refused cycles are one stall, the profile remedy is applied once and verified against the configuration it wrote, the next launch finds the profile and the stall ends, the master never woken', { timeout: 600_000 }, async () => {
  const result = await runDay({ reviewerProfile: { name: 'reviewer-x', writes: true } });
  const stalled = result.logs.filter(line => /recorded one stall bound to the profile-unknown remedy: review-launch: Unknown reviewer profile reviewer-x/.test(line));
  assert.equal(stalled.length, 1, 'one stall, recorded once');
  assert.deepEqual(result.profileWrites.length, 1, 'the profile remedy is applied exactly once over the day');
  assert.equal(result.logs.filter(line => /the profile-unknown stall remedy applied, verified/.test(line)).length, 1, 'applied once and verified');
  // The refusals stop at the remedy: the first launch after it finds the profile, and every one after does too.
  assert.ok(result.reviewRefusals.length >= stallCycleBound && result.reviewRefusals.length <= stallCycleBound + 1, `the launches were refused only until the remedy (${result.reviewRefusals.length})`);
  assert.ok(result.reviewRefusals.every(at => at <= result.profileWrites[0]), 'no launch is refused after the profile write');
  assert.ok(result.reviewsLanded.length > result.cycles / 2, 'reviews launch for the rest of the day');
  assert.deepEqual(result.state.stepStalls, {}, 'the stall ends once the launches find the profile');
  assert.equal(result.prompts.filter(prompt => /stall:/.test(prompt)).length, 0, 'a verified remedy never wakes the master session');
});

test('unit:soak-step-stalls-reviewer-profile-unverified — a day whose profile remedy writes no reviewer profile of the asked-for name: one stall, the remedy applied once and recorded unverified, the master woken once, and the refused launch attempted at most once per five minutes all day', { timeout: 600_000 }, async () => {
  const result = await runDay({ reviewerProfile: { name: 'reviewer-x', writes: false } });
  const standing = Object.values(result.state.stepStalls).find(run => run.step === 'review-launch');
  assert.ok(standing?.stalledAt, 'the day recorded the review-launch stall');
  assert.equal(Object.keys(result.state.stepStalls).length, 1, 'one signature, one run — the record stays bounded');
  assert.equal(standing.signature, 'review-launch: Unknown reviewer profile reviewer-x');
  assert.equal(result.profileWrites.length, 1, 'the profile remedy is applied once for the run, never again however long it stands');
  assert.equal(standing.remedy?.kind, 'profile-unknown');
  assert.equal(standing.remedy?.verified, false);
  assert.match(standing.remedy!.detail, /reviewer profile reviewer-x is still not configured/);
  // Bounded retries: after its three refusals in a row the launch is attempted once per five minutes.
  const gaps = result.reviewRefusals.slice(reviewerProfileRefusalLimit).map((at, index) => at - result.reviewRefusals[reviewerProfileRefusalLimit - 1 + index]);
  assert.ok(gaps.length > 10, 'the day runs many windows past the stall');
  assert.ok(gaps.every(gap => gap >= stallBackoffMs), `every refused launch past the third waits a full five minutes: ${gaps.map(gap => Math.round(gap / minute)).join(', ')} min`);
  assert.equal(result.reviewsLanded.length, 0);
  // Bounded wakes: the unverified remedy wakes the master once for the run, naming the remedy's outcome.
  const subject = stallSubjectKey(standing.signature);
  const wakes = result.prompts.filter(prompt => prompt.includes(subject));
  assert.equal(wakes.length, 1, `one wake per run: ${wakes.length} over the day`);
  const task = stallWakeSubjects(result.state, 'graphyard').find(entry => entry.key === subject)!;
  assert.match(task.detail, /profile-unknown remedy was applied once .* unverified/);
  assert.ok(Object.keys(result.state.stepStalls).length <= retainedStepStalls);
});
