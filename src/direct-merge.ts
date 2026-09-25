import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { demand, type Principal, type Work } from './model.js';
import type { Store } from './store.js';
import { save, wakeJob } from './store.js';
import { settleDelivered } from './model/actions.js';
import { reconciliationRefusalPrefix } from './merge-queue.js';
import { unauthorizedMergeViolation, type OperatorAuthorizedDelivery } from './engine.js';

/**
 * Direct-merge mode: the operator's standing statement that merges into the base branch inside a
 * window are theirs, so a merge no execution authorized is delivered as operator-authorized instead
 * of held with the unauthorized-merge violation. Only an admin credential sets or clears it, or the
 * deployment operator through GRAPHYARD_DIRECT_MERGE_SINCE/UNTIL; no agent identity can grant its
 * own bypass. The setting lives on the append-only ledger (`policy.direct-merge.set|cleared`, no
 * work item), so it is carried by every backup and needs no table. Every window ever recorded
 * stays in force for the merges that landed inside it: a later `set` or `cleared` only closes the
 * open window at the instant it was written.
 */
export const directMergeEventPrefix = 'policy.direct-merge.';
export const directMergeEnvironmentActor = 'deployment environment';

export interface DirectMergeWindow {
  since: string; until: string | null; reason: string; setBy: string; enabledAt: string;
  source: 'setting' | 'environment';
  /** The ledger sequence of the `set` event, or null for the deployment environment. */
  event: string | null;
}
type Queryable = Pick<pg.PoolClient, 'query'>;
const instant = z.string().trim().refine(value => Number.isFinite(Date.parse(value)), 'Use an ISO 8601 instant, such as 2026-09-23T22:00:00Z').transform(value => new Date(Date.parse(value)).toISOString());
const setSchema = z.object({ since: instant, until: instant.nullable().optional(), reason: z.string().trim().min(1).max(1000) }).strict()
  .refine(data => !data.until || Date.parse(data.until) > Date.parse(data.since), 'until must be after since');
const clearSchema = z.object({ reason: z.string().trim().min(1).max(1000) }).strict();

/** The window the deployment environment declares, or null; an unparseable value is reported and ignored. */
export function directMergeFromEnv(env: NodeJS.ProcessEnv = process.env, now = new Date()): DirectMergeWindow | null {
  const since = env.GRAPHYARD_DIRECT_MERGE_SINCE?.trim();
  if (!since) return null;
  const until = env.GRAPHYARD_DIRECT_MERGE_UNTIL?.trim() || null;
  const parsed = setSchema.safeParse({ since, until, reason: 'GRAPHYARD_DIRECT_MERGE_SINCE is set in the deployment environment' });
  if (!parsed.success) { console.error(`Direct-merge mode from the environment ignored: ${parsed.error.issues.map(issue => issue.message).join('; ')}`); return null; }
  return { since: parsed.data.since, until: parsed.data.until ?? null, reason: parsed.data.reason, setBy: directMergeEnvironmentActor, enabledAt: now.toISOString(), source: 'environment', event: null };
}

/** Every window the ledger records, oldest first, each closed at the instant the next policy event was written. */
export async function recordedWindows(db: Queryable): Promise<DirectMergeWindow[]> {
  const rows = (await db.query(`SELECT seq, kind, payload, created_at FROM events WHERE work_id IS NULL AND kind LIKE '${directMergeEventPrefix}%' ORDER BY seq`)).rows;
  const windows: DirectMergeWindow[] = [];
  for (const row of rows) {
    const at = new Date(row.created_at).toISOString(), open = windows.at(-1);
    if (open && (!open.until || Date.parse(open.until) > Date.parse(at))) open.until = at;
    if (row.kind === `${directMergeEventPrefix}set`) windows.push({ ...row.payload.setting, event: String(row.seq) });
  }
  return windows;
}
export async function directMergeWindows(db: Queryable, environment: DirectMergeWindow | null) {
  return [...await recordedWindows(db), ...(environment ? [environment] : [])];
}
/** The window a merge at `time` fell inside, if any. */
export const coveringWindow = (windows: DirectMergeWindow[], time: number) =>
  windows.find(window => Date.parse(window.since) <= time && (!window.until || time < Date.parse(window.until))) ?? null;
const openAt = (window: DirectMergeWindow, now: number) => !window.until || Date.parse(window.until) > now;

/** What master status and /api/status show: the windows still open, and one line while any is. */
export async function directMergeStatus(db: Queryable, environment: DirectMergeWindow | null, now: Date) {
  const recorded = (await recordedWindows(db)).at(-1);
  const active = [...(recorded && openAt(recorded, now.getTime()) ? [recorded] : []), ...(environment && openAt(environment, now.getTime()) ? [environment] : [])];
  const line = active.length ? active.map(window => `Direct-merge mode is on since ${window.since}${window.until ? ` until ${window.until}` : ''}, set by ${window.setBy} (${window.reason}): gated merging is bypassed and merges inside the window are delivered as operator-authorized`).join('; ') : null;
  return { on: active.length > 0, windows: active, line };
}

/** The operator-authorized record a merge inside a direct-merge window is delivered with. */
export function directMergeAuthorization(window: DirectMergeWindow, merge: { sha: string; at: string }, snapshotRevision: number, cutoff: string, unmet: string[]): OperatorAuthorizedDelivery & { directMerge: DirectMergeWindow } {
  const decision = window.event ? `direct-merge:${window.event}` : 'direct-merge:environment';
  return { decision, requestedBy: window.setBy, requestedAt: window.enabledAt, approvedBy: window.setBy, approvedAt: window.enabledAt, reason: window.reason, approvalReason: '',
    operator: window.setBy, refusedDecision: '', unmet, cutoff, snapshotRevision, execution: null, violation: unauthorizedMergeViolation, directMerge: window,
    judgement: `No merge execution authorized merge ${merge.sha.slice(0, 12)}; it landed at ${merge.at}, inside the direct-merge window from ${window.since}${window.until ? ` to ${window.until}` : ''} that ${window.setBy} set (${window.reason}), so gated merging was bypassed and it is delivered as operator-authorized` };
}

/**
 * Deliver every open item already held with the unauthorized-merge violation whose recorded merge
 * lies inside a window, from the merged observation it carries: the same record, ledger entry and
 * job retirement the observation path writes. Runs inside the caller's coordination transaction.
 */
export async function sweepDirectMerges(db: pg.PoolClient, all: Work[], windows: DirectMergeWindow[], now: Date): Promise<Work[]> {
  const delivered: Work[] = [];
  if (!windows.length) return delivered;
  for (const work of all) {
    const observation = work.observation;
    if (work.stage === 'done' || !observation?.merged || !observation.mergeSha || !observation.mergedAt || !work.violations.includes(unauthorizedMergeViolation)) continue;
    const window = coveringWindow(windows, Date.parse(observation.mergedAt));
    if (!window) continue;
    const record = directMergeAuthorization(window, { sha: observation.mergeSha, at: observation.mergedAt }, work.revision, observation.mergedAt, work.gates.filter(gate => !gate.passed).map(gate => `gate ${gate.name} had not passed: ${gate.reasons.join('; ')}`));
    work.violations = work.violations.filter(entry => entry !== unauthorizedMergeViolation && !entry.startsWith(reconciliationRefusalPrefix));
    work.stage = 'done'; work.stageEnteredAt = now.toISOString(); work.mergeExecution = null;
    work.delivery = Object.assign({ mergedAt: observation.mergedAt, mergeSha: observation.mergeSha, authorizationRevision: work.revision }, { operatorAuthorization: record });
    await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES($1,$2,$3,$4)', [work.id, window.setBy, 'merge.operator-authorized',
      JSON.stringify({ details: { ...record, mergeSha: observation.mergeSha, mergedAt: observation.mergedAt, authorizationRevision: work.revision, evidenceAsOf: null, gatesNow: work.gates.filter(gate => !gate.passed).map(gate => ({ name: gate.name, reasons: gate.reasons })), at: now.toISOString() } })]);
    await db.query('DELETE FROM jobs WHERE work_id=$1', [work.id]);
    // What the delivery still owes, in the same transaction: nothing retries against it (GY-185).
    settleDelivered(work, all, now);
    await save(db, work, 'graphyard', 'direct-merge.delivered', now, { window: record.decision });
    delivered.push(work);
  }
  if (delivered.length) for (const behind of all) if (behind.queue && behind.stage !== 'done') await wakeJob(db, behind.id);
  return delivered;
}

/** At startup: say whether direct-merge mode is on, and deliver the items already held inside a window. */
export async function startDirectMerge(store: Store, environment: DirectMergeWindow | null) {
  const swept = await store.transaction(async (db, now) => {
    const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document);
    const delivered = await sweepDirectMerges(db, all, await directMergeWindows(db, environment), now);
    return { status: await directMergeStatus(db, environment, now), delivered: delivered.map(work => work.key) };
  });
  console.log(swept.status.line ?? 'Direct-merge mode is off: every merge needs a merge execution or a two-party decision');
  if (swept.delivered.length) console.log(`Direct-merge mode delivered ${swept.delivered.join(', ')}, merged inside its window`);
  return swept;
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** The admin-only setting: set, clear and read, each set or clear appended to the ledger with its actor and reason. */
export class DirectMerges {
  constructor(private store: Store, private environment: () => DirectMergeWindow | null) {}

  async status(actor: Principal) {
    demand(['admin', 'coordinator', 'reader', 'operator-agent'].includes(actor.role), 'Direct-merge mode is readable by admin, coordinator, reader and operator-agent identities', 403);
    const now = (await this.store.pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
    return { ...await directMergeStatus(this.store.pool, this.environment(), now), history: await recordedWindows(this.store.pool) };
  }

  async change(actor: Principal, action: 'on' | 'off', input: unknown, key: string) {
    demand(actor.role === 'admin', 'Direct-merge mode is set and cleared only with an admin credential; agent identities cannot authorize their own bypass', 403);
    demand(key && key.length <= 200, 'An Idempotency-Key is required', 400);
    const data = action === 'on' ? setSchema.parse(input) : clearSchema.parse(input);
    const fingerprint = digest({ action, data });
    return this.store.transaction(async (db, now) => {
      const receipt = (await db.query('SELECT * FROM receipts WHERE actor=$1 AND key=$2', [actor.id, key])).rows[0];
      if (receipt) { demand(receipt.fingerprint === fingerprint, 'Idempotency key reused with different input'); return receipt.result; }
      const current = (await recordedWindows(db)).at(-1);
      let payload: Record<string, unknown>;
      if (action === 'on') {
        const set = data as z.infer<typeof setSchema>;
        const setting = { since: set.since, until: set.until ?? null, reason: set.reason, setBy: actor.id, enabledAt: now.toISOString(), source: 'setting' as const };
        payload = { setting, reason: set.reason, replaced: current && openAt(current, now.getTime()) ? current : null };
      } else {
        demand(current && openAt(current, now.getTime()), 'Direct-merge mode is not on', 409);
        payload = { reason: data.reason, cleared: current };
      }
      // The status is read at the instant the change was written, so an `off` reads as closed.
      const at = (await db.query('INSERT INTO events(work_id,actor,kind,payload) VALUES(NULL,$1,$2,$3) RETURNING created_at', [actor.id, `${directMergeEventPrefix}${action === 'on' ? 'set' : 'cleared'}`, JSON.stringify(payload)])).rows[0].created_at as Date;
      // Setting the mode resolves every item already held for a merge inside a window at once.
      const all: Work[] = (await db.query('SELECT document FROM work_items ORDER BY number')).rows.map(row => row.document);
      const delivered = await sweepDirectMerges(db, all, await directMergeWindows(db, this.environment()), now);
      const result = { action, ...await directMergeStatus(db, this.environment(), at), delivered: delivered.map(work => work.key) };
      await db.query('INSERT INTO receipts(actor,key,fingerprint,result) VALUES($1,$2,$3,$4)', [actor.id, key, fingerprint, JSON.stringify(result)]);
      return result;
    });
  }
}
