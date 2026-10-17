import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, type Principal, type Work } from './model.js';
import type { Store } from './store.js';
import { unexplainedShadowDisagreements } from './server/shadow-verdict.js';
import { decisionsByWork } from './server/decision-ledger.js';

/**
 * The merger setting: which writer lands heads on the base branch, the `control-plane` (the shipped
 * default since GY-1833) or `github`, the legacy mode the setup checklist flags. A database that held
 * history before the default changed was pinned to `github` by its migration
 * (src/store/tables/merger-default.ts), so no install changes merger without the event below.
 * Like direct-merge mode it lives on the append-only ledger (`policy.merger.set`, no work item), is
 * set only with an admin credential, and is never read from graphyard.json or the environment. Switching to `control-plane` is refused while any shadow-only-fail or shadow-missed
 * verdict stands unexplained (GY-1560); setting `github` is never refused for that reason.
 */
export const mergerModes = ['github', 'control-plane'] as const;
export type MergerMode = typeof mergerModes[number];
export const mergerEventKind = 'policy.merger.set';
export const defaultMergerMode: MergerMode = 'control-plane';

export interface MergerSetting { merger: MergerMode; since: string | null; setBy: string | null; reason: string | null; event: string | null }
type Queryable = Pick<pg.PoolClient, 'query'>;
const changeSchema = z.object({ merger: z.enum(mergerModes), reason: z.string().trim().min(1).max(1000) }).strict();

const settingOf = (row: any): MergerSetting => ({ merger: row.payload.merger, since: new Date(row.created_at).toISOString(), setBy: row.actor, reason: row.payload.reason ?? null, event: String(row.seq) });

/** Every recorded change, oldest first. */
export async function mergerHistory(db: Queryable): Promise<MergerSetting[]> {
  return (await db.query(`SELECT seq, actor, payload, created_at FROM events WHERE work_id IS NULL AND kind=$1 ORDER BY seq`, [mergerEventKind])).rows.map(settingOf);
}
/** The newest recorded setting, or the control-plane default when none is recorded. */
export async function recordedMergerMode(db: Queryable): Promise<MergerSetting> {
  const row = (await db.query(`SELECT seq, actor, payload, created_at FROM events WHERE work_id IS NULL AND kind=$1 ORDER BY seq DESC LIMIT 1`, [mergerEventKind])).rows[0];
  return row ? settingOf(row) : { merger: defaultMergerMode, since: null, setBy: null, reason: null, event: null };
}
/** What /api/status shows as `mergeWriter`: the setting, and one line while the control plane is the merger. */
export async function mergeWriterStatus(db: Queryable) {
  const setting = await recordedMergerMode(db);
  const line = setting.merger === 'control-plane' ? `The control plane is the merge writer since ${setting.since}, set by ${setting.setBy} (${setting.reason})` : null;
  return { ...setting, line };
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The admin-only setting: read by the roles that watch the install, changed by an admin alone. */
export class MergerSettings {
  constructor(private store: Store) {}

  async status(actor: Principal) {
    demand(['admin', 'coordinator', 'reader', 'operator-agent'].includes(actor.role), 'The merger setting is readable by admin, coordinator, reader and operator-agent identities', 403);
    // `mode` names the writer as the delivery defaults read it (GY-1901): `control-plane`, GitHub only a mirror, or `github`.
    const setting = await mergeWriterStatus(this.store.pool);
    return { ...setting, mode: setting.merger, history: await mergerHistory(this.store.pool) };
  }

  async change(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'admin', 'The merger setting is changed only with an admin credential', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data = changeSchema.parse(input);
    const fingerprint = digest({ action: 'merger', data });
    return this.store.transaction(async (db) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result; }
      const current = await recordedMergerMode(db);
      demand(current.merger !== data.merger, `The merger is already ${current.merger}`, 409);
      // GY-1560: control-plane is refused while any shadow disagreement stands unexplained; github never is.
      if (data.merger === 'control-plane') {
        const unexplained = await unexplainedShadowDisagreements(db);
        demand(!unexplained.length, `Control-plane merger refused while unexplained shadow disagreements stand: ${[...new Set(unexplained.map(entry => entry.key))].join(', ')}`, 409);
      }
      await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, mergerEventKind, JSON.stringify({ merger: data.merger, reason: data.reason, previous: current.merger })]);
      const setting = await mergeWriterStatus(db);
      const result = { ...setting, mode: setting.merger, history: await mergerHistory(db) };
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      return result;
    });
  }
}

/**
 * GY-1927: automatic merging. Default true: every install that never set it hands a candidate
 * whose every gate passes to its merge writer, as before. Set false (`master init --no-auto-merge`),
 * the plane holds every such candidate — GitHub is asked for no queue entry, auto-merge or
 * head-bound merge and the control-plane writer starts none — until an applied merge decision,
 * approved by an identity other than its requester, binds its exact sha, baseSha and policy
 * revision. Checks keep publishing as they would. Like the merger it is an attributed policy event
 * on the append-only ledger (`policy.auto-merge.set`), written by an admin or coordinator only.
 */
export const autoMergeEventKind = 'policy.auto-merge.set';
export interface AutoMergeSetting { autoMerge: boolean; since: string | null; setBy: string | null; reason: string | null; event: string | null }
const autoMergeChangeSchema = z.object({ autoMerge: z.boolean(), reason: z.string().trim().min(1).max(1000) }).strict();
const autoMergeOf = (row: any): AutoMergeSetting => ({ autoMerge: row.payload.autoMerge === true, since: new Date(row.created_at).toISOString(), setBy: row.actor, reason: row.payload.reason ?? null, event: String(row.seq) });

/** The newest recorded automatic-merging setting, or the default (on) when none is recorded. */
export async function recordedAutoMerge(db: Queryable): Promise<AutoMergeSetting> {
  const row = (await db.query(`SELECT seq, actor, payload, created_at FROM events WHERE work_id IS NULL AND kind=$1 ORDER BY seq DESC LIMIT 1`, [autoMergeEventKind])).rows[0];
  return row ? autoMergeOf(row) : { autoMerge: true, since: null, setBy: null, reason: null, event: null };
}
/** What /api/status shows as `autoMerge`: the setting, and the line master status shows for it. */
export async function autoMergeStatus(db: Queryable) {
  const setting = await recordedAutoMerge(db);
  const line = setting.autoMerge ? 'routine merges permitted after gates pass'
    : `each merge needs an approved merge decision: graphyard master decide GY-N merge REASON, approved by an identity other than its requester (automatic merging off since ${setting.since}, set by ${setting.setBy}: ${setting.reason})`;
  return { ...setting, line };
}

/** The decision fields the release reads. */
type MergeDecisionLike = { action: string; state: string; input: any; requestedBy: string; approvedBy: string | null; id?: string };
/** The applied, independently approved merge decision bound to the item's exact candidate and policy revision, if one stands. */
export function releasingMergeDecision<T extends MergeDecisionLike>(work: Pick<Work, 'candidate' | 'policyRevision'>, decisions: readonly T[]): T | null {
  const candidate = work.candidate;
  return decisions.find(decision => decision.action === 'merge' && decision.state === 'applied' && !!candidate && !!decision.approvedBy && decision.approvedBy !== decision.requestedBy
    && decision.input?.sha === candidate.sha && decision.input?.baseSha === candidate.baseSha && decision.input?.policyRevision === work.policyRevision) ?? null;
}
/** The hold one item's candidate is under, as a sentence, or null when nothing holds it. */
export const mergeHoldReason = (work: Pick<Work, 'key' | 'candidate' | 'policyRevision'>, setting: Pick<AutoMergeSetting, 'autoMerge'>, decisions: readonly MergeDecisionLike[]): string | null =>
  setting.autoMerge || !work.candidate || releasingMergeDecision(work, decisions) ? null
    : `${work.key}: automatic merging is off, so ${work.candidate.sha.slice(0, 12)} is held until an applied merge decision, approved by an identity other than its requester, binds that head, base ${work.candidate.baseSha.slice(0, 12)} and policy revision ${work.policyRevision} (graphyard master decide ${work.key} merge REASON)`;
/** Each named item's hold, keyed by id: one read of the setting, and of the decisions only while automatic merging is off. */
export async function mergeHolds(db: Queryable, work: readonly Work[]): Promise<Map<string, string | null>> {
  const setting = await recordedAutoMerge(db), holds = new Map<string, string | null>();
  if (setting.autoMerge) { for (const item of work) holds.set(item.id, null); return holds; }
  const held = work.filter(item => item.stage !== 'done' && !!item.candidate);
  const decisions = await decisionsByWork(db, held.map(item => item.id));
  for (const item of work) holds.set(item.id, null);
  for (const item of held) holds.set(item.id, mergeHoldReason(item, setting, decisions[item.id] ?? []));
  return holds;
}
/** One item's hold (see `mergeHolds`). */
export const mergeHold = async (db: Queryable, work: Work) => (await mergeHolds(db, [work])).get(work.id) ?? null;

/** The automatic-merging setting: read by the roles that watch the install, changed by an admin or the coordinator alone. */
export class AutoMergeSettings {
  constructor(private store: Store) {}

  async status(actor: Principal) {
    demand(['admin', 'coordinator', 'reader', 'operator-agent'].includes(actor.role), 'The automatic-merging setting is readable by admin, coordinator, reader and operator-agent identities', 403);
    return autoMergeStatus(this.store.pool);
  }

  /** An unchanged value writes nothing and answers the standing setting, so rerunning `master init` is idempotent. */
  async change(actor: Principal, input: unknown, key: string) {
    demand(actor.role === 'admin' || actor.role === 'coordinator', 'Automatic merging is set only with an admin or coordinator credential', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data = autoMergeChangeSchema.parse(input);
    const fingerprint = digest({ action: 'auto-merge', data });
    return this.store.transaction(async (db) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result; }
      const current = await recordedAutoMerge(db);
      if (current.autoMerge !== data.autoMerge) await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3)', [actor.id, autoMergeEventKind, JSON.stringify({ autoMerge: data.autoMerge, reason: data.reason, previous: current.autoMerge, role: actor.role })]);
      const result = await autoMergeStatus(db);
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      return result;
    });
  }
}
