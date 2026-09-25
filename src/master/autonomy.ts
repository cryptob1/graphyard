// Concern: agent identities and autonomy — approver and escalation launches, and the autonomy commands.
import { randomUUID, randomBytes } from 'node:crypto';
import { readFile, mkdir, lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { type ChildRun, type ChildRunOptions, defaultChildRun } from '../child-runner.js';
import { distinctSessionName, sessionNameLimit, sessionName, nameForLaunch } from '../session-name.js';
import { localDirectory } from '../onboarding.js';
import { broadScopeRefusals } from '../coordination.js';
import { writeHarnessPermissions } from '../harness.js';
import { type Work, escalationTriggers } from '../model.js';
import { branchContamination, pendingRestore } from '../merge-queue.js';
import { type FleetProbe, selectFleetSession } from '../fleet.js';
import { type EscalationContext, contextFingerprint, escalationAction, handleEscalation, followPrecedent } from '../model/escalation-context.js';
import { agentKindSchema, type EnvironmentKind, environmentKinds, type MasterConfig, masterConfigSchema, type WorkerProfile } from './profiles.js';
import { assertOutsideWorktrees, atomicPrivateText, atomicPrivateWrite, externalCredential, loadMasterConfig, privateFile, readCredentialFile } from './config.js';
import { accountLaunch, agentLaunchPlan, setupAgentEnvironments } from './environments.js';
import { type RequestDelivery, startAgentSession } from './launch.js';
import { createdHerdrTab, type HerdrAgent, herdrJson, stopCreatedHerdrTab } from './herdr.js';
import { failureText } from './worktrees.js';
import { herdrAttach } from './dispatch.js';
import type { SessionHandleInput } from '../model/sessions.js';
import { registeredLaunch } from '../model/session-state.js';
import { liveReviewRequest } from '../model/dispatch.js';
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
 * The session record a decision's approver registers (GY-172): keyed on the decision, so a
 * relaunch for the same decision reopens it rather than adding a second, and bound to nothing the
 * item moves past — the session report closes it once its pane is gone, and the loop records it
 * ended when it closes the pane of a decision that settled.
 */
export const approverSessionId = (decision: string) => `approver:${decision}`;
export type SessionRegistrar = (handle: SessionHandleInput) => Promise<unknown>;
export async function launchApprover(root: string, work: Work, decision: string, explicitKind: NonNullable<WorkerProfile['kind']> | undefined, agents: HerdrAgent[], run?: ChildRun, probe: FleetProbe = {}, register?: SessionRegistrar) {
  const config = await loadMasterConfig(root);
  await agentToken(root, config, 'approver');
  const retry = `graphyard master approver ${work.key} ${decision} [AGENT_KIND]`;
  const name = nameForLaunch(retry, () => approverSessionName(work, decision));
  if (agents.some(agent => agent.name === name)) throw new Error(`Approver session ${name} is already visible in Herdr; let it finish or close it first`);
  // The approver's runtime and account come from the registry's approver role. An explicit
  // AGENT_KIND is the operator's override; an installation whose registry has no approver role
  // yet runs the approver on its first reviewer profile's runtime. No runtime is assumed.
  // The sessions Herdr lists are what the role's count is judged against (GY-190): an approver that
  // judged its decision and exited no longer holds a slot the next one needs.
  const selected = explicitKind ? null : await selectFleetSession(config, 'approver', { name, principal: config.approver!.id }, { runtime: { agents, available: true }, ...probe, work: work.key });
  // Nothing here names a runtime: the role's account decides, then the operator's own argument,
  // then a runtime this installation already configured for another session.
  const kind = selected?.account.kind ?? explicitKind ?? config.reviewers[0]?.kind ?? config.workers[0]?.kind;
  // A launch refused for its runtime gives the chosen session back at once (GY-184).
  const plan = () => {
    if (!kind) throw new Error('No runtime is configured for the approver: name accounts for the approver role with graphyard master registry role set approver ACCOUNT[,ACCOUNT…] --reason REASON, or pass AGENT_KIND');
    return accountLaunch({ kind, approvals: 'auto', agentArgs: [], environment: {} }, selected?.account ?? null);
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
      subject: `${work.key}: judge decision ${decision}`, state: 'running' }, () => startAgentSession(name, kind, created.pane, launch.args, prompt, run, { directory: root, retry, contract: launch.contract, environment: launch.environment }), () => undefined));
  } catch (error) {
    if (pane || tabId) try { await stopCreatedHerdrTab(pane, tabId, run); } catch { /* the launch error below is the report */ }
    await selected?.release(`approver launch for ${work.key} failed: ${failureText(error).slice(0, 300)}`);
    throw error;
  }
  // The registry session is returned with the launch: the loop ends it once the decision is judged.
  return { agentName: name, work: work.key, decision, identity: config.approver!.id, pane: pane!, delivery, focusChanged: false, session: selected?.account.fleet.session ?? null,
    account: selected ? { environment: selected.account.name, kind, reason: selected.selection.reason, skipped: selected.skipped } : null };
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
  const directory = resolve(await localDirectory(root), 'escalations'); await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, `${context.key}-${context.escalation.trigger}-${context.fingerprint.slice(0, 12)}.json`);
  await atomicPrivateWrite(file, context);
  const launch = agentLaunchPlan(kind, 'auto');
  const cli = `node ${config.cliPath}`;
  const prompt = `You are a Graphyard escalation handler spawned for the ${context.escalation.trigger} escalation on ${context.key} in ${config.repository}, acting as ${config.operatorAgent!.id}. Your entire input is the file ${file}: the context the control plane assembled for this decision — the repository's own operating rules and policy, the current goals and priorities, the item (requirements, the standing refusal, the candidate, its typed history) and precedent (earlier ${escalationAction} decisions with their reasons and outcomes). Read that file and nothing else: do not run status, events or any other read, do not open the repository, and hold no state beyond it. Decide whether the ${context.escalation.trigger} escalation should be resolved, following the precedent that applies and saying which. If it should, run ${cli} master decide ${context.key} ${escalationAction} '{"trigger":"${context.escalation.trigger}"}' --precedent DECISION_ID[,DECISION_ID] --context ${context.fingerprint} "YOUR REASON" exactly once, citing only ids listed in precedent.detail; when precedent.detail lists no decision that applies, leave out --precedent and the control plane records that no precedent was available — never invent an id. An independent approver judges it. If it should not, request nothing and state the reason in this tab. Never edit, push, merge, review, approve or submit evidence. Stop when the decision is recorded or declined.`;
  let pane: string | undefined, tabId: string | undefined, delivery: RequestDelivery | undefined;
  try {
    const created = createdHerdrTab(await herdrJson(['tab', 'create', ...(config.herdrWorkspace ? ['--workspace', config.herdrWorkspace] : []), '--cwd', root, '--label', `Escalation · ${context.key}`, '--env', `GRAPHYARD_URL=${config.url}`, '--env', 'GRAPHYARD_ESCALATION_HANDLER=1', '--env', `GRAPHYARD_HOST_ID=${config.hostId}`, ...Object.entries(launch.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--no-focus'], run));
    pane = created.pane; tabId = created.tab;
    // The instruction is the session's own first request (GY-93), never pasted into it: a handler
    // that refused a pasted prompt would record no decision and leave the escalation standing.
    // Registered first, like every launched session (GY-172 AC-2).
    ({ delivery } = await registeredLaunch(register, { id: `escalation:${context.escalation.trigger}:${context.fingerprint.slice(0, 12)}`, kind: 'coordination', role: 'escalation', principal: config.operatorAgent!.id, runtime: kind, host: config.hostId,
      agentName: name, pane: created.pane, attach: herdrAttach(created.pane, config.herdrWorkspace), ...(config.herdrWorkspace ? { workspace: config.herdrWorkspace } : {}),
      subject: `${context.key}: handle the ${context.escalation.trigger} escalation`, state: 'running' }, () => startAgentSession(name, kind, created.pane, launch.args, prompt, run, { directory: root, retry: escalationRetry, environment: launch.environment }), () => undefined));
  } catch (error) {
    if (pane || tabId) try { await stopCreatedHerdrTab(pane, tabId, run); } catch { /* the launch error below is the report */ }
    throw error;
  }
  return { agentName: name, work: context.key, trigger: context.escalation.trigger, fingerprint: context.fingerprint, context: file, identity: config.operatorAgent!.id, pane: pane!, delivery, focusChanged: false };
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
    return launchApprover(root, work, args[1], args[2] ? agentKindSchema.parse(args[2]) : undefined, await deps.agents(), deps.runtime, {}, registrar(work.id));
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
