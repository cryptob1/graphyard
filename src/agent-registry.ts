import { once } from './store/mutations.js';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, type Principal } from './model.js';
import type { Store } from './store.js';
import { registryRoles, RegistryError, chooseSession, emptyRegistry, fleetView, foldObservations, liveSessions, endRegistrySession, runOutcomes, refusalHistoryLimit, settleSessions, type AgentRegistry as RegistryDocument, type FleetSession, type RegistryMutation } from './model/registry.js';
import { applyRegistryMutation, registryMutationSchemas, observationRequestSchema, selectionRequestSchema } from './model-boundary/registry.js';
import { implementerProvider, type ReviewDiversity } from './model/review-diversity.js';
import { holdLimitNoticeAccount } from './model/account-quota.js';

/**
 * The agent registry as control-plane state.
 *
 * The registry is one aggregate kept on the append-only event ledger: every change — a
 * configuration mutation, a selection, a quota state an executor observed — appends one
 * `agent-registry.*` event that carries the change and the whole resulting document, and the
 * current registry is the document of the newest such event. That makes the ledger both the
 * state and its complete, attributable history, so the registry is carried by every logical
 * backup and needs no table of its own. The document is small (tens of kilobytes at most) and
 * events are appended only when something an eligibility decision reads has changed, never per
 * poll. Every write happens inside the store's coordination transaction, so a selection is
 * serialized against every other selection and mutation, across replicas and executor hosts.
 */
export const registryEventPrefix = 'agent-registry.';
const configurators = ['admin', 'coordinator'] as const;
const readers = ['admin', 'coordinator', 'reader', 'slice-lead'] as const;

export async function readRegistry(db: Pick<pg.PoolClient, 'query'>): Promise<RegistryDocument> {
  const row = (await db.query(`SELECT payload->'registry' AS registry FROM events WHERE work_id IS NULL AND kind LIKE '${registryEventPrefix}%' ORDER BY seq DESC LIMIT 1`)).rows[0];
  return row?.registry ?? emptyRegistry();
}

const appendRegistry = async (db: Pick<pg.PoolClient, 'query'>, actor: Principal, kind: string, registry: RegistryDocument, change: unknown) => {
  const removedRoles = registry.roles.filter(role => !registryRoles.includes(role.name)).map(role => role.name);
  if (removedRoles.length) {
    registry.roles = registry.roles.filter(role => registryRoles.includes(role.name));
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, `${registryEventPrefix}roles-retired`, JSON.stringify({ change: { removedRoles }, registry })]);
  }
  await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, `${registryEventPrefix}${kind}`, JSON.stringify({ change, registry })]);
  return removedRoles.length ? [`Removed retired roles: ${removedRoles.join(', ')}`] : [];
};

/**
 * A session ended on its provider's limit notice (GY-3096): the account it spent is marked exhausted
 * in the registry, with the notice and its reset, inside the caller's transaction that records the
 * exhaustion on the item — so no selection by any loop, restarted or not, hands it out before the reset.
 */
export async function recordLimitNoticeHold(db: Pick<pg.PoolClient, 'query'>, actor: Principal, notice: Parameters<typeof holdLimitNoticeAccount>[1], now: Date) {
  const registry = await readRegistry(db), at = now.toISOString();
  const account = holdLimitNoticeAccount(registry, notice, { actor: actor.id, at });
  if (!account) return null;
  registry.revision++; registry.updatedAt = at;
  await appendRegistry(db, actor, 'observed', registry, { limitNotice: { account, work: notice.work, role: notice.role, reason: notice.reason, resetsAt: notice.resetsAt } });
  return account;
}

export class AgentRegistry {
  constructor(private store: Store) {}

  private append(db: pg.PoolClient, actor: Principal, kind: string, registry: RegistryDocument, change: unknown) { return appendRegistry(db, actor, kind, registry, change); }
  /** The work items live sessions were launched for: all that session liveness reads. */
  private async sessionWork(db: Pick<pg.PoolClient, 'query'>, registry: RegistryDocument) {
    const keys = [...new Set(liveSessions(registry).map(session => session.work).filter((key): key is string => !!key))];
    if (!keys.length) return [];
    return (await db.query('SELECT w.document FROM work_index i JOIN work_items w ON w.id = i.id WHERE i.key = ANY($1::text[])', [keys])).rows.map(row => row.document);
  }

  /** The registry as status and the dashboard show it; `host` judges placement for that executor. */
  async view(actor: Principal, host: string | null = null) {
    demand((readers as readonly string[]).includes(actor.role), 'The agent registry is readable by admin, coordinator, slice-lead and reader identities', 403);
    return this.snapshot(host);
  }
  /** The same view for the status route, which has already authorized its caller. */
  async snapshot(host: string | null = null) {
    const { registry, at } = await this.settled();
    return fleetView(registry, Date.parse(at), host);
  }
  /** The stored document, for executors that need the launch contracts and credential references. */
  async document(actor: Principal) {
    demand((configurators as readonly string[]).includes(actor.role), 'Launch contracts and credential references are read by admin and coordinator identities', 403);
    return (await this.settled()).registry;
  }
  /**
   * The registry with every session whose lease or request has gone ended on the record (GY-974).
   * Every read the loop and status make goes through here, so a stale session stops counting at once
   * and its end is appended to registry history with its reason, without waiting for a selection
   * the role's full count would never let the loop ask for. A read that closes nothing appends
   * nothing and takes no coordination lock.
   */
  private async settled(): Promise<{ registry: RegistryDocument; at: string }> {
    const registry = await readRegistry(this.store.pool);
    const at = new Date((await this.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now).toISOString();
    if (!settleSessions(structuredClone(registry), await this.sessionWork(this.store.pool, registry), at).length) return { registry, at };
    return this.store.transaction(async (db, now) => {
      const current = await readRegistry(db), settledAt = now.toISOString();
      const closed = settleSessions(current, await this.sessionWork(db, current), settledAt);
      if (closed.length) {
        current.revision++; current.updatedAt = settledAt;
        await this.append(db, { id: 'graphyard', role: 'coordinator' }, 'sessions-settled', current, { ended: closed.map(session => ({ session: session.id, role: session.role, account: session.account, work: session.work, reason: session.endReason })) });
      }
      return { registry: current, at: settledAt };
    });
  }

  async history(actor: Principal, limit = 100) {
    demand((readers as readonly string[]).includes(actor.role), 'Registry history is readable by admin, coordinator, slice-lead and reader identities', 403);
    const bounded = z.number().int().min(1).max(500).parse(limit);
    // A refusal carries how often it repeated and when it was last seen (GY-3095).
    return (await this.store.pool.query(`SELECT e.seq,e.actor,e.kind,e.payload->'change' AS change,(e.payload->'registry'->>'revision')::int AS revision,e.created_at,r.count,r.last_at FROM events e
      LEFT JOIN registry_refusal_repeats r ON r.seq = e.seq WHERE e.work_id IS NULL AND e.kind LIKE '${registryEventPrefix}%' ORDER BY e.seq DESC LIMIT $1`, [bounded]))
      .rows.map(row => {
        const kind = String(row.kind).slice(registryEventPrefix.length), at = row.created_at.toISOString();
        return { seq: String(row.seq), at, actor: row.actor, kind, revision: row.revision, change: row.change,
          ...(kind === 'refused' ? { count: row.count ?? 1, lastSeenAt: row.last_at?.toISOString() ?? at } : {}) };
      });
  }

  /** One configuration change: validated, referentially whole, idempotent, appended with its reason. */
  async mutate(actor: Principal, kind: RegistryMutation, input: unknown, key: string) {
    demand((configurators as readonly string[]).includes(actor.role), 'The agent registry is configured by admin and coordinator identities', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    demand(kind in registryMutationSchemas, `Unknown registry change ${kind}`, 404);
    const receiptInput = { kind, input };
    return this.store.transaction(async (db, now) => once(db, actor, key, receiptInput, async () => {
      const current = await readRegistry(db);
      let applied: ReturnType<typeof applyRegistryMutation>;
      try { applied = applyRegistryMutation(current, kind, input, { actor: actor.id, at: now.toISOString() }); }
      catch (error) { if (error instanceof RegistryError) demand(false, error.message, 409); throw error; }
      const parsed = registryMutationSchemas[kind].parse(input);
      const attention = await this.append(db, actor, kind, applied.registry, { ...parsed, removed: applied.removed });
      const result = { attention, revision: applied.registry.revision, kind, removed: applied.removed, registry: fleetView(applied.registry, now.getTime()) };
      return result;
    }));
  }

  /**
   * Choose the session an executor's action runs on, and record the choice. The executor reports
   * what it just observed about the accounts on its own host; the registry folds that in, closes
   * sessions whose work has moved on, and picks the first eligible account of the role. A choice
   * appends `agent-registry.selected` with its reason; a refusal is recorded too, once per distinct
   * reason, so a loop that asks every few seconds does not flood the ledger with the same answer.
   */
  async select(actor: Principal, input: unknown, key: string) {
    demand((configurators as readonly string[]).includes(actor.role), 'Sessions are selected by the executor\'s coordinator identity (or an admin)', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const request = selectionRequestSchema.parse(input);
    const receiptInput = { kind: 'select', request };
    return this.store.transaction(async (db, now) => once(db, actor, key, receiptInput, async () => {
      const registry = await readRegistry(db), at = now.toISOString();
      let changed = settleSessions(registry, await this.sessionWork(db, registry), at).length > 0;
      // Its quotas and the smoke tests it ran (GY-446), for the logins on its own host only.
      if (foldObservations(registry, request, { actor: actor.id, at })) changed = true;
      const choice = chooseSession(registry, request, now.getTime(), await this.reviewDiversity(db, registry, request));
      let result: { selected: boolean; reason: string; skipped: typeof choice.skipped; session: FleetSession | null; account: unknown; runtime: unknown; model: unknown; policy?: unknown; revision: number };
      if (choice.account) {
        const session: FleetSession = { id: randomUUID(), role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: request.host, work: request.work, principal: request.principal, group: request.group,
          selectedAt: at, selectedBy: actor.id, reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
        registry.sessions.push(session); registry.revision++; registry.updatedAt = at;
        await this.append(db, actor, 'selected', registry, { session });
        // A role served past its own accounts says so in the registry history (GY-3092).
        if (choice.failover) await this.append(db, actor, 'failover', registry, { failover: { ...choice.failover, session: session.id, work: request.work } });
        result = { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
      } else {
        // The same request refused for the same reason as its own last refusal, with no session chosen
        // for it since, is a repeat (GY-3095): it raises that entry's count and last-seen time, and only
        // a different refusal appends a new entry, so loops asking for several requests in turn do not bury history.
        const last = registry.refusals.findLast(entry => entry.role === request.role && entry.host === request.host && entry.work === request.work);
        const repeated = !!last && last.reason === choice.reason
          && !registry.sessions.some(session => session.role === request.role && session.host === request.host && session.work === request.work && session.selectedAt > last.at);
        if (repeated) {
          await db.query(`INSERT INTO registry_refusal_repeats(seq,count,last_at) SELECT seq,2,$2 FROM events WHERE kind = '${registryEventPrefix}refused' AND created_at >= $1::timestamptz AND payload->'change'->'refusal'->>'at' = $3
            ORDER BY seq DESC LIMIT 1 ON CONFLICT (seq) DO UPDATE SET count = registry_refusal_repeats.count + 1, last_at = EXCLUDED.last_at`, [last.at, at, last.at]);
        } else registry.refusals = [...registry.refusals, { at, role: request.role, host: request.host, work: request.work, by: actor.id, reason: choice.reason, skipped: choice.skipped }].slice(-refusalHistoryLimit);
        if (!repeated || changed) { registry.revision++; registry.updatedAt = at; await this.append(db, actor, repeated ? 'observed' : 'refused', registry, repeated ? { host: request.host } : { refusal: registry.refusals.at(-1) }); }
        result = { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
      }
      return result;
    }));
  }

  /**
   * What an executor observed of the accounts on its own host, reported the moment a session sees one
   * spent rather than with its next selection (GY-1573), so an account on the same provider login is
   * refused on every host at once. Folded as a selection folds it; appends only on a change.
   */
  async observe(actor: Principal, input: unknown, key: string) {
    demand((configurators as readonly string[]).includes(actor.role), 'Observations are reported by the executor\'s coordinator identity (or an admin)', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const request = observationRequestSchema.parse(input);
    const receiptInput = { kind: 'observe', request };
    return this.store.transaction(async (db, now) => once(db, actor, key, receiptInput, async () => {
      const registry = await readRegistry(db), at = now.toISOString();
      const changed = foldObservations(registry, request, { actor: actor.id, at });
      if (changed) { registry.revision++; registry.updatedAt = at; await this.append(db, actor, 'observed', registry, { host: request.host }); }
      const result = { changed, revision: registry.revision };
      return result;
    }));
  }

  /**
   * What a reviewer choice needs to prefer another provider than the implementer's (GY-1496): the
   * newest worker session the registry retains for the item, else the newest one the ledger's
   * `agent-registry.selected` events record, else the item's last assignment's runtime. Null for
   * every other role, and when the implementer's provider is unknown.
   */
  private async reviewDiversity(db: Pick<pg.PoolClient, 'query'>, registry: RegistryDocument, request: { role: string; work: string | null }): Promise<ReviewDiversity | null> {
    if (request.role !== 'reviewer' || !request.work) return null;
    const ledger = registry.sessions.some(session => session.role === 'worker' && session.work === request.work) ? []
      // Bounded to the last fortnight by the (kind, created_at) index: no review follows a worker by longer.
      : (await db.query(`SELECT payload->'change'->'session' AS session FROM events WHERE kind = '${registryEventPrefix}selected' AND created_at > now() - interval '14 days'
          AND payload->'change'->'session'->>'role' = 'worker' AND payload->'change'->'session'->>'work' = $1 ORDER BY created_at DESC, seq DESC LIMIT 1`, [request.work])).rows.map(row => row.session);
    const work = ledger.length ? null : (await db.query('SELECT w.document FROM work_index i JOIN work_items w ON w.id = i.id WHERE i.key = $1', [request.work])).rows[0]?.document;
    const provider = implementerProvider(registry, request.work, ledger, work?.lastAssignment);
    return provider ? { work: request.work, provider } : null;
  }

  /** An executor whose launch failed gives the session back at once instead of waiting out the grace. */
  async endSession(actor: Principal, id: string, input: unknown, key: string) {
    demand((configurators as readonly string[]).includes(actor.role), 'Sessions are ended by the executor\'s coordinator identity (or an admin)', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    // A headless run's end says whether it produced a result (GY-446): runs of one role that end
    // without one, twice in a row, hold the account from that role.
    const data = z.object({ reason: z.string().trim().min(1).max(500), outcome: z.enum(runOutcomes).optional() }).strict().parse(input);
    return this.store.transaction(async (db, now) => {
      const registry = await readRegistry(db), session = registry.sessions.find(entry => entry.id === id);
      demand(session, 'Unknown session', 404);
      if (!endRegistrySession(registry, session, data.reason, data.outcome, now.toISOString())) return { session };
      registry.revision++; registry.updatedAt = now.toISOString();
      await this.append(db, actor, 'session-ended', registry, { session: session.id, account: session.account, reason: data.reason, ...(data.outcome ? { outcome: data.outcome } : {}) });
      return { session };
    });
  }
}
