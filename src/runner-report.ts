import { createHash } from 'node:crypto';
import { z } from 'zod';
const id = z.string().regex(/^[a-f0-9]{64}$/);
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
