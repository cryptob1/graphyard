<!-- page: Operate Graphyard | 5 | loop, merges. -->
# Master-agent operating mode

The master (`coordinator`) routes and administers GitHub unasked, never implementing, reviewing or proving; it no longer hand-decomposes goals ([goal pipeline](how-graphyard-works.md#from-goal-to-work-items)). Human-only: goals and priorities, spending money or opening third-party accounts, issuing credentials to people ([who decides](glossary.md#who-decides)); it decides the rest, never asking a human to run what an agent may. `master guide` prints its role instructions, then this page; AGENTS.md carries the worker block.

## Operate

Keep cycling: `master status`; `master run` dispatches (`schedule.order`); merge gate-passing candidates; rework findings; deployment verification (`master verify-deployment GY-N`, [refusals](operations-reference.md#perpetual-master-loop)); Close finished agent sessions. Stop only when every in-scope item is Done or has a genuinely external blocker recorded in Graphyard, and every merge is verified against the exact deployed release or deployment-blocked. Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions. `controlPlane.production` flags main ahead of production.

`master run` is unit `graphyard-master.service` ([supervision](onboarding.md#the-loop-must-be-supervised)); on `daemon.liveness` `stalled`/`absent`: `systemctl --user restart graphyard-master`, never from a [dirty or non-forward checkout](master-agent-sessions.md#the-coordinator-checkout-is-confined-at-the-os-level).

**Cycle cadence.** The loop sleeps `run.intervalSeconds`, at most 30 s while anything is actionable. The dispatcher tick wakes it early, once per new subject, no sooner than `run.dispatchIntervalSeconds` after the cycle (`woken Ns before the … wait ended: REASONS`), never cutting a failed cycle's backoff.

### System-driven items

Unless created `"systemDriven": false`, items refuse hand `dispatch`, `merge`, `review`, `decide attest|merge`, loop-owned `decide rework` (`--precedent` answers refusals), except stopped-loop recovery, unproduced `manual:` attestations, `decide merge` unauthorized or without an operator agent. The loop attests unproduced `manual:` proofs via an independent approver once per head, base, policy revision (`loopDecisions.attestations`).

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness; closing sessions is not the master's manual duty.** A sweep runs every automatic-dispatch tick (`run.dispatchIntervalSeconds`, default 10, 30 at most); a coordination handle closes at the second consecutive sweep that misses it; a handle a lease or dispatch request names is held until it ends; an unobserved one is left alone for its first 3 minutes; a paneless worker handle reads `launching` under its lease. A handle another host launched is left to that host's loop. Closures: **Vanished** (named by no attempt or request, missing twice; a request-less review is recorded ended and relaunched), **Ended** (agentless pane or terminal state; `idle`, `done` and `blocked` are deliberately not terminal; also unlisted after its attempt or request ended, recorded), **Superseded** (review or proof session for a head the item moved past, delivered items too; implementation sessions follow lease), **Duplicate** (older session per role and head). A closure decides no gate, ends no lease, stops no process; concurrency and busy names count live sessions only. A session past its role's maximum (4h implementation, 1h review, `run.producerTimeoutMinutes` for a producer, 12h coordination) is flagged, not closed.

**Instead of closing sessions by hand:** do nothing for a finished or dead session (`graphyard master run --once` sweeps); attach to an overlong one with its handle's command. Never mark another session's handle finished to free a slot.

`blocked` frees its slot; [classes](protocol/leases.md#blocked-work-unblocks-itself) `github-credential`, `control-plane-error`, `sandbox-path`, `worktree-mismatch`, `outside-scope-test-failure`, `dispatch-failure`, `host-supervisor`, `planned-file-scope`, `needs-decision` self-clear; `genuine`/`human-only` escalate.

### System invariants

Per cycle (`daemon.invariants.lines`): `follow-ups-per-parent` (1 open), `lingering-sessions` (30 min), `refresh-churn` (3 per own head), `merge-stall` (10 min), `cycle-p90` (30 s), `untriaged-backlog` (24 h), `deploy-lease-loss` (0). `cycle-p90` judges a cycle's own work, net of child and control-plane waits. Thresholds: `invariants` in `.graphyard/master.json`; `tests/soak-*.test.ts` enforce.

## Research and diagnosis

`Recurring <class>` and `invariant:` faults past `invariantBoundMinutes` get a read-only diagnostician (`run.diagnostician`; none for human-only parks); quota refusals wait in `daemon.diagnoses` until `retryAt`; `stale`/`withdrawn` decisions, stale backlog releases: re-requested ≤3 times, then escalated (`decision-stale`); raced, delivered, [plane-wide](operations.md#incident-decision-tree) requests retry faultless; a refused fix `create` is `fix-item`, never re-filed; runs stopped at their bound: `overlong-session`; no `loop` fault for restart-lost diagnoses, approver refusals, nor `merge` for base conflicts under 30m.

## Machine-filed backlog

Review follow-ups are fixed in-PR, never filed; Pi (`run.research`, `triageConcurrency` 2) triages follow-up, fault items; closures need approval.

## Automatic dispatch at submit

Past the build gate (`autoDispatch`): a producer request per proof group (`unit`, `integration`; `manual` with `producerProofs`), then, once passed, a review request (before: `proofs-pending`). **The loop launches each request within 30 seconds**, starting the reviewer profile (`run.reviewerProfile`) and one producer session per proof group on a `master producer add FILE` profile ([template](../examples/master/claude-producer.json); `.graphyard/reviews.json`, `.graphyard/producers.json`). Reviewer launches await head's bot reviews (`run.awaitReviewers`) ≤`awaitReviewersMinutes` (8, 0 disables), skipping a bot under a usage-limit notice until it next reviews (`skipped: <bot> exhausted since <time>`, `dispatch.botReviewers`).

- **Concurrency is per role**: `concurrency` (1–20, default 1; above 1 each session takes a name unique to its request; `run.reviewerProfile` and producer profiles default to 4 sessions) applies without a restart; lowering it drains first (`longestWaitMs`); starved minutes: `counts.concurrencyStarved`.
- `pane_not_found` panes close. No request outlives its own token: one expired and unreported by Herdr settles `expired` (`dispatch.sessionReconcile.stuck` counts pending). Unanswered sessions relaunch (12 per request, then `dispatch.abandoned`); exhausted producer runs raise `escalation:proof-exhausted`, then quoting rework.
- **Every role fails over on spent quota** or waits as one uncounted `capacity` line.

The master never launches reviews or producers by hand, except `master review GY-N [PROFILE]` once relaunching stops.

### Proofs must exercise their criterion

A passing producer records `"exercise"`: rerun without the criterion's behaviour, proof must fail with a case executed, else the pass is recorded as not exercising its criterion rather than as passing (`unexercised`, `evidence.exercise.refused`); next: `request-rework` naming proof, criterion and surviving mutation. Unexercised `manual:` proofs re-attest instead.

## GitHub merges

GitHub merges heads whose gates pass under the `github` merger ([delivery](delivery.md#one-delivery-path)), the [merge writer](delivery-redesign.md#merge-writer) under `control-plane`; failing heads need two-party `master decide GY-N merge`; skew: `… deploy main first`; a check the base head fails too is a [base failure](development.md#base-failures). Unresolved review threads are the reviewer's inputs, not merge blockers (`reviewThreads`); approvals list each under `Resolved threads:`, `Follow-up threads:` or `Overridden threads:` ([rules](coordination.md#review-gate-verdicts-not-threads)).

**Shadow gate.** Named test failures fail the verdict; a runner exit naming none is a host failure (diagnostic, retries, one attention line), never `shadow-only-fail`. Groups of 40.
