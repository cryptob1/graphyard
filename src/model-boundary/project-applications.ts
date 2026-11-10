import { z } from 'zod';
import { previewModes, maxCandidateChanges, boundCaseId, applicationProblems, declarationKeys, projectDeliveryVariable, type ProjectDelivery, effectiveDelivery } from '../model/project-applications.js';
// ---------------------------------------------------------------------------
// What a managed repository declares about the applications its cases exercise, in graphyard.json's
// `delivery` beside the merge gate: each application (a static site, a Compose project or a Node app), and
// which E2E case runs against which application. A change whose cases need an application gets a
// local preview of it; the rapid path's defaults (local previews, candidates of at most five changes,
// required verification of the exact live release) are what normal onboarding commits. Pure and
// browser-safe: the loaders below read the process only when it has one.
// ---------------------------------------------------------------------------

const relativePath = (what: string) => z.string().trim().min(1).max(300)
  .refine(path => !path.startsWith('/') && !path.split('/').some(segment => segment === '..') && !/[\s\u0000-\u001f]/.test(path), `${what} is a repository-relative path without .. segments or whitespace`);
/** Where the deployed application answers the commit it serves (JSON `commit` or `sha`, or plain text); Graphyard only reads it. */
const versionUrl = z.string().trim().url().max(500).refine(url => /^https?:/.test(url), 'A versionUrl is an http or https URL').optional();
/** Where the application, wherever Graphyard serves it, answers the commit it serves (JSON `commit`, `revision`, `sha` or `version`, or plain text): a path on its own origin, read by an e2e run against it before /healthz. */
const versionPath = z.string().trim().max(300).regex(/^\/(?!\/)[^?#\s]*$/, "A versionPath is a path starting with '/', without a query").optional();
const applicationId = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'An application id is 1-40 lowercase letters, digits or hyphens, starting with a letter or digit');

/** A static site: the directory its build writes, and the command that builds it (null: the directory is served as committed). */
export const staticApplicationSchema = z.object({ id: applicationId, kind: z.literal('static'), directory: relativePath('A static application directory'), build: z.string().trim().min(1).max(500).nullable().default(null), versionUrl, versionPath }).strict();
/** A Compose project: its file, the service that answers HTTP and that service's container port. */
export const composeApplicationSchema = z.object({ id: applicationId, kind: z.literal('compose'), file: relativePath('A Compose file'), service: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/, 'A Compose service name'), port: z.number().int().min(1).max(65535), versionUrl, versionPath }).strict();
/** A Node application (GY-3201): its directory, the command that builds it there (null: none) and the command that starts it there, listening on the PORT Graphyard assigns; the repository's install runs at its root first. */
export const nodeApplicationSchema = z.object({ id: applicationId, kind: z.literal('node'), directory: relativePath('A node application directory'), build: z.string().trim().min(1).max(500).nullable().default(null), start: z.string().trim().min(1).max(500), versionUrl, versionPath }).strict();
export const applicationSchema = z.discriminatedUnion('kind', [staticApplicationSchema, composeApplicationSchema, nodeApplicationSchema]);

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
