<!-- page: Operate Graphyard | 5 | loop, dispatch, merges. -->
# Master-agent operating mode

The master (`coordinator`) routes, merges, verifies deployments, administers GitHub; never implements, reviews or proves.

## Agents approve agents

The master acts without asking. Three decisions are human-only: goals and priorities, spending money or opening third-party accounts, issuing credentials to people ([who decides](glossary.md#who-decides)); everything else it applies alone or through an approver agent and never asks humans to run what agents may run.

## Operate

Keep cycling: status, dispatch, review, merge, deployment verification. Stop only when every in-scope item is Done or has a genuinely external blocker recorded in Graphyard, and every merge is verified against the exact deployed release or deployment-blocked.

1. `master status` on startup and events.
2. `master run` dispatches ready work in `schedule.order`.
3. Merge exact candidates passing every gate; rework findings.
4. `master verify-deployment GY-N` after delivery ([refusals](operations-reference.md#perpetual-master-loop)). Railway: set `productionEnvironment`.
5. Close finished agent sessions; repeat.

Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions. `controlPlane.production` flags main ahead of production.

`master run` is the `graphyard-master.service` unit ([supervision](onboarding.md#the-loop-must-be-supervised)); restart it (`systemctl --user restart graphyard-master`) when `daemon.liveness` is `stalled` or `absent`, never from a dirty checkout (GY-857; [sessions](master-agent-sessions.md#the-coordinator-checkout-is-confined-at-the-os-level)).

The loop launches, wakes and rotates the [master session](master-agent-sessions.md#the-loops-own-master-session).

### System-driven items

Unless created `"systemDriven": false`, an item refuses hand `dispatch`, `merge`, `review` and `decide attest|merge`, except stopped-loop recovery, unproduced `manual:` attestations, and `decide merge` of unauthorized merges or with no operator agent.

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness; closing sessions is not the master's manual duty.** A sweep runs every automatic-dispatch tick (`run.dispatchIntervalSeconds`, default 10, 30 at most). A handle closes at the second consecutive sweep
that misses it; an unobserved one is left alone for its first 3 minutes. A handle another host launched is left to
that host's loop. `sessions.unseen` lists stale handles. `dispatch.sessionReconcile` reports each closure:

- **Vanished**: missing from two consecutive listings.
- **Ended**: agentless pane or terminal state. `idle`, `done` and
  `blocked` are deliberately not terminal.
- **Superseded**: a review or proof session for a head the item moved past; a delivered item is closed the same
  way as any other. Implementation sessions are left to the lease.
- **Duplicate**: the older of two sessions for one role and head.

A closure decides no gate, ends no lease, and stops no process. A profile's concurrency is counted against live sessions only, and a name is busy only while a live session has it. A session past its role's maximum (4h implementation, 1h review, `run.producerTimeoutMinutes` for a producer, 12h coordination) raises attention, is never closed.

**So what an operator or a master does instead of closing sessions by hand:** nothing, for a session
that finished or died (`graphyard master run --once` sweeps); for an overlong one, attach to it with the command on the handle. Never mark
another session's handle finished to free a slot.

### System invariants

Each cycle (`daemon.invariants.lines`): `follow-ups-per-parent` (1 open), `lingering-sessions` (30 min), `refresh-churn` (3 per own head), `merge-stall` (10 min), `cycle-p90` (30 s), `untriaged-backlog` (24 h), `deploy-lease-loss` (0). Faults per class; thresholds: `invariants` in `.graphyard/master.json`; `tests/soak.test.ts` enforces.

### The pipeline doctor

Every `run.doctor.intervalMinutes` (default 10) the loop launches the [doctor](onboarding.md#the-pipeline-doctor-on-by-default) for stuck work: sanctioned commands only (`scope`, `requirements`, `unblock`, `decide`+`approver`, `settle-containment`, `close`, `create`, `release`), never merge, dispatch, evidence or leases. Off: `run.doctor.enabled=false`.

## Research and diagnosis

With `run.research` set, features (or `"research": true`) get one read-only Pi briefing per revision. Build follows recommendations, differing answers rework, failure never blocks; product questions need humans.

`Recurring <class> faults` and `invariant:` faults past `invariantBoundMinutes` get a read-only diagnostician (`run.diagnostician`); approved decisions release fixes or close duplicates; recurrences re-file. Branch restores owed under 30 minutes and restart-resumed merges are self-handled, not `merge` faults.

## Machine-filed backlog

Follow-up findings wait on their item (`pendingFollowUps`) until it ships, then form or join its follow-up item; closing unshipped drops them ([follow-ups](followups.md)). Triage skips unshipped parents. With `run.research`, Pi triages follow-up and fault items (release, close, merge; closure needs approval), `triageConcurrency` (default 2) at once; untriaged past 24h raises attention; status counts `machineUntriaged`/`operatorBacklog`.

## Automatic dispatch at submit

A candidate passing the build gate gets, in `autoDispatch`, one producer request per proof group (`unit`, `integration`, `manual` for `producerProofs`), then a review request once those pass (`proofs-pending` until then). **The loop launches each request within 30 seconds**: every `dispatchIntervalSeconds` it starts the reviewer profile (`run.reviewerProfile`) and one producer session per proof group on a `master producer add FILE` profile ([template](../examples/master/claude-producer.json); `.graphyard/reviews.json`, `.graphyard/producers.json`). Reviewer launches await bot reviews (`run.awaitReviewers`) for `awaitReviewersMinutes` (default 8, 0 disables), skipping bots with usage-limit notices until they review again (`skipped: <bot> exhausted since <time>`; `dispatch.botReviewers`).

**Concurrency is per role.** A profile's `concurrency` (1–20, default 1) caps simultaneous sessions, each with a name unique to its request above one. `run.reviewerProfile`'s profile defaults to 4 sessions; pending sessions count before Herdr shows them. It applies without a restart; lowering it drains sessions first (`longestWaitMs`); a role starved ten minutes counts in `counts.concurrencyStarved`.

**Requests always settle.** A gone pane (`pane_not_found`) is closed. A settled reviewer's pane closes next dispatch tick; after 3 refused closes, attention names the pane. No request outlives its own token: expired, unreported by Herdr, it settles `expired`; one still pending counts in `dispatch.sessionReconcile.stuck`. Unanswered sessions relaunch elsewhere (12 per request, then `dispatch.abandoned`); unposted reviewers are reminded first. Killed or vanished producer runs spend no attempt; spent ones raise `escalation:proof-exhausted`, then quoting rework.

**Every role fails over on spent quota** or waits as one `capacity` line, uncounted, relaunching oldest-first.

The master never launches reviews or producers by hand, except `master review GY-N [PROFILE]` once the loop stops relaunching.

### Proofs must exercise their criterion

A passing producer records `"exercise"`: the proof rerun with the criterion's behaviour removed.

```json
"exercise":{"criterion":"AC-1","behaviour":"the lease expiry check in claim()","result":"fail","executed":4}
```

A pass is trusted only when that stripped run failed with a case executed; otherwise it is recorded as not exercising its criterion rather than as passing (`unexercised`, `evidence.exercise.refused`); the loop requests rework quoting it, for automated proofs. When every proof a unit or integration group has left is such a finding, the next action is `request-rework`, naming proof, criterion and surviving mutation, shown in `master status` as awaiting rework. `decide attest` adds `exercise` (fails on base), approver-confirmed; unexercised `manual:` proofs re-attest, never rework. Attestations carry only on a kept patch-id.

## Guarded merges

`master merge GY-N|--all` asks [GitHub to merge](github.md#merge-queue) only under a current authorization for the exact head, base and policy. Protocol skew refuses (`… deploy main first`).

### Repair lane

The first no-admin-bypass exception: a `"repair": "merge-path"` item (`mergePath` files only) stalled 15 minutes, checks passed, given an approver's `master decide GY-N repair-merge REASON` naming the fault, merges through the App's ruleset bypass, audited (`repair.merged`), flagged until a normal merge.

The main guard's revert ([optimistic merges](github.md#optimistic-merges)) is the second: confirmed required-suite failures on main traced to culprits land reverts on the base tip — refused if later merges touched the culprit's files — head-bound through the bypass, recorded `optimistic.revert.*`, reopening items as rework.

Unresolved review threads are the reviewer's inputs, not merge blockers (`reviewThreads`); its approval names each on `Resolved threads:`, `Follow-up threads:` or `Overridden threads:` ([rules](coordination.md#review-gate-verdicts-not-threads)).
