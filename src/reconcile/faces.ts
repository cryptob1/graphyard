import { stableJson } from '../model/stable-json.js';
import type { PoolClient } from 'pg';
import { pathScopesOverlap } from '../model.js';
import type { Work } from '../model.js';
import type { ActionAccount } from '../model/action-account.js';
import { rowDueAt, stalledActionLifts, waitDueAt } from '../model/liveness.js';
import type { SavedVersion } from '../store/locked-read.js';

/**
 * One reconciliation tick's outcome (GY-1115, GY-1290): every candidate is evaluated or deferred.
 * `writes` counts the items its batches wrote, and `lockWaitMs` is the longest a batch waited in
 * line for the coordination lock before writing them: the one place a tick waits on other writers.
 * `full` says why the tick evaluated every live item, or is null when it evaluated only the items
 * whose inputs moved, and `lagMs` is the event-loop lag sampled over the tick's window (GY-1777),
 * null when the window held no sample. `due` counts the items a non-full tick evaluated because
 * their recorded due instant had passed (GY-1873), not because an input moved. `faces` lists the
 * fleet faces a writer outside the pass moved that the tick decided on (GY-1898) — also on a full
 * tick, where `full.moved` names them again — and `readers` counts the live items those faces made
 * evaluated: the moved ones and the ones whose evaluation reads them.
 */
export interface ReconcileTick { at: string; candidates: number; evaluated: number; deferred: number; maxAttempts: number; ms: number; writes: number; lockWaitMs: number; due: number; full: ReconcileFull | null; faces: FaceMove[]; readers: number; lagMs: { p50: number; max: number } | null }

/** One item whose fleet face moved (GY-1777): which face fields, or `new` for an item the view first read and `gone` for one deleted. */
export interface FaceMove { id: string; key: string; fields: string[] }
/**
 * Why a tick evaluated every live item (GY-1777, GY-1898): the kept view was empty (`view`: the
 * first pass of a process, or one after a reset), the merge configuration changed, or the
 * full-evaluation interval elapsed — since GY-1898 these are the only full passes, for a fleet
 * face a writer moved is decided the way the pass's own moved faces are (GY-1777), on the tick's
 * `faces`. `moved` lists the faces other writers moved that the full pass also decided on.
 */
export interface ReconcileFull { cause: 'view' | 'configuration' | 'interval'; moved: FaceMove[] }

/**
 * One item in the reconciliation view kept between passes (GY-1124). `due` is what the item's last
 * evaluation read as the earliest instant at which its outcome could change with no write
 * (GY-1873): null until an evaluation of the document as it stands has run, and stale the moment
 * the document moves — every reread and every write re-records it from the evaluation of what
 * stands then.
 */
export interface ReconcileEntry { number: number; work: Work; version: string; settled: boolean; face: string; due: number | null }
/** A write a reconciliation batch planned (GY-1290): its evaluation of the item, on a copy, at the row version and the clock it read, with the due instant that evaluation read (GY-1873). */
export interface ReconcilePlan { id: string; work: Work; version: string; now: Date; due: number | null }
/** One planned write, committed: whether it wrote, whether later planned items must be evaluated again, and what to keep of it once committed. */
export interface ReconcileWritten { wrote: boolean; stale: boolean; faceMoved: OwnFaceMove | null; saved: SavedVersion[]; apply: () => void }
/** The running pass's kept view and its readers, as one planned write needs them. */
export interface ReconcilePass {
  fleet: Map<string, ReconcileEntry>; all: () => Work[]; view: () => void; lockWait: (ms: number) => void;
  versionsOf: (db: PoolClient) => Promise<Map<string, string>>; moved: (versions: Map<string, string>) => string[]; reread: (db: PoolClient, ids: string[]) => Promise<FaceMove[]>;
}
/**
 * What other items' evaluations can read of an item (GY-1124): its document without the fields a
 * renewal moves — the revision, the update time, the lease's expiry, and an action claim's expiry
 * and renewal count (GY-1276), and the assignment's session start the first renewal stamps
 * (GY-1499). A heartbeat or an executor's claim renewal leaves the face unchanged, so the pass
 * after it evaluates only the renewed item; any other write changes it, and
 * the pass evaluates every live item against it, unless the write was a reconciliation pass's own
 * (GY-1777): that pass evaluated against it as planned, so the next evaluates only the items whose
 * evaluation reads it (`readsFace`: by reference, as a split sibling, through a shared exclusive
 * resource or an overlapping path scope). A claim expiring is a move of the clock alone, which the
 * bounded full evaluation (`reconcileFullEvaluationMs`) catches up.
 */
export function fleetFace(work: Work) {
  const { revision: _revision, updatedAt: _updatedAt, lease, actionQueue, lastAssignment, ...rest } = work;
  const assignment = lastAssignment && (({ startedAt: _startedAt, ...identity }) => identity)(lastAssignment);
  const actions = actionQueue && {
    ...actionQueue,
    actions: actionQueue.actions.map(row => {
      if (!row.claim) return row;
      const { expiresAt: _expiresAt, renewedAt: _renewedAt, renewals: _renewals, ...claim } = row.claim;
      return { ...row, claim };
    }),
  };
  return stableJson({ ...rest, lastAssignment: assignment, actionQueue: actions, lease: lease ? { owner: lease.owner, epoch: lease.epoch } : null });
}
/**
 * The face fields that differ between two fleet faces (GY-1777), as the slow-tick warning names
 * them: `new` when the view held no face before, `gone` when it holds none after.
 */
export function faceFields(before: string, after: string): string[] {
  if (!before) return ['new'];
  if (!after) return ['gone'];
  const a = JSON.parse(before) as Record<string, unknown>, b = JSON.parse(after) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(field => JSON.stringify(a[field]) !== JSON.stringify(b[field])).sort();
}
/** The moves merged by item (GY-1777): one entry per item in the order first seen, its fields the union of every move's. */
export function mergeFaceMoves(moves: Iterable<FaceMove>): FaceMove[] {
  const merged = new Map<string, FaceMove>();
  for (const move of moves) {
    const known = merged.get(move.id);
    merged.set(move.id, known ? { ...known, fields: [...new Set([...known.fields, ...move.fields])].sort() } : move);
  }
  return [...merged.values()];
}
/**
 * The earliest instant at which this evaluated document's outcome could change with no write
 * (GY-1873): the minimum over the time-bounded inputs its evaluation read — the lease's expiry,
 * every open row's due (its claim, its retry, its settle window, the idle bound), the bound the
 * named wait runs to, the observation window's opening, every evidence record's expiry, the review
 * gate's mechanical hold and a running split's dispatch hold, and the
 * widest backoff a stalled action's escalation lifts at. Instants already past are ignored: what they guarded has flipped already
 * (or needs a write, or the full evaluation), and a past due would wake the item every pass. Null
 * when the document holds none — then only a write or the full evaluation can change the outcome,
 * and the item is never evaluated as due. A wait on another item is deliberately absent: nothing
 * on this document flips when that instant passes — the other item's own due and the face its
 * evaluation writes reach the waiter through `readsFace`.
 */
export function reconcileDueAt(work: Work, all: Work[], now: Date, account: ActionAccount): number | null {
  const nowMs = now.getTime();
  let due: number | null = null;
  const consider = (at: number | null | undefined) => { if (at != null && Number.isFinite(at) && at > nowMs && (due === null || at < due)) due = at; };
  const considerIso = (value: string | null | undefined) => { if (value) consider(Date.parse(value)); };
  considerIso(work.lease?.expiresAt);
  for (const row of work.actionQueue?.actions ?? []) considerIso(rowDueAt(row, now));
  if (!account.action && account.wait && account.wait.kind !== 'dependency') considerIso(waitDueAt(work, account.wait, all, now));
  considerIso(work.observationWindow?.notBefore);
  // Accepted evidence stops counting once its expiry passes (currentEvidence), so a gate can fail by the clock alone.
  for (const evidence of work.evidence ?? []) considerIso(evidence.expiresAt);
  // The review gate's mechanical hold lapses at its round window, and dispatch's wait on a running split at its limit and grace.
  for (const lift of stalledActionLifts(work)) consider(lift);
  return due;
}
/** A fleet face the pass's own planned write moved (GY-1777): the move, and the item's document before and after it. */
export interface OwnFaceMove { move: FaceMove; before: Work; after: Work }
/**
 * The document a moved face's readers last saw (GY-1898): the recorded face parsed back. A fleet
 * face keeps every field of the document another item's evaluation reads (`fleetFace` strips only
 * the fields no evaluation reads of another item), so the face the view held stands in for the
 * document the move left wherever the whole document is no longer kept.
 */
export function faceDocument(face: string): Work | null { return face ? JSON.parse(face) as Work : null; }
/**
 * What a moved face reaches (GY-1777, GY-1898): every way one item's evaluation reads another's face. By
 * reference, as a dependency, a wait on it or a follow-up of its delivery: its id or key stands in
 * the reader's own face (`mention`). Through an exclusive resource both name (`resourceConflicts`). Through path
 * scope (`fileConflicts`, `inheritedObligations`): the reader's observed and landing-check files
 * against the moved item's observed files, the
 * contract paths of a bootstrap deferral it declares, and those of any deferral whose proof its
 * evidence may have delivered. Built from the document before and after the move — whole where the
 * view keeps it, the recorded face where it does not (`faceDocument`) — and every document a
 * repeated move passed through between them (`between`), so a reader of any of them is reached.
 * Either end is null when the move created or deleted the item.
 */
export interface FaceReach { id: string; mention: RegExp; resources: Set<string>; paths: string[] }
export interface FaceMoveSides { move: FaceMove; before: Work | null; after: Work | null; between?: Work[] }
export function faceReach({ move, before, after, between = [] }: FaceMoveSides, all: Work[]): FaceReach {
  const sides = [before, ...between, after].filter((work): work is Work => !!work);
  const proofs = new Set(sides.flatMap(work => work.evidence ?? []).map(evidence => evidence.proof));
  const paths = new Set<string>();
  for (const work of sides) {
    for (const path of [...work.observation?.files ?? [], ...work.plannedFiles ?? [], ...work.exclusiveResources ?? []]) paths.add(path);
    for (const criterion of work.criteria ?? []) for (const path of criterion.bootstrap?.contractPaths ?? []) paths.add(path);
  }
  for (const work of all) {
    if (work.id === move.id) continue;
    for (const criterion of work.criteria ?? []) if (criterion.bootstrap && criterion.proofs.some(proof => proofs.has(proof))) for (const path of criterion.bootstrap.contractPaths) paths.add(path);
  }
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return { id: move.id, mention: new RegExp(`${escaped(move.id)}|(^|[^A-Za-z0-9])${escaped(move.key)}(?![A-Za-z0-9])`),
    resources: new Set(sides.flatMap(work => work.exclusiveResources ?? [])), paths: [...paths] };
}
/** The paths other items' evaluations read an item on (GY-1777): the files its candidate was observed to change, and the ones its landing check compared. */
export function readerPaths(work: Work): string[] {
  return [...work.plannedFiles ?? [], ...work.exclusiveResources ?? [], ...work.observation?.files ?? [], ...(work.observation?.scopeFiles ?? []).map(file => file.path), ...(work.observation?.landing?.files ?? []).map(file => file.path)];
}
/** Whether `entry`'s evaluation reads the moved face `reach` describes (GY-1777). */
export function readsFace(entry: ReconcileEntry, reach: FaceReach) {
  const work = entry.work;
  if (work.id === reach.id) return false;
  if (reach.mention.test(entry.face)) return true;
  if ((work.exclusiveResources ?? []).some(resource => reach.resources.has(resource))) return true;
  return readerPaths(work).some(path => reach.paths.some(other => pathScopesOverlap(path, other)));
}
/** The moved faces as the slow-tick warning names them (GY-1777): each by key and the fields that changed on it. */
export function describeFaceMoves(moves: FaceMove[]) {
  return `the fleet face of ${moves.map(move => `${move.key} (${move.fields.join(', ')})`).join(', ')} moved`;
}
/** The slow-tick warning's account of a full pass (GY-1777, GY-1898): its cause, and every face another writer moved beside it. */
export function describeFull(full: ReconcileFull) {
  const moved = full.moved.length ? describeFaceMoves(full.moved) : '';
  const cause = { view: 'the kept view was empty (the first pass of this process, or one after a reset)', configuration: 'the merge configuration changed', interval: 'the full-evaluation interval elapsed' }[full.cause];
  return moved ? `${cause}, and ${moved}` : cause;
}
