import { once } from './store/mutations.js';
import { z } from 'zod';
import type pg from 'pg';
import { admin, demand, type Principal } from './model.js';
import { proofSchema } from './model-boundary/proof.js';
import { Engine } from './engine.js';
const name = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).max(150);
const revision = z.number().int().positive();
const base = { id: name, expectedRevision: z.number().int().min(0) };
const resourceNames = z.array(name).min(1).max(30).refine(a => new Set(a).size === a.length, 'Resources must be unique');
const ref = z.object({ id: name, revision }).strict();
export const definitionSchema = z.discriminatedUnion('kind', [
  // `delivery` is the environment's release policy: how recent a verified common interval
  // must be, and whether selecting an expected release needs a separate operator approval.
  // Absent, the defaults are the conservative ones.
  // `immutable: false` declares shared staging: a target other candidates and releases move
  // under a request. Such a target may only execute once an observer has independently
  // measured it running the candidate manifest; an immutable preview needs no such gate.
  z.object({ ...base, kind: z.literal('environment'), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), url: z.url().max(2000).refine(s => { const u = new URL(s); return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.search; }, 'Use HTTPS without credentials, query or fragment'), instance: name, immutable: z.boolean(), services: resourceNames, resources: resourceNames, delivery: z.object({ freshnessSeconds: z.number().int().min(30).max(86_400), approvalRequired: z.boolean(), automaticRollback: z.boolean().optional() }).strict().optional() }).strict(),
  // Observer and promoter registrations are D3's deployment identities: an observer reports
  // runtime facts for its named services only, a promoter may define and select the expected
  // release. `services` is required for both and refused for every other role.
  // A rollback registration is D4's executor identity: service-scoped like an observer, it
  // declares how its provider fences a mutation and whether it may act without an operator.
  z.object({ ...base, kind: z.literal('registration'), principalId: name, role: z.enum(['builder', 'observer', 'promoter', 'rollback']), environment: ref, adapterVersion: name, proofs: z.array(proofSchema).max(50), enabled: z.boolean(), services: resourceNames.optional(), rollback: z.object({ fencing: z.enum(['provider', 'serialized', 'none']), automatic: z.boolean() }).strict().optional() }).strict(),
]);
type DefinitionInput = z.infer<typeof definitionSchema>;
export type Definition = DefinitionInput & { revision: number; createdAt: string; createdBy: string };
export type Environment = Definition & { kind: 'environment' };
export type Registration = Definition & { kind: 'registration' };
export const deliveryPolicy = (environment: Environment) => ({ freshnessSeconds: 300, approvalRequired: true, automaticRollback: false, ...environment.delivery });
export type RollbackFencing = 'provider' | 'serialized' | 'none';

/** Shared deployment definitions retained after retiring the validation runner. */
export class Validation {
  constructor(readonly engine: Engine, readonly principals: Principal[], readonly repository: string) {}
  get store() { return this.engine.store; }
  async event(db: pg.PoolClient, actor: string, kind: string, payload: unknown, workId?: string) { await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [workId ?? null, actor, `validation.${kind}`, JSON.stringify(payload)]); }
  async definition(db: pg.PoolClient, kind: Definition['kind'], selected: { id: string; revision: number }, current = true): Promise<Definition> {
    const rows = (await db.query('SELECT document FROM validation_definitions WHERE kind=$1 AND id=$2 ORDER BY revision DESC', [kind, selected.id])).rows;
    const found = rows.find(r => r.document.revision === selected.revision)?.document as Definition | undefined;
    demand(found && (!current || rows[0].document.revision === selected.revision), 'Definition missing or authorization generation superseded');
    return found;
  }
  async registration(db: pg.PoolClient, selected: { id: string; revision: number }, role: Registration['role']): Promise<Registration> {
    const r = await this.definition(db, 'registration', selected) as Registration;
    const p = this.principals.find(p => p.id === r.principalId);
    demand(r.enabled && r.role === role && p && p.role === 'producer', 'Registration revoked or principal role is not authorized');
    // Environment revisions revoke old deployment authority too.
    await this.definition(db, 'environment', r.environment);
    return r;
  }
  async withReceipt(actor: Principal, command: string, data: unknown, key: string, fn: (db: pg.PoolClient, now: Date) => Promise<unknown>) {
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const receiptInput = { command: `validation.${command}`, data };
    return this.store.transaction(async (db, now) => once(db, actor, key, receiptInput, () => fn(db, now)));
  }

  async define(actor: Principal, input: unknown, key: string) {
    admin(actor); const data = definitionSchema.parse(input);
    return this.withReceipt(actor, 'define', data, key, async (db, now) => {
      const latest = (await db.query('SELECT revision FROM validation_definitions WHERE kind=$1 AND id=$2 ORDER BY revision DESC LIMIT 1', [data.kind, data.id])).rows[0]?.revision ?? 0;
      demand(latest === data.expectedRevision, 'Configuration generation changed');
      if (data.kind === 'environment') demand(data.repository === this.repository && !!this.repository, 'Environment repository is not managed');
      if (data.kind === 'registration') {
        await this.definition(db, 'environment', data.environment, data.enabled);
        const principal = this.principals.find(p => p.id === data.principalId);
        demand(!data.enabled || principal && principal.role === 'producer', 'Registration principal must have the appropriate separate role');
        if (data.role === 'observer' || data.role === 'promoter' || data.role === 'rollback') {
          const environment = await this.definition(db, 'environment', data.environment, false) as Environment;
          demand(!!data.services?.length && data.services.every(service => environment.services.includes(service)), 'Observer, promoter and rollback registrations must name services of their environment');
          demand(!data.proofs.length, 'Deployment identities carry no proof scope');
        } else demand(!data.services, 'Only observer, promoter and rollback registrations are service-scoped');
        if (data.role === 'rollback') {
          // An adapter that can neither fence the provider write nor observe its own operation
          // settle may still execute an operator-requested rollback behind the serialized
          // barrier; it can never be the one that decides to roll back.
          demand(!!data.rollback, 'Rollback registrations must declare their fencing and whether they may act automatically');
          demand(!data.rollback!.automatic || data.rollback!.fencing !== 'none', 'An unfenced rollback adapter cannot offer automatic rollback');
        } else demand(!data.rollback, 'Only rollback registrations declare rollback fencing');
      }
      const definition: Definition = { ...data, revision: latest + 1, createdAt: now.toISOString(), createdBy: actor.id };
      await db.query('INSERT INTO validation_definitions VALUES($1,$2,$3,$4)', [data.kind, data.id, definition.revision, JSON.stringify(definition)]);
      await this.event(db, actor.id, 'defined', { definition });
      return definition;
    });
  }
}
