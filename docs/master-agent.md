<!-- page: Operate Graphyard | 5 | loop, dispatch, merges. -->
# Master-agent operating mode

The master (`coordinator`) routes and administers GitHub unasked, never implementing, reviewing or proving. Human-only ([who decides](glossary.md#who-decides)): goals and priorities, spending money or opening third-party accounts, issuing credentials to people; it does the rest itself or via an approver agent.

## Operate

Keep cycling: `master status`; `master run` dispatches (`schedule.order`); merge gate-passing candidates; rework findings; deployment verification (`master verify-deployment GY-N`, [refusals](operations-reference.md#perpetual-master-loop)); Close finished agent sessions. Stop only when every in-scope item is Done or has a genuinely external blocker recorded in Graphyard, and every merge is verified against the exact deployed release or deployment-blocked. Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions. `controlPlane.production` flags main ahead of production.

`master run` is the `graphyard-master.service` unit ([supervision](onboarding.md#the-loop-must-be-supervised)); `daemon.liveness` `stalled`/`absent` → `systemctl --user restart graphyard-master`, never from a [dirty or moved checkout](master-agent-sessions.md#the-coordinator-checkout-is-confined-at-the-os-level), which raises [`escalation:dirty-checkout`](operations.md#resources-and-disk). The loop launches, wakes and rotates the [master session](master-agent-sessions.md#the-loops-own-master-session). Railway: set `productionEnvironment`.

### System-driven items

Unless `"systemDriven": false`, items refuse hand `dispatch`, `merge`, `review`, `decide attest|merge`, except stopped-loop recovery, unproduced `manual:` attestations, and `decide merge` unauthorized or without an operator agent.

The loop attests unproduced `manual:` proofs via an independent approver once per head, base and policy revision (`loopDecisions.attestations`).

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness; closing sessions is not the master's manual duty.** Sweeps run every automatic-dispatch tick (`run.dispatchIntervalSeconds`, default 10, 30 at most). A handle closes at the second consecutive sweep
that misses it; an unobserved one is left alone for its first 3 minutes; a paneless worker handle reads `launching` while its attempt's lease stands (renewed by the launch until its supervisor's first heartbeat). A handle another host launched is left to
that host's loop. `dispatch.sessionReconcile` reports each closure:

- **Vanished**: absent from two consecutive listings.
- **Ended**: agentless pane or terminal state. `idle`, `done` and
  `blocked` are deliberately not terminal.
- **Superseded**: a review or proof session for a head the item moved past; a delivered item is closed the same
  way as any other. Implementation sessions are left to the lease.
- **Duplicate**: the older of two sessions for one role and head.

A closure decides no gate, ends no lease, and stops no process. Concurrency is counted against live sessions only; a name is busy only while a live session has it. A session past its role's maximum (4h implementation, 1h review, `run.producerTimeoutMinutes` for a producer, 12h coordination) raises attention, never closure.

**So what an operator or a master does instead of closing sessions by hand:** nothing, for a session
that finished or died (`graphyard master run --once` sweeps); for an overlong one, attach to it with the command on the handle. Never mark
another session's handle finished to free a slot.

`blocked` frees the slot; [classes](protocol/leases.md#blocked-work-unblocks-itself) `github-credential`, `control-plane-error`, `sandbox-path`, `worktree-mismatch`, `outside-scope-test-failure`, `planned-file-scope`, `needs-decision` self-clear; `genuine`/`human-only` escalate.

### System invariants

Each cycle (`daemon.invariants.lines`): `follow-ups-per-parent` (1 open), `lingering-sessions` (30 min), `refresh-churn` (3 per own head), `merge-stall` (10 min), `cycle-p90` (30 s), `untriaged-backlog` (24 h), `deploy-lease-loss` (0). Thresholds: `invariants` in `.graphyard/master.json`, enforced by `tests/soak.test.ts`.

### The pipeline doctor

The loop's [doctor](onboarding.md#the-pipeline-doctor-on-by-default) uses sanctioned commands only.

## Research and diagnosis

`Recurring <class> faults` and `invariant:` faults past `invariantBoundMinutes` get a read-only diagnostician (`run.diagnostician`); a provider quota refusal reads `waiting` in `daemon.diagnoses` until `retryAt`, then probes once. Branch restores, base conflicts under 30m and restart-resumed merges are not `merge` faults.

## Machine-filed backlog

Review follow-ups are never filed; worth-fixing findings are fixed on the same pull request. Pi (`run.research`, `triageConcurrency` 2) triages follow-up and fault items; closure needs approval.

## Automatic dispatch at submit

Past the build gate (`autoDispatch`): one producer request per proof group (`unit`, `integration`; `manual` with `producerProofs`), then, once passing, a review request (`proofs-pending` until then). **The loop launches each request within 30 seconds**: every `dispatchIntervalSeconds` it starts the reviewer profile (`run.reviewerProfile`) and one producer session per proof group on a `master producer add FILE` profile ([template](../examples/master/claude-producer.json); `.graphyard/reviews.json`, `.graphyard/producers.json`). Reviewer launches await the head's bot reviews (`run.awaitReviewers`) up to `awaitReviewersMinutes` (default 8; 0 disables), skipping a bot that posted a usage-limit notice until it next reviews (`skipped: <bot> exhausted since <time>`; `dispatch.botReviewers`).

- **Concurrency is per role**: `concurrency` (1–20, default 1; above 1, each session takes a name unique to its request) applies without a restart (`run.reviewerProfile` and producer profiles default to 4 sessions); lowering it drains first (`longestWaitMs`); starved minutes count in `counts.concurrencyStarved`.
- Requests always settle: `pane_not_found` panes close. No request outlives its own token: expired, unreported by Herdr, it settles `expired` (`dispatch.sessionReconcile.stuck` counts pending ones). Unanswered sessions relaunch (12 per request, then `dispatch.abandoned`); exhausted producer runs raise `escalation:proof-exhausted`, then a rework quoting it.
- **Every role fails over on spent quota** or waits as one uncounted `capacity` line.

The master never launches reviews or producers by hand, except `master review GY-N [PROFILE]` once relaunching stops.

### Proofs must exercise their criterion

A passing producer records `"exercise"`: rerun without the criterion's behaviour, the proof must fail with a case executed, else the pass is recorded as not exercising its criterion rather than as passing (`unexercised`, `evidence.exercise.refused`); next action `request-rework` naming proof, criterion and surviving mutation. Unexercised `manual:` proofs re-attest, never rework.

## Guarded merges

`master merge GY-N|--all` asks [GitHub to merge](github.md#merge-queue) only when authorized now for exact head, base and policy; protocol skew refuses (`… deploy main first`).

A required check the base head also fails is a [base failure](development.md#base-failures), not rework. Unresolved review threads are the reviewer's inputs, not merge blockers (`reviewThreads`); approvals list each under `Resolved threads:`, `Follow-up threads:` or `Overridden threads:` ([rules](coordination.md#review-gate-verdicts-not-threads)).
