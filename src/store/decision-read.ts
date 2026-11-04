import { sharedResources } from '../coordination.js';
import type { Work } from '../model.js';
import { followUpRequest } from '../model/observation-window.js';
import type { Queryable } from './locked-read.js';

/**
 * A single-item decision's inputs. Read documents only for the focus, prerequisites, follow-up
 * parent and bootstrap proof issuers/provers. Resource conflicts need only the index's lease and
 * resource names. The index trigger keeps these selectors atomic with every document write.
 * Call inside the decision's transaction; the caller retains its locks and revision checks.
 */
export async function decisionWork(db: Queryable, focus: readonly (string | null | undefined)[], submissionPr?: number): Promise<Work[]> {
  const works = new Map<string, Work>();
  const read = async (refs: string[]) => {
    if (!refs.length) return;
    const rows = (await db.query(`SELECT w.document FROM work_index i JOIN work_items w ON w.id = i.id
      WHERE (i.id::text = ANY($1::text[]) OR i.key = ANY($1::text[])) AND NOT (i.id::text = ANY($2::text[])) ORDER BY i.number`, [refs, [...works.keys()]])).rows;
    for (const row of rows) works.set(row.document.id, row.document);
  };
  await read(focus.filter((ref): ref is string => !!ref));
  if (!works.size) return [];
  const focused = [...works.values()];
  // Bootstrap declarations are global obligations; their proven deliveries retire them even when
  // the delivery is not a dependency of this item. Do not substitute a missing proof with a pass.
  const issuers = (await db.query("SELECT id::text AS id FROM work_index WHERE peers->'bootstrap' = 'true'::jsonb ORDER BY number", [])).rows;
  await read(issuers.map(row => row.id));
  const proofs = [...new Set([...works.values()].flatMap(work => work.criteria.flatMap(ac => ac.bootstrap ? ac.proofs : [])))];
  if (proofs.length) await read((await db.query("SELECT id::text AS id FROM work_index WHERE peers->'proofs' ?| $1::text[] ORDER BY number", [proofs])).rows.map(row => row.id));
  // Transitive prerequisites also supply inherited contracts. Follow-up parents are not always
  // declared dependencies (legacy post-deployment filings), but their delivery binds the reading.
  for (;;) {
    const before = works.size;
    await read([...works.values()].flatMap(work => [...work.dependencies, followUpRequest(work)?.work].filter((id): id is string => !!id && !works.has(id))));
    if (works.size === before) break;
  }
  // A submitted PR may already belong to an otherwise unrelated item.
  if (submissionPr !== undefined) await read((await db.query("SELECT id::text AS id FROM work_index WHERE peers->'submissionPr' = to_jsonb($1::int)", [submissionPr])).rows.map(row => row.id));
  // Read compact in-flight peers: path scopes can overlap without exact string equality.
  const rows = (await db.query(`SELECT id::text AS id, key, stage, peers FROM work_index
    WHERE jsonb_typeof(peers->'lease') = 'object'
      OR (stage <> 'done' AND jsonb_typeof(peers->'submission') = 'object') ORDER BY number`, [])).rows;
  for (const row of rows) if (!works.has(row.id)) {
    const peer = {
      id: row.id, key: row.key, stage: row.stage, lease: row.peers.lease, exclusiveResources: row.peers.resources,
      submission: row.peers.submission, reworkRequested: row.peers.reworkRequested,
      candidate: row.peers.candidate ? {} : null, observation: { files: row.peers.files ?? [] },
      criteria: [], dependencies: [], evidence: [], workspaces: [],
    } as unknown as Work;
    if (focused.some(work => sharedResources(work, peer).length)) works.set(row.id, peer);
  }
  return [...works.values()];
}
