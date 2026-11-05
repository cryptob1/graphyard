import type { PoolClient } from 'pg';
import type { Principal, Work, Observation } from './model.js';
import type { GitRunner } from './merge-writer/local-observation.js';
import { runCommand } from './engine/commands/run.js';
import { renewalFaultOf, renewalFaultRefusal, recordPlaneLiveness, startPlaneBeat, yieldToRenewals } from './engine/leases.js';
import type { Command } from './engine/commands/schemas.js';
import { evaluateWork } from './engine/evaluate.js';
import { observe, observeControlPlaneCandidate } from './engine/observe.js';
import { observationJob, pullAssignment, resyncWork } from './engine/actions.js';
import { coordinationLockWithin, fullEvaluationIntervalMs, noteFaceMove, reconcileWrite, reconcile, reconcileItem, reconcileTick } from './reconcile/scheduler.js';
import { EventLoopLag, configuredReconcileFullMs } from './reconcile/lag.js';
import type { FaceMove, FaceMoveSides, OwnFaceMove, ReconcileEntry, ReconcilePass, ReconcilePlan, ReconcileTick } from './reconcile/faces.js';

import type { Store } from './store.js';
export { idempotencyMismatch, type Command } from './engine/commands/schemas.js';
export { RenewalFault, planeStallMs, readPlaneStalls, renewalFaultEvent, renewalFaultOf, stallRenewalWindowMs } from './engine/leases.js';
export { actionOnlyLookback, onlyActionsMovedSince, sameBesideActions, sameBesideBookkeeping } from './engine/observe.js';
export { EventLoopLag, configuredReconcileFullMs } from './reconcile/lag.js';
export type { FaceMove, ReconcileFull, ReconcileTick } from './reconcile/faces.js';

export class Engine {
  operatorAuthorizer?: (db: any, now: Date, actor: Principal) => Promise<Principal>;
  // The configured credential registry, used to report which required proof names
  // currently have an authorized producer. Authority itself lives in the grant store.
  principals: Principal[] = [];
  // Reviewer identities and the control-plane App are deployment facts, not client input.
  /**
   * Reads a submitted head from the control plane's checkout (GY-1523) while the control plane is
   * the merge writer. Left undefined, `git -C` GRAPHYARD_REPOSITORY_ROOT (else the working
   * directory); null means no checkout, and every head submission is refused as unreadable.
   */
  gitRunner: GitRunner | null | undefined = undefined;
  /** The base branch a submitted head is observed against (GY-1523): the deployment's GITHUB_BASE_BRANCH, else `main`. */
  baseBranch = process.env.GITHUB_BASE_BRANCH ?? 'main';
  constructor(public store: Store, public leaseSeconds = 120, public repository = process.env.GITHUB_REPOSITORY ?? '') {}
  /** The commit this process first recorded itself serving (recordPlaneLiveness); undefined until its first tick named one (GY-2177). */
  servedCommit: string | null | undefined;

  /**
   * Run one command. A renewal that fails server-side — what `renewalFaultOf` blames on the server: a connection or statement timeout,
   * a lost connection, the database's server-error classes — is recorded against its lease
   * (`recordRenewalFault`) and answered 503 with the grace that record earns. Any other failure,
   * a programming error included, is refused without a grace, so bugs surface instead of
   * extending the lease they broke (GY-671).
   */
  async execute(actor: Principal, command: Command, id: string | null, input: unknown, key: string, context: { observation?: Observation } = {}) {
    if (command !== 'heartbeat') return runCommand(this, actor, command, id, input, key, context);
    const started = new Date();
    this.renewing++;
    try {
      return await runCommand(this, actor, command, id, input, key, context);
    } catch (error) {
      if (renewalFaultOf(error) === null || !id) throw error;
      throw await renewalFaultRefusal(this, actor, id, Number((input as { epoch?: unknown } | null)?.epoch), started, error);
    } finally {
      if (--this.renewing === 0) for (const resume of this.renewalsDone.splice(0)) resume();
    }
  }
  /** Lease renewals in flight in this process, and the reconciliation steps waiting for them to finish (GY-1290). */
  renewing = 0;
  readonly renewalsDone: (() => void)[] = [];
  /**
   * The longest one reconciliation step waits for the renewals in flight (GY-1290). A renewal takes
   * no lock a waiting step holds, so the wait ends when they do; the bound only keeps a stream of
   * overlapping renewals from holding reconciliation back indefinitely.
   */
  reconcileYieldMs = 1_000;

  evaluate(work: Work, all: Work[], now: Date): number | null { return evaluateWork(work, all, now); }
  observeControlPlaneCandidate(work: Work) { return observeControlPlaneCandidate(this, work); }
  observe(id: string, expectedRevision: number, observation: Observation, jobToken?: string) { return observe(this, id, expectedRevision, observation, jobToken); }
  pullAssignment(actor: Principal, input: unknown, key: string) { return pullAssignment(this, actor, input, key); }
  resyncWork(actor: Principal, id: string, input: unknown = {}) { return resyncWork(this, actor, id, input); }
  observationJob(id: string) { return observationJob(this, id); }
  recordPlaneLiveness(at?: Date) { return recordPlaneLiveness(this, at); }
  startPlaneBeat(intervalMs?: number) { return startPlaneBeat(this, intervalMs); }
  reconcile(): Promise<void> { return reconcile(this); }
  fullEvaluationIntervalMs() { return fullEvaluationIntervalMs(this); }
  noteFaceMove(move: FaceMove, before: string, after: Work | null) { return noteFaceMove(this, move, before, after); }
  reconcileWrite(plan: ReconcilePlan, stale: boolean, pass: ReconcilePass) { return reconcileWrite(this, plan, stale, pass); }
  yieldToRenewals() { return yieldToRenewals(this); }
  reconcileTick() { return reconcileTick(this); }
  coordinationLockWithin(db: PoolClient, ms: number) { return coordinationLockWithin(db, ms); }
  /** One item's reconciliation inside a batch (`reconcile/scheduler.ts`); a method so a test can wrap it. */
  reconcileItem(db: PoolClient, work: Work, all: Work[], now: Date, options: { dryRun?: boolean } = {}) { return reconcileItem(this, db, work, all, now, options); }

  /**
   * How long one reconciliation batch may hold its items' row locks before it yields (GY-274).
   * The first tick after a deploy re-evaluated every item under one lock for 65 s, and every
   * heartbeat queued behind it until the workers' supervisors gave up.
   */
  reconcileBatchMs = 250;
  /**
   * A reconciliation tick slower than this logs a warning with its item count and duration
   * (GY-727): a tick over the bound is the symptom that preceded GY-727's 30 s passes. The
   * production bound; only tests shorten it, as they shorten `reconcileBatchMs`.
   */
  reconcileSlowWarnMs = 5_000;
  /**
   * The most writes one batch plans (GY-1290): each runs in its own transaction under the
   * coordination lock, and every later item in the batch is evaluated against the earlier ones as
   * planned, so the count bounds how much one surprise at write time sends back for evaluation.
   */
  reconcileBatchWrites = 8;
  /**
   * How long a batch with writes waits in line for the coordination lock (GY-1115, GY-1290), never
   * more than half the server's `deadlock_timeout` (`coordinationLockWithin`); it holds no row while
   * it waits. A write that could not take it tries again, `reconcileRetryBackoffMs` later per
   * attempt, and after `reconcileMaxAttempts` attempts the batch's unwritten items are deferred to the next pass.
   */
  reconcileCommitLockWaitMs = 500;
  reconcileMaxAttempts = 3;
  reconcileRetryBackoffMs = 25;
  /** The last reconciliation ticks, newest last (GY-1115): what each evaluated, deferred and wrote, and its longest wait for the coordination lock. */
  readonly reconcileTicks: ReconcileTick[] = [];
  /**
   * How long reconciliation may go without evaluating every live item (GY-1124). Between full
   * passes a pass evaluates only the items whose inputs it can see moving; this bound catches up
   * what only the clock moves — an observation going stale, a settle window closing. It is the
   * floor: the next full pass is due no sooner than `fullEvaluationIntervalMs` (GY-1867).
   */
  reconcileFullEvaluationMs = configuredReconcileFullMs();
  /** The measured duration (ms, rounded) of the last full pass, recorded when that pass ends (GY-1867). */
  reconcileFullMs = 0;
  /**
   * The fleet as the last pass left it (GY-1124): every item's document — a settled delivery's
   * work-index summary — with the row version (`xmin`) it was read at, whether the index called
   * it settled, and its fleet face (`fleetFace`). Kept between passes, so a pass reads again only
   * the documents whose row moved; cleared whenever a pass fails in a way that could leave it
   * holding a document the database rolled back.
   */
  readonly reconcileView = new Map<string, ReconcileEntry>();
  /** Items a pass chose to evaluate that no committed batch evaluated (a deferred batch, a row a writer held): the next pass owes them. */
  readonly reconcileOwed = new Set<string>();
  /** When the last full evaluation began (the database clock, ms), and the configuration it evaluated under. */
  reconcileFullAt = -Infinity;
  reconcileConfig = '';
  /**
   * Fleet faces a writer outside the running pass moved since the last pass decided what to
   * evaluate, by item, each with the face the view held before the move and the document read
   * after it (GY-1124, GY-1898): the next pass evaluates the moved item and the items whose
   * evaluation reads the face (`readsFace`) — not every live item, since GY-1898 — and a slow tick
   * names the faces and how many items they made evaluated.
   */
  readonly reconcileFaceMoves = new Map<string, FaceMoveSides>();
  /**
   * Fleet faces the pass's own planned writes moved (GY-1777): the pass evaluated against them as
   * planned, so they do not make the next pass full; it evaluates the items whose evaluation reads
   * them (`readsFace`), and the bounded full evaluation catches up the rest.
   */
  readonly reconcileOwnMoves = new Map<string, OwnFaceMove>();
  /** The event-loop lag sampler (GY-1777), open over each tick's window and read into the tick. */
  readonly eventLoopLag = new EventLoopLag();
  /** What the last pass read and evaluated: the documents it fetched, the items it evaluated, and whether it was full. */
  lastReconcile = { documentsRead: 0, evaluated: 0, live: 0, full: false };
  /** Forget the kept view, so the next pass reads the whole fleet again (GY-1124). */
  resetReconcileView() { this.reconcileView.clear(); this.reconcileOwed.clear(); this.reconcileFullAt = -Infinity; this.reconcileFaceMoves.clear(); this.reconcileOwnMoves.clear(); }
  reconcileRunning: Promise<void> | null = null;
  reconcileTrailing: Promise<void> | null = null;
}
