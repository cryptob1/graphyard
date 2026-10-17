// Concern: a project's application declarations, the cases bound to them, and the effective delivery defaults (GY-1901).
import { z } from 'zod';

// ---------------------------------------------------------------------------
// What a managed repository declares about the applications its cases exercise, in graphyard.json's
// `delivery` beside the merge gate: each application (a static site, or a Compose project), and
// which E2E case runs against which application. A change whose cases need an application gets a
// local preview of it; the rapid path's defaults (local previews, candidates of at most five changes,
// required verification of the exact live release) are what normal onboarding commits. Pure and
// browser-safe: the loaders below read the process only when it has one.
// ---------------------------------------------------------------------------

const relativePath = (what: string) => z.string().trim().min(1).max(300)
  .refine(path => !path.startsWith('/') && !path.split('/').some(segment => segment === '..') && !/[\s\u0000-\u001f]/.test(path), `${what} is a repository-relative path without .. segments or whitespace`);
const applicationId = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'An application id is 1-40 lowercase letters, digits or hyphens, starting with a letter or digit');

/** A static site: the directory its build writes, and the command that builds it (null: the directory is served as committed). */
export const staticApplicationSchema = z.object({ id: applicationId, kind: z.literal('static'), directory: relativePath('A static application directory'), build: z.string().trim().min(1).max(500).nullable().default(null) }).strict();
/** A Compose project: its file, the service that answers HTTP and that service's container port. */
export const composeApplicationSchema = z.object({ id: applicationId, kind: z.literal('compose'), file: relativePath('A Compose file'), service: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/, 'A Compose service name'), port: z.number().int().min(1).max(65535) }).strict();
export const applicationSchema = z.discriminatedUnion('kind', [staticApplicationSchema, composeApplicationSchema]);
export type Application = z.infer<typeof applicationSchema>;
export const applicationKinds = ['static', 'compose'] as const;

/** A case id as src/e2e/case.ts accepts it: lowercase letters, digits, ., _ and -, at most 100 characters. */
const boundCaseId = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export const previewModes = ['local', 'off'] as const;
export type PreviewMode = (typeof previewModes)[number];
/** The most changes one candidate holds. */
export const maxCandidateChanges = 5;

/** The fields `delivery` gains for the rapid path; every one optional, so a policy committed before them still parses. */
export const projectDeliveryShape = {
  /** `local`: a change whose bound cases need an application is previewed on this host; `off`: none is. */
  previews: z.enum(previewModes).optional(),
  candidateMaxChanges: z.number().int().min(1).max(maxCandidateChanges).optional(),
  /** Whether a promotion counts only once the exact live release is verified. */
  productionVerification: z.boolean().optional(),
  applications: z.array(applicationSchema).max(20).optional(),
  /** E2E case id → the application id it runs against. */
  cases: z.record(z.string().trim().regex(boundCaseId, 'A bound case id is the id of an e2e/cases/ID.json case: 1-100 lowercase letters, digits, ., _ or -'), z.string()).optional(),
};

/**
 * Why a declaration's applications and case bindings cannot be used, one actionable sentence each:
 * a duplicate application id, or a case bound to an application the policy does not declare, or —
 * when the repository's case ids are known — a binding to a case that does not exist.
 */
export function applicationProblems(declared: { applications?: Application[]; cases?: Record<string, string> }, caseIds?: readonly string[]): string[] {
  const problems: string[] = [];
  const ids = (declared.applications ?? []).map(application => application.id);
  for (const id of new Set(ids.filter((id, index) => ids.indexOf(id) !== index))) problems.push(`delivery.applications declares "${id}" more than once; give each application its own id`);
  for (const [caseId, application] of Object.entries(declared.cases ?? {})) {
    if (!ids.includes(application)) problems.push(`delivery.cases binds case "${caseId}" to application "${application}", which delivery.applications does not declare; ${ids.length ? `bind it to one of ${ids.join(', ')}` : 'declare the application first'}`);
    if (caseIds && !caseIds.includes(caseId)) problems.push(`delivery.cases binds case "${caseId}", but e2e/cases/${caseId}.json does not exist; bind an existing case or add it`);
  }
  return problems;
}

/** The repository's E2E case ids, from its file list. */
export const caseIdsOf = (files: readonly string[]) => files.flatMap(file => {
  const id = /^e2e\/cases\/([^/]+)\.json$/.exec(file)?.[1];
  return id && boundCaseId.test(id) ? [id] : [];
});

/**
 * The applications a scan finds: a Compose file at the root (its first service exposing a port), and
 * a static site — a `public/`, `site/` or `www/` directory holding HTML, or an index.html at the root —
 * when the repository holds one. Cases bind by evidence only: every case binds to the one
 * application a repository declares, and a case tagged with an application's id binds to it. A scan
 * skips build output (dist/, build/), so a built site is declared by hand.
 */
export function detectApplications(files: readonly string[], contents: Record<string, string>, buildCommand: string | null): { applications: Application[]; cases: Record<string, string> } {
  const applications: Application[] = [];
  const compose = ['compose.yml', 'compose.yaml', 'docker-compose.yml', 'docker-compose.yaml'].find(file => files.includes(file));
  if (compose) {
    const service = composeService(contents[compose] ?? '');
    if (service) applications.push({ id: 'app', kind: 'compose', file: compose, ...service });
  }
  const built = ['public', 'site', 'www'].find(directory => files.some(file => file.startsWith(`${directory}/`) && file.endsWith('.html')));
  if (built) applications.push({ id: 'site', kind: 'static', directory: built, build: buildCommand });
  else if (files.includes('index.html')) applications.push({ id: 'site', kind: 'static', directory: '.', build: null });
  const cases: Record<string, string> = {};
  for (const caseId of caseIdsOf(files)) {
    let tags: unknown[] = [];
    try { tags = JSON.parse(contents[`e2e/cases/${caseId}.json`] ?? '{}')?.tags ?? []; } catch { /* an unreadable case binds by the single-application rule only */ }
    const tagged = applications.find(application => Array.isArray(tags) && tags.includes(application.id));
    const bound = tagged ?? (applications.length === 1 ? applications[0] : null);
    if (bound) cases[caseId] = bound.id;
  }
  return { applications, cases };
}

/** The first Compose service publishing a port, read line by line (no YAML parser): its name and container port. */
function composeService(source: string): { service: string; port: number } | null {
  let inServices = false, service: string | null = null, inPorts = false;
  for (const line of source.split('\n')) {
    if (/^services:\s*$/.test(line)) { inServices = true; continue; }
    if (!inServices) continue;
    if (/^\S/.test(line)) break;
    const name = /^ {2}([a-zA-Z0-9][a-zA-Z0-9_.-]*):\s*$/.exec(line);
    if (name) { service = name[1]; inPorts = false; continue; }
    if (/^ {4}ports:\s*$/.test(line)) { inPorts = true; continue; }
    const port = inPorts && service ? /^\s+-\s*["']?(?:[\d.]+:)?(?:(\d+):)?(\d+)(?:\/tcp)?["']?\s*$/.exec(line) : null;
    if (port) return { service: service!, port: Number(port[2]) };
  }
  return null;
}

/** The delivery a project runs, every default resolved: what /api/status shows as `project.delivery`. */
export interface ProjectDelivery {
  mode: string;
  previews: PreviewMode;
  candidateMaxChanges: number | null;
  productionVerification: boolean;
  applications: Application[];
  cases: Record<string, string>;
  /** Where the declaration came from: the deployment variable, the checkout's graphyard.json, or none (the defaults). */
  source: 'environment' | 'graphyard.json' | 'default';
}

/**
 * The effective delivery of a declared `delivery` (null: the repository declares none). The local
 * mode, and a repository declaring nothing, get the rapid path's defaults; the release-candidate
 * and per-PR modes keep their own behaviour (no previews; candidates of any size, or none) unless
 * they declare a field.
 */
export function effectiveDelivery(declared: Record<string, any> | null | undefined, source: ProjectDelivery['source'] = 'graphyard.json'): ProjectDelivery {
  const mode = typeof declared?.mode === 'string' ? declared.mode : 'local';
  const rapid = mode === 'local';
  return {
    mode,
    previews: declared?.previews ?? (rapid ? 'local' : 'off'),
    candidateMaxChanges: declared?.candidateMaxChanges ?? (rapid ? maxCandidateChanges : mode === 'per-pr' ? 1 : null),
    productionVerification: declared?.productionVerification ?? mode !== 'per-pr',
    applications: declared?.applications ?? [],
    cases: declared?.cases ?? {},
    source: declared ? source : 'default',
  };
}

/** The deployment variable the control plane reads the project's delivery from: the image carries no graphyard.json. */
export const projectDeliveryVariable = 'GRAPHYARD_PROJECT_DELIVERY' as const;
const declarationKeys = ['mode', 'previews', 'candidateMaxChanges', 'productionVerification', 'applications', 'cases'] as const;
const declarationSchema = z.object({ mode: z.string().trim().min(1).max(40), ...projectDeliveryShape }).strict();

/** Checks a declaration and names every problem in one actionable error. */
function checked(value: unknown, where: string) {
  const parsed = declarationSchema.safeParse(value);
  if (!parsed.success) throw new Error(`${where} does not parse: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'delivery'}: ${issue.message}`).join('; ')}`);
  const problems = applicationProblems(parsed.data);
  if (problems.length) throw new Error(`${where}: ${problems.join('; ')}`);
  return parsed.data;
}

/** What an installer deploys as GRAPHYARD_PROJECT_DELIVERY: the declaration fields of a delivery policy, as compact JSON. */
export function projectDeliveryAssignment(policy: Record<string, unknown>) {
  const value = JSON.stringify(checked(Object.fromEntries(declarationKeys.filter(key => policy[key] !== undefined).map(key => [key, policy[key]])), 'delivery'));
  return { variable: projectDeliveryVariable, value };
}

/**
 * The project delivery a process serves: GRAPHYARD_PROJECT_DELIVERY when set, else the `delivery` of
 * graphyard.json at `root` (GRAPHYARD_REPOSITORY_ROOT, else the working directory), else the defaults.
 * A declaration that does not parse, or binds a case to an undeclared application, refuses with the reason.
 */
export function loadProjectDelivery(env: Record<string, string | undefined> = process.env, root?: string): ProjectDelivery {
  const raw = env[projectDeliveryVariable]?.trim();
  if (raw) {
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new Error(`${projectDeliveryVariable} must be JSON of graphyard.json's delivery mode, previews, candidateMaxChanges, productionVerification, applications and cases`); }
    return effectiveDelivery(checked(value, projectDeliveryVariable), 'environment');
  }
  const host = (globalThis as { process?: { cwd(): string; getBuiltinModule?(name: string): any } }).process;
  const fs = host?.getBuiltinModule?.('node:fs'), path = host?.getBuiltinModule?.('node:path');
  if (!fs || !path) return effectiveDelivery(null);
  let text: string;
  try { text = fs.readFileSync(path.resolve(root ?? env.GRAPHYARD_REPOSITORY_ROOT?.trim() ?? host!.cwd(), 'graphyard.json'), 'utf8'); } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return effectiveDelivery(null);
    throw error;
  }
  const delivery = (JSON.parse(text) as Record<string, any> | null)?.delivery;
  if (!delivery) return effectiveDelivery(null);
  return effectiveDelivery(checked(Object.fromEntries(declarationKeys.filter(key => delivery[key] !== undefined).map(key => [key, delivery[key]])), 'graphyard.json delivery'));
}

let inForce: ProjectDelivery | null = null;
/**
 * `project` on /api/status: the delivery this process serves, read once; a refusal is reported as
 * `error` (the defaults are then not claimed) rather than failing every status read.
 */
export function projectDelivery(): { delivery: ProjectDelivery | null; error?: string } {
  try { return { delivery: inForce ??= loadProjectDelivery() }; }
  catch (error: any) { return { delivery: null, error: String(error?.message ?? error) }; }
}
/** Replaces the delivery in force (a test); null reads it again on next use. */
export function setProjectDelivery(delivery: ProjectDelivery | null) { inForce = delivery; }
