import type pg from 'pg';
import { currentEvidence, type Work } from './model.js';

export const SHIPPING_PULSE_WEEKS = 12;
export const SHIPPING_PULSE_LIMIT = 1000;
export const SHIPPING_PULSE_RECENT_LIMIT = 10;
export const SHIPPING_PULSE_PRODUCTION_LIMIT = 100;

export interface ShippingPulse {
  generatedAt: string;
  range: { start: string; end: string; weeks: number; semantics: 'repository-utc-inclusive' };
  completeness: 'complete' | 'partial';
  partialReason?: string;
  counts: { days7: number; days30: number };
  intentToMerge: { medianHours: number | null; sampleSize: number; excluded: number };
  prToProduction: {
    averageHours: number | null; medianHours: number | null; p90Hours: number | null;
    sampleSize: number; eligible: number; excluded: number; coveragePercent: number;
    sparse: boolean; exclusions: Record<string, number>;
    split: { prToMergeAverageHours: number | null; mergeToProductionAverageHours: number | null };
  };
  weeks: { start: string; end: string; count: number }[];
  recent: {
    key: string; title: string; pullRequest: number; mergeSha: string; mergedAt: string;
    quality: { passingProofs: number | null; requiredProofs: number | null; violations: string[]; unavailableReason?: string };
  }[];
}

/**
 * The immutable snapshot that authorized a delivery, located by the revision the
 * delivery record itself cites. Only the newest deliveries carry it, so the response
 * stays bounded.
 */
type AuthorizedSnapshot = Pick<Work, 'evidence' | 'criteria' | 'candidate' | 'policyRevision' | 'scenarioRequirements' | 'validation'>;

type DeliveryRow = {
  work_id: string; key: string; title: string; pull_request: number; merge_sha: string;
  merged_at: Date; intent_at: Date | null; authorized_work: AuthorizedSnapshot | null; delivery_violations: unknown;
  pr_created_at: Date | null; production_at: Date | null; production_matches: number; superseded_matches: number;
};

function startOfUtcWeek(date: Date) {
  const result = new Date(date);
  result.setUTCHours(0, 0, 0, 0);
  result.setUTCDate(result.getUTCDate() - ((result.getUTCDay() + 6) % 7));
  return result;
}

function median(values: number[]) {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

export const QUALITY_UNRESOLVED = 'The immutable snapshot that authorized this delivery is no longer in the retained ledger, so recorded proof totals are unknown.';

/**
 * Counts the proofs that actually authorized this delivery. Requirements, policy
 * revision, and evidence are read from the snapshot the delivery cites, never from the
 * work item as it stands now: an observation recorded after the operator revised
 * requirements carries the newer criteria, and reading those would restate a
 * historically authorized delivery as unproven. Evidence is then applied with the same
 * rules the merge gate used - exact candidate SHA, base SHA, policy revision,
 * validation selection, and scenario revision, unexpired as of the merge - so an
 * obsolete pass recorded against an earlier candidate is never counted. Violations stay
 * with the append-only delivery record, which also carries any violation the post-merge
 * comparison raised against that authorization.
 */
function deliveredQuality(snapshot: AuthorizedSnapshot | null, recorded: unknown, mergedAt: Date) {
  const violations = Array.isArray(recorded) ? recorded.filter(value => typeof value === 'string').slice(0, 10) : [];
  // An unresolvable authorization is unknown, never zero proofs passed out of zero required.
  if (!snapshot) return { passingProofs: null, requiredProofs: null, violations, unavailableReason: QUALITY_UNRESOLVED };
  const required = [...new Set((snapshot.criteria ?? []).flatMap(criterion => criterion.proofs ?? []))];
  const work = { ...snapshot, evidence: snapshot.evidence ?? [] } as Work;
  const passed = required.filter(proof => {
    const evidence = currentEvidence(work, proof, mergedAt);
    return !!evidence && evidence.result === 'pass' && evidence.executed > 0 && evidence.skipped === 0;
  });
  return { passingProofs: passed.length, requiredProofs: required.length, violations };
}

function rounded(value: number | null) { return value === null ? null : Math.round(value * 10) / 10; }
function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function p90(values: number[]) { return values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.9) - 1] : null; }

/**
 * Reads immutable create and accepted-delivery events only. The database clock is
 * the repository clock; both ends of every published interval are inclusive.
 */
export async function shippingPulse(pool: pg.Pool): Promise<ShippingPulse> {
  const clock = await pool.query("SELECT statement_timestamp() AS now");
  const now = clock.rows[0].now as Date;
  const currentWeek = startOfUtcWeek(now);
  const rangeStart = new Date(currentWeek);
  rangeStart.setUTCDate(rangeStart.getUTCDate() - 7 * (SHIPPING_PULSE_WEEKS - 1));
  const result = await pool.query<DeliveryRow>(`
    WITH delivery_events AS (
      SELECT DISTINCT ON (e.work_id) e.work_id, e.seq, e.payload->'work' AS work,
        graphyard_instant(e.payload->'work'->'delivery'->>'mergedAt') AS merged_at
      FROM events e
      WHERE e.kind = 'github.observed'
        AND e.payload->'work'->'delivery'->>'mergedAt' IS NOT NULL
        AND graphyard_instant(e.payload->'work'->'delivery'->>'mergedAt') BETWEEN $1 AND $2
      ORDER BY e.work_id ASC, e.seq ASC
    ), exact_deliveries AS (
      SELECT work_id, seq, work, merged_at FROM delivery_events
      ORDER BY merged_at DESC, work_id ASC LIMIT $3
    ), ranked AS (
      SELECT work_id, work, merged_at,
        row_number() OVER (ORDER BY merged_at DESC, work_id ASC) AS rank_position FROM exact_deliveries
    )
    SELECT d.work_id, d.work->>'key' AS key, d.work->>'title' AS title,
      (d.work->'candidate'->>'pr')::int AS pull_request,
      d.work->'delivery'->>'mergeSha' AS merge_sha, d.merged_at,
      (d.work->'observation'->>'prCreatedAt')::timestamptz AS pr_created_at,
      intent.created_at AS intent_at,
      CASE WHEN d.rank_position <= $5 THEN COALESCE(d.work->'violations','[]'::jsonb) END AS delivery_violations,
      -- Requirements and evidence come from the revision this delivery cites, found by an
      -- exact (work_id, revision) index probe on the append-only ledger. The observation
      -- that recorded the delivery carries whatever the work item held at observation
      -- time, which may already be a later requirement or policy revision.
      CASE WHEN d.rank_position <= $5 THEN (
        SELECT jsonb_build_object(
          'evidence', COALESCE(a.work->'evidence','[]'::jsonb),
          'criteria', COALESCE(a.work->'criteria','[]'::jsonb),
          'candidate', a.work->'candidate',
          'policyRevision', a.work->'policyRevision',
          'scenarioRequirements', COALESCE(a.work->'scenarioRequirements','[]'::jsonb),
          'validation', COALESCE(a.work->'validation','{}'::jsonb))
        FROM (
          SELECT e.payload->'work' AS work FROM events e
          WHERE e.work_id=d.work_id AND e.payload ? 'work'
            AND e.payload->'work'->>'revision' = d.work->'delivery'->>'authorizationRevision'
          ORDER BY e.seq DESC LIMIT 1
        ) a) END AS authorized_work,
      production.production_at, production.production_matches::int, production.superseded_matches::int
    FROM ranked d
    LEFT JOIN LATERAL (
      SELECT created_at FROM events
      WHERE work_id=d.work_id AND kind='create' ORDER BY seq ASC LIMIT 1
    ) intent ON true
    LEFT JOIN LATERAL (
      SELECT min(o.deployed_at) FILTER (WHERE o.deployed_at>=d.merged_at AND NOT o.superseded) AS production_at,
        count(*) AS production_matches,
        count(*) FILTER (WHERE o.superseded) AS superseded_matches
      FROM (
        SELECT pom.deployed_at, EXISTS (
            SELECT 1 FROM production_observations later
            WHERE later.provider=source.provider AND later.deployment_id=source.deployment_id
              AND later.status='superseded') AS superseded
        FROM production_observation_merges pom
        JOIN production_observations source ON source.id=pom.observation_id
        WHERE pom.merge_sha=lower(d.work->'delivery'->>'mergeSha')
          AND pom.status='succeeded' AND pom.kind='deployment'
        ORDER BY pom.deployed_at ASC, pom.observation_id ASC LIMIT $4
      ) o
    ) production ON true
    ORDER BY d.merged_at DESC, d.work_id ASC`,
    [rangeStart.toISOString(), now.toISOString(), SHIPPING_PULSE_LIMIT + 1, SHIPPING_PULSE_PRODUCTION_LIMIT + 1, SHIPPING_PULSE_RECENT_LIMIT]);
  const deliveryPartial = result.rows.length > SHIPPING_PULSE_LIMIT;
  const rows = result.rows.slice(0, SHIPPING_PULSE_LIMIT);
  const productionPartial = rows.some(row => row.production_matches > SHIPPING_PULSE_PRODUCTION_LIMIT);
  const partial = deliveryPartial || productionPartial;
  const since7 = now.getTime() - 7 * 86_400_000;
  const since30 = now.getTime() - 30 * 86_400_000;
  const durations = rows.filter(row => row.intent_at && row.intent_at <= row.merged_at)
    .map(row => (row.merged_at.getTime() - row.intent_at!.getTime()) / 3_600_000);
  const medianHours = median(durations);
  const productionDurations: number[] = [], prToMerge: number[] = [], mergeToProduction: number[] = [];
  const exclusions: Record<string, number> = {};
  const exclude = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  for (const row of rows) {
    if (!row.pr_created_at) { exclude('missing-pr-created-at'); continue; }
    if (!row.production_at) { exclude(row.production_matches > SHIPPING_PULSE_PRODUCTION_LIMIT ? 'production-observation-cap' : row.superseded_matches > 0 && row.production_matches === row.superseded_matches ? 'superseded-deployment' : 'no-verifiable-production-deployment'); continue; }
    if (row.pr_created_at > row.merged_at || row.production_at < row.merged_at) { exclude('invalid-clock-order'); continue; }
    productionDurations.push((row.production_at.getTime() - row.pr_created_at.getTime()) / 3_600_000);
    prToMerge.push((row.merged_at.getTime() - row.pr_created_at.getTime()) / 3_600_000);
    mergeToProduction.push((row.production_at.getTime() - row.merged_at.getTime()) / 3_600_000);
  }
  const weeks = Array.from({ length: SHIPPING_PULSE_WEEKS }, (_, index) => {
    const start = new Date(rangeStart); start.setUTCDate(start.getUTCDate() + index * 7);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 7); end.setMilliseconds(end.getMilliseconds() - 1);
    const boundedEnd = end > now ? now : end;
    return { start: start.toISOString(), end: boundedEnd.toISOString(), count: rows.filter(row => row.merged_at >= start && row.merged_at <= boundedEnd).length };
  });
  return {
    generatedAt: now.toISOString(), range: { start: rangeStart.toISOString(), end: now.toISOString(), weeks: SHIPPING_PULSE_WEEKS, semantics: 'repository-utc-inclusive' },
    completeness: partial ? 'partial' : 'complete',
    ...(partial ? { partialReason: [deliveryPartial ? `More than ${SHIPPING_PULSE_LIMIT} exact deliveries occurred in the bounded window; counts and statistics are lower-bound samples.` : '', productionPartial ? `More than ${SHIPPING_PULSE_PRODUCTION_LIMIT} production observations matched at least one merge; the response is conservatively partial at the explicit query cap.` : ''].filter(Boolean).join(' ') } : {}),
    counts: { days7: rows.filter(row => row.merged_at.getTime() >= since7).length, days30: rows.filter(row => row.merged_at.getTime() >= since30).length },
    intentToMerge: { medianHours: rounded(medianHours), sampleSize: durations.length, excluded: rows.length - durations.length },
    prToProduction: {
      averageHours: rounded(average(productionDurations)), medianHours: rounded(median(productionDurations)), p90Hours: rounded(p90(productionDurations)),
      sampleSize: productionDurations.length, eligible: rows.length, excluded: rows.length - productionDurations.length,
      coveragePercent: rows.length ? Math.round(productionDurations.length / rows.length * 1000) / 10 : 0,
      sparse: productionDurations.length < 5, exclusions,
      split: { prToMergeAverageHours: rounded(average(prToMerge)), mergeToProductionAverageHours: rounded(average(mergeToProduction)) },
    },
    weeks,
    recent: rows.slice(0, SHIPPING_PULSE_RECENT_LIMIT).map(row => ({
      key: row.key, title: row.title, pullRequest: row.pull_request, mergeSha: row.merge_sha, mergedAt: row.merged_at.toISOString(),
      quality: deliveredQuality(row.authorized_work, row.delivery_violations, row.merged_at),
    })),
  };
}
