<!-- page: Operate Graphyard | 5 | loop, dispatch, merges. -->
# Master-agent operating mode

The master (`coordinator`) routes, merges, verifies deployments and administers GitHub without asking; it never implements, reviews or proves. Human-only: goals and priorities, spending money or opening third-party accounts, issuing credentials to people ([who decides](glossary.md#who-decides)); it does the rest itself or via an approver.

## Operate

Keep cycling: `master status`; `master run` dispatches (`schedule.order`); merge candidates passing every gate; rework findings; deployment verification (`master verify-deployment GY-N`, [refusals](operations-reference.md#perpetual-master-loop); Railway: `productionEnvironment`). Close finished agent sessions. Stop only when every in-scope item is Done or has a genuinely external blocker recorded in Graphyard, and every merge is verified against the exact deployed release or deployment-blocked. Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions. `controlPlane.production` flags main ahead of production.

When `daemon.liveness` is `stalled` or `absent`, restart `graphyard-master.service` ([supervision](onboarding.md#the-loop-must-be-supervised)): `systemctl --user restart graphyard-master`, never from a [dirty checkout](master-agent-sessions.md#the-coordinator-checkout-is-confined-at-the-os-level).

### System-driven items

Unless created `"systemDriven": false`, an item refuses hand `dispatch`, `merge`, `review` and `decide attest|merge`, except stopped-loop recovery, unproduced `manual:` attestations, and `decide merge` when unauthorized or without an operator agent.

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness; closing sessions is not the master's manual duty.** A sweep runs every automatic-dispatch tick (`run.dispatchIntervalSeconds`, default 10, 30 at most). A handle closes at the second consecutive sweep
that misses it; an unobserved one is left alone for its first 3 minutes. A handle another host launched is left to
that host's loop. `dispatch.sessionReconcile` reports closures (`sessions.unseen`: stale handles):

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

With `run.research`, a feature (or `"research": true`) gets one read-only Pi brief per revision, which build follows; a differing answer reworks, failure never blocks, product questions go to a human.

[Follow-ups](followups.md) stay on the item until `graphyard promote-followup`. With `run.research`, Pi triages machine-filed items (legacy follow-ups, faults), `triageConcurrency` (default 2) at once: release, approved close, or merge (`machineUntriaged`, `operatorBacklog`).

## Automatic dispatch at submit

Past the build gate a candidate gets (`autoDispatch`) a producer request per proof group (`unit`, `integration`; `manual` for `producerProofs`), then a review request once they pass. **The loop launches each request within 30 seconds**: every `dispatchIntervalSeconds` it starts the reviewer profile (`run.reviewerProfile`) and one producer session per proof group on a `master producer add FILE` profile ([template](../examples/master/claude-producer.json); `.graphyard/reviews.json`, `.graphyard/producers.json`). A reviewer launch awaits the head's bot reviews (`run.awaitReviewers`) up to `awaitReviewersMinutes` (default 8, 0 disables), skipping a bot that posted a usage-limit notice until it next reviews (`skipped: <bot> exhausted since <time>`; `dispatch.botReviewers`).

- **Concurrency is per role**: `concurrency` (1–20, default 1; above 1, each session takes a name unique to its request) applies without a restart; lowering it drains first (`longestWaitMs`); ten starved minutes count in `counts.concurrencyStarved`.
- **Requests always settle.** A `pane_not_found` pane is closed. No request outlives its own token: expired and unreported by Herdr, it settles `expired`, else counts in `dispatch.sessionReconcile.stuck`. Unanswered sessions relaunch elsewhere, 12 per request (`dispatch.abandoned`); an unposted reviewer is reminded first. Killed producer runs spend no attempt; exhausted ones raise `escalation:proof-exhausted`, then rework.

The master never launches reviews or producers by hand (`master review GY-N [PROFILE]` only after the loop stops relaunching).

### Proofs must exercise their criterion

A passing producer records `"exercise"` (`criterion`, `behaviour`, `result`, `executed`): the proof rerun without the criterion's behaviour, which must fail with a case executed; otherwise the pass is recorded as not exercising its criterion rather than as passing (`unexercised`, `evidence.exercise.refused`) and reworked, naming the surviving mutation. Unexercised `manual:` proofs re-attest with an approver-confirmed `exercise` that fails on base. Attestations carry only on a kept patch-id.

## Guarded merges

`master merge GY-N|--all` asks [GitHub to merge](github.md#merge-queue) only under a current authorization for the exact head, base and policy; protocol skew refuses (`… deploy main first`).

### Repair lane

The only admin-bypass merges (head-bound, via the App's ruleset bypass):

- A `"repair": "merge-path"` item (`mergePath` files only) stalled 15 minutes with checks passed, on an approver's `master decide GY-N repair-merge REASON` naming the fault; audited (`repair.merged`), flagged until a normal merge.
- The main guard's [revert](github.md#optimistic-merges) of a confirmed required-suite failure's culprit, unless a later merge touched its files (`optimistic.revert.*`), reopening the item as rework.

Unresolved review threads are the reviewer's inputs, not merge blockers (`reviewThreads`); its approval lists each under `Resolved threads:`, `Follow-up threads:` or `Overridden threads:` ([rules](coordination.md#review-gate-verdicts-not-threads)).
