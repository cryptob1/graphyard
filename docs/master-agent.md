<!-- page: Operate Graphyard | 5 | loop, dispatch, merges. -->
# Master-agent operating mode

The master (`coordinator`) routes, merges, verifies deployments, administers GitHub; never implements, reviews or proves. Human-only ([who decides](glossary.md#who-decides)): goals and priorities, spending money or opening third-party accounts, issuing credentials to people. Agents approve everything else: the master applies it unasked, alone or via an approver agent.

## Operate

Keep cycling (status, dispatch, review, merge, deployment verification) until every in-scope item is Done or has a genuinely external blocker recorded in Graphyard, and every merge is verified against the exact deployed release or deployment-blocked. Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions.

1. `master status` on startup and events; `master run` dispatches ready work in `schedule.order`.
2. Merge exact candidates passing every gate; rework findings.
3. After delivery, `master verify-deployment GY-N` ([refusals](operations-reference.md#perpetual-master-loop); Railway: `productionEnvironment`); `controlPlane.production` flags main ahead of production.
4. Close finished agent sessions; repeat.

`graphyard-master.service` ([supervision](onboarding.md#the-loop-must-be-supervised)) runs `master run`, which launches, wakes and rotates the [master session](master-agent-sessions.md#the-loops-own-master-session). At `daemon.liveness` `stalled` or `absent`, `systemctl --user restart graphyard-master`, never from a dirty checkout.

### System-driven items

Unless created `"systemDriven": false`, an item refuses hand `dispatch`, `merge`, `review` and `decide attest|merge`, except stopped-loop recovery, unproduced `manual:` attestations, and `decide merge` of unauthorized merges or with no operator agent.

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness; closing sessions is not the master's manual duty.** On every automatic-dispatch tick (`run.dispatchIntervalSeconds`, default 10, 30 at most), a handle closes at the second consecutive sweep that misses it; an unobserved one is left alone for its first 3 minutes. A handle another host launched is left to that host's loop. `sessions.unseen` lists stale handles; `dispatch.sessionReconcile` reports closures: **Vanished**; **Ended** (agentless pane or terminal state; `idle`, `done` and `blocked` are deliberately not terminal); **Superseded** (review or proof session for a past head; a delivered item is closed the same way as any other; implementation sessions follow the lease); **Duplicate** (older of two per role and head). A closure decides no gate, ends no lease, and stops no process; concurrency is counted against live sessions only, a name busy only while a live session has it. Past its role's maximum (4h implementation, 1h review, `run.producerTimeoutMinutes` for a producer, 12h coordination) a session raises attention, never closure.

**So what an operator or a master does instead of closing sessions by hand:** nothing, for a session that finished or died (`graphyard master run --once` sweeps); for an overlong one, attach to it with the command on the handle. Never mark another session's handle finished to free a slot.

### System invariants

Each cycle (`daemon.invariants.lines`): `follow-ups-per-parent` (1 open), `lingering-sessions` (30 min), `refresh-churn` (3 per own head), `merge-stall` (10 min), `cycle-p90` (30 s), `untriaged-backlog` (24 h), `deploy-lease-loss` (0). Faults per class; thresholds: `invariants` in `.graphyard/master.json`; `tests/soak.test.ts` enforces.

## Machine-filed backlog

Approval follow-ups stay on the item ([follow-ups](followups.md)). With `run.research`, Pi triages machine-filed (legacy follow-up and fault) items, `triageConcurrency` (default 2) at once: release, merge, or close (approved); untriaged past 24h raises attention (status: `machineUntriaged`, `operatorBacklog`). It also briefs a feature (or `"research": true`) once per revision, read-only: build follows it, a differing answer reworks, failure never blocks, product questions need a human. `Recurring <class> faults` and `invariant:` faults past `invariantBoundMinutes` get a read-only diagnostician (`run.diagnostician`); an approved decision releases its fix or close-as-duplicate; recurrences re-file.

## Automatic dispatch at submit

In `autoDispatch`, a build-gate pass gets one producer request per proof group (`unit`, `integration`, `manual` for `producerProofs`), then a review request (`proofs-pending` until then). **The loop launches each request within 30 seconds** (each `dispatchIntervalSeconds`): reviewers on `run.reviewerProfile`, and one producer session per proof group on a `master producer add FILE` profile ([template](../examples/master/claude-producer.json); `.graphyard/reviews.json`, `.graphyard/producers.json`). Reviewers await the head's bot reviews (`run.awaitReviewers`) up to `awaitReviewersMinutes` (default 8, 0 disables), skipping a bot with a usage-limit notice until it next reviews (`skipped: <bot> exhausted since <time>`; `dispatch.botReviewers`).

**Concurrency is per role**: a profile's `concurrency` (1–20, default 1; above one, each session with a name unique to its request) applies without a restart, and lowering it drains first (`longestWaitMs`); a role starved ten minutes counts in `counts.concurrencyStarved`.

**Requests always settle.** Gone panes (`pane_not_found`) close. No request outlives its own token: expired and unreported by Herdr, it settles `expired`; still pending, it counts in `dispatch.sessionReconcile.stuck`. Unanswered sessions relaunch elsewhere (12 per request, then `dispatch.abandoned`), unposted reviewers reminded first. Killed or vanished producer runs spend no attempt; spent ones raise `escalation:proof-exhausted`, then a quoting rework. **Every role fails over on spent quota** or waits as one uncounted `capacity` line, relaunching oldest-first. The master never launches reviews or producers by hand, except `master review GY-N [PROFILE]` once the loop stops relaunching.

### Proofs must exercise their criterion

A passing producer records `"exercise"` (`criterion`, `behaviour`, `result`, `executed`): the proof rerun without the criterion's behaviour, trusted only if it failed with a case executed. Otherwise the pass is recorded as not exercising its criterion rather than as passing (`unexercised`, `evidence.exercise.refused`); once a unit or integration group has only such findings left, the next action is a `request-rework` quoting proof, criterion and surviving mutation (`master status`: awaiting rework). `decide attest` adds an approver-confirmed `exercise` (fails on base); unexercised `manual:` proofs re-attest, never rework. Attestations carry only on a kept patch-id.

## Guarded merges

`master merge GY-N|--all` asks [GitHub to merge](github.md#merge-queue) only under a current authorization for the exact head, base and policy. Protocol skew refuses (`… deploy main first`). Unresolved review threads are the reviewer's inputs, not merge blockers (`reviewThreads`); approvals sort each under `Resolved threads:`, `Follow-up threads:` or `Overridden threads:` ([rules](coordination.md#review-gate-verdicts-not-threads)).

### Repair lane

Two exceptions to no-admin-bypass use the App's ruleset bypass. A `"repair": "merge-path"` item (`mergePath` files only) stalled 15 minutes with passing checks merges on an approver's `master decide GY-N repair-merge REASON` naming the fault; audited (`repair.merged`), flagged until a normal merge. The main guard's [revert](github.md#optimistic-merges) of a confirmed required-suite failure's culprit, head-bound on the base tip, is refused if a later merge touched the culprit's files, recorded `optimistic.revert.*`, the item reopened as rework.
