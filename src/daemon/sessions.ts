// Concern: launched sessions — worker profile health.
import type { Work } from '../model.js';
import { agentAssignment, finishedAgentStates, reclaimableAgent, type WorkerProfile, type HerdrAgent } from '../master.js';
import { type DaemonAction, type DaemonState, message, profileCooldownMs } from './state.js';

export interface ProfileHealth { profile: WorkerProfile; healthy: boolean; busy: boolean; reason: string | null }
/**
 * A profile is dispatchable only when its credential still authenticates its principal, its agent
 * name is free in Herdr, and it is not inside a failure cool-off. Everything else routes around it.
 * A profile that is merely working is `busy`: that is capacity, not something to escalate.
 *
 * GY-1322: a name held by a finished session (idle or done) that no live assignment in `work` owns
 * is free — the dispatch bounded-closes that session and launches as on a profile with no agent —
 * so a fleet that just drained dispatches. A finished session a live lease still owns is `busy`,
 * and its reason names the agent's state, the lease and the remedy.
 */
export function profileHealth(profiles: WorkerProfile[], credentials: Record<string, { available: boolean; reason: string | null }>, agents: HerdrAgent[], state: DaemonState, now: number, work: readonly Work[] = []): ProfileHealth[] {
  return profiles.map(profile => {
    const credential = credentials[profile.name] ?? { available: true, reason: null };
    const found = agents.find(candidate => candidate.name === profile.agentName);
    const agent = reclaimableAgent(profile, found, work, now) ? undefined : found;
    const cooldown = state.profiles[profile.name]?.cooldownUntil;
    const busy = profile.mode === 'launch' && credential.available && !!agent;
    const reason = profile.mode !== 'launch' ? 'Existing sessions are observed only; Graphyard will not inject new work into an unsupervised process'
      : !credential.available ? credential.reason ?? 'Worker credential is unavailable'
        : agent ? agentReason(profile, agent, work, now)
          : cooldown && Date.parse(cooldown) > now ? `Cooling off after a failed launch until ${cooldown}: ${state.profiles[profile.name]?.reason ?? 'launch failed'}`
            : null;
    return { profile, healthy: !reason, busy, reason };
  });
}
/** Why an agent holding a launch profile's name keeps it from dispatch, with the remedy when the agent is finished. No parentheses: refusals list each reason inside them. */
function agentReason(profile: WorkerProfile, agent: HerdrAgent, work: readonly Work[], now: number) {
  const status = agent.agent_status ?? 'present';
  if (!finishedAgentStates.includes(status)) return `Herdr agent ${profile.agentName} is ${status}`;
  const owner = agentAssignment(profile, agent, work, now);
  if (owner) return `Herdr agent ${profile.agentName} is ${status} under ${owner.key}'s live lease; remedy: bounded close or relaunch once that lease ends${agent.pane_id ? `, or herdr pane close ${agent.pane_id} on the host` : ''}`;
  return `Herdr agent ${profile.agentName} is ${status} with no pane to close; remedy: relaunch the session or restart Herdr on the host`;
}

/**
 * GY-1708: whether a profile's agent still consumes the role's machine bound. A finished agent no
 * live lease owns is reclaimable, so the mid-attempt exhaustion redispatch may take the name; an
 * agent that still owns a live lease (or is not finished) blocks a second session of the same role.
 */
export function occupiesRoleBound(profile: WorkerProfile, agent: HerdrAgent | undefined, work: readonly Work[], now: number): boolean {
  if (!agent) return false;
  return !reclaimableAgent(profile, agent, work, now);
}

/** Retry a refused action on a widening cycle interval rather than on every pass. */
export function readyToRetry(previous: DaemonAction | undefined, cycle: number, maxBackoffCycles = 30) {
  if (!previous) return true;
  // A waiting action is an outcome still being reconciled (GY-195): it is asked again every cycle.
  if (previous.state === 'waiting') return true;
  if (previous.state !== 'failed') return false;
  return cycle - previous.cycle >= Math.min(2 ** Math.max(0, previous.attempts - 1), maxBackoffCycles);
}

export function recordProfileFailure(state: DaemonState, profile: WorkerProfile, reason: string, now: number) {
  const previous = state.profiles[profile.name] ?? { failures: 0, reason: null, cooldownUntil: null };
  state.profiles[profile.name] = { failures: previous.failures + 1, reason: reason.slice(0, 500), cooldownUntil: new Date(now + profileCooldownMs).toISOString() };
}
export function clearProfileFailure(state: DaemonState, profile: WorkerProfile) { delete state.profiles[profile.name]; }
