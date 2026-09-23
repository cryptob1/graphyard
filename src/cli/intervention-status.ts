import { agentOwner, type AttentionItem } from '../master.js';

/**
 * What the product made people do by hand this week (GY-98), as `master status` carries it: the
 * rate per delivery, the kinds and stages, the items that cost the most attention, and every
 * kind-at-stage pattern over the threshold with the item Graphyard opened for it. The server
 * opens that item on its own within a minute of the threshold being crossed; a pattern still
 * without one is the one line here that asks the master to act.
 */
export async function interventionSummary(masterApi: (path: string) => Promise<any>) {
  try {
    const report = await masterApi('interventions?window=7');
    const crossed = (report.patterns as { kind: string; stage: string; count: number; threshold: number; crossed: boolean; work: { key: string } | null }[]).filter(pattern => pattern.crossed);
    const summary = { window: report.window, deliveries: report.deliveries, total: report.total, open: report.open, waitedMs: report.waitedMs, ratePerDelivery: report.ratePerDelivery,
      byKind: report.byKind, byStage: report.byStage, costliest: (report.costliest as unknown[]).slice(0, 5), patterns: crossed, judgements: (report.judgements as unknown[]).length, ledger: report.ledger, error: null };
    const attentionItems: AttentionItem[] = crossed.filter(pattern => !pattern.work).map(pattern => ({ subject: 'interventions',
      text: `${pattern.count} ${pattern.kind} interventions at the ${pattern.stage} stage in ${report.window.days} days crossed the threshold of ${pattern.threshold} and no item stands for the pattern yet; the server opens one within a minute`,
      ...agentOwner('master', 'POST /api/interventions/patterns with the coordinator credential opens it now if the server tick does not') }));
    return { summary, attentionItems };
  } catch (error) {
    return { summary: { error: `The intervention report could not be read: ${error instanceof Error ? error.message : 'unknown reason'}` }, attentionItems: [] as AttentionItem[] };
  }
}
