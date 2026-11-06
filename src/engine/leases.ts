import { record } from '../store/mutations.js';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { activeLease, submittedEpoch, stallCovering, demand } from '../model.js';
import type { PlaneStall, Lease, Principal, Work } from '../model.js';
import { Refusal } from '../model/refusal.js';
import { buildIdentity } from '../protocol-version.js';
import { noSubmissionRenewalRefused, workerNoSubmissionRefusalMs } from '../model/attempt-bound.js';
import { recordAssignmentStart } from '../pipeline-speed.js';
import type { Engine } from '../engine.js';

import { recordRenewalFault } from '../store/renewal-fault.js';

// Old deployments did not persist assignment labels. Preserve the known owner/epoch
// before clearing a legacy lease; its original claim time is unknown.
export function preserveAssignment(work: Work) {
  if (work.lease && (!work.lastAssignment || work.lastAssignment.epoch < work.lease.epoch))
    work.lastAssignment = { owner: work.lease.owner, epoch: work.lease.epoch };
}

/**
 * The plane stalls recorded around `fromMs`..`untilMs` (wall-clock ms): the gaps in the
 * reconciliation loop's own ticks (recordPlaneLiveness), each once in the ledger with no work of its
 * own. They are read beside the attestations wherever a lapse is classed, so a lease that ran out
 * while the plane itself was down is explained by the plane's record rather than counted as a
 * lost worker (GY-1791). The `created_at` index serves the read; the window is bounded by the
 * caller to the lapse it is classing.
 */
export async function readPlaneStalls(db: { query: (text: string, values: unknown[]) => Promise<{ rows: any[] }> }, fromMs: number, untilMs: number): Promise<PlaneStall[]> {
  const rows = (await db.query(`SELECT payload->'details' AS details FROM events WHERE kind = 'plane.stall' AND created_at >= to_timestamp($1 / 1000.0) AND created_at <= to_timestamp($2 / 1000.0) ORDER BY created_at`, [fromMs, untilMs])).rows;
  return rows.map(row => { const details = row.details ?? {}; return { from: String(details.from), to: String(details.to) }; }).filter(stall => Number.isFinite(Date.parse(stall.from)) && Number.isFinite(Date.parse(stall.to)));
}
/**
 * The lease a worker submitted under ended at that submission. A supervisor that keeps renewing it
 * (or releases it) is told so, rather than left to read the loss as a superseded epoch.
 */
export function endedBySubmission(work: Work, epoch: number) {
  if (!work.lease && submittedEpoch(work, epoch))
    demand(false, `Implementation lease for epoch ${epoch} ended when ${work.key} was submitted; stop heartbeating after complete`);
}

/** The ledger kind of a lease renewal that failed server-side (GY-558). */
export const renewalFaultEvent = 'lease.renewal-failed';
/** A lease carrying the server-side renewal fault that extended it (GY-558); cleared by the next renewal. */
export type GracedLease = Lease & { renewalFault?: { at: string; error: string } };
/** A renewal that failed server-side: 503, with the grace its recorded fault earned, if any. */
export class RenewalFault extends Refusal {
  constructor(message: string, readonly grace: { at: string; graceUntil: string; now: string } | null) { super(message, 503); }
}
/** The SQLSTATE classes a failed renewal may blame on the server (GY-671): connection exceptions,
 * insufficient resources, program limits, operator intervention (statement timeouts among them),
 * system errors and internal errors. Client-caused classes — bad data, constraint violations,
 * syntax, privileges, serialization and deadlock — are the request's own and earn nothing. */
const renewalFaultSqlClasses = new Set(['08', '53', '54', '57', '58', 'XX']);
/** The connection-level failures a renewal may blame on the server, named by message or errno. */
const renewalFaultMessage = /connection|terminated|timed? ?out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|socket hang up/i;
/** The connection errnos a failed renewal may blame on the server, whatever its message says. */
const renewalFaultErrnos = /^ECONN(RESET|REFUSED|ABORTED)|^ETIMEDOUT$|^EPIPE$|^E(HOST|NET)UNREACH$|^EAI_AGAIN$/;
/**
 * What a failed renewal blames on the server, or null when it may not (GY-558, narrowed by
 * GY-671): only infrastructure trouble — lost or timed-out connections, statement timeouts and
 * the database's server-error classes — never a programming error. A TypeError in a heartbeat
 * must surface as the bug it is instead of silently extending the lease it broke, so anything
 * this cannot name as the server's fault is answered as a refusal, with no grace and no record.
 */
export function renewalFaultOf(error: unknown): string | null {
  if (error instanceof Refusal) return error.status >= 500 ? `HTTP ${error.status}: ${error.message}` : null;
  if (error instanceof z.ZodError) return null;
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    if (renewalFaultErrnos.test(code)) return `${code}: ${(error as Error).message}`;
    if (/^[0-9A-Z]{5}$/.test(code)) return renewalFaultSqlClasses.has(code.slice(0, 2)) ? `SQLSTATE ${code}: ${(error as Error).message}` : null;
  }
  const message = error instanceof Error ? error.message : String(error);
  return renewalFaultMessage.test(message) ? message : null;
}

/** How long the reconciliation loop may go between passes before the gap is recorded as a plane stall (GY-1791): the loop is driven every couple of seconds, so a minute is dozens of missed passes. */
export const planeStallMs = 60_000;
/**
 * How long past a recorded stall's end a lease the stall kept may stand (GY-1801): the window a
 * still-retrying supervisor needs to land the renewal the stall ate. A supervisor's renewals wait
 * under its lease window and retry within a doubling backoff capped at ten seconds (`session-watch.ts`),
 * so one that was mid-renewal when the plane stopped answering lands a fresh one well inside thirty
 * seconds of its recovery — a full lease period keeps a lease nobody renews standing instead, and a
 * pane closed under a lease only the stall keeps is exactly the live-lease close the soak's
 * invariant forbids (GY-1801). The window therefore ends far inside the loop's own exited-pane
 * sighting (`cycle-sessions.ts` sights a pane whose runtime left twice, `launchAppearanceMs` apart),
 * and well past the retry the grace exists for.
 */
export const stallRenewalWindowMs = 30_000;

/**
 * Let a lease renewal run before reconciliation's next evaluation or write (GY-1290). Evaluation is
 * CPU work on the one event loop every request shares: a renewal's every query round trip would
 * otherwise resume only after the evaluation then running, so a renewal of a few round trips waited
 * through as many evaluations. Reconciliation first lets the event loop run — a due timer, an
 * arriving request included — then waits until no renewal is in flight, so a renewal waits on at
 * most the one evaluation it arrived during.
 */
export async function yieldToRenewals(engine: Engine) {
  // A timer's yield (GY-1867), not `setImmediate`: a chain of immediate continuations keeps the
  // loop in the check phase, so timers scheduled while a long evaluation runs — the event-loop
  // sampler's included — fire only once it ends, and a tick reads as starved when it was itself.
  await new Promise(resolve => setTimeout(resolve, 0));
  if (!engine.renewing) return;
  let timer: NodeJS.Timeout | undefined;
  await new Promise<void>(resolve => { engine.renewalsDone.push(resolve); timer = setTimeout(resolve, engine.reconcileYieldMs); });
  clearTimeout(timer);
}

/**
 * Record a renewal that failed server-side inside its lease's expiry window (GY-558): a
 * `lease.renewal-failed` event naming the owner, epoch and the time the renewal arrived,
 * written without the coordination lock. `renewalGrace` then keeps the lease valid until the
 * next successful renewal or one further lease period from that time, whichever comes first.
 * The record is written on the main pool, not the lease pool (GY-671): the lease pool is
 * reserved for the lease commands, and the very exhaustion that failed the renewal must not
 * also fail the record of it. A record the database refuses is retried in the background until
 * that period has passed. The refusal carries the grace the record earns even before it has
 * landed (GY-671) — the same one period from the renewal's arrival `renewalGrace` will grant
 * once it does — so the worker's supervisor extends its local deadline as far as the server
 * will hold the lease, instead of stopping at the old deadline while the server still keeps it.
 */
export async function renewalFaultRefusal(engine: Engine, actor: Principal, id: string, epoch: number, at: Date, error: unknown) {
  const reason = (error instanceof Error ? error.message : String(error)).slice(0, 300);
  console.error(`[lease] renewal of ${id} epoch ${epoch} by ${actor.id} failed server-side: ${reason}`);
  const payload = JSON.stringify({ owner: actor.id, epoch, at: at.toISOString(), error: reason });
  const until = at.getTime() + engine.leaseSeconds * 1000;
  // Only a live lease of this owner and epoch earns a grace; the refusal says what it earned.
  const write = () => recordRenewalFault(engine.store.pool, id, actor, epoch, at, until, renewalFaultEvent, payload);
  let recorded: { grace_until: Date; now: Date } | undefined, unrecorded: string | null = null;
  try { recorded = await write(); } catch (failure) {
    unrecorded = (failure as Error).message;
    const retry = () => setTimeout(() => { if (Date.now() < until) write().catch(retry); }, 1000).unref();
    retry();
  }
  const grace = recorded ? { at: at.toISOString(), graceUntil: recorded.grace_until.toISOString(), now: recorded.now.toISOString() }
    : unrecorded !== null ? { at: at.toISOString(), graceUntil: new Date(until).toISOString(), now: new Date().toISOString() } : null;
  return new RenewalFault(grace
    ? `Lease renewal failed server-side (${reason}); ${unrecorded === null ? 'the failure is recorded and the lease stays valid' : 'the record is being retried and the lease is kept'} until ${grace.graceUntil} or the next successful renewal`
    : `Lease renewal failed server-side (${reason}); no live lease of this owner and epoch was found to keep`, grace);
}

/**
 * A lease past its expiry that a recorded server-side renewal fault still covers (GY-558): the
 * first fault after its last renewal and inside its expiry window extends it to one lease period
 * after that fault, once — a later fault before a successful renewal extends nothing. A lease
 * whose worker stopped renewing has no such record and expires as before. A gap in the plane's
 * own ticks (recordPlaneLiveness) that covers the expiry is the same server-side fault in the plane
 * itself (GY-1791): renewals could not land while no tick ran, so a supervisor still retrying
 * finds the lease live and renews, where the base lapsed it and raised a lease loss. That stall
 * keeps the lease only for `stallRenewalWindowMs` past the stall — the window a still-retrying
 * supervisor needs to land the renewal the stall ate — never a full lease period (GY-1801): a
 * lease the stall alone keeps, with nobody renewing it, must lapse inside the loop's own
 * exited-pane sighting window (launchAppearanceMs), so no step closes the attempt's pane while
 * the stall alone holds the lease live.
 */
export async function renewalGrace(engine: Engine, db: PoolClient, work: Work, now: Date) {
  const lease = work.lease as GracedLease | null;
  if (!lease || lease.renewalFault || Date.parse(lease.expiresAt) > now.getTime()) return false;
  const leaseMs = engine.leaseSeconds * 1000, expires = Date.parse(lease.expiresAt);
  const fault = (await db.query(`SELECT payload->>'at' AS at, payload->>'error' AS error FROM events WHERE kind=$1 AND created_at>$2::timestamptz AND work_id=$3
    AND payload->>'owner'=$4 AND (payload->>'epoch')::int=$5 AND (payload->>'at')::timestamptz>$2::timestamptz AND (payload->>'at')::timestamptz<=$6::timestamptz
    ORDER BY (payload->>'at')::timestamptz LIMIT 1`, [renewalFaultEvent, new Date(expires - leaseMs).toISOString(), work.id, lease.owner, lease.epoch, lease.expiresAt])).rows[0] as { at: string; error: string } | undefined;
  if (fault) {
    lease.renewalFault = { at: new Date(fault.at).toISOString(), error: fault.error };
    lease.expiresAt = new Date(Math.max(expires, Date.parse(fault.at) + leaseMs)).toISOString();
    return true;
  }
  // The stall covers the expiry itself, so the read reaches back one window before it; the
  // recovery tick wrote the stall at its own `to`, which is the newest row the window can hold.
  const stall = stallCovering(await readPlaneStalls(db, expires - leaseMs, now.getTime()), expires);
  if (!stall) return false;
  lease.renewalFault = { at: stall.from, error: `the control plane was not answering between ${stall.from} and ${stall.to}` };
  lease.expiresAt = new Date(Math.max(expires, Date.parse(stall.to) + stallRenewalWindowMs)).toISOString();
  return true;
}

/**
 * Renew `work`'s lease for `epoch` (GY-1124): the lease checks every heartbeat passes, shared by
 * the item-locked fast path and the operator-agent heartbeat through `executeCommand`, so a lease
 * check added for renewals is added once and reaches both.
 */
export function renewLease(engine: Engine, work: Work, actor: Principal, epoch: number, now: Date) {
  endedBySubmission(work, epoch);
  activeLease(work, actor, epoch, now);
  // GY-1462: the backstop to the loop's end past the reclaim bound (GY-1460): an attempt held
  // unsubmitted past workerNoSubmissionRefusalMs is not renewed, so its lease lapses into containment and reclaim.
  demand(!noSubmissionRenewalRefused(work, now.getTime()),
    `Implementation lease for epoch ${epoch} of ${work.key} is not renewed: no submission in ${workerNoSubmissionRefusalMs / 60_000} minutes, past the worker no-submission bound; the attempt ends and its branch is kept for the next`);
  work.lease!.expiresAt = new Date(now.getTime() + engine.leaseSeconds * 1000).toISOString();
  delete (work.lease as GracedLease).renewalFault;
  recordAssignmentStart(work, epoch, now);
}

/**
 * Record the plane's own liveness (GY-1791): the process beating on its own timer (startPlaneBeat),
 * before it answers requests (the server's startup), and at the start of every pass all call engine.
 * A gap past `planeStallMs` since the previous record is one `plane.stall` ledger row, read, appended
 * and moved forward in one transaction under the row's lock, so a failed write leaves the old tick
 * and a concurrent process sees the gap once. That row is what lets the plane explain its own
 * outages: a lease lapsing inside a recorded stall is history with its cause, never a lease loss
 * (leaseLapseCause), and renewal grace keeps the lease live for a supervisor still retrying
 * (GY-558's rule). Best effort beside the pass — liveness bookkeeping never fails reconciliation.
 *
 * The tick runs on the lease pool, the connections heartbeats run on (pools.ts `leaseCommands`),
 * and on nothing else: a stall is "renewals could not land", so the tick must measure the path
 * that serves them. The request pool exhausted behind slow queries while heartbeats still land is
 * no stall — a tick there would have recorded one and explained away a worker that truly vanished
 * — and a lease pool that cannot take this tick's connection could not take a renewal either.
 *
 * The time recorded is read once the lease pool has answered (the connection taken and the
 * transaction open), never when the beat was sent: a beat held behind a black-holed connection
 * records when it landed, so beats that waited out an outage cannot replay the times they were
 * sent at over the gap and move the tick past a stall nothing recorded. A caller measuring a
 * simulated clock passes `at`.
 */
export async function recordPlaneLiveness(engine: Engine, at?: Date) {
  let db: PoolClient | null = null;
  try {
    db = await engine.store.leasePool.connect();
    await db.query('BEGIN');
    at ??= new Date();
    await db.query('INSERT INTO plane_liveness(id,tick_at) VALUES(true,$1) ON CONFLICT (id) DO NOTHING', [at]);
    const previous = (await db.query('SELECT tick_at FROM plane_liveness WHERE id = true FOR UPDATE')).rows[0].tick_at as Date;
    let served: string | null | undefined;
    if (at.getTime() > previous.getTime()) {
      if (at.getTime() - previous.getTime() > planeStallMs)
        await record(db, null, 'graphyard', 'plane.stall', { details: { from: previous.toISOString(), to: at.toISOString() } });
      // GY-2177: the first tick that moves also records what this process serves, against what the
      // tick named before it: a change is a deploy, recorded once with the window it names — from
      // the replaced release's last tick, when its renewals started landing nowhere, to this
      // process's first answer, from which the release before it refuses every renewal client-side
      // with the version skew until the loop realigns. That row is what lets the plane explain the
      // lapses its own deploy causes (leaseLapseCause), the way a stall row explains its outage.
      // The read is one indexed query per process, and the commit comparison makes a retried tick
      // (a failed transaction leaves the field unset) idempotent.
      if (engine.servedCommit === undefined) {
        served = buildIdentity().commit;
        const last = await db.query(`SELECT payload->>'commit' AS commit FROM events WHERE kind = 'plane.deploy' ORDER BY created_at DESC LIMIT 1`);
        if (served && last.rows[0]?.commit !== served)
          await record(db, null, 'graphyard', 'plane.deploy', { details: { commit: served, from: previous.toISOString(), to: at.toISOString() } });
      }
      await db.query('UPDATE plane_liveness SET tick_at = $1 WHERE id = true', [at]);
    }
    await db.query('COMMIT');
    // The field moves once the row is on the ledger: a failed transaction left it unset, and the
    // next tick's commit comparison retries the whole check without recording anything twice.
    if (served !== undefined) engine.servedCommit = served;
  } catch {
    await db?.query('ROLLBACK').catch(() => {}); // the next beat records it
  } finally { db?.release(); }
}

/**
 * Beat the plane's liveness on a timer of its own, so slow serial work between passes is never
 * read as an outage. The first beat lands before this resolves, so a server starts answering
 * heartbeats with the gap since its previous process already on the record. One beat is in flight
 * at a time: a beat the lease pool has not answered is not joined by the next interval's, so an
 * outage queues no pile of beats to land together when the pool answers again.
 */
export async function startPlaneBeat(engine: Engine, intervalMs = planeStallMs / 6): Promise<() => void> {
  await recordPlaneLiveness(engine);
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void recordPlaneLiveness(engine).finally(() => { inFlight = false; });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
