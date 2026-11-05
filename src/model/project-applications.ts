import type { z } from 'zod';
import type { applicationSchema } from '../model-boundary/project-applications.js';
export type Application = z.infer<typeof applicationSchema>;

/** A case id as src/e2e/case.ts accepts it: lowercase letters, digits, ., _ and -, at most 100 characters. */
export const boundCaseId = /^[a-z0-9][a-z0-9._-]{0,99}$/;

export const previewModes = ['local', 'off'] as const;
export type PreviewMode = (typeof previewModes)[number];
/** The most changes one candidate holds. */
export const maxCandidateChanges = 5;

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
export const declarationKeys = ['mode', 'previews', 'candidateMaxChanges', 'productionVerification', 'applications', 'cases'] as const;
