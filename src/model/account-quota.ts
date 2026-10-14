// Concern: what the registry knows of each account's quota and login — folding a probe into it,
// and finding the account that shares an exhausted login.
import type { AgentRegistry, FleetAccount, QuotaObservation } from './registry.js';

/**
 * Fold an executor's probe into what the registry knows. An operator's exhausted mark stands until
 * its reset passes or an operator clears it, whatever a probe reads meanwhile: the mark exists for
 * what a probe cannot see — a plan the provider cut off, a runtime whose quota Graphyard cannot
 * read — so only the login state and its identity are taken from the probe while it holds. A session's exhaustion
 * report holds the same way until its reset (GY-1581). Returns whether anything
 * an eligibility decision reads has changed, so a steady state appends nothing to the ledger.
 */
export function foldObservation(account: FleetAccount, observed: QuotaObservation, context: { actor: string; at: string }) {
  const held = account.quota, now = Date.parse(context.at);
  const operatorHold = held.source === 'operator' && held.state === 'exhausted' && (!held.resetsAt || Date.parse(held.resetsAt) > now);
  if (operatorHold) {
    const identity = observed.identity === undefined ? held.identity ?? null : observed.identity;
    if ((observed.loggedIn === null || observed.loggedIn === held.loggedIn) && identity === (held.identity ?? null)) return false;
    account.quota = { ...held, loggedIn: observed.loggedIn ?? held.loggedIn, identity }; return true;
  }
  // A session's report of an exhaustion (GY-1581) is what a probe cannot see either, so it stands until the reset it
  // named: a later ordinary probe takes only the login state, and the spent login it was reported on stays, so its
  // shared-login twin stays held too. Another session's report replaces it.
  const sessionHold = !!held.session && held.state === 'exhausted' && !!held.resetsAt && Date.parse(held.resetsAt) > now;
  if (sessionHold && !observed.session) {
    if (observed.loggedIn === null || observed.loggedIn === held.loggedIn) return false;
    account.quota = { ...held, loggedIn: observed.loggedIn }; return true;
  }
  // A provider restates the same reset to the millisecond or not at all; only a reset that really moved is a change.
  const moved = (held.resetsAt === null) !== (observed.resetsAt === null) || !!held.resetsAt && !!observed.resetsAt && Math.abs(Date.parse(held.resetsAt) - Date.parse(observed.resetsAt)) > 60_000;
  // A probe that could not read the login file leaves the identity last read; one that read a login naming no account (an
  // API key, a logout) clears it, so a home logged in afresh is never held under its former login.
  const identity = observed.identity === undefined ? held.identity ?? null : observed.identity;
  const changed = held.loggedIn !== observed.loggedIn || held.state !== observed.state || moved || held.source !== 'probe' || identity !== (held.identity ?? null) || held.session !== observed.session;
  account.quota = { ...observed, identity, observedAt: context.at, observedBy: context.actor, source: 'probe' };
  return changed;
}

/**
 * Another registry account on the same provider login as `account` that is recorded exhausted with
 * a reset still ahead (GY-1573): two accounts on one subscription share one limit, so the twin is
 * spent until that reset whatever its own probe last read. An account whose identity is unknown has
 * no twin, and an exhaustion with no reset time holds only the account it was recorded on.
 */
export function exhaustedTwin(registry: Pick<AgentRegistry, 'accounts'>, account: FleetAccount, now: number): FleetAccount | null {
  const identity = account.quota.identity ?? null;
  if (!identity) return null;
  return registry.accounts.find(other => other.name !== account.name && (other.quota.identity ?? null) === identity && other.quota.state === 'exhausted'
    && !!other.quota.resetsAt && Date.parse(other.quota.resetsAt) > now) ?? null;
}
