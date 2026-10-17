import { agentOwner, type AttentionItem } from '../master.js';

/** The route the summary reads, as an unavailable section names it (GY-422). */
export const interventionSummaryRoute = 'GET /api/interventions?window=7';

/**
 * What the product made people do by hand this week (GY-98), as `master status` carries it: the
 * rate per delivery, the kinds and stages, the items that cost the most attention, and every
 * kind-at-stage pattern over the threshold, each raised as attention for the master; no work item
 * is filed for a pattern.
 */
export async function interventionSummary(masterApi: (path: string) => Promise<any>) {
  try {
    const report = await masterApi('interventions?window=7');
    const crossed = (report.patterns as { kind: string; stage: string; count: number; threshold: number; crossed: boolean; work: { key: string } | null }[]).filter(pattern => pattern.crossed);
    const summary = { window: report.window, deliveries: report.deliveries, total: report.total, open: report.open, waitedMs: report.waitedMs, ratePerDelivery: report.ratePerDelivery,
      byKind: report.byKind, byStage: report.byStage, costliest: (report.costliest as unknown[]).slice(0, 5), patterns: crossed, judgements: (report.judgements as unknown[]).length, ledger: report.ledger, scan: report.scan ?? null, available: true, error: null };
    // A crossed pattern is reported, never filed (2026-10-17): the master decides whether a code change is needed.
    const attentionItems: AttentionItem[] = crossed.map(pattern => ({ subject: 'interventions',
      text: `${pattern.count} ${pattern.kind} interventions at the ${pattern.stage} stage in ${report.window.days} days crossed the threshold of ${pattern.threshold}`,
      ...agentOwner('master', 'Read the instances in master status interventions; file a code-change item only if a product defect causes them') }));
    return { summary, attentionItems };
  } catch (error) {
    // The section is unavailable, never the report (GY-422): master status names it with its route.
    return { summary: { available: false, route: interventionSummaryRoute, error: `The intervention report could not be read: ${error instanceof Error ? error.message : 'unknown reason'}` }, attentionItems: [] as AttentionItem[] };
  }
}
