import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store.js';
import { demand, type Principal } from './model.js';

const sha = z.string().regex(/^[0-9a-f]{40}$/i);
const observationSchema = z.object({
  provider: z.string().trim().min(1).max(40), deploymentId: z.string().trim().min(1).max(200),
  status: z.enum(['succeeded', 'failed', 'superseded']), kind: z.enum(['deployment', 'rollback']),
  deployedAt: z.iso.datetime(), commitSha: sha.optional(), artifactDigest: z.string().trim().min(8).max(200).optional(),
  sourceUrl: z.url().max(2000), mergeShas: z.array(sha).max(500),
}).strict().superRefine((value, context) => {
  if (value.status === 'succeeded' && !value.commitSha && !value.artifactDigest) context.addIssue({ code: 'custom', path: ['commitSha'], message: 'A successful deployment needs an immutable commit or artifact digest' });
  if (value.status === 'succeeded' && value.kind === 'deployment' && !value.mergeShas.length) context.addIssue({ code: 'custom', path: ['mergeShas'], message: 'A successful deployment needs independently verified merge containment' });
});

export class ProductionDelivery {
  constructor(private store: Store) {}
  async observe(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'producer', 'Only a trusted producer may record provider deployment observations', 403);
    demand(key, 'Idempotency-Key is required', 400);
    const data = observationSchema.parse(input);
    const fingerprint = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key was already used for another request'); return receipt.result; }
      demand(Date.parse(data.deployedAt) <= now.getTime(), 'Deployment time cannot be in the future', 400);
      const result = { id: randomUUID(), observedAt: now.toISOString(), ...data, mergeShas: [...new Set(data.mergeShas.map(value => value.toLowerCase()))] };
      await db.query(`INSERT INTO production_observations(id,provider,deployment_id,status,kind,deployed_at,observed_at,commit_sha,artifact_digest,source_url,producer,document)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [result.id, data.provider, data.deploymentId, data.status, data.kind, data.deployedAt, now, data.commitSha?.toLowerCase() ?? null, data.artifactDigest ?? null, data.sourceUrl, actor.id, result]);
      for (const mergeSha of result.mergeShas) await db.query('INSERT INTO production_observation_merges(observation_id,merge_sha,deployed_at,status,kind) VALUES($1,$2,$3,$4,$5)', [result.id, mergeSha, data.deployedAt, data.status, data.kind]);
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, result]);
      return result;
    });
  }
}
