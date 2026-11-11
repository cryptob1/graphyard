export { shellQuote } from '../shell-quote.js';
// Concern: dispatching a worker — dispatchability, the worker launch, its prompt and environment.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { ChildProcessError, defaultChildRun } from '../child-runner.js';
import { discover, assertRepository } from '../onboarding.js';
import { concurrentOverlap, resourceConflicts } from '../coordination.js';
import { type SandboxExec, environmentBlocker, WorkerSandboxError, verifyWorkerSandbox, workerPaths, writablePaths, grantWorkerPaths } from '../worker-sandbox.js';
import { assertNoApprovalOptOut } from '../harness.js';
import { parkedOnHuman, humanDecisionLabel, answerCommand, dispatchHumanWait } from '../model/human-request.js';
import { supersededByObservation } from '../model/park-withdrawal.js';
import { loopOwnedRefusal } from '../model/loop-owned.js';
import { workerPreference } from '../model-boundary/worker-preference.js';
import { loopObservation, loopObservationProofs, observationWindowHold, servingReleaseProof, type Work } from '../model.js';
import type { MasterConfig, WorkerProfile } from './profiles.js';
import { runtimeLoginHomes } from './profiles.js';
import { loadMasterConfig, readWorkerCredential } from './config.js';
import { atomicPrivateWrite, readCredentialFile } from '../private-file.js';
import { credentialMaskFor, CredentialMaskError, type MaskProbe } from './confinement.js';
import { accountLaunch, agentLaunchPlan, NoHealthyAccountError, onSelectedSession, selectAccount, sharedGitDirectory } from './environments.js';
import type { FleetProbe } from '../fleet.js';
import { repinPath, type CanaryOffer } from '../model/registry.js';
import { reviewStandards } from '../review-prompt.js';
import { launcherCoordinatorRoot, preservePartialWork, prepareConfinedGitPaths, sessionConfinement } from './launch.js';
import { defaultHeadlessExec, startHeadlessWorker, type HeadlessExec } from '../headless-session.js';
import { liveRun } from '../runner/registry.js';
import { detectRuntimeExhaustion } from './runtime-prompt.js';
import { detectLoggedOut } from './logged-out.js';
import { cycleBaseTip, dependencyDirectories, failureText, shareDependencies, type SharedDependencies } from './worktrees.js';
import { humanOnlyDecisions, installWorkerHarness, prepareSessionHarness, sessionSlotsGrant, submissionPolicyRule } from './harness.js';
import { withVerificationPath } from './verification-slots.js';
import { holdRepeatedLimitAccount, repeatedLimitAccount } from './launch-account.js';
import { dispatchedFile, DispatchReservedError, profileLaunchedFile } from './dispatch-reservation.js';
import { projectMemoryDigest, type ProjectMemory } from '../model/project-memory.js';
import { readProjectMemory } from '../project-memory.js';
import { readVerificationMaps, verificationMapDigest, type VerificationMap } from '../verification-maps.js';
import { namedPaths } from '../model/documentation-glob.js';
import { appliedReworkBrief, reworkBriefSection, type AppliedRework } from './rework-brief.js';
import { workerBeforePushSection, workerFastGatesPresent } from './worker-fast-gates.js';
import { attemptBoundMs, attemptCeilingMs } from './attempt-bound.js';
import { attemptProgressWindowMs } from '../model/attempt-bound.js';

/** The launcher's own runner: the CLI as a child, and git. `stdio` is honoured for the streams a child may inherit; the rest is captured. */
type WorkerCommand = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: ('ignore' | 'pipe' | 'inherit')[] }) => string | Buffer | Promise<string | Buffer>;
/** `reclaimed` names each abandoned worktree the `worktree` command freed the branch from (GY-1078). `work` is the document the claim itself returned (GY-2956): the item as the attempt begins, fresher than the snapshot the dispatch chose from — the handoff reads the partial work a cycle's close step recorded on it. */
export type PreparedWorker = { epoch: number; path: string; base: string; branch?: string; dependencies?: SharedDependencies; reclaimed?: string[]; work?: Work };
/** Claims the item and builds its worktree; `claimBy` is a hand dispatch's claim deadline (prepareWorkerLaunch). */
/** `onClaimed` is called with the epoch the moment the claim is held, before the worktree is built (GY-1373); what it returns stops the keep-alive it started. */
/** `cycle` is the dispatch snapshot instant whose one fetch of the base branch the preparation shares (GY-1836); absent, a hand dispatch fetches for itself. */
type WorkerPreparer = (root: string, key: string, profileName: string, run?: WorkerCommand, claimBy?: number, onClaimed?: ClaimedHook, cycle?: string) => Promise<PreparedWorker>;
type ClaimedHook = (epoch: number) => (() => Promise<void>) | void;

/**
 * `sandbox` runs the launch's sandbox probe (GY-134). The worktree prepareWorkerLaunch creates is
 * always probed; a worktree an injected preparer supplies is probed only when a runner is given.
 */
export interface DispatchOptions {
  probe?: FleetProbe; sandbox?: SandboxExec;
  /** The dispatch snapshot's items and clock; the item alone and now by default. */
  allWork?: Work[]; observedAt?: string;
  /** Claims the item and builds its worktree, and hands a failed launch's claim back; prepareWorkerLaunch and releaseWorkerLaunch by default. */
  prepare?: WorkerPreparer; release?: (root: string, key: string, epoch: number, profileName: string, blocker?: string) => Promise<void>;
  /** Runs the worker's one headless child (GY-3259); spawnHeadless outside tests. */
  headless?: HeadlessExec;
  /** Records a worker run that stopped at once on its provider's limit notice on the item, as the coordinator: its handoff and the account hold. Absent, the hold is the dispatch's own start failure. */
  capacity?: (event: Record<string, unknown>) => Promise<unknown>;
  /** Overrides the credential-mask read probe (GY-3228); tests supply one. */
  maskProbe?: MaskProbe;
  /** The prompt section a run of repeated equal failures asks for (GY-3104, daemon/repeated-failure.ts). */
  diagnosis?: string;
  /** A hand dispatch's deadline on this host's clock: past it the item's backed-off dispatch row is the executor's again, so the launch claims nothing (GY-175). */
  claimBy?: number;
  /** The coordinator checkout the worker's session is confined against, for a launcher embedded outside the CLI (startAgentSession's `coordinatorRoot`). */
  coordinatorRoot?: string;
  /**
   * Renews the claimed lease while the launch prepares (GY-1287). The worktree
   * prepareWorkerLaunch creates is always kept alive (renewWorkerLaunch); a worktree an injected
   * preparer supplies is kept alive only when a renewer is given.
   */
  renew?: LeaseRenewer;
  /** How often the launch renews the lease until its supervisor takes over (launchRenewalMs). */
  renewIntervalMs?: number;
  /** Newer runtime versions this launch may run as their canary (GY-3103): a launch on one of these runtimes leads its PATH with the offer's entry, once per dispatch. */
  canaries?: CanaryOffer[];
  /** Accounts whose runtime backs off this item (GY-3103), excluded from the selection. */
  exclude?: string[];
  /** Hears the runtime each launch of this dispatch chose, so a failure backs off that runtime (GY-3103). */
  onRuntime?: (kind: string) => void;
  /** Reads the base's verification maps (GY-1495); readVerificationMaps from the coordinator checkout by default. */
  verificationMaps?: (root: string, baseBranch: string) => Promise<VerificationMap[]>;
}
/** Renews `key` epoch `epoch` under `profileName`'s credential, as the worker's own heartbeat does. */
export type LeaseRenewer = (root: string, key: string, epoch: number, profileName: string) => Promise<unknown>;
/**
 * How often a launch renews the lease it claimed while it prepares the session (GY-1287): a
 * quarter of the production 120 s lease, so two renewals may fail before it is at risk.
 */
export const launchRenewalMs = 30_000;
/**
 * The launch's own heartbeat (GY-1287). Between the claim and the watch supervisor's first
 * heartbeat the launch writes the worker's rules, mints its credential, opens its pane and waits
 * for its runtime; on a busy host that took longer than the 120 s lease, which lapsed under a
 * launch nothing had gone wrong with: the supervisor then met "Lease missing, expired, or
 * superseded", the launch failed, and the lapse stood as a lease-loss escalation. The launch
 * renews the lease from its claim until the supervisor owns the session or the launch releases
 * it. A failed renewal is not fatal here: the supervisor's own first heartbeat is the authority.
 */
export function launchLeaseKeepAlive(renew: (() => Promise<unknown>) | null, intervalMs = launchRenewalMs) {
  if (!renew) return { stop: async () => {} };
  let pending: Promise<unknown> | null = null, stopped = false;
  const beat = () => { if (!pending && !stopped) pending = renew().catch(() => {}).finally(() => { pending = null; }); };
  beat();
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  // Stopping waits out a renewal in flight, so none lands after the release that follows.
  return { stop: async () => { stopped = true; clearInterval(timer); await pending; } };
}
/** Refuses a hand launch past its `claimBy`: the item's backed-off dispatch action is the executor's again, so the launch claims nothing. */
export function assertClaimDeadline(key: string, claimBy: number | undefined, now = Date.now()) {
  if (claimBy !== undefined && now >= claimBy)
    throw new Error(`${key}: the hand launch did not reach its lease claim before the item's backed-off dispatch action is offered to the executor again, so it claims nothing; the loop's dispatcher launches the item`);
}
export const describeOverlap = (overlap: ReturnType<typeof concurrentOverlap>) => overlap.map(ahead => `${ahead.key} (${ahead.state}, ${ahead.stage}) on ${ahead.paths.join(', ')}`).join('; ');
export function assertDispatchable(work: Work, allWork: Work[], observedAt: string) {
  const now = Date.parse(observedAt);
  if (!Number.isFinite(now)) throw new Error('Dispatch requires a valid Graphyard snapshot clock');
  if (parkedOnHuman(work)) throw new Error(`${dispatchHumanWait} (${humanDecisionLabel[work.humanRequest!.kind]}); ${answerCommand(work.key, work.humanRequest!)} resumes it`);
  if (!work.criteria.length) throw new Error('Waiting on the master: writing the criteria');
  if (!work.ready || work.blocker) throw new Error('Dispatch requires released work without a blocker');
  // GY-1760: an item only the master side can satisfy is never handed to a worker — not by the
  // loop's dispatch step, not by a hand launch — whoever released it, so its master-only steps
  // never reach a worker that must block on them.
  const loopOwned = loopOwnedRefusal(work);
  if (loopOwned) throw new Error(loopOwned);
  const unfinished = work.dependencies.map(id => allWork.find(item => item.id === id)).filter(dependency => !dependency || dependency.stage !== 'done');
  if (unfinished.length) throw new Error(`Dispatch blocked by unfinished dependencies: ${unfinished.map(dependency => dependency?.key ?? 'unknown').join(', ')}`);
  if (work.lease && Date.parse(work.lease.expiresAt) > now) throw new Error(`Dispatch blocked by active owner ${work.lease.owner}`);
  if (work.submission && !work.reworkRequested) throw new Error('Dispatch requires operator-authorized rework for a submitted item');
  const conflicts = resourceConflicts(work, allWork, now);
  if (conflicts.length) throw new Error(`Dispatch blocked by exclusive resources: ${conflicts.map(conflict => `${conflict.resource} held by ${conflict.key}`).join(', ')}`);
  // GY-1698: the durable loop offers claimable work through this gate, not only through the action
  // queue's nextAction wait — a released follow-up whose reading cannot exist yet must not be claimed.
  const window = observationWindowHold(work, new Date(now));
  if (window) throw new Error(`Dispatch waits for its observation window: the reading it owes can first exist at ${window.notBefore} (${window.detail})`);
  // GY-1762: an item whose only work is the loop's own live reading has nothing a code worker can do.
  const observing = loopObservation(work, new Date(now), allWork);
  if (observing) throw new Error(`Dispatch waits for the loop's observation: ${observing.waitingFor}`);
  if (loopObservationProofs(work)) throw new Error('Dispatch refused: the loop records this item\'s reading itself and no code worker can finish it');
  // Observed-file overlap holds nothing: the merge queue and a sync round integrate whichever of
  // two overlapping items lands second. A file an item declares is an exclusive resource, held above.
}

export async function dispatchWork(root: string, work: Work, profile: WorkerProfile, options: DispatchOptions = {}) {
  const { allWork = [work], observedAt = new Date().toISOString(), prepare = prepareWorkerLaunch, release = releaseWorkerLaunch } = options;
  assertDispatchable(work, allWork, observedAt);
  const config = await loadMasterConfig(root);
  // The served repository can differ from the CLI release checkout (Huck's install).
  // Confine its Git store, not the launcher's code. Injected preparers retain the test boundary.
  const coordinatorRoot = options.coordinatorRoot ?? (prepare === prepareWorkerLaunch ? root : undefined);
  let selected: Awaited<ReturnType<typeof selectAccount>> | undefined, launched: ReturnType<typeof accountLaunch> | undefined;
  // GY-1772: which runtimes the worker is tried on first, never judged from its path lane; recorded with the selection it ordered.
  let prefer: 'fast' | 'strong' | null = null;
  let result: Awaited<ReturnType<typeof launchWorker>> | undefined;
  const startFailures: AccountStartFailure[] = [];
  // GY-3103: the canary this dispatch ran, and its start failure; a fallback launch never runs it again.
  let canary: { runtime: string; failed: string | null } | null = null;
  // The repository's true root, through the common Git directory: a coordinator checkout that is
  // itself a linked worktree still derives the root every sibling worktree sits under (GY-2959).
  const repositoryRoot = dirname(await sharedGitDirectory(root) ?? root);
  if (profile.mode === 'existing') throw new Error('Existing sessions are observable but cannot be safely adopted for new work; use a launch profile so Graphyard supervises the agent process');
  await readCredentialFile(profile.credentialFile!);
  // One headless run per profile name: a live one holds the profile (GY-3259).
  if (liveRun(profile.agentName)) throw new DispatchReservedError('profile', profile.name, `Launch profile agent name ${profile.agentName} is already running a worker; pick another profile`);
  // A profile that cannot launch without a human at its prompts is refused before any account is chosen.
  assertNoApprovalOptOut(profile.kind ?? 'unnamed', profile.approvals);
  // A rework round's grounds are read before anything is claimed, too (GY-1569).
  const rework = appliedReworkBrief(work);
  // The account is chosen before anything is claimed: a profile whose accounts are all logged out
  // or out of quota claims nothing, and the refusal names every account it skipped and why. An
  // account whose run already failed under this dispatch is passed over, so the fallback lands on
  // the next account rather than the same one again (GY-417).
  // An account this item's last launches each ended on with its limit notice is held before the
  // choice, so the attempt is routed to an eligible account rather than onto it a third time (GY-1582).
  // A hold that cannot be read or written refuses the dispatch before anything is claimed: launching
  // without it could hand the same spent account back, and the loop's retry takes it from there.
  // On the snapshot's clock, as dispatchability is judged, and the choice reads holds at the same instant.
  const holdAt = options.probe?.now?.() ?? Date.parse(observedAt), clock = { now: () => holdAt };
  await holdRepeatedLimitAccount(config, work, holdAt, { registry: options.probe?.registry }).catch((error: unknown) => {
    throw new Error(`${work.key}'s last worker launches each ended on ${repeatedLimitAccount(work, holdAt)?.account ?? 'one account'}'s limit notice, and the hold that keeps the next launch off it could not be placed: ${failureText(error).slice(0, 300)}; nothing was claimed`, { cause: error });
  });
  let startError: unknown = null;
  for (;;) {
    const accounts = profile.accounts?.length ? profile.accounts.filter(name => !startFailures.some(failure => failure.account === name)) : undefined;
    if (accounts && !accounts.length)
      throw new Error(`${describeStartFailures(startFailures, null)}; no further account of profile ${profile.name} to fall back to`, { cause: startError });
    try {
      prefer = workerPreference(work, startFailures.length);
      selected = await selectAccount(config, 'worker', accounts && accounts.length < (profile.accounts?.length ?? 0) ? { ...profile, accounts } : profile, { ...clock, ...options.probe, work: work.key, prefer, exclude: [...options.exclude ?? [], ...startFailures.map(failure => failure.account)] });
    } catch (error) {
      if (!startFailures.length || !(error instanceof NoHealthyAccountError)) throw error;
      throw new Error(`${describeStartFailures(startFailures, null)}; no further account of profile ${profile.name} could be launched: ${failureText(error).slice(0, 300)}`, { cause: error });
    }
    // The agent registry chooses from its own role order and never reads the profile's
    // `accounts`, so it can hand back the account whose run just failed. That session is given
    // back and the dispatch ends once, naming both (GY-417); the loop's retry and backoff take it from there.
    const again = selected.account && startFailures.find(failure => failure.account === selected!.account!.name);
    if (again) {
      await selected.release?.(`worker launch for ${work.key}: ${again.account} already failed to start under this dispatch`);
      throw new Error(`${describeStartFailures(startFailures, null)}; the agent registry chose ${again.account} again, so no further account of the worker role to fall back to`, { cause: startError });
    }
    // The repository root rides the choice, so an opencode launch derives its repository-tree
    // permission from the checkout the dispatch serves (GY-2959).
    const chosen = selected;
    let launch = await onSelectedSession(chosen, `worker launch for ${work.key} failed`, async () => accountLaunch(profile, chosen.account, { repositoryRoot, headless: true }));
    const offer: CanaryOffer | undefined = !canary && chosen.account && 'fleet' in chosen.account ? options.canaries?.find(entry => entry.runtime === (chosen.account as { fleet: { runtime: string } }).fleet.runtime) : undefined;
    if (offer) {
      launch = { ...launch, environment: { ...launch.environment, PATH: repinPath(launch.environment.PATH ?? '', offer.entry) } };
      canary = { runtime: offer.runtime, failed: null };
    }
    launched = launch;
    options.onRuntime?.(launch.kind ?? profile.kind ?? 'unknown');
    try {
      assertClaimDeadline(work.key, options.claimBy);
      result = await launchWorker(root, config, work, profile, launch, prepare, release, { sandboxProbe: options.sandbox ?? (prepare === prepareWorkerLaunch ? 'host' : null), claimBy: options.claimBy, coordinatorRoot,
        renew: options.renew ?? (prepare === prepareWorkerLaunch ? renewWorkerLaunch : null), renewIntervalMs: options.renewIntervalMs, verificationMaps: options.verificationMaps ?? readVerificationMaps, rework, cycle: observedAt,
        diagnosis: options.diagnosis ?? '', maskProbe: options.maskProbe, headless: options.headless ?? defaultHeadlessExec(), capacity: options.capacity });
    } catch (error) {
      // The registry session chosen for this launch never ran on; its account is free again at once.
      await chosen.release?.(`worker launch for ${work.key} failed: ${failureText(error).slice(0, 300)}`);
      // A run that ended at once on its account's limit notice or logged-out login gives way to the
      // profile's next account in this same dispatch (GY-417); a write probe diagnoses the host, never the account.
      if (!chosen.account || !(error instanceof HeadlessWorkerExit && error.moveOn)) throw error;
      startError = error;
      const failure: AccountStartFailure = { account: chosen.account.name, kind: launch.kind ?? 'unknown', reason: failureText(error).slice(0, 500), at: new Date().toISOString() };
      if (offer && canary) canary.failed = failure.reason;
      await recordAccountStartFailure(config, failure.account, failure.kind, failure.reason).catch(() => {});
      startFailures.push(failure);
      continue;
    }
    // History supports status; it never grants or reserves a slot.
    const at = new Date().toISOString();
    await mkdir(resolve(root, '.graphyard/dispatch'), { recursive: true }).catch(() => {});
    await writeFile(dispatchedFile(root, work.key), JSON.stringify({ epoch: result.epoch, at, runtime: launch.kind ?? null, account: chosen.account?.name ?? null, run: result.run }), { mode: 0o600 }).catch(() => {});
    // The dispatch record names the runtime and account the session runs on, the preference
    // that ordered the accounts (GY-1772), and every account whose run failed first (GY-417).
    await writeFile(profileLaunchedFile(root, profile.name), JSON.stringify({ key: work.key, epoch: result.epoch, agentName: profile.agentName, at,
      runtime: launch.kind ?? null, account: chosen.account?.name ?? null, prefer, ...(startFailures.length ? { failedAccounts: startFailures } : {}) }), { mode: 0o600 }).catch(() => {});
    // A start on the account clears its own run of consecutive start failures.
    if (chosen.account) await clearAccountStartFailures(config, chosen.account.name).catch(() => {});
    break;
  }
  const concurrent = concurrentOverlap(work, allWork, Date.parse(observedAt));
  // The epoch the launch claimed rides the result (GY-1791): the record the loop and every watcher
  // key by `principal:epoch` must carry the one that was claimed.
  return { work: work.key, epoch: result.epoch, run: result.run, runtime: launched?.kind ?? null, initialHead: result.initialHead, runtimeStartedAt: result.runtimeStartedAt, canary, profile: profile.name, principal: profile.principal, agentName: profile.agentName, approvals: profile.approvals,
    launch: launched?.plan ?? agentLaunchPlan(profile.kind, profile.approvals, profile.agentArgs, profile.environment), ownership: 'worker launcher claimed and is supervising the agent process', harness: result.harness, dependencies: result.dependencies, sandbox: result.sandbox, mergeWriter: result.mergeWriter, pushCredential: result.pushCredential, ...(result.reclaimed.length ? { reclaimed: result.reclaimed } : {}),
    // The selection names the preference that ordered the accounts it chose from (GY-1772).
    account: selected?.account ? { environment: selected.account.name, kind: selected.account.kind, quota: selected.health?.quota ?? null, skipped: selected.skipped, prefer } : null,
    // A dispatch whose preferred account's run failed names what happened and where the session runs
    // instead, so the fallback is on the record rather than silent (GY-417).
    fallback: selected && startFailures.length ? { failed: startFailures, note: describeStartFailures(startFailures, selected.account?.name ?? null) } : null,
    // Observed-file overlap is recorded with the dispatch, never held on: the item runs beside the
    // in-flight items that touch the same files and whichever lands second is re-integrated.
    overlap: concurrent.length ? { concurrent, note: `Dispatched beside ${describeOverlap(concurrent)}; the merge queue orders them and whichever lands second is re-integrated by base refresh, or sent back for a sync on a real conflict` } : null };
}

export const herdrAttach = (pane: string, workspace?: string | null) => `herdr pane attach ${pane}${workspace ? ` --workspace ${workspace}` : ''}`;

/**
 * One account whose runtime was launched and never came up, recorded with why (GY-417). A launch
 * that starts like this falls back to the profile's next account, so nothing else would show the
 * failure: the account, its runtime and the start refusal are what master status names.
 */
export interface AccountStartFailure { account: string; kind: string; reason: string; at: string }
const accountStartFailureSchema = z.object({ kind: z.string().min(1).max(40), failures: z.number().int().min(1), reason: z.string().min(1).max(500), at: z.string() }).strict();
const accountStartFailureLogSchema = z.object({ version: z.literal(1), accounts: z.record(z.string(), accountStartFailureSchema).default({}) }).strict();
export type AccountStartFailures = z.infer<typeof accountStartFailureLogSchema>['accounts'];
/** Beside the coordinator's other private launch state (the environment log), outside every worktree. */
export const accountStartFailurePath = (config: Pick<MasterConfig, 'credentialFile'>) =>
  resolve(dirname(config.credentialFile), `${basename(config.credentialFile).replace(/\.token$/, '')}.start-failures.json`);
/** The accounts whose runtime recently failed to start, each with its consecutive count. */
export async function readAccountStartFailures(config: Pick<MasterConfig, 'credentialFile'>): Promise<AccountStartFailures> {
  try { return accountStartFailureLogSchema.parse(JSON.parse(await readFile(accountStartFailurePath(config), 'utf8'))).accounts; }
  catch { return {}; }
}
/** Count one more consecutive start failure of `account`, replacing the stored reason and time. */
export async function recordAccountStartFailure(config: Pick<MasterConfig, 'credentialFile'>, account: string, kind: string, reason: string, now = Date.now()) {
  const log = await readAccountStartFailures(config);
  log[account] = { kind: kind.slice(0, 40), failures: (log[account]?.failures ?? 0) + 1, reason: reason.slice(0, 500), at: new Date(now).toISOString() };
  await atomicPrivateWrite(accountStartFailurePath(config), { version: 1, accounts: log });
  return log[account];
}
/** A launch on `account` started: its run of consecutive start failures is over. */
export async function clearAccountStartFailures(config: Pick<MasterConfig, 'credentialFile'>, account: string) {
  const log = await readAccountStartFailures(config);
  if (!log[account]) return;
  delete log[account];
  await atomicPrivateWrite(accountStartFailurePath(config), { version: 1, accounts: log });
}
/** The fallback line a dispatch that fell forward reads as: every account that failed, then the one launched on. */
export const describeStartFailures = (failures: readonly AccountStartFailure[], launchedOn: string | null) =>
  `${failures.map(failure => `${failure.account} failed to start: ${failure.reason}`).join('; ')}; launched on ${launchedOn ?? 'no named account'}`;
/** What a profile's last worker dispatch recorded, as master status reads it (GY-417). */
export interface ProfileLaunchRecord { key: string; epoch: number; agentName: string; at: string; runtime: string | null; account: string | null; /** Which runtimes the dispatch tried first (GY-1772); null on a record written before the preference was recorded. */ prefer: 'fast' | 'strong' | null; failedAccounts: AccountStartFailure[]; /** The attempt whose runtime session this launch resumed (GY-2971). */ resumedFrom?: number }
const profileLaunchRecordSchema = z.object({
  key: z.string().min(1), epoch: z.number().int().min(1), agentName: z.string().min(1), at: z.string().min(1),
  runtime: z.string().nullable().default(null), account: z.string().nullable().default(null), prefer: z.enum(['fast', 'strong']).nullable().default(null),
  resumedFrom: z.number().int().min(1).optional(),
  prepareMs: z.unknown().optional().transform(() => undefined), // retired (GY-2876): a record written before parses
  failedAccounts: z.array(z.object({ account: z.string().min(1), kind: z.string().min(1), reason: z.string().min(1), at: z.string().min(1) }).strict()).default([]),
}).strict();
/** The last dispatch record of each launch profile; a profile never dispatched reads as absent. */
export async function readProfileLaunchRecords(root: string, profiles: { name: string }[]): Promise<Record<string, ProfileLaunchRecord>> {
  const records: Record<string, ProfileLaunchRecord> = {};
  for (const profile of profiles) {
    try { records[profile.name] = profileLaunchRecordSchema.parse(JSON.parse(await readFile(profileLaunchedFile(root, profile.name), 'utf8'))); }
    catch { /* no launch of this profile has been recorded yet */ }
  }
  return records;
}


interface WorkerLaunchOptions { sandboxProbe: SandboxExec | 'host' | null; claimBy?: number; coordinatorRoot?: string; renew: LeaseRenewer | null; renewIntervalMs?: number; verificationMaps: NonNullable<DispatchOptions['verificationMaps']>; rework: AppliedRework | null; cycle?: string; diagnosis: string; maskProbe?: MaskProbe; headless: HeadlessExec; capacity?: DispatchOptions['capacity'] }
async function launchWorker(root: string, config: MasterConfig, work: Work, profile: WorkerProfile, launch: ReturnType<typeof accountLaunch>, prepare: WorkerPreparer, release: (root: string, key: string, epoch: number, profileName: string, blocker?: string) => Promise<void>, { sandboxProbe, claimBy, coordinatorRoot, renew, renewIntervalMs, verificationMaps, rework, cycle, diagnosis, maskProbe, headless, capacity }: WorkerLaunchOptions) {
  const mergeWriter = 'control-plane' as const;
  // The lease is the launch's to keep alive until the supervisor's first heartbeat (GY-1287), from
  // the claim itself (GY-1373): building the worktree of a large repository on a loaded host took
  // longer than the 120 s lease, which lapsed before the credential was minted ("Lease missing,
  // expired, or superseded"), and every launch of the item failed the same way. A preparer that does
  // not report its claim is kept alive from its return, as before.
  let keepAlive = null as ReturnType<typeof launchLeaseKeepAlive> | null;
  const keep = (epoch: number) => { keepAlive ??= launchLeaseKeepAlive(renew ? () => renew(root, work.key, epoch, profile.name) : null, renewIntervalMs); return () => keepAlive!.stop(); };
  let prepared: PreparedWorker;
  try { prepared = await prepare(root, work.key, profile.name, undefined, claimBy, keep, cycle); }
  catch (error) { await keepAlive?.stop(); throw error; }
  keep(prepared.epoch);
  try { return await launchPrepared(); } finally { await keepAlive?.stop(); }
  async function launchPrepared() {
    // The session has no GitHub credential and must still reach no keyring.
    const confinementCredential = { ownGitHubCredential: false, secretsBus: null };
    // The operator's credential locations are hidden from this session (GY-1856): the config home
    // wholesale, the deployment and configured mask paths, while its own token and runtime login stay.
    const credentialMask = credentialMaskFor(config, { credentialFile: profile.credentialFile, runtimeHomes: runtimeLoginHomes(launch.environment, launch.contract?.homeVariable) });
    // The worker writes its worktree, the worktree's own Git admin directory, the common Git
    // directory (GY-2977: packed-refs lock) and the shared Git paths the coordinator confinement
    // re-exposes; each is granted to the runtime's sandbox, and the grant is proved below before
    // anything starts.
    const confinementRoot = coordinatorRoot ?? launcherCoordinatorRoot();
    if (confinementRoot) prepareConfinedGitPaths(confinementRoot);
    const paths = workerPaths(prepared.path);
    // So is the host's verification lock directory, or a sandboxed worker's heavy runs go unbounded (GY-612).
    const writable = [...writablePaths({ ...paths, commonDir: paths.commonDir ?? await sharedGitDirectory(root) }), ...sessionSlotsGrant(root, config)];
    const args = grantWorkerPaths(launch.kind, launch.args, writable, prepared.path);
    // The worker's own rules go into its worktree before the session starts, so pushing its
    // branch and opening its pull request never wait on a keypress. A failure is reported, not fatal.
    const harness = await installWorkerHarness(config, { ...profile, kind: launch.kind as WorkerProfile['kind'] }, work.key, prepared).catch(error => ({ applied: false, reason: error instanceof Error ? error.message : 'Worker rules could not be written' }));
    const memory = await readProjectMemory(root).catch(() => null);
    // The area maps the plan touches (GY-1495), read from the base before the session starts.
    const maps = await verificationMaps(root, config.baseBranch).catch(() => []);
    // GY-1797: whether this checkout carries the fast gates is read here, once, and handed to the prompt as an input.
    // GY-2956: the prompt reads the claimed document when the preparer returned it, not the
    // snapshot the dispatch chose from — an attempt preserved in the same cycle is in the claim's
    // record, and a handoff built from the older copy would send the worker back to the shared base.
    const prompt = workerPrompt({ ...config, fastGates: workerFastGatesPresent(root) }, prepared.work ?? work, profile, prepared.epoch, prepared.dependencies ?? null, memory, prepared.base, maps, rework, diagnosis);
    // The worker loads its own role rules, never the master's: it may push its assigned branch.
    const sessionHarness = await prepareSessionHarness(root, config, { role: 'worker', kind: launch.kind, profile: profile.name, branch: prepared.branch ?? `graphyard/${work.key.toLowerCase()}-${prepared.epoch}`, credentialFiles: [profile.credentialFile!] });
    let sandbox: ReturnType<typeof verifyWorkerSandbox> | null = null;
    try {
      // A sandbox that cannot write them is a launch failure naming the path, not a worker that
      // fails at its first sync; the claimed item is blocked below with the probe cause.
      // The probe runs behind the same coordinator confinement the session will (GY-1321): a sandbox
      // that cannot start inside that read-only mount fails the launch naming the path it refused on.
      // The same confinement is asked whether it still reads a masked credential location (GY-3228).
      if (sandboxProbe || maskProbe) {
        const confinement = await sessionConfinement(launch.kind!, [...args, ...sessionHarness.args], { directory: prepared.path, cwd: prepared.path, environment: withVerificationPath(sessionHarness.environment, launch.environment), ...confinementCredential, credentialMask, ...(maskProbe ? { maskProbe } : {}) }, coordinatorRoot);
        if (sandboxProbe) sandbox = verifyWorkerSandbox({ ...launch, args, ...(confinement?.wrapper.length ? { confinement: confinement.wrapper } : {}) }, prepared.path, writable, sandboxProbe === 'host' ? undefined : sandboxProbe);
      }
      const initialHead = await Promise.resolve().then(() => defaultChildRun('git', ['-C', prepared.path, 'rev-parse', 'HEAD'])).then(value => /^[0-9a-f]{40,64}$/.test(String(value).trim()) ? String(value).trim() : null, () => null);
      // GY-3259: the worker is one headless run of its runtime's one-task form under `graphyard
      // watch`, which heartbeats this claim under the worker's own credential and stops the runtime
      // on lease loss. The instruction is its own first request on the command line, never pasted;
      // a worker never reaches the operator's keyring, and no Herdr pane is opened for it.
      const started = await startHeadlessWorker({ name: profile.agentName, work: work.key, subject: `${work.key}: ${work.title}`, epoch: prepared.epoch, principal: profile.principal, account: launch.account ?? null,
        kind: launch.kind!, args: [...args, ...sessionHarness.args], contract: launch.contract, credentialMask, role: sessionHarness.role, directory: prepared.path, prompt, root, exec: headless, coordinatorRoot,
        environment: { GRAPHYARD_URL: config.url, GRAPHYARD_TOKEN_FILE: profile.credentialFile!, GRAPHYARD_HOST_ID: config.hostId, ...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}), ...(process.env.DBUS_SESSION_BUS_ADDRESS ? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS } : {}), ...withVerificationPath(sessionHarness.environment, launch.environment) },
        supervisor: [process.execPath, config.cliPath, 'watch', work.key, String(prepared.epoch), '--'], timeoutMs: attemptCeilingMs(config.run) });
      if (started.ended) await settleEarlyExit(started.ended);
      return { harness, dependencies: prepared.dependencies ?? null, sandbox, run: started.id, initialHead, runtimeStartedAt: new Date().toISOString(), epoch: prepared.epoch, reclaimed: prepared.reclaimed ?? [], mergeWriter, pushCredential: 'none' as const };
    } catch (error) {
      await keepAlive?.stop();
      try { await release(root, work.key, prepared.epoch, profile.name, error instanceof CredentialMaskError ? error.message : error instanceof WorkerSandboxError ? environmentBlocker('sandbox write probe', error.runtime, error) : undefined); }
      catch (releaseError) {
        // A lease that is already gone has handed its epoch back — a run that exited released it
        // through its supervisor — so the launch's own failure is reported as it is (GY-860, GY-1287).
        if (!(releaseError instanceof Error && /Lease missing, expired, or superseded/.test(releaseError.message))) throw new Error(`${failureText(error)}; Graphyard could not release epoch ${prepared.epoch}`);
      }
      throw error;
    }
  }
  /**
   * A run that ended within its startup observation has ended its process, and its supervisor has
   * released its lease unless it completed. One that stopped on its provider's limit notice keeps its
   * work on its branch and records the handoff and the account hold on the item, and one whose agent
   * is not logged in moves on: both refuse this account so the same dispatch starts the next one.
   * One that exited 0 simply finished early; any other early exit fails the launch.
   */
  async function settleEarlyExit({ output, ok }: { output: string; ok: boolean }) {
    const notice = detectRuntimeExhaustion(output, launch.kind!, Date.now());
    if (notice) {
      const partialWork = await preservePartialWork(prepared.path, `${work.key} attempt ${prepared.epoch} stopped on its provider's limit notice`);
      await capacity?.({ event: 'exhausted', role: 'worker', epoch: prepared.epoch, profile: profile.name, account: launch.account ?? null, runtime: launch.kind ?? null,
        reason: `the headless worker stopped on its provider's limit notice: ${notice.reason}`.slice(0, 500), resetsAt: notice.resetsAt ?? null, partialWork });
      throw new HeadlessWorkerExit(`the ${launch.kind} worker stopped at once on its provider's limit notice: ${notice.reason}`, true);
    }
    if (ok) return;
    const loggedOut = detectLoggedOut(output);
    if (loggedOut) throw new HeadlessWorkerExit(`the ${launch.kind} worker exited at once: ${loggedOut}`, true);
    throw new HeadlessWorkerExit(`the ${launch.kind} worker exited at once${output.trim() ? `: ${output.trim().slice(-300)}` : ' without output'}`, false);
  }
}
/** A worker run that ended inside its startup observation; `moveOn` refuses its account so the dispatch tries the next. */
export class HeadlessWorkerExit extends Error { constructor(message: string, readonly moveOn: boolean) { super(message); } }
/**
 * Every launched session decides and acts on its own. The only way out without its result is a
 * recorded blocker that names the exact command that was blocked; a session that stops to ask for
 * confirmation or offers a menu of options is waiting on input, and the loop records it as failed.
 */
export function autonomousSession(outcome: string, blocker: string, failureException = '') {
  return `Decide and act on your own: ${outcome}. Never stop to ask a human for confirmation, never end your turn with a question, and never offer a menu of options to choose from; choose what the criteria and these instructions support and carry it out. `
    + `If a command you need is refused or cannot succeed${failureException}, ${blocker}, naming the exact command that was blocked and its error, then stop. A session that ends waiting on input is recorded as failed with that reason.`;
}
/**
 * A runtime keeps some prompts beyond every approval flag it takes — Claude Code asks before an `rm`
 * whose target it cannot resolve, even with its permission checks skipped — and a session stopped
 * on one waits for a person (GY-197). Worker and producer requests say how to never trigger it.
 */
export const destructivePromptGuidance = 'Never give rm or mv a glob or variable target outside your mktemp -d directory: the destructive-operation prompt waits for nobody. A refused cleanup of untracked files is not a blocker: leave them, git add only your own paths and submit; stop only when a refusal blocks the change. ';
/**
 * OpenCode asks before reaching any path outside its launch directory — a worker reaches one as
 * soon as it creates a second worktree (a bisect) or reads a sibling path (GY-2959) — so the
 * launch pre-grants the repository tree and the instruction names the prompt beside the rm/mv one:
 * a prompt that still appears names a path outside the repository, and Reject keeps the worker
 * inside its worktree.
 */
export const externalDirectoryPromptGuidance = 'Your launch already granted the repository tree, so an OpenCode external-directory prompt names a path outside it: Reject it and continue in your worktree. ';
export function workerPrompt(
  config: Pick<MasterConfig, 'cliPath'> & Partial<Pick<MasterConfig, 'repository' | 'run'>> & { fastGates?: boolean },
  work: Pick<Work, 'key' | 'title'> & Partial<Pick<Work, 'capacity' | 'humanRequests' | 'description' | 'criteria' | 'scenarioRequirements' | 'candidate' | 'submission' | 'pipeline' | 'lastAssignment' | 'policyRevision'>>,
  profile: Pick<WorkerProfile, 'principal'>,
  epoch: number,
  dependencies?: Pick<SharedDependencies, 'shared'> | null,
  memory?: ProjectMemory | null,
  baseSha?: string | null,
  verificationMaps?: readonly VerificationMap[] | null,
  rework?: AppliedRework | null,
  diagnosis = '',
) {
  // A session that reinstalls dependencies it already has costs the host a gigabyte per attempt,
  // so the launcher says which trees are already there rather than leaving it to be guessed.
  const installed = dependencies?.shared.length ? `The assigned worktree needs no dependency install: ${dependencies.shared.map(entry => `${entry.name} ${entry.how === 'reachable' ? 'already resolves to' : 'is shared with'} the install at ${entry.source}`).join(', ')}, for this exact lockfile. Do not install dependencies again unless you change the lockfile. ` : '';
  const memoryDigest = projectMemoryDigest(memory, 'worker', { baseSha: baseSha ?? undefined });
  const standards = reviewStandards(work);
  return `Implement ${work.key}: ${work.title}. Claimed as ${profile.principal} under lease supervision. Run node ${config.cliPath} status ${work.key} before editing. ${config.fastGates ? workerBeforePushSection(config.cliPath, work.key) : ''}Use the assigned worktree; never weaken criteria; commit on the assigned branch, and submit with node ${config.cliPath} complete ${work.key} ${epoch} --head as your last action: complete ends your lease; stop at once on lease loss (node ${config.cliPath} guide complete). `
    + attemptBoundSection(config.run, work, epoch)
    + `Do not submit trusted evidence or merge; review and producers are requested on their own. `
    + installed
    + (memoryDigest || '')
    // The maps for the areas the item's description and criteria name.
    + verificationMapDigest(verificationMaps, [...new Set([work.description ?? '', ...(work.criteria ?? []).map(criterion => criterion.text)].flatMap(namedPaths))], 'worker')
    + submissionPolicyRule
    + destructivePromptGuidance
    + externalDirectoryPromptGuidance
    + standards.simplicity
    // The reason the applied rework decision gave, so the round answers it rather than resubmitting (GY-1569).
    + reworkBriefSection(work, rework)
    // GY-3104: two equal failures in a row ask for a diagnosis, not a blind retry.
    + diagnosis
    + resumedAttempt(work)
    // GY-1726: a follow-up whose reading cannot exist yet waits for it rather than escalating.
    + (work.criteria?.some(criterion => criterion.proofs.some(servingReleaseProof)) ? `If the observation this item owes cannot exist yet (its window has not elapsed on the serving release), do not record a blocker: defer it with node ${config.cliPath} defer ${work.key} ${epoch} NOT-BEFORE REASON (NOT-BEFORE is the ISO instant the reading can first exist, at most 30 days away), which ends your lease and holds dispatch until then, then stop. ` : '')
    + `If the item cannot continue without a decision only a human may make — ${humanOnlyDecisions.join('; ')} — park it with node ${config.cliPath} park ${work.key} ${epoch} (guide park names the fields) and stop; parking ends your lease. Do not write it as a blocker. `
    // GY-3166: the reviewers' standards for this item's own criteria, known from the start of the work; only the verdict-posting text stays with the reviewer.
    + (work.criteria?.length ? `Reviewers judge your head by this checklist, with the simplicity rule above: ${standards.criteria}. ${standards.repetition}For a user-facing feature, judge: ${standards.product}` : '')
    // GY-1987: the worker judges its own diff by the reviewer's standard (graphyard review self) before it submits, so a blocking finding costs a push, not a review round.
    + `Last step before complete: check your diff against the reviewers' standards (node ${config.cliPath} review self ${work.key} prints them) and fix each BLOCKING finding you would expect. `
    + autonomousSession('implement the item, commit it and submit the head with complete --head', `record a blocker with node ${config.cliPath} blocked ${work.key} ${epoch} REASON`, ', other than a test failing only for the sandbox limitations described above');
}

/**
 * The attempt bound, named plainly so the agent plans around it (GY-2961): when its session ends,
 * that the bound extends while the worktree commits or changes files, the hard ceiling, and the
 * handoff rule. Without a claim time on the record there is no instant to name, so no section.
 */
function attemptBoundSection(run: MasterConfig['run'] | undefined, work: Partial<Pick<Work, 'lastAssignment' | 'pipeline'>>, epoch: number) {
  const claimedAt = (work.lastAssignment?.epoch === epoch ? work.lastAssignment.claimedAt : null) ?? work.pipeline?.attempts?.find(attempt => attempt.epoch === epoch)?.claimedAt ?? null;
  if (!claimedAt || !Number.isFinite(Date.parse(claimedAt))) return '';
  const claimed = Date.parse(claimedAt);
  return `Your session ends at ${new Date(claimed + attemptBoundMs(run)).toISOString()} unless it keeps making progress: the bound extends while your worktree commits or changes files (a stop needs ${Math.round(attemptProgressWindowMs / 60_000)} minutes without either past the bound), and nothing runs past ${new Date(claimed + attemptCeilingMs(run)).toISOString()}; commit forward often, and a successor receives your diff. `;
}

/** What the previous attempt left for this one: the work an exhausted session had not committed, and a human's answer. */
function resumedAttempt(work: Partial<Pick<Work, 'capacity' | 'humanRequests'>>) {
  const interrupted = work.capacity?.exhaustions.filter(entry => entry.role === 'worker').at(-1);
  // Why the attempt ended: a spent provider account, or a worker killed or gone without submitting (GY-105).
  const ended = interrupted?.cause === 'interrupted' ? `${interrupted.reason.replace(/\.\s*$/, '')}` : 'stopped when its provider account ran out of quota';
  const kept = interrupted?.partialWork.commit && interrupted.partialWork.state !== 'discarded'
    ? `The previous attempt (epoch ${interrupted.epoch}) ${ended}; its work is kept as commit ${interrupted.partialWork.commit}${interrupted.partialWork.branch ? ` on local branch ${interrupted.partialWork.branch}` : ''}${interrupted.partialWork.path ? ` (worktree ${interrupted.partialWork.path})` : ''}. Read it with git log and git show, and bring what is sound into your branch with git cherry-pick or git merge instead of redoing it. `
    : interrupted?.partialWork.state === 'discarded' ? `The previous attempt (epoch ${interrupted.epoch}) ${ended}; its uncommitted changes could not be committed and were discarded (${interrupted.partialWork.detail ?? 'no detail recorded'}), so nothing of them is left to read${interrupted.partialWork.branch ? `; its committed work is on local branch ${interrupted.partialWork.branch}` : ''}. ` : '';
  const last = work.humanRequests?.at(-1);
  const answered = last?.answer?.outcome === 'provided' ? `An earlier attempt asked the human for ${last.needed} (${humanDecisionLabel[last.kind]}); the human answered: ${last.answer.text}. Continue from that answer. ` : '';
  // GY-1815: every park withdrawn on observation carries what was observed, even after a later park was answered, so no resumed attempt parks on it again.
  const superseded = (work.humanRequests ?? []).filter(request => request.answer?.outcome === supersededByObservation).map(request => `An earlier attempt asked the human for ${request.needed} (${humanDecisionLabel[request.kind]}); the request was closed as superseded by observation, because the asked state already holds: ${request.answer!.text.replace(/^superseded-by-observation: /, '')} (recorded by ${request.answer!.by}). Continue from that observed state; do not park on the same question again. `).join('');
  return kept + answered + superseded;
}

function workerEnvironment(config: MasterConfig, profile: WorkerProfile) {
  const env: NodeJS.ProcessEnv = { ...process.env, GRAPHYARD_URL: config.url, GRAPHYARD_TOKEN_FILE: profile.credentialFile, GRAPHYARD_HOST_ID: config.hostId };
  delete env.GRAPHYARD_TOKEN; delete env.GRAPHYARD_MASTER_TOKEN; delete env.GRAPHYARD_REQUEST_ID;
  return env;
}
// A worker launch runs the Graphyard CLI to claim and to build the assigned worktree, which on a
// large repository is the slowest thing the dispatcher waits on; it is bounded well above the
// runtime bound, so a slow checkout is never mistaken for a hung one (GY-114).
export const workerLaunchTimeoutMs = 600_000;
// A `pipe` stderr is captured so a failed child's is in its error's message, where the dispatch
// classifier reads the worktree command's git text (GY-860); it is still shown, echoed on failure.
export const workerCommand: WorkerCommand = async (command, args, options = {}) => {
  try { return await defaultChildRun(command, args, { cwd: options.cwd, env: options.env, timeoutMs: workerLaunchTimeoutMs, stdout: options.stdio?.[1] === 'inherit' ? 'inherit' : 'capture', stderr: options.stdio?.[2] === 'inherit' ? 'inherit' : 'capture' }); }
  catch (error) { if (options.stdio?.[2] === 'pipe' && error instanceof ChildProcessError && error.stderr) process.stderr.write(error.stderr); throw error; }
};

/**
 * A failed `worktree` command as the launch failure: the item, the epoch, and what the command
 * wrote to stderr — the CLI's error, which carries git's — never only the command line (GY-1078).
 */
export function worktreeFailure(key: string, epoch: number, error: unknown) {
  const stderr = typeof (error as { stderr?: unknown } | null)?.stderr === 'string' ? (error as { stderr: string }).stderr.trim() : '';
  return `Worker launch failed: the worktree for ${key} epoch ${epoch} could not be created: ${stderr || failureText(error)}`;
}

/** The launch's renewal of its claim (GY-1287): the worker's own `heartbeat`, under the profile's credential. */
export async function renewWorkerLaunch(root: string, key: string, epoch: number, profileName: string, run: WorkerCommand = workerCommand) {
  const config = await loadMasterConfig(root); const profile = config.workers.find(worker => worker.name === profileName);
  if (!profile || profile.mode !== 'launch' || !profile.kind || !profile.credentialFile) throw new Error('A complete launch profile is required');
  await run(process.execPath, [config.cliPath, 'heartbeat', key, String(epoch)], { cwd: root, env: workerEnvironment(config, profile) });
}
export async function releaseWorkerLaunch(root: string, key: string, epoch: number, profileName: string, blocker?: string, run: WorkerCommand = workerCommand) {
  const config = await loadMasterConfig(root); const profile = config.workers.find(worker => worker.name === profileName);
  if (!profile || profile.mode !== 'launch' || !profile.kind || !profile.credentialFile) throw new Error('A complete launch profile is required');
  await readWorkerCredential(root, profile.credentialFile);
  await run(process.execPath, [config.cliPath, ...(blocker ? ['blocked', key, String(epoch), blocker] : ['unclaim', key, String(epoch)])], { cwd: root, env: workerEnvironment(config, profile) });
}

/**
 * `claimBy` is a hand dispatch's deadline on this host's clock (GY-175): it is checked again
 * immediately before the lease claim, after the credential read, discovery and base fetch, so a
 * backed-off dispatch row the executor may claim by then never meets a second launch at the claim.
 */
export async function prepareWorkerLaunch(root: string, key: string, profileName: string, run: WorkerCommand = workerCommand, claimBy?: number, onClaimed?: ClaimedHook, cycle?: string): Promise<PreparedWorker> {
  const config = await loadMasterConfig(root); const profile = config.workers.find(worker => worker.name === profileName);
  if (!profile || profile.mode !== 'launch' || !profile.kind || !profile.credentialFile) throw new Error('A complete launch profile is required');
  await readWorkerCredential(root, profile.credentialFile);
  const detected = await discover(root);
  if (!detected.repository) throw new Error('Worker launcher requires a recognized GitHub origin');
  assertRepository(detected.repository, config.repository);
  const env = workerEnvironment(config, profile);
  // GY-1836: the cycle's one fetch of origin, shared with every worktree the cycle prepares.
  const base = await cycleBaseTip(root, config.baseBranch, cycle, run, env);
  assertClaimDeadline(key, claimBy);
  const claim = JSON.parse(String(await run(process.execPath, [config.cliPath, 'claim', key], { cwd: root, env })));
  const claimedEpoch = Number.isSafeInteger(claim.epoch) && claim.epoch > 0 ? claim.epoch as number : null;
  let stopKeeping: (() => Promise<void>) | void = undefined;
  try {
    if (claim.lease?.owner !== profile.principal || claimedEpoch === null) throw new Error('Worker launcher acquired an unexpected assignment identity');
    stopKeeping = onClaimed?.(claimedEpoch);
    // The worktree command's stderr is captured rather than inherited, so the failure the loop
    // records names git's own error instead of only the command line that failed (GY-1078).
    const workspace = JSON.parse(String(await Promise.resolve(run(process.execPath, [config.cliPath, 'worktree', key, String(claimedEpoch), base], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }))
      .catch(error => { throw new Error(worktreeFailure(key, claimedEpoch, error)); })));
    if (!workspace.path || !isAbsolute(workspace.path)) throw new Error('Worker launcher did not receive an assigned workspace');
    // The checkout is the attempt's; the dependency tree does not have to be. Sharing is a
    // convenience for the session that follows, so a refusal is reported, never fatal.
    const dependencies: SharedDependencies = await shareDependencies(root, workspace.path).catch(error => ({ shared: [], skipped: [{ name: dependencyDirectories[0], reason: failureText(error) }] }));
    // What the command reclaimed to free the branch is carried to the dispatch record, never only
    // to its stderr, which a launch that succeeds discards (GY-1078).
    const reclaimed = Array.isArray(workspace.reclaimed) ? (workspace.reclaimed as { path?: unknown; action?: unknown }[]).map(entry => `${String(entry.path)}: ${String(entry.action)}`) : [];
    // The claim's own response is the item's document as the new attempt begins (GY-2956): the
    // prompt built from it carries the recovery details the close step recorded this same cycle,
    // which the dispatch's older snapshot copy cannot show.
    return { epoch: claimedEpoch, path: workspace.path, base, dependencies, work: claim as Work, ...(typeof workspace.branch === 'string' && workspace.branch ? { branch: workspace.branch } : {}), ...(reclaimed.length ? { reclaimed } : {}) };
  } catch (error) {
    if (claimedEpoch !== null) {
      // The keep-alive stops before the release, so no renewal races the claim being handed back.
      await stopKeeping?.();
      try { await run(process.execPath, [config.cliPath, 'unclaim', key, String(claimedEpoch)], { cwd: root, env }); }
      catch (releaseError) {
        // GY-860: the worktree command releases its own claim as a workspace failure when git
        // could not build the workspace, which hands the epoch back; a release refused because
        // that already happened changes nothing, and only one that could not reach the server wraps.
        if (releaseError instanceof Error && /Lease missing, expired, or superseded/.test(releaseError.message)) throw error;
        throw new Error(`${error instanceof Error ? error.message : 'Workspace preparation failed'}; Graphyard could not release epoch ${claimedEpoch}`);
      }
    }
    throw error;
  }
}
