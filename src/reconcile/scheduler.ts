import { record } from '../store/mutations.js';
import { jsonChanged, stableJson } from '../model/stable-json.js';
import type { PoolClient } from 'pg';
import { save, wakeJob } from '../store.js';
import { commitLockWaitMs, reconcileCommitBlockingSql, reconcileRereadSql, reconcileRowLockSql, reconcileRowsSql, reconcileVersionsSql } from '../store/coordination-sql.js';
import { advisoryLocks } from '../store/locks.js';
import type { Work } from '../model.js';
import { settleDelivered } from '../model-boundary/actions.js';
import { livenessOf, livenessRepairEntry } from '../model-boundary/liveness.js';
import { endLapsedAttempt } from '../pipeline-speed.js';
import { isSettledSummary, isStandIn, lockedRows, rememberSaved, savedVersions, warmLockedReads } from '../store/locked-read.js';
import type { Engine } from '../engine.js';
import { recordDispatch } from '../engine/evaluate.js';
import { preserveAssignment, renewalGrace, recordPlaneLiveness, yieldToRenewals } from '../engine/leases.js';
import { describeFaceMoves, describeFull, faceDocument, faceFields, faceReach, fleetFace, mergeFaceMoves, readsFace, type FaceMove, type OwnFaceMove, type ReconcilePass, type ReconcilePlan, type ReconcileTick, type ReconcileFull, type ReconcileWritten } from './faces.js';

/** A reconciliation batch that found the coordination lock held past its wait before it wrote (GY-727, GY-1290): it runs again. */
class ReconcileContended extends Error {}

/** What `reconcileItem`'s evaluation of a document decided to write, kept until it is written (GY-1290). */
const reconcileWrites = new WeakMap<Work, { delivered: true } | { ledger: { kind: string; details: Record<string, unknown> }[] }>();

/**
 * When the next full pass is due, measured from when the last one began (GY-1867): the configured
 * interval stretched past a pass that ran longer than a third of it — `max(I, 3 × its duration)` —
 * so a full pass is never due again the moment it ends and full passes take at most about a
 * quarter of the server's time whatever the fleet grows to; the configured value stays the floor.
 * An interval of 0 — unreachable through `GRAPHYARD_RECONCILE_FULL_MS`, which clamps to
 * 2000..300000 — keeps the meaning the stress suites give it: the clock brings every pass.
 */
function fullEvaluationIntervalMs(engine: Engine) {
  return engine.reconcileFullEvaluationMs > 0 ? Math.max(engine.reconcileFullEvaluationMs, 3 * engine.reconcileFullMs) : 0;
}

/**
 * Note a face another writer moved, merging the fields of one noted already, the before face of
 * the first and the after document of the last (GY-1777, GY-1898). The documents in between are
 * kept too: a pass may have evaluated another item against one of them, so its readers are owed.
 */
function noteFaceMove(engine: Engine, move: FaceMove, before: string, after: Work | null) {
  const known = engine.reconcileFaceMoves.get(move.id);
  const noted = { move, before: faceDocument(before), after };
  engine.reconcileFaceMoves.set(move.id, known ? { move: mergeFaceMoves([known.move, move])[0], before: known.before ?? noted.before, after: noted.after ?? known.after,
    between: [...known.between ?? [], ...[known.after, noted.before].filter((work): work is Work => !!work)] } : noted);
}

/** Note a face the pass's own planned write moved (GY-1777): the document before its first write of the pass and after its last, the fields merged. */
function noteOwnMove(engine: Engine, own: OwnFaceMove) {
  const known = engine.reconcileOwnMoves.get(own.move.id);
  engine.reconcileOwnMoves.set(own.move.id, known ? { move: mergeFaceMoves([known.move, own.move])[0], before: known.before, after: own.after } : own);
}

/**
 * Reconcile every item whose inputs moved, one tick at a time per server (GY-1115, GY-1124): a
 * call made while a tick runs waits for the next tick, which starts once the running one ends and
 * serves every call that arrived meanwhile, so a request that reconciles after its own write
 * (`resyncWork`) still sees it. Each resync used to start a tick of its own, and concurrent ticks
 * held a connection each and kept moving each other's items, so every one of their batches was
 * contended. A tick therefore holds at most one pool connection. Ticks must not overlap for the
 * kept view's sake too: it is shared engine state, and a batch mutates its documents before it
 * commits, so a second tick must neither evaluate against that uncommitted state nor have its
 * view cleared by the first tick's failure.
 */
export function reconcile(engine: Engine): Promise<void> {
  if (!engine.reconcileRunning) {
    const run: Promise<void> = reconcileTick(engine).finally(() => { if (engine.reconcileRunning === run) engine.reconcileRunning = null; });
    return engine.reconcileRunning = run;
  }
  return engine.reconcileTrailing ??= engine.reconcileRunning.catch(() => {}).then(() => { engine.reconcileTrailing = null; return reconcile(engine); });
}

/**
 * One reconciliation tick, in batches. The pass opens with one short coordination transaction
 * that reads every row's version (`xmin`) and settled flag — never a document — and compares
 * them with the view the previous pass kept (GY-1124): only the rows that moved since are read
 * again, under the lock as their compact stand-ins from the in-process cache (`lockedRows`,
 * GY-1027: an open item's coordination projection, a settled delivery's work-index summary), so
 * the lock hold grows with neither the history nor the open items' histories. The first pass of
 * a process reads every live document once.
 *
 * The pass then evaluates the items whose own row moved, plus those whose inputs elsewhere
 * did: a fleet face any writer moved (anything beyond a lease renewal: stage, queue,
 * dependencies, resources, candidate…) brings the moved item and the items whose evaluation
 * reads it (`readsFace`: by reference, as a split sibling, through a shared exclusive resource
 * or an overlapping path scope) — since GY-1898 whatever the writer, so a routine session or
 * observation write no longer makes every pass full; the kept view's emptiness, a merge
 * configuration change and the full-evaluation interval are the only full passes. An item whose
 * lease has lapsed or whose standing escalations read the
 * ledger is evaluated, and the items an earlier pass deferred. No sooner than
 * `max(reconcileFullEvaluationMs, 3 × the last full pass's duration)` (GY-1867) after the last full
 * pass began, the pass evaluates every live item, for the inputs only the clock moves, so a full
 * pass is never due again the moment it ends. A pass after a heartbeat therefore reads one document
 * and evaluates one item. A
 * face the pass's own writes moved does not make the next pass full either (GY-1777): the next pass
 * evaluates the items whose evaluation reads it (`readsFace`), and a tick over
 * `reconcileSlowWarnMs` names what made it full — or, when a moved face drove it, the faces and
 * how many items they made evaluated — and the event-loop lag it ran under.
 *
 * Each batch evaluates on the background lane (a bounded share of the pool) holding no lock at
 * all (GY-1290): one short transaction compares every row's version with the view, re-reads only
 * the items that moved, and evaluates each item on a copy, against the whole fleet as the batch's
 * earlier planned writes will leave it, writing nothing (`reconcileItem`'s dry run), until
 * `reconcileBatchMs` has passed (GY-274's per-batch bound retained) or `reconcileBatchWrites`
 * writes are planned. A heartbeat, an observation save or any request on any item, the batch's
 * own included, commits while it evaluates. Each planned write then runs in a transaction of its
 * own (`reconcileWrite`): it waits in line for the coordination lock like every fleet command,
 * holding no row, then takes the item's row lock, writes the evaluation — again only if the item
 * or another item's face moved since — and commits. A row is therefore held for one item's write,
 * never across the batch, so a renewal never waits on the batch's evaluations or on its later
 * writes; and nothing rolls back because another item moved: the race GY-1115 bounded — a batch
 * holding its rows while it raced every fleet command for the coordination lock at commit with a
 * 200 ms wait, and rolling back whenever any item moved, which observation saves did every few
 * seconds (GY-1290) — is gone. Only a lock still held past `reconcileCommitLockWaitMs` on each of
 * `reconcileMaxAttempts` attempts defers the batch's unwritten items, and nothing else of it, to
 * the next pass. Between batches the event loop runs. Every batch evaluates at least one item.
 */
async function reconcileTick(engine: Engine) {
  const tickStarted = performance.now();
  // The event-loop lag over the tick's window (GY-1777): a timer's overrun past its 10 ms
  // resolution, so a tick slowed by a starved loop is told apart from one waiting on I/O.
  engine.eventLoopLag.start();
  // The plane's liveness is read before this pass classes any lapse (GY-1791): the pass that meets
  // a lease the stall let run out must already find the stall on the record. The independent beat
  // (startPlaneBeat) keeps the tick moving through a long pass, so a pass's own length is no gap.
  await recordPlaneLiveness(engine);
  try { await reconcilePass(engine, tickStarted); }
  finally { engine.eventLoopLag.stop(); }
}

async function reconcilePass(engine: Engine, tickStarted: number) {
  // A pass would otherwise open on a cold stand-in cache and project, under the coordination lock,
  // every row it has not cached — every open document on a process's first pass (GY-1042), and on
  // each later pass every row another process wrote since (GY-1939): warm it, outside the lock.
  await warmLockedReads(engine.store.pool);
  const fleet = engine.reconcileView;
  let all: Work[] = [], candidates: string[] = [], next = 0, documentsRead = 0, full = false;
  const tick: ReconcileTick = { at: new Date().toISOString(), candidates: 0, evaluated: 0, deferred: 0, maxAttempts: 0, ms: 0, writes: 0, lockWaitMs: 0, due: 0, full: null, faces: [], readers: 0, lagMs: null };
  const view = () => { all = [...fleet.values()].sort((a, b) => a.number - b.number).map(entry => entry.work); };
  // Only the pass's candidates and the rows not settled now are versioned: a settled delivery that stays settled is never visited.
  const versionsOf = async (db: PoolClient) => new Map<string, string>((await db.query(reconcileVersionsSql, [candidates])).rows.map(row => [row.id, row.version]));
  const moved = (versions: Map<string, string>) => [...versions].filter(([id, version]) => fleet.get(id)?.version !== version).map(([id]) => id);
  // Read moved rows again into the view. Every face the read finds moved is noted for the next
  // decision with the face the view held and the document read (GY-1898), whichever writer moved it.
  const reread = async (db: PoolClient, ids: string[]): Promise<FaceMove[]> => {
    if (!ids.length) return [];
    const rows = (await db.query(reconcileRereadSql, [ids])).rows as { id: string; number: string; version: string; document: Work }[];
    documentsRead += rows.length;
    const moves: FaceMove[] = [];
    for (const row of rows) {
      const face = fleetFace(row.document), before = fleet.get(row.id)?.face ?? '';
      if (before !== face) { const move = { id: row.id, key: row.document.key, fields: faceFields(before, face) }; moves.push(move); noteFaceMove(engine, move, before, row.document); }
      // The document moved, so whatever due its last evaluation read is stale; the item is a candidate
      // this pass (a moved row is changed), and its next evaluation records the fresh instant (GY-1873).
      fleet.set(row.id, { number: Number(row.number), work: row.document, version: row.version, settled: false, face, due: null });
    }
    view();
    return moves;
  };
  let opened = false, decided = false, changed: string[] = [], config = '', fullCause: ReconcileFull['cause'] | null = null, openedAt = 0;
  // The live items whose recorded due instant has passed (GY-1873), kept beside the pass's other
  // candidate sets so the batches can say what an evaluation was woken by.
  let clockDue = new Set<string>();
  const pass: ReconcilePass = { fleet, all: () => all, view, versionsOf, moved, reread, lockWait: ms => { tick.lockWaitMs = Math.max(tick.lockWaitMs, Math.round(ms)); } };
  try {
    for (;;) {
      const opening = !opened, evaluating: string[] = [], plans: ReconcilePlan[] = [];
      let gone = 0;
      const finished = await engine.store.transaction(async (db, now) => {
        if (opening) {
          // Versions first: a row that moves after them reads as moved, so the first batch reads it again.
          const listed = (await db.query(reconcileRowsSql)).rows as { id: string; number: string; version: string; settled: boolean }[];
          config = stableJson({});
          // Measured on the clock evaluation reads, so time the gates see pass is what brings the catch-up.
          // GY-1867: the interval stretches past the last full pass, so the tick after a long full
          // pass is not full again at once; a face a writer moved no longer makes it full either
          // (GY-1898): the moved item and its readers are evaluated instead.
          fullCause = !fleet.size ? 'view' : config !== engine.reconcileConfig ? 'configuration' : !(now.getTime() - engine.reconcileFullAt < fullEvaluationIntervalMs(engine)) ? 'interval' : null;
          full = fullCause !== null;
          openedAt = now.getTime();
          if (full) engine.reconcileFullAt = openedAt;
          const versions = new Map(listed.map(row => [row.id, row]));
          for (const id of [...fleet.keys()]) if (!versions.has(id)) { const entry = fleet.get(id)!; noteFaceMove(engine, { id, key: entry.work.key, fields: ['gone'] }, entry.face, null); fleet.delete(id); }
          changed = listed.filter(row => { const entry = fleet.get(row.id); return !entry || entry.version !== row.version || entry.settled !== row.settled; }).map(row => row.id);
          // Under the lock the pass reads no document whole (GY-1027): a row that moved is held as its
          // stand-in — a settled delivery's summary, an open item's projection, served from the
          // in-process cache — and the first batch reads the open ones whole, outside the lock.
          const rows = await lockedRows(db, []);
          for (const { number, document } of rows) {
            const row = versions.get(document.id), entry = fleet.get(document.id);
            if (!row || entry && entry.version === row.version && entry.settled === row.settled) continue;
            const settled = isSettledSummary(document);
            if (!settled) { fleet.set(document.id, { number, work: document, version: row.version, settled, face: entry?.face ?? '', due: null }); continue; }
            const face = fleetFace(document);
            if (entry?.face !== face) noteFaceMove(engine, { id: document.id, key: document.key, fields: faceFields(entry?.face ?? '', face) }, entry?.face ?? '', document);
            fleet.set(document.id, { number, work: document, version: row.version, settled, face, due: null });
          }
          view();
          opened = true;
          return false;
        }
        if (!decided) {
          // The rows the opening held as stand-ins, read whole outside the coordination lock — their
          // moves are noted like any other writer's, and consumed here — then the pass decides what
          // it evaluates: the items whose own row moved, the moved item and the readers of a face any
          // writer moved (GY-1898), the lapsed, escalated and owed ones, and the dues. An item moved
          // twice (once noted mid-pass, once held as a stand-in here) is one move with the fields of both.
          await reread(db, [...fleet].filter(([, entry]) => !entry.settled && isStandIn(entry.work)).map(([id]) => id));
          const external = [...engine.reconcileFaceMoves.values()];
          engine.reconcileFaceMoves.clear();
          // A face any writer moved is decided the way the pass's own moved faces are (GY-1777):
          // only the moved item and the items whose evaluation reads it are due. Only the kept
          // view, the merge configuration and the full-evaluation interval make the pass full.
          const faceReaches = external.map(note => faceReach(note, all));
          const ownReaches = [...engine.reconcileOwnMoves.values()].map(own => faceReach(own, all));
          engine.reconcileOwnMoves.clear();
          const reaches = [...faceReaches, ...ownReaches];
          const live = [...fleet].filter(([, entry]) => !entry.settled).sort(([, a], [, b]) => a.number - b.number).map(([id]) => id);
          const moved = external.map(({ move }) => move).sort((a, b) => (fleet.get(a.id)?.number ?? Infinity) - (fleet.get(b.id)?.number ?? Infinity) || a.key.localeCompare(b.key));
          if (full) tick.full = { cause: fullCause!, moved };
          tick.faces = moved;
          // What only the clock can change (GY-1873): every evaluated item left the earliest instant
          // its outcome could change with no write in the view, and the pass wakes the ones whose
          // instant has passed, beside the items whose inputs moved as before. The full evaluation
          // stays as the safety net over both.
          clockDue = full ? new Set<string>() : new Set(live.filter(id => { const entry = fleet.get(id)!; return entry.due !== null && entry.due <= now.getTime(); }));
          const due = full ? new Set(live) : new Set([
            ...changed,
            // The moved items themselves: one noted mid-pass had its row read into the view since,
            // so `changed` no longer names it, and one noted here as a stand-in never left it.
            ...moved.map(move => move.id),
            ...engine.reconcileOwed,
            ...live.filter(id => { const work = fleet.get(id)!.work; return !!work.lease && Date.parse(work.lease.expiresAt) <= now.getTime() || reaches.some(reach => readsFace(fleet.get(id)!, reach)); }),
            ...clockDue,
          ]);
          // How many items the moved faces made evaluated (GY-1898), for the slow-tick warning.
          if (!full) tick.readers = live.filter(id => due.has(id) && (moved.some(move => move.id === id) || faceReaches.some(reach => readsFace(fleet.get(id)!, reach)))).length;
          if (full) engine.reconcileConfig = config;
          candidates = live.filter(id => due.has(id)); tick.candidates = candidates.length;
          engine.reconcileOwed.clear();
          for (const id of candidates) engine.reconcileOwed.add(id);
          decided = true;
        }
        // Evaluation, holding no lock: each item on a copy of its current document, writing nothing.
        await reread(db, moved(await versionsOf(db)));
        const started = performance.now(), batch = next;
        // Each item is evaluated against the fleet as the batch's earlier writes will leave it, as if each had been written in turn.
        const planned = new Map<string, Work>();
        while (next < candidates.length) {
          if (next > batch && (plans.length >= engine.reconcileBatchWrites || performance.now() - started >= engine.reconcileBatchMs)) return false;
          // The dry run awaits no I/O: between evaluations a renewal runs first (`yieldToRenewals`).
          await yieldToRenewals(engine);
          const id = candidates[next++];
          // Deleted since the pass opened, nothing is left to evaluate; a stand-in from the opening
          // read is read whole as the batch reaches it (GY-1027).
          if (!fleet.has(id)) { gone++; continue; } else if (isStandIn(fleet.get(id)!.work)) await reread(db, [id]);
          evaluating.push(id);
          const entry = fleet.get(id)!, copy = structuredClone(entry.work);
          const outcome = await engine.reconcileItem(db, copy, planned.size ? all.map(work => planned.get(work.id) ?? work) : all, now, { dryRun: true });
          // The evaluation read the document as it stands: its due instant stands whatever it wrote (GY-1873).
          entry.due = outcome.due;
          if (!tick.full && clockDue.has(id)) tick.due++;
          if (outcome.wrote) {
            planned.set(id, copy); plans.push({ id, work: copy, version: entry.version, now, due: outcome.due });
          }
        }
        return true;
      }, { lane: 'background', coordinationLock: opening, retryStaleWrites: false });
      if (opening) continue;
      // What the batch found nothing to write for is settled; each planned item is settled by its own write.
      for (const id of evaluating) if (!plans.some(plan => plan.id === id)) engine.reconcileOwed.delete(id);
      tick.evaluated += evaluating.length - plans.length; tick.deferred += gone; tick.maxAttempts = Math.max(tick.maxAttempts, 1);
      // Writing, each item in a transaction of its own (`reconcileWrite`), so no row is held past its own write.
      let stale = false, attempts = 0;
      for (let index = 0; index < plans.length;) {
        let written: ReconcileWritten;
        try { written = await reconcileWrite(engine, plans[index], stale, pass); }
        catch (error) {
          // Nothing was written: the coordination lock stayed held past the wait, so the write is tried again.
          if (!(error instanceof ReconcileContended)) throw error;
          tick.maxAttempts = Math.max(tick.maxAttempts, ++attempts);
          if (attempts < engine.reconcileMaxAttempts) { await new Promise(resolve => setTimeout(resolve, engine.reconcileRetryBackoffMs * attempts)); continue; }
          // Out of attempts: the batch's unwritten items stay owed to the next pass, and the pass goes on.
          console.warn(`reconciliation deferred ${plans.length - index} item(s) after ${attempts} attempts found the coordination lock held past ${engine.reconcileCommitLockWaitMs} ms; retrying next tick`);
          tick.deferred += plans.length - index;
          break;
        }
        // Committed: what the write saved stands in for its row in the next locked read (GY-1027), and a
        // face it moved is owed to the rest of the fleet.
        written.apply(); rememberSaved(written.saved);
        engine.reconcileOwed.delete(plans[index].id);
        if (written.faceMoved) noteOwnMove(engine, written.faceMoved);
        tick.maxAttempts = Math.max(tick.maxAttempts, attempts + 1); tick.evaluated++; if (written.wrote) tick.writes++;
        stale = written.stale; attempts = 0; index++;
      }
      if (finished) break;
      await new Promise(resolve => setImmediate(resolve));
    }
  } catch (error) {
    // A failure that rolled back a transaction may leave the kept view holding a document the database never stored.
    engine.resetReconcileView();
    throw error;
  }
  engine.lastReconcile = { documentsRead, evaluated: tick.evaluated, live: [...fleet.values()].filter(entry => !entry.settled).length, full };
  const elapsedMs = performance.now() - tickStarted;
  tick.ms = Math.round(elapsedMs);
  // The next full pass is spaced past this one's own length, whatever made it full (GY-1867).
  if (tick.full) engine.reconcileFullMs = tick.ms;
  tick.lagMs = engine.eventLoopLag.read();
  engine.reconcileTicks.push(tick);
  if (engine.reconcileTicks.length > 20) engine.reconcileTicks.shift();
  if (elapsedMs >= engine.reconcileSlowWarnMs) {
    // GY-1777: the warning says what made the pass full and the loop's lag, so a starved process is told from a held lock.
    const why = tick.full ? `every live item evaluated because ${describeFull(tick.full)}`
      : `${tick.candidates} candidate(s) whose inputs moved${tick.faces.length ? `, ${describeFaceMoves(tick.faces)} and made ${tick.readers} evaluated` : ''}${tick.due ? `, ${tick.due} of them due by the clock` : ''}`;
    const lag = tick.lagMs ? `event-loop lag p50 ${tick.lagMs.p50} ms, max ${tick.lagMs.max} ms over the tick` : 'no event-loop lag sample over the tick';
    console.warn(`reconciliation tick took ${Math.round(elapsedMs)} ms for ${engine.lastReconcile.live} item(s) (${tick.evaluated} evaluated, ${tick.writes} written, longest wait for the coordination lock ${tick.lockWaitMs} ms; ${why}; ${lag}), over the ${engine.reconcileSlowWarnMs} ms bound; a high lag is this process starved of CPU, otherwise find what held the coordination lock in the server logs`);
  }
}

/**
 * Write one item a reconciliation batch planned, in a transaction of its own (GY-1290). It waits
 * in line for the coordination lock holding no row, so no fleet command can move what the item
 * reads while it writes; reads again whatever moved since the batch evaluated; and only then
 * takes the item's row lock, which nothing but a lease renewal can hold now, for its own write.
 * When neither the item's row nor any item's face moved since the evaluation (`stale` carries an
 * earlier write that came out other than evaluated), the evaluation stands and is written as it
 * is; otherwise the item is evaluated again, on its current document against the current fleet.
 * Committing per item means a renewal waits on reconciliation for at most its own item's write:
 * never on the batch's evaluation of other items, nor on a later write that waits for its turn.
 */
async function reconcileWrite(engine: Engine, plan: ReconcilePlan, stale: boolean, pass: ReconcilePass): Promise<ReconcileWritten> {
  // Before its transaction, so the write holds no lock while a renewal runs.
  await yieldToRenewals(engine);
  return engine.store.transaction(async (db, now) => {
    const waitStarted = performance.now(), locked = await coordinationLockWithin(db, engine.reconcileCommitLockWaitMs);
    pass.lockWait(performance.now() - waitStarted);
    if (!locked) throw new ReconcileContended();
    if ((await pass.reread(db, pass.moved(await pass.versionsOf(db)))).length) stale = true;
    const row = (await db.query(reconcileRowLockSql, [plan.id])).rows[0] as { version: string } | undefined;
    if (!row || !pass.fleet.has(plan.id)) return { wrote: false, stale, faceMoved: null, saved: [], apply: () => {} };
    if (row.version !== pass.fleet.get(plan.id)!.version) await pass.reread(db, [plan.id]);
    const entry = pass.fleet.get(plan.id)!;
    let work = plan.work, before = entry.work, due = plan.due;
    if (!stale && entry.version === plan.version) await writeReconciled(engine, db, work, pass.all(), plan.now);
    else {
      // In place: a failure from here on clears the kept view, as every rolled-back write does. The
      // document as it stood is kept apart (GY-1777), so a reader of a relationship the write
      // removes (a path, a resource) is reached through it rather than left to the full pass.
      before = structuredClone(entry.work);
      work = entry.work;
      const outcome = await engine.reconcileItem(db, work, pass.all(), now);
      // The re-evaluation read the document as it now stands: its due instant replaces the planned one (GY-1873),
      // here and in what the committed write keeps.
      entry.due = due = outcome.due;
      // Items the batch evaluated after this one read it as evaluated: if it came out otherwise, they are evaluated again too.
      if (fleetFace(work) !== fleetFace(plan.work)) stale = true;
      if (!outcome.wrote) return { wrote: false, stale, faceMoved: null, saved: [], apply: () => {} };
    }
    const version = ((await db.query('SELECT xmin::text AS version FROM work_items WHERE id = $1', [plan.id])).rows[0] as { version: string }).version, face = fleetFace(work);
    const saved = await savedVersions(db, [work]);
    const faceMoved = face !== entry.face ? { move: { id: plan.id, key: work.key, fields: faceFields(entry.face, face) }, before, after: work } : null;
    return { wrote: true, stale, faceMoved, saved, apply: () => { Object.assign(entry, { work, version, face, due }); pass.view(); } };
  }, { lane: 'background', coordinationLock: false, retryStaleWrites: false });
}

/**
 * Take the coordination lock for one planned write, waiting in line for at most `ms` (GY-1115,
 * GY-1290). The write's transaction holds no row lock when it asks, so no holder can be waiting
 * on it; the check that none is (`reconcileCommitBlockingSql`) and the wait's cap at half the
 * session's `deadlock_timeout` keep that guarantee enforced rather than assumed, should a write
 * ever take a lock before it. A wait past `ms`, or a holder blocked on the write, is contention:
 * the write is tried again.
 */
async function coordinationLockWithin(db: PoolClient, ms: number) {
  const { blocking, deadlock_ms: deadlockMs } = (await db.query(reconcileCommitBlockingSql, [advisoryLocks.coordination])).rows[0];
  if (blocking) return false;
  await db.query(`SET LOCAL lock_timeout = '${commitLockWaitMs(ms, Number(deadlockMs))}ms'`);
  try { await db.query('SELECT pg_advisory_xact_lock($1)', [advisoryLocks.coordination]); }
  catch (error) { if (['55P03', '40P01'].includes((error as { code?: string }).code ?? '')) return false; throw error; }
  await db.query('SET LOCAL lock_timeout TO DEFAULT');
  return true;
}

/**
 * One item's reconciliation inside a batch, holding the item's row lock; `wrote` says whether it
 * wrote the item, and `due` is the earliest instant at which the evaluated document's outcome
 * could change with no write (GY-1873), read whether or not anything was written — that instant
 * is what wakes the item later. A `dryRun` (GY-1290) evaluates `work` — a copy — with no lock and
 * writes nothing: `wrote` says the evaluation would write, which is all the batch's lock-free
 * phase asks.
 */
export async function reconcileItem(engine: Engine, db: PoolClient, work: Work, all: Work[], now: Date, { dryRun = false }: { dryRun?: boolean } = {}): Promise<{ wrote: boolean; due: number | null }> {
  // A delivered item is not re-evaluated, but one still holding rows, a merge-queue entry (stored
  // before GY-1236) or an action from before its delivery — every item delivered before GY-185 —
  // is settled here once, and the check that finds nothing to settle costs no evaluation. A
  // verify-deployment row or action left from before done-at-merge (GY-1981) is such a leftover.
  if (work.stage === 'done') {
    const leftover = !!(work as Work & { queue?: unknown }).queue || !!work.actionQueue?.actions.length || !!work.nextAction;
    if (!leftover || !settleDelivered(work, all, now)) return { wrote: false, due: null };
    reconcileWrites.set(work, { delivered: true });
    if (!dryRun) await writeReconciled(engine, db, work, all, now);
    return { wrote: true, due: null };
  }
  const before = JSON.stringify(work);
  // The liveness invariant (GY-201) is judged on the record as it stood, before this tick
  // touched it, so a violation the tick repairs is recorded rather than silently absorbed.
  const stranded = livenessOf(work, all, now).violation;
  preserveAssignment(work);
  // A recorded server-side renewal fault keeps the lease for one more period (GY-558).
  await renewalGrace(engine, db, work, now);
  const leaseLost = !!work.lease && Date.parse(work.lease.expiresAt) <= now.getTime();
  // GitHub executes merges (GY-258): a merge execution recorded before that stays in the
  // ledger, where delivery attribution reads it, and no longer holds the record.
  if (work.mergeExecution) work.mergeExecution = null;
  const ledger: { kind: string; details: Record<string, unknown> }[] = [];
  // A lapsed lease ends the attempt and the item is claimable again: nothing is escalated.
  const lost = leaseLost ? work.lease! : null;
  if (lost) {
    work.lease = null;
    ledger.push({ kind: 'lease.expired', details: { owner: lost.owner, epoch: lost.epoch, expiresAt: lost.expiresAt, submission: work.submission } });
    endLapsedAttempt(work, lost, now);
  }
  const due = engine.evaluate(work, all, now);
  // Every violation found at the start of the tick is repaired by the evaluation above — the
  // derivation names its successor and the queue opens its row — and the ledger says so.
  if (stranded) ledger.push(livenessRepairEntry(stranded, work, all, now));
  if (!jsonChanged(before, work)) return { wrote: false, due };
  reconcileWrites.set(work, { ledger });
  if (!dryRun) await writeReconciled(engine, db, work, all, now);
  return { wrote: true, due };
}

/** Write `work` as `reconcileItem` evaluated it at `now`: its ledger entries, its dispatch transitions, the document and its wakes. */
async function writeReconciled(engine: Engine, db: PoolClient, work: Work, all: Work[], now: Date) {
  const write = reconcileWrites.get(work)!;
  reconcileWrites.delete(work);
  if ('delivered' in write) { await save(db, work, 'graphyard', 'delivery.settled', now); return; }
  const { ledger } = write;
  for (const entry of ledger) await record(db, work, 'graphyard', entry.kind, { details: { ...entry.details, at: now.toISOString() } });
  await recordDispatch(db, work, now);
  await save(db, work, 'graphyard', 'reconciled', now, ledger.length ? { ledger: ledger.map(entry => entry.kind) } : undefined);
  if (work.submission) await wakeJob(db, work.id);
}
