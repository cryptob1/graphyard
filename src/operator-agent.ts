import { createHash } from 'node:crypto';
import { z } from 'zod';
import { demand, operatorCapabilities, operatorCredentialHash, type Principal } from './model.js';
import type { Store } from './store.js';

const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/);
const reason = z.string().trim().min(1).max(2000);
const token = z.string().min(32).max(10000);
const scope = z.object({
  repositories: z.array(z.string().trim().min(1).max(300)).min(1).max(20),
  workItems: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
}).strict().refine(v => new Set(v.repositories).size === v.repositories.length && new Set(v.workItems).size === v.workItems.length, 'Scope entries must be unique');
const setupSchema = z.object({ id, displayName: z.string().trim().min(1).max(100), capabilities: z.array(z.enum(operatorCapabilities)).min(1).max(operatorCapabilities.length), scope, token, reason }).strict();
const rotateSchema = z.object({ token, transitionSeconds: z.number().int().min(0).max(86400), reason }).strict();
const revokeSchema = z.object({ reason }).strict();
const configureSchema = z.object({ expectedRevision: z.number().int().positive(), capabilities: z.array(z.enum(operatorCapabilities)).min(1).max(operatorCapabilities.length), scope, reason }).strict();

const digest = (secret: string) => createHash('sha256').update(secret).digest('hex');
const fingerprint = (secret: string) => digest(secret).slice(0, 16);
const publicDocument = (document: any) => ({ ...document, credentials: undefined });

export class OperatorAgents {
  constructor(private store: Store, private repository: string, private configuredPrincipals: { id: string; tokenHash: string }[] = []) {}

  async authenticate(secret: string): Promise<Principal | undefined> {
    if (!secret) return;
    const row = (await this.store.pool.query(`SELECT a.document,c.fingerprint FROM operator_credentials c JOIN operator_agents a ON a.id=c.agent_id
      WHERE c.token_hash=$1 AND c.revoked_at IS NULL AND c.valid_from<=clock_timestamp() AND (c.valid_until IS NULL OR c.valid_until>clock_timestamp())`, [digest(secret)])).rows[0];
    if (!row || row.document.revokedAt) return;
    const d = row.document;
    return { id: d.id, role: 'operator-agent', displayName: d.displayName, capabilities: d.capabilities, scope: d.scope, [operatorCredentialHash]: digest(secret) };
  }

  async revalidate(db: any, now: Date, actor: Principal): Promise<Principal> {
    const tokenHash = actor[operatorCredentialHash]; demand(tokenHash, 'Operator-agent credential context is missing', 401);
    const row = (await db.query(`SELECT a.document FROM operator_credentials c JOIN operator_agents a ON a.id=c.agent_id
      WHERE c.token_hash=$1 AND c.revoked_at IS NULL AND c.valid_from<=$2 AND (c.valid_until IS NULL OR c.valid_until>$2) FOR SHARE`, [tokenHash, now])).rows[0];
    demand(row && !row.document.revokedAt && row.document.id === actor.id, 'Operator-agent credential is revoked or expired', 401);
    const d = row.document;
    return { id: d.id, role: 'operator-agent', displayName: d.displayName, capabilities: d.capabilities, scope: d.scope, [operatorCredentialHash]: tokenHash };
  }

  async list(actor: Principal) {
    demand(actor.role === 'admin', 'Administrator permission required', 403);
    return (await this.store.pool.query('SELECT document FROM operator_agents ORDER BY document->>\'id\'')).rows.map(r => publicDocument(r.document));
  }

  async setup(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'admin', 'Administrator permission required', 403);
    const data = setupSchema.parse(input); this.validateRepository(data.scope.repositories);
    return this.mutate(actor, 'operator-agent.setup', data.id, key, data, async (db, now) => {
      demand(!(await db.query('SELECT 1 FROM operator_agents WHERE id=$1', [data.id])).rowCount, 'Operator agent already exists');
      demand(!this.configuredPrincipals.some(principal => principal.id === data.id), 'Principal ID is already configured');
      demand(!this.configuredPrincipals.some(principal => principal.tokenHash === digest(data.token)), 'Credential is already assigned to a configured principal');
      const document = { id: data.id, displayName: data.displayName, role: 'operator-agent', capabilities: data.capabilities, scope: data.scope, revision: 1, createdAt: now.toISOString(), updatedAt: now.toISOString(), revokedAt: null, lastMutation: { kind: 'setup', actor: actor.id, at: now.toISOString(), reason: data.reason }, fingerprints: [fingerprint(data.token)] };
      await db.query('INSERT INTO operator_agents(id,document) VALUES($1,$2)', [data.id, JSON.stringify(document)]);
      await db.query('INSERT INTO operator_credentials(agent_id,fingerprint,token_hash,valid_from) VALUES($1,$2,$3,$4)', [data.id, fingerprint(data.token), digest(data.token), now]);
      return publicDocument(document);
    });
  }

  async configure(actor: Principal, agentId: string, input: unknown, key: string) {
    demand(actor.role === 'admin', 'Administrator permission required', 403);
    const data = configureSchema.parse(input); this.validateRepository(data.scope.repositories);
    return this.mutate(actor, 'operator-agent.configure', agentId, key, data, async (db, now) => {
      const row = (await db.query('SELECT document FROM operator_agents WHERE id=$1 FOR UPDATE', [agentId])).rows[0]; demand(row, 'Operator agent not found', 404);
      const document = row.document; demand(!document.revokedAt, 'Operator agent is revoked'); demand(document.revision === data.expectedRevision, 'Operator-agent revision changed; reload before configuring');
      document.capabilities = data.capabilities; document.scope = data.scope; document.revision++; document.updatedAt = now.toISOString(); document.lastMutation = { kind: 'configure', actor: actor.id, at: now.toISOString(), reason: data.reason };
      await db.query('UPDATE operator_agents SET document=$2 WHERE id=$1', [agentId, JSON.stringify(document)]); return publicDocument(document);
    });
  }

  async rotate(actor: Principal, agentId: string, input: unknown, key: string) {
    demand(actor.role === 'admin', 'Administrator permission required', 403);
    const data = rotateSchema.parse(input);
    return this.mutate(actor, 'operator-agent.rotate', agentId, key, { ...data, token: undefined, tokenHash: digest(data.token) }, async (db, now) => {
      const row = (await db.query('SELECT document FROM operator_agents WHERE id=$1 FOR UPDATE', [agentId])).rows[0]; demand(row, 'Operator agent not found', 404);
      const document = row.document; demand(!document.revokedAt, 'Operator agent is revoked');
      const fp = fingerprint(data.token); demand(!document.fingerprints.includes(fp), 'Credential was already used');
      demand(!this.configuredPrincipals.some(principal => principal.tokenHash === digest(data.token)), 'Credential is already assigned to a configured principal');
      const until = new Date(now.getTime() + data.transitionSeconds * 1000);
      await db.query('UPDATE operator_credentials SET valid_until=LEAST(COALESCE(valid_until,$2),$2) WHERE agent_id=$1 AND revoked_at IS NULL', [agentId, until]);
      await db.query('INSERT INTO operator_credentials(agent_id,fingerprint,token_hash,valid_from) VALUES($1,$2,$3,$4)', [agentId, fp, digest(data.token), now]);
      document.fingerprints.push(fp); document.revision++; document.updatedAt = now.toISOString(); document.lastMutation = { kind: 'rotate', actor: actor.id, at: now.toISOString(), reason: data.reason, transitionEndsAt: until.toISOString() };
      await db.query('UPDATE operator_agents SET document=$2 WHERE id=$1', [agentId, JSON.stringify(document)]); return publicDocument(document);
    });
  }

  async revoke(actor: Principal, agentId: string, input: unknown, key: string) {
    demand(actor.role === 'admin', 'Administrator permission required', 403);
    const data = revokeSchema.parse(input);
    return this.mutate(actor, 'operator-agent.revoke', agentId, key, data, async (db, now) => {
      const row = (await db.query('SELECT document FROM operator_agents WHERE id=$1 FOR UPDATE', [agentId])).rows[0]; demand(row, 'Operator agent not found', 404);
      const document = row.document; demand(!document.revokedAt, 'Operator agent is already revoked');
      await db.query('UPDATE operator_credentials SET revoked_at=$2 WHERE agent_id=$1 AND revoked_at IS NULL', [agentId, now]);
      document.revokedAt = now.toISOString(); document.revision++; document.updatedAt = now.toISOString(); document.lastMutation = { kind: 'revoke', actor: actor.id, at: now.toISOString(), reason: data.reason };
      await db.query('UPDATE operator_agents SET document=$2 WHERE id=$1', [agentId, JSON.stringify(document)]); return publicDocument(document);
    });
  }

  private validateRepository(repositories: string[]) { demand(!!this.repository && repositories.includes(this.repository), 'Scope must explicitly include this configured repository'); }
  private async mutate(actor: Principal, kind: string, target: string, key: string, fingerprintInput: unknown, operation: (db: any, now: Date) => Promise<any>) {
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const fp = digest(JSON.stringify({ kind, target, input: fingerprintInput }));
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fp, 'Idempotency key reused with different input'); return receipt.result; }
      const result = await operation(db, now);
      await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, kind, JSON.stringify({ target, result })]);
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fp, JSON.stringify(result)]); return result;
    });
  }
}
