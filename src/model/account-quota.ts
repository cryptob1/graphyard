// Concern: fold this account's observations and request a live check after a session signal.
import type { AgentRegistry, FleetAccount, ObservedQuota, QuotaObservation } from './registry.js';

/** An instant as the owner reads it: `2026-11-18 15:00 UTC`. */
export const utcClock = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
/** The reason a usage window at its ceiling gives (GY-3494): `weekly allowance 100% used, back 2026-11-18 15:00 UTC`. */
export const allowanceHold = /^\S+ allowance \d+(?:\.\d+)?% used, back /;
const allowanceName = (window: string) => window === '7d' ? 'weekly' : window === '5h' ? '5-hour' : window;
/**
 * A window at or over the ceiling with a future reset holds the account until that window's own reset,
 * whatever the last live check said (GY-3494): a passing check lifts only a hold resting on a failed request.
 */
export function windowHold(quota: QuotaObservation, ceiling: number, now: number): QuotaObservation {
  if (quota.state === 'exhausted') return quota;
  const spent = quota.usage.filter(usage => usage.percent >= ceiling && !!usage.resetsAt && Date.parse(usage.resetsAt) > now)
    .sort((a, b) => Date.parse(b.resetsAt!) - Date.parse(a.resetsAt!))[0];
  if (!spent) return quota;
  const { since: _since, session: _session, ...rest } = quota;
  return { ...rest, state: 'exhausted', resetsAt: spent.resetsAt, reason: `${allowanceName(spent.window)} allowance ${spent.percent}% used, back ${utcClock(spent.resetsAt!)}` };
}
/** A usage read that failed keeps the account's last good windows until each one's own reset, marked with when they were read (GY-3494). */
export function lastGoodUsage(account: FleetAccount, read: QuotaObservation, now: number): QuotaObservation['usage'] {
  if (read.usage.length || read.loggedIn === false) return read.usage;
  return (account.quota.usage ?? []).filter(usage => !!usage.resetsAt && Date.parse(usage.resetsAt) > now)
    .map(usage => ({ ...usage, readAt: usage.readAt ?? account.quota.observedAt ?? new Date(now).toISOString() }));
}

/**
 * What an exhausted reading rests on, named with its reset (GY-3094), or null when it rests on
 * nothing that still holds: an operator's mark, a session's report, a usage window the probe read at
 * its ceiling, or a failed request the host recorded with its reason and reset. A reading of
 * exhausted with none of these is unknown. A failed live request stands until a passing check;
 * legacy passive readings expire at their stated reset.
 */
export function exhaustionEvidence(quota: Pick<ObservedQuota, 'state' | 'usage' | 'resetsAt' | 'reason' | 'session' | 'source' | 'since'>, now: number): string | null {
  if (quota.state !== 'exhausted') return null;
  const ahead = (iso: string | null) => !iso || Date.parse(iso) > now;
  // A notice that named no reset is held for the bounded window, which is not its reset (GY-3302).
  const resets = !quota.resetsAt ? 'reset unknown' : quota.session === 'guessed' ? `reset unknown, held until ${quota.resetsAt}` : `resets ${quota.resetsAt}`;
  if (quota.since) return `the live request failed${quota.reason ? `: ${quota.reason}` : ''}; ${resets}`;
  if (quota.source === 'operator') return ahead(quota.resetsAt) ? `marked exhausted by an operator${quota.reason ? `: ${quota.reason}` : ''}; ${quota.resetsAt ? resets : 'awaiting a live check'}` : null;
  if (quota.resetsAt && !ahead(quota.resetsAt)) return null;
  if (quota.session) return `a session reported it spent${quota.reason ? `: ${quota.reason}` : ''}; ${resets}`;
  if (quota.resetsAt && quota.reason) return allowanceHold.test(quota.reason) ? quota.reason : `${quota.reason}; ${resets}`;
  const windows = quota.usage.filter(usage => ahead(usage.resetsAt));
  if (windows.length) return `usage ${windows.map(usage => `${usage.window} window at ${usage.percent}%${usage.resetsAt ? ` until ${usage.resetsAt}` : ''}`).join(', ')}; ${resets}`;
  return null;
}

/** Fold a host observation. A real request (since) supersedes every previous hold;
 * passive usage/login-file readings do not contradict a failed request. */
export function foldObservation(account: FleetAccount, observed: QuotaObservation, context: { actor: string; at: string }) {
  const held = account.quota, now = Date.parse(context.at);
  if (observed.state === 'exhausted' && observed.since && account.quotaDecision && Date.parse(observed.since) <= Date.parse(account.quotaDecision.at)) return false;
  if (!observed.since) {
    const loginHold = held.session === 'login' && held.loggedIn === false && (!observed.identity || observed.identity === held.identity);
    const quotaHold = held.state === 'exhausted' && (!!held.since || (held.source === 'operator' || !!held.session) && (!held.resetsAt || Date.parse(held.resetsAt) > now));
    if (loginHold || quotaHold && !observed.session) return false;
  }
  // A provider restates the same reset to the millisecond or not at all; only a reset that really moved is a change.
  const moved = (held.resetsAt === null) !== (observed.resetsAt === null) || !!held.resetsAt && !!observed.resetsAt && Math.abs(Date.parse(held.resetsAt) - Date.parse(observed.resetsAt)) > 60_000;
  // A probe that could not read the login file leaves the identity last read; one that read a login naming no account (an
  // API key, a logout) clears it, so a home logged in afresh is never held under its former login.
  const identity = observed.identity === undefined ? held.identity ?? null : observed.identity;
  // A read that failed or returned no windows names no evidence, so it is unknown, never exhausted (GY-3094).
  const state = observed.state === 'exhausted' && !exhaustionEvidence({ ...observed, source: 'probe' }, now) ? 'unknown' as const : observed.state;
  const changed = held.since !== observed.since || held.loggedIn !== observed.loggedIn || held.state !== state || moved || held.source !== 'probe' || identity !== (held.identity ?? null) || held.session !== observed.session || held.key !== observed.key || (held.fault ?? null) !== (observed.fault ?? null);
  account.quota = { ...observed, state, ...state === observed.state ? {} : { resetsAt: null }, identity, observedAt: context.at, observedBy: context.actor, source: 'probe' };
  return changed;
}

/** A session notice requests a host check; only that request's failure can hold the account.
 * Keep an existing live failure until its check is due instead of replacing it with narrative. */
export function requestLimitNoticeCheck(registry: AgentRegistry, notice: { role: string; work: string; principal: string | null; account: string | null; reason: string; resetsAt: string | null }, context: { actor: string; at: string }) {
  const session = registry.sessions.filter(entry => entry.role === notice.role && entry.work === notice.work && (!notice.principal || entry.principal === notice.principal))
    .sort((a, b) => Date.parse(b.selectedAt) - Date.parse(a.selectedAt))[0];
  const account = registry.accounts.find(entry => entry.name === notice.account) ?? registry.accounts.find(entry => entry.name === session?.account);
  if (!account) return null;
  if (account.quota.since && account.quota.state === 'exhausted') return null;
  const observed: QuotaObservation = { loggedIn: account.quota.loggedIn, state: 'unknown', usage: account.quota.usage, resetsAt: null, session: 'guessed',
    reason: `Check ${account.name}: ${notice.reason}`.slice(0, 500) };
  return foldObservation(account, observed, context) ? account.name : null;
}
