import type pg from 'pg';

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
    quality: { passingProofs: number; requiredProofs: number; violations: string[] };
  }[];
}

type DeliveryRow = {
  work_id: string; key: string; title: string; pull_request: number; merge_sha: string;
  merged_at: Date; intent_at: Date | null; passing_proofs: number; required_proofs: number;
  violations: unknown;
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
      SELECT e.work_id, e.seq, e.payload->'work' AS work,
        (e.payload->'work'->'delivery'->>'mergedAt')::timestamptz AS merged_at,
        row_number() OVER (PARTITION BY e.work_id ORDER BY e.seq ASC) AS delivery_number
      FROM events e
      WHERE e.kind = 'github.observed'
        AND e.payload->'work'->'delivery'->>'mergedAt' IS NOT NULL
        AND e.payload->'work'->'delivery'->>'mergedAt' BETWEEN $1 AND $2
    ), exact_deliveries AS (
      SELECT work_id, seq, work, merged_at FROM delivery_events WHERE delivery_number=1
      ORDER BY merged_at DESC, work_id ASC LIMIT $3
    )
    SELECT d.work_id, d.work->>'key' AS key, d.work->>'title' AS title,
      (d.work->'candidate'->>'pr')::int AS pull_request,
      d.work->'delivery'->>'mergeSha' AS merge_sha, d.merged_at,
      (d.work->'observation'->>'prCreatedAt')::timestamptz AS pr_created_at,
      intent.created_at AS intent_at,
      (SELECT count(*)::int FROM jsonb_array_elements(COALESCE(d.work->'evidence','[]'::jsonb)) proof
        WHERE proof->>'trusted' = 'true' AND proof->>'result' = 'pass'
          AND (proof->>'executed')::int > 0 AND (proof->>'skipped')::int = 0) AS passing_proofs,
      (SELECT count(*)::int FROM jsonb_array_elements(COALESCE(d.work->'criteria','[]'::jsonb)) criterion,
        jsonb_array_elements(COALESCE(criterion->'proofs','[]'::jsonb))) AS required_proofs,
      COALESCE(d.work->'violations','[]'::jsonb) AS violations,
      production.production_at, production.production_matches::int, production.superseded_matches::int
    FROM exact_deliveries d
    LEFT JOIN LATERAL (
      SELECT created_at FROM events
      WHERE work_id=d.work_id AND kind='create' ORDER BY seq ASC LIMIT 1
    ) intent ON true
    LEFT JOIN LATERAL (
      SELECT min(o.deployed_at) FILTER (WHERE o.status='succeeded' AND o.kind='deployment'
          AND o.deployed_at>=d.merged_at AND NOT EXISTS (
            SELECT 1 FROM production_observations later WHERE later.provider=o.provider
              AND later.deployment_id=o.deployment_id AND later.status='superseded')) AS production_at,
        count(*) FILTER (WHERE o.status='succeeded' AND o.kind='deployment') AS production_matches,
        count(*) FILTER (WHERE o.status='succeeded' AND o.kind='deployment' AND EXISTS (
            SELECT 1 FROM production_observations later WHERE later.provider=o.provider
              AND later.deployment_id=o.deployment_id AND later.status='superseded')) AS superseded_matches
      FROM (
        SELECT observed.* FROM production_observation_merges pom
        JOIN production_observations observed ON observed.id=pom.observation_id
        WHERE pom.merge_sha=lower(d.work->'delivery'->>'mergeSha')
          AND observed.status='succeeded' AND observed.kind='deployment'
        ORDER BY observed.deployed_at ASC, observed.id ASC LIMIT $4
      ) o
    ) production ON true
    ORDER BY d.merged_at DESC, d.work_id ASC`, [rangeStart.toISOString(), now.toISOString(), SHIPPING_PULSE_LIMIT + 1, SHIPPING_PULSE_PRODUCTION_LIMIT + 1]);
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
      quality: { passingProofs: row.passing_proofs, requiredProofs: row.required_proofs, violations: Array.isArray(row.violations) ? row.violations.filter(value => typeof value === 'string').slice(0, 10) : [] },
    })),
  };
}
