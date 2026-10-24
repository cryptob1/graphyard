import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { observeShaGrant, principalGrants, type PrincipalGrant } from '../server/principals.js';
import { REDACTED, type DeclaredSessionKind, type PlannedPrincipal, type Role } from './types.js';

/** 32 random bytes rendered base64url: 43 characters, far above the 32-character floor. */
export const generateToken = () => randomBytes(32).toString('base64url');
export const fingerprint = (secret: string) => createHash('sha256').update(secret).digest('hex').slice(0, 12);

/**
 * Every generated secret is registered here. All installer output — plan JSON, progress
 * lines, summaries, command echoes — passes through `scrub`, so a formatting mistake
 * degrades to `[redacted]` instead of disclosing a credential.
 */
export class Vault {
  private secrets = new Set<string>();
  add<T extends string>(secret: T): T { if (secret && secret.length >= 8) this.secrets.add(secret); return secret; }
  scrub<T>(value: T): T {
    if (typeof value === 'string') { let text: string = value; for (const secret of this.secrets) text = text.split(secret).join(REDACTED); return text as T & string; }
    if (Array.isArray(value)) return value.map(item => this.scrub(item)) as T;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.scrub(item)])) as T;
    return value;
  }
  exposes(text: string) { for (const secret of this.secrets) if (text.includes(secret)) return true; return false; }
  assertClean(text: string, where: string) { if (this.exposes(text)) throw new Error(`Refusing to emit ${where}: it contains a generated credential`); return text; }
  get size() { return this.secrets.size; }
}

/**
 * A roster entry (GY-1879): a planned principal with the lane grants it holds — each names one
 * lane the server checks by name (`external-runs:import` for POST /api/validation/import,
 * `delivery:observe-sha` for POST /api/delivery/observe-sha, GY-1912) and is
 * never a proof pattern — and, for one `graphyard principal add` registered, `source`, which every
 * later apply keeps; the installer's own entries carry none.
 */
export interface RosterPrincipal extends PlannedPrincipal { grants?: PrincipalGrant[]; source?: 'principal' }
const roles: Role[] = ['admin', 'coordinator', 'worker', 'reader', 'producer'];
/** One install.json roster entry: the principal, with its credential's fingerprint and never the credential. */
const principalRecordSchema = z.object({ id: z.string().min(1), role: z.enum(['admin', 'coordinator', 'worker', 'reader', 'producer']), proofs: z.array(z.string().min(1)).optional(), grants: z.array(z.enum(principalGrants)).optional(), sessionKind: z.enum(['human', 'ai']).optional(), source: z.literal('principal').optional(), fingerprint: z.string().length(12) }).strict();
export const installRecordSchema = z.object({
  version: z.literal(1),
  installId: z.string().min(1),
  repository: z.string().min(1),
  provider: z.enum(['compose', 'local']),
  /** The installation runs everything on its host (GY-717); its credentials live there, not here. */
  selfContained: z.boolean().default(false),
  /** The installation this one was moved from with --migrate, by fingerprint only. */
  migratedFrom: z.object({ provider: z.string().min(1), at: z.string().min(1), principals: z.array(z.object({ id: z.string().min(1), fingerprint: z.string().length(12) }).strict()) }).strict().nullable().default(null),
  baseBranch: z.string().min(1),
  reviewPolicy: z.enum(['github', 'agent']).default('github'),
  domain: z.string().nullable().default(null),
  /** The provider service install named (`--server-name`), so `master setup` finds that service again (GY-1416). */
  service: z.string().min(1).nullable().default(null),
  url: z.string().nullable().default(null),
  /** The coordinates `install --apply` reached the deployment with, so `principal add|remove` reaches the same one (GY-1879). */
  deployment: z.object({ sshHost: z.string().min(1).nullable(), sshUser: z.string().min(1), local: z.boolean(), port: z.number().int().positive().nullable(), image: z.string().min(1).nullable() }).strict().nullable().default(null),
  principals: z.array(principalRecordSchema).default([]),
  github: z.object({ appId: z.number().int().positive(), installationId: z.number().int().positive(), slug: z.string().min(1), webhookFingerprint: z.string().length(12), ciAppIds: z.array(z.number().int().positive()).default([]) }).nullable().default(null),
  /**
   * GY-1550: this installation was applied with `--no-github-app`. Master setup and
   * `derivedVariables` must not push a saved App registration onto the deployment.
   */
  noGithubApp: z.boolean().default(false),
  /**
   * GY-1901: the merger this installation chose, `control-plane` for one a non-observe install
   * created, so a retry before graphyard.json is committed still proposes the local mode. Null on a
   * record that predates it: that installation keeps the delivery model it had.
   */
  merger: z.enum(['control-plane', 'github']).nullable().default(null),
  /** GY-2941: this installation runs its own Herdr instance (`--herdr-instance`), so every redeploy composed from the record passes it again. */
  herdrInstance: z.boolean().default(false),
  reviewers: z.array(z.object({ name: z.string().min(1), appId: z.number().int().positive(), botUserId: z.number().int().positive() })).default([]),
  profiles: z.array(z.object({ name: z.string().min(1), principal: z.string().min(1), kind: z.string().min(1), role: z.enum(['worker', 'reviewer', 'master']) })).default([]),
  /** The release pipeline's deployment adapter and the plan actions --apply created for it (GY-1102). */
  release: z.object({ adapter: z.enum(['railway', 'command']), created: z.array(z.string()).default([]) }).strict().optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();
export type InstallRecord = z.infer<typeof installRecordSchema>;

export const configHome = (override?: string) => resolve(override ?? process.env.GRAPHYARD_CONFIG_HOME ?? resolve(homedir(), '.config/graphyard'));
export const installDirectory = (installId: string, override?: string) => resolve(configHome(override), installId);

/** Credentials never live inside the managed repository, its worktrees, or any Git checkout. */
export function assertOutsideRepository(directory: string, repositoryRoot: string | null) {
  if (!isAbsolute(directory)) throw new Error('The installation credential directory must be an absolute path');
  if (!repositoryRoot) return;
  const fromRoot = relative(resolve(repositoryRoot), directory);
  const inside = fromRoot === '' || (fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot));
  if (inside) throw new Error('Refusing to store installation credentials inside the managed repository');
}

async function atomicPrivate(file: string, content: string) {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
  await chmod(file, 0o600);
}

export async function prepareInstallDirectory(directory: string, repositoryRoot: string | null) {
  assertOutsideRepository(directory, repositoryRoot);
  await mkdir(resolve(directory, 'tokens'), { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700); await chmod(resolve(directory, 'tokens'), 0o700);
  return directory;
}

export const tokenFile = (directory: string, principal: string) => resolve(directory, 'tokens', `${principal}.token`);

export async function readToken(directory: string, principal: string) {
  const file = tokenFile(directory, principal);
  const info = await lstat(file);
  if (!info.isFile() || info.mode & 0o077) throw new Error(`${file} must be a regular file with mode 0600`);
  const value = (await readFile(file, 'utf8')).trim();
  if (value.length < 32) throw new Error(`${file} does not contain a usable credential`);
  return value;
}

/**
 * Idempotent: an existing principal keeps its token so re-apply never rotates live
 * credentials. With `create` false — the `--plan` path — a missing token is left missing
 * rather than generated, so planning writes nothing at all.
 */
export async function ensureTokens(directory: string, principals: PlannedPrincipal[], vault: Vault, create = true) {
  const tokens = new Map<string, string>();
  for (const principal of principals) {
    let token: string | null = null;
    try { token = await readToken(directory, principal.id); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
      if (create) { token = generateToken(); await atomicPrivate(tokenFile(directory, principal.id), `${token}\n`); }
    }
    if (token) tokens.set(principal.id, vault.add(token));
  }
  return tokens;
}

export async function readInstallRecord(directory: string): Promise<InstallRecord | null> {
  try { return installRecordSchema.parse(JSON.parse(await readFile(resolve(directory, 'install.json'), 'utf8'))); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function writeInstallRecord(directory: string, record: z.input<typeof installRecordSchema>, vault: Vault) {
  const serialized = JSON.stringify(installRecordSchema.parse(record), null, 2);
  vault.assertClean(serialized, 'install.json');
  const file = resolve(directory, 'install.json');
  try { await lstat(file); await atomicPrivate(`${file}.next`, serialized); await rename(`${file}.next`, file); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; await atomicPrivate(file, serialized); }
  return record;
}

/** A principal's own fields, in one order, so two entries compare by content. */
const principalFields = (principal: RosterPrincipal) => ({ id: principal.id, role: principal.role, ...(principal.sessionKind ? { sessionKind: principal.sessionKind } : {}), ...(principal.proofs?.length ? { proofs: principal.proofs } : {}), ...(principal.grants?.length ? { grants: principal.grants } : {}) });
/** The exact value of GRAPHYARD_PRINCIPALS, matching the server's principal schema. */
export function principalsVariable(principals: RosterPrincipal[], tokens: Map<string, string>) {
  return JSON.stringify(principals.map(principal => ({ ...principalFields(principal), token: tokens.get(principal.id) ?? '' })));
}
/** The install.json roster for `principals`: each entry with its credential's fingerprint, never the credential. */
export function principalRecords(principals: RosterPrincipal[], tokens: Map<string, string>) {
  return principals.map(principal => ({ ...principalFields(principal), ...(principal.source ? { source: principal.source } : {}), fingerprint: fingerprint(tokens.get(principal.id)!) }));
}
/** The roster install.json records, as principals: what an apply reconciles with and `graphyard principal` edits. */
export function recordedRoster(record: Pick<InstallRecord, 'principals'> | null): RosterPrincipal[] {
  return (record?.principals ?? []).map(entry => ({ ...principalFields(entry), ...(entry.source ? { source: entry.source } : {}) }));
}

/**
 * The roster an apply deploys (GY-1879): the planner's principals, then every recorded principal
 * `graphyard principal add` registered — with its role, kind, grants and, through its token file,
 * its credential — and, under observation-only, which plans no worker or producer, the ones an
 * earlier apply registered. An apply reconciles the roster and revokes nothing it did not plan;
 * only a full apply's own plan (`--workers`, `--producer-proof`) retires the installer's entries.
 */
export function reconcileRoster(planned: RosterPrincipal[], recorded: RosterPrincipal[], options: { observeOnly?: boolean } = {}): RosterPrincipal[] {
  // A registered entry whose id the plan now produces is refused, never replaced: its holder's token
  // would carry the planned role and proofs, widening a lane credential into authority nobody granted.
  const collision = recorded.find(entry => entry.source === 'principal' && planned.some(principal => principal.id === entry.id));
  if (collision) throw new Error(`${collision.id} is registered by graphyard principal add as ${collision.role}${collision.grants?.length ? ` with grants ${collision.grants.join(', ')}` : ''}, and this apply plans its own ${planned.find(principal => principal.id === collision.id)!.role} under the same id; nothing was written. Run graphyard principal remove ${collision.id} first, or apply without the option that plans it`);
  const kept = recorded.filter(entry => !planned.some(principal => principal.id === entry.id) && (entry.source === 'principal' || !!options.observeOnly));
  return [...planned, ...kept];
}

export const principalIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
/** Proof patterns `principal add --proof` accepts: the same lanes the installer seeds with `--producer-proof`. */
const proofPattern = /^(unit|integration|e2e|manual):[A-Za-z0-9._*:/-]+$/;
/**
 * One `graphyard principal add` entry, judged as `plannedPrincipals` judges the planner's: a
 * producer is created only with an explicit lane grant (`--grant`) or proof seed (`--proof`), since
 * an ungranted producer would be a standing credential with no lane; a grant names a producer lane
 * and a proof seed names proof authority, held by a producer, an admin or (for readings) a coordinator.
 */
export function rosterEntry(input: { id: string; role?: string; sessionKind?: string; grants?: string[]; proofs?: string[] }): RosterPrincipal {
  if (!principalIdPattern.test(input.id)) throw new Error('A principal id is 1 to 100 letters, digits, dots, underscores and dashes, starting with a letter or digit');
  const role = input.role as Role;
  if (!roles.includes(role)) throw new Error(`--role takes ${roles.join(', ')}`);
  const sessionKind = (input.sessionKind ?? 'ai') as DeclaredSessionKind;
  if (sessionKind !== 'ai' && sessionKind !== 'human') throw new Error('--session-kind takes ai or human');
  const grants = [...new Set(input.grants ?? [])].sort() as PrincipalGrant[];
  const proofs = [...new Set(input.proofs ?? [])].sort();
  const unknown = grants.filter(grant => !principalGrants.includes(grant));
  if (unknown.length) throw new Error(`Unknown grant ${unknown.join(', ')}; --grant takes ${principalGrants.join(', ')}`);
  const badProofs = proofs.filter(proof => !proofPattern.test(proof));
  if (badProofs.length) throw new Error(`Unknown proof ${badProofs.join(', ')}; --proof takes unit:*, integration:*, e2e:* or manual:* patterns`);
  if (role === 'producer' && !grants.length && !proofs.length) throw new Error(`A producer is created only with an explicit grant (--grant ${principalGrants.join('|')}) or proof seed (--proof unit:*|integration:*|e2e:*|manual:*): an ungranted producer would be a standing credential with no lane, and widening it later is never automatic`);
  if (role !== 'producer' && grants.length) throw new Error(`A grant names a producer lane; ${role} ${input.id} holds none. Use --role producer`);
  // A coordinator's patterns authorize only the loop's readings; evidence submission still refuses it.
  if (role !== 'producer' && role !== 'admin' && role !== 'coordinator' && proofs.length) throw new Error(`A proof seed names proof authority; ${role} ${input.id} holds none. Use --role producer, coordinator or admin`);
  if (grants.includes(observeShaGrant) && (grants.length > 1 || proofs.length)) throw new Error(`${observeShaGrant} is held by a dedicated observer principal, beside no other grant or proof; add a separate principal for it`);
  return { id: input.id, role, sessionKind, ...(proofs.length ? { proofs } : {}), ...(grants.length ? { grants } : {}), source: 'principal' };
}
/**
 * Place an existing credential at the install token path `ensureTokens` reads, so `principal add`
 * restores a former identity instead of minting a new secret the dispatcher's credential file would
 * not match (GY-1998). Refuses to overwrite a different standing token for the same id, and, for an
 * id the roster already records, any credential whose fingerprint differs from the recorded one: the
 * deployment serves that credential, so a lost token file is restored only with the same secret.
 * `created` is true when this call wrote the file.
 */
export async function importPrincipalToken(directory: string, principal: string, source: string, recorded: string | null = null) {
  const text = (await readFile(source, 'utf8')).trim();
  if (text.length < 32) throw new Error(`${source} does not contain a usable credential`);
  if (/[\r\n\0]/.test(text)) throw new Error(`${source} must be a single-line credential`);
  if (recorded && fingerprint(text) !== recorded) throw new Error(`${source} is not the credential install.json records for ${principal} (fingerprint ${recorded}), which the deployment serves; nothing was written. Import the matching credential, or run graphyard principal remove ${principal} and add it again`);
  const dest = tokenFile(directory, principal);
  try {
    const standing = (await readFile(dest, 'utf8')).trim();
    if (standing === text) return { path: dest, created: false };
    if (standing) throw new Error(`${dest} already holds a different credential for ${principal}; nothing was written. Import that credential instead, or run graphyard principal remove ${principal} and add it again with --token-file ${source}`);
  } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(resolve(directory, 'tokens'), { recursive: true, mode: 0o700 });
  await atomicPrivate(dest, `${text}\n`);
  return { path: dest, created: true };
}
const installersOwn = (roster: RosterPrincipal[], id: string) => {
  const existing = roster.find(principal => principal.id === id);
  if (existing && existing.source !== 'principal') throw new Error(`${id} is one of the installer's own principals; change it with graphyard install --apply (--workers, --producer-proof), not graphyard principal`);
  return existing;
};
/** `roster` with `entry` added or replaced by id; `changed` is false when the roster already held exactly it. */
export function upsertRosterEntry(roster: RosterPrincipal[], entry: RosterPrincipal) {
  const existing = installersOwn(roster, entry.id);
  if (existing && JSON.stringify(principalFields(existing)) === JSON.stringify(principalFields(entry))) return { roster, changed: false };
  // GY-1912: the observer lane never moves onto, or off, a standing credential: an import-only principal is never widened into an observer.
  const lanes = (principal: RosterPrincipal) => (principal.grants ?? []).join(',');
  if (existing && lanes(existing) !== lanes(entry) && [existing, entry].some(principal => principal.grants?.includes(observeShaGrant)))
    throw new Error(`${entry.id} holds ${existing.grants?.length ? existing.grants.join(', ') : 'no grant'}; ${observeShaGrant} is held by a dedicated principal, so add the observer under its own id rather than changing this one's grants`);
  return { roster: existing ? roster.map(principal => principal.id === entry.id ? entry : principal) : [...roster, entry], changed: true };
}
/** `roster` without `id`; `changed` is false when it held no such principal. */
export function removeRosterEntry(roster: RosterPrincipal[], id: string) {
  const existing = installersOwn(roster, id);
  return { roster: existing ? roster.filter(principal => principal.id !== id) : roster, changed: !!existing };
}

/** The principal the deployment's own end-to-end cases run as (GY-2167): the installer issues it with the rest of the roster. */
export const e2ePrincipalId = (installId: string) => `${installId}-e2e`;

export function plannedPrincipals(installId: string, options: { workers?: number; producerProofs?: string[] } = {}): PlannedPrincipal[] {
  const workers = Math.min(Math.max(options.workers ?? 1, 1), 20);
  const proofs = [...new Set(options.producerProofs ?? [])].sort();
  // The declared kind travels with the principal into GRAPHYARD_PRINCIPALS: the operator is a
  // human session — an undeclared admin is refused every human-only answer (delegation.ts
  // `sessionKind`), which would strand the needs-you requests the loop parks for the operator —
  // and every agent principal is ai. The operator attests manual proofs through its roster pattern.
  return [
    { id: `${installId}-operator`, role: 'admin' as Role, sessionKind: 'human' as DeclaredSessionKind, proofs: ['manual:*'] },
    // The master's pattern covers only the post-deploy readings the loop records; a coordinator submits no evidence.
    { id: `${installId}-master`, role: 'coordinator' as Role, sessionKind: 'ai' as DeclaredSessionKind, proofs: ['manual:*'] },
    ...Array.from({ length: workers }, (_, index) => ({ id: `${installId}-worker-${index + 1}`, role: 'worker' as Role, sessionKind: 'ai' as DeclaredSessionKind })),
    { id: `${installId}-dashboard`, role: 'reader' as Role, sessionKind: 'ai' as DeclaredSessionKind },
    // The e2e identity runs the deployment's own end-to-end cases (GY-2167): a case's first step
    // creates an item, and an admin is the roster role whose principal the create path admits.
    { id: e2ePrincipalId(installId), role: 'admin' as Role, sessionKind: 'ai' as DeclaredSessionKind },
    // A producer is created only with an explicit proof allowlist; an empty grant would
    // be a standing credential with no lane, and widening it later is never automatic.
    ...(proofs.length ? [{ id: `${installId}-ci`, role: 'producer' as Role, proofs, sessionKind: 'ai' as DeclaredSessionKind }] : []),
  ];
}

/** Implementation sessions receive worker credentials only. */
export function workerPrincipals(principals: PlannedPrincipal[]) { return principals.filter(principal => principal.role === 'worker'); }
export function principalOfRole(principals: PlannedPrincipal[], role: Role) {
  const found = principals.find(principal => principal.role === role);
  if (!found) throw new Error(`The installation has no ${role} principal`);
  return found;
}

