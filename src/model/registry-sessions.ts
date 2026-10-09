import type { Work } from './work.js';
import { fleetRoles, rolePolicy } from './registry.js';
import { exhaustedTwin, foldObservation } from './account-quota.js';
import type { AccountSmoke, AgentRegistry, FleetAccount, FleetModel, FleetRefusal, FleetRoleName, FleetRuntime, FleetSession, ObservedQuota, RolePolicy, RunOutcome, SelectionRequest, SessionSkip } from './registry.js';
import { accountProvider, busyDifferentProvider, sameProviderFallback, sharedProviderSkip, type ReviewDiversity } from './review-diversity.js';
import { deriveAccountPlan, groupAccountsByPlan, type FleetPlanView } from '../provider-usage.js';

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
  // The master session (GY-898) names no work item by design: it holds its slot until the loop
  // that supervises it ends it (rotation), bounded only by the outer cap above — its own budget is
  // at most 12 hours — so a second host never reads the role as free while the pane still runs.
  if (session.role === 'master') return null;
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

/**
 * How long after a failed smoke test the account's executor tests it again (GY-515): a provider
 * outage during the one prompt would otherwise keep a sound account out until an operator changed it.
 */
export const smokeRetestMs = 3_600_000;
/**
 * Whether an account's failed smoke test is due for the retest its executor runs (GY-515): the age
 * rule `needsSmoke` applies. A due failure no longer bars a launch — the launch is what tests the
 * account again — but no session is chosen on it until a fresh pass is folded.
 */
export const smokeFailureDue = (account: FleetAccount, now: number) =>
  account.smoke?.result === 'fail' && now - Date.parse(account.smoke.at) >= smokeRetestMs;
const until = (iso: string | null) => iso ? ` until ${iso}` : '';
/**
 * Why an account cannot take a session right now, whatever role asks — null when it can. `host`
 * is the executor asking: an account is placed where its login lives, so every other host is
 * refused it. Without a host the placement is not judged (a report has no single asking host).
 *
 * `expiredSmokeRetestable` is the launch preflight's reading (fleetRoleHealth, GY-515): a Pi
 * account whose only fault is a smoke failure that has aged past `smokeRetestMs` may be launched
 * at, because that launch runs the retest. The session choice itself never passes the flag — it
 * refuses until the retest's fresh result is folded.
 */
export function accountIneligibility(registry: AgentRegistry, account: FleetAccount, now: number, host?: string | null,
  options: { expiredSmokeRetestable?: boolean } = {}): string | null {
  if (!account.enabled) return `${account.name} is disabled`;
  if (!registry.runtimes.some(runtime => runtime.name === account.runtime)) return `${account.name} runs ${account.runtime}, which is not a registered runtime`;
  if (!registry.models.some(model => model.name === account.model)) return `${account.name} runs ${account.model}, which is not a registered model`;
  if (host && account.credential.host !== host) return `${account.name} is placed on ${account.credential.host}; this executor is ${host}`;
  if (account.quota.loggedIn === false) return `${account.name} is not logged in`;
  const pi = registry.runtimes.some(runtime => runtime.name === account.runtime && runtime.launch.kind === 'pi');
  if (account.smoke?.result === 'fail' && !(options.expiredSmokeRetestable && pi && smokeFailureDue(account, now))) return `${account.name} failed its smoke test${account.smoke.reason ? `: ${account.smoke.reason}` : ''}; it is tested again after ${smokeRetestMs / 60_000} minutes, or at once when the account is changed (master registry account set)`;
  const plan = deriveAccountPlan(account, registry.accounts);
  const planAccounts = registry.accounts.filter(other => other.name === account.name || deriveAccountPlan(other, registry.accounts).planId === plan.planId);
  const held = (other: FleetAccount) => other.quota.state === 'exhausted' && (!other.quota.resetsAt || Date.parse(other.quota.resetsAt) > now);
  // An operator hold on the plan wins, and so does a session's exhaustion report until its reset (GY-1581): no probe outranks either. Otherwise the
  // newest probe on the plan decides, so a stale exhaustion one host reported without a reset is superseded by a later probe elsewhere (GY-1158).
  // Another account's guessed report holds nothing here, never even as a probe: its host resends it every selection, so it is always the newest. A pure read.
  const guessed = (other: FleetAccount) => other.quota.session === 'guessed' && other.name !== account.name, reported = (other: FleetAccount) => !!other.quota.session && !guessed(other) && held(other);
  const probes = planAccounts.filter(other => other.quota.source === 'probe' && other.quota.observedAt && other.quota.state !== 'unknown' && !guessed(other))
    .sort((a, b) => Date.parse(b.quota.observedAt!) - Date.parse(a.quota.observedAt!));
  const exhausted = planAccounts.find(other => other.quota.source === 'operator' && held(other)) ?? [account, ...planAccounts].find(reported)
    ?? (probes.length ? [probes[0]].find(held) : [account, ...planAccounts].find(other => !guessed(other) && held(other)));
  if (exhausted?.name === account.name) return `${account.name} quota is exhausted${until(account.quota.resetsAt)}${account.quota.reason ? ` (${account.quota.reason})` : ''}`;
  if (exhausted) return `${account.name} quota is exhausted on plan ${plan.planName} (${exhausted.name} quota is ${exhausted.quota.source === 'operator' ? 'marked exhausted by operator' : 'exhausted'}${until(exhausted.quota.resetsAt)}${exhausted.quota.reason ? `: ${exhausted.quota.reason}` : ''})`;
  const twin = exhaustedTwin(registry, account, now);
  if (twin) return `${account.name} quota is exhausted${until(twin.quota.resetsAt)}: it is the same provider login as ${twin.name}, whose quota is ${twin.quota.source === 'operator' ? 'marked exhausted by operator' : 'exhausted'}${twin.quota.reason ? ` (${twin.quota.reason})` : ''}`;
  const running = liveSessions(registry).filter(session => session.account === account.name).length;
  if (account.maxSessions !== null && running >= account.maxSessions) return `${account.name} is at its session limit (${running} of ${account.maxSessions} live)`;
  return null;
}

/**
 * How long an account is kept from a role after `unjudgedRunLimit` consecutive headless runs of
 * that role on it ended without a result (GY-446): a run that dies unjudged twice in a row is the
 * account failing, not the item, so the loop falls through to the role's next account.
 */
export const unjudgedRunLimit = 2, unjudgedHoldMs = 3_600_000;
/** Why an account is kept from one role right now, or null. */
export function roleIneligibility(account: FleetAccount, role: FleetRoleName, now: number): string | null {
  const held = account.unjudged?.[role];
  if (!held?.until || Date.parse(held.until) <= now) return null;
  return `${account.name} is held from ${role} until ${held.until}: ${unjudgedRunLimit} consecutive ${role} runs on it ended without a result${held.reason ? ` (last: ${held.reason})` : ''}`;
}
/**
 * Record how one headless run of a session ended. A run with a result clears its account's count
 * for the role; one without adds to it, and the `unjudgedRunLimit`th in a row holds the account
 * from the role for `unjudgedHoldMs`. Returns whether anything changed.
 */
export function recordRunOutcome(registry: AgentRegistry, session: Pick<FleetSession, 'account' | 'role'>, outcome: RunOutcome, reason: string, at: string) {
  const account = registry.accounts.find(entry => entry.name === session.account);
  if (!account) return false;
  const held = account.unjudged?.[session.role];
  if (outcome === 'result') {
    if (!held) return false;
    delete account.unjudged![session.role]; return true;
  }
  // A run that started before the hold and ends unjudged during it leaves the hold as it is: the
  // account stays barred from the role for the whole hour, however many overlapping runs end.
  if (held?.until && Date.parse(held.until) > Date.parse(at)) return false;
  const runs = (held?.until ? 0 : held?.runs ?? 0) + 1;
  (account.unjudged ??= {})[session.role] = runs >= unjudgedRunLimit
    ? { runs: 0, until: new Date(Date.parse(at) + unjudgedHoldMs).toISOString(), reason: reason.slice(0, 300) }
    : { runs, until: null, reason: reason.slice(0, 300) };
  return true;
}
/**
 * End one session with the reason its executor gave, and record its run's outcome when it names
 * one. A session something else ended first (its runtime session gone, a relaunch) still takes its
 * run's outcome, once. Returns whether anything changed.
 */
export function endRegistrySession(registry: AgentRegistry, session: FleetSession, reason: string, outcome: RunOutcome | undefined, at: string) {
  const late = !!session.endedAt;
  if (late && (!outcome || session.outcome)) return false;
  if (!late) { session.endedAt = at; session.endReason = reason; }
  if (outcome) { session.outcome = outcome; recordRunOutcome(registry, session, outcome, reason, at); }
  return true;
}
/**
 * Fold what an executor observed about the accounts on its own host into the registry: each quota,
 * and each smoke test it ran. Returns whether anything an eligibility decision reads has changed.
 */
export function foldObservations(registry: AgentRegistry, request: Pick<SelectionRequest, 'host' | 'observations'>, context: { actor: string; at: string }) {
  let changed = false;
  for (const observed of request.observations) {
    const account = registry.accounts.find(entry => entry.name === observed.account);
    // An executor only vouches for the logins on its own host.
    if (!account || account.credential.host !== request.host) continue;
    if (foldObservation(account, observed.quota, context)) changed = true;
    if (observed.smoke) { account.smoke = { result: observed.smoke.result, reason: observed.smoke.reason, at: context.at, by: context.actor }; changed = true; }
  }
  return changed;
}

export interface SessionChoice { account: FleetAccount; runtime: FleetRuntime; model: FleetModel; policy: RolePolicy; reason: string; skipped: SessionSkip[] }
export interface SessionRefusal { account: null; reason: string; skipped: SessionSkip[] }
/**
 * The session an action runs on: the first account of the role, in the role's own order, that is
 * placed on the asking host, logged in, within quota and under its session limit, provided the
 * role itself is under its concurrency limit. For role reviewer with a known implementer provider
 * (GY-1496) the first such account on another provider is chosen; one only at its session limit is
 * waited for, and with none the first same-provider account serves with the fallback recorded.
 * Pure: the registry passed in already carries the executor's fresh observations and only live sessions.
 */
export function chooseSession(registry: AgentRegistry, request: Pick<SelectionRequest, 'role' | 'host'>, now: number, diversity: ReviewDiversity | null = null): SessionChoice | SessionRefusal {
  const role = registry.roles.find(entry => entry.name === request.role);
  if (!role) return { account: null, reason: `role ${request.role} is not configured in the agent registry`, skipped: [] };
  if (!role.accounts.length) return { account: null, reason: `role ${request.role} names no account`, skipped: [] };
  const running = liveSessions(registry).filter(session => session.role === role.name);
  if (running.length >= role.concurrency) return { account: null, skipped: [],
    reason: role.concurrency === 0 ? `role ${role.name} is paused (concurrency 0)` : `role ${role.name} is at its concurrency limit (${running.length} of ${role.concurrency} live: ${running.map(session => `${session.account}${session.work ? ` on ${session.work}` : ''}`).join(', ')})` };
  const skipped: SessionSkip[] = [], diverse = role.name === 'reviewer' ? diversity : null, others: SessionSkip[] = [], busy: SessionSkip[] = [];
  let fallback: { account: FleetAccount; index: number; skip: SessionSkip } | null = null; const shared = new Set<SessionSkip>();
  const chosen = (account: FleetAccount, index: number, passed: SessionSkip[], note: string): SessionChoice => {
    // The role's policy names the model its sessions run, where it names one; else the account's own.
    const policy = rolePolicy(role), runtime = registry.runtimes.find(entry => entry.name === account.runtime)!;
    const model = registry.models.find(entry => entry.name === (policy.model ?? account.model)) ?? registry.models.find(entry => entry.name === account.model)!;
    return { account, runtime, model, policy, skipped: passed,
      reason: `${account.name} is the first eligible account for ${role.name} (preference ${index + 1} of ${role.accounts.length}; ${running.length + 1} of ${role.concurrency} concurrent)${note}${passed.length ? ` — passed over ${passed.map(entry => entry.reason).join('; ')}` : ''}` };
  };
  for (const [index, name] of role.accounts.entries()) {
    const account = registry.accounts.find(entry => entry.name === name);
    const refusal = account ? accountIneligibility(registry, account, now, request.host) ?? roleIneligibility(account, role.name, now) : `${name} is not a registered account`;
    const differs = !!diverse && !!account && accountProvider(registry, account) !== diverse.provider;
    if (refusal) {
      skipped.push({ account: name, reason: refusal });
      if (differs) others.push({ account: name, reason: refusal });
      if (differs && account!.maxSessions !== null && !accountIneligibility(registry, { ...account!, maxSessions: null }, now, request.host) && !roleIneligibility(account!, role.name, now)) busy.push({ account: name, reason: refusal });
      continue;
    }
    if (diverse && !differs) { const skip = sharedProviderSkip(name, diverse); skipped.push(skip); shared.add(skip); fallback ??= { account: account!, index, skip }; continue; }
    return chosen(account!, index, skipped, diverse ? ` on provider ${accountProvider(registry, account!)}, not the implementer's ${diverse.provider}` : '');
  }
  if (diverse && busy.length) return { account: null, skipped, reason: busyDifferentProvider(role.name, diverse, busy) };
  if (fallback) return chosen(fallback.account, fallback.index, skipped.filter((entry, at) => at < skipped.indexOf(fallback!.skip) || !shared.has(entry)), `; ${sameProviderFallback(diverse!, others)}`);
  return { account: null, skipped, reason: `no eligible account for ${role.name}: ${skipped.map(entry => entry.reason).join('; ')}` };
}

export interface FleetAccountView {
  name: string; runtime: string; model: string; modelId: string | null; cost: FleetModel['cost'] | null; capability: FleetModel['capability'] | null;
  host: string; home: string | null; enabled: boolean; maxSessions: number | null; note: string | null;
  /** The provider plan this account draws on (GY-1121). */
  plan?: string;
  /** Every role that names the account, with its place in that role's order. */
  roles: { role: FleetRoleName; preference: number; of: number }[];
  liveSessions: { id: string; role: FleetRoleName; work: string | null; host: string; since: string }[];
  quota: ObservedQuota['state']; loggedIn: boolean | null; usage: ObservedQuota['usage']; resetsAt: string | null; observedAt: string | null; quotaSource: ObservedQuota['source'];
  eligible: boolean;
  /** Why the account cannot take a session now; null when it can. */
  ineligible: string | null;
  /** Its last smoke test (GY-446); null until an executor has run one since the account last changed. */
  smoke: AccountSmoke | null;
  /** The roles it is held from after runs that ended without a result, and why. */
  held: { role: FleetRoleName; reason: string }[];
}
export interface FleetRoleView { role: FleetRoleName; accounts: string[]; concurrency: number; live: number; next: string | null; blocked: string | null; policy: RolePolicy }
export interface FleetView {
  revision: number; updatedAt: string | null; configured: boolean; host: string | null;
  runtimes: FleetRuntime[]; models: FleetModel[]; accounts: FleetAccountView[]; roles: FleetRoleView[];
  plans?: FleetPlanView[];
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
    const planInfo = deriveAccountPlan(account, registry.accounts);
    return { name: account.name, runtime: account.runtime, model: account.model, modelId: model?.id ?? null, cost: model?.cost ?? null, capability: model?.capability ?? null,
      host: account.credential.host, home: account.credential.home, enabled: account.enabled, maxSessions: account.maxSessions, note: account.note ?? null,
      plan: account.plan ?? planInfo.planName,
      roles: registry.roles.filter(role => role.accounts.includes(account.name)).map(role => ({ role: role.name, preference: role.accounts.indexOf(account.name) + 1, of: role.accounts.length })),
      liveSessions: live.filter(session => session.account === account.name).map(session => ({ id: session.id, role: session.role, work: session.work, host: session.host, since: session.selectedAt })),
      quota: account.quota.state, loggedIn: account.quota.loggedIn, usage: account.quota.usage, resetsAt: account.quota.resetsAt, observedAt: account.quota.observedAt, quotaSource: account.quota.source,
      eligible: !ineligible, ineligible, smoke: account.smoke ?? null,
      held: fleetRoles.flatMap(role => { const reason = roleIneligibility(account, role, now); return reason ? [{ role, reason }] : []; }) };
  });
  const roles: FleetRoleView[] = registry.roles.map(role => {
    const choice = host ? chooseSession(registry, { role: role.name, host }, now) : null;
    const first = host ? choice?.account?.name ?? null : role.accounts.find(name => accounts.find(account => account.name === name)?.eligible) ?? null;
    const running = live.filter(session => session.role === role.name).length;
    const blocked = host ? (choice!.account ? null : choice!.reason) : running >= role.concurrency ? `role ${role.name} is at its concurrency limit (${running} of ${role.concurrency} live)` : first ? null : `no eligible account for ${role.name}`;
    return { role: role.name, accounts: role.accounts, concurrency: role.concurrency, live: running, next: blocked ? null : first, blocked, policy: rolePolicy(role) };
  });
  const unassigned = accounts.filter(account => !account.roles.length).map(account => `${account.name} serves no role; name it in a role or remove it`);
  const missing = registry.accounts.length ? fleetRoles.filter(name => !registry.roles.some(role => role.name === name)).map(name => name === 'master'
    ? 'role master is not configured; the durable loop launches no master session until graphyard master registry role set master ACCOUNT[,ACCOUNT…] --reason REASON names its accounts'
    : `role ${name} is not configured; its sessions launch from local profiles until it is`) : [];
  const plans = groupAccountsByPlan({ accounts: registry.accounts }, now);
  return { revision: registry.revision, updatedAt: registry.updatedAt, configured: registry.roles.length > 0, host, runtimes: registry.runtimes, models: registry.models, accounts, roles, plans,
    sessions: registry.sessions.slice(-30), refusals: registry.refusals, lastMutation: registry.lastMutation,
    attention: [...roles.flatMap(role => roleAttention(role, live)), ...unassigned, ...missing] };
}

/**
 * What a blocked role raises as fleet attention (GY-950). A role at its concurrency limit whose
 * live sessions all carry work is waiting for a slot — each waiting item already names its own
 * dispatch wait — so it raises nothing. Only the sessions holding a slot with no work (a master
 * session never carries work, so it is always accounted for) are raised, by id, to be ended.
 */
function roleAttention(role: FleetRoleView, live: FleetSession[]): string[] {
  if (!role.blocked) return [];
  if (!role.concurrency || role.live < role.concurrency) return [role.blocked];
  const idle = role.role === 'master' ? [] : live.filter(session => session.role === role.role && !session.work);
  return idle.length ? [`role ${role.role} is at its concurrency limit (${role.live} of ${role.concurrency} live) with ${idle.length} session${idle.length === 1 ? '' : 's'} carrying no work: ${idle.map(session => `${session.id} (${session.account})`).join(', ')}`] : [];
}

