/**
 * The coordination view's document, built in SQL (GY-185, GY-203).
 *
 * `coordinationWork` (src/server/work-view.ts) is the rule; this is its SQL form, applied before a
 * document leaves the database so the histories it bounds are never loaded whole. The same builder
 * serves two readers: `Store.coordinationSnapshot`, over a live item's stored document, and the
 * work index's projection function (src/store/tables/work-index.ts), which stores a settled
 * delivery's summary at write time so the snapshot never reads that document at all.
 *
 * Every fragment reads the document as `d.document`, which the reader selects through `detoasted`.
 */

/**
 * A document expression read from storage once. A stored document is a TOAST
 * pointer, and every `d.document->` in the fragments below — dozens per row, some inside a per-element
 * filter — would decompress the whole document again: a 100-item snapshot spent seconds doing
 * that. Concatenating an empty object materializes it; select it in a subquery with `OFFSET 0`,
 * which keeps the planner from inlining the expression back into each reference.
 */
export const detoasted = (document: string) => `(${document} || '{}'::jsonb)`;

/**
 * The history each live coordination-view document keeps, the attempt records each of its resolved
 * action rows keeps, and the finished sessions it keeps beside its running ones: the SQL side of
 * `coordinationHistoryLimit`, `coordinationRecordLimit` and `coordinationSessionLimit` in
 * src/server/work-view.ts, which must stay equal to them.
 */
export const coordinationTail = 20, coordinationRecords = 3, coordinationSessions = 5;
const array = (path: string) => `(CASE WHEN jsonb_typeof(${path}) = 'array' THEN ${path} ELSE '[]'::jsonb END)`;
/** The last `keep` entries of the array at `path`, each passed through `each` (which reads it as `<as>.entry`). */
const tail = (path: string, keep: number, each = (entry: string) => entry, as = 't') => `(SELECT COALESCE(jsonb_agg(${each(`${as}.entry`)} ORDER BY ${as}.position), '[]'::jsonb) FROM jsonb_array_elements(${array(path)}) WITH ORDINALITY AS ${as}(entry, position) WHERE ${as}.position > jsonb_array_length(${array(path)}) - ${keep})`;
/** A resolved action row with only its most recent attempt records. */
const resolvedRow = (row: string) => `CASE WHEN jsonb_typeof(${row}->'history') = 'array' THEN jsonb_set(${row}, '{history}', ${tail(`${row}->'history'`, coordinationRecords, entry => entry, 'records')}) ELSE ${row} END`;
export const length = (path: string) => `(CASE WHEN jsonb_typeof(${path}) = 'array' THEN jsonb_array_length(${path}) ELSE 0 END)`;
const object = (path: string) => `jsonb_typeof(${path}) = 'object'`;
const absent = (path: string) => `COALESCE(jsonb_typeof(${path}), 'null') NOT IN ('object', 'array')`;
const running = (entry: string) => `${entry}->>'state' = 'running'`;

/**
 * A delivery nothing is owed for any more: done, with no next action, no queue entry, no lease,
 * no containment quarantine, no action row and no running session. The SQL form of `deliverySettled`
 * in src/server/work-view.ts; the two must agree, and tests/store-locks.test.ts holds them to it.
 */
export const settledSql = `COALESCE(d.document->>'stage' = 'done' AND ${absent("d.document->'nextAction'")} AND ${absent("d.document->'queue'")} AND ${absent("d.document->'lease'")} AND ${absent("d.document->'containmentQuarantine'")}
  AND ${length("d.document->'actionQueue'->'actions'")} = 0
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${array("d.document->'sessions'")}) AS s(entry) WHERE ${running('s.entry')}), false)`;

/**
 * What makes an evidence record one the coordination view can still consult, gathered once per
 * document as the lateral `r` from one read of its top-level fields (each `d.document->` detoasts
 * the whole document again): the candidate's head and base, the heads the open review, the open
 * producer requests and the `keep` most recent dispatch requests name, and the records a carry
 * decision on the queue's tip or the base refresh carried.
 */
export const coordinationRelevance = (keep: number) => `LATERAL jsonb_to_record(d.document) AS f(candidate jsonb, "autoDispatch" jsonb, queue jsonb, "baseRefresh" jsonb)
  CROSS JOIN LATERAL (SELECT f.candidate->>'sha' AS head, f.candidate->>'baseSha' AS base,
    ARRAY(SELECT f."autoDispatch"->'review'->>'sha'
      UNION SELECT p.request->>'sha' FROM jsonb_array_elements(${array(`f."autoDispatch"->'producers'`)}) AS p(request)
      UNION SELECT h.request->>'sha' FROM jsonb_array_elements(${tail(`f."autoDispatch"->'history'`, keep)}) AS h(request)) AS requested,
    ARRAY(SELECT c.carried->>'evidenceId' FROM jsonb_array_elements(${array("f.queue->'speculation'->'carry'->'evidence'")} || ${array(`f."baseRefresh"->'carry'->'evidence'`)}) AS c(carried)
      WHERE c.carried->'carried' = 'true'::jsonb) AS carried) AS r`;
/**
 * The evidence records the coordination view keeps, decided in SQL so a long history of superseded
 * heads never leaves the database: those on the candidate's exact head and base, those a carry
 * decision carried, and those on a head a request names. The view's own filter then applies the
 * exact rule (which carry applies to the candidate), so this keeps a superset of what it keeps.
 */
const relevantEvidence = `((entry->>'sha' = r.head AND entry->>'baseSha' IS NOT DISTINCT FROM r.base)
    OR entry->>'id' = ANY(r.carried) OR entry->>'sha' = ANY(r.requested))`;

/**
 * One document as the coordination view reads it: the pipeline timeline dropped, the observation
 * without its per-file scope comparison, only the evidence records a coordinator decision can
 * still consult (read with `coordinationRelevance(keep)` joined as `r`), each without its
 * artifacts, scope digests and provenance, and the resolved dispatch requests, queue history and
 * resolved action rows cut to their `keep` most recent entries (each row to its last few attempt
 * records), and its running sessions with only the last few finished ones. A settled delivery
 * (`settled`, `keep` 0) keeps none of those histories and no finished session: nothing the loop
 * decides reads a finished delivery's history. What does read a delivery's finished sessions reads
 * the full snapshot instead — throughput attribution of coordination sessions and the session
 * summaries — and containment recovery, which needs the quarantined epoch's finished session, only
 * ever sees an unsettled item, since a quarantine keeps it out of `settledSql` (GY-257). A new
 * reader of finished sessions belongs on the full snapshot, or must unsettle what it reads.
 */
export const coordinationDocument = ({ keep, settled }: { keep: number; settled: boolean }) => `d.document - 'pipeline' - 'evidence' - 'observation' - 'queueHistory' - 'actionQueue' - 'autoDispatch' - 'sessions'
  || jsonb_build_object('evidence', (SELECT COALESCE(jsonb_agg(entry - 'artifacts' - 'scopeFiles' - 'provenance' ORDER BY position), '[]'::jsonb) FROM jsonb_array_elements(${array("d.document->'evidence'")}) WITH ORDINALITY AS e(entry, position) WHERE ${relevantEvidence}))
  || CASE WHEN d.document ? 'observation' THEN jsonb_build_object('observation', CASE WHEN ${object("d.document->'observation'")} THEN (d.document->'observation') - 'scopeFiles' ELSE d.document->'observation' END) ELSE '{}'::jsonb END
  || CASE WHEN jsonb_typeof(d.document->'queueHistory') = 'array' THEN jsonb_build_object('queueHistory', ${tail("d.document->'queueHistory'", keep)}) ELSE '{}'::jsonb END
  || CASE WHEN ${object("d.document->'actionQueue'")} THEN jsonb_build_object('actionQueue', ((d.document->'actionQueue') - 'history') || jsonb_build_object('history', ${tail("d.document->'actionQueue'->'history'", keep, resolvedRow)})) ELSE '{}'::jsonb END
  || CASE WHEN ${object("d.document->'autoDispatch'")} THEN jsonb_build_object('autoDispatch', ((d.document->'autoDispatch') - 'history') || jsonb_build_object('history', ${tail("d.document->'autoDispatch'->'history'", keep)})) ELSE '{}'::jsonb END
  || CASE WHEN jsonb_typeof(d.document->'sessions') = 'array' THEN jsonb_build_object('sessions', (SELECT COALESCE(jsonb_agg(s.entry ORDER BY s.position), '[]'::jsonb) FROM jsonb_array_elements(d.document->'sessions') WITH ORDINALITY AS s(entry, position)
    WHERE ${running('s.entry')} OR s.position > jsonb_array_length(d.document->'sessions') - ${settled ? 0 : coordinationSessions})) ELSE '{}'::jsonb END`;
/** The live document's form, as `Store.coordinationSnapshot` selects it. */
export const coordinationDocumentSql = coordinationDocument({ keep: coordinationTail, settled: false });

/** What the SQL cut from each history, per item, so the view still says how much it left out. */
export interface CoordinationTrim { evidence: number; dispatchHistory: number; queueHistory: number; actionHistory: number; sessions: number }
/** The counts `coordinationDocument` cut, given the document it built as `kept` and what it keeps of each history. */
export const coordinationTrimSql = (kept: string, keep: number) => `jsonb_build_object(
  'evidence', ${length("d.document->'evidence'")} - ${length(`${kept}->'evidence'`)},
  'dispatchHistory', GREATEST(0, ${length("d.document->'autoDispatch'->'history'")} - ${keep}),
  'queueHistory', GREATEST(0, ${length("d.document->'queueHistory'")} - ${keep}),
  'actionHistory', GREATEST(0, ${length("d.document->'actionQueue'->'history'")} - ${keep}),
  'sessions', ${length("d.document->'sessions'")} - ${length(`${kept}->'sessions'`)})`;

/**
 * The items a reconciliation pass can change (GY-727): everything that is not a settled delivery.
 * `settled` is the work index's own flag, kept current beside every write by the same trigger, so
 * the filter is an index lookup that never reads a document: the pass reads only these documents,
 * once, and takes a settled delivery's summary from the index instead of its document.
 */
export const reconcileCandidatesSql = `SELECT w.id, w.number, w.document FROM work_items w
  WHERE NOT EXISTS (SELECT 1 FROM work_index i WHERE i.id = w.id AND i.settled) ORDER BY w.number`;
/** The settled deliveries' summaries: the rest of the fleet a batch evaluates its items against. */
export const reconcileSettledSql = 'SELECT i.id, i.number, i.summary FROM work_index i WHERE i.settled ORDER BY i.number';
/** Items a pass already read that moved since, read again: the only documents a pass reads twice. */
export const reconcileRereadSql = 'SELECT w.id, w.number, w.xmin::text AS version, w.document FROM work_items w WHERE w.id = ANY($1::uuid[])';
/**
 * The versions of the rows a pass can be affected by, never their documents: the pass's own
 * candidates (`$1`) and every row not settled now, which takes in an item created or reopened
 * since. `xmin` changes with every write to the row, including the writes that bump no revision
 * (a claim renewal), so a pass that compares it with what it read knows exactly which items moved
 * since. A settled delivery that stays settled is never visited, so a batch's check grows with
 * the live items, not with the history (GY-727).
 */
export const reconcileVersionsSql = `SELECT w.id, w.xmin::text AS version FROM work_items w
  JOIN (SELECT unnest($1::uuid[]) AS id UNION SELECT i.id FROM work_index i WHERE NOT i.settled) live ON live.id = w.id`;
/**
 * One batch item's row lock, taken as the batch reaches it (GY-727), with the version of the row
 * it locked: after waiting for a writer, the version is the one that writer committed, never the
 * statement's older snapshot. Locked row by row, a batch holds only its own items, so a mutation
 * on any other item commits while the batch holds its transaction.
 */
export const reconcileItemLockSql = 'SELECT xmin::text AS version FROM work_items WHERE id = $1 FOR UPDATE';
