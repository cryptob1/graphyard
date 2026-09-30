import type { FleetAccountView, FleetRoleView, FleetView } from '../src/model/registry';
import { smokeRetestMs } from '../src/model/registry-sessions';
import { formatDuration } from '../src/model/duration';

/**
 * What the Agents page answers at a glance (GY-978): which accounts can work right now, which are
 * spent and until when, and why — one status per account, one launch verdict per role. Pure over
 * the `FleetView` `GET /api/agent-registry` serves, so a test renders exactly what the browser does.
 */

export const accountChips = ['disabled', 'no-role', 'spent', 'launch-failing', 'unavailable', 'working', 'idle'] as const;
export type AccountChip = typeof accountChips[number];
export const chipLabels: Record<AccountChip, string> = {
  disabled: 'Disabled', 'no-role': 'No role', spent: 'Spent', 'launch-failing': 'Launch failing', unavailable: 'Unavailable', working: 'Working', idle: 'Idle',
};
/** The tone each chip draws with, from the dashboard's own status tokens (web/style.css). */
export const chipTones: Record<AccountChip, 'ok' | 'busy' | 'wait' | 'bad' | 'off'> = {
  disabled: 'off', 'no-role': 'off', spent: 'wait', 'launch-failing': 'bad', unavailable: 'bad', working: 'busy', idle: 'ok',
};

/** A reset or retry time in the viewer's own time zone, e.g. "Oct 3, 08:27 AM". */
export const localTime = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
/** How far away a time is, e.g. "in 2d 23h", or "now" once it has passed. */
export const countdown = (iso: string, now: number) => { const left = Date.parse(iso) - now; return left <= 0 ? 'now' : `in ${formatDuration(left / 60_000)}`; };
/** A time with its countdown: "Oct 3, 08:27 AM (in 2d 23h)". */
export const whenText = (iso: string, now: number) => `${localTime(iso)} (${countdown(iso, now)})`;

/** How long a failed launch keeps its account marked as launch failing. */
export const launchFailureWindowMs = 60 * 60_000;
/** The end reasons an executor records when a session never started (src/producer.ts, src/master/autonomy.ts, src/daemon/cycle-sessions.ts). */
export const launchFailurePattern = /launch failed|failed (?:to start|before it started)|refused before it started|closed as failed/i;

export interface AccountStatus {
  chip: AccountChip; label: string;
  /** Why, in one sentence an operator can act on. */
  reason: string;
  /** When the account can work again by itself, when that is known. */
  until: string | null;
}

/** The account's launch failure, when its last smoke test failed, a role holds it after runs ended without a result, or its latest launch failed within the window. */
export function launchFailure(account: FleetAccountView, fleet: Pick<FleetView, 'sessions'>, now: number): { reason: string; until: string | null } | null {
  if (account.smoke?.result === 'fail') {
    const retry = new Date(Date.parse(account.smoke.at) + smokeRetestMs).toISOString();
    return { reason: `smoke test failed${account.smoke.reason ? `: ${account.smoke.reason}` : ''}`, until: Date.parse(retry) > now ? retry : null };
  }
  const held = account.held ?? [];
  if (held.length) {
    const until = held.map(entry => heldUntil(entry.reason)).filter((iso): iso is string => !!iso).sort()[0] ?? null;
    return { reason: `held from ${held.map(entry => entry.role).join(', ')} after runs that ended without a result`, until };
  }
  const latest = fleet.sessions.filter(session => session.account === account.name).sort((a, b) => Date.parse(b.selectedAt) - Date.parse(a.selectedAt))[0];
  if (latest?.endedAt && latest.endReason && launchFailurePattern.test(latest.endReason) && now - Date.parse(latest.endedAt) <= launchFailureWindowMs)
    return { reason: `last launch failed: ${latest.endReason}`, until: null };
  return null;
}

/** The time a role hold ends, from the registry's own reason (`roleIneligibility`). */
const heldUntil = (reason: string) => /until (\d{4}-\d\d-\d\dT[\d:.]+Z)/.exec(reason)?.[1] ?? null;
const exhausted = (account: FleetAccountView, now: number) => account.quota === 'exhausted' && (!account.resetsAt || Date.parse(account.resetsAt) > now);

/**
 * The one status an account shows, from its enabled flag, role membership, quota state and reset
 * time, recent launch failures and live sessions — the first that applies, in `accountChips` order.
 */
export function accountStatus(account: FleetAccountView, fleet: Pick<FleetView, 'sessions'>, now: number): AccountStatus {
  const status = (chip: AccountChip, reason: string, until: string | null = null): AccountStatus => ({ chip, label: chipLabels[chip], reason, until });
  if (!account.enabled) return status('disabled', 'disabled by an operator; nothing launches on it until it is enabled');
  if (!account.roles.length) return status('no-role', 'serves no role; name it in a role or remove it');
  if (exhausted(account, now)) return status('spent', account.resetsAt
    ? `quota spent until ${whenText(account.resetsAt, now)}${account.usage.length ? ` — ${account.usage.map(entry => `${entry.window} ${entry.percent}%`).join(', ')}` : ''}`
    : 'quota spent; the provider stated no reset time', account.resetsAt);
  const failing = launchFailure(account, fleet, now);
  if (failing) return status('launch-failing', `${failing.reason}${failing.until ? `; retried ${whenText(failing.until, now)}` : ''}`, failing.until);
  const live = account.liveSessions;
  const full = account.maxSessions !== null && live.length >= account.maxSessions;
  if (account.ineligible && !full) return status('unavailable', account.ineligible.startsWith(`${account.name} `) ? account.ineligible.slice(account.name.length + 1) : account.ineligible);
  if (live.length) return status('working', `${live.length} live — ${live.map(session => `${session.role}${session.work ? ` on ${session.work}` : ''}`).join(', ')}${full ? ` (at its limit of ${account.maxSessions})` : ''}`);
  return status('idle', `ready for ${account.roles.map(entry => entry.role).join(', ')}`);
}

export const roleLabels: Record<string, string> = { worker: 'Workers', reviewer: 'Reviewers', producer: 'Producers', approver: 'Approvers', 'escalation-handler': 'Escalation handlers', diagnostician: 'Diagnosticians' };

export interface RoleLaunch {
  role: string; canLaunch: boolean;
  /** The account the next launch runs on now, when one can. */
  account: string | null;
  /** The earliest time an account of the role frees up by itself, when none can launch now and one will. */
  nextAt: string | null;
  text: string;
}

/**
 * Whether a role can launch now and, when it cannot, why — each account's reason, grouped — and the
 * earliest time it can: "Workers: none can launch — opencode-a, opencode-b spent until Oct 3, 08:27 AM
 * (in 2d 23h); cursor-a launch failing; next: opencode-a Oct 3, 08:27 AM (in 2d 23h)".
 */
export function roleLaunch(role: FleetRoleView, fleet: Pick<FleetView, 'accounts' | 'sessions'>, now: number): RoleLaunch {
  const label = roleLabels[role.role] ?? role.role;
  const result = (canLaunch: boolean, text: string, account: string | null = null, nextAt: string | null = null): RoleLaunch => ({ role: role.role, canLaunch, account, nextAt, text: `${label}: ${text}` });
  if (role.concurrency === 0) return result(false, 'none can launch — paused (concurrency 0); next: when its concurrency is raised');
  if (!role.accounts.length) return result(false, 'none can launch — the role names no account; next: when an account is added to it');
  const accounts = role.accounts.map(name => ({ name, view: fleet.accounts.find(account => account.name === name) ?? null }));
  // The account the registry's own choice would take: the first eligible one the role does not hold out.
  const ready = accounts.find(({ view }) => view && view.eligible && !view.held.some(entry => entry.role === role.role));
  if (role.live >= role.concurrency) return result(false, `none can launch — at its concurrency limit (${role.live} of ${role.concurrency} live); next: ${ready ? `${ready.name} ` : ''}when one of its sessions ends`, null, null);
  if (ready) return result(true, `can launch now — next: ${ready.name} now${launchFailure(ready.view!, fleet, now) ? ' (its last launch failed)' : ''}`, ready.name);
  // Every account is out: group them by what keeps them out, and find the earliest one back by itself.
  const groups = new Map<string, string[]>();
  let next: { name: string; at: string } | null = null;
  for (const { name, view } of accounts) {
    const status = view ? accountStatus(view, fleet, now) : null;
    const why = !view ? 'not a registered account'
      : status!.chip === 'spent' ? `spent${status!.until ? ` until ${whenText(status!.until, now)}` : ''}`
      : status!.chip === 'launch-failing' ? 'launch failing'
      : status!.chip === 'working' ? 'at its session limit'
      : status!.chip === 'idle' ? `held from ${role.role}` : status!.chip === 'disabled' ? 'disabled' : status!.reason;
    groups.set(why, [...(groups.get(why) ?? []), name]);
    const back = status?.until ?? view?.held.map(entry => heldUntil(entry.reason)).find(Boolean) ?? null;
    if (back && Date.parse(back) > now && (!next || Date.parse(back) < Date.parse(next.at))) next = { name, at: back };
  }
  const reasons = [...groups].map(([why, names]) => `${names.join(', ')} ${why}`).join('; ');
  return result(false, `none can launch — ${reasons}; next: ${next ? `${next.name} ${whenText(next.at, now)}` : 'no account frees up by itself — enable, fix or connect one'}`, null, next?.at ?? null);
}
