/**
 * One Postgres table the control plane owns. The registry under src/store/tables/ is the
 * single source of the schema: the migration is the concatenated DDL, and every consumer
 * that must name every table — the logical backup above all — derives its list from it
 * instead of keeping one by hand.
 */
export interface TableDefinition {
  name: string;
  /** Idempotent DDL: CREATE ... IF NOT EXISTS, ALTER ... ADD COLUMN IF NOT EXISTS, indexes, triggers. */
  ddl: string;
  /** Columns that give the rows a stable order for export and restore, primary key first. */
  orderBy: string;
  /** The serial column whose sequence a restore must advance, when the table has one. */
  serial?: string;
  /** A disposable cache the migration creates but a backup neither carries nor a restore requires empty. */
  cache?: boolean;
}

export const defineTable = (definition: TableDefinition) => definition;

/** The append-only trigger every ledger table installs; the function itself is created once by the schema preamble. */
export const appendOnly = (table: string) => `DROP TRIGGER IF EXISTS immutable_${table} ON ${table};
CREATE TRIGGER immutable_${table} BEFORE UPDATE OR DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION graphyard_immutable();`;
