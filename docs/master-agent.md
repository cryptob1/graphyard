<!-- page: Operate Graphyard | 5 | loop, dispatch, merges -->
# Master-agent operating mode

The master (`coordinator`) routes, merges, verifies deployments, administers GitHub; never implements, reviews or proves.

## Agents approve agents

The master acts without asking. Three decisions are human-only: goals and priorities, spending money or opening third-party accounts, and issuing credentials to people; everything else it applies alone or through an approver agent; never ask a human to run what an agent may run.

## Operate

Keep cycling: status, dispatch, review, merge, deployment verification. Stop only when every in-scope item is Done or has a genuinely external blocker recorded in Graphyard, and every merge verified against the exact deployed release or deployment-blocked.

1. `master status`.
2. `master run` dispatches ready work in `schedule.order`.
3. Merge exact candidates passing every gate; rework findings.
4. `master verify-deployment GY-N` after delivery.
5. Close finished agent sessions; repeat.

Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions. `controlPlane.production` flags main ahead of production.

`master run` is the `graphyard-master.service` unit; restart it (`systemctl --user restart graphyard-master`) when `daemon.liveness` is `stalled` or `absent`, never from a dirty checkout.

### System-driven items

Unless created `"systemDriven": false`, an item refuses hand `dispatch`, `merge`, `review` and `decide attest|merge`, except stopped-loop recovery, unproduced `manual:` attestations, and `decide merge` of unauthorized merges or no operator agent.

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness; closing sessions is not the master's manual duty.** Sweeps run every automatic-dispatch tick (`run.dispatchIntervalSeconds`, 30 at most); a handle closes at the second consecutive sweep
that misses it; an unobserved one is left alone for its first 3 minutes. A handle another host launched is left to
that host's loop. `sessions.unseen` lists stale handles; `dispatch.sessionReconcile` reports each closure:

- **Vanished**: two consecutive missed listings.
- **Ended**: agentless pane; `idle`, `done` and
  `blocked` are deliberately not terminal.
- **Superseded**: a review or proof session the item moved past; a delivered item is closed the same
  way as any other. Implementation sessions are left to the lease.
- **Duplicate**: the older of two same-role same-head sessions.

A closure decides no gate, ends no lease, and stops no process. A profile's concurrency is counted against live sessions only, and a name is busy only while a live session has it. Past its role's maximum (4h implementation, 1h review, `run.producerTimeoutMinutes` for a producer, 12h coordination) raises attention, never closed.

**So what an operator or a master does instead of closing sessions by hand:** nothing, for a session
that finished or died (`graphyard master run --once`); for an overlong one, attach to it with the command on the handle. Never mark
another session's handle finished to free a slot.

### System invariants

Each cycle (`daemon.invariants.lines`): `follow-ups-per-parent` (1 open), `lingering-sessions` (30 min), `refresh-churn` (3 per own head), `merge-stall` (10 min), `cycle-p90` (30 s), `untriaged-backlog` (24 h), `deploy-lease-loss` (0). Thresholds: `invariants` in `.graphyard/master.json`; `tests/soak.test.ts` enforces.

## Research and diagnosis

With `run.research` (`model`, `timeoutMinutes` 15, `tokenBudget`), a feature gets one read-only Pi briefing per revision. Product questions: Needs you; build follows the recommendation, a differing answer reworks, failure never blocks.

`Recurring <class> faults` items and `invariant:` faults past `invariantBoundMinutes` get a read-only diagnostician (`run.diagnostician`: `model`/`fallbackModel`/`serverLogCommand`/registry role); approved decisions release its fix or close-as-duplicate; recurrences re-file.

## Machine-filed backlog

One follow-up per parent; approvals append findings. With `run.research`, Pi triages machine-filed items (release, close, merge; closure approved), `triageConcurrency` (default 2); untriaged past 24h raises attention, counted as `machineUntriaged`/`operatorBacklog`.

## Automatic dispatch at submit

A build-gate pass gets, in `autoDispatch`, one producer request per proof group (`unit`/`integration`/`manual` for `producerProofs`), then a review request once its mechanical proofs pass (`proofs-pending`; failure means rework). **The loop launches each request within 30 seconds**: every `dispatchIntervalSeconds` it starts the reviewer profile (`run.reviewerProfile`) and one producer session per proof group on a `master producer add FILE` profile ([template](../examples/master/claude-producer.json)), (`.graphyard/producers.json`). A reviewer launch awaits the head's bot reviews (`run.awaitReviewers`) for `awaitReviewersMinutes` (0 disables), skipping one that last posted a usage-limit notice until it next reviews (`skipped: <bot> exhausted since <time>`; `dispatch.botReviewers`).

**Concurrency is per role.** A profile's `concurrency` (1–20, default 1) caps its simultaneous sessions, each with a name unique to its request. Applies without a restart; lowering it drains sessions first (`longestWaitMs`); a role starved ten minutes counts in `counts.concurrencyStarved`.

**Requests always settle.** A gone pane (`pane_not_found`) is closed. No request outlives its own token: an expired, Herdr-unreported one settles `expired`; a still-pending one counts in `dispatch.sessionReconcile.stuck`. Unanswered sessions relaunch (12 per request, then `dispatch.abandoned`); an unposted reviewer is reminded first. Killed or vanished producer runs spend no attempt; spent ones raise `escalation:proof-exhausted`, then a quoting rework.

**Every role fails over on spent quota** or waits as one `capacity` line, uncounted.

The master never launches reviews or producers by hand, except `master review GY-N [PROFILE]` once the loop stops relaunching.

### Proofs must exercise their criterion

A passing producer records `"exercise"`: the proof rerun with the criterion's behaviour removed.

A pass is trusted only when that stripped run failed with a case executed; otherwise it is recorded as not exercising its criterion rather than as passing (`unexercised`, `evidence.exercise.refused`); the loop requests rework quoting it, for automated proofs. When every proof a unit or integration group has left is such a finding, the next action is `request-rework`, naming proof, criterion and surviving mutation, and `master status` names it as awaiting that rework, not as an unanswered producer request. `decide attest` adds `exercise` (fails on base), approver-confirmed; unexercised `manual:` proofs: re-attest, never rework. Attestations carry only on a kept patch-id.

### The prereview-proof claim (GY-136)

`node scripts/measure-pipeline-speed.mjs --claim GY-115 --record .graphyard/measurements/rework-claim`: deliveries merged after GY-115's merge commit (deployment observation, else merge instant, basis named; GY-115 excluded) give the median of `speed.reworkRounds` against the fixed pre-merge median 2; a miss is the finding (exit 2), an undelivered claim `not judged`, a missing cause classification exits 1; `rework` events classify by binding (`:proof:`/`:ci:` mechanical, `:threads:`/`:verdict:` review, conflict/sync integration, else reason templates), the mechanical share reported for both.

## Guarded merges

`master merge GY-N|--all` merges through GitHub [merge queue](github.md#merge-queue) only under a current authorization for the exact head, base and policy. Protocol skew refuses (`… deploy main first`).

### Repair lane

Two no-admin-bypass exceptions exist. First, a `"repair": "merge-path"` item (`mergePath` files only) stalled 15 minutes, checks passed, given an approver's `master decide GY-N repair-merge REASON` naming the fault, merges through the App's ruleset bypass, audited (`repair.merged`), flagged until a normal merge.

The main guard's revert ([optimistic merges](github.md#optimistic-merges)) is the second: a confirmed required-suite failure on main traced to the culprit lands a base-tip revert (refused when a later merge touched the culprit's files), head-bound through the same bypass, recorded `optimistic.revert.*` not `repair.merged`, the item reopened as rework.

Unresolved review threads are the reviewer's inputs, not merge blockers (`reviewThreads`); its approval names each on `Resolved threads:`, `Follow-up threads:` or `Overridden threads:` ([rules](coordination.md#review-gate-verdicts-not-threads)).
