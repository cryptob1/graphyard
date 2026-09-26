import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { REDACTED, type PlannedPrincipal, type Role } from './types.js';

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

const principalRecordSchema = z.object({ id: z.string().min(1), role: z.enum(['admin', 'coordinator', 'worker', 'reader', 'producer']), proofs: z.array(z.string().min(1)).optional(), fingerprint: z.string().length(12) }).strict();
export const installRecordSchema = z.object({
  version: z.literal(1),
  installId: z.string().min(1),
  repository: z.string().min(1),
  provider: z.enum(['railway', 'hetzner', 'docker-host', 'compose', 'host']),
  /** The installation runs everything on its host (GY-717); its credentials live there, not here. */
  selfContained: z.boolean().default(false),
  /** The installation this one was moved from with --migrate, by fingerprint only. */
  migratedFrom: z.object({ provider: z.string().min(1), at: z.string().min(1), principals: z.array(z.object({ id: z.string().min(1), fingerprint: z.string().length(12) }).strict()) }).strict().nullable().default(null),
  baseBranch: z.string().min(1),
  reviewPolicy: z.enum(['github', 'agent']).default('github'),
  domain: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  principals: z.array(principalRecordSchema).default([]),
  github: z.object({ appId: z.number().int().positive(), installationId: z.number().int().positive(), slug: z.string().min(1), webhookFingerprint: z.string().length(12), ciAppIds: z.array(z.number().int().positive()).default([]) }).nullable().default(null),
  reviewers: z.array(z.object({ name: z.string().min(1), appId: z.number().int().positive(), botUserId: z.number().int().positive() })).default([]),
  profiles: z.array(z.object({ name: z.string().min(1), principal: z.string().min(1), kind: z.string().min(1), role: z.enum(['worker', 'reviewer', 'master']) })).default([]),
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

/** The exact value of GRAPHYARD_PRINCIPALS, matching the server's principal schema. */
export function principalsVariable(principals: PlannedPrincipal[], tokens: Map<string, string>) {
  return JSON.stringify(principals.map(principal => ({ id: principal.id, role: principal.role, ...(principal.proofs?.length ? { proofs: principal.proofs } : {}), token: tokens.get(principal.id) ?? '' })));
}

export function plannedPrincipals(installId: string, options: { workers?: number; producerProofs?: string[] } = {}): PlannedPrincipal[] {
  const workers = Math.min(Math.max(options.workers ?? 1, 1), 20);
  const proofs = [...new Set(options.producerProofs ?? [])].sort();
  return [
    { id: `${installId}-operator`, role: 'admin' as Role },
    { id: `${installId}-master`, role: 'coordinator' as Role },
    ...Array.from({ length: workers }, (_, index) => ({ id: `${installId}-worker-${index + 1}`, role: 'worker' as Role })),
    { id: `${installId}-dashboard`, role: 'reader' as Role },
    // A producer is created only with an explicit proof allowlist; an empty grant would
    // be a standing credential with no lane, and widening it later is never automatic.
    ...(proofs.length ? [{ id: `${installId}-ci`, role: 'producer' as Role, proofs }] : []),
  ];
}

/** Implementation sessions receive worker credentials only. */
export function workerPrincipals(principals: PlannedPrincipal[]) { return principals.filter(principal => principal.role === 'worker'); }
export function principalOfRole(principals: PlannedPrincipal[], role: Role) {
  const found = principals.find(principal => principal.role === role);
  if (!found) throw new Error(`The installation has no ${role} principal`);
  return found;
}

