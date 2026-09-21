import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { currentEvidence, deliveryState, deploySmokeRequired, exhaustedReviewerProfiles, postDeployMs, productionLatencyMs, reviewProviderOf, reviewerProfileFor, rollbackGuidance, type ContainmentScope, type Work } from './model.js';
import { scopeBlockedBudgetMs, scopeDecisionBudgetMs, scopeDecisionSample, type ScopeRequestState } from './model/scope.js';
import { scopePattern, watchAssignment } from './supervisor.js';
import { pendingBaseRefresh } from './merge-queue.js';
import { dispatchOrder } from './coordination.js';
import { capacitySignature, describeCapacity, detectExhaustion, standingCapacity, type CapacityAccount, type CapacityRole, type PartialWork } from './model/capacity.js';
import { answerCommand, humanDecisionLabel, parkedOnHuman } from './model/human-request.js';
import { independentProducerProfiles, launchProducer, readProducerLedger, saveProducerLedger } from './producer.js';
import { launchReview, readReviewLedger, saveReviewLedger } from './reviewer.js';
import { inspectProducerCredentials, inspectProfileAccounts, preservePartialWork, profileAccount, readEnvironmentLog, recordObservedExhaustion, roleCapacity, selectionKey, type ObservedExhaustion, type ProfileAccountHealth, type RoleCapacity } from './master.js';
import { assertDispatchable, assertOutsideWorktrees, closeHerdrPane, diskExhaustion, diskThresholdBytes, dispatchWork, inspectWorkerCredentials, listHerdrAgents, mergedWithoutAuthorization, mergeExecutor, observeHerdrAgents, reclaimAdvice, reclaimIdleMs, reclaimWorktrees, unauthorizedMergeViolation, writeFailure, type ConfigReload, type HerdrAgent, type MasterConfig, type MergeExecutor, type WorkerProfile, type WorktreeReclaimReport } from './master.js';

/**
 * The durable coordination loop. Every step is a pure decision over one Graphyard snapshot plus
 * an injected effect, so the same cycle runs under systemd, under Herdr, or inside a test with no
 * process supervision at all. The daemon is a coordinator: it never claims a lease, never produces
 * evidence, never calls an operator route, and reaches GitHub only through the guarded merge.
 */

export const daemonActionKinds = ['close', 'dispatch', 'review', 'refresh', 'proof', 'merge', 'deployment', 'smoke', 'escalation', 'config', 'session', 'reclaim', 'scope', 'failover', 'capacity', 'human'] as const;
export type DaemonActionKind = typeof daemonActionKinds[number];
export const daemonActionSchema = z.object({
  kind: z.enum(daemonActionKinds),
  work: z.string().nullable().default(null),
  principal: z.string().nullable().default(null),
  state: z.enum(['started', 'done', 'failed', 'indeterminate']),
  detail: z.string().max(2000),
  attempts: z.number().int().min(0).max(1000).default(1),
  // The item's attempt epoch when the action started. A dispatch that lands always advances it,
  // which is what separates a landed assignment from a submission left over from an earlier one.
  epoch: z.number().int().min(0).nullable().default(null),
  cycle: z.number().int().min(0),
  at: z.string(),
}).strict();
export type DaemonAction = z.infer<typeof daemonActionSchema>;

const percentileSchema = z.object({ count: z.number().int().min(0), p50Ms: z.number().int().min(0), p90Ms: z.number().int().min(0) }).strict();
const noMeasurement = { count: 0, p50Ms: 0, p90Ms: 0 };
export const cycleMetricsSchema = z.object({
  cycle: z.number().int().min(0), at: z.string(), durationMs: z.number().int().min(0),
  open: z.number().int().min(0), actions: z.number().int().min(0),
  stages: z.record(z.string(), percentileSchema).default({}),
  lead: percentileSchema,
  // Delivery analytics behind the merge: creation to the observed deployment (PR-to-production
  // latency), merge to the smoke verdict (post-deploy time), and how many verdicts failed.
  production: percentileSchema.default(noMeasurement),
  postDeploy: percentileSchema.default(noMeasurement),
  postDeployFailures: z.number().int().min(0).default(0),
  // How promptly the loop answers the workers waiting on it: request-to-decision over the
  // retained scope decisions, and the longest request still undecided at this cycle.
  // (Optional, so a cursor written before the loop decided scope keeps parsing as it is.)
  scope: percentileSchema.optional(),
  scopeOpenMs: z.number().int().min(0).optional(),
}).strict();
export type CycleMetrics = z.infer<typeof cycleMetricsSchema>;

export const deploymentObservationSchema = z.object({
  source: z.enum(['endpoint', 'github-deployment', 'unavailable']),
  sha: z.string().nullable(), at: z.string(), reason: z.string().max(500).nullable(),
  deployed: z.array(z.string()).max(200).default([]), pending: z.array(z.string()).max(200).default([]),
}).strict();
export type DeploymentObservation = z.infer<typeof deploymentObservationSchema>;

/** What one reclamation did, kept on the cursor so `master status` reports it without rescanning. */
export const reclaimSummarySchema = z.object({
  at: z.string(), scanned: z.number().int().min(0), removed: z.number().int().min(0), kept: z.number().int().min(0),
  freedBytes: z.number().int().min(0), freeBytes: z.number().int().min(0).nullable().default(null),
  errors: z.array(z.string().max(500)).max(20).default([]),
}).strict();
export type ReclaimSummary = z.infer<typeof reclaimSummarySchema>;

export const scopeMeasurementSchema = z.object({
  work: z.string().max(200), epoch: z.number().int().min(0), at: z.string(),
  waitedMs: z.number().int().min(0), state: z.enum(['approved', 'refused']),
}).strict();
export type ScopeMeasurement = z.infer<typeof scopeMeasurementSchema>;

/**
 * What the loop last saw of an assignment whose Herdr session is gone: enough for a later cycle
 * to tell a lease that is still being renewed from one that has simply not lapsed yet. Without
 * that second look, every session that ends a moment before its lease does would read as an
 * orphaned supervisor.
 */
export const orphanObservationSchema = z.object({
  epoch: z.number().int().min(0), owner: z.string().max(200),
  pid: z.number().int().positive(), unit: z.string().max(200),
  firstSeenAt: z.string(), leaseExpiresAt: z.string(),
  /** How many times this supervisor has been stopped, and the expiry it was last stopped at. */
  stops: z.number().int().min(0).default(0),
  stoppedLeaseExpiresAt: z.string().nullable().default(null),
}).strict();
export type OrphanObservation = z.infer<typeof orphanObservationSchema>;

export const daemonStateSchema = z.object({
  version: z.literal(1), url: z.string(), repository: z.string(),
  lock: z.object({ id: z.string(), pid: z.number().int().positive(), host: z.string(), startedAt: z.string(), heartbeatAt: z.string() }).strict().nullable().default(null),
  cycle: z.number().int().min(0).default(0),
  lastCycleAt: z.string().nullable().default(null),
  actions: z.record(z.string(), daemonActionSchema).default({}),
  profiles: z.record(z.string(), z.object({ failures: z.number().int().min(0), reason: z.string().max(500).nullable(), cooldownUntil: z.string().nullable() }).strict()).default({}),
  metrics: z.array(cycleMetricsSchema).default([]),
  deployment: deploymentObservationSchema.nullable().default(null),
  /** The last reload of .graphyard/master.json: what the running loop adopted, or why it refused. */
  config: z.object({ at: z.string(), changed: z.array(z.string().max(100)).max(100), refused: z.string().max(1000).nullable() }).strict().nullable().default(null),
  /** The last worktree reclamation: what it removed and how much room the host has. */
  reclaim: reclaimSummarySchema.nullable().default(null),
  /** One entry per scope request this loop has decided, for the latency budget it must keep. */
  scope: z.array(scopeMeasurementSchema).default([]),
  /** Per work item, what the loop last saw of an assignment whose Herdr session is gone. */
  orphans: z.record(z.string(), orphanObservationSchema).default({}),
}).strict();
export type DaemonState = z.infer<typeof daemonStateSchema>;

export const retainedActions = 500, retainedMetrics = 100, profileCooldownMs = 600_000, maxProofAttempts = 3, retainedScopeDecisions = 200;
/** Reclamation scans the worktree directory, so it runs on its own bounded interval, not every cycle. */
export const reclaimIntervalMs = 600_000;
const gigabytes = (bytes: number | null) => bytes === null ? 'an unknown amount of space' : `${(bytes / 1e9).toFixed(1)} GB`;

export function emptyDaemonState(config: MasterConfig): DaemonState {
  return daemonStateSchema.parse({ version: 1, url: config.url, repository: config.repository });
}

/** Derived from the coordinator credential, so the cursor lives beside it and never inside a worktree. */
export function daemonStatePath(config: MasterConfig) {
  const file = config.credentialFile;
  return resolve(dirname(file), `${basename(file).replace(/\.token$/, '')}.daemon.json`);
}

export async function readDaemonState(root: string, config: MasterConfig): Promise<DaemonState> {
  const file = daemonStatePath(config);
  await assertOutsideWorktrees(root, dirname(file), 'Master daemon state directory');
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch (error: any) { if (error.code === 'ENOENT') return emptyDaemonState(config); throw error; }
  const state = daemonStateSchema.parse(JSON.parse(raw));
  if (state.url !== config.url || state.repository.toLowerCase() !== config.repository.toLowerCase()) throw new Error('Master daemon state belongs to another Graphyard server or repository; remove it before running the loop');
  return state;
}

export async function writeDaemonState(config: MasterConfig, state: DaemonState) {
  const file = daemonStatePath(config), temporary = `${file}.${randomUUID()}.tmp`;
  // The cursor is written twice per external action, so it is usually the first thing a full
  // volume stops. Saying so is the difference between a disk to reclaim and a mystery.
  try {
    await writeFile(temporary, JSON.stringify(daemonStateSchema.parse(state), null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } catch (error) { throw writeFailure(error, 'Writing the master daemon cursor'); }
  await chmod(file, 0o600);
}

/** Keep the cursor bounded without ever discarding an unresolved action. */
export function pruneDaemonState(state: DaemonState) {
  const entries = Object.entries(state.actions);
  const resolved = entries.filter(([, action]) => action.state === 'done' || action.state === 'failed');
  if (resolved.length > retainedActions) {
    for (const [key] of resolved.sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at)).slice(0, resolved.length - retainedActions)) delete state.actions[key];
  }
  if (state.metrics.length > retainedMetrics) state.metrics = state.metrics.slice(-retainedMetrics);
  if (state.scope.length > retainedScopeDecisions) state.scope = state.scope.slice(-retainedScopeDecisions);
  return state;
}

const liveProcess = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; } };

/**
 * One loop per repository. A second daemon would duplicate dispatch, so a live lock refuses. A
 * lock left behind by a killed daemon is reclaimed as soon as its process is demonstrably gone,
 * which is what makes kill-and-restart resume rather than wait out a timeout.
 */
export function acquireDaemonLock(state: DaemonState, identity: { pid: number; host: string }, now: number, intervalMs: number) {
  const lock = state.lock;
  const staleAfterMs = Math.max(3 * intervalMs, 120_000);
  if (lock) {
    const age = now - Date.parse(lock.heartbeatAt);
    const sameHost = lock.host === identity.host;
    const alive = sameHost ? lock.pid !== identity.pid && liveProcess(lock.pid) : !Number.isFinite(age) || age < staleAfterMs;
    if (alive) throw new Error(`Another Graphyard master loop holds this repository (pid ${lock.pid} on ${lock.host}, last cycle ${lock.heartbeatAt}); stop it before starting a second daemon`);
  }
  state.lock = { id: randomUUID(), pid: identity.pid, host: identity.host, startedAt: new Date(now).toISOString(), heartbeatAt: new Date(now).toISOString() };
  return state.lock;
}

/**
 * A daemon killed mid-action leaves a `started` cursor entry. Graphyard, not the cursor, decides
 * what actually happened: an assignment that landed is closed as done, one that did not is released
 * for a fresh attempt. Neither outcome repeats an action that already took effect.
 *
 * A dispatch lands only by the launcher claiming under the worker's own identity, and every claim
 * advances the epoch, so the attempt epoch is the one honest witness. A submission is not: rework
 * authorized by an operator keeps the previous attempt's submission while the item waits to be
 * assigned again, and reading that as success would strand the rework at a key that never retries.
 */
export function reconcilePendingActions(state: DaemonState, work: Work[], now: number) {
  const resumed: DaemonAction[] = [];
  for (const [key, action] of Object.entries(state.actions)) {
    if (action.state !== 'started') continue;
    // A base refresh is the control plane's own work, not an effect this loop invoked, so there is
    // nothing interrupted to reconcile: the cycle resolves the same entry from Graphyard's record
    // of what the merge did, or leaves it open while the reconciliation job has not run yet.
    if (action.kind === 'refresh') continue;
    const item = work.find(candidate => candidate.key === action.work || candidate.id === action.work);
    const owned = !!item?.lease && item.lease.owner === action.principal && Date.parse(item.lease.expiresAt) > now;
    const next: DaemonAction = { ...action, at: new Date(now).toISOString() };
    if (action.kind === 'dispatch') {
      // A cursor written before attempt epochs were recorded can fall back only to a submission the
      // current attempt owns; one kept across rework says nothing about the attempt just dispatched.
      const landed = owned ? 'Graphyard shows the assignment landed before the restart'
        : action.epoch !== null && item && item.epoch > action.epoch ? `Graphyard advanced the attempt past epoch ${action.epoch}, so the assignment landed before the restart`
          : action.epoch === null && item?.submission && !item.reworkRequested ? 'the current attempt is already submitted, so the assignment landed before the restart'
            : null;
      next.state = landed ? 'done' : 'failed';
      next.detail = landed ? `Resumed: ${landed}` : 'Resumed: no assignment landed, so the item stays eligible for a fresh dispatch';
    } else if (action.kind === 'merge') {
      next.state = item?.observation?.merged || item?.stage === 'done' ? 'done' : 'failed';
      next.detail = next.state === 'done' ? 'Resumed: Graphyard observed the merge' : 'Resumed: no merge was observed; the guarded merge may be attempted again';
    } else if (action.kind === 'scope' && action.work) {
      // The decision lives on the item: either the control plane recorded one for the open
      // request or it did not, and an undecided request is simply asked again next cycle.
      const pending = item?.scopeRequest && !item.scopeRequest.decision;
      next.state = pending ? 'failed' : 'done';
      next.detail = pending ? 'Resumed: the scope request is still undecided and will be decided again'
        : `Resumed: Graphyard holds the decision (${item?.scopeRequest?.decision?.state ?? 'the request was withdrawn or superseded'})`;
    } else if (action.kind === 'deployment' && action.work) {
      // Recording a deployment either landed on the delivery snapshot or it did not; a repeat of a
      // landed record is refused by Graphyard, so retrying is safe.
      next.state = item?.delivery?.deployment ? 'done' : 'failed';
      next.detail = next.state === 'done' ? 'Resumed: Graphyard holds the deployment observation' : 'Resumed: no deployment observation was recorded; it may be recorded again';
    } else {
      next.state = 'indeterminate';
      next.detail = `Resumed: the ${action.kind} request was interrupted and its effect is unknown`;
    }
    state.actions[key] = next; resumed.push(next);
  }
  return resumed;
}

export const dispatchKey = (work: Work) => `dispatch:${work.id}:${work.epoch}`;
export const candidateKey = (kind: DaemonActionKind, work: Work) => `${kind}:${work.id}:${work.candidate?.sha ?? 'none'}:${work.candidate?.baseSha ?? 'none'}:${work.policyRevision}`;
export const closeKey = (profile: WorkerProfile, pane: string) => `close:${profile.name}:${pane}`;
/** One decision per request: the instant the worker recorded it identifies the ask. */
export const scopeKey = (work: Work, request: ScopeRequestState) => `scope:${work.id}:${request.epoch}:${request.at}`;

export function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? Math.max(0, Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)])) : 0;
  return { count: sorted.length, p50Ms: at(50), p90Ms: at(90) };
}

/**
 * How the loop is keeping the promise a scope request rests on: request-to-decision percentiles
 * over the decisions it has taken, every request still undecided with how long it has waited, and
 * the breaches of the two bounds — p90 within five minutes once ten requests have been decided,
 * and nothing left undecided for longer than fifteen. A breach means workers are waiting on the
 * loop, so it is escalated with the numbers rather than left in the metrics.
 */
export function scopeBudget(work: Work[], decisions: ScopeMeasurement[], now: number) {
  const measured = percentiles(decisions.map(entry => entry.waitedMs));
  const open = work.flatMap(item => {
    const request = item.scopeRequest;
    return request && !request.decision ? [{ key: item.key, epoch: request.epoch, waitedMs: Math.max(0, now - Date.parse(request.at)) }] : [];
  }).sort((a, b) => b.waitedMs - a.waitedMs);
  // One id per breach, not per wording: the numbers in the detail move every cycle, and an
  // escalation that changed key each time would read as a new incident every twenty seconds.
  const breaches = [
    ...(measured.count >= scopeDecisionSample && measured.p90Ms > scopeDecisionBudgetMs
      ? [{ id: 'p90', detail: `Scope decisions are too slow: p90 is ${Math.round(measured.p90Ms / 1000)}s over the last ${measured.count} requests, above the ${scopeDecisionBudgetMs / 60_000}-minute budget` }] : []),
    ...open.filter(entry => entry.waitedMs > scopeBlockedBudgetMs)
      .map(entry => ({ id: `blocked:${entry.key}:${entry.epoch}`,
        detail: `${entry.key} has been blocked on its scope request for ${Math.round(entry.waitedMs / 60_000)} minutes, above the ${scopeBlockedBudgetMs / 60_000}-minute bound; decide it with graphyard master scope ${entry.key} REASON` })),
  ];
  return { ...measured, open, longestOpenMs: open[0]?.waitedMs ?? 0, breaches, withinBudget: !breaches.length };
}

/**
 * Stage dwell for work still in flight, delivered lead time, and the post-deploy flow: time to the
 * observed deployment and time from merge to the smoke verdict, with failures counted. All of it
 * comes from the snapshot the cycle already read, so the measurement cannot disagree with the
 * state the cycle acted on.
 */
export function stageMetrics(work: Work[], now: number) {
  const stages: Record<string, ReturnType<typeof percentiles>> = {};
  const open = work.filter(item => item.stage !== 'done');
  for (const stage of [...new Set(open.map(item => item.stage))].sort()) {
    stages[stage] = percentiles(open.filter(item => item.stage === stage).map(item => now - Date.parse(item.stageEnteredAt)).filter(Number.isFinite));
  }
  const delivered = work.filter(item => item.stage === 'done' && item.delivery);
  const lead = percentiles(delivered.map(item => Date.parse(item.delivery!.mergedAt) - Date.parse(item.createdAt)).filter(value => Number.isFinite(value) && value >= 0));
  const production = percentiles(delivered.map(item => productionLatencyMs(item)).filter((value): value is number => value !== null));
  const postDeploy = percentiles(delivered.map(item => postDeployMs(item, now)).filter((value): value is number => value !== null));
  const postDeployFailures = delivered.filter(item => deliveryState(item) === 'delivered-with-failure').length;
  return { stages, lead, production, postDeploy, postDeployFailures };
}

export function missingProofs(work: Work, now: Date) {
  const proofs = [...new Set(work.criteria.flatMap(criterion => criterion.proofs))];
  return proofs.filter(proof => {
    const evidence = currentEvidence(work, proof, now);
    return !evidence || evidence.result !== 'pass' || evidence.executed < 1 || evidence.skipped > 0;
  });
}

/** An assignment whose watch supervisor has outlived the session it was launched to run. */
export interface OrphanSupervisor { id: string; key: string; epoch: number; owner: string; profile: string; agentName: string; scope: ContainmentScope; leaseExpiresAt: string }

/**
 * Assignments held by a supervisor whose session Herdr no longer reports.
 *
 * The supervisor records its own pid and the containment scope it created when it launches, so an
 * orphan is named by the launch record rather than found with `pgrep`. Only an assignment carrying
 * that record for the very epoch that holds the lease qualifies: without it there is no scope to
 * stop the supervisor through, and a neighbouring attempt's scope must never be mistaken for it.
 *
 * This says nothing about whether the lease is still advancing — the caller that acts on it needs
 * a second observation for that (`orphanObservationSchema`); `master status` names what it sees.
 */
export function orphanedSupervisors(work: Work[], profiles: WorkerProfile[], agents: HerdrAgent[], now: number): OrphanSupervisor[] {
  return work.flatMap(item => {
    const lease = item.lease;
    if (item.stage === 'done' || !lease || !(Date.parse(lease.expiresAt) > now)) return [];
    const profile = profiles.find(candidate => candidate.mode === 'launch' && candidate.principal === lease.owner);
    if (!profile || agents.some(agent => agent.name === profile.agentName)) return [];
    const quarantine = item.containmentQuarantine;
    if (!quarantine?.scope || quarantine.epoch !== lease.epoch || quarantine.owner !== lease.owner) return [];
    return [{ id: item.id, key: item.key, epoch: lease.epoch, owner: lease.owner, profile: profile.name, agentName: profile.agentName, scope: quarantine.scope, leaseExpiresAt: lease.expiresAt }];
  });
}

/**
 * Stop one orphaned watch supervisor on this host: the containment scope it created for the agent,
 * and the supervisor process that outlived it.
 *
 * The scope is the master's own user unit, so no privilege beyond the coordinator's own session is
 * used. The recorded pid is signalled only while its own command line still names this assignment's
 * `watch KEY EPOCH --` invocation: a pid the kernel has since handed to something else is reported,
 * never signalled. A refusal of one half is recorded; only a stop that reached neither throws.
 */
export function stopWatchSupervisor(orphan: OrphanSupervisor, signal: NodeJS.Signals, run: (command: string, args: string[]) => string,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill, readCommand: (pid: number) => string = pid => readFileSync(`/proc/${pid}/cmdline`, 'utf8')) {
  if (!scopePattern.test(orphan.scope.unit)) throw new Error(`Recorded containment scope ${orphan.scope.unit} is not a Graphyard watch scope`);
  const refusals: string[] = [];
  let stopped = 0;
  try { run('systemctl', ['--user', 'kill', '--kill-whom=all', `--signal=${signal}`, orphan.scope.unit]); stopped++; }
  catch (error) { refusals.push(`containment scope ${orphan.scope.unit} could not be signalled: ${message(error)}`); }
  let argv: string[] | null = null;
  try { argv = readCommand(orphan.scope.pid).split('\0').filter(Boolean); }
  catch (error) { refusals.push(`supervisor pid ${orphan.scope.pid} could not be read: ${message(error)}`); }
  if (argv) {
    const assignment = watchAssignment(argv);
    if (assignment?.key === orphan.key && assignment.epoch === String(orphan.epoch)) {
      try { kill(orphan.scope.pid, signal); stopped++; }
      catch (error) { refusals.push(`supervisor pid ${orphan.scope.pid} could not be signalled: ${message(error)}`); }
    } else refusals.push(`pid ${orphan.scope.pid} no longer runs the watch supervisor for ${orphan.key} epoch ${orphan.epoch}`);
  }
  if (!stopped) throw new Error(refusals.join('; ') || 'Nothing of the recorded containment could be stopped');
  return { unit: orphan.scope.unit, pid: orphan.scope.pid, signal, refusals };
}

export interface ProfileHealth { profile: WorkerProfile; healthy: boolean; busy: boolean; reason: string | null }
/**
 * A profile is dispatchable only when its credential still authenticates its principal, its agent
 * name is free in Herdr, and it is not inside a failure cool-off. Everything else routes around it.
 * A profile that is merely working is `busy`: that is capacity, not something to escalate.
 */
export function profileHealth(profiles: WorkerProfile[], credentials: Record<string, { available: boolean; reason: string | null }>, agents: HerdrAgent[], state: DaemonState, now: number): ProfileHealth[] {
  return profiles.map(profile => {
    const credential = credentials[profile.name] ?? { available: true, reason: null };
    const agent = agents.find(candidate => candidate.name === profile.agentName);
    const cooldown = state.profiles[profile.name]?.cooldownUntil;
    const busy = profile.mode === 'launch' && credential.available && !!agent;
    const reason = profile.mode !== 'launch' ? 'Existing sessions are observed only; Graphyard will not inject new work into an unsupervised process'
      : !credential.available ? credential.reason ?? 'Worker credential is unavailable'
        : agent ? `Herdr agent ${profile.agentName} is ${agent.agent_status ?? 'present'}`
          : cooldown && Date.parse(cooldown) > now ? `Cooling off after a failed launch until ${cooldown}: ${state.profiles[profile.name]?.reason ?? 'launch failed'}`
            : null;
    return { profile, healthy: !reason, busy, reason };
  });
}

/** Retry a refused action on a widening cycle interval rather than on every pass. */
export function readyToRetry(previous: DaemonAction | undefined, cycle: number, maxBackoffCycles = 30) {
  if (!previous) return true;
  if (previous.state !== 'failed') return false;
  return cycle - previous.cycle >= Math.min(2 ** Math.max(0, previous.attempts - 1), maxBackoffCycles);
}

export function recordProfileFailure(state: DaemonState, profile: WorkerProfile, reason: string, now: number) {
  const previous = state.profiles[profile.name] ?? { failures: 0, reason: null, cooldownUntil: null };
  state.profiles[profile.name] = { failures: previous.failures + 1, reason: reason.slice(0, 500), cooldownUntil: new Date(now + profileCooldownMs).toISOString() };
}
export function clearProfileFailure(state: DaemonState, profile: WorkerProfile) { delete state.profiles[profile.name]; }

/** A reviewer or producer session a launch ledger holds as pending, as the failover step reads it. */
export interface LaunchedSession { role: 'reviewer' | 'producer'; record: string; profile: string; agentName: string; pane: string | null; work: string; requestId: string | null }
/** A session only says its account is spent once it has stopped; while it works, its output is its own prose. */
export const stoppedStates = ['idle', 'done', 'blocked'];
export const failoverKey = (role: CapacityRole, work: Work, attempt: string | number) => `failover:${role}:${work.id}:${attempt}`;
export const capacityKey = (role: CapacityRole) => `capacity:${role}`;

export interface DaemonEffects {
  closeSession: (pane: string) => void | Promise<void>;
  dispatch: (work: Work, profile: WorkerProfile, agents: HerdrAgent[], snapshot: { work: Work[]; now: string }) => Promise<unknown>;
  requestProof: (work: Work) => void | Promise<void>;
  /**
   * Asks the control plane to decide the item's open scope request and returns the decided
   * document. The loop carries no verdict of its own: it asks, and Graphyard decides from the
   * item's own criteria. A loop wired without it simply never decides one, and every request
   * waits for the operator exactly as it did before.
   */
  decideScope?: (work: Work) => Promise<Work>;
  merge: (work: Work) => Promise<unknown>;
  observeDeployment: (delivered: Work[]) => Promise<DeploymentObservation>;
  /** Records the coordinator's own deployment observation on the delivered item. */
  recordDeployment: (work: Work, observation: { sha: string; source: 'endpoint' | 'github-deployment'; observedAt: string }) => Promise<unknown>;
  /** Asks the provider to run the trusted smoke workflow against the observed deployment. */
  requestSmoke: (work: Work) => void | Promise<void>;
  /**
   * Removes the dependency directories of finished assignment worktrees. A loop configured
   * without it keeps cycling; it simply never reclaims. It touches no checkout, no branch, and
   * no Graphyard record, so it needs no credential and is safe to run on every cycle.
   */
  reclaim?: (work: Work[]) => Promise<WorktreeReclaimReport>;
  /**
   * Mid-session capacity (GY-89). `sessionOutput` reads the tail of a stopped session's own
   * terminal, which is where a runtime says its provider account is spent; `reportCapacity`
   * records what the loop observed on the item. A loop wired without the two never fails a
   * session over and never escalates capacity: it cycles exactly as it did before.
   */
  sessionOutput?: (agent: HerdrAgent) => string | null;
  reportCapacity?: (work: Work, event: Record<string, unknown>) => Promise<Work>;
  /** The reviewer and producer sessions the launch ledgers hold as pending. */
  launchedSessions?: () => Promise<LaunchedSession[]>;
  /** The account the profile's current session was launched on, as its launcher recorded it. */
  selectedAccount?: (role: CapacityRole, profile: string) => Promise<{ environment: string | null; kind: string | null } | null>;
  /** Commits (or cleanly discards) what the interrupted attempt left uncommitted in its worktree. */
  preserveWork?: (work: Work, epoch: number) => Promise<PartialWork>;
  /** Keeps every launcher off the spent account until it resets. */
  holdAccount?: (account: string, observed: Omit<ObservedExhaustion, 'until'>) => Promise<unknown>;
  /** Ends an exhausted reviewer or producer session on its ledger, so its request may launch again. */
  endSession?: (session: LaunchedSession, resolution: string) => Promise<void>;
  /** Launches the session's request again on another account or runtime; throws `accountsExhausted` when none is left. */
  relaunch?: (session: LaunchedSession, work: Work, snapshot: { work: Work[]; now: string }) => Promise<{ profile: string }>;
  /** Account health of the reviewer and producer profiles, as the worker profiles' arrives in `credentials`. */
  roleHealth?: () => Promise<Partial<Record<'reviewer' | 'producer', { profiles: { name: string }[]; health: Record<string, { available: boolean; reason: string | null; accounts?: ProfileAccountHealth[] }> }>>>;
  agents: () => HerdrAgent[];
  /**
   * The same session inventory with whether it could be read at all. A Herdr that cannot be
   * reached reports no sessions, and stopping a supervisor on that would kill live work, so the
   * orphan step acts only on an inventory that says it is available.
   */
  herdr?: () => { agents: HerdrAgent[]; available: boolean };
  /** Stops an orphaned watch supervisor through the containment scope it recorded at launch. */
  stopSupervisor?: (orphan: OrphanSupervisor, signal: NodeJS.Signals) => void | Promise<void>;
  credentials: (profiles: WorkerProfile[]) => Promise<Record<string, { available: boolean; reason: string | null; accounts?: ProfileAccountHealth[] }>>;
  snapshot: () => Promise<{ work: Work[]; now: string }>;
  persist: (state: DaemonState) => Promise<void>;
}

async function record(state: DaemonState, key: string, action: Omit<DaemonAction, 'at' | 'epoch'> & { at?: string; epoch?: number | null }, now: number, persist: DaemonEffects['persist']) {
  const entry = daemonActionSchema.parse({ ...action, at: action.at ?? new Date(now).toISOString() });
  state.actions[key] = entry; await persist(state);
  return entry;
}

/**
 * One coordination cycle: close finished sessions, reclaim the disk finished assignments hold,
 * dispatch claimable work to a healthy profile, shepherd reviews and proofs, invoke only the
 * guarded merge, verify the deployed SHA, and measure the stages. The cursor is persisted before and after every external action, so a kill between
 * them leaves an entry the next start reconciles against Graphyard instead of repeating.
 */
export async function runCycle(config: MasterConfig, state: DaemonState, effects: DaemonEffects, now: () => number = Date.now) {
  const startedAt = now();
  const snapshot = await effects.snapshot();
  const observedAt = Date.parse(snapshot.now), clock = Number.isFinite(observedAt) ? observedAt : startedAt;
  const performed: DaemonAction[] = [];
  const resumed = reconcilePendingActions(state, snapshot.work, clock);
  if (resumed.length) { performed.push(...resumed); await effects.persist(state); }

  const agents = effects.agents();
  const credentials = await effects.credentials(config.workers);
  const open = snapshot.work.filter(item => item.stage !== 'done');
  const owns = (principal: string) => open.some(item => !!item.lease && item.lease.owner === principal && Date.parse(item.lease.expiresAt) > clock);

  // 1. Close finished worker sessions. Authority stops at the lease, so a launched agent with no
  //    active assignment has nothing left to do and its pane must not linger holding a provider seat.
  for (const profile of config.workers.filter(worker => worker.mode === 'launch')) {
    const agent = agents.find(candidate => candidate.name === profile.agentName);
    if (!agent?.pane_id || owns(profile.principal)) continue;
    if (!['idle', 'done', 'blocked'].includes(agent.agent_status ?? '')) continue;
    const key = closeKey(profile, agent.pane_id);
    if (state.actions[key]?.state === 'done') continue;
    await record(state, key, { kind: 'close', work: null, principal: profile.principal, state: 'started', detail: `Closing ${profile.agentName}: no active Graphyard assignment`, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    try {
      await effects.closeSession(agent.pane_id);
      performed.push(await record(state, key, { kind: 'close', work: null, principal: profile.principal, state: 'done', detail: `Closed finished session ${profile.agentName} (${agent.agent_status ?? 'unknown'}) with no active assignment`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'close', work: null, principal: profile.principal, state: 'failed', detail: `Could not close ${profile.agentName}: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 1a. Mid-session exhaustion. A session that ran out of provider quota does not fail: it stops
  //     on its runtime's limit notice and waits for a person. The loop reads that notice from the
  //     session's own output, keeps what the attempt had not committed, holds the account until
  //     it resets, records the exhaustion — account, notice, reset time, partial work — on the
  //     item, and gets the action onto another account: a worker's lease ends in that same
  //     record, so the dispatch step re-queues the item on the next cycle, and a reviewer or
  //     producer request is launched again at once. Nobody repoints a profile by hand.
  const failedOver = new Set<string>();
  if (effects.sessionOutput && effects.reportCapacity) {
    const stopped = (name: string) => { const agent = agents.find(candidate => candidate.name === name); return agent && stoppedStates.includes(agent.agent_status ?? '') ? agent : null; };
    const notice = (agent: HerdrAgent) => { try { const output = effects.sessionOutput!(agent); return output ? detectExhaustion(output, clock) : null; } catch { return null; } };
    const held = async (role: CapacityRole, profile: string, item: Work, signal: { reason: string; resetsAt: string | null }) => {
      const selected = await effects.selectedAccount?.(role, profile) ?? null;
      const account = selected?.environment ?? null;
      await effects.holdAccount?.(account ?? profileAccount(profile), { at: new Date(clock).toISOString(), resetsAt: signal.resetsAt, reason: signal.reason, role, profile, work: item.key });
      return { account, runtime: selected?.kind ?? null };
    };
    for (const profile of config.workers.filter(worker => worker.mode === 'launch')) {
      const agent = stopped(profile.agentName);
      const item = open.find(candidate => !!candidate.lease && candidate.lease.owner === profile.principal && Date.parse(candidate.lease.expiresAt) > clock);
      if (!agent || !item || item.submission?.epoch === item.lease!.epoch) continue;
      const key = failoverKey('worker', item, item.lease!.epoch), previous = state.actions[key];
      if (previous?.state === 'done' || !readyToRetry(previous, state.cycle)) { if (previous) failedOver.add(item.id); continue; }
      const signal = notice(agent);
      if (!signal) continue;
      failedOver.add(item.id);
      const epoch = item.lease!.epoch, attempts = (previous?.attempts ?? 0) + 1;
      const resets = signal.resetsAt ? `resets ${signal.resetsAt}` : 'reset time unknown';
      await record(state, key, { kind: 'failover', work: item.key, principal: profile.principal, epoch, state: 'started', detail: `${profile.agentName} on ${item.key} (epoch ${epoch}) stopped on its provider's limit notice: ${signal.reason}`, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        const partialWork = await effects.preserveWork?.(item, epoch) ?? { state: 'not-applicable' as const, detail: 'this loop has no access to the attempt worktree' };
        const { account, runtime } = await held('worker', profile.name, item, signal);
        await effects.reportCapacity(item, { event: 'exhausted', role: 'worker', epoch, profile: profile.name, account, runtime: runtime ?? profile.kind ?? null, reason: signal.reason, resetsAt: signal.resetsAt, partialWork });
        // The lease is over on the record; the supervisor is stopped through the containment scope
        // it recorded, which is the path that settles its quarantine, so the item is claimable again.
        const scope = item.containmentQuarantine?.epoch === epoch && item.containmentQuarantine.owner === profile.principal ? item.containmentQuarantine.scope : undefined;
        let stop = 'its supervisor stops on the ended lease';
        try {
          if (scope && effects.stopSupervisor) { await effects.stopSupervisor({ id: item.id, key: item.key, epoch, owner: profile.principal, profile: profile.name, agentName: profile.agentName, scope, leaseExpiresAt: item.lease!.expiresAt }, 'SIGTERM'); stop = `its supervisor (pid ${scope.pid}) was stopped through ${scope.unit}`; }
        } catch (error) { stop = `its supervisor could not be signalled (${message(error)}) and stops on the ended lease`; }
        clearProfileFailure(state, profile);
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: profile.principal, epoch, state: 'done',
          detail: `${item.key} epoch ${epoch} exhausted ${account ?? `${profile.name}'s own account`} mid-session (${signal.reason}; ${resets}). Partial work ${partialWork.state}${partialWork.commit ? ` at ${partialWork.commit.slice(0, 12)}` : ''}; the attempt ended as released, ${stop}, and ${item.key} is re-queued for another account`,
          attempts, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: profile.principal, epoch, state: 'failed', detail: `${item.key} epoch ${epoch} exhausted its account (${signal.reason}) but could not be failed over: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
      }
    }
    for (const session of await effects.launchedSessions?.().catch(() => [] as LaunchedSession[]) ?? []) {
      const agent = stopped(session.agentName), item = open.find(candidate => candidate.key === session.work);
      if (!agent || !item) continue;
      const key = failoverKey(session.role, item, session.record), previous = state.actions[key];
      if (previous?.state === 'done' || !readyToRetry(previous, state.cycle)) continue;
      const signal = notice(agent);
      if (!signal) continue;
      const attempts = (previous?.attempts ?? 0) + 1, resets = signal.resetsAt ? `resets ${signal.resetsAt}` : 'reset time unknown';
      await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'started', detail: `${session.role} session ${session.agentName} for ${item.key} stopped on its provider's limit notice: ${signal.reason}`, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        const { account, runtime } = await held(session.role, session.profile, item, signal);
        await effects.reportCapacity(item, { event: 'exhausted', role: session.role, ...(session.requestId ? { requestId: session.requestId } : {}), profile: session.profile, account, runtime, reason: signal.reason, resetsAt: signal.resetsAt,
          partialWork: { state: 'not-applicable', detail: `a ${session.role} session edits nothing: it reads the exact head and leaves no work to keep` } });
        await effects.endSession?.(session, `provider quota exhausted on ${account ?? `${session.profile}'s own account`} mid-session (${signal.reason}; ${resets}); launched again on another account`);
        let next = 'its request launches again on the next dispatch tick';
        if (session.requestId && effects.relaunch) {
          try { next = `relaunched on profile ${(await effects.relaunch(session, item, snapshot)).profile}`; }
          catch (error) {
            next = (error as { accountsExhausted?: boolean })?.accountsExhausted ? `no other account is left for the role (${message(error)}), so it waits for capacity`
              : `it could not be launched again at once (${message(error)}), so the dispatcher launches it on its retry schedule`;
          }
        }
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'done',
          detail: `${session.role} session ${session.agentName} for ${item.key} exhausted ${account ?? `${session.profile}'s own account`} mid-session (${signal.reason}; ${resets}); ${next}`, attempts, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'failover', work: item.key, principal: null, state: 'failed', detail: `${session.role} session ${session.agentName} for ${item.key} exhausted its account (${signal.reason}) but could not be failed over: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
      }
    }
  }

  // 1b. A worker session that stops on a prompt while it holds its assignment is waiting on input
  //     no one will give; it is recorded as failed with that reason, once per pane, for the master.
  for (const profile of config.workers.filter(worker => worker.mode === 'launch')) {
    const agent = agents.find(candidate => candidate.name === profile.agentName);
    const item = open.find(candidate => !!candidate.lease && candidate.lease.owner === profile.principal && Date.parse(candidate.lease.expiresAt) > clock);
    if (!agent?.pane_id || !item || agent.agent_status !== 'blocked' || failedOver.has(item.id)) continue;
    const key = `session:blocked:${profile.name}:${agent.pane_id}:${item.epoch}`;
    if (state.actions[key]) continue;
    performed.push(await record(state, key, { kind: 'session', work: item.key, principal: profile.principal, state: 'failed', detail: `Worker session ${profile.agentName} on ${item.key} (epoch ${item.epoch}) is waiting on input (Herdr reports it blocked) instead of deciding on its own; answer or stop it, and have it record a blocker naming the blocked command rather than asking`, attempts: 1, epoch: item.epoch, cycle: state.cycle }, now(), effects.persist));
  }

  // 1c. A lease that keeps advancing while Herdr no longer reports the session renewing it is an
  //     orphaned watch supervisor: the agent is gone, the item stays owned by a worker that cannot
  //     act, nothing lapses, and no replacement can be dispatched. Two observations establish it —
  //     one lease expiry later than the one first seen with the session already gone — and the
  //     supervisor is then stopped through the containment scope it recorded at launch, rather
  //     than left for a master to find with `pgrep` and kill by hand.
  const runtime = effects.herdr?.();
  if (runtime?.available && effects.stopSupervisor) {
    const orphans = orphanedSupervisors(open, config.workers, runtime.agents, clock);
    for (const id of Object.keys(state.orphans)) if (!orphans.some(orphan => orphan.id === id)) delete state.orphans[id];
    for (const orphan of orphans) {
      const previous = state.orphans[orphan.id];
      const tracked = previous && previous.epoch === orphan.epoch && previous.owner === orphan.owner && previous.pid === orphan.scope.pid ? previous : null;
      if (!tracked) {
        state.orphans[orphan.id] = orphanObservationSchema.parse({ epoch: orphan.epoch, owner: orphan.owner, pid: orphan.scope.pid, unit: orphan.scope.unit, firstSeenAt: new Date(clock).toISOString(), leaseExpiresAt: orphan.leaseExpiresAt });
        await effects.persist(state); continue;
      }
      // A supervisor already stopped is judged against the expiry it was stopped at: a lease that
      // advances past it proves the stop did not take, and the next signal is not negotiable.
      const baseline = Date.parse(tracked.stoppedLeaseExpiresAt ?? tracked.leaseExpiresAt);
      state.orphans[orphan.id] = { ...tracked, leaseExpiresAt: orphan.leaseExpiresAt };
      if (!(Date.parse(orphan.leaseExpiresAt) > baseline)) { await effects.persist(state); continue; }
      const stops = tracked.stops + 1, signal: NodeJS.Signals = stops === 1 ? 'SIGTERM' : 'SIGKILL';
      const key = `incident:orphan-supervisor:${orphan.id}:${orphan.epoch}:${orphan.scope.pid}`;
      const incident = `${orphan.key} epoch ${orphan.epoch} renewed its lease to ${orphan.leaseExpiresAt} while Herdr no longer reports session ${orphan.agentName}: its watch supervisor (pid ${orphan.scope.pid}, containment scope ${orphan.scope.unit}) has outlived the agent`;
      await record(state, key, { kind: 'escalation', work: orphan.key, principal: orphan.owner, epoch: orphan.epoch, state: 'started', detail: `${incident}; stopping it with ${signal} through that scope`, attempts: stops, cycle: state.cycle }, now(), effects.persist);
      try {
        await effects.stopSupervisor(orphan, signal);
        state.orphans[orphan.id] = { ...state.orphans[orphan.id], stops, stoppedLeaseExpiresAt: orphan.leaseExpiresAt };
        performed.push(await record(state, key, { kind: 'escalation', work: orphan.key, principal: orphan.owner, epoch: orphan.epoch, state: 'done', detail: `${incident}; stopped with ${signal} through that scope, so the lease lapses instead of renewing`, attempts: stops, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'escalation', work: orphan.key, principal: orphan.owner, epoch: orphan.epoch, state: 'failed', detail: `${incident}; it could not be stopped through that scope: ${message(error)}`, attempts: stops, cycle: state.cycle }, now(), effects.persist));
      }
    }
  }

  // A pane this cycle just closed frees its profile, so health is read after the closures.
  const health = profileHealth(config.workers, credentials, effects.agents(), state, clock);

  // 2. Decide the open scope requests. A worker that needs a file its own criteria — or this
  //    repository's documentation rule — already imply must not wait for a master session to run
  //    a command: the control plane recomputes the decision from the item itself, and the loop
  //    asks it to settle every open request on the cycle it first sees one. An implied additive
  //    request is applied to the live item with its audited reason; anything wider is refused and
  //    escalated here with that reason, and the item stays blocked until an operator decides it.
  //    What this pass decides is kept, so the budget below measures what is still waiting rather
  //    than what has just been answered.
  const settled = new Map<string, Work>();
  for (const item of open) {
    const request = item.scopeRequest;
    if (!effects.decideScope || !request || request.decision) continue;
    // A request whose attempt no longer holds the lease is moot: a fresh attempt asks afresh.
    if (!item.lease || item.lease.epoch !== request.epoch || Date.parse(item.lease.expiresAt) <= clock) continue;
    const key = scopeKey(item, request);
    const previous = state.actions[key];
    if (!readyToRetry(previous, state.cycle)) continue;
    const attempts = (previous?.attempts ?? 0) + 1;
    await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'started',
      detail: `Deciding ${item.key}'s scope request for ${request.paths.join(', ') || 'no path'}`, attempts, cycle: state.cycle }, now(), effects.persist);
    try {
      const decided = await effects.decideScope(item);
      const decision = decided.scopeDecision;
      if (!decision) throw new Error('The control plane answered without a decision');
      settled.set(item.id, decided);
      state.scope.push(scopeMeasurementSchema.parse({ work: item.key, epoch: request.epoch, at: decision.at, waitedMs: decision.waitedMs, state: decision.state }));
      const waited = `${Math.round(decision.waitedMs / 1000)}s after ${request.requestedBy} asked`;
      performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done',
        detail: decision.state === 'approved'
          ? `Widened ${item.key} with ${request.paths.join(', ')} ${waited}: ${decision.reason}`
          : `Refused ${item.key}'s scope request for ${request.paths.join(', ') || 'no path'} ${waited}: ${decision.reason}`,
        attempts, cycle: state.cycle }, now(), effects.persist));
      if (decision.state === 'refused') {
        const escalationKey = `escalation:scope:${item.id}:${request.at}`;
        performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done',
          detail: `${item.key} is blocked on scope: ${request.requestedBy} asked for ${request.paths.join(', ') || 'a requirements change'} because ${request.reason}, and the loop refused it because ${decision.reason}. Decide it with graphyard master scope ${item.key} REASON, or graphyard master requirements ${item.key} FILE REASON for anything that is not purely additive`,
          attempts: 1, cycle: state.cycle }, now(), effects.persist));
      }
    } catch (error) {
      performed.push(await record(state, key, { kind: 'scope', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'failed',
        detail: `Could not decide ${item.key}'s scope request: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 2b. The promise that decision rests on: workers wait minutes, not a shift. A p90 above the
  //     budget, or any request left undecided past the blocked bound, is escalated with the
  //     numbers — the loop is the only thing that could have answered them.
  const budget = scopeBudget(open.map(item => settled.get(item.id) ?? item), state.scope, clock);
  for (const breach of budget.breaches) {
    const key = `escalation:scope-budget:${breach.id}`;
    if (state.actions[key]?.detail === breach.detail) continue;
    performed.push(await record(state, key, { kind: 'escalation', work: null, principal: null, state: 'failed', detail: breach.detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  }

  // 3. Reclaim the disk the finished assignments are holding, before anything asks for more of
  //    it. Every attempt and every rework checks the repository out again, so without this step
  //    the host fills and the loop starts failing at whatever it happens to write next. The
  //    reclaimer removes dependency directories only: checkouts, branches and Graphyard's
  //    registered workspace records are never touched, so nothing here can lose work.
  //    Scanning the worktree directory is not free, so it keeps to its own interval — except
  //    while the last scan found free space below the configured threshold, when the host needs
  //    every cycle it can get rather than a cadence.
  const reclaimedAt = state.reclaim ? Date.parse(state.reclaim.at) : Number.NaN;
  const pressed = state.reclaim?.freeBytes !== null && state.reclaim?.freeBytes !== undefined && state.reclaim.freeBytes < diskThresholdBytes(config);
  if (effects.reclaim && (pressed || !(Number.isFinite(reclaimedAt) && clock - reclaimedAt < reclaimIntervalMs))) {
    try {
      const report = await effects.reclaim(snapshot.work);
      state.reclaim = reclaimSummarySchema.parse({ at: report.at, scanned: report.scanned, removed: report.removed.length, kept: report.kept.length,
        freedBytes: report.freedBytes, freeBytes: report.freeAfter === null ? null : Math.max(0, Math.round(report.freeAfter)), errors: report.errors.slice(0, 20) });
      if (report.removed.length || report.errors.length) {
        performed.push(await record(state, `reclaim:${report.at}`, { kind: 'reclaim', work: null, principal: null, state: report.errors.length ? 'failed' : 'done',
          detail: `Reclaimed ${report.removed.length} dependency director${report.removed.length === 1 ? 'y' : 'ies'} from ${report.scanned} assignment worktree(s), ${gigabytes(report.freedBytes)} recovered, ${gigabytes(report.freeAfter)} free${report.errors.length ? `; ${report.errors.length} could not be removed: ${report.errors[0]}` : ''}`,
          attempts: 1, cycle: state.cycle }, now(), effects.persist));
      } else await effects.persist(state);
    } catch (error) {
      performed.push(await record(state, `reclaim:${new Date(clock).toISOString()}`, { kind: 'reclaim', work: null, principal: null, state: 'failed', detail: `Worktree reclamation failed: ${message(error)}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 4. Dispatch claimable work to a healthy profile. The launcher claims under the worker's own
  //    identity; the daemon never holds a lease. An unhealthy profile is skipped, not waited on.
  //    An item whose planned files overlap a claimed or unmerged item is not claimable (the
  //    loop never overrides that; `master dispatch --allow-overlap` is the operator's call), and
  //    the smallest planned scope within a priority is offered first.
  const claimable = open.filter(item => {
    try { assertDispatchable(item, snapshot.work, snapshot.now); return true; } catch { return false; }
  }).sort(dispatchOrder);

  // 4a. Capacity. A role whose every configured account is spent is not a launch to keep
  //     retrying and not a failure to keep reporting: each item that needs the role records one
  //     capacity escalation naming every account and its reset time, the loop stops launching
  //     that role until the first of them resets, and the cycle says so in one line. Everything
  //     that needs a different role — a review, a proof, a merge, a deployment — runs below
  //     exactly as it would have, and the escalation is withdrawn the cycle an account returns.
  const capacities: RoleCapacity[] = [roleCapacity('worker', config.workers.filter(worker => worker.mode === 'launch'), credentials)];
  if (effects.reportCapacity) {
    const others = await effects.roleHealth?.().catch(() => null) ?? {};
    for (const role of ['reviewer', 'producer'] as const) if (others[role]) capacities.push(roleCapacity(role, others[role]!.profiles, others[role]!.health));
    const needs: Record<CapacityRole, Work[]> = {
      worker: claimable,
      reviewer: open.filter(item => item.autoDispatch?.review?.state === 'requested'),
      producer: open.filter(item => item.autoDispatch?.producers.some(request => request.state === 'requested')),
    };
    for (const capacity of capacities) {
      const key = capacityKey(capacity.role), previous = state.actions[key];
      if (capacity.exhausted) {
        const waiting = needs[capacity.role];
        const signature = capacitySignature(capacity.role, capacity.accounts);
        for (const item of waiting) {
          const standing = standingCapacity(item, capacity.role)[0];
          if (standing && capacitySignature(standing.role, standing.accounts) === signature) continue;
          try { await effects.reportCapacity(item, { event: 'escalated', role: capacity.role, accounts: capacity.accounts }); }
          catch (error) { performed.push(await record(state, `${key}:${item.id}`, { kind: 'capacity', work: item.key, principal: null, state: 'failed', detail: `Could not record the ${capacity.role} capacity escalation on ${item.key}: ${message(error)}`, attempts: (state.actions[`${key}:${item.id}`]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist)); }
        }
        const detail = `${describeCapacity(capacity.role, capacity.accounts)}${waiting.length ? `; waiting: ${waiting.map(item => item.key).join(', ')}` : ''}`;
        if (previous?.detail !== detail) performed.push(await record(state, key, { kind: 'capacity', work: null, principal: null, state: 'done', detail, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
        continue;
      }
      const restored = open.filter(item => standingCapacity(item, capacity.role).length);
      for (const item of restored) await effects.reportCapacity(item, { event: 'restored', role: capacity.role, reason: `An account for the ${capacity.role} role reports quota again` }).catch(() => {});
      if (restored.length || previous && !previous.detail.startsWith('Restored')) {
        performed.push(await record(state, key, { kind: 'capacity', work: null, principal: null, state: 'done', detail: `Restored: a ${capacity.role} account reports quota again; ${capacity.role} launches resume${restored.length ? ` for ${restored.map(item => item.key).join(', ')}` : ''}`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
      }
    }
  }
  const workersSpent = !!effects.reportCapacity && capacities[0].exhausted;

  // 4b-human. An item parked on a decision only a human may make holds no lease and is not
  //     claimable, so there is nothing to dispatch and nothing to escalate to an agent: the loop
  //     names it once, with how to answer. The answer itself makes the item claimable, and the
  //     dispatch below picks it up on the next cycle — no master session is part of that.
  for (const item of open.filter(parkedOnHuman)) {
    const request = item.humanRequest!, key = `human:${item.id}:${request.id}`;
    if (state.actions[key]) continue;
    performed.push(await record(state, key, { kind: 'human', work: item.key, principal: request.requestedBy, epoch: request.epoch, state: 'done',
      detail: `${item.key} is parked on a human-only decision (${humanDecisionLabel[request.kind]}): ${request.needed} — ${request.reason}. Its attempt ended without a lease and nothing else waits on it; the human answers with ${answerCommand(item.key, request)} and the loop dispatches it again`,
      attempts: 1, cycle: state.cycle }, now(), effects.persist));
  }

  const taken = new Set<string>();
  for (const item of workersSpent ? [] : claimable) {
    const key = dispatchKey(item);
    if (state.actions[key] && state.actions[key].state !== 'failed') continue;
    const free = effects.agents();
    const choice = health.find(entry => entry.healthy && !taken.has(entry.profile.name) && !free.some(agent => agent.name === entry.profile.agentName));
    if (!choice) {
      // Every launch profile working is capacity, not a decision for anyone. Escalate only when no
      // profile could take work even if it were free.
      const launchable = health.filter(entry => entry.profile.mode === 'launch');
      if (!launchable.some(entry => entry.healthy || entry.busy)) {
        const detail = `No worker profile can take ${item.key}: ${launchable.map(entry => `${entry.profile.name} (${entry.reason})`).join('; ') || 'no launch profile is configured'}`;
        const escalationKey = `escalation:dispatch:${item.id}`;
        if (state.actions[escalationKey]?.detail !== detail) performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[escalationKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      }
      break;
    }
    taken.add(choice.profile.name);
    await record(state, key, { kind: 'dispatch', work: item.key, principal: choice.profile.principal, epoch: item.epoch, state: 'started', detail: `Dispatching ${item.key} to ${choice.profile.name}`, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    try {
      await effects.dispatch(item, choice.profile, free, snapshot);
      clearProfileFailure(state, choice.profile);
      performed.push(await record(state, key, { kind: 'dispatch', work: item.key, principal: choice.profile.principal, epoch: item.epoch, state: 'done', detail: `Dispatched ${item.key} to ${choice.profile.name}; the worker launcher claimed under ${choice.profile.principal}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      recordProfileFailure(state, choice.profile, message(error), now());
      performed.push(await record(state, key, { kind: 'dispatch', work: item.key, principal: choice.profile.principal, epoch: item.epoch, state: 'failed', detail: `Dispatch of ${item.key} to ${choice.profile.name} failed: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 4b. A base branch that moved under an in-flight candidate. Nobody is asked to do anything
  //     about it: the control plane merges the new base into the candidate's own branch and
  //     decides what the review and each proof carry (see merge-queue.ts). The cycle reports
  //     what that refresh did — or the conflict that stopped it — so a pass that brought six
  //     stalled items forward is an action rather than a "0 actions" line.
  for (const item of open.filter(candidate => candidate.submission && candidate.candidate && !candidate.reworkRequested)) {
    const refresh = item.baseRefresh, pending = pendingBaseRefresh(item);
    // One action per head, base tip and policy revision: opened when the branch moves under the
    // candidate, resolved when the control plane reports what its merge did.
    const target = pending ? { head: item.candidate!.sha, base: pending.baseTip } : refresh ? { head: refresh.from.sha, base: refresh.base } : null;
    if (!target) continue;
    const key = `refresh:${item.id}:${target.head}:${target.base}:${item.policyRevision}`;
    if (pending) {
      if (state.actions[key]) continue;
      performed.push(await record(state, key, { kind: 'refresh', work: item.key, principal: null, state: 'started',
        detail: `${item.key}: base branch moved from ${pending.boundBase.slice(0, 12)} to ${pending.baseTip.slice(0, 12)}; the control plane is bringing ${item.candidate!.sha.slice(0, 12)} onto it. No rework round, no review round and no proof round is requested for the move.`,
        attempts: 1, cycle: state.cycle }, now(), effects.persist));
      continue;
    }
    if (state.actions[key]?.state === 'done' || state.actions[key]?.state === 'failed') continue;
    const carry = refresh!.carry;
    const kept = carry ? [...(carry.approval.carried ? ['the approval'] : []), ...carry.evidence.filter(entry => entry.carried).map(entry => entry.proof)] : [];
    const again = carry ? [...(carry.approval.carried ? [] : ['the approval']), ...carry.evidence.filter(entry => !entry.carried).map(entry => entry.proof)] : [];
    const detail = refresh!.conflict
      ? `${item.key}: ${refresh!.from.sha.slice(0, 12)} cannot be brought onto base branch tip ${refresh!.base.slice(0, 12)} by Graphyard; it returns to the worker with the conflict named: ${refresh!.conflict}`
      : `${item.key}: brought ${refresh!.from.sha.slice(0, 12)} onto base branch tip ${refresh!.base.slice(0, 12)} as ${(refresh!.head ?? '').slice(0, 12)} with no rework round; kept ${kept.join(', ') || 'nothing'}${again.length ? `; required afresh: ${again.join(', ')}` : ''}`;
    performed.push(await record(state, key, { kind: 'refresh', work: item.key, principal: null, state: refresh!.conflict ? 'failed' : 'done', detail,
      attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  }

  // 5. Shepherd reviews and proofs for submitted candidates. Graphyard dispatches provider reviews
  //    and trusted producers publish evidence; the daemon records exactly one request per candidate
  //    and escalates what only a human or a producer may resolve.
  for (const item of open.filter(candidate => candidate.submission && candidate.candidate && !candidate.reworkRequested)) {
    const reviewGate = item.gates.find(gate => gate.name === 'review');
    if (reviewGate && !reviewGate.passed) {
      const key = candidateKey('review', item);
      const provider = reviewProviderOf(item.policy);
      const exhausted = provider === 'agent' && !reviewerProfileFor(item) && exhaustedReviewerProfiles(item).length > 0;
      if (exhausted) {
        const escalation = `${item.key}: every configured reviewer profile is exhausted for the current candidate (${exhaustedReviewerProfiles(item).join(', ')}); add reviewer capacity or revise the review policy. Exhaustion is never an approval.`;
        const escalationKey = `escalation:review:${item.id}:${item.candidate!.sha}:${item.policyRevision}`;
        if (state.actions[escalationKey]?.state !== 'done') performed.push(await record(state, escalationKey, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: escalation, attempts: 1, cycle: state.cycle }, now(), effects.persist));
      } else {
        const detail = provider === 'github' ? `${item.key}: an independent GitHub approval of the current commit is required; the coordinator cannot supply it`
          : item.reviewRequest ? `${item.key}: Graphyard dispatched ${provider} review to profile ${item.reviewRequest.profile ?? provider}; waiting for a verdict on ${item.candidate!.sha.slice(0, 12)}`
            : `${item.key}: waiting for Graphyard to dispatch a ${provider} review for ${item.candidate!.sha.slice(0, 12)}`;
        if (state.actions[key]?.detail !== detail) performed.push(await record(state, key, { kind: 'review', work: item.key, principal: null, state: 'done', detail, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      }
    }
    const outstanding = missingProofs(item, new Date(clock));
    if (!outstanding.length) continue;
    const manual = outstanding.filter(proof => proof.startsWith('manual:'));
    const automatable = outstanding.filter(proof => !proof.startsWith('manual:'));
    if (manual.length) {
      const key = `escalation:proof:${item.id}:${item.candidate!.sha}:${item.policyRevision}`;
      if (state.actions[key]?.state !== 'done') performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: `${item.key} needs operator-witnessed proof for ${manual.join(', ')}; the coordinator holds no producer credential and cannot submit it`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
    }
    if (!automatable.length) continue;
    const key = candidateKey('proof', item);
    const previous = state.actions[key];
    if (previous && (previous.state === 'done' || previous.attempts >= maxProofAttempts || !readyToRetry(previous, state.cycle))) continue;
    if (!config.run.proofWorkflow) {
      if (previous?.state !== 'failed') performed.push(await record(state, key, { kind: 'proof', work: item.key, principal: null, state: 'failed', detail: `${item.key} needs trusted evidence for ${automatable.join(', ')}; configure master run --proof-workflow so the loop can request it from the trusted producer workflow`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      continue;
    }
    await record(state, key, { kind: 'proof', work: item.key, principal: null, state: 'started', detail: `Requesting ${config.run.proofWorkflow} for ${item.key}`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    try {
      await effects.requestProof(item);
      performed.push(await record(state, key, { kind: 'proof', work: item.key, principal: null, state: 'done', detail: `Requested trusted producer workflow ${config.run.proofWorkflow} for ${item.key} PR #${item.submission!.pr} at ${item.candidate!.sha.slice(0, 12)} (${automatable.join(', ')})`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'proof', work: item.key, principal: null, state: 'failed', detail: `Could not request ${config.run.proofWorkflow} for ${item.key}: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 6. Merge. The only path is the guarded command, which rechecks the exact candidate, every gate,
  //    branch protection and the published queue tip immediately before the provider call.
  //    An item GitHub already merged with no valid execution behind it is not a candidate: the
  //    merge cannot be re-run, so the loop names the violation and the two-party decision that
  //    reconciles it once, instead of asking the guarded merge every cycle.
  for (const item of open.filter(mergedWithoutAuthorization)) {
    const key = `${candidateKey('escalation', item)}:merged`;
    if (state.actions[key]?.state === 'done') continue;
    performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: `${item.key} was merged on GitHub (${item.observation!.mergeSha?.slice(0, 12) ?? 'merge commit unknown'} at ${item.observation!.mergedAt ?? 'an unrecorded time'}) without a valid merge execution: ${unauthorizedMergeViolation}. It stays at the merge stage until a two-party decision reconciles it: graphyard master decide ${item.key} merge REASON, then graphyard master approver ${item.key} DECISION; Graphyard re-checks the record at the merge cutoff and delivers on the approved decision`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
  }
  const mergeCandidates = open.filter(candidate => candidate.stage === 'merge' && !mergedWithoutAuthorization(candidate));
  if (config.autoMerge) {
    for (const item of mergeCandidates) {
      const key = candidateKey('merge', item);
      const previous = state.actions[key];
      if (!readyToRetry(previous, state.cycle)) continue;
      await record(state, key, { kind: 'merge', work: item.key, principal: null, state: 'started', detail: `Invoking the guarded merge for ${item.key}`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
      try {
        const result = await effects.merge(item);
        performed.push(await record(state, key, { kind: 'merge', work: item.key, principal: null, state: 'done', detail: `Guarded merge accepted for ${item.key}: ${(result as { result?: string })?.result ?? 'merge requested'}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        // A refusal is the gate working, not a daemon fault: record it and keep cycling.
        performed.push(await record(state, key, { kind: 'merge', work: item.key, principal: null, state: 'failed', detail: `Guarded merge refused for ${item.key}: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
      }
    }
  } else {
    for (const item of mergeCandidates) {
      const key = candidateKey('escalation', item);
      if (state.actions[key]?.state === 'done') continue;
      performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: `Automatic merging is disabled; ${item.key} awaits explicit operator approval before the guarded merge runs`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 7. Verify what is actually deployed. This is an observation, never a gate: Graphyard already
  //    marked the work Done on an observed merge, and a lagging rollout must stay visible as lag.
  const delivered = snapshot.work.filter(item => item.stage === 'done' && item.delivery)
    .sort((a, b) => Date.parse(a.delivery!.mergedAt) - Date.parse(b.delivery!.mergedAt));
  const deploymentKey = `deployment:${delivered.at(-1)?.delivery?.mergeSha ?? 'none'}`;
  try {
    const observation = await effects.observeDeployment(delivered);
    state.deployment = deploymentObservationSchema.parse(observation);
    if (state.actions[deploymentKey]?.detail !== deploymentDetail(state.deployment)) {
      performed.push(await record(state, deploymentKey, { kind: 'deployment', work: null, principal: null, state: observation.source === 'unavailable' ? 'failed' : 'done', detail: deploymentDetail(state.deployment), attempts: (state.actions[deploymentKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
    }
  } catch (error) {
    state.deployment = { source: 'unavailable', sha: null, at: new Date(now()).toISOString(), reason: message(error), deployed: [], pending: delivered.map(item => item.key) };
    performed.push(await record(state, deploymentKey, { kind: 'deployment', work: null, principal: null, state: 'failed', detail: `Deployment SHA could not be verified: ${message(error)}`, attempts: (state.actions[deploymentKey]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
  }

  // 7b. The second confidence layer. For each delivery whose policy asks for a smoke proof: record
  //     the observation on Graphyard once the release serves its merge, ask the provider to run the
  //     trusted smoke workflow against exactly that commit, and escalate a failed verdict with
  //     rollback guidance. The loop never produces the verdict: the workflow's producer does.
  const observed = state.deployment;
  for (const item of delivered.filter(candidate => deploySmokeRequired(candidate.policy))) {
    const delivery = item.delivery!;
    if (!delivery.deployment) {
      if (observed?.source === 'unavailable' || !observed?.sha || !observed.deployed.includes(item.key)) continue;
      const key = `deployment:record:${item.id}:${observed.sha}`;
      if (state.actions[key] && state.actions[key].state !== 'failed') continue;
      if (!readyToRetry(state.actions[key], state.cycle)) continue;
      const attempts = (state.actions[key]?.attempts ?? 0) + 1;
      await record(state, key, { kind: 'deployment', work: item.key, principal: null, state: 'started', detail: `Recording that ${observed.sha.slice(0, 12)} from ${observed.source} serves ${item.key}`, attempts, cycle: state.cycle }, now(), effects.persist);
      try {
        await effects.recordDeployment(item, { sha: observed.sha, source: observed.source as 'endpoint' | 'github-deployment', observedAt: observed.at });
        performed.push(await record(state, key, { kind: 'deployment', work: item.key, principal: null, state: 'done', detail: `Recorded deployment ${observed.sha.slice(0, 12)} (${observed.source}) covering ${item.key} merge ${delivery.mergeSha.slice(0, 12)}; the smoke proof may now be requested`, attempts, cycle: state.cycle }, now(), effects.persist));
      } catch (error) {
        performed.push(await record(state, key, { kind: 'deployment', work: item.key, principal: null, state: 'failed', detail: `Could not record the deployment for ${item.key}: ${message(error)}`, attempts, cycle: state.cycle }, now(), effects.persist));
      }
      continue;
    }
    const outcome = deliveryState(item);
    if (outcome === 'delivered-with-failure') {
      const key = `escalation:smoke:${item.id}:${delivery.smoke!.evidenceId}`;
      if (state.actions[key]?.state !== 'done') performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: rollbackGuidance(item, config.baseBranch)!, attempts: 1, cycle: state.cycle }, now(), effects.persist));
      continue;
    }
    if (outcome !== 'awaiting-smoke') continue;
    const key = `smoke:${item.id}:${delivery.deployment.sha}`;
    const previous = state.actions[key];
    if (previous && (previous.state === 'done' || previous.attempts >= maxProofAttempts || !readyToRetry(previous, state.cycle))) continue;
    if (!config.run.smokeWorkflow) {
      if (previous?.state !== 'failed') performed.push(await record(state, key, { kind: 'smoke', work: item.key, principal: null, state: 'failed', detail: `${item.key} is deployed at ${delivery.deployment.sha.slice(0, 12)} and needs its post-deployment smoke proof; configure master init --smoke-workflow so the loop can request it from the trusted producer workflow`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist));
      continue;
    }
    await record(state, key, { kind: 'smoke', work: item.key, principal: null, state: 'started', detail: `Requesting ${config.run.smokeWorkflow} for ${item.key} at ${delivery.deployment.sha.slice(0, 12)}`, attempts: (previous?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    try {
      await effects.requestSmoke(item);
      performed.push(await record(state, key, { kind: 'smoke', work: item.key, principal: null, state: 'done', detail: `Requested trusted smoke workflow ${config.run.smokeWorkflow} for ${item.key} against deployed ${delivery.deployment.sha.slice(0, 12)} (merge ${delivery.mergeSha.slice(0, 12)})`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      performed.push(await record(state, key, { kind: 'smoke', work: item.key, principal: null, state: 'failed', detail: `Could not request ${config.run.smokeWorkflow} for ${item.key}: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 8. Measure. Every cycle records stage p50/p90 whether or not it acted.
  const { stages, lead, production, postDeploy, postDeployFailures } = stageMetrics(snapshot.work, clock);
  const metrics = cycleMetricsSchema.parse({ cycle: state.cycle, at: new Date(clock).toISOString(), durationMs: Math.max(0, Math.round(now() - startedAt)), open: open.length, actions: performed.length, stages, lead, production, postDeploy, postDeployFailures,
    scope: { count: budget.count, p50Ms: budget.p50Ms, p90Ms: budget.p90Ms }, scopeOpenMs: budget.longestOpenMs });
  state.metrics.push(metrics);
  state.cycle += 1;
  state.lastCycleAt = new Date(now()).toISOString();
  if (state.lock) state.lock = { ...state.lock, heartbeatAt: state.lastCycleAt };
  pruneDaemonState(state);
  await effects.persist(state);
  return { actions: performed, metrics, deployment: state.deployment, health, scope: budget };
}

/**
 * Every failure the cycle records passes through here. A command that failed because the host
 * ran out of room keeps its own output and gains the name of the condition, so the action reads
 * as a disk to reclaim rather than as an unexplained command error.
 */
const message = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error), cause = diskExhaustion(error);
  return cause ? `${text} — ${cause}: ${reclaimAdvice}` : text;
};
function deploymentDetail(observation: DeploymentObservation) {
  if (observation.source === 'unavailable') return `Deployment SHA is unverified: ${observation.reason ?? 'no deployment observation is configured or available'}`;
  return `Deployed SHA ${observation.sha?.slice(0, 12) ?? 'unknown'} from ${observation.source}; verified ${observation.deployed.length} delivered item(s), ${observation.pending.length} not yet serving`;
}

/**
 * The deployed commit, taken from a configured endpoint that reports it or from the provider's own
 * deployment record. A delivered item counts as deployed when the serving commit is its merge commit
 * or a descendant of it, so later merges do not make earlier ones look undeployed.
 */
export async function observeDeployment(config: MasterConfig, delivered: Work[], run: (command: string, args: string[]) => string, fetcher: typeof fetch = fetch, now = () => Date.now()): Promise<DeploymentObservation> {
  const at = new Date(now()).toISOString();
  const unavailable = (reason: string): DeploymentObservation => ({ source: 'unavailable', sha: null, at, reason, deployed: [], pending: delivered.map(item => item.key) });
  if (!delivered.length) return { source: 'unavailable', sha: null, at, reason: 'No delivered work is awaiting deployment verification', deployed: [], pending: [] };
  let sha: string | null = null, source: DeploymentObservation['source'] = 'unavailable';
  if (config.run.deploymentUrl) {
    let payload: any;
    try {
      const response = await fetcher(config.run.deploymentUrl, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) return unavailable(`Deployment endpoint answered ${response.status}`);
      payload = await response.json();
    } catch (error) { return unavailable(`Deployment endpoint is unreachable: ${message(error)}`); }
    const value = config.run.deploymentShaField.split('.').reduce((node: any, part) => node?.[part], payload);
    if (typeof value !== 'string' || !/^[0-9a-f]{7,40}$/i.test(value)) return unavailable(`Deployment endpoint did not report a commit at ${config.run.deploymentShaField}`);
    sha = value.toLowerCase(); source = 'endpoint';
  } else {
    let deployments: any[];
    try { deployments = JSON.parse(run('gh', ['api', `repos/${config.repository}/deployments?per_page=20&ref=${encodeURIComponent(config.baseBranch)}`])); }
    catch (error) { return unavailable(`No deployment endpoint is configured and GitHub deployments are unavailable: ${message(error)}`); }
    if (!Array.isArray(deployments) || !deployments.length) return unavailable('No deployment endpoint is configured and the repository records no GitHub deployment for the managed base branch');
    for (const deployment of deployments) {
      let statuses: any[];
      try { statuses = JSON.parse(run('gh', ['api', `repos/${config.repository}/deployments/${deployment.id}/statuses?per_page=10`])); }
      catch { continue; }
      if (Array.isArray(statuses) && statuses[0]?.state === 'success' && typeof deployment.sha === 'string') { sha = deployment.sha.toLowerCase(); source = 'github-deployment'; break; }
    }
    if (!sha) return unavailable('No GitHub deployment for the managed base branch reports a successful status');
  }
  const deployed: string[] = [], pending: string[] = [];
  for (const item of delivered) {
    const mergeSha = item.delivery!.mergeSha.toLowerCase();
    if (mergeSha === sha) { deployed.push(item.key); continue; }
    try {
      const comparison = JSON.parse(run('gh', ['api', `repos/${config.repository}/compare/${mergeSha}...${sha}`]));
      (comparison?.status === 'ahead' || comparison?.status === 'identical' ? deployed : pending).push(item.key);
    } catch { pending.push(item.key); }
  }
  return deploymentObservationSchema.parse({ source, sha, at, reason: null, deployed: deployed.slice(-200), pending: pending.slice(-200) });
}

/** The compact daemon view `master status` joins onto Graphyard truth. */
export function daemonSummary(state: DaemonState, now: number, intervalMs: number) {
  const lastCycleAt = state.lastCycleAt ? Date.parse(state.lastCycleAt) : Number.NaN;
  const lagMs = Number.isFinite(lastCycleAt) ? now - lastCycleAt : null;
  const recent = Object.entries(state.actions).map(([key, action]) => ({ key, ...action })).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return {
    running: !!state.lock && lagMs !== null && lagMs < Math.max(3 * intervalMs, 120_000),
    lock: state.lock, cycle: state.cycle, lastCycleAt: state.lastCycleAt, lagMs,
    unresolved: recent.filter(action => action.state === 'started' || action.state === 'indeterminate'),
    escalations: recent.filter(action => action.kind === 'escalation').slice(0, 20),
    actions: recent.slice(0, 40),
    metrics: state.metrics.at(-1) ?? null,
    deployment: state.deployment,
    profiles: state.profiles,
    config: state.config,
    reclaim: state.reclaim,
  };
}

/**
 * Adopt a reloaded master.json into the running loop, or record why it was refused. A refusal is
 * an escalation naming the stale setting, written once per distinct reason; an adoption names what
 * changed. Either way the loop keeps cycling on the settings it holds.
 */
export async function noteConfigReload(state: DaemonState, reload: ConfigReload, persist: DaemonEffects['persist']) {
  const previous = state.config;
  state.config = { at: reload.at, changed: reload.changed.slice(0, 100), refused: reload.refused?.slice(0, 1000) ?? null };
  const noted: DaemonAction[] = [];
  if (reload.refused && previous?.refused !== state.config.refused) {
    const entry = daemonActionSchema.parse({ kind: 'escalation', work: null, principal: null, state: 'failed', detail: state.config.refused, attempts: 1, cycle: state.cycle, at: reload.at });
    state.actions[`escalation:config:${reload.at}`] = entry; noted.push(entry);
  }
  if (reload.changed.length) {
    const entry = daemonActionSchema.parse({ kind: 'config', work: null, principal: null, state: 'done', detail: `Adopted .graphyard/master.json changes without a restart: ${reload.changed.join(', ')}`.slice(0, 2000), attempts: 1, cycle: state.cycle, at: reload.at });
    state.actions[`config:${reload.at}`] = entry; noted.push(entry);
  }
  if (noted.length || previous?.refused !== state.config.refused) await persist(state);
  return noted;
}

/**
 * Supervised entry point. The process owns no lease and no credential beyond the coordinator token,
 * so a restart is always safe: it reconciles the cursor against Graphyard and keeps cycling.
 */
export async function runDaemon(config: MasterConfig, state: DaemonState, effects: DaemonEffects, options: { once?: boolean; intervalMs: number | (() => number); identity: { pid: number; host: string }; signals?: NodeJS.Signals[]; now?: () => number; log?: (line: string) => void;
  /** Re-reads .graphyard/master.json before each cycle, so profiles, workspace, run settings and autoMerge apply without a restart. */
  reload?: () => Promise<ConfigReload> } ) {
  // Progress goes to stderr so stdout stays the machine-readable result the CLI prints.
  const now = options.now ?? Date.now, log = options.log ?? (line => console.error(line));
  const interval = () => typeof options.intervalMs === 'function' ? options.intervalMs() : options.intervalMs;
  acquireDaemonLock(state, options.identity, now(), interval());
  await effects.persist(state);
  let stopping = false;
  // A supervisor's SIGTERM must land during the wait, not one whole interval later.
  const waking = new AbortController();
  const stop = () => { stopping = true; waking.abort(); };
  const signals = options.signals ?? ['SIGTERM', 'SIGINT'];
  for (const signal of signals) process.on(signal, stop);
  const cycles: { cycle: number; actions: number; durationMs: number }[] = [];
  try {
    do {
      if (options.reload) {
        for (const action of await noteConfigReload(state, await options.reload().then(reload => { config = reload.config; return reload; }), effects.persist)) log(`[graphyard-master] ${action.kind} ${action.state}: ${action.detail}`);
      }
      const result = await runCycle(config, state, effects, now);
      cycles.push({ cycle: result.metrics.cycle, actions: result.actions.length, durationMs: result.metrics.durationMs });
      for (const action of result.actions) log(`[graphyard-master] cycle ${result.metrics.cycle} ${action.kind} ${action.state}: ${action.detail}`);
      log(`[graphyard-master] cycle ${result.metrics.cycle} complete in ${result.metrics.durationMs}ms; ${result.metrics.open} open, ${result.actions.length} action(s)`);
      if (options.once || stopping) break;
      try { await delay(interval(), undefined, { signal: waking.signal }); } catch { /* woken to stop */ }
    } while (!stopping);
  } finally {
    for (const signal of signals) process.off(signal, stop);
    state.lock = null;
    await effects.persist(state).catch(() => {});
  }
  return { cycles, stopped: stopping };
}

/** Effects bound to the real coordinator process; `config` may be a live source the loop reloads. */
export function daemonEffects(root: string, source: MasterConfig | (() => MasterConfig), deps: {
  snapshot: () => Promise<{ work: Work[]; now: string }>;
  mutate: (path: string, data: unknown, requestId?: string) => Promise<any>;
  /**
   * The merge executor this daemon process is: its coordinator principal and an instance minted
   * once per process. Every guarded merge the loop runs presents it, so an execution this process
   * acquired is resumed by this process alone and never by an interactive merge or a second loop.
   */
  executor: MergeExecutor;
  run?: (command: string, args: string[]) => string;
}): DaemonEffects {
  const run = deps.run ?? ((command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 }));
  const current = typeof source === 'function' ? source : () => source;
  return {
    agents: () => { try { return listHerdrAgents(run); } catch { return []; } },
    // The tail of the session's own terminal, unwrapped so a notice the pane folded reads as one line.
    sessionOutput: agent => { const target = agent.name ?? agent.pane_id; return target ? run('herdr', ['agent', 'read', target, '--source', 'recent-unwrapped', '--lines', '60', '--format', 'text']) : null; },
    reportCapacity: (work, event) => deps.mutate(`work/${work.id}/capacity`, event),
    launchedSessions: async () => [
      ...(await readReviewLedger(root)).reviews.filter(entry => entry.state === 'pending').map(entry => ({ role: 'reviewer' as const, record: entry.id, profile: entry.profile, agentName: entry.agentName, pane: entry.pane, work: entry.key, requestId: entry.requestId ?? null })),
      ...(await readProducerLedger(root)).producers.filter(entry => entry.state === 'pending').map(entry => ({ role: 'producer' as const, record: entry.id, profile: entry.profile, agentName: entry.agentName, pane: entry.pane, work: entry.key, requestId: entry.requestId })),
    ],
    selectedAccount: async (role, profile) => (await readEnvironmentLog(current())).selected?.[selectionKey(role, profile)] ?? null,
    preserveWork: async (work, epoch) => {
      const workspace = work.workspaces.find(entry => entry.epoch === epoch);
      if (!workspace || workspace.host !== current().hostId) return { state: 'not-applicable', detail: workspace ? `the attempt worktree is on ${workspace.host}, not this host; its commits stay on ${workspace.branch}` : 'the attempt registered no workspace' };
      return preservePartialWork(workspace.path, `${work.key} attempt ${epoch} interrupted by provider quota exhaustion`, run);
    },
    holdAccount: (account, observed) => recordObservedExhaustion(current(), account, observed),
    endSession: async (session, resolution) => {
      if (session.pane) closeHerdrPane(session.pane, run);
      const closedAt = new Date().toISOString(), ended = { state: 'failed' as const, resolution: resolution.slice(0, 500), closedAt };
      if (session.role === 'reviewer') { const ledger = await readReviewLedger(root); await saveReviewLedger(root, { ...ledger, reviews: ledger.reviews.map(entry => entry.id === session.record && entry.state === 'pending' ? { ...entry, ...ended } : entry) }); }
      else { const ledger = await readProducerLedger(root); await saveProducerLedger(root, { ...ledger, producers: ledger.producers.map(entry => entry.id === session.record && entry.state === 'pending' ? { ...entry, ...ended } : entry) }); }
    },
    relaunch: async (session, work, snapshot) => {
      const config = current(), agents = listHerdrAgents(run);
      const request = session.role === 'reviewer' ? work.autoDispatch?.review : work.autoDispatch?.producers.find(entry => entry.id === session.requestId);
      if (!request || request.id !== session.requestId || request.state !== 'requested') throw new Error(`${work.key} no longer requests this ${session.role} session`);
      // The profile that just ran out goes last: its other accounts are still its own failover.
      const order = <P extends { name: string; agentName: string }>(profiles: P[]) => [...profiles.filter(profile => profile.name !== session.profile), ...profiles.filter(profile => profile.name === session.profile)].filter(profile => !agents.some(agent => agent.name === profile.agentName));
      const skipped: string[] = [];
      for (const profile of session.role === 'reviewer' ? order(config.reviewers) : order(independentProducerProfiles(work, config.producers))) {
        try {
          if (session.role === 'reviewer') await launchReview(root, work, profile.name, agents, snapshot.now, { run, requestId: request.id });
          else await launchProducer(root, work, request, profile as MasterConfig['producers'][number], agents, snapshot.now, { run });
          return { profile: profile.name };
        } catch (error) { if (!(error as { accountsExhausted?: boolean })?.accountsExhausted) throw error; skipped.push(message(error)); }
      }
      if (!skipped.length) throw new Error(`no ${session.role} profile is free to take the request`);
      throw Object.assign(new Error(skipped.join('; ')), { accountsExhausted: true });
    },
    roleHealth: async () => {
      const config = current();
      return {
        ...(config.reviewers.length ? { reviewer: { profiles: config.reviewers, health: await inspectProfileAccounts(config, 'reviewer', config.reviewers, Object.fromEntries(config.reviewers.map(profile => [profile.name, { available: true, reason: null as string | null }]))) } } : {}),
        ...(config.producers.length ? { producer: { profiles: config.producers, health: await inspectProducerCredentials(root, config.producers) } } : {}),
      };
    },
    herdr: () => { const runtime = observeHerdrAgents(run); return { agents: runtime.agents, available: runtime.available }; },
    stopSupervisor: (orphan, signal) => { stopWatchSupervisor(orphan, signal, run); },
    credentials: profiles => inspectWorkerCredentials(root, profiles),
    snapshot: deps.snapshot,
    closeSession: pane => closeHerdrPane(pane, run),
    dispatch: (work, profile, agents, snapshot) => dispatchWork(root, work, profile, agents, run, snapshot.work, undefined, undefined, undefined, snapshot.now),
    decideScope: work => deps.mutate(`work/${work.id}/autoscope`, { epoch: work.scopeRequest!.epoch }),
    requestProof: work => {
      const config = current();
      run('gh', ['workflow', 'run', config.run.proofWorkflow!, '--repo', config.repository, '--ref', config.baseBranch,
        '-f', `pr=${work.submission!.pr}`, '-f', `work_id=${work.id}`, '-f', `policy_revision=${work.policyRevision}`]);
    },
    merge: work => mergeExecutor(current(), deps.snapshot, deps.mutate, deps.executor, randomUUID(), run)(work),
    observeDeployment: delivered => observeDeployment(current(), delivered, run),
    recordDeployment: (work, observation) => deps.mutate(`work/${work.id}/deployment`, { sha: observation.sha, mergeSha: work.delivery!.mergeSha, source: observation.source, observedAt: observation.observedAt }),
    requestSmoke: work => {
      const config = current();
      run('gh', ['workflow', 'run', config.run.smokeWorkflow!, '--repo', config.repository, '--ref', config.baseBranch,
        '-f', `work_id=${work.id}`, '-f', `deployed_sha=${work.delivery!.deployment!.sha}`, '-f', `merge_sha=${work.delivery!.mergeSha}`, '-f', `policy_revision=${work.policyRevision}`]);
    },
    // The idle bound comes from the live configuration, so a host under pressure can shorten it
    // (or a slow repository lengthen it) without restarting the loop.
    reclaim: work => reclaimWorktrees(root, work, { idleMs: reclaimIdleMs(current()) }),
    persist: state => writeDaemonState(current(), state),
  };
}
