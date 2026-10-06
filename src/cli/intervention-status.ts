import { agentOwner, type AttentionItem } from '../master.js';

/** The route the summary reads, as an unavailable section names it (GY-422). */
export const interventionSummaryRoute = 'GET /api/interventions?window=7';

/**
 * What the product made people do by hand this week (GY-98), as `master status` carries it: the
 * rate per delivery, the kinds and stages, the items that cost the most attention, and every
 * kind-at-stage pattern over the threshold with the item Graphyard opened for it. A server whose
 * report says its pattern scan is on opens that item on its own within a minute of the threshold
 * being crossed. The scan is off by default (GY-1372): a pattern without an item then waits on
 * the scan being enabled or run by hand, a missing variable (configuration), never a decision.
 */
export async function interventionSummary(masterApi: (path: string) => Promise<any>) {
  try {
    const report = await masterApi('interventions?window=7');
    const crossed = (report.patterns as { kind: string; stage: string; count: number; threshold: number; crossed: boolean; work: { key: string } | null }[]).filter(pattern => pattern.crossed);
    const summary = { window: report.window, deliveries: report.deliveries, total: report.total, open: report.open, waitedMs: report.waitedMs, ratePerDelivery: report.ratePerDelivery,
      byKind: report.byKind, byStage: report.byStage, costliest: (report.costliest as unknown[]).slice(0, 5), patterns: crossed, judgements: (report.judgements as unknown[]).length, ledger: report.ledger, scan: report.scan ?? null, available: true, error: null };
    const scan = report.scan as { enabled: boolean; variable: string } | undefined;
    const attentionItems: AttentionItem[] = crossed.filter(pattern => !pattern.work).map(pattern => {
      const crossing = `${pattern.count} ${pattern.kind} interventions at the ${pattern.stage} stage in ${report.window.days} days crossed the threshold of ${pattern.threshold} and no item stands for the pattern yet`;
      // A report without the field (a server before GY-1372) keeps the wording it had; only `enabled: false` says the scan is off.
      if (scan?.enabled !== false) return { subject: 'interventions', text: `${crossing}; the server opens one within a minute`,
        ...agentOwner('master', 'POST /api/interventions/patterns with the coordinator credential opens it now if the server tick does not') };
      return { subject: 'interventions', kind: 'setup' as const,
        text: `${crossing}; the automatic pattern scan is off on this server, so nothing opens one on its own: ${scan.variable}=1 on the deployment enables it`,
        ...agentOwner('master', `POST /api/interventions/patterns with the coordinator credential opens it now; set ${scan.variable}=1 on the deployment to scan every minute`) };
    });
    return { summary, attentionItems };
  } catch (error) {
    // The section is unavailable, never the report (GY-422): master status names it with its route.
    return { summary: { available: false, route: interventionSummaryRoute, error: `The intervention report could not be read: ${error instanceof Error ? error.message : 'unknown reason'}` }, attentionItems: [] as AttentionItem[] };
  }
}
