import { readdirSync } from 'node:fs';
import type { RuntimeSession } from '../model/sessions.js';
// Concern: launched sessions — worker profile health, launch back-off and runtime canaries.
import type { Work } from '../model.js';
import type { CoordinationRounds } from '../server/work-view.js';
import { newestVersion, pinnedInstall, versionEntry, versionName, type AgentRegistry, type CanaryOffer, type FleetRuntime } from '../model/registry.js';
import { resumeExitWindowMs } from '../master/session-resume.js';
import { agentAssignment, finishedAgentStates, reclaimableAgent } from '../master/dispatch-reservation.js';
import { type WorkerProfile } from '../master/profiles.js';
import type { DaemonAction, DaemonState } from './state.js';

export interface ProfileHealth { profile: WorkerProfile; healthy: boolean; busy: boolean; reason: string | null }
/**
 * A profile is dispatchable only when its credential still authenticates its principal, its agent
 * name is free in Herdr. Everything else routes around it. A failed launch backs off its runtime for
 * its item (launchBackoff), not the profile.
 * A profile that is merely working is `busy`: that is capacity, not something to escalate.
 *
 * GY-1322: a name held by a finished session (idle or done) that no live assignment in `work` owns
 * is free — the dispatch bounded-closes that session and launches as on a profile with no agent —
 * so a fleet that just drained dispatches. A finished session a live lease still owns is `busy`,
 * and its reason names the agent's state, the lease and the remedy.
 */
export function profileHealth(profiles: WorkerProfile[], credentials: Record<string, { available: boolean; reason: string | null }>, agents: RuntimeSession[], state: DaemonState, now: number, work: readonly Work[] = []): ProfileHealth[] {
  return profiles.map(profile => {
    const credential = credentials[profile.name] ?? { available: true, reason: null };
    const found = agents.find(candidate => candidate.name === profile.agentName);
    const agent = reclaimableAgent(profile, found, work, now) ? undefined : found;
    const busy = profile.mode === 'launch' && credential.available && !!agent;
    const reason = profile.mode !== 'launch' ? 'Existing sessions are observed only; Graphyard will not inject new work into an unsupervised process'
      : !credential.available ? credential.reason ?? 'Worker credential is unavailable'
        : agent ? agentReason(profile, agent, work, now) : null;
    return { profile, healthy: !reason, busy, reason };
  });
}
/** Why an agent holding a launch profile's name keeps it from dispatch, with the remedy when the agent is finished. No parentheses: refusals list each reason inside them. */
function agentReason(profile: WorkerProfile, agent: RuntimeSession, work: readonly Work[], now: number) {
  const status = agent.agent_status ?? 'present';
  if (!finishedAgentStates.includes(status)) return `Herdr agent ${profile.agentName} is ${status}`;
  const owner = agentAssignment(profile, agent, work, now);
  if (owner) return `Herdr agent ${profile.agentName} is ${status} under ${owner.key}'s live lease; remedy: bounded close or relaunch once that lease ends${agent.pane_id ? `, or herdr pane close ${agent.pane_id} on the host` : ''}`;
  return `Herdr agent ${profile.agentName} is ${status} with no pane to close; remedy: relaunch the session or restart Herdr on the host`;
}

/** Retry a refused action on a widening cycle interval rather than on every pass. */
export function readyToRetry(previous: DaemonAction | undefined, cycle: number, maxBackoffCycles = 30) {
  if (!previous) return true;
  // A waiting action is an outcome still being reconciled (GY-195): it is asked again every cycle.
  if (previous.state === 'waiting') return true;
  if (previous.state !== 'failed') return false;
  return cycle - previous.cycle >= Math.min(2 ** Math.max(0, previous.attempts - 1), maxBackoffCycles);
}

/**
 * GY-3103: a worker launch failure backs off its runtime for that item — 1 minute, doubling with
 * each further failure to at most 30 minutes — however many profiles or accounts run the runtime.
 * A failure that names no runtime (it failed before one was chosen) backs off the item on every
 * runtime. A launch of the runtime that does useful work (it outlives the failed-launch window,
 * commits or submits) clears every back-off of that runtime.
 */
export const launchBackoffMs = (failures: number) => Math.min(60_000 * 2 ** Math.max(0, failures - 1), 1_800_000);
export const anyRuntime = 'any';
const backoffKey = (runtime: string, item: Pick<Work, 'id'>) => `${runtime}:${item.id}`;
export function recordLaunchFailure(state: DaemonState, runtime: string | null, item: Pick<Work, 'id'>, reason: string, now: number) {
  const key = backoffKey(runtime ?? anyRuntime, item), failures = (state.launchBackoff[key]?.failures ?? 0) + 1;
  state.launchBackoff[key] = { failures, reason: reason.slice(0, 500), until: new Date(now + launchBackoffMs(failures)).toISOString() };
}
export function clearLaunchFailures(state: DaemonState, runtime: string) {
  for (const key of Object.keys(state.launchBackoff)) if (key.startsWith(`${runtime}:`) || key.startsWith(`${anyRuntime}:`)) delete state.launchBackoff[key];
}
/** The back-off holding `runtime` off `item`, or null when it may launch. */
export function launchBackoff(state: DaemonState, runtime: string, item: Pick<Work, 'id'>, now: number) {
  const live = (key: string) => { const entry = state.launchBackoff[key]; return entry && Date.parse(entry.until) > now ? entry : null; };
  return live(backoffKey(runtime, item)) ?? live(backoffKey(anyRuntime, item));
}
/**
 * The worker accounts whose runtime backs off `item`, which its launch excludes from selection, and
 * whether that is every worker account — then the item waits. Without the registry, the profile's
 * own runtime decides.
 */
export function backedOffAccounts(state: DaemonState, registry: Pick<AgentRegistry, 'runtimes' | 'accounts' | 'roles'> | null, profile: WorkerProfile, item: Pick<Work, 'id'>, now: number) {
  if (!registry?.accounts.length) return { exclude: [], all: !!launchBackoff(state, profile.kind ?? profile.mode, item, now) };
  const kind = (runtime: string) => registry.runtimes.find(entry => entry.name === runtime)?.launch.kind ?? runtime;
  const workers = registry.roles.find(role => role.name === 'worker')?.accounts ?? registry.accounts.map(account => account.name);
  const exclude = workers.filter(name => { const account = registry.accounts.find(entry => entry.name === name); return !!account && !!launchBackoff(state, kind(account.runtime), item, now); });
  return { exclude, all: exclude.length > 0 && exclude.length === workers.length };
}

/** The version directories installed under `root`. */
export function installedVersions(root: string): string[] {
  try { return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && versionName.test(entry.name)).map(entry => entry.name); }
  catch { return []; }
}
/**
 * GY-3103: the newer version of a registry runtime one canary session runs on: the newest version
 * installed beside the pinned one, when it is not the pinned one — a pinned directory that no
 * longer exists makes the newest the canary as well. Null when the runtime's PATH is not led by a
 * versioned install or the pinned version is the newest.
 */
export function canaryOffer(runtime: FleetRuntime, versions: (root: string) => string[] = installedVersions): CanaryOffer | null {
  const pin = pinnedInstall(runtime);
  const newest = pin && newestVersion(versions(pin.root));
  return pin && newest && newest !== pin.version ? { runtime: runtime.name, entry: versionEntry(pin, newest), version: newest } : null;
}
/**
 * Whether the canary session `item` epoch `epoch` proved its version (the docs/master-agent.md
 * failed-launch rule): it submitted, committed, or ran longer than 60 s after its runtime started.
 * A session that ended sooner failed; null while it is still inside the window.
 */
export function canaryVerdict(item: Work, epoch: number, now: number): { passed: true; why: string } | { passed: false; why: string } | null {
  if (item.submission?.epoch === epoch) return { passed: true, why: 'submitted' };
  const session = (item.sessions ?? []).find(handle => handle.kind === 'implementation' && (handle.epoch ?? Number(/:(\d+)$/.exec(handle.id)?.[1])) === epoch);
  if (!session) return null;
  if (session.initialHead && session.workTree?.head && session.workTree.head !== session.initialHead) return { passed: true, why: 'committed' };
  const end = (item as Work & CoordinationRounds).attemptEnd ?? item.pipeline?.attempts.find(entry => entry.epoch === epoch);
  const attempt = end?.epoch === epoch ? end as { endedAt?: string | null; cause?: string } : null;
  const endedAt = attempt?.endedAt ?? (session.state !== 'running' ? session.endedAt ?? null : null);
  const age = (endedAt ? Date.parse(endedAt) : now) - Date.parse(session.runtimeStartedAt ?? session.startedAt);
  if (age >= resumeExitWindowMs) return { passed: true, why: `ran ${Math.round(age / 1000)} s` };
  return endedAt ? { passed: false, why: (attempt?.cause ?? session.outcome ?? 'the session ended').slice(0, 400) } : null;
}
