// Concern: dispatching a worker — dispatchability, the worker launch, its prompt and environment.
import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
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
import { loadMasterConfig, readCredentialFile, readWorkerCredential } from './config.js';
import { accountLaunch, agentLaunchPlan, type EnvironmentProbe, onSelectedSession, selectAccount, sharedGitDirectory } from './environments.js';
import { closeFailedLaunch, launchStartMs, type PromptDelivery, PromptNotAcceptedError, type RequestDelivery, SessionStartError, startAgentSession, type StartBounds, withLaunchClose } from './launch.js';
import { createdHerdrTab, type HerdrAgent, herdrJson } from './herdr.js';
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
      // or out of quota claims nothing, and the refusal names every account it skipped and why.
      selected = await selectAccount(config, 'worker', profile, { ...options.probe, work: work.key });
      // The Git directories the worker writes are granted once its worktree exists (launchWorker).
      // A launch refused for its effective arguments gives the chosen session back at once (GY-184).
      const chosen = selected;
      const launch = await onSelectedSession(chosen, `worker launch for ${work.key} failed`, async () => accountLaunch(profile, chosen.account));
      launched = launch;
      // A prompt the runtime never accepted closes the session and releases the claim; the launch is
      // then made once more from a fresh claim, rather than leaving an idle session holding the item.
      for (let attempt = 1; ; attempt++) {
        try {
          assertClaimDeadline(work.key, options.claimBy);
          let epoch: number;
          ({ target, harness, dependencies, delivery, sandbox, started, consent, epoch } = await launchWorker(root, config, work, profile, launch, run, prepare, release, agentTimeoutMs, options.prompt, options.start, options.sandbox ?? (prepare === prepareWorkerLaunch ? 'host' : null), options.claimBy, options.supervisor, options.stopSupervisor));
          // The epoch this launch claimed outlives the reservation, so a dispatcher still holding the older snapshot is refused cleanly.
          const at = new Date().toISOString();
          await writeFile(dispatchedFile(root, work.key), JSON.stringify({ epoch, at }), { mode: 0o600 }).catch(() => {});
          await writeFile(profileLaunchedFile(root, profile.name), JSON.stringify({ key: work.key, epoch, agentName: profile.agentName, at }), { mode: 0o600 }).catch(() => {});
          break;
        } catch (error) {
          if (error instanceof PromptNotAcceptedError && attempt < 2) { relaunched++; continue; }
          // The registry session chosen for this launch never ran; its account is free again at once.
          await selected.release?.(`worker launch for ${work.key} failed: ${failureText(error).slice(0, 300)}`);
          throw error;
        }
      }
    } finally { await unreserve(); }
  }
  const concurrent = concurrentOverlap(work, allWork, Date.parse(observedAt));
  return { work: work.key, profile: profile.name, principal: profile.principal, agentName: profile.agentName, pane: target.pane_id ?? null, approvals: profile.approvals,
    launch: launched?.plan ?? agentLaunchPlan(profile.kind, profile.approvals, profile.agentArgs, profile.environment), ownership: 'worker launcher claimed and is supervising the agent process', harness, dependencies, delivery, sandbox,
    // `awaiting consent` is not a started session: the runtime has not read its request (GY-130).
    started, consent: { answered: consent.answered, awaiting: consent.awaiting ? { prompt: consent.awaiting.prompt, kind: consent.awaiting.kind, pane: consent.awaiting.pane, attach: consent.awaiting.attach, releaseAt: consent.awaiting.releaseAt, attention: consentHoldAttention(consent.awaiting) } : null },
    account: selected?.account ? { environment: selected.account.name, kind: selected.account.kind, quota: selected.health?.quota ?? null, skipped: selected.skipped } : null, relaunched,
    // Planned-file overlap is recorded with the dispatch, never held on: the item runs beside the
    // in-flight items that touch the same files and whichever lands second is re-integrated.
    overlap: concurrent.length ? { concurrent, note: `Dispatched beside ${describeOverlap(concurrent)}; the merge queue orders them and whichever lands second is re-integrated by base refresh, or sent back for a sync on a real conflict` } : null };
}

export const herdrAttach = (pane: string, workspace?: string | null) => `herdr pane attach ${pane}${workspace ? ` --workspace ${workspace}` : ''}`;
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
