import { z } from 'zod';
import { activeLease, demand, type Principal } from '../model.js';
import type { Work } from '../model.js';
import { pushCredentialBound, revokeInstallationToken, type MintedPushCredential, type TokenRevoker } from '../worker-credential.js';
import type { Services } from './routes.js';

const pushCredentialRequest = z.object({ epoch: z.number().int().positive() }).strict();

/** Refuses unless `actor` holds `work`'s live lease of an unsubmitted `epoch` still inside its time box; answers the lease bound. */
function mintable(work: Work | undefined, actor: Principal, epoch: number, now: Date): number {
  demand(work, 'Work not found', 404);
  activeLease(work, actor, epoch, now);
  demand(work.submission?.epoch !== epoch, `${work.key} epoch ${epoch} was submitted; its attempt pushes nothing more`);
  const bound = pushCredentialBound(work, actor.id, epoch);
  demand(bound !== null, `${work.key} records no claim of epoch ${epoch} by ${actor.id}, so no lease bound caps a credential`);
  demand(now.getTime() < bound, `${work.key} epoch ${epoch} has outrun its implementation time box; the loop ends the attempt, so no credential is minted for it`);
  return bound;
}

/**
 * A worker session's push credential (GY-999), minted for the principal holding the item's live
 * lease and nobody else: an installation token of the control-plane App narrowed to this
 * repository and to `contents` and `pull_requests` write. The attempt's lease bound (its claim plus
 * the implementation time box) caps the credential's stated expiry, and nothing is minted past it
 * or for an epoch already submitted. Minting waits on GitHub, so the lease is checked again once
 * the token exists (GY-1066): an attempt submitted, released or superseded meanwhile — or a lease
 * that lapsed — gets nothing, and the token is revoked. The token is answered to the caller once
 * and never stored.
 */
export async function issuePushCredential(services: Pick<Services, 'engine' | 'github' | 'repository'>, actor: Principal, id: string, input: unknown, now = new Date(), revoke: TokenRevoker = revokeInstallationToken): Promise<MintedPushCredential> {
  demand(actor.role === 'worker', 'Only the worker holding the item\'s lease may mint its push credential', 403);
  const parsed = pushCredentialRequest.safeParse(input);
  demand(parsed.success, 'A push credential request names the lease epoch: {"epoch": N}', 422);
  const { epoch } = parsed.data;
  const find = () => services.engine.store.workDocument(id);
  const work = await find();
  mintable(work, actor, epoch, now);
  demand(services.github, 'GitHub integration is required to mint a worker push credential', 503);
  const started = Date.now();
  const minted = await services.github.mintPushToken();
  let bound: number;
  try { bound = mintable(await find(), actor, epoch, new Date(now.getTime() + Date.now() - started)); }
  catch (error) {
    const revoked = await revoke(minted.token).then(() => true, () => false);
    if (!revoked) console.error(`${work!.key} epoch ${epoch}: a push credential minted after its lease moved could not be revoked; GitHub's expiry (${minted.expiresAt}) bounds it`);
    throw error;
  }
  return {
    key: work!.key, epoch, repository: services.repository, token: minted.token, tokenExpiresAt: minted.expiresAt,
    expiresAt: new Date(Math.min(Date.parse(minted.expiresAt), bound)).toISOString(), leaseBound: new Date(bound).toISOString(), permissions: minted.permissions,
  };
}
