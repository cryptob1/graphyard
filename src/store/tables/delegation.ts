import { appendOnly, defineTable } from '../tables.js';

/** Slice-lead rulings and human intake, both append-only. */
export const leadRulings = defineTable({
  name: 'lead_rulings', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS lead_rulings (
  id uuid PRIMARY KEY, work_id uuid NOT NULL REFERENCES work_items(id), lead_id text NOT NULL,
  slice_id text NOT NULL, action text NOT NULL, rule_id text NOT NULL, reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
${appendOnly('lead_rulings')}`,
});
export const intakeItems = defineTable({
  name: 'intake_items', orderBy: 'id',
  ddl: `CREATE TABLE IF NOT EXISTS intake_items (
  id uuid PRIMARY KEY, origin text NOT NULL, title text NOT NULL, description text NOT NULL,
  source_work_id uuid REFERENCES work_items(id), submitted_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
${appendOnly('intake_items')}`,
});

export const delegationTables = [leadRulings, intakeItems];
