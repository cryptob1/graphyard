// Concern: the daemon cursor's persistence, bounds and single-writer lock — reading it, writing it, pruning and bounding it, and the one-loop lock over the repository.
import { randomUUID } from 'node:crypto';
import { readlinkSync } from 'node:fs';
import { readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { type MasterConfig, assertOutsideWorktrees, writeFailure, diskExhaustionMessage, reclaimAdvice } from '../master.js';
import { forwardTolerant } from '../master/profiles.js';
import { boundDetail } from './decisions.js';
import { waitReason } from '../model/action-kinds.js';
import { classified, noteActionOutcome, type FaultKind } from '../model/fault-classes.js';
import { unansweredStands } from '../model/fault-record.js';
import { daemonActionFaultKind, daemonActionSchema, daemonStateSchema, retainedDoctorRuns, type DaemonAction, type DaemonState, type DeploymentObservation } from './state.js';

export const standingTmpKey = 'reclaim:tmp:standing'; // GY-1600: the one row of a run of /tmp passes removing 0 under the standing inode bound
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
export const retainedActions = 500, retainedMetrics = 100, profileCooldownMs = 600_000, maxProofAttempts = 3, retainedScopeDecisions = 200;
export const retainedSamples = 200, retainedClocks = 500, retainedBaseFailures = 200;
/** How many items' dispatch-failure runs (GY-1078) are kept; a run is retired when its item dispatches or is blocked, so this only catches items the loop stopped seeing. */
export const retainedDispatchFailureRuns = 500;
/** Reclamation scans the worktree directory, so it runs on its own bounded interval, not every cycle. */
export const reclaimIntervalMs = 600_000;
export const gigabytes = (bytes: number | null) => bytes === null ? 'an unknown amount of space' : `${(bytes / 1e9).toFixed(1)} GB`;

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
  // GY-2186: the diagnostician's records and the fault instances' item links an older loop kept are
  // dropped, not carried: the loop launches no diagnostician and links no instance any more, and the
  // schema no longer declares the fields, so riding them forward would keep them for ever.
  const { shadow: _shadow, ...stored } = JSON.parse(raw);
  delete (stored as Record<string, unknown>).diagnoses;
  if (stored.faults && typeof stored.faults === 'object') delete (stored.faults as Record<string, unknown>).linked;
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
  // A row holding a standing failing run is that fault's only record (GY-1086): retired oldest, its next refusal
  // opened a new instance — six in a day for one cause — so it is kept while its run stands (endFailingRuns ends it).
  // The standing /tmp pass row (GY-1600) is likewise its run's only count and exists only while the inode bound stands.
  const resolved = entries.filter(([key, action]) => (action.state === 'done' || action.state === 'failed') && !state.faults.failing[key] && key !== standingTmpKey);
  if (resolved.length > retainedActions) {
    for (const [key] of resolved.sort((a, b) => Date.parse(a[1].at) - Date.parse(b[1].at)).slice(0, resolved.length - retainedActions)) delete state.actions[key];
  }
  // A failing run whose action row is retired has ended (GY-173): its reference would otherwise hold its instance forever.
  for (const key of Object.keys(state.faults.failing)) if (!state.actions[key]) delete state.faults.failing[key];
  if (state.metrics.length > retainedMetrics) state.metrics = state.metrics.slice(-retainedMetrics);
  if (state.latency.length > retainedSamples) state.latency = state.latency.slice(-retainedSamples);
  // A clock is dropped when its delivery was sampled; this bound only catches items the loop
  // stopped seeing (a removed item, a renamed repository) so the cursor cannot grow without end.
  const clocks = Object.keys(state.clocks);
  if (clocks.length > retainedClocks) for (const id of clocks.slice(0, clocks.length - retainedClocks)) delete state.clocks[id];
  if (state.scope.length > retainedScopeDecisions) state.scope = state.scope.slice(-retainedScopeDecisions);
  // A watch is retired when its item moves on; this bound only catches items the loop stopped seeing.
  const watches = Object.entries(state.approvals).sort((a, b) => Date.parse(a[1].requestedAt) - Date.parse(b[1].requestedAt));
  if (watches.length > retainedClocks) for (const [key] of watches.slice(0, watches.length - retainedClocks)) delete state.approvals[key];
  // A cleared base failure is retired by its step once its candidates were rerun and refreshed; this bound drops the oldest, cleared first.
  const failures = Object.entries(state.baseFailures).sort((a, b) => Number(!a[1].cleared) - Number(!b[1].cleared) || Date.parse(a[1].raisedAt) - Date.parse(b[1].raisedAt));
  if (failures.length > retainedBaseFailures) for (const [key] of failures.slice(0, failures.length - retainedBaseFailures)) delete state.baseFailures[key];
  // The doctor's runs are kept newest first from the report; the oldest go past the bound, never one still running.
  if (state.doctor.runs.length > retainedDoctorRuns) {
    const settled = state.doctor.runs.filter(entry => entry.state !== 'running');
    const excess = state.doctor.runs.length - retainedDoctorRuns;
    if (settled.length >= excess) {
      const drop = new Set(settled.slice(0, excess).map(entry => entry.at));
      state.doctor.runs = state.doctor.runs.filter(entry => !drop.has(entry.at));
    }
  }
  const runs = Object.entries(state.dispatchFailures).sort((a, b) => Date.parse(a[1].lastAt) - Date.parse(b[1].lastAt));
  if (runs.length > retainedDispatchFailureRuns) for (const [id] of runs.slice(0, runs.length - retainedDispatchFailureRuns)) delete state.dispatchFailures[id];
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
 * Every write of an action goes through here (GY-173): a failed or indeterminate action carries
 * the class of its fault kind, anything else carries none, and the outcome is noted against the
 * fault record — a failure opening one instance per run of failures, a success ending the run.
 * A null fault kind is an outcome that is no fault (a guarded merge the gate refused): it is
 * stored for retry like any failure but carries no class and is never noted as an instance.
 * The detail is bounded here, before the schema sees it, so a caller that quotes a long error or
 * path list cannot fail every cycle with an over-long string (GY-179).
 */
export function storeAction(state: DaemonState, key: string, action: Omit<DaemonAction, 'faultClass'> & { faultClass?: unknown }, faultKind: FaultKind | null = daemonActionFaultKind(action.kind)): DaemonAction {
  const { faultClass: _, ...rest } = action;
  const failed = faultKind !== null && (rest.state === 'failed' || rest.state === 'indeterminate');
  const fault = faultKind === null || unansweredStands(state.faults, key) || (faultKind.startsWith('action:') && waitReason(rest.detail)) ? null : classified(faultKind);
  const entry = daemonActionSchema.parse({ ...rest, detail: boundDetail(rest.detail), attempts: clampCount(rest.attempts, 1000), ...(failed && fault ? { faultClass: fault.faultClass } : {}) });
  if (fault) { dispatchRun(state.faults.failing, key, entry.state); noteActionOutcome(state.faults, key, entry.state, { ...fault, subject: entry.work ?? key, text: entry.detail }, entry.at); }
  state.actions[key] = entry;
  return entry;
}
/**
 * GY-1287: an item's dispatch row is keyed by the epoch it was offered at (`dispatch:ID:EPOCH`), and
 * a launch that fails after its claim advances that epoch, so the item's next dispatch writes a new
 * row. Its failures are still one run of one fault: a failure carries the item's failing run from
 * the earlier row onto this one, and a success ends the run whichever row opened it. On 5 October
 * 2026 GY-717's lapsed launch and the retry that met the control plane restarting counted as two.
 */
function dispatchRun(failing: Record<string, string>, key: string, outcome: DaemonAction['state']) {
  const item = /^dispatch:([^:]+):\d+$/.exec(key)?.[1];
  if (!item) return;
  const earlier = Object.keys(failing).filter(other => other !== key && other.startsWith(`dispatch:${item}:`));
  if (outcome === 'done') for (const other of earlier) delete failing[other];
  else if ((outcome === 'failed' || outcome === 'indeterminate') && !failing[key] && earlier.length) { failing[key] = failing[earlier.at(-1)!]; for (const other of earlier) delete failing[other]; }
}
/**
 * A refusal that still stands, observed again with the same detail (GY-1086): its row is not
 * rewritten — the run it opened is the one fault — but its time moves, so neither the cursor
 * bound nor the recurrence window takes it for a run that has ended and opens it again.
 */
export function touchStanding(state: DaemonState, key: string, at: string) {
  const row = state.actions[key];
  if (row && row.state === 'failed') row.at = at;
}
/** The action key a recurring class's filing is recorded under. */
export const faultActionKey = (faultClass: string) => `fault:${faultClass}`;
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
    if (state.upgrade.last) state.upgrade.last = { ...state.upgrade.last, from: cut(state.upgrade.last.from, 40), to: cut(state.upgrade.last.to, 40), executors: cut(state.upgrade.last.executors, 300) };
    if (state.upgrade.snapshot) state.upgrade.snapshot = { ...state.upgrade.snapshot, commit: cut(state.upgrade.snapshot.commit, 40), checkout: cut(state.upgrade.snapshot.checkout, 40), dirty: state.upgrade.snapshot.dirty.slice(0, 20).map(path => cut(path, 300)) };
  }
  if (state.config) state.config = { ...state.config, changed: state.config.changed.slice(0, 100).map(entry => cut(entry, 100)), refused: cut(state.config.refused, 1000) };
  if (state.reclaim) state.reclaim.errors = state.reclaim.errors.slice(0, 20).map(entry => cut(entry, 500));
  for (const clock of Object.values(state.clocks)) clock.key = cut(clock.key, 40);
  for (const sample of state.latency) sample.work = cut(sample.work, 40);
  for (const entry of state.scope) entry.work = cut(entry.work, 200);
  for (const orphan of Object.values(state.orphans)) Object.assign(orphan, { owner: cut(orphan.owner, 200), unit: cut(orphan.unit, 200) });
  for (const watch of Object.values(state.approvals)) {
    Object.assign(watch, { work: cut(watch.work, 40), action: cut(watch.action, 40), decision: cut(watch.decision, 100), agentName: cut(watch.agentName, 200), pane: cut(watch.pane, 200) });
    watch.ended = watch.ended.slice(-10).map(entry => cut(entry, 300));
  }
  for (const absence of Object.values(state.absences)) absence.owner = cut(absence.owner, 200);
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
    state.projectMemory.decisions = (state.projectMemory.decisions ?? []).slice(0, 50);
    state.projectMemory.pitfalls = (state.projectMemory.pitfalls ?? []).slice(0, 50);
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
