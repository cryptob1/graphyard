import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store.js';
import { demand, type Principal } from './model.js';

/**
 * How wide a measured provider/repository clock bracket may be. This bounds how precisely
 * the offset is known, not how large it is: a provider whose clock is hours away from the
 * repository is still recorded exactly, because the collector measured where it stands.
 * A bracket wider than this was not measured carefully enough to attribute a deployment
 * to a repository instant, so it is refused rather than averaged into a guess. Twenty
 * seconds is the same precision merge verification demands of the GitHub offset.
 */
export const PRODUCTION_CLOCK_PRECISION_MS = 20_000;
/**
 * The furthest apart the two clocks may be said to stand. Beyond a month the reading is
 * not clock skew but a misconfigured collector or a replayed report, and normalizing by
 * it would move deployments across reporting windows wholesale.
 */
export const PRODUCTION_CLOCK_OFFSET_LIMIT_MS = 30 * 86_400_000;

const sha = z.string().regex(/^[0-9a-f]{40}$/i);
const offsetMs = z.number().int().min(-PRODUCTION_CLOCK_OFFSET_LIMIT_MS).max(PRODUCTION_CLOCK_OFFSET_LIMIT_MS);
const observationSchema = z.object({
  provider: z.string().trim().min(1).max(40), deploymentId: z.string().trim().min(1).max(200),
  status: z.enum(['succeeded', 'failed', 'superseded']), kind: z.enum(['deployment', 'rollback']),
  deployedAt: z.iso.datetime(),
  /**
   * The bracket, in milliseconds, within which the collector measured this provider's
   * clock to stand relative to the repository clock: repository instant = provider
   * timestamp + offset, with the true offset somewhere in [min, max]. The collector is
   * the only party that sees both clocks, so it measures the bracket the way merge
   * verification does - by reading one clock either side of a read of the other - and
   * reports it with every observation.
   */
  clockOffset: z.object({ min: offsetMs, max: offsetMs }).strict(),
  commitSha: sha.optional(), artifactDigest: z.string().trim().min(8).max(200).optional(),
  sourceUrl: z.url().max(2000), mergeShas: z.array(sha).max(500),
}).strict().superRefine((value, context) => {
  if (value.status === 'succeeded' && !value.commitSha && !value.artifactDigest) context.addIssue({ code: 'custom', path: ['commitSha'], message: 'A successful deployment needs an immutable commit or artifact digest' });
  if (value.status === 'succeeded' && value.kind === 'deployment' && !value.mergeShas.length) context.addIssue({ code: 'custom', path: ['mergeShas'], message: 'A successful deployment needs independently verified merge containment' });
  if (value.clockOffset.max < value.clockOffset.min) context.addIssue({ code: 'custom', path: ['clockOffset'], message: 'The clock offset bracket is inverted' });
  if (value.clockOffset.max - value.clockOffset.min > PRODUCTION_CLOCK_PRECISION_MS) context.addIssue({ code: 'custom', path: ['clockOffset'], message: `The clock offset must be measured to within ${PRODUCTION_CLOCK_PRECISION_MS / 1000} seconds` });
});

export class ProductionDelivery {
  constructor(private store: Store) {}
  /**
   * Deployment observation is its own trust lane. A producer credential alone is not
   * enough: acceptance collectors and build attestors also hold `producer`, and their
   * `proofs` allowlist confers no deployment authority, so a compromised test collector
   * would otherwise be able to forge production-delivery history it cannot forge
   * acceptance evidence for. The credential must carry an explicit deployment-observer
   * scope naming this exact provider, and that scope is never satisfied by widening a
   * proof allowlist. Configured empty or absent, the endpoint denies.
   *
   * The observation is carried onto the repository clock here, while the measured offset
   * is still in hand. Nothing downstream can recover it: a provider clock running behind
   * the repository makes a real post-merge deployment look like it preceded its own merge,
   * and one running ahead inflates every duration derived from it. Both bounds of the
   * bracket are stored, so a later comparison can tell a genuine ordering violation from
   * one that only reflects how precisely the two clocks were related.
   */
  async observe(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'producer', 'Only a trusted producer may record provider deployment observations', 403);
    demand(actor.deploymentProviders?.length, 'This credential carries no deployment-observer authority', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data = observationSchema.parse(input);
    demand(actor.deploymentProviders!.includes(data.provider), 'Deployment-observer authority does not cover this provider', 403);
    const fingerprint = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key was already used for another request'); return receipt.result; }
      const providerTime = Date.parse(data.deployedAt);
      const deployedAtRepository = new Date(providerTime + data.clockOffset.min);
      const deployedAtRepositoryMax = new Date(providerTime + data.clockOffset.max);
      // A deployment that has finished cannot lie in the repository's future. The earliest
      // bound is the one to test: if even that is still to come, the whole bracket is,
      // and no reading of the two clocks makes the report possible. A provider clock
      // running fast no longer loses the observation, because the negative offset it
      // measured carries the timestamp back where it belongs instead of being forgiven by
      // a fixed allowance.
      demand(deployedAtRepository.getTime() <= now.getTime(),
        'The earliest repository instant this deployment can have occurred at is still in the future', 400);
      const result = {
        id: randomUUID(), observedAt: now.toISOString(), ...data,
        deployedAtRepository: deployedAtRepository.toISOString(), deployedAtRepositoryMax: deployedAtRepositoryMax.toISOString(),
        mergeShas: [...new Set(data.mergeShas.map(value => value.toLowerCase()))],
      };
      await db.query(`INSERT INTO production_observations(id,provider,deployment_id,status,kind,deployed_at,observed_at,deployed_at_repository,deployed_at_repository_max,clock_offset_min_ms,clock_offset_max_ms,commit_sha,artifact_digest,source_url,producer,document)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [result.id, data.provider, data.deploymentId, data.status, data.kind, data.deployedAt, now, deployedAtRepository, deployedAtRepositoryMax, data.clockOffset.min, data.clockOffset.max, data.commitSha?.toLowerCase() ?? null, data.artifactDigest ?? null, data.sourceUrl, actor.id, result]);
      for (const mergeSha of result.mergeShas) await db.query('INSERT INTO production_observation_merges(observation_id,merge_sha,deployed_at,status,kind,deployed_at_repository,deployed_at_repository_max) VALUES($1,$2,$3,$4,$5,$6,$7)', [result.id, mergeSha, data.deployedAt, data.status, data.kind, deployedAtRepository, deployedAtRepositoryMax]);
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, result]);
      return result;
    });
  }
}
