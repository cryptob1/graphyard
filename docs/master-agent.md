<!-- page: Operate Graphyard | 5 | loop, dispatch, merges. -->
# Master-agent operating mode

The master (`coordinator`) routes, merges, verifies deployments and administers GitHub without asking; never implements, reviews or proves. Human-only: goals and priorities, spending money or opening third-party accounts, issuing credentials to people ([who decides](glossary.md#who-decides)).

## Operate

Cycle: `master status`; `master run` dispatches (`schedule.order`); merge gate-passing candidates; rework findings; deployment verification (`master verify-deployment GY-N`, [refusals](operations-reference.md#perpetual-master-loop); Railway: `productionEnvironment`). Close finished sessions. Stop only when every in-scope item is Done or has an external blocker recorded in Graphyard, and every merge is verified against deployed release or deployment-blocked. Review findings, rework, idle workers, and proof setup are not stopping conditions. `controlPlane.production` flags main ahead of production.

When `daemon.liveness` is `stalled` or `absent`, run `systemctl --user restart graphyard-master` (`graphyard-master.service`; [supervision](onboarding.md#the-loop-must-be-supervised)), never from a [dirty checkout](master-agent-sessions.md#the-coordinator-checkout-is-confined-at-the-os-level). The loop launches, wakes and rotates the [master session](master-agent-sessions.md#the-loops-own-master-session).

### System-driven items

Unless created `"systemDriven": false`, items refuse hand `dispatch`, `merge`, `review` and `decide attest|merge`, except stopped-loop recovery, unproduced `manual:` attestations, and `decide merge` when unauthorized or without an operator agent.

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness; closing sessions is not the master's manual duty.** A sweep runs every automatic-dispatch tick (`run.dispatchIntervalSeconds`, default 10, 30 at most). A handle closes at the second consecutive sweep
that misses it; an unobserved one is left alone for its first 3 minutes. A handle another host launched is left to
that host's loop. `dispatch.sessionReconcile` reports closures (`sessions.unseen`):

- **Vanished**: missed twice.
- **Ended**: agentless pane or terminal state; `idle`, `done` and
  `blocked` are deliberately not terminal.
- **Superseded**: a review or proof session for a head the item moved past; a delivered item is closed the same
  way as any other. Implementation sessions are left to the lease.
- **Duplicate**: the older of two for a role and head.

A closure decides no gate, ends no lease, and stops no process. Concurrency is counted against live sessions only; a name is busy only while a live session has it. A session past its role's maximum (4h implementation, 1h review, `run.producerTimeoutMinutes` for a producer, 12h coordination) raises attention, never closure.

**So what an operator or a master does instead of closing sessions by hand:** nothing, for a session
that finished or died (`graphyard master run --once` sweeps); for an overlong one, attach to it with the command on the handle. Never mark
another session's handle finished to free a slot.

### System invariants

Each cycle (`daemon.invariants.lines`): `follow-ups-per-parent` (1 open), `lingering-sessions` (30 min), `refresh-churn` (3 per own head), `merge-stall` (10 min), `cycle-p90` (30 s), `untriaged-backlog` (24 h), `deploy-lease-loss` (0). Faults per class; thresholds: `invariants` in `.graphyard/master.json`; `tests/soak.test.ts` enforces.

## Machine-filed backlog

With `run.research`, each feature (or `"research": true`) revision gets a read-only Pi brief that build follows; differing answers rework, failure never blocks, product questions go to a human.

[Follow-ups](followups.md) stay on the item until `graphyard promote-followup`. Pi also triages machine-filed items (`triageConcurrency`, default 2): release, approved close, or merge (`machineUntriaged`, `operatorBacklog`).

## Automatic dispatch at submit

Past the build gate, `autoDispatch` requests a producer per proof group (`unit`, `integration`; `manual` for `producerProofs`), then, once they pass, a review. **The loop launches each request within 30 seconds**: each `dispatchIntervalSeconds` starts `run.reviewerProfile` and one producer session per proof group on a `master producer add FILE` profile ([template](../examples/master/claude-producer.json); `.graphyard/reviews.json`, `.graphyard/producers.json`). Reviewers await bot reviews (`run.awaitReviewers`) up to `awaitReviewersMinutes` (default 8, 0 disables), skipping a bot with a usage-limit notice until it next reviews (`skipped: <bot> exhausted since <time>`; `dispatch.botReviewers`).

- **Concurrency is per role**: `concurrency` (1–20, default 1; above 1, each session takes a name unique to its request) applies without a restart, and lowering it drains first (`longestWaitMs`); ten starved minutes count in `counts.concurrencyStarved`. `run.reviewerProfile` defaults to 4 sessions, pending ones counted.
- **Requests always settle.** A `pane_not_found` pane is closed; a settled reviewer's open pane closes next tick (attention after 3 refused closes). No request outlives its own token: expired and unreported by Herdr it settles `expired`, else counts in `dispatch.sessionReconcile.stuck`. Unanswered sessions relaunch elsewhere (an unposted reviewer is reminded first), 12 per request (`dispatch.abandoned`). Killed producer runs spend no attempt; exhausted ones raise `escalation:proof-exhausted`, then rework.

The master never launches reviews or producers by hand (`master review GY-N [PROFILE]` only after the loop stops relaunching).

### Proofs must exercise their criterion

A passing producer records `"exercise"` (`criterion`, `behaviour`, `result`, `executed`): the proof rerun without the criterion's behaviour must fail with a case executed; otherwise the pass is recorded as not exercising its criterion rather than as passing (`unexercised`, `evidence.exercise.refused`) and reworked, naming the surviving mutation. Unexercised `manual:` proofs re-attest with an approver-confirmed `exercise` that fails on base. Attestations carry only on a kept patch-id.

## Guarded merges

`master merge GY-N|--all` asks [GitHub to merge](github.md#merge-queue) only when authorized for the exact current head, base and policy; protocol skew refuses (`… deploy main first`).

### Repair lane

The only admin-bypass merges (head-bound, App ruleset bypass):

- A `"repair": "merge-path"` item (`mergePath` files only) stalled 15 minutes, checks passed, on an approver's `master decide GY-N repair-merge REASON`; audited (`repair.merged`).
- The main guard's [revert](github.md#optimistic-merges) of a confirmed required-suite failure's culprit (`optimistic.revert.*`), reopening it as rework.

Unresolved review threads are the reviewer's inputs, not merge blockers (`reviewThreads`); approval lists each under `Resolved threads:`, `Follow-up threads:` or `Overridden threads:` ([rules](coordination.md#review-gate-verdicts-not-threads)).
