import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, utimes, writeFile, type FileHandle } from 'node:fs/promises';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { Store, wakeFromWebhook } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { server } from '../src/server.js';
import { GitHub, processJob } from '../src/github.js';
import { GitHubCacheStore } from '../src/github-cache.js';
import { createHash } from 'node:crypto';
import { Refusal, isClosed, type Principal, type Work } from '../src/model.js';
import { approverSessionName, assessContainment, atomicPrivateWrite, automaticReviewerConcurrency, containmentPhase, containmentQuarantines, decisionInput, dispatchWork, loadMasterConfig, masterConfigSchema, mergeExecutor, profileConcurrency, setupMaster, type MasterConfig, type WorkerProfile } from '../src/master.js';
import { readAccountStartFailures, readProfileLaunchRecords, workerLaunchStatus } from '../src/master/dispatch.js';
import { readControlPlaneClock, unmeasured } from '../src/master/containment.js';
import { containmentRefusalCause } from '../src/daemon/cycle-reclaim.js';
import type { SupervisorProbeReport } from '../src/containment-probe.js';
import { coordinatorConfinementRefusal, mergeBatchSize, mergeParallelTips, optimisticExcludeGlobs, optimisticMergeEnabled, rerunFailedChecks } from '../src/master/profiles.js';
import { doctorSettingsSchema } from '../src/master/doctor-settings.js';
import { headlessConfinementWrapper, sessionConfinement } from '../src/master/launch.js';
import { answeringWidening, emptyDaemonState, runCycle, type DaemonEffects, type DaemonState } from '../src/master-daemon.js';
import { adoptHeadlessRuns } from '../src/daemon/run.js';
import { maxApproverLaunches, maxLostApproverRuns } from '../src/daemon/decisions.js';
import { adoptRuns, detachRuns, liveRuns, pruneRunDirectories, runDirectoryRetentionMs, runsDirectory, watchedRuns, withRunnerAgents, type Applied } from '../src/runner/registry.js';
import { applyDecision, approverRunOptions, startNarrowRun } from '../src/runner/roles.js';
import type { DecidePayload } from '../src/runner/payloads.js';
import { plannedFilesMax, type ScopeRequestState } from '../src/model/scope.js';
import { diagnosticianSettings, diagnosisSettled } from '../src/runner/payloads.js';
import { stoppedStates } from '../src/daemon/effects.js';
import type { RunOptions, RunRecord, RunResult, Runner } from '../src/runner/types.js';
import type { DiagnosticianEffects } from '../src/daemon/diagnosis.js';
import { Launcher } from '../src/daemon/cycle.js';
import { branchReport, buildMasterStatus } from '../src/master/status.js';
import { docsHeadroomStatus, docsTrimActionKey, docsWordCountAt, type ReportedAttention } from '../src/daemon/faults.js';
import { docsTrimTitle } from '../src/model/documentation.js';
import { successorWidening } from '../src/model/successors.js';
import { checkInvariants, emptyInvariantRecord, invariantDefaults, systemInvariants, type InvariantCheck } from '../src/model/invariants.js';
import { heldNameAttention, readReviewLedger, settledCloseAttempts, type ReviewRecord } from '../src/reviewer.js';
import { emptyDispatchCursor, runDispatchTick, selectReviewerProfile } from '../src/auto-dispatch.js';
import { fleet, requested } from './helpers/review-fleet.js';
import { reclaimResources, readReclaimReports, settleTmpReclaim } from '../src/master-resources.js';
import { heldOpenPaths, reclaimTmpDirectories, writeTempOwner, tmpReclaimLimitPerCycle, tmpReclaimMinAgeMs, type TmpReclaimReport } from '../src/tmp-reclaim.js';
import { temporaryDirectory } from './helpers/temp-dirs.js';
import { expandTypedCommand } from './helpers/launch-shell.js';
import { lostRunReason, requestAttemptLimit, sessionRetry, sessionRetryLimit } from '../src/producer.js';
import type { ExhaustedProof } from '../src/daemon/decisions.js';
import { performSelfUpgrade, type SelfUpgradeOutcome } from '../src/daemon/upgrade.js';
import { defaultOptimisticExclude } from '../src/optimistic-merge.js';
import { queuePlacement } from '../src/merge-queue.js';
import { shipHeldFollowUps, type ShipFollowUps, type ShipRuns } from '../src/reviewer.js';
import { followUpEntries, followUpParent, hasShipped } from '../src/model/machine-backlog.js';
import { repeatedClientErrorLimit } from '../src/retry-stop.js';
import { SimulatedGitHub, SimulatedHerdr, SimulatedPi, blockedMergeMs, clock, protectionOnlyCheck, statusContext, clockSql, hour, minute, sha } from './helpers/soak-world.js';
import { mergeStallAttention } from '../src/cli/master-status.js';
import { laneApprover } from '../src/server/decisions.js';
import { itemLane, lanes, laneSpeedTargets } from '../src/model/policy.js';
import { doctorRunEvent } from '../src/server/routes/status.js';
import { containmentSettlementRefusals, containmentVerificationSchema } from '../src/quarantine.js';
import { scopeRefusalBlocker } from '../src/model/scope.js';
import type { DoctorEffects } from '../src/daemon/doctor.js';

/**
 * GY-404: per-item gates cannot catch faults that emerge from interaction over time, so this runs
 * the real loop — `runCycle` with the real engine on the test Postgres, the real reconciliation job
 * (`processJob`) and the real guarded merge — against a deterministic simulated GitHub, Herdr and
 * clock for a simulated day, and asserts after every cycle that every system invariant
 * (src/model/invariants.ts) holds. Fifteen items pass through it: released every fifteen minutes so
 * a merge lands about every fifteen, three sent back by their reviewer, two whose worker dies, two
 * production deploys, a file split on main that re-plans an item, one pull request merged by hand
 * outside the queue that another candidate's landing check reconciles (GY-756), one pull request GitHub reports
 * CLEAN at once and one UNSTABLE, a reviewer bot out of quota that fails over, the loop's
 * resource reclaim with its /tmp pass (GY-421) over a scratch tmp root holding a backlog past the
 * per-pass bound, a directory held open, one a live owner keeps, and a leftover every hour that
 * ages past the six-hour threshold during the day, one head whose producer
 * runs are killed, then fail until the request is spent (GY-496), two flaky tips
 * rerun once (GY-516), one passing on the rerun and one failing again, and the
 * between-cycles self-upgrade (GY-437) against a simulated coordinator checkout that stands dirty
 * across the second deploy for a while. The plane also reports a held integration job in three
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
 * cycle — and the invariants hold on that detached path. Optimistic merge (GY-500) is on, as by
 * default: disjoint items land past the queue, two that change shared infrastructure queue, and one
 * breaks main after its optimistic merge, so the main guard reads the post-merge runs, reverts it
 * and reopens it. The loop publishes its merge-queue configuration every cycle it changes (GY-330,
 * GY-498, GY-500, GY-516), and a second, queue-only day runs the parallel-tip window (GY-498) over
 * every item: several tips validated at once, a failing tip ejecting only its own entry once the
 * tips ahead pass while the suffix rebuilds without it, and the window reconfigured mid-day and
 * republished. A change to the loop that breaks an invariant fails here, in CI, before it merges;
 * a new behaviour that repeats per cycle, head or item belongs in this world.
 * The loop records every worker's session handle and may prompt a session (GY-544): three workers
 * ask for scope that is decided before the loop's next cycle sees the request, two panes are
 * misread by Herdr as holding no agent for one cycle, and one worker's runtime exits and leaves
 * its pane on a bare shell.
 */
const repository = 'owner/project';
const PROOF = 'unit:soak-behaves';
const principals = {
  operator: { id: 'operator', role: 'admin', sessionKind: 'ai' },
  operatorAgent: { id: 'graphyard-master-operator', role: 'admin', sessionKind: 'ai' },
  approver: { id: 'graphyard-approver', role: 'admin', sessionKind: 'ai' },
  coordinator: { id: 'graphyard-master', role: 'coordinator' },
  producer: { id: 'proof-runner', role: 'producer', proofs: [PROOF] },
} satisfies Record<string, Principal>;
const workers: WorkerProfile[] = ['one', 'two', 'three'].map(name => ({ name, principal: `worker-${name}`, agentName: `soak-worker-${name}`, mode: 'launch', kind: 'claude', credentialFile: `/outside/${name}.token`, agentArgs: [], approvals: 'auto', environment: {} }) as WorkerProfile);
// The queue-only day's roster (GY-498): worker capacity enough to fill the parallel-tip window,
// which three workers' push rate can never deepen past two tips in flight.
const queueWorkers: WorkerProfile[] = ['four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'].map(name => ({ name, principal: `worker-${name}`, agentName: `soak-worker-${name}`, mode: 'launch', kind: 'claude', credentialFile: `/outside/${name}.token`, agentArgs: [], approvals: 'auto', environment: {} }) as WorkerProfile);
const everyone: Principal[] = [...Object.values(principals), ...[...workers, ...queueWorkers].map(profile => ({ id: profile.principal, role: 'worker' as const }))];
const credentials = everyone.map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
const token = (principal: Principal) => credentials.find(entry => entry.id === principal.id)!.token;
const reviewerApps = [{ id: 'claude-reviewer', runtime: 'claude', appId: 55_001, botUserId: 55_002 }, { id: 'cursor-reviewer', runtime: 'cursor', appId: 66_001, botUserId: 66_002 }];
const launcher = fileURLToPath(new URL('../bin/graphyard.mjs', import.meta.url));
const soakConfig: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository, baseBranch: 'main', githubAppId: 1234,
  hostId: 'soak-host', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers,
  operatorAgent: { id: principals.operatorAgent.id, credentialFile: '/outside/operator.token' }, approver: { id: principals.approver.id, credentialFile: '/outside/approver.token' },
  run: { proofWorkflow: 'acceptance.yml', intervalSeconds: 60 } });

/** The day, in simulated time from the start. */
const start = Date.parse('2031-06-02T08:00:00Z');
const basePlan = {
  items: 15, releaseEveryMs: 15 * minute, workMs: 20 * minute,
  // GY-842: review panes of a previous day, standing agentless with their worktrees deleted.
  leftovers: 8,
  rework: new Set([3, 7, 11]), deaths: new Set([5, 9]), deathAfterMs: 8 * minute,
  deploys: [2 * hour + 30 * minute, 5 * hour], dirtyCheckout: { from: 4 * hour + 50 * minute, to: 6 * hour }, split: { at: 45 * minute, item: 12 }, clean: 2, unstable: 4, slowRecompute: 8, exhaustedReviewer: 6, slowObservationMs: 10 * minute,
  /** GY-500: the item whose first head breaks main after its optimistic merge, and the items that change shared infrastructure and so queue. */
  breaksMain: 10, infrastructure: new Set([13, 14]),
  // GY-516: a flake on a speculative tip whose one rerun passes, and one whose rerun fails again.
  flaky: { rerunPasses: 13, rerunFails: 14 },
  // GY-839: for one stretch of the day GitHub answers every open candidate's compares without a
  // usable merge base, so the landing comparison keeps the two-way endpoint diff and the base's
  // own new changes read as reverts — the reading this item fixes. The window covers the NOTICE
  // commit on main, which moves the base under candidates still unqueued: their false landing
  // refusals hold only the build gate and clear on the same heads when the window closes, before
  // a worker could even react to them.
  blind: { from: 96 * minute, to: 98 * minute },
  notice: 96 * minute,
  // GY-852: the item whose worker idles with its live lease, loses its pane, and whose profile's
  // agent name another session then holds — the loop must reclaim the attempt without pasting
  // into or closing that pane, and still deliver the item. The reassigned day carries it alone:
  // its plan is trimmed to this fault, so it never shares an item with the main day's.
  reassigned: 5,
  // GY-496: item 1's first head has its producer runs killed (exit 143) twice, then failing until
  // the request is spent; the loop escalates it once and requests one rework for that head. The
  // fault-free first item hosts it because GY-756's out-of-queue merge needs the last released
  // one: a pull request merged by hand a minute after it is opened lands before producer runs
  // could fail, and the spent request would never be.
  spentProducer: 1, lostRuns: 2,
  // GY-756: a pull request somebody merges on GitHub by hand, a minute after it is opened, inside
  // a direct-merge window the operator opened for exactly that minute. The item is the last
  // released one, whose pull request stands unheard while it waits its turn: the minute it lands,
  // the flaky tip the queue holds for the rerun-fails item is what finds it landed and reconciles
  // it at once — and is itself rebuilt onto the moved base, so the failed rerun never costs that
  // item its rework round (the rerun-fails path itself is exercised by tests/tip-flake-rerun.test.ts).
  outOfQueue: { item: 15, afterMs: minute },
  // The control plane's held integration job, standing in three separate windows: three instances
  // of the `held-jobs` fault class inside the recurrence window, so the loop files the class's one
  // recurring item and the diagnostician diagnoses it (GY-439).
  heldJob: { at: [40, 80, 120].map(offset => offset * minute), forMs: 2 * minute },
  // GY-544: scope asked and answered between two cycles, and a live pane Herdr misreads for one cycle.
  // The scope overlay cannot ride item ten: an applied scope decision binds the approval baseline to
  // the attempt's first pull request (the requirement-review reset), and item ten's optimistic revert
  // reopens it onto a new pull request no approval can ever satisfy — items one and thirteen keep
  // their pull request across their rounds, so the overlay rides those.
  scoped: new Set([1, 4, 13]), scopeAfterMs: 6 * minute, misread: new Set([1, 10]), misreadAfterMs: 4 * minute,
  // A runtime that exits and leaves its pane open on a bare shell. Item eight's first attempt is
  // free to exit, its second carrying the slow-recompute head; item ten's first attempt is the one
  // that must break main, so the exit could not ride it.
  exits: new Set([8]), exitAfterMs: 12 * minute,
  // GY-453, the headless day: approver runs killed from outside, by item — the first four of item 5's
  // (one more than the loop gives back), and every one of item 9's.
  killedApprovers: new Map([[5, 4], [9, Number.POSITIVE_INFINITY]]),
  // GY-430: the item whose auto-merge GitHub keeps BLOCKED past master status's ten-minute bound
  // after Graphyard's gate passed; the main day sets it, so no other day waits on that merge.
  blockedMerge: 0,
  // GY-883: a review-rework item whose observation carries its real scope files — one module, so
  // it rides the low lane — and whose rework is therefore applied by the control plane as it is
  // requested, with no approver session. Its first application is refused by the engine once, so
  // the failed application is supervised and requested again before it applies. Items three and
  // seven keep riding high (their reworks are what the capacity and refusal days put to approvers).
  lowLane: 11,
};
/** GY-430: the main day's item whose auto-merge GitHub holds BLOCKED past the bound: one with no other merge-path fault. */
const blockedMergeItem = 6;
/** GY-711: the main day's item whose first attempt is fenced and blocked on a covered scope refusal: the fault-free one. */
const remedyItem = 2;
const file = (n: number) => `src/soak/item-${n}.ts`;
const files = (n: number) => basePlan.infrastructure.has(n) ? [file(n), `tests/helpers/soak-item-${n}.ts`] : [file(n)];
const fixture = (n: number) => `src/soak/item-${n}-fixture.ts`;
/** GY-845: the FOLLOW-UP findings one approval of item `n` names: one every approval repeats, one of its own. */
const followUpFindings = (n: number, review: number) => [{ path: file(n), text: `${file(n)} — the finding every approval of item ${n} repeats` }, { path: file(n), text: `${file(n)} — the finding approval ${review} names` }];

// ---------------------------------------------------------------------------
// The failover day (GY-417): the dispatch path is the real `dispatchWork` on a real master root,
// with one launch profile whose preferred account's OpenCode runtime never comes up. Everything the
// launcher reads outside Herdr is real — the credential homes, the account ledger beside the
// coordinator's credential file, the launch records — and Herdr is this world.
// ---------------------------------------------------------------------------

/** What one real dispatch recorded, sampled the way master status reads it between cycles. */
interface LaunchSample { key: string; failures: Awaited<ReturnType<typeof readAccountStartFailures>>; attention: Awaited<ReturnType<typeof workerLaunchStatus>> }
type Dispatched = Awaited<ReturnType<typeof dispatchWork>>;
/** The failover day's inputs and outputs, threaded through `simulateDay` and back to the test. */
interface Failover { root: string; master: MasterConfig; world: FailoverWorld; dispatches: Dispatched[]; samples: LaunchSample[] }

/**
 * The Herdr side of the failover day: the panes the real `dispatchWork` creates live in the same
 * SimulatedHerdr the loop reads. An account whose runtime is in `broken` draws the echoed launch
 * command for ever — the runtime never comes up, and the launcher closes its pane at the start
 * bound; any other account's runtime reports ready at once. `healthyEverywhere` ends the broken
 * run, so a later launch starts on the preferred account and clears its failure count.
 */
class FailoverWorld {
  /** The runtime kind of every `pane run`, in order: the launches the world actually served. */
  kinds: string[] = [];
  /** Panes of runtimes in the broken set that the launcher closed at the start bound. */
  closedBrokenPanes = 0;
  launched = 0;
  readonly herdr = new SimulatedHerdr(() => clock.now());
  private readonly typed = new Map<string, string>();
  private readonly kindsByPane = new Map<string, string>();
  private panes = 0;
  /** The launcher's own start clock: its waits at the start bound pass here, not on the day's. */
  now = clock.now();
  constructor(private broken: Set<string>) {}
  healthyEverywhere() { this.broken.clear(); }
  wait = (ms: number) => { this.now += ms; };
  bounds() { return { clock: () => this.now, wait: this.wait }; }
  run = (command: string, args: string[]): string => {
    if (command !== 'herdr') throw new Error(`Unexpected command ${command}`);
    const json = (result: unknown) => JSON.stringify({ result });
    const kind = (pane: string) => this.kindsByPane.get(pane);
    const healthy = (pane: string) => { const runtime = kind(pane); return !!runtime && !this.broken.has(runtime); };
    if (args[0] === 'tab' && args[1] === 'create') {
      const pane = this.herdr.open(`pending-${++this.panes}`, 'unknown');
      this.herdr.agents.get(pane)!.agent = null;
      return json({ root_pane: { pane_id: pane, tab_id: `wS:t${this.panes}` } });
    }
    if (args[0] === 'pane' && args[1] === 'run') {
      const runtime = expandTypedCommand(args[3]).kind;
      this.kindsByPane.set(args[2], runtime); this.typed.set(args[2], args[3]); this.kinds.push(runtime);
      return '';
    }
    if (args[0] === 'pane' && args[1] === 'read') return healthy(args[2]) ? `${kind(args[2])} ready\n` : `vish@host ~/code/project ❯ ${this.typed.get(args[2]) ?? ''}\n`;
    if (args[0] === 'pane' && args[1] === 'list') return json({ panes: this.herdr.paneList() });
    if (args[0] === 'pane' && args[1] === 'close') {
      if (kind(args[2]) && this.broken.has(kind(args[2])!)) this.closedBrokenPanes += 1;
      this.herdr.close(args[2]);
      return json({});
    }
    if (args[0] === 'agent' && args[1] === 'get') {
      if (!healthy(args[2])) return JSON.stringify({ error: { code: 'agent_not_found', message: `agent target ${args[2]} not found` } });
      // A runtime that came up is what Herdr now lists in the pane, as the loop reads it.
      const agent = this.herdr.agents.get(args[2]);
      if (agent) { agent.agent = kind(args[2])!; agent.agent_status = 'idle'; }
      return json({ agent: { pane_id: args[2], agent: kind(args[2]), agent_status: 'idle' } });
    }
    if (args[0] === 'agent' && args[1] === 'rename') { const agent = this.herdr.agents.get(args[2]); if (agent) agent.name = args[3]; return json({ agent }); }
    if (args[0] === 'agent' && args[1] === 'list') return json({ agents: this.herdr.list() });
    return json({});
  };
}

/** The failover day's coordinator: a real master root with an OpenCode and a Claude account logged in, and one launch profile naming them in that order. */
async function failoverInstalled() {
  const root = await temporaryDirectory('soak-master'), credentials = await temporaryDirectory('soak-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${repository}.git`], { cwd: root });
  const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository, baseBranch: 'main', githubAppId: 1234 }));
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'wS' }, coordinatorStatus as typeof fetch);
  const homes = await temporaryDirectory('soak-homes');
  const opencodeHome = join(homes, 'opencode-a');
  await mkdir(join(opencodeHome, 'opencode'), { recursive: true });
  await writeFile(join(opencodeHome, 'opencode/auth.json'), JSON.stringify({ 'zai-coding-plan': { type: 'api', key: 'k' } }), { mode: 0o600 });
  const claudeHome = join(homes, 'claude-b');
  await mkdir(claudeHome, { recursive: true });
  await writeFile(join(claudeHome, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'claude-b-token', refreshToken: 'r', expiresAt: Date.now() + 5 * 3_600_000, subscriptionType: 'max' } }), { mode: 0o600 });
  const credentialFile = join(credentials, 'worker.token');
  await writeFile(credentialFile, 'worker-token-'.padEnd(40, 'x'), { mode: 0o600 });
  const profile: WorkerProfile = { name: 'soak-failover', principal: 'worker-one', agentName: 'soak-worker-failover', mode: 'launch', kind: 'opencode', credentialFile, agentArgs: [], approvals: 'auto', environment: {}, accounts: ['opencode-a', 'claude-b'] };
  const base = await loadMasterConfig(root);
  // The day's loop configuration, on the coordinator's real credential and Herdr workspace, with the one launch profile.
  await atomicPrivateWrite(join(root, '.graphyard/master.json'), { ...soakConfig, url: base.url, credentialFile: base.credentialFile, herdrWorkspace: base.herdrWorkspace,
    environments: [{ name: 'opencode-a', kind: 'opencode', home: opencodeHome }, { name: 'claude-b', kind: 'claude', home: claudeHome }], workers: [profile] });
  return { root, master: await loadMasterConfig(root), profile };
}

/**
 * The diagnostician's answer, derived the way a read-only session would from the evidence the
 * prompt carries: the cause is the held integration job standing for the class, and the answer is
 * the newest open item listed as covering the cause. The payload goes through the options' own
 * validation, exactly as a real run's tool call does.
 */
function diagnosisRunner(seen: { subject: string }[]): Runner {
  return {
    name: 'soak-diagnostician',
    start<T>(prompt: string, options: RunOptions<T>) {
      const given = JSON.parse(prompt.slice(prompt.indexOf('{'))) as { subject: string; faultClass: string; instances: { at: string }[]; openItems: string[] };
      seen.push({ subject: given.subject });
      const open = given.openItems.map(line => /^GY-(\d+)/.exec(line)?.[1]).filter((key): key is string => !!key && `GY-${key}` !== given.subject);
      const payload = {
        subject: given.subject,
        cause: 'The integration job queue held the same sync job on a permission shortfall that clears on its own; the loop already tracks the class, so the newest open item covers the cause',
        evidence: {
          logLines: [`${given.instances.at(-1)?.at ?? 'unknown'} held-jobs on installation: 1 integration job(s) held on a permission shortfall`],
          commands: ['graphyard master status — the held-jobs line stood in three separate windows and was absent between them'],
        },
        faultClass: given.faultClass,
        covering: open.length ? `GY-${Math.max(...open.map(Number))}` : null,
        fix: null,
      };
      let result: RunResult<T>;
      try { const parsed = options.validate(payload); result = { ok: true, tool: options.tool, payload: parsed, payloads: [parsed] }; }
      catch (error) { result = { ok: false, failure: { reason: 'invalid-payload', detail: String(error) }, payloads: [] }; }
      return { id: `soak-diagnosis-${seen.length}`, events: [], onEvent: () => () => {}, cancel() {}, result: async () => result };
    },
  };
}

/**
 * GY-630: the scope-widening scenarios a day also carries when `scope` is set, as extra items
 * released beside the fifteen. Item `wideRule` asks a wide ask its criterion's own directory
 * implies: the rule approves it directly and folds it into one directory entry. Item `wideFinding`
 * asks a wide ask only a review finding grounds: the loop widens by posting the folded revision.
 * Item `unrepresentable` asks the one path no fold can represent under the plannedFiles cap: the
 * rule refuses it, nothing routes or retries it, and the item stays blocked with the escalation.
 */
const scopePlan = {
  wideRule: 16, wideFinding: 17, unrepresentable: 18,
  wideRuleDir: 'tests/soak-wide/', wideFindingDir: 'src/soak/extra-17/', unrepresentablePath: 'newtop-18/next.ts',
  wideRulePlanned: 20, wideRuleAsked: 90, wideFindingAsked: 100, unrepresentablePlanned: plannedFilesMax - 1,
};
const padded = (n: number) => String(n).padStart(3, '0');
/** Item `unrepresentable`'s planned files: plannedFilesMax entries, none in the asked path's directories. */
const bulk18 = [file(scopePlan.unrepresentable), ...Array.from({ length: scopePlan.unrepresentablePlanned }, (_, index) => `tests/bulk-18/bulk-${padded(index)}.test.ts`)];

/**
 * GY-888: the day's session launches are confined by the launcher's own logic, not asserted
 * beside it. Every dispatch and approver launch runs the real sessionConfinement against a
 * fixture coordinator checkout — the worker in a linked worktree under it, the approver from the
 * checkout itself, as each role really runs — and the same launch on a host that cannot build the
 * mount namespace is judged to be refused with the reason named, never started unconfined. A
 * change that drops the confinement from the per-cycle launch fails the soak, not only the unit
 * suite.
 */
let coordinatorBase: string | null = null, coordinatorRoot: string | null = null, soakLaunches = 0;
/**
 * Fixture worktrees the day's launches take in turn (GY-957, review follow-up): every `git worktree
 * add` scans each worktree already registered on the checkout, so one fresh worktree per launch made
 * the file's cost grow with the square of its launches — about twenty minutes on a runner — while
 * the confinement it exercises costs a millisecond. The pool is wider than the sessions a day keeps
 * open at once, and each launch still confines against a real linked worktree of the checkout.
 */
const soakWorktreePool = 16;
/** The session's own worktree: a linked worktree of the fixture checkout, as the launcher prepares them. */
function soakSessionDirectory(): string {
  const directory = join(coordinatorRoot!, '.graphyard', 'worktrees', `wt-${soakLaunches++ % soakWorktreePool}`);
  if (existsSync(directory)) return directory;
  mkdirSync(dirname(directory), { recursive: true });
  execFileSync('git', ['-C', coordinatorRoot!, 'worktree', 'add', '--detach', '--quiet', directory, 'HEAD'], { stdio: 'ignore' });
  return directory;
}

let pgServer: EmbeddedPostgres, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
before(async () => {
  // An offset no other test file takes: two files sharing a port fail in their `before` hook.
  const port = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + 404;
  pgServer = new EmbeddedPostgres({ databaseDir: await temporaryDirectory('soak'), user: 'graphyard', password: 'testing-only', port, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
  await pgServer.initialise(); await pgServer.start(); await pgServer.createDatabase('soak_test');
  const connection = `postgres://graphyard:testing-only@127.0.0.1:${port}/soak_test`;
  // The database reads the simulated clock: its time functions are shadowed before the schema exists.
  const setup = new pg.Client({ connectionString: connection });
  await setup.connect();
  for (const statement of clockSql) await setup.query(statement);
  await setup.query('ALTER DATABASE soak_test SET search_path = public, pg_catalog');
  await setup.end();
  clock.install(start);
  store = new Store(connection); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  engine.principals = everyone; engine.reviewerApps = reviewerApps; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  // The fixture coordinator checkout the simulated launches confine against (GY-888).
  coordinatorBase = await temporaryDirectory('soak-coordinator');
  coordinatorRoot = join(coordinatorBase, 'coordinator');
  const git = (...args: string[]) => execFileSync('git', ['-C', coordinatorRoot!, ...args], { stdio: 'ignore' });
  mkdirSync(join(coordinatorRoot, 'src'), { recursive: true });
  writeFileSync(join(coordinatorRoot, 'src', 'loop.ts'), 'export const loop = 1;\n');
  git('init', '-b', 'main');
  git('config', 'user.email', 'graphyard@localhost');
  git('config', 'user.name', 'Graphyard');
  git('add', '.');
  git('commit', '-m', 'coordinator');
});
after(async () => { clock.uninstall(); if (http) await new Promise<void>(resolve => http.close(() => resolve())); if (store) await store.close(); if (pgServer) await pgServer.stop(); });

const id = () => randomUUID();
async function api(principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown) {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': id() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status}): ${result?.error ?? JSON.stringify(result)}`);
  return result;
}

/**
 * One simulated day of the loop against this world. `regression` injects a fault into the loop's own
 * effects, standing for a change that breaks an invariant, so the soak shows it would fail.
 * `capacityWait` refuses every approver launch with `capacityExhausted` between `from` and `to`,
 * and records what waited, what was refused and what launched once the window closed (GY-849). `queued`
 * runs the day with the optimistic lane off, so every item goes through the merge queue under the
 * parallel-tip window (GY-498): `window` is the configured `mergeQueue.parallelTips`, `reconfigure`
 * rewrites master config mid-day the way an operator's edit does (the next cycle republishes it),
 * and `failTip` names the item whose first speculative tip fails and keeps failing after its rerun.
 * `stale` stages the GY-831 faults against two items, armed from the record the loop itself
 * produced: `stuck` is the item whose published tip GitHub answers with a head other than the
 * record's, so every guarded merge attempt refuses with one unchanged message, and `lostCarry` is
 * the item whose carried review GitHub stops holding once the tip's carry decision bound it, so the
 * re-post cannot use it.
 */
let days = 0;
async function simulateDay(options: { hours: number; master?: { exitAt: number; refuseRelease: { from: number; to: number }; sessionMinutes: number; heartbeatMinutes: number }; regression?: 'approvers-left-open'; headless?: boolean; handApprovers?: boolean; staleRework?: boolean; staleMerge?: number; capacityWait?: { from: number; to: number }; scope?: boolean; refuseReworkOf?: number[]; reassigned?: number | null; credentialBlocked?: { recovers: number; never: number }; queued?: { window: number; reconfigure?: { at: number; window: number }; failTip?: number; releaseEveryMs?: number }; stale?: { stuck: number; lostCarry: number }; protectedBranch?: boolean; docs?: { budget: { total: number; perPage: number } }; containment?: { failUntil: number; slowUntil: number }; followUps?: { parents: number[]; refused: number }; plan?: Partial<typeof basePlan>; github806?: boolean;
  /** GY-417: dispatch through the real `dispatchWork` on a real master root with a two-account launch profile. */
  failover?: Failover }) {
  const dayStart = clock.now();
  // A day may restage the shared scenario: the day-scoped view of the plan is what every fault
  // below arms from, while each test's own assertions still read the shared base plan.
  const plan = { ...basePlan, ...options.plan };
  const failover = options.failover;
  const config: MasterConfig = failover ? failover.master : options.queued
    ? masterConfigSchema.parse({ ...soakConfig, workers: [...workers, ...queueWorkers], mergeQueue: { optimistic: false, parallelTips: options.queued.window } })
    : options.master ? masterConfigSchema.parse({ ...soakConfig, run: { ...soakConfig.run, masterSessionMinutes: options.master.sessionMinutes, masterHeartbeatMinutes: options.master.heartbeatMinutes } })
    : soakConfig;
  if (options.stale) config.reviewer = { slug: 'graphyard-reviewer', appId: 77_001, installationId: 77_002, credentialFile: '/outside/reviewer.json', boundAt: new Date(dayStart).toISOString() };
  // The spent producer request (GY-496) is a main-day fault, like the blind window and the split:
  // the queue-only, hand-approver and regression days exercise their own faults and would only
  // inherit this one's rework round.
  const mainDay = !options.queued && !options.handApprovers && !options.regression && !options.scope && !options.headless;
  // The documentation day's world (GY-574): the project keeps the 12,000-word budget and its base
  // sits 15 words under it, within the 3% warning — so the loop's headroom step counts it, and the
  // queue tips whose entries grow the pages are what the day judges.
  const docs = options.docs && {
    budget: options.docs.budget,
    // README.md 1,195 words and ten pages of 1,079: 11,985 total. The project's CI fails its
    // docs-budget check when a commit's total is over 12,000, so each entry passes alone and the
    // combination on a tip is what overflows — the fault the queue's attribution answers.
    pages: { 'README.md': 1_195, ...Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map(letter => [`docs/${letter}.md`, 1_079])) } as Record<string, number>,
    // Entry 1 grows README.md by 10 words (its tip lands at exactly the budget), entries 2, 3 and
    // 4 each add a page of 10 words: every entry fits alone, and each combination with entry 1
    // landed is the first tip over the budget — the fault the queue's attribution answers.
    grow: (n: number): { page: string; words: number } | undefined =>
      n === 1 ? { page: 'README.md', words: 10 } : n <= 4 ? { page: `docs/grown-${n}.md`, words: 10 } : undefined,
    page: (n: number) => n === 1 ? 'README.md' : `docs/grown-${n}.md`,
  };
  const github = new SimulatedGitHub({ repository, baseBranch: 'main', appId: 1234, ciAppId: 15368, reviewerApps, ciMs: 5 * minute, reviewMs: 3 * minute, firstPullRequest: 100 * ++days, ...(docs ? { docs: { budget: docs.budget, pages: docs.pages } } : {}) },
    [...Array.from({ length: plan.items }, (_, index) => file(index + 1)), 'README.md']);
  const herdr = failover ? failover.world.herdr : new SimulatedHerdr(() => clock.now());
  // GY-453: approvers as headless Pi runs in the real run registry on disk, the loop restarting
  // (detaching every run) after every other cycle a run is live, and adopting them on the next.
  const headless = options.headless ? { pi: new SimulatedPi(), root: await temporaryDirectory('soak-runs'), applied: [] as string[], submitted: [] as string[],
    runs: new Map<string, number>(), launched: new Map<number, number>(), settling: new Map<string, Promise<RunRecord>>(), restarts: 0, adoptedLive: 0, adoptedEnded: 0 } : null;
  const adapter = github.adapter();
  // GY-883: the low-lane item's observation lists its changed files as scope files, the way the
  // real adapter reports them; every other item keeps the empty list, an unknown change, so it
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

  // ---- The fifteen items, created in the backlog and released one every fifteen minutes. ----
  const releaseEveryMs = options.queued?.releaseEveryMs ?? plan.releaseEveryMs;
  for (let n = 1; n <= plan.items + (options.scope ? 3 : 0); n++) {
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
    // A documentation day's item edits the page it grows, so the tip's docs change is its own
    // planned scope, and its policy requires the project's docs budget check (GY-574).
    const docsIntake = docs && n <= 4 ? {
      plannedFiles: [...files(n), docs.page(n)],
      policy: { checks: ['test', 'typecheck', 'unit:docs-word-budget'], review: true },
    } : {};
    let work = await engine.execute(principals.operator, 'create', null, { title: `Soak item ${n}`, plannedFiles: files(n), criteria: [{ id: 'AC-1', text: plan.scoped.has(n) ? `Item ${n} behaves, with its fixture ${fixture(n)}` : `Item ${n} behaves`, proofs: [PROOF] }], ...scopeIntake, ...docsIntake }, id());
    if (n === plan.exhaustedReviewer) work = await engine.execute(principals.operator, 'reviewpolicy', work.id, { provider: 'agent', expectedPolicyRevision: work.policyRevision, reason: 'Reviewed by the reviewer bots',
      reviewerProfiles: [{ name: 'claude-reviewer', runtime: 'claude', reviewerApp: 'claude-reviewer' }, { name: 'cursor-reviewer', runtime: 'cursor', reviewerApp: 'cursor-reviewer' }] }, id());
    items.push(work);
  }
  // ---- The backlog a previous day left (GY-842): panes of review sessions whose worktrees the
  // ---- reclaim removed while the panes stood on. Enough of them that the sweep's per-pass bound
  // ---- is what paces the drain, and one pane Graphyard never launched that it must never touch.
  // Pane ids are this simulated world's own, so two days on one control plane never collide.
  const world = `w${days}:`, leftovers = plan.leftovers, foreignPane = `${world}operator`;
  for (let index = 0; index < leftovers; index++) {
    const work = items[index], pane = `${world}left${index}`;
    herdr.shell(pane, `/tmp/soak/leftover-${index} (deleted)`);
    await api(principals.coordinator, 'POST', `work/${work.id}/session`, { id: `review-leftover-${index}`, kind: 'review', runtime: 'claude', host: 'soak-host',
      subject: `${work.key}: review (previous day)`, state: 'running', pane, attach: `herdr pane attach ${pane}` });
  }
  herdr.shell(foreignPane, '/home/vish');
  const numberOf = (work: Pick<Work, 'key'>) => items.findIndex(item => item.key === work.key) + 1;
  for (const n of plan.rework) github.verdicts.set(items[n - 1].key, ['CHANGES_REQUESTED']);
  if (plan.unstable) github.unstable.add(items[plan.unstable - 1].key);
  if (plan.slowRecompute) github.slowRecompute.add(items[plan.slowRecompute - 1].key);
  if (plan.blockedMerge) github.blockedMerge.add(items[plan.blockedMerge - 1].key);
  github.exhaustedProfiles.add('claude-reviewer');
  if (plan.flaky.rerunPasses) github.flaky.set(items[plan.flaky.rerunPasses - 1].key, 'rerun-passes');
  if (plan.flaky.rerunFails) github.flaky.set(items[plan.flaky.rerunFails - 1].key, 'rerun-fails');
  // GY-498: in the queue-only day one item's first tip fails and keeps failing after its rerun, so
  // the window has to attribute the failure to it and rebuild the tips behind it without it.
  if (options.queued?.failTip) github.flaky.set(items[options.queued.failTip - 1].key, 'rerun-fails');
  // GY-854: the entry ahead of the failing one passes but GitHub is slow to make it mergeable, so
  // the failing tip is ejected while that entry is still queued, unlanded, and the ejected tip holds
  // its commits; GitHub refuses every write of every restore of the failing entry's branch.
  if (options.queued?.failTip && options.protectedBranch) {
    github.slowMergeable.set(items[options.queued.failTip - 2].key, 45 * minute);
    github.refusedBranches.add(items[options.queued.failTip - 1].key);
  }
  // GY-854: GitHub refuses every write of every restore of the failing entry's branch.
  // GY-831: the lostCarry item's reviews are the bound reviewer App's own, whose approval a
  // Graphyard-authored tip carries — and whose review the day will take away once it is carried.
  if (options.stale) github.botReviewers.add(items[options.stale.lostCarry - 1].key);

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
  }
  // The unrepresentable ask's worker never pushes or submits: its item stays blocked on scope.
  const hold = new Set(options.scope ? [items[scopePlan.unrepresentable - 1].key] : []);

  // ---- Workers: the loop dispatches, the simulated session claims, works, pushes and submits (or dies). ----
  interface Session { work: string; key: string; branch: string; profile: WorkerProfile; epoch: number; attempt: number; pane: string; pushAt: number; diesAt: number | null; exitsAt: number | null; dispatchAt: number; state: 'working' | 'submitted' | 'dead' | 'exited' | 'idling' | 'reclaimed' | 'credential-blocked'; syncs: number; syncedFor?: string; refusedSince?: number;
    scopeAt: number | null; misreadAt: number | null; misread: boolean; credentialAt: number | null; settlementToken?: string }
  const sessions: Session[] = [], lost: string[] = [];
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
  const principalOf = (profile: WorkerProfile): Principal => ({ id: profile.principal, role: 'worker' });
  const dispatch: DaemonEffects['dispatch'] = failover ? async (work, profile, free, snapshot) => {
    // An earlier day's item still open in the shared store goes the simulated way: the day's own
    // five are what the real launch path and its ledger are judged on.
    if (!items.some(item => item.id === work.id)) return simulatedDispatch(work, profile, free, snapshot);
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
      scopeAt: null, misreadAt: null, misread: false, credentialAt: null });
    return { key: work.key, epoch, pane: result.pane!, agentName: profile.agentName };
  } : (work, profile, free, snapshot) => simulatedDispatch(work, profile, free, snapshot);
  async function simulatedDispatch(...[work, profile]: Parameters<DaemonEffects['dispatch']>) {
    const principal = principalOf(profile);
    const claimed = await engine.execute(principal, 'claim', work.id, {}, id());
    const epoch = claimed.epoch, key = work.key, n = numberOf(work);
    // A rework attempt pushes to the pull request already linked, from a fresh workspace: the
    // branch the standing submission's workspace used, which the engine demands a re-registered
    // workspace on a submitted item reuse — as when a submitted attempt's lease is reclaimed.
    const branch = work.candidate?.branch ?? work.workspaces.find(entry => entry.epoch === work.submission?.epoch)?.branch ?? `graphyard/${key.toLowerCase()}-${epoch}`;
    const path = `/tmp/soak/${key}-${epoch}`;
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
    // GY-711: the routine-remedy item's first attempt is launched under a containment fence, as a
    // supervised launch is, and a minute in it reports a scope refusal naming only its own planned
    // file — the blocker a widening already covers. Both remedies must then fire from the real cycle.
    if (mainDay && !options.containment && n === remedyItem && attempt === 1) {
      const settlementHash = createHash('sha256').update(`soak-settlement-${key}-${epoch}`).digest('hex');
      await engine.execute(principal, 'quarantine', work.id, { epoch, settlementHash }, id());
      await engine.execute(principal, 'launch', work.id, { epoch, settlementHash }, id());
      pending.push(async () => { await engine.execute(principal, 'blocked', work.id, { epoch, reason: `${scopeRefusalBlocker}: ${file(n)} is outside the attempt's plannedFiles` }, id()); });
    }
    // GY-852: the reassigned item's first session takes the lease and then sits at its prompt for
    // ever, as an idle worker does, so the loop's idle re-prompt and reclaim run against it.
    const idling = options.reassigned === n && attempt === 1;
    // GY-999: a session whose push is refused for want of a valid GitHub login blocks on it. The
    // recovering item's first two attempts do; the other item's every attempt does — a failure no
    // freshly minted credential cures, which the retry ladder must bound.
    const credentialBlocks = !!options.credentialBlocked && ((n === options.credentialBlocked.recovers && attempt <= 2) || n === options.credentialBlocked.never);
    const pane = herdr.open(profile.agentName, idling ? 'done' : 'working', path);
    sessions.push({ work: work.id, key, branch, profile, epoch, attempt, pane, pushAt: idling ? Number.MAX_SAFE_INTEGER : clock.now() + plan.workMs,
      diesAt: !options.capacityWait && !idling && plan.deaths.has(n) && attempt === 1 ? clock.now() + plan.deathAfterMs : null,
      exitsAt: !idling && plan.exits.has(n) && attempt === 1 ? clock.now() + plan.exitAfterMs : null, dispatchAt: clock.now(), state: idling ? 'idling' : 'working', syncs: 0,
      scopeAt: !idling && plan.scoped.has(n) && attempt === 1 ? clock.now() + plan.scopeAfterMs : null, misreadAt: !idling && plan.misread.has(n) && attempt === 1 ? clock.now() + plan.misreadAfterMs : null, misread: false,
      credentialAt: credentialBlocks ? clock.now() + 5 * minute : null, settlementToken });
    // A scope scenario asks the moment it holds the lease, as a worker does, and keeps working
    // while the control plane decides. An ask carries at most fifty paths, so a wide ask is
    // filed in batches, which one open request of the attempt merges.
    const ask = scopeAsks.get(key);
    for (let at = 0; ask && at < ask.length; at += 50)
      await engine.execute(principal, 'scope', work.id, { epoch, paths: ask.slice(at, at + 50), reason: `Item ${n}: the ${ask.length === 1 ? 'file' : 'files'} this change touches` }, id());
    // The pane is the session's own coordinate: the loop records it on the implementation handle.
    return { key, epoch, pane, agentName: profile.agentName };
  }
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
      const head = sha('head', session.key, session.epoch);
      if (numberOf(session) === plan.breaksMain && session.attempt === 1) github.breaking.add(head);
      const grown = docs?.grow(numberOf(session));
      const pr = github.push(session.key, session.branch, principal.id, head, grown ? [...files(numberOf(session)), grown.page] : files(numberOf(session)), grown);
      await engine.execute(principal, 'submit', session.work, { epoch: session.epoch, pr: pr.number, documentation: 'A simulated item: it changes no documented behaviour' }, id());
      session.state = 'submitted';
      await lowerFence(session);
      // Its work done, the runtime exits and leaves the pane behind (GY-842); the loop's session
      // end closes it in the same step, or the sweep reclaims it as the backstop.
      herdr.kill(session.pane);
    }
    // GY-839: a worker whose candidate was refused on landing does what that refusal asks —
    // graphyard sync, restore what the base changed, push again. Under a fault window long enough
    // for a worker to react, this is the worker round the false refusal costs; while GitHub answers
    // merge bases truly the landing comparison clears on its own and no worker is woken at all.
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
      if (now - since < 3 * minute) continue;
      session.syncs += 1; session.syncedFor = candidate; session.refusedSince = undefined;
      const syncedGrow = docs?.grow(numberOf(session));
      github.push(session.key, session.branch, principalOf(session.profile).id, sha('head', session.key, session.epoch, 'sync', session.syncs), syncedGrow ? [...files(numberOf(session)), syncedGrow.page] : files(numberOf(session)), syncedGrow);
    }
  };

  // ---- The session record and the prompts the loop gives sessions (GY-544). ----
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

  // ---- Approvers and producers: sessions the loop launches, each acting on the minute after. ----
  const pending: (() => Promise<void>)[] = [];
  const wakes: { key: string; at: number }[] = [];
  const approverPanes: string[] = [], approverWorks: string[] = [];
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
    if (herdr.list().some(agent => agent.name === name && !stoppedStates.includes(agent.agent_status ?? '')))
      throw new Error(`Approver session ${name} is already live in Herdr; let it finish or close it first`);
    if (options.capacityWait && clock.now() - dayStart >= options.capacityWait.from && clock.now() - dayStart < options.capacityWait.to) {
      capacityRefused.push({ decision, key: work.key, elapsed: clock.now() - dayStart });
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
    approverWorks.push(work.key);
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
    const pane = herdr.open(agentName);
    approverPanes.push(pane);
    pending.push(async () => {
      const current = (await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(work.id)}/decisions`)).decisions.find((entry: { id: string; state: string }) => entry.id === decision);
      // A session relaunched onto a decision judged while it was being launched finds the decision
      // applied and exits without judging: the judge itself refuses a second verdict, and the day
      // must not die on what a real session would simply see.
      if (!current || current.state !== 'requested') { herdr.status(pane, 'done'); return; }
      const refuseDue = !!options.refuseReworkOf?.includes(numberOf(work)) && !refused.some(entry => entry.key === work.key)
        && current.action === 'rework';
      if (refuseDue) {
        await api(principals.approver, 'POST', `work/${work.id}/approve`, { action: 'refuse', decision, reason: `Refused: ${work.key}'s rework rests on grounds this approver does not accept` });
        refused.push({ key: work.key, decision });
      } else {
        await api(principals.approver, 'POST', `work/${work.id}/approve`, { decision, reason: `Approved: the loop's routine ${decision} decision for ${work.key} rests on what it verified` });
      }
      herdr.status(pane, 'done');
    });
    return { agentName, pane };
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
  const requestProof: DaemonEffects['requestProof'] = work => {
    pending.push(async () => {
      const current = (await store.list()).find(item => item.id === work.id)!;
      if (!current.candidate || current.candidate.sha !== work.candidate?.sha || current.stage === 'done') return;
      // The trusted workflow publishes nothing for the spent head: only the dispatcher's producer runs stand for it.
      if (spentOn(current)) return;
      await engine.execute(principals.producer, 'evidence', current.id, { proof: PROOF, sha: current.candidate.sha, baseSha: current.candidate.baseSha, policyRevision: current.policyRevision, result: 'pass', executed: 4, skipped: 0,
        exercise: { criterion: 'AC-1', behaviour: `item ${numberOf(current)}'s change`, result: 'fail', executed: 1 } }, id());
    });
  };

  // ---- Production: two deploys, each a new control-plane build serving the base tip it was cut from. ----
  const production = { build: sha('build', 0), sha: github.tip, deploys: [] as { at: number; build: string; sha: string }[] };
  // GY-852: the reassigned day runs on a control plane the earlier days share, so its loop reads
  // only its own items: an earlier day's half-finished item (a rework decision nobody adopted)
  // would otherwise be dispatched, pushed and refused here for its linked pull request. The
  // containment day (GY-811) runs last and reads only its own items too, so its cycles do not pay
  // for every earlier day's delivered work; the failover day (GY-417) reads only its own as well.
  const ownItems = options.reassigned || options.headless || options.credentialBlocked || options.containment || failover ? new Set(items.map(item => item.id)) : null;
  const snapshot = async () => { const read = await store.coordinationSnapshot(); return { work: ownItems ? read.work.filter(item => ownItems.has(item.id)) : read.work, now: read.now, jobs: read.jobs }; };
  const transport = async (path: string, data: any, key: string = id()) => {
    const match = /^work\/([^/]+)\/merge-acquire$/.exec(path);
    if (!match) {
      // A carried approval the re-post could not use is reported by the guarded merge itself
      // (GY-831), through the same mutation path as the merge request.
      const stale = /^work\/([^/]+)\/mergerefused$/.exec(path);
      if (stale) return await engine.execute(principals.coordinator, 'mergerefused', stale[1], data, key);
      // The loop's own configuration publication (GY-330, GY-498, GY-500, GY-516) goes the same way.
      if (path === 'merge-queue') return await api(principals.coordinator, 'POST', 'merge-queue', data);
      throw new Error(`Unexpected mutation ${path}`);
    }
    try { return await engine.requestEnqueue(principals.coordinator, match[1], data, key); }
    catch (error) { if (error instanceof Refusal) throw Object.assign(new Error(JSON.stringify({ error: error.message })), { confirmedRefusal: error.status >= 400 && error.status < 500 }); throw error; }
  };
  // One executor instance for the loop's process, and a fresh request per merge the loop asks for, as `master run` wires it.
  const executor = { principal: principals.coordinator.id, instance: `soak-${randomUUID()}` };
  const merge: DaemonEffects['merge'] = work => mergeExecutor(config, snapshot, transport, executor, randomUUID(), github.gh(repository))(work);
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
  const refuseMerge: DaemonEffects['refuseMerge'] = (work, reason, since) => api(principals.coordinator, 'POST', `work/${work.id}/mergerefused`, { sha: work.candidate!.sha, baseSha: work.candidate!.baseSha, policyRevision: work.policyRevision, reason: reason.slice(0, 2000), since });
  // The diagnostician (GY-439), faked: its run answers from the evidence the prompt carries, and
  // its filing and deciding ride the same routes the production wiring uses, as the master's
  // operator-agent identity.
  const settings = diagnosticianSettings({ diagnostician: { invariantBoundMinutes: 30 } });
  const diagnosed: { subject: string }[] = [];
  const diagnostician: DiagnosticianEffects = {
    settings, cwd: '/tmp/soak/checkout',
    runner: async attempt => ({ runner: diagnosisRunner(diagnosed), runtime: `soak-${attempt}`, model: attempt === 'primary' ? settings.model : settings.fallbackModel }),
    context: async () => ({ journal: [`${new Date(clock.now()).toISOString()} graphyard-master: 1 integration job(s) held on a permission shortfall`], serverLog: [`${new Date(clock.now()).toISOString()} POST /api/status 200`], pullRequests: [] }),
    file: (input, key) => engine.execute(principals.operatorAgent, 'create', null, input, key),
    decide: (work, action, reason, input = {}) => api(principals.operatorAgent, 'POST', `work/${work.id}/decide`, { action, input: decisionInput(action, work, input), reason }),
  };
  // GY-711's routine remedies run from the real cycle: this host's containment probe (its
  // supervisor verified gone once the fence lapsed), the coordinator's autosettle — whose first
  // call the control plane fails transiently, so the reclaim step's settle fails and the doctor's
  // settle remedy is what lowers the fence — and the operator-agent unblock.
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
  const effects: DaemonEffects = {
    agents: () => headless ? withRunnerAgents(herdr.list()) as ReturnType<SimulatedHerdr['list']> : herdr.list(),
    herdr: () => ({ agents: headless ? withRunnerAgents(herdr.list()) as ReturnType<SimulatedHerdr['list']> : herdr.list(), available: true }),
    ...(headless ? { adoptRuns: () => adoptRuns(headless.root, { approver: async owner => ({ options: approverRunOptions('', String(owner.context.decision), {}, 30 * minute),
      apply: applyVerdict(String(owner.context.workId), String(owner.context.run)) }) }, { runner: headless.pi }) } : {}),
    panes: async () => ({ panes: herdr.paneList(), available: true }),
    recordSession,
    credentials: async profiles => Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null }])),
    snapshot, dispatch, requestProof, approver, merge, refuseMerge, doctor, containment, settleContainment, unblock,
    closeSession: pane => { if (options.regression === 'approvers-left-open' && /approver/.test(herdr.agents.get(pane)?.name ?? '')) return; herdr.close(pane); },
    decide: (work, action, reason, input = {}) => {
      const bound = decisionInput(action, work, input);
      decideCalls.push({ key: work.key, action, reason, input: bound });
      return api(principals.operatorAgent, 'POST', `work/${work.id}/decide`, { action, input: bound, reason });
    },
    decisions: work => api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(work.id)}/decisions`),
    withdraw: (work, decision, reason) => api(principals.operatorAgent, 'POST', `work/${work.id}/decide`, { action: 'withdraw', decision, reason }),
    faultClassPolicy: { threshold: 3, windowHours: 24 },
    fileFaultClass: (input, key) => {
      // The documentation trim item is what the once-only filing assertion reads (GY-574).
      if (input.title.startsWith(docsTrimTitle)) docsFilings.push(key);
      return engine.execute(principals.operatorAgent, 'create', null, input, key);
    },
    diagnostician,
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
      widenScope: (work: Work, request: ScopeRequestState, paths: string[], reason: string) =>
        api(principals.operatorAgent, 'POST', `work/${work.id}/requirements`, answeringWidening(work, request, paths, reason)),
    } : {}),
    controlPlane: async () => ({ build: { commit: production.build }, ...(heldJobs ? { heldJobs: 1 } : {}) }),
    observeDeployment: async delivered => {
      const serving = delivered.filter(item => github.contains(production.sha, item.delivery!.mergeSha));
      return { source: 'endpoint', sha: production.sha, at: new Date(clock.now()).toISOString(), reason: null, deployed: serving.map(item => item.key), pending: delivered.filter(item => !serving.includes(item)).map(item => item.key) };
    },
    recordDeployment: async () => {}, requestSmoke: () => {}, persist: async () => {},
    // A rework refused on a stale observation wakes the item's observation job (GY-710) through
    // the server's own resync endpoint, as `master run` wires it.
    wakeObservation: work => { wakes.push({ key: work.key, at: clock.now() }); return api(principals.coordinator, 'POST', `work/${work.id}/resync`, {}); },
    reclaimResources: (work, agents) => reclaimResources(reclaimRoot, { reviewers: [], producers: [] }, { work, agents }, { closePane: pane => { herdr.close(pane); }, tmpRoot, tmpPass }),
    // What the loop's reclaim path needs to end an attempt on the record (GY-852): the partial
    // work kept on its branch, and the capacity report that ends the lease in the same transaction.
    // They ride the reassigned and credential-blocked days alone, whose attempts are the ones the
    // loop ends; the other days' dead workers lapse as they always did.
    ...(options.reassigned || options.credentialBlocked ? {
      reportCapacity: async (work: Work, event: Record<string, unknown>) => api(principals.coordinator, 'POST', `work/${work.id}/capacity`, event),
      preserveWork: async (work: Work, epoch: number) => {
        const current = (await store.list()).find(item => item.id === work.id)!;
        const workspace = current.workspaces.find(entry => entry.epoch === epoch);
        return workspace ? { state: 'committed' as const, commit: sha('wip', work.key, epoch), branch: workspace.branch, detail: 'kept as WIP' } : { state: 'not-applicable' as const, detail: 'this world records no worktree' };
      },
    } : {}),
    promptSession,
    exhaustedProofs: async () => [...abandoned.values()],
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
  };
  if (options.master) {
    const plan = options.master, name = config.masterAgentName!;
    // Timed on the day's schedule position, as every other fault of the day is.
    const refusing = () => elapsed >= plan.refuseRelease.from && elapsed < plan.refuseRelease.to;
    effects.masterSession = { launch: async () => {
      const pane = herdr.open(name, 'idle'), session = `master-registry-${master.launches.length + 1}`;
      master.launches.push({ at: elapsed, pane, session });
      return { agentName: name, pane, runtime: 'claude', account: 'claude-master', session };
    } };
    effects.endRegistrySession = async session => {
      if (refusing()) { master.refusedEnds.push(session); throw new Error('the agent registry is unreachable: timeout'); }
      master.ended.push(session);
    };
    effects.holdAccount = async () => {};
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
    settled: [] as { key: string; epoch: number; elapsed: number }[], assessed: [] as { key: string; epoch: number; elapsed: number; refusals: string[] }[] };
  if (options.containment) {
    const phases = options.containment;
    const slowRead = async (ms: number) => { fenced.drift += ms; await moveClock(ms); };
    const read = effects.snapshot;
    effects.snapshot = async () => {
      await slowRead(3_000);
      const result = await read();
      await slowRead(3_000);
      // What this cycle's reclaim step will see: a quarantine that could settle (past its grace
      // window), one still in its grace window, only live ones, or none.
      const at = Date.parse(result.now), local = containmentQuarantines(result.work, config.hostId);
      if (local.some(item => containmentPhase(item, at)?.state === 'lapsed')) fenced.assessable.add(cycles);
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
      await api(principals.coordinator, 'POST', `work/${work.id}/autosettle`, { epoch: assessment.epoch, settlementHash: work.containmentQuarantine!.settlementHash,
        reason: `The soak loop verified on ${assessment.host} that the supervisor of epoch ${assessment.epoch} is gone`, verification: assessment.verification });
      fenced.settled.push({ key: work.key, epoch: assessment.epoch, elapsed });
    };
  }
  let publishedMergeQueue: string | null = null;
  const mergeQueuePosts: { at: number; settings: Record<string, number | boolean | readonly string[]> }[] = [];
  effects.publishMergeBatchSize = async () => {
    const settings = { batchSize: mergeBatchSize(config), optimistic: optimisticMergeEnabled(config), parallelTips: mergeParallelTips(config), rerunFailedChecks: rerunFailedChecks(config), optimisticExclude: optimisticExcludeGlobs(config) };
    const published = JSON.stringify(settings);
    if (published === publishedMergeQueue) return;
    mergeQueuePosts.push({ at: clock.now(), settings });
    await api(principals.coordinator, 'POST', 'merge-queue', settings);
    publishedMergeQueue = published;
  };

  // ---- The coordinator checkout the loop runs from, and its supervisor (GY-437). ----
  // A detached checkout of the base branch, at the tip the day starts on; git answers from the
  // simulated GitHub, and a restart of the fleet or of the loop itself is recorded, not performed.
  const checkout = { head: github.tip, origin: github.tip, dirty: false };
  const upgrades = { fetches: 0, checkouts: [] as { at: number; from: string; to: string }[], executors: [] as string[], self: 0, outcomes: [] as SelfUpgradeOutcome['outcome'][] };
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
    restartExecutors: async to => { upgrades.executors.push(to); return { result: 'restarted', reason: null, coordinator: { commit: to }, held: [], restarted: [], unsupervised: [], forgotten: [] }; },
    // The supervisor re-executes the loop: the next process loads the release the checkout holds, as runDaemon records it.
    restartSelf: async () => { upgrades.self++; state.release = { commit: checkout.head, dirty: checkout.dirty }; },
  });

  // ---- The day. ----
  let state = emptyDaemonState(config);
  /** The cursor's upgrade actions and the refusal's attempts, sampled every cycle the checkout stood refused. */
  const refusalSamples: { keys: number; attempts: number }[] = [];
  // Session launches run beside the cycle (GY-616): the loop carries one launcher across its
  // cycles, the way `runDaemon` does, and a launch settles in the interval after the cycle that
  // handed it over — here, before the simulated clock moves on.
  const launcher = new Launcher();
  const violations: string[] = [], observed = new Set<string>(), failures: string[] = [], escalations: string[] = [], spent = new Set<string>(), actionKeys = new Set<string>(), lanesSeen = new Set<string>();
  // Peers `processJob` reconciled from another item's landing check (GY-744), as `KEY merged|unmerged`.
  const reconciled: string[] = [];
  const reconcileLanded = engine.reconcileLanded;
  engine.reconcileLanded = async (...args) => {
    const saved = await reconcileLanded.apply(engine, args);
    reconciled.push(...saved.map(item => `${item.key} ${item.observation?.merged ? 'merged' : 'unmerged'}`));
    return saved;
  };
  let outside: { key: string; sha: string; at: number } | null = null;
  // GY-839: every false landing refusal the fault window produces, first seen per candidate head.
  const landingRefusals: { key: string; sha: string; elapsed: number }[] = [];
  // GY-430: every merge-stalled line master status would show, read after each cycle of the day
  // that sets `plan.blockedMerge`.
  const mergeStallSightings: { subject: string; text: string; at: number }[] = [];
  // GY-498: the parallel-tip window as the day saw it — how many entries held a published tip at
  // once, which successor tips were chained onto a predecessor's, and every tip per entry, so the
  // test can watch the window fill, a failure isolate its entry, and the suffix rebuild without it.
  const windowSamples: { at: number; concurrent: number; keys: string[] }[] = [];
  const tipPublications: { key: string; tip: string; at: number; position: number }[] = [];
  const chainedTips = new Set<string>();
  let peakWindow = 0;
  const seenTips = new Set<string>();
  let released = 0, split = false, noticed = false, deploys = 0, cycles = 0, reportedDispatches = 0, restarted = false, exitedRowsSeen = 0;
  // GY-574: the documentation day records the trim filings, the loop's trim actions, and when the
  // trim item was closed with the documentation still saturated, so the once-only filing and the
  // bounded action count are what the day itself observed.
  const docsFilings: string[] = [], docsActions: { state: string; detail: string }[] = [];
  let closedTrim = false;
  // GY-831: when each staged fault armed, and what the lost carry named, so the test can assert the
  // recovery against the exact candidate and review the faults were staged on.
  const stale: { stuckArmedAt: number | null; stuckHead: string | null; stuckReported: boolean; lostAt: number | null; carried: { reviewer: string; reviewId: number; originalSha: string } | null } =
    { stuckArmedAt: null, stuckHead: null, stuckReported: false, lostAt: null, carried: null };
  const releasedScope = new Set<number>();
  const restoreLines: string[] = [];
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
  // first `staleMerge` items to get there. When the loop is back the merge gate refuses its
  // observation as stale; the loop wakes the job and merges once that observation lands.
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
  // GY-845: the loop's follow-up steps, as reconcileReviews runs them every pass over the real
  // routes: each approval of a parent posts its FOLLOW-UP findings to the parent (one finding every
  // approval repeats, one of its own), and the ship step files each delivered parent's held
  // findings as its one follow-up item. One parent's ship is refused with an unchanged 4xx all day,
  // which must stop after repeatedClientErrorLimit attempts; one extra parent holds findings and is
  // closed without shipping. A follow-up item open while its parent has not shipped is a violation.
  const followUpDay = { approvals: new Map<string, number[]>(), ships: new Map<string, number>(), runs: {} as ShipRuns, events: [] as string[], closed: null as Work | null, early: [] as string[] };
  const followUpPost = async (key: string, body: unknown, idempotency: string) => {
    const response = await fetch(`${url}/api/work/${encodeURIComponent(key)}/followups`, { method: 'POST', headers: { Authorization: `Bearer ${token(principals.operatorAgent)}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotency }, body: JSON.stringify(body) });
    const result = await response.json() as any;
    if (!response.ok) throw new Error(`Graphyard refused the follow-ups of ${key} (${response.status}): ${result?.error ?? JSON.stringify(result)}`);
    return result;
  };
  const followUpShip: ShipFollowUps = async (parent, key) => {
    followUpDay.ships.set(parent, (followUpDay.ships.get(parent) ?? 0) + 1);
    if (options.followUps && parent === items[options.followUps.refused - 1].key) throw new Error(`Graphyard refused to file the held follow-ups of ${parent} (403): soak: this parent's filing is refused`);
    return { key: (await followUpPost(parent, { ship: true, reason: `${parent} shipped; its held review follow-ups become its follow-up item` }, key)).key };
  };
  async function followUpsTick() {
    if (!options.followUps) return;
    if (!followUpDay.closed) {
      const closed = await api(principals.operator, 'POST', 'work', { title: 'Soak follow-up parent closed unshipped', plannedFiles: ['src/soak/closed-parent.ts'], criteria: [{ id: 'AC-1', text: 'Never shipped', proofs: [PROOF] }] }) as Work;
      await followUpPost(closed.key, { findings: followUpFindings(0, 0), reason: 'soak: an approval of a parent that will close unshipped', parent: true }, id());
      await api(principals.operator, 'POST', `work/${closed.key}/close`, { kind: 'obsolete', reason: 'soak: the parent closes without shipping' });
      followUpDay.closed = closed;
    }
    for (const pr of github.prs.values()) {
      const n = numberOf(pr);
      if (!options.followUps.parents.includes(n)) continue;
      const seen = followUpDay.approvals.get(pr.key) ?? [];
      for (const review of pr.reviews.filter(entry => entry.state === 'APPROVED' && !seen.includes(entry.id))) {
        seen.push(review.id); followUpDay.approvals.set(pr.key, seen);
        await followUpPost(pr.key, { findings: followUpFindings(n, review.id), reason: `soak: approval ${review.id} of ${pr.key}`, parent: true }, `followups:${review.id}`);
      }
    }
    // One listing per pass, read again only when a ship changed something: the store carries every
    // earlier day's items, so a listing per step slowed this day past its bound.
    let all = await store.list();
    const shipped = await shipHeldFollowUps(all, followUpShip, followUpDay.runs, new Date(clock.now()));
    followUpDay.events.push(...shipped);
    if (shipped.length) all = await store.list();
    for (const item of all) {
      const parent = followUpParent(item), of = parent && all.find(entry => entry.key === parent);
      if (of && !isClosed(item) && item.stage !== 'done' && !hasShipped(of)) followUpDay.early.push(`${item.key} is open while its parent ${parent} has not shipped (${of.stage})`);
    }
  }
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
  const jobsDue = async () => Number((await store.pool.query('SELECT count(*) AS due FROM jobs WHERE available_at<=now() AND (held_until IS NULL OR held_until<=now()) AND (locked_until IS NULL OR locked_until<now())')).rows[0].due);
  // The day's schedule position, hoisted so the launch effects record against it: one cycle is one
  // simulated minute, and a launch the cycle handed over settles before the position advances.
  let elapsed = 0;
  for (; elapsed <= options.hours * hour;) {
    const now = clock.now();
    // Scheduled events: releases, the file split on main, the deploys. The queue-only day runs with
    // the split past its end: the re-plan and its stale-tip flush are the main day's scenario, and
    // a queue of tips built before the split only ejects in a cascade the day cannot recover from.
    while (released < plan.items && elapsed >= released * releaseEveryMs) await engine.execute(principals.operator, 'ready', items[released++].id, {}, id());
    // The scope scenarios release beside the fifteen: the wide asks early enough to decide well
    // before their workers push, the unrepresentable one so its refusal stands for hours.
    for (const [slot, n] of [[30, scopePlan.wideRule], [35, scopePlan.wideFinding], [40, scopePlan.unrepresentable]] as const)
      if (options.scope && !releasedScope.has(n) && elapsed >= slot * minute) { await engine.execute(principals.operator, 'ready', items[n - 1].id, {}, id()); releasedScope.add(n); }
    const splitAt = options.queued ? options.hours * hour + hour : plan.split.at;
    if (!split && elapsed >= splitAt) {
      split = true;
      const from = file(plan.split.item), successors = [`src/soak/item-${plan.split.item}-a.ts`, `src/soak/item-${plan.split.item}-b.ts`];
      const commit = github.commit(`Split ${from}\n\nGraphyard-Successor: ${from} -> ${successors.join(', ')}`, [...github.files.filter(path => path !== from), ...successors]);
      github.successions.push(...successors.map(to => ({ from, to, commit: commit.sha, similarity: 70 })));
    }
    if (elapsed > 0 && elapsed % hour === 0 && elapsed < options.hours * hour) hourly.push({ directory: await leftover(`graphyard-hour-${elapsed / hour}`, 0), at: elapsed });
    // GY-839: while the window stands, GitHub answers every open candidate's compares without a
    // usable merge base; afterwards its answers carry the true one again. The queue-only day runs
    // with the window past its end: its fault is the bound candidates' recovery, which the main
    // day exercises, and a queue full of false landing refusals would only churn sync rounds.
    const blind = options.queued ? { from: options.hours * hour + hour, to: options.hours * hour + 2 * hour } : plan.blind;
    github.staleMergeBase = elapsed >= blind.from && elapsed < blind.to
      ? new Set([...github.prs.values()].filter(pr => pr.open).map(pr => pr.head)) : new Set<string>();
    // A change landed on main outside Graphyard, moving the base under candidates already pushed.
    if (!noticed && elapsed >= plan.notice) { noticed = true; github.commit('Add NOTICE to the base branch', [...github.files, 'NOTICE']); }
    // GY-574: an hour in, the filed trim item is closed and its trim lands on the base branch —
    // the README gives back the words, as the trim item's own criterion delivers — with the set
    // still inside the 3% warning, so the filing episode stays open and files nothing more. The
    // closing comes after the crossing tip has been judged, so the day observes both halves.
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
    await workersTick(now);
    await producersTick(now);
    // GY-756: the out-of-queue merge. Git shows it landed at once; its item records it unlanded
    // until an observation — its own, or another candidate's landing check — reconciles it.
    // The queue-only day runs without it: a tip the window published is not merged by hand.
    const byHand = options.queued ? undefined : [...github.prs.values()].find(pr => pr.key === items[plan.outOfQueue.item - 1].key && pr.open);
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
      // GY-845: the follow-up steps run once the approvers have judged, never between the cycle that
      // requested a decision and its approval: a held finding moves the parent's revision, so a
      // release, unblock or unpinned resolve bound to the earlier revision would be refused as raced.
      await followUpsTick();
      await engine.reconcile();
      await busyFleet(now);
      // GY-806: CI's check_run webhooks, delivered as the route delivers them. The pass claims every
      // webhook-woken job that is due before any polled one, and re-observes each within the minute.
      // Only the day that asserts them runs them (`github806`): every other scenario keeps main's pass.
      if (options.github806) for (const delivery of github.completedChecks(now)) webhook.deliveries += (await wakeFromWebhook(store.pool, { all: false, prs: [delivery.pr], shas: [delivery.sha], branches: [] }, true)).length;
      const dueNow = await due(), woken = (await store.webhookDue()).filter(id => dueNow.has(id));
      let claims = 0;
      for (let guard = 0; guard < 200 && await jobsDue(); guard++) {
        await processJob(engine, adapter);
        if (woken.length && ++claims === woken.length) {
          const left = new Set(await store.webhookDue());
          for (const id of woken) if (left.has(id)) webhook.late.push(`+${Math.round(elapsed / minute)} min ${items.find(item => item.id === id)?.key ?? id}`);
        }
      }
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
      // GY-831: arm the staged faults once, from the record the loop itself produced. The stuck
      // item's fault holds only the published tip it was armed on — a rework round's new head is
      // never armed, so the round the rework decision asks for is what lands. The lostCarry item's
      // fault takes the carried review away once the tip's carry decision has bound it and before
      // the tip's own CI finished, so the first guarded merge attempt finds nothing to re-post.
      if (options.stale) for (const item of await store.list()) {
        const speculation = item.queue?.speculation, candidate = item.candidate;
        if (!speculation || !candidate || speculation.tip !== candidate.sha) continue;
        // The queue may re-publish the tip before the loop's first refusal lands, so the fault
        // re-arms on each published tip of the item until the record holds a refusal for the
        // candidate — after that the fault is spent: the rework round's head is never armed.
        if (options.stale.stuck === numberOf(item) && !stale.stuckReported) {
          if (item.mergeRefusal?.sha === candidate.sha) stale.stuckReported = true;
          else if (speculation.tip === candidate.sha) {
            github.stuckHeads.add(candidate.sha);
            stale.stuckHead = candidate.sha;
            stale.stuckArmedAt ??= clock.now();
          }
        }
        // The bound App's review is taken away once the tip's carry decision has bound it, so the
        // re-post cannot use it and reports it at once. From then on the item's further reviews
        // come from the ordinary reviewer identity, so no later approval re-binds the carry to a
        // review the re-post could try to mint against.
        if (options.stale.lostCarry === numberOf(item) && !stale.lostAt && speculation.carry?.approval.carried && typeof (speculation.carry.approval as { reviewId?: unknown }).reviewId === 'number') {
          const carried = speculation.carry.approval as { reviewer: string; reviewId: number; originalSha: string };
          const prRow = github.prs.get(candidate.pr)!;
          if (prRow.reviews.some(review => review.id === carried.reviewId)) {
            stale.lostAt = clock.now(); stale.carried = carried;
            prRow.reviews = prRow.reviews.filter(review => review.id !== carried.reviewId);
            github.botReviewers.delete(item.key);
          }
        }
      }
      // GY-854: what master status says of the failing entry's branch while a restore is owed on it.
      if (options.protectedBranch) {
        const key = items[options.queued!.failTip! - 1].key;
        const line = branchReport(buildMasterStatus(await store.workSnapshot(), [], []).work).contaminated.find(entry => entry.key === key)?.line;
        if (line && restoreLines.at(-1) !== line) restoreLines.push(line);
      }
      // GY-498: sample the window after the pass's publications, then apply a mid-day master-config
      // edit, which the cycle about to run publishes the way an operator's edit is published.
      if (options.queued) {
        const all = await store.list();
        const tipped = all.filter(item => item.stage !== 'done' && item.queue?.speculation && item.candidate
          && item.queue.speculation.tip === item.candidate.sha && item.queue.speculation.base === item.candidate.baseSha);
        if (tipped.length >= 2) {
          windowSamples.push({ at: elapsed, concurrent: tipped.length, keys: tipped.map(item => item.key) });
          for (const ahead of tipped) for (const behind of tipped) {
            if (ahead.key !== behind.key && github.contains(behind.queue!.speculation!.tip, ahead.queue!.speculation!.tip)) chainedTips.add(`${ahead.key}->${behind.key}`);
          }
        }
        for (const item of tipped) {
          if (seenTips.has(`${item.key}:${item.queue!.speculation!.tip}`)) continue;
          seenTips.add(`${item.key}:${item.queue!.speculation!.tip}`);
          const placement = queuePlacement(item, all.map(entry => entry.id === item.id ? item : entry), clock.now());
          tipPublications.push({ key: item.key, tip: item.queue!.speculation!.tip, at: elapsed, position: placement?.position ?? -1 });
        }
        if (options.queued.reconfigure && elapsed >= options.queued.reconfigure.at) {
          config.mergeQueue!.parallelTips = options.queued.reconfigure.window;
        }
        peakWindow = Math.max(peakWindow, tipped.length);
      }
      // GY-849: what still waited for capacity when the window closed, each with its request's age.
      if (options.capacityWait && !capacityWaiters && elapsed >= options.capacityWait.to)
        capacityWaiters = Object.values(state.approvals).filter(watch => watch.capacity).map(watch => ({ decision: watch.decision, key: watch.work, requestedAt: watch.requestedAt }));
      // GY-898: the master session is killed mid-day, inside the window the registry refuses to end sessions.
      if (options.master && !master.killed && elapsed >= options.master.exitAt) {
        const live = herdr.byName(config.masterAgentName!);
        if (live?.pane_id) { herdr.kill(live.pane_id); master.killed = live.pane_id; }
      }
      if (options.staleRework && await restartOnVerdict(now)) { elapsed += minute; await moveClock(minute); continue; }
      if (options.staleMerge && await restartOnMerge(now)) { elapsed += minute; await moveClock(minute); continue; }
      master.cycleOf = cycles;
      try {
        if (headless) for (const run of await adoptHeadlessRuns(state, effects, () => {}, 'cycle')) {
          headless.settling.set(run.directory, run.settled);
          if (headless.pi.processes.get(run.directory)!.state === 'live') { headless.adoptedLive++; continue; }
          // An adopted run that already ended is applied on adoption, before the cycle judges its decision.
          headless.adoptedEnded++; await run.settled; headless.settling.delete(run.directory); await new Promise(resolve => setImmediate(resolve));
        }
        const result = await runCycle(config, state, effects, clock.now, launcher); cycles++;
        reportedDispatches += result.actions.filter(action => action.kind === 'dispatch' && action.state === 'done').length;
        escalations.push(...result.actions.filter(action => action.kind === 'escalation').map(action => action.detail));
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
      // Between cycles, as runDaemon runs it: the self-upgrade against the simulated checkout.
      checkout.dirty = elapsed >= plan.dirtyCheckout.from && elapsed < plan.dirtyCheckout.to;
      const upgraded = await selfUpgrade(state);
      upgrades.outcomes.push(upgraded.outcome);
      if (upgraded.outcome === 'failed') failures.push(`${new Date(now).toISOString()}: self-upgrade failed: ${upgraded.reason}`);
      if (upgraded.outcome === 'refused') refusalSamples.push({ keys: Object.keys(state.actions).filter(key => key.startsWith('upgrade:')).length, attempts: state.actions['upgrade:refused']?.attempts ?? 0 });
      // The loop restarts after every other cycle a run is live, once its launches have settled as
      // `runDaemon` lets them: it signals none, and the next cycle adopts them.
      if (headless && cycles % 2 && headless.pi.live()) { detachRuns(); headless.settling.clear(); headless.restarts++; }
      for (const check of state.invariants.report as InvariantCheck[]) {
        if (check.observed) observed.add(check.invariant);
        if (!check.holds) violations.push(`${new Date(now).toISOString()} (+${Math.round(elapsed / minute)} min) ${check.line}`);
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
  // The documentation day ends with its crossing entries held by the budget (GY-574): they are
  // closed here, so the day's undelivered work is not a later day's loop's to dispatch and judge.
  if (docs) {
    await moveClock(5 * minute);
    for (const leftover of await store.list()) {
      if (leftover.stage === 'done' || leftover.closure) continue;
      await api(principals.operator, 'POST', `work/${leftover.key}/close`, { kind: 'obsolete', reason: 'soak: the documentation day ends with its crossing entries held; a later day runs its own scenario' });
    }
  }

  // The credential-blocked day ends with its never-curing item held at the cap: it is closed here,
  // so a later day's loop never dispatches it.
  if (options.credentialBlocked) {
    for (const leftover of await store.list()) {
      if (!items.some(entry => entry.id === leftover.id) || leftover.stage === 'done' || leftover.closure) continue;
      await api(principals.operator, 'POST', `work/${leftover.key}/close`, { kind: 'obsolete', reason: 'soak: the credential-blocked day ends with its never-curing item held at the attempt cap' });
    }
  }
  engine.reconcileLanded = reconcileLanded; engine.directMergeEnvironment = null;
  const final = (await store.list()).filter(item => items.some(entry => entry.id === item.id));
  await settleTmpReclaim(); await holder.close();
  const tmp = { root: tmpRoot, backlog, deadOwned, cache, heldDirectory, liveOwned, hourly, passes: tmpPasses, peak: tmpPeak, reports: await readReclaimReports(reclaimRoot), left: readdirSync(tmpRoot) };
  if (process.env.SOAK_TRACE) console.error(`landing: ${github.landingChecks} checks over ${github.landingBases.size} bases, ${github.ancestorCompares} ancestor compares, ${github.blindCompares} blind compares; false landing refusals: ${landingRefusals.map(entry => `${entry.key}@+${Math.round(entry.elapsed / minute)}min ${entry.sha.slice(0, 12)}`).join(', ') || 'none'}`);
  engine.execute = executeAll;
  return { reconciled, outside, items, final, github, sessions, lost, violations, observed, failures, production, cycles, reportedDispatches, state, dayStart, tmp, headless, herdr, hand, escalations, spent, producerRuns, abandoned, spentHead, actionKeys, upgrades, refusalSamples, checkout, landingRefusals, foreignPane,
    mergeQueuePosts, windowSamples, tipPublications, chainedTips, peakWindow, config, refused, decideCalls, restarted, stale, approverPanes, herdrClosed: herdr.closed, diagnosisModel: settings.model, capacityRefused, capacityLaunched, capacityWaiters,
    decided, misreads, prompts, exitedLive, exitedClosed, exitedRowsSeen, reassign, docsFilings, docsActions, closedTrim, confined, unconfinedRefusals, fenced, mergeStallSightings, restoreLines, master, followUpDay, lanesSeen, laneApplications, approverWorks, failover, webhook, remedies, immutable: { ...immutable, bound: immutableBound, distinct: immutableSends.size },
    wakes, staleMerges, restartLog };
}

/**
 * GY-888: every session launch the day made ran the launcher's real confinement — a worker in its
 * linked worktree, an approver from the checkout itself, a headless producer run wrapped at its
 * spawn — and the same launch on a host that cannot build the mount namespace was refused with
 * the reason named, never started unconfined. Nothing that keeps the checkout authoritative — its
 * tree, its index, the refs only the guarded merge moves — is re-exposed writable.
 */
function assertLaunchesConfined(day: { confined: { role: string; key: string; directory: string; mechanism: string; reexposed: readonly string[] }[]; unconfinedRefusals: string[]; sessions: unknown[]; producerRuns: unknown[] }, root: string) {
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

test('unit:soak-invariants-hold — a simulated day of the real loop: fifteen items delivered and every system invariant holding after every cycle', { timeout: 360_000 }, async () => {
  const began = performance.now();
  const hours = Number(process.env.SOAK_HOURS ?? 24);
  const day = await simulateDay({ hours, github806: true, plan: { blockedMerge: blockedMergeItem } });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { reconciled, outside, items, final, github, sessions, lost, violations, observed, failures, production, cycles, reportedDispatches, dayStart, tmp, state, producerRuns, abandoned, spentHead, actionKeys, upgrades, refusalSamples, checkout, herdr, landingRefusals, foreignPane, mergeQueuePosts, approverPanes, herdrClosed, diagnosisModel, decided, misreads, prompts, exitedLive, exitedClosed, exitedRowsSeen, lanesSeen, laneApplications, approverWorks } = day;
  const undelivered = final.filter(item => item.stage !== 'done' || !item.delivery);
  assert.deepEqual(undelivered.map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all fifteen items are delivered');
  // GY-1060: every item merged under protection requiring `secrets` beside the policy's checks, so
  // the union gate, the batch verdicts and the window view read a protection-only check all day.
  // A final observation taken before CI reported on its head carries no runs and is not judged.
  assert.ok(final.every(item => item.observation?.requiredChecks?.some(check => check.name === protectionOnlyCheck && check.appId === null)
    && (!item.observation.checks.length || item.observation.checks.some(run => run.name === protectionOnlyCheck && run.result === 'success')))
    && final.filter(item => item.observation!.checks.length).length >= basePlan.items - 1, `every delivery passed the protection-only ${protectionOnlyCheck} check`);
  assert.ok(final.every(item => item.observation?.requiredChecks?.some(check => check.name === statusContext && check.appId === null)
    && (!item.observation.checks.length || item.observation.checks.some(run => run.name === statusContext && run.source === 'status' && run.result === 'success'))),
    `every delivery passed the status-sourced ${statusContext} context`);
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease: a dead worker lapses, it is not refused');
  assert.deepEqual([...observed].sort(), [...systemInvariants].sort(), 'every invariant was observed, not merely left unread');
  // GY-806: webhooks drove observation all day — every woken job claimed ahead of the polled ones
  // and re-observed within the minute of its delivery, and no poll skipped outside a refresh.
  const { webhook } = day;
  assert.ok(webhook.deliveries >= basePlan.items && webhook.woken >= basePlan.items, `check_run webhooks woke the items: ${JSON.stringify(webhook)}`);
  assert.deepEqual(webhook.late, [], 'every webhook-woken job was claimed before any polled job of its pass');
  assert.deepEqual(webhook.unobserved, [], 'every webhook-woken item was re-observed within the minute of its delivery');
  assert.ok(webhook.refreshes > 0, 'webhook-driven observations recorded their refresh on the job');
  assert.equal(webhook.skipped, 0, 'no poll was skipped past the refresh that justified it');
  // GY-806: the immutable cache, run through the real adapter all day, stayed within its bound while every
  // path still read was fetched once; the day produced more distinct paths than the bound holds, so it aged out.
  const { immutable } = day;
  assert.ok(immutable.cycles > 0 && immutable.reads > 0, `the immutable path ran every cycle: ${JSON.stringify(immutable)}`);
  assert.ok(immutable.distinct > immutable.bound.rows, `the day asked more distinct paths (${immutable.distinct}) than the bound holds (${immutable.bound.rows})`);
  assert.ok(immutable.peakLive <= immutable.bound.rows, `the bound holds every path still read (${immutable.peakLive})`);
  assert.deepEqual(immutable.overBound, [], 'immutable rows and bytes stayed within their bound every cycle');
  assert.deepEqual(immutable.refetched, [], 'no path still read was asked of GitHub twice');
  if (process.env.SOAK_TRACE) console.error(`immutable: ${JSON.stringify(immutable)}`);
  assert.ok(lanesSeen.size > 0, 'the day\'s items were evaluated into risk lanes, each checked against its change and its status row every cycle');
  // GY-883: the low-lane item's rework round ran with no approver session. Its first application
  // was refused, recorded failed and requested again on the retry interval; the second applied it,
  // with the lane as its ground, and its watch settled once — no decision was left supervised.
  const lowItem = final.find(item => item.key === items[basePlan.lowLane - 1].key)!;
  assert.ok(lanesSeen.has('low') && lanesSeen.has('high'), `the day rode both the low and the high lane: ${[...lanesSeen].join(', ')}`);
  assert.equal(lowItem.lane, 'low', 'the item whose observation names its one module rides low');
  assert.equal(lowItem.pipeline?.reworkRounds, 1, 'its review verdict cost it one rework round');
  assert.deepEqual(approverWorks.filter(key => key === lowItem.key), [], 'no approver session was launched for the low-lane item');
  assert.deepEqual(laneApplications.map(entry => entry.refused), [true, false], 'the lane applied its rework twice: refused once, then applied');
  const laneReworks = ((await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(lowItem.id)}/decisions`)).decisions as { action: string; state: string; approvedBy?: string | null }[]).filter(entry => entry.action === 'rework');
  assert.deepEqual(laneReworks.map(entry => entry.state), ['failed', 'applied'], `one failed application, then one applied: ${JSON.stringify(laneReworks)}`);
  assert.equal(laneReworks[1].approvedBy, laneApprover, 'the applied rework names the risk lane as its approver');
  const laneRecords = Object.values(state.actions).filter(entry => entry.work === lowItem.key && entry.kind === 'decision' && /its risk lane needs no approver/.test(entry.detail));
  assert.deepEqual(laneRecords.map(entry => [entry.state, entry.attempts]), [['done', 2]], `the loop requested it twice under one action, the second time applied: ${JSON.stringify(laneRecords.map(entry => entry.detail))}`);
  assert.ok(laneApplications[1].at - laneApplications[0].at >= minute, 'the failed application was requested again on a later cycle, not inside the one that failed');
  const laneWatches = Object.values(state.approvals).filter(watch => watch.work === lowItem.key);
  assert.ok(laneWatches.every(watch => watch.settledAt && !watch.agentName && watch.launches === 0), `its decision watch settled with no session launched, and none is left supervised: ${JSON.stringify(laneWatches)}`);
  // The day held what it was meant to: a merge about every fifteen minutes, the rework rounds, the deaths,
  // the deploys, the split, both merge states, auto-merge, and the failover.
  // One item broke main after its optimistic merge and was reverted and reopened, so it merged twice.
  assert.equal(github.merges.length, basePlan.items + 1, 'fifteen items merged, one of them twice');
  const gaps = github.merges.slice(1).map((entry, index) => entry.at - github.merges[index].at).sort((a, b) => a - b);
  assert.ok(Math.abs(gaps[Math.floor(gaps.length / 2)] - 15 * minute) <= 5 * minute, `a merge about every fifteen minutes: ${github.merges.map(entry => `${entry.key} +${Math.round((entry.at - dayStart) / minute)} min`).join(', ')}`);
  assert.ok(github.merges.some(entry => entry.key === items[basePlan.clean - 1].key && entry.state === 'CLEAN' && entry.mode === 'immediate'), `a CLEAN pull request merged at once: ${JSON.stringify(github.merges)}`);
  assert.ok(github.merges.some(entry => entry.key === items[basePlan.unstable - 1].key && entry.state === 'UNSTABLE' && entry.mode === 'immediate'), 'an UNSTABLE pull request merged at once');
  assert.ok(github.merges.some(entry => entry.key === items[basePlan.slowRecompute - 1].key && entry.mode === 'auto-merge'), 'one GitHub reported BLOCKED when asked was set to auto-merge, and GitHub merged it once it recomputed');
  // GY-430: the auto-merge GitHub held BLOCKED past ten minutes was named by master status on every
  // cycle past the bound and on none after it merged; the six-minute recompute never was, and the
  // line is derived per read, one per item, so nothing about it accumulates over the day.
  const blockedKey = items[blockedMergeItem - 1].key, blockedLanding = github.merges.find(entry => entry.key === blockedKey);
  assert.equal(blockedLanding?.mode, 'auto-merge', `${blockedKey} was set to auto-merge while GitHub reported it BLOCKED: ${JSON.stringify(blockedLanding)}`);
  const blockedSightings = day.mergeStallSightings.filter(line => line.subject === blockedKey);
  assert.ok(blockedSightings.length >= Math.floor((blockedMergeMs - 10 * minute) / minute) - 1, `master status named ${blockedKey}'s BLOCKED auto-merge while it stood past ten minutes: ${blockedSightings.length} sighting(s)`);
  for (const line of blockedSightings) {
    assert.match(line.text, new RegExp(`^merge-stalled: ${blockedKey} pull request #\\d+ at [0-9a-f]{12} has been set to auto-merge for (\\d+) minutes .* while GitHub reports mergeStateStatus BLOCKED: .+`), line.text);
    assert.ok(Number(/for (\d+) minutes/.exec(line.text)![1]) >= 10 && line.at < blockedLanding!.at, `only past the bound and before the merge: ${line.text}`);
  }
  assert.equal(new Set(blockedSightings.map(line => line.at)).size, blockedSightings.length, 'one line per read, never repeated within one');
  assert.deepEqual(day.mergeStallSightings.filter(line => line.subject !== blockedKey).map(line => line.text), [], 'no other merge stood stalled; the six-minute recompute stayed under the bound');
  // GY-516's rerun-fails round is absent from that total by design: the out-of-queue merge (GY-756)
  // moves the base under the flaky tip while its failed rerun stands, and the queue rebuilds the
  // tip, so the round is superseded rather than skipped — the path itself is exercised, with its
  // rework, by tests/tip-flake-rerun.test.ts.
  assert.equal(final.reduce((total, item) => total + (item.pipeline?.reworkRounds ?? 0), 0), basePlan.rework.size + 2, 'three rework rounds from review, the reverted optimistic merge, and the spent producer request; the failed rerun is superseded by the out-of-queue merge');
  // GY-496: the killed runs relaunched without spending an attempt, the request stayed bounded, and
  // its spent head was escalated once and reworked once; the fresh head passed its proofs.
  const spentItem = final.find(item => item.key === items[basePlan.spentProducer - 1].key)!;
  assert.ok(spentHead && spentItem.candidate && spentItem.candidate.sha !== spentHead, `the spent head was replaced by a fresh one: ${spentHead} → ${spentItem.candidate?.sha}`);
  assert.equal(abandoned.size, 1, 'one producer request was spent');
  assert.deepEqual(producerRuns.map(run => run.resolution?.startsWith(`${lostRunReason}: `) ? 'lost' : 'counted'), [...Array(basePlan.lostRuns).fill('lost'), ...Array(sessionRetryLimit).fill('counted')], 'the killed runs spent no attempt; the failing runs spent them all');
  assert.ok(producerRuns.length <= requestAttemptLimit, 'relaunches stay bounded per request');
  assert.equal(spentItem.pipeline?.reworkRounds, 1, 'the spent head was reworked once');
  const proofEscalations = [...actionKeys].filter(key => key.startsWith(`escalation:proof-exhausted:${spentItem.key}:`));
  const reworks = [...actionKeys].filter(key => key.startsWith(`decision:rework:${spentItem.id}:${spentHead}:proof-exhausted`));
  assert.equal(proofEscalations.length, 1, `one escalation for the spent request: ${proofEscalations.join(', ')}`);
  assert.equal(reworks.length, 1, `one rework decision for the spent head: ${reworks.join(', ')}`);
  assert.deepEqual([...actionKeys].filter(key => key.startsWith('escalation:proof-workflow:')), [], 'the trusted workflow was never spent');
  // GY-1118: the review-cap step runs on every open item every cycle of the day; no item passes its cap of three rounds, so it files, withdraws and escalates nothing.
  assert.deepEqual([...actionKeys].filter(key => /^(escalation:)?review-cap:/.test(key)), [], 'no review-cap action on a day whose items stay within the cap');
  assert.equal(sessions.filter(session => session.state === 'dead').length, basePlan.deaths.size, 'two workers died');
  // GY-756: the pull request merged by hand outside the queue was found landed by another
  // candidate's landing check while its item recorded it unlanded, reconciled by `processJob` at
  // once, and delivered on the merge commit GitHub made; every peer a landing check named is
  // reconciled once, not re-observed on every cycle after.
  const outOfQueue = items[basePlan.outOfQueue.item - 1].key;
  assert.ok(outside && github.merges.some(entry => entry.key === outOfQueue && entry.mode === 'outside' && entry.sha === outside.sha), `${outOfQueue} was merged by hand: ${JSON.stringify(github.merges)}`);
  assert.ok(github.landedReports.some(report => report.endsWith(`-> ${outOfQueue}`) && !report.startsWith(`${outOfQueue} `)), `another candidate's landing check found ${outOfQueue} landed: ${github.landedReports.join(', ')}`);
  assert.ok(reconciled.includes(`${outOfQueue} merged`), `processJob reconciled ${outOfQueue} from that landing check: ${reconciled.join(', ')}`);
  assert.equal(final.find(item => item.key === outOfQueue)!.delivery?.mergeSha, outside!.sha, `${outOfQueue} was delivered on the merge made outside the queue`);
  assert.deepEqual(reconciled.filter((entry, index) => reconciled.indexOf(entry) !== index), [], `no landed peer was reconciled twice: ${reconciled.join(', ')}`);
  // Every dispatch the launcher settled was reported by a later cycle (GY-616): one dispatch-done
  // per session, none lost between the hand-off and the drain.
  assert.equal(reportedDispatches, sessions.length, 'each settled dispatch launch was reported to a cycle');
  assert.equal(production.deploys.length, basePlan.deploys.length, 'two production deploys');
  assert.ok(final.find(item => item.key === items[basePlan.split.item - 1].key)!.plannedFiles.includes(`src/soak/item-${basePlan.split.item}-a.ts`), 'the split file re-planned its item onto the successors');
  const reviewed = final.find(item => item.key === items[basePlan.exhaustedReviewer - 1].key)!;
  assert.ok(reviewed.reviewFailovers?.some(failover => failover.profile === 'claude-reviewer' && failover.exhaustion === 'usage-limit' && failover.nextProfile === 'cursor-reviewer'), `the exhausted reviewer bot failed over to the next profile: ${JSON.stringify(reviewed.reviewFailovers)}`);
  // GY-500: disjoint items merged optimistically and infrastructure changes queued; the one that
  // broke main was reverted head-bound within one CI duration of its failing post-merge run, and
  // reopened once, while the main guard's reads and ledger writes stayed bounded per cycle.
  const ledger = async (kind: string) => (await store.pool.query(`SELECT kind, work_id, payload->'details' AS details, created_at FROM events WHERE kind LIKE $1 AND created_at >= $2 ORDER BY seq`, [kind, new Date(dayStart).toISOString()])).rows;
  const keyOf = (workId: string) => final.find(item => item.id === workId)?.key;
  const optimistic = (await ledger('optimistic.merged')).map(row => keyOf(row.work_id));
  const culprit = items[basePlan.breaksMain - 1].key;
  // Items land in the queue too while main is red or another optimistic merge touches their files.
  assert.ok(new Set(optimistic).size > basePlan.items / 2, `most items merged optimistically: ${optimistic.join(', ')}`);
  for (const n of basePlan.infrastructure) assert.ok(!optimistic.includes(items[n - 1].key), `${items[n - 1].key} changes shared infrastructure and queued`);
  assert.equal(optimistic.filter(key => key === culprit).length, 2, `${culprit} merged optimistically, and again after its rework round`);
  assert.deepEqual(github.reverts.map(entry => [entry.key, !!entry.merged]), [[culprit, true]], 'exactly one revert, of the culprit, and it landed');
  const [postMergeFailed] = (await ledger('optimistic.post-merge')).filter(row => keyOf(row.work_id) === culprit && row.details?.verdict === 'fail');
  assert.ok(postMergeFailed, `the culprit's post-merge run failed on main: ${JSON.stringify(await ledger('optimistic.post-merge'))}`);
  const failedAt = new Date(postMergeFailed.created_at).getTime();
  assert.ok(github.reverts[0].mergedAt! - failedAt <= 5 * minute, `the revert landed within one CI duration of the failure (${Math.round((github.reverts[0].mergedAt! - failedAt) / minute)} min)`);
  assert.equal((await ledger('optimistic.revert.merged')).length, 1, 'one merged revert on the ledger');
  assert.equal((await ledger('optimistic.revert.merged')).filter(row => row.details?.reopened?.source === 'optimistic-revert').length, 1, 'one reopen, with the failure attached');
  assert.ok(!github.commits.get(github.tip)!.broken, 'main is green at the end of the day');
  // GY-711: the doctor fired from the real cycle on its ten-minute interval across the day — the
  // cursor holds its recent runs (all reported), the ledger holds every summary the loop posted,
  // and the scripted finding reached the run record it belongs to.
  const postedDoctorRuns = Number((await store.pool.query(`SELECT count(*) AS n FROM events WHERE kind = $1 AND created_at >= $2`, [doctorRunEvent, new Date(dayStart).toISOString()])).rows[0].n);
  assert.ok(postedDoctorRuns >= Math.floor(Number(process.env.SOAK_HOURS ?? 24) * 2), `the doctor ran on its interval through the day: ${postedDoctorRuns} summaries on the ledger`);
  assert.ok(state.doctor.runs.length > 0 && state.doctor.runs.every(entry => entry.state === 'reported'), 'every doctor run the cursor retains reported');
  assert.ok(state.doctor.runs.some(entry => entry.findings.some(finding => finding.subject === items[0].key && finding.check === 'worker')), 'the doctor report applied: its finding is on the run record');
  // GY-711, AC-3: the two per-item remedies the loop applies without an agent fired in the real
  // cycle across the day, each exactly once, and nothing repeated after. The fenced item's reclaim
  // settle was failed by the control plane, so the doctor's settle remedy lowered the fence on its
  // own key; the covered scope-refusal blocker was cleared once, at the revision the loop read.
  const { remedies } = day, remedied = items[remedyItem - 1], remedyFinal = final.find(item => item.id === remedied.id)!;
  const remedyActions = (name: string) => Object.entries(state.actions).filter(([key]) => key.startsWith(`remedy:${name}:${remedied.id}:`)).map(([, action]) => action);
  assert.deepEqual(remedies.settles, [{ key: remedied.key, ok: false }, { key: remedied.key, ok: true }], 'the fence was settled twice in all: the reclaim step\'s refused call, then the remedy\'s one successful call');
  assert.deepEqual(remedyActions('settle').map(action => `${action.state} x${action.attempts}`), ['done x1'], 'the settle remedy applied once, on its first attempt');
  assert.equal(remedyFinal.containmentQuarantine ?? null, null, 'the submitted attempt\'s lapsed fence is settled');
  assert.deepEqual(remedies.unblocks, [{ key: remedied.key, revision: remedies.unblocks[0]?.revision }], 'the covered scope-refusal blocker was cleared exactly once');
  assert.deepEqual(remedyActions('unblock').map(action => `${action.state} x${action.attempts}`), ['done x1'], 'the unblock remedy applied once, on its first attempt');
  assert.ok(!remedyFinal.blocker, 'the cleared blocker never came back');
  // The loop published its merge-queue settings exactly once for the whole day — on a change, not
  // every cycle (GY-330, GY-498, GY-500, GY-516) — and each setting reached the installation ledger.
  assert.equal(mergeQueuePosts.length, 1, `one publication, not one per cycle: ${JSON.stringify(mergeQueuePosts)}`);
  assert.deepEqual(mergeQueuePosts[0].settings, { batchSize: 4, optimistic: true, optimisticExclude: [...defaultOptimisticExclude], parallelTips: 4, rerunFailedChecks: 1 });
  const published = await store.pool.query(`SELECT kind, payload FROM events WHERE kind LIKE 'merge-queue.%' AND created_at >= $1 ORDER BY seq`, [new Date(dayStart).toISOString()]);
  assert.deepEqual(published.rows.map(row => [row.kind, row.payload.previous]), [
    ['merge-queue.batch-size', null], ['merge-queue.parallel-tips', null], ['merge-queue.rerun-failed-checks', null], ['merge-queue.optimistic', null], ['merge-queue.optimistic-exclude', null],
  ], `each setting recorded once: ${JSON.stringify(published.rows)}`);
  assert.deepEqual(await ledger('optimistic.guard.failed'), [], 'the main guard never failed');
  const guardWrites = (await ledger('optimistic.guard')).length;
  assert.ok(guardWrites <= 2 * optimistic.length + 4, `the main guard writes its state only on a change (${guardWrites} rows for ${optimistic.length} optimistic merges)`);
  const busiest = Math.max(...github.reads.commitChecks.values());
  assert.ok(busiest <= 4, `the main guard reads at most a few commits' checks per cycle (${busiest})`);
  // GY-516: each flaky tip was rerun exactly once. The rerun-fails tip never lands its round: the
  // out-of-queue merge (GY-756) moves the base under it while the rerun stands, the queue rebuilds
  // the tip, and the item delivers on the head the flake never touched — the superseded round is
  // what the plan comment above records, and tests/tip-flake-rerun.test.ts holds the path itself.
  const flaky = { passes: items[basePlan.flaky.rerunPasses - 1].key, fails: items[basePlan.flaky.rerunFails - 1].key };
  assert.deepEqual(github.reruns.map(entry => entry.key).sort(), Object.values(flaky).sort(), `one rerun per flaky tip: ${JSON.stringify(github.reruns)}`);
  const passed = github.reruns.find(entry => entry.key === flaky.passes)!, failed = github.reruns.find(entry => entry.key === flaky.fails)!;
  // The tip whose rerun passed is the one that lands, or the reviewed head it carried is what the
  // landed tip was rebuilt from: a republication resets the branch to that head (GY-568) and its
  // CI passes afresh on the same patch, so the flake still costs no rework round.
  const rerunTipFrom = (final.find(item => item.key === flaky.passes)!.queueHistory ?? []).find(entry => entry.tip === passed.sha)?.from ?? passed.sha;
  assert.ok(github.contains(github.merges.find(entry => entry.key === flaky.passes)!.sha, rerunTipFrom), 'the tip whose rerun passed, or the reviewed head under it, is what landed');
  assert.equal(final.find(item => item.key === flaky.passes)!.pipeline?.reworkRounds ?? 0, 0, 'a flake whose rerun passed costs no rework round');
  assert.equal(final.find(item => item.key === flaky.fails)!.pipeline?.reworkRounds ?? 0, 0, 'the tip whose rerun failed was superseded by the out-of-queue merge before the round was asked');
  assert.ok(!github.contains(github.merges.find(entry => entry.key === flaky.fails)!.sha, failed.sha), 'and what landed for it is not the failed tip');
  // GY-839: the landing check ran in the loop all day, over bases that moved under open candidates.
  // The three-way comparison from the merge base is what a candidate bound behind the tip was
  // judged by, and the fault window's blind answers are the only source of false landing refusals
  // the day has. Each held only the build gate and cleared on the exact head it named, before any
  // worker could react: no ejection, no sync round, no rework.
  assert.ok(github.landingChecks > 0, 'the landing check ran during the simulated day');
  assert.ok(github.landingBases.size >= basePlan.items, `the landing check judged moving bases (${github.landingBases.size})`);
  assert.ok(github.ancestorCompares > 0, `candidates bound behind the tip were compared from their merge base (${github.ancestorCompares} ancestor compares)`);
  assert.ok(github.blindCompares > 0, `the fault window answered compares without a usable merge base (${github.blindCompares} blind compares)`);
  assert.ok(landingRefusals.length >= 2, `the fault window caught every candidate bound behind it (${JSON.stringify(landingRefusals)})`);
  assert.ok(landingRefusals.every(entry => entry.elapsed >= basePlan.blind.from - minute && entry.elapsed <= basePlan.blind.to + minute),
    `a false landing refusal stood only inside the fault window: ${JSON.stringify(landingRefusals)}`);
  for (const entry of landingRefusals) {
    const landed = github.merges.find(merge => merge.key === entry.key);
    assert.ok(landed && github.contains(landed.sha, entry.sha), `${entry.key} landed the exact head its false refusal named (${entry.sha.slice(0, 12)})`);
  }
  assert.ok(sessions.every(session => session.syncs === 0), 'no worker was woken to sync what was never wrong');
  // GY-887: the landability verdict rode every observation as the one `graphyard/landable` run per
  // head, written only when the verdict changed, at a bounded request cost, and every head GitHub
  // merged carried its success.
  const landableHeads = [...github.landable.entries()];
  const landableRequests = (kind: string) => github.landableRequests.filter(request => request.kind === kind).length;
  assert.ok(landableHeads.length >= basePlan.items, `every candidate head carried the landability verdict (${landableHeads.length} heads)`);
  assert.deepEqual(landableHeads.filter(([, runs]) => runs.length !== 1).map(([head]) => head), [], 'one standing graphyard/landable run per head, updated in place');
  assert.deepEqual(landableHeads.filter(([, runs]) => runs[0].writes > 5).map(([head, runs]) => `${head.slice(0, 12)} ${runs[0].writes}`), [], 'no head is rewritten in a loop: only a changed verdict is written');
  assert.equal(landableRequests('post'), landableHeads.length, 'each head\'s run was created once');
  assert.ok(github.landableRequests.length <= 2 * cycles, `publishing the verdict costs a bounded number of requests (${github.landableRequests.length} over ${cycles} cycles)`);
  for (const merge of github.merges) {
    const head = github.prs.get(merge.pr)!.head;
    assert.equal(github.landable.get(head)?.[0]?.body.conclusion, 'success', `${merge.key}'s merged head ${head.slice(0, 12)} carried a landable success`);
  }
  // The diagnostician (GY-439) rode the same day. The three held-job windows recur past the
  // threshold, so the loop files the class's one recurring item and diagnoses it within the cycle
  // that files it, and the day's own churn (the dead workers' leases, the delivery budget) recurs
  // into further classes beside it. Every filed item is diagnosed once, never relaunched per
  // cycle, and closed as a duplicate of the open item its diagnosis named, on the approved
  // two-party decision, with its approver session closed once the decision settled.
  const filedFaultItems = (await store.list()).filter(item => item.origin?.faultClass);
  assert.ok(filedFaultItems.length >= 1, `the day filed recurring-fault items: ${filedFaultItems.map(item => `${item.key} (${item.origin!.faultClass!.class})`).join(', ')}`);
  assert.deepEqual(Object.keys(state.diagnoses).sort(), filedFaultItems.map(item => item.key).sort(), 'one diagnosis per filed item, none relaunched per cycle');
  const byKey = new Map(filedFaultItems.map(item => [item.key, item]));
  for (const [subject, diagnosis] of Object.entries(state.diagnoses)) {
    const item = byKey.get(subject)!;
    assert.ok(diagnosisSettled(diagnosis), `${subject}'s diagnosis settled: ${diagnosis.state} ${diagnosis.detail}`);
    assert.equal(diagnosis.kind, 'recurring');
    assert.equal(diagnosis.faultClass, item.origin!.faultClass!.class);
    assert.equal(item.stage, 'done', `${subject} was closed on its diagnosis`);
    assert.deepEqual([item.closure?.kind, item.closure?.ref], ['duplicate', diagnosis.answeredBy], `${subject} was closed as the duplicate of the item its diagnosis answered it with`);
    if (diagnosis.state === 'answered') {
      assert.ok(diagnosis.diagnosis!.covering, `${subject}'s diagnosis named an open item as covering the cause`);
      assert.equal(diagnosis.answeredBy, diagnosis.diagnosis!.covering);
      assert.ok(diagnosis.decision && diagnosis.decision.action === 'close' && diagnosis.decision.approver, `${subject}'s closure rode an approved two-party decision with an independent approver`);
    }
  }
  // The injected class, end to end: three instances in the window, one item, one primary run,
  // every instance linked to it, and no fix item filed for a covering diagnosis.
  const heldJobs = state.faults.instances.filter(entry => entry.kind === 'held-jobs');
  assert.equal(heldJobs.length, basePlan.heldJob.at.length, `one instance per held-job window: ${JSON.stringify(heldJobs.map(entry => entry.at))}`);
  const configuration = filedFaultItems.filter(item => item.origin!.faultClass!.class === 'configuration');
  assert.equal(configuration.length, 1, 'the held-job class filed exactly one recurring item');
  const configurationKey = configuration[0].key, configurationDiagnosis = state.diagnoses[configurationKey];
  assert.ok(heldJobs.every(entry => entry.linkedTo === configurationKey), 'every held-job instance links to the recurring item, so none files again');
  assert.equal(configurationDiagnosis.state, 'answered', `the held-job diagnosis was answered: ${configurationDiagnosis.detail}`);
  assert.deepEqual(configurationDiagnosis.runs.map(entry => [entry.model, entry.result]), [[diagnosisModel, 'diagnosed']], 'one primary run diagnosed it, no fallback needed');
  assert.ok(!(await store.list()).some(item => /Filed by the master loop from the diagnostician's diagnosis/.test(item.description ?? '')), 'the covering diagnoses filed no fix item');
  assert.ok(approverPanes.length > 0, 'the day launched approver sessions for its decisions');
  assert.deepEqual(approverPanes.filter(pane => !herdrClosed.includes(pane)), [], `every approver session the day launched was closed once its decision settled: ${JSON.stringify(herdrClosed)}`);
  assert.ok(cycles > 24 * 6, `the loop cycled through the day (${cycles} cycles)`);
  // The /tmp pass across the day (GY-421): never two in flight, never past its bound, and what it
  // takes is exactly what is stale and unheld.
  assert.equal(tmp.peak, 1, 'at most one /tmp pass is in flight, whatever the cycles do');
  assert.ok(tmp.passes.length > 1 && tmp.passes.every(pass => pass.removed.length <= tmpReclaimLimitPerCycle && pass.errors.length === 0), `every pass stays within its bound: ${tmp.passes.map(pass => pass.removed.length).filter(Boolean).join(', ')}`);
  assert.ok(tmp.backlog.every(directory => !existsSync(directory)), 'the backlog is cleared');
  assert.ok(tmp.passes.filter(pass => pass.removed.some(entry => tmp.backlog.includes(entry.path))).length >= 2, 'a backlog past the bound takes more than one pass');
  assert.ok(!existsSync(tmp.deadOwned) && !existsSync(`${tmp.deadOwned}.owner`), 'a dead run\'s directory goes at once, marker and all');
  assert.ok(existsSync(tmp.heldDirectory), 'a directory a live process holds open is kept all day');
  assert.ok(existsSync(tmp.liveOwned), 'a directory whose owner still runs is kept all day');
  if (hours > 7) assert.ok(!existsSync(tmp.cache), 'a tsx cache left unwritten for six hours goes');
  const aged = tmp.hourly.filter(entry => entry.at <= (hours - 7) * hour), young = tmp.hourly.filter(entry => entry.at >= (hours - 5) * hour);
  assert.deepEqual(aged.filter(entry => existsSync(entry.directory)).map(entry => entry.directory), [], 'each leftover goes once it is past six hours old');
  assert.deepEqual(young.filter(entry => !existsSync(entry.directory)).map(entry => entry.directory), [], 'no leftover goes before it is six hours old');
  const freed = tmp.passes.reduce((total, pass) => total + pass.bytes, 0), reported = tmp.reports.reduce((total, report) => total + report.tmp.bytes, 0);
  // The last pass may finish after the day's last cycle: its bytes are the next cycle's to record.
  const last = tmp.passes.at(-1)!.bytes;
  assert.ok(freed >= 1024 * (tmpReclaimLimitPerCycle + 20) && reported <= freed && reported >= freed - last, `the reclaim records carry the bytes the passes freed (${reported} of ${freed})`);
  assert.ok(tmp.reports.length <= 50, `the reclaim record stays bounded (${tmp.reports.length})`);
  assert.ok(Object.keys(state.actions).filter(key => key.startsWith('reclaim:resources:')).length <= tmp.passes.filter(pass => pass.removed.length).length, 'the loop records a reclaim only for a pass that freed something');
  // GY-437: the between-cycles self-upgrade ran after every cycle of the day. Each deploy aligned
  // the checkout once, and restarted the fleet and the loop once (every merge touches src/); the
  // dirty checkout across the second deploy was refused, untouched, without growing the cursor,
  // and aligned once it was clean again.
  const summary = `${upgrades.checkouts.map(entry => `+${Math.round((entry.at - dayStart) / minute)} min ${entry.from.slice(0, 7)}..${entry.to.slice(0, 7)}`).join(', ')}`;
  assert.equal(upgrades.outcomes.length, cycles, 'the self-upgrade ran between every cycle');
  assert.equal(upgrades.checkouts.length, production.deploys.length, `one alignment per deploy: ${summary}`);
  assert.equal(upgrades.executors.length, production.deploys.length, 'one fleet restart per deploy');
  assert.equal(upgrades.self, production.deploys.length, 'one re-execution of the loop per deploy');
  assert.deepEqual(upgrades.executors, upgrades.checkouts.map(entry => entry.to), 'the fleet restarts against the tip the checkout moved to');
  assert.ok(upgrades.checkouts[1].at >= dayStart + basePlan.dirtyCheckout.to, `the second deploy aligned only once the checkout was clean: ${summary}`);
  assert.ok(refusalSamples.length >= 3, `the dirty checkout stood refused across the second deploy (${refusalSamples.length} cycles)`);
  assert.deepEqual(new Set(refusalSamples.map(sample => JSON.stringify(sample))).size, 1, `a standing refusal does not grow the cursor's actions: ${JSON.stringify(refusalSamples.slice(0, 3))}`);
  assert.equal(state.upgrade.refused, null, 'the refusal cleared with the alignment');
  assert.equal(state.upgrade.alignedRelease, production.deploys[1].sha, 'the loop stands aligned with the last deployed release');
  assert.equal(state.release?.commit, checkout.head, 'the re-executed loop reports the release the checkout holds');
  assert.ok(Object.keys(state.actions).filter(key => key.startsWith('upgrade:')).length <= production.deploys.length + 1, `the cursor holds one upgrade action per deploy and one refusal: ${Object.keys(state.actions).filter(key => key.startsWith('upgrade:')).join(', ')}`);
  // GY-842 across the day: every pane the day's launches opened went somewhere — closed once, by
  // the step that ended its session or by the bounded sweep — the operator's own pane was never
  // touched, the previous day's backlog drained over successive bounded passes, and the drain
  // itself is what stands on the cursor.
  assert.equal(new Set(herdr.closed).size, herdr.closed.length, `no pane was closed twice: ${herdr.closed.join(', ')}`);
  assert.ok(!herdr.closed.includes(foreignPane), 'the pane Graphyard never launched is never closed');
  const reclaimed = herdr.closed.filter(pane => pane.includes(':left'));
  assert.equal(reclaimed.length, basePlan.leftovers, 'every leftover pane of the previous day is reclaimed');
  const passes = [...new Set(reclaimed.map(pane => herdr.closedAt.get(pane)))];
  assert.ok(passes.length >= 2, `the backlog drained over successive passes, not in one burst (${passes.length})`);
  // The bound paces every pass: however the backlog interleaves with the day's other panes, no
  // pass carries more than six of the leftovers, and the eight take several passes.
  const perPass = [...new Set(reclaimed.map(pane => herdr.closedAt.get(pane)))].map(at => reclaimed.filter(pane => herdr.closedAt.get(pane) === at).length);
  assert.ok(perPass.every(count => count <= 6), `a pass closes at most the bound of six (${perPass.join(', ')})`);
  const sweepStatus = state.actions['sweep:panes:status'];
  assert.match(sweepStatus?.detail ?? '', /0 standing agentless; the backlog has drained/, `the drain is what stands on the record (${sweepStatus?.detail?.slice(0, 200)})`);
  assert.doesNotMatch(sweepStatus?.detail ?? '', /the oldest is pane/, 'no oldest pane outlives the drained day');
  assert.ok(!state.actions['sweep:panes:attention'], 'the day never stood past the agentless attention bound');
  // GY-544: every scope decision made between two cycles earned exactly one re-prompt for its attempt, and nothing else re-prompted it.
  assert.equal(decided.length, basePlan.scoped.size, 'scope requests were asked and decided between cycles');
  for (const attempt of decided) {
    const [key, epoch] = attempt.split(':');
    const told = prompts.filter(prompt => prompt.key === key && prompt.epoch === Number(epoch) && /its scope request was applied/.test(prompt.text));
    assert.equal(told.length, 1, `${attempt}: one re-prompt for its scope decision: ${JSON.stringify(prompts)}`);
  }
  assert.equal(prompts.length, decided.length, `no prompt beyond one per scope decision: ${JSON.stringify(prompts.map(prompt => prompt.text.slice(0, 200)))}`);
  // Herdr's misreads closed no live session; the pane whose runtime exited was closed as exited; no sighting outlived its handle.
  assert.equal(misreads.length, basePlan.misread.size, 'two live panes were misread for a cycle');
  assert.deepEqual(exitedLive, [], 'no implementation handle was closed as exited while its agent was live');
  for (const n of basePlan.exits) assert.ok(exitedClosed.some(entry => entry.startsWith(`${items[n - 1].key} `)), `${items[n - 1].key}: the handle of the worker whose runtime exited was closed as exited: ${exitedClosed.join(', ')}`);
  assert.ok(exitedRowsSeen > 0, 'the loop recorded exited-session sightings during the day');
  assert.deepEqual(Object.keys(state.actions).filter(key => key.startsWith('exited:implementation:')), [], 'no exited-session sighting outlives the day');
  assert.deepEqual(final.flatMap(item => (item.sessions ?? []).filter(handle => handle.kind === 'implementation' && handle.state === 'running').map(handle => `${item.key} ${handle.id}`)), [], 'every implementation handle is closed once its item is delivered');
  const seconds = (performance.now() - began) / 1000;
  assert.ok(seconds < 120, `the day runs well inside the six minutes its case timeout allows it (${seconds.toFixed(1)} s)`);
});

test('unit:soak-invariants-hold — the parallel-tip window validates several queue positions at once, a failing tip ejects only its own entry while the suffix rebuilds without it, and a mid-day window change is republished, with every system invariant holding', { timeout: 360_000 }, async () => {
  // GY-498: a queue-only day (the optimistic lane off, so every item goes through the queue),
  // released three minutes apart so the queue stays deeper than the window, with the window
  // reconfigured from 4 to 2 an hour and a quarter in. Item four is the one whose first tip fails
  // and keeps failing after its rerun, so the window must attribute the failure to it once the
  // tips ahead pass, eject it alone, and rebuild the tips behind it without it. The main day's
  // other faults (the blind compare window, the file split) stay out of this day: their recovery
  // is exercised there, and here they would only cascade ejections the queue re-queues in a loop.
  // This is the real loop, the real reconciliation job and the real guarded merge across the whole
  // day, so the window's behaviour is exercised as it repeats per cycle, head and entry — not as a
  // one-shot unit fixture.
  const began = performance.now();
  const reconfigure = { at: 75 * minute, window: 2 };
  const failTip = 4;
  const day = await simulateDay({ hours: 4, queued: { window: 4, reconfigure, failTip, releaseEveryMs: 3 * minute } });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { items, final, github, sessions, violations, failures, lost, mergeQueuePosts, windowSamples, tipPublications, chainedTips, peakWindow, dayStart } = day;
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all fifteen items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  // The window held several published tips at once, and a successor's tip was chained onto the tip
  // of the entry ahead of it — the positions validate concurrently, not one head at a time.
  assert.ok(peakWindow >= 3, `several tips validated at once: ${JSON.stringify(windowSamples)}`);
  assert.ok(chainedTips.size >= 1, `successor tips built on the tip ahead: ${[...chainedTips].join(', ')}`);
  // The failing tip ejected its own entry, named the check, and is not the tip that landed: the
  // entry re-entered and was validated again on a rebuilt tip.
  const ejectee = final.find(item => item.key === items[failTip - 1].key)!;
  const ejection = (ejectee.queueHistory ?? []).find(entry => entry.event === 'ejected' && /Required CI check test did not pass on speculative tip [0-9a-f]{12}/.test(entry.reason ?? ''));
  assert.ok(ejection, `the failing tip ejected its entry: ${JSON.stringify((ejectee.queueHistory ?? []).map(entry => [entry.event, entry.reason]))}`);
  assert.match(ejection!.reason!, /rerun/, 'the rerun is named in the ejection');
  const failedTip = ejection!.tip!;
  assert.ok((ejectee.queueHistory ?? []).some((entry, index) => entry.event === 'enqueued' && index > (ejectee.queueHistory ?? []).indexOf(ejection!)), 'the ejected entry re-entered the queue');
  const landed = github.merges.filter(merge => merge.key === ejectee.key);
  assert.ok(landed.length >= 1 && landed.every(merge => !github.contains(merge.sha, failedTip)), 'what landed is a rebuilt tip, not the failed one');
  assert.ok(github.merges.every(merge => !github.contains(merge.sha, failedTip)), 'the failed tip never landed');
  // The suffix rebuilt: an entry that held a tip chained onto the failed tip later held — and
  // landed — a tip that does not contain it, so the tips behind the culprit were rebuilt without it.
  const successor = [...chainedTips].find(chaining => chaining.startsWith(`${ejectee.key}->`))?.split('->')[1];
  assert.ok(successor, `an entry behind the ejectee held a tip chained onto the failed tip: ${[...chainedTips].join(', ')}`);
  const successorTips = tipPublications.filter(publication => publication.key === successor).map(publication => publication.tip);
  assert.ok(successorTips.some(tip => github.contains(tip, failedTip)), 'its first tip was chained onto the failed tip');
  const successorLanded = github.merges.find(merge => merge.key === successor);
  assert.ok(successorLanded && !github.contains(successorLanded.sha, failedTip), 'the entry behind landed a tip rebuilt without the ejected entry');
  // The mid-day master-config edit was published once the loop next cycled, applied at once, and a
  // restarted control plane reads it back from the installation ledger; no tip after it was
  // published outside the narrowed window.
  assert.deepEqual(mergeQueuePosts.map(post => post.settings), [
    { batchSize: 4, optimistic: false, optimisticExclude: [...defaultOptimisticExclude], parallelTips: 4, rerunFailedChecks: 1 },
    { batchSize: 4, optimistic: false, optimisticExclude: [...defaultOptimisticExclude], parallelTips: 2, rerunFailedChecks: 1 },
  ], `the reconfiguration was published once, on its change: ${JSON.stringify(mergeQueuePosts)}`);
  assert.ok(mergeQueuePosts[1].at - dayStart >= reconfigure.at, 'the reconfiguration was published after the config edit');
  // The reconfiguration reached the installation ledger (a value the ledger already holds — the
  // default 4, published by an earlier day in this file — is not re-recorded, only applied).
  const tips = await store.pool.query(`SELECT payload FROM events WHERE kind='merge-queue.parallel-tips' ORDER BY seq`);
  assert.deepEqual(tips.rows.at(-1)!.payload.parallelTips, reconfigure.window, 'the narrowed window reached the installation ledger');
  assert.deepEqual(tips.rows.at(-1)!.payload.previous, 4, 'the ledger records the window it moved from');
  const late = tipPublications.filter(publication => publication.at >= reconfigure.at + 2 * minute);
  assert.ok(late.length >= 1, `the queue kept publishing under the narrowed window: ${JSON.stringify(tipPublications)}`);
  assert.ok(late.every(publication => publication.position < reconfigure.window), `every publication after the change sat inside the narrowed window: ${JSON.stringify(late)}`);
  assert.equal(engine.parallelTips, reconfigure.window, 'the control plane applies the master\'s window at once');
  assert.equal(await new Engine(store).loadParallelTips(), reconfigure.window, 'a restarted control plane reads the window back from the installation ledger');
  const status = await api(principals.coordinator, 'GET', 'status');
  assert.equal(status.mergeQueue.parallelTips, reconfigure.window, 'status reports the narrowed window');
  const seconds = (performance.now() - began) / 1000;
  assert.ok(seconds < 150, `the queue-only day runs inside its budget (${seconds.toFixed(1)} s)`);
});

test('unit:soak-invariants-hold — an ejected tip whose restore GitHub refuses is restored at most twice per contaminated head, then held under the escalation with no further branch writes, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-854: a queue-only day in which item three's first tip, chained behind item two's, fails and
  // keeps failing after its rerun. Item two's tip passes but GitHub is slow to make it mergeable, so
  // item three is ejected while item two is still queued: the ejected tip holds item two's unlanded
  // commits and the control plane owes the branch a restore. GitHub refuses every write of every
  // restore. The loop offers a failed restore once more, then escalates it, and every cycle after
  // that writes nothing more to the branch; once item two lands, the day delivers every item.
  const failTip = 3;
  const day = await simulateDay({ hours: 3, queued: { window: 4, failTip, releaseEveryMs: 3 * minute }, protectedBranch: true,
    plan: { items: 4, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), breaksMain: 0, flaky: { rerunPasses: 0, rerunFails: 0 } } });
  const { items, final, github, violations, failures, dayStart } = day;
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  const ejectee = final.find(item => item.key === items[failTip - 1].key)!, ahead = final.find(item => item.key === items[failTip - 2].key)!;
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'every item is delivered');
  const restore = ejectee.baseRefresh?.restore;
  assert.ok(restore, `the ejected tip was restored: ${JSON.stringify(ejectee.queueHistory)}`);
  assert.deepEqual(restore!.foreign, [ahead.key], 'the restore names the unlanded entry the tip carried');
  assert.equal(restore!.outcome, 'unpublished', 'a refused restore is never recorded done');
  assert.equal(restore!.attempts, 2, 'the failed restore was retried once');
  assert.match(restore!.escalated ?? '', /failed twice without the candidate changing and stops repeating \(branch reset refused\)/, 'the second failure escalated with its reason');
  assert.match(restore!.failure ?? '', /Protected branch update failed/, 'the record carries what GitHub refused');
  // Each attempt stopped at its refused branch reset: two writes over the whole day, both refused,
  // and none in the cycles after the escalation was recorded.
  const writes = github.restoreWrites.filter(write => write.key === ejectee.key);
  assert.deepEqual(writes.map(write => [write.write, write.refused]), [['reset', true], ['reset', true]], `at most two restore attempts for the contaminated head: ${JSON.stringify(writes)}`);
  assert.ok(Date.parse(restore!.performedAt!) - dayStart < 45 * minute, 'the escalation was recorded early in the day, with many cycles after it');
  // performedAt is stamped as the restore starts; its own branch write follows the scratch merge by milliseconds (GY-1087), a cycle by minutes.
  assert.ok(writes.every(write => write.at <= Date.parse(restore!.performedAt!) + 1000), 'no branch write followed the escalation');
  const landedAhead = github.merges.find(merge => merge.key === ahead.key)!;
  assert.ok(landedAhead.at - Date.parse(restore!.performedAt!) >= 15 * minute, 'the entry ahead landed well after the escalation: the contaminated head stood through many cycles');
  assert.equal(github.restoreWrites.filter(write => write.key !== ejectee.key).length, 0, 'no other branch was restored');
  // master status named the escalation, with what GitHub refused, while it stood; the worker's
  // rework round for the failed tip then replaced the branch head, which ends the contamination.
  const escalation = day.restoreLines.find(entry => /the restore is not on the branch .* escalated: it stops repeating/.test(entry));
  assert.ok(escalation?.includes(restore!.failure!), `master status named the escalation: ${JSON.stringify(day.restoreLines)}`);
});

const docsTotalDebug = (count: Record<string, number> | undefined) => count === undefined ? undefined : Object.values(count).reduce((a: number, b: number) => a + b, 0);
test('unit:soak-invariants-hold — the documentation budget under the real loop: a base inside the 3% warning files the trim item once across the day, a tip failing only the docs budget ejects the entry whose docs change crossed it naming the words over and the pages that grew, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-574, over the real queue, the real observer and the real word counting: the base sits at
  // 11,985 of a 12,000-word budget (inside the 3% warning), four items grow the pages, and the day
  // is judged on what the loop, the gates, the window and the counter do about it.
  const { items, final, github, violations, failures, lost, docsFilings, docsActions, closedTrim, state } =
    await simulateDay({ hours: 4, queued: { window: 4, releaseEveryMs: 10 * minute }, docs: { budget: { total: 12_000, perPage: 1_200 } },
      plan: { items: 4, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), breaksMain: 0, flaky: { rerunPasses: 0, rerunFails: 0 } } });
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  // Headroom: the saturated base filed the trim item once, the day closed it with the docs still
  // saturated, and the filing episode — not the open item — is what kept it to one.
  assert.ok(closedTrim, 'the trim item was filed and then closed with the documentation still saturated');
  assert.equal(docsFilings.length, 1, `exactly one filing across the day: ${JSON.stringify(docsFilings)}`);
  assert.ok(docsActions.length <= 4, `a bounded number of loop actions for ${docsTrimActionKey} (${docsActions.length}): ${JSON.stringify(docsActions)}`);
  assert.equal(docsActions.filter(action => action.state === 'done').length, 1, 'the one filing is the one done action');
  assert.match(state.actions[docsTrimActionKey]?.detail ?? '', /^Filed /, 'the filing stands as the open episode on the loop cursor');
  // Attribution: entry 1's tip fits (11,995 words) and merges, never ejected; entry 2's tip is
  // the first failing one at 12,005 words, and its ejection names the words over and the pages
  // that grew — never the queue head. Entries 3 and 4 each fit alone, and each combination that
  // crossed ejects its own crossing entry the same way.
  const head = final.find(item => item.key === items[0].key)!;
  assert.equal(head.stage, 'done', 'entry 1 merges: its tip fit the budget');
  assert.ok((head.queueHistory ?? []).every(entry => entry.event !== 'ejected'), 'the queue head is never the one the overflow ejects');
  const crossing = final.find(item => item.key === items[1].key)!;
  if (process.env.SOAK_DOCS_DEBUG) {
    console.error('CROSSING', JSON.stringify({ stage: crossing.stage, candidate: crossing.candidate, docsBudget: crossing.observation?.docsBudget ? { ...crossing.observation.docsBudget, base: docsTotalDebug(crossing.observation.docsBudget.base), pages: docsTotalDebug(crossing.observation.docsBudget.pages) } : null, checks: crossing.observation?.checks }, null, 1));
    for (const merge of github.merges) console.error('MERGE', JSON.stringify(merge));
    for (const [number, pr] of github.prs) console.error('PR', number, pr.key, [...pr.pushed.keys()].map(head => { const commit = github.commits.get(head)!; const docs = [...commit.contents].filter(([path]) => path === 'README.md' || /^docs\/.+\.md$/.test(path)).map(([path, text]) => `${path}=${text.split(/\s+/).filter(Boolean).length}`); return `${head.slice(0, 8)}: ${docs.join(' ')}`; }));
  }
  const ejected = [items[1], items[2], items[3]].map(item => final.find(entry => entry.key === item.key)!);
  const reasons = ejected.map(item => (item.queueHistory ?? []).map(entry => entry.reason ?? '').filter(reason => /unit:docs-word-budget failed: its docs change takes the budgeted documentation/.test(reason)));
  assert.ok(reasons[0]!.length >= 1, `the crossing entry was ejected with the attributed reason: ${JSON.stringify((crossing.queueHistory ?? []).map(entry => [entry.event, entry.reason]))}`);
  assert.match(reasons[0]![0], /to 12005 words, 5 over the 12000-word budget; pages that grew: docs\/grown-2\.md \(0 → 10\)/);
  // Entries 3 and 4 fill the window behind them: while the base was over its budget their
  // combinations were held by the project's own check, and once the trim landed they validated
  // and merged — the queue moves again, which is what keeping headroom is for.
  for (const item of [items[2], items[3]]) {
    const delivered = final.find(entry => entry.key === item.key)!;
    assert.equal(delivered.stage, 'done', `${item.key} is delivered once the trim has restored the room`);
  }
  // The counter's reads are bounded by what it counted: each distinct commit's tree once, each
  // distinct page and configuration version once, whatever tips and rounds held them again.
  assert.ok(github.docsReads.blobs.size <= 24, `blob reads are bounded by the distinct versions (${github.docsReads.blobs.size})`);
  assert.ok(github.docsReads.trees.size <= 48, `tree reads are bounded by the distinct commits counted (${github.docsReads.trees.size})`);
});

test('unit:soak-invariants-hold — hand-launched approvers that vanish or stop without judging are relaunched within the bound, a refused relaunch is retried, and the spent watches keep every invariant holding', { timeout: 240_000 }, async () => {
  // GY-551: for every decision a master put to an approver by hand the loop now launches up to two
  // more sessions itself and keeps the spent watch past the bound, so both repeat per item here.
  const day = await simulateDay({ hours: 6, handApprovers: true });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { final, violations, failures, state, herdr, hand, escalations, spent } = day;
  // Every item is delivered, so the day after starts from a clean board.
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all fifteen items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the relaunches and the kept spent watches');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.equal(hand.size, 2);
  for (const [decision, { key, launches, refused }] of hand) {
    assert.equal(launches - refused, 2, `${key}: the loop relaunched the hand-launched approver twice, the hand launch being the first of three`);
    assert.ok(spent.has(decision), `${key}: past the bound the watch was kept, spent`);
    assert.ok(escalations.some(detail => detail.includes(decision) && /3 approver session\(s\)/.test(detail) && /session 1: .*session 2: .*session 3: /.test(detail)), `${key}: the unanswered decision was escalated with each session's end reason`);
    assert.equal(final.find(item => item.key === key)!.stage, 'done', `${key} was still delivered`);
    assert.ok(!Object.values(state.approvals).some(watch => watch.decision === decision), `${key}: the spent watch went with its delivered item`);
    assert.ok(![...herdr.agents.values()].some(agent => agent.name === approverSessionName(final.find(item => item.key === key)!, decision)), `${key}: no approver session for it is left open`);
  }
  assert.equal([...hand.values()].reduce((total, entry) => total + entry.refused, 0), 1, 'one relaunch was refused by a registry timeout, and retried');
});

// Keep restart-induced stale observations in their own day, trimmed to six items so it adds
// little to the soak file's runtime: pausing the whole loop changes which heads need speculative
// tips, so the baseline day's CI-flake schedule stays intact.
test('unit:soak-invariants-hold — stale rework and stale merges each wake the observation job once and proceed once it lands, without storms or cursor growth', { timeout: 300_000 }, async () => {
  const rework = new Set([2, 4]);
  const day = await simulateDay({ hours: 6, staleRework: true, staleMerge: 2,
    plan: { items: 4, leftovers: 0, slowRecompute: 0, workMs: 15 * minute, rework, deaths: new Set(), breaksMain: 0, infrastructure: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 4, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 4 } } });
  const { items, final, wakes, restartLog, staleMerges, state, violations, failures, lost } = day;
  assert.deepEqual(final.filter(item => item.stage !== 'done' || !item.delivery).map(item => `${item.key} ${item.stage}`), [], 'all four items are delivered after the restarts');
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.equal(final.reduce((total, item) => total + (item.pipeline?.reworkRounds ?? 0), 0), rework.size, 'every rework round completes');
  // Each rework the restart left on a stale observation woke its item's observation job.
  const reworkKeys = [...rework].map(n => items[n - 1].key);
  assert.deepEqual(restartLog.filter(entry => entry.kind === 'rework').map(entry => entry.key), reworkKeys, `one stale rework per rework item: ${JSON.stringify(restartLog)}`);
  assert.equal(staleMerges.length, 2, 'two merges were left on a stale observation');
  // Every stale observation the restarts left — rework or merge — woke its item's job exactly once
  // after that restart, and the item was still delivered: no wake storm, no growth of state.actions.
  for (const [index, entry] of restartLog.entries()) {
    const until = restartLog.slice(index + 1).find(next => next.key === entry.key)?.at ?? Infinity;
    assert.equal(wakes.filter(wake => wake.key === entry.key && wake.at >= entry.at && wake.at < until).length, 1, `${entry.key} (${entry.kind}): one observation wake: ${JSON.stringify(wakes)}`);
  }
  assert.equal(wakes.length, restartLog.length, `no wake beyond the stale observations: ${JSON.stringify(wakes)}`);
  assert.ok(Object.keys(state.actions).filter(key => key.startsWith('wake:observation:')).length <= wakes.length, 'one wake entry per item woken');
});

test('unit:soak-invariants-hold — a guarded merge that refuses a queue head is acted on, never retried for good: a stuck candidate is re-reviewed and then reworked while the queue moves, a lost carried review is re-reviewed at once, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-831 in the world the loop really runs in: the queue's own tip publication carries each
  // item's approval, the guarded merge re-posts it through the bound reviewer App, and a refusal
  // repeats every cycle until the ten-minute bound. Item two queues behind item one, so its tip is
  // a Graphyard-authored merge carrying its approval, and GitHub answers every merge attempt for
  // that tip with a head other than the record's — one unchanged refusal, past the bound: the loop
  // clears the carried approval (rereview), and when the same refusal stands on — the carried
  // approval answered by the tip's own exact review — the loop re-arms to the rework action
  // instead of deduplicating the refusal away. Item four queues behind the stuck item with its
  // reviews posted by the bound reviewer App; its carried review is taken away once the tip's
  // carry decision bound it, so the re-post cannot use it and reports it at once. The rework round
  // lands a head the fault was never armed on; the queue moves while both items are out of the
  // head; and no merge refusal is recorded for any item the day did not stage.
  const began = performance.now();
  const stuck = 4, lostCarry = 2;
  const { items, final, github, violations, failures, lost, escalations, state, herdr, stale, config, dayStart } =
    await simulateDay({ hours: 4, queued: { window: 4, releaseEveryMs: 3 * minute }, stale: { stuck, lostCarry }, plan: { items: 6, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set([5]), deaths: new Set(), breaksMain: 0, flaky: { rerunPasses: 0, rerunFails: 0 } } });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all ten items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the refusals, the rereviews and the rework');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.ok(config.reviewer, 'the day runs with the bound reviewer identity the re-post needs');

  // ---- The stuck candidate: refused past the bound, re-reviewed, then reworked. ----
  const stuckItem = final.find(item => item.key === items[stuck - 1].key)!;
  assert.ok(stale.stuckArmedAt && stale.stuckHead, 'the stuck fault armed on the item\'s own published tip');
  const itemEvents = async (id: string, kind: string) => (await store.pool.query(
    `SELECT payload->'details' AS details, created_at FROM events WHERE kind=$1 AND work_id=$2 AND created_at >= $3 ORDER BY seq`,
    [kind, id, new Date(dayStart).toISOString()])).rows;
  const stuckRefusals = await itemEvents(stuckItem.id, 'mergerefused');
  assert.equal(stuckRefusals.length, 2, `the stuck candidate was refused to the control plane exactly twice: ${JSON.stringify(stuckRefusals.map(row => row.details?.reason?.slice(0, 80)))}`);
  assert.match(stuckRefusals[0].details.reason, /changed on GitHub before merge/);
  assert.equal(stuckRefusals[0].details.sha, stale.stuckHead, 'the refusal names the armed tip');
  assert.equal(stuckRefusals[1].details.since, stuckRefusals[0].details.since, 'both actions answer the same standing refusal, dated from its first attempt');
  assert.ok(stuckRefusals[1].details.since && new Date(stuckRefusals[0].created_at).getTime() - Date.parse(stuckRefusals[1].details.since) >= 9 * minute,
    'the first action waited past the ten-minute bound');
  assert.equal(stuckItem.pipeline?.reworkRounds ?? 0, 1, 'the rework decision sent the candidate back to its worker once');
  const stuckMerged = github.merges.find(entry => entry.key === stuckItem.key)!;
  assert.ok(stuckMerged, 'the stuck candidate was delivered');
  assert.ok(!github.contains(stuckMerged.sha, stale.stuckHead!), 'what landed is the rework round\'s head, never the armed tip');
  // The rework decision the loop requested for the merge refusal was judged, and no approver
  // session for it is left open.
  const decisions = await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(stuckItem.id)}/decisions`);
  const rework = (decisions.decisions as any[]).find(decision => decision.action === 'rework' && decision.input?.binding === `${stale.stuckHead}:merge-refused`);
  assert.ok(rework, `the merge-refusal rework decision was requested: ${JSON.stringify((decisions.decisions as any[]).map(decision => [decision.action, decision.state]))}`);
  assert.equal(rework.state, 'applied', 'the approver applied it');
  assert.ok(![...herdr.agents.values()].some(agent => (agent.name ?? '').startsWith(`graphyard-approver-${stuckItem.key.toLowerCase()}-`)), 'no approver session for the rework decision is left open');
  // Both phases raised the attention the criterion names: the reason, and the next step taken.
  assert.ok(escalations.some(detail => detail.includes(stuckItem.key) && /same reason: .*changed on GitHub before merge\. Next step: Graphyard clears the carried approval/.test(detail)),
    'the rereview phase names the reason and the clearing');
  assert.ok(escalations.some(detail => detail.includes(stuckItem.key) && /same reason: .*changed on GitHub before merge\. Next step: Graphyard marks candidate .* for a rework decision/.test(detail)),
    'the rework phase names the reason and the rework decision');
  // Acted on once per phase: the loop's own record holds one done marker per recovery phase, each
  // raised once, for this candidate and reason.
  const repeated = Object.entries(state.actions).filter(([key]) => key.includes(':repeated') && key.includes(stuckItem.id));
  assert.ok(repeated.length >= 1 && repeated.length <= 2, `one repeated-action marker per phase: ${JSON.stringify(repeated.map(([key, action]) => [key, action.state, action.attempts]))}`);
  assert.ok(repeated.every(([, action]) => action.state === 'done' && action.attempts === 1), 'each phase acted once');

  // ---- The queue moved while the stuck candidate could not land. ----
  const stuckHistory = stuckItem.queueHistory ?? [];
  const ejection = stuckHistory.find(entry => entry.event === 'ejected' && (entry.reason ?? '').startsWith('The guarded merge refused candidate '));
  assert.ok(ejection, `the rework refusal ejected the stuck entry: ${JSON.stringify(stuckHistory.map(entry => [entry.event, entry.reason?.slice(0, 60)]))}`);
  assert.ok(stuckHistory.some((entry, index) => entry.event === 'enqueued' && index > stuckHistory.indexOf(ejection!)), 'the reworked candidate re-entered the queue');
  const ejectionAt = Date.parse(ejection!.at);
  const moved = github.merges.filter(entry => entry.at >= ejectionAt && entry.at < stuckMerged.at && entry.key !== stuckItem.key);
  assert.ok(moved.length >= 2, `the entries behind it merged while it was out of the head: ${moved.length} merges before it landed`);

  // ---- The lost carried review: reported at once, re-reviewed, delivered. ----
  const lostItem = final.find(item => item.key === items[lostCarry - 1].key)!;
  assert.ok(stale.lostAt && stale.carried, 'the lost carry armed on the tip\'s own carry decision');
  assert.equal(stale.carried.reviewer, 'graphyard-reviewer[bot]', 'the carried review was the bound reviewer App\'s own');
  const lostEvents = await itemEvents(lostItem.id, 'mergerefused');
  assert.ok(lostEvents.length >= 1, 'the unusable re-post was reported to the control plane');
  assert.match(lostEvents[0].details.reason, new RegExp(`the approval of ${stale.carried.originalSha.slice(0, 12)} by graphyard-reviewer\\[bot\\] is no longer on the pull request`),
    'the first refusal names the carried review it could not re-post');
  assert.ok(new Date(lostEvents[0].created_at).getTime() - Date.parse(lostEvents[0].details.since ?? lostEvents[0].details.at ?? lostEvents[0].created_at) < 1_000,
    'the refusal was reported the moment the re-post failed, not retried to a bound first');
  assert.ok(Date.parse(lostEvents[0].created_at) - stale.lostAt <= 20 * minute, `the refusal was reported on the item's first merge attempt: ${Math.round((Date.parse(lostEvents[0].created_at) - stale.lostAt) / minute)} min after the carry was bound`);
  assert.ok(github.merges.some(entry => entry.key === lostItem.key), 'the item whose carried review was lost was delivered anyway');

  // ---- The faults stayed theirs: no other item recorded a merge refusal. ----
  const others = (await store.pool.query(
    `SELECT work_id, count(*) AS count FROM events WHERE kind='mergerefused' AND created_at >= $1 GROUP BY work_id`,
    [new Date(dayStart).toISOString()])).rows;
  assert.deepEqual(others.map(row => [row.work_id, Number(row.count)]).sort(), [[lostItem.id, lostEvents.length], [stuckItem.id, 2]].sort(),
    `only the staged items were refused: ${JSON.stringify(others)}`);
  const seconds = (performance.now() - began) / 1000;
  assert.ok(seconds < 200, `the day runs inside its budget (${seconds.toFixed(1)} s)`);
});

test('unit:soak-invariants-hold — approver launches refused for capacity wait uncounted and relaunch oldest-first within two cycles of capacity freeing, with no hand action and every invariant holding', { timeout: 360_000 }, async () => {
  // GY-849: between minute 50 and minute 130 no approver account is eligible, which spans the
  // rework rounds of items three and seven (requested about minutes 58 and 118), so both decisions
  // sit waiting when the window closes. The loop must relaunch them — uncounted against the launch
  // bound, one at a time on the launcher, the older request taking the freed capacity first, each
  // within a couple of cycles of the window closing — with no hand action, and both items delivered.
  const began = performance.now();
  const window = { from: 50 * minute, to: 130 * minute };
  const day = await simulateDay({ hours: 6, capacityWait: window });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { items, final, violations, failures, escalations, capacityRefused, capacityLaunched, capacityWaiters } = day;
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all fifteen items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the capacity waits and the ordered relaunches');
  assert.deepEqual(failures, [], 'no cycle failed');
  // Both rework decisions were refused inside the window and both still waited when it closed.
  assert.ok(capacityWaiters && capacityWaiters.length === 2, `both rework decisions waited at window close: ${JSON.stringify(capacityWaiters)}`);
  const waiters = [...(capacityWaiters ?? [])].sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
  assert.ok(waiters.every(entry => [...capacityRefused].some(refusal => refusal.decision === entry.decision && refusal.elapsed >= window.from && refusal.elapsed < window.to)),
    `each waiting decision was refused for capacity inside the window: ${JSON.stringify(capacityRefused.slice(0, 4))}…`);
  assert.ok(waiters.every(entry => entry.key === items[2].key || entry.key === items[6].key), `the waiters are the rework rounds of items three and seven: ${JSON.stringify(waiters)}`);
  // Once capacity freed, the oldest waiting decision launched first, then the next: one at a time,
  // each in its own cycle, so a newer decision never races an older one for the freed capacity.
  const recovered = capacityLaunched.filter(entry => waiters.some(waiter => waiter.decision === entry.decision)).sort((a, b) => a.elapsed - b.elapsed);
  assert.deepEqual(recovered.map(entry => entry.decision), waiters.map(entry => entry.decision),
    `capacity freed took the waiting decisions in age order: ${JSON.stringify({ launched: recovered, waited: waiters })}`);
  assert.ok(recovered.length >= 2 && recovered[0].elapsed < recovered[1].elapsed,
    `the relaunches went one at a time, never two in one cycle: ${JSON.stringify(recovered)}`);
  for (const entry of recovered)
    assert.ok(entry.elapsed >= window.to && entry.elapsed <= window.to + 2 * minute, `${entry.decision} launched within two cycles of capacity freeing (+${Math.round((entry.elapsed - window.to) / minute)} min)`);
  // Neither decision was left unanswered: neither escalated as unjudged, and both rework rounds ran.
  for (const waiter of waiters)
    assert.ok(!escalations.some(detail => detail.includes(waiter.decision) && /approver session\(s\)/.test(detail)), `${waiter.key}: the capacity wait never escalated as unjudged`);
  for (const n of [3, 7]) assert.equal(final.find(item => item.key === items[n - 1].key)!.pipeline?.reworkRounds ?? 0, 1, `item ${n}'s rework round ran after its capacity wait`);
  const seconds = (performance.now() - began) / 1000;
  assert.ok(seconds < 150, `the capacity-wait day runs inside its budget (${seconds.toFixed(1)} s)`);
});

test('unit:soak-invariants-hold — the loop\'s own master session across a day: launched once, relaunched within three cycles of dying while the registry refuses to end its session (which stays owed until it is ended), rotated at its budget, never two at once, and woken only by material events with the heartbeat as the fallback', { timeout: 600_000 }, async () => {
  // GY-898: the master-session step runs every cycle of the real loop here. The session dies at
  // minute 70, inside a window (minutes 60–100) in which the registry refuses every end, so the
  // rotation's release is owed and retried; the relaunched session passes its 90-minute budget.
  const plan = { exitAt: 70 * minute, refuseRelease: { from: 60 * minute, to: 100 * minute }, sessionMinutes: 90, heartbeatMinutes: 30 };
  const day = await simulateDay({ hours: 6, master: plan });
  const { final, violations, failures, state, master, cycles } = day;
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all fifteen items are delivered with the master session in the loop');
  assert.deepEqual(violations, [], 'every system invariant holds, and never two master sessions at once');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.equal(master.maxLive, 1, 'exactly one master session ran at a time');
  assert.equal(master.launches[0].at, 0, 'the first cycle launches the master session');
  assert.ok(master.killed, 'the scenario killed the live master session');
  // AC-1: the dead session is relaunched within three cycles, and its refused release stays owed until the registry answers.
  assert.ok(master.launches[1] && master.launches[1].at > plan.exitAt && master.launches[1].at <= plan.exitAt + 3 * minute,
    `the dead master was relaunched within three cycles: ${JSON.stringify(master.launches.slice(0, 2))}`);
  assert.match(master.rotations[0]?.detail ?? '', /\(exited\)/);
  assert.ok(master.refusedEnds.includes(master.launches[0].session), 'the rotation\'s registry end was refused inside the window');
  assert.ok(master.ended.includes(master.launches[0].session), 'the owed registry session was ended once the registry answered');
  assert.deepEqual(state.master.unreleased, [], 'nothing is owed to the registry at the end of the day');
  // AC-1: a budget rotation, one budget after the relaunch (deferred at most 30 minutes while a
  // guarded merge on an open item runs), on the clock the loop measures the budget by: the cycle
  // that rotated read it between `before` and `after`.
  const budget = master.rotations.find(rotation => /\(budget\)/.test(rotation.detail));
  const relaunched = master.launches[1]?.startedAt;
  assert.ok(relaunched !== undefined, 'the relaunch recorded its start');
  assert.ok(budget && budget.after >= relaunched + plan.sessionMinutes * minute && budget.before <= relaunched + (plan.sessionMinutes + 32) * minute,
    `the relaunched session rotated at its ${plan.sessionMinutes}-minute budget: ${JSON.stringify({ relaunched, rotations: master.rotations })}`);
  assert.equal(master.launches.length, master.rotations.length + 1, 'every rotation relaunched exactly one session');
  // AC-2: at most one wake per cycle, every event wake names its causes, heartbeats are spaced by
  // the configured window, and no cycle repeats the previous cycle's causes (a wake storm).
  const perCycle = new Map<number, number>();
  for (const wake of master.wakes) perCycle.set(wake.cycle, (perCycle.get(wake.cycle) ?? 0) + 1);
  assert.ok([...perCycle.values()].every(count => count === 1), 'never more than one wake in a cycle');
  const events = master.wakes.filter(wake => !/heartbeat fallback/.test(wake.text));
  assert.ok(events.length > 0, 'the day\'s material events woke the master');
  assert.ok(events.every(wake => /Changed subjects, by key: (?!none)\S/.test(wake.text)), 'every event wake names the subjects that changed');
  const causes = (text: string) => /Changed subjects, by key: ([^.]*)\./.exec(text)?.[1] ?? '';
  const repeats = events.filter((wake, index) => index > 0 && events[index - 1].cycle === wake.cycle - 1 && causes(events[index - 1].text) === causes(wake.text));
  assert.deepEqual(repeats.map(wake => `+${Math.round(wake.at / minute)} min: ${causes(wake.text)}`), [], 'no wake repeats the previous cycle\'s causes');
  const heartbeats = master.wakes.filter(wake => /heartbeat fallback/.test(wake.text));
  for (let index = 1; index < heartbeats.length; index++) assert.ok(heartbeats[index].clock! - heartbeats[index - 1].clock! >= plan.heartbeatMinutes * minute, `heartbeats are spaced by the quiet window: ${JSON.stringify(heartbeats.map(wake => wake.clock))}`);
  assert.ok(master.wakes.length < cycles / 2, `wakes are events, not every cycle: ${master.wakes.length} wakes in ${cycles} cycles`);
});

// GY-475's citation day runs before the regression day: the days share one control plane, and
// the regression day leaves items mid-flight on purpose, whose rework a later day's loop would
// take up with the pull request of a simulated GitHub that day can no longer reach.
test('unit:soak-invariants-hold — after a restart the first request for a refused rework decision already cites the refusal the binding names, and no request is refused', { timeout: 600_000 }, async () => {
  // GY-475: the approver refuses the rework decision items 3 and 7 call for; the loop settles the
  // watch, escalates the refusal and never re-requests it. A restart then loses the cursor while
  // both items still call for the same decision — same head, base and grounds binding. The ledger
  // keeps the refused inputs as jsonb, whose key order is not the loop's, so the fresh loop's
  // up-front scan matches them only in canonical form: each item's next request already cites its
  // refusal and is accepted on the first attempt, where a scan blind to the binding would send an
  // uncited request, take the 409 the server answers it with, and spend one of the three bounded
  // refusal answers per item.
  const day = await simulateDay({ hours: 6, refuseReworkOf: [3, 7] });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { final, violations, observed, failures, lost, escalations, herdr, refused, decideCalls, restarted, state } = day;
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all fifteen items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the refusals, the restart and the cited re-requests');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.deepEqual([...observed].sort(), [...systemInvariants].sort(), 'every invariant was observed, not merely left unread');
  assert.ok(restarted, 'the day included the scenario restart');
  assert.equal(refused.length, 2, 'both scenario refusals were judged');
  assert.equal(final.reduce((total, item) => total + (item.pipeline?.reworkRounds ?? 0), 0), basePlan.rework.size + 2, 'the refusals added no rework rounds beyond the main day\'s own (review, the reverted merge, and the spent producer request; the failed rerun is superseded by the out-of-queue merge)');
  for (const { key, decision } of refused) {
    const item = final.find(entry => entry.key === key)!;
    const history = (await api(principals.operatorAgent, 'GET', `work/${encodeURIComponent(item.id)}/decisions`)).decisions as { id: string; action: string; state: string; input: any }[];
    const reworks = history.filter(entry => entry.action === 'rework');
    assert.equal(reworks.length, 2, `${key}: bounded requests — exactly the refused and the cited rework decisions`);
    assert.equal(reworks[0].id, decision, `${key}: the refused rework decision was the first`);
    assert.equal(reworks[0].state, 'refused');
    assert.equal(reworks[1].state, 'applied', `${key}: the cited re-request was applied and carried the round`);
    const calls = decideCalls.filter(call => call.key === key && call.action === 'rework');
    assert.equal(calls.length, 2, `${key}: each request was sent once — the re-request took no refused round-trip`);
    assert.ok(!calls[0].reason.includes(decision), `${key}: the refused request could cite nothing`);
    assert.ok(calls[1].reason.includes(decision), `${key}: the first request after the restart cites the refusal in its reason`);
    // The ledger kept the refused input as jsonb, whose key order is not the one the request
    // builds, so the fresh scan only matched it in canonical form — which this proves ran.
    assert.notEqual(JSON.stringify(reworks[0].input), JSON.stringify(calls[1].input), `${key}: jsonb kept the refused input in another key order than the request builds`);
    assert.deepEqual(calls[1].input, reworks[0].input, `${key}: the cited request carries the refused request's exact input`);
    assert.ok(escalations.some(detail => detail.includes(decision) && /does not request it again/.test(detail)), `${key}: the refusal was escalated, not re-requested, while it stood`);
    assert.ok(!Object.values(state.approvals).some(watch => watch.work === key), `${key}: no watch is left open on the item`);
  }
  assert.ok(![...herdr.agents.values()].some(agent => /approver/i.test(agent.name ?? '')), 'no approver session is left open at the end of the day');
});

test('unit:soak-invariants-hold — direct wide scope requests: a rule-approved ask folds and answers once, a finding-grounded ask widens once, and an unrepresentable ask is refused with nothing retrying it', { timeout: 600_000 }, async () => {
  const day = await simulateDay({ hours: 4, scope: true });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { items, final, violations, failures, state, escalations } = day;
  assert.deepEqual(violations, [], 'every system invariant holds with the scope scenarios in the day');
  assert.deepEqual(failures, [], 'no cycle failed');

  // The rule-approved wide ask: folded into one directory entry, applied once, delivered on the
  // folded scope, and never decided again across the rest of the day.
  const wide = final.find(item => item.key === items[scopePlan.wideRule - 1].key)!;
  assert.equal(wide.scopeDecision?.state, 'approved', wide.scopeDecision?.reason);
  assert.deepEqual(wide.plannedFiles, [file(scopePlan.wideRule), scopePlan.wideRuleDir], 'the wide ask folded into one directory entry');
  assert.equal(wide.stage, 'done', 'the wide item was delivered on the folded scope');
  const wideActions = Object.keys(state.actions).filter(key => key.startsWith(`scope:${wide.id}:`));
  assert.equal(wideActions.length, 1, `one scope action stands for the wide item: ${wideActions.join(', ')}`);

  // The finding-grounded wide ask: the rule refuses it, the loop widens once by posting the folded
  // revision, and the item delivers on the folded scope.
  const found = final.find(item => item.key === items[scopePlan.wideFinding - 1].key)!;
  assert.equal(found.scopeDecision?.state, 'approved', 'the posted widening answered the request');
  assert.deepEqual(found.plannedFiles, [file(scopePlan.wideFinding), scopePlan.wideFindingDir], 'the finding-grounded ask folded the same way');
  assert.equal(found.stage, 'done', 'the finding item was delivered on the folded scope');
  const foundActions = Object.keys(state.actions).filter(key => key.startsWith(`scope:${found.id}:`));
  assert.equal(foundActions.length, 2, `the refusal and the widening are the only scope actions: ${foundActions.join(', ')}`);
  assert.equal((await api(principals.operatorAgent, 'GET', `work/${found.id}/decisions`)).decisions.filter((decision: any) => decision.action === 'requirements').length, 0, 'the loop widened on the finding directly, without routing a decision');

  // The unrepresentable ask: refused by the rule, decided once, never applied, never routed, and
  // never re-decided: the escalation stands and nothing retries it for the rest of the day.
  const blocked = final.find(item => item.key === items[scopePlan.unrepresentable - 1].key)!;
  assert.equal(blocked.stage, 'build', 'the item is held in build');
  assert.match(blocked.scopeDecision!.reason, new RegExp(`no fold represents the ask within the ${plannedFilesMax} entries plannedFiles holds \\(${plannedFilesMax + 1} after folding\\)`));
  assert.equal(blocked.scopeDecision?.state, 'refused', 'the refusal stands recorded on the item');
  assert.deepEqual(blocked.plannedFiles, bulk18, 'the oversized ask was never applied');
  const decided = Object.entries(state.actions).filter(([key]) => key.startsWith(`scope:${blocked.id}:`) && !key.includes(':finding:'));
  assert.equal(decided.length, 1, `one deciding action stands for the blocked item: ${decided.map(([key]) => key).join(', ')}`);
  assert.equal(decided[0][1].attempts, 1, 'the rule decided the ask once and never re-decided it');
  const judging = Object.entries(state.actions).find(([key]) => key.startsWith(`scope:${blocked.id}:`) && key.includes(':finding:'));
  assert.ok(judging && judging[1].state === 'done' && /no unresolved review finding/.test(judging[1].detail), `the finding rule judged the refusal and left it standing: ${judging?.[1].detail}`);
  assert.equal((await api(principals.operatorAgent, 'GET', `work/${blocked.id}/decisions`)).decisions.filter((decision: any) => decision.action === 'requirements').length, 0, 'an unrepresentable fold is never routed to a decision the schema would refuse');
  assert.equal(escalations.filter(detail => detail.includes(blocked.key) && /blocked on scope/.test(detail)).length, 1, 'exactly one escalation stands for the blocked item');
});

test('unit:soak-invariants-hold — a loop change that breaks an invariant fails the soak: approver sessions the loop no longer closes are named within the hour', { timeout: 600_000 }, async () => {
  // The regression GY-403 was: approvers finished, nobody closed them. Here the loop's close reports
  // success and closes nothing, which no per-item gate of any change would notice.
  // The day runs beside the shard's other files, so its wall clock is the machine's, not the loop's:
  // with six day-simulations in the file this is the slowest day per simulated hour (lingering
  // approver sessions pile up all day), and CI measured it past the old 120s budget while the
  // simulated hour held, so its budget is sized like the other days' — about twice its measured
  // run (GY-630).
  const day = await simulateDay({ hours: 3, regression: 'approvers-left-open' });
  assertLaunchesConfined(day, coordinatorRoot!);
  const { violations, state } = day;
  assert.ok(violations.some(line => /lingering-sessions: VIOLATED — .*approver session graphyard-approver-gy-\d+-/.test(line)), `the soak names the lingering approver: ${violations.slice(0, 3).join('\n')}`);
  assert.ok(violations.every(line => /lingering-sessions/.test(line)), `nothing else is violated: ${violations.filter(line => !/lingering-sessions/.test(line)).slice(0, 3).join('\n')}`);
  // The violation is a fault of its class on the loop's record, which files one item when it recurs.
  assert.equal(state.faults.instances.filter(instance => instance.kind === 'invariant:lingering-sessions' && instance.faultClass === 'session-liveness').length, 1);
});

test('unit:soak-invariants-hold — a worker idle past its bound whose pane died is reclaimed without pasting into or closing the pane the reused agent name holds, and is still delivered', { timeout: 600_000 }, async () => {
  // GY-852: one worker takes its lease and then idles at its prompt for ever. Past the idle bound
  // the loop re-prompts it once — in its own pane. The pane then dies and the profile's agent name
  // is taken by another session (the shape that delivered GY-589's re-prompt to GY-831-4's pane),
  // so the reclaim runs while the name holds a pane this attempt does not own: nothing is pasted
  // into it, nothing closes it, and the item is handed to a new attempt that delivers it. The
  // routing repeats per cycle here, which is why it lives in this world.
  const n = basePlan.reassigned;
  const { items, final, violations, failures, lost, herdrClosed, prompts, state, reassign } = await simulateDay({
    hours: 6, reassigned: n,
    plan: { items: 6, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), breaksMain: 0, infrastructure: new Set([5]), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
  });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all six items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the idle re-prompt and the reclaim');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost: the idle attempt was reclaimed');
  assert.ok(reassign.pane && reassign.phantom, `the scenario ran: ${JSON.stringify(reassign)}`);
  assert.ok(reassign.phantomGone, 'the other session ended once the attempt was reclaimed');
  // Every paste went to the pane it was addressed to: the idle re-prompt reached the worker's own
  // pane exactly once, and the pane the reused name holds received nothing, ever.
  const mine = prompts.filter(entry => entry.key === items[n - 1].key);
  assert.deepEqual(mine.map(entry => entry.pane), [reassign.pane], `the re-prompt reached only its own pane: ${JSON.stringify(prompts.map(entry => entry.pane))}`);
  assert.ok(!prompts.some(entry => entry.pane === reassign.phantom), 'no paste ever reached the pane the reused name holds');
  assert.ok(!herdrClosed.includes(reassign.phantom!), 'the loop never closed the pane the reused name holds');
  // The reclaim is on the record with why, and the attempt it ended was followed by a delivered one.
  const reclaim = state.actions[`resume:reclaim:${items[n - 1].id}:1`];
  assert.equal(reclaim?.state, 'done');
  assert.match(reclaim.detail, /its pane .* has been gone from the runtime .* keeping the attempt's branch/);
  assert.equal(final.find(item => item.key === items[n - 1].key)!.stage, 'done', 'the item was delivered by its next attempt');
});

test('unit:soak-invariants-hold — start failures on the real dispatch path fall forward across the day: three consecutive failures of one account across items raise one attention item, a later start on the account clears it, and every failed pane is closed at its bound', { timeout: 300_000 }, async () => {
  // GY-417: account failover and the failure ledger repeat per dispatch, so the real loop runs a
  // day whose every dispatch goes through `dispatchWork` on a master root whose OpenCode account's
  // runtime never comes up: each launch falls forward to the Claude account, is recorded, and is
  // bounded — the failed pane is closed at the start bound and the claim is released. The fourth
  // dispatch finds the account healthy: it starts, and the ledger and its attention item clear.
  const { root, master, profile } = await failoverInstalled();
  const world = new FailoverWorld(new Set(['opencode']));
  const { final, violations, failures, lost, reportedDispatches, sessions, failover } = await simulateDay({
    hours: 3, failover: { root, master, world, dispatches: [], samples: [] },
    plan: { items: 5, releaseEveryMs: 5 * minute, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), breaksMain: 0, infrastructure: new Set(), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 5, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 5 } },
  });
  assert.ok(failover, 'the day ran the failover scenario');
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all five items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds across the real launches');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no worker lost its lease');
  assert.equal(reportedDispatches, sessions.length, 'each settled dispatch launch was reported to a cycle');
  assert.equal(world.launched, 5, 'every item of the day was dispatched through the real path');
  assert.deepEqual(world.kinds, ['opencode', 'claude', 'opencode', 'claude', 'opencode', 'claude', 'opencode', 'opencode'],
    `three launches fell forward to the second account, the last two started on the preferred one: ${world.kinds.join(', ')}`);
  assert.equal(world.closedBrokenPanes, 3, 'each runtime that never started had its pane closed at the start bound');
  assert.equal(failover.dispatches.length, 5);

  // Every fallback dispatch named the account that failed and the one that took the launch.
  for (const [index, dispatched] of failover.dispatches.entries()) {
    if (index < 3) {
      assert.ok(dispatched.fallback!.note.startsWith('opencode-a failed to start: ') && dispatched.fallback!.note.endsWith('; launched on claude-b'), dispatched.fallback!.note);
      assert.equal(dispatched.account!.environment, 'claude-b');
    } else {
      assert.equal(dispatched.fallback, null, 'a dispatch whose preferred account starts records no fallback');
      assert.equal(dispatched.account!.environment, 'opencode-a');
    }
  }

  // The ledger grew one failure per launch across items, raised exactly one attention item at
  // three in a row — three items, still one item, never more — and cleared on the healthy start.
  const counts = failover.samples.map(sample => sample.failures['opencode-a']?.failures ?? 0);
  assert.deepEqual(counts, [1, 2, 3, 0, 0], `one consecutive failure per launch across items: ${counts.join(', ')}`);
  const raised = failover.samples.map(sample => sample.attention.items.length);
  assert.deepEqual(raised, [0, 0, 1, 0, 0], `one attention item, exactly at three consecutive failures: ${raised.join(', ')}`);
  assert.equal(new Set(failover.samples.map(sample => sample.key)).size, 5, 'the failing launches ran on different items');
  const attention = failover.samples[2].attention.items[0];
  assert.equal(attention.subject, 'opencode-a never starts');
  assert.ok(attention.text.includes('failed to start 3 launches in a row'), attention.text);
  assert.ok(attention.text.includes('opencode-a (runtime opencode)'), attention.text);
  const row = failover.samples[2].attention.rows[profile.name];
  assert.ok(row.fallback!.startsWith('opencode-a failed to start: ') && row.fallback!.endsWith('; launched on claude-b'), row.fallback!);
  assert.equal(failover.samples[3].attention.rows[profile.name].fallback, null, 'the healthy start turned the row\'s fallback off');

  // The last dispatch record and the ledger agree: the account started, nothing is held against it.
  const record = (await readProfileLaunchRecords(root, [profile]))[profile.name];
  assert.equal(record.account, 'opencode-a');
  assert.equal(record.runtime, 'opencode');
  assert.deepEqual(record.failedAccounts, []);
  assert.deepEqual(await readAccountStartFailures(master), {}, 'the healthy start cleared the account\'s run of failures');
});

test('unit:soak-invariants-hold — review follow-ups across a day: approvals of unshipped parents (re-approvals during rework included) are held on them, each delivered parent gets exactly one follow-up item, a parent closed unshipped drops its findings, a refused ship stops at the bound, and every invariant holds', { timeout: 300_000 }, async () => {
  // GY-845: the follow-up filing and the ship step run every pass, so they belong in this world.
  // Item 1's first head is spent by its producer and reworked, so it is approved twice; item 2 is
  // sent back by its reviewer first; item 3's optimistic merge breaks main, so it is delivered,
  // reverted and reopened before it ships, and approved again; item 4's ship is refused all day.
  const parents = [1, 2, 3, 4], refused = 4, reverted = 3;
  const { items, final, violations, failures, followUpDay } = await simulateDay({
    hours: 3, followUps: { parents, refused },
    plan: { items: 6, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set([2]), deaths: new Set(), breaksMain: reverted, infrastructure: new Set([5]), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
  });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}`), [], 'all six items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds, follow-ups-per-parent included, across the approvals, the ships and the close');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(followUpDay.early, [], 'no follow-up item was ever open while its parent had not shipped');
  const all = await store.list();
  const followUpsOf = (key: string) => all.filter(item => followUpParent(item) === key);
  for (const n of [1, reverted]) assert.ok((followUpDay.approvals.get(items[n - 1].key) ?? []).length >= 2, `item ${n} was re-approved during its rework: ${JSON.stringify([...followUpDay.approvals])}`);
  assert.ok(final.find(item => item.key === items[reverted - 1].key)!.optimisticMerges?.some(merge => merge.revert?.state === 'merged'), 'item 3\'s first merge was reverted, reopening it');
  for (const n of parents) {
    const key = items[n - 1].key, approvals = followUpDay.approvals.get(key) ?? [];
    assert.ok(approvals.length >= 1, `${key} was approved`);
    if (n === refused) {
      assert.equal(followUpDay.ships.get(key), repeatedClientErrorLimit, `the refused ship of ${key} is attempted exactly up to the stop`);
      assert.ok(followUpDay.runs[key]?.stoppedAt, 'and then stopped');
      assert.equal(followUpDay.events.filter(line => line.includes(`on ${key} stopped retrying`)).length, 1, 'one stop line, never repeated');
      assert.deepEqual(followUpsOf(key), [], 'its findings stay held on it');
      assert.equal(final.find(item => item.key === key)!.pendingFollowUps?.findings.length, approvals.length + 1);
      continue;
    }
    assert.equal(followUpDay.ships.get(key), 1, `${key}'s held findings were shipped once`);
    const filed = followUpsOf(key);
    assert.equal(filed.length, 1, `${key} has exactly one follow-up item`);
    assert.deepEqual(filed[0]!.dependencies, [], 'depending on nothing: its parent has landed');
    assert.deepEqual(followUpEntries(filed[0]!).map(entry => entry.text).sort(), [...new Set(approvals.flatMap(review => followUpFindings(n, review).map(entry => entry.text)))].sort(), 'holding the deduplicated union of every approval\'s findings');
  }
  for (const n of [5, 6]) assert.deepEqual(followUpsOf(items[n - 1].key), [], 'an item without follow-up findings gets none');
  const closed = all.find(item => item.key === followUpDay.closed!.key)!;
  assert.ok(isClosed(closed) && closed.pendingFollowUps?.dropped?.reason, 'the parent closed unshipped dropped its findings with a recorded reason');
  assert.deepEqual(followUpsOf(closed.key), [], 'and never got a follow-up item');
  // The day's follow-up items are closed here, so a later day's backlog is its own.
  for (const item of all.filter(entry => followUpParent(entry) && !isClosed(entry))) await api(principals.operator, 'POST', `work/${item.key}/close`, { kind: 'obsolete', reason: 'soak: the follow-up day ends' });
});

test('unit:soak-invariants-hold — automatic reviews over hours of dispatch ticks, items and heads: the default reviewer concurrency is never exceeded, every settled reviewer\'s pane is closed within one cycle, a pane Herdr will not close is retried a bounded number of times and reported, no pending session\'s pane is closed, and every invariant holds', { timeout: 180_000 }, async () => {
  // GY-1072: the automatic profile runs automaticReviewerConcurrency sessions, and reconcileReviews
  // sweeps settled reviewers' panes on every dispatch tick. Sixteen items each go through two heads
  // (changes requested, then approved); one settled reviewer's close fails once, another's forever.
  const host = await fleet({ name: 'claude-reviewer', agentName: 'claude-reviewer', kind: 'claude' }, 'claude-reviewer');
  const tickMs = 30_000, reviewMs = 2 * minute, reworkMs = minute;
  try {
    const config = await loadMasterConfig(host.root);
    const limit = profileConcurrency(selectReviewerProfile(config).profile!);
    assert.equal(limit, automaticReviewerConcurrency);
    const cursor = emptyDispatchCursor(config);
    const total = 16, closeOnceRefused = { n: 3, head: 1 }, closeNeverAccepted = { n: 7, head: 2 };
    // Each item's current head, when it next enters (a rework waits for its worker), and when it was delivered.
    const items = new Map<number, { work: Work | null; head: number; enterAt: number; deliveredAt: number | null }>();
    for (let n = 1; n <= total; n++) items.set(n, { work: null, head: 1, enterAt: clock.now() + (n <= 6 ? 0 : (n - 6) * 5 * minute), deliveredAt: null });
    const live = () => [...items.values()].filter(entry => entry.work && entry.deliveredAt === null).map(entry => entry.work!);
    // Each session posts its verdict two minutes in: changes requested on a first head, an approval on the second.
    const reviewIds = new Map<string, number>();
    const observe = (record: ReviewRecord) => Date.now() - Date.parse(record.requestedAt) < reviewMs ? null
      : { state: /e2/.test(record.sha) ? 'APPROVED' : 'CHANGES_REQUESTED', reviewer: 'graphyard-reviewer[bot]', reviewId: reviewIds.get(record.id) ?? reviewIds.set(record.id, 10_000 + reviewIds.size).get(record.id)!, submittedAt: new Date().toISOString() };
    const effects = host.effects(live, () => config, observe);
    const ledgerFile = join(host.root, '.graphyard/reviews.json');
    const heldSince = new Map<string, number>(), seenPending = new Set<string>(), refused: string[] = [], ledgers: string[] = [];
    let peak = 0, cycle = 0, neverPane: string | null = null, lingeringFrom: number | null = null;
    const record = emptyInvariantRecord();
    for (; cycle < 600; cycle++) {
      for (const [n, entry] of items) if (!entry.work && entry.deliveredAt === null && entry.enterAt <= clock.now()) entry.work = requested(n, entry.head);
      const closesBefore = host.closes.length;
      const tick = await runDispatchTick(config, cursor, effects, Date.now);
      refused.push(...tick.refused.map(entry => `${entry.work}: ${entry.reason}`));
      const ledger = (await readReviewLedger(host.root)).reviews;
      // Faults armed on the panes as their sessions start.
      for (const entry of ledger.filter(entry => entry.state === 'pending' && entry.pane && !seenPending.has(entry.id))) {
        seenPending.add(entry.id);
        const n = Number(entry.key.slice(3)) - 500, head = /e2/.test(entry.sha) ? 2 : 1;
        if (n === closeOnceRefused.n && head === closeOnceRefused.head) host.refuseClose.set(entry.pane!, 1);
        if (n === closeNeverAccepted.n && head === closeNeverAccepted.head) { host.refuseClose.set(entry.pane!, Infinity); neverPane = entry.pane; }
      }
      // No pending session's pane is ever closed.
      for (const pane of host.closes.slice(closesBefore)) assert.ok(!ledger.some(entry => entry.pane === pane && entry.state === 'pending'), `cycle ${cycle}: the pane ${pane} of a pending session was closed`);
      // The profile never runs more sessions than its limit, the held name included.
      const sessions = host.agents.filter(agent => agent.name?.startsWith('claude-reviewer')).length;
      assert.ok(sessions <= limit, `cycle ${cycle}: ${sessions} reviewer sessions over the limit of ${limit}`);
      peak = Math.max(peak, sessions);
      // Every settled reviewer still in its pane is closed by the next cycle, unless Herdr refuses that close every time.
      for (const entry of ledger.filter(entry => entry.state !== 'pending' && entry.pane)) {
        const visible = host.agents.some(agent => agent.pane_id === entry.pane && agent.name === entry.agentName);
        if (!visible) { heldSince.delete(entry.pane!); continue; }
        if (!heldSince.has(entry.pane!)) heldSince.set(entry.pane!, cycle);
        if (entry.pane !== neverPane) assert.ok(cycle - heldSince.get(entry.pane!)! <= 1, `cycle ${cycle}: settled reviewer ${entry.agentName} on ${entry.key} still holds pane ${entry.pane} since cycle ${heldSince.get(entry.pane!)}`);
      }
      // A verdict moves its item on: changes requested is reworked into the next head, an approval delivers it.
      for (const entry of items.values()) {
        if (entry.deliveredAt !== null || !entry.work || !ledger.some(review => review.requestId === entry.work!.autoDispatch!.review!.id && review.state === 'completed')) continue;
        if (entry.head === 1) Object.assign(entry, { work: null, head: 2, enterAt: clock.now() + reworkMs });
        else entry.deliveredAt = clock.now();
      }
      // The lingering-sessions invariant over the delivered items, their review sessions as the runtime lists them.
      const delivered = [...items].filter(([, entry]) => entry.deliveredAt !== null).map(([n, entry]) => ({ ...requested(n, 2), stage: 'done', delivery: { mergedAt: new Date(entry.deliveredAt!).toISOString() },
        sessions: ledger.filter(review => review.key === `GY-${500 + n}`).map(review => ({ id: review.id, kind: 'review', state: 'running', agentName: review.agentName, pane: review.pane })) }) as unknown as Work);
      const lingering = checkInvariants(record, { work: delivered, now: clock.now(), agents: host.agents }).find(check => check.invariant === 'lingering-sessions')!;
      const neverKey = `GY-${500 + closeNeverAccepted.n}`, neverDelivered = items.get(closeNeverAccepted.n)!.deliveredAt;
      if (!lingering.holds) {
        assert.deepEqual(lingering.subjects, [neverKey], `cycle ${cycle}: only the pane Herdr refuses to close lingers: ${lingering.reading}`);
        assert.ok(neverDelivered !== null && clock.now() - neverDelivered > invariantDefaults.sessionAfterSettleMinutes * minute);
        lingeringFrom ??= cycle;
      }
      if ([...items.values()].every(entry => entry.deliveredAt !== null)) {
        ledgers.push(await readFile(ledgerFile, 'utf8'));
        if (lingeringFrom !== null && ledgers.length > 10) break;
      }
      clock.advance(tickMs);
    }
    assert.ok(cycle < 600, 'the day settles');
    assert.deepEqual(refused, [], 'no launch was refused at the agent-name bound or otherwise');
    assert.ok(peak >= 3, `reviews ran in parallel (peak ${peak})`);
    const ledger = (await readReviewLedger(host.root)).reviews;
    assert.equal(ledger.filter(entry => entry.state === 'completed').length, 2 * total, 'every head of every item was reviewed once');
    // The pane Herdr refused once was released by the sweep; the one it never closes was tried a bounded number of times and is reported.
    assert.equal(host.closes.filter(pane => pane === neverPane).length, 1 + settledCloseAttempts, 'the settlement close and the bounded retries, nothing more');
    const held = heldNameAttention(ledger);
    assert.deepEqual(held.map(item => item.subject), [`GY-${500 + closeNeverAccepted.n}`]);
    assert.match(held[0].text, new RegExp(`in pane ${neverPane}`));
    assert.ok(lingeringFrom !== null, 'the lingering-sessions invariant names the held pane once it outlives its bound');
    // Once every request has settled, the ledger is not rewritten on later ticks.
    assert.ok(ledgers.length > 10, `the day ran on past its last delivery (${ledgers.length} quiet cycles)`);
    assert.equal(new Set(ledgers.slice(-10)).size, 1, 'no ledger churn from the refused close');
  } finally { await host.cleanup(); }
});

test('unit:soak-invariants-hold — headless approver runs through loop restarts (GY-453): each adopted and applied exactly once, lost ones retried within a bound, the run registry bounded', { timeout: 480_000 }, async () => {
  const { items, final, violations, failures, state, headless } = await simulateDay({ hours: 6, headless: true });
  const { pi, root, applied, submitted, runs, restarts, adoptedLive, adoptedEnded } = headless!;
  const keyOf = (n: number) => items[n - 1].key;
  assert.deepEqual(violations, [], 'every system invariant holds after every cycle, across every restart');
  assert.deepEqual(failures, [], 'no cycle failed');
  // Every item is delivered but the one whose approver is killed every time: its decision is escalated.
  assert.deepEqual(final.filter(item => item.stage !== 'done' || !item.delivery).map(item => item.key), [keyOf(9)]);
  // The loop restarted with runs live, and adopted both runs still live and runs that ended while unwatched.
  assert.ok(restarts >= 3 && adoptedLive > 0 && adoptedEnded > 0, `restarts ${restarts}, adopted live ${adoptedLive}, adopted ended ${adoptedEnded}`);
  // Exactly once: every submitted verdict applied once, whether its run was watched or adopted, and each on disk as applied.
  assert.ok(submitted.length >= 4, `verdicts submitted: ${submitted.length}`);
  assert.deepEqual([...applied].sort(), [...submitted].sort(), 'each submitted verdict applied exactly once');
  // Bounded per decision, lost runs included: at most maxApproverLaunches + maxLostApproverRuns runs.
  assert.ok([...runs.values()].every(count => count <= maxApproverLaunches + maxLostApproverRuns), `runs per decision: ${[...runs.values()].join(', ')}`);
  const killed = Object.values(state.approvals).find(watch => watch.work === keyOf(9))!;
  assert.equal(runs.get(killed.decision), maxApproverLaunches + maxLostApproverRuns, 'an approver killed every time is relaunched only within the bound');
  assert.deepEqual([killed.launches, killed.lostRuns, !!killed.exhaustedAt, killed.settledAt], [maxApproverLaunches, maxLostApproverRuns, true, null], 'then its decision is escalated as unjudged');
  assert.equal(final.find(item => item.key === keyOf(5))!.stage, 'done', 'an approver lost one time more than is given back still judges its decision');
  // The registry is bounded: nothing left running or watched, one directory per run, each applied
  // run recorded, and every one of them removed once past its retention.
  assert.deepEqual([pi.live(), watchedRuns(), liveRuns().length], [0, 0, 0]);
  const registry = runsDirectory(root);
  assert.equal(readdirSync(registry).length, pi.started.length);
  assert.equal(pi.started.filter(directory => existsSync(join(directory, 'record.json'))).length, pi.started.length, 'every run, lost ones included, has its record');
  pruneRunDirectories(registry, clock.now() + runDirectoryRetentionMs + hour);
  assert.deepEqual(readdirSync(registry), [], 'ended runs leave the registry once past their retention');
});

test('unit:soak-invariants-hold — sessions blocked on a GitHub credential failure are ended once each and relaunched on the retry ladder: one item recovers and is delivered, one that never recovers is held at the attempt cap, and every invariant holds', { timeout: 600_000 }, async () => {
  // GY-999: a worker whose push is refused for want of a valid GitHub login records that blocker.
  // The loop ends the attempt in the cycle that sees it — work kept, pane closed, lease released —
  // and the item is launched again with a fresh credential. The ending counts on the GY-885 retry
  // ladder: each relaunch waits its backoff, and an item whose every attempt fails that way is held
  // at the cap for an independent approver's decision instead of being ended and relaunched for ever. The ending and the relaunch run per item and per cycle, so they live here.
  const recovers = 2, never = 3;
  const { items, final, violations, failures, lost, herdrClosed, sessions, state } = await simulateDay({
    hours: 6, credentialBlocked: { recovers, never },
    plan: { items: 6, leftovers: 2, slowRecompute: 0, workMs: 15 * minute, rework: new Set(), deaths: new Set(), breaksMain: 0, infrastructure: new Set([5]), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set(), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
  });
  assert.deepEqual(violations, [], 'every system invariant holds across the credential endings and the relaunches');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost: each blocked attempt was ended by the loop');
  const recovering = items[recovers - 1], held = items[never - 1];
  assert.deepEqual(final.filter(item => item.stage !== 'done' && item.id !== held.id).map(item => `${item.key} ${item.stage}`), [], 'every other item, the recovering one included, is delivered');

  const attemptsOf = (work: Work) => sessions.filter(session => session.key === work.key);
  const endings = (work: Work) => Object.entries(state.actions).filter(([key]) => key.startsWith(`resume:credential:${work.id}:`));
  // The recovering item: two blocked attempts, each ended once, then the third delivers.
  const mine = attemptsOf(recovering);
  assert.equal(mine.length, 3, `two blocked attempts and the one that delivered: ${mine.map(session => `${session.epoch}:${session.state}`).join(', ')}`);
  assert.deepEqual(mine.slice(0, 2).map(session => session.state), ['reclaimed', 'reclaimed']);
  assert.deepEqual(endings(recovering).map(([, action]) => [action.state, action.attempts]), [['done', 1], ['done', 1]], 'each blocked attempt was ended once');
  assert.ok(mine.slice(0, 2).every(session => herdrClosed.includes(session.pane)), 'the loop closed each blocked pane');
  // The relaunches wait the ladder's backoff: 5 minutes after the first ending, 15 after the second.
  assert.ok(mine[1].dispatchAt - mine[0].dispatchAt >= 5 * minute + 5 * minute, `the second attempt waited its backoff: ${(mine[1].dispatchAt - mine[0].dispatchAt) / minute} min`);
  assert.ok(mine[2].dispatchAt - mine[1].dispatchAt >= 5 * minute + 15 * minute, `the third attempt waited its backoff: ${(mine[2].dispatchAt - mine[1].dispatchAt) / minute} min`);

  // The never-curing item: bounded at the cap, never relaunched past it while the approver's refusal stands.
  const theirs = attemptsOf(held);
  assert.equal(theirs.length, 3, `the ladder bounds the relaunches at the cap: ${theirs.map(session => `${session.epoch}:${session.state}`).join(', ')}`);
  assert.deepEqual(endings(held).map(([, action]) => [action.state, action.attempts]), [['done', 1], ['done', 1], ['done', 1]]);
  assert.match(state.actions[`retry:held:${held.id}`]?.detail ?? '', /held: 3 attempts in a row ended without submitting.*credential-blocked attempt on epoch 1.*credential-blocked attempt on epoch 3/, 'the hold names every credential failure');
  assert.ok(state.actions[`retry:cap-request:${held.id}`], 'the loop asked for the decision that alone resumes the item, rather than relaunching it');
  assert.ok(theirs.every(session => session.state === 'reclaimed'), 'no blocked session was left holding its lease');
});

test('unit:soak-invariants-hold — containment quarantines of dead workers stand across many cycles while the timed clock read fails and then answers slowly, one read a cycle and none without an assessable quarantine, each escalation recorded once, and they settle once reads are fast, with every invariant holding', { timeout: 600_000 }, async () => {
  // GY-811: every supervised launch raises a containment quarantine; two workers die, so their
  // fences outlive them and only the loop can lower them. The work snapshot takes 6 s to read, so
  // its bound is too wide to settle with — the shared cause of GY-466, GY-521 and GY-543. The
  // loop's light timed read of the plane's clock fails for the first stretch of the day, answers in
  // 6 s for the next, and only then answers fast: the fences stand, escalated once per cause, and
  // settle within a cycle or two of the fast reads. The day is short and its items released close
  // together: it runs last in the file, where each one-minute cycle costs the most (about 200 s on
  // a CI runner, so its bound is about twice that, like the regression day's), and last so that no
  // other day pays for the state it leaves.
  const failUntil = 35 * minute, slowUntil = hour, deaths = [2, 4];
  const { items, final, violations, failures, lost, escalations, fenced, cycles } = await simulateDay({
    hours: 3, containment: { failUntil, slowUntil },
    plan: { items: 6, leftovers: 2, slowRecompute: 0, releaseEveryMs: 5 * minute, workMs: 20 * minute, rework: new Set(), deaths: new Set(deaths), breaksMain: 0, infrastructure: new Set([5]), flaky: { rerunPasses: 0, rerunFails: 0 }, scoped: new Set(), misread: new Set(), exits: new Set([3]), spentProducer: 0, lostRuns: 0, outOfQueue: { item: 6, afterMs: 99 * hour }, blind: { from: 99 * hour, to: 100 * hour }, split: { at: 99 * hour, item: 6 } },
  });
  assert.deepEqual(final.filter(item => item.stage !== 'done').map(item => `${item.key} ${item.stage}: ${item.gates.flatMap(gate => gate.reasons).join('; ')}`), [], 'all six items are delivered');
  assert.deepEqual(violations, [], 'every system invariant holds while the fences stand and once they settle');
  assert.deepEqual(failures, [], 'no cycle failed');
  assert.deepEqual(lost, [], 'no lease was lost: a dead worker lapses and its fence waits for the loop');
  assert.deepEqual(final.filter(item => item.containmentQuarantine).map(item => item.key), [], 'no fence outlives the day');

  // Probe volume is bounded: at most one timed read a cycle, exactly one in each cycle with a
  // quarantine past its grace window, and none in a cycle whose quarantines are all live or still in
  // grace, or that has none (GY-1044).
  const perCycle = new Map<number, number>();
  for (const probe of fenced.probes) perCycle.set(probe.cycle, (perCycle.get(probe.cycle) ?? 0) + 1);
  assert.deepEqual([...perCycle.values()].filter(count => count > 1), [], 'never more than one timed read in a cycle');
  assert.deepEqual([...perCycle.keys()].filter(cycle => !fenced.assessable.has(cycle)), [], 'a timed read only in a cycle with an assessable quarantine');
  assert.deepEqual([...fenced.assessable].filter(cycle => !perCycle.has(cycle)), [], 'every cycle with an assessable quarantine read the clock');
  assert.ok(fenced.liveOnly.size > 30, `many cycles held only live workers' fences, and read no clock (${fenced.liveOnly.size})`);
  assert.ok(fenced.bare.size > 0, 'cycles with no fence at all read no clock');
  assert.ok(fenced.graced.size > 0, `cycles whose fences were at most in their grace window read no clock (${fenced.graced.size})`);
  const lastSettled = Math.max(...fenced.settled.map(entry => entry.elapsed));
  assert.deepEqual(fenced.probes.filter(probe => probe.elapsed > lastSettled).map(probe => probe.elapsed / minute), [], `no read after the last fence settled, for the rest of the day's ${cycles} cycles`);
  for (const phase of ['fail', 'slow', 'fast'] as const) assert.ok(fenced.probes.some(probe => probe.phase === phase), `the fences stood through ${phase} reads`);

  for (const n of deaths) {
    const key = items[n - 1].key;
    // The dead attempt's fence stood through the failing and the slow reads, refused for the
    // width of the bound the read measured, and settled once the reads were fast.
    const refused = fenced.assessed.filter(entry => entry.key === key && entry.epoch === 1 && entry.refusals.length);
    assert.ok(refused.some(entry => entry.elapsed < failUntil && entry.refusals.some(reason => /the snapshot read of the control-plane clock took \d+ms round trip/.test(reason))),
      `${key}: while the timed read failed, the snapshot's bound was refused naming its round trip: ${JSON.stringify(refused.slice(0, 2))}`);
    assert.ok(refused.some(entry => entry.elapsed >= failUntil && entry.elapsed < slowUntil && entry.refusals.some(reason => /the timed read of the control-plane clock took 6\d{3}ms round trip/.test(reason))),
      `${key}: while the timed read was slow, it was refused naming that read's round trip`);
    const settled = fenced.settled.filter(entry => entry.key === key);
    assert.equal(settled.length, 1, `${key}: the dead attempt's fence settled exactly once: ${JSON.stringify(fenced.settled)}`);
    assert.ok(settled[0].elapsed >= slowUntil && settled[0].elapsed <= slowUntil + 3 * minute, `${key}: it settled within the first cycles of fast reads (+${Math.round(settled[0].elapsed / minute)} min)`);
    // Each cause of the standing fence was escalated once: the round trip a read measured, and
    // whether the timed or the snapshot read measured it, change from cycle to cycle, and neither
    // is a new cause (GY-1044) — the failing and the slow reads are one unbounded clock.
    const escalated = escalations.filter(detail => detail.startsWith(`${key}: containment quarantine from epoch 1 `));
    assert.ok(escalated.length >= 1 && escalated.length <= 3, `${key}: the standing fence was escalated once per cause, not once per cycle: ${escalated.length}`);
    assert.ok(escalated.some(detail => /control-plane clock took \d+ms round trip/.test(detail)), `${key}: the unbounded clock was escalated: ${JSON.stringify(escalated)}`);
    assert.equal(new Set(escalated.map(containmentRefusalCause)).size, escalated.length, `${key}: no escalation repeats: ${JSON.stringify(escalated)}`);
    assert.equal(final.find(item => item.key === key)!.stage, 'done', `${key}: delivered by the attempt after the settled one`);
  }
});
