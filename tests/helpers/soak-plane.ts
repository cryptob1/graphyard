import { after, before, beforeEach } from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { Store } from '../../src/store.js';
import { Engine } from '../../src/engine.js';
import { server } from '../../src/server.js';
import { type Principal, deploySmokeProof } from '../../src/model.js';
import { type MasterConfig, type WorkerProfile, atomicPrivateWrite, dispatchWork, loadMasterConfig, masterConfigSchema, setupMaster } from '../../src/master.js';
import { type CredentialMinter, MergeWriterUnreadError, readAccountStartFailures, workerLaunchStatus } from '../../src/master/dispatch.js';
import type { MergerMode } from '../../src/merger-mode.js';
import { paneSweepLimit } from '../../src/daemon/cycle-reclaim.js';
import { plannedFilesMax } from '../../src/model/scope.js';
import { type RunOptions, type RunResult, type Runner } from '../../src/runner/types.js';
import { temporaryDirectory } from './temp-dirs.js';
import { expandTypedCommand } from './launch-shell.js';
import { type BlockerClass } from '../../src/model/blocker-class.js';
import { SimulatedHerdr, clock, clockSql, hour, minute } from './soak-world.js';

/**
 * The soak's control planes and the scenario every suite stages (GY-404, split per concern by
 * GY-1363): the principals, worker profiles and master config, the day's plans, the failover
 * world, the fixture coordinator checkout, and `soakControlPlanes`, the hooks each
 * tests/soak-*.test.ts suite registers to run its days on a Postgres server of its own.
 */
export const repository = 'owner/project';
export const PROOF = 'unit:soak-behaves';
/** GY-521: a proof no producer session may run, satisfied only by the attest decision the loop requests. */
export const MANUAL = 'manual:soak-attested';
export const principals = {
  operator: { id: 'operator', role: 'admin', sessionKind: 'ai' },
  operatorAgent: { id: 'graphyard-master-operator', role: 'admin', sessionKind: 'ai' },
  approver: { id: 'graphyard-approver', role: 'admin', sessionKind: 'ai' },
  coordinator: { id: 'graphyard-master', role: 'coordinator' },
  producer: { id: 'proof-runner', role: 'producer', proofs: [PROOF] },
  // The slow-deployment day's deliveries ask for a post-deployment smoke proof (GY-1354), which only this producer may run.
  smoker: { id: 'smoke-runner', role: 'producer', proofs: [deploySmokeProof] },
} satisfies Record<string, Principal>;
export const workers: WorkerProfile[] = ['one', 'two', 'three'].map(name => ({ name, principal: `worker-${name}`, agentName: `soak-worker-${name}`, mode: 'launch', kind: 'claude', credentialFile: `/outside/${name}.token`, agentArgs: [], approvals: 'auto', environment: {} }) as WorkerProfile);
// The slow-server day's roster (GY-1286): worker capacity enough to staff every item at once.
export const extraWorkers: WorkerProfile[] = ['four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'].map(name => ({ name, principal: `worker-${name}`, agentName: `soak-worker-${name}`, mode: 'launch', kind: 'claude', credentialFile: `/outside/${name}.token`, agentArgs: [], approvals: 'auto', environment: {} }) as WorkerProfile);
/**
 * The loop's own operator-agent identity, provisioned on every control plane as onboarding does:
 * the control plane accepts the loop's rule-grounded successor re-plan only from an operator agent
 * (GY-1397), which `principals.operatorAgent`, an admin standing in for it elsewhere, is not.
 */
export const loopAgent: Principal = { id: 'graphyard-master-loop', role: 'operator-agent', sessionKind: 'ai' };
const loopAgentToken = `${loopAgent.id}-token-${'x'.repeat(32)}`;
export const everyone: Principal[] = [...Object.values(principals), ...[...workers, ...extraWorkers].map(profile => ({ id: profile.principal, role: 'worker' as const }))];
export const credentials = everyone.map(principal => ({ ...principal, token: `${principal.id}-token-${'x'.repeat(32)}` }));
export const token = (principal: Principal) => principal.id === loopAgent.id ? loopAgentToken : credentials.find(entry => entry.id === principal.id)!.token;
export const reviewerApps = [{ id: 'claude-reviewer', runtime: 'claude', appId: 55_001, botUserId: 55_002 }, { id: 'cursor-reviewer', runtime: 'cursor', appId: 66_001, botUserId: 66_002 }];
export const launcher = fileURLToPath(new URL('../../bin/graphyard.mjs', import.meta.url));
export const soakConfig: MasterConfig = masterConfigSchema.parse({ version: 1, url: 'https://graphyard.example', credentialFile: '/outside/master.token', cliPath: launcher, repository, baseBranch: 'main', githubAppId: 1234,
  hostId: 'soak-host', masterAgentName: 'graphyard-master-project', autoMerge: true, mergeMethod: 'merge', workers,
  operatorAgent: { id: principals.operatorAgent.id, credentialFile: '/outside/operator.token' }, approver: { id: principals.approver.id, credentialFile: '/outside/approver.token' },
  run: { proofWorkflow: 'acceptance.yml', intervalSeconds: 60 } });

/** The day, in simulated time from the start. */
export const start = Date.parse('2031-06-02T08:00:00Z');
/** Where the day's worker worktrees stand, as the launcher lays them out (…/.graphyard/worktrees/KEY-EPOCH, GY-980). */
export const soakWorktreeRoot = '/tmp/soak/.graphyard/worktrees';
/** The leftover panes a day other than the main one seeds (GY-842's original eight). */
export const sideDayLeftovers = 8;
export const basePlan = {
  items: 15, releaseEveryMs: 15 * minute, workMs: 20 * minute,
  // GY-842: review panes of a previous day, standing agentless with their worktrees deleted —
  // more than one pass's bound, so the drain takes several passes: derived from the bound, which
  // GY-980 raised to equal the old count and so let one pass take them all when nothing else shared it.
  leftovers: paneSweepLimit + 2,
  // GY-980: of each class a previous day left in Graphyard worktrees — an unrecorded shell, a shell
  // whose handle stayed 'running', an ended session's idle agent — this many.
  worktreeLeftovers: 2,
  rework: new Set([3, 7, 11]), deaths: new Set([5, 9]), deathAfterMs: 8 * minute,
  // GY-521: the attested item is one whose first head is review-reworked, so its unproducible
  // manual proof is the only thing standing on the fresh head.
  deploys: [2 * hour + 30 * minute, 5 * hour],
  // GY-916: the first deploy's executor restart meets a claim still held for this many passes, and
  // the loop's installed unit carries a hand-copied watchdog window too short for its interval
  // (the supervisor also restarts the loop at these offsets, before any alignment rewrites it).
  heldClaimRestarts: 3, driftedWatchdogSec: 120, loopRestarts: [1 * hour, 2 * hour],
  dirtyCheckout: { from: 4 * hour + 50 * minute, to: 6 * hour },
  // GY-866: a session outside the loop checks out another commit in the coordinator checkout, and it is put back.
  headMove: { from: 3 * hour + 20 * minute, to: 3 * hour + 40 * minute }, split: { at: 45 * minute, item: 12 }, clean: 2, unstable: 4, slowRecompute: 8, exhaustedReviewer: 6, slowObservationMs: 10 * minute, attested: 3,
  // GY-566: main rewrites the docs page item six documented itself in just as its reviewer approves
  // it; the loop routes the docs-only conflict to a docs-sync session, which resolves it in four
  // minutes. Item six hosts it because its approval lands past the day's first merges, so the base
  // move does not churn the early cadence, and the regression day reuses it.
  docsConflict: { item: 6, page: 'docs/master-agent.md', syncMs: 4 * minute },
  baseFailure: { breaks: 183 * minute, repaired: 194 * minute },
  // GY-516: a flake on an item's first head whose one rerun passes, and one whose rerun fails again.
  flaky: { rerunPasses: 10, rerunFails: 14 },
  // GY-793: item 2's worker pushes while a broken commit stands on main, so its candidate's `test`
  // run fails on the suite that commit broke; the fix lands and completes CI minutes later, and the
  // observation judges the failure a base breakage, so the control plane refreshes the candidate
  // onto the fixed tip instead of asking for the rework round the failure is not the worker's to
  // serve. The window is timed from the dispatch of the item's attempt that submits — the main day's
  // remedy item (GY-711) is item 2 too, and its first attempt blocks — so it holds only this item's
  // push: item 1's own 20-minute work puts its push after the fix, and item 3 is released long after it.
  baseBreak: { item: 2, brokenAfterMs: 1 * minute, fixedAfterMs: 4 * minute, pushAfterMs: 2 * minute },
  // GY-839: for one stretch of the day GitHub answers every open candidate's compares without a
  // usable merge base, so the landing comparison keeps the two-way endpoint diff and the base's
  // own new changes read as reverts — the reading this item fixes. The window covers the NOTICE
  // commit on main, which moves the base under candidates still open: their false landing
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
  // GY-612: the host's memory dip; only the main day carries one (memoryDay below).
  memoryDip: null as { from: number; until: number } | null,
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
  // An applied scope decision binds the approval baseline to the attempt's first pull request (the
  // requirement-review reset), so the overlay rides items that keep their pull request across their rounds.
  scoped: new Set([1, 4, 13]), scopeAfterMs: 6 * minute, misread: new Set([1, 10]), misreadAfterMs: 4 * minute,
  // A runtime that exits and leaves its pane open on a bare shell. Item eight's first attempt is
  // free to exit, its second carrying the slow-recompute head.
  exits: new Set([8]), exitAfterMs: 12 * minute,
  // GY-453, the headless day: approver runs killed from outside, by item — the first four of item 3's
  // (one more than the loop gives back), and every one of item 7's. Both are review-rework items, whose
  // decisions still go to an approver; a dead worker's lease loss no longer does, since the control
  // plane settles it itself (GY-1393).
  killedApprovers: new Map([[3, 4], [7, Number.POSITIVE_INFINITY]]),
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
export const blockedMergeItem = 6;
/** GY-711: the main day's item whose first attempt blocks on a covered scope refusal and whose second is fenced: the fault-free one. */
export const remedyItem = 2;
/**
 * GY-1092: the main day's diagnostician provider is spent from the start until past the first
 * recurring-fault item's filing, naming no reset, so the loop's first diagnoses wait the hold, one
 * probe after it is refused again, and the next probe finds the provider answering.
 */
export const diagnosisLimit = { from: 0, to: 3 * hour + 30 * minute };
export const file = (n: number) => `src/soak/item-${n}.ts`;
export const files = (n: number) => [file(n)];
export const fixture = (n: number) => `src/soak/item-${n}-fixture.ts`;

/**
 * GY-1250, the main-guard day: under GitHub delivery item `breaks`'s first merge and item
 * `abandons`'s first merge each break main's `test` though each passed CI alone; the second's
 * revert fails its own checks, and main is fixed forward by hand `fixAfterMs` after the guard gives
 * that revert up.
 */
export interface MainGuardDay { breaks: number; abandons?: number; fixAfterMs: number }
/** One diagnostician run the soak's fake started: whose, which attempt, when, and whether its provider refused it for its limit. */
export interface DiagnosisRun { subject: string; attempt: 'primary' | 'fallback'; at: number; refused: boolean }
// ---------------------------------------------------------------------------
// The failover day (GY-417): the dispatch path is the real `dispatchWork` on a real master root,
// with one launch profile whose preferred account's OpenCode runtime never comes up. Everything the
// launcher reads outside Herdr is real — the credential homes, the account ledger beside the
// coordinator's credential file, the launch records — and Herdr is this world.
// ---------------------------------------------------------------------------

/** What one real dispatch recorded, sampled the way master status reads it between cycles. */
export interface LaunchSample { key: string; failures: Awaited<ReturnType<typeof readAccountStartFailures>>; attention: Awaited<ReturnType<typeof workerLaunchStatus>> }
export type Dispatched = Awaited<ReturnType<typeof dispatchWork>>;
/** The failover day's inputs and outputs, threaded through `simulateDay` and back to the test. */
export interface Failover { root: string; master: MasterConfig; world: FailoverWorld; dispatches: Dispatched[]; samples: LaunchSample[];
  /** GY-1523: every real dispatch the launcher refused before claiming, with the day's instant and the launcher's words. */
  refused?: { key: string; at: number; error: string }[] }

/**
 * The Herdr side of the failover day: the panes the real `dispatchWork` creates live in the same
 * SimulatedHerdr the loop reads. An account whose runtime is in `broken` draws the echoed launch
 * command for ever — the runtime never comes up, and the launcher closes its pane at the start
 * bound; any other account's runtime reports ready at once. `healthyEverywhere` ends the broken
 * run, so a later launch starts on the preferred account and clears its failure count.
 */
export class FailoverWorld {
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
  /** GY-1523: how many times the real launcher read the merger — one per dispatch, before it claims, and never otherwise. */
  reads = 0;
  /** GY-1523: every push credential the real launcher minted; none under the control-plane merger. */
  minted: { key: string; epoch: number }[] = [];
  /**
   * `merger` is what the day's control plane records as its merge writer, answered to every read;
   * `unreadable` holds the ordinals (from 1) of the reads the plane fails with a 503 instead, as a
   * status read meets while the plane restarts.
   */
  constructor(private broken: Set<string>, readonly merger: MergerMode = 'github', private readonly unreadable: Set<number> = new Set()) {}
  healthyEverywhere() { this.broken.clear(); }
  /** The launcher's merger read (DispatchOptions.readMergeWriter): counted, and refused on the scheduled ordinals exactly as readMergeWriter refuses a 503. */
  readMergeWriter = async (config: MasterConfig): Promise<MergerMode> => {
    this.reads += 1;
    if (this.unreadable.has(this.reads)) throw new MergeWriterUnreadError(`${config.url}/api/status`, 'HTTP 503');
    return this.merger;
  };
  /** The launcher's push-credential minter: records the attempt it minted for and makes the credential home, as the real minter does. */
  mint: CredentialMinter = async (_root, input) => { this.minted.push({ key: input.key, epoch: input.epoch }); await mkdir(input.directory, { recursive: true }); };
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
export async function failoverInstalled() {
  const root = await temporaryDirectory('soak-master'), credentials = await temporaryDirectory('soak-credentials');
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['remote', 'add', 'origin', `https://github.com/${repository}.git`], { cwd: root });
  const coordinatorStatus = async () => new Response(JSON.stringify({ actor: { id: 'master', role: 'coordinator' }, repository, baseBranch: 'main', githubAppId: 1234 }));
  // The install's Herdr workspace is the one the world's panes live in (`w1:pN`): since GY-1441 the
  // launcher closes only panes in its own workspace, so a scope the world never serves would keep
  // every failed start's pane, and with it its epoch.
  await setupMaster(root, { url: 'https://graphyard.example', token: 'coordinator-token-'.padEnd(40, 'x'), cliPath: launcher, credentialDirectory: credentials, herdrWorkspace: 'w1' }, coordinatorStatus as typeof fetch);
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
export function diagnosisRunner(seen: DiagnosisRun[], attempt: 'primary' | 'fallback', refuses: () => boolean): Runner {
  return {
    name: 'soak-diagnostician',
    start<T>(prompt: string, options: RunOptions<T>) {
      const given = JSON.parse(prompt.slice(prompt.indexOf('{'))) as { subject: string; faultClass: string; instances: { at: string }[]; openItems: string[] };
      const refused = refuses();
      seen.push({ subject: given.subject, attempt, at: clock.now(), refused });
      // GY-1092: the provider's spent account, as Pi reports it — the run makes no call and ends on the provider's 429.
      if (refused) return { id: `soak-diagnosis-${seen.length}`, events: [], onEvent: () => () => {}, cancel() {},
        result: async (): Promise<RunResult<T>> => ({ ok: false, failure: { reason: 'no-payload', detail: 'the run ended without a graphyard_diagnose call (last error: 429: {"code":"1310","message":"Weekly/Monthly Limit Exhausted"})' }, payloads: [] }) };
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
 *
 * GY-1293: item `partial` asks a documentation page the item implies and a file nothing grounds:
 * the loop widens by the page and puts the rest to the approver against the widened revision.
 * The control plane answers the loop's first widening of `wideFinding` with a 5xx and its first of
 * `partial` with a stale-revision refusal, and `partial`'s first decision-history read outlasts the
 * decisions step's deadline: each is retried on the next cycle and none is a fault.
 */
export const scopePlan = {
  wideRule: 16, wideFinding: 17, unrepresentable: 18, partial: 19,
  partialPage: 'docs/soak-partial-19.md', partialFile: 'src/soak/ungrounded-19.ts',
  wideRuleDir: 'tests/soak-wide/', wideFindingDir: 'src/soak/extra-17/', unrepresentablePath: 'newtop-18/next.ts',
  wideRulePlanned: 20, wideRuleAsked: 90, wideFindingAsked: 100, unrepresentablePlanned: plannedFilesMax - 1,
};
export const padded = (n: number) => String(n).padStart(3, '0');

/**
 * GY-1008: the blocked day. Each of the first eight items' first attempt records one of the
 * 2026-09-30 blocker texts a few minutes in, which ends the attempt; the loop re-checks each one
 * every cycle and nobody else touches them. The credential, sandbox and control-plane probes run
 * through the real probe code and fail until their cause clears at the minute below; the
 * outside-scope failure clears once the base moves (items nine and ten land meanwhile); the
 * planned-file-scope blocker becomes a widening decision its approver judges; the needs-decision
 * blocker names a decision the master requested and never put to an approver, which the loop
 * launches. Item `repeating` blocks on every attempt, so the loop clears it `maxAutomaticClears`
 * times in a row and then leaves it to the master.
 * GY-1055: the control-plane blockers that clear on health name the whole plane (503, a refused
 * connection); item `requestError` met a 500 on its own request, which health cannot show fixed,
 * so the loop hands it to the master once and never probes it. The credential cause stands past
 * `blockerEscalateMs`, so the loop reports it to the master once and still clears it when it goes.
 */
export const blockerPlan = {
  items: 10, repeating: 7, requestError: 8, blockAfterMs: 5 * minute,
  clearsAt: { 'github-credential': 150 * minute, 'sandbox-path': 75 * minute, 'control-plane-error': 30 * minute } as Partial<Record<BlockerClass, number>>,
  classes: { 1: 'github-credential', 2: 'sandbox-path', 3: 'control-plane-error', 4: 'outside-scope-test-failure', 5: 'planned-file-scope', 6: 'needs-decision', 7: 'control-plane-error', 8: 'control-plane-error' } as Record<number, BlockerClass>,
  text: (n: number, branch: string, decision: string | null): string | null => ({
    1: "git push failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    2: `error: unable to append to '.git/logs/refs/remotes/origin/${branch}': Read-only file system`,
    3: 'graphyard complete command failed with HTTP 503 Service Unavailable',
    4: "The test suite fails in tests/shared.test.ts on the base branch, outside this item's plannedFiles",
    5: `SCOPE NEEDED: ${extraFile(5)} (https://github.com/owner/project/issues/5 explains why) for commit 8106499e9f`,
    6: `Waiting on decision ${decision}: its approver was never launched`,
    7: 'graphyard complete command failed: connect ECONNREFUSED 127.0.0.1:8787',
    8: 'graphyard complete command failed with Internal error (HTTP 500)',
  } as Record<number, string>)[n] ?? null,
};
export const extraFile = (n: number) => `src/soak/item-${n}-extra.ts`;
/** Item `unrepresentable`'s planned files: plannedFilesMax entries, none in the asked path's directories. */
export const bulk18 = [file(scopePlan.unrepresentable), ...Array.from({ length: scopePlan.unrepresentablePlanned }, (_, index) => `tests/bulk-18/bulk-${padded(index)}.test.ts`)];

/**
 * GY-888: the day's session launches are confined by the launcher's own logic, not asserted
 * beside it. Every dispatch and approver launch runs the real sessionConfinement against a
 * fixture coordinator checkout — the worker in a linked worktree under it, the approver from the
 * checkout itself, as each role really runs — and the same launch on a host that cannot build the
 * mount namespace is judged to be refused with the reason named, never started unconfined. A
 * change that drops the confinement from the per-cycle launch fails the soak, not only the unit
 * suite.
 */
export let coordinatorBase: string | null = null, coordinatorRoot: string | null = null, soakLaunches = 0;
/**
 * Fixture worktrees the day's launches take in turn (GY-957, review follow-up): every `git worktree
 * add` scans each worktree already registered on the checkout, so one fresh worktree per launch made
 * the file's cost grow with the square of its launches — about twenty minutes on a runner — while
 * the confinement it exercises costs a millisecond. The pool is wider than the sessions a day keeps
 * open at once, and each launch still confines against a real linked worktree of the checkout.
 */
export const soakWorktreePool = 16;
/** The session's own worktree: a linked worktree of the fixture checkout, as the launcher prepares them. */
export function soakSessionDirectory(): string {
  const directory = join(coordinatorRoot!, '.graphyard', 'worktrees', `wt-${soakLaunches++ % soakWorktreePool}`);
  if (existsSync(directory)) return directory;
  mkdirSync(dirname(directory), { recursive: true });
  execFileSync('git', ['-C', coordinatorRoot!, 'worktree', 'add', '--detach', '--quiet', directory, 'HEAD'], { stdio: 'ignore' });
  return directory;
}

export let pgServer: EmbeddedPostgres, pgPort: number, store: Store, engine: Engine, http: ReturnType<typeof server>, url: string;
// Every control plane the suite started, each closed before its Postgres server stops.
export const stores: Store[] = [];
export const listeners: ReturnType<typeof server>[] = [];
/**
 * A control plane on its own database of the shared Postgres server. Every test starts on a fresh
 * one (the `beforeEach` below): the loop's reconciliation and job passes read every item the
 * database holds, so on a shared plane each earlier day's items made every cycle of a later day
 * slower — the days late in the file ran past their bounds on a slow CI runner (GY-971), and the
 * whole file past the release-candidate job's 45-minute timeout (GY-1360) — and a later day's loop
 * acted on items an earlier day left open, which its own assertions never staged.
 */
export async function controlPlane(database: string) {
  await pgServer.createDatabase(database);
  const connection = `postgres://graphyard:testing-only@127.0.0.1:${pgPort}/${database}`;
  // The database reads the simulated clock: its time functions are shadowed before the schema exists.
  const setup = new pg.Client({ connectionString: connection });
  await setup.connect();
  for (const statement of clockSql) await setup.query(statement);
  // A plane starts at the simulated time the earlier days reached.
  await setup.query('UPDATE simulated_clock SET offset_ms=$1', [clock.offsetMs]);
  await setup.query(`ALTER DATABASE ${database} SET search_path = public, pg_catalog`);
  await setup.end();
  store = new Store(connection); await store.init();
  engine = new Engine(store, [15368], 120, repository); engine.submissionObserver = null;
  engine.principals = everyone; engine.reviewerApps = reviewerApps; engine.controlPlaneAppId = 1234;
  http = server(engine, credentials);
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  stores.push(store); listeners.push(http);
  await api(principals.operator, 'POST', 'operator-agents', { id: loopAgent.id, displayName: loopAgent.id, capabilities: ['policy:requirements'], scope: { repositories: [repository], workItems: ['*'] }, token: loopAgentToken, reason: 'Onboarding provisions the loop\'s operator agent' });
}
/**
 * The hooks every soak suite registers (GY-1363): its own Postgres server, the simulated clock and
 * the fixture coordinator checkout before its first day, a fresh control plane before every day,
 * and all of it stopped after its last. `portOffset` is the suite's own: two files sharing a port
 * fail in their `before` hook, and the release-candidate job runs the suites side by side.
 */
export function soakControlPlanes(suite: string, portOffset: number) {
  before(async () => {
    pgPort = Number(process.env.GRAPHYARD_TEST_PORT ?? 15438) + portOffset;
    pgServer = new EmbeddedPostgres({ databaseDir: await temporaryDirectory(suite), user: 'graphyard', password: 'testing-only', port: pgPort, persistent: false, onLog: () => {}, onError: () => {}, postgresFlags: ['-h', '127.0.0.1'] });
    await pgServer.initialise(); await pgServer.start();
    clock.install(start);
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
  after(async () => {
    clock.uninstall();
    for (const listener of listeners) await new Promise<void>(resolve => listener.close(() => resolve()));
    for (const store of stores) await store.close();
    if (pgServer) await pgServer.stop();
  });
  let planes = 0;
  beforeEach(() => controlPlane(`soak_day_${++planes}`));
}

export const id = () => randomUUID();
export async function api(principal: Principal, method: 'GET' | 'POST', path: string, body?: unknown, key: string = id()) {
  const response = await fetch(`${url}/api/${path}`, { method, headers: { Authorization: `Bearer ${token(principal)}`, 'Content-Type': 'application/json', 'Idempotency-Key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json() as any;
  if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status}): ${result?.error ?? JSON.stringify(result)}`);
  return result;
}
