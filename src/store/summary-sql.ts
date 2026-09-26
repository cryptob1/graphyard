import { detoasted } from './coordination-sql.js';

/**
 * The summary the work snapshot serves for a settled delivery (GY-422), built in SQL.
 *
 * The snapshot every client polls used to carry every delivered and closed item whole — every
 * evidence record, session, action row and pipeline attempt it ever had — and grew with history:
 * 22 MB and 47 s on a ledger of two thousand sessions. No reader of it needs a finished delivery's
 * history. A settled delivery is the one `settledSql` (coordination-sql.ts) names — done, with
 * nothing owed and nothing running — and the work index already stores the coordination view's
 * form of it at write time: its decision state (key, stage, policy, delivery or closure, candidate,
 * the evidence that binds the candidate, the observation's merge facts) without its histories.
 * The loop has read settled items in exactly that form since GY-203.
 *
 * The summary is that stored form, without the prose no snapshot reader renders (the description,
 * the research brief, answered human requests), and with the three things the readers derive
 * figures from, each bounded:
 *
 * - `pipeline`: the timeline reduced to what the speed report measures (each attempt's claim and
 *   end, the submission, rework rounds, hand-offs, the reconstruction's coverage);
 * - `sessions`: only those that ended in the last `summarySessionWindowMs`, which the Workers page
 *   counts per account;
 * - `completedActions`: how many action rows it completed, which the action report totals.
 *
 * `summary: true` is how a reader tells it from a document; `GET /api/work/:id` answers the whole
 * document, history included, for the reader that needs it.
 */
export const summarySessionWindowMs = 24 * 3_600_000;
/** What the stored settled form carries that no snapshot reader renders, left out of the summary. */
export const summaryOmitted = ['description', 'researchBrief', 'humanRequests', 'sessions', 'pipeline'] as const;

const array = (path: string) => `(CASE WHEN jsonb_typeof(${path}) = 'array' THEN ${path} ELSE '[]'::jsonb END)`;
/** The timeline `p` as the speed report reads it (pipelineSpeed in src/pipeline-speed.ts). */
const compactPipeline = (p: string) => `jsonb_build_object('submittedAt', ${p}->'submittedAt', 'reworkRounds', ${p}->'reworkRounds', 'interventions', ${p}->'interventions', 'backfill', ${p}->'backfill',
  'attempts', (SELECT COALESCE(jsonb_agg(jsonb_build_object('claimedAt', a.entry->'claimedAt', 'endedAt', a.entry->'endedAt') ORDER BY a.position), '[]'::jsonb) FROM jsonb_array_elements(${array(`${p}->'attempts'`)}) WITH ORDINALITY AS a(entry, position)))`;
const recentSessions = (sessions: string) => `(SELECT COALESCE(jsonb_agg(s.entry ORDER BY s.position), '[]'::jsonb) FROM jsonb_array_elements(${array(sessions)}) WITH ORDINALITY AS s(entry, position)
  WHERE graphyard_timestamptz(COALESCE(s.entry->>'endedAt', s.entry->>'updatedAt', s.entry->>'startedAt')) >= statement_timestamp() - interval '${summarySessionWindowMs} milliseconds')`;

/**
 * Every settled delivery's summary with its item number, one row each: the work index's stored
 * form (read once, as `d.summary`) and, from the item's document (read once, as `h`), the bounded
 * timeline, recent sessions and completed-action count.
 */
export const settledSummariesSql = `SELECT d.number, (d.summary ${summaryOmitted.map(field => `- '${field}'`).join(' ')})
    || jsonb_build_object('sessions', ${recentSessions('h.sessions')}, 'completedActions', (SELECT count(*) FROM jsonb_array_elements(${array('h.history')}) AS r(entry) WHERE r.entry->>'result' = 'done'), 'summary', true)
    || CASE WHEN jsonb_typeof(h.pipeline) = 'object' THEN jsonb_build_object('pipeline', ${compactPipeline('h.pipeline')}) ELSE '{}'::jsonb END AS document
  FROM (SELECT i.number, i.id, ${detoasted('i.summary')} AS summary FROM work_index i WHERE i.settled OFFSET 0) d
  CROSS JOIN LATERAL (SELECT x.document->'pipeline' AS pipeline, x.document->'sessions' AS sessions, x.document->'actionQueue'->'history' AS history
    FROM (SELECT ${detoasted('w.document')} AS document FROM work_items w WHERE w.id = d.id OFFSET 0) x) h`;
