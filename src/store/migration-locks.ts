/**
 * Lock ordering for the startup migration (2026-09-26). A table's DDL that builds an index (a share lock)
 * and then rebuilds a trigger (an exclusive lock) upgrades its lock mid-transaction; a live writer that had
 * read the table and queued behind the index build then deadlocks with it, and Postgres cancelled the
 * migration on every deploy under live traffic. The tables whose triggers a DDL rebuilds are locked
 * exclusively first, in one statement, so the migration never upgrades a lock it holds.
 */
type Step = (waiting: string, sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;

/** The tables a DDL rebuilds a trigger on, in DDL order. */
export const rebuiltTriggerTables = (ddl: string) => [...new Set([...ddl.matchAll(/^DROP TRIGGER IF EXISTS \w+ ON (\w+);/gm)].map(match => match[1]))];

/** Lock the existing tables whose triggers `ddl` rebuilds exclusively, before the DDL runs. */
export async function lockRebuiltTriggerTables(step: Step, waiting: string, ddl: string) {
  const rebuilt = rebuiltTriggerTables(ddl);
  if (!rebuilt.length) return;
  const present: string[] = (await step(waiting, "SELECT COALESCE(array_agg(name ORDER BY ord), '{}') AS names FROM unnest($1::text[]) WITH ORDINALITY AS t(name, ord) WHERE to_regclass(name) IS NOT NULL", [rebuilt])).rows[0].names;
  if (present.length) await step(waiting, `LOCK TABLE ${present.map(name => `"${name}"`).join(', ')} IN ACCESS EXCLUSIVE MODE`);
}

/** A deadlock with live traffic (40P01) is transient: run the migration again, rolled back, while the deadline allows. */
export async function retryDeadlocks(migrate: () => Promise<void>, retryable: () => boolean, rollback: () => Promise<unknown>) {
  for (;;) {
    try { return await migrate(); } catch (error) {
      if ((error as { code?: string }).code !== '40P01' || !retryable()) throw error;
      await rollback();
    }
  }
}
