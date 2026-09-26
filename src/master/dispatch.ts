// Concern: dispatching a worker — dispatchability, the worker launch, its prompt and environment.
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { type ChildRun, defaultChildRun } from '../child-runner.js';
import { researchWorkerSection } from '../research.js';
import { discover, assertRepository } from '../onboarding.js';
import { concurrentOverlap, resourceConflicts } from '../coordination.js';
import { type SandboxExec, verifyWorkerSandbox, workerPaths, writablePaths, grantWorkerPaths } from '../worker-sandbox.js';
import { assertNoApprovalOptOut } from '../harness.js';
import { parkedOnHuman, humanDecisionLabel, answerCommand } from '../model/human-request.js';
import { documentationWorkerSection } from '../model/documentation.js';
import type { Work } from '../model.js';
import { type ConsentAnswer, type ConsentHold, consentHoldAttention, consentHoldMs, writeConsentHold } from '../consent-prompt.js';
import type { MasterConfig, WorkerProfile } from './profiles.js';
import { atomicPrivateWrite, loadMasterConfig, readCredentialFile, readWorkerCredential } from './config.js';
import { accountLaunch, agentLaunchPlan, type EnvironmentProbe, NoHealthyAccountError, onSelectedSession, selectAccount, sharedGitDirectory } from './environments.js';
import { closeFailedLaunch, launchStartMs, type PromptDelivery, PromptNotAcceptedError, type RequestDelivery, SessionStartError, startAgentSession, type StartBounds, withLaunchClose } from './launch.js';
import { createdHerdrTab, type HerdrAgent, herdrJson } from './herdr.js';
import { agentOwner, type AttentionItem } from './attention.js';
import { containmentHold, stopLaunchSupervisor } from './containment.js';
import { dependencyDirectories, failureText, type SharedDependencies, shareDependencies } from './worktrees.js';
import { humanOnlyDecisions, installWorkerHarness, prepareSessionHarness } from './harness.js';
import { currentAgents, dispatchedFile, DispatchReservedError, profileLaunchedFile, reserveDispatch, watchSupervisorRunning } from './dispatch-reservation.js';

/** The launcher's own runner: the CLI as a child, and git. `stdio` is honoured for the streams a child may inherit; the rest is captured. */
type WorkerCommand = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: ('ignore' | 'pipe' | 'inherit')[] }) => string | Buffer | Promise<string | Buffer>;
export type PreparedWorker = { epoch: number; path: string; base: string; branch?: string; dependencies?: SharedDependencies };
/** Claims the item and builds its worktree; `claimBy` is a hand dispatch's claim deadline (prepareWorkerLaunch). */
type WorkerPreparer = (root: string, key: string, profileName: string, run?: WorkerCommand, claimBy?: number) => Promise<PreparedWorker>;

/**
 * `sandbox` runs the launch's sandbox probe (GY-134). The worktree prepareWorkerLaunch creates is
 * always probed; a worktree an injected preparer supplies is probed only when a runner is given.
 */
export interface DispatchOptions {
  probe?: EnvironmentProbe; prompt?: PromptDelivery; start?: StartBounds; sandbox?: SandboxExec;
  /** A hand dispatch's deadline on this host's clock: past it the item's backed-off dispatch row is the executor's again, so the launch claims nothing (GY-175). */
  claimBy?: number;
  /**
   * Whether the watch supervisor for an assignment is running on this host (GY-273): a launch that
   * fails once one may be is never closed under it. A test's stub answers for its fake panes.
   */
  supervisor?: (target: { key: string; epoch: number; pane: string | undefined }) => boolean | Promise<boolean>;
  /**
   * Stops the watch supervisor of a launch whose runtime never started (GY-413), answering whether
   * it is gone: its own shutdown settles its quarantine, and only then is its pane closed.
   */
  stopSupervisor?: (target: { key: string; epoch: number; pane: string | undefined }) => boolean | Promise<boolean>;
  /** Herdr's agents read afresh, under the profile's reservation (GY-273); the loop passes `listHerdrAgents`. */
  agents?: () => HerdrAgent[] | Promise<HerdrAgent[]>;
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
  if (parkedOnHuman(work)) throw new Error(`Dispatch waits on a human-only decision (${humanDecisionLabel[work.humanRequest!.kind]}); ${answerCommand(work.key, work.humanRequest!)} resumes it`);
  if (!work.ready || work.blocker) throw new Error('Dispatch requires released work without a blocker');
  const fenced = containmentHold(work, now);
  if (fenced) throw new Error(fenced);
  const unfinished = work.dependencies.map(id => allWork.find(item => item.id === id)).filter(dependency => !dependency || dependency.stage !== 'done');
  if (unfinished.length) throw new Error(`Dispatch blocked by unfinished dependencies: ${unfinished.map(dependency => dependency?.key ?? 'unknown').join(', ')}`);
  if (work.lease && Date.parse(work.lease.expiresAt) > now) throw new Error(`Dispatch blocked by active owner ${work.lease.owner}`);
  if (work.submission && !work.reworkRequested) throw new Error('Dispatch requires operator-authorized rework for a submitted item');
  const conflicts = resourceConflicts(work, allWork, now);
  if (conflicts.length) throw new Error(`Dispatch blocked by exclusive resources: ${conflicts.map(conflict => `${conflict.resource} held by ${conflict.key}`).join(', ')}`);
  // Planned-file overlap holds nothing: dispatch is optimistic, and the merge queue and a sync
  // round integrate whichever of two overlapping items lands second.
}

export async function dispatchWork(root: string, work: Work, profile: WorkerProfile, agents: HerdrAgent[], run?: ChildRun, allWork: Work[] = [work], prepare: WorkerPreparer = prepareWorkerLaunch, release: (root: string, key: string, epoch: number, profileName: string) => Promise<void> = releaseWorkerLaunch, agentTimeoutMs?: number, observedAt = new Date().toISOString(), options: DispatchOptions = {}) {
  assertDispatchable(work, allWork, observedAt);
  const config = await loadMasterConfig(root);
  let target = agents.find(agent => agent.name === profile.agentName);
  let selected: Awaited<ReturnType<typeof selectAccount>> | undefined, launched: ReturnType<typeof accountLaunch> | undefined, relaunched = 0;
  let harness: Awaited<ReturnType<typeof installWorkerHarness>> | null = null;
  let dependencies: PreparedWorker['dependencies'] | null = null;
  let delivery: RequestDelivery | null = null, sandbox: ReturnType<typeof verifyWorkerSandbox> | null = null;
  let started: 'started' | 'awaiting consent' = 'started', consent: { answered: ConsentAnswer[]; awaiting: ConsentHold | null } = { answered: [], awaiting: null };
  const startFailures: AccountStartFailure[] = [];
  if (profile.mode === 'existing') {
    if (!target) throw new Error('Existing worker is not visible in Herdr');
    throw new Error('Existing sessions are observable but cannot be safely adopted for new work; use a launch profile so Graphyard supervises the agent process');
  } else {
    await readCredentialFile(profile.credentialFile!);
    if (target) throw new DispatchReservedError('profile', profile.name, 'Launch profile agent name is already visible in Herdr');
    // A profile that cannot launch without a human at its prompts is refused before any account is chosen.
    assertNoApprovalOptOut(profile.kind ?? 'unnamed', profile.approvals);
    // The profile and the item are reserved before anything is claimed, and Herdr's agents are read
    // again under the reservation: the snapshot this dispatcher chose from may already be stale (GY-273).
    const unreserve = await reserveDispatch(root, work, profile, observedAt);
    try {
      if ((await currentAgents(root, profile, agents, observedAt, run, options.agents)).some(agent => agent.name === profile.agentName))
        throw new DispatchReservedError('profile', profile.name, `Launch profile agent name ${profile.agentName} is already visible in Herdr; pick another profile`);
      // The account is chosen before anything is claimed: a profile whose accounts are all logged out
      // or out of quota claims nothing, and the refusal names every account it skipped and why. An
      // account whose runtime already failed to start under this dispatch is passed over, so the
      // fallback lands on the next account rather than the same one again (GY-417).
      let startError: unknown = null;
      for (;;) {
        const accounts = profile.accounts?.length ? profile.accounts.filter(name => !startFailures.some(failure => failure.account === name)) : undefined;
        if (accounts && !accounts.length)
          throw new Error(`${describeStartFailures(startFailures, null)}; no further account of profile ${profile.name} to fall back to`, { cause: startError });
        try {
          selected = await selectAccount(config, 'worker', accounts && accounts.length < (profile.accounts?.length ?? 0) ? { ...profile, accounts } : profile, { ...options.probe, work: work.key });
        } catch (error) {
          if (!startFailures.length || !(error instanceof NoHealthyAccountError)) throw error;
          throw new Error(`${describeStartFailures(startFailures, null)}; no further account of profile ${profile.name} could be launched: ${failureText(error).slice(0, 300)}`, { cause: error });
        }
        // The Git directories the worker writes are granted once its worktree exists (launchWorker).
        // A launch refused for its effective arguments gives the chosen session back at once (GY-184).
        const chosen = selected;
        const launch = await onSelectedSession(chosen, `worker launch for ${work.key} failed`, async () => accountLaunch(profile, chosen.account));
        launched = launch;
        // A prompt the runtime never accepted closes the session and releases the claim; the launch is
        // then made once more from a fresh claim, rather than leaving an idle session holding the item.
        try {
          for (let attempt = 1; ; attempt++) {
            try {
              assertClaimDeadline(work.key, options.claimBy);
              let epoch: number;
              ({ target, harness, dependencies, delivery, sandbox, started, consent, epoch } = await launchWorker(root, config, work, profile, launch, run, prepare, release, agentTimeoutMs, options.prompt, options.start, options.sandbox ?? (prepare === prepareWorkerLaunch ? 'host' : null), options.claimBy, options.supervisor, options.stopSupervisor));
              // The epoch this launch claimed outlives the reservation, so a dispatcher still holding the older snapshot is refused cleanly.
              const at = new Date().toISOString();
              await writeFile(dispatchedFile(root, work.key), JSON.stringify({ epoch, at }), { mode: 0o600 }).catch(() => {});
              // The dispatch record names the runtime and account the session runs on, and every
              // account whose runtime failed to start first, so a slot running one runtime under a
              // profile named for another is on the record, not a surprise (GY-417).
              await writeFile(profileLaunchedFile(root, profile.name), JSON.stringify({ key: work.key, epoch, agentName: profile.agentName, at,
                runtime: launch.kind ?? null, account: chosen.account?.name ?? null, ...(startFailures.length ? { failedAccounts: startFailures } : {}) }), { mode: 0o600 }).catch(() => {});
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
          if (!(error instanceof SessionStartError) || !chosen.account || !['never started', 'still starting'].includes(error.startCase)) throw error;
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
  return { work: work.key, profile: profile.name, principal: profile.principal, agentName: profile.agentName, pane: target.pane_id ?? null, approvals: profile.approvals,
    launch: launched?.plan ?? agentLaunchPlan(profile.kind, profile.approvals, profile.agentArgs, profile.environment), ownership: 'worker launcher claimed and is supervising the agent process', harness, dependencies, delivery, sandbox,
    // `awaiting consent` is not a started session: the runtime has not read its request (GY-130).
    started, consent: { answered: consent.answered, awaiting: consent.awaiting ? { prompt: consent.awaiting.prompt, kind: consent.awaiting.kind, pane: consent.awaiting.pane, attach: consent.awaiting.attach, releaseAt: consent.awaiting.releaseAt, attention: consentHoldAttention(consent.awaiting) } : null },
    account: selected?.account ? { environment: selected.account.name, kind: selected.account.kind, quota: selected.health?.quota ?? null, skipped: selected.skipped } : null, relaunched,
    // A dispatch whose preferred account's runtime never started names what happened and where the
    // session runs instead, so the fallback is on the record rather than silent (GY-417).
    fallback: selected && startFailures.length ? { failed: startFailures, note: describeStartFailures(startFailures, selected.account?.name ?? null) } : null,
    // Planned-file overlap is recorded with the dispatch, never held on: the item runs beside the
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
/** How many launches one account's runtime may fail to start in a row before master status raises one attention item naming the account and its runtime (GY-417). */
export const accountStartFailureLimit = 3;
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
/**
 * What each launch profile's last worker dispatch recorded, joined onto its `master status` row
 * (GY-417): the runtime and account the session runs on — a slot is named by what runs in it,
 * never by the profile's name alone — and, when the preferred account's runtime failed to start,
 * one `fallback` line naming that account and the one launched on.
 */
export function workerLaunchRows(profiles: { name: string }[], records: Record<string, ProfileLaunchRecord>): Record<string, { runtime: string | null; account: string | null; fallback: string | null }> {
  const rows: Record<string, { runtime: string | null; account: string | null; fallback: string | null }> = {};
  for (const profile of profiles) {
    const record = records[profile.name];
    if (record) rows[profile.name] = { runtime: record.runtime, account: record.account, fallback: record.failedAccounts.length ? describeStartFailures(record.failedAccounts, record.account) : null };
  }
  return rows;
}
/**
 * One attention item per account whose runtime failed to start `accountStartFailureLimit` launches
 * in a row (GY-417): every launch fell back to the profile's next account, so no session, no item
 * and no refused launch would otherwise show that this runtime never starts at all.
 */
export function accountStartFailureAttention(failures: AccountStartFailures, cliPath: string): AttentionItem[] {
  return Object.entries(failures).filter(([, entry]) => entry.failures >= accountStartFailureLimit).map(([account, entry]) => ({
    subject: `${account} never starts`,
    text: `Worker account ${account} (runtime ${entry.kind}) failed to start ${entry.failures} launches in a row; each launch fell back to the profile's next account, so no session shows the failure. Last refusal at ${entry.at}: ${entry.reason}`,
    ...agentOwner('master', `Re-check the account with node ${cliPath} master environments --apply and log its runtime in, or drop it from the profiles' account order with node ${cliPath} master config accounts:PROFILE=… until it starts`) }));
}
/** What a profile's last worker dispatch recorded, as master status reads it (GY-417). */
export interface ProfileLaunchRecord { key: string; epoch: number; agentName: string; at: string; runtime: string | null; account: string | null; failedAccounts: AccountStartFailure[] }
const profileLaunchRecordSchema = z.object({
  key: z.string().min(1), epoch: z.number().int().min(1), agentName: z.string().min(1), at: z.string().min(1),
  runtime: z.string().nullable().default(null), account: z.string().nullable().default(null),
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
/** Everything `master status` shows of worker launches (GY-417): each profile's row fields and the never-starting accounts. */
export async function workerLaunchStatus(root: string, config: Pick<MasterConfig, 'credentialFile' | 'cliPath' | 'workers'>) {
  const failures = await readAccountStartFailures(config);
  return { rows: workerLaunchRows(config.workers, await readProfileLaunchRecords(root, config.workers)), items: accountStartFailureAttention(failures, config.cliPath) };
}

export function consentHold(config: Pick<MasterConfig, 'herdrWorkspace'>, key: string, epoch: number, agentName: string, pane: string, awaiting: { prompt: string; kind: ConsentHold['kind']; request?: string | null; named?: boolean }, now = Date.now()): ConsentHold {
  return { key, epoch, agentName, pane, attach: herdrAttach(pane, config.herdrWorkspace), prompt: awaiting.prompt, kind: awaiting.kind, since: new Date(now).toISOString(), releaseAt: new Date(now + consentHoldMs).toISOString(), ...(awaiting.request ? { request: awaiting.request } : {}), ...(awaiting.named === false ? { named: false } : {}) };
}

async function launchWorker(root: string, config: MasterConfig, work: Work, profile: WorkerProfile, launch: ReturnType<typeof accountLaunch>, run: ChildRun | undefined, prepare: WorkerPreparer, release: (root: string, key: string, epoch: number, profileName: string) => Promise<void>, agentTimeoutMs: number | undefined, delivery?: PromptDelivery, start?: StartBounds, sandboxProbe: SandboxExec | 'host' | null = null, claimBy?: number, supervisor: NonNullable<DispatchOptions['supervisor']> = watchSupervisorRunning, stopSupervisor: NonNullable<DispatchOptions['stopSupervisor']> = stopLaunchSupervisor) {
  const prepared = await prepare(root, work.key, profile.name, undefined, claimBy);
  // The worker writes its worktree, the worktree's own Git admin directory and the shared one;
  // each is granted to the runtime's sandbox, and the grant is proved below before anything starts.
  const paths = workerPaths(prepared.path);
  const writable = writablePaths({ ...paths, commonDir: paths.commonDir ?? await sharedGitDirectory(root) });
  const args = grantWorkerPaths(launch.kind, launch.args, writable, prepared.path);
  // The worker's own rules go into its worktree before the session starts, so pushing its
  // branch and opening its pull request never wait on a keypress. A failure is reported, not fatal.
  const harness = await installWorkerHarness(config, { ...profile, kind: launch.kind as WorkerProfile['kind'] }, work.key, prepared).catch(error => ({ applied: false, reason: error instanceof Error ? error.message : 'Worker rules could not be written' }));
  const prompt = workerPrompt(config, work, profile, prepared.epoch, prepared.dependencies ?? null);
  // The worker loads its own role rules, never the master's: it may push its assigned branch.
  const sessionHarness = await prepareSessionHarness(root, config, { role: 'worker', kind: launch.kind, profile: profile.name, branch: prepared.branch ?? `graphyard/${work.key.toLowerCase()}-${prepared.epoch}`, credentialFiles: [profile.credentialFile!] });
  let pane: string | undefined, tabId: string | undefined, sandbox: ReturnType<typeof verifyWorkerSandbox> | null = null, ran = false;
  try {
    // A sandbox that cannot write them is a launch failure naming the path, not a worker that
    // fails at its first sync; the claim is released below like any other failed launch.
    if (sandboxProbe) sandbox = verifyWorkerSandbox({ ...launch, args }, prepared.path, writable, sandboxProbe === 'host' ? undefined : sandboxProbe);
    const tabArgs = ['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', prepared.path, '--label', `${work.key} · ${profile.agentName}`, '--env', `GRAPHYARD_URL=${config.url}`, '--env', `GRAPHYARD_TOKEN_FILE=${profile.credentialFile}`, '--env', `GRAPHYARD_HOST_ID=${config.hostId}`, '--env', `GRAPHYARD_HERDR_AGENT_KIND=${launch.kind}`, ...Object.entries(launch.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'];
    const created = createdHerdrTab(await herdrJson(tabArgs, run)); pane = created.pane; tabId = created.tab;
    // The instruction is the session's own first request, on the runtime's command line under
    // the supervisor, read from the request file in the worktree (GY-121); only a runtime without
    // that contract is prompted after.
    const started = await startAgentSession(profile.agentName, launch.kind!, pane, [...args, ...sessionHarness.args], prompt, run,
      { ...delivery, ...start, timeoutMs: start?.timeoutMs ?? agentTimeoutMs ?? launchStartMs(config), directory: prepared.path, role: sessionHarness.role, prefix: [process.execPath, config.cliPath, 'watch', work.key, String(prepared.epoch), '--'], holdConsent: true, contract: launch.contract, environment: launch.environment, onRun: () => { ran = true; } });
    // A worker stopped on a prompt the launcher does not answer is held for a human rather than
    // closed: its record beside the launch files is what master status raises and what the watch
    // supervisor bounds, releasing the slot once `consentHoldMs` passes with the prompt unanswered.
    const hold = started.awaiting ? consentHold(config, work.key, prepared.epoch, profile.agentName, pane, started.awaiting) : null;
    if (hold) writeConsentHold(started.files.stem, hold);
    return { target: { name: profile.agentName, pane_id: pane, agent_status: hold ? 'blocked' : 'working', cwd: prepared.path } as HerdrAgent, harness, dependencies: prepared.dependencies ?? null, delivery: started.delivery, sandbox,
      started: started.started.state, consent: { answered: started.consent, awaiting: hold }, epoch: prepared.epoch };
  } catch (error) {
    const malformedTab = (error as any)?.herdrTab as string | undefined;
    const failed = error instanceof Error ? error.message : 'Worker launch failed';
    // Once the command line is in the pane, the watch supervisor may be running there with the
    // runtime under it. Closing that pane kills both by SIGHUP and leaves an unverified containment
    // fence (GY-273), so it is left alone: the claim is released below, and the supervisor stops
    // its own worker on the lost lease and settles the containment itself.
    const target = { key: work.key, epoch: prepared.epoch, pane };
    let supervised = ran && await Promise.resolve(supervisor(target)).catch(() => true);
    // A runtime that never started (GY-413) leaves nothing under its supervisor worth keeping, and
    // the pane it leaves idles in the worktree holding the containment fence. Its supervisor is
    // stopped first — its own shutdown settles its quarantine — and only once it is gone is the
    // pane closed, before the claim is released. A supervisor that will not stop keeps its pane.
    let stop = '';
    if (supervised && error instanceof SessionStartError) {
      supervised = !await Promise.resolve(stopSupervisor(target)).catch(() => false);
      stop = supervised ? '' : `its watch supervisor for epoch ${prepared.epoch} was stopped and `;
    }
    if (!supervised && (pane || tabId || malformedTab)) {
      let note: string;
      try { note = await closeFailedLaunch(pane, tabId ?? malformedTab, run); }
      catch { throw new Error(`${failed}; Herdr could not confirm pane shutdown, so Graphyard retained epoch ${prepared.epoch}`); }
      withLaunchClose(error, `${stop}${note} before epoch ${prepared.epoch} was released`);
    }
    try { await release(root, work.key, prepared.epoch, profile.name); }
    catch { throw new Error(supervised ? `${failed}; pane ${pane} was left to its running supervisor, but Graphyard could not release epoch ${prepared.epoch}` : `${failed}; the pane was stopped but Graphyard could not release epoch ${prepared.epoch}`); }
    // A supervised pane is never relaunched over: the failure is reported as it is, not as a retryable prompt.
    if (supervised) throw Object.assign(new Error(`${failed}; pane ${pane} was left to its running supervisor, which stops the worker on the released epoch ${prepared.epoch}`), { cause: error });
    throw error;
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
export function workerPrompt(config: Pick<MasterConfig, 'cliPath'>, work: Pick<Work, 'key' | 'title'> & Partial<Pick<Work, 'capacity' | 'humanRequests' | 'documentation' | 'description' | 'criteria' | 'researchBrief'>>, profile: Pick<WorkerProfile, 'principal'>, epoch: number, dependencies?: Pick<SharedDependencies, 'shared'> | null) {
  // A session that reinstalls dependencies it already has costs the host a gigabyte per attempt,
  // so the launcher says which trees are already there rather than leaving it to be guessed.
  const installed = dependencies?.shared.length ? `The assigned worktree needs no dependency install: ${dependencies.shared.map(entry => `${entry.name} ${entry.how === 'reachable' ? 'already resolves to' : 'is shared with'} the install at ${entry.source}`).join(', ')}, for this exact lockfile. Do not install dependencies again unless you change the lockfile. ` : '';
  return `Implement ${work.key}: ${work.title}. The Graphyard worker launcher has claimed this item under principal ${profile.principal}, created its assigned worktree, and placed this agent under lease supervision. Run node ${config.cliPath} status ${work.key} before editing. Work only in the current assigned worktree, satisfy the stated criteria without weakening them, open a PR, and submit it with complete as your last action: complete ends your lease and the supervisor then stops this session, which is the attempt ending, not lease loss. Stop immediately if the supervisor reports lease loss before you have submitted. Do not submit trusted evidence or merge the PR; the control plane requests the independent review and the proof producers for your exact head as soon as it passes the build gate, so ask nobody to launch them. `
    + installed
    // The research brief recorded before build, with the product decisions it asked for (GY-259).
    + (work.researchBrief && work.criteria ? researchWorkerSection({ ...work, criteria: work.criteria, description: work.description ?? '' }, config.cliPath) : '')
    // The standard documentation criterion the control plane stamped at create time (GY-215).
    + (work.documentation ? documentationWorkerSection(work.documentation, work.key, epoch, config.cliPath) : '')
    + destructivePromptGuidance
    + resumedAttempt(work)
    + `If the item cannot continue without a decision only a human may make — ${humanOnlyDecisions.join('; ')} — do not wait and do not write it as a blocker: record it with node ${config.cliPath} park ${work.key} ${epoch} KIND NEEDED -- REASON (KIND is goals-and-priorities, money-or-accounts or credentials-for-people; NEEDED is the exact thing the human must provide), which ends your lease and parks the item for the human, then stop. `
    + autonomousSession('implement the item, open the pull request and submit it with complete', `record a blocker with node ${config.cliPath} blocked ${work.key} ${epoch} REASON`);
}

/** What the previous attempt left for this one: the work an exhausted session had not committed, and a human's answer. */
function resumedAttempt(work: Partial<Pick<Work, 'capacity' | 'humanRequests'>>) {
  const interrupted = work.capacity?.exhaustions.filter(entry => entry.role === 'worker').at(-1);
  // Why the attempt ended: a spent provider account, or a worker killed or gone without submitting (GY-105).
  const ended = interrupted?.cause === 'interrupted' ? `${interrupted.reason.replace(/\.\s*$/, '')}` : 'stopped when its provider account ran out of quota';
  const kept = interrupted?.partialWork.commit && interrupted.partialWork.state !== 'discarded'
    ? `The previous attempt (epoch ${interrupted.epoch}) ${ended}; its work is kept as commit ${interrupted.partialWork.commit}${interrupted.partialWork.branch ? ` on local branch ${interrupted.partialWork.branch}` : ''}${interrupted.partialWork.path ? ` (worktree ${interrupted.partialWork.path})` : ''}. Read it with git log and git show, and bring what is sound into your branch with git cherry-pick or git merge instead of redoing it. `
    : interrupted?.partialWork.state === 'discarded' ? `The previous attempt (epoch ${interrupted.epoch}) ${ended}; its uncommitted changes could not be committed and were discarded (${interrupted.partialWork.detail ?? 'no detail recorded'}), so nothing of them is left to read${interrupted.partialWork.branch ? `; its committed work is on local branch ${interrupted.partialWork.branch}` : ''}. ` : '';
  const answered = work.humanRequests?.at(-1)?.answer?.outcome === 'provided' ? work.humanRequests.at(-1)! : null;
  return kept + (answered ? `An earlier attempt asked the human for ${answered.needed} (${humanDecisionLabel[answered.kind]}); the human answered: ${answered.answer!.text}. Continue from that answer. ` : '');
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
const workerCommand: WorkerCommand = (command, args, options = {}) => defaultChildRun(command, args, { cwd: options.cwd, env: options.env, timeoutMs: workerLaunchTimeoutMs, stdout: options.stdio?.[1] === 'inherit' ? 'inherit' : 'capture', stderr: options.stdio?.[2] === 'inherit' ? 'inherit' : 'capture' });

export async function releaseWorkerLaunch(root: string, key: string, epoch: number, profileName: string, run: WorkerCommand = workerCommand) {
  const config = await loadMasterConfig(root); const profile = config.workers.find(worker => worker.name === profileName);
  if (!profile || profile.mode !== 'launch' || !profile.kind || !profile.credentialFile) throw new Error('A complete launch profile is required');
  await readWorkerCredential(root, profile.credentialFile);
  await run(process.execPath, [config.cliPath, 'release', key, String(epoch)], { cwd: root, env: workerEnvironment(config, profile) });
}

/**
 * `claimBy` is a hand dispatch's deadline on this host's clock (GY-175): it is checked again
 * immediately before the lease claim, after the credential read, discovery and base fetch, so a
 * backed-off dispatch row the executor may claim by then never meets a second launch at the claim.
 */
export async function prepareWorkerLaunch(root: string, key: string, profileName: string, run: WorkerCommand = workerCommand, claimBy?: number): Promise<PreparedWorker> {
  const config = await loadMasterConfig(root); const profile = config.workers.find(worker => worker.name === profileName);
  if (!profile || profile.mode !== 'launch' || !profile.kind || !profile.credentialFile) throw new Error('A complete launch profile is required');
  await readWorkerCredential(root, profile.credentialFile);
  const detected = await discover(root);
  if (!detected.repository) throw new Error('Worker launcher requires a recognized GitHub origin');
  assertRepository(detected.repository, config.repository);
  const env = workerEnvironment(config, profile);
  await run('git', ['fetch', '--quiet', '--no-tags', 'origin', `+refs/heads/${config.baseBranch}:refs/remotes/origin/${config.baseBranch}`], { cwd: root, env, stdio: ['ignore', 'ignore', 'inherit'] });
  const base = String(await run('git', ['rev-parse', '--verify', `refs/remotes/origin/${config.baseBranch}`], { cwd: root, env })).trim();
  if (!/^[0-9a-f]{40}$/i.test(base)) throw new Error('Worker launcher could not resolve the current managed base branch');
  assertClaimDeadline(key, claimBy);
  const claim = JSON.parse(String(await run(process.execPath, [config.cliPath, 'claim', key], { cwd: root, env })));
  const claimedEpoch = Number.isSafeInteger(claim.epoch) && claim.epoch > 0 ? claim.epoch as number : null;
  try {
    if (claim.lease?.owner !== profile.principal || claimedEpoch === null) throw new Error('Worker launcher acquired an unexpected assignment identity');
    const workspace = JSON.parse(String(await run(process.execPath, [config.cliPath, 'worktree', key, String(claimedEpoch), base], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] })));
    if (!workspace.path || !isAbsolute(workspace.path)) throw new Error('Worker launcher did not receive an assigned workspace');
    // The checkout is the attempt's; the dependency tree does not have to be. Sharing is a
    // convenience for the session that follows, so a refusal is reported, never fatal.
    const dependencies: SharedDependencies = await shareDependencies(root, workspace.path).catch(error => ({ shared: [], skipped: [{ name: dependencyDirectories[0], reason: failureText(error) }] }));
    return { epoch: claimedEpoch, path: workspace.path, base, dependencies, ...(typeof workspace.branch === 'string' && workspace.branch ? { branch: workspace.branch } : {}) };
  } catch (error) {
    if (claimedEpoch !== null) try { await run(process.execPath, [config.cliPath, 'release', key, String(claimedEpoch)], { cwd: root, env }); }
    catch { throw new Error(`${error instanceof Error ? error.message : 'Workspace preparation failed'}; Graphyard could not release epoch ${claimedEpoch}`); }
    throw error;
  }
}
