// Concern: the provider login behind an account home, so accounts on one subscription are held together (GY-1573).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AgentRegistry, QuotaObservation } from '../model/registry.js';
import type { AgentEnvironment } from './profiles.js';
import type { ObservedExhaustion } from './environments.js';

/**
 * The provider login an account home holds (GY-1573), as its kind and a digest of the provider's own
 * ids, so two homes logged in to one subscription read alike and nothing identifying leaves the host:
 * Claude Code's OAuth account and organization, Codex's ChatGPT account, Cursor's user. OpenCode and
 * Pi name no single login (each provider keeps its own), and an API-key login names no account, so
 * those read null: unknown, which holds nothing. A login file that exists but cannot be read or
 * parsed just now (a runtime mid-write) reads undefined: the login has not been seen to change.
 */
export async function providerIdentity(kind: string, home: string): Promise<string | null | undefined> {
  const file = kind === 'claude' ? '.claude.json' : kind === 'codex' ? 'auth.json' : kind === 'cursor' ? 'cli-config.json' : null;
  if (!file) return null;
  let login: any;
  try { login = JSON.parse(await readFile(resolve(home, file), 'utf8')); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined; }
  const ids = kind === 'claude' ? [login?.oauthAccount?.accountUuid, login?.oauthAccount?.organizationUuid] : kind === 'codex' ? [login?.tokens?.account_id] : [login?.authInfo?.userId];
  if (!ids.every(id => typeof id === 'string' && id.trim() || typeof id === 'number')) return null;
  return `${kind}:${createHash('sha256').update(ids.map(String).join('\0')).digest('hex').slice(0, 32)}`;
}

export const describeObservedExhaustion = (environment: string, held: ObservedExhaustion) =>
  `${environment} exhausted its quota mid-session at ${held.at} (${held.reason}); ${held.resetsAt ? `it resets ${held.resetsAt}` : `its reset time is unknown, so it is tried again after ${held.until}`}`;
/**
 * What this host reports of an account a session saw spent: exhausted until the hold ends. Only a
 * reset the session named is the subscription's (GY-1573); the hour assumed when it named none is
 * this host's guess, so that report names no login and holds no other account.
 */
export const heldObservation = (environment: string, held: ObservedExhaustion, read: QuotaObservation = { loggedIn: true, state: 'unknown', usage: [], resetsAt: null, reason: null }): QuotaObservation =>
  ({ ...read, state: 'exhausted', resetsAt: held.until, reason: describeObservedExhaustion(environment, held).slice(0, 500), identity: !held.resetsAt ? null : held.identity !== undefined ? held.identity : read.identity });
/**
 * A hold as the agent registry is told of it, with the login it was spent on (GY-1573). A hold saved
 * before identities were recorded is given one, kept on the hold once reported so a source home logged
 * in afresh later moves no hold: the identity the log last read for its account, else its home's login
 * read now. A login unreadable just now (a runtime mid-write) returns null, so the hold stays pending
 * until it can be read; a hold with no known home names no login, and the registry keeps the one its
 * executor last observed for that account.
 */
export async function reconstructedHold(held: ObservedExhaustion, launched?: { identity?: string | null }, home?: { kind: string; home: string }): Promise<ObservedExhaustion | null> {
  if (held.identity !== undefined) return held;
  if (launched?.identity !== undefined) return { ...held, identity: launched.identity };
  if (!home) return held;
  const identity = await providerIdentity(home.kind, home.home);
  return identity === undefined ? null : { ...held, identity };
}
/**
 * Whether a hold recorded under an environment's name was spent on that environment (GY-1574): a hold
 * that names the home its session ran in holds a same-named environment on another home (a legacy
 * configured environment named like a registry account) only as a twin of the same login, never by name;
 * so does one that names another runtime's login in the same directory. A hold saved before holds named
 * their home is judged by the home and runtime the environment log recorded for that name, the ones its
 * session launched on; only with no home known does the name decide.
 */
export const spentHere = (held: ObservedExhaustion | undefined, environment: { home: string; kind?: string }, launched?: { home?: string; kind?: string }) => {
  const spent = held?.home ? { home: held.home, kind: held.kind } : launched?.home ? { home: launched.home, kind: launched.kind } : undefined;
  return !!held && (!spent || resolve(spent.home) === resolve(environment.home) && (!spent.kind || !environment.kind || spent.kind === environment.kind));
};
/**
 * A held account on the same provider login as `name` (GY-1573): one a session saw spent with a known
 * reset holds every configured environment logged in to that subscription until the same reset. The
 * spent login is the one recorded with the hold, so a source home logged in afresh since moves no
 * hold; a hold recorded before identities were reads the home it was spent on now, never a same-named
 * configured one (GY-1574). An environment whose identity is unknown, or a hold with no reset, holds
 * nothing beyond its own home. A login file that cannot be read just now (a runtime mid-write) reads as
 * `known`, the identity the environment log last recorded for it, when that was read from the same home.
 */
export async function heldTwin(environments: readonly AgentEnvironment[], held: Record<string, ObservedExhaustion>, name: string, known: Record<string, { identity?: string | null; kind?: string; home?: string }> = {}) {
  const self = environments.find(environment => environment.name === name);
  const candidates = self ? Object.entries(held).filter(([other, entry]) => entry.resetsAt && (other !== name || !spentHere(entry, self, known[name]))) : [];
  const read = async (kind: string, home: string, recorded?: { identity?: string | null; home?: string }) => {
    const identity = await providerIdentity(kind, home);
    return identity !== undefined ? identity : recorded && (!recorded.home || resolve(recorded.home) === resolve(home)) ? recorded.identity ?? null : null;
  };
  const identity = candidates.length ? await read(self!.kind, self!.home, known[name]) : null;
  if (!identity) return null;
  for (const [other, entry] of candidates) {
    const twin = environments.find(environment => environment.name === other), launched = known[other]?.home ? known[other] : undefined;
    const home = entry.home ?? launched?.home ?? twin?.home, kind = (entry.home ? entry.kind : launched?.kind) ?? twin?.kind ?? self!.kind;
    const spent = entry.identity !== undefined ? entry.identity : home ? await read(kind, home, known[other]) : null;
    if (spent === identity) return { name: other, held: entry, reason: `${name} is the same provider login as ${describeObservedExhaustion(other, entry)}` };
  }
  return null;
}
/**
 * The home and runtime kind the agent registry logs `name` in with on `host`, or undefined when the
 * registry names none (no such account here, or a key login with no home): what a same-named hold is judged by.
 */
export const registryLogin = (registry: Pick<AgentRegistry, 'accounts'> & Partial<Pick<AgentRegistry, 'runtimes'>> | null | undefined, host: string | undefined, name: string) => {
  const account = registry?.accounts.find(entry => entry.name === name && (!host || entry.credential.host === host));
  return account?.credential.home ? { home: account.credential.home, kind: registry?.runtimes?.find(runtime => runtime.name === account.runtime)?.launch.kind } : undefined;
};
const twinReason = (account: string, other: string, held: ObservedExhaustion) => `${account} is the same provider login as ${describeObservedExhaustion(other, held)}`.slice(0, 500);
/**
 * What this host tells the agent registry of a pending hold (GY-1574). One spent in the same-named
 * registry account's own home and runtime (or with no registry document to judge by) is that account's
 * own. One spent elsewhere, a legacy configured environment named like a registry account or one the
 * registry does not list, is never reported as that account: its spent login is delivered instead as
 * a hold on every registry account on this host the registry knows on that login, so the registry
 * holds their twins on every host until the reset. Null while no account here is known on that login
 * (the hold stays pending, tried again next cycle); an empty list when the hold names no login or reset
 * to share, so there is nothing for the registry.
 */
export function registryHoldObservations(registry: Pick<AgentRegistry, 'accounts'> & Partial<Pick<AgentRegistry, 'runtimes'>> | null | undefined, host: string, name: string, held: ObservedExhaustion, launched?: { home?: string; kind?: string }): { account: string; quota: QuotaObservation }[] | null {
  const login = registryLogin(registry, host, name);
  if (!registry || login && spentHere(held, login, launched)) return [{ account: name, quota: heldObservation(name, held) }];
  if (!held.resetsAt || !held.identity) return [];
  const twins = registry.accounts.filter(account => account.credential.host === host && account.quota.identity === held.identity);
  return twins.length ? twins.map(({ name: account, quota: { loggedIn, usage } }) => ({ account, quota: { loggedIn, usage, state: 'exhausted' as const, resetsAt: held.until, reason: twinReason(account, name, held), identity: held.identity } })) : null;
}
/**
 * What this host tells the registry of an account it probed (GY-1574): one a session here saw spent
 * reads as that hold, and one on the login of a hold with a known reset reads spent until that reset,
 * so no role's probe launches on, or clears the mark of, an account held here or held as a twin. A
 * same-named hold is the account's own only when it was spent in the account's home on its runtime
 * (`login`, the registry's, judged as spentHere judges it), whatever either login reads; one spent on
 * another home or runtime (a legacy configured environment named like the account) holds it only as a
 * twin of the same login.
 * With the account's home unknown, a hold naming another home and a known login other than the one
 * probed is not the account's either.
 */
export function heldOverlay(held: Record<string, ObservedExhaustion>, account: string, quota: QuotaObservation, login?: { home: string; kind?: string }, launched?: { home?: string; kind?: string }): QuotaObservation {
  const own = held[account];
  const ownHere = login ? spentHere(own, login, launched) : !!own && !(own.home && own.identity && quota.identity && own.identity !== quota.identity);
  if (ownHere) return heldObservation(account, own, quota);
  const twin = quota.identity ? Object.entries(held).find(([, entry]) => entry.resetsAt && entry.identity === quota.identity) : undefined;
  return twin ? { ...quota, state: 'exhausted', resetsAt: twin[1].until, reason: twinReason(account, twin[0], twin[1]) } : quota;
}
