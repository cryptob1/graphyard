import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { type FileHandle, mkdir, open, utimes, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { wakeFromWebhook } from '../../src/store.js';
import { GitHub, idleObservationSeconds, processJob } from '../../src/github.js';
import { GitHubCacheStore } from '../../src/github-cache.js';
import { GitHubChargeLedger } from '../../src/github-charges.js';
import { type Principal, Refusal, type Work } from '../../src/model.js';
import * as deploymentStep from '../../src/daemon/deployment.js';
import { DispatchReservedError, type HerdrAgent, type MasterConfig, type WorkerProfile, approverSessionName, assessContainment, containmentPhase, containmentQuarantines, decisionInput, dispatchWork, masterConfigSchema, reclaimableAgent } from '../../src/master.js';
import { readAccountStartFailures, workerLaunchStatus, worktreeFailure } from '../../src/master/dispatch.js';
import { readControlPlaneClock } from '../../src/master/containment.js';
import { containmentSettlementRefusals, containmentVerificationSchema, loopEndedAttempt } from '../../src/quarantine.js';
import { type SupervisorProbeReport } from '../../src/containment-probe.js';
import { coordinatorConfinementRefusal, rerunFailedChecks } from '../../src/master/profiles.js';
import { doctorSettingsSchema } from '../../src/master/doctor-settings.js';
import { headlessConfinementWrapper, sessionConfinement } from '../../src/master/launch.js';
import { type DaemonEffects, type DaemonState, answeringWidening, emptyDaemonState, runCycle } from '../../src/master-daemon.js';
import { type HostMemoryReading, readReclaimReports, reclaimResources, settleTmpReclaim } from '../../src/master-resources.js';
import { retainedActions } from '../../src/daemon/state.js';
import { adoptHeadlessRuns, coordinatorCheckoutGuard, noteWatchdog } from '../../src/daemon/run.js';
import { type ExhaustedProof } from '../../src/daemon/decisions.js';
import { decisionEventKinds, decisionReadDeadlineMs } from '../../src/daemon/decision-reads.js';
import { type Applied, adoptRuns, detachRuns, withRunnerAgents } from '../../src/runner/registry.js';
import { applyDecision, approverRunOptions, startNarrowRun } from '../../src/runner/roles.js';
import { type DecidePayload, diagnosticianSettings } from '../../src/runner/payloads.js';
import { clearDecompositionRuns } from '../../src/decomposition-step.js';
import { type ScopeRequestState, scopeRefusalBlocker } from '../../src/model/scope.js';
import { stoppedStates } from '../../src/daemon/effects.js';
import { loopThroughputMeasurement, throughputClaim } from '../../src/throughput.js';
import { type RunOptions, type RunRecord, type RunResult, type Runner } from '../../src/runner/types.js';
import { type DiagnosticianEffects } from '../../src/daemon/diagnosis.js';
import { type AcceptanceEffects, clearDrafts, draftsSettled } from '../../src/daemon/acceptance.js';
import type { Goal, Landing } from '../../src/model/goal.js';
import { recordLanding } from '../../src/server/routes/goals.js';
import { terminalDecisions } from '../../src/cli/decision-report.js';
import { Launcher } from '../../src/daemon/cycle.js';
import { wakeOwnObservation } from '../../src/master/base-break-refresh.js';
import { buildMasterStatus } from '../../src/master/status.js';
import * as faultsStep from '../../src/daemon/faults.js';
import { type ReportedAttention, docsHeadroomStatus, docsWordCountAt } from '../../src/daemon/faults.js';
import { docsTrimTitle } from '../../src/model/documentation.js';
import { successorWidening } from '../../src/model/successors.js';
import { type InvariantCheck } from '../../src/model/invariants.js';
import { type ReviewRecord, judgeFreshReads, planMechanicalFixes, reviewRecordSchema } from '../../src/reviewer.js';
import { type DocsSyncPlan, docsSyncHarness, docsSyncSessionName, releaseDocsSyncHarness } from '../../src/docs-sync.js';
import { type TmpReclaimReport, heldOpenPaths, reclaimTmpDirectories, tmpReclaimLimitPerCycle, tmpReclaimMinAgeMs, writeTempOwner } from '../../src/tmp-reclaim.js';
import { temporaryDirectory } from './temp-dirs.js';
import { lostRunReason, sessionRetry } from '../../src/producer.js';
import { type SelfUpgradeOutcome, performSelfUpgrade } from '../../src/daemon/upgrade.js';
import { watchdogPlan } from '../../src/daemon/liveness.js';
import { loopSelfProvision, masterSetup } from '../../src/cli/master-setup.js';
import { deploymentTarget } from '../../src/install/index.js';
import { type Transport } from '../../src/install/transport.js';
import { loopWatchdogSeconds } from '../../src/supervisor.js';
import { ChildProcessError } from '../../src/child-runner.js';
import { probeBlocker } from '../../src/daemon/blocker-probes.js';
import { type BlockerClass } from '../../src/model/blocker-class.js';
import { SimulatedGitHub, SimulatedHerdr, SimulatedPi, clock, hour, minute, sha } from './soak-world.js';
import { mergeStallAttention } from '../../src/cli/master-status.js';
import { itemLane, laneSpeedTargets, lanes } from '../../src/model/policy.js';
import { type MechanicalFixRequest, appliedMechanicalRework, freshReadFor, mechanicalFixRequests, mechanicalFixState } from '../../src/mechanical-findings.js';
import { mechanicalHoldPattern } from '../../src/model/refusal-catalogue.js';
import { type InterventionRecordInput } from '../../src/model/interventions.js';
import { RefusedResponse } from '../../src/model/refusal.js';
import { type DiagnosisRun, type Failover, MANUAL, type MainGuardDay, PROOF, api, basePlan, blockerPlan, bulk18, coordinatorRoot, diagnosisRunner, engine, everyone, extraFile, extraWorkers, file, files, fixture, id, padded, principals, remedyItem, repository, reviewerApps, scopePlan, sideDayLeftovers, soakConfig, soakSessionDirectory, soakWorktreeRoot, store, token, url, workers } from './soak-plane.js';

/**
 * GY-404: per-item gates cannot catch faults that emerge from interaction over time, so this runs
 * the real loop — `runCycle` with the real engine on the test Postgres, the real reconciliation job
 * (`processJob`) and the real guarded merge — against a deterministic simulated GitHub, Herdr and
 * clock for a simulated day, and asserts after every cycle that every system invariant
 * (src/model/invariants.ts) holds. Fifteen items pass through it: released every fifteen minutes so
 * a merge lands about every fifteen, three sent back by their reviewer, two whose worker dies, two
 * production deploys, a file split on main that re-plans an item, one pull request merged by hand
 * outside Graphyard that another candidate's landing check reconciles (GY-756), one pull request GitHub reports
 * CLEAN at once and one UNSTABLE, a reviewer bot out of quota that fails over, one whose docs page
 * main rewrites under it — a conflict a docs-sync session resolves without a rework round (GY-566) —,
 * a `manual:` proof no producer may run, attested by the loop's own request, whose head moves while
 * that request is open, the loop's resource reclaim with its /tmp pass (GY-421) over a scratch tmp root holding a backlog past the
 * per-pass bound, a directory held open, one a live owner keeps, and a leftover every hour that
 * ages past the six-hour threshold during the day, one head whose producer
 * runs are killed, then fail until the request is spent (GY-496), two flaky heads
 * rerun once (GY-516), one passing on the rerun and one failing again, and the
 * between-cycles self-upgrade (GY-437) against a simulated coordinator checkout that stands dirty
 * across the second deploy for a while, and a test that breaks on main for eleven minutes (GY-528) —
 * the candidates it fails are held without rework, one P0 item is filed, and once main is repaired
 * each is rerun and refreshed onto it. The plane also reports a held integration job in three
 * separate windows, so the `held-jobs` fault class recurs past its threshold and the loop files one
 * recurring-fault item for it (GY-173): the diagnostician (GY-439) is wired as a fake, so the real
 * loop diagnoses the recurring item within the cycle that files it and closes it, on the approved
 * two-party decision, as a duplicate of an open item — once, never again per cycle, with the
 * approver session closed once the decision settles. One day's approver refuses the rework decision two items
 * call for, and a mid-day restart loses the loop's cursor while they still call for it, so their
 * next requests must cite those binding-carrying refusals at once (GY-475). Every one of the
 * fifteen must be delivered. The loop
 * carries one `Launcher` across its cycles (GY-616), as `runDaemon` does, so session launches run
 * beside the cycle — outliving it, holding their profile from hand-off, and reported by the next
 * cycle — and the invariants hold on that detached path. One candidate's required check fails only
 * because main was briefly broken while its worker pushed, and the control plane brings it onto the
 * tip that fixed the breakage with no rework round (GY-793). The loop publishes its merge
 * settings whenever they change (GY-516). A change to the loop that breaks an invariant fails here, in CI, before it merges;
 * a new behaviour that repeats per cycle, head or item belongs in this world.
 * The loop records every worker's session handle and may prompt a session (GY-544): three workers
 * ask for scope that is decided before the loop's next cycle sees the request, two panes are
 * misread by Herdr as holding no agent for one cycle, and one worker's runtime exits and leaves
 * its pane on a bare shell.
 */

/**
 * One simulated day of the loop against this world. `regression` injects a fault into the loop's own
 * effects, standing for a change that breaks an invariant, so the soak shows it would fail.
 * `capacityWait` refuses every approver launch with `capacityExhausted` between `from` and `to`,
 * and records what waited, what was refused and what launched once the window closed (GY-849).
 * `starved` stages GY-1099's observation starvation: each named item's
 * evidence is held until every other gate passes, and from then until GitHub merges it the
 * observation workers never reach its polled job, so its merge gate refuses only for a stale
 * observation; only a prioritized wake is claimed. `dropFirst` is the item whose first prioritized
 * wake is lost too, so the loop must ask again in the next observation window. `mechanical` keeps
 * the review ledger the dispatcher's reconciliation keeps (GY-971), with the reviews GitHub holds,
 * and names the item whose first approval raises findings classified mechanical whose bot commit
 * the fresh read accepts (`applied`) and the one whose bot commit it rejects as a misclassification
 * (`rejected`). `reviewCap` runs the day under that `reviewRoundCap`: each of `items` is sent back
 * by a change request naming a BLOCKING: finding on every head through the one past the cap, and the
 * approver refuses the capped rework request of each of `refused` (GY-1389).
 */
export let days = 0;
export async function simulateDay(options: { hours: number; backlog?: boolean; master?: { exitAt: number; refuseRelease: { from: number; to: number }; sessionMinutes: number; heartbeatMinutes: number; working?: { from: number; retryAt: number } }; regression?: ('approvers-left-open' | 'docs-syncs-left-open')[]; headless?: boolean; handApprovers?: boolean; stranded?: boolean | 'resume'; staleRework?: boolean; staleMerge?: number; capacityWait?: { from: number; to: number }; diagnosisLimit?: { from: number; to: number }; scope?: boolean; refuseReworkOf?: number[]; reassigned?: number | null; workspaceFailure?: { item: number; until: number }; credentialBlocked?: { recovers: number; never: number }; blockers?: boolean; retrying?: { worker: number; approver: number }; starved?: { items: number[]; dropFirst: number }; docs?: { budget: { total: number; perPage: number } }; dispatchFailing?: { constant: number; changing: number; refuseBlocks: number; unblockAfterMs: number }; mainGuard?: MainGuardDay; containment?: { failUntil: number; slowUntil: number; refuseSettle?: number }; mechanical?: { applied: number; rejected: number }; slowDecisions?: { from: number; to: number; ms: number }; slowObservation?: { from: number; to: number; attentionMs: number }; slowDeployment?: { from: number; to: number; observationMs: number }; selfProvision?: { redeployFails: { from: number; to: number } }; plan?: Partial<typeof basePlan>; github806?: boolean; remedies?: boolean;
  decomposition?: { broadItems: number[]; concurrency?: number };
  /** GY-1294: the loop's own write moves a diagnosed item's revision before its approver reads the diagnosis decision, so the decision settles stale. */
  staleDiagnosis?: boolean;
  /**
   * GY-1315: releases requested outside any diagnosis go stale in backlog. Item `item`'s hand release
   * races once, item `racing`'s every release races, and `backlog` items never released sit beside
   * them, each history read taking `readMs` of real time.
   */
  staleRelease?: { item: number; racing: number; backlog: number; readMs: number };
  /** GY-1329: item `item`'s flaky workflow run keeps running its other jobs for `ms` after its `test` check failed. */
  unfinishedRun?: { item: number; ms: number };
  /** GY-417: dispatch through the real `dispatchWork` on a real master root with a two-account launch profile. */
  failover?: Failover;
  /**
   * GY-1322: every profile's agent name starts held by a session no item owns, working until
   * `finishAt` and then finished (idle or done), while the day's items wait ready; each attempt's
   * session is left finished in its pane on submit. Item `seeded` carries a dispatch-failure
   * blocker recorded on the fleet-idle cause before the loop could reclaim.
   */
  drained?: { finishAt: number; seeded: number };
  /** GY-1302: wire the loop's promotion drive over the day's moving main, with a stubbed ledger, run list and dispatch. */
  promotion?: boolean;
  /** GY-1389: the review-round cap, the items whose change requests name a blocking finding past it, and those whose capped round the approver refuses. */
  reviewCap?: { cap: number; items: number[]; refused: number[] };
  /** GY-1417: record three goals and wire the acceptance role (acceptanceWorld below). */
  acceptance?: boolean }) {
  const dayStart = clock.now();
  // A day may restage the shared scenario: the day-scoped view of the plan is what every fault
  // below arms from, while each test's own assertions still read the shared base plan.
  const plan = { ...basePlan, ...options.plan };
  const failover = options.failover;
  const config: MasterConfig = failover ? failover.master
    // GY-1286: the slow-server day staffs every item at once, so their decisions fall due together.
    : options.slowDecisions ? masterConfigSchema.parse({ ...soakConfig, workers: [...workers, ...extraWorkers] })
    : options.master ? masterConfigSchema.parse({ ...soakConfig, run: { ...soakConfig.run, masterSessionMinutes: options.master.sessionMinutes, masterHeartbeatMinutes: options.master.heartbeatMinutes } })
    // GY-1354: the slow-deployment day's deliveries ask for a smoke proof the loop requests from this workflow.
    : options.slowDeployment ? masterConfigSchema.parse({ ...soakConfig, run: { ...soakConfig.run, smokeWorkflow: 'smoke.yml' } })
    : options.decomposition ? masterConfigSchema.parse({ ...soakConfig, run: { ...soakConfig.run, research: { command: 'pi', model: 'research-pi-model' }, decomposition: { concurrency: options.decomposition.concurrency ?? 2 } } })
    : options.reviewCap ? masterConfigSchema.parse({ ...soakConfig, reviewRoundCap: options.reviewCap.cap })
    : soakConfig;
  // The spent producer request (GY-496) is a main-day fault, like the blind window and the split:
  // the hand-approver, documentation and regression days exercise their own faults and would only
  // inherit this one's rework round.
  const mainDay = !options.handApprovers && !options.stranded && !options.regression && !options.scope && !options.headless && !options.blockers && !options.starved && !options.decomposition && !options.staleRelease;
  // GY-793's base breakage runs only on the day that asserts it (`github806`): on any other day it
  // would reshape that day's own scenario (a rework or fenced item doubling as the broken one).
  const baseBreakDay = mainDay && !!options.github806;
  /** When the base-break item's submitting attempt was dispatched: the broken window is timed from it. */
  let baseBreakFrom: number | null = null;
  // The documentation day's world (GY-574): the project keeps the 12,000-word budget and its base
  // sits 15 words under it, within the 3% warning — so the loop's headroom step counts it while
  // four items grow the pages.
  const docs = options.docs && {
    budget: options.docs.budget,
    // README.md 1,195 words and ten pages of 1,079: 11,985 total. The project's CI fails its
    // docs-budget check when a commit's total is over 12,000.
    pages: { 'README.md': 1_195, ...Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(letter => [`docs/${letter}.md`, 1_079])) } as Record<string, number>,
    // Item 1 grows README.md by 10 words and items 2, 3 and 4 each add a page of one word: every
    // head, built on whatever landed before it, stays inside the budget and still inside the warning.
    grow: (n: number): { page: string; words: number } | undefined =>
      n === 1 ? { page: 'README.md', words: 10 } : n <= 4 ? { page: `docs/grown-${n}.md`, words: 1 } : undefined,
    page: (n: number) => n === 1 ? 'README.md' : `docs/grown-${n}.md`,
  };
  const github = new SimulatedGitHub({ repository, baseBranch: 'main', appId: 1234, ciAppId: 15368, reviewerApps, ciMs: 5 * minute, reviewMs: 3 * minute, firstPullRequest: 100 * ++days, ...(docs ? { docs: { budget: docs.budget, pages: docs.pages } } : {}), ...(options.mainGuard ? { mainGuard: true } : {}) },
    [...Array.from({ length: plan.items }, (_, index) => file(index + 1)), 'README.md', ...(docs ? [] : [plan.docsConflict.page])]);
  const herdr = failover ? failover.world.herdr : new SimulatedHerdr(() => clock.now());
  // GY-453: approvers as headless Pi runs in the real run registry on disk, the loop restarting
  // (detaching every run) after every other cycle a run is live, and adopting them on the next.
  const headless = options.headless ? { pi: new SimulatedPi(), root: await temporaryDirectory('soak-runs'), applied: [] as string[], submitted: [] as string[],
    runs: new Map<string, number>(), launched: new Map<number, number>(), settling: new Map<string, Promise<RunRecord>>(), restarts: 0, adoptedLive: 0, adoptedEnded: 0 } : null;
  const adapter = github.adapter();
  // GY-883: the low-lane item's observation lists its changed files as scope files, the way the
  // real adapter reports them; every other item keeps the empty list, an unknown change, so it
  // rides high and keeps the full path.
  const items: Work[] = [];
  const observeAll = adapter.observe.bind(adapter);
  adapter.observe = async (work, peers) => {
    const observation = await observeAll(work, peers);
    return plan.lowLane && work.key === items[plan.lowLane - 1]?.key
      ? { ...observation, scopeFiles: (observation.files ?? []).map(path => ({ path, status: 'modified' as const, sha: null, additions: 1, deletions: 0, binary: false })) }
      : observation;
  };
  // Its first lane application is refused by the engine, as a rework the control plane cannot
  // apply at the moment it is requested would be; every later one goes through.
  const laneApplications: { key: string; refused: boolean; at: number }[] = [];
  const executeAll = engine.execute.bind(engine);
  engine.execute = (async (actor, command, id, input, key, context) => {
    const laneWork = plan.lowLane ? items[plan.lowLane - 1] : undefined;
    if (command === 'rework' && laneWork && id === laneWork.id && /approved by graphyard-risk-lane/.test(actor.displayName ?? '')) {
      const refused = !laneApplications.length;
      laneApplications.push({ key: laneWork.key, refused, at: clock.now() });
      if (refused) throw new Refusal(`Simulated: ${laneWork.key}'s rework could not be applied at the moment it was requested`, 409);
    }
    return executeAll(actor, command, id, input, key, context);
  }) as typeof engine.execute;
  // ---- The host's /tmp: a scratch root the loop's reclaim step sweeps every cycle (GY-421). ----
  // Every directory is stamped with the simulated clock, which the pass reads, so ages move with the day.
  const reclaimRoot = await temporaryDirectory('soak-reclaim'), tmpRoot = await temporaryDirectory('soak-tmp');
  await mkdir(join(reclaimRoot, '.graphyard'));
  const leftover = async (name: string, ageMs: number, owner?: object) => {
    const directory = join(tmpRoot, name), at = new Date(clock.now() - ageMs);
    await mkdir(directory); await writeFile(join(directory, 'data'), 'x'.repeat(1024));
    await utimes(join(directory, 'data'), at, at); await utimes(directory, at, at);
    if (owner) await writeFile(`${directory}.owner`, JSON.stringify(owner));
    return directory;
  };
  // A backlog past the per-pass bound, all stale; a dead run's marked directory, young; a young tsx cache.
  const backlog = await Promise.all(Array.from({ length: tmpReclaimLimitPerCycle + 20 }, (_, index) => leftover(`graphyard-backlog-${index}`, tmpReclaimMinAgeMs + hour)));
  const deadOwned = await leftover('graphyard-dead-run', 0, { pid: 2 ** 22 + 1, startedAt: 1, at: new Date(clock.now()).toISOString() });
  const cache = await leftover('tsx-4242', 0);
  // Stale but kept all day: one a live process holds open, one whose marked owner (this process) still runs.
  const heldDirectory = await leftover('graphyard-held', tmpReclaimMinAgeMs + hour);
  const holder: FileHandle = await open(join(heldDirectory, 'data'), 'r');
  const held = await heldOpenPaths();
  assert.ok(held.has(join(heldDirectory, 'data')), 'the open handle is visible to the holder scan');
  const liveOwned = await leftover('graphyard-live-run', tmpReclaimMinAgeMs + hour);
  await writeTempOwner(liveOwned);
  const hourly: { directory: string; at: number }[] = [];
  const tmpPasses: TmpReclaimReport[] = [];
  let tmpInFlight = 0, tmpPeak = 0;
  const tmpPass = async (options: Parameters<typeof reclaimTmpDirectories>[0] = {}) => {
    tmpPeak = Math.max(tmpPeak, ++tmpInFlight);
    // The holder set is read once above: a /proc scan per pass would time the day by the host's process count.
    try { const report = await reclaimTmpDirectories({ ...options, held }); tmpPasses.push(report); return report; }
    finally { tmpInFlight--; }
  };

  const moveClock = async (ms: number) => { clock.advance(ms); await store.pool.query('UPDATE simulated_clock SET offset_ms=$1', [clock.offsetMs]); };
  await moveClock(0);

  const pending: (() => Promise<void>)[] = [];
  const decompositionHistory = {
    starts: [] as { key: string; at: number }[],
    peakConcurrent: 0,
    currentLive: 0,
    createdChildren: [] as string[],
    deliveredParents: [] as string[],
  };
  clearDecompositionRuns();
  let fakeDecompositionRunner: Runner | undefined;
  if (options.decomposition) {
    fakeDecompositionRunner = {
      name: 'soak-decomposer',
      start<T>(prompt: string, runOptions: RunOptions<T>) {
        const itemKey = /GY-\d+/.exec(prompt)?.[0] ?? 'unknown';
        decompositionHistory.starts.push({ key: itemKey, at: clock.now() });
        decompositionHistory.currentLive++;
        decompositionHistory.peakConcurrent = Math.max(decompositionHistory.peakConcurrent, decompositionHistory.currentLive);
        const children = [
          {
            title: `${itemKey} Child Part 1`,
            criteria: ['AC-1', 'AC-2', 'AC-3'],
            plannedFiles: [`src/soak/${itemKey.toLowerCase()}-part-1.ts`],
            after: [],
          },
          {
            title: `${itemKey} Child Part 2`,
            criteria: ['AC-4', 'AC-5'],
            plannedFiles: [`src/soak/${itemKey.toLowerCase()}-part-2.ts`],
            after: [0],
          },
        ];
        const payload = {
          reason: `Split ${itemKey} into two smaller parts`,
          children,
        };
        const parsed = runOptions.validate ? runOptions.validate(payload) : payload;
        let resolveResult: (res: RunResult<T>) => void;
        const resultPromise = new Promise<RunResult<T>>(resolve => {
          resolveResult = resolve;
        });
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          decompositionHistory.currentLive--;
        };
        pending.push(async () => {
          finish();
          resolveResult({
            ok: true,
            tool: runOptions.tool,
            payload: parsed as T,
            payloads: [parsed as T],
          });
        });
        return {
          id: `soak-decomp-${randomUUID()}`,
          events: [],
          onEvent: () => () => {},
          cancel() {
            finish();
          },
          result: () => resultPromise,
        };
      },
    };
  }

  // ---- The fifteen items, created in the backlog and released one every fifteen minutes. ----
  const releaseEveryMs = plan.releaseEveryMs;
  for (let n = 1; n <= plan.items + (options.scope ? 4 : 0); n++) {
    // The scope scenarios carry their own intake: item wideRule plans twenty files under the
    // directory its criterion names; item unrepresentable plans plannedFilesMax entries outside
    // every directory of the one path its criterion implies.
    const scopeIntake = options.scope && n === scopePlan.wideRule ? {
        plannedFiles: [file(n), ...Array.from({ length: scopePlan.wideRulePlanned }, (_, index) => `${scopePlan.wideRuleDir}base-${padded(index)}.test.ts`)],
        criteria: [{ id: 'AC-1', text: `Every file under ${scopePlan.wideRuleDir} behaves for item ${n}`, proofs: [PROOF] }] }
      : options.scope && n === scopePlan.unrepresentable ? {
        plannedFiles: bulk18,
        criteria: [{ id: 'AC-1', text: `Item ${n} behaves, and ${scopePlan.unrepresentablePath} moves onto the shared helper too`, proofs: [PROOF] }] }
      : {};
    // A documentation day's item edits the page it grows, so its docs change is its own
    // planned scope, and its policy requires the project's docs budget check (GY-574).
    const docsIntake = docs && n <= 4 ? {
      plannedFiles: [...files(n), docs.page(n)],
      policy: { checks: ['test', 'typecheck', 'unit:docs-word-budget'], review: true },
    } : {};
    const isBroad = options.decomposition?.broadItems.includes(n);
    const broadIntake = isBroad ? {
      criteria: [
        { id: 'AC-1', text: `Item ${n} behaviour 1`, proofs: [PROOF] },
        { id: 'AC-2', text: `Item ${n} behaviour 2`, proofs: [PROOF] },
        { id: 'AC-3', text: `Item ${n} behaviour 3`, proofs: [PROOF] },
        { id: 'AC-4', text: `Item ${n} behaviour 4`, proofs: [PROOF] },
        { id: 'AC-5', text: `Item ${n} behaviour 5`, proofs: [PROOF] },
      ],
      plannedFiles: ['src/', 'tests/', 'docs/'],
    } : {};
    const criteria = [{ id: 'AC-1', text: plan.scoped.has(n) || (options.remedies && n === remedyItem) ? `Item ${n} behaves, with its fixture ${fixture(n)}` : `Item ${n} behaves`, proofs: [PROOF] },
      ...(n === plan.attested ? [{ id: 'AC-2', text: `Item ${n} is attested`, proofs: [MANUAL] }] : [])];
    const smokeIntake = options.slowDeployment ? { policy: { checks: ['test', 'typecheck'], review: true, deploySmoke: true } } : {};
    let work = await engine.execute(principals.operator, 'create', null, { title: `Soak item ${n}`, plannedFiles: files(n), criteria, ...scopeIntake, ...docsIntake, ...broadIntake, ...smokeIntake }, id());
    if (n === plan.exhaustedReviewer) work = await engine.execute(principals.operator, 'reviewpolicy', work.id, { provider: 'agent', expectedPolicyRevision: work.policyRevision, reason: 'Reviewed by the reviewer bots',
      reviewerProfiles: [{ name: 'claude-reviewer', runtime: 'claude', reviewerApp: 'claude-reviewer' }, { name: 'cursor-reviewer', runtime: 'cursor', reviewerApp: 'cursor-reviewer' }] }, id());
    items.push(work);
  }
  // GY-1315: the unreleased backlog the stale-release step reads every cold cycle, beside the day's items.
  const staleReleaseDay = { hand: [] as { key: string; decision: string; outcome: string }[], races: [] as { key: string; decision: string; outcome: string; at: number }[], handReleased: [] as { key: string; elapsed: number }[],
    backlog: [] as Work[], backlogReads: 0, steps: [] as { elapsed: number; ms: number; backlogReads: number }[] };
  for (let index = 0; index < (options.staleRelease?.backlog ?? 0); index++)
    staleReleaseDay.backlog.push(await engine.execute(principals.operator, 'create', null, { title: `Soak backlog ${days}-${index}`, plannedFiles: [`src/soak/backlog-${days}-${index}.ts`], criteria: [{ id: 'AC-1', text: `Backlog ${index} behaves`, proofs: [PROOF] }] }, id()));
  const staleReleaseItems = new Set(options.staleRelease ? [options.staleRelease.item, options.staleRelease.racing] : []);
  // ---- The backlog a previous day left (GY-842): panes of review sessions whose worktrees the
  // ---- reclaim removed while the panes stood on. Enough of them that the sweep's per-pass bound
  // ---- is what paces the drain, and one pane Graphyard never launched that it must never touch.
  // Pane ids are this simulated world's own, so two days on one control plane never collide.
  // The full backlog, and GY-980's worktree leftovers below, stand only on the main day that
  // asserts their drain (`backlog`): every other day runs near its own timeout on CI and keeps the
  // eight panes it always had, unless its plan names its own.
  const backlogDay = options.backlog === true;
  const world = `w${days}:`, leftovers = backlogDay || options.plan?.leftovers != null ? plan.leftovers : sideDayLeftovers, foreignPane = `${world}operator`;
  for (let index = 0; index < leftovers; index++) {
    const work = items[index], pane = `${world}left${index}`;
    // The sweep closes agentless panes only in Graphyard worktrees (GY-980 AC-1); these stand in
    // worktrees of attempts no lease holds, reclaimed under them.
    herdr.shell(pane, `${soakWorktreeRoot}/${work.key}-${60 + index} (deleted)`);
    await api(principals.coordinator, 'POST', `work/${work.id}/session`, { id: `review-leftover-${index}`, kind: 'review', runtime: 'claude', host: 'soak-host',
      subject: `${work.key}: review (previous day)`, state: 'running', pane, attach: `herdr pane attach ${pane}` });
  }
  herdr.shell(foreignPane, '/home/vish');
  // ---- GY-980: what else a previous day left in its worktrees. Bare shells in Graphyard worktrees
  // ---- no session recorded, shells whose review handle stayed 'running' with no lease on their
  // ---- epoch, and ended sessions whose agents still idle in their panes, named as recorded. The
  // ---- day's own workers stand in Graphyard worktrees too, so the sweep meets them leased.
  const previousWorktrees: string[] = [];
  for (let index = 0; index < (backlogDay ? plan.worktreeLeftovers : 0); index++) {
    const work = items[index % items.length];
    const unrecorded = `${world}tree${index}`, stuck = `${world}stuck${index}`, idle = `${world}idle${index}`;
    herdr.shell(unrecorded, `${soakWorktreeRoot}/${work.key}-${90 + index}`);
    herdr.shell(stuck, `${soakWorktreeRoot}/${work.key}-${80 + index}/src`);
    await api(principals.coordinator, 'POST', `work/${work.id}/session`, { id: `review-stuck-${index}`, kind: 'review', runtime: 'claude', host: 'soak-host',
      subject: `${work.key}: review (previous day, its runtime exited at start)`, state: 'running', pane: stuck, attach: `herdr pane attach ${stuck}` });
    herdr.agents.set(idle, { name: `review-previous-${index}`, pane_id: idle, agent: 'claude', agent_status: 'idle', cwd: `/tmp/soak/checkouts/review-previous-${index}` });
    await api(principals.coordinator, 'POST', `work/${work.id}/session`, { id: `review-ended-${index}`, kind: 'review', runtime: 'claude', host: 'soak-host', agentName: `review-previous-${index}`,
      subject: `${work.key}: review (previous day, ended)`, state: 'finished', pane: idle, attach: `herdr pane attach ${idle}` });
    previousWorktrees.push(unrecorded, stuck, idle);
  }
  const numberOf = (work: Pick<Work, 'key'>) => items.findIndex(item => item.key === work.key) + 1;
  for (const n of plan.rework) github.verdicts.set(items[n - 1].key, ['CHANGES_REQUESTED']);
  // GY-1389: a change request on every head through the first past the cap, each naming a blocking finding.
  const cappedDay = options.reviewCap;
  if (cappedDay) {
    for (const n of cappedDay.items) github.verdicts.set(items[n - 1].key, Array.from({ length: cappedDay.cap + 1 }, () => 'CHANGES_REQUESTED' as const));
    github.changeRequestBody = (key, review) => cappedDay.items.includes(numberOf({ key })) ? `AC-1 is judged on ${review.sha.slice(0, 12)}.\nBLOCKING: AC-1 is not met — ${key} skips the last frob.` : null;
  }
  if (plan.unstable) github.unstable.add(items[plan.unstable - 1].key);
  if (plan.slowRecompute) github.slowRecompute.add(items[plan.slowRecompute - 1].key);
  if (plan.blockedMerge) github.blockedMerge.add(items[plan.blockedMerge - 1].key);
  github.exhaustedProfiles.add('claude-reviewer');
  if (plan.flaky.rerunPasses) github.flaky.set(items[plan.flaky.rerunPasses - 1].key, 'rerun-passes');
  if (plan.flaky.rerunFails) github.flaky.set(items[plan.flaky.rerunFails - 1].key, 'rerun-fails');
  if (options.unfinishedRun) github.unfinishedRunMs.set(items[options.unfinishedRun.item - 1].key, options.unfinishedRun.ms);
  // GY-1250: two items whose first merges break main though each passed CI alone; the second's
  // revert fails its own checks too, so the guard gives it up and main is fixed forward by hand.
  const guardDay = options.mainGuard && { breaks: items[options.mainGuard.breaks - 1].key, abandons: options.mainGuard.abandons ? items[options.mainGuard.abandons - 1].key : null, fixedAt: null as number | null,
    filled: false, linePruned: false, fixAfterMs: options.mainGuard.fixAfterMs,
    /** The guard's GitHub requests per tick: what one `processJob` call that ran the guard asked. */
    ticks: [] as { at: number; requests: typeof github.guardRequests }[] };
  if (guardDay) { github.breaksMain.add(guardDay.breaks); if (guardDay.abandons) { github.breaksMain.add(guardDay.abandons); github.revertFails.add(guardDay.abandons); } }
  // GitHub delivery is deployed with a standing direct-merge window (GRAPHYARD_DIRECT_MERGE_SINCE),
  // under which GitHub's own merges are delivered as operator-authorized.
  if (guardDay) engine.directMergeEnvironment = { since: new Date(dayStart).toISOString(), until: null, reason: 'GRAPHYARD_DIRECT_MERGE_SINCE is set in the deployment environment', setBy: 'deployment environment', enabledAt: new Date(dayStart).toISOString(), source: 'environment', event: null };

  // The scope scenarios: what each extra item asks for the moment it is dispatched, and — for the
  // finding-grounded one — the trusted findings that ground its paths on the base branch.
  const scopeAsks = new Map<string, string[]>();
  const findings = new Map<string, Set<string>>();
  if (options.scope) {
    scopeAsks.set(items[scopePlan.wideRule - 1].key, Array.from({ length: scopePlan.wideRuleAsked }, (_, index) => `${scopePlan.wideRuleDir}wide-${padded(index)}.test.ts`));
    const findingPaths = Array.from({ length: scopePlan.wideFindingAsked }, (_, index) => `${scopePlan.wideFindingDir}extra-${padded(index)}.ts`);
    scopeAsks.set(items[scopePlan.wideFinding - 1].key, findingPaths);
    findings.set(items[scopePlan.wideFinding - 1].key, new Set(findingPaths));
    scopeAsks.set(items[scopePlan.unrepresentable - 1].key, [scopePlan.unrepresentablePath]);
    scopeAsks.set(items[scopePlan.partial - 1].key, [scopePlan.partialPage, scopePlan.partialFile]);
  }
  // GY-1293: the refusals that judge nothing about scope, each answered once, and the slow read.
  const transientWidenings = new Map<number, number>([[scopePlan.wideFinding, 500], [scopePlan.partial, 409]]);
  const transientRefused: { n: number; status: number; elapsed: number }[] = [], lateReads: { n: number; elapsed: number }[] = [];
  // The unrepresentable ask's worker never pushes or submits: its item stays blocked on scope.
  const hold = new Set(options.scope ? [items[scopePlan.unrepresentable - 1].key] : []);

  // ---- GY-971: the review ledger, kept as the dispatcher's review reconciliation keeps it. ----
  // Every verdict the reviewer posts is recorded as its session's, and the real planner and fresh-read
  // judge run over the ledger on each pass, one pass behind GitHub as the dispatcher's tick is, so
  // the loop meets each approval unclassified first. The loop reads the ledger's plans each cycle.
  const mechanicalDay = options.mechanical;
  const ledger: ReviewRecord[] = [], ledgered = new Set<number>(), bodies = new Map<number, { body: string; sha: string; state: string }>();
  const misclassified: { signal: InterventionRecordInput; key: string }[] = [];
  const botRounds: { key: string; approved: string; head: string; reviewId: number; bot: string; epoch: number }[] = [];
  if (mechanicalDay) for (const n of [mechanicalDay.applied, mechanicalDay.rejected]) github.carriedOnly.add(items[n - 1].key);
  const mechanicalItem = (key: string) => !!mechanicalDay && [mechanicalDay.applied, mechanicalDay.rejected].some(n => items[n - 1].key === key);
  const reviewBody = (key: string, review: { sha: string; state: string }) => {
    const n = items.findIndex(item => item.key === key) + 1, bot = botRounds.find(round => round.head === review.sha);
    if (bot && review.state === 'CHANGES_REQUESTED') return `AC-1 unmet.\nRejected bot commit: ${review.sha} — it changed the retry bound in ${file(n)}, a behaviour change, not a typo fix`;
    // The first approval of a scenario item raises one finding of each class.
    if (mechanicalItem(key) && review.state === 'APPROVED' && !ledger.some(record => record.key === key))
      return [`AC-1 met.`, `Nit: ${file(n)}:3 — "recieve" is a typo (mechanical: typo)`, `Nit: ${file(n)}:9 — the retry is unbounded when the source keeps failing (substantive: behavior)`].join('\n');
    return 'AC-1 met.';
  };
  // Each review's body is written once, when GitHub's observation or the ledger first reads it: the
  // observation counts an approval's mechanical nits from it, which hold the review gate (GY-971).
  const bodyOf = (key: string, review: { id: number; sha: string; state: string }) => {
    if (!bodies.has(review.id)) bodies.set(review.id, { sha: review.sha, state: review.state, body: reviewBody(key, review) });
    return bodies.get(review.id)!.body;
  };
  if (mechanicalDay) github.reviewBody = (key, review) => review.state === 'APPROVED' && review.reviewer === 'reviewer' && mechanicalItem(key) ? bodyOf(key, review) : '';
  const ledgerRun = async (_command: string, args: string[]) => {
    const match = /^repos\/owner\/project\/pulls\/\d+\/reviews\/(\d+)$/.exec(args[1] ?? ''), entry = match ? bodies.get(Number(match[1])) : undefined;
    if (!entry) throw new Error(`the simulated GitHub cannot answer gh ${args.join(' ')}`);
    return JSON.stringify({ id: Number(match![1]), state: entry.state, commit_id: entry.sha, body: entry.body });
  };
  // A head as GitHub reports its commit: its parents and the paths it changed from its first parent.
  const observeCommit = async (head: string) => {
    const commit = github.commits.get(head)!, parent = github.commits.get(commit.parents[0]!);
    return { parents: commit.parents, files: commit.files.filter(path => commit.contents.get(path) !== parent?.contents.get(path)), at: new Date(commit.at).toISOString() };
  };
  // Each head the review gate held for its mechanical-fix round (GY-971), as the loop's passes saw it.
  const reviewHolds = new Set<string>();
  const reconcileLedger = async () => {
    const work = (await store.list()).filter(item => items.some(entry => entry.id === item.id));
    for (const item of work) if (item.candidate && item.gates.some(gate => gate.name === 'review' && gate.reasons.some(reason => mechanicalHoldPattern.test(reason)))) reviewHolds.add(`${item.key} ${item.candidate.sha}`);
    const at = new Date(clock.now());
    await planMechanicalFixes(ledger, work, repository, ledgerRun, at);
    await judgeFreshReads(ledger, repository, ledgerRun, async (signal, key) => { misclassified.push({ signal, key }); await api(principals.coordinator, 'POST', 'interventions', signal, key); }, at);
    for (const pr of github.prs.values()) for (const review of pr.reviews) {
      const item = work.find(entry => entry.key === pr.key);
      if (ledgered.has(review.id) || review.reviewer !== 'reviewer' || !item) continue;
      ledgered.add(review.id);
      bodyOf(item.key, review);
      const bot = botRounds.find(round => round.head === review.sha);
      const fresh = (await freshReadFor(mechanicalFixRequests(ledger), item.key, review.sha, { principal: bot?.bot ?? pr.author, role: 'worker' }, review.reviewer, observeCommit))?.fresh;
      ledger.push(reviewRecordSchema.parse({ id: randomUUID(), key: item.key, pr: pr.number, sha: review.sha, baseSha: item.candidate?.baseSha ?? github.tip, policyRevision: item.policyRevision,
        profile: 'soak-reviewer', agentName: `soak-review-${review.id}`, pane: null, sessionDirectory: '/tmp/soak/review', requestedAt: review.submittedAt, tokenExpiresAt: review.submittedAt,
        state: 'completed', verdict: { state: review.state, reviewer: review.reviewer, reviewId: review.id, submittedAt: review.submittedAt }, ...(fresh ? { freshRead: fresh } : {}) }));
    }
  };

  // ---- Workers: the loop dispatches, the simulated session claims, works, pushes and submits (or dies). ----
  interface Session { work: string; key: string; branch: string; profile: WorkerProfile; epoch: number; attempt: number; pane: string; pushAt: number; diesAt: number | null; exitsAt: number | null; dispatchAt: number; state: 'working' | 'submitted' | 'dead' | 'exited' | 'idling' | 'reclaimed' | 'credential-blocked' | 'blocked' | 'failed-over'; syncs: number; syncedFor?: string; refusedSince?: number;
    scopeAt: number | null; misreadAt: number | null; misread: boolean; credentialAt: number | null; blockAt: number | null; retryingAt: number | null; settlementToken?: string; files?: string[]; bot?: MechanicalFixRequest }
  const sessions: Session[] = [], lost: string[] = [], launches: number[] = [];
  // GY-973: what each pane's screen tail shows, where it is not a session at work, and the
  // accounts the loop held. OpenCode 1.18 on a spent account prints its limit banner with a retry
  // marker and retries for ever, so Herdr keeps the session `working` and only the screen tells.
  const screens = new Map<string, string>(), heldAccounts = new Map<string, { resetsAt: string | null }>(), approverAccounts: { key: string; account: string }[] = [];
  // The banner names whole seconds: a reset on a fractional one would never read back as itself.
  const retryReset = new Date(Math.ceil((dayStart + 2 * 24 * hour) / 1000) * 1000);
  const hostWallClock = (instant: Date) => { const pad = (value: number) => String(value).padStart(2, '0'); return `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())} ${pad(instant.getHours())}:${pad(instant.getMinutes())}:${pad(instant.getSeconds())}`; };
  const retryBanner = `┃ Reading src/model/capacity.ts\n\n  ■⬝⬝⬝⬝⬝⬝⬝  Weekly/Monthly Limit Exhausted. Your limit will reset at ${hostWallClock(retryReset)} [retrying in 4s attempt #5]${' '.repeat(96)}… esc interrupt • OpenCode 1.18.32  \n`;
  const accountHeld = (account: string) => { const hold = heldAccounts.get(account); return !!hold && (!hold.resetsAt || Date.parse(hold.resetsAt) > clock.now()); };
  // GY-888: every session launch the day makes carries the coordinator confinement through the
  // launcher's own logic, and the same launch where the mount namespace cannot be built is
  // refused with the reason named — never started unconfined. The fixture worktree each launch
  // needs is built serially: git refuses concurrent worktree registrations on one checkout.
  const confined: { role: 'worker' | 'approver' | 'producer'; key: string; directory: string; mechanism: string; reexposed: readonly string[] }[] = [];
  const unconfinedRefusals: string[] = [];
  const reexposedWritable = (wrapper: readonly string[]) => wrapper.filter((word, index) => index > 0 && wrapper[index - 1] === '--bind');
  let confining: Promise<void> = Promise.resolve();
  const confine = (role: 'worker' | 'approver', key: string, directory?: string) => {
    const done = confining.then(async () => {
      // The worker's own worktree is built here too: git refuses concurrent worktree
      // registrations on one checkout, as concurrent launches would race them.
      const session = directory ?? soakSessionDirectory();
      const launch = await sessionConfinement('claude', [], { directory: session }, coordinatorRoot!);
      confined.push({ role, key, directory: session, mechanism: launch!.mechanism, reexposed: reexposedWritable(launch!.wrapper) });
      const refusal = await coordinatorConfinementRefusal({ kind: 'claude', args: [], coordinatorRoot: coordinatorRoot!, sessionDirectory: session, platform: 'linux', bwrap: null });
      if (refusal) unconfinedRefusals.push(refusal);
    });
    confining = done.catch(() => {});
    return done;
  };
  const attempts = new Map<string, number>();
  // GY-1322: the finished sessions dispatches closed to launch over, the most live panes any one
  // profile name had at once, the dispatch blocks the loop asked for, and the seeded blocker's life.
  const drain = { reclaimed: [] as { key: string; profile: string; pane: string; status: string; at: number }[], peakPerName: 0, blocks: [] as string[],
    seededAt: null as number | null, clearedAt: null as number | null, finishedAt: null as number | null, holders: [] as string[],
    // Sessions that finish inside the next cycle, after its first Herdr read (the close step's) and
    // before the dispatch step reads Herdr again: the race the dispatch's own reclaim answers.
    finishing: [] as { pane: string; status: string }[], reads: 0 };
  const finishDuringCycle = () => { if (options.drained && ++drain.reads >= 2) for (const { pane, status } of drain.finishing.splice(0)) herdr.status(pane, status); };
  // GY-860: the claims whose worktree the host could not build, and any cycle that cooled a profile off for one.
  const workspaceFailures: { key: string; epoch: number; profile: string; at: number }[] = [], workspaceCooled: string[] = [];
  const principalOf = (profile: WorkerProfile): Principal => ({ id: profile.principal, role: 'worker' });
  // GY-1078: launches that fail after the claim, as the launcher's do when `worktree` cannot create
  // the attempt's worktree: the epoch is claimed, released, and the failure carries git's stderr.
  // The constant item fails for one cause until the operator clears its blocker; the changing
  // item fails four times, each for a different cause, then launches.
  const failing = { launches: [] as { key: string; epoch: number; at: number; failure: string | null }[], blocks: [] as { key: string; reason: string; at: number; refused: boolean }[],
    unblocked: null as number | null, blockedAt: null as number | null, blockerSeen: [] as { key: string; at: number }[] };
  const failureOf = (n: number, key: string, epoch: number): string | null => {
    if (!options.dispatchFailing) return null;
    const tries = failing.launches.filter(entry => entry.key === key).length;
    if (n === options.dispatchFailing.constant && failing.unblocked === null)
      return `fatal: 'graphyard/${key.toLowerCase()}-1' is already used by worktree at '/tmp/soak/.graphyard/worktrees/${key}-${epoch - 1}'`;
    if (n === options.dispatchFailing.changing && tries < 4)
      return [`fatal: '/tmp/soak/.graphyard/worktrees/${key}-${epoch}' already exists`, 'fatal: Unable to create index.lock: File exists', 'fatal: not a valid object name: origin/main', 'error: could not lock config file .git/config: Permission denied'][tries];
    return null;
  };
  const dispatch: DaemonEffects['dispatch'] = failover ? async (work, profile, free, snapshot) => {
    // An earlier day's item still open in the shared store goes the simulated way: the day's own
    // five are what the real launch path and its ledger are judged on.
    if (!items.some(item => item.id === work.id)) return simulatedDispatch(work, profile, free, snapshot);
    launches.push(clock.now());
    // The real dispatch path (GY-417): the launcher claims through the engine, launches through
    // the world's Herdr, and falls forward to the profile's next account when the preferred
    // account's runtime never comes up. The day's fourth dispatch finds the account healthy, so
    // the same account starts and clears its run of failures.
    const principal = principalOf(profile), world = failover.world;
    world.launched += 1;
    if (world.launched === 4) world.healthyEverywhere();
    let epoch = 0, branch = '';
    const result = await dispatchWork(failover.root, work, profile, free, world.run, snapshot.work,
      async () => {
        const claimed = await engine.execute(principal, 'claim', work.id, {}, id());
        epoch = claimed.epoch; branch = `graphyard/${work.key.toLowerCase()}-${epoch}`;
        const path = await temporaryDirectory('soak-launch');
        await engine.execute(principal, 'workspace', work.id, { epoch, host: 'soak-host', path, branch }, id());
        return { epoch, path, base: github.tip };
      },
      async (_root, _key, claimedEpoch) => { await engine.execute(principal, 'release', work.id, { epoch: claimedEpoch }, id()); },
      5_000, snapshot.now, { start: world.bounds(), agents: () => herdr.list(), supervisor: () => false, stopSupervisor: () => true });
    failover.dispatches.push(result);
    failover.samples.push({ key: work.key, failures: await readAccountStartFailures(failover.master), attention: await workerLaunchStatus(failover.root, failover.master) });
    // The launched session works its request in the pane the launcher created and submits like
    // any session of the day; the world's tick renews its lease and pushes its head.
    const attempt = (attempts.get(work.key) ?? 0) + 1; attempts.set(work.key, attempt);
    sessions.push({ work: work.id, key: work.key, branch, profile, epoch, attempt, pane: result.pane!, pushAt: clock.now() + plan.workMs, diesAt: null, exitsAt: null, dispatchAt: clock.now(), state: 'working', syncs: 0,
      scopeAt: null, misreadAt: null, misread: false, credentialAt: null, blockAt: null, retryingAt: null });
    return { key: work.key, epoch, pane: result.pane!, agentName: profile.agentName };
  } : (work, profile, free, snapshot) => simulatedDispatch(work, profile, free, snapshot);
  async function simulatedDispatch(...[work, profile, , snapshot]: Parameters<DaemonEffects['dispatch']>) {
    // As `dispatchWork` does under its reservation (GY-1322): a session holding the profile's agent
    // name is closed and launched over only when it is finished and no live assignment owns it;
    // any other holder refuses the launch before anything is claimed.
    for (const holder of herdr.list().filter(agent => agent.name === profile.agentName)) {
      if (!reclaimableAgent(profile, holder, snapshot.work, clock.now())) throw new DispatchReservedError('profile', profile.name, `Launch profile agent name ${profile.agentName} is already visible in Herdr; pick another profile`);
      herdr.close(holder.pane_id!);
      drain.reclaimed.push({ key: work.key, profile: profile.name, pane: holder.pane_id!, status: holder.agent_status ?? '', at: clock.now() - dayStart });
    }
    launches.push(clock.now());
    const principal = principalOf(profile);
    const claimed = await engine.execute(principal, 'claim', work.id, {}, id());
    const epoch = claimed.epoch, key = work.key, n = numberOf(work);
    const sessionFiles = (work.plannedFiles && !work.plannedFiles.some(f => f.endsWith('/'))) ? [...work.plannedFiles] : files(n);
    // GY-860: for part of the day an earlier attempt's worktree holds this item's branch where the
    // host cannot free it. The worktree command releases the claim as a workspace failure with
    // git's message, which hands the epoch back, and fails the way the real child runner reports
    // it: the command line, then the command's stderr.
    if (options.workspaceFailure?.item === n && clock.now() - dayStart < options.workspaceFailure.until) {
      const held = `Git worktree creation failed: fatal: 'graphyard/${key.toLowerCase()}-${epoch}' is already used by worktree at /tmp/soak/${key}-held`;
      await engine.execute(principal, 'release', work.id, { epoch, failure: { message: held } }, id());
      workspaceFailures.push({ key, epoch, profile: profile.name, at: clock.now() - dayStart });
      throw new ChildProcessError(process.execPath, ['graphyard.mjs', 'worktree', key, String(epoch), 'main'], { stdout: '', status: 1, signal: null, timedOut: false,
        stderr: `${held}. The claim was released as a workspace failure, so the attempt costs nothing; inspect the event and repair the host before it redispatches.\n` });
    }
    const failure = failureOf(n, key, epoch);
    if (options.dispatchFailing) failing.launches.push({ key, epoch, at: clock.now(), failure });
    if (failure !== null) {
      await engine.execute(principal, 'release', work.id, { epoch }, id());
      throw new Error(worktreeFailure(key, epoch, { stderr: `Git worktree creation failed: git worktree add /tmp/soak/.graphyard/worktrees/${key}-${epoch} graphyard/${key.toLowerCase()}-${epoch} failed (exit 128): ${failure}\n` }));
    }
    // A rework attempt pushes to the pull request already linked, from a fresh workspace: the
    // branch the standing submission's workspace used, which the engine demands a re-registered
    // workspace on a submitted item reuse — as when a submitted attempt's lease is reclaimed.
    const branch = work.candidate?.branch ?? work.workspaces.find(entry => entry.epoch === work.submission?.epoch)?.branch ?? `graphyard/${key.toLowerCase()}-${epoch}`;
    const path = `${soakWorktreeRoot}/${key}-${epoch}`;
    // The launch is confined before its pane opens: the session's own worktree is a linked
    // worktree of the coordinator checkout, exactly as the launcher prepares them (GY-888).
    await confine('worker', key);
    await engine.execute(principal, 'workspace', work.id, { epoch, host: 'soak-host', path, branch }, id());
    // GY-811: the containment day's supervisor fences its session as `watch` does — a quarantine
    // whose settlement token only it holds, acknowledged by the launch — and lowers the fence
    // itself when the session ends on its own; a session that dies leaves it for the loop.
    const settlementToken = options.containment ? createHash('sha256').update(`settle\0${key}\0${epoch}`).digest('hex') : undefined;
    if (settlementToken) {
      const settlementHash = createHash('sha256').update(settlementToken).digest('hex');
      await engine.execute(principal, 'quarantine', work.id, { epoch, settlementHash }, id());
      await engine.execute(principal, 'launch', work.id, { epoch, settlementHash }, id());
    }
    const attempt = (attempts.get(key) ?? 0) + 1; attempts.set(key, attempt);
    // GY-971: an attempt the item's applied mechanical-fix rework started is the bot round, as the
    // worker launcher reads it; any other rework is ordinary work.
    const reviewId = mechanicalDay && work.candidate ? appliedMechanicalRework(work, (await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(work.id)}/decisions`)).decisions) : null;
    const bot = reviewId === null ? undefined : mechanicalFixRequests(ledger).find(request => request.key === key && request.reviewId === reviewId && request.head === work.candidate!.sha);
    // GY-711: the routine-remedy item exercises both per-item remedies from the real cycle. Its
    // first attempt asks, a minute in, for the fixture its criterion names, which the control plane
    // widens, and then reports a stale scope refusal naming that fixture — the blocker a widening
    // already covers, on the item's structured scope record — and stops on it, as the blocked day's
    // sessions do. Its
    // second attempt is launched under a containment fence, as a supervised launch is, and submits
    // without its supervisor lowering it: the lapsed fence of a submitted attempt. Only the day that
    // asserts them (`remedies`) scripts them, so every other day keeps its own item plan.
    if (options.remedies && n === remedyItem && attempt === 1)
      pending.push(async () => {
        await engine.execute(principal, 'scope', work.id, { epoch, paths: [fixture(n)], reason: 'The fixture my criterion names' }, id());
        await engine.execute(principals.coordinator, 'autoscope', work.id, { epoch }, id());
        await engine.execute(principal, 'blocked', work.id, { epoch, reason: `${scopeRefusalBlocker}: ${fixture(n)} is outside the attempt's plannedFiles` }, id());
        const session = sessions.find(entry => entry.work === work.id && entry.epoch === epoch);
        if (session) { herdr.kill(session.pane); session.state = 'blocked'; }
      });
    if (options.remedies && n === remedyItem && attempt === 2) {
      const settlementHash = createHash('sha256').update(`soak-settlement-${key}-${epoch}`).digest('hex');
      await engine.execute(principal, 'quarantine', work.id, { epoch, settlementHash }, id());
      await engine.execute(principal, 'launch', work.id, { epoch, settlementHash }, id());
    }
    // GY-852: the reassigned item's first session takes the lease and then sits at its prompt for
    // ever, as an idle worker does, so the loop's idle re-prompt and reclaim run against it.
    const idling = options.reassigned === n && attempt === 1;
    // GY-999: a session whose push is refused for want of a valid GitHub login blocks on it. The
    // recovering item's first two attempts do; the other item's every attempt does — a failure no
    // freshly minted credential cures, which the retry ladder must bound.
    const credentialBlocks = !!options.credentialBlocked && ((n === options.credentialBlocked.recovers && attempt <= 2) || n === options.credentialBlocked.never);
    const pane = herdr.open(profile.agentName, idling ? 'done' : 'working', path);
    // The base-break item's attempt that submits works fast and pushes inside the broken window (GY-793):
    // its first, unless the remedy day scripts that one to block.
    const fastPush = baseBreakDay && plan.baseBreak.item === n && baseBreakFrom === null && !(options.remedies && n === remedyItem && attempt === 1);
    if (fastPush) baseBreakFrom = clock.now();
    const pushAfterMs = fastPush ? plan.baseBreak.pushAfterMs : plan.workMs;
    sessions.push({ work: work.id, key, branch, profile, epoch, attempt, pane, pushAt: idling ? Number.MAX_SAFE_INTEGER : clock.now() + pushAfterMs,
      diesAt: !options.capacityWait && !idling && plan.deaths.has(n) && attempt === 1 ? clock.now() + plan.deathAfterMs : null,
      exitsAt: !idling && plan.exits.has(n) && attempt === 1 ? clock.now() + plan.exitAfterMs : null, dispatchAt: clock.now(), state: idling ? 'idling' : 'working', syncs: 0,
      scopeAt: !idling && plan.scoped.has(n) && attempt === 1 ? clock.now() + plan.scopeAfterMs : null, misreadAt: !idling && plan.misread.has(n) && attempt === 1 ? clock.now() + plan.misreadAfterMs : null, misread: false,
      // GY-1008: the blocked day's first attempts record their blocker; the repeating item's every attempt does.
      blockAt: options.blockers && blockerPlan.classes[n] && (attempt === 1 || n === blockerPlan.repeating) ? clock.now() + blockerPlan.blockAfterMs : null,
      credentialAt: credentialBlocks ? clock.now() + 5 * minute : null, retryingAt: options.retrying?.worker === n && attempt === 1 ? clock.now() + 5 * minute : null, settlementToken, files: sessionFiles, ...(bot ? { bot } : {}) });
    // A scope scenario asks the moment it holds the lease, as a worker does, and keeps working
    // while the control plane decides. An ask carries at most fifty paths, so a wide ask is
    // filed in batches, which one open request of the attempt merges.
    const ask = scopeAsks.get(key);
    for (let at = 0; ask && at < ask.length; at += 50)
      await engine.execute(principal, 'scope', work.id, { epoch, paths: ask.slice(at, at + 50), reason: `Item ${n}: the ${ask.length === 1 ? 'file' : 'files'} this change touches` }, id());
    // The pane is the session's own coordinate: the loop records it on the implementation handle.
    return { key, epoch, pane, agentName: profile.agentName };
  }
  // GY-1322: the drained fleet. At the day's start every launch profile's name is held by a session
  // no item owns, working; at `finishAt` each finishes and sits at its prompt (idle, then done,
  // alternating) inside the next cycle, after the close step read it working, so that cycle's
  // launches go only by the dispatch closing one. The seeded item's blocker is the one a loop
  // before GY-1322 recorded on that drain.
  const drainTick = async (now: number) => {
    const drained = options.drained!, launchProfiles = config.workers.filter(profile => profile.mode === 'launch');
    if (!drain.holders.length) for (const profile of launchProfiles) drain.holders.push(herdr.open(profile.agentName, 'working', `/tmp/soak/drained-${profile.name}`));
    if (drain.finishedAt === null && now - dayStart >= drained.finishAt) { drain.finishing.push(...drain.holders.map((pane, index) => ({ pane, status: index % 2 ? 'done' : 'idle' }))); drain.finishedAt = now - dayStart; }
    drain.reads = 0;
    const seeded = items[drained.seeded - 1];
    if (drain.seededAt === null && (await store.list()).some(item => item.id === seeded.id && item.ready)) {
      const principal = principalOf(launchProfiles[0]);
      const { epoch } = await engine.execute(principal, 'claim', seeded.id, {}, id());
      const cause = `Worker launch failed: No worker profile can take ${seeded.key}: ${launchProfiles.map(profile => `${profile.name} (Herdr agent ${profile.agentName} is working)`).join('; ')}`;
      await engine.execute(principal, 'blocked', seeded.id, { epoch, reason: `Dispatch failed 3 consecutive times with the same cause since ${new Date(now).toISOString()}, so the master loop stopped redispatching ${seeded.key}: ${cause}` }, id());
      drain.seededAt = now - dayStart;
    }
    if (drain.seededAt !== null && drain.clearedAt === null && !(await store.list()).find(item => item.id === seeded.id)!.blocker) drain.clearedAt = now - dayStart;
    const live = new Map<string, number>();
    for (const agent of herdr.agents.values()) if (agent.name) live.set(agent.name, (live.get(agent.name) ?? 0) + 1);
    drain.peakPerName = Math.max(drain.peakPerName, ...launchProfiles.map(profile => live.get(profile.agentName) ?? 0));
  };
  const lowerFence = async (session: Session) => {
    if (session.settlementToken) await engine.execute(principalOf(session.profile), 'settle', session.work, { epoch: session.epoch, settlementToken: session.settlementToken }, id());
  };
  const workersTick = async (now: number) => {
    for (const session of sessions.filter(entry => entry.state === 'working' || entry.state === 'idling' || entry.state === 'credential-blocked')) {
      if (session.diesAt !== null && now >= session.diesAt) { herdr.kill(session.pane); session.state = 'dead'; continue; }
      // GY-999: the push is refused for want of a GitHub login, and the session records the blocker
      // and waits on it, its supervisor renewing the lease — until the loop ends the attempt.
      if (session.credentialAt !== null && now >= session.credentialAt && session.state === 'working') {
        await engine.execute(principalOf(session.profile), 'blocked', session.work, { epoch: session.epoch, reason: `git push origin ${session.branch} failed: fatal: could not read Username for 'https://github.com': No such device or address` }, id());
        herdr.status(session.pane, 'idle');
        session.state = 'credential-blocked';
        continue;
      }
      if (session.state === 'credential-blocked') {
        try { await engine.execute(principalOf(session.profile), 'heartbeat', session.work, { epoch: session.epoch }, id()); }
        catch (error) { if (!(error instanceof Refusal)) throw error; herdr.kill(session.pane); session.state = 'reclaimed'; }
        continue;
      }
      // The runtime exits and leaves a bare shell in its pane; its supervisor keeps the lease a few
      // minutes more, then releases it, so the item goes to a new attempt without a lease loss.
      if (session.exitsAt !== null && now >= session.exitsAt) {
        const listed = herdr.agents.get(session.pane);
        if (listed?.agent) { listed.agent = null; listed.agent_status = 'unknown'; }
        const principal = principalOf(session.profile);
        if (now < session.exitsAt + 4 * minute) await engine.execute(principal, 'heartbeat', session.work, { epoch: session.epoch }, id());
        else { await engine.execute(principal, 'release', session.work, { epoch: session.epoch }, id()); await lowerFence(session); session.state = 'exited'; }
        continue;
      }
      const principal = principalOf(session.profile);
      // GY-973: the session's runtime hits the spent account and retries on it for ever — still
      // `working` to Herdr, never pushing, its supervisor renewing the lease until the loop ends it.
      if (session.retryingAt !== null && now >= session.retryingAt) { session.retryingAt = null; session.pushAt = Number.MAX_SAFE_INTEGER; screens.set(session.pane, retryBanner); }
      // Herdr misreads the live agent for exactly one cycle: its pane shows no agent, then shows it again.
      const listed = herdr.agents.get(session.pane);
      if (session.misread && listed) { listed.agent = 'claude'; session.misread = false; }
      else if (session.misreadAt !== null && now >= session.misreadAt && listed) { listed.agent = null; session.misread = true; session.misreadAt = null; misreads.push(session.pane); }
      // The worker asks for scope its criteria name and goes idle waiting; the control plane decides
      // it before the loop's next cycle, so the loop never sees the request open.
      if (session.scopeAt !== null && now >= session.scopeAt) {
        session.scopeAt = null;
        await engine.execute(principal, 'scope', session.work, { epoch: session.epoch, paths: [fixture(numberOf(session))], reason: 'The fixture my criterion names' }, id());
        herdr.status(session.pane, 'idle');
        await engine.execute(principals.coordinator, 'autoscope', session.work, { epoch: session.epoch }, id());
        decided.push(`${session.key}:${session.epoch}`);
      }
      // GY-1008: the worker records its blocker, which ends the attempt in the same transaction; its
      // runtime then exits. The needs-decision item's master requested a decision first and put it
      // to no approver, as on 2026-09-30.
      if (session.blockAt !== null && now >= session.blockAt) {
        const n = numberOf(session);
        let decision: string | null = null;
        if (blockerPlan.classes[n] === 'needs-decision') {
          const current = (await store.list()).find(item => item.id === session.work)!;
          decision = (await api(principals.operatorAgent, 'POST', `work/${current.id}/decide`, { action: 'requirements', input: decisionInput('requirements', current, { plannedFiles: [...current.plannedFiles, extraFile(n)] }), reason: `Soak: ${current.key} needs ${extraFile(n)}, requested by the master and put to no approver` })).id;
          blockerDecisions.set(session.key, decision!);
        }
        const blocked = await engine.execute(principal, 'blocked', session.work, { epoch: session.epoch, reason: blockerPlan.text(n, session.branch, decision)! }, id());
        blockerEvents.push({ key: session.key, epoch: session.epoch, elapsed: now - dayStart, lease: blocked.lease?.epoch ?? null });
        herdr.kill(session.pane);
        session.state = 'blocked';
        continue;
      }
      // The unrepresentable item's worker stays live on its refused ask: the item is blocked on
      // scope, so it neither pushes nor submits.
      if (now < session.pushAt || hold.has(session.key)) {
        // A renewal refused is lease loss: the supervisor stops the session, as `watch` does. An
        // idling session whose lease the loop itself ended is not lost — it was reclaimed (GY-852).
        try { await engine.execute(principal, 'heartbeat', session.work, { epoch: session.epoch }, id()); }
        catch (error) {
          if (!(error instanceof Refusal)) throw error;
          herdr.kill(session.pane);
          if (session.state === 'idling') { session.state = 'reclaimed'; continue; }
          // The loop failed the retrying session over, ending its lease: its supervisor stops it.
          if (screens.has(session.pane)) { session.state = 'failed-over'; continue; }
          session.state = 'dead'; lost.push(`${session.key} epoch ${session.epoch}: ${error.message}`);
        }
        // The refused ask stands for hours; near the day's end the worker releases the item with
        // the refusal standing, ending its attempt cleanly instead of lapsing in a later day.
        if (hold.has(session.key) && now >= dayStart + options.hours * hour - 20 * minute) {
          await engine.execute(principal, 'release', session.work, { epoch: session.epoch }, id());
          await lowerFence(session);
          herdr.status(session.pane, 'done');
          session.state = 'dead';
        }
        continue;
      }
      // The bot round makes one commit on the approved head, changing only the findings' files, and submits it.
      if (session.bot) {
        const approved = github.commits.get(session.bot.head)!, head = sha('bot', session.key, session.epoch);
        const contents = new Map(approved.contents);
        for (const path of session.bot.paths) contents.set(path, sha('content', path, head));
        github.record({ sha: head, tree: sha('tree', head), parents: [session.bot.head], files: approved.files, at: now, message: `${session.key}: mechanical review fixes (review ${session.bot.reviewId})` }, contents);
        const pr = [...github.prs.values()].find(entry => entry.branch === session.branch && entry.open)!;
        Object.assign(pr, { head, autoMerge: false, mergeRequestedAt: null });
        pr.pushed.set(head, now);
        botRounds.push({ key: session.key, approved: session.bot.head, head, reviewId: session.bot.reviewId, bot: principal.id, epoch: session.epoch });
        // The fresh read of the rejected item's bot commit requests changes; every other head is approved,
        // a Graphyard-authored tip the queue pushed over the approved head included.
        if (session.key === items[mechanicalDay!.rejected - 1].key) github.verdicts.set(session.key, ['CHANGES_REQUESTED']);
        await engine.execute(principal, 'submit', session.work, { epoch: session.epoch, pr: pr.number, documentation: 'mechanical review fixes only; no documented behaviour changed' }, id());
        session.state = 'submitted';
        herdr.kill(session.pane);
        continue;
      }
      const head = sha('head', session.key, session.epoch);
      const grown = docs?.grow(numberOf(session));
      const sessionFiles = session.files ?? (grown ? [...files(numberOf(session)), grown.page] : files(numberOf(session)));
      const pr = github.push(session.key, session.branch, principal.id, head, sessionFiles, grown);
      await engine.execute(principal, 'submit', session.work, { epoch: session.epoch, pr: pr.number, documentation: 'A simulated item: it changes no documented behaviour' }, id());
      session.state = 'submitted';
      await lowerFence(session);
      // Its work done, the runtime exits and leaves the pane behind (GY-842); the loop's session
      // end closes it in the same step, or the sweep reclaims it as the backstop. On the drained
      // day the runtime instead sits finished at its prompt, holding the profile's name.
      if (options.drained) drain.finishing.push({ pane: session.pane, status: 'done' }); else herdr.kill(session.pane);
    }
    // GY-839: a worker whose candidate was refused on landing does what that refusal asks —
    // graphyard sync, restore what the base changed, push again — once the refusal has outlived the
    // loop's next reading of the candidate (the observation backstop: no gate asks for a fresher one
    // since GY-1235). Under a fault window long enough for a worker to react, this is the worker round
    // the false refusal costs; while GitHub answers merge bases truly the landing comparison clears
    // on its own and no worker is woken at all.
    // The same remedy is what a queue ejection for a landing revert instructs, whose wording names
    // the work rather than a count of files.
    for (const session of sessions.filter(entry => entry.state === 'submitted')) {
      const current = (await store.list()).find(item => item.id === session.work);
      const refused = (current?.gates ?? []).flatMap(gate => gate.passed ? [] : gate.reasons)
        .some(reason => /would revert (?:\d+ files?|work) outside its planned files/.test(reason));
      const candidate = current?.candidate?.sha;
      // A sync answers one candidate; a later refusal of a new candidate is synced again, exactly
      // as a worker runs graphyard sync each time a landing refusal names its current head.
      if (!refused || !candidate || session.syncedFor === candidate) { session.refusedSince = undefined; continue; }
      const since = session.refusedSince ?? now;
      session.refusedSince = since;
      if (now - since <= idleObservationSeconds * 1000) continue;
      session.syncs += 1; session.syncedFor = candidate; session.refusedSince = undefined;
      const syncedGrow = docs?.grow(numberOf(session));
      const sessionFiles = session.files ?? (syncedGrow ? [...files(numberOf(session)), syncedGrow.page] : files(numberOf(session)));
      github.push(session.key, session.branch, principalOf(session.profile).id, sha('head', session.key, session.epoch, 'sync', session.syncs), sessionFiles, syncedGrow);
    }
  };

  // ---- The session record and the prompts the loop gives sessions (GY-544). ----
  const closedLeased: string[] = [];
  // GY-1008: each recorded blocker (with the lease the item held right after it), every probe the
  // loop ran, the needs-decision item's decision, and the loop's blocker actions.
  const blockerEvents: { key: string; epoch: number; elapsed: number; lease: number | null }[] = [];
  const blockerProbes: { key: string; class: BlockerClass; elapsed: number; passed: boolean }[] = [];
  const blockerDecisions = new Map<string, string>();
  const blockerActions: { elapsed: number; work: string | null; state: string; detail: string }[] = [];
  let blockerKeysPeak = 0;
  const decided: string[] = [], misreads: string[] = [], prompts: { key: string; epoch: number; pane: string; text: string }[] = [], exitedLive: string[] = [], exitedClosed: string[] = [];
  const panes = new Map<string, string>();
  const recordSession: DaemonEffects['recordSession'] = async (work, handle) => {
    if (handle.pane) panes.set(`${work.id}:${handle.id}`, handle.pane);
    if (handle.kind === 'implementation' && handle.state === 'finished' && /the agent has exited/.test(handle.outcome ?? '')) {
      const pane = panes.get(`${work.id}:${handle.id}`), listed = pane ? herdr.agents.get(pane) : undefined;
      exitedClosed.push(`${work.key} ${handle.id}`);
      if (listed?.agent) exitedLive.push(`${work.key} ${handle.id} in pane ${pane}, whose agent is live: ${handle.outcome}`);
    }
    return api(principals.coordinator, 'POST', `work/${work.id}/session`, handle);
  };
  const promptSession: DaemonEffects['promptSession'] = async (agent, text) => {
    const session = sessions.find(entry => entry.pane === agent.pane_id);
    prompts.push({ key: session?.key ?? '?', epoch: session?.epoch ?? 0, pane: agent.pane_id!, text });
    // The prompted session resumes — unless it is the scenario's stuck worker, which ignores the
    // paste and stays at its prompt, as the idle worker the loop must reclaim does (GY-852).
    if (session?.state !== 'idling') herdr.status(agent.pane_id!, 'working');
  };
  // Main rewrites the docs page an item documented itself in just as its reviewer approves it: the
  // approved head now conflicts with the base there, and only there (GY-566).
  let docsRewritten = false;
  const docsTick = () => {
    const host = items[plan.docsConflict.item - 1]; // absent on a day planned with fewer items
    const pr = host && [...github.prs.values()].find(entry => entry.key === host.key && entry.open);
    if (docsRewritten || !pr?.reviews.some(review => review.sha === pr.head && review.state === 'APPROVED')) return;
    docsRewritten = true;
    github.docsConflicts.set(pr.key, plan.docsConflict.page);
    github.commit(`Reword ${plan.docsConflict.page}`, github.files);
  };

  // ---- Docs-sync sessions (GY-566): launched by the loop for a docs-only conflict, each merges the base in and pushes. ----
  const docsSyncRuns: { plan: DocsSyncPlan; agentName: string; pane: string; pushAt: number; outcome: 'working' | 'pushed' | 'gave up'; roleFile: string | null }[] = [];
  // GY-1433: the launcher writes each Claude session's role file under a root that carries the
  // master's project settings, and the loop's settle of the session removes it (docsSyncSettled).
  const docsSyncRoot = await temporaryDirectory('soak-docs-sync');
  await mkdir(join(docsSyncRoot, '.claude'), { recursive: true });
  await writeFile(join(docsSyncRoot, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { deny: ['Bash(git push:*)'] } }));
  const docsSync: DaemonEffects['docsSync'] = async (_work, docsPlan) => {
    const agentName = docsSyncSessionName(docsPlan);
    if (herdr.byName(agentName)) throw new Error(`Docs-sync session ${agentName} is already visible in Herdr; let it finish first`);
    const { file: roleFile } = await docsSyncHarness(docsSyncRoot, config, docsPlan, 'claude');
    const pane = herdr.open(agentName);
    docsSyncRuns.push({ plan: docsPlan, agentName, pane, pushAt: clock.now() + plan.docsConflict.syncMs, outcome: 'working', roleFile });
    return { agentName, pane, account: 'claude-reviewer', runtime: 'claude', session: null };
  };
  const docsSyncTick = (now: number) => {
    for (const run of docsSyncRuns.filter(entry => entry.outcome === 'working' && now >= entry.pushAt)) {
      run.outcome = github.docsSync(run.plan.key, run.plan.head, run.plan.base) ? 'pushed' : 'gave up';
      herdr.status(run.pane, 'done');
    }
  };

  // ---- Approvers and producers: sessions the loop launches, each acting on the minute after. ----
  const wakes: { key: string; at: number }[] = [];
  // The decision each launch judges beside its item (GY-1389: one approver per capped round).
  const approverPanes: string[] = [], approverWorks: string[] = [], approverDecisions: string[] = [];
  /** A headless approver's verdict, applied as the approver identity; each run's launch is counted once it is. */
  const applyVerdict = (workId: string, run: string) => async (result: RunResult<DecidePayload>): Promise<Applied[]> => {
    if (!result.ok) return [];
    headless!.applied.push(run);
    return [await applyDecision(url, token(principals.approver), { id: workId }, result.payload)];
  };
  // GY-475: the scenario's refusals and every request the loop sent, so the day can be judged on
  // what its first request after the loss of the loop's own cursor already cited.
  const refused: { key: string; decision: string }[] = [];
  const decideCalls: { key: string; action: string; reason: string; input: unknown }[] = [];
  // GY-551: decisions a master requested and put to an approver by hand (`master approver`), whose
  // sessions all end without judging: the first vanishes or stops, each relaunch the loop makes
  // stops `done`, and one relaunch is refused by a registry timeout.
  const hand = new Map<string, { key: string; launches: number; refused: number }>();
  // GY-1294: the diagnosis decisions a revision race staled before their approver read them.
  const diagnosisRaces: { key: string; decision: string; action: string; outcome: string }[] = [];
  // GY-1318: the request-time leg of the same race — a diagnosis decide refused before any decision is recorded.
  const diagnosisRequestRaces: { key: string; action: string; revision: number }[] = [];
  // GY-1297: approvals a fault left with no outcome — the ledger holds the approval and nothing
  // after it — and every withdrawal the loop sent for each.
  const stranded = new Map<string, { key: string; workId: string; kind: 'moved' | 'holds'; watched: boolean; pane: string | null }>(), withdrawals = new Map<string, number>();
  // GY-1300: with `stranded: 'resume'` the loop has production's resume effect; each resume it sent,
  // with the state the control plane answered, and each approver launch for a stranded decision.
  const resumes = new Map<string, string[]>(), strandedLaunches = new Map<string, number>();
  // The first attestation the loop requests is overtaken: its worker pushes a new head before the
  // approver judges, so the loop must withdraw it, close its approver and ask afresh for the new head.
  const attestations: { decision: string; sha: string; judged: 'overtaken' | 'approved' }[] = [];
  // GY-849: approver launches the capacity window refused, the launches that succeeded once it
  // closed, and the watches still waiting when it did, each with its request's age.
  const capacityRefused: { decision: string; key: string; elapsed: number }[] = [];
  const capacityLaunched: { decision: string; key: string; elapsed: number }[] = [];
  let capacityWaiters: { decision: string; key: string; requestedAt: string }[] | null = null;
  const approver: DaemonEffects['approver'] = async (work, decision) => {
    // As production's launchApprover, a session of this name still live in Herdr refuses the
    // launch, whatever asked for it: the doctor's approver remedy (GY-711) and the loop's own
    // supervision share this effect, and two live sessions for one decision would judge it twice.
    // A stopped session's pane lingers until the sweep closes it; its relaunch opens a fresh pane,
    // as the sweep-then-relaunch pair does.
    const name = approverSessionName(work, decision);
    if (stranded.has(decision)) strandedLaunches.set(decision, (strandedLaunches.get(decision) ?? 0) + 1);
    if (herdr.list().some(agent => agent.name === name && !stoppedStates.includes(agent.agent_status ?? '')))
      throw new Error(`Approver session ${name} is already live in Herdr; let it finish or close it first`);
    // The window is read on the day's own schedule too, as the waiters at its close and the launches
    // after it are: the simulated clock runs real time forward, so on a slow host a window read from
    // it would close minutes early and let a rework decision it should hold launch at once.
    if (options.capacityWait && elapsed >= options.capacityWait.from && elapsed < options.capacityWait.to) {
      capacityRefused.push({ decision, key: work.key, elapsed });
      throw Object.assign(new Error('No healthy agent account for the approver: every approver account is spent until its quota resets'), { capacityExhausted: true });
    }
    const unjudged = hand.get(decision);
    // The relaunch bound is counted in cycles, so the launch is recorded on the day's own schedule
    // (`elapsed`, advanced one simulated minute per cycle): the simulated clock also runs real time
    // forward since the day was installed, and a launch recorded on it would overrun a two-cycle
    // bound by however slow the host was, not by any cycle the loop spent.
    if (!unjudged) capacityLaunched.push({ decision, key: work.key, elapsed });
    if (unjudged) {
      unjudged.launches += 1;
      if (unjudged.key === items[plan.items - 1].key && unjudged.launches === 1) { unjudged.refused += 1; throw new Error('the agent registry for the approver role is unreachable: timeout'); }
      // The relaunch is confined like the launch it retries (GY-888); an approver session runs
      // from the coordinator checkout itself, so the wrapper re-exposes nothing of it.
      await confine('approver', work.key, coordinatorRoot!);
      const agentName = approverSessionName(work, decision), pane = herdr.open(agentName);
      pending.push(async () => { herdr.status(pane, 'done'); });
      return { agentName, pane };
    }
    await confine('approver', work.key, coordinatorRoot!);
    const agentName = approverSessionName(work, decision);
    approverWorks.push(work.key); approverDecisions.push(decision);
    const standing = (await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(work.id)}/decisions`)).decisions.find((entry: { id: string }) => entry.id === decision);
    // Only a reworked item's worker is still there to resubmit the head that overtakes the request;
    // on any other day the attestation is judged as asked.
    const overtaker = !headless && standing?.action === 'attest' && !attestations.length && plan.rework.has(numberOf(work)) ? sessions.find(entry => entry.key === work.key) : undefined;
    if (standing?.action === 'attest') attestations.push({ decision, sha: standing.input.sha, judged: overtaker ? 'overtaken' : 'approved' });
    if (headless) {
      const n = numberOf(work), launch = (headless.launched.get(n) ?? 0) + 1, run = `${decision}#${launch}`;
      headless.launched.set(n, launch); headless.runs.set(decision, (headless.runs.get(decision) ?? 0) + 1);
      const started = startNarrowRun({ runner: headless.pi, name: agentName, role: 'approver', work: work.key, subject: decision, root: headless.root, context: { workId: work.id, decision, run },
        prompt: `Judge ${decision}`, options: approverRunOptions(headless.root, decision, {}, 30 * minute), apply: applyVerdict(work.id, run) });
      const directory = started.run.directory!;
      headless.settling.set(directory, started.settled);
      // A run judges on the second minute after its launch, so a restart finds it live.
      let judging = false;
      const act = async () => {
        if (!judging) { judging = true; pending.push(act); return; }
        if (launch <= (plan.killedApprovers.get(n) ?? 0)) { headless.pi.kill(directory); return; }
        headless.pi.submit(directory, { decision, approve: true, reason: `Approved: the loop's routine decision for ${work.key} rests on what it verified` });
        headless.submitted.push(run);
      };
      pending.push(act);
      return { agentName, pane: null, run: started.record, settled: started.settled };
    }
    // GY-973: approvers launch on the first account the loop has not held; the scenario's first
    // approver for its item lands on a spent one and retries on it, working to Herdr, judging nothing.
    const account = options.retrying ? ['approver-a', 'approver-b'].find(name => !accountHeld(name)) ?? null : null;
    if (account) approverAccounts.push({ key: work.key, account });
    if (options.retrying?.approver === numberOf(work) && approverAccounts.filter(entry => entry.key === work.key).length === 1) {
      const pane = herdr.open(agentName);
      screens.set(pane, retryBanner);
      return { agentName, pane, account };
    }
    const pane = herdr.open(agentName);
    approverPanes.push(pane);
    if (overtaker) {
      pending.push(async () => { github.push(work.key, overtaker.branch, overtaker.profile.principal, sha('head', work.key, 'moved'), [file(numberOf(work))]); });
      return { agentName, pane };
    }
    // GY-971: the mechanical-fix day's approvers take ten minutes to judge, as a real session does,
    // so an approved head the merge step did not hold would land before its bot round was applied.
    const judgeAt = clock.now() + (mechanicalDay ? 10 * minute : 0);
    pending.push(async function judge() {
      if (clock.now() < judgeAt) { pending.push(judge); return; }
      const current = (await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(work.id)}/decisions`)).decisions.find((entry: { id: string; state: string }) => entry.id === decision);
      // A session relaunched onto a decision judged while it was being launched finds the decision
      // applied and exits without judging: the judge itself refuses a second verdict, and the day
      // must not die on what a real session would simply see.
      if (!current || current.state !== 'requested') { herdr.status(pane, 'done'); return; }
      // GY-1294, the 2026-10-04/05 shape: a write of the loop's own lands on the diagnosed item
      // between the diagnosis decision's request and its approver's read, so the server settles the
      // decision stale ("Task revision changed; reload and request again"). The loop's decisions
      // step must ask again, and the decision it asks for is judged as any other.
      if (options.staleDiagnosis && !diagnosisRaces.length && (current.action === 'close' || current.action === 'release')
        && Object.values(state.diagnoses).some(entry => entry.decision?.id === decision)) {
        await engine.execute(principals.coordinator, 'request', work.id, { type: 'note', reason: `Soak: the loop's own note on ${work.key}, landing before the approver reads ${decision}` }, id());
        const outcome = await api(principals.approver, 'POST', `work/${work.id}/approve`, { decision, reason: `Approved: the loop's routine ${decision} decision for ${work.key} rests on what it verified` })
          .then(() => 'applied', (error: Error) => error.message);
        diagnosisRaces.push({ key: work.key, decision, action: current.action, outcome });
        herdr.status(pane, 'done');
        return;
      }
      // GY-1315: every release of the racing item meets the same race, until the loop stops asking.
      if (options.staleRelease && current.action === 'release' && numberOf(work) === options.staleRelease.racing) {
        await engine.execute(principals.coordinator, 'request', work.id, { type: 'note', reason: `Soak: a note on ${work.key}, landing before the approver reads ${decision}` }, id());
        const outcome = await api(principals.approver, 'POST', `work/${work.id}/approve`, { decision, reason: `Approved: release ${work.key}` }).then(() => 'applied', (error: Error) => error.message);
        staleReleaseDay.races.push({ key: work.key, decision, outcome, at: clock.now() });
        herdr.status(pane, 'done');
        return;
      }
      const refuseDue = (!!options.refuseReworkOf?.includes(numberOf(work)) && !refused.some(entry => entry.key === work.key)
        && current.action === 'rework') || (!!cappedDay?.refused.includes(numberOf(work)) && current.action === 'rework' && /:capped:/.test(current.input?.binding ?? ''));
      if (refuseDue) {
        await api(principals.approver, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision, reason: `Refused: ${work.key}'s rework rests on grounds this approver does not accept` });
        refused.push({ key: work.key, decision });
      } else {
        await api(principals.approver, 'POST', `work/${work.id}/approve`, { decision, reason: `Approved: the loop's routine ${decision} decision for ${work.key} rests on what it verified` });
      }
      herdr.status(pane, 'done');
    });
    return { agentName, pane, account };
  };
  // GY-496: the dispatcher's producer request for item `plan.spentProducer`'s first head, scheduled by
  // the real `sessionRetry`. Its first runs are killed (a lost run relaunches at once, spending no
  // attempt), the rest fail, until the request is spent and the dispatcher stops attempting it.
  const producerRuns: { requestId: string; state: string; requestedAt: string; closedAt: string | null; resolution: string | null }[] = [];
  const abandoned = new Map<string, ExhaustedProof>();
  let spentHead: string | null = null;
  const spentOn = (work: Work) => mainDay && numberOf(work) === plan.spentProducer && !!work.candidate && (spentHead ??= work.candidate.sha) === work.candidate.sha;
  const producersTick = async (now: number) => {
    if (!mainDay) return;
    const item = (await store.list()).find(entry => numberOf(entry) === plan.spentProducer);
    if (!item?.submission || !item.candidate || item.stage === 'done' || !spentOn(item)) return;
    const requestId = `soak-producer-${item.key}-${item.candidate.sha.slice(0, 12)}`, at = new Date(now).toISOString();
    if (abandoned.has(requestId)) return;
    const runs = () => producerRuns.filter(run => run.requestId === requestId);
    const running = runs().find(run => run.state === 'pending');
    if (running) Object.assign(running, { state: 'failed', closedAt: at, resolution: runs().length <= plan.lostRuns
      ? `${lostRunReason}: the headless run was killed (pi exited on SIGTERM) before it reached a verdict, without trusted evidence for ${PROOF} (missing); it is relaunched and not counted as an attempt`
      : `the headless run ended (exit: pi exited with code 1) without trusted evidence for ${PROOF} (fail)` });
    const retry = sessionRetry(producerRuns, requestId, now);
    if (retry.exhausted) abandoned.set(requestId, { requestId, work: item.key, sha: item.candidate.sha, group: 'unit', proofs: [PROOF], reason: `${retry.started} of its sessions failed`, attempts: runs().map(run => `${run.state}: ${run.resolution}`) });
    else if (retry.launch) {
      // A headless producer run is wrapped at its spawn by the launcher's own seam (GY-888), and
      // a host that cannot confine one refuses it instead of starting it unconfined.
      confined.push({ role: 'producer', key: item.key, directory: coordinatorRoot!, mechanism: 'read-only-mount', reexposed: reexposedWritable(headlessConfinementWrapper(coordinatorRoot!, coordinatorRoot!)) });
      try { headlessConfinementWrapper(coordinatorRoot!, coordinatorRoot!, null); unconfinedRefusals.push('the headless run was not refused'); }
      catch (error) { unconfinedRefusals.push(error instanceof Error ? error.message : String(error)); }
      producerRuns.push({ requestId, state: 'pending', requestedAt: at, closedAt: null, resolution: null });
    }
  };
  // GY-1099: the starved items' evidence, held until their other gates pass (see `starved` above).
  const starvedProof = new Map<string, Work>();
  const requestProof: DaemonEffects['requestProof'] = work => {
    if (options.starved?.items.includes(numberOf(work))) { starvedProof.set(work.id, work); return; }
    pending.push(async () => {
      const current = (await store.list()).find(item => item.id === work.id)!;
      if (!current.candidate || current.candidate.sha !== work.candidate?.sha || current.stage === 'done') return;
      // The trusted workflow publishes nothing for the spent head: only the dispatcher's producer runs stand for it.
      if (spentOn(current)) return;
      for (const proof of new Set(current.criteria.flatMap(cr => cr.proofs))) {
        const matchingCriteria = current.criteria.filter(cr => cr.proofs.includes(proof)).map(cr => cr.id);
        const criterion = matchingCriteria[0] ?? 'AC-1';
        await engine.execute(principals.producer, 'evidence', current.id, { proof, sha: current.candidate.sha, baseSha: current.candidate.baseSha, policyRevision: current.policyRevision, result: 'pass', executed: 4, skipped: 0,
          exercise: { criterion, behaviour: `item ${numberOf(current) || current.key}'s change`, result: 'fail', executed: 1 } }, id());
      }
    });
  };

  // ---- Production: two deploys, each a new control-plane build serving the base tip it was cut from. ----
  const production = { build: sha('build', 0), sha: github.tip, deploys: [] as { at: number; build: string; sha: string }[] };
  // GY-852: the reassigned day runs on a control plane the earlier days share, so its loop reads
  // only its own items: an earlier day's half-finished item (a rework decision nobody adopted)
  // would otherwise be dispatched, pushed and refused here for its linked pull request. The
  // containment day (GY-811) runs last and reads only its own items too, so its cycles do not pay
  // for every earlier day's delivered work; the failover day (GY-417) reads only its own as well. The mechanical day (GY-971) starts a plane of its own
  // and keeps the filter so it does not depend on where it falls in the file.
  const ownItems = options.reassigned || options.headless || options.blockers || options.credentialBlocked || options.dispatchFailing || options.drained || options.containment || options.mechanical || failover ? new Set(items.map(item => item.id)) : null;
  const snapshot = async () => { const read = await store.coordinationSnapshot(); return { work: ownItems ? read.work.filter(item => ownItems.has(item.id)) : read.work, now: read.now, jobs: read.jobs }; };
  // ---- Host memory (GY-612): below its floor the loop launches nothing, recording the crossing once each way. ----
  const dip = plan.memoryDip;
  const GiB = 2 ** 30;
  let memoryReads = 0;
  const memoryReading = (): HostMemoryReading => {
    const elapsed = clock.now() - dayStart;
    if (!dip || elapsed < dip.from || elapsed >= dip.until) return { totalBytes: 62 * GiB, availableBytes: 20 * GiB };
    // The same two consumers with their ranking reversed every other read: the host's `ps` ranking
    // moves while a dip stands, and a fault keyed on that wording would churn instances (GY-612).
    const consumers = [{ command: 'node', processes: 3, rssBytes: 6 * GiB }, { command: 'claude', processes: 2, rssBytes: 5 * GiB }];
    if (memoryReads++ % 2 === 1) consumers.reverse();
    return { totalBytes: 62 * GiB, availableBytes: 2 * GiB, consumers };
  };
  // The pipeline doctor (GY-711) fires inside this world too: a scripted Pi run reports the first
  // item as stuck, the loop applies the report through its real path, and every run summary is
  // posted to the control plane the dashboard reads. The day thus proves the doctor step fires
  // from the real cycle on its interval — per-cycle behaviour belongs in this world.
  const doctor: DaemonEffects['doctor'] = {
    settings: { ...doctorSettingsSchema.parse({}), command: 'pi' }, cwd: '/soak/coordinator', env: {},
    runner: async () => ({ runtime: 'pi', model: 'soak/doctor', runner: {
      name: 'pi', start: (_prompt: string, runOptions: { tool: string }) => ({
        id: `soak-doctor-${clock.now()}`, events: [], onEvent: () => () => {}, cancel: () => {},
        result: async () => ({ ok: true as const, tool: runOptions.tool, payloads: [],
          payload: { findings: [{ subject: items[0].key, check: 'worker' as const, detail: 'The scripted soak finding: this item stood in its stage past the worker bound', unactionable: false }], actions: [], filed: [] } }) }) } as unknown as Runner }),
    file: async input => api(principals.operatorAgent, 'POST', 'work', input) as Promise<Work>,
    recordRun: async run => api(principals.operatorAgent, 'POST', 'doctor', run),
  };
  const observeRequests: { key: string; sha: string; at: number }[] = [];
  // The diagnostician (GY-439), faked: its run answers from the evidence the prompt carries, and
  // its filing and deciding ride the same routes the production wiring uses, as the master's
  // operator-agent identity.
  const settings = diagnosticianSettings({ diagnostician: { invariantBoundMinutes: 30 } });
  const diagnosed: DiagnosisRun[] = [];
  clearDrafts();
  const acceptance = options.acceptance ? await acceptanceWorld(dayStart) : null;
  // GY-1092: for `diagnosisLimit` the provider refuses every run for its spent quota, naming no reset.
  const limited = () => !!options.diagnosisLimit && clock.now() - dayStart >= options.diagnosisLimit.from && clock.now() - dayStart < options.diagnosisLimit.to;
  const diagnostician: DiagnosticianEffects = {
    settings, cwd: '/tmp/soak/checkout',
    runner: async attempt => ({ runner: diagnosisRunner(diagnosed, attempt, limited), runtime: `soak-${attempt}`, model: attempt === 'primary' ? settings.model : settings.fallbackModel }),
    context: async () => ({ journal: [`${new Date(clock.now()).toISOString()} graphyard-master: 1 integration job(s) held on a permission shortfall`], serverLog: [`${new Date(clock.now()).toISOString()} POST /api/status 200`], pullRequests: [] }),
    file: (input, key) => engine.execute(principals.operatorAgent, 'create', null, input, key),
    // GY-1318: on a staleDiagnosis day the first decide names the revision the item held before the
    // loop's own write moved it, so the control plane refuses it at request time (GY-1304's instance).
    decide: (work, action, reason, input = {}) => {
      // A revision before the first is no race: it is refused as invalid input, not as moved.
      const raced = !!options.staleDiagnosis && !diagnosisRequestRaces.length && work.revision > 1;
      if (raced) diagnosisRequestRaces.push({ key: work.key, action, revision: work.revision - 1 });
      return api(principals.operatorAgent, 'POST', `work/${work.id}/decide`, { action, input: decisionInput(action, raced ? { ...work, revision: work.revision - 1 } : work, input), reason });
    },
  };
  // GY-711's routine remedies run from the real cycle: this host's containment probe (its
  // supervisor verified gone once the fence lapsed), the coordinator's autosettle — whose first
  // call the control plane fails transiently, so the reclaim step's settle fails and a later settle
  // (its own retry or the doctor's settle remedy) lowers the fence — and the operator-agent unblock.
  const remedies = { settles: [] as { key: string; ok: boolean }[], unblocks: [] as { key: string; revision: number }[] };
  const containment: DaemonEffects['containment'] = async (work, observed) => {
    const now = Date.parse(observed.now);
    return Object.fromEntries(work.filter(item => item.containmentQuarantine && containmentPhase(item, now)?.state !== 'live').map(item => {
      const fence = item.containmentQuarantine!, workspace = item.workspaces.find(entry => entry.epoch === fence.epoch)!;
      const verification = containmentVerificationSchema.parse({ method: 'linux-proc-systemd', host: workspace.host, uid: 1000, platform: 'linux', workspacePath: workspace.path,
        observedAt: observed.now, clockOffset: { min: 0, max: 0 }, processes: [], scopes: [], inaccessible: 0, unverifiable: [] });
      const refusals = containmentSettlementRefusals(item, verification, { now });
      return [item.id, { key: item.key, id: item.id, epoch: fence.epoch, owner: fence.owner, at: fence.at, host: workspace.host, workspacePath: workspace.path, scope: fence.scope ?? null,
        settleable: !refusals.length, refusals, attestation: 'soak', verification }];
    }));
  };
  const settleContainment: DaemonEffects['settleContainment'] = async (work, assessment) => {
    const first = !remedies.settles.length;
    remedies.settles.push({ key: work.key, ok: !first });
    if (first) throw new Error('the control plane answered 502 Bad Gateway');
    return api(principals.coordinator, 'POST', `work/${work.id}/autosettle`, { epoch: assessment.epoch, settlementHash: work.containmentQuarantine!.settlementHash,
      reason: `The soak loop verified the supervisor of epoch ${assessment.epoch} gone`, verification: assessment.verification });
  };
  const unblock: DaemonEffects['unblock'] = async (work, reason) => {
    remedies.unblocks.push({ key: work.key, revision: work.revision });
    return api(principals.operatorAgent, 'POST', `work/${work.id}/unblock`, { reason, expectedRevision: work.revision });
  };
  // The control plane's status read the faults are classified from; `heldJobs` is the flap below.
  let heldJobs = false;
  const recordDecompositionEffect: DaemonEffects['recordDecomposition'] = async (work, event) => {
    if (event.event === 'decided') {
      for (const child of event.payload.children) {
        decompositionHistory.createdChildren.push(child.title);
      }
    }
    return api(principals.coordinator, 'POST', `work/${work.id}/decomposition`, event);
  };
  // GY-1302: the loop's promotion drive. Main moves with every merge of the day while production
  // moves only on its deploys, so a promotion is due all day; each dispatched candidate validates
  // for ninety minutes and GitHub lists it only two minutes after the dispatch, so the loop's own
  // record of its dispatch is what holds the next one back meanwhile. For the day's first hour every
  // dispatch is refused (a token without actions: write), and for the half hour after it the remote
  // cannot be fetched: neither failure is repeated every cycle.
  const promotion = { ledgerReads: 0, runReads: 0, dispatches: [] as number[], violations: [] as string[], validationMs: 90 * minute, listedAfterMs: 2 * minute,
    failDispatchUntil: hour, failLedger: [hour, hour + 30 * minute] as const, failedDispatches: [] as number[], failedLedgerReads: 0 };
  const promotionEffect: DaemonEffects['promotion'] = options.promotion ? {
    ledger: async () => {
      promotion.ledgerReads++;
      const into = clock.now() - dayStart;
      if (into >= promotion.failLedger[0] && into < promotion.failLedger[1]) { promotion.failedLedgerReads++; throw new Error('git fetch: Could not resolve host: github.com'); }
      return { mainSha: github.tip, promotedSha: production.sha, promotedAt: null, behind: github.tip === production.sha ? 0 : 1 };
    },
    runs: async () => {
      promotion.runReads++;
      return promotion.dispatches.filter(at => clock.now() - at >= promotion.listedAfterMs).reverse()
        .map(at => ({ status: clock.now() < at + promotion.validationMs ? 'in_progress' : 'completed', createdAt: new Date(at).toISOString(), event: 'workflow_dispatch' }));
    },
    dispatch: async () => {
      const now = clock.now(), last = promotion.dispatches.at(-1);
      if (now - dayStart < promotion.failDispatchUntil) { promotion.failedDispatches.push(now); throw new Error('gh: HTTP 403: Resource not accessible by integration'); }
      if (github.tip === production.sha) promotion.violations.push(`+${Math.round((now - dayStart) / minute)} min: dispatched while production runs main`);
      if (last !== undefined && now < last + promotion.validationMs) promotion.violations.push(`+${Math.round((now - dayStart) / minute)} min: dispatched while the candidate of +${Math.round((last - dayStart) / minute)} min is in validation`);
      if (last !== undefined && now - last < 120 * minute) promotion.violations.push(`+${Math.round((now - dayStart) / minute)} min: dispatched ${Math.round((now - last) / minute)} min after the last`);
      const refused = promotion.failedDispatches.at(-1);
      if (refused !== undefined && now - refused < 120 * minute) promotion.violations.push(`+${Math.round((now - dayStart) / minute)} min: dispatched ${Math.round((now - refused) / minute)} min after a refused attempt`);
      promotion.dispatches.push(now);
    },
  } : undefined;
  // GY-1385: the loop's own throughput measurement after each verified deployment, through the
  // real loopThroughputMeasurement, recorded under a directory of this day's own. The plane's status
  // names a deployed release only statusLagMs after the loop first asks for it, as a rollout that
  // lags the deployment record does, so the loop's wait and its bounded re-asks run on every day.
  // The claim is the day's first merged item: before it merges there is no window, and nothing is measured.
  const initialProduction = production.sha;
  const throughput = { root: await temporaryDirectory('soak-measurements'), statusLagMs: 3 * minute, statusReads: 0, firstAsk: new Map<string, number>(),
    asks: [] as { sha: string; outcome: string; revision: string | null; elapsed: number; read: number }[], claim: () => github.merges[0]?.key ?? throughputClaim.item };
  const servingRevision = () => {
    const last = production.deploys.at(-1), since = last && throughput.firstAsk.get(last.sha);
    return last && (since === undefined || clock.now() < since + throughput.statusLagMs) ? production.deploys.at(-2)?.sha ?? initialProduction : production.sha;
  };
  const measureThroughput: DaemonEffects['measureThroughput'] = async (work, observedSha) => {
    if (!throughput.firstAsk.has(observedSha)) throughput.firstAsk.set(observedSha, clock.now());
    const outcome = await loopThroughputMeasurement(throughput.root, { work, observedSha, now: clock.now, origin: url, claimKey: throughput.claim(),
      status: async () => { throughput.statusReads++; return { now: new Date(clock.now()).toISOString(), release: { version: '0.9.1', revision: servingRevision() } }; },
      readItem: id => api(principals.coordinator, 'GET', `work/${encodeURIComponent(id)}`),
      contains: async (ancestor, descendant) => github.contains(descendant, ancestor) });
    throughput.asks.push({ sha: observedSha, outcome: outcome.outcome, revision: outcome.revision, elapsed: clock.now() - dayStart, read: outcome.read?.length ?? 0 });
    return outcome;
  };
  const effects: DaemonEffects = {
    ...(promotionEffect ? { promotion: promotionEffect } : {}),
    measureThroughput,
    agents: () => { finishDuringCycle(); return headless ? withRunnerAgents(herdr.list()) as ReturnType<SimulatedHerdr['list']> : herdr.list(); },
    herdr: () => ({ agents: headless ? withRunnerAgents(herdr.list()) as ReturnType<SimulatedHerdr['list']> : herdr.list(), available: true }),
    ...(headless ? { adoptRuns: () => adoptRuns(headless.root, { approver: async owner => ({ options: approverRunOptions('', String(owner.context.decision), {}, 30 * minute),
      apply: applyVerdict(String(owner.context.workId), String(owner.context.run)) }) }, { runner: headless.pi }) } : {}),
    panes: async () => ({ panes: herdr.paneList(), available: true }),
    recordSession,
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, accountHeld(`account-${profile.name}`) ? { available: false, reason: `account-${profile.name} is held until ${heldAccounts.get(`account-${profile.name}`)!.resetsAt}` } : { available: true, reason: null }])),
    snapshot, dispatch, requestProof, approver, docsSync, docsSyncSettled: synced => releaseDocsSyncHarness(docsSyncRoot, synced), doctor, containment, settleContainment, unblock,
    closeSession: async pane => {
      const name = herdr.agents.get(pane)?.name ?? '';
      if ((options.regression?.includes('approvers-left-open') && /approver/.test(name)) || (options.regression?.includes('docs-syncs-left-open') && /docs-sync/.test(name))) return;
      // GY-980: no step closes a worker's pane while its attempt holds a live lease — the sweep's
      // worktree shells and idle agents included — unless its runtime exited, whose session end
      // closes the bare shell under the lease its supervisor still holds (GY-544).
      const session = sessions.find(entry => entry.pane === pane), lease = session ? (await store.list()).find(item => item.id === session.work)?.lease : null;
      const exited = session?.exitsAt != null && clock.now() >= session.exitsAt;
      if (session && !exited && lease && lease.epoch === session.epoch && Date.parse(lease.expiresAt) > clock.now()) closedLeased.push(`${session.key} epoch ${session.epoch} pane ${pane}`);
      herdr.close(pane);
    },
    decide: (work, action, reason, input = {}) => {
      const bound = decisionInput(action, work, input);
      decideCalls.push({ key: work.key, action, reason, input: bound });
      return api(principals.operatorAgent, 'POST', `work/${work.id}/decide`, { action, input: bound, reason });
    },
    decisions: work => api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(work.id)}/decisions`),
    withdraw: (work, decision, reason) => { withdrawals.set(decision, (withdrawals.get(decision) ?? 0) + 1); return api(principals.operatorAgent, 'POST', `work/${work.id}/decide`, { action: 'withdraw', decision, reason }); },
    ...(options.stranded === 'resume' ? { resume: async (work: Work, decision: string) => {
      const settled = await api(principals.operatorAgent, 'POST', `work/${work.id}/decide`, { action: 'resume', decision });
      resumes.set(decision, [...resumes.get(decision) ?? [], settled.state]);
      return settled;
    } } : {}),
    faultClassPolicy: { threshold: 3, windowHours: 24 },
    fileFaultClass: (input, key) => {
      // The documentation trim item is what the once-only filing assertion reads (GY-574).
      if (input.title.startsWith(docsTrimTitle)) docsFilings.push(key);
      return engine.execute(principals.operatorAgent, 'create', null, input, key);
    },
    diagnostician,
    ...(acceptance ? { acceptance: acceptance.effects } : {}),
    baseSuccessions: async since => ({ tip: github.tip, successions: github.successions.filter(entry => github.commits.get(entry.commit)!.at >= Date.parse(since)), files: new Set(github.files) }),
    replan: (work, paths, reason) => api(principals.operatorAgent, 'POST', `work/${work.id}/requirements`, successorWidening(work, paths, reason)),
    // The scope scenarios run the loop's own deciding and widening effects: the rule decides the
    // open requests, and the loop widens on the findings it reads, posting the folded revision.
    ...(options.scope ? {
      decideScope: (work: Work) => api(principals.operatorAgent, 'POST', `work/${work.id}/autoscope`, { epoch: work.scopeRequest!.epoch }),
      reviewFindings: async (work: Work) => {
        const named = findings.get(work.key);
        return named ? [{ ground: 'review thread 1', text: `Please also update ${[...named].join(', ')} in this round.` }] : [];
      },
      basePaths: async (paths: readonly string[]) => new Set<string>(paths),
      widenScope: async (work: Work, request: ScopeRequestState, paths: string[], reason: string) => {
        const status = transientWidenings.get(numberOf(work));
        if (status) {
          transientWidenings.delete(numberOf(work)); transientRefused.push({ n: numberOf(work), status, elapsed });
          const error = status === 409 ? 'Policy revision changed; reload before revising' : 'Internal error; consult server logs';
          throw new RefusedResponse(`Graphyard refused work/${work.id}/requirements (${status}): ${error}`, status, { error });
        }
        return api(principals.operatorAgent, 'POST', `work/${work.id}/requirements`, answeringWidening(work, request, paths, reason));
      },
      // The first read of the partial item's history once its request is refused answers past the step's deadline.
      decisions: async (work: Work) => {
        if (numberOf(work) === scopePlan.partial && !lateReads.length && work.scopeRequest?.decision?.state === 'refused') {
          lateReads.push({ n: numberOf(work), elapsed });
          await new Promise(resolve => setTimeout(resolve, decisionReadDeadlineMs + 500));
        }
        return api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(work.id)}/decisions`);
      },
    } : {}),
    controlPlane: async () => ({ build: { commit: production.build }, ...(heldJobs ? { heldJobs: 1 } : {}) }),
    observeDeployment: async delivered => {
      const serving = delivered.filter(item => github.contains(production.sha, item.delivery!.mergeSha));
      return { source: 'endpoint', sha: production.sha, at: new Date(clock.now()).toISOString(), reason: null, deployed: serving.map(item => item.key), pending: delivered.filter(item => !serving.includes(item)).map(item => item.key) };
    },
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    // The base failure (GY-528): CI logs and the base head's run read from GitHub, reruns, and what the operator-agent files and asks for.
    failedTests: async job => github.failedTests(job),
    baseCheck: async check => github.baseCheck(check),
    rerunJob: async job => { await github.rerun(job, 'loop'); },
    fileBaseFailure: async (input, key) => { const filed = await api(principals.operatorAgent, 'POST', 'work', input, key); baseFailure.filed.push(filed); return filed; },
    refreshCandidate: async (work, reason, key) => { baseFailure.refreshes.push(work.key); return api(principals.operatorAgent, 'POST', `work/${work.id}/refresh`, { reason, base: work.observation?.baseTip }, key); },
    hostMemory: async () => memoryReading(),
    // A rework refused on a stale observation wakes the item's observation job (GY-710) through
    // the server's own resync endpoint, as `master run` wires it.
    wakeObservation: work => { wakes.push({ key: work.key, at: clock.now() }); return api(principals.coordinator, 'POST', `work/${work.id}/resync`, {}); },
    reclaimResources: (work, agents) => reclaimResources(reclaimRoot, { reviewers: [], producers: [] }, { work, agents }, { closePane: pane => { herdr.close(pane); }, tmpRoot, tmpPass }),
    // What the loop's reclaim path needs to end an attempt on the record (GY-852): the partial
    // work kept on its branch, and the capacity report that ends the lease in the same transaction.
    // They ride the reassigned and credential-blocked days alone, whose attempts are the ones the
    // loop ends; the other days' dead workers lapse as they always did.
    // GY-973: the retrying day reads each pane's screen tail, and each worker profile runs on an
    // account of its own, which the loop holds when a session spends it.
    ...(options.retrying ? {
      sessionOutput: (agent: HerdrAgent) => screens.get(agent.pane_id ?? '') ?? `● Working as ${agent.name}…\n`,
      selectedAccount: async (role: string, profile: string) => role === 'worker' ? { environment: `account-${profile}`, kind: null } : null,
      holdAccount: async (account: string, observed: { resetsAt: string | null }) => { heldAccounts.set(account, { resetsAt: observed.resetsAt }); },
    } : {}),
    ...(options.reassigned || options.credentialBlocked || options.retrying ? {
      reportCapacity: async (work: Work, event: Record<string, unknown>) => api(principals.coordinator, 'POST', `work/${work.id}/capacity`, event),
      preserveWork: async (work: Work, epoch: number) => {
        const current = (await store.list()).find(item => item.id === work.id)!;
        const workspace = current.workspaces.find(entry => entry.epoch === epoch);
        return workspace ? { state: 'committed' as const, commit: sha('wip', work.key, epoch), branch: workspace.branch, detail: 'kept as WIP' } : { state: 'not-applicable' as const, detail: 'this world records no worktree' };
      },
    } : {}),
    promptSession,
    // GY-1008: the blocked day probes through the real probe code, over a world whose credential,
    // write path and control plane fail until their minute, and records through the real route.
    // The credential-blocked day's world answers every probe: what fails there is each session's own credential.
    ...(options.blockers || options.credentialBlocked ? {
      probeBlocker: (work: Work, classification: Parameters<NonNullable<DaemonEffects['probeBlocker']>>[1]) => {
        const failing = !!options.blockers && elapsed < (blockerPlan.clearsAt[classification.class] ?? 0);
        const ran = (passed: boolean) => blockerProbes.push({ key: work.key, class: classification.class, elapsed, passed });
        return probeBlocker(work, classification, {
          run: () => { ran(!failing); if (failing) throw Object.assign(new Error('exit 1'), { stderr: classification.class === 'github-credential' ? 'You are not logged into any GitHub hosts.' : 'Read-only file system' }); return ''; },
          planeHealth: async () => { ran(!failing); return failing ? 'the server answered 500 Internal Server Error on /healthz' : null; },
          baseTip: async () => { ran(false); return github.tip; },
          launch: { kind: workers[0].kind, args: workers[0].agentArgs ?? [], environment: workers[0].environment }, cwd: `/tmp/soak/${work.key}-${work.epoch}`, clock: clock.now(),
        });
      },
      recordBlockerProbe: (work: Work, body: unknown) => api(principals.coordinator, 'POST', `work/${work.id}/blocker-probe`, body),
    } : {}),
    // GY-1322: the drained day's loop probes and clears its dispatch-failure blocker through the
    // real route, and any dispatch block it asks for is recorded and refused.
    ...(options.drained ? {
      recordBlockerProbe: (work: Work, body: unknown) => api(principals.coordinator, 'POST', `work/${work.id}/blocker-probe`, body),
      blockDispatch: async (_work: Work, reason: string) => { drain.blocks.push(reason); throw new Error('soak: the drained day records no dispatch block'); },
    } : {}),
    // GY-1078: the loop records a repeated dispatch failure's cause through the real `dispatchblock`
    // command; the control plane refuses the first `refuseBlocks` of those requests.
    ...(options.dispatchFailing ? {
      blockDispatch: async (work: Work, reason: string) => {
        const refused = failing.blocks.length < options.dispatchFailing!.refuseBlocks;
        failing.blocks.push({ key: work.key, reason, at: clock.now(), refused });
        if (refused) throw new Error('Graphyard refused work/dispatchblock (503): simulated: the control plane is unavailable');
        return api(principals.coordinator, 'POST', `work/${work.id}/dispatchblock`, { reason });
      },
    } : {}),
    exhaustedProofs: async () => [...abandoned.values()],
    ...(mechanicalDay ? { mechanicalFixes: async () => mechanicalFixState(ledger) } : {}),
    // A rework decision waiting on a stale observation wakes the item's own job (GY-793): the real
    // resync, with the observation job run while the step waits, as the control plane runs it. Its
    // waking resync is an observation wake like GY-710's, and counts as one; the polls do not.
    observe: (work, waitMs) => wakeOwnObservation(body => { if (body.wake !== false) wakes.push({ key: work.key, at: clock.now() }); return engine.resyncWork(principals.coordinator, work.id, body); },
      async () => { await processJob(engine, adapter); }, { waitMs }),
    // The documentation day's loop counts the base branch's real pages through the counting code
    // master status runs (GY-574), over a git that answers from the simulated repository.
    ...(docs ? {
      reportedAttention: async () => {
        const worldGit = async (_command: string, args: string[]): Promise<string> => {
          const [op, ...operands] = args;
          const commitOfTree = (tree: string) => [...github.commits.values()].find(entry => entry.tree === tree);
          if (op === 'rev-parse') return `${github.commits.get(github.tip)!.tree}\n`;
          if (op === 'ls-tree') {
            const commit = commitOfTree(operands.at(-1)!)!;
            return commit.files.map(path => {
              const text = commit.contents.get(path) ?? '';
              return `100644 blob ${createHash('sha1').update(text).digest('hex')} ${Buffer.byteLength(text)}\t${path}`;
            }).join('\n');
          }
          if (op === 'show') return operands.map(spec => {
            const [, tree, path] = /^([^:]+):(.+)$/.exec(spec)!;
            return commitOfTree(tree)!.contents.get(path) ?? '';
          }).join('');
          throw new Error(`the simulated documentation checkout cannot answer git ${op}`);
        };
        const counted = await docsWordCountAt('/checkout', 'origin/main', worldGit);
        const status = await docsHeadroomStatus('/checkout', 'main', () => counted);
        return { items: [], docs: status.docs } as ReportedAttention;
      },
    } : {}),
    ...(options.decomposition ? {
      recordDecomposition: recordDecompositionEffect,
      research: { cwd: coordinatorRoot ?? process.cwd(), runner: fakeDecompositionRunner },
    } : {}),
  };
  // ---- The loop's own master session (GY-898): launched on the registry's master role, woken on
  // ---- material events, killed mid-day while the registry refuses to end sessions, rotated at its
  // ---- budget. Every launch, wake, registry end and refused end is recorded against the day's
  // ---- schedule (`at`, one minute per cycle). The budget and the heartbeat are measured on the
  // ---- loop's own clock, which also runs real time forward, so those are recorded on it too
  // ---- (`startedAt`, `clock`, `before`/`after`, as offsets from the day's start): on a slow host the
  // ---- schedule falls behind that clock by however long the cycles took.
  const master = {
    launches: [] as { at: number; pane: string; session: string; startedAt?: number }[],
    wakes: [] as { at: number; cycle: number; text: string; clock?: number }[],
    ended: [] as string[], refusedEnds: [] as string[], killed: null as string | null,
    maxLive: 0, cycleOf: 0, rotations: [] as { at: number; detail: string; before: number; after: number }[],
    // GY-1223: the master pane the day set working, every read of a master screen, the accounts each launch took and the loop held.
    worked: null as string | null, bannerAt: null as number | null, reads: [] as { at: number; pane: string; status: string }[],
    accounts: [] as string[], holds: [] as { account: string; resetsAt: string | null; at: number }[],
  };
  if (options.master) {
    const plan = options.master, name = config.masterAgentName!;
    // Timed on the day's schedule position, as every other fault of the day is.
    const refusing = () => elapsed >= plan.refuseRelease.from && elapsed < plan.refuseRelease.to;
    // The registry launches the master role on its first account the loop does not hold (GY-1223).
    effects.masterSession = { launch: async () => {
      const pane = herdr.open(name, 'idle'), session = `master-registry-${master.launches.length + 1}`;
      const account = ['claude-master', 'claude-master-b'].find(candidate => !accountHeld(candidate)) ?? 'claude-master';
      master.launches.push({ at: elapsed, pane, session });
      master.accounts.push(account);
      return { agentName: name, pane, runtime: 'claude', account, session };
    } };
    effects.endRegistrySession = async session => {
      if (refusing()) { master.refusedEnds.push(session); throw new Error('the agent registry is unreachable: timeout'); }
      master.ended.push(session);
    };
    effects.holdAccount = async (account, observed) => { heldAccounts.set(account, { resetsAt: observed.resetsAt }); master.holds.push({ account, resetsAt: observed.resetsAt, at: elapsed }); };
    // GY-1223: the loop reads the master's screen every cycle it supervises it. A working master
    // shows its own prose — which names the limit banner with no retry marker — until the day
    // prints its runtime's retry banner; any other pane reads as no screen, as on the other days.
    const workerOutput = effects.sessionOutput;
    effects.sessionOutput = agent => {
      if (agent.name !== name) return workerOutput ? workerOutput(agent) : null;
      master.reads.push({ at: elapsed, pane: agent.pane_id ?? '', status: agent.agent_status ?? '' });
      return screens.get(agent.pane_id ?? '') ?? '● Waiting for the next wake\n';
    };
    const workerPrompt = effects.promptSession!;
    // A wake leaves the master idle, as a session that read master status and found nothing to do.
    effects.promptSession = async (agent, text) => agent.name === name ? void master.wakes.push({ at: elapsed, cycle: master.cycleOf, text }) : workerPrompt(agent, text);
  }
  // The loop publishes the master's merge-queue settings each cycle they change (GY-330, GY-498,
  // GY-500, GY-516), exactly as daemonEffects wires it; the day records what was published, when.
  // ---- GY-811: the containment day. The work snapshot takes 6 s to read, as it does on a loaded
  // ---- plane, so its own bound is wider than the 5 s tolerance and cannot settle; the loop bounds its clock with the light
  // ---- timed HEAD / instead, which fails, then answers slowly, then answers fast as the day goes on.
  const fenced = { drift: 0, probes: [] as { cycle: number; elapsed: number; phase: 'fail' | 'slow' | 'fast' }[], assessable: new Set<number>(), liveOnly: new Set<number>(), graced: new Set<number>(), bare: new Set<number>(),
    settled: [] as { key: string; epoch: number; elapsed: number; cycle: number }[], assessed: [] as { key: string; epoch: number; elapsed: number; refusals: string[] }[],
    refused: [] as { key: string; epoch: number; elapsed: number; cycle: number }[] };
  if (options.containment) {
    const phases = options.containment;
    const slowRead = async (ms: number) => { fenced.drift += ms; await moveClock(ms); };
    const read = effects.snapshot;
    effects.snapshot = async () => {
      await slowRead(3_000);
      const result = await read();
      await slowRead(3_000);
      // What this cycle's reclaim step will see: a quarantine that could settle (past its grace
      // window, or of an attempt the loop ended on its record, GY-1155), one still in its grace
      // window, only live ones, or none.
      const at = Date.parse(result.now), local = containmentQuarantines(result.work, config.hostId);
      if (local.some(item => containmentPhase(item, at)?.state === 'lapsed' || loopEndedAttempt(item))) fenced.assessable.add(cycles);
      else if (local.some(item => containmentPhase(item, at)?.state === 'grace')) fenced.graced.add(cycles);
      else if (local.length) fenced.liveOnly.add(cycles);
      else fenced.bare.add(cycles);
      return result;
    };
    effects.controlPlaneClock = () => {
      const phase = elapsed < phases.failUntil ? 'fail' : elapsed < phases.slowUntil ? 'slow' : 'fast';
      fenced.probes.push({ cycle: cycles, elapsed, phase });
      return readControlPlaneClock(config.url, { fetcher: (async (_url: string, init: RequestInit) => {
        assert.equal(init.method, 'HEAD');
        if (phase === 'fail') throw new Error('connect ETIMEDOUT graphyard.example:443');
        if (phase === 'slow') await slowRead(3_000);
        const date = new Date(clock.now()).toUTCString();
        if (phase === 'slow') await slowRead(3_000);
        return new Response(null, { headers: { date } });
      }) as unknown as typeof fetch });
    };
    // The host's probe: a session the day still runs is present in its workspace; any other is gone.
    effects.containment = async (work, observed) => {
      const assessed = await assessContainment(work, { hostId: config.hostId, observedAt: observed.now, clockOffset: observed.clockOffset, clockRoundTripMs: observed.clockRoundTripMs, clockSource: observed.clockSource,
        probe: target => {
          const running = sessions.some(session => session.key === target.key && session.epoch === target.epoch && (session.state === 'working' || session.state === 'idling'));
          return { method: 'linux-proc-systemd', platform: 'linux', uid: 1000, workspacePath: target.workspacePath, processes: running ? [{ pid: 4242, evidence: 'command' }] : [], scopes: [], held: [],
            recordedScope: null, inaccessible: 0, unverifiable: [] } as unknown as SupervisorProbeReport;
        } });
      for (const assessment of Object.values(assessed)) fenced.assessed.push({ key: assessment.key, epoch: assessment.epoch, elapsed, refusals: assessment.refusals });
      return assessed;
    };
    effects.settleContainment = async (work, assessment) => {
      // GY-1155: the plane answers one item's first settlement with Railway's 502, as it did on 2026-10-03.
      if (phases.refuseSettle && work.key === items[phases.refuseSettle - 1].key && !fenced.refused.length) {
        fenced.refused.push({ key: work.key, epoch: assessment.epoch, elapsed, cycle: cycles });
        throw new Error(`Graphyard refused work/${work.id}/autosettle: {"status":"error","code":502,"message":"Application failed to respond"}`);
      }
      await api(principals.coordinator, 'POST', `work/${work.id}/autosettle`, { epoch: assessment.epoch, settlementHash: work.containmentQuarantine!.settlementHash,
        reason: `The soak loop verified on ${assessment.host} that the supervisor of epoch ${assessment.epoch} is gone`, verification: assessment.verification });
      fenced.settled.push({ key: work.key, epoch: assessment.epoch, elapsed, cycle: cycles });
    };
  }
  // ---- GY-1286: the slow-server day. Inside the window every decision request and observation wake
  // ---- the loop sends takes `ms` of the clock before the plane answers, as the 30s-timeout writes of
  // ---- cycles 12285 and 12293 did, so the decisions step runs past its budget and puts items off.
  const budgetDay = { cycles: [] as { cycle: number; elapsed: number; spentMs: number; slow: number; deferred: string[] }[], withdrawn: [] as { key: string; cycle: number }[], slowCalls: 0, cycleSlow: 0 };
  if (options.slowDecisions) {
    const window = options.slowDecisions, { decide, wakeObservation, withdraw } = effects;
    const slow = async () => {
      const at = clock.now() - dayStart;
      if (at < window.from || at >= window.to) return;
      budgetDay.slowCalls++; budgetDay.cycleSlow++; fenced.drift += window.ms; await moveClock(window.ms);
    };
    effects.decide = async (work, action, reason, input) => { await slow(); return decide!(work, action, reason, input); };
    effects.wakeObservation = async work => { await slow(); return wakeObservation!(work); };
    effects.withdraw = async (work, decision, reason) => { budgetDay.withdrawn.push({ key: work.key, cycle: cycles }); return withdraw!(work, decision, reason); };
  }
  // ---- GY-1345: the slow-observation day. Inside the window the attention master status adds answers
  // ---- `attentionMs` after it is asked, as cycle 12621's did in 350.8s: the cycle that asks spends the
  // ---- faults step's whole budget on it and is cut, and the read stays in flight across cycles.
  const observationDay = { cycles: [] as { cycle: number; elapsed: number; spentMs: number; cut: boolean; pending: number }[], started: 0, landed: 0, inFlight: 0, maxInFlight: 0 };
  if (options.slowObservation) {
    const window = options.slowObservation, { controlPlane } = effects, attention = effects.reportedAttention ?? (async () => ({ items: [] }) as ReportedAttention);
    const budget = faultsStep.faultObservationBudgetMs(config.run.intervalSeconds * 1000);
    const inWindow = () => { const at = clock.now() - dayStart; return at >= window.from && at < window.to; };
    let landing: { at: number; answer: () => void } | null = null;
    effects.controlPlane = async () => {
      // A plane fast again answers the read in flight; inside the window it answers once its time is up.
      if (landing && (!inWindow() || clock.now() >= landing.at)) { const read = landing; landing = null; read.answer(); }
      return controlPlane!();
    };
    effects.reportedAttention = (...args) => {
      if (!inWindow()) return attention(...args);
      observationDay.started++; observationDay.inFlight++; observationDay.maxInFlight = Math.max(observationDay.maxInFlight, observationDay.inFlight);
      // The asking cycle waits its budget out on the read: the loop's clock moves at once (the budget is
      // judged right after the read is asked), less a moment the real timer still waits.
      const waited = budget - 200;
      fenced.drift += waited;
      return moveClock(waited).then(() => new Promise<ReportedAttention>(resolve => {
        landing = { at: clock.now() - waited + window.attentionMs, answer: () => { observationDay.inFlight--; observationDay.landed++; resolve(attention(...args)); } };
      }));
    };
  }
  // ---- GY-1354: the slow-deployment day. Inside the window the release observation answers
  // ---- `observationMs` after it is asked, as cycle 12624's did in 587.1s: the cycle that asks spends the
  // ---- deployment step's whole budget on it and is cut, and the read stays in flight across cycles.
  const deploymentDay = { cycles: [] as { cycle: number; elapsed: number; spentMs: number; cut: boolean; pending: number }[], started: 0, landed: 0, inFlight: 0, maxInFlight: 0,
    records: [] as string[], smokes: [] as string[], land: () => {} };
  if (options.slowDeployment) {
    const window = options.slowDeployment, { observeDeployment } = effects;
    const budget = deploymentStep.deploymentStepBudgetMs(config.run.intervalSeconds * 1000);
    const inWindow = () => { const at = clock.now() - dayStart; return at >= window.from && at < window.to; };
    let landing: { at: number; answer: () => void } | null = null;
    // Checked before each cycle: a release fast again answers the read in flight; inside the window it answers once its time is up.
    deploymentDay.land = () => { if (landing && (!inWindow() || clock.now() >= landing.at)) { const read = landing; landing = null; read.answer(); } };
    effects.observeDeployment = (delivered, containment) => {
      if (!inWindow()) return observeDeployment(delivered, containment);
      deploymentDay.started++; deploymentDay.inFlight++; deploymentDay.maxInFlight = Math.max(deploymentDay.maxInFlight, deploymentDay.inFlight);
      // The asking cycle waits its budget out on the read, as on the slow-observation day.
      const waited = budget - 200;
      fenced.drift += waited;
      return moveClock(waited).then(() => new Promise<Awaited<ReturnType<typeof observeDeployment>>>(resolve => {
        landing = { at: clock.now() - waited + window.observationMs, answer: () => { deploymentDay.inFlight--; deploymentDay.landed++; resolve(observeDeployment(delivered, containment)); } };
      }));
    };
    // The loop's real route for the deployment record (src/daemon/effects.ts), so a smoke request follows it.
    effects.recordDeployment = async (item, observation) => {
      deploymentDay.records.push(item.key);
      return api(principals.coordinator, 'POST', `work/${item.id}/deployment`, { sha: observation.sha, mergeSha: item.delivery!.mergeSha, source: observation.source, observedAt: observation.observedAt });
    };
    effects.requestSmoke = async item => { deploymentDay.smokes.push(item.key); };
  }
  // ---- GY-1416: the loop's setup step (7e) on a Railway deployment that lacks the revert approver.
  // ---- The real `master setup --apply` runs against a scripted Railway CLI on the simulated clock;
  // ---- at `redeployFails.from` the variables vanish and every redeploy fails until `redeployFails.to`.
  const provisionDay = { runs: [] as number[], sets: [] as { name: string; at: number }[], redeploys: [] as { at: number; ok: boolean }[], actions: [] as { at: number; keys: string[] }[] };
  if (options.selfProvision) {
    const window = options.selfProvision.redeployFails, provisionRoot = await temporaryDirectory('soak-self-provision');
    const at = () => clock.now() - dayStart, failing = () => at() >= window.from && at() < window.to;
    const deployed: Record<string, string> = { GITHUB_APP_ID: '1234' };
    let vanished = false;
    const transport: Transport = {
      description: 'soak railway',
      async exec(_program, args, options = {}) {
        if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ name: 'graphyard', services: { edges: [{ node: { name: 'graphyard' } }] } }), stderr: '' };
        if (args[0] === 'variables' && args.includes('--json')) return { code: 0, stdout: JSON.stringify(deployed), stderr: '' };
        if (args[0] === 'variable' && args[1] === 'set') { deployed[args[args.length - 1]] = options.input ?? ''; provisionDay.sets.push({ name: args[args.length - 1], at: at() }); }
        args.forEach((arg, index) => { if (args[index - 1] === '--set') { deployed[arg.slice(0, arg.indexOf('='))] = arg.slice(arg.indexOf('=') + 1); provisionDay.sets.push({ name: arg.slice(0, arg.indexOf('=')), at: at() }); } });
        if (args[0] === 'redeploy') { provisionDay.redeploys.push({ at: at(), ok: !failing() }); if (failing()) throw new Error('railway redeploy exited 1: deployment failed'); }
        return { code: args[0] === 'domain' ? 1 : 0, stdout: '', stderr: '' };
      },
      async putFile() { throw new Error('Railway variables are never written as files'); },
    };
    const target = deploymentTarget({ provider: 'railway', repository, service: 'graphyard', linkDirectory: provisionRoot, transport });
    const derived = [{ name: 'GRAPHYARD_REVERT_APPROVER_APP_ID', value: '55001', secret: false, source: 'the reviewer App registration' },
      { name: 'GRAPHYARD_REVERT_APPROVER_PRIVATE_KEY', value: 'soak-reviewer-private-key-material', secret: true, source: 'the reviewer App registration' }];
    const setup = ((root: string, master: Parameters<typeof masterSetup>[1], setupOptions: Parameters<typeof masterSetup>[2]) => {
      provisionDay.runs.push(at());
      return masterSetup(root, master, setupOptions, { locate: async () => ({ ...target, derived }), now: () => clock.now() });
    }) as typeof masterSetup;
    effects.selfProvision = async () => {
      // The variables vanish from the deployment as the failing window opens (a service recreated by hand).
      if (!vanished && at() >= window.from) { vanished = true; for (const value of derived) delete deployed[value.name]; }
      provisionDay.actions.push({ at: at(), keys: Object.keys(state.actions).filter(key => key.includes('self-provision')) });
      return loopSelfProvision(provisionRoot, { repository: config.repository }, { now: clock.now(), setup });
    };
  }
  if (options.staleRelease) {
    // The backlog's history reads take real time, as a slow control plane's do; master status's own
    // decision report is the attention the loop classifies, so an owed stale release reaches the fault step.
    const { decisions } = effects, slowReads = new Set(staleReleaseDay.backlog.map(item => item.id)), readMs = options.staleRelease.readMs;
    effects.decisions = async work => {
      if (slowReads.has(work.id)) { staleReleaseDay.backlogReads++; await new Promise(resolve => setTimeout(resolve, readMs)); }
      return decisions!(work);
    };
    // The loop's real ledger read (src/daemon/effects.ts), so the kept histories are what production keeps.
    effects.decisionChanges = async after => {
      const query = new URLSearchParams({ kind: decisionEventKinds.join(','), payload: 'none', routine: 'include', order: after ? 'asc' : 'desc', limit: after ? '1000' : '1', view: 'page' });
      if (after) query.set('cursor', after);
      const read = await api(principals.coordinator, 'GET', `events?${query}`) as { events: { seq: string; work_id: string }[]; page: { hasMore: boolean } };
      return { seq: (after ? read.events.at(-1)?.seq : read.events[0]?.seq) ?? after ?? '0', work: [...new Set(read.events.map(event => event.work_id))], complete: !!after && !read.page.hasMore };
    };
    effects.reportedAttention = async (work, _coordinator, observed) => {
      const report = await terminalDecisions(path => api(principals.operatorAgent, 'GET', path), work, { approvals: Object.values(state.approvals), runtime: { available: observed.available ?? true, agents: observed.agents }, now: Date.parse(observed.now) });
      return { items: report.attentionItems } as ReportedAttention;
    };
  }
  let publishedMergeQueue: string | null = null;
  const mergeQueuePosts: { at: number; settings: Record<string, number> }[] = [];
  effects.publishMergeSettings = async () => {
    const settings = { rerunFailedChecks: rerunFailedChecks(config) };
    const published = JSON.stringify(settings);
    if (published === publishedMergeQueue) return;
    mergeQueuePosts.push({ at: clock.now(), settings });
    await api(principals.coordinator, 'POST', 'merge-queue', settings);
    publishedMergeQueue = published;
  };
  const baseFailure = { filed: [] as Work[], refreshes: [] as string[] };

  // ---- The coordinator checkout the loop runs from, and its supervisor (GY-437). ----
  // A detached checkout of the base branch, at the tip the day starts on; git answers from the
  // simulated GitHub, and a restart of the fleet or of the loop itself is recorded, not performed.
  const checkout = { head: github.tip, origin: github.tip, dirty: false };
  const upgrades = { fetches: 0, checkouts: [] as { at: number; from: string; to: string }[], executors: [] as string[], self: 0, outcomes: [] as SelfUpgradeOutcome['outcome'][],
    /** GY-916: the restarts refused on a held claim, the owed restart sampled each cycle it stood, and the unit the supervisor runs. */
    held: [] as string[], owed: [] as { to: string; state: string; attempts: number }[], unit: { watchdogSec: plan.driftedWatchdogSec, rewrites: 0 },
    starts: 0, watchdog: [] as { failed: number; attempts: number; windowSec: number }[] };
  /** The paths the base branch changed between two commits: every merged pull request's files, and what any other commit added or removed. */
  const changedPaths = (from: string, to: string) => {
    const paths = new Set<string>(), seen = new Set<string>(), queue = [to];
    while (queue.length) {
      const at = queue.pop()!;
      if (seen.has(at) || github.contains(from, at)) continue;
      seen.add(at);
      const commit = github.commits.get(at)!, merged = github.merges.find(entry => entry.sha === at);
      if (merged) for (const path of github.prs.get(merged.pr)!.files) paths.add(path);
      else if (commit.parents[0]) {
        const before = new Set(github.commits.get(commit.parents[0])!.files), after = new Set(commit.files);
        for (const path of [...before, ...after]) if (before.has(path) !== after.has(path)) paths.add(path);
      }
      if (!merged) queue.push(...commit.parents);
      else queue.push(commit.parents[0]);
    }
    return [...paths];
  };
  const coordinatorGit = async (command: string, args: string[]): Promise<string> => {
    assert.equal(command, 'git');
    const [op, ...operands] = args.slice(2);
    if (op === 'fetch') { upgrades.fetches++; checkout.origin = github.tip; return ''; }
    if (op === 'rev-parse') return `${operands[0] === 'HEAD' ? checkout.head : checkout.origin}\n`;
    if (op === 'symbolic-ref') throw Object.assign(new Error('fatal: ref HEAD is not a symbolic ref'), { status: 1 });
    if (op === 'status') return checkout.dirty ? ' M src/master.ts\n' : '';
    if (op === 'diff') { const [from, to] = operands[1].split('..'); return `${changedPaths(from, to).join('\n')}\n`; }
    if (op === 'checkout') { assert.ok(!checkout.dirty, 'a dirty checkout is never touched'); upgrades.checkouts.push({ at: clock.now(), from: checkout.head, to: operands[2] }); checkout.head = operands[2]; return ''; }
    throw new Error(`the simulated coordinator checkout cannot answer git ${args.slice(2).join(' ')}`);
  };
  const selfUpgrade = (state: DaemonState) => performSelfUpgrade(config, state, {
    root: '/soak/coordinator', run: coordinatorGit, now: clock.now, persist: async () => {},
    restartExecutors: async to => {
      // A busy fleet: a claim outlives restartExecutors' bounded wait for the first passes, and the restart is refused.
      if (upgrades.held.length < plan.heldClaimRestarts) { upgrades.held.push(to); return { result: 'refused', reason: `Restart refused while an executor on ${config.hostId} holds a claimed action`, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] }; }
      upgrades.executors.push(to); return { result: 'restarted', reason: null, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] };
    },
    // The alignment re-applies the unit the loop runs under: a drifted watchdog window is rewritten to the configuration's.
    alignUnit: async () => {
      if (upgrades.unit.watchdogSec === loopWatchdogSeconds(config.run.intervalSeconds)) return { wrote: 'unchanged', reason: null };
      upgrades.unit.watchdogSec = loopWatchdogSeconds(config.run.intervalSeconds); upgrades.unit.rewrites++;
      return { wrote: 'updated', reason: null };
    },
    // The supervisor re-executes the loop: the next process loads the release the checkout holds, as runDaemon records it,
    // and starts under the unit as it now stands.
    restartSelf: async () => { upgrades.self++; state.release = { commit: checkout.head, dirty: checkout.dirty }; await processStart(state); },
  });
  /** What runDaemon does once per process start: the supervisor's watchdog window judged against the interval (GY-916). */
  const processStart = async (state: DaemonState) => {
    upgrades.starts++;
    await noteWatchdog(state, watchdogPlan({ NOTIFY_SOCKET: '/run/user/1000/systemd/notify', WATCHDOG_USEC: String(upgrades.unit.watchdogSec * 1_000_000) }, config.run.intervalSeconds * 1000), new Date(clock.now()).toISOString(), async () => {});
  };

  // ---- The day. ----
  let state = emptyDaemonState(config);
  await processStart(state);
  const loopRestarts = [...plan.loopRestarts];
  // GY-866: the checkout guard `runDaemon` runs after every cycle, against the simulated checkout:
  // it reads the tree and HEAD each cycle, raises the refusal naming the paths, the HEAD and the
  // panes pointing at the checkout, and lets the self-upgrade run only on a clean checkout at the
  // commit the loop runs. Its Herdr inventory reads are counted, to bound them.
  const guardReads = { agents: 0, refused: 0, transitions: 0, details: new Set<string>(), headMoves: 0, foreignHead: sha('foreign-head', 1) };
  const guard = coordinatorCheckoutGuard({
    state: () => state, snapshot, persist: async () => {}, now: clock.now, log: () => {}, applies: () => true,
    read: async () => ({ root: '/soak/coordinator', commit: checkout.head, modified: checkout.dirty ? ['src/master.ts'] : [], untracked: [] }),
    agents: () => { guardReads.agents++; return herdr.list(); },
  });
  await guard.start(checkout.head);
  let movedFrom: string | null = null, lastRefusal: string | null = null;
  /** The cursor's upgrade actions and the refusal's attempts, sampled every cycle the checkout stood refused. */
  const refusalSamples: { keys: number; attempts: number; head: boolean }[] = [];
  // Session launches run beside the cycle (GY-616): the loop carries one launcher across its
  // cycles, the way `runDaemon` does, and a launch settles in the interval after the cycle that
  // handed it over — here, before the simulated clock moves on.
  const launcher = new Launcher();
  const violations: string[] = [], observed = new Set<string>(), faulted = new Set<string>(), failures: string[] = [], escalations: string[] = [], spent = new Set<string>(), actionKeys = new Set<string>(), lanesSeen = new Set<string>();
  // Peers `processJob` reconciled from another item's landing check (GY-744), as `KEY merged|unmerged`.
  const reconciled: string[] = [];
  const reconcileLanded = engine.reconcileLanded;
  engine.reconcileLanded = async (...args) => {
    const saved = await reconcileLanded.apply(engine, args);
    reconciled.push(...saved.map(item => `${item.key} ${item.observation?.merged ? 'merged' : 'unmerged'}`));
    return saved;
  };
  let outside: { key: string; sha: string; at: number } | null = null;
  // GY-793: the commit that broke main, and the one that fixed it, so the day can be judged on
  // what the refresh of the candidate built against the breakage named.
  const baseBreak: { broken?: string; fixed?: string } = {};
  // GY-839: every false landing refusal the fault window produces, first seen per candidate head.
  const landingRefusals: { key: string; sha: string; elapsed: number }[] = [];
  // GY-430: every merge-stalled line master status would show, read after each cycle of the day
  // that sets `plan.blockedMerge`.
  const mergeStallSightings: { subject: string; text: string; at: number }[] = [];
  let released = 0, split = false, noticed = false, deploys = 0, cycles = 0, reportedDispatches = 0, restarted = false, exitedRowsSeen = 0, broken = false, repaired = false, repairClosed = false;
  // GY-574: the documentation day records the trim filings, the loop's trim actions, and when the
  // trim item was closed with the documentation still saturated, so the once-only filing and the
  // bounded action count are what the day itself observed.
  const docsFilings: string[] = [], docsActions: { state: string; detail: string }[] = [];
  let closedTrim = false;
  const releasedScope = new Set<number>();
  // GY-1099: when each starved item's starvation armed and its evidence landed, the prioritized
  // wakes the world dropped or let through, and any other open item seen merge-ready but stale.
  const starvation = { armed: new Map<string, number>(), released: new Set<string>(), evidenced: new Map<string, number>(), dropped: [] as string[], claimed: [] as { key: string; at: number }[], peersStale: [] as string[] };
  // GY-852: the reassigned item's own pane and the pane the reused name came to hold.
  const reassign = { pane: null as string | null, phantom: null as string | null, phantomGone: false };
  // A stale rework (GY-710). The loop restarts just after a changes request on a rework item is
  // observed, and is down for three minutes; the observation fleet is busy and reads that item
  // again only ten minutes on, unless the loop wakes its job. So when the loop is back, the only
  // observation of the request is stale: its rework waits, and the loop wakes the observation job.
  let loopDownUntil = 0;
  const restarts = new Map<string, number>();
  const restartLog: { key: string; kind: 'rework' | 'merge'; at: number }[] = [];
  const restartOnVerdict = async (now: number) => {
    const rework = new Set([...plan.rework].map(n => items[n - 1].id));
    const requested = (await store.list()).find(item => rework.has(item.id) && item.candidate && !restarts.has(item.candidate.sha)
      && !!item.observation?.reviews.some(review => review.sha === item.candidate!.sha && review.state === 'CHANGES_REQUESTED'));
    if (!requested) return false;
    restarts.set(requested.candidate!.sha, now); restartLog.push({ key: requested.key, kind: 'rework', at: now }); loopDownUntil = now + 3 * minute;
    return true;
  };
  // A stale merge (GY-710): the same restart just as an item reaches the merge stage, for the
  // first `staleMerge` items to get there. Since GY-1235 no gate reads the observation's age, so
  // GitHub merges the item meanwhile and the loop has nothing to wake.
  const staleMerges: string[] = [];
  const restartOnMerge = async (now: number) => {
    if (staleMerges.length >= (options.staleMerge ?? 0)) return false;
    const merging = (await store.list()).find(item => item.stage === 'merge' && item.candidate && !restarts.has(item.candidate.sha) && item.gates.every(gate => gate.passed));
    if (!merging) return false;
    restarts.set(merging.candidate!.sha, now); staleMerges.push(merging.key); restartLog.push({ key: merging.key, kind: 'merge', at: now }); loopDownUntil = now + 3 * minute;
    return true;
  };
  const busyFleet = async (now: number) => {
    for (const item of (await store.list()).filter(entry => entry.candidate && restarts.has(entry.candidate.sha))) {
      const since = restarts.get(item.candidate!.sha)!, readAt = since + plan.slowObservationMs;
      if (now >= readAt || wakes.some(wake => wake.key === item.key && wake.at >= since)) continue;
      await store.pool.query('UPDATE jobs SET available_at=GREATEST(available_at, $2) WHERE work_id=$1', [item.id, new Date(readAt)]);
    }
  };
  /** GY-806: the check_run deliveries, the jobs they woke, and any woken job claimed after a polled one or left unobserved. */
  const webhook = { deliveries: 0, woken: 0, refreshes: 0, skipped: 0, late: [] as string[], unobserved: [] as string[] };
  // GY-806: the real adapter's immutable path and its persisted layer, read every cycle as an observation
  // reads them: each open head's commit and its compare against the current base tip. GitHub itself is the
  // simulated one (`send` answers from it). The table must stay within its bound all day while every path
  // still read is asked of GitHub once: retired heads and moved base tips age out, live ones never do.
  const immutableScope = `soak-${days}`, immutableBound = { rows: 40, bytes: 24 * 1024 };
  const immutableCache = new GitHubCacheStore(store.pool, immutableScope, { flushMs: Number.MAX_SAFE_INTEGER, pruneMs: Number.MAX_SAFE_INTEGER, maxImmutableRows: immutableBound.rows, maxImmutableBytes: immutableBound.bytes });
  const immutableClient = new GitHub({ repository, base: 'main', appId: 1234, installationId: 2, privateKey: 'not-used' });
  immutableClient.immutableHotEntries = 8;
  const immutableSends = new Map<string, number>();
  Object.assign(immutableClient, { token: 'fixture-token', expires: Number.MAX_SAFE_INTEGER, send: async (path: string) => {
    immutableSends.set(path, (immutableSends.get(path) ?? 0) + 1);
    const [, head] = /([a-f0-9]{40})$/.exec(path) ?? [];
    const pr = [...github.prs.values()].find(entry => entry.head === head);
    return path.includes('/compare/') ? { status: 'ahead', ahead_by: 1, total_commits: 1, commits: [{ sha: head }], files: (pr?.files ?? []).map(filename => ({ filename, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b\n'.repeat(40) })) }
      : { sha: head, parents: [{ sha: pr?.base }], commit: { tree: { sha: sha(`tree-${head}`) }, message: pr?.key ?? 'change' } };
  } });
  await immutableClient.attachCache(immutableCache);
  const immutable = { cycles: 0, peakLive: 0, peakRows: 0, peakBytes: 0, overBound: [] as string[], refetched: [] as string[], reads: 0 };
  // GY-1052: the shared per-cycle reads on the real adapter, taken through `observe()` by every open item
  // each cycle: one base-ref read per cycle, protection every five minutes, each observation binding the
  // current tip. `send` answers from the simulated GitHub, so an `observe()` that stopped sharing its reads
  // fails the per-cycle counts. And the cross-replica charge ledger over the day: two replicas charge what
  // they ask of GitHub, the second restarting every three hours under a new instance id; the table must stay
  // within two hours of rows, the restarted ids' included, and the fleet count must be the other replica's hour.
  const cycleClient = new GitHub({ repository, base: 'main', appId: 1234, installationId: 2, privateKey: 'not-used' });
  cycleClient.clock = () => clock.now();
  const cycleSends = { ref: 0, protection: 0, other: 0 };
  Object.assign(cycleClient, { token: 'fixture-token', expires: Number.MAX_SAFE_INTEGER, send: async (path: string) => {
    const [route, query = ''] = path.replace(`/repos/${repository}`, '').split('?'), page = new URLSearchParams(query).get('page');
    if (route === '/git/ref/heads/main') { cycleSends.ref++; return { ref: 'refs/heads/main', object: { type: 'commit', sha: github.tip } }; }
    if (route === '/branches/main/protection' || route === '/rules/branches/main') { cycleSends.protection++; return route.endsWith('/protection') ? { required_status_checks: { strict: false, checks: [] } } : []; }
    cycleSends.other++;
    let match = /^\/pulls\/(\d+)(\/reviews|\/files)?$/.exec(route);
    if (match) {
      const pr = github.prs.get(Number(match[1]))!;
      if (match[2] === '/reviews') return [];
      if (match[2] === '/files') return page !== '1' ? [] : pr.files.map(filename => ({ filename, status: 'modified', sha: sha(`blob-${pr.head}-${filename}`), additions: 1, deletions: 1, patch: '@@' }));
      return { number: pr.number, state: 'open', draft: false, merged: false, mergeable: true, merge_commit_sha: null, merged_at: null, created_at: new Date(pr.createdAt).toISOString(), user: { login: pr.author, id: 7 },
        head: { sha: pr.head, ref: pr.branch, repo: { full_name: repository } }, base: { sha: github.tip, ref: 'main', repo: { full_name: repository } } };
    }
    if (/^\/commits\/[a-f0-9]{40}\/check-runs$/.test(route)) return { check_runs: [] };
    match = /^\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/.exec(route);
    if (match) return { status: match[1] === match[2] ? 'identical' : 'ahead', ahead_by: 1, total_commits: 1, commits: [{ sha: match[2] }], files: [] };
    return { sha: route.slice(-40), parents: [], commit: { tree: { sha: sha(`tree-${route.slice(-40)}`) }, message: 'change' } };
  } });
  const shared = { cycles: 0, observations: 0, refReads: 0, protectionReads: 0, overRead: [] as string[], stale: [] as string[], failed: [] as string[] };
  const chargeInstallation = `soak-charges-${days}`, chargeOptions = { syncMs: 2 ** 31 - 1 };
  const replicaA = new GitHubChargeLedger(store.pool, chargeInstallation, { ...chargeOptions, instance: 'replica-a' });
  let replicaB = new GitHubChargeLedger(store.pool, chargeInstallation, { ...chargeOptions, instance: 'replica-b-0' }), chargeRestarts = 0;
  const charged = { b: [] as number[], cycles: 0, peakRows: 0, instancesSeen: new Set<string>(), overBound: [] as string[], miscounted: [] as string[], boundaryCycles: 0 };
  const jobsDue = async () => Number((await store.pool.query('SELECT count(*) AS due FROM jobs WHERE available_at<=now() AND (held_until IS NULL OR held_until<=now()) AND (locked_until IS NULL OR locked_until<now())')).rows[0].due);
  // The day's schedule position, hoisted so the launch effects record against it: one cycle is one
  // simulated minute, and a launch the cycle handed over settles before the position advances.
  let elapsed = 0;
  for (; elapsed <= options.hours * hour;) {
    const now = clock.now();
    // Scheduled events: releases, the file split on main, the deploys. The queue-only day runs with
    // the split past its end: the re-plan and its stale-tip flush are the main day's scenario, and
    // a queue of tips built before the split only ejects in a cascade the day cannot recover from.
    while (released < plan.items && elapsed >= released * releaseEveryMs) { const next = items[released++]; if (!staleReleaseItems.has(released)) await engine.execute(principals.operator, 'ready', next.id, {}, id()); }
    // The scope scenarios release beside the fifteen: the wide asks early enough to decide well
    // before their workers push, the unrepresentable one so its refusal stands for hours.
    for (const [slot, n] of [[30, scopePlan.wideRule], [35, scopePlan.wideFinding], [40, scopePlan.unrepresentable], [45, scopePlan.partial]] as const)
      if (options.scope && !releasedScope.has(n) && elapsed >= slot * minute) { await engine.execute(principals.operator, 'ready', items[n - 1].id, {}, id()); releasedScope.add(n); }
    const splitAt = plan.split.at;
    if (!split && elapsed >= splitAt) {
      split = true;
      const from = file(plan.split.item), successors = [`src/soak/item-${plan.split.item}-a.ts`, `src/soak/item-${plan.split.item}-b.ts`];
      const commit = github.commit(`Split ${from}\n\nGraphyard-Successor: ${from} -> ${successors.join(', ')}`, [...github.files.filter(path => path !== from), ...successors]);
      github.successions.push(...successors.map(to => ({ from, to, commit: commit.sha, similarity: 70 })));
    }
    if (elapsed > 0 && elapsed % hour === 0 && elapsed < options.hours * hour) hourly.push({ directory: await leftover(`graphyard-hour-${elapsed / hour}`, 0), at: elapsed });
    // GY-839: while the window stands, GitHub answers every open candidate's compares without a
    // usable merge base; afterwards its answers carry the true one again.
    const blind = plan.blind;
    github.staleMergeBase = elapsed >= blind.from && elapsed < blind.to
      ? new Set([...github.prs.values()].filter(pr => pr.open).map(pr => pr.head)) : new Set<string>();
    // A change landed on main outside Graphyard, moving the base under candidates already pushed.
    if (!noticed && elapsed >= plan.notice) { noticed = true; github.commit('Add NOTICE to the base branch', [...github.files, 'NOTICE']); }
    // A test breaks on main outside Graphyard, and is repaired eleven minutes later (GY-528). Only
    // the 24-hour main day runs it: its candidates are held without rework either way, and that
    // day is where the filing, rerun and refresh recovery is asserted. The window is sized to the
    // push cadence — one worker pushes every fifteen minutes — so exactly one push lands inside it
    // (item twelve's first head) and is held, and the repair lands early enough that the refreshed
    // candidate re-merges into the long gap before the next release's merge: every merge the day
    // delays otherwise moves the base under an open candidate and reads as churn beside the remedy
    // refresh itself. It stands three hours in, clear of the morning's scenarios: the memory dip
    // holds the first launches, so items one and two push together past half an hour, and a hold
    // there would replace the spent producer's head (GY-496) before its request is spent.
    if (mainDay && options.hours >= 24 && !broken && elapsed >= plan.baseFailure.breaks) { broken = true; github.baseFailure.broken = github.commit('Add a test holding a fixed date against the clock', github.files).sha; }
    if (mainDay && options.hours >= 24 && !repaired && elapsed >= plan.baseFailure.repaired) { repaired = true; github.baseFailure.repaired = github.commit('Repair the fixed-date test', github.files).sha; }
    // Once the repair has landed and the loop has retired the base failure, the person who repaired
    // main closes the P0 item filed for it as obsolete, naming the repair commit: an open item would keep
    // the day stepping one minute at a time to its end, and leave work for the next day's loop.
    const repairItem = baseFailure.filed[0];
    if (repaired && !repairClosed && repairItem && !Object.keys(state.baseFailures).length) {
      repairClosed = true;
      await api(principals.operator, 'POST', `work/${repairItem.key}/close`, { kind: 'obsolete', reason: `soak: main was repaired outside Graphyard by ${github.baseFailure.repaired}` });
    }
    // GY-793: main is briefly broken by a direct commit and fixed by the next one. Item 2's worker
    // pushes inside the window, so its candidate is built against the broken commit; the fix's own
    // run completes one CI duration after it, which is when the judgement can first name the tip
    // that fixed the breakage. Only the main day runs it: the other days exercise their own faults.
    if (baseBreakDay && baseBreakFrom !== null) {
      if (!baseBreak.broken && now - baseBreakFrom >= plan.baseBreak.brokenAfterMs) {
        baseBreak.broken = github.commit('Break the base-branch suite', [...github.files, 'src/soak/base-broken.ts'], clock.now(), [github.tip], undefined, { broken: true }).sha;
        github.baseBreaks.add(baseBreak.broken);
      }
      if (baseBreak.broken && !baseBreak.fixed && now - baseBreakFrom >= plan.baseBreak.fixedAfterMs) {
        baseBreak.fixed = github.commit('Fix the broken base-branch suite', github.files.filter(path => path !== 'src/soak/base-broken.ts'), clock.now(), [github.tip], undefined, { broken: false }).sha;
      }
    }
    // GY-574: an hour in, the filed trim item is closed and its trim lands on the base branch —
    // the README gives back the words, as the trim item's own criterion delivers — with the set
    // still inside the 3% warning, so the filing episode stays open and files nothing more.
    if (docs && !closedTrim && elapsed >= 60 * minute) {
      const trim = (await store.list()).find(item => item.title.startsWith(docsTrimTitle));
      if (trim) {
        closedTrim = true;
        await api(principals.operator, 'POST', `work/${trim.key}/close`, { kind: 'obsolete', reason: 'soak: the trim item closed with the documentation still saturated' });
        const contents = new Map(github.commits.get(github.tip)!.contents);
        contents.set('README.md', Array.from({ length: 1_165 }, (_, index) => `t${index}`).join(' '));
        github.commit('Trim the documentation for word-budget headroom', github.files, clock.now(), [github.tip], undefined, {}, contents);
      }
    }
    // GY-1315: two minutes in, the master requests both items' releases by hand, puts them to no
    // approver, and the loop's own note lands before an approver reads each, so both settle stale.
    if (options.staleRelease && elapsed === 2 * minute) for (const n of staleReleaseItems) {
      const current = (await store.list()).find(item => item.id === items[n - 1].id)!;
      const decision = await api(principals.operatorAgent, 'POST', `work/${current.id}/decide`, { action: 'release', input: decisionInput('release', current, {}), reason: `Soak: a hand-requested release of ${current.key}` });
      await engine.execute(principals.coordinator, 'request', current.id, { type: 'note', reason: `Soak: a note on ${current.key}, landing before the approver reads ${decision.id}` }, id());
      const outcome = await api(principals.approver, 'POST', `work/${current.id}/approve`, { decision: decision.id, reason: `Approved: release ${current.key}` }).then(() => 'applied', (error: Error) => error.message);
      staleReleaseDay.hand.push({ key: current.key, decision: decision.id, outcome });
    }
    // Once the loop has escalated the racing item's spent release, the operator releases it by the hand route the escalation names.
    if (options.staleRelease && !staleReleaseDay.handReleased.length) {
      const racing = items[options.staleRelease.racing - 1];
      if (Object.values(state.actions).some(action => action.kind === 'escalation' && action.work === racing.key && /graphyard master release/.test(action.detail))) {
        await engine.execute(principals.operator, 'ready', racing.id, {}, id());
        staleReleaseDay.handReleased.push({ key: racing.key, elapsed });
      }
    }
    // GY-551: twenty minutes in, the master requests a release of the last two items by hand and
    // puts each to an approver session it launches itself; neither session judges it.
    if (options.handApprovers && elapsed === 20 * minute) for (const [n, ending] of [[plan.items, 'vanishes'], [plan.items - 1, 'stops']] as const) {
      const current = (await store.list()).find(item => item.id === items[n - 1].id)!;
      const decision = await api(principals.operatorAgent, 'POST', `work/${current.id}/decide`, { action: 'release', input: decisionInput('release', current, {}), reason: `Soak: a hand-requested release of ${current.key} its approver never judges` });
      hand.set(decision.id, { key: current.key, launches: 0, refused: 0 });
      const pane = herdr.open(approverSessionName(current, decision.id));
      // Each ends a minute after the loop first lists it.
      pending.push(async () => { pending.push(async () => { if (ending === 'vanishes') herdr.kill(pane); else herdr.status(pane, 'done'); }); });
    }
    // GY-1297: once each scenario item has a candidate, a fault strands an approval on it — approved,
    // its application never recorded. Item 1's rework is bound to a head the item never had (it moved
    // past it) and item 2's unblock judged no head (its situation holds), each put to an approver
    // session by hand; item 3's rework, bound to a head it left, has no session at all, so the loop's
    // own rework request for it when its reviewer sends it back meets it standing.
    if (options.stranded) for (const [n, action, kind, watched] of [[1, 'rework', 'moved', true], [2, 'unblock', 'holds', true], [3, 'rework', 'moved', false]] as const) {
      if ([...stranded.values()].some(entry => entry.workId === items[n - 1].id)) continue;
      const current = (await store.list()).find(item => item.id === items[n - 1].id)!;
      if (!current.candidate) continue;
      const id = randomUUID(), input = action === 'rework' ? { previousWorkerStopped: true } : { expectedRevision: current.revision };
      const situation = kind === 'moved' ? { situation: { sha: sha('stranded', n), baseSha: current.candidate.baseSha } } : {};
      await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [current.id, principals.operatorAgent.id, 'decision.requested', JSON.stringify({ id, action, input, reason: `Soak: a ${action} of ${current.key} whose application a fault interrupts`, requester: { id: principals.operatorAgent.id, role: 'admin' }, capabilities: [], ...situation })]);
      await store.pool.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [current.id, principals.approver.id, 'decision.approved', JSON.stringify({ id, action, reason: 'Soak: approved, then the application is interrupted', requestedBy: principals.operatorAgent.id, approver: { id: principals.approver.id, role: 'admin' } })]);
      stranded.set(id, { key: current.key, workId: current.id, kind, watched, pane: watched ? herdr.open(approverSessionName(current, id)) : null });
    }
    // GY-475: once the loop has settled the scenario's refused rework decisions (each approver
    // session closed, its refusal escalated and never re-requested), the daemon restarts: the
    // fresh cursor holds no watch, and the items still call for the same decisions — same head,
    // base and grounds binding. The fresh loop's first request for each must already cite its
    // refusal: the ledger keeps the refused inputs as jsonb, whose key order is not the loop's,
    // so the scan matches only in canonical form, and an uncited request would cost a refused
    // round-trip and one of the three bounded refusal answers.
    if (options.refuseReworkOf?.length && !restarted && refused.length === options.refuseReworkOf.length
      && refused.every(entry => state.actions[`escalation:decision-refused:${entry.decision}`]?.state === 'done')) {
      state = emptyDaemonState(config);
      restarted = true;
    }
    const deploying = deploys < plan.deploys.length && elapsed >= plan.deploys[deploys];
    if (deploying) { production.build = sha('build', ++deploys); production.sha = github.tip; production.deploys.push({ at: now, build: production.build, sha: production.sha }); }
    // The plane reports its held integration job only inside the flap windows (GY-439's recurring fault).
    heldJobs = plan.heldJob.at.some(at => elapsed >= at && elapsed < at + plan.heldJob.forMs);
    // GY-852: the idling worker's pane dies after its re-prompt, and the profile's agent name is
    // taken by another session standing at its prompt — the shape that delivered one item's
    // re-prompt into another item's pane. Once the loop has reclaimed the attempt, the other
    // session ends on its own.
    if (options.reassigned) {
      const reassigned = options.reassigned;
      const idled = sessions.find(entry => entry.key === items[reassigned - 1].key && entry.state === 'idling');
      if (idled) {
        if (!reassign.pane && now >= idled.dispatchAt + 36 * minute) {
          herdr.kill(idled.pane);
          reassign.pane = idled.pane;
          reassign.phantom = herdr.open(idled.profile.agentName, 'done');
        }
        if (reassign.phantom && !reassign.phantomGone) {
          const current = (await store.list()).find(item => item.id === items[reassigned - 1].id)!;
          if (current.lease === null || current.lease.epoch !== idled.epoch) { reassign.phantomGone = true; herdr.kill(reassign.phantom); idled.state = 'reclaimed'; }
        }
      }
    }
    // The world moves: GitHub, then the sessions. A deploy restarts the control plane once the
    // sessions have renewed: for the rest of that minute nothing reaches it, the loop included.
    github.tick(now);
    // GY-1250: the operator fixes main forward a while after the guard gave up the revert.
    if (guardDay && guardDay.fixedAt === null) {
      const given = [...github.reverts.values()].find(revert => revert.key === guardDay.abandons && revert.closedAt !== null);
      if (given && now - given.closedAt! >= guardDay.fixAfterMs) { github.fixForward(given.mergeSha); guardDay.fixedAt = now; }
    }
    // The docs-conflict scenario is a main-day and regression-day fault: the other days' own
    // rework accounting and windows would only absorb a base move this day must hold.
    if (!options.headless && !options.scope && !options.handApprovers && !options.stranded && !options.capacityWait && !options.refuseReworkOf?.length && !options.containment && !failover && !docs) docsTick();
    await workersTick(now);
    if (options.drained) await drainTick(now);
    docsSyncTick(now);
    await producersTick(now);
    // GY-1078: every blocker the day's failing items carry is sighted; the operator clears the
    // constant item's `unblockAfterMs` after it is recorded, and its next launch succeeds.
    if (options.dispatchFailing) for (const item of (await store.list()).filter(entry => items.some(own => own.id === entry.id) && entry.blocker)) {
      failing.blockerSeen.push({ key: item.key, at: now });
      if (numberOf(item) !== options.dispatchFailing.constant || failing.unblocked !== null) continue;
      failing.blockedAt ??= now;
      if (now - failing.blockedAt < options.dispatchFailing.unblockAfterMs) continue;
      await engine.execute(principals.operator, 'unblock', item.id, { reason: 'soak: the worktree holding the branch was removed by hand' }, id());
      failing.unblocked = now;
    }
    // GY-756: the out-of-queue merge. Git shows it landed at once; its item records it unlanded
    // until an observation — its own, or another candidate's landing check — reconciles it.
    // The queue-only day runs without it: a tip the window published is not merged by hand.
    const byHand = [...github.prs.values()].find(pr => pr.key === items[plan.outOfQueue.item - 1].key && pr.open);
    // It lands in a minute another open candidate is observed while its own item is not, so the
    // landing check of that other candidate is what reconciles it, as it was for GY-744's peer.
    const due = async () => new Set((await store.pool.query('SELECT work_id FROM jobs WHERE available_at<=now() AND (held_until IS NULL OR held_until<=now()) AND (locked_until IS NULL OR locked_until<now())')).rows.map(row => row.work_id as string));
    const handItem = items[plan.outOfQueue.item - 1];
    if (!outside && !deploying && byHand && now - byHand.createdAt >= plan.outOfQueue.afterMs && await due().then(ids => !ids.has(handItem.id) && [...github.prs.values()].some(pr => pr.open && pr !== byHand && ids.has(items.find(item => item.key === pr.key)!.id)))) {
      engine.directMergeEnvironment = { since: new Date(now).toISOString(), until: new Date(now + minute).toISOString(), reason: 'Soak: an operator merges one pull request by hand', setBy: 'environment', enabledAt: new Date(now).toISOString(), source: 'environment', event: null };
      outside = { key: byHand.key, sha: github.mergeOutside(byHand, now).sha, at: now };
    }
    if (!deploying && now >= loopDownUntil) {
      for (const act of pending.splice(0)) await act();
      // A watched run that ended has its verdict applied before the world moves on.
      if (headless) await Promise.all([...headless.settling].filter(([directory]) => headless.pi.processes.get(directory)!.state !== 'live').map(([directory, settled]) => { headless.settling.delete(directory); return settled; }));
      await engine.reconcile();
      await busyFleet(now);
      // GY-806: CI's check_run webhooks, delivered as the route delivers them. The pass claims every
      // webhook-woken job that is due before any polled one, and re-observes each within the minute.
      // Only the day that asserts them runs them (`github806`): every other scenario keeps main's pass.
      if (options.github806) for (const delivery of github.completedChecks(now)) webhook.deliveries += (await wakeFromWebhook(store.pool, { all: false, prs: [delivery.pr], shas: [delivery.sha], branches: [] }, true)).length;
      // GY-1099: the observation workers never reach a starved item's polled job until GitHub has
      // merged it; a prioritized wake is claimed, except the dropped item's first one.
      if (options.starved) {
        const mergedOnGitHub = (id: string) => github.merges.some(entry => entry.key === items.find(item => item.id === id)!.key);
        const starved = [...starvation.armed.keys()].filter(id => !mergedOnGitHub(id));
        // Once GitHub has merged it, the workers reach its polled job again, which reads the merge.
        for (const id of [...starvation.armed.keys()].filter(id => mergedOnGitHub(id) && !starvation.released.has(id))) {
          await store.pool.query('UPDATE jobs SET available_at=now() WHERE work_id=$1', [id]);
          starvation.released.add(id);
        }
        const dropping = items[options.starved.dropFirst - 1];
        if (starved.includes(dropping.id) && !starvation.dropped.length && (await store.webhookDue()).includes(dropping.id)) {
          await store.pool.query('UPDATE jobs SET webhook_at=NULL WHERE work_id=$1', [dropping.id]);
          starvation.dropped.push(`+${Math.round(elapsed / minute)} min ${dropping.key}`);
        }
        const prioritized = new Set(await store.webhookDue());
        for (const id of starved) if (prioritized.has(id)) starvation.claimed.push({ key: items.find(item => item.id === id)!.key, at: elapsed });
        await store.pool.query(`UPDATE jobs SET available_at=now() + interval '1 day' WHERE work_id = ANY($1::uuid[]) AND NOT (work_id = ANY($2::uuid[]))`, [starved, [...prioritized]]);
      }
      const dueNow = await due(), woken = (await store.webhookDue()).filter(id => dueNow.has(id));
      let claims = 0, processed = 0;
      const job = async () => {
        const from = github.guardRequests.length;
        await processJob(engine, adapter);
        if (guardDay && github.guardRequests.length > from) guardDay.ticks.push({ at: elapsed, requests: github.guardRequests.slice(from) });
      };
      for (let guard = 0; guard < 200 && await jobsDue(); guard++, processed++) {
        await job();
        if (woken.length && ++claims === woken.length) {
          const left = new Set(await store.webhookDue());
          for (const id of woken) if (left.has(id)) webhook.late.push(`+${Math.round(elapsed / minute)} min ${items.find(item => item.id === id)?.key ?? id}`);
        }
      }
      // GY-1250: the job loop runs whether or not a job is due, and with it the main guard.
      if (guardDay && !processed) await job();
      for (const item of await store.list()) {
        if (!woken.includes(item.id) || item.stage === 'done') continue;
        webhook.woken++;
        if (!item.observation || Date.parse(item.observation.at) < now) webhook.unobserved.push(`+${Math.round(elapsed / minute)} min ${item.key}`);
      }
      if (options.github806) {
        webhook.refreshes += Number((await store.pool.query('SELECT count(*) AS n FROM jobs WHERE refreshed_until > now()')).rows[0].n);
        webhook.skipped += Number((await store.pool.query("SELECT count(*) AS n FROM jobs WHERE deferred_reason LIKE 'poll skipped:%' AND (refreshed_until IS NULL OR available_at > refreshed_until)")).rows[0].n);
        immutable.peakLive = Math.max(immutable.peakLive, 2 * [...github.prs.values()].filter(pr => pr.open && !pr.merged).length);
        for (const pr of github.prs.values()) {
          if (!pr.open || pr.merged) continue;
          for (const path of [`/commits/${pr.head}`, `/compare/${github.tip}...${pr.head}`]) {
            await immutableClient.request(path); immutable.reads++;
            if ((immutableSends.get(`/repos/${repository}${path}`) ?? 0) > 1) immutable.refetched.push(`+${Math.round(elapsed / minute)} min ${pr.key} ${path.split('/').slice(-2).join('/')}`);
          }
        }
        const openPrs = [...github.prs.values()].filter(pr => pr.open && !pr.merged), sent = { ...cycleSends }, fleet = await store.list();
        for (const pr of openPrs) {
          const work = fleet.find(entry => entry.submission?.pr === pr.number);
          if (!work) continue;
          const observed = await cycleClient.observe(work, fleet).catch(error => { shared.failed.push(`+${Math.round(elapsed / minute)} min ${pr.key}: ${error instanceof Error ? error.message : error}`); return null; });
          if (observed && observed.baseTip !== github.tip) shared.stale.push(`+${Math.round(elapsed / minute)} min ${observed.baseTip?.slice(0, 8)} for ${github.tip.slice(0, 8)}`);
        }
        if (openPrs.length) { shared.cycles++; shared.observations += openPrs.length; }
        if (cycleSends.ref - sent.ref > 1) shared.overRead.push(`+${Math.round(elapsed / minute)} min ${cycleSends.ref - sent.ref} ref reads`);
        shared.refReads = cycleSends.ref; shared.protectionReads = cycleSends.protection;
        if (elapsed > 0 && elapsed % (3 * hour) < minute) { await replicaB.close(); replicaB = new GitHubChargeLedger(store.pool, chargeInstallation, { ...chargeOptions, instance: `replica-b-${++chargeRestarts}` }); }
        for (let index = 0; index < cycleSends.ref - sent.ref; index++) replicaA.charge(now, 'GET /git/ref/heads/:branch', 'git');
        for (let index = 0; index < cycleSends.protection - sent.protection; index++) replicaA.charge(now, 'GET /branches/:branch/protection', 'branches');
        for (const _pr of openPrs) { replicaB.charge(now, 'GET /pulls/:n', 'pulls'); charged.b.push(now); }
        await replicaB.sync(now); await replicaA.sync(now); charged.cycles++;
        // The window is computed here from the calendar, not with the ledger's minute floor (GY-1052): the
        // hour back from now, truncated to the start of its UTC minute, that boundary minute's charges included.
        const windowStart = new Date(now - hour); windowStart.setUTCSeconds(0, 0);
        const expected = charged.b.filter(at => at >= windowStart.getTime()).length;
        if (charged.b.some(at => at >= windowStart.getTime() && at < now - hour)) charged.boundaryCycles++;
        const counted = replicaA.fleet(now).rows.reduce((total, row) => total + row.requests, 0);
        if (counted !== expected) charged.miscounted.push(`+${Math.round(elapsed / minute)} min counted ${counted} of ${expected}`);
        const ledger = (await store.pool.query('SELECT count(*)::int AS n, min(minute) AS oldest, array_agg(DISTINCT instance) AS instances FROM github_charges WHERE installation=$1', [chargeInstallation])).rows[0];
        charged.peakRows = Math.max(charged.peakRows, ledger.n);
        for (const instance of ledger.instances ?? []) charged.instancesSeen.add(instance);
        // Three endpoints, at most one row per endpoint, instance and minute, and every row within two hours.
        if (ledger.n > 3 * (2 * 60 + 2) || ledger.oldest && now - ledger.oldest.getTime() > 2 * hour) charged.overBound.push(`+${Math.round(elapsed / minute)} min ${ledger.n} rows from ${ledger.oldest?.toISOString()}`);
        await immutableCache.flush(); await immutableCache.prune(); immutable.cycles++;
        const held = (await store.pool.query(`SELECT count(*)::int AS n, coalesce(sum(pg_column_size(value)), 0)::int AS bytes FROM github_cache WHERE kind = 'immutable' AND key LIKE $1`, [`${immutableScope}:%`])).rows[0];
        immutable.peakRows = Math.max(immutable.peakRows, held.n); immutable.peakBytes = Math.max(immutable.peakBytes, held.bytes);
        if (held.n > immutableBound.rows || held.bytes > immutableBound.bytes) immutable.overBound.push(`+${Math.round(elapsed / minute)} min ${held.n} rows ${held.bytes} bytes`);
      }
      for (const item of await store.list()) {
        const sha = item.candidate?.sha, refused = (item.gates ?? []).flatMap(gate => gate.passed ? [] : gate.reasons)
          .find(reason => /would revert \d+ files? outside its planned files/.test(reason));
        if (sha && refused && !landingRefusals.some(entry => entry.key === item.key && entry.sha === sha)) landingRefusals.push({ key: item.key, sha, elapsed });
      }
      // GY-1099: a starved item is armed once every gate but acceptance and merge passes on a
      // fresh observation; its evidence lands three minutes later, on an observation by then stale.
      if (options.starved) for (const item of await store.list()) {
        if (item.stage === 'done') continue;
        if (!options.starved.items.includes(numberOf(item))) continue;
        const held = starvedProof.get(item.id);
        if (!held || !item.candidate || held.candidate?.sha !== item.candidate.sha) continue;
        if (!starvation.armed.has(item.id) && item.gates.every(gate => gate.passed || gate.name === 'acceptance' || gate.name === 'merge')) starvation.armed.set(item.id, elapsed);
        const armedAt = starvation.armed.get(item.id);
        if (armedAt !== undefined && !starvation.evidenced.has(item.id) && elapsed - armedAt >= 3 * minute) {
          await engine.execute(principals.producer, 'evidence', item.id, { proof: PROOF, sha: item.candidate.sha, baseSha: item.candidate.baseSha, policyRevision: item.policyRevision, result: 'pass', executed: 4, skipped: 0,
            exercise: { criterion: 'AC-1', behaviour: `item ${numberOf(item)}'s change`, result: 'fail', executed: 1 } }, id());
          starvation.evidenced.set(item.id, elapsed);
        }
      }
      // GY-849: what still waited for capacity when the window closed, each with its request's age.
      if (options.capacityWait && !capacityWaiters && elapsed >= options.capacityWait.to)
        capacityWaiters = Object.values(state.approvals).filter(watch => watch.capacity).map(watch => ({ decision: watch.decision, key: watch.work, requestedAt: watch.requestedAt }));
      // GY-898: the master session is killed mid-day, inside the window the registry refuses to end sessions.
      if (options.master && !master.killed && elapsed >= options.master.exitAt) {
        const live = herdr.byName(config.masterAgentName!);
        if (live?.pane_id) { herdr.kill(live.pane_id); master.killed = live.pane_id; }
      }
      // GY-1223: from `working.from` the live master works (Herdr reports it working) and its screen
      // carries a bare limit notice it wrote itself; at `working.retryAt` its runtime prints the
      // retry banner on its spent account and keeps retrying, still working, until the loop acts.
      const working = options.master?.working;
      if (working && !master.worked && elapsed >= working.from) {
        const live = herdr.byName(config.masterAgentName!);
        if (live?.pane_id) {
          herdr.status(live.pane_id, 'working'); master.worked = live.pane_id;
          screens.set(live.pane_id, `● Reading docs/master-agent-sessions.md\n\nWeekly/Monthly Limit Exhausted. Your limit will reset at ${hostWallClock(retryReset)} is the banner a working session must carry its retry marker beside\n● Working as ${config.masterAgentName}…\n`);
        }
      }
      if (working && master.worked && master.bannerAt === null && elapsed >= working.retryAt) { screens.set(master.worked, retryBanner); master.bannerAt = elapsed; }
      if (options.staleRework && await restartOnVerdict(now)) { elapsed += minute; await moveClock(minute); continue; }
      if (options.staleMerge && await restartOnMerge(now)) { elapsed += minute; await moveClock(minute); continue; }
      master.cycleOf = cycles;
      // GY-916: the supervisor restarts the loop for its own reasons: a new process, the same unit.
      if (loopRestarts.length && elapsed >= loopRestarts[0]) { loopRestarts.shift(); await processStart(state); }
      try {
        if (mechanicalDay) await reconcileLedger();
        if (headless) for (const run of await adoptHeadlessRuns(state, effects, () => {}, 'cycle')) {
          headless.settling.set(run.directory, run.settled);
          if (headless.pi.processes.get(run.directory)!.state === 'live') { headless.adoptedLive++; continue; }
          // An adopted run that already ended is applied on adoption, before the cycle judges its decision.
          headless.adoptedEnded++; await run.settled; headless.settling.delete(run.directory); await new Promise(resolve => setImmediate(resolve));
        }
        if (options.slowDeployment) { deploymentDay.land(); await new Promise(resolve => setImmediate(resolve)); }
        const cycleStart = clock.now(); budgetDay.cycleSlow = 0;
        const result = await runCycle(config, state, effects, clock.now, launcher); cycles++;
        if (acceptance) await draftsSettled();
        if (options.staleRelease) { staleReleaseDay.steps.push({ elapsed, ms: result.metrics.steps?.decisions?.ms ?? 0, backlogReads: staleReleaseDay.backlogReads }); staleReleaseDay.backlogReads = 0; }
        if (options.slowDecisions) budgetDay.cycles.push({ cycle: cycles - 1, elapsed, spentMs: clock.now() - cycleStart, slow: budgetDay.cycleSlow, deferred: [...state.decisionsDeferred] });
        if (options.slowDeployment) deploymentDay.cycles.push({ cycle: cycles - 1, elapsed, spentMs: clock.now() - cycleStart, cut: result.actions.some(action => action.kind === 'deployment' && /spent its \d+s budget/.test(action.detail)), pending: deploymentStep.deploymentReadsPending(state) });
        if (options.slowObservation) observationDay.cycles.push({ cycle: cycles - 1, elapsed, spentMs: clock.now() - cycleStart, cut: result.actions.some(action => action.kind === 'fault' && /spent its \d+s observation budget/.test(action.detail)), pending: faultsStep.observationReadsPending(state) });
        if (options.workspaceFailure) for (const [name, entry] of Object.entries(state.profiles)) if (/worktree/.test(entry.reason ?? '')) workspaceCooled.push(`+${Math.round(elapsed / minute)} min ${name}: ${entry.reason}`);
        reportedDispatches += result.actions.filter(action => action.kind === 'dispatch' && action.state === 'done').length;
        escalations.push(...result.actions.filter(action => action.kind === 'escalation').map(action => action.detail));
        // GY-1250: once the abandoned revert's line is raised as recovered (GY-1332: it repeats while
        // main is red), a busy cycle's resolved rows retire its row from the cursor, so "never raised
        // again" must hold without it.
        if (guardDay) {
          const lineKey = Object.keys(state.actions).find(key => key.startsWith('escalation:main-guard:'));
          if (lineKey && !guardDay.filled && /passed again/.test(state.actions[lineKey].detail)) {
            for (let row = 0; row < retainedActions + 20; row++) state.actions[`dispatch:filler:${row}`] = { kind: 'dispatch', work: null, principal: null, state: 'done', detail: 'filler', attempts: 1, epoch: null, cycle: state.cycle, at: new Date(clock.now()).toISOString() } as never;
            guardDay.filled = true;
          } else if (guardDay.filled && !lineKey) guardDay.linePruned = true;
        }
        if (options.blockers) blockerActions.push(...result.actions.filter(action => action.kind === 'blocker').map(action => ({ elapsed, work: action.work, state: action.state, detail: action.detail })));
        if (options.master) {
          const after = clock.now() - dayStart;
          master.rotations.push(...result.actions.filter(action => action.kind === 'failover' && action.detail.startsWith('Ended master session')).map(action => ({ at: elapsed, detail: action.detail, before: now - dayStart, after })));
          // The wake this cycle delivered carries the loop's clock reading the heartbeat is spaced by.
          for (const wake of master.wakes) if (wake.cycle === master.cycleOf && wake.clock === undefined && state.master.lastWake) wake.clock = Date.parse(state.master.lastWake.at) - dayStart;
        }
        if (docs) for (const action of result.actions) if (action.kind === 'fault' && /documentation headroom/.test(action.detail)) docsActions.push({ state: action.state, detail: action.detail });
        for (const watch of Object.values(state.approvals)) if (hand.has(watch.decision) && watch.exhaustedAt) spent.add(watch.decision);
        if (process.env.SOAK_TRACE) for (const action of result.actions) console.error(`+${Math.round(elapsed / minute)} ${action.kind} ${action.state} ${action.work ?? ''}: ${action.detail.slice(0, 300)}`);
      }
      catch (error) { failures.push(`${new Date(now).toISOString()}: ${error instanceof Error ? error.message : String(error)}`); }
      for (const key of Object.keys(state.actions)) actionKeys.add(key);
      blockerKeysPeak = Math.max(blockerKeysPeak, Object.keys(state.actions).filter(key => key.startsWith('blocker:')).length);
      // Only the day that holds a merge BLOCKED pays for the extra snapshot read each cycle.
      if (plan.blockedMerge) mergeStallSightings.push(...mergeStallAttention(await snapshot()).map(line => ({ subject: line.subject, text: line.text, at: clock.now() })));
      // The interval between cycles is when a hand-off launch settles; the day's clock waits for
      // them so the world never acts on a half-finished launch.
      await launcher.idle();
      // GY-898: at most one master session, whatever the cycle did.
      if (options.master) {
        // A settled launch carries the start the loop recorded: the budget is measured from it.
        const last = master.launches.at(-1);
        if (last && last.startedAt === undefined && state.master.session === last.session && state.master.startedAt) last.startedAt = Date.parse(state.master.startedAt) - dayStart;
        const live = herdr.list().filter(agent => agent.name === config.masterAgentName).length;
        master.maxLive = Math.max(master.maxLive, live);
        if (live > 1) violations.push(`${new Date(now).toISOString()} (+${Math.round(elapsed / minute)} min) ${live} master sessions are live at once`);
      }
      // GY-544: the loop's exited-session sightings stay bounded by the implementation handles still running here.
      const exitedRows = Object.keys(state.actions).filter(key => key.startsWith('exited:implementation:'));
      const running = (await store.list()).flatMap(item => (item.sessions ?? []).filter(handle => handle.kind === 'implementation' && handle.state === 'running' && handle.host === config.hostId)).length;
      exitedRowsSeen += exitedRows.length;
      if (exitedRows.length > running) violations.push(`${new Date(now).toISOString()} (+${Math.round(elapsed / minute)} min) ${exitedRows.length} exited-session sighting(s) for ${running} running implementation handle(s)`);
      // Between cycles, as runDaemon runs it: the checkout guard, then the self-upgrade against the
      // simulated checkout. GY-866: inside the head-move window HEAD stands at a commit the loop
      // never aligned to, and is put back where it was when the window closes.
      checkout.dirty = elapsed >= plan.dirtyCheckout.from && elapsed < plan.dirtyCheckout.to;
      const moved = elapsed >= plan.headMove.from && elapsed < plan.headMove.to;
      if (moved && movedFrom === null) { movedFrom = checkout.head; checkout.head = guardReads.foreignHead; guardReads.headMoves++; }
      if (!moved && movedFrom !== null) { checkout.head = movedFrom; movedFrom = null; }
      const readsBefore = guardReads.agents;
      const { refusal, upgraded } = await guard.betweenCycles(selfUpgrade);
      const lastSeen = lastRefusal;
      if (refusal && refusal !== lastRefusal) guardReads.transitions++;
      lastRefusal = refusal;
      if (refusal) {
        guardReads.refused++; guardReads.details.add(refusal);
        assert.ok(guardReads.agents <= readsBefore + 1, 'a refused cycle reads the Herdr inventory at most once');
        if (refusal !== lastSeen) assert.equal(guardReads.agents, readsBefore + 1, 'a refusal that changed reads the Herdr inventory afresh');
        refusalSamples.push({ keys: Object.keys(state.actions).filter(key => key.startsWith('upgrade:') || key.startsWith('escalation:dirty-checkout')).length, attempts: state.actions['escalation:dirty-checkout']?.attempts ?? 0, head: moved });
      } else assert.equal(guardReads.agents, readsBefore, 'a clean checkout costs no Herdr inventory read');
      if (upgraded) upgrades.outcomes.push(upgraded.outcome);
      if (upgraded?.outcome === 'failed') failures.push(`${new Date(now).toISOString()}: self-upgrade failed: ${upgraded.reason}`);
      if (upgraded?.outcome === 'pending') upgrades.owed.push({ to: state.upgrade.pending?.to ?? 'none', state: state.actions[`upgrade:${state.deployment?.sha}`]?.state ?? 'none', attempts: state.actions[`upgrade:${state.deployment?.sha}`]?.attempts ?? 0 });
      const watchdogActions = Object.entries(state.actions).filter(([key]) => key.startsWith('escalation:watchdog:'));
      upgrades.watchdog.push({ failed: watchdogActions.filter(([, action]) => action.state === 'failed').length, attempts: watchdogActions.reduce((total, [, action]) => total + action.attempts, 0), windowSec: upgrades.unit.watchdogSec });
      // The loop restarts after every other cycle a run is live, once its launches have settled as
      // `runDaemon` lets them: it signals none, and the next cycle adopts them.
      if (headless && cycles % 2 && headless.pi.live()) { detachRuns(); headless.settling.clear(); headless.restarts++; }
      for (const check of state.invariants.report as InvariantCheck[]) {
        if (check.observed) observed.add(check.invariant);
        if (!check.holds) { violations.push(`${new Date(now).toISOString()} (+${Math.round(elapsed / minute)} min) ${check.line}`); for (const subject of check.subjects) faulted.add(`${check.invariant}:${subject}`); }
      }
      // GY-883: every evaluated item rides the lane its observed change decides, with that lane's
      // shipped speed target, and master status reports both on its row — every cycle, all day.
      const listed = await store.list();
      for (const row of buildMasterStatus({ work: listed, now: new Date(now).toISOString() }, [], []).work) {
        const item = listed.find(entry => entry.key === row.key)!;
        if (!item.lane) continue;
        if (!lanes.includes(item.lane) || item.lane !== itemLane(item) || item.speedTarget !== laneSpeedTargets[item.lane] || row.lane !== item.lane || row.speedTarget !== item.speedTarget)
          violations.push(`${new Date(now).toISOString()} (+${Math.round(elapsed / minute)} min) ${item.key} rides lane ${item.lane} (target ${item.speedTarget}); its change decides ${itemLane(item)}; status reports ${row.lane} (target ${row.speedTarget})`);
        else lanesSeen.add(item.lane);
      }
    }
    const open = (await store.list()).filter(item => item.stage !== 'done').length;
    const step = open ? minute : 10 * minute;
    // The containment day's slow reads moved the clock inside the cycle; the day keeps one cycle a minute.
    elapsed += step; await moveClock(Math.max(0, step - fenced.drift)); fenced.drift = 0;
  }
  // Anything the documentation day (GY-574) left open is closed here, so the day's undelivered
  // work is not a later day's loop's to dispatch and judge.
  if (docs) {
    await moveClock(5 * minute);
    for (const leftover of await store.list()) {
      if (leftover.stage === 'done' || leftover.closure) continue;
      await api(principals.operator, 'POST', `work/${leftover.key}/close`, { kind: 'obsolete', reason: 'soak: the documentation day ends; a later day runs its own scenario' });
    }
  }

  // The blocked day ends with its repeating and request-error items left to the master: they are
  // closed here, so the next day's loop does not inherit them.
  if (options.blockers) {
    await moveClock(5 * minute);
    for (const leftover of await store.list()) {
      if (leftover.stage === 'done' || leftover.closure || !items.some(item => item.id === leftover.id)) continue;
      await api(principals.operator, 'POST', `work/${leftover.key}/close`, { kind: 'obsolete', reason: 'soak: the blocked day ends with its repeating and request-error blockers left to the master' });
    }
    // One more cycle sees it closed: the rows the loop kept for its blocker go with it.
    await runCycle(config, state, effects, clock.now, launcher); await launcher.idle();
  }
  // The credential-blocked day ends with its never-curing item held at the cap, and a failing-dispatch
  // day may end with an item still held: each is closed here, so a later day's loop never dispatches it.
  if (options.credentialBlocked || options.dispatchFailing) {
    for (const leftover of await store.list()) {
      if (!items.some(entry => entry.id === leftover.id) || leftover.stage === 'done' || leftover.closure) continue;
      await api(principals.operator, 'POST', `work/${leftover.key}/close`, { kind: 'obsolete', reason: 'soak: the credential-blocked day ends with its never-curing item held at the attempt cap' });
    }
  }
  // A later day's loop must not read this day's backlog.
  for (const extra of staleReleaseDay.backlog) await api(principals.operator, 'POST', `work/${extra.key}/close`, { kind: 'obsolete', reason: 'soak: the stale-release day ends with its backlog never released' });
  engine.reconcileLanded = reconcileLanded; engine.directMergeEnvironment = null;
  const final = (await store.list()).filter(item => items.some(entry => entry.id === item.id));
  // The days share one control plane, and a later day's loop that reads every item would dispatch
  // this day's unfinished ones and push to their linked pull requests. With the day's record taken
  // above, each is taken out of the plane: its lease given up by the worker holding it, then closed.
  for (const leftover of final.filter(item => item.stage !== 'done' && !item.closure)) {
    const owner = leftover.lease && everyone.find(principal => principal.id === leftover.lease!.owner);
    if (owner) await engine.execute(owner, 'release', leftover.id, { epoch: leftover.lease!.epoch }, id()).catch(() => {});
    await api(principals.operator, 'POST', `work/${leftover.key}/close`, { kind: 'obsolete', reason: 'soak: the day ended with this item unfinished; a later day must not dispatch it' }).catch(() => {});
  }
  if (options.decomposition) {
    decompositionHistory.deliveredParents = (await store.list()).filter(item => item.children?.length && item.stage === 'done').map(item => item.key);
  }
  await settleTmpReclaim(); await holder.close();
  const tmp = { root: tmpRoot, backlog, deadOwned, cache, heldDirectory, liveOwned, hourly, passes: tmpPasses, peak: tmpPeak, reports: await readReclaimReports(reclaimRoot), left: readdirSync(tmpRoot) };
  if (process.env.SOAK_TRACE) console.error(`landing: ${github.landingChecks} checks over ${github.landingBases.size} bases, ${github.ancestorCompares} ancestor compares, ${github.blindCompares} blind compares; false landing refusals: ${landingRefusals.map(entry => `${entry.key}@+${Math.round(entry.elapsed / minute)}min ${entry.sha.slice(0, 12)}`).join(', ') || 'none'}`);
  engine.execute = executeAll;
  return { provisionDay, promotion, throughput, reconciled, outside, items, final, github, sessions, docsSyncRuns, docsSyncRoot, lost, launches, violations, faulted, observed, failures, production, cycles, reportedDispatches, state, dayStart, tmp, headless, herdr, hand, stranded, withdrawals, resumes, strandedLaunches, escalations, spent, attestations, producerRuns, abandoned, spentHead, actionKeys, upgrades, refusalSamples, guardReads, checkout, landingRefusals, foreignPane, previousWorktrees, closedLeased,
    mergeQueuePosts, config, refused, decideCalls, restarted, approverPanes, failing, herdrClosed: herdr.closed, diagnosisModel: settings.model, diagnosisRuns: diagnosed, baseBreak, capacityRefused, capacityLaunched, capacityWaiters,
    decided, misreads, prompts, screens, heldAccounts, approverAccounts, retryReset, exitedLive, exitedClosed, exitedRowsSeen, reassign, workspaceFailures, workspaceCooled, docsFilings, docsActions, closedTrim, confined, unconfinedRefusals, fenced, mergeStallSightings, master, baseFailure,
    blockerEvents, blockerProbes, blockerDecisions, blockerActions, blockerKeysPeak, attempts, lanesSeen, laneApplications, approverWorks, approverDecisions, failover, webhook, remedies, observeRequests, starvation, immutable: { ...immutable, bound: immutableBound, distinct: immutableSends.size }, mechanical: { ledger, botRounds, misclassified, reviewHolds }, shared, charges: { ...charged, b: charged.b.length, instancesSeen: [...charged.instancesSeen], restarts: chargeRestarts },
    wakes, staleMerges, restartLog, guardDay, budgetDay, observationDay, deploymentDay, decompositionDay: decompositionHistory, diagnosisRaces, diagnosisRequestRaces, transientRefused, lateReads, staleReleaseDay, drain, acceptanceDay: acceptance?.day ?? null };
}

/**
 * GY-888: every session launch the day made ran the launcher's real confinement — a worker in its
 * linked worktree, an approver from the checkout itself, a headless producer run wrapped at its
 * spawn — and the same launch on a host that cannot build the mount namespace was refused with
 * the reason named, never started unconfined. Nothing that keeps the checkout authoritative — its
 * tree, its index, the refs only the guarded merge moves — is re-exposed writable.
 */
export function assertLaunchesConfined(day: { confined: { role: string; key: string; directory: string; mechanism: string; reexposed: readonly string[] }[]; unconfinedRefusals: string[]; sessions: unknown[]; producerRuns: unknown[] }, root: string) {
  const gitDir = join(root, '.git');
  const shared = [join(gitDir, 'objects'), join(gitDir, 'worktrees'), join(gitDir, 'refs', 'remotes'), join(gitDir, 'logs', 'refs', 'remotes'), join(gitDir, 'refs', 'heads', 'graphyard'), join(gitDir, 'logs', 'refs', 'heads', 'graphyard'), join(gitDir, 'FETCH_HEAD')];
  const sharedWritable = (path: string) => shared.some(base => path === base || path.startsWith(`${base}/`));
  const workerLaunches = day.confined.filter(launch => launch.role === 'worker');
  assert.equal(workerLaunches.length, day.sessions.length, `every worker dispatch the loop made was confined before its pane opened (${workerLaunches.length} of ${day.sessions.length})`);
  assert.equal(day.confined.filter(launch => launch.role === 'producer').length, day.producerRuns.length, 'every headless producer run was wrapped at its spawn');
  for (const launch of day.confined) {
    assert.equal(launch.mechanism, 'read-only-mount', `the ${launch.role} launch for ${launch.key} carries the read-only mount`);
    assert.ok(!launch.reexposed.includes(root) && ![join(gitDir, 'refs', 'heads'), join(gitDir, 'logs', 'refs', 'heads'), join(root, 'src'), join(gitDir, 'index')].some(path => launch.reexposed.includes(path)),
      `the ${launch.role} launch for ${launch.key} never re-exposes the checkout, its tree, index or every branch's refs writable: ${launch.reexposed.join(', ')}`);
    assert.ok(launch.reexposed.every(path => path === launch.directory || path.startsWith(`${launch.directory}/`) || sharedWritable(path)),
      `the ${launch.role} launch for ${launch.key} re-exposes only its own directory and the shared Git areas: ${launch.reexposed.join(', ')}`);
  }
  assert.ok(workerLaunches.every(launch => launch.reexposed.includes(launch.directory)), 'each worker launch re-exposes its own worktree writable');
  assert.ok(day.unconfinedRefusals.length >= day.confined.length && day.unconfinedRefusals.every(text => /Graphyard never starts a session unconfined|bubblewrap \(bwrap\) is not installed/.test(text)),
    `the same launches are refused where the confinement cannot be built: ${day.unconfinedRefusals[0] ?? 'none'}`);
}

// GY-612: the main day starts below the host's memory floor — the way the day that item records
// began — and recovers a quarter hour in, so the only launch it holds back is the first item's.
export const memoryDay = { memoryDip: { from: 0, until: 15 * minute } };

/**
 * GY-1417: the acceptance role's day. Three goals are recorded on the soak plane's real /api/goals
 * and the loop drives them through `acceptanceStep` with headless runs faked and GitHub's pull
 * requests held here. `signup`'s first open and first post fail and its first draft is refused;
 * `billing`'s approved pull request is closed unmerged by a person; `audit`'s first draft run
 * returns nothing and its first approved pull request conflicts with the base. The control plane's
 * land answers waiting until half an hour after it was first asked, then merged.
 */
export async function acceptanceWorld(dayStart: number) {
  const day = {
    goals: {} as Record<string, string>, runs: [] as { goal: string; role: 'draft' | 'judge'; at: number }[], opens: [] as { goal: string; pr: number; revision: number; at: number }[],
    posts: [] as { goal: string; ok: boolean; at: number }[], reads: [] as { pr: number; at: number }[], closes: [] as number[], lands: [] as { pr: number; at: number }[],
    pulls: new Map<number, { goal: string; branch: string; head: string; state: 'open' | 'closed' | 'merged'; autoAt: number | null }>(),
  };
  for (const name of ['signup', 'billing', 'audit'])
    day.goals[name] = (await api(principals.operatorAgent, 'POST', 'goals', { statement: `Customers can use ${name} without help`, users: ['Repository operators'], constraints: [], deployTarget: 'uat' })).key;
  const named = (key: string) => Object.entries(day.goals).find(([, goal]) => goal === key)![0];
  let next = 5000, openFailed = false, billingClosed = false, auditConflicted = false;
  const runner = (role: 'draft' | 'judge', goal: Goal): Runner => ({ name: 'soak-acceptance', start<T>(_prompt: string, options: RunOptions<T>) {
    const name = named(goal.key), drafts = day.runs.filter(run => run.goal === name && run.role === role).length;
    day.runs.push({ goal: name, role, at: clock.now() - dayStart });
    const failed = role === 'draft' && name === 'audit' && drafts < 2;
    const outcome = `${name}-${goal.revision}`;
    const payload = role === 'draft' ? { goal: goal.key, outcomes: [{ id: outcome, title: `A customer completes ${name}`, criteria: [`The ${name} page answers`], case: { id: outcome, title: `${name} answers`, tags: ['api'], target: 'uat', required: true,
      steps: [{ kind: 'http', name: 'read the board', method: 'GET', path: '/api/board', status: 200 }] } }] }
      : { goal: goal.key, verdict: name === 'signup' && goal.drafts === 1 ? 'refuse' : 'approve', reason: name === 'signup' && goal.drafts === 1 ? 'The case checks the board, not the sign-up' : 'Each outcome is what a customer asked for' };
    const result: RunResult<T> = failed ? { ok: false, failure: { reason: 'no-payload', detail: 'the run ended without a graphyard_acceptance call' }, payloads: [] }
      : { ok: true, tool: options.tool, payload: options.validate(payload), payloads: [] };
    return { id: `soak-acceptance-${day.runs.length}`, events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
  } });
  const read = (pr: number) => {
    day.reads.push({ pr, at: clock.now() - dayStart });
    const pull = day.pulls.get(pr)!;
    return { state: pull.state, mergeSha: pull.state === 'merged' ? sha('acceptance-merge', pr) : null, head: pull.head };
  };
  // POST /api/goals/:key/land as the control plane answers it, its GitHub held here: the merge lands half an hour after it is
  // first asked; a person closes billing's first approved pull request instead, and audit's first conflicts with the base.
  const land = async (goal: Goal) => {
    const pr = goal.acceptance!.pr, pull = day.pulls.get(pr)!;
    assert.equal(pull.head, goal.approval!.head, 'an acceptance pull request is landed only at its approved head');
    day.lands.push({ pr, at: clock.now() - dayStart });
    pull.autoAt ??= clock.now();
    let state: Landing['state'] = 'waiting';
    if (pull.goal === 'audit' && !auditConflicted) { auditConflicted = true; pull.state = 'closed'; state = 'conflicting'; }
    else if (pull.state === 'open' && clock.now() - pull.autoAt >= 30 * minute) {
      pull.state = pull.goal === 'billing' && !billingClosed ? 'closed' : 'merged';
      billingClosed ||= pull.goal === 'billing';
      state = pull.state;
    }
    const detail = state === 'conflicting' ? `acceptance pull request #${pr} conflicts with main` : state === 'closed' ? `acceptance pull request #${pr} was closed without merging` : state === 'merged' ? `#${pr} merged` : 'Required status check "test" is expected';
    const landing: Landing = { state, detail, mergeSha: state === 'merged' ? sha('acceptance-merge', pr) : null };
    if (state === 'waiting') return { goal, landing };
    // Recorded as the land route records it: merged has no route of its own.
    return { goal: await recordLanding(store, goal, landing, principals.operatorAgent), landing };
  };
  const effects: AcceptanceEffects = {
    settings: diagnosticianSettings({}), cwd: coordinatorRoot!,
    goals: async () => (await api(principals.coordinator, 'GET', 'goals?open=1')).goals,
    runner: async (role, attempt, goal) => ({ runner: runner(role, goal), runtime: `soak-${attempt}`, model: attempt }),
    open: async (goal, draft) => {
      const name = named(goal.key), branch = `graphyard/${goal.key.toLowerCase()}-acceptance-${goal.revision}`;
      if (name === 'signup' && !openFailed) { openFailed = true; throw new Error('gh pr create: HTTP 502'); }
      const existing = [...day.pulls].find(([, pull]) => pull.branch === branch && pull.state === 'open');
      const head = sha('acceptance', goal.key, goal.revision, JSON.stringify(draft));
      if (existing) { existing[1].head = head; return { pr: existing[0], branch, head }; }
      const pr = next++;
      day.pulls.set(pr, { goal: name, branch, head, state: 'open', autoAt: null });
      day.opens.push({ goal: name, pr, revision: goal.revision, at: clock.now() - dayStart });
      return { pr, branch, head };
    },
    draft: async (goal, input) => {
      const name = named(goal.key), first = !day.posts.some(entry => entry.goal === name);
      day.posts.push({ goal: name, ok: !(name === 'signup' && first), at: clock.now() - dayStart });
      if (name === 'signup' && first) throw new Error('Graphyard refused goals (502): Bad Gateway');
      return api(principals.operatorAgent, 'POST', `goals/${goal.key}/draft`, input, `acceptance:${goal.id}:${goal.revision}`);
    },
    judge: (goal, judgement) => api(principals.approver, 'POST', `goals/${goal.key}/${judgement.verdict}`, { reason: judgement.reason }, `acceptance:${goal.id}:${goal.revision}:judged`),
    pullRequest: async pr => read(pr),
    land,
    close: async pr => { const pull = day.pulls.get(pr)!; if (pull.state === 'open') pull.state = 'closed'; day.closes.push(pr); },
    closed: (goal, pr, reason) => api(principals.operatorAgent, 'POST', `goals/${goal.key}/closed`, { pr, reason }, `acceptance:${goal.id}:${goal.revision}:closed`),
  };
  return { day, effects };
}
