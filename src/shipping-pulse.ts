import type pg from 'pg';
import { currentEvidence, type Work } from './model.js';
import { DELIVERY_EVENT_PREDICATE, DELIVERY_REPOSITORY_INSTANT } from './store.js';

export const SHIPPING_PULSE_WEEKS = 12;
export const SHIPPING_PULSE_LIMIT = 1000;
export const SHIPPING_PULSE_RECENT_LIMIT = 10;
export const SHIPPING_PULSE_PRODUCTION_LIMIT = 100;

export interface ShippingPulse {
  generatedAt: string;
  range: { start: string; end: string; weeks: number; semantics: 'repository-utc-inclusive' };
  completeness: 'complete' | 'partial';
  partialReason?: string;
  /**
   * The window held more deliveries than the query cap, so only the newest were read.
   * Counts are then lower bounds, but the durations are not bounds in either direction:
   * they describe the newest deliveries alone, and the omitted older ones could move
   * them up or down. Callers must present the two differently.
   */
  truncated: boolean;
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
type AuthorizedSnapshot = Pick<Work, 'evidence' | 'criteria' | 'candidate' | 'policyRevision' | 'scenarioRequirements' | 'validation' | 'implementers' | 'workspaces' | 'lastAssignment' | 'lease'>;

type DeliveryRow = {
  work_id: string; key: string; title: string; pull_request: number; merge_sha: string;
  merged_at: Date; evidence_as_of: Date | null; intent_at: Date | null; authorized_work: AuthorizedSnapshot | null; delivery_violations: unknown;
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
 * validation selection, and scenario revision - so an obsolete pass recorded against an
 * earlier candidate is never counted. Expiry is re-checked at the authorization-time
 * clock bound the delivery itself recorded, never at the raw provider merge timestamp:
 * those are different clocks, related only through the offset bound captured at merge
 * verification, so judging expiry at the provider instant can report evidence that was
 * live at authorization as expired. Violations stay with the append-only delivery
 * record, which also carries any violation the post-merge comparison raised against that
 * authorization.
 */
function deliveredQuality(snapshot: AuthorizedSnapshot | null, recorded: unknown, asOf: Date) {
  const violations = Array.isArray(recorded) ? recorded.filter(value => typeof value === 'string').slice(0, 10) : [];
  // An unresolvable authorization is unknown, never zero proofs passed out of zero required.
  if (!snapshot) return { passingProofs: null, requiredProofs: null, violations, unavailableReason: QUALITY_UNRESOLVED };
  const required = [...new Set((snapshot.criteria ?? []).flatMap(criterion => criterion.proofs ?? []))];
  const work = { ...snapshot, evidence: snapshot.evidence ?? [], workspaces: snapshot.workspaces ?? [] } as Work;
  const passed = required.filter(proof => {
    const evidence = currentEvidence(work, proof, asOf);
    return !!evidence && evidence.result === 'pass' && evidence.executed > 0 && evidence.skipped === 0;
  });
  return { passingProofs: passed.length, requiredProofs: required.length, violations };
}

function rounded(value: number | null) { return value === null ? null : Math.round(value * 10) / 10; }
function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }
function p90(values: number[]) { return values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.9) - 1] : null; }

/**
 * Reads immutable create and accepted-delivery events only. A work item contributes one
 * delivery, its first, and that is settled across the whole ledger before any window,
 * count, or bucket is applied.
 *
 * The database clock is the repository clock, and every instant this compares against it
 * is carried onto it first. Three clocks produce the timestamps involved: GitHub's, for
 * the merge and pull-request times, related to the repository clock through the bounded
 * offset each delivery recorded at merge verification; each deployment provider's, related
 * through the bracket its collector measured at ingestion; and the repository's own, for
 * the append-only intent event. Comparing any of them raw would move a delivery across a
 * window boundary, discard a real deployment as preceding its own merge, or bias a
 * published duration by the whole offset. Both ends of every published interval are
 * inclusive.
 */
export async function shippingPulse(pool: pg.Pool): Promise<ShippingPulse> {
  const clock = await pool.query("SELECT statement_timestamp() AS now");
  const now = clock.rows[0].now as Date;
  const currentWeek = startOfUtcWeek(now);
  const rangeStart = new Date(currentWeek);
  rangeStart.setUTCDate(rangeStart.getUTCDate() - 7 * (SHIPPING_PULSE_WEEKS - 1));
  const result = await pool.query<DeliveryRow>(`
    WITH windowed AS (
      -- Candidates: delivery-bearing events whose recorded instant falls in the window.
      -- A work item can appear here more than once - a re-observation writes another
      -- snapshot, and a snapshot written after the delivery carries it forward - so this
      -- narrows to the earliest such event per work item and nothing else. It cannot yet
      -- decide that event is the item's delivery, because the window hides everything
      -- before it.
      SELECT DISTINCT ON (work_id) work_id, seq, payload->'work' AS work,
        ${DELIVERY_REPOSITORY_INSTANT} AS merged_at
      FROM events
      WHERE ${DELIVERY_EVENT_PREDICATE}
        AND ${DELIVERY_REPOSITORY_INSTANT} BETWEEN $1 AND $2
      ORDER BY work_id ASC, seq ASC
    ), exact_deliveries AS (
      -- Deduplication is global, and happens before anything is counted, bucketed, or
      -- ranked: a work item is delivered once, at its first accepted-delivery event
      -- anywhere in the ledger. Keeping the earliest in-window event instead would count
      -- a later snapshot of an older delivery as a delivery inside this window, inflating
      -- the counts and the weekly bars and attributing the work to the wrong week. One
      -- indexed (work_id, seq) probe per candidate answers it exactly; a candidate whose
      -- first delivery event lies before the window simply falls away here.
      SELECT w.work_id, w.work, w.merged_at FROM windowed w
      WHERE w.seq = (
        SELECT first.seq FROM events first
        WHERE first.work_id = w.work_id AND ${DELIVERY_EVENT_PREDICATE}
        ORDER BY first.seq ASC LIMIT 1)
      ORDER BY w.merged_at DESC, w.work_id ASC LIMIT $3
    ), ranked AS (
      SELECT work_id, work, merged_at,
        row_number() OVER (ORDER BY merged_at DESC, work_id ASC) AS rank_position FROM exact_deliveries
    )
    SELECT d.work_id, d.work->>'key' AS key, d.work->>'title' AS title,
      (d.work->'candidate'->>'pr')::int AS pull_request,
      d.work->'delivery'->>'mergeSha' AS merge_sha, d.merged_at,
      -- GitHub's own pull-request creation time, carried onto the repository clock with
      -- the offset the delivery recorded, so it can be compared with the merge instant and
      -- with repository deployment observations. Both endpoints of the PR-to-merge split
      -- shift together, so that component is unchanged by the correction.
      graphyard_instant(d.work->'observation'->>'prCreatedAt')
        + COALESCE((d.work->'delivery'->>'repositoryClockOffsetMs')::bigint, 0) * interval '1 millisecond' AS pr_created_at,
      -- Written by the engine on the repository clock; deliveries recorded before this
      -- field existed have none, and fall back to the repository merge instant above.
      graphyard_instant(d.work->'delivery'->>'evidenceAsOf') AS evidence_as_of,
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
          'validation', COALESCE(a.work->'validation','{}'::jsonb),
          -- Producer independence is judged against the implementers as they stood in
          -- the cited snapshot, the same identities the authorization itself weighed.
          'implementers', COALESCE(a.work->'implementers','[]'::jsonb),
          'workspaces', COALESCE(a.work->'workspaces','[]'::jsonb),
          'lastAssignment', a.work->'lastAssignment',
          'lease', a.work->'lease')
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
    -- Both endpoints on the repository clock. deployed_at_repository is the earliest
    -- repository instant a deployment can have occurred at and deployed_at_repository_max
    -- the latest, carried across at ingestion with the offset bracket the collector
    -- measured; d.merged_at is likewise the earliest repository instant of the merge.
    -- A deployment counts as post-merge when its latest bound reaches the merge: the
    -- containment proof already establishes that it deployed that merge, so a narrower
    -- test would discard a real deployment over two clocks each measured to within twenty
    -- seconds. Where the two brackets overlap, the merge instant is the deployment's own
    -- lower bound - it cannot have run before the commit it contains - so the reported
    -- instant is clamped to it rather than allowed to read as a negative duration.
    LEFT JOIN LATERAL (
      SELECT CASE WHEN count(*) FILTER (WHERE NOT o.superseded AND o.deployed_at_repository_max>=d.merged_at) > 0
          THEN greatest(min(o.deployed_at_repository) FILTER (WHERE NOT o.superseded AND o.deployed_at_repository_max>=d.merged_at), d.merged_at) END AS production_at,
        count(*) AS production_matches,
        count(*) FILTER (WHERE o.superseded) AS superseded_matches
      FROM (
        SELECT pom.deployed_at_repository, pom.deployed_at_repository_max, EXISTS (
            SELECT 1 FROM production_observations later
            WHERE later.provider=source.provider AND later.deployment_id=source.deployment_id
              AND later.status='superseded') AS superseded
        FROM production_observation_merges pom
        JOIN production_observations source ON source.id=pom.observation_id
        WHERE pom.merge_sha=lower(d.work->'delivery'->>'mergeSha')
          AND pom.status='succeeded' AND pom.kind='deployment'
        ORDER BY pom.deployed_at_repository ASC, pom.observation_id ASC LIMIT $4
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
    completeness: partial ? 'partial' : 'complete', truncated: deliveryPartial,
    ...(partial ? { partialReason: [deliveryPartial ? `More than ${SHIPPING_PULSE_LIMIT} exact deliveries occurred in the bounded window; only the newest ${SHIPPING_PULSE_LIMIT} were read. The counts are lower bounds. The durations are not bounds: they describe only those newest ${SHIPPING_PULSE_LIMIT} deliveries, and the older ones left out could move them in either direction.` : '', productionPartial ? `More than ${SHIPPING_PULSE_PRODUCTION_LIMIT} production observations matched at least one merge; the response is conservatively partial at the explicit query cap.` : ''].filter(Boolean).join(' ') } : {}),
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
      quality: deliveredQuality(row.authorized_work, row.delivery_violations, row.evidence_as_of ?? row.merged_at),
    })),
  };
}
