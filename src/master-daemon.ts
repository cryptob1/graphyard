import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { currentEvidence, exhaustedReviewerProfiles, reviewProviderOf, reviewerProfileFor, type Work } from './model.js';
import { assertDispatchable, assertOutsideWorktrees, closeHerdrPane, dispatchWork, inspectWorkerCredentials, listHerdrAgents, mergeExecutor, type HerdrAgent, type MasterConfig, type WorkerProfile } from './master.js';

/**
 * The durable coordination loop. Every step is a pure decision over one Graphyard snapshot plus
 * an injected effect, so the same cycle runs under systemd, under Herdr, or inside a test with no
 * process supervision at all. The daemon is a coordinator: it never claims a lease, never produces
 * evidence, never calls an operator route, and reaches GitHub only through the guarded merge.
 */

export const daemonActionKinds = ['close', 'dispatch', 'review', 'proof', 'merge', 'deployment', 'escalation'] as const;
export type DaemonActionKind = typeof daemonActionKinds[number];
export const daemonActionSchema = z.object({
  kind: z.enum(daemonActionKinds),
  work: z.string().nullable().default(null),
  principal: z.string().nullable().default(null),
  state: z.enum(['started', 'done', 'failed', 'indeterminate']),
  detail: z.string().max(2000),
  attempts: z.number().int().min(0).max(1000).default(1),
  cycle: z.number().int().min(0),
  at: z.string(),
}).strict();
export type DaemonAction = z.infer<typeof daemonActionSchema>;

const percentileSchema = z.object({ count: z.number().int().min(0), p50Ms: z.number().int().min(0), p90Ms: z.number().int().min(0) }).strict();
export const cycleMetricsSchema = z.object({
  cycle: z.number().int().min(0), at: z.string(), durationMs: z.number().int().min(0),
  open: z.number().int().min(0), actions: z.number().int().min(0),
  stages: z.record(z.string(), percentileSchema).default({}),
  lead: percentileSchema,
}).strict();
export type CycleMetrics = z.infer<typeof cycleMetricsSchema>;

export const deploymentObservationSchema = z.object({
  source: z.enum(['endpoint', 'github-deployment', 'unavailable']),
  sha: z.string().nullable(), at: z.string(), reason: z.string().max(500).nullable(),
  deployed: z.array(z.string()).max(200).default([]), pending: z.array(z.string()).max(200).default([]),
}).strict();
export type DeploymentObservation = z.infer<typeof deploymentObservationSchema>;

export const daemonStateSchema = z.object({
  version: z.literal(1), url: z.string(), repository: z.string(),
  lock: z.object({ id: z.string(), pid: z.number().int().positive(), host: z.string(), startedAt: z.string(), heartbeatAt: z.string() }).strict().nullable().default(null),
  cycle: z.number().int().min(0).default(0),
  lastCycleAt: z.string().nullable().default(null),
  actions: z.record(z.string(), daemonActionSchema).default({}),
  profiles: z.record(z.string(), z.object({ failures: z.number().int().min(0), reason: z.string().max(500).nullable(), cooldownUntil: z.string().nullable() }).strict()).default({}),
  metrics: z.array(cycleMetricsSchema).default([]),
  deployment: deploymentObservationSchema.nullable().default(null),
}).strict();
export type DaemonState = z.infer<typeof daemonStateSchema>;

export const retainedActions = 500, retainedMetrics = 100, profileCooldownMs = 600_000, maxProofAttempts = 3;

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
  await writeFile(temporary, JSON.stringify(daemonStateSchema.parse(state), null, 2), { mode: 0o600, flag: 'wx' });
  await rename(temporary, file); await chmod(file, 0o600);
}

/** Keep the cursor bounded without ever discarding an unresolved action. */
export function pruneDaemonState(state: DaemonState) {
  const entries = Object.entries(state.actions);
  const resolved = entries.filter(([, action]) => action.state === 'done' || action.state === 'failed');
  if (resolved.length > retainedActions) {
    for (const [key] of resolved.sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at)).slice(0, resolved.length - retainedActions)) delete state.actions[key];
  }
  if (state.metrics.length > retainedMetrics) state.metrics = state.metrics.slice(-retainedMetrics);
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
 */
export function reconcilePendingActions(state: DaemonState, work: Work[], now: number) {
  const resumed: DaemonAction[] = [];
  for (const [key, action] of Object.entries(state.actions)) {
    if (action.state !== 'started') continue;
    const item = work.find(candidate => candidate.key === action.work || candidate.id === action.work);
    const owned = !!item?.lease && item.lease.owner === action.principal && Date.parse(item.lease.expiresAt) > now;
    const next: DaemonAction = { ...action, at: new Date(now).toISOString() };
    if (action.kind === 'dispatch') {
      next.state = owned || !!item?.submission ? 'done' : 'failed';
      next.detail = owned ? 'Resumed: Graphyard shows the assignment landed before the restart'
        : item?.submission ? 'Resumed: the assignment produced a submission before the restart'
          : 'Resumed: no assignment landed, so the item stays eligible for a fresh dispatch';
    } else if (action.kind === 'merge') {
      next.state = item?.observation?.merged || item?.stage === 'done' ? 'done' : 'failed';
      next.detail = next.state === 'done' ? 'Resumed: Graphyard observed the merge' : 'Resumed: no merge was observed; the guarded merge may be attempted again';
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

export function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted.length ? Math.max(0, Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1)])) : 0;
  return { count: sorted.length, p50Ms: at(50), p90Ms: at(90) };
}

/**
 * Stage dwell for work still in flight, plus delivered lead time. Both come from the snapshot the
 * cycle already read, so the measurement cannot disagree with the state the cycle acted on.
 */
export function stageMetrics(work: Work[], now: number) {
  const stages: Record<string, ReturnType<typeof percentiles>> = {};
  const open = work.filter(item => item.stage !== 'done');
  for (const stage of [...new Set(open.map(item => item.stage))].sort()) {
    stages[stage] = percentiles(open.filter(item => item.stage === stage).map(item => now - Date.parse(item.stageEnteredAt)).filter(Number.isFinite));
  }
  const lead = percentiles(work.filter(item => item.stage === 'done' && item.delivery)
    .map(item => Date.parse(item.delivery!.mergedAt) - Date.parse(item.createdAt)).filter(value => Number.isFinite(value) && value >= 0));
  return { stages, lead };
}

export function missingProofs(work: Work, now: Date) {
  const proofs = [...new Set(work.criteria.flatMap(criterion => criterion.proofs))];
  return proofs.filter(proof => {
    const evidence = currentEvidence(work, proof, now);
    return !evidence || evidence.result !== 'pass' || evidence.executed < 1 || evidence.skipped > 0;
  });
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

export interface DaemonEffects {
  closeSession: (pane: string) => void | Promise<void>;
  dispatch: (work: Work, profile: WorkerProfile, agents: HerdrAgent[], snapshot: { work: Work[]; now: string }) => Promise<unknown>;
  requestProof: (work: Work) => void | Promise<void>;
  merge: (work: Work) => Promise<unknown>;
  observeDeployment: (delivered: Work[]) => Promise<DeploymentObservation>;
  agents: () => HerdrAgent[];
  credentials: (profiles: WorkerProfile[]) => Promise<Record<string, { available: boolean; reason: string | null }>>;
  snapshot: () => Promise<{ work: Work[]; now: string }>;
  persist: (state: DaemonState) => Promise<void>;
}

async function record(state: DaemonState, key: string, action: Omit<DaemonAction, 'at'> & { at?: string }, now: number, persist: DaemonEffects['persist']) {
  const entry = daemonActionSchema.parse({ ...action, at: action.at ?? new Date(now).toISOString() });
  state.actions[key] = entry; await persist(state);
  return entry;
}

/**
 * One coordination cycle: close finished sessions, dispatch claimable work to a healthy profile,
 * shepherd reviews and proofs, invoke only the guarded merge, verify the deployed SHA, and measure
 * the stages. The cursor is persisted before and after every external action, so a kill between
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

  // A pane this cycle just closed frees its profile, so health is read after the closures.
  const health = profileHealth(config.workers, credentials, effects.agents(), state, clock);

  // 2. Dispatch claimable work to a healthy profile. The launcher claims under the worker's own
  //    identity; the daemon never holds a lease. An unhealthy profile is skipped, not waited on.
  const claimable = open.filter(item => {
    try { assertDispatchable(item, snapshot.work, snapshot.now); return true; } catch { return false; }
  }).sort((a, b) => a.priority - b.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const taken = new Set<string>();
  for (const item of claimable) {
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
    await record(state, key, { kind: 'dispatch', work: item.key, principal: choice.profile.principal, state: 'started', detail: `Dispatching ${item.key} to ${choice.profile.name}`, attempts: (state.actions[key]?.attempts ?? 0) + 1, cycle: state.cycle }, now(), effects.persist);
    try {
      await effects.dispatch(item, choice.profile, free, snapshot);
      clearProfileFailure(state, choice.profile);
      performed.push(await record(state, key, { kind: 'dispatch', work: item.key, principal: choice.profile.principal, state: 'done', detail: `Dispatched ${item.key} to ${choice.profile.name}; the worker launcher claimed under ${choice.profile.principal}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    } catch (error) {
      recordProfileFailure(state, choice.profile, message(error), now());
      performed.push(await record(state, key, { kind: 'dispatch', work: item.key, principal: choice.profile.principal, state: 'failed', detail: `Dispatch of ${item.key} to ${choice.profile.name} failed: ${message(error)}`, attempts: state.actions[key].attempts, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 3. Shepherd reviews and proofs for submitted candidates. Graphyard dispatches provider reviews
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

  // 4. Merge. The only path is the guarded command, which rechecks the exact candidate, every gate,
  //    branch protection and the published queue tip immediately before the provider call.
  if (config.autoMerge) {
    for (const item of open.filter(candidate => candidate.stage === 'merge')) {
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
    for (const item of open.filter(candidate => candidate.stage === 'merge')) {
      const key = candidateKey('escalation', item);
      if (state.actions[key]?.state === 'done') continue;
      performed.push(await record(state, key, { kind: 'escalation', work: item.key, principal: null, state: 'done', detail: `Automatic merging is disabled; ${item.key} awaits explicit operator approval before the guarded merge runs`, attempts: 1, cycle: state.cycle }, now(), effects.persist));
    }
  }

  // 5. Verify what is actually deployed. This is an observation, never a gate: Graphyard already
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

  // 6. Measure. Every cycle records stage p50/p90 whether or not it acted.
  const { stages, lead } = stageMetrics(snapshot.work, clock);
  const metrics = cycleMetricsSchema.parse({ cycle: state.cycle, at: new Date(clock).toISOString(), durationMs: Math.max(0, Math.round(now() - startedAt)), open: open.length, actions: performed.length, stages, lead });
  state.metrics.push(metrics);
  state.cycle += 1;
  state.lastCycleAt = new Date(now()).toISOString();
  if (state.lock) state.lock = { ...state.lock, heartbeatAt: state.lastCycleAt };
  pruneDaemonState(state);
  await effects.persist(state);
  return { actions: performed, metrics, deployment: state.deployment, health };
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
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
  };
}

/**
 * Supervised entry point. The process owns no lease and no credential beyond the coordinator token,
 * so a restart is always safe: it reconciles the cursor against Graphyard and keeps cycling.
 */
export async function runDaemon(config: MasterConfig, state: DaemonState, effects: DaemonEffects, options: { once?: boolean; intervalMs: number; identity: { pid: number; host: string }; signals?: NodeJS.Signals[]; now?: () => number; log?: (line: string) => void } ) {
  // Progress goes to stderr so stdout stays the machine-readable result the CLI prints.
  const now = options.now ?? Date.now, log = options.log ?? (line => console.error(line));
  acquireDaemonLock(state, options.identity, now(), options.intervalMs);
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
      const result = await runCycle(config, state, effects, now);
      cycles.push({ cycle: result.metrics.cycle, actions: result.actions.length, durationMs: result.metrics.durationMs });
      for (const action of result.actions) log(`[graphyard-master] cycle ${result.metrics.cycle} ${action.kind} ${action.state}: ${action.detail}`);
      log(`[graphyard-master] cycle ${result.metrics.cycle} complete in ${result.metrics.durationMs}ms; ${result.metrics.open} open, ${result.actions.length} action(s)`);
      if (options.once || stopping) break;
      try { await delay(options.intervalMs, undefined, { signal: waking.signal }); } catch { /* woken to stop */ }
    } while (!stopping);
  } finally {
    for (const signal of signals) process.off(signal, stop);
    state.lock = null;
    await effects.persist(state).catch(() => {});
  }
  return { cycles, stopped: stopping };
}

/** Effects bound to the real coordinator process. */
export function daemonEffects(root: string, config: MasterConfig, deps: {
  snapshot: () => Promise<{ work: Work[]; now: string }>;
  mutate: (path: string, data: unknown, requestId?: string) => Promise<any>;
  executionOwner: string;
  run?: (command: string, args: string[]) => string;
}): DaemonEffects {
  const run = deps.run ?? ((command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 }));
  return {
    agents: () => { try { return listHerdrAgents(run); } catch { return []; } },
    credentials: profiles => inspectWorkerCredentials(root, profiles),
    snapshot: deps.snapshot,
    closeSession: pane => closeHerdrPane(pane, run),
    dispatch: (work, profile, agents, snapshot) => dispatchWork(root, work, profile, agents, run, snapshot.work, undefined, undefined, undefined, snapshot.now),
    requestProof: work => {
      run('gh', ['workflow', 'run', config.run.proofWorkflow!, '--repo', config.repository, '--ref', config.baseBranch,
        '-f', `pr=${work.submission!.pr}`, '-f', `work_id=${work.id}`, '-f', `policy_revision=${work.policyRevision}`]);
    },
    merge: work => mergeExecutor(config, deps.snapshot, deps.mutate, deps.executionOwner, randomUUID(), run)(work),
    observeDeployment: delivered => observeDeployment(config, delivered, run),
    persist: state => writeDaemonState(config, state),
  };
}
