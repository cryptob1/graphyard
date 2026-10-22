// Concern: the daemon cursor's persistence, bounds and single-writer lock — reading it, writing it, pruning and bounding it, and the one-loop lock over the repository.
import { randomUUID } from 'node:crypto';
import { readlinkSync } from 'node:fs';
import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { type MasterConfig, assertOutsideWorktrees, writeFailure, diskExhaustionMessage, reclaimAdvice } from '../master.js';
import { forwardTolerant } from '../master/profiles.js';
import { boundDetail } from './text.js';
import { daemonActionSchema, daemonStateSchema, type DaemonAction, type DaemonState, type DeploymentObservation } from './state.js';

/**
 * The cursor schema as GY-1960 reads and writes it: declared fields strict, unknown fields kept.
 * Built on first use, never at module scope: state.ts and this module import each other, so the
 * schema it wraps does not exist while this file's body runs.
 */
let tolerated: typeof daemonStateSchema | undefined;
const toleratedStateSchema = () => tolerated ??= forwardTolerant(daemonStateSchema);
/**
 * GY-1960: a cursor record the loop rewrites from what it declares (its release, its latest
 * reload) keeps the fields a newer loop wrote under it. `next` sets every declared field, so only
 * the undeclared ones of `previous` survive under it; a null `next` clears the record as before.
 */
export const carryUndeclared = <T extends object | null>(previous: object | null | undefined, next: T): T => previous && next ? { ...previous, ...next } : next;
export const retainedActions = 500, retainedMetrics = 100, profileCooldownMs = 600_000, maxProofAttempts = 3;
export const retainedBaseFailures = 200;

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
  // GY-1960: the cursor is forward-tolerant. A cursor a newer loop wrote carries fields this
  // version does not declare; they parse, ride every write, and are written back unchanged, so a
  // rollback or a held-CLI snapshot neither fails nor silently drops what the newer loop recorded.
  // Declared fields are still validated: a malformed one refuses the read as before.
  // GY-2087: the shadow gate's verdicts an older loop kept are dropped, not carried.
  // GY-2186, GY-2873: records of retired machinery an older loop kept are dropped, not carried, so
  // they do not ride forward for ever.
  const { shadow: _shadow, diagnoses: _diagnoses, faults: _faults, doctor: _doctor, dispatchFailures: _dispatchFailures, stepStalls: _stepStalls, ...stored } = JSON.parse(raw);
  for (const action of Object.values<Record<string, unknown>>(stored.actions ?? {})) delete action.faultClass;
  const state = toleratedStateSchema().parse(stored);
  if (state.url !== config.url || state.repository.toLowerCase() !== config.repository.toLowerCase()) throw new Error('Master daemon state belongs to another Graphyard server or repository; remove it before running the loop');
  return state;
}

export async function writeDaemonState(config: MasterConfig, state: DaemonState) {
  const file = daemonStatePath(config), temporary = `${file}.${randomUUID()}.tmp`;
  // The cursor is written twice per external action, so it is usually the first thing a full
  // volume stops. Saying so is the difference between a disk to reclaim and a mystery.
  try {
    await writeFile(temporary, JSON.stringify(toleratedStateSchema().parse(boundDaemonState(state)), null, 2), { mode: 0o600, flag: 'wx' });
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
  // Retired fields a cursor written before GY-2874 still carries are dropped on its next write.
  delete state.orphans; delete state.approvals; delete state.absences; delete state.decisionsDeferred;
  // And those GY-2876 retired: the reclaim, memory, latency and cycle-duration readings.
  delete state.reclaim; delete state.memory; delete state.clocks; delete state.latency;
  for (const metric of state.metrics) for (const field of ['durationMs', 'childWaitMs', 'workMs', 'planeWaitMs', 'steps', 'timings', 'stages', 'lead', 'production', 'postDeploy', 'postDeployFailures', 'idleMs', 'scope', 'scopeOpenMs'] as const) delete metric[field];
  // A cleared base failure is retired by its step once its candidates were rerun and refreshed; this bound drops the oldest, cleared first.
  const failures = Object.entries(state.baseFailures).sort((a, b) => Number(!a[1].cleared) - Number(!b[1].cleared) || Date.parse(a[1].raisedAt) - Date.parse(b[1].raisedAt));
  if (failures.length > retainedBaseFailures) for (const [key] of failures.slice(0, failures.length - retainedBaseFailures)) delete state.baseFailures[key];
  return state;
}

/**
 * Fit every bounded field of the cursor to its schema bound, in place (GY-187). The schema is the
 * cursor's contract, and parsing it is the last step of every write — so a value over its bound
 * (a delivered list longer than 200, a refusal quoted in full, an attempt counter past 1000) used
 * to fail that write, and with it the whole cycle, on every cycle until somebody edited the file.
 * Truncation loses the tail of a long string or the oldest entries of a long list; failing the
 * write loses the cycle. Counts are clamped, never reset, so a backoff keeps its place.
 */
export const clampCount = (value: number, max: number) => Math.min(max, Math.max(0, Math.floor(Number.isFinite(value) ? value : 0)));

/**
 * Every write of an action goes through here. The detail is bounded here, before the schema sees
 * it, so a caller that quotes a long error or path list cannot fail every cycle with an over-long
 * string (GY-179).
 */
export function storeAction(state: DaemonState, key: string, action: DaemonAction): DaemonAction {
  const entry = daemonActionSchema.parse({ ...action, detail: boundDetail(action.detail), attempts: clampCount(action.attempts, 1000) });
  state.actions[key] = entry;
  return entry;
}
/** A refusal that still stands, observed again with the same detail (GY-1086): its row is not rewritten, but its time moves. */
export function touchStanding(state: DaemonState, key: string, at: string) {
  const row = state.actions[key];
  if (row && row.state === 'failed') row.at = at;
}
const cut = <T extends string | null | undefined>(value: T, max: number): T => (typeof value === 'string' && value.length > max ? boundDetail(value, max) : value) as T;
export function boundDaemonState(state: DaemonState): DaemonState {
  for (const action of Object.values(state.actions)) {
    action.detail = boundDetail(action.detail);
    action.attempts = clampCount(action.attempts, 1000);
  }
  for (const profile of Object.values(state.profiles)) profile.reason = cut(profile.reason, 500);
  if (state.deployment) state.deployment = boundDeployment(state.deployment);
  if (state.upgrade) {
    state.upgrade.refused = state.upgrade.refused ? { ...state.upgrade.refused, reason: cut(state.upgrade.refused.reason, 500) } : null;
    if (state.upgrade.pending) state.upgrade.pending = { ...state.upgrade.pending, from: cut(state.upgrade.pending.from, 40), to: cut(state.upgrade.pending.to, 40) };
    if (state.upgrade.stalled) state.upgrade.stalled = { ...state.upgrade.stalled, reason: cut(state.upgrade.stalled.reason, 500) };
    if (state.upgrade.last) state.upgrade.last = { ...state.upgrade.last, from: cut(state.upgrade.last.from, 40), to: cut(state.upgrade.last.to, 40) };
    if (state.upgrade.snapshot) state.upgrade.snapshot = { ...state.upgrade.snapshot, commit: cut(state.upgrade.snapshot.commit, 40), checkout: cut(state.upgrade.snapshot.checkout, 40), dirty: state.upgrade.snapshot.dirty.slice(0, 20).map(path => cut(path, 300)) };
  }
  if (state.config) state.config = { ...state.config, changed: state.config.changed.slice(0, 100).map(entry => cut(entry, 100)), refused: cut(state.config.refused, 1000) };
  if (state.master) {
    state.master.agentName = cut(state.master.agentName, 200);
    state.master.pane = cut(state.master.pane, 200);
    state.master.account = cut(state.master.account, 200);
    state.master.session = cut(state.master.session, 200);
    if (state.master.lastEnd) state.master.lastEnd = { ...state.master.lastEnd, cause: cut(state.master.lastEnd.cause, 40), detail: cut(state.master.lastEnd.detail, 500) };
    if (state.master.lastWake) state.master.lastWake = { ...state.master.lastWake, causes: state.master.lastWake.causes.slice(-20).map(cause => cut(cause, 60)) };
    state.master.unreleased = state.master.unreleased.slice(-20).map(entry => ({ ...entry, session: cut(entry.session, 200), reason: cut(entry.reason, 300) }));
  }
  const failures = state.failures;
  if (failures.last) Object.assign(failures.last, { call: cut(failures.last.call, 100), reason: cut(failures.last.reason, 1000) });
  if (failures.lastUnhandled) failures.lastUnhandled.reason = cut(failures.lastUnhandled.reason, 1000);
  if (state.projectMemory) {
    state.projectMemory.notes = (state.projectMemory.notes ?? []).slice(0, 50);
    state.projectMemory.changes = (state.projectMemory.changes ?? []).slice(0, 50);
  }
  return state;
}
/** A deployment observation within its schema: 200 deliveries a side (the newest kept) and a 500-character reason. */
export function boundDeployment<T extends Pick<DeploymentObservation, 'reason' | 'deployed' | 'pending'>>(observation: T): T {
  return { ...observation, reason: cut(observation.reason ?? null, 500), deployed: (observation.deployed ?? []).slice(-200), pending: (observation.pending ?? []).slice(-200) };
}

/**
 * This process's PID namespace (`pid:[4026531836]`), or null where /proc does not say (not Linux).
 * A pid means something only in the namespace it was taken in (GY-1370): a sandbox with its own
 * PID namespace sees none of the host's processes, so its probe of a host pid always reads gone.
 */
export const pidNamespace = () => { try { return readlinkSync('/proc/self/ns/pid'); } catch { return null; } };
/** The host's initial PID namespace (the kernel's PROC_PID_INIT_INO), which a lock written before GY-1370 was taken in. */
export const initialPidNamespace = 'pid:[4026531836]';
export const liveProcess = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; } };

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
  state.lock = { id: randomUUID(), pid: identity.pid, host: identity.host, startedAt: new Date(now).toISOString(), heartbeatAt: new Date(now).toISOString(), pidNamespace: pidNamespace() };
  return state.lock;
}

/**
 * Every failure the cycle records passes through here. A command that failed because the host
 * ran out of room keeps its own output and gains the name of the condition, so the action reads
 * as a disk to reclaim rather than as an unexplained command error.
 */
export const message = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error), exhausted = diskExhaustionMessage(error);
  // An error already reported as disk exhaustion is not explained twice.
  return exhausted && !text.includes(reclaimAdvice) ? `${text} — ${exhausted}` : text;
};
