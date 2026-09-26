// Concern: agent identities and autonomy — approver and escalation launches, and the autonomy commands.
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, mkdir, lstat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { type ChildRun, type ChildRunOptions, defaultChildRun } from '../child-runner.js';
import { distinctSessionName, sessionNameLimit, sessionName, nameForLaunch } from '../session-name.js';
import { localDirectory } from '../onboarding.js';
import { broadScopeRefusals } from '../coordination.js';
import { writeHarnessPermissions } from '../harness.js';
import { type Work, escalationTriggers } from '../model.js';
import { branchContamination, pendingRestore } from '../merge-queue.js';
import { type FleetLaunchAccount, type FleetProbe, selectFleetSession } from '../fleet.js';
import { capacityRetryAt } from '../model/capacity.js';
import { type EscalationContext, contextFingerprint, escalationAction, handleEscalation, followPrecedent } from '../model/escalation-context.js';
import { type AgentEnvironment, agentKindSchema, type EnvironmentKind, environmentKinds, type MasterConfig, masterConfigSchema, type WorkerProfile } from './profiles.js';
import { assertOutsideWorktrees, atomicPrivateText, atomicPrivateWrite, externalCredential, loadMasterConfig, privateFile, readCredentialFile } from './config.js';
import { type AccountSkip, accountLaunch, agentLaunchPlan, describeObservedExhaustion, type EnvironmentProbe, heldAwareProbe, inspectProfileAccounts, type LaunchRole, NoHealthyAccountError, observedExhaustions, ownLoginHold, type ProfileAccountHealth, recordEnvironmentLog, selectAccount, setupAgentEnvironments } from './environments.js';
import { closeFailedLaunch, launchStartMs, type RequestDelivery, startAgentSession, withLaunchClose } from './launch.js';
import { createdHerdrTab, type HerdrAgent, herdrJson } from './herdr.js';
import { failureText } from './worktrees.js';
import { herdrAttach } from './dispatch.js';
import type { SessionHandleInput } from '../model/sessions.js';
import { registeredLaunch } from '../model/session-state.js';
import { liveReviewRequest } from '../model/dispatch.js';
import { narrowRoleRuntime, piRuntimeSchema } from '../runner/payloads.js';
import { applyDecision, approverRunOptions, narrowRunner, piApproverPrompt, registryRunner, startNarrowRun } from '../runner/roles.js';
import type { Runner, RunRecord } from '../runner/types.js';
import { autonomyPlan, autonomyReason, humanOnlyDecisions, masterHarness } from './harness.js';

type AutonomyFetch = typeof fetch;
async function adminCall(config: MasterConfig, token: string, fetcher: AutonomyFetch, path: string, body?: unknown) {
  const response = await fetcher(`${config.url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status}): ${result?.error ?? 'unknown'}`);
  return result;
}
async function identityHolds(config: MasterConfig, file: string, id: string, fetcher: AutonomyFetch) {
  try { return (await adminCall(config, await readCredentialFile(file), fetcher, 'status')).actor?.id === id; } catch { return false; }
}
/**
 * Onboarding for autonomy: provision (or repair) the master's operator-agent identity and the
 * approver identity, store their credentials beside the coordinator's, record them in the
 * master configuration, and install the master's harness rules. The admin credential is read
 * once from stdin and never stored. Without `apply` it reports the plan and changes nothing.
 */
export async function setupAutonomy(root: string, input: { adminToken?: string; apply: boolean; harness?: string }, fetcher: AutonomyFetch = fetch) {
  const config = await loadMasterConfig(root);
  const plan = autonomyPlan(config);
  const identities = [plan.operatorAgent, plan.approver];
  const describe = identities.map(({ id, capabilities, credentialFile, role }) => ({ id, capabilities, credentialFile, role }));
  if (!input.apply) return { applied: false, identities: describe, humanOnly: humanOnlyDecisions, harness: await writeHarnessPermissions(root, masterHarness(root, config, input.harness ?? 'claude'), false),
    next: 'Rerun with --apply and the admin credential on stdin: graphyard master autonomy --admin-token-stdin --apply' };
  if (!input.adminToken || input.adminToken.length < 32) throw new Error('Autonomy setup needs the admin credential once, on stdin; it is used to provision the agent identities and is never stored');
  const status = await adminCall(config, input.adminToken, fetcher, 'status');
  if (status.actor?.role !== 'admin') throw new Error('Autonomy setup needs the admin credential; it provisions operator-agent identities, which only an admin may create');
  const existing: any[] = await adminCall(config, input.adminToken, fetcher, 'operator-agents');
  const changes: string[] = [];
  for (const identity of identities) {
    const current = existing.find(document => document.id === identity.id);
    if (current?.revokedAt) throw new Error(`${identity.id} was revoked; choose another identity in .graphyard/master.json or restore it through the operator-agent API`);
    const body = { capabilities: identity.capabilities, scope: identity.scope, reason: autonomyReason };
    // Compared as sets: the server stores these in jsonb, which keeps neither key nor entry order.
    const same = (left: string[] = [], right: string[] = []) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
    if (current && (!same(current.capabilities, identity.capabilities) || !same(current.scope?.repositories, identity.scope.repositories) || !same(current.scope?.workItems, identity.scope.workItems))) {
      await adminCall(config, input.adminToken, fetcher, `operator-agents/${encodeURIComponent(identity.id)}/configure`, { expectedRevision: current.revision, ...body });
      changes.push(`${identity.id}: capabilities set to ${identity.capabilities.join(', ')}`);
    }
    if (current && await identityHolds(config, identity.credentialFile, identity.id, fetcher)) continue;
    const token = randomBytes(32).toString('hex');
    if (current) await adminCall(config, input.adminToken, fetcher, `operator-agents/${encodeURIComponent(identity.id)}/rotate`, { token, transitionSeconds: 0, reason: autonomyReason });
    else await adminCall(config, input.adminToken, fetcher, 'operator-agents', { id: identity.id, displayName: identity.displayName, token, ...body });
    await atomicPrivateText(identity.credentialFile, token);
    await assertOutsideWorktrees(root, identity.credentialFile, `${identity.id} credential file`);
    changes.push(`${identity.id}: ${current ? 'credential rotated' : 'provisioned'}`);
  }
  const next = { ...config, operatorAgent: { id: plan.operatorAgent.id, credentialFile: plan.operatorAgent.credentialFile }, approver: { id: plan.approver.id, credentialFile: plan.approver.credentialFile } };
  await atomicPrivateWrite(resolve(await localDirectory(root), 'master.json'), masterConfigSchema.parse(next));
  const harness = await writeHarnessPermissions(root, masterHarness(root, next, input.harness ?? 'claude'), true);
  return { applied: true, identities: describe, changes, humanOnly: humanOnlyDecisions, harness,
    next: 'The master now creates, releases, unblocks and adds requirements with its operator-agent identity, and requests every other decision with graphyard master decide; graphyard master approver GY-N DECISION launches the independent approver session' };
}

export async function agentToken(root: string, config: MasterConfig, which: 'operatorAgent' | 'approver') {
  const identity = config[which];
  if (!identity) throw new Error(`No ${which === 'operatorAgent' ? 'master operator-agent' : 'approver'} identity is provisioned; run graphyard master autonomy --admin-token-stdin --apply`);
  await externalCredential(root, identity.credentialFile, which === 'operatorAgent' ? 'Operator-agent' : 'Approver');
  return readCredentialFile(identity.credentialFile);
}

/**
 * Fill the binding a decision needs from the item's current state, so the master names the
 * decision and its reason and Graphyard supplies the exact revision or candidate it binds to.
 */
export function decisionInput(action: string, work: Work, input: Record<string, unknown>) {
  if (['release', 'unblock', 'resolve'].includes(action)) return { expectedRevision: work.revision, ...input };
  if (action === 'requirements') return { expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: work.dependencies, plannedFiles: work.plannedFiles, exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [], ...input };
  if ((action === 'merge' || action === 'attest') && work.candidate) return { sha: work.candidate.sha, baseSha: work.candidate.baseSha, policyRevision: work.policyRevision, ...(action === 'attest' ? { result: 'pass', executed: 1, skipped: 0 } : {}), ...input };
  if (action === 'rework' || action === 'recover') return { previousWorkerStopped: true, ...input };
  // The repair lane (GY-406) binds the exact head it may merge.
  if (action === 'repair-merge' && work.candidate) return { sha: work.candidate.sha, ...input };
  return input;
}
/** With automatic merging off, the guarded merge runs only for a candidate an approver agent approved. */
export function approvedMerge<T extends { action: string; state: string; input: any; approvedBy: string | null }>(work: Work, decisions: T[]): T | null {
  return decisions.find(decision => decision.action === 'merge' && decision.state === 'applied' && !!work.candidate
    && decision.input.sha === work.candidate.sha && decision.input.baseSha === work.candidate.baseSha && decision.input.policyRevision === work.policyRevision) ?? null;
}

/**
 * With automatic merging off, an approver agent's merge decision for the exact candidate stands in
 * for the operator: a named item without one is refused, and `--all` keeps only approved ones.
 */
export async function approvedMerges(selected: Work[], decisions: (work: Work) => Promise<{ decisions: Parameters<typeof approvedMerge>[1] }>, single: boolean) {
  const approved: Work[] = [];
  for (const work of selected) {
    if (approvedMerge(work, (await decisions(work)).decisions)) approved.push(work);
    else if (single) throw new Error(`${work.key} has no approved merge decision for its current candidate; request one with graphyard master decide ${work.key} merge REASON`);
  }
  return approved;
}
/**
 * A roster rotation, previewed against the principals the server authenticates now. It may add
 * principals and rotate tokens; it may never drop a live principal or change its role. Tokens
 * are never read into the report.
 */
export function previewPrincipalRotation(live: { id: string; role: string; leases?: string[] }[], proposed: { id: string; role: string }[]) {
  const dropped = live.filter(principal => !proposed.some(next => next.id === principal.id));
  const changed = live.filter(principal => proposed.some(next => next.id === principal.id && next.role !== principal.role));
  const refusals = [...dropped.map(principal => `${principal.id} (${principal.role}${principal.leases?.length ? `, holding ${principal.leases.join(', ')}` : ''}) is live and would be dropped`),
    ...changed.map(principal => `${principal.id} would change role from ${principal.role} to ${proposed.find(next => next.id === principal.id)!.role}`)];
  return { kept: live.filter(principal => !dropped.includes(principal) && !changed.includes(principal)).map(principal => principal.id), added: proposed.filter(next => !live.some(principal => principal.id === next.id)).map(next => `${next.id} (${next.role})`), refusals, applicable: !refusals.length };
}
export async function readProposedRoster(root: string) {
  const file = resolve(root, '.graphyard/credentials.json'); await privateFile(file);
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  if (!Array.isArray(parsed) || !parsed.every(entry => typeof entry?.id === 'string' && typeof entry?.role === 'string')) throw new Error('.graphyard/credentials.json must be the principal array the deployment runs with');
  return parsed.map(entry => ({ id: entry.id as string, role: entry.role as string }));
}

/** Stop this host's master loop, if one runs, and start it again detached, logging beside the config. */
export async function restartMasterLoop(root: string, config: MasterConfig, lock: { pid: number; host: string; heartbeatAt: string } | null, options: { timeoutMs?: number } = {}) {
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; } };
  let stopped: number | null = null;
  if (lock && lock.host !== config.hostId && Date.now() - Date.parse(lock.heartbeatAt) < 3 * config.run.intervalSeconds * 1000) throw new Error(`The master loop runs on ${lock.host} (pid ${lock.pid}); restart it on that host`);
  if (lock && lock.host === config.hostId && alive(lock.pid)) {
    process.kill(lock.pid, 'SIGTERM'); stopped = lock.pid;
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    while (alive(lock.pid)) {
      if (Date.now() > deadline) throw new Error(`Master loop pid ${lock.pid} did not stop within ${Math.round((options.timeoutMs ?? 30_000) / 1000)} seconds; it was not restarted`);
      await new Promise(done => setTimeout(done, 200));
    }
  }
  const log = resolve(await localDirectory(root), 'master-run.log');
  const { openSync } = await import('node:fs'); const { spawn } = await import('node:child_process');
  const output = openSync(log, 'a', 0o600);
  const child = spawn(process.execPath, [config.cliPath, 'master', 'run'], { cwd: root, detached: true, stdio: ['ignore', output, output] });
  child.unref();
  return { stopped, started: child.pid ?? null, log };
}

/**
 * Launch the independent approver session for one decision: its own Herdr tab, its own
 * credential by path, the approver marker, and a prompt to judge — never to implement.
 */
/**
 * One session name per decision, not per item. An item takes several decisions in its life — rework
 * after a verdict, rework after a base conflict, a merge approval — and an approver stops when it
 * has judged, leaving its tab listed. Named per item, that finished tab refused the launch of the
 * next decision's approver until somebody closed it by hand.
 *
 * Per decision and inside the runtime's limit, both (GY-101): the fixed prefix and an eight-
 * character decision fragment left four characters for the key, so every key from GY-10 up built a
 * 33-character name no runtime would take and no approver could be launched at all. The key is
 * kept whole now and the decision id takes what the limit leaves.
 */
/**
 * Two decisions whose fragments match are one session: the second launch is refused as already
 * visible, or adopted as the first decision's approver. So the full role word is kept only while it
 * leaves at least `approverDistinguisher` characters of the decision id (one collision in ~16
 * million per pair, against one in 65,536 at the four the generic floor accepts); past that the
 * role word gives way to `gy-approver`, which affords the full eight for any key up to GY-12345678.
 */
export const approverDistinguisher = 6;
export const approverSessionName = (work: Pick<Work, 'key'>, decision: string) =>
  distinctSessionName(sessionNameLimit - sessionName('graphyard-approver', work.key).length - 1 >= approverDistinguisher ? ['graphyard-approver'] : ['gy-approver'], work.key, decision);
/**
 * The names an approver's and an escalation handler's exhaustion is held under when the session
 * ran on no named account: the runtime's own login, which every launch of the role shares.
 */
export const approverProfile = 'approver', escalationProfile = 'escalation-handler';
/** The runtime an approver runs on when nothing names an account or a runtime for it. */
export const approverRuntime = (config: Pick<MasterConfig, 'reviewers' | 'workers'>) => config.reviewers[0]?.kind ?? config.workers[0]?.kind;
/**
 * Where an approver may run when the agent registry does not decide the role (GY-182): the accounts
 * the reviewer profiles name — the runtime an approver already borrowed — or, with none named, the
 * worker profiles'. An approver is a capacity role like any other, so an account a session of any
 * role saw spent is skipped until its reset, and the next account takes the decision.
 */
export function approverProfiles(config: Pick<MasterConfig, 'reviewers' | 'workers'>) {
  const named = <P extends { name: string; accounts?: string[] }>(profiles: P[]) => profiles.filter(profile => profile.accounts?.length).map(profile => ({ name: profile.name, accounts: profile.accounts! }));
  const reviewers = named(config.reviewers);
  return reviewers.length ? reviewers : named(config.workers.filter(profile => profile.mode === 'launch'));
}
export type ApproverSelection = { fleet: NonNullable<Awaited<ReturnType<typeof selectFleetSession>>>; account: FleetLaunchAccount; profile: string; skipped: AccountSkip[] }
  | { fleet: null; account: AgentEnvironment | null; profile: string; skipped: AccountSkip[] };
/**
 * The account an approver launches on: the registry's approver role when it defines one, else the
 * first healthy, unheld account of `approverProfiles`, else the runtime's own login unless a session
 * saw it spent. Throws `NoHealthyAccountError` — `capacityExhausted` when every skip was spent quota.
 */
export async function selectApproverAccount(config: MasterConfig, work: string | null, principal: string, probe: FleetProbe = {}, kind = approverRuntime(config)): Promise<ApproverSelection> {
  const fleet = await selectFleetSession(config, 'approver', { name: approverProfile, principal }, await heldAwareProbe(config, { ...probe, work: work ?? undefined }));
  if (fleet) return { fleet, account: fleet.account, profile: approverProfile, skipped: fleet.skipped };
  const profiles = approverProfiles(config), skipped: AccountSkip[] = [];
  if (!profiles.length) { await selectAccount(config, 'approver', { name: approverProfile, kind }, { ...probe, work: work ?? undefined }); return { fleet: null, account: null, profile: approverProfile, skipped }; }
  for (const profile of profiles) {
    try {
      const selected = await selectAccount(config, 'approver', profile, { ...probe, work: work ?? undefined });
      return { fleet: null, account: selected.account as AgentEnvironment | null, profile: profile.name, skipped: [...skipped, ...selected.skipped] };
    } catch (error) { if (!(error instanceof NoHealthyAccountError)) throw error; skipped.push(...error.skipped); }
  }
  const spent = new NoHealthyAccountError(`No healthy agent account for the approver: ${skipped.map(entry => entry.reason).join('; ')}`, skipped);
  if (spent.capacityExhausted) throw spent;
  // A named account that is logged out or unconfigured is a fault to fix, not a wait: the approver
  // runs on the runtime's own login, as it did before it had accounts, unless that one is spent too.
  await selectAccount(config, 'approver', { name: approverProfile, kind }, { ...probe, work: work ?? undefined });
  return { fleet: null, account: null, profile: approverProfile, skipped };
}
/**
 * The runtime's own login for a role launched on an explicit runtime: no account is chosen, but a
 * login a session of any role saw spent is refused until its reset, as `selectAccount` refuses it.
 */
export async function heldRuntimeLogin(config: MasterConfig, role: LaunchRole, profile: string, work: string | null, probe: FleetProbe = {}, kind?: string): Promise<ApproverSelection> {
  const at = probe.now?.() ?? Date.now(), own = ownLoginHold(await observedExhaustions(config, at), { name: profile, kind });
  if (own) {
    const skip: AccountSkip = { at: new Date(at).toISOString(), role, profile, environment: own.key, reason: describeObservedExhaustion(`${profile}'s own account`, own.held), work, cause: 'exhausted' };
    await recordEnvironmentLog(config, [], [skip]).catch(() => {});
    throw new NoHealthyAccountError(`No healthy agent account for ${role} profile ${profile}: ${skip.reason}`, [skip]);
  }
  return { fleet: null, account: null, profile, skipped: [] };
}
/**
 * Undo a launch that failed after its tab or registry session existed: the tab is closed and the
 * registry session ended. One the registry could not be told of is named on the returned error
 * (`registrySession`), so the caller keeps the only id that can free the role's slot later.
 */
async function abandonLaunch(error: unknown, pane: string | undefined, tabId: string | undefined, selected: { release: (reason: string) => Promise<boolean>; account: FleetLaunchAccount } | null, reason: string, run?: ChildRun) {
  // Closed through the loop's own close path before the session is given back, and the failure
  // records it (GY-413); a close Herdr could not confirm is recorded too.
  let failure = error instanceof Error ? error : new Error(failureText(error));
  if (pane || tabId) {
    try { failure = withLaunchClose(failure, await closeFailedLaunch(pane, tabId, run)); }
    catch (closeError) { failure = withLaunchClose(failure, `Herdr could not confirm ${pane ? `pane ${pane}` : `tab ${tabId}`} closed: ${failureText(closeError).slice(0, 200)}`); }
  }
  if (selected && !await selected.release(reason)) Object.assign(failure, { registrySession: selected.account.fleet.session });
  return failure;
}
/**
 * The session record a decision's approver registers (GY-172): keyed on the decision, so a
 * relaunch for the same decision reopens it rather than adding a second, and bound to nothing the
 * item moves past — the session report closes it once its pane is gone, and the loop records it
 * ended when it closes the pane of a decision that settled.
 */
export const approverSessionId = (decision: string) => `approver:${decision}`;
export type SessionRegistrar = (handle: SessionHandleInput) => Promise<unknown>;
export async function launchApprover(root: string, work: Work, decision: string, explicitKind: NonNullable<WorkerProfile['kind']> | undefined, agents: HerdrAgent[], run?: ChildRun, probe: FleetProbe = {}, register?: SessionRegistrar,
  headless: { runner?: Runner; fetcher?: typeof fetch } = {}) {
  const config = await loadMasterConfig(root);
  const token = await agentToken(root, config, 'approver');
  const retry = `graphyard master approver ${work.key} ${decision} [AGENT_KIND]`;
  const name = nameForLaunch(retry, () => approverSessionName(work, decision));
  if (agents.some(agent => agent.name === name)) throw new Error(`Approver session ${name} is already visible in Herdr; let it finish or close it first`);
  // GY-169: with the approver's runtime set to `pi` (and no AGENT_KIND override) the approver is a
  // headless run under the same session name. Its verdict comes back as a validated
  // graphyard_decide call and is applied here as the approver identity, on the route `master
  // approve`/`master refuse` use, so the server's separation rules decide exactly as they do today.
  // GY-170: when the registry defines the approver role, its choice decides the runtime too — an
  // account of a `pi` runtime runs headless with that account's home, model and the role's policy,
  // and `run.runtimes`/`run.pi` configure only an approver the registry does not define.
  const registry = explicitKind ? null : await selectFleetSession(config, 'approver', { name: approverProfile, principal: config.approver!.id }, await heldAwareProbe(config, { runtime: { agents, available: true }, ...probe, work: work.key }));
  if (registry && registry.account.kind === 'pi') {
    let started: ReturnType<typeof startNarrowRun>;
    try {
      started = startNarrowRun({ runner: headless.runner ?? registryRunner(registry.account), name, role: 'approver', work: work.key, subject: decision,
        prompt: piApproverPrompt(config, work.key, decision, config.approver!.id),
        options: approverRunOptions(root, decision, { GRAPHYARD_URL: config.url, GRAPHYARD_TOKEN_FILE: config.approver!.credentialFile, GRAPHYARD_HOST_ID: config.hostId }, piRuntimeSchema.parse(config.run.pi ?? {}).approverTimeoutMinutes * 60_000),
        apply: async result => result.ok ? [await applyDecision(config.url, token, work, result.payload, headless.fetcher)] : [] });
    } catch (error) { await registry.release(`approver run for ${work.key} failed to start: ${failureText(error).slice(0, 300)}`); throw error; }
    // The run is the session: the registry's slot is given back the moment it ends.
    const settled = started.settled.finally(() => registry.release(`the headless approver run for ${work.key} ended`));
    settled.catch(() => { /* the run's own record carries its failure */ });
    return { agentName: name, work: work.key, decision, identity: config.approver!.id, pane: null as string | null, runtime: 'pi' as const, delivery: 'request' as RequestDelivery, focusChanged: false, session: registry.account.fleet.session,
      account: { environment: registry.account.name, kind: registry.account.kind, quota: registry.health?.quota ?? null, skipped: registry.skipped },
      run: started.record, settled: settled as Promise<RunRecord> | undefined };
  }
  if (!registry && !explicitKind && narrowRoleRuntime(config.run, 'approver') === 'pi') {
    const pi = piRuntimeSchema.parse(config.run.pi ?? {});
    const started = startNarrowRun({ runner: headless.runner ?? narrowRunner(pi), name, role: 'approver', work: work.key, subject: decision,
      prompt: piApproverPrompt(config, work.key, decision, config.approver!.id),
      options: approverRunOptions(root, decision, { GRAPHYARD_URL: config.url, GRAPHYARD_TOKEN_FILE: config.approver!.credentialFile, GRAPHYARD_HOST_ID: config.hostId }, pi.approverTimeoutMinutes * 60_000),
      apply: async result => result.ok ? [await applyDecision(config.url, token, work, result.payload, headless.fetcher)] : [] });
    return { agentName: name, work: work.key, decision, identity: config.approver!.id, pane: null as string | null, runtime: 'pi' as const, delivery: 'request' as RequestDelivery, focusChanged: false, session: null, account: null,
      run: started.record, settled: started.settled as Promise<RunRecord> | undefined };
  }
  // The approver's runtime and account come from the registry's approver role. An explicit
  // AGENT_KIND is the operator's override; an installation whose registry has no approver role
  // yet runs the approver on its first reviewer profile's runtime. No runtime is assumed.
  // The override picks the runtime, never past a hold: the runtime's own login a session saw spent
  // is not launched on again before its reset, whichever form of the command asked for it.
  // The sessions Herdr lists are what the role's count is judged against (GY-190): an approver that
  // judged its decision and exited no longer holds a slot the next one needs.
  const chosen = explicitKind ? await heldRuntimeLogin(config, 'approver', approverProfile, work.key, probe, explicitKind)
    : registry ? { fleet: registry, account: registry.account, profile: approverProfile, skipped: registry.skipped } satisfies ApproverSelection
    : await selectApproverAccount(config, work.key, config.approver!.id, { runtime: { agents, available: true }, ...probe });
  const selected = chosen?.fleet ?? null;
  // Nothing here names a runtime: the role's account decides, then the operator's own argument,
  // then a runtime this installation already configured for another session.
  const kind = chosen?.account?.kind ?? explicitKind ?? approverRuntime(config);
  // A launch refused for its runtime gives the chosen session back at once (GY-184).
  const plan = () => {
    if (!kind) throw new Error('No runtime is configured for the approver: name accounts for the approver role with graphyard master registry role set approver ACCOUNT[,ACCOUNT…] --reason REASON, or pass AGENT_KIND');
    return accountLaunch({ kind, approvals: 'auto', agentArgs: [], environment: {} }, chosen?.account ?? null);
  };
  let launch: ReturnType<typeof accountLaunch>;
  try { launch = plan(); }
  catch (error) { await selected?.release(`approver launch for ${work.key} failed: ${failureText(error).slice(0, 300)}`); throw error; }
  const cli = `node ${config.cliPath}`;
  let delivery: RequestDelivery | undefined;
  const prompt = `You are the independent Graphyard approver for ${config.repository}, acting as ${config.approver!.id}. Judge decision ${decision} on ${work.key}: run ${cli} master decisions ${work.key}, read the item with ${cli} status ${work.key}, its pull request and history, and weigh the requester's reason against the item's criteria and the operator's goals. If it is justified, run ${cli} master approve ${work.key} ${decision} "YOUR REASON". If not, record the refusal: run ${cli} master refuse ${work.key} ${decision} "YOUR REASON" — a decline is recorded, never expressed by exiting. Never approve a decision you requested, implemented, or produced evidence for; never edit, push, merge, review, or submit evidence. Stop when the decision is judged.`;
  let pane: string | undefined, tabId: string | undefined;
  try {
    const created = createdHerdrTab(await herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', root, '--label', `Approver · ${work.key}`, '--env', `GRAPHYARD_URL=${config.url}`, '--env', `GRAPHYARD_TOKEN_FILE=${config.approver!.credentialFile}`, '--env', 'GRAPHYARD_APPROVER=1', '--env', `GRAPHYARD_HOST_ID=${config.hostId}`, ...Object.entries(launch.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'], run));
    pane = created.pane; tabId = created.tab;
    // Registered with its pane before its runtime starts (GY-172 AC-2), so the session report
    // observes this approver like every other session and closes it once it is gone.
    ({ delivery } = await registeredLaunch(register, { id: approverSessionId(decision), kind: 'coordination', role: 'approver', principal: config.approver!.id, runtime: kind, host: config.hostId,
      agentName: name, pane: created.pane, attach: herdrAttach(created.pane, config.herdrWorkspace), ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}),
      subject: `${work.key}: judge decision ${decision}`, state: 'running' }, () => startAgentSession(name, kind, created.pane, launch.args, prompt, run, { directory: root, retry, contract: launch.contract, environment: launch.environment, timeoutMs: launchStartMs(config) }), () => undefined));
  } catch (error) {
    throw await abandonLaunch(error, pane, tabId, selected, `approver launch for ${work.key} failed: ${failureText(error).slice(0, 300)}`, run);
  }
  const spentOn = selected?.account.name ?? chosen?.account?.name ?? null;
  // The registry session is kept with the launch: the loop ends it once the decision is judged, or
  // the moment the session is spent.
  const session = selected?.account.fleet.session ?? null;
  // The record is part of the launch: without it an adopted session's spent account and registry
  // slot are unknown, so a launch whose record cannot be written is closed and fails.
  // It names the item and decision too (GY-403), so the loop watches a session `master approver`
  // launched exactly as one of its own, and closes it once its decision settles.
  try { await saveApproverLaunch(root, { agentName: name, account: spentOn, runtime: kind, session, launchedAt: new Date().toISOString(), work: work.key, decision }); }
  catch (error) { throw await abandonLaunch(error, pane, tabId, selected, `approver launch record for ${work.key} could not be written: ${failureText(error).slice(0, 300)}`, run); }
  return { agentName: name, work: work.key, decision, identity: config.approver!.id, pane: pane! as string | null, delivery, focusChanged: false, runtime: kind as string, session,
    account: selected ? { environment: selected.account.name, kind, reason: selected.selection.reason, skipped: selected.skipped }
      : chosen?.account ? { environment: chosen.account.name, kind, reason: `the first healthy account of profile ${chosen.profile}`, skipped: chosen.skipped } : null,
    run: null as RunRecord | null, settled: undefined as Promise<RunRecord> | undefined };
}

/**
 * The account each approver session was launched on (GY-182). The loop adopts a session a master
 * started with `master approver` rather than launching its own, and an adopted session that stops
 * on a limit notice must hold the account it actually spent, not the runtime's own login.
 */
export const approverLaunchSchema = z.object({ agentName: z.string().max(200), account: z.string().max(200).nullable(), runtime: z.string().max(40).nullable(),
  /** The agent registry session the launch holds, when the registry chose its account. */
  session: z.string().max(200).nullable().default(null), launchedAt: z.string(),
  /** The item and decision it judges (GY-403): the loop registers the session in its approval watch from these. */
  work: z.string().max(40).nullable().default(null), decision: z.string().max(100).nullable().default(null) }).strict();
export type ApproverLaunch = z.infer<typeof approverLaunchSchema>;
const approverLaunchesPath = async (root: string) => resolve(await localDirectory(root), 'approvers', 'launches.json');
/** Every approver launch recorded on this host within the last day. */
export async function readApproverLaunches(root: string): Promise<ApproverLaunch[]> {
  try { return z.array(approverLaunchSchema).parse(JSON.parse(await readFile(await approverLaunchesPath(root), 'utf8'))); } catch { return []; }
}
export async function readApproverLaunch(root: string, agentName: string): Promise<ApproverLaunch | null> {
  return (await readApproverLaunches(root)).findLast(entry => entry.agentName === agentName) ?? null;
}
/** Record the launch of `launch.agentName`, replacing an earlier one of that name; records past a day are dropped. */
export async function saveApproverLaunch(root: string, launch: z.input<typeof approverLaunchSchema>, now = Date.now()) {
  const file = await approverLaunchesPath(root);
  let kept: ApproverLaunch[] = [];
  try { kept = z.array(approverLaunchSchema).parse(JSON.parse(await readFile(file, 'utf8'))); } catch { /* a missing or unreadable record starts empty */ }
  kept = kept.filter(entry => entry.agentName !== launch.agentName && now - Date.parse(entry.launchedAt) < escalationSessionMs);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await atomicPrivateWrite(file, [...kept, approverLaunchSchema.parse(launch)].slice(-retainedEscalationSessions));
}

/** The approver role's accounts as `roleCapacity` reads them: whether any is left, and each one's reset. */
export async function approverRoleHealth(config: MasterConfig, probe: EnvironmentProbe = {}) {
  const named = approverProfiles(config), profiles = named.length ? named : [{ name: approverProfile, kind: approverRuntime(config) }];
  return { profiles, health: await inspectProfileAccounts(config, 'approver', profiles, Object.fromEntries(profiles.map(profile => [profile.name, { available: true, reason: null as string | null }])), probe) };
}

/**
 * The escalation-handler role's accounts as `roleCapacity` reads them, as `approverRoleHealth` does
 * for the approver. A handler launches on the runtime its escalation names, so `runtimes` — those of
 * the handlers waiting to launch again — are each checked: a runtime's own login another role saw
 * spent bars the handler too. The role has capacity while any of them can launch.
 */
export async function escalationRoleHealth(config: MasterConfig, probe: EnvironmentProbe = {}, runtimes: string[] = []) {
  const profiles = [{ name: escalationProfile }], results: { available: boolean; reason: string | null; accounts?: ProfileAccountHealth[] }[] = [];
  for (const kind of runtimes.length ? [...new Set(runtimes)] : [undefined]) {
    results.push((await inspectProfileAccounts(config, 'escalation-handler', [{ name: escalationProfile, kind }], { [escalationProfile]: { available: true, reason: null as string | null } }, probe))[escalationProfile]);
  }
  const usable = results.find(result => result.available);
  return { profiles, health: { [escalationProfile]: usable ?? { available: false, reason: results.map(result => result.reason).filter(Boolean).join('; ') || null, accounts: results.flatMap(result => result.accounts ?? []) } } };
}

/**
 * The escalation handlers this host launched and has not seen end (GY-182). A handler is launched
 * by a master, not by the loop, so this is what lets the loop find one that stopped on its
 * provider's limit notice, hold the account and launch the same escalation again elsewhere.
 * `waiting` is a handler ended for spent quota with no account left: it is launched again once
 * `retryAt` passes. One that finished — stopped with no notice, or gone from Herdr — is ended by
 * the loop too, so the registry session it holds does not keep the role's slot.
 */
export const escalationSessionSchema = z.object({
  agentName: z.string().max(200), pane: z.string().max(200).nullable(), work: z.string().max(40), trigger: z.string().max(64),
  kind: z.string().max(40), account: z.string().max(200).nullable(), runtime: z.string().max(40).nullable(), launchedAt: z.string(),
  /** The agent registry session the handler holds, when the registry chose its account: ended with the handler. */
  session: z.string().max(200).nullable().default(null),
  waiting: z.object({ since: z.string(), retryAt: z.string(), reason: z.string().max(500) }).strict().nullable().default(null),
  /** When the loop first saw the handler stopped with no limit notice: past a grace, it has finished. */
  idleSince: z.string().optional(),
}).strict();
export type EscalationSession = z.infer<typeof escalationSessionSchema>;
export const retainedEscalationSessions = 50, escalationSessionMs = 86_400_000;
/** With no reset known for a spent account, a waiting handler is tried again this soon (the loop's capacity recheck). */
const escalationCapacityRecheckMs = 60_000;
const escalationSessionsPath = async (root: string) => resolve(await localDirectory(root), 'escalations', 'sessions.json');
export async function readEscalationSessions(root: string): Promise<EscalationSession[]> {
  try { return z.array(escalationSessionSchema).parse(JSON.parse(await readFile(await escalationSessionsPath(root), 'utf8'))); } catch { return []; }
}
/**
 * Replace the handler of `work`/`trigger` (or drop it with `session` null). A running handler's
 * record is dropped a day after launch, or when more than the retained count are running; a waiting
 * one is kept until a day past its `retryAt`, however many there are, so a weekly reset still finds
 * the escalation to launch again.
 */
export async function saveEscalationSession(root: string, work: string, trigger: string, session: EscalationSession | null, now = Date.now()) {
  const current = (entry: EscalationSession) => now - Date.parse(entry.waiting ? entry.waiting.retryAt : entry.launchedAt) < escalationSessionMs;
  const kept = (await readEscalationSessions(root)).filter(entry => !(entry.work === work && entry.trigger === trigger) && current(entry));
  const file = await escalationSessionsPath(root); await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // The count bounds running and finished records only: a waiting one is the loop's only way to
  // launch its escalation again, so it stays until the time filter above lets it go.
  const all = [...kept, ...(session ? [session] : [])], launched = all.filter(entry => !entry.waiting);
  const evicted = new Set(launched.slice(0, Math.max(0, launched.length - retainedEscalationSessions)));
  await atomicPrivateWrite(file, all.filter(entry => !evicted.has(entry)));
}

/**
 * `master review` registers the reviewer session before its runtime starts (GY-172 AC-2), keyed on
 * the review request it answers, as the loop's own reviewer launches are; the pane and name the
 * launcher returns are written over the registration once it has started. `launch` is the reviewer
 * launcher itself, which still refuses an unknown item or profile with its own reason.
 */
export async function registeredReview<T>(config: MasterConfig, args: string[], snapshot: { work: Work[] }, mutate: (path: string, body: unknown) => Promise<unknown>, launch: () => Promise<T>) {
  const work = snapshot.work.find(item => item.id === args[0] || item.key === args[0]);
  const profile = args[1] ? config.reviewers.find(entry => entry.name === args[1]) : config.reviewers.length === 1 ? config.reviewers[0] : undefined;
  if (!work?.candidate || !profile) return launch();
  const request = liveReviewRequest(work), sha = work.candidate.sha, id = request?.id ?? `review:${sha}`;
  // A reviewer another launch registered for this request is not this call's to close: the
  // registration carries this attempt's token and the control plane refuses to register over, or
  // close, a running handle another attempt holds — checked in its mutation, not against this
  // snapshot, which a concurrent `master review` or the loop's own reviewer launch shares. A running
  // handle with no token predates that rule and has nothing to hold it, so it is left alone here.
  if (work.sessions?.some(handle => handle.id === id && handle.state === 'running' && handle.head === sha && !handle.launch)) return launch();
  return registeredLaunch(handle => mutate(`work/${work.id}/session`, handle), { id, kind: 'review', role: 'review', head: sha, runtime: profile.kind, host: config.hostId,
    ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}), subject: `${work.key}: review ${sha.slice(0, 12)} (PR #${work.candidate.pr})`, state: 'running' },
  launch, launched => launched as { pane?: string | null; agentName?: string | null }, pane => herdrAttach(pane, config.herdrWorkspace));
}

/**
 * A context the handler received is what the control plane assembled: the fingerprint covers
 * every byte but itself, so a document altered or abridged on the way is refused before it is judged.
 */
export function verifiedContext(context: EscalationContext) {
  const { fingerprint, ...document } = context;
  if (contextFingerprint(document) !== fingerprint) throw new Error(`The escalation context for ${context.key} does not match its fingerprint ${fingerprint}; fetch it again from the control plane`);
  return context;
}
/**
 * Spawn a judging session for one escalation (GY-90). It is a fresh master: its whole input is
 * the assembled context, written to one private file, and the escalation inside it. It holds no
 * loop state, reads nothing else, and records its decision with `master decide … --precedent
 * --context`, so the ledger carries the reason, the precedent it relied on and what it saw; with
 * no precedent to cite it decides without `--precedent`, and the ledger records that (GY-138).
 */
export async function launchEscalationHandler(root: string, config: MasterConfig, context: EscalationContext, kind: NonNullable<WorkerProfile['kind']>, agents: HerdrAgent[], run?: ChildRun, register?: SessionRegistrar) {
  await agentToken(root, config, 'operatorAgent');
  const escalationRetry = `graphyard master escalation ${context.key} ${context.escalation.trigger} ${kind}`;
  const name = nameForLaunch(escalationRetry, () => distinctSessionName(['graphyard-escalation', 'graphyard-esc', 'gy-esc'], context.key, context.escalation.trigger));
  if (agents.some(agent => agent.name === name)) throw new Error(`Escalation handler ${name} is already visible in Herdr; let it finish or close it first`);
  // A capacity role like any other (GY-182): the registry's escalation-handler role chooses the
  // account when it defines one, and a login a session saw spent is not launched on before it resets.
  let selected: Awaited<ReturnType<typeof selectFleetSession>>;
  try {
    selected = await selectFleetSession(config, 'escalation-handler', { name, principal: config.operatorAgent!.id }, await heldAwareProbe(config, { work: context.key }));
    if (!selected) await selectAccount(config, 'escalation-handler', { name: escalationProfile, kind }, { work: context.key });
  } catch (error) {
    if (!(error instanceof NoHealthyAccountError) || !error.capacityExhausted) throw error;
    // Every account is already spent before this handler starts — another role may have held a
    // shared one. The escalation is kept as a waiting record, so the loop reports the capacity
    // wait and launches it again once the first held account resets, with no one retrying it.
    const at = Date.now(), held = await observedExhaustions(config, at);
    const retryAt = capacityRetryAt(error.skipped.map(skip => ({ resetsAt: held[skip.environment]?.until ?? null }))) ?? new Date(at + escalationCapacityRecheckMs).toISOString();
    await saveEscalationSession(root, context.key, context.escalation.trigger, { agentName: name, pane: null, work: context.key, trigger: context.escalation.trigger, kind, account: null, runtime: null, launchedAt: new Date(at).toISOString(), session: null,
      waiting: { since: new Date(at).toISOString(), retryAt, reason: error.message.slice(0, 500) } });
    // The wait rides on the error, so a loop that ended a spent handler keeps it rather than its own guess.
    throw Object.assign(new NoHealthyAccountError(`${error.message}; the escalation waits and the loop launches it again at ${retryAt}`, error.skipped), { retryAt });
  }
  const runtime = selected?.account.kind ?? kind;
  const directory = resolve(await localDirectory(root), 'escalations'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, `${context.key}-${context.escalation.trigger}-${context.fingerprint.slice(0, 12)}.json`);
  await atomicPrivateWrite(file, context);
  // A launch refused for its runtime gives the chosen session back at once (GY-184).
  let launch: ReturnType<typeof accountLaunch>;
  try { launch = accountLaunch({ kind: runtime, approvals: 'auto', agentArgs: [], environment: {} }, selected?.account ?? null); }
  catch (error) { await selected?.release(`escalation handler launch for ${context.key} failed: ${failureText(error).slice(0, 300)}`); throw error; }
  const cli = `node ${config.cliPath}`;
  const prompt = `You are a Graphyard escalation handler spawned for the ${context.escalation.trigger} escalation on ${context.key} in ${config.repository}, acting as ${config.operatorAgent!.id}. Your entire input is the file ${file}: the context the control plane assembled for this decision — the repository's own operating rules and policy, the current goals and priorities, the item (requirements, the standing refusal, the candidate, its typed history) and precedent (earlier ${escalationAction} decisions with their reasons and outcomes). Read that file and nothing else: do not run status, events or any other read, do not open the repository, and hold no state beyond it. Decide whether the ${context.escalation.trigger} escalation should be resolved, following the precedent that applies and saying which. If it should, run ${cli} master decide ${context.key} ${escalationAction} '{"trigger":"${context.escalation.trigger}"}' --precedent DECISION_ID[,DECISION_ID] --context ${context.fingerprint} "YOUR REASON" exactly once, citing only ids listed in precedent.detail; when precedent.detail lists no decision that applies, leave out --precedent and the control plane records that no precedent was available — never invent an id. An independent approver judges it. If it should not, request nothing and state the reason in this tab. Never edit, push, merge, review, approve or submit evidence. Stop when the decision is recorded or declined.`;
  let pane: string | undefined, tabId: string | undefined, delivery: RequestDelivery | undefined;
  try {
    const created = createdHerdrTab(await herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', root, '--label', `Escalation · ${context.key}`, '--env', `GRAPHYARD_URL=${config.url}`, '--env', 'GRAPHYARD_ESCALATION_HANDLER=1', '--env', `GRAPHYARD_HOST_ID=${config.hostId}`, ...Object.entries(launch.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'], run));
    pane = created.pane; tabId = created.tab;
    // The instruction is the session's own first request (GY-93), never pasted into it: a handler
    // that refused a pasted prompt would record no decision and leave the escalation standing.
    // Registered first, like every launched session (GY-172 AC-2).
    ({ delivery } = await registeredLaunch(register, { id: `escalation:${context.escalation.trigger}:${context.fingerprint.slice(0, 12)}`, kind: 'coordination', role: 'escalation', principal: config.operatorAgent!.id, runtime, host: config.hostId,
      agentName: name, pane: created.pane, attach: herdrAttach(created.pane, config.herdrWorkspace), ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}),
      subject: `${context.key}: handle the ${context.escalation.trigger} escalation`, state: 'running' }, () => startAgentSession(name, runtime, created.pane, launch.args, prompt, run, { directory: root, retry: escalationRetry, environment: launch.environment, timeoutMs: launchStartMs(config) }), () => undefined));
  } catch (error) {
    const failure = await abandonLaunch(error, pane, tabId, selected, `escalation handler launch for ${context.key} failed: ${failureText(error).slice(0, 300)}`, run);
    // A registry session that could not be ended is kept on a record due now: the loop ends it
    // before it launches the escalation again, so the role's slot is never left orphaned.
    const orphan = (failure as { registrySession?: string }).registrySession;
    if (orphan) {
      const at = new Date().toISOString();
      await saveEscalationSession(root, context.key, context.escalation.trigger, { agentName: name, pane: null, work: context.key, trigger: context.escalation.trigger, kind, account: selected?.account.name ?? null, runtime, launchedAt: at, session: orphan,
        waiting: { since: at, retryAt: at, reason: `the launch failed (${failureText(error)}) and its registry session could not be ended`.slice(0, 500) } }).catch(() => {});
    }
    throw failure;
  }
  // The record is part of the launch: it is how the loop finds a handler that stopped on a limit
  // notice and ends its registry session, so a launch whose record cannot be written is closed and fails.
  try { await saveEscalationSession(root, context.key, context.escalation.trigger, { agentName: name, pane: pane!, work: context.key, trigger: context.escalation.trigger, kind, account: selected?.account.name ?? null, runtime, launchedAt: new Date().toISOString(), session: selected?.account.fleet.session ?? null, waiting: null }); }
  catch (error) { throw await abandonLaunch(error, pane, tabId, selected, `escalation handler record for ${context.key} could not be written: ${failureText(error).slice(0, 300)}`, run); }
  return { agentName: name, work: context.key, trigger: context.escalation.trigger, fingerprint: context.fingerprint, context: file, identity: config.operatorAgent!.id, pane: pane!, delivery, focusChanged: false, account: selected?.account.name ?? null };
}

export const broadScopeFlag = '--allow-broad-scope';
/**
 * Where planned files are set — `master create`, `master requirements`, `master scope` — a
 * root-level directory scope is refused with the narrower paths it should name (AC-2 of GY-112),
 * unless the command carries --allow-broad-scope: the exception is then written into the audited
 * reason, naming the scopes, so it is explicit and attributable to the identity that set it. A
 * revision is judged on the scopes it introduces; one the item already carries is not re-refused.
 */
export function guardBroadScope(input: { plannedFiles?: string[]; title?: string; description?: string; criteria?: { text: string }[] }, reason: string, options: { allow: boolean; command: string; existing?: string[] }) {
  const refusals = broadScopeRefusals(input.plannedFiles ?? [], [input.title ?? '', input.description ?? '', ...(input.criteria ?? []).map(criterion => criterion.text)]).filter(refusal => !options.existing?.includes(refusal.scope));
  if (!refusals.length) return reason;
  if (!options.allow) throw new Error(`${options.command} refused a high-conflict scope: ${refusals.map(refusal => refusal.reason).join('; ')}. Pass ${broadScopeFlag} to record the exception in the audited reason instead`);
  return `Broad scope exception (${refusals.map(refusal => refusal.scope).join(', ')}) recorded with ${broadScopeFlag}: ${reason}`;
}
export const autonomySubcommands = ['autonomy', 'create', 'release', 'unblock', 'requirements', 'repair', 'decide', 'decisions', 'approve', 'approver', 'principals', 'restart', 'environments', 'context', 'escalation'] as const;
export interface AutonomyDependencies {
  coordinator: (path: string) => Promise<any>;
  readSecret: () => Promise<string>;
  agents: () => HerdrAgent[] | Promise<HerdrAgent[]>;
  daemonLock: () => Promise<{ pid: number; host: string; heartbeatAt: string } | null>;
  /** A coordinator-authenticated mutation, with which a session this command launches is registered before it starts (GY-172). */
  mutate?: (path: string, body: unknown) => Promise<unknown>;
  /** The runner a launched session's runtime calls go through; the asynchronous runner when omitted. */
  runtime?: ChildRun;
  fetcher?: typeof fetch;
  /** Runs the roster applier; the default is the asynchronous runner with the applier's output passed through. */
  run?: (command: string, args: string[], options?: ChildRunOptions) => string | Buffer | Promise<string | Buffer>;
  /**
   * Refuses a `decide` the caller does not own (GY-175), judged on the exact work document and
   * snapshot clock the decision is then built from, so a later read cannot move the item under it.
   */
  assertDecision?: (work: Work, action: string, input: unknown, now: number) => void | Promise<void>;
}
const words = (args: string[]) => args.join(' ').trim();
async function jsonArgument(value: string) { return JSON.parse(value.startsWith('@') ? await readFile(value.slice(1), 'utf8') : value); }
/**
 * The autonomy subcommands of `graphyard master`: onboarding the agent identities, the master's
 * own intent commands, two-party decisions, the approver session, roster rotation and the loop
 * restart. Each authenticates as the identity the command belongs to, never as another.
 */
export async function runAutonomyCommand(root: string, config: MasterConfig, id: string, args: string[], deps: AutonomyDependencies) {
  if (!(autonomySubcommands as readonly string[]).includes(id)) throw new Error(`Unknown autonomy command ${id}`);
  const fetcher = deps.fetcher ?? fetch;
  const call = async (token: string, path: string, body?: unknown) => {
    const response = await fetcher(`${config.url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': process.env.GRAPHYARD_REQUEST_ID ?? randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
  };
  const operator = () => agentToken(root, config, 'operatorAgent');
  const registrar = (work: string): SessionRegistrar | undefined => deps.mutate ? handle => deps.mutate!(`work/${encodeURIComponent(work)}/session`, handle) : undefined;
  const snapshotItem = async (key: string | undefined) => {
    if (!key) throw new Error(`Use master ${id} GY-N …`);
    const snapshot = await deps.coordinator('work-snapshot'), found = snapshot.work.find((work: Work) => work.id === key || work.key === key);
    if (!found) throw new Error(`Unknown work item ${key}`); return { work: found as Work, now: Date.parse(snapshot.now) };
  };
  const item = async (key: string | undefined) => (await snapshotItem(key)).work;
  const reason = (rest: string[]) => { const text = words(rest); if (!text) throw new Error(`master ${id} needs a REASON; every agent decision is attributable`); return text; };
  if (id === 'environments') {
    // The agent accounts sessions run on: discover or create them, report login and quota, and
    // with --apply generate profiles from the logged-in ones (see setupAgentEnvironments).
    const value = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
    const create = (value('--create') ?? '').split(',').filter(Boolean) as EnvironmentKind[];
    if (create.some(kind => !environmentKinds.includes(kind))) throw new Error(`master environments --create takes ${environmentKinds.join(', ')}`);
    return setupAgentEnvironments(root, { directory: value('--directory'), create, apply: args.includes('--apply'), verify: token => call(token, 'status') });
  }
  if (id === 'autonomy') {
    const apply = args.includes('--apply'), harness = args[args.indexOf('--harness') + 1];
    if (apply && !args.includes('--admin-token-stdin')) throw new Error('Use master autonomy --admin-token-stdin --apply so the admin credential is not stored in shell history');
    return setupAutonomy(root, { apply, adminToken: apply ? await deps.readSecret() : undefined, ...(args.includes('--harness') ? { harness } : {}) }, fetcher);
  }
  const allowBroad = args.includes(broadScopeFlag); args = args.filter(argument => argument !== broadScopeFlag);
  if (id === 'create') {
    if (!args[0]) throw new Error(`Use master create FILE [${broadScopeFlag}] REASON`);
    const input = await jsonArgument(`@${args[0]}`);
    return call(await operator(), 'work', { ...input, reason: guardBroadScope(input, reason(args.slice(1)), { allow: allowBroad, command: 'master create' }) });
  }
  if (id === 'release' || id === 'unblock') {
    const work = await item(args[0]);
    return call(await operator(), `work/${work.id}/${id === 'release' ? 'ready' : 'unblock'}`, { expectedRevision: work.revision, reason: reason(args.slice(1)) });
  }
  if (id === 'repair') {
    // The coordinator's own request (GY-127): the control plane resets a branch found carrying
    // another item's unlanded commits to the item's own reviewed head and merges the base onto it.
    // The command records the request; the reconciliation job runs it and master status reports it.
    const work = await item(args[0]);
    const contamination = branchContamination(work, (await deps.coordinator('work-snapshot')).work as Work[]);
    if (!contamination) throw new Error(`${work.key} head ${work.candidate?.sha.slice(0, 12) ?? '(none)'} carries no other item's unlanded commits; there is nothing to repair`);
    if (pendingRestore(work)) throw new Error(`A repair of ${work.key} is already requested; graphyard master status reports it under contamination.restore`);
    return call(await readCredentialFile(config.credentialFile), `work/${work.id}/repair`, { reason: reason(args.slice(1)) });
  }
  if (id === 'requirements') {
    const work = await item(args[0]); if (!args[1]) throw new Error(`Use master requirements GY-N FILE [${broadScopeFlag}] REASON`);
    const input = decisionInput('requirements', work, await jsonArgument(`@${args[1]}`)) as { plannedFiles?: string[]; criteria?: { text: string }[] };
    return call(await operator(), `work/${work.id}/requirements`, { ...input, reason: guardBroadScope({ ...input, title: work.title, description: work.description }, reason(args.slice(2)), { allow: allowBroad, command: 'master requirements', existing: work.plannedFiles }) });
  }
  if (id === 'decide') {
    const { work, now } = await snapshotItem(args[0]); const action = args[1];
    if (!action) throw new Error('Use master decide GY-N ACTION [JSON|@FILE] [--precedent ID[,ID]] [--context FINGERPRINT] REASON');
    // A handler cites the decisions it followed and the fingerprint of the context it judged from.
    const flags: Record<string, string> = {}; const rest: string[] = [];
    for (let index = 2; index < args.length; index++) {
      if (args[index] === '--precedent' || args[index] === '--context') { flags[args[index].slice(2)] = args[++index] ?? ''; continue; }
      rest.push(args[index]);
    }
    const explicit = rest[0] && /^[{@]/.test(rest[0]);
    const input = explicit ? await jsonArgument(rest[0]) : {};
    await deps.assertDecision?.(work, action, input, now);
    return call(await operator(), `work/${work.id}/decide`, { action, input: decisionInput(action, work, input), reason: reason(rest.slice(explicit ? 1 : 0)),
      ...(flags.precedent ? { precedent: flags.precedent.split(',').map(value => value.trim()).filter(Boolean) } : {}), ...(flags.context ? { context: flags.context } : {}) });
  }
  if (id === 'context' || id === 'escalation') {
    // The assembled context, read from the control plane by key and nothing else — no snapshot,
    // no status; `escalation` then spawns a fresh handler on it: the built-in precedent rule in
    // this process, or a judging session of KIND.
    if (!args[0]) throw new Error(`Use master ${id} GY-N [TRIGGER] [--budget N]${id === 'escalation' ? ' [precedent|AGENT_KIND]' : ''}`);
    const rest: string[] = []; let budget: string | undefined;
    for (let index = 1; index < args.length; index++) { if (args[index] === '--budget') budget = args[++index]; else rest.push(args[index]); }
    const trigger = rest.find(value => (escalationTriggers as readonly string[]).includes(value));
    const params = new URLSearchParams(); if (trigger) params.set('trigger', trigger); if (budget) params.set('budget', budget);
    const context = verifiedContext(await deps.coordinator(`work/${encodeURIComponent(args[0])}/context${params.size ? `?${params}` : ''}`));
    if (id === 'context') return context;
    const handler = rest.find(value => value !== trigger) ?? 'precedent';
    if (handler === 'precedent') return handleEscalation(context, followPrecedent, async request => call(await operator(), `work/${encodeURIComponent(context.key)}/decide`, request));
    return launchEscalationHandler(root, config, context, agentKindSchema.parse(handler), await deps.agents(), deps.runtime, registrar(context.key));
  }
  if (id === 'decisions') return deps.coordinator(`work/${encodeURIComponent((await item(args[0])).id)}/decisions`);
  if (id === 'approve') {
    // The server refuses self-approval; this refuses the master's session before it asks.
    if (process.env.GRAPHYARD_MASTER === '1') throw new Error('The master never approves its own decisions; graphyard master approver GY-N DECISION launches the independent approver session');
    const file = process.env.GRAPHYARD_TOKEN_FILE;
    if (!file) throw new Error('master approve runs in an approver session, which carries its own credential file in GRAPHYARD_TOKEN_FILE');
    const token = await readCredentialFile(file);
    for (const own of [config.credentialFile, config.operatorAgent?.credentialFile]) if (own && token === await readCredentialFile(own).catch(() => null)) throw new Error('That is one of the master\'s own credentials; approvals come from the approver identity');
    const work = await item(args[0]); if (!args[1]) throw new Error('Use master approve GY-N DECISION REASON');
    return call(token, `work/${work.id}/approve`, { decision: args[1], reason: reason(args.slice(2)) });
  }
  if (id === 'approver') {
    const work = await item(args[0]); if (!args[1]) throw new Error('Use master approver GY-N DECISION [AGENT_KIND]');
    const launched = await launchApprover(root, work, args[1], args[2] ? agentKindSchema.parse(args[2]) : undefined, await deps.agents(), deps.runtime, {}, registrar(work.id));
    // A headless approver runs in this process, so the command waits for its verdict and reports the run.
    const { settled, ...report } = launched;
    return settled ? { ...report, run: await settled } : report;
  }
  if (id === 'principals') {
    const live = (await deps.coordinator('principals')).principals;
    const preview = previewPrincipalRotation(live, await readProposedRoster(root));
    if (!args.includes('--apply')) return { ...preview, applied: false, next: preview.applicable ? 'Rerun with --apply to deploy the roster' : 'Restore every live principal in .graphyard/credentials.json; a rotation never drops one' };
    if (!preview.applicable) throw new Error(`Roster rotation refused: ${preview.refusals.join('; ')}`);
    const applier = resolve(root, 'scripts/provision-railway.mjs');
    try { await lstat(applier); } catch { throw new Error('This repository has no roster applier (scripts/provision-railway.mjs); deploy GRAPHYARD_PRINCIPALS with the configured provider'); }
    await (deps.run ?? defaultChildRun)(process.execPath, [applier], { cwd: root, env: { ...process.env, GRAPHYARD_URL: config.url }, stdout: 'inherit', stderr: 'inherit' });
    return { ...preview, applied: true, next: 'Redeploy the service so the roster takes effect, then graphyard master status' };
  }
  return restartMasterLoop(root, config, await deps.daemonLock());
}
