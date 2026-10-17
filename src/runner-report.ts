import { createHash } from 'node:crypto';
import { z } from 'zod';
const id = z.string().regex(/^[a-f0-9]{64}$/);
/**
 * Imported evidence links meet the artifact boundary (src/engine.ts): HTTP(S) and free of credentials.
 * A link names where the producer's record lives, which may need its own sign-in (a GitHub Actions
 * run of a private repository): it is never public proof.
 */
const evidenceLink = z.string().url().max(2000).refine(value => { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }, 'evidence links are HTTP(S) and carry no credentials');
const status = z.enum(['passed', 'failed', 'timedOut', 'skipped', 'interrupted']);
export const runnerReport = z.object({
  format: z.literal('graphyard-playwright-v1'),
  declared: z.array(z.object({ id, expected: status, location: z.object({ file: z.string().min(1).max(500).refine(p => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..') && !/[\x00-\x1f\x7f]/.test(p)), line: z.number().int().min(0), column: z.number().int().min(0) }).strict() }).strict()).max(10_000),
  executions: z.array(z.object({ id, status, retry: z.number().int().min(0).max(100) }).strict()).max(10_000),
  steps: z.array(z.object({ test: id, sequence: z.number().int().positive(), durationMs: z.number().finite().min(0), failed: z.boolean() }).strict()).max(10_000),
  errors: z.number().int().min(0), overflow: z.boolean(), status: z.enum(['passed', 'failed', 'timedout', 'interrupted']),
}).strict();
export function inventoryIdentity(input: unknown) {
  const report = runnerReport.parse(input);
  return createHash('sha256').update(JSON.stringify([...report.declared].sort((a,b) => a.id.localeCompare(b.id)))).digest('hex');
}
/** Use ONLY on bytes collected from the pinned, independently controlled execution boundary. */
export function verifyRunnerReport(inventory: unknown, execution: unknown) {
  const planned = runnerReport.parse(inventory), actual = runnerReport.parse(execution);
  const reasons: string[] = [];
  const declared = new Set(planned.declared.map(t => t.id)), executed = new Set(actual.executions.map(t => t.id));
  if (!declared.size || declared.size !== planned.declared.length || planned.executions.length || planned.errors || planned.overflow || planned.status !== 'passed') reasons.push('Approved test inventory is missing or inconsistent');
  if (planned.declared.some(t => t.expected !== 'passed')) reasons.push('Required inventory includes skipped or expected-failing tests');
  if (inventoryIdentity(planned) !== inventoryIdentity(actual)) reasons.push('Executed inventory differs from the enumerated approved suite');
  if (actual.executions.length !== executed.size || actual.executions.length !== declared.size || actual.executions.some(t => !declared.has(t.id) || t.retry !== 0)) reasons.push('Tests are missing, duplicated, unexpected or retried');
  if (actual.steps.some((s, i) => s.sequence !== i + 1 || !declared.has(s.test))) reasons.push('Step trace is inconsistent with the approved inventory');
  if (actual.status !== 'passed' || actual.errors || actual.overflow || actual.executions.some(t => t.status !== 'passed') || actual.steps.some(s => s.failed)) reasons.push('Behavior failed, was skipped, interrupted or not completely observed');
  return { passed: reasons.length === 0, inventoryComplete: !reasons.some(r => /inventory|missing|duplicated|inconsistent/.test(r)), executed: actual.executions.filter(t => t.status !== 'skipped').length, skipped: actual.executions.filter(t => t.status === 'skipped').length, reasons, report: actual };
}

// --- External run results (GY-1842, GY-1860) --------------------------------------------------

/**
 * The one documented format an external test system — Huck Engineer, a CI collector, a manual
 * harness — hands a whole run in through: the producer, the candidate head or deployed digest it
 * tested, and per case its id, verdict, attempts, duration and evidence links. A case's verdict is
 * one of `externalVerdicts`; `blocked` — the case could not run because a precondition or
 * environment was missing — is its own verdict carrying its reason, distinct from `unrun` (the run
 * never reached it), `skipped` (the producer chose not to run it; GY-1860) and `failed` (it ran and
 * failed). Beside the verdicts the format carries the run's provenance (GY-1860): the producer's
 * tool version, the catalog or source commit it ran from, and per run and per case the original
 * result value the tool reported, kept byte for byte beside the verdict it was mapped to, with
 * each evidence pointer's id kept byte for byte the same way (GY-1869). Like `runnerReport` the
 * schema refuses what it does not understand: unknown fields, an unknown verdict, a blocked case
 * without its reason, a case id or producer name with control characters, a result or evidence id
 * that is blank, over 200 characters or carries control characters, and a run naming neither
 * a head nor a digest are refused, never guessed or dropped.
 */
export const externalRunFormat = 'graphyard-external-run-v1';
export const externalVerdicts = ['passed', 'failed', 'flaky', 'blocked', 'unrun', 'skipped'] as const;
export type ExternalVerdict = (typeof externalVerdicts)[number];

const externalName = z.string().trim().min(1).max(200).refine(value => !/[\x00-\x1f\x7f]/.test(value));
/** A value kept byte for byte as the producer's tool gave it — a run or case result, an evidence pointer's id: refused when blank, over 200 characters or carrying control characters, else never trimmed. */
const verbatimValue = z.string().max(200).refine(value => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value));
/** A commit the producer names as provenance: hex, abbreviated or full, kept exactly as given. */
const provenanceCommit = z.string().regex(/^[a-f0-9]{7,64}$/);
/**
 * An opaque, authenticated pointer to evidence the producer keeps (GY-1860 N3): its evidence id —
 * kept byte for byte like a result, since it names a row of the producer's own records — and the
 * storage key it lives under, never turned into a URL.
 */
const evidencePointer = z.object({ evidenceId: verbatimValue.optional(), storageKey: z.string().min(1).max(1000).refine(value => !/[\x00-\x1f\x7f]/.test(value)).optional() }).strict()
  .refine(pointer => pointer.evidenceId !== undefined || pointer.storageKey !== undefined, 'an evidence pointer names its evidence id or storage key');

export const externalRun = z.object({
  format: z.literal(externalRunFormat),
  /** The external system that ran the cases, named so the record says who measured. */
  producer: externalName,
  /** The run's own id; absent, one is derived from the document so the same hand-in keeps one id. */
  runId: externalName.optional(),
  /** The candidate head the run tested (a 40-hex commit), when it tested a checkout. */
  sha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  /** The deployed digest the run tested (an image or bundle digest), when it tested a deployment. */
  digest: externalName.optional(),
  environment: externalName.optional(),
  /** The version of the producer's tool that measured the run. */
  toolVersion: externalName.optional(),
  /**
   * The commit of the case catalog or source the producer ran from. Provenance only: it says where
   * the cases came from, never which case-definition version executed — that is each case's own
   * `caseVersion`, null when the producer does not know it, and nothing is inferred from this.
   */
  catalogCommitSha: provenanceCommit.optional(),
  /** The run's overall result exactly as the producer's tool reported it, before any mapping. */
  result: verbatimValue.optional(),
  cases: z.array(z.object({
    id: externalName,
    verdict: z.enum(externalVerdicts),
    /** How many times the case was tried; omitted or null when the producer does not know (N1/N2), never filled in. */
    attempts: z.number().int().min(0).max(1000).nullable().optional(),
    durationMs: z.number().finite().min(0).nullable().optional(),
    /** How many rows the producer's report held for the case; a count of its own, never read as attempts. */
    reportRows: z.number().int().min(0).max(1_000_000).nullable().optional(),
    /** Required cases decide the release verdict; a case without the flag is optional. */
    required: z.boolean().optional(),
    /** Why a case could not run: demanded for `blocked`, the precondition or environment it missed. */
    reason: z.string().trim().min(1).max(1000).optional(),
    /** Where the run's own record of the case lives (trace, log, report): HTTP(S) links or opaque pointers. */
    evidence: z.array(z.union([evidenceLink, evidencePointer])).max(100).optional(),
    /** The case's result exactly as the producer's tool reported it, kept beside the verdict it maps to. */
    result: verbatimValue.optional(),
    /** The executed case-definition version, when the producer knows it. */
    caseVersion: externalName.optional(),
  }).strict()).max(10_000),
}).strict().superRefine((run, ctx) => {
  if (!run.sha && !run.digest) ctx.addIssue({ code: 'custom', path: [], message: 'the run names what it tested: give the candidate head `sha` or the deployed `digest`' });
  for (const [index, entry] of run.cases.entries()) if (entry.verdict === 'blocked' && !entry.reason)
    ctx.addIssue({ code: 'custom', path: ['cases', index, 'reason'], message: `blocked case ${entry.id} names why it could not run` });
});

/**
 * One imported case, with the import's defaults filled in: optional unless declared, no evidence,
 * and its provenance explicit — `result`, `caseVersion`, `attempts`, `durationMs` and `reportRows`
 * are null when the producer gave none, so a reader never mistakes an absent value for one.
 */
export interface ExternalCaseResult { id: string; verdict: ExternalVerdict; attempts: number | null; durationMs: number | null; reportRows: number | null; required: boolean; reason?: string; evidence: ExternalEvidence[]; result: string | null; caseVersion: string | null }
/** One piece of a case's evidence as the producer gave it: a link, or an opaque pointer (never a URL). */
export type ExternalEvidence = string | { evidenceId?: string; storageKey?: string };
export interface ExternalRunResult { producer: string; runId: string; sha?: string; digest?: string; environment?: string; toolVersion: string | null; catalogCommitSha: string | null; result: string | null; cases: ExternalCaseResult[] }

/**
 * Parse and normalise one external hand-in. Every verdict is kept exactly as the producer gave it;
 * nothing is read as anything else, and `skipped` stays skipped — never blocked or unrun. A run
 * without its own `runId` takes one derived from the document's content, so handing the same run in
 * twice binds to the same id and a changed one does not: the flaky acceptance of an imported run
 * binds to case, run id and exact head. `catalogCommitSha` is kept as provenance and never read
 * into a case's `caseVersion`.
 */
export function importExternalRun(input: unknown): ExternalRunResult {
  const run = externalRun.parse(input);
  return {
    producer: run.producer,
    runId: run.runId ?? `external-${createHash('sha256').update(JSON.stringify(run)).digest('hex').slice(0, 16)}`,
    ...(run.sha ? { sha: run.sha } : {}), ...(run.digest ? { digest: run.digest } : {}), ...(run.environment ? { environment: run.environment } : {}),
    toolVersion: run.toolVersion ?? null, catalogCommitSha: run.catalogCommitSha ?? null, result: run.result ?? null,
    cases: run.cases.map(entry => ({ id: entry.id, verdict: entry.verdict, attempts: entry.attempts ?? null, durationMs: entry.durationMs ?? null, reportRows: entry.reportRows ?? null, required: entry.required ?? false,
      ...(entry.reason ? { reason: entry.reason } : {}), evidence: entry.evidence ?? [], result: entry.result ?? null, caseVersion: entry.caseVersion ?? null })),
  };
}
