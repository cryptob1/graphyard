import { agentOwner, type AttentionItem } from '../master.js';

/**
 * The server's heartbeat health (`leaseHealth` in GET /api/status, GY-558): p50/p95 renewal latency
 * over the last ten minutes and the renewals refused or failed server-side, with one attention item
 * when p95 exceeds the server's threshold. Null from a server that predates it.
 */
export function leaseHealthStatus(coordinator: { leaseHealth?: { p50Ms: number | null; p95Ms: number | null; renewals: number; refused: number; failed: number; windowMs: number; attention: string | null } | null } | null | undefined) {
  const report = coordinator?.leaseHealth ?? null;
  const attention: AttentionItem[] = report?.attention
    ? [{ subject: 'leases', text: report.attention, ...agentOwner('master', 'GET /api/status (leaseHealth) and the server logs name what holds the lease pool or the coordination lock; workers keep their leases through recorded server-side failures') }]
    : [];
  return { report: report && { p50Ms: report.p50Ms, p95Ms: report.p95Ms, renewals: report.renewals, refused: report.refused, failed: report.failed, windowMs: report.windowMs }, attention };
}
