// Concern: the provider login behind an account home, so accounts on one subscription are held together (GY-1573).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { QuotaObservation } from '../model/registry.js';
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
  ({ ...read, state: 'exhausted', session: true, resetsAt: held.until, reason: describeObservedExhaustion(environment, held).slice(0, 500), identity: !held.resetsAt ? null : held.identity !== undefined ? held.identity : read.identity });
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
 * A held account on the same provider login as `name` (GY-1573): one a session saw spent with a known
 * reset holds every configured environment logged in to that subscription until the same reset. The
 * spent login is the one recorded with the hold, so a source home logged in afresh since moves no
 * hold; a hold recorded before identities were, reads its home now. An environment whose identity is
 * unknown, or a hold with no reset, holds nothing beyond its own name. A login file that cannot be read
 * just now (a runtime mid-write) reads as `known`, the identity the environment log last recorded for it.
 */
export async function heldTwin(environments: readonly AgentEnvironment[], held: Record<string, ObservedExhaustion>, name: string, known: Record<string, { identity?: string | null }> = {}) {
  const candidates = Object.entries(held).filter(([other, entry]) => other !== name && entry.resetsAt);
  const read = async (environment: AgentEnvironment) => { const identity = await providerIdentity(environment.kind, environment.home); return identity === undefined ? known[environment.name]?.identity ?? null : identity; };
  const self = candidates.length ? environments.find(environment => environment.name === name) : undefined;
  const identity = self ? await read(self) : null;
  if (!identity) return null;
  for (const [other, entry] of candidates) {
    const twin = environments.find(environment => environment.name === other);
    const spent = entry.identity !== undefined ? entry.identity : twin ? await read(twin) : null;
    if (spent === identity) return { name: other, held: entry, reason: `${name} is the same provider login as ${describeObservedExhaustion(other, entry)}` };
  }
  return null;
}
