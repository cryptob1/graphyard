import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';

/**
 * The end-to-end case repository (GY-1351). A case is a JSON file under `e2e/cases/`, reviewed like
 * code: an id, a title, tags, a target (`uat`: it runs against UAT before every release; `any`: on
 * demand only) and ordered steps against the HTTP API and the dashboard. `graphyard e2e sync`
 * registers each case as a revision of the scenario of the same id (src/scenarios.ts), so editing a
 * case publishes a new immutable revision and `e2e:ID` proofs keep pinning the revision they named.
 *
 * Values may name `{{token}}` (the target's credential), `{{run}}` (this run's id), `{{case}}` and
 * any value an earlier http step saved; the runner (src/e2e/runner.ts) substitutes them.
 */
export const caseDirectory = 'e2e/cases';
export const caseRunner = 'graphyard-e2e';

const text = z.string().min(1).max(500);
const variable = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'a variable name is letters, digits and _');
/** One check on an http step's JSON answer, at a dotted path (`criteria.0.id`; empty is the whole body). */
const assertion = z.object({
  path: z.string().max(200),
  equals: z.unknown().optional(),
  exists: z.boolean().optional(),
  type: z.enum(['array', 'object', 'string', 'number', 'boolean', 'null']).optional(),
  /** An array holding an element that matches this partial object, or a string holding this text. */
  includes: z.unknown().optional(),
}).strict().refine(entry => ['equals', 'exists', 'type', 'includes'].filter(op => op in entry).length === 1, 'an assertion names exactly one of equals, exists, type or includes');
const httpStep = z.object({
  kind: z.literal('http'), name: text.optional(),
  method: z.enum(['GET', 'POST']), path: z.string().regex(/^\//, 'a path starts with /').max(500),
  body: z.unknown().optional(),
  status: z.number().int().min(100).max(599),
  expect: z.array(assertion).max(50).default([]),
  /** Values to keep for later steps: variable name → dotted path into the answer. */
  save: z.record(variable, z.string().max(200)).optional(),
}).strict();
const browserStep = z.object({
  kind: z.literal('browser'), name: text.optional(),
  action: z.enum(['open', 'click', 'fill', 'expectText']),
  path: z.string().regex(/^\//, 'a path starts with /').max(500).optional(),
  role: z.enum(['button', 'link', 'heading', 'navigation', 'tab', 'textbox']).optional(),
  label: text.optional(), text: text.optional(), value: z.string().max(2000).optional(),
  /** Match `text` exactly (the default) or as a substring of the accessible name or text. */
  exact: z.boolean().optional(),
}).strict().superRefine((step, context) => {
  const needs: Record<typeof step.action, (keyof typeof step)[]> = { open: ['path'], click: ['text'], fill: ['label', 'value'], expectText: ['text'] };
  for (const field of needs[step.action]) if (step[field] === undefined) context.addIssue({ code: 'custom', path: [field], message: `a browser ${step.action} step needs ${field}` });
});
const step = z.discriminatedUnion('kind', [httpStep, browserStep]);
export const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'an id is lower-case letters, digits, ., _ and -').max(100),
  title: z.string().min(1).max(200),
  description: z.string().min(1).max(2000).optional(),
  tags: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a tag is lower-case letters, digits and -').max(40)).max(20).default([]),
  target: z.enum(['uat', 'any']),
  steps: z.array(step).min(1).max(50),
}).strict().superRefine((entry, context) => {
  if (!entry.steps.some(s => s.kind === 'http' || s.action === 'expectText')) context.addIssue({ code: 'custom', path: ['steps'], message: 'a case checks something: at least one http step or browser expectText step' });
  entry.steps.forEach((s, index) => { if (JSON.stringify(s).length > 2000) context.addIssue({ code: 'custom', path: ['steps', index], message: 'a step is at most 2000 characters of JSON' }); });
});
export type E2eCase = z.infer<typeof caseSchema>;
export type E2eStep = E2eCase['steps'][number];
export interface CaseFile { file: string; definition: E2eCase }

/** `steps.2.status`, or `(case)` for the document itself. */
const fieldOf = (path: readonly PropertyKey[]) => path.length ? path.map(String).join('.') : '(case)';

/** Validate one case file's text, refusing a malformed case by naming the file and the field. */
export function parseCase(file: string, source: string): E2eCase {
  let raw: unknown;
  try { raw = JSON.parse(source); } catch (error) { throw new Error(`${file}: (case): not valid JSON: ${(error as Error).message}`); }
  const parsed = caseSchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues.map(issue => `${file}: ${fieldOf(issue.path)}: ${issue.message}`).join('\n'));
  const named = basename(file, extname(file));
  if (named !== parsed.data.id) throw new Error(`${file}: id: the case id ${JSON.stringify(parsed.data.id)} must match its file name ${JSON.stringify(named)}`);
  return parsed.data;
}

/** Every case under `directory` (relative to `root`), sorted by id; any malformed file refuses the whole read. */
export async function loadCases(root: string, directory = caseDirectory): Promise<CaseFile[]> {
  const names = (await readdir(join(root, directory))).filter(name => name.endsWith('.json')).sort();
  const errors: string[] = []; const cases: CaseFile[] = [];
  for (const name of names) {
    const file = `${directory}/${name}`;
    try { cases.push({ file, definition: parseCase(file, await readFile(join(root, file), 'utf8')) }); } catch (error) { errors.push((error as Error).message); }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return cases;
}

/** The cases a run selects: one id, every case with a tag, a target, or all of them. */
export function selectCases(cases: readonly CaseFile[], selector: { id?: string; tag?: string; target?: 'uat'; all?: boolean }) {
  if (selector.id) {
    const found = cases.filter(entry => entry.definition.id === selector.id);
    if (!found.length) throw new Error(`No E2E case ${selector.id} under ${caseDirectory}/`);
    return found;
  }
  if (selector.tag) return cases.filter(entry => entry.definition.tags.includes(selector.tag!));
  if (selector.target) return cases.filter(entry => entry.definition.target === selector.target);
  if (selector.all) return [...cases];
  throw new Error('Name a case, --tag TAG or --all');
}

/** A step in words, for the scenario registry and for naming a failing step. */
export function describeStep(step: E2eStep): string {
  if (step.name) return step.name;
  if (step.kind === 'http') return `${step.method} ${step.path}`;
  return { open: `open ${step.path}`, click: `click ${step.role ? `${step.role} ` : ''}"${step.text}"`, fill: `fill "${step.label}"`, expectText: `expect ${step.role ? `${step.role} ` : 'text '}"${step.text}"` }[step.action];
}

/**
 * The scenario definition a case registers as: the registry's own fields, with each step recorded
 * in full so any edit to a case — a step, a body, an assertion, a tag — is a new revision.
 */
export function scenarioDefinition({ file, definition }: CaseFile) {
  const expected = definition.steps.flatMap(s => s.kind === 'http'
    ? [`${s.method} ${s.path} answers ${s.status}`, ...s.expect.map(check => `${check.path || '(body)'} ${Object.entries(check).filter(([key]) => key !== 'path').map(([key, value]) => `${key} ${JSON.stringify(value)}`).join('')}`)]
    : s.action === 'expectText' ? [`the page shows ${s.role ? `${s.role} ` : ''}"${s.text}"`] : []);
  return {
    id: definition.id, title: definition.title, purpose: definition.description ?? definition.title,
    setup: [], steps: definition.steps.map(s => JSON.stringify(s)), expected: expected.slice(0, 50).map(line => line.slice(0, 2000)),
    environment: definition.target, runner: caseRunner, testPath: file, tags: definition.tags,
  };
}
export type CaseScenario = ReturnType<typeof scenarioDefinition>;

const definitionKeys = ['id', 'title', 'purpose', 'setup', 'steps', 'expected', 'environment', 'runner', 'testPath', 'tags'] as const;
/** Whether a registered revision is exactly this case's definition. */
export const sameDefinition = (revision: Record<string, unknown>, definition: CaseScenario) =>
  definitionKeys.every(key => JSON.stringify(revision[key] ?? (key === 'tags' ? [] : null)) === JSON.stringify(definition[key]));

/** The newest registered revision of a case that is exactly its current definition, or null when the case is not synced. */
export function registeredRevision(registry: readonly { id: string; revision: number }[], definition: CaseScenario): number | null {
  const match = registry.filter(entry => entry.id === definition.id && sameDefinition(entry as Record<string, unknown>, definition)).sort((a, b) => b.revision - a.revision)[0];
  return match?.revision ?? null;
}

export type Api = (path: string, data?: unknown, requestId?: string) => Promise<any>;
export interface SyncResult { id: string; revision: number; change: 'created' | 'revised' | 'unchanged' }

/**
 * Register every case as a scenario revision through the existing registry (`POST /api/scenarios`,
 * an operator's command). A case whose newest revision already matches is left alone; any other is
 * published on top of the newest revision, so the registry refuses a concurrent edit rather than
 * losing it, and earlier revisions — and the proofs that pin them — stay as they were.
 */
export async function syncCases(api: Api, cases: readonly CaseFile[]): Promise<SyncResult[]> {
  const registry: { id: string; revision: number }[] = await api('scenarios');
  const results: SyncResult[] = [];
  for (const entry of cases) {
    const definition = scenarioDefinition(entry);
    const latest = registry.filter(scenario => scenario.id === definition.id).sort((a, b) => b.revision - a.revision)[0];
    if (latest && sameDefinition(latest as Record<string, unknown>, definition)) { results.push({ id: definition.id, revision: latest.revision, change: 'unchanged' }); continue; }
    const published = await api('scenarios', { ...definition, expectedRevision: latest?.revision ?? 0 }, `e2e-sync:${definition.id}:${(latest?.revision ?? 0) + 1}`);
    results.push({ id: definition.id, revision: published.revision, change: latest ? 'revised' : 'created' });
  }
  return results;
}
