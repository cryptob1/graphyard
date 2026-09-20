import type pg from 'pg';
import { z } from 'zod';
import { demand } from './model.js';

/**
 * Reading an item's history.
 *
 * The ledger is append-only and complete, but the read that served it returned the latest 300
 * rows of everything, and the control plane writes two rows continuously: one `github.observed`
 * per reconciliation pass and one `heartbeat` per worker renewal. On a real item those two kinds
 * are 60-98% of the ledger, so the last 300 rows covered roughly two hours and the claims,
 * submissions, verdicts, reworks and evidence that describe a delivery fell off the end of the
 * page. Nothing was lost; it was unreachable.
 *
 * This read makes the whole lifetime reachable: the routine kinds are summarised as counts with
 * their first and last instants instead of being paged through, every other row is returned in
 * `seq` order behind a cursor, and `kind`, `since` and `until` narrow the scan. Nothing is
 * dropped silently — what the default filter left out is reported beside the rows it returned,
 * and an exhausted summary scan says so.
 */
export const routineEventKinds = ['github.observed', 'heartbeat'] as const;
export type RoutineEventKind = typeof routineEventKinds[number];
/** Page size, hard page cap, and the bound on the rows one routine summary aggregates. */
export const eventHistoryLimits = { page: 300, maxPage: 1000, summaryScan: 100_000, pages: 200 } as const;

export interface EventHistoryQuery {
  /** One work item, or the whole ledger when null. */
  work: string | null;
  /** Exactly the kinds to return; empty means every kind the routine filter leaves. */
  kinds: string[];
  /** Half-open [since, until) on the recorded instant. */
  since: string | null; until: string | null;
  /** Exclusive `seq` boundary of the previous page, in the direction of `order`. */
  cursor: string | null;
  limit: number;
  order: 'asc' | 'desc';
  /** Routine rows are excluded unless the caller asks for them explicitly. */
  routine: 'exclude' | 'include';
  /** `full` keeps the event's whole payload; `details` drops the work snapshot it embeds. */
  payload: 'full' | 'details' | 'none';
  /**
   * `rows` answers with the event array alone; `history` adds paging and the routine summary;
   * `page` is `history` without the summary, for the pages after the first of one walk — the
   * summary covers the whole filtered range, so recomputing it per page only repeats an aggregate.
   */
  view: 'rows' | 'history' | 'page';
}

const kindPattern = /^[\w.:-]{1,100}$/;
export const eventHistorySchema = z.object({
  work: z.string().uuid().nullish(),
  kind: z.array(z.string().regex(kindPattern, 'An event kind is 1-100 characters of letters, digits, dot, colon, dash or underscore')).max(25).default([]),
  since: z.string().datetime().nullish(), until: z.string().datetime().nullish(),
  cursor: z.string().regex(/^\d{1,19}$/, 'A cursor is the seq of the last row of the previous page').nullish(),
  limit: z.coerce.number().int().min(1).max(eventHistoryLimits.maxPage).default(eventHistoryLimits.page),
  order: z.enum(['asc', 'desc']).default('desc'),
  routine: z.enum(['exclude', 'include']).default('exclude'),
  payload: z.enum(['full', 'details', 'none']).default('full'),
  view: z.enum(['rows', 'history', 'page']).default('rows'),
}).strict();

/** Query parameters as the HTTP routes receive them; `kind` may repeat or carry a comma-separated list. */
export function parseEventHistoryQuery(params: URLSearchParams): EventHistoryQuery {
  const single = (name: string) => { const value = params.get(name); return value === null || value === '' ? undefined : value; };
  const kinds = params.getAll('kind').flatMap(value => value.split(',')).map(value => value.trim()).filter(Boolean);
  const parsed = eventHistorySchema.parse({
    work: single('work'), kind: kinds, since: single('since'), until: single('until'), cursor: single('cursor'),
    limit: single('limit'), order: single('order'), routine: single('routine'), payload: single('payload'), view: single('view'),
  });
  demand(!(parsed.since && parsed.until) || Date.parse(parsed.since!) <= Date.parse(parsed.until!), 'until must not precede since', 400);
  return { work: parsed.work ?? null, kinds: [...new Set(parsed.kind)], since: parsed.since ?? null, until: parsed.until ?? null,
    cursor: parsed.cursor ?? null, limit: parsed.limit, order: parsed.order, routine: parsed.routine, payload: parsed.payload, view: parsed.view };
}

/**
 * Which kinds this query returns and which routine kinds it leaves out. Naming a routine kind
 * explicitly selects it: a caller that asks for `heartbeat` is not asking to be protected from it.
 */
export function eventSelection(query: Pick<EventHistoryQuery, 'kinds' | 'routine'>): { kinds: string[]; excluded: RoutineEventKind[] } {
  const kinds = [...new Set(query.kinds)];
  const excluded = query.routine === 'include' ? [] : routineEventKinds.filter(kind => !kinds.includes(kind));
  return { kinds, excluded };
}

interface Sql { text: string; values: unknown[] }
const builder = () => { const values: unknown[] = []; return { values, param: (value: unknown) => `$${values.push(value)}` }; };

/** One page of events: bounded, cursor-paged, and ordered by the ledger's own sequence. */
export function eventHistorySql(query: EventHistoryQuery): Sql {
  const { values, param } = builder();
  const { kinds, excluded } = eventSelection(query);
  const where: string[] = [];
  if (query.work) where.push(`work_id=${param(query.work)}::uuid`);
  if (kinds.length) where.push(`kind=ANY(${param(kinds)}::text[])`);
  else if (excluded.length) where.push(`NOT (kind=ANY(${param([...excluded])}::text[]))`);
  if (query.since) where.push(`created_at>=${param(query.since)}::timestamptz`);
  if (query.until) where.push(`created_at<${param(query.until)}::timestamptz`);
  if (query.cursor) where.push(`seq${query.order === 'asc' ? '>' : '<'}${param(query.cursor)}::bigint`);
  const columns = query.payload === 'none' ? '' : query.payload === 'details' ? ", payload->'details' AS details" : ', payload';
  // One row beyond the page proves whether another page exists without a second count.
  return { text: `SELECT seq,work_id,actor,kind,created_at${columns} FROM events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY seq ${query.order === 'asc' ? 'ASC' : 'DESC'} LIMIT ${param(query.limit + 1)}`, values };
}

/**
 * The excluded routine rows, as counts with their first and last instants over the whole
 * filtered range — not just the current page, so every page says the same thing about what the
 * default filter left out. The aggregate is bounded; an exhausted bound is reported, never hidden.
 */
export function routineSummarySql(query: EventHistoryQuery, scan: number = eventHistoryLimits.summaryScan): Sql | null {
  const { excluded } = eventSelection(query);
  if (!excluded.length) return null;
  const { values, param } = builder();
  const where: string[] = [`kind=ANY(${param([...excluded])}::text[])`];
  if (query.work) where.push(`work_id=${param(query.work)}::uuid`);
  if (query.since) where.push(`created_at>=${param(query.since)}::timestamptz`);
  if (query.until) where.push(`created_at<${param(query.until)}::timestamptz`);
  // Newest first inside the bound: when the cap truncates an enormous range, the rows summarised
  // are the ones next to the page being read.
  return { text: `SELECT kind, count(*)::int AS count, min(created_at) AS first_at, max(created_at) AS last_at, min(seq) AS first_seq, max(seq) AS last_seq
      FROM (SELECT kind, created_at, seq FROM events WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT ${param(scan)}) sampled
     GROUP BY kind ORDER BY kind`, values };
}

export interface RoutineKindSummary { kind: string; count: number; firstAt: string | null; lastAt: string | null; firstSeq: string | null; lastSeq: string | null }
export interface RoutineSummary {
  included: boolean; excluded: string[]; kinds: RoutineKindSummary[]; total: number;
  scanLimit: number; truncated: boolean; statement: string;
}
const iso = (value: Date | string | null | undefined) => value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null;
const count = (value: number) => value.toLocaleString('en-US');

/** Shape the aggregate rows into the disclosure the read returns beside its page. */
export function summariseRoutine(query: EventHistoryQuery, rows: any[], scan: number = eventHistoryLimits.summaryScan): RoutineSummary {
  const { excluded } = eventSelection(query);
  if (!excluded.length) {
    return { included: true, excluded: [], kinds: [], total: 0, scanLimit: scan, truncated: false,
      statement: query.routine === 'include' ? 'Routine rows (github.observed, heartbeat) are included in this read.' : 'Every routine kind was named explicitly, so nothing was excluded.' };
  }
  const kinds: RoutineKindSummary[] = rows.map(row => ({ kind: row.kind, count: Number(row.count), firstAt: iso(row.first_at), lastAt: iso(row.last_at), firstSeq: row.first_seq === null || row.first_seq === undefined ? null : String(row.first_seq), lastSeq: row.last_seq === null || row.last_seq === undefined ? null : String(row.last_seq) }));
  const total = kinds.reduce((sum, entry) => sum + entry.count, 0);
  const truncated = total >= scan;
  const described = kinds.filter(entry => entry.count).map(entry => `${count(entry.count)} ${entry.kind} between ${entry.firstAt} and ${entry.lastAt}`);
  return { included: false, excluded: [...excluded], kinds, total, scanLimit: scan, truncated,
    statement: total
      ? `${count(total)} routine row(s) were excluded from this read and summarised instead: ${described.join('; ')}. Pass routine=include to page through them.${truncated ? ` The summary aggregated the newest ${count(scan)} routine rows of the range; earlier ones are not counted here.` : ''}`
      : `No routine row (${excluded.join(', ')}) falls inside this read's filters.` };
}

export interface EventHistoryPage {
  observedAt: string;
  filters: { work: string | null; kinds: string[]; since: string | null; until: string | null; order: 'asc' | 'desc'; limit: number; routine: 'exclude' | 'include'; payload: 'full' | 'details' | 'none' };
  events: any[];
  page: { returned: number; hasMore: boolean; nextCursor: string | null; firstSeq: string | null; lastSeq: string | null; firstAt: string | null; lastAt: string | null };
  /** The disclosure of what the filter left out; null for a read that did not ask for it (`rows`, `page`). */
  routine: RoutineSummary | null;
}

/**
 * One bounded page of history and the disclosure of what the filter left out. Paging with
 * `order=asc` and the returned `nextCursor` walks an item's whole lifetime, however old, in
 * `limit`-sized reads that never revisit a row.
 */
export async function readEventHistory(pool: pg.Pool, query: EventHistoryQuery, scan: number = eventHistoryLimits.summaryScan): Promise<EventHistoryPage> {
  const page = eventHistorySql(query);
  // The aggregate is only ever read through the history view, so the bare row read never pays for it.
  const summary = query.view === 'history' ? routineSummarySql(query, scan) : null;
  const [clock, rows, routineRows] = await Promise.all([
    pool.query('SELECT clock_timestamp() AS now'),
    pool.query(page.text, page.values),
    summary ? pool.query(summary.text, summary.values) : Promise.resolve({ rows: [] as any[] }),
  ]);
  const hasMore = rows.rows.length > query.limit;
  const events = rows.rows.slice(0, query.limit).map(row => ({ ...row, seq: String(row.seq) }));
  const last = events.at(-1);
  return {
    observedAt: (clock.rows[0].now as Date).toISOString(),
    filters: { work: query.work, kinds: query.kinds, since: query.since, until: query.until, order: query.order, limit: query.limit, routine: query.routine, payload: query.payload },
    events,
    page: { returned: events.length, hasMore, nextCursor: hasMore && last ? last.seq : null,
      firstSeq: events[0]?.seq ?? null, lastSeq: last?.seq ?? null,
      firstAt: iso(events[0]?.created_at) ?? null, lastAt: iso(last?.created_at) ?? null },
    routine: query.view === 'history' ? summariseRoutine(query, routineRows.rows, scan) : null,
  };
}

/**
 * The same vocabulary on the command line: `graphyard events GY-N --kind claim,submit --since …`.
 * `--routine` is the explicit flag that returns the rows the default summarises, and `--all`
 * follows the cursor to the end of the range instead of stopping at one page.
 */
export interface EventHistoryFlags { params: URLSearchParams; all: boolean }
const valueFlags = new Set(['kind', 'since', 'until', 'limit', 'order', 'cursor', 'payload']);
export const eventsUsage = 'Use events GY-N [--kind K[,K]] [--since ISO] [--until ISO] [--order asc|desc] [--limit N] [--cursor SEQ] [--payload full|details|none] [--routine] [--all]';

export function parseEventHistoryFlags(args: string[]): EventHistoryFlags {
  const params = new URLSearchParams();
  let all = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    demand(argument.startsWith('--'), `Unexpected argument ${argument}. ${eventsUsage}`, 400);
    const name = argument.slice(2);
    if (name === 'routine') { params.set('routine', 'include'); continue; }
    if (name === 'all') { all = true; continue; }
    demand(valueFlags.has(name), `Unknown flag ${argument}. ${eventsUsage}`, 400);
    const value = args[++index];
    demand(value !== undefined && !value.startsWith('--'), `${argument} needs a value. ${eventsUsage}`, 400);
    if (name === 'kind') for (const kind of value.split(',').map(entry => entry.trim()).filter(Boolean)) params.append('kind', kind);
    else params.set(name, value);
  }
  // Reading a whole lifetime reads it forwards, unless the caller asked for an order itself.
  if (all && !params.has('order')) params.set('order', 'asc');
  return { params, all };
}
