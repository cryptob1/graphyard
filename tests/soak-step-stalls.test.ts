import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDaemonState, runDaemon, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { stepStallSchema } from '../src/daemon/state.js';
import { masterConfigSchema, type MasterConfig } from '../src/master.js';
import { noteCycleStalls, retainedStepStalls, stallBackoffMs, stallCycleBound, stallHeldEffects, stallSubjectKey } from '../src/daemon/step-stalls.js';
import { stallWakeSubjects } from '../src/daemon/cycle-master.js';
import { daemonSummary } from '../src/daemon/run.js';
import { stallStatusAttention } from '../src/daemon/step-stalls.js';
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
//

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
  /** The merge writer's merger reads, each the call a persistent merger failure makes. */
  mergerReads: number[];
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
  /** Every closeSession call the day's close step actually made: the pane and the simulated minute it was made at. */
  closes: { pane: string; at: number }[];
  state: DaemonState;
}

/** The idle worker sessions a close day lists: the launch profile's own session names with distinct all-digit tags (GY-122), so every close refusal signs the same normalised signature, and a pane of its own for each. */
const idleWorkerSessions = (count: number): (HerdrAgent & { pane_id: string })[] =>
  Array.from({ length: count }, (_, index) => ({ name: `agent-worker-a-${String(index + 1).padStart(8, '0')}`, pane_id: `pane-close-${index + 1}`, agent: 'claude', agent_status: 'idle' }));

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
  /** The merge writer's merger read, made before any merge is admitted, fails this way on every call. */
  mergerFailure?: string;
  /** Every closeSession call of the day's close step fails this way: one refusal shared by every pane the day lists (GY-1900). */
  closePaneFailure?: string;
  /** The idle worker sessions of the launch profile the day lists, all with no active assignment, so the close step sweeps them every cycle. */
  idleWorkerSessions?: number;
  /** The day offers no work at all: the dispatcher launches nothing, so the close refusals are the day's only failures. */
  withoutWork?: boolean;
  /** The day's credential read and launch answer by the worker's credential file: refused (401) until it holds the issued token. */
  credentials?: { coordinator: string; worker: string; good: string };
  /** The cycle's own credential read fails this way on every cycle from `after` milliseconds into the day: the cycle fails before its master-session step. */
  credentialFailure?: { text: string; after: number };
  /** The dispatcher beside the loop launches a review asking for this reviewer profile after every cycle; the profile remedy's write configures it when `writes`. */
  reviewerProfile?: { name: string; writes: boolean };
  /** The host reclaim succeeds, rather than failing the day's way, while this answers true for the time into the day. */
  reclaimLands?: (elapsed: number) => boolean; }): Promise<Day> {
  const files = options.credentials ?? (options.reviewerProfile ? await (async () => {
    const directory = await temporaryDirectory('gy-1854-soak-reviewer-');
    return { coordinator: join(directory, 'coordinator.token'), worker: join(directory, 'worker-a.token') };
  })() : undefined);
  const result: Day = { cycles: 0, launches: [], landed: [], reclaims: [], mergerReads: [], credentialReads: [], records: [], prompts: [], remedies: [], remedyHistory: [], waits: [], cursorStalls: 'null', cursorMergeWriter: 'null', logs: [], reviewRefusals: [], reviewsLanded: [], profileWrites: [], closes: [], state: emptyDaemonState(config(files)) };
  // The reviewer profiles the day's configuration carries: the remedy's write adds the asked-for one when the day says it does.
  const reviewers: string[] = [];
  /**
   * One review launch of the dispatcher beside the loop, through the launch boundary's own record
   * (GY-1850): a configured profile launches and clears the record; an unknown one is refused and
   * counted — after three refusals in a row the boundary attempts it once per five minutes.
   */
  const launchReview = async () => {
    const profile = options.reviewerProfile!.name, at = now;
    if (reviewers.includes(profile)) { await clearReviewerProfileRefusal(config(files)); result.reviewsLanded.push(at - start); return; }
    const known = await readReviewerProfileRefusal(config(files));
    if (known && known.refusals >= reviewerProfileRefusalLimit && at - Date.parse(known.at) < reviewerProfileRetryMs) return;
    await recordReviewerProfileRefusal(config(files), profile, at);
    result.reviewRefusals.push(at - start);
  };
  let now = start;
  let stop = () => {};
  const effects: DaemonEffects = {
    agents: () => options.idleWorkerSessions ? idleWorkerSessions(options.idleWorkerSessions) : [],
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
    snapshot: async () => ({ work: options.withoutWork ? [] : [options.withMergeWriter ? submitted(now) : claimable(now)], now: new Date(now).toISOString() }),
    closeSession: options.closePaneFailure ? async (pane: string) => { result.closes.push({ pane, at: now - start }); throw new Error(options.closePaneFailure); } : () => {},
    dispatch: async (_work, profile) => {
      result.launches.push(now - start);
      // A launch a standing stall admitted reads its own admission on the cursor: the window it armed was written before the launch was made.
      const standing = Object.values(result.state.stepStalls).find(run => run.step === 'dispatch' && run.stalledAt);
      if (standing) assert.equal((JSON.parse(result.cursorStalls) as Record<string, { attemptAt: string | null }>)[standing.signature]?.attemptAt, standing.attemptAt, `the admission at +${Math.round((now - start) / minute)}min is on the cursor before the launch`);
      if ((options.credentials && (await readFile(profile.credentialFile!, 'utf8')).trim() === options.credentials.good)) { result.landed.push(now - start); return {}; }
      throw new Error(options.dispatchFailure ?? 'no dispatch was due');
    },
    ...(options.reclaimFailure ? { reclaim: async () => {
      result.reclaims.push(now - start);
      if (options.reclaimLands?.(now - start)) return { root: '/outside/repo', at: new Date(now).toISOString(), applied: true, scanned: 0, idleMs: 0, removed: [], kept: [], freeBefore: null, freeAfter: null, freedBytes: 0, errors: [] };
      throw new Error(options.reclaimFailure);
    } } : {}),
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
        merger: async () => { result.mergerReads.push(now - start); if (options.mergerFailure) throw new Error(options.mergerFailure); return 'control-plane' as const; },
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
    // A failing merger read is isolated by the merge writer's own step, the day's scripted failure.
    assert.deepEqual(Object.keys(result.state.actions).filter(key => key.startsWith('isolated:') && !(options.mergerFailure && key === 'isolated:merge:merge writer')), [], `${phase}: no step isolated a failure`);
    // The day's scripted failures are the only ones: the dispatch refusal, the merge record the
    // plane refuses as reused, and the one deployment line an unconfigured endpoint answers with.
    const scripted = (action: { kind: string; detail: string }) => action.kind === 'dispatch' || action.kind === 'merge' || (action.kind === 'reclaim' && !!options.reclaimFailure)
      || (action.kind === 'close' && !!options.closePaneFailure)
      || (action.kind === 'deployment' && /unverified: not configured/.test(action.detail));
    const failed = Object.values(result.state.actions).filter(action => action.state === 'failed' && !scripted(action));
    assert.deepEqual(failed.map(action => `${action.kind}: ${action.detail}`), [], `${phase}: no step but the day's scripted ones failed`);
  };
  now += interval;
  await runDaemon(config(files), result.state, effects, runOptions);
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
  assert.deepEqual(standing.calls, [{ call: 'reclaim', async: true, resource: null }], 'the stall holds the effect its failed rows carry, however short the failure text');
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

test('unit:soak-step-stalls-merger-hold — a day whose merge writer\u2019s merger read fails the same way every cycle, before any merge is admitted: one stall, the merger read itself made at most once per five minutes while it stands, the master woken once, every invariant holding', { timeout: 600_000 }, async () => {
  const result = await runDay({ withMergeWriter: true, mergerFailure: 'Graphyard refused /api/status (500): merger unreadable' });
  const standing = Object.values(result.state.stepStalls).find(run => run.step === 'merge');
  assert.ok(standing?.stalledAt, 'the day recorded the merge stall');
  assert.equal(Object.values(result.state.stepStalls).filter(run => run.step === 'merge').length, 1, 'one signature, one run, one stall');
  assert.ok(standing.calls.some(entry => entry.call === 'mergeWriter.merger'), `the stall holds the merger read its failed rows carry: ${JSON.stringify(standing.calls)}`);
  // The read itself — made before admission on every cycle, and by the steps that read the merger
  // after it — is made once per window from the cycle after the stall formed.
  const stalledFrom = Date.parse(standing.stalledAt!) - start;
  const after = result.mergerReads.filter(at => at > stalledFrom);
  const gaps = after.slice(1).map((at, index) => at - after[index]);
  assert.ok(gaps.length >= 3, `the day runs several windows past the stall (${after.length} merger read(s))`);
  assert.ok(gaps.every(gap => gap >= stallBackoffMs), `every merger read past the stall waits a full window: ${gaps.map(gap => Math.round(gap / minute)).join(', ')} min`);
  assert.ok(result.mergerReads.length <= 4 + dayMs / stallBackoffMs, `${result.mergerReads.length} merger reads over ${result.cycles} cycles is once per window, not once per cycle`);
  assert.ok(result.cycles > 2 * result.mergerReads.length, 'the loop kept cycling between the held reads');
  assert.ok(standing.count <= result.mergerReads.length, 'the run counts merger reads, never held cycles');
  assert.deepEqual(result.records, [], 'no merge record is written while the merger is unread');
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
  // Every wait the day answered is either a cycle that ran (and made its one read) or the loop holding its next cycle to the window.
  const held = result.logs.filter(line => /the next cycle is held to/.test(line)).length;
  assert.ok(held > 0, 'the loop held its next cycle to the stall window');
  assert.equal(result.credentialReads.length + held, result.cycles, 'every cycle that ran made its one read: the held cycles are not run at all, since the read fails the cycle before anything else');
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

/**
 * The real loop whose every cycle fails at its own snapshot read, from `from` for `span`
 * milliseconds of simulated time, over the cursor `state`: answers each snapshot read's instant and
 * the cursor as last written. Every read asserts that the stall window admitting it is already on
 * the cursor, so a process ending during the read restarts into that window.
 */
async function snapshotDay(state: DaemonState, from: number, span: number) {
  let now = from, stop = () => {}, cursor = JSON.stringify(state);
  const reads: number[] = [], logs: string[] = [], admitted: boolean[] = [];
  const effects = {
    agents: () => [], herdr: () => ({ agents: [masterSession()], available: true }),
    masterSession: { launch: async () => { throw new Error('never launched'); }, adopt: async () => null },
    promptSession: async () => {},
    snapshot: async () => {
      reads.push(now);
      const standing = Object.values(state.stepStalls).find(run => run.cycle && run.stalledAt && run.attemptAt);
      // Judged after the day: a throw here would only be another failed cycle.
      if (standing) admitted.push((JSON.parse(cursor) as DaemonState).stepStalls[standing.signature]?.attemptAt === standing.attemptAt);
      throw new Error('Graphyard refused /api/work (503): upstream unavailable');
    },
    closeSession: () => {}, dispatch: async () => {}, requestProof: () => {}, requestSmoke: () => {},
    observeDeployment: async () => ({ source: 'unavailable' as const, sha: null, at: new Date(now).toISOString(), reason: 'not configured', deployed: [], pending: [] }),
    recordDeployment: async () => {},
    persist: async (written: DaemonState) => { cursor = JSON.stringify(written); },
  } as unknown as DaemonEffects;
  const sleep = async (wait: number) => { now += wait; if (now - from >= span) stop(); };
  await runDaemon(config(), state, effects, { intervalMs: interval, identity: { pid: process.pid, host: 'soak-host' }, now: () => now, log: line => logs.push(line),
    checkout: async () => ({ root: '/outside/repo', commit: 'c'.repeat(40), modified: [], untracked: [] }), checkoutRestore: async () => [],
    process: { on: (signal: string, handler: () => void) => { if (signal === 'SIGTERM') stop = handler; }, off: () => {} } as unknown as Pick<NodeJS.Process, 'on' | 'off'>,
    delay: async wait => sleep(wait), wake: { sleep: async wait => { await sleep(wait); return ['soak-tick']; } } });
  return { reads, cursor, logs, admitted, end: now };
}

test('unit:soak-step-stalls-snapshot-restart — failed cycles stalled on the snapshot read run once per five minutes, each admitted read’s window written before the read, and a restart honours the window the previous process left', { timeout: 600_000 }, async () => {
  const first = await snapshotDay(emptyDaemonState(config()), start, 2 * hour);
  const stall = Object.values((JSON.parse(first.cursor) as DaemonState).stepStalls).find(run => run.step === 'snapshot');
  assert.ok(stall?.stalledAt && stall.cycle, 'three failed cycles at the snapshot read are one cycle-level stall');
  const stalledAt = Date.parse(stall.stalledAt);
  const after = first.reads.filter(at => at > stalledAt);
  assert.ok(after.length >= 3, `the reads go on past the stall (${after.length})`);
  const gaps = [stalledAt, ...after].slice(1).map((at, index) => at - [stalledAt, ...after][index]);
  assert.ok(gaps.every(gap => gap >= stallBackoffMs), `every read past the stall waits a full window: ${gaps.map(gap => gap / minute).join(', ')} min`);
  assert.equal(first.admitted.length, after.length, 'every read past the stall was admitted by its window');
  assert.ok(first.admitted.every(Boolean), 'each admitted read’s window was on the cursor before the read');
  // The restart: a new process over the cursor the last one wrote, a minute after its last read.
  const lastRead = first.reads.at(-1)!;
  const restarted = JSON.parse(first.cursor) as DaemonState;
  const nextAt = Date.parse(Object.values(restarted.stepStalls).find(run => run.step === 'snapshot')!.nextAttemptAt!);
  assert.ok(nextAt > lastRead + minute, 'the window the last read armed is still standing a minute later');
  const second = await snapshotDay(restarted, lastRead + minute, hour);
  assert.ok(second.reads.length >= 1 && second.reads[0] >= nextAt, `the restarted loop's first read waits for the saved window (${(second.reads[0] - lastRead) / minute} min after the last read)`);
  assert.ok(second.logs.some(line => /the next cycle is held to/.test(line)), 'the restart logs the hold it honoured');
  const restartedGaps = second.reads.slice(1).map((at, index) => at - second.reads[index]);
  assert.ok(restartedGaps.every(gap => gap >= stallBackoffMs), 'and keeps one read per window');
});

test('unit:soak-step-stalls-structured-port — a day whose merge writer\u2019s step record is refused the same way every cycle: one stall holding mergeWriter.record for that item, the write made at most once per five minutes, the port\u2019s other methods never held', { timeout: 600_000 }, async () => {
  const state = emptyDaemonState(config());
  let now = start;
  const records: number[] = [];
  let mergers = 0;
  // The merge writer's reads: the owed step record retried every cycle, the merger read beside it.
  const held = stallHeldEffects({ mergeWriter: {
    record: async () => { records.push(now); throw new Error('Graphyard refused /api/work/work-7/merge-record (409): record conflict'); },
    merger: async () => { mergers += 1; return 'control-plane'; },
  } } as unknown as DaemonEffects, () => state, () => now);
  let cycles = 0;
  for (; now - start < dayMs; now += interval) {
    cycles += 1;
    const actions: { kind: string; state: 'failed'; detail: string }[] = [];
    try { await held.mergeWriter!.record(claimable(now), {} as never); }
    catch (error) { actions.push({ kind: 'merge', state: 'failed', detail: `The merge record for GY-7 is not yet recorded by the coordinator and is retried next cycle: ${(error as Error).message}` }); }
    await held.mergeWriter!.merger();
    noteCycleStalls(state, actions, cycles, now);
  }
  const runs = Object.values(state.stepStalls);
  assert.equal(runs.length, 1, 'one signature, one run');
  assert.ok(runs[0].stalledAt, 'the recurring refusal is one stall');
  assert.deepEqual(runs[0].calls, [{ call: 'mergeWriter.record', async: true, resource: 'GY-7' }], 'the stall holds the structured call that failed, for its item');
  assert.ok(records.length <= stallCycleBound + 1 + dayMs / stallBackoffMs, `${records.length} record writes over ${cycles} cycles is once per window, not once per cycle`);
  const gaps = records.slice(stallCycleBound).map((at, index) => at - records[stallCycleBound - 1 + index]);
  assert.ok(gaps.every(gap => gap >= stallBackoffMs), 'every write past the stall waits a full window');
  assert.equal(mergers, cycles, 'the port\u2019s other methods are made every cycle');
});

test('unit:soak-step-stalls-overflow-collapse — a day whose pane closes are refused the same way for twelve idle sessions of one profile: the twelve invocations outgrow the bound the run names, so one stall holds every closeSession invocation, the call is made at most once per five minutes across the day\u2019s windows — every pane past the eighth included — the master is woken once, and the persisted run stays within its schema bound', { timeout: 600_000 }, async () => {
  const result = await runDay({
    closePaneFailure: 'herdr refused the pane close (503): the pane service is unreachable',
    idleWorkerSessions: 12, withoutWork: true,
  });
  const standing = Object.values(result.state.stepStalls).find(run => run.step === 'close');
  assert.ok(standing?.stalledAt, 'the day recorded the stall of the refused closes');
  assert.equal(Object.keys(result.state.stepStalls).length, 1, 'one signature, one run, one stall — twelve panes sign the one normalised refusal');
  assert.match(standing.signature, /^close: Could not close agent-worker-a-N: herdr refused the pane close \(N\): the pane service is unreachable$/);
  // The twelve invocations outgrew the bound the list names: the hold is the call's own, one entry
  // naming no resource, which holds every invocation of closeSession (GY-1900).
  assert.deepEqual(standing.calls, [{ call: 'closeSession', async: true, resource: null }], 'the full list collapsed to the call\u2019s own hold');

  // Bounded retries, the overflow panes included. The three forming cycles invoke every session —
  // all twelve, the ones past the eighth included; from the stall on, the real closeSession is
  // made at most once per five-minute window across all twelve together, and no pane twice in one.
  const stalledFrom = Date.parse(standing.stalledAt!) - start;
  const formed = result.closes.filter(close => close.at <= stalledFrom), past = result.closes.filter(close => close.at > stalledFrom);
  const windows = (dayMs - stalledFrom) / stallBackoffMs;
  assert.ok(windows >= 10, `the day runs many backoff windows past the stall (${Math.round(windows)})`);
  const made = (pane: string) => result.closes.filter(close => close.pane === pane);
  for (const session of idleWorkerSessions(12))
    assert.equal(made(session.pane_id).filter(close => close.at <= stalledFrom).length, stallCycleBound, `${session.pane_id} is invoked on each forming cycle, the overflow panes included`);
  assert.equal(formed.length, 12 * stallCycleBound, 'the forming cycles named every pane');
  assert.ok(afterBound(past, windows), `${past.length} real close calls past the stall over ${result.cycles} cycles and ${Math.round(windows)} windows is one per window, not twelve and not one per cycle`);
  const gaps = past.slice(1).map((close, index) => close.at - past[index].at);
  assert.ok(gaps.length >= 3 && gaps.every(gap => gap >= stallBackoffMs), `every real close past the stall waits a full window: ${gaps.map(gap => Math.round(gap / minute)).join(', ')} min`);
  for (const session of idleWorkerSessions(12)) {
    const each = made(session.pane_id).filter(close => close.at > stalledFrom);
    const paneGaps = each.slice(1).map((close, index) => close.at - each[index].at);
    assert.ok(paneGaps.every(gap => gap >= stallBackoffMs), `no pane is made twice inside a window (${session.pane_id})`);
    assert.ok(each.length <= 1 + windows, `${session.pane_id} is made ${each.length} time(s) past the stall, never once per cycle`);
  }
  // Eleven of the twelve panes are never made again once the stall stands: each window's one
  // admission is the sweep's first invocation, and the hold covers every other pane with it.
  const madePast = new Set(past.map(close => close.pane));
  assert.ok(12 - madePast.size >= 11, `the panes never made past the stall: ${12 - madePast.size} of 12`);
  // The held cycles count nothing: the count is the forming cycles plus the window attempts whose failures the day recorded.
  assert.ok(standing.count >= stallCycleBound && standing.count <= stallCycleBound + past.length, `the run counted ${standing.count}: its forming cycles and its window attempts, never its held cycles`);

  // Nothing binds to a pane-service refusal, so no remedy ran, and the master is woken once for
  // the standing stall, with the signature as the subject — never once per cycle or per attempt.
  assert.equal(standing.remedy, null, 'no remedy binds to the refusal');
  assert.ok(result.remedyHistory.every(entry => entry === '[]'), 'the day attempted no remedy');
  const subject = stallSubjectKey(standing.signature);
  const stallWakes = result.prompts.filter(prompt => prompt.includes(subject));
  assert.equal(stallWakes.length, 1, `one wake per run: ${result.prompts.filter(prompt => prompt.includes('stall:')).length} stall prompt(s) over the day`);
  assert.match(stallWakes[0], /Changed subjects/);
  assert.match(stallWakeSubjects(result.state, 'graphyard').find(entry => entry.key === subject)!.detail, /close call failed with one signature on 3 consecutive cycles/);
  const served = daemonSummary(result.state, start + dayMs, interval).stepStalls.find(row => row.subject === subject);
  assert.equal(served?.needsMaster, true, 'master status serves the stall under the key the wake names');

  // The persisted state the day wrote is the live one, and stays within the schema's bound: the
  // collapsed list is one entry, far under stepStallSchema.calls.max(8), on the cursor too.
  assert.deepEqual(JSON.parse(result.cursorStalls), JSON.parse(JSON.stringify(result.state.stepStalls)), 'the persisted stepStalls are the live ones');
  const persisted = Object.values(JSON.parse(result.cursorStalls) as Record<string, StepStallSchemaRun>);
  assert.equal(persisted.length, 1);
  assert.equal(stepStallSchema.parse(persisted[0]).calls.length, 1, 'the persisted run\u2019s held list is the collapsed one');
});

/** Whether one window's worth of attempts (with slack for the day's boundary) bounds a call's past-stall invocations. */
function afterBound(past: { at: number }[], windows: number): boolean {
  return past.length <= 2 + windows;
}

/** The shape of a persisted stall run the schema parse reads back. */
type StepStallSchemaRun = Parameters<typeof stepStallSchema.parse>[0];
