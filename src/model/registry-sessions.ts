import type { Work } from './work.js';
import { fleetRoles, rolePolicy } from './registry.js';
import type { AgentRegistry, FleetAccount, FleetModel, FleetRefusal, FleetRoleName, FleetRuntime, FleetSession, ObservedQuota, RolePolicy, SelectionRequest, SessionSkip } from './registry.js';

/**
 * Which sessions of the agent registry are live, which accounts may take another, the choice an
 * action runs on, and the view status and the dashboard show. Everything here is pure over the
 * registry document; src/agent-registry.ts runs it inside the coordination transaction.
 */
export const sessionHistoryLimit = 100, refusalHistoryLimit = 20;
export const launchGraceMs = 5 * 60_000, reviewSessionMs = 2 * 3_600_000, producerSessionMs = 24 * 3_600_000, decisionSessionMs = 30 * 60_000, sessionCapMs = 48 * 3_600_000;
type SessionWork = Pick<Work, 'key' | 'lease' | 'autoDispatch' | 'stage'>;
/**
 * Whether a recorded session still occupies its account, and why not when it does not. Nothing
 * reports a session's end: the control plane already knows what each one was launched for, so a
 * worker session lives as long as its item's lease, a reviewer or producer session as long as the
 * request it answers stands, and a decision session for a bounded time. Every session is live
 * through a launch grace, because the claim or the request follows the choice.
 */
export function sessionEnded(session: FleetSession, work: SessionWork | undefined, now: number): string | null {
  if (session.endedAt) return session.endReason ?? 'ended';
  const age = now - Date.parse(session.selectedAt);
  if (age < launchGraceMs) return null;
  if (age > sessionCapMs) return 'older than any session runs';
  if (session.role === 'approver' || session.role === 'escalation-handler') return age > decisionSessionMs ? 'the decision window passed' : null;
  if (!work) return session.work ? `${session.work} is no longer an open work item` : 'the launch grace passed and the session names no work item';
  if (session.role === 'worker') {
    const lease = work.lease;
    if (!lease || Date.parse(lease.expiresAt) <= now) return `${work.key} holds no live lease`;
    return session.principal && lease.owner !== session.principal ? `${work.key} is leased to ${lease.owner}` : null;
  }
  if (session.role === 'reviewer') return work.autoDispatch?.review?.state === 'requested' && age <= reviewSessionMs ? null : `${work.key} has no standing review request`;
  return (work.autoDispatch?.producers ?? []).some(request => request.state === 'requested') && age <= producerSessionMs ? null : `${work.key} has no standing producer request`;
}

/** Close every session whose reason to exist has gone; returns the ones it closed. */
export function settleSessions(registry: AgentRegistry, work: readonly SessionWork[], at: string) {
  const now = Date.parse(at), byKey = new Map(work.map(item => [item.key, item])), closed: FleetSession[] = [];
  // A relaunch for the same work supersedes the session it replaces: a reviewer request is answered
  // by one session, a worker lease held by one, and a producer request group by one each.
  const open = registry.sessions.filter(session => !session.endedAt);
  for (const session of open) {
    let ended = sessionEnded(session, session.work ? byKey.get(session.work) : undefined, now);
    if (!ended && session.work && session.role !== 'producer') {
      const newer = open.find(other => other !== session && other.role === session.role && other.work === session.work && Date.parse(other.selectedAt) > Date.parse(session.selectedAt));
      if (newer) ended = `superseded by the ${newer.account} session launched for ${session.work}`;
    }
    if (!ended && session.work && session.role === 'producer') {
      const standing = (byKey.get(session.work)?.autoDispatch?.producers ?? []).filter(request => request.state === 'requested').length;
      const newer = open.filter(other => other.role === 'producer' && other.work === session.work && Date.parse(other.selectedAt) > Date.parse(session.selectedAt)).length;
      if (standing > 0 && newer >= standing) ended = `superseded by newer producer sessions for ${session.work}`;
    }
    if (ended) { session.endedAt = at; session.endReason = ended; closed.push(session); }
  }
  const live = registry.sessions.filter(session => !session.endedAt), ended = registry.sessions.filter(session => session.endedAt);
  registry.sessions = [...ended.slice(-Math.max(0, sessionHistoryLimit - live.length)), ...live].sort((a, b) => Date.parse(a.selectedAt) - Date.parse(b.selectedAt));
  return closed;
}
export const liveSessions = (registry: Pick<AgentRegistry, 'sessions'>) => registry.sessions.filter(session => !session.endedAt);

/**
 * The live sessions an incoming request replaces, before anything about limits is counted: one
 * session answers one review request, one holds one worker lease, one answers one producer proof
 * group. A relaunch for the same work is that same slot again, so a session whose launch failed,
 * whose runtime died, or whose head has been superseded must never refuse its own successor —
 * at a concurrency of 1 that deadlocks the role until the session's outer cap (two hours for a
 * reviewer, a day for a producer). `settleSessions` cannot see this, because it only ends a
 * session once a *newer* one exists, and at the limit the newer one is never created.
 *
 * A producer is superseded only within its own proof group, so the integration and manual groups
 * of one item still run side by side; a producer request that names no group supersedes nothing.
 */
export function supersededByRequest(registry: Pick<AgentRegistry, 'sessions'>, request: Pick<SelectionRequest, 'role' | 'work' | 'group'>): FleetSession[] {
  if (!request.work) return [];
  return liveSessions(registry).filter(session => session.role === request.role && session.work === request.work
    && (request.role !== 'producer' || (!!request.group && (session.group ?? null) === request.group)));
}

const until = (iso: string | null) => iso ? ` until ${iso}` : '';
/**
 * Why an account cannot take a session right now, whatever role asks — null when it can. `host`
 * is the executor asking: an account is placed where its login lives, so every other host is
 * refused it. Without a host the placement is not judged (a report has no single asking host).
 */
export function accountIneligibility(registry: AgentRegistry, account: FleetAccount, now: number, host?: string | null): string | null {
  if (!account.enabled) return `${account.name} is disabled`;
  if (!registry.runtimes.some(runtime => runtime.name === account.runtime)) return `${account.name} runs ${account.runtime}, which is not a registered runtime`;
  if (!registry.models.some(model => model.name === account.model)) return `${account.name} runs ${account.model}, which is not a registered model`;
  if (host && account.credential.host !== host) return `${account.name} is placed on ${account.credential.host}; this executor is ${host}`;
  if (account.quota.loggedIn === false) return `${account.name} is not logged in`;
  if (account.quota.state === 'exhausted' && (!account.quota.resetsAt || Date.parse(account.quota.resetsAt) > now)) return `${account.name} quota is exhausted${until(account.quota.resetsAt)}${account.quota.reason ? ` (${account.quota.reason})` : ''}`;
  const running = liveSessions(registry).filter(session => session.account === account.name).length;
  if (account.maxSessions !== null && running >= account.maxSessions) return `${account.name} is at its session limit (${running} of ${account.maxSessions} live)`;
  return null;
}

export interface SessionChoice { account: FleetAccount; runtime: FleetRuntime; model: FleetModel; policy: RolePolicy; reason: string; skipped: SessionSkip[] }
export interface SessionRefusal { account: null; reason: string; skipped: SessionSkip[] }
/**
 * The session an action runs on: the first account of the role, in the role's own order, that is
 * placed on the asking host, logged in, within quota and under its session limit, provided the
 * role itself is under its concurrency limit. Pure: the registry passed in already carries the
 * executor's fresh observations and only sessions that are still live.
 */
export function chooseSession(registry: AgentRegistry, request: Pick<SelectionRequest, 'role' | 'host'>, now: number): SessionChoice | SessionRefusal {
  const role = registry.roles.find(entry => entry.name === request.role);
  if (!role) return { account: null, reason: `role ${request.role} is not configured in the agent registry`, skipped: [] };
  if (!role.accounts.length) return { account: null, reason: `role ${request.role} names no account`, skipped: [] };
  const running = liveSessions(registry).filter(session => session.role === role.name);
  if (running.length >= role.concurrency) return { account: null, skipped: [],
    reason: role.concurrency === 0 ? `role ${role.name} is paused (concurrency 0)` : `role ${role.name} is at its concurrency limit (${running.length} of ${role.concurrency} live: ${running.map(session => `${session.account}${session.work ? ` on ${session.work}` : ''}`).join(', ')})` };
  const skipped: SessionSkip[] = [];
  for (const [index, name] of role.accounts.entries()) {
    const account = registry.accounts.find(entry => entry.name === name);
    const refusal = account ? accountIneligibility(registry, account, now, request.host) : `${name} is not a registered account`;
    if (refusal) { skipped.push({ account: name, reason: refusal }); continue; }
    // The role's policy names the model its sessions run, where it names one; else the account's own.
    const policy = rolePolicy(role), runtime = registry.runtimes.find(entry => entry.name === account!.runtime)!;
    const model = registry.models.find(entry => entry.name === (policy.model ?? account!.model)) ?? registry.models.find(entry => entry.name === account!.model)!;
    return { account: account!, runtime, model, policy, skipped,
      reason: `${name} is the first eligible account for ${role.name} (preference ${index + 1} of ${role.accounts.length}; ${running.length + 1} of ${role.concurrency} concurrent)${skipped.length ? ` — passed over ${skipped.map(entry => entry.reason).join('; ')}` : ''}` };
  }
  return { account: null, skipped, reason: `no eligible account for ${role.name}: ${skipped.map(entry => entry.reason).join('; ')}` };
}

export interface FleetAccountView {
  name: string; runtime: string; model: string; modelId: string | null; cost: FleetModel['cost'] | null; capability: FleetModel['capability'] | null;
  host: string; home: string | null; enabled: boolean; maxSessions: number | null; note: string | null;
  /** Every role that names the account, with its place in that role's order. */
  roles: { role: FleetRoleName; preference: number; of: number }[];
  liveSessions: { id: string; role: FleetRoleName; work: string | null; host: string; since: string }[];
  quota: ObservedQuota['state']; loggedIn: boolean | null; usage: ObservedQuota['usage']; resetsAt: string | null; observedAt: string | null; quotaSource: ObservedQuota['source'];
  eligible: boolean;
  /** Why the account cannot take a session now; null when it can. */
  ineligible: string | null;
}
export interface FleetRoleView { role: FleetRoleName; accounts: string[]; concurrency: number; live: number; next: string | null; blocked: string | null; policy: RolePolicy }
export interface FleetView {
  revision: number; updatedAt: string | null; configured: boolean; host: string | null;
  runtimes: FleetRuntime[]; models: FleetModel[]; accounts: FleetAccountView[]; roles: FleetRoleView[];
  sessions: FleetSession[]; refusals: FleetRefusal[]; lastMutation: AgentRegistry['lastMutation'];
  attention: string[];
}

/**
 * The registry as status and the dashboard show it: each account with its runtime, model, role
 * eligibility, live sessions, quota and reset time, and the reason it is ineligible when it is;
 * each role with the account its next action would run on, or what stops it.
 */
export function fleetView(registry: AgentRegistry, now: number, host: string | null = null): FleetView {
  const live = liveSessions(registry);
  const accounts: FleetAccountView[] = registry.accounts.map(account => {
    const model = registry.models.find(entry => entry.name === account.model);
    const ineligible = accountIneligibility(registry, account, now, host);
    return { name: account.name, runtime: account.runtime, model: account.model, modelId: model?.id ?? null, cost: model?.cost ?? null, capability: model?.capability ?? null,
      host: account.credential.host, home: account.credential.home, enabled: account.enabled, maxSessions: account.maxSessions, note: account.note ?? null,
      roles: registry.roles.filter(role => role.accounts.includes(account.name)).map(role => ({ role: role.name, preference: role.accounts.indexOf(account.name) + 1, of: role.accounts.length })),
      liveSessions: live.filter(session => session.account === account.name).map(session => ({ id: session.id, role: session.role, work: session.work, host: session.host, since: session.selectedAt })),
      quota: account.quota.state, loggedIn: account.quota.loggedIn, usage: account.quota.usage, resetsAt: account.quota.resetsAt, observedAt: account.quota.observedAt, quotaSource: account.quota.source,
      eligible: !ineligible, ineligible };
  });
  const roles: FleetRoleView[] = registry.roles.map(role => {
    const choice = host ? chooseSession(registry, { role: role.name, host }, now) : null;
    const first = host ? choice?.account?.name ?? null : role.accounts.find(name => accounts.find(account => account.name === name)?.eligible) ?? null;
    const running = live.filter(session => session.role === role.name).length;
    const blocked = host ? (choice!.account ? null : choice!.reason) : running >= role.concurrency ? `role ${role.name} is at its concurrency limit (${running} of ${role.concurrency} live)` : first ? null : `no eligible account for ${role.name}`;
    return { role: role.name, accounts: role.accounts, concurrency: role.concurrency, live: running, next: blocked ? null : first, blocked, policy: rolePolicy(role) };
  });
  const unassigned = accounts.filter(account => !account.roles.length).map(account => `${account.name} serves no role; name it in a role or remove it`);
  const missing = registry.accounts.length ? fleetRoles.filter(name => !registry.roles.some(role => role.name === name)).map(name => `role ${name} is not configured; its sessions launch from local profiles until it is`) : [];
  return { revision: registry.revision, updatedAt: registry.updatedAt, configured: registry.roles.length > 0, host, runtimes: registry.runtimes, models: registry.models, accounts, roles,
    sessions: registry.sessions.slice(-30), refusals: registry.refusals, lastMutation: registry.lastMutation,
    attention: [...roles.filter(role => role.blocked).map(role => role.blocked!), ...unassigned, ...missing] };
}

