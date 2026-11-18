// Concern: what the registry knows of each account's quota and login — folding a probe into it,
// and finding the account that shares an exhausted login.
import type { AgentRegistry, FleetAccount, ObservedQuota, QuotaObservation } from './registry.js';

/**
 * What an exhausted reading rests on, named with its reset (GY-3094), or null when it rests on
 * nothing that still holds: an operator's mark, a session's report, a usage window the probe read at
 * its ceiling, or a hold a host recorded (a shared-login twin) with its reason and reset. A reading of
 * exhausted with none of these, or one whose reset has passed, is unknown: never a reason to pass
 * an account over.
 */
export function exhaustionEvidence(quota: Pick<ObservedQuota, 'state' | 'usage' | 'resetsAt' | 'reason' | 'session' | 'source'>, now: number): string | null {
  if (quota.state !== 'exhausted') return null;
  const ahead = (iso: string | null) => !iso || Date.parse(iso) > now;
  // A notice that named no reset is held for the bounded window, which is not its reset (GY-3302).
  const resets = !quota.resetsAt ? 'reset unknown' : quota.session === 'guessed' ? `reset unknown, held until ${quota.resetsAt}` : `resets ${quota.resetsAt}`;
  if (quota.source === 'operator') return ahead(quota.resetsAt) ? `marked exhausted by an operator${quota.reason ? `: ${quota.reason}` : ''}; ${quota.resetsAt ? resets : 'held until an operator clears it'}` : null;
  if (quota.resetsAt && !ahead(quota.resetsAt)) return null;
  if (quota.session) return `a session reported it spent${quota.reason ? `: ${quota.reason}` : ''}; ${resets}`;
  if (quota.resetsAt && quota.reason) return `${quota.reason}; ${resets}`;
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
    const quotaHold = held.state === 'exhausted' && (held.source === 'operator' || !!held.session) && (!held.resetsAt || Date.parse(held.resetsAt) > now);
    if (loginHold || quotaHold && !observed.session) return false;
  }
  // A provider restates the same reset to the millisecond or not at all; only a reset that really moved is a change.
  const moved = (held.resetsAt === null) !== (observed.resetsAt === null) || !!held.resetsAt && !!observed.resetsAt && Math.abs(Date.parse(held.resetsAt) - Date.parse(observed.resetsAt)) > 60_000;
  // A probe that could not read the login file leaves the identity last read; one that read a login naming no account (an
  // API key, a logout) clears it, so a home logged in afresh is never held under its former login.
  const identity = observed.identity === undefined ? held.identity ?? null : observed.identity;
  // A read that failed or returned no windows names no evidence, so it is unknown, never exhausted (GY-3094).
  const state = observed.state === 'exhausted' && !exhaustionEvidence({ ...observed, source: 'probe' }, now) ? 'unknown' as const : observed.state;
  const changed = held.loggedIn !== observed.loggedIn || held.state !== state || moved || held.source !== 'probe' || identity !== (held.identity ?? null) || held.session !== observed.session;
  account.quota = { ...observed, state, ...state === observed.state ? {} : { resetsAt: null }, identity, observedAt: context.at, observedBy: context.actor, source: 'probe' };
  return changed;
}

/** How long a limit notice that named no reset holds its account: the hour a host holds it (unknownResetHoldMs). */
const unnamedResetHoldMs = 3_600_000;
/**
 * Hold the account a session spent on its provider's limit notice (GY-3096), as the registry's own
 * quota reading: exhausted until the notice's reset (an hour when it named none), with the notice as
 * the reason. The account is the one the report names when the registry knows it, else the one the
 * registry's newest session of that role for the item (and its principal) ran on. Kept in the
 * registry, the hold binds every selection, whichever loop process asks next. Returns the account
 * held, or null when none is known or nothing changed.
 */
export function holdLimitNoticeAccount(registry: AgentRegistry, notice: { role: string; work: string; principal: string | null; account: string | null; reason: string; resetsAt: string | null }, context: { actor: string; at: string }) {
  const session = registry.sessions.filter(entry => entry.role === notice.role && entry.work === notice.work && (!notice.principal || entry.principal === notice.principal))
    .sort((a, b) => Date.parse(b.selectedAt) - Date.parse(a.selectedAt))[0];
  const account = registry.accounts.find(entry => entry.name === notice.account) ?? registry.accounts.find(entry => entry.name === session?.account);
  if (!account) return null;
  const now = Date.parse(context.at), named = !!notice.resetsAt && Date.parse(notice.resetsAt) > now;
  const resetsAt = named ? notice.resetsAt! : new Date(now + unnamedResetHoldMs).toISOString();
  const observed: QuotaObservation = { loggedIn: account.quota.loggedIn, state: 'exhausted', usage: account.quota.usage, resetsAt, session: named ? 'named' : 'guessed',
    reason: `${account.name} stopped a ${notice.role} session on ${notice.work} on its provider's limit notice: ${notice.reason}`.slice(0, 500) };
  return foldObservation(account, observed, context) ? account.name : null;
}
