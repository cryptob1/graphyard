import { randomUUID } from 'node:crypto';
import { probeCandidateConflicts } from '../conflicts.js';
import { agentOwner, agentToken, assessContainment, buildMasterStatus, diskPressure, diskPressureAttention, diskThresholdBytes, freeBytes, herdrWorkspaceHealth, humanOwner, inspectWorkerCredentials, installationOwner, inventoryWorktrees, managedRootStatus, mergeProtocolSkew, observeHerdrAgents, planWorktreeReclaim, reclaimIdleMs, snapshotWithClock, worktreesDirectory, type AttentionItem, type HerdrAgent, type MasterConfig, type WorkerProfile } from '../master.js';
import { generatedFilesAssignment, generatedFilesDrift, generatedFilesVariable, generatedManifestScript } from '../install/generated-files.js';
import type { Work } from '../model.js';
import { actionReport, agentRequestAttention, agentRequestReport, sessionReport } from './loop-report.js';
import { daemonSummary, orphanedSupervisors, readDaemonState, type DaemonState, type OrphanSupervisor } from '../master-daemon.js';
import { readReviewLedger, reconcileReviews, reviewerBindingHealth, summarizeReviews } from '../reviewer.js';
import { readProducerLedger, reconcileProducers, sessionRetries, summarizeProducers } from '../producer.js';
import { dispatchSummary, readDispatchCursor } from '../auto-dispatch.js';
import { unansweredRequests, type RequestProgress, type UnansweredRequest } from '../model/dispatch.js';
import { readAdministrationLedger, readSudoState, summarizeAdministration } from '../master-browser.js';
import { workMutation, type CliCommand } from './registry.js';

export { actionReport, agentRequestAttention, agentRequestReport, sessionReport } from './loop-report.js';

/**
 * One attention item per open worker scope request whose epoch still holds the lease: addressed
 * to the master, naming the requested paths and the worker's reason, with the one command that
 * approves it. A request from a lease that ended is never surfaced.
 */
export function scopeRequestAttention(snapshot: { work: Work[]; now: string }) {
  return snapshot.work.flatMap(work => {
    const request = work.scopeRequest;
    const live = request && work.lease && work.lease.epoch === request.epoch && Date.parse(work.lease.expiresAt) > Date.parse(snapshot.now);
    return live ? [{ subject: work.key, text: `${request.requestedBy} needs files outside plannedFiles: ${request.paths.join(', ')} — ${request.reason}`, ...agentOwner('master', `graphyard master scope ${work.key}`) }] : [];
  });
}

type MasterStatus = ReturnType<typeof buildMasterStatus>;

/** Long waits read in the unit the reader thinks in; a request measured in seconds is still young. */
const elapsed = (ms: number) => ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h${Math.floor(ms % 3_600_000 / 60_000)}m` : ms >= 60_000 ? `${Math.floor(ms / 60_000)}m` : `${Math.floor(ms / 1000)}s`;

/** Who answers a request whose session settled unanswered, and with which command. */
export function unansweredRequestOwner(key: string, request: Pick<UnansweredRequest, 'kind'>) {
  return request.kind === 'review'
    ? agentOwner('master', `graphyard master review ${key} [PROFILE] forces the next attempt for the open request`)
    : agentOwner('master', `graphyard master decide ${key} rework REASON, approved by the approver agent, so the group's proofs are requested afresh on the next head`, 'approver');
}

/**
 * One attention item per live request whose session settled without satisfying its gate. Such a
 * request is the one state `master status` used to show as nothing at all: no session running, no
 * launch refused, no failure — just a `sinceMs` climbing past the hour while the gate goes on
 * refusing. It is named here with the verdict that settled the session, how long the request has
 * stood, and the command that gets it answered, and counted apart from the requests with a
 * session actually running (`counts.dispatchRunning`).
 */
export function unansweredRequestAttention(rows: { key: string; dispatch: { review: RequestProgress | null; producers: RequestProgress[] } | null }[]): AttentionItem[] {
  return rows.flatMap(row => unansweredRequests(row.dispatch).map(request => {
    const subject = request.kind === 'review' ? 'Review request' : `Producer request for ${request.group ?? 'its'} proofs`;
    const verdict = request.verdict ? `with verdict ${request.verdict}` : 'without a verdict';
    return { subject: row.key, text: `${subject} for ${row.key} has stood unanswered for ${elapsed(request.sinceMs)}: its session ${request.state} ${verdict} after attempt ${request.attempts} — ${request.resolution ?? 'no reason recorded'}; nothing is running for it and no further attempt is scheduled`,
      ...unansweredRequestOwner(row.key, request) };
  }));
}

/**
 * The command that reclaims an assignment from a watch supervisor that outlived its agent. The
 * coordination cycle does it on its own; this is how a master runs that cycle once when the loop
 * is stopped, which is the state the item is usually noticed in.
 */
export const supervisorReclaimCommand = 'graphyard master run --once';

/**
 * One attention line for an assignment whose watch supervisor has outlived its session.
 *
 * `Assigned worker session is done` reads as an item that finished, which is exactly what it is
 * not: the session is gone, the lease is still advancing, and the item cannot be dispatched to
 * anybody. This names the supervisor holding it, the process and scope it is held by, and the
 * command that reclaims it — an agent command, never a hand search for a pid.
 */
export function orphanSupervisorAttention(orphan: OrphanSupervisor, host: string | null): AttentionItem {
  return { subject: orphan.key,
    text: `Lease epoch ${orphan.epoch} of ${orphan.key} is still advancing (to ${orphan.leaseExpiresAt}) while Herdr no longer reports session ${orphan.agentName}: an orphaned watch supervisor (pid ${orphan.scope.pid}, containment scope ${orphan.scope.unit}) holds the item for a worker that cannot act`,
    ...agentOwner('master', `${supervisorReclaimCommand} stops that supervisor through its containment scope; on ${host ?? 'its registered host'}, systemctl --user kill --kill-whom=all --signal=SIGTERM ${orphan.scope.unit} does the same by hand`) };
}

/**
 * Rewrite the session attention of every assignment held by an orphaned supervisor, in the row
 * and in the attention list alike, so both say the same thing. A Herdr that could not be read
 * reports no sessions, and every live assignment would then look orphaned, so an unavailable
 * runtime changes nothing.
 */
export function nameOrphanSupervisors(status: MasterStatus, work: Work[], profiles: WorkerProfile[], runtime: { agents: HerdrAgent[]; available: boolean }, now: number): MasterStatus {
  if (!runtime.available) return status;
  const orphans = orphanedSupervisors(work, profiles, runtime.agents, now);
  if (!orphans.length) return status;
  const rewritten = new Map<string, { previous: string | null; item: AttentionItem }>();
  const rows = status.work.map(row => {
    const orphan = orphans.find(entry => entry.key === row.key);
    if (!orphan) return row;
    const item = orphanSupervisorAttention(orphan, work.find(candidate => candidate.id === orphan.id)?.workspaces.find(space => space.epoch === orphan.epoch)?.host ?? null);
    rewritten.set(row.key, { previous: row.attention, item });
    const { subject, text, ...owner } = item;
    return { ...row, attention: text, attentionOwner: owner };
  });
  const attentionItems = status.attentionItems.map(entry => {
    const rewrite = rewritten.get(entry.subject);
    return rewrite && entry.text === rewrite.previous ? rewrite.item : entry;
  });
  for (const [key, rewrite] of rewritten) if (!attentionItems.some(entry => entry.subject === key && entry.text === rewrite.item.text)) attentionItems.push(rewrite.item);
  return { ...status, work: rows, attentionItems };
}

/**
 * Terminal decisions nothing waits on any more: a stale one — approval refused on a revision or
 * candidate race, so its pin can never hold again — and a withdrawn one the requester took back.
 * A stale decision raises master attention with the re-request command only while it is still the
 * latest decision for its action — a later decision of the same action supersedes it, whatever its
 * state; a withdrawn one is listed for the record and never raises attention.
 */
async function terminalDecisions(masterApi: (path: string) => Promise<any>, work: { id: string; key: string; stage: string }[]) {
  const listed: { work: string; id: string; action: string; state: string; reason: string | null; race?: unknown }[] = [];
  const attentionItems: AttentionItem[] = [];
  for (const item of work) {
    if (item.stage === 'done') continue;
    const history = await masterApi(`work/${item.id}/decisions`).catch(() => null);
    const decisions = history?.decisions ?? [];
    const latest = new Map<string, string>();
    for (const decision of decisions) latest.set(decision.action, decision.id);
    for (const decision of decisions) {
      if (decision.state !== 'stale' && decision.state !== 'withdrawn') continue;
      listed.push({ work: item.key, id: decision.id, action: decision.action, state: decision.state, reason: decision.outcome ?? null, ...(decision.race ? { race: decision.race } : {}) });
      if (decision.state === 'stale' && latest.get(decision.action) === decision.id)
        attentionItems.push({ subject: item.key, text: `Decision ${decision.id} (${decision.action}) is stale: ${decision.outcome ?? 'the item moved past it'}; request it again, the stale decision no longer blocks`,
          ...agentOwner('master', `graphyard master decide ${item.key} ${decision.action} [JSON|@FILE] REASON, then graphyard master approver ${item.key} DECISION`, 'approver') });
    }
  }
  return { listed, attentionItems };
}

/**
 * The `master status` report: Graphyard work truth joined with Herdr session health, the local
 * review, producer, dispatch, daemon and administration ledgers, the dispatch schedule with its
 * overlap holds, and the conflict set of every open candidate probed over the fetched PR heads.
 */
export async function masterStatusReport(root: string, master: MasterConfig, masterApi: (path: string) => Promise<any>, coordinator: any, cli: { commit: string | null }) {
  const runtime = observeHerdrAgents();
  const credentials = await inspectWorkerCredentials(root, master.workers);
  let reviewRecords = (await readReviewLedger(root)).reviews, reviewRuntime = { available: true, reason: null as string | null };
  const { snapshot, clockOffset } = await snapshotWithClock(() => masterApi('work-snapshot'));
  // Sessions the automatic dispatcher launched are settled against this same snapshot: a
  // head change cancels them here as well as in the loop, so status never shows a stale one.
  try { reviewRecords = (await reconcileReviews(root, master, { work: snapshot.work, agents: runtime.available ? runtime.agents : null })).reviews; }
  catch (error) { reviewRuntime = { available: false, reason: `Reviewer verdicts could not be reconciled with GitHub: ${error instanceof Error ? error.message : 'unknown reason'}` }; }
  let producerRecords = (await readProducerLedger(root)).producers;
  try { producerRecords = (await reconcileProducers(root, master, snapshot.work, runtime.available ? runtime.agents : null)).producers; } catch { /* the ledger as last written stands */ }
  const reviews = summarizeReviews(reviewRecords), producers = summarizeProducers(producerRecords);
  // Every request whose last session failed or expired, with its attempts and the next relaunch.
  const retries = [...sessionRetries(reviewRecords, Date.now()), ...sessionRetries(producerRecords, Date.now())];
  // Setup that silently stops every launch: an App registered but never bound, a bound App whose
  // credential is gone, a Herdr workspace that no longer exists.
  const reviewerBinding = await reviewerBindingHealth(master);
  const workspace = herdrWorkspaceHealth(master);
  const setup = { reviewer: reviewerBinding, herdrWorkspace: workspace, attention: [...reviewerBinding.attention, ...(workspace.exists === false ? [workspace.reason!] : [])] };
  const dispatchCursor = await readDispatchCursor(root, master).catch(error => ({ error: error instanceof Error ? error.message : 'Master dispatch cursor is unreadable' }));
  const dispatch = 'error' in dispatchCursor ? { running: false, failures: [] as { requestId: string; kind: string; attempts: number; reason: string; at: string; nextAt: string }[], error: dispatchCursor.error } : dispatchSummary(dispatchCursor, Date.now(), master.run.dispatchIntervalSeconds * 1000);
  const containment = assessContainment(snapshot.work, { hostId: master.hostId, observedAt: snapshot.now, clockOffset });
  // Disk is reported from the host, not from the cursor: the loop may be stopped, and the volume
  // filling is exactly the condition that stops it. The plan behind the number is the same one the
  // loop and `master reclaim` compute, so the attention item never promises room reclaiming cannot give.
  const worktrees = worktreesDirectory(root);
  const reclaimPlan = planWorktreeReclaim(await inventoryWorktrees(root).catch(() => []), snapshot.work, { now: Date.now(), idleMs: reclaimIdleMs(master) });
  const disk = diskPressure(worktrees, await freeBytes(worktrees), diskThresholdBytes(master), reclaimPlan);
  // The managed worktree root is a volume of its own as often as not: proof and review checkouts
  // live there, and it is judged against its own minimum and budget, before a write there fails.
  const managedRoot = await managedRootStatus(root, master, [...reviewRecords, ...producerRecords]);
  const diskAttention = [...diskPressureAttention(disk), ...managedRoot.attention];
  const daemonState = await readDaemonState(root, master).catch(error => ({ error: error instanceof Error ? error.message : 'Master daemon state is unreadable' }));
  const daemon = 'error' in daemonState ? { running: false, error: daemonState.error } : daemonSummary(daemonState, Date.now(), master.run.intervalSeconds * 1000);
  // Browser administration is reported beside the work it unblocks: a pending sudo code is
  // the one thing the operator must act on, and the recent ledger entries say who changed what.
  const administration = { browser: master.browser ? { profile: master.browser.profile } : null, ...summarizeAdministration((await readAdministrationLedger(root)).entries, await readSudoState(root)) };
  // A worker session Herdr no longer reports, on an assignment whose lease is still advancing, is
  // an orphaned supervisor rather than a session that finished; it is named with what reclaims it.
  const status = nameOrphanSupervisors(buildMasterStatus(snapshot, master.workers, runtime.agents, credentials, containment, reviews, master.baseBranch, coordinator, { producers, failures: dispatch.failures, retries }, probeCandidateConflicts(root, snapshot.work)),
    snapshot.work, master.workers, runtime, Date.parse(snapshot.now));
  // A waiting sudo prompt is the operator confirming their own GitHub credential on their device,
  // the one step no agent may take for them; a timed-out one is the master's to rerun.
  const sudo = administration.sudo;
  const scopeRequests = [...scopeRequestAttention(snapshot), ...agentRequestAttention(snapshot)];
  // A request whose session settled without satisfying its gate: nothing runs for it, nothing
  // refused, and nothing will launch again until it is named here with the command that answers it.
  const unanswered = unansweredRequestAttention(status.work);
  const attentionItems = [...diskAttention, ...scopeRequests, ...unanswered, ...(sudo ? [...status.attentionItems, { subject: 'installation', text: sudo.instruction,
    ...(Date.parse(sudo.deadline) <= Date.now() ? agentOwner('master', `graphyard master browser ${sudo.flow}`) : humanOwner('issuing credentials to people', sudo.instruction)) }] : [...status.attentionItems])];
  // Setup that stops every launch is the master's to repair.
  for (const text of reviewerBinding.attention) attentionItems.push({ subject: 'setup', text, ...agentOwner('master', 'graphyard master reviewer setup (or graphyard master reviewer bind FILE --key-stdin) to bind the reviewer App') });
  if (workspace.exists === false) attentionItems.push({ subject: 'setup', text: workspace.reason!, ...agentOwner('master', 'Set herdrWorkspace in .graphyard/master.json to a workspace herdr workspace list shows; master run adopts it on its next tick') });
  // The generated-files variable the installers set beside GRAPHYARD_PRINCIPALS, compared with
  // the managed repository's manifest: a deployment that does not exempt the manifest's paths
  // sends every docs-touching item into the out-of-scope refusal, so the drift is raised here
  // with the exact command that fixes the deployment.
  const generatedFiles: AttentionItem[] = [];
  try {
    const manifest = generatedFilesAssignment(root);
    const deployed = coordinator?.delegationLimits?.deployed?.[generatedFilesVariable];
    for (const text of generatedFilesDrift(deployed, manifest)) generatedFiles.push({ subject: 'installation', text, ...installationOwner('delegation-limits', text) });
  } catch (error) {
    generatedFiles.push({ subject: 'installation', text: `The repository generated-file manifest is unreadable: ${error instanceof Error ? error.message : 'unknown reason'}`,
      ...agentOwner('master', `Fix ${generatedManifestScript} so --list prints the generated paths; master status reports the deployment drift again once it does`) });
  }
  attentionItems.push(...generatedFiles);
  const decisions = await terminalDecisions(masterApi, snapshot.work);
  return { ...status, attentionItems: [...attentionItems, ...decisions.attentionItems],
    counts: { ...status.counts, dispatchUnanswered: unanswered.length,
      attention: status.counts.attention + diskAttention.length + generatedFiles.length + unanswered.length + scopeRequests.filter(item => !(status.work as { key: string; attention: string | null }[]).find(row => row.key === item.subject)?.attention).length },
    terminalDecisions: decisions.listed,
    autoMerge: master.autoMerge, mergeApproval: master.autoMerge ? 'routine merges permitted after gates pass' : 'each merge needs an approved merge decision: graphyard master decide GY-N merge REASON, approved by the approver agent',
    versionSkew: mergeProtocolSkew(coordinator, cli), cli,
    reviewer: master.reviewer ? { identity: `${master.reviewer.slug}[bot]`, appId: master.reviewer.appId, profiles: master.reviewers.map(profile => profile.name), automatic: master.run.reviewerProfile ?? (master.reviewers.length === 1 ? master.reviewers[0].name : null) } : null,
    producerProfiles: master.producers.map(profile => ({ name: profile.name, principal: profile.principal, kind: profile.kind, agentName: profile.agentName })),
    setup, administration, daemon, dispatch,
    // The inverted loop: what the control plane says each item needs, who is running it, and
    // every session it can be watched through.
    actions: actionReport(snapshot), sessions: sessionReport(snapshot),
    requests: agentRequestReport(snapshot),
    // What the host has left, what a reclaim would give back, and the bound it was judged against.
    disk: { ...disk, worktreeRoot: managedRoot.health, idleMs: reclaimIdleMs(master), reclaimable: reclaimPlan.filter(entry => entry.disposable).map(entry => ({ path: entry.path, key: entry.key, epoch: entry.epoch, disposition: entry.disposition, detail: entry.detail })) },
    runtime: { herdr: { available: runtime.available, reason: runtime.reason }, reviews: reviewRuntime } };
}

/**
 * How the coordination cycle keeps to its configured interval, from the durations the daemon
 * records for its retained cycles: the last one, the p95, and every cycle that overran. A cycle
 * longer than its interval means the loop is falling behind the work it shepherds.
 */
export function cycleBudget(state: Pick<DaemonState, 'metrics'>, intervalMs: number) {
  const metrics = state.metrics;
  const last = metrics.at(-1) ?? null;
  const durations = metrics.map(metric => metric.durationMs).sort((a, b) => a - b);
  const p95Ms = durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] : null;
  const overruns = metrics.filter(metric => metric.durationMs > intervalMs);
  return {
    intervalMs, measured: metrics.length, lastCycle: last ? { cycle: last.cycle, at: last.at, durationMs: last.durationMs } : null,
    withinInterval: last ? last.durationMs <= intervalMs : null, p95Ms, overruns: overruns.length,
    lastOverrun: overruns.length ? { cycle: overruns.at(-1)!.cycle, at: overruns.at(-1)!.at, durationMs: overruns.at(-1)!.durationMs } : null,
  };
}

/** The worker half of live scope negotiation: ask, or withdraw, without leaving the lease. */
export const scopeRequestCommand: CliCommand = {
  name: 'scope-request',
  scope: 'work',
  help: [
    '  scope-request GY-N EPOCH PATH... -- REASON',
    '                                Ask the master to widen plannedFiles with PATH... for a',
    "                                reason; `scope-request GY-N EPOCH -` withdraws the open",
    '                                request. The master approves it with one command:',
    '                                `graphyard master scope GY-N`, and the attempt keeps its',
    '                                lease — a free-text blocker that waits on a human is never',
    '                                needed for scope',
  ],
  async run(context, work) {
    const { args, print } = context;
    const epoch = Number(args[0]);
    if (!Number.isInteger(epoch) || epoch < 1) throw new Error('Use scope-request GY-N EPOCH PATH... -- REASON, or scope-request GY-N EPOCH - to withdraw');
    if (args[1] === '-') return print(await workMutation(context, work)('scope', { epoch, paths: [], reason: 'Withdrawn by the worker' }));
    const separator = args.indexOf('--');
    const paths = args.slice(1, separator < 0 ? args.length : separator);
    const reason = separator < 0 ? '' : args.slice(separator + 1).join(' ').trim();
    if (!paths.length || !reason) throw new Error('Name at least one PATH outside plannedFiles and give a REASON after --');
    return print(await workMutation(context, work)('scope', { epoch, paths, reason }));
  },
};

/**
 * The one-command approval behind `master scope GY-N [REASON]`: read the item's open scope
 * request, verify the requesting epoch still holds the lease, and apply the purely additive
 * requirements revision that adds the requested paths — with the master's own operator-agent
 * identity, since widening planned files is non-weakening intent.
 */
export async function approveScopeRequest(root: string, config: MasterConfig, args: string[], deps: { coordinator: (path: string) => Promise<any>; fetcher?: typeof fetch; operatorToken?: () => Promise<string> }) {
  if (!args[0]) throw new Error('Use master scope GY-N [REASON]');
  const work = ((await deps.coordinator('work-snapshot')).work as Work[]).find(item => item.id === args[0] || item.key === args[0]);
  if (!work) throw new Error(`Unknown work item ${args[0]}`);
  const request = work.scopeRequest;
  if (!request) throw new Error(`${work.key} has no open scope request to approve`);
  if (!work.lease || work.lease.epoch !== request.epoch) throw new Error(`${work.key}'s scope request belongs to epoch ${request.epoch}, which no longer holds the lease; ask the live worker to request again`);
  const token = await (deps.operatorToken ? deps.operatorToken() : agentToken(root, config, 'operatorAgent'));
  const fetcher = deps.fetcher ?? fetch;
  const reason = args.slice(1).join(' ').trim() || `Approve ${request.requestedBy}'s scope request: ${request.reason}`;
  const response = await fetcher(`${config.url}/api/work/${work.id}/requirements`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': process.env.GRAPHYARD_REQUEST_ID ?? randomUUID() }, body: JSON.stringify({ expectedPolicyRevision: work.policyRevision, criteria: work.criteria, dependencies: work.dependencies, plannedFiles: [...new Set([...work.plannedFiles, ...request.paths])], exclusiveResources: work.exclusiveResources ?? [], producerProofs: work.producerProofs ?? [], reason }), signal: AbortSignal.timeout(30_000) });
  const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result;
}
