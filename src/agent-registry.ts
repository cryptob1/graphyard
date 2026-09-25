import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, type Principal } from './model.js';
import type { Store } from './store.js';
import { RegistryError, applyRegistryMutation, chooseSession, emptyRegistry, fleetView, foldObservation, liveSessions, refusalHistoryLimit, registryMutationSchemas, selectionRequestSchema, settleSessions, supersededByRequest,
  type AgentRegistry as RegistryDocument, type FleetSession, type RegistryMutation } from './model/registry.js';

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
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const configurators = ['admin', 'coordinator'] as const;
const readers = ['admin', 'coordinator', 'reader', 'slice-lead'] as const;

export async function readRegistry(db: Pick<pg.PoolClient, 'query'>): Promise<RegistryDocument> {
  const row = (await db.query(`SELECT payload->'registry' AS registry FROM events WHERE work_id IS NULL AND kind LIKE '${registryEventPrefix}%' ORDER BY seq DESC LIMIT 1`)).rows[0];
  return row?.registry ?? emptyRegistry();
}

export class AgentRegistry {
  constructor(private store: Store) {}

  private async append(db: pg.PoolClient, actor: Principal, kind: string, registry: RegistryDocument, change: unknown) {
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, `${registryEventPrefix}${kind}`, JSON.stringify({ change, registry })]);
  }
  /** The work items live sessions were launched for: all that session liveness reads. */
  private async sessionWork(db: Pick<pg.PoolClient, 'query'>, registry: RegistryDocument) {
    const keys = [...new Set(liveSessions(registry).map(session => session.work).filter((key): key is string => !!key))];
    if (!keys.length) return [];
    return (await db.query("SELECT document FROM work_items WHERE document->>'key' = ANY($1::text[])", [keys])).rows.map(row => row.document);
  }

  /** The registry as status and the dashboard show it; `host` judges placement for that executor. */
  async view(actor: Principal, host: string | null = null) {
    demand((readers as readonly string[]).includes(actor.role), 'The agent registry is readable by admin, coordinator, slice-lead and reader identities', 403);
    return this.snapshot(host);
  }
  /** The same view for the status route, which has already authorized its caller. */
  async snapshot(host: string | null = null) {
    const registry = await readRegistry(this.store.pool);
    const now = new Date((await this.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now);
    // A read settles a copy: sessions whose lease or request has gone stop counting at once, and
    // the next selection records their end.
    settleSessions(registry, await this.sessionWork(this.store.pool, registry), now.toISOString());
    return fleetView(registry, now.getTime(), host);
  }
  /** The stored document, for executors that need the launch contracts and credential references. */
  async document(actor: Principal) {
    demand((configurators as readonly string[]).includes(actor.role), 'Launch contracts and credential references are read by admin and coordinator identities', 403);
    return readRegistry(this.store.pool);
  }

  async history(actor: Principal, limit = 100) {
    demand((readers as readonly string[]).includes(actor.role), 'Registry history is readable by admin, coordinator, slice-lead and reader identities', 403);
    const bounded = z.number().int().min(1).max(500).parse(limit);
    return (await this.store.pool.query(`SELECT seq,actor,kind,payload->'change' AS change,(payload->'registry'->>'revision')::int AS revision,created_at FROM events WHERE work_id IS NULL AND kind LIKE '${registryEventPrefix}%' ORDER BY seq DESC LIMIT $1`, [bounded]))
      .rows.map(row => ({ seq: String(row.seq), at: row.created_at.toISOString(), actor: row.actor, kind: String(row.kind).slice(registryEventPrefix.length), revision: row.revision, change: row.change }));
  }

  /** One configuration change: validated, referentially whole, idempotent, appended with its reason. */
  async mutate(actor: Principal, kind: RegistryMutation, input: unknown, key: string) {
    demand((configurators as readonly string[]).includes(actor.role), 'The agent registry is configured by admin and coordinator identities', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    demand(kind in registryMutationSchemas, `Unknown registry change ${kind}`, 404);
    const fingerprint = digest({ kind, input });
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result; }
      const current = await readRegistry(db);
      let applied: ReturnType<typeof applyRegistryMutation>;
      try { applied = applyRegistryMutation(current, kind, input, { actor: actor.id, at: now.toISOString() }); }
      catch (error) { if (error instanceof RegistryError) demand(false, error.message, 409); throw error; }
      const parsed = registryMutationSchemas[kind].parse(input);
      await this.append(db, actor, kind, applied.registry, { ...parsed, removed: applied.removed });
      const result = { revision: applied.registry.revision, kind, removed: applied.removed, registry: fleetView(applied.registry, now.getTime()) };
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      return result;
    });
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
    const fingerprint = digest({ kind: 'select', request });
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result; }
      const registry = await readRegistry(db), at = now.toISOString();
      let changed = settleSessions(registry, await this.sessionWork(db, registry), at).length > 0;
      // The request supersedes the session it replaces before any limit is counted, so a relaunch
      // for the same work is never refused by its own dead predecessor.
      for (const superseded of supersededByRequest(registry, request)) {
        superseded.endedAt = at; superseded.endReason = `superseded by the ${request.role} session requested for ${request.work}`; changed = true;
      }
      for (const observed of request.observations) {
        const account = registry.accounts.find(entry => entry.name === observed.account);
        // An executor only vouches for the logins on its own host.
        if (!account || account.credential.host !== request.host) continue;
        if (foldObservation(account, observed.quota, { actor: actor.id, at })) changed = true;
      }
      const choice = chooseSession(registry, request, now.getTime());
      let result: { selected: boolean; reason: string; skipped: typeof choice.skipped; session: FleetSession | null; account: unknown; runtime: unknown; model: unknown; policy?: unknown; revision: number };
      if (choice.account) {
        const session: FleetSession = { id: randomUUID(), role: request.role, account: choice.account.name, runtime: choice.runtime.name, model: choice.model.name, host: request.host, work: request.work, principal: request.principal, group: request.group,
          selectedAt: at, selectedBy: actor.id, reason: choice.reason, skipped: choice.skipped, endedAt: null, endReason: null };
        registry.sessions.push(session); registry.revision++; registry.updatedAt = at;
        await this.append(db, actor, 'selected', registry, { session });
        result = { selected: true, reason: choice.reason, skipped: choice.skipped, session, account: choice.account, runtime: choice.runtime, model: choice.model, policy: choice.policy, revision: registry.revision };
      } else {
        const last = registry.refusals.at(-1);
        const repeated = !!last && last.role === request.role && last.host === request.host && last.work === request.work && last.reason === choice.reason;
        if (!repeated) registry.refusals = [...registry.refusals, { at, role: request.role, host: request.host, work: request.work, by: actor.id, reason: choice.reason, skipped: choice.skipped }].slice(-refusalHistoryLimit);
        if (!repeated || changed) { registry.revision++; registry.updatedAt = at; await this.append(db, actor, repeated ? 'observed' : 'refused', registry, repeated ? { host: request.host } : { refusal: registry.refusals.at(-1) }); }
        result = { selected: false, reason: choice.reason, skipped: choice.skipped, session: null, account: null, runtime: null, model: null, revision: registry.revision };
      }
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      return result;
    });
  }

  /** An executor whose launch failed gives the session back at once instead of waiting out the grace. */
  async endSession(actor: Principal, id: string, input: unknown, key: string) {
    demand((configurators as readonly string[]).includes(actor.role), 'Sessions are ended by the executor\'s coordinator identity (or an admin)', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data = z.object({ reason: z.string().trim().min(1).max(500) }).strict().parse(input);
    return this.store.transaction(async (db, now) => {
      const registry = await readRegistry(db), session = registry.sessions.find(entry => entry.id === id);
      demand(session, 'Unknown session', 404);
      if (session.endedAt) return { session };
      session.endedAt = now.toISOString(); session.endReason = data.reason;
      registry.revision++; registry.updatedAt = session.endedAt;
      await this.append(db, actor, 'session-ended', registry, { session: session.id, account: session.account, reason: data.reason });
      return { session };
    });
  }
}
