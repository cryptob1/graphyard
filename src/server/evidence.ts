import type pg from 'pg';
import type { DecisionAction } from '../model/approval.js';

type Db = pg.PoolClient;

/**
 * GY-1378: an evidence decision accepts a flaky result that was recorded — a failed attempt and a
 * later passing one of the case in that release run, both at that exact SHA — or nothing at all.
 * Checked when the decision is requested and again when it is approved.
 */
export async function flakyEvidence(db: Db, action: DecisionAction, input: Record<string, any>): Promise<string | null> {
  if (action !== 'evidence') return null;
  const prefix = `${input.runId}:attempt-`;
  const attempts = (await db.query(`SELECT document->'run'->>'id' AS run, document->>'result' AS result FROM scenario_runs
    WHERE scenario=$1 AND document->>'sha'=$2 AND document->'run'->>'kind'='e2e' AND left(document->'run'->>'id', length($3)) = $3`, [input.case, input.sha, prefix])).rows
    .map(row => ({ attempt: Number(String(row.run).slice(prefix.length)), result: row.result as string })).filter(entry => Number.isInteger(entry.attempt)).sort((a, b) => a.attempt - b.attempt);
  return attempts.length > 1 && attempts.at(-1)!.result === 'pass' && attempts.some(entry => entry.result === 'fail') ? null
    : `E2E case ${input.case} has no recorded flaky result in run ${input.runId} at ${input.sha}: an evidence decision accepts a failed attempt followed by a passing one, both recorded at that exact SHA`;
}

/**
 * The applied outcome of a decision that changes nothing about the item: a merge approval the
 * guarded merge still rechecks, or a release-ledger decision (GY-1378) the ledger reads.
 */
export function appliedOutcome(action: DecisionAction, input: Record<string, any>): string | null {
  if (action === 'merge') return `Merge of ${input.sha} onto ${input.baseSha} at policy revision ${input.policyRevision} approved; the guarded merge still rechecks every gate`;
  if (action === 'evidence') return `Flaky E2E case ${input.case} of run ${input.runId} accepted at ${input.sha} only`;
  if (action === 'fold') return `Release hold of outcome ${input.outcome} may fold into the hold of outcome ${input.into}`;
  return null;
}
