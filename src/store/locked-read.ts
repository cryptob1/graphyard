import type { Work } from '../model.js';
import { pathScope } from '../model/scope.js';
import { coordinationDocumentSql, coordinationRelevance, coordinationTail, detoasted } from './coordination-sql.js';

/**
 * What a coordination decision reads of the board while it holds the coordination lock (GY-1027).
 *
 * About twenty write paths read every work item's whole document inside the locked transaction —
 * claims, selections, renewals, submissions, observations and each reconciliation batch. On
 * 2026-10-01 the ledger held ~1000 documents (62 MB, 570 of them delivered), one such read took
 * 15-20 s, and every other coordination write queued behind it: registry selects were abandoned at
 * their client bound, leases lapsed, and the cost grew with every item ever created.
 *
 * A decision reads whole only what it acts on and what its answer turns on: the item(s) it names
 * (`focus`, by id or key), the open items that overlap them — by planned or observed files, by an
 * exclusive resource, or by sharing the merge queue — and their dependencies. Every other item is a
 * compact stand-in: an open item as the coordination view's projection (`coordinationDocumentSql`,
 * which `Store.coordinationSnapshot` serves the loop: stage, lease, queue, planned files, the
 * observation without its per-file scope, the candidate's evidence, running sessions, recent
 * histories), and a settled delivery (`settledSql`) as the work index's summary, projected on write
 * (src/store/tables/work-index.ts). Each stand-in is cached in-process by the version of the row it
 * was built from, so a read builds only the stand-ins that changed since the last one and the lock
 * hold grows with neither the history nor the open items' histories.
 *
 * A stand-in is never a document: `save` refuses one (`assertSavable`), so a path that writes an
 * item must name it in `focus`, or read it whole itself.
 */
export type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[] }> };

const summaries = new WeakSet<object>(), projections = new WeakSet<object>();
/** Stand-ins as JSON text by the version of the row each was built from, in insertion order; bounded so a long-lived process stays bounded. */
const cache = new Map<string, string>();
export const lockedSummaryCacheLimit = 20_000;

/** Whether `work` is a settled delivery's summary handed out by `lockedWork` rather than its document. */
export const isSettledSummary = (work: object) => summaries.has(work);
/** Whether `work` is any stand-in `lockedWork` handed out — a settled summary or an open item's projection — rather than its document. */
export const isStandIn = (work: object) => summaries.has(work) || projections.has(work);
/** Refuse to save a stand-in over the document it stands for. */
export function assertSavable(work: Work) {
  if (isStandIn(work)) throw new Error(`${work.key} was read as a ${summaries.has(work) ? 'settled summary' : 'compact projection'}; a write to it must read it as its document (name it in lockedWork's focus)`);
}

export interface LockedReadOptions {
  /** Lock the documents read whole. */
  forUpdate?: boolean;
  /** A reconciliation batch's own rows (GY-1027): the first `limit` unsettled items numbered after `after` are read whole too. */
  after?: number; limit?: number;
}

/** Every work item in number order, read for a decision under the coordination lock (see the module comment). */
export async function lockedWork(db: Queryable, focus: readonly (string | null | undefined)[] = [], options: LockedReadOptions = {}): Promise<Work[]> {
  return (await lockedRows(db, focus, options)).map(row => row.document);
}
/** `lockedWork` with each item's number, which orders the board. */
export async function lockedRows(db: Queryable, focus: readonly (string | null | undefined)[] = [], { forUpdate = false, after, limit }: LockedReadOptions = {}): Promise<{ number: number; document: Work }[]> {
  const named = focus.filter((entry): entry is string => !!entry);
  // Versions: a stand-in is keyed by the row it was built from — the document's row for a projection,
  // the index row for a summary. Either is rewritten (new xmin) with every write to the item, and
  // transaction ids are never reused within a cluster's lifetime, which the postmaster's start time
  // and the database name scope.
  const listed: Listed[] = (await db.query(`SELECT w.number, w.id::text AS id, w.xmin::text AS wx, i.xmin::text AS ix, COALESCE(i.settled AND i.summary IS NOT NULL, false) AS settled,
    (w.id::text = ANY($1::text[]) OR i.key = ANY($1::text[])) AS focus FROM work_items w LEFT JOIN work_index i ON i.id = w.id ORDER BY w.number`, [named])).rows
    .map(row => ({ number: Number(row.number), id: row.id, wx: row.wx, ix: row.ix, settled: row.settled, focus: row.focus }));
  const cluster = (await db.query("SELECT current_database() || ':' || pg_postmaster_start_time()::text AS cluster")).rows[0].cluster as string;
  const versionOf = (row: Listed) => row.settled ? `${cluster}/i/${row.id}:${row.ix}` : `${cluster}/w/${row.id}:${row.wx}`;

  const whole = new Map<number, Work>();
  const own = after === undefined || !limit ? [] : listed.filter(row => !row.settled && !row.focus && row.number > after).slice(0, limit);
  await readWhole(db, [...listed.filter(row => row.focus), ...own].map(row => row.number), forUpdate, whole);

  // The stand-ins: what this call fetched is kept for this call, since the bounded cache may evict it before it is used.
  const fetched = new Map<string, string>();
  const rest = listed.filter(row => !whole.has(row.number));
  const missingSummaries = rest.filter(row => row.settled && !cache.has(versionOf(row))).map(row => row.id);
  if (missingSummaries.length) {
    for (const row of (await db.query(`SELECT id::text AS id, xmin::text AS ix, summary::text AS text FROM work_index WHERE settled AND summary IS NOT NULL AND id::text = ANY($1::text[])`, [missingSummaries])).rows) {
      const version = `${cluster}/i/${row.id}:${row.ix}`;
      fetched.set(row.id, row.text); remember(version, row.text);
    }
  }
  const missingProjections = rest.filter(row => !row.settled && !cache.has(versionOf(row))).map(row => row.number);
  if (missingProjections.length) {
    for (const row of (await db.query(`SELECT d.id, d.wx, x.document::text AS text
      FROM (SELECT w.id::text AS id, w.xmin::text AS wx, ${detoasted('w.document')} AS document FROM work_items w WHERE w.number = ANY($1::bigint[]) OFFSET 0) d
      CROSS JOIN ${coordinationRelevance(coordinationTail)} CROSS JOIN LATERAL (SELECT ${coordinationDocumentSql} AS document) x`, [missingProjections])).rows) {
      fetched.set(row.id, row.text); remember(`${cluster}/w/${row.id}:${row.wx}`, row.text);
    }
  }
  const standIns = new Map<number, Work>();
  for (const row of rest) {
    const text = fetched.get(row.id) ?? cache.get(versionOf(row));
    // Changed between the two reads (a settled item reopened, say): it is read whole below.
    if (!text) continue;
    const document = JSON.parse(text) as Work;
    (row.settled ? summaries : projections).add(document);
    standIns.set(row.number, document);
  }

  // What the focus's answer turns on, read whole: its dependencies and the open items that overlap it.
  const focused = listed.filter(row => row.focus && whole.has(row.number)).map(row => whole.get(row.number)!);
  const related = new Set<number>();
  for (const row of rest) {
    if (!standIns.has(row.number)) { related.add(row.number); continue; }
    const other = standIns.get(row.number)!;
    if (focused.some(work => (work.dependencies ?? []).includes(row.id) || (!row.settled && overlaps(work, other)))) related.add(row.number);
  }
  await readWhole(db, [...related], forUpdate, whole);

  const rows: { number: number; document: Work }[] = [];
  for (const row of listed) {
    const document = whole.get(row.number) ?? standIns.get(row.number);
    if (document) rows.push({ number: row.number, document });
  }
  return rows;
}

type Listed = { number: number; id: string; wx: string; ix: string | null; settled: boolean; focus: boolean };

async function readWhole(db: Queryable, numbers: number[], forUpdate: boolean, into: Map<number, Work>) {
  const wanted = numbers.filter(number => !into.has(number));
  if (!wanted.length) return;
  for (const row of (await db.query(`SELECT number, document FROM work_items WHERE number = ANY($1::bigint[]) ORDER BY number${forUpdate ? ' FOR UPDATE' : ''}`, [wanted])).rows) into.set(Number(row.number), row.document as Work);
}

/**
 * Whether an open item's answer can turn on `other`: they name an overlapping file (planned or
 * observed on the candidate), share an exclusive resource, or both hold merge-queue entries.
 */
function overlaps(work: Work, other: Work) {
  if (work.id === other.id) return true;
  if (work.queue && other.queue) return true;
  const resources = new Set(work.exclusiveResources ?? []);
  if ((other.exclusiveResources ?? []).some(resource => resources.has(resource))) return true;
  const mine = scopesOf(work);
  if (!mine.length) return false;
  return scopesOf(other).some(theirs => mine.some(scope => scope.path === theirs.path || scope.prefix && theirs.path.startsWith(scope.path) || theirs.prefix && scope.path.startsWith(theirs.path)));
}
const scopes = new WeakMap<Work, { path: string; prefix: boolean }[]>();
function scopesOf(work: Work) {
  let known = scopes.get(work);
  if (!known) scopes.set(work, known = [...(work.plannedFiles ?? []), ...(work.observation?.files ?? [])].map(pathScope));
  return known;
}

function remember(version: string, text: string) {
  cache.delete(version);
  cache.set(version, text);
  while (cache.size > lockedSummaryCacheLimit) cache.delete(cache.keys().next().value!);
}

/**
 * The id of the work item `param` names by id or display key, resolved on the work index, so a
 * lookup by key reads one index row instead of scanning (and detoasting) every document's key.
 */
export const workIdByRef = (param: string) => `(SELECT id FROM work_index WHERE id::text = ${param} OR key = ${param} ORDER BY number LIMIT 1)`;
