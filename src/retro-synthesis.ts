import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { demand, operatorCapability, type Principal } from './model.js';
import { approveCapability } from './model/approval.js';
import type { InterventionPolicy } from './model/interventions.js';
import { detectRecurringCauses, draftPrevention, foldRetroArtefacts, retroApprovalConflict, retroGovernedPath, retroLedgerKinds, retroStanding, type RetroArtefact, type RetroLedgerRow } from './model/retro-synthesis.js';
import { controlPlaneActor, foldInterventions, readInterventionLedger } from './interventions.js';
import type { Store } from './store.js';
import { boundedSnapshot } from './store/bounded-snapshot.js';

/**
 * Retro synthesis read from and written to the ledger (GY-970; see model/retro-synthesis.ts).
 *
 * `synthesizeRetro` reads the same window of interventions the pattern detector reads, groups the
 * refusals and reworks by cause, and records a `retro.drafted` row per prevention artefact for each
 * cause past the threshold. It writes nothing else: no work item, no requirement, no check. An
 * artefact takes effect only through `judgeRetroArtefact`, where an independent agent identity
 * holding `decision:approve` approves it — applying it to its governed registry at the next
 * revision in the same transaction — or refuses it. Both record the recurring pattern the draft
 * named, so its instances never produce another draft.
 */
type Db = { query: pg.Pool['query'] };
/** The newest unjudged drafts a reading folds; a registry holds tens of entries, not thousands. */
export const retroLedgerLimit = 5_000;

/**
 * Every judged artefact — its judgement and the draft it judged, however old — and the newest
 * drafts, so an applied requirement, check or catalogue entry never drops out of its registry and
 * a registry's revision never falls back as the ledger grows.
 */
export async function readRetroArtefacts(db: Db): Promise<RetroArtefact[]> {
  const result = await db.query(`SELECT seq, actor, kind, created_at, payload FROM events WHERE kind = ANY($1) AND (kind <> 'retro.drafted'
      OR seq >= COALESCE((SELECT min(seq) FROM (SELECT seq FROM events WHERE kind = 'retro.drafted' ORDER BY seq DESC LIMIT $2) newest), 0)
      OR payload->>'id' IN (SELECT payload->>'id' FROM events WHERE kind IN ('retro.applied', 'retro.refused')))
    ORDER BY seq`, [[...retroLedgerKinds], retroLedgerLimit]);
  return foldRetroArtefacts(result.rows.map((row): RetroLedgerRow => ({ seq: Number(row.seq), actor: row.actor, kind: row.kind, at: new Date(row.created_at).toISOString(), payload: row.payload })));
}

/**
 * Draft prevention artefacts for every refusal or rework cause past the detector's threshold. The
 * detection runs again under the coordination lock against the artefacts already recorded, so two
 * concurrent syntheses never draft the same instances twice.
 */
export async function synthesizeRetro(store: Store, policy: InterventionPolicy, options: { now?: string; actor?: Principal; limit?: number } = {}) {
  const snapshot = await boundedSnapshot(store.reportPool);
  const now = options.now ?? snapshot.now;
  const since = new Date(Date.parse(now) - policy.windowDays * 86_400_000).toISOString();
  const { rows, truncated } = await readInterventionLedger(store.reportPool, { limit: options.limit, since });
  const { interventions } = foldInterventions(rows, snapshot.work, now);
  const actor = options.actor ?? controlPlaneActor;
  const drafted = await store.transaction(async db => {
    const artefacts = await readRetroArtefacts(db);
    const written: RetroArtefact[] = [];
    for (const pattern of detectRecurringCauses(interventions, artefacts, policy, now)) {
      for (const draft of draftPrevention(pattern)) {
        const id = randomUUID();
        const inserted = await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3) RETURNING seq', [actor.id, 'retro.drafted', JSON.stringify({ id, at: now, draft, pattern })]);
        written.push({ ...draft, id, seq: Number(inserted.rows[0].seq), state: 'drafted', draftedBy: actor.id, draftedAt: now, pattern, approval: null, application: null, refusal: null });
      }
    }
    return written;
  });
  return { drafted, truncated };
}

/**
 * An independent judgement of one drafted artefact. Approval applies it through its governed path
 * at the registry's next revision and records the pattern it closes; refusal records why. Only an
 * agent session (an AI admin or an operator agent) holding `decision:approve` judges — never a human
 * session, the identity that drafted it, or one that recorded the instances it was drafted from.
 */
export async function judgeRetroArtefact(store: Store, actor: Principal, repository: string, id: string, verdict: 'approve' | 'refuse', reason: string) {
  demand(actor.role === 'admin' || actor.role === 'operator-agent', `Retro artefacts are judged by agent identities holding ${approveCapability}; ${actor.id} is a ${actor.role}`, 403);
  operatorCapability(actor, approveCapability, undefined, repository);
  return store.transaction(async (db, now) => {
    const artefacts = await readRetroArtefacts(db);
    const artefact = artefacts.find(entry => entry.id === id);
    demand(artefact, 'Retro artefact not found', 404);
    demand(artefact.state === 'drafted', `Retro artefact ${id} is already ${artefact.state}`, 409);
    const conflict = retroApprovalConflict(artefact, actor);
    demand(!conflict, conflict ?? '', 403);
    // Whoever wrote the recurring feedback the draft was synthesised from does not judge it either.
    const sources = artefact.pattern.instances.flatMap(instance => instance.sources.map(source => source.seq));
    const authored = sources.length ? (await db.query('SELECT 1 FROM events WHERE seq = ANY($1::bigint[]) AND actor = $2 LIMIT 1', [sources, actor.id])).rowCount : 0;
    demand(!authored, `${actor.id} recorded instances of the pattern retro artefact ${id} was drafted from; an independent agent identity must judge it`, 403);
    const at = now.toISOString();
    if (verdict === 'refuse') {
      const refusal = { by: actor.id, at, reason };
      await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, 'retro.refused', JSON.stringify({ id, refusal, closes: { cause: artefact.pattern.cause, fingerprint: artefact.pattern.fingerprint } })]);
      return { ...artefact, state: 'refused', refusal } satisfies RetroArtefact;
    }
    const standing = retroStanding(artefacts).find(entry => entry.registry === artefact.registry)!;
    const approval = { by: actor.id, at, reason, closes: { cause: artefact.pattern.cause, fingerprint: artefact.pattern.fingerprint, instances: artefact.pattern.instances.map(instance => instance.id) } };
    const application = { registry: artefact.registry, revision: standing.revision + 1, path: retroGovernedPath[artefact.registry] };
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, 'retro.applied', JSON.stringify({ id, approval, application })]);
    return { ...artefact, state: 'applied', approval, application } satisfies RetroArtefact;
  });
}

/** The read behind the API: every artefact, newest first, and what each governed registry stands at. */
export async function readRetroReport(store: Store) {
  const artefacts = await readRetroArtefacts(store.reportPool);
  return { artefacts: [...artefacts].reverse(), standing: retroStanding(artefacts), drafted: artefacts.filter(artefact => artefact.state === 'drafted').length };
}
