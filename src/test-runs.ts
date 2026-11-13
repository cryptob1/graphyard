import type { Evidence, Work } from './model.js';
import { demand } from './model.js';
import { flakiness, flakyWindow, runKey, scenarioRun, type ScenarioRun } from './model/test-cases.js';
import type { Scenario } from './scenarios.js';

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

/**
 * Append the run a just-accepted evidence record projects, inside the transaction that accepted
 * it. Only trusted records project, so a worker's own assertion is never a run; a retried publish
 * of the same lane run on the same commit is the same row.
 */
export async function recordScenarioRun(db: Queryable, work: Pick<Work, 'id' | 'key' | 'candidate'>, evidence: Evidence) {
  const run = scenarioRun(work, evidence);
  if (!run) return;
  await db.query('INSERT INTO scenario_runs(scenario,run_key,document) VALUES($1,$2,$3) ON CONFLICT (run_key) DO NOTHING', [run.scenarioId, runKey(run), JSON.stringify(run)]);
}

/** Evidence withdrawn after its run was recorded: the run stays in history, marked, and never decides a result. */
export async function withdrawnEvidence(db: Queryable): Promise<Set<string>> {
  const rows = (await db.query(`SELECT e->>'id' AS id FROM work_items, jsonb_array_elements(document->'evidence') e WHERE e->>'proof' LIKE 'e2e:%' AND e ? 'revocation'`)).rows;
  return new Set(rows.map(row => row.id));
}
const toRun = (row: { seq: string; document: Omit<ScenarioRun, 'seq'> }, withdrawn: Set<string>): ScenarioRun =>
  ({ ...row.document, seq: Number(row.seq), ...(withdrawn.has(row.document.evidenceId) ? { withdrawn: true } : {}) });

export interface CaseSummary {
  id: string; title: string | null; purpose: string | null; testPath: string | null; environment: string | null;
  /** Null for a case with recorded runs but no definition in the registry. */
  revision: number | null;
  /** The latest definition: when it changed and who published it. */
  changed: { at: string; by: string } | null;
  /** The items whose criteria name this case, closed-unmerged items left out: each item and the criteria, with their text, that need it. */
  links: ProofLink[];
  latest: ScenarioRun | null;
  /** Whether the latest run measured an older revision than the case now defines. */
  staleRevision: boolean;
  runs: number; failures: number; lastFailure: ScenarioRun | null;
  flaky: boolean; flakyReason: string | null;
  /** The newest runs, newest first, `historyWindow` at most; older runs page through `runHistory`. */
  history: ScenarioRun[];
}
export const historyWindow = flakyWindow;
/** An item a proof belongs to: its id (to open it), key, title, stage and the criteria naming the proof. */
export interface ProofLink { id: string; key: string; title: string; stage: string; criteria: { id: string; text: string }[] }
/** A manual or closed-question proof (GY-3278): its item and criterion, and the latest trusted record of it, or null while it waits. */
export interface JudgedProof { proof: string; link: ProofLink; record: { result: 'pass' | 'fail'; producer: string; at: string } | null }

/** Items' criteria naming proofs of a kind, closed items left out: one row per item, criterion and proof. */
const criterionRows = (db: Queryable, where: string, evidence = false) => db.query(`SELECT p AS proof, document->>'id' AS id, document->>'key' AS key, document->>'title' AS title, document->>'stage' AS stage, c->>'id' AS criterion, c->>'text' AS text${evidence ? `, document->'evidence' AS evidence` : ''}
  FROM work_items, jsonb_array_elements(document->'criteria') c, jsonb_array_elements_text(c->'proofs') p
  WHERE COALESCE(document->'closure', 'null'::jsonb) = 'null'::jsonb AND (${where}) ORDER BY number`);
/** Group criterion rows by item, one link per item. */
function linksOf(rows: { id: string; key: string; title: string; stage: string; criterion: string; text: string }[]): ProofLink[] {
  const byWork = new Map<string, ProofLink>();
  for (const row of rows) {
    const entry = byWork.get(row.key) ?? { id: row.id, key: row.key, title: row.title, stage: row.stage, criteria: [] };
    if (!entry.criteria.some(criterion => criterion.id === row.criterion)) entry.criteria.push({ id: row.criterion, text: row.text });
    byWork.set(row.key, entry);
  }
  return [...byWork.values()];
}

/** Every manual: proof and every proof answered as a closed question, with its item, criterion and state (GY-3278). */
export async function judgedProofs(db: Queryable): Promise<JudgedProof[]> {
  const rows = (await criterionRows(db, `p LIKE 'manual:%' OR p IN (SELECT q->>'proof' FROM jsonb_array_elements(COALESCE(document->'closedQuestions', '[]'::jsonb)) q)`, true)).rows;
  const proofs = new Map<string, JudgedProof>();
  for (const row of rows) {
    const id = `${row.key} ${row.proof}`, existing = proofs.get(id);
    if (existing) { existing.link.criteria.push({ id: row.criterion, text: row.text }); continue; }
    const latest = ((row.evidence ?? []) as Evidence[]).filter(record => record.proof === row.proof && record.trusted && !record.revocation).at(-1);
    proofs.set(id, { proof: row.proof, link: linksOf([row])[0], record: latest ? { result: latest.result, producer: latest.producer, at: latest.at } : null });
  }
  return [...proofs.values()];
}

/** Every test case with its latest result, last change, failure history and flakiness: the Tests page. */
export async function testSummary(db: Queryable): Promise<{ window: number; cases: CaseSummary[] }> {
  const withdrawn = await withdrawnEvidence(db);
  const definitions: Scenario[] = (await db.query('SELECT DISTINCT ON (id) document FROM scenarios ORDER BY id, revision DESC')).rows.map(row => row.document);
  const recent = (await db.query(`SELECT seq, scenario, document FROM (SELECT seq, scenario, document, row_number() OVER (PARTITION BY scenario ORDER BY seq DESC) AS n FROM scenario_runs) ranked WHERE n <= $1 ORDER BY scenario, seq DESC`, [historyWindow])).rows;
  // Withdrawn failures are not failures: counted and selected in SQL, so the whole history is never loaded.
  const excluded = [...withdrawn];
  const totals = (await db.query(`SELECT scenario, count(*) AS runs, count(*) FILTER (WHERE document->>'result' = 'fail' AND NOT (document->>'evidenceId' = ANY($1::text[]))) AS failures FROM scenario_runs GROUP BY scenario`, [excluded])).rows;
  const lastFailures = (await db.query(`SELECT DISTINCT ON (scenario) seq, scenario, document FROM scenario_runs WHERE document->>'result' = 'fail' AND NOT (document->>'evidenceId' = ANY($1::text[])) ORDER BY scenario, seq DESC`, [excluded])).rows;
  const links = (await criterionRows(db, `p LIKE 'e2e:%'`)).rows.map(row => ({ ...row, scenario: row.proof.slice(4) }));
  // A case work links to is listed even before its definition is synced or it has run (GY-3194).
  const ids = [...new Set([...definitions.map(d => d.id), ...recent.map(row => row.scenario as string), ...links.map(row => row.scenario as string)])].sort();
  const cases: CaseSummary[] = [];
  for (const id of ids) {
    const definition = definitions.find(d => d.id === id);
    const history = recent.filter(row => row.scenario === id).map(row => toRun(row, withdrawn));
    const total = totals.find(row => row.scenario === id);
    const failure = lastFailures.find(row => row.scenario === id);
    const lastFailure = failure ? toRun(failure, withdrawn) : null;
    const failures = Number(total?.failures ?? 0);
    const latest = history.find(run => !run.withdrawn) ?? null;
    cases.push({ id, title: definition?.title ?? null, purpose: definition?.purpose ?? null, testPath: definition?.testPath ?? null, environment: definition?.environment ?? null,
      revision: definition?.revision ?? null, changed: definition ? { at: definition.createdAt, by: definition.createdBy } : null, links: linksOf(links.filter(row => row.scenario === id)),
      latest, staleRevision: !!latest && !!definition && latest.scenarioRevision !== null && latest.scenarioRevision < definition.revision,
      runs: Number(total?.runs ?? 0), failures, lastFailure, ...(({ flaky, reason }) => ({ flaky, flakyReason: reason }))(flakiness(history)), history });
  }
  return { window: historyWindow, cases };
}

/** One case's runs, newest first, paged by ledger sequence: `before` is the previous page's `next`. */
export async function runHistory(db: Queryable, id: string, params: URLSearchParams): Promise<{ runs: ScenarioRun[]; next: number | null }> {
  const before = params.get('before'), limit = Number(params.get('limit') ?? 50);
  demand(before === null || /^[1-9]\d{0,17}$/.test(before), 'before must be a run sequence number', 400);
  demand(Number.isInteger(limit) && limit >= 1 && limit <= 200, 'limit must be between 1 and 200', 400);
  const rows = (await db.query('SELECT seq, document FROM scenario_runs WHERE scenario=$1 AND ($2::bigint IS NULL OR seq < $2::bigint) ORDER BY seq DESC LIMIT $3', [id, before, limit + 1])).rows;
  const withdrawn = await withdrawnEvidence(db);
  const runs = rows.slice(0, limit).map(row => toRun(row, withdrawn));
  return { runs, next: rows.length > limit ? runs.at(-1)!.seq : null };
}
