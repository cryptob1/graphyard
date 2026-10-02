import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/**
 * The installation's billable GitHub requests across every replica (GY-806, github_charges,
 * src/store/tables/github-cache.ts). Replicas sharing one Postgres share one installation quota,
 * so a process's own charges understate the spend: each process writes its charges per minute and
 * endpoint under its own instance id, and reads back every other instance's last hour. The GitHub
 * adapter adds those to its own in `budget().billable`, which master status reports.
 *
 * Like the response cache it is write-behind on a timer with plain pool queries, and a database
 * failure never fails a request: the report then counts this process alone until the next sync.
 */
export interface ChargeRow { endpoint: string; kind: string; requests: number }
export class GitHubChargeLedger {
  readonly instance: string;
  readonly syncMs: number;
  private pending = new Map<string, { minute: number; endpoint: string; kind: string; requests: number }>();
  private others: ChargeRow[] = [];
  private instances = 0;
  private timer: NodeJS.Timeout | null = null;
  private syncing: Promise<void> | null = null;
  private reportedAt = 0;
  private syncedAt = 0;
  /** `installation` separates installations sharing one database; `instance` names this process. */
  constructor(private pool: Pick<pg.Pool, 'query'>, private installation: string, options: { instance?: string; syncMs?: number } = {}) {
    this.instance = options.instance ?? randomUUID();
    this.syncMs = options.syncMs ?? 15_000;
  }
  /** One billable request this process made at `at` (epoch ms). */
  charge(at: number, endpoint: string, kind: string) {
    const minute = Math.floor(at / 60_000) * 60_000;
    const key = `${minute}|${endpoint}`;
    const entry = this.pending.get(key);
    if (entry) entry.requests++;
    else this.pending.set(key, { minute, endpoint, kind, requests: 1 });
    this.schedule();
  }
  private schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; void this.sync(); }, this.syncMs);
    this.timer.unref?.();
  }
  /**
   * Every other instance's billable requests in the last hour, as of the last sync, and how many
   * instances charged. A read of a stale answer schedules the next sync, so a replica that spends
   * nothing itself still reports the others.
   */
  fleet(now = Date.now()): { rows: ChargeRow[]; instances: number } {
    if (now - this.syncedAt >= this.syncMs) this.schedule();
    return { rows: this.others, instances: this.instances };
  }
  /** Write this process's queued charges and read the other instances' last hour. Never throws. */
  sync(now = Date.now(), windowMs = 60 * 60_000): Promise<void> {
    if (this.syncing) return this.syncing.then(() => this.sync(now, windowMs));
    this.syncing = this.write(now, windowMs).finally(() => { this.syncing = null; });
    return this.syncing;
  }
  private async write(now: number, windowMs: number) {
    this.syncedAt = now;
    const batch = [...this.pending.values()]; this.pending.clear();
    let written = false;
    try {
      if (batch.length) await this.pool.query(`INSERT INTO github_charges(installation, instance, minute, endpoint, kind, requests)
SELECT $1, $2, to_timestamp(m / 1000.0), e, k, n FROM unnest($3::bigint[], $4::text[], $5::text[], $6::int[]) AS t(m, e, k, n)
ON CONFLICT (installation, instance, minute, endpoint) DO UPDATE SET requests = github_charges.requests + EXCLUDED.requests`,
      [this.installation, this.instance, batch.map(entry => entry.minute), batch.map(entry => entry.endpoint), batch.map(entry => entry.kind), batch.map(entry => entry.requests)]);
      written = true;
      const since = new Date(Math.floor((now - windowMs) / 60_000) * 60_000 + 60_000);
      const rows = (await this.pool.query(`SELECT endpoint, kind, sum(requests)::int AS requests, count(DISTINCT instance)::int AS instances FROM github_charges
WHERE installation=$1 AND instance<>$2 AND minute >= $3 GROUP BY GROUPING SETS ((endpoint, kind), ())`, [this.installation, this.instance, since])).rows;
      this.others = rows.filter(row => row.endpoint !== null).map(row => ({ endpoint: String(row.endpoint), kind: String(row.kind), requests: Number(row.requests) }));
      this.instances = Number(rows.find(row => row.endpoint === null)?.instances ?? 0);
      await this.pool.query(`DELETE FROM github_charges WHERE installation=$1 AND minute < $2`, [this.installation, new Date(now - 2 * windowMs)]);
    } catch (error) {
      // An unwritten batch is queued again for the next sync, merged with what was charged since,
      // so a transient failure delays the other replicas' count instead of losing it. Minutes past
      // the report's window are dropped, which keeps the queue bounded through a long outage.
      if (!written) {
        for (const entry of batch) {
          if (entry.minute < now - windowMs) continue;
          const key = `${entry.minute}|${entry.endpoint}`, queued = this.pending.get(key);
          if (queued) queued.requests += entry.requests; else this.pending.set(key, entry);
        }
      }
      if (Date.now() - this.reportedAt >= 60_000) {
        this.reportedAt = Date.now();
        console.error(`GitHub charge ledger sync failed; the billable report counts this process alone: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  /** Stop the timer and write what is queued. */
  async close() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.pending.size) await this.sync();
  }
}
