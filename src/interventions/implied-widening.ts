// Concern: the paths a requirements revision adds that its own revised record already implies (GY-1719).
import type { Work } from '../model.js';
import { decideScopeRequest, pathScopeContains, type ItemDocumentation } from '../model/scope.js';
import type { FollowUpSource } from '../model/scope-companions.js';

/**
 * GY-1719: a requirements revision that widens plannedFiles only by what the revised record itself
 * grounds is no scope decision of the master's. `master requirements` derives plannedFiles from the
 * criteria it posts (derivePlannedFiles: the files a criterion names, the test file its proofs live
 * in, the docs-budget gate beside planned documentation, the timing baseline beside a planned test),
 * and a worker that asked for any of those would have had it granted by the engine's own rule
 * (`decideScopeRequest`, an approved autoscope) with nobody stepping in. The three review-stage
 * widenings GY-1719 links were each such a revision: GY-1717's AC-3 re-derivation added only the
 * docs-budget gate beside a granted docs page, GY-1700's AC-0 only the test its proof names, and
 * GY-1662's AC-4 the timing baseline and docs-budget gate beside its granted test and page, plus the
 * test its duplicate GY-1664 — closed into it — had already planned.
 *
 * `absorbed` is the plan of every item the record closes as a duplicate of this one: that scope was
 * resolved against the base when the duplicate was created, so carrying it in decides nothing new.
 * The judgement is the engine's rule over the revised criteria and the plan as it stood: true only
 * when the row carries those criteria and every added path is implied or absorbed. A review follow-up
 * carries its `origin` and `description`, so a path its findings name is implied here as the engine implies it.
 */
export function impliedWidening(revision: {
  added: readonly string[]; before: readonly string[]; criteria: unknown;
  documentation?: ItemDocumentation | null; absorbed?: readonly string[];
} & FollowUpSource): boolean {
  const { added, before, criteria, absorbed = [] } = revision;
  if (!added.length || !Array.isArray(criteria) || !criteria.every(entry => entry && typeof entry.id === 'string' && typeof entry.text === 'string')) return false;
  const rest = added.filter(path => !absorbed.some(planned => pathScopeContains(planned, path)));
  if (!rest.length) return true;
  const item = { plannedFiles: [...before, ...added.filter(path => !rest.includes(path))], criteria: criteria as Work['criteria'], documentation: revision.documentation ?? null, origin: revision.origin ?? null, description: revision.description ?? null };
  return decideScopeRequest(item, { paths: [...rest] }).state === 'approved';
}
