import type { AgentRegistry, FleetAccount, FleetSession, SessionSkip } from './registry.js';
import type { AssignmentIdentity } from './work.js';

/**
 * Reviewer provider diversity (GY-1496). An implementer and a reviewer on the same model provider
 * share blind spots, so the registry's choice for role reviewer prefers an account on a different
 * provider than the one that implemented the item. Pure over the registry document and what the
 * service read about the item; src/model/registry-sessions.ts applies it inside chooseSession.
 */

/** A runtime's provider when nothing names a model provider: the kind its launch contract starts. */
const runtimeProvider = (registry: Pick<AgentRegistry, 'runtimes'>, runtime: string | null | undefined) =>
  !runtime ? null : registry.runtimes.find(entry => entry.name === runtime)?.launch.kind ?? runtime;
const modelProvider = (registry: Pick<AgentRegistry, 'models'>, model: string | null | undefined) =>
  registry.models.find(entry => entry.name === model)?.provider ?? null;

/** An account's provider: its model's provider, else its runtime's launch kind. */
export function accountProvider(registry: Pick<AgentRegistry, 'models' | 'runtimes'>, account: Pick<FleetAccount, 'model' | 'runtime'>): string | null {
  return modelProvider(registry, account.model) ?? runtimeProvider(registry, account.runtime);
}

/** A recorded session's provider: its account's, or, for an account since removed, what the session recorded. */
export function sessionProvider(registry: Pick<AgentRegistry, 'models' | 'runtimes' | 'accounts'>, session: Pick<FleetSession, 'account' | 'model' | 'runtime'>): string | null {
  const account = registry.accounts.find(entry => entry.name === session.account);
  return modelProvider(registry, session.model) ?? (account ? accountProvider(registry, account) : runtimeProvider(registry, session.runtime));
}

type WorkerSession = Pick<FleetSession, 'role' | 'work' | 'account' | 'model' | 'runtime' | 'selectedAt'>;
const newest = (sessions: readonly WorkerSession[], key: string) => sessions
  .filter(session => session.role === 'worker' && session.work === key)
  .sort((a, b) => Date.parse(b.selectedAt) - Date.parse(a.selectedAt))[0];

/**
 * The provider that implemented an item: that of the newest registry worker session for it — the
 * sessions the registry still retains first, then the `agent-registry.selected` ledger events the
 * service read for it — else the item's last assignment's runtime, else unknown (null).
 */
export function implementerProvider(registry: Pick<AgentRegistry, 'models' | 'runtimes' | 'accounts' | 'sessions'>, key: string,
  ledger: readonly WorkerSession[] = [], lastAssignment?: Pick<AssignmentIdentity, 'runtime'> | null): string | null {
  const session = newest(registry.sessions, key) ?? newest(ledger, key);
  if (session) return sessionProvider(registry, session);
  return runtimeProvider(registry, lastAssignment?.runtime);
}

/** What a reviewer choice knows about the item it reviews: its key and the provider that implemented it. */
export interface ReviewDiversity { work: string; provider: string }

/** The skip recorded for an eligible account passed over because it shares the implementer's provider. */
export const sharedProviderSkip = (account: string, diversity: ReviewDiversity): SessionSkip =>
  ({ account, reason: `${account} shares the implementer's provider ${diversity.provider} on ${diversity.work}` });

/**
 * The refusal when the only different-provider accounts that could serve are at their own session
 * limit: the review waits for one rather than running on the implementer's provider. Worded as a
 * full role, so the launch retries as at role capacity (src/fleet.ts roleAtCapacity).
 */
export const busyDifferentProvider = (role: string, diversity: ReviewDiversity, busy: SessionSkip[]) =>
  `role ${role} is at its concurrency limit for providers other than ${diversity.provider}: ${busy.map(entry => entry.reason).join('; ')}; ${diversity.work} waits for ${busy.length === 1 ? 'it' : 'one'} rather than a review on ${diversity.provider}`;

/** The reason recorded when the review falls back to the implementer's provider. */
export const sameProviderFallback = (diversity: ReviewDiversity, others: SessionSkip[]) =>
  `no reviewer account outside provider ${diversity.provider} can serve ${diversity.work}: ${others.length ? others.map(entry => entry.reason).join('; ') : 'none is configured for the role'}`;
