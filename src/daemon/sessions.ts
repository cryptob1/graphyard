// Concern: launched sessions — orphaned watch supervisors and worker profile health.
import { readFileSync } from 'node:fs';
import type { ChildRun } from '../child-runner.js';
import type { ContainmentScope, Work } from '../model.js';
import { scopePattern, watchAssignment } from '../supervisor.js';
import type { WorkerProfile, HerdrAgent } from '../master.js';
import { type DaemonAction, type DaemonState, message, profileCooldownMs } from './state.js';

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
export async function stopWatchSupervisor(orphan: OrphanSupervisor, signal: NodeJS.Signals, run: ChildRun,
  kill: (pid: number, signal: NodeJS.Signals) => void = process.kill, readCommand: (pid: number) => string = pid => readFileSync(`/proc/${pid}/cmdline`, 'utf8')) {
  if (!scopePattern.test(orphan.scope.unit)) throw new Error(`Recorded containment scope ${orphan.scope.unit} is not a Graphyard watch scope`);
  const refusals: string[] = [];
  let stopped = 0;
  try { await run('systemctl', ['--user', 'kill', '--kill-whom=all', `--signal=${signal}`, orphan.scope.unit]); stopped++; }
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
