import { z } from 'zod';
import { activeLease, demand, type Principal } from '../model.js';
import { pushCredentialBound, type MintedPushCredential } from '../worker-credential.js';
import type { Services } from './routes.js';

const pushCredentialRequest = z.object({ epoch: z.number().int().positive() }).strict();

/**
 * A worker session's push credential (GY-999), minted for the principal holding the item's live
 * lease and nobody else: an installation token of the control-plane App narrowed to this
 * repository and to `contents` and `pull_requests` write. The attempt's lease bound (its claim plus
 * the implementation time box) caps the credential's stated expiry, and nothing is minted past it
 * or for an epoch already submitted. The token is answered to the caller once and never stored.
 */
export async function issuePushCredential(services: Pick<Services, 'engine' | 'github' | 'repository'>, actor: Principal, id: string, input: unknown, now = new Date()): Promise<MintedPushCredential> {
  demand(actor.role === 'worker', 'Only the worker holding the item\'s lease may mint its push credential', 403);
  const parsed = pushCredentialRequest.safeParse(input);
  demand(parsed.success, 'A push credential request names the lease epoch: {"epoch": N}', 422);
  const { epoch } = parsed.data;
  const work = (await services.engine.store.list()).find(item => item.id === id || item.key === id);
  demand(work, 'Work not found', 404);
  activeLease(work, actor, epoch, now);
  demand(work.submission?.epoch !== epoch, `${work.key} epoch ${epoch} was submitted; its attempt pushes nothing more`);
  const bound = pushCredentialBound(work, actor.id, epoch);
  demand(bound !== null, `${work.key} records no claim of epoch ${epoch} by ${actor.id}, so no lease bound caps a credential`);
  demand(now.getTime() < bound, `${work.key} epoch ${epoch} has outrun its implementation time box; the loop ends the attempt, so no credential is minted for it`);
  demand(services.github, 'GitHub integration is required to mint a worker push credential', 503);
  const minted = await services.github.mintPushToken();
  return {
    key: work.key, epoch, repository: services.repository, token: minted.token, tokenExpiresAt: minted.expiresAt,
    expiresAt: new Date(Math.min(Date.parse(minted.expiresAt), bound)).toISOString(), leaseBound: new Date(bound).toISOString(), permissions: minted.permissions,
  };
}
