// Concern: the release filing credential (GY-1614) as a setup step the master runs itself (GY-1692).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { installDirectory, readToken } from '../install/secrets.js';
import { localTransport } from '../install/transport.js';
import { installIdFor } from '../install/types.js';
import { filingReason, followUpFilingExcess, followUpFilingRefusal, releaseFilingIdentity } from '../release-candidate.js';

/**
 * GY-1691 parked, as a decision only a human may make, the issue of the operator agent
 * `graphyard-release-follow-up` and the storing of its token as the uat environment's
 * GRAPHYARD_RELEASE_TOKEN: the secret predated the identity, so every failed candidate's filing was
 * refused and no follow-up or hold was filed. Neither is a person's decision: the identity is an
 * agent's, the install's admin credential is saved on this host (`graphyard install` writes the
 * operator token under the install directory), and the host's gh login administers the repository.
 * `master setup --apply`, which the loop runs itself, keeps the credential current: it issues the
 * identity when it is missing, reinstates it under a fresh credential when it was revoked (every
 * revoked credential stays revoked), narrows it to `intent:create` over this repository when it holds
 * more or less, and rotates it, storing the new token as the secret, when the secret is absent or not
 * proven newer than the credential the identity holds. A host that holds no admin credential reports
 * that, naming the administrator's one-time step, in the setup attention — never in a park.
 */
export const releaseFilingSecret = 'GRAPHYARD_RELEASE_TOKEN';
export const releaseFilingEnvironment = 'uat';
/** How long the credential a rotation replaces stays valid: a candidate workflow already running still files with it. */
export const releaseFilingTransitionSeconds = 3_600;
const setupReason = 'GY-1692: graphyard master setup --apply keeps the release filing credential current';

export type ReleaseFilingState = 'current' | 'provisioned' | 'reinstated' | 'rotated' | 'configured' | 'planned' | 'unavailable' | 'failed';
export interface ReleaseFilingStep { state: ReleaseFilingState; detail: string; next: string | null }
export interface ReleaseFilingAudit { at: string; variable: string; secret: true; fingerprint: string; source: string; provider: 'github'; service: string }
export interface ReleaseFilingDeps {
  /** The install's admin credential, or null when this host holds none; the install directory's operator token by default. */
  adminToken?: () => Promise<string | null>;
  fetch?: typeof fetch;
  /** Runs `gh ARGS` with INPUT on stdin and returns what it did; a failure is returned, never thrown. */
  gh?: (args: string[], input?: string) => Promise<{ code: number; stdout: string; stderr: string }>;
  token?: () => string; now?: () => number;
  /** One line per token stored: its fingerprint, never its value. */
  audit?: (entry: ReleaseFilingAudit) => Promise<void>;
  /** The master's own last handoff (`ReleaseFilingHandoff`), kept on this host; without one every secret is judged by time alone. */
  handoff?: { read: () => Promise<ReleaseFilingHandoff | null>; write: (handoff: ReleaseFilingHandoff) => Promise<void> };
}
/**
 * What the master's own handoff left: the fingerprint of the credential it stored and the `updated_at`
 * GitHub reported for that store. GitHub records a store to the second and the plane records a
 * rotation to the millisecond, so a store landing in the rotation's second cannot be ordered against
 * it by time: the record is the proof the master stored this credential, whatever second it landed in.
 */
export interface ReleaseFilingHandoff { at: string; fingerprint: string; secretUpdatedAt: string }

/** The install directory's operator (admin) token, or null when the install wrote none here. */
export async function installAdminToken(repository: string, home?: string): Promise<string | null> {
  const id = installIdFor(repository);
  try { return await readToken(installDirectory(id, home), `${id}-operator`); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null; throw error; }
}
const defaultGh: NonNullable<ReleaseFilingDeps['gh']> = async (args, input) => {
  const result = await localTransport().exec('gh', args, { allowFailure: true, ...(input === undefined ? {} : { input }) });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
};
const fingerprint = (token: string) => createHash('sha256').update(token).digest('hex').slice(0, 16);
export const releaseFilingSetupNext = 'graphyard master setup --apply';
/**
 * The administrator's step, named only when no agent on this host can take it. `operator-agent setup`
 * reads the token from standard input and prints the identity's document, never the token, so the
 * step mints one token first and hands that same value to both commands.
 */
export const releaseFilingAdministratorStep = (repository: string) =>
  `the administrator issues ${releaseFilingIdentity.id} once, minting one token and handing the same value to both commands: TOKEN=$(openssl rand -hex 32); printf %s "$TOKEN" | graphyard operator-agent setup FILE --token-stdin; printf %s "$TOKEN" | gh secret set ${releaseFilingSecret} --repo ${repository} --env ${releaseFilingEnvironment}; unset TOKEN (FILE as in docs/delivery.md#release-filing-credential; setup prints the identity's document, never its token)`;

/**
 * When the identity's newest credential was issued, which the uat secret must be at least as new
 * as: `credentialIssuedAt`, which the plane records at setup and rotate and keeps through configure
 * (src/operator-agent.ts). A document recorded before that field was kept has only its last
 * mutation: a configure after a rotation overwrote the rotation's instant, so the newest mutation
 * bounds the issue from above — a secret older than it is rotated once more than it had to be,
 * never read as current while it predates a rotation it cannot see.
 */
export const credentialIssuedAt = (document: { createdAt?: string; updatedAt?: string; credentialIssuedAt?: string; lastMutation?: { kind?: string; at?: string } | null }) =>
  document.credentialIssuedAt ?? document.lastMutation?.at ?? document.updatedAt ?? document.createdAt ?? null;
/**
 * Whether the secret is not proven newer than the credential. GitHub records a secret's `updated_at`
 * to the second: the store happened somewhere within that second, so it is proven to follow the
 * credential's issue only when its second begins after the issue's instant. A store within the
 * issue's second may have landed before the rotation (a token the administrator stored at
 * 06:30:00.100 against a rotation at 06:30:00.700 reads as 06:30:00) and is not proven: the
 * master's own stores are proven by its handoff record instead (`ReleaseFilingHandoff`), and a
 * store it did not make within that second is rotated once more rather than read as current.
 */
export const secretPredatesCredential = (secretUpdatedAt: string, issuedAt: string) =>
  Date.parse(secretUpdatedAt) <= Date.parse(issuedAt);
/** Whether the handoff record proves the stored secret is DOCUMENT's newest credential: the master stored that credential and GitHub still reports that store. */
export const handoffProvesSecret = (handoff: ReleaseFilingHandoff | null, document: { fingerprints?: string[] }, secret: { updatedAt: string } | null) =>
  !!handoff && !!secret && handoff.secretUpdatedAt === secret.updatedAt && handoff.fingerprint === document.fingerprints?.at(-1);

/**
 * Plan or apply the release filing credential for MASTER's repository (above). Nothing it returns
 * or audits carries a token; the admin credential is read for this call and never stored.
 */
export async function provisionReleaseFiling(master: { url: string; repository: string }, options: { apply: boolean }, deps: ReleaseFilingDeps = {}): Promise<ReleaseFilingStep> {
  const { repository } = master, identity = releaseFilingIdentity.id;
  const fetcher = deps.fetch ?? fetch, gh = deps.gh ?? defaultGh, now = deps.now ?? Date.now;
  const failed = (detail: string): ReleaseFilingStep => ({ state: 'failed', detail: detail.slice(0, 2000), next: releaseFilingSetupNext });
  let admin: string | null;
  try { admin = await (deps.adminToken ?? (() => installAdminToken(repository)))(); }
  catch (error) { return failed(`the install's admin credential could not be read: ${error instanceof Error ? error.message : String(error)}`); }
  if (!admin) {
    const step = releaseFilingAdministratorStep(repository);
    return { state: 'unavailable', detail: `no installation admin credential is saved under ${installDirectory(installIdFor(repository))}/tokens on this host, so the master cannot issue ${identity}: ${step}`, next: step };
  }
  const plane = async (path: string, body?: unknown) => {
    const response = await fetcher(`${master.url}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
    const result: any = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Graphyard refused ${path} (${response.status}): ${result?.error ?? 'unknown'}`);
    return result;
  };
  try {
    const agents: any[] = await plane('operator-agents');
    const document = agents.find(entry => entry?.id === identity) ?? null;
    // A revoked identity is reissued through setup, which reinstates it under a fresh credential (src/operator-agent.ts): every credential it held stays revoked.
    const revoked: { at: string; reason: string | null } | null = document?.revokedAt ? { at: document.revokedAt, reason: document.lastMutation?.kind === 'revoke' ? document.lastMutation.reason ?? null : null } : null;
    const current = revoked ? null : document;
    const actor = current ? { id: current.id, role: 'operator-agent', capabilities: current.capabilities, scope: current.scope } : null;
    const misfit = actor ? followUpFilingRefusal(actor, repository) ?? followUpFilingExcess(actor, repository) : null;
    const secret = await readSecret(gh, repository);
    const issuedAt = current ? credentialIssuedAt(current) : null;
    // The master's own store is proven by its handoff record; any other secret only by a second that begins after the credential's issue.
    const handoff = await deps.handoff?.read().catch(() => null) ?? null;
    const proven = !!current && handoffProvesSecret(handoff, current, secret);
    const stale = !!current && (!secret || (!proven && !!issuedAt && secretPredatesCredential(secret.updatedAt, issuedAt)));
    const scope = { repositories: [repository], workItems: ['*'] }, capabilities = [...releaseFilingIdentity.capabilities];
    const issue = revoked ? `reinstate ${identity}, revoked ${revoked.at}${revoked.reason ? ` (${revoked.reason})` : ''}, under a fresh credential holding only intent:create over ${repository}` : `issue ${identity} holding only intent:create over ${repository}`;
    const steps = [...(!current ? [`${issue} and store its token as the ${releaseFilingEnvironment} ${releaseFilingSecret}${secret ? ` (the one stored ${secret.updatedAt} predates the ${revoked ? 'credential' : 'identity'})` : ' (none is stored)'}`] : []),
      ...(misfit ? [`narrow ${identity} to intent:create over ${repository} alone (${misfit})`] : []),
      ...(stale ? [`rotate ${identity}'s credential and store the new token as the ${releaseFilingEnvironment} ${releaseFilingSecret} (${secret ? `the one stored ${secret.updatedAt} is not proven newer than the credential issued ${issuedAt}` : 'none is stored'})`] : [])];
    if (!steps.length) return { state: 'current', detail: `${identity} holds only intent:create over ${repository}, and the ${releaseFilingEnvironment} ${releaseFilingSecret} (stored ${secret!.updatedAt}) is ${proven ? `the credential the master stored (issued ${issuedAt})` : `newer than its credential (${issuedAt})`}`, next: null };
    if (!options.apply) return { state: 'planned', detail: `${releaseFilingSetupNext} would ${steps.join('; ')}`, next: releaseFilingSetupNext };
    if (misfit) await plane(`operator-agents/${encodeURIComponent(identity)}/configure`, { expectedRevision: current.revision, capabilities, scope, reason: setupReason });
    if (!current || stale) {
      const token = (deps.token ?? (() => randomBytes(32).toString('hex')))();
      if (current) await plane(`operator-agents/${encodeURIComponent(identity)}/rotate`, { token, transitionSeconds: releaseFilingTransitionSeconds, reason: setupReason });
      else await plane('operator-agents', { id: identity, displayName: 'Release follow-up', capabilities, scope, token, reason: `${filingReason}. ${setupReason}${revoked ? ` (reinstated after the revocation of ${revoked.at}${revoked.reason ? `: ${revoked.reason}` : ''})` : ''}` });
      const stored = await gh(['secret', 'set', releaseFilingSecret, '--repo', repository, '--env', releaseFilingEnvironment], token);
      const did = current ? 'rotated' : revoked ? 'reinstated' : 'provisioned';
      if (stored.code !== 0) return failed(`${identity} ${did} but storing ${releaseFilingSecret} in the ${releaseFilingEnvironment} environment of ${repository} failed (gh exited ${stored.code}): ${stored.stderr.trim() || stored.stdout.trim()}; the next run rotates it again`);
      await deps.audit?.({ at: new Date(now()).toISOString(), variable: releaseFilingSecret, secret: true, fingerprint: fingerprint(token), source: `operator agent ${identity} ${did} by ${releaseFilingSetupNext}`, provider: 'github', service: `${repository}/environments/${releaseFilingEnvironment}` });
      // The store is read back and recorded as the master's handoff, so the next run reads it current whatever second it landed in.
      const recorded = await recordHandoff(deps, gh, repository, fingerprint(token), now);
      return { state: did, detail: `${did} ${identity} (intent:create over ${repository}) and stored its token as the ${releaseFilingEnvironment} ${releaseFilingSecret} of ${repository} through gh${misfit ? `, narrowed first (${misfit})` : ''}${current ? `; the replaced credential stays valid ${releaseFilingTransitionSeconds / 60} minutes` : ''}${revoked ? `; every credential revoked ${revoked.at} stays revoked` : ''}${recorded ? '' : `; the handoff could not be recorded (${recorded === null ? 'gh did not report the store' : 'the record could not be written'}), so a store within the rotation's second is rotated once more by the next run`}`, next: null };
    }
    return { state: 'configured', detail: `narrowed ${identity} to intent:create over ${repository} alone (${misfit}); the ${releaseFilingEnvironment} ${releaseFilingSecret} is ${proven ? 'the credential the master stored' : 'newer than its credential'}`, next: null };
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Reads the store back and records it as the master's handoff: true when recorded, null when gh did
 * not report the secret, false when the record could not be written. Neither failure undoes the store.
 */
async function recordHandoff(deps: ReleaseFilingDeps, gh: NonNullable<ReleaseFilingDeps['gh']>, repository: string, tokenFingerprint: string, now: () => number): Promise<boolean | null> {
  if (!deps.handoff) return true;
  const after = await readSecret(gh, repository).catch(() => null);
  if (!after) return null;
  return deps.handoff.write({ at: new Date(now()).toISOString(), fingerprint: tokenFingerprint, secretUpdatedAt: after.updatedAt }).then(() => true, () => false);
}

/** The uat secret as GitHub records it (never its value): when it was last stored, or null when none is. */
async function readSecret(gh: NonNullable<ReleaseFilingDeps['gh']>, repository: string): Promise<{ updatedAt: string } | null> {
  const result = await gh(['api', `repos/${repository}/environments/${releaseFilingEnvironment}/secrets/${releaseFilingSecret}`]);
  if (result.code !== 0) {
    if (/\b404\b|not found/i.test(`${result.stderr} ${result.stdout}`)) return null;
    throw new Error(`gh could not read the ${releaseFilingEnvironment} ${releaseFilingSecret} of ${repository} (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim() || 'no output'}`);
  }
  let parsed: any;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error(`gh printed no JSON for the ${releaseFilingEnvironment} ${releaseFilingSecret} of ${repository}`); }
  const updatedAt = typeof parsed?.updated_at === 'string' ? parsed.updated_at : typeof parsed?.created_at === 'string' ? parsed.created_at : null;
  if (!updatedAt) throw new Error(`gh reported the ${releaseFilingEnvironment} ${releaseFilingSecret} of ${repository} without a timestamp`);
  return { updatedAt };
}
