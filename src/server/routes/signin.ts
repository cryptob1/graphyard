import { createHash, timingSafeEqual } from 'node:crypto';
import { defineRoutes } from '../routes.js';
import type { Credential } from '../principals.js';

/** The ledger event that spends a sign-in claim: one per claim hash, ever. */
export const signinClaimedEvent = 'signin.claimed';
export const claimHashOf = (code: string) => createHash('sha256').update(code).digest('hex');

/** The deployed claim (GRAPHYARD_SIGNIN_CLAIM, a SHA-256) and the admin credential it yields; null when none is deployed. */
export function signinClaimFromEnv(env: NodeJS.ProcessEnv, credentials: Credential[]) {
  const hash = String(env.GRAPHYARD_SIGNIN_CLAIM ?? '').trim().toLowerCase();
  const admin = credentials.find(credential => credential.role === 'admin');
  return /^[a-f0-9]{64}$/.test(hash) && admin ? { hash, principal: admin.id, token: admin.token } : null;
}

/**
 * The single-use admin sign-in of a self-contained host (GY-717 AC-4). The installer prints a link
 * carrying a random claim and deploys only its SHA-256 (GRAPHYARD_SIGNIN_CLAIM); the dashboard
 * trades the claim for the admin credential here, once. The spend is recorded on the ledger inside
 * the coordination transaction, so a second use — or a race of two — is refused, and a restart or a
 * restored backup does not revive it. Nobody reads a token file or logs into the host to sign in.
 */
export const signinRoutes = defineRoutes('signin', [
  { method: 'POST', path: '/api/signin/claim', async handle({ body, services, send }) {
    const claim = services.signinClaim;
    if (!claim) return send(404, { error: 'This installation has no sign-in link; sign in with an admin token' });
    let code = '';
    try { code = String(JSON.parse((await body(4096)).toString('utf8'))?.code ?? ''); } catch { code = ''; }
    const presented = Buffer.from(claimHashOf(code));
    if (!code || !timingSafeEqual(presented, Buffer.from(claim.hash))) return send(401, { error: 'That sign-in link is not valid' });
    const spent = await services.engine.store.transaction(async db => {
      const used = await db.query(`SELECT 1 FROM events WHERE work_id IS NULL AND kind=$1 AND payload->>'claim'=$2 LIMIT 1`, [signinClaimedEvent, claim.hash]);
      if (used.rowCount) return false;
      await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [claim.principal, signinClaimedEvent, JSON.stringify({ claim: claim.hash })]);
      return true;
    });
    if (!spent) return send(410, { error: 'That sign-in link was already used; sign in with an admin token' });
    return { token: claim.token, principal: claim.principal };
  } },
]);
