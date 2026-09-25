import { createHash } from 'node:crypto';
import { z } from 'zod';
import type pg from 'pg';
import { demand, deploySmokeProof, deploySmokeRequired, grantPatternSchema, grantsAuthorize, ungrantableRoles, type Principal, type ProofAuthority, type ProofGrant, type Work } from './model.js';
import { save, type Store } from './store.js';

const principalId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/);
const reason = z.string().trim().min(1).max(2000);
const patterns = z.array(grantPatternSchema).min(1).max(50).refine(v => new Set(v).size === v.length, 'Grant patterns must be unique');
export const grantMutationSchema = z.object({ patterns, reason, expectedRevision: z.number().int().min(0).optional() }).strict();

/**
 * The environment allowlist is a bootstrap seed: it decides authority only until a grant
 * record exists for that principal. Every mutation materializes the seed first, so a later
 * environment edit can neither restore a revoked name nor add a new one without a redeploy
 * that Graphyard would then ignore anyway.
 */
export async function readGrant(db: pg.PoolClient, id: string, lock = false): Promise<ProofGrant | undefined> {
  return (await db.query(`SELECT document FROM proof_grants WHERE principal_id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0]?.document;
}
export async function effectiveAuthority(db: pg.PoolClient, actor: Principal): Promise<ProofAuthority> {
  if (actor.role === 'admin') return { principalId: actor.id, role: 'admin', patterns: ['manual:*'], source: 'role' };
  if (actor.role !== 'producer') return { principalId: actor.id, role: actor.role, patterns: [], source: 'role' };
  const record = await readGrant(db, actor.id);
  return record
    ? { principalId: actor.id, role: 'producer', patterns: record.patterns, source: 'grant' }
    : { principalId: actor.id, role: 'producer', patterns: actor.proofs ?? [], source: 'environment' };
}
/** The single authorization question every trusted-evidence path must ask. */
export async function authorizedForProof(db: pg.PoolClient, actor: Principal, proof: string): Promise<boolean> {
  if ((ungrantableRoles as readonly string[]).includes(actor.role)) return false;
  return grantsAuthorize((await effectiveAuthority(db, actor)).patterns, proof);
}
export async function authorizedForEveryProof(db: pg.PoolClient, actor: Principal, proofs: readonly string[]): Promise<boolean> {
  if (!proofs.length) return false;
  const authority = await effectiveAuthority(db, actor);
  return proofs.every(proof => grantsAuthorize(authority.patterns, proof));
}
/** Live authority for every known principal, for gap reporting and the operator dashboard. */
export async function authorityRegistry(db: pg.PoolClient, principals: readonly Principal[]): Promise<ProofAuthority[]> {
  const records: ProofGrant[] = (await db.query('SELECT document FROM proof_grants')).rows.map(r => r.document);
  return principals.filter(p => p.role === 'producer' || p.role === 'admin').map(p => {
    if (p.role === 'admin') return { principalId: p.id, role: p.role, patterns: ['manual:*'], source: 'role' as const };
    const record = records.find(r => r.principalId === p.id);
    return record
      ? { principalId: p.id, role: p.role, patterns: record.patterns, source: 'grant' as const }
      : { principalId: p.id, role: p.role, patterns: p.proofs ?? [], source: 'environment' as const };
  });
}
/**
 * Required proof names with no principal currently authorized to produce them. A manual proof the
 * work names in `producerProofs` is run by a producer session, never attested, so the admin role's
 * `manual:*` does not cover it: until a producer holds it, it is a gap the operator is asked to grant.
 */
export async function unauthorizedProofs(db: pg.PoolClient, principals: readonly Principal[], proofs: readonly string[], producerProofs: readonly string[] = []): Promise<string[]> {
  return gapsAgainst(await authorityRegistry(db, principals), proofs, producerProofs);
}
const gapsAgainst = (registry: readonly ProofAuthority[], proofs: readonly string[], producerProofs: readonly string[] = []) =>
  proofs.filter(proof => !registry.some(authority => (authority.role === 'producer' || !producerProofs.includes(proof)) && grantsAuthorize(authority.patterns, proof)));

/** The proof names whose authority a work item's stored `proofGaps` reports on. */
const gapProofs = (work: Work) => [...new Set(work.criteria.flatMap(ac => ac.proofs)), ...(deploySmokeRequired(work.policy) ? [deploySmokeProof] : [])];
/**
 * Recomputes the stored `proofGaps` of every open item against live authority after a grant or
 * revoke, so status stops asking for a grant that has already been applied (and names one a revoke
 * opened). Only the items whose gaps change are locked, in item order, and saved.
 */
async function refreshProofGaps(db: pg.PoolClient, principals: readonly Principal[], actor: string, now: Date) {
  const registry = await authorityRegistry(db, principals);
  const gapsOf = (work: Work) => gapsAgainst(registry, gapProofs(work), work.producerProofs);
  const open: Work[] = (await db.query("SELECT document FROM work_items WHERE document->>'stage' <> 'done' ORDER BY number")).rows.map(row => row.document);
  const changed: string[] = [];
  for (const work of open) if (JSON.stringify(gapsOf(work)) !== JSON.stringify(work.proofGaps ?? [])) changed.push(work.id);
  if (!changed.length) return;
  for (const row of (await db.query('SELECT document FROM work_items WHERE id = ANY($1::uuid[]) ORDER BY number FOR UPDATE', [changed])).rows) {
    const work: Work = row.document;
    const gaps = gapsOf(work);
    if (JSON.stringify(gaps) === JSON.stringify(work.proofGaps ?? [])) continue;
    work.proofGaps = gaps;
    await save(db, work, actor, 'proof-gaps.refreshed', now, { proofGaps: gaps });
  }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class ProofGrants {
  constructor(private store: Store, private principals: readonly Principal[] = []) {}

  /**
   * Materialize the environment allowlist once per producer so the live grant set is the
   * whole truth from the first request. Never overwrites an existing record, so a revoked
   * name is not resurrected by the next restart.
   */
  async seed(actor = 'bootstrap') {
    const seeded: ProofGrant[] = [];
    await this.store.transaction(async (db, now) => {
      for (const principal of this.principals.filter(p => p.role === 'producer')) {
        if (await readGrant(db, principal.id, true)) continue;
        seeded.push(await this.write(db, now, this.materialize(principal, now), 'seed', actor, 'Bootstrap seed from the deployment environment allowlist', principal.proofs ?? []));
      }
    });
    return seeded;
  }

  async list(actor: Principal) {
    demand(actor.role !== 'operator-agent', 'Grant inspection is not available to operator agents', 403);
    return this.store.transaction(async db => {
      const registry = await authorityRegistry(db, this.principals);
      const records: ProofGrant[] = (await db.query("SELECT document FROM proof_grants ORDER BY principal_id")).rows.map(r => r.document);
      // A producer is a subject of the grant set, not an administrator of it.
      const visible = actor.role === 'producer' ? (value: { principalId: string }) => value.principalId === actor.id : () => true;
      return { authorities: registry.filter(visible), grants: records.filter(visible) };
    });
  }

  async history(actor: Principal, id: string) {
    demand(actor.role === 'admin' || actor.role === 'coordinator' || actor.role === 'reader', 'Grant history inspection is not permitted for this role', 403);
    principalId.parse(id);
    return (await this.store.pool.query('SELECT seq,principal_id,document,created_at FROM proof_grant_history WHERE principal_id=$1 ORDER BY seq', [id]))
      .rows.map(row => ({ seq: Number(row.seq), principalId: row.principal_id, at: row.created_at.toISOString(), ...row.document }));
  }

  grant(actor: Principal, id: string, input: unknown, key: string) { return this.mutate(actor, 'grant', id, input, key); }
  revoke(actor: Principal, id: string, input: unknown, key: string) { return this.mutate(actor, 'revoke', id, input, key); }

  private materialize(principal: Principal, now: Date): ProofGrant {
    const seededFrom = [...new Set(principal.proofs ?? [])];
    return { principalId: principal.id, role: 'producer', patterns: seededFrom, revision: 0, createdAt: now.toISOString(), updatedAt: now.toISOString(), seededFrom,
      lastMutation: { kind: 'seed', actor: 'bootstrap', at: now.toISOString(), reason: 'Bootstrap seed from the deployment environment allowlist', patterns: seededFrom } };
  }

  private async write(db: pg.PoolClient, now: Date, record: ProofGrant, kind: ProofGrant['lastMutation']['kind'], actor: string, why: string, applied: string[]) {
    record.revision++;
    record.updatedAt = now.toISOString();
    record.lastMutation = { kind, actor, at: now.toISOString(), reason: why, patterns: applied };
    await db.query('INSERT INTO proof_grants(principal_id,document) VALUES($1,$2) ON CONFLICT(principal_id) DO UPDATE SET document=$2', [record.principalId, JSON.stringify(record)]);
    await db.query('INSERT INTO proof_grant_history(principal_id,document) VALUES($1,$2)', [record.principalId, JSON.stringify({ kind, actor, reason: why, patterns: applied, revision: record.revision, effective: record.patterns })]);
    return record;
  }

  private async mutate(actor: Principal, kind: 'grant' | 'revoke', id: string, input: unknown, key: string) {
    demand(actor.role === 'admin', 'Administrator permission required', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    principalId.parse(id);
    const data = grantMutationSchema.parse(input);
    const fingerprint = digest({ kind, target: id, input: data });
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result as ProofGrant; }
      const principal = this.principals.find(p => p.id === id);
      demand(principal, 'Unknown principal; proof authority follows a configured credential', 404);
      // Authority is bounded by role before it is bounded by name. Implementation workers,
      // readers, coordinators and operator agents can never hold a proof grant.
      demand(!(ungrantableRoles as readonly string[]).includes(principal.role), `A ${principal.role} principal can never hold proof authority`, 403);
      demand(principal.role === 'producer', `Proof grants apply to producer principals; ${principal.id} is ${principal.role}`, 403);
      const record = (await readGrant(db, id, true)) ?? this.materialize(principal, now);
      demand(data.expectedRevision === undefined || data.expectedRevision === record.revision, 'Grant revision changed; reload before mutating');
      const before = record.patterns;
      const after = kind === 'grant'
        ? [...new Set([...before, ...data.patterns])].sort()
        : before.filter(pattern => !data.patterns.includes(pattern)).sort();
      demand(JSON.stringify(after) !== JSON.stringify([...before].sort()),
        kind === 'grant' ? 'Every requested pattern is already granted' : 'None of the requested patterns is granted; revoke names an exact recorded pattern');
      record.patterns = after;
      const result = await this.write(db, now, record, kind, actor.id, data.reason, data.patterns);
      await refreshProofGaps(db, this.principals, actor.id, now);
      await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, `proof-grant.${kind}`, JSON.stringify({ target: id, patterns: data.patterns, reason: data.reason, effective: result.patterns, revision: result.revision })]);
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      return result;
    });
  }
}
