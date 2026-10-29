// Concern: dispatching a worker — dispatchability, the worker launch, its prompt and environment.
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { type ChildRun, ChildProcessError, defaultChildRun } from '../child-runner.js';
import { appliedMechanicalRework, mechanicalWorkerSection, readMechanicalFixRequests, type MechanicalFixRequest } from '../mechanical-findings.js';
import { discover, assertRepository } from '../onboarding.js';
import { concurrentOverlap, resourceConflicts } from '../coordination.js';
import { type SandboxExec, WorkerSandboxError, verifyWorkerSandbox, workerPaths, writablePaths, grantWorkerPaths } from '../worker-sandbox.js';
import { assertNoApprovalOptOut } from '../harness.js';
import { parkedOnHuman, humanDecisionLabel, answerCommand, dispatchHumanWait } from '../model/human-request.js';
import { supersededByObservation } from '../model/park-withdrawal.js';
import { loopOwnedRefusal } from '../model/loop-owned.js';
import { workerPreference } from '../model/worker-preference.js';
import { loopObservation, loopObservationProofs, observationWindowHold, servingReleaseProof, type Work } from '../model.js';
import { type ConsentAnswer, type ConsentHold, consentHoldAttention, consentHoldMs, writeConsentHold } from '../consent-prompt.js';
import type { MasterConfig, WorkerProfile } from './profiles.js';
import { atomicPrivateWrite, loadMasterConfig, readCredentialFile, readWorkerCredential } from './config.js';
import type { MergerMode } from '../merger-mode.js';
import { accountLaunch, agentLaunchPlan, type EnvironmentProbe, NoHealthyAccountError, onSelectedSession, selectAccount, sharedGitDirectory } from './environments.js';
import { simplicityParagraph } from '../reviewer.js';
import { closeFailedLaunch, launcherCoordinatorRoot, launchStartMs, prepareConfinedGitPaths, sessionConfinement, type PromptDelivery, PromptNotAcceptedError, type RequestDelivery, SessionStartError, startAgentSession, type StartBounds, withLaunchClose } from './launch.js';
import { closeHerdrPane, createdHerdrTab, type HerdrAgent, herdrJson } from './herdr.js';
import { cycleBaseTip, dependencyDirectories, failureText, shareDependencies, type SharedDependencies } from './worktrees.js';
import { humanOnlyDecisions, installWorkerHarness, prepareSessionHarness, sessionSlotsGrant, submissionPolicyRule } from './harness.js';
import { withVerificationPath } from './verification-slots.js';
import { holdRepeatedLimitAccount, repeatedLimitAccount } from './launch-account.js';
import { carryTranscript, freshLaunch, readAttemptLaunch, resumeLaunchVariable, resumePlan, type AttemptLaunch } from './session-resume.js';
import { currentAgents, dispatchedFile, DispatchReservedError, launchedSinceSnapshot, profileLaunchedFile, reclaimableAgent, reserveDispatch } from './dispatch-reservation.js';
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
  probe?: EnvironmentProbe; prompt?: PromptDelivery; start?: StartBounds; sandbox?: SandboxExec;
  /** A hand dispatch's deadline on this host's clock: past it the item's backed-off dispatch row is the executor's again, so the launch claims nothing (GY-175). */
  claimBy?: number;
  /** Closes, bounded, the pane of a finished session a launch takes its profile's name back from (GY-1322); closeHerdrPane by default. */
  closePane?: (pane: string) => Promise<void>;
  /** Herdr's agents read afresh, under the profile's reservation (GY-273); the loop passes `listHerdrAgents`. */
  agents?: () => HerdrAgent[] | Promise<HerdrAgent[]>;
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
  // Planned-file overlap holds nothing: dispatch is optimistic, and the merge queue and a sync
  // round integrate whichever of two overlapping items lands second.
}

export async function dispatchWork(root: string, work: Work, profile: WorkerProfile, agents: HerdrAgent[], run?: ChildRun, allWork: Work[] = [work], prepare: WorkerPreparer = prepareWorkerLaunch, release: (root: string, key: string, epoch: number, profileName: string) => Promise<void> = releaseWorkerLaunch, agentTimeoutMs?: number, observedAt = new Date().toISOString(), options: DispatchOptions = {}) {
  assertDispatchable(work, allWork, observedAt);
  const config = await loadMasterConfig(root);
  // GY-1523: a worker is launched with no push credential and no keyring proxy: the control plane is the only merge writer.
  const mergeWriter: MergerMode = 'control-plane';
  let round: ReworkRound;
  let target = agents.find(agent => agent.name === profile.agentName);
  let selected: Awaited<ReturnType<typeof selectAccount>> | undefined, launched: ReturnType<typeof accountLaunch> | undefined, relaunched = 0;
  // GY-1772: which runtimes the worker is tried on first, never judged from its path lane; recorded with the selection it ordered.
  let prefer: 'fast' | 'strong' | null = null;
  let harness: Awaited<ReturnType<typeof installWorkerHarness>> | null = null;
  let dependencies: PreparedWorker['dependencies'] | null = null, reclaimed: string[] = [];
  let delivery: RequestDelivery | null = null, sandbox: ReturnType<typeof verifyWorkerSandbox> | null = null;
  let started: 'started' | 'awaiting consent' = 'started', consent: { answered: ConsentAnswer[]; awaiting: ConsentHold | null } = { answered: [], awaiting: null };
  let pushCredential: 'minted' | 'none' = 'none';
  // The epoch the launch claimed, hoisted for the result: the registration's id is guessed from the
  // snapshot before the claim, and the caller re-keys the record onto this one (GY-1791).
  let claimedEpoch: number | undefined;
  const startFailures: AccountStartFailure[] = [];
  let closedAgent: string | null = null;
  // GY-2971: the item's last launch on this host, whose runtime session the next attempt may resume.
  let resumed: { session: string | null; resumedFrom: number | null; path: string } | null = null;
  const previous = await readAttemptLaunch(root, work.key);
  // The repository's true root, through the common Git directory: a coordinator checkout that is
  // itself a linked worktree still derives the root every sibling worktree sits under (GY-2959).
  const repositoryRoot = dirname(await sharedGitDirectory(root) ?? root);
  if (profile.mode === 'existing') {
    if (!target) throw new Error('Existing worker is not visible in Herdr');
    throw new Error('Existing sessions are observable but cannot be safely adopted for new work; use a launch profile so Graphyard supervises the agent process');
  } else {
    await readCredentialFile(profile.credentialFile!);
    const now = Date.parse(observedAt);
    if (target && !reclaimableAgent(profile, target, allWork, now)) throw new DispatchReservedError('profile', profile.name, 'Launch profile agent name is already visible in Herdr');
    // A profile that cannot launch without a human at its prompts is refused before any account is chosen.
    assertNoApprovalOptOut(profile.kind ?? 'unnamed', profile.approvals);
    // A rework round's grounds are read before anything is claimed, too (GY-1569).
    round = await reworkRound(root, work);
    // The profile and the item are reserved before anything is claimed, and Herdr's agents are read
    // again under the reservation: the snapshot this dispatcher chose from may already be stale (GY-273).
    const unreserve = await reserveDispatch(root, work, profile, observedAt);
    try {
      const visible = (await currentAgents(root, profile, agents, observedAt, run, options.agents)).find(agent => agent.name === profile.agentName);
      if (visible && (!reclaimableAgent(profile, visible, allWork, now) || await launchedSinceSnapshot(root, profile, allWork)))
        throw new DispatchReservedError('profile', profile.name, `Launch profile agent name ${profile.agentName} is already visible in Herdr; pick another profile`);
      // GY-1322: a finished session no live assignment owns holds the name and nothing else; it is
      // closed, bounded, and the launch goes on as on a profile with no agent.
      if (visible) {
        try { await (options.closePane ?? (pane => closeHerdrPane(pane, run)))(visible.pane_id!); }
        catch (error) { throw new Error(`Herdr agent ${visible.name} is ${visible.agent_status} with no live assignment, and its bounded close failed: ${failureText(error).slice(0, 300)}; remedy: close pane ${visible.pane_id} on the host (herdr pane close ${visible.pane_id}) or relaunch Herdr`, { cause: error }); }
        closedAgent = `${visible.name} (${visible.agent_status}, pane ${visible.pane_id})`;
        target = undefined;
      }
      // The account is chosen before anything is claimed: a profile whose accounts are all logged out
      // or out of quota claims nothing, and the refusal names every account it skipped and why. An
      // account whose runtime already failed to start under this dispatch is passed over, so the
      // fallback lands on the next account rather than the same one again (GY-417).
      // An account this item's last launches each ended on with its limit notice is held before the
      // choice, so the attempt is routed to an eligible account rather than onto it a third time (GY-1582).
      // A hold that cannot be read or written refuses the dispatch before anything is claimed: launching
      // without it could hand the same spent account back, and the loop's retry takes it from there.
      // On the snapshot's clock, as dispatchability is judged, and the choice reads holds at the same instant.
      const holdAt = options.probe?.now?.() ?? Date.parse(observedAt), clock = { now: () => holdAt };
      await holdRepeatedLimitAccount(config, work, holdAt, {}).catch((error: unknown) => {
        throw new Error(`${work.key}'s last worker launches each ended on ${repeatedLimitAccount(work, holdAt)?.account ?? 'one account'}'s limit notice, and the hold that keeps the next launch off it could not be placed: ${failureText(error).slice(0, 300)}; nothing was claimed`, { cause: error });
      });
      let startError: unknown = null;
      for (;;) {
        const accounts = profile.accounts?.length ? profile.accounts.filter(name => !startFailures.some(failure => failure.account === name)) : undefined;
        if (accounts && !accounts.length)
          throw new Error(`${describeStartFailures(startFailures, null)}; no further account of profile ${profile.name} to fall back to`, { cause: startError });
        try {
          prefer = workerPreference(work, startFailures.length);
          selected = await selectAccount(config, 'worker', accounts && accounts.length < (profile.accounts?.length ?? 0) ? { ...profile, accounts } : profile, { ...clock, ...options.probe, work: work.key, prefer, exclude: startFailures.map(failure => failure.account) });
        } catch (error) {
          if (!startFailures.length || !(error instanceof NoHealthyAccountError)) throw error;
          throw new Error(`${describeStartFailures(startFailures, null)}; no further account of profile ${profile.name} could be launched: ${failureText(error).slice(0, 300)}`, { cause: error });
        }
        // The agent registry chooses from its own role order and never reads the profile's
        // `accounts`, so it can hand back the account whose runtime just failed. That session is
        // given back and the dispatch ends once, naming both, rather than relaunching the same
        // runtime again (GY-417); the loop's retry and backoff take it from there.
        const again = selected.account && startFailures.find(failure => failure.account === selected!.account!.name);
        if (again) {
          await selected.release?.(`worker launch for ${work.key}: ${again.account} already failed to start under this dispatch`);
          throw new Error(`${describeStartFailures(startFailures, null)}; the agent registry chose ${again.account} again, so no further account of the worker role to fall back to`, { cause: startError });
        }
        // The Git directories the worker writes are granted once its worktree exists (launchWorker).
        // A launch refused for its effective arguments gives the chosen session back at once (GY-184).
        // The repository root rides the choice, so an opencode launch derives its repository-tree
        // permission from the checkout the dispatch serves (GY-2959).
        const chosen = selected;
        const launch = await onSelectedSession(chosen, `worker launch for ${work.key} failed`, async () => accountLaunch(profile, chosen.account, { repositoryRoot }));
        launched = launch;
        // A prompt the runtime never accepted closes the session and releases the claim; the launch is
        // then made once more from a fresh claim, rather than leaving an idle session holding the item.
        try {
          for (let attempt = 1; ; attempt++) {
            try {
              assertClaimDeadline(work.key, options.claimBy);
              let epoch: number;
              ({ target, harness, dependencies, delivery, sandbox, started, consent, epoch, reclaimed, pushCredential, resumed } = await launchWorker(root, config, work, profile, launch, run, prepare, release, agentTimeoutMs, options.prompt, options.start, options.sandbox ?? (prepare === prepareWorkerLaunch ? 'host' : null), options.claimBy, options.coordinatorRoot, options.renew ?? (prepare === prepareWorkerLaunch ? renewWorkerLaunch : null), options.renewIntervalMs, options.verificationMaps, mergeWriter, round, observedAt, previous));
              claimedEpoch = epoch;
              // The epoch this launch claimed outlives the reservation, so a dispatcher still holding the older snapshot is refused cleanly.
              const at = new Date().toISOString();
              // It also names the runtime session the next attempt may resume (GY-2971).
              await writeFile(dispatchedFile(root, work.key), JSON.stringify({ epoch, at, runtime: launch.kind ?? null, account: chosen.account?.name ?? null, ...resumed }), { mode: 0o600 }).catch(() => {});
              // The dispatch record names the runtime and account the session runs on, the preference
              // that ordered the accounts (GY-1772), every account whose runtime failed to start
              // first, so a slot running one runtime under a profile named for another is on the
              // record, not a surprise (GY-417).
              await writeFile(profileLaunchedFile(root, profile.name), JSON.stringify({ key: work.key, epoch, agentName: profile.agentName, at,
                runtime: launch.kind ?? null, account: chosen.account?.name ?? null, prefer, ...(resumed?.resumedFrom ? { resumedFrom: resumed.resumedFrom } : {}), ...(startFailures.length ? { failedAccounts: startFailures } : {}) }), { mode: 0o600 }).catch(() => {});
              // A start on the account clears its own run of consecutive start failures.
              if (chosen.account) await clearAccountStartFailures(config, chosen.account.name).catch(() => {});
              break;
            } catch (error) {
              if (error instanceof PromptNotAcceptedError && attempt < 2) { relaunched++; continue; }
              // The registry session chosen for this launch never ran; its account is free again at once.
              await chosen.release?.(`worker launch for ${work.key} failed: ${failureText(error).slice(0, 300)}`);
              throw error;
            }
          }
        } catch (error) {
          // The chosen account's runtime never came up — refused at the bound as never started, or
          // still starting at the ceiling: its pane is closed and its claim released, so the
          // profile's next account takes the launch rather than the dispatch dying silently (GY-417).
          // GY-1746: a Pi launch refused before its session started — the sandbox probe failing, or the host unable to confine it — likewise moves the same dispatch to the next account.
          const piRefused = launch.kind === 'pi' && (error instanceof WorkerSandboxError || /never starts a session unconfined|cannot be launched/.test(failureText(error)));
          if (!chosen.account || !(piRefused || error instanceof SessionStartError && ['never started', 'still starting', ...launch.kind === 'pi' ? ['exited'] : []].includes(error.startCase))) throw error;
          startError = error;
          const failure: AccountStartFailure = { account: chosen.account.name, kind: launch.kind ?? 'unknown', reason: failureText(error).slice(0, 500), at: new Date().toISOString() };
          await recordAccountStartFailure(config, failure.account, failure.kind, failure.reason).catch(() => {});
          startFailures.push(failure);
          continue;
        }
        break;
      }
    } finally { await unreserve(); }
  }
  const concurrent = concurrentOverlap(work, allWork, Date.parse(observedAt));
  // The epoch the launch claimed rides the result (GY-1791): the launcher registered the session
  // before the claim under its snapshot's `epoch + 1`, and a dispatch that claims again after its
  // first runtime refused the prompt claims a later epoch — the record the loop, the resume fence
  // and every watcher key by `principal:epoch` must carry the one that was claimed, so the caller
  // re-keys the registration once the claim is known.
  return { work: work.key, epoch: claimedEpoch, profile: profile.name, principal: profile.principal, agentName: profile.agentName, pane: target.pane_id ?? null, approvals: profile.approvals,
    launch: launched?.plan ?? agentLaunchPlan(profile.kind, profile.approvals, profile.agentArgs, profile.environment), ownership: 'worker launcher claimed and is supervising the agent process', harness, dependencies, delivery, sandbox, mergeWriter, pushCredential, ...(reclaimed.length ? { reclaimed } : {}), ...(closedAgent ? { closedAgent } : {}),
    // `awaiting consent` is not a started session: the runtime has not read its request (GY-130).
    // Whether the attempt resumed the previous attempt's runtime session (GY-2971).
    resumedFrom: resumed?.resumedFrom ?? null,
    started, consent: { answered: consent.answered, awaiting: consent.awaiting ? { prompt: consent.awaiting.prompt, kind: consent.awaiting.kind, pane: consent.awaiting.pane, attach: consent.awaiting.attach, releaseAt: consent.awaiting.releaseAt, attention: consentHoldAttention(consent.awaiting) } : null },
    // The selection names the preference that ordered the accounts it chose from (GY-1772).
    account: selected?.account ? { environment: selected.account.name, kind: selected.account.kind, quota: selected.health?.quota ?? null, skipped: selected.skipped, prefer } : null, relaunched,
    // A dispatch whose preferred account's runtime never started names what happened and where the
    // session runs instead, so the fallback is on the record rather than silent (GY-417).
    fallback: selected && startFailures.length ? { failed: startFailures, note: describeStartFailures(startFailures, selected.account?.name ?? null) } : null,
    // Planned-file overlap is recorded with the dispatch, never held on: the item runs beside the
    // in-flight items that touch the same files and whichever lands second is re-integrated.
    overlap: concurrent.length ? { concurrent, note: `Dispatched beside ${describeOverlap(concurrent)}; the merge queue orders them and whichever lands second is re-integrated by base refresh, or sent back for a sync on a real conflict` } : null };
}

/**
 * GY-971. Whether this attempt is a mechanical-fix round: only a rework of a submitted candidate can
 * be, and only when the item's last applied rework was that round's; the review ledger's plans are
 * read only then. Any other rework round carries the last rework's reason as its brief (GY-1569).
 */
export type ReworkRound = { mechanical: { requests: MechanicalFixRequest[]; reviewId: number } | null; rework: AppliedRework | null };
async function reworkRound(root: string, work: Work): Promise<ReworkRound> {
  if (!work.submission) return { mechanical: null, rework: null };
  const reviewId = work.candidate ? appliedMechanicalRework(work) : null;
  if (reviewId !== null) return { mechanical: { requests: await readMechanicalFixRequests(root), reviewId }, rework: null };
  return { mechanical: null, rework: appliedReworkBrief(work) };
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

export function consentHold(config: Pick<MasterConfig, 'herdrWorkspace'>, key: string, epoch: number, agentName: string, pane: string, awaiting: { prompt: string; kind: ConsentHold['kind']; request?: string | null; named?: boolean }, now = Date.now()): ConsentHold {
  return { key, epoch, agentName, pane, attach: herdrAttach(pane, config.herdrWorkspace), prompt: awaiting.prompt, kind: awaiting.kind, since: new Date(now).toISOString(), releaseAt: new Date(now + consentHoldMs).toISOString(), ...(awaiting.request ? { request: awaiting.request } : {}), ...(awaiting.named === false ? { named: false } : {}) };
}

async function launchWorker(root: string, config: MasterConfig, work: Work, profile: WorkerProfile, launch: ReturnType<typeof accountLaunch>, run: ChildRun | undefined, prepare: WorkerPreparer, release: (root: string, key: string, epoch: number, profileName: string) => Promise<void>, agentTimeoutMs: number | undefined, delivery?: PromptDelivery, start?: StartBounds, sandboxProbe: SandboxExec | 'host' | null = null, claimBy?: number, coordinatorRoot?: string, renew: LeaseRenewer | null = null, renewIntervalMs?: number, verificationMaps: NonNullable<DispatchOptions['verificationMaps']> = readVerificationMaps, mergeWriter: MergerMode = 'control-plane', round: ReworkRound = { mechanical: null, rework: null }, cycle?: string, previous: AttemptLaunch | null = null) {
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
    // The worker writes its worktree, the worktree's own Git admin directory and the shared Git
    // paths the coordinator confinement re-exposes — never the common Git directory itself (GY-1321);
    // each is granted to the runtime's sandbox, and the grant is proved below before anything starts.
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
    // A mechanical-fix round (GY-971) is told exactly which findings its one commit fixes; any other
    // rework round, the reason of the decision that sent it back (GY-1569), read before the claim.
    const { mechanical, rework } = round;
    // The area maps the plan touches (GY-1495), read from the base before the session starts.
    const maps = await verificationMaps(root, config.baseBranch).catch(() => []);
    // GY-1797: whether this checkout carries the fast gates is read here, once, and handed to the prompt as an input.
    // GY-2956: the prompt reads the claimed document when the preparer returned it, not the
    // snapshot the dispatch chose from — an attempt preserved in the same cycle is in the claim's
    // record, and a handoff built from the older copy would send the worker back to the shared base.
    const prompt = workerPrompt({ ...config, fastGates: workerFastGatesPresent(root) }, prepared.work ?? work, profile, prepared.epoch, prepared.dependencies ?? null, memory, prepared.base, mechanical, maps, rework);
    // The worker loads its own role rules, never the master's: it may push its assigned branch.
    const sessionHarness = await prepareSessionHarness(root, config, { role: 'worker', kind: launch.kind, profile: profile.name, branch: prepared.branch ?? `graphyard/${work.key.toLowerCase()}-${prepared.epoch}`, credentialFiles: [profile.credentialFile!] });
    let pane: string | undefined, tabId: string | undefined, sandbox: ReturnType<typeof verifyWorkerSandbox> | null = null;
    try {
      // A sandbox that cannot write them is a launch failure naming the path, not a worker that
      // fails at its first sync; the claim is released below like any other failed launch.
      // The probe runs behind the same coordinator confinement the session will (GY-1321): a sandbox
      // that cannot start inside that read-only mount fails the launch naming the path it refused on.
      if (sandboxProbe) {
        const confinement = await sessionConfinement(launch.kind!, [...args, ...sessionHarness.args], { directory: prepared.path, cwd: prepared.path, ...confinementCredential }, coordinatorRoot);
        sandbox = verifyWorkerSandbox({ ...launch, args, ...(confinement?.wrapper.length ? { confinement: confinement.wrapper } : {}) }, prepared.path, writable, sandboxProbe === 'host' ? undefined : sandboxProbe);
      }
      const tabArgs = ['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', prepared.path, '--label', `${work.key} · ${profile.agentName}`, '--env', `GRAPHYARD_URL=${config.url}`, '--env', `GRAPHYARD_TOKEN_FILE=${profile.credentialFile}`, '--env', `GRAPHYARD_HOST_ID=${config.hostId}`, '--env', `GRAPHYARD_HERDR_AGENT_KIND=${launch.kind}`, ...(process.env.XDG_RUNTIME_DIR ? ['--env', `XDG_RUNTIME_DIR=${process.env.XDG_RUNTIME_DIR}`] : []), ...(process.env.DBUS_SESSION_BUS_ADDRESS ? ['--env', `DBUS_SESSION_BUS_ADDRESS=${process.env.DBUS_SESSION_BUS_ADDRESS}`] : []), ...Object.entries(withVerificationPath(sessionHarness.environment, launch.environment)).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'];
      // GY-2971: the previous attempt's runtime session is resumed when this launch runs on the same
      // runtime and account and that attempt recorded its id; the brief is the same complete brief, so
      // only the conversation carries over. Otherwise the launch is fresh, and the log says why.
      const log = start?.log ?? ((line: string) => process.stderr.write(`${line}\n`));
      let plan = resumePlan(previous, { kind: launch.kind, account: launch.account });
      if (plan.resume) {
        log(`graphyard: ${work.key} attempt ${prepared.epoch} resumes attempt ${plan.from}'s ${launch.kind} session ${plan.session}`);
        await carryTranscript(launch.kind, launch.environment, plan.session, previous?.path, prepared.path);
      } else if (plan.why) log(`graphyard: ${work.key} attempt ${prepared.epoch} launches a fresh session: ${plan.why}`);
      // The instruction is the session's own first request, on the runtime's command line under
      // the supervisor, read from the request file in the worktree (GY-121); only a runtime without
      // that contract is prompted after.
      // A worker never reaches the operator's keyring, minted credential or not (GY-999, GY-1039): one
      // launched without a minter has no GitHub credential at all, never the host's login.
      const open = async () => {
        const created = createdHerdrTab(await herdrJson(plan.resume ? [...tabArgs.slice(0, -1), '--env', `${resumeLaunchVariable}=1`, '--no-focus'] : tabArgs, run)); pane = created.pane; tabId = created.tab;
        return startAgentSession(profile.agentName, launch.kind!, pane, [...args, ...plan.args, ...sessionHarness.args], prompt, run,
          { ...delivery, ...start, timeoutMs: start?.timeoutMs ?? agentTimeoutMs ?? launchStartMs(config), directory: prepared.path, cwd: prepared.path, role: sessionHarness.role, prefix: [process.execPath, config.cliPath, 'watch', work.key, String(prepared.epoch), '--'], holdConsent: true, contract: launch.contract, environment: launch.environment, ...confinementCredential, ...(coordinatorRoot ? { coordinatorRoot } : {}) });
      };
      let started: Awaited<ReturnType<typeof open>>;
      try { started = await open(); }
      catch (error) {
        // A resume that exits or never comes up within its start bound closes its pane and launches
        // the same attempt fresh, under the lease it already holds.
        if (!plan.resume || !(error instanceof SessionStartError)) throw error;
        await closeFailedLaunch(pane, tabId, run);
        pane = tabId = undefined;
        plan = freshLaunch(launch.kind, `the resume of attempt ${plan.from}'s session failed at start (${error.startCase}): ${failureText(error).slice(0, 300)}`);
        log(`graphyard: ${work.key} attempt ${prepared.epoch} launches a fresh session: ${plan.why}`);
        started = await open();
      }
      // A worker stopped on a prompt the launcher does not answer is held for a human rather than
      // closed: its record beside the launch files is what master status raises and what the watch
      // supervisor bounds, releasing the slot once `consentHoldMs` passes with the prompt unanswered.
      const hold = started.awaiting ? consentHold(config, work.key, prepared.epoch, profile.agentName, pane!, started.awaiting) : null;
      if (hold) writeConsentHold(started.files.stem, hold);
      return { target: { name: profile.agentName, pane_id: pane, agent_status: hold ? 'blocked' : 'working', cwd: prepared.path } as HerdrAgent, harness, dependencies: prepared.dependencies ?? null, delivery: started.delivery, sandbox,
        started: started.started.state, consent: { answered: started.consent, awaiting: hold }, epoch: prepared.epoch, reclaimed: prepared.reclaimed ?? [], mergeWriter, pushCredential: 'none' as const,
        resumed: { session: plan.session, resumedFrom: plan.resume ? plan.from : null, path: prepared.path } };
    } catch (error) {
      const malformedTab = (error as any)?.herdrTab as string | undefined;
      const failed = error instanceof Error ? error.message : 'Worker launch failed';
      // A failed launch closes its pane — a watch supervisor already running there ends with it — and releases the claim.
      if (pane || tabId || malformedTab) {
        let note: string;
        try { note = await closeFailedLaunch(pane, tabId ?? malformedTab, run); }
        catch { throw new Error(`${failed}; Herdr could not confirm pane shutdown, so Graphyard retained epoch ${prepared.epoch}`); }
        withLaunchClose(error, `${note} before epoch ${prepared.epoch} was released`);
      }
      await keepAlive?.stop();
      try { await release(root, work.key, prepared.epoch, profile.name); }
      catch (releaseError) {
        // A lease that is already gone has handed its epoch back: nothing is stranded, so the
        // launch's own failure is reported as it is, as the worktree path does (GY-860, GY-1287).
        if (!(releaseError instanceof Error && /Lease missing, expired, or superseded/.test(releaseError.message))) throw new Error(`${failed}; the pane was stopped but Graphyard could not release epoch ${prepared.epoch}`);
      }
      throw error;
    }
  }
}
/**
 * Every launched session decides and acts on its own. The only way out without its result is a
 * recorded blocker that names the exact command that was blocked; a session that stops to ask for
 * confirmation or offers a menu of options is waiting on input, and the loop records it as failed.
 */
export function autonomousSession(outcome: string, blocker: string) {
  return `Decide and act on your own: ${outcome}. Never stop to ask a human for confirmation, never end your turn with a question, and never offer a menu of options to choose from; choose what the criteria and these instructions support and carry it out. `
    + `If a command you need is refused or cannot succeed, ${blocker}, naming the exact command that was blocked and its error, then stop. A session that ends waiting on input is recorded as failed with that reason.`;
}
/**
 * A runtime keeps some prompts beyond every approval flag it takes — Claude Code asks before an `rm`
 * whose target it cannot resolve, even with its permission checks skipped — and a session stopped
 * on one waits for a person (GY-197). Worker and producer requests say how to never trigger it.
 */
export const destructivePromptGuidance = 'Avoid any command that triggers your runtime\'s destructive-operation prompt, which waits for a person and no person will answer it: never give rm or mv a glob or a variable as its target (such as DIR/* or "$DIR") outside a directory you created yourself with mktemp -d. Name explicit paths inside your worktree instead, and for scratch files create a directory with mktemp -d and remove only that directory by its exact path. ';
/**
 * OpenCode asks before reaching any path outside its launch directory — a worker reaches one as
 * soon as it creates a second worktree (a bisect) or reads a sibling path (GY-2959) — so the
 * launch pre-grants the repository tree and the instruction names the prompt beside the rm/mv one:
 * a prompt that still appears names a path outside the repository, and Reject keeps the worker
 * inside its worktree.
 */
export const externalDirectoryPromptGuidance = 'Your launch has already granted the repository tree, so an OpenCode external-directory prompt names a path outside the repository: choose its Reject and continue with explicit paths inside your assigned worktree. ';
/**
 * A worker that asked to rewrite a wrong commit waited on the master to say "fix forward" (GY-1477,
 * GY-1567): rewriting the assigned branch is never granted, so the request says so.
 */
export const branchRewriteGuidance = 'Never rewrite the assigned branch: fix a wrong commit forward with a new commit. ';
export function workerPrompt(
  config: Pick<MasterConfig, 'cliPath'> & Partial<Pick<MasterConfig, 'repository' | 'run'>> & { fastGates?: boolean },
  work: Pick<Work, 'key' | 'title'> & Partial<Pick<Work, 'capacity' | 'humanRequests' | 'description' | 'criteria' | 'candidate' | 'submission' | 'pipeline' | 'lastAssignment'>>,
  profile: Pick<WorkerProfile, 'principal'>,
  epoch: number,
  dependencies?: Pick<SharedDependencies, 'shared'> | null,
  memoryOrMechanical?: ProjectMemory | { requests: readonly MechanicalFixRequest[]; reviewId: number } | null,
  baseShaOrMechanical?: string | { requests: readonly MechanicalFixRequest[]; reviewId: number } | null,
  mechanicalOpt?: { requests: readonly MechanicalFixRequest[]; reviewId: number } | null,
  verificationMaps?: readonly VerificationMap[] | null,
  rework?: AppliedRework | null,
) {
  let memory: ProjectMemory | null = null;
  let baseSha: string | undefined = undefined;
  let mechanical: { requests: readonly MechanicalFixRequest[]; reviewId: number } | null = null;

  if (memoryOrMechanical && 'requests' in memoryOrMechanical) {
    mechanical = memoryOrMechanical;
  } else {
    memory = (memoryOrMechanical as ProjectMemory | null) ?? null;
  }

  if (baseShaOrMechanical && typeof baseShaOrMechanical === 'object' && 'requests' in baseShaOrMechanical) {
    mechanical = baseShaOrMechanical;
  } else if (typeof baseShaOrMechanical === 'string') {
    baseSha = baseShaOrMechanical;
  }

  if (mechanicalOpt) {
    mechanical = mechanicalOpt;
  }
  // A session that reinstalls dependencies it already has costs the host a gigabyte per attempt,
  // so the launcher says which trees are already there rather than leaving it to be guessed.
  const installed = dependencies?.shared.length ? `The assigned worktree needs no dependency install: ${dependencies.shared.map(entry => `${entry.name} ${entry.how === 'reachable' ? 'already resolves to' : 'is shared with'} the install at ${entry.source}`).join(', ')}, for this exact lockfile. Do not install dependencies again unless you change the lockfile. ` : '';
  const memoryDigest = projectMemoryDigest(memory, 'worker', { baseSha });
  return `Implement ${work.key}: ${work.title}. The Graphyard worker launcher has claimed this item under principal ${profile.principal}, created its assigned worktree, and placed this agent under lease supervision. Run node ${config.cliPath} status ${work.key} before editing. ${config.fastGates ? workerBeforePushSection(config.cliPath, work.key) : ''}Work only in the current assigned worktree, satisfy the stated criteria without weakening them, commit on the assigned branch, and submit the commit with node ${config.cliPath} complete ${work.key} ${epoch} --head as your last action (nothing is pushed and no pull request is opened): complete ends your lease and the supervisor then stops this session, which is the attempt ending, not lease loss. Stop immediately if the supervisor reports lease loss before you have submitted. `
    + attemptBoundSection(config.run, work, epoch)
    + `Do not submit trusted evidence or merge; the control plane requests the independent review and the proof producers for your exact head as soon as it passes the build gate, so ask nobody to launch them. `
    + installed
    + (memoryDigest || '')
    // The maps for the areas the item's description and criteria name.
    + verificationMapDigest(verificationMaps, [...new Set([work.description ?? '', ...(work.criteria ?? []).map(criterion => criterion.text)].flatMap(namedPaths))], 'worker')
    + submissionPolicyRule
    + destructivePromptGuidance
    + externalDirectoryPromptGuidance
    + branchRewriteGuidance
    + simplicityParagraph
    + (config.repository && mechanical ? mechanicalWorkerSection(config.repository, config.cliPath, { key: work.key, candidate: work.candidate ?? null }, epoch, mechanical.requests, mechanical.reviewId) : '')
    // The reason the applied rework decision gave, so the round answers it rather than resubmitting (GY-1569).
    + (mechanical ? '' : reworkBriefSection(work, rework))
    + resumedAttempt(work)
    // GY-1726: a follow-up whose reading cannot exist yet waits for it rather than escalating.
    + (work.criteria?.some(criterion => criterion.proofs.some(servingReleaseProof)) ? `If the observation this item owes cannot exist yet (its window has not elapsed on the serving release), do not record a blocker: defer it with node ${config.cliPath} defer ${work.key} ${epoch} NOT-BEFORE REASON (NOT-BEFORE is the ISO instant the reading can first exist, at most 30 days away), which ends your lease and holds dispatch until then, then stop. ` : '')
    + `If the item cannot continue without a decision only a human may make — ${humanOnlyDecisions.join('; ')} — do not wait and do not write it as a blocker: record it with node ${config.cliPath} park ${work.key} ${epoch} KIND NEEDED --ask ASK --recommend TEXT --why SENTENCE -- REASON (KIND is goals-and-priorities, money-or-accounts or credentials-for-people; NEEDED is the exact thing the human must provide: every human step the item still needs, in this one request; ASK is one plain sentence naming the human's action; TEXT is the choice you recommend, or the safest way to obtain a value, such as a fine-grained token scoped to one repository with a short expiry and only the permissions needed, and SENTENCE is one plain sentence of why), which ends your lease and parks the item for the human, then stop. `
    // GY-1987: the worker judges its own diff by the reviewer's standard (graphyard review self) before it submits, so a blocking finding costs a push, not a review round.
    + `Before complete, run node ${config.cliPath} review self ${work.key}, judge your diff by what it prints and fix each BLOCKING finding first. `
    + autonomousSession('implement the item, commit it and submit the head with complete --head', `record a blocker with node ${config.cliPath} blocked ${work.key} ${epoch} REASON`);
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

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
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
export async function releaseWorkerLaunch(root: string, key: string, epoch: number, profileName: string, run: WorkerCommand = workerCommand) {
  const config = await loadMasterConfig(root); const profile = config.workers.find(worker => worker.name === profileName);
  if (!profile || profile.mode !== 'launch' || !profile.kind || !profile.credentialFile) throw new Error('A complete launch profile is required');
  await readWorkerCredential(root, profile.credentialFile);
  await run(process.execPath, [config.cliPath, 'unclaim', key, String(epoch)], { cwd: root, env: workerEnvironment(config, profile) });
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
