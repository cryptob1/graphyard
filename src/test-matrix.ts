import type { GateRecord } from './batch-gate.js';
import type { ScenarioRun } from './model/test-cases.js';

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

/**
 * The Tests page's environment matrix (GY-3278 AC-3): where each E2E case ran, in delivery order.
 * Trial is the merge trial's run of the candidate (and any other trusted run of a candidate), Main
 * the batch gate on main, Served a `graphyard e2e run` against the release this install serves, and
 * Nightly the daily full run of the catalog on the verified commit. Every cell comes from a record
 * the control plane already keeps: the run ledger, and the batch gate's record in the checkout.
 */
export const matrixColumns = ['trial', 'main', 'served', 'nightly'] as const;
export type MatrixColumn = typeof matrixColumns[number];
export interface MatrixCell {
  result: 'pass' | 'fail' | 'skipped';
  at: string;
  /** The run's output: its own URL, the item whose trial ran it, or the item the failure was filed as. */
  link: { url: string } | { item: string; key: string } | null;
  detail: string | null;
}
export type CaseMatrix = Partial<Record<MatrixColumn, MatrixCell>>;

/** The case's category: its first tag, 'other' when untagged. */
export const caseCategory = (tags: readonly string[] | undefined) => tags?.[0] ?? 'other';

/** The newest Trial and Served run of every case, withdrawn runs left out. A UAT run of a release candidate is neither. */
export async function placedRuns(db: Queryable, withdrawn: string[]): Promise<Map<string, CaseMatrix>> {
  const rows = (await db.query(`SELECT DISTINCT ON (scenario, place) scenario, place, document FROM (
      SELECT seq, scenario, document, CASE WHEN document->'run'->>'kind' <> 'e2e' THEN 'trial' WHEN document->>'environment' <> 'uat' THEN 'served' END AS place
      FROM scenario_runs WHERE NOT (COALESCE(document->>'evidenceId', '') = ANY($1::text[]))) runs
    WHERE place IS NOT NULL ORDER BY scenario, place, seq DESC`, [withdrawn])).rows as { scenario: string; place: 'trial' | 'served'; document: ScenarioRun & { e2e?: { failingStep: { name: string; reason: string } | null } } }[];
  const matrix = new Map<string, CaseMatrix>();
  for (const { scenario, place, document: run } of rows) {
    const link = run.run.url ? { url: run.run.url } : run.workId ? { item: run.workId, key: run.workKey } : null;
    const step = run.e2e?.failingStep;
    (matrix.get(scenario) ?? matrix.set(scenario, {}).get(scenario)!)[place] = { result: run.result, at: run.at, link,
      detail: step ? `${step.name}: ${step.reason}` : run.environment ? `on ${run.environment}` : null };
  }
  return matrix;
}

/** The Main and Nightly cells of one case, from the batch gate's record; none without a gate. */
export function gateCells(gate: GateRecord | null, id: string, ranNightly: boolean, items: ReadonlyMap<string, string>): CaseMatrix {
  if (!gate) return {};
  const cells: CaseMatrix = {}, check = `e2e:${id}`;
  const filedKey = gate.filed?.[`diagnostic:${check}`]?.item ?? null, filed = filedKey && items.has(filedKey) ? { item: items.get(filedKey)!, key: filedKey } : null;
  const main = gate.lastOutcome?.cases?.[id];
  if (main && gate.lastOutcome) cells.main = { result: main, at: gate.lastOutcome.finishedAt, link: null, detail: gate.lastOutcome.tip ? `gated ${gate.lastOutcome.tip.slice(0, 12)}` : null };
  const failure = gate.diagnosticFailures?.[check];
  const preview = gate.previewCases?.[id];
  if (preview) cells.nightly = { result: preview.verdict === 'passed' ? 'pass' : preview.verdict === 'failed' ? 'fail' : 'skipped', at: preview.at, link: filed, detail: preview.detail };
  else if (gate.diagnosticsAt && (failure || ranNightly)) cells.nightly = { result: failure ? 'fail' : 'pass', at: failure?.at ?? gate.diagnosticsAt,
    link: failure ? filed : null, detail: failure?.detail ?? (gate.verified ? `on ${gate.verified.slice(0, 12)}` : null) };
  return cells;
}

/** The ids of the items the gate filed its nightly failures as, by key, so a cell opens the item. */
export async function filedItems(db: Queryable, gate: GateRecord | null): Promise<Map<string, string>> {
  const keys = Object.entries(gate?.filed ?? {}).filter(([key, entry]) => key.startsWith('diagnostic:e2e:') && entry.item).map(([, entry]) => entry.item!);
  if (!keys.length) return new Map();
  const rows = (await db.query(`SELECT id::text AS id, key FROM work_index WHERE key = ANY($1::text[])`, [keys])).rows;
  return new Map(rows.map(row => [row.key, row.id]));
}
