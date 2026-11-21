// Concern: fold this account's observations and request a live check after a session signal.
import type { AgentRegistry, FleetAccount, ObservedQuota, QuotaObservation } from './registry.js';

/** An instant as the owner reads it: `2026-11-18 15:00 UTC`. */
export const utcClock = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
/** A usage read that failed keeps the account's last good windows until each one's own reset, marked with when they were read (GY-3494). */
export function lastGoodUsage(account: FleetAccount, read: QuotaObservation, now: number): QuotaObservation['usage'] {
  if (read.usage.length || read.loggedIn === false) return read.usage;
  return (account.quota.usage ?? []).filter(usage => !!usage.resetsAt && Date.parse(usage.resetsAt) > now)
    .map(usage => ({ ...usage, readAt: usage.readAt ?? account.quota.observedAt ?? new Date(now).toISOString() }));
}

/**
 * What an exhausted reading rests on, named with its reset (GY-3094), or null when it rests on
 * nothing that holds (GY-3555): only the account's own live request, refused by its provider, or an
 * operator's mark until its reset. Any other reading of exhausted is unknown. A refused live request
 * stands until a passing check.
 */
export function exhaustionEvidence(quota: Pick<ObservedQuota, 'state' | 'usage' | 'resetsAt' | 'reason' | 'session' | 'source' | 'since'>, now: number): string | null {
  if (quota.state !== 'exhausted') return null;
  // A refusal that named no reset is held for one check interval, which is not its reset (GY-3302).
  const resets = !quota.resetsAt ? 'reset unknown' : quota.session === 'guessed' ? `reset unknown, held until ${quota.resetsAt}` : `resets ${quota.resetsAt}`;
  if (quota.since) return `${quota.reason ?? 'the live request was refused'}; ${resets}`;
  if (quota.source === 'operator' && (!quota.resetsAt || Date.parse(quota.resetsAt) > now)) return `marked exhausted by an operator${quota.reason ? `: ${quota.reason}` : ''}; ${quota.resetsAt ? resets : 'awaiting a live check'}`;
  return null;
}

/** Fold a host observation. Only a live request (since) sets quota (GY-3555): it supersedes any earlier result, and an
 * operator's mark only when it is newer than the mark. A reading that made no request never replaces a live result or a mark. */
export function foldObservation(account: FleetAccount, observed: QuotaObservation, context: { actor: string; at: string }) {
  const held = account.quota, now = Date.parse(context.at);
  const decided = account.quotaDecision ? Date.parse(account.quotaDecision.at) : null;
  if (observed.since ? decided !== null && Date.parse(observed.since) <= decided : held.source === 'operator') return false;
  if (!observed.since) {
    const loginHold = held.session === 'login' && held.loggedIn === false && (!observed.identity || observed.identity === held.identity);
    if (loginHold || held.since && held.state !== 'available') return false;
  }
  // A provider restates the same reset to the millisecond or not at all; only a reset that really moved is a change.
  const moved = (held.resetsAt === null) !== (observed.resetsAt === null) || !!held.resetsAt && !!observed.resetsAt && Math.abs(Date.parse(held.resetsAt) - Date.parse(observed.resetsAt)) > 60_000;
  // A probe that could not read the login file leaves the identity last read; one that read a login naming no account (an
  // API key, a logout) clears it, so a home logged in afresh is never held under its former login.
  const identity = observed.identity === undefined ? held.identity ?? null : observed.identity;
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
