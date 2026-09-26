<!-- page: Operate Graphyard | 5 | loop, dispatch, merges. -->
# Master-agent operating mode

The master (`coordinator`) routes, merges, verifies deployments, administers GitHub; never implements, reviews or proves.

## Autonomy: agents approve agents

The master acts without asking. Only three decisions are human-only: goals and priorities, spending money or opening third-party accounts, and issuing credentials to people. Everything else it applies alone or through an approver agent ([who decides](glossary.md#who-decides)); never ask a human to run what an agent may run.

## Operate

Keep cycling: status, dispatch, review, merge, deployment verification. Stop only when every in-scope item is Done or has a genuinely external blocker recorded in Graphyard, and every merged change is verified against the exact deployed release or has a recorded deployment blocker.

1. `master status` at startup and after events.
2. `master run` dispatches ready work in `schedule.order`.
3. Merge exact candidates passing every gate; route findings to rework.
4. `master verify-deployment GY-N` after delivery ([refusals](operations-reference.md#perpetual-master-loop)). Railway: `master config productionEnvironment='graphyard / production'`.
5. Close finished agent sessions; return to status.

Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions. `controlPlane.production` flags main ahead of production.

`master run` runs this loop under the `graphyard-master.service` unit ([supervision](onboarding.md#the-loop-must-be-supervised)); restart it (`systemctl --user restart graphyard-master`) when `daemon.liveness` is `stalled` or `absent`.

### System-driven items

Unless created `"systemDriven": false`, an item refuses hand `dispatch`, `merge`, `review` and `decide attest|merge`, except stopped-loop recovery, unproduced `manual:` attestations, and `decide merge` of unauthorized merges or with no operator agent. Hand `dispatch` waits out live or just-released ones.

Only unproduced `manual:` proofs left: the loop requests one attest decision and approver per proof and head; a new head withdraws it; no operator escalation (`loopDecisions.attestations`, not `needsHuman`).

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness; closing finished sessions is not the master's
manual duty.** A sweep runs on every automatic-dispatch tick (`run.dispatchIntervalSeconds`, default 10, 30 at most). A handle closes at the second consecutive sweep
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
that finished or died (loop stopped: `graphyard master run --once` sweeps); for an overlong one, attach to it with the command on the handle. Never mark
another session's handle finished to free a slot.

### System invariants

Each cycle (`daemon.invariants.lines`): `follow-ups-per-parent` (1 open), `lingering-sessions` (30 min), `refresh-churn` (3 per own head), `merge-stall` (10 min), `cycle-p90` (30 s), `untriaged-backlog` (24 h), `deploy-lease-loss` (0). Faults per class; thresholds: `invariants` in `.graphyard/master.json`; `tests/soak.test.ts` enforces.

## Research before build

With `run.research` set (`model`, `timeoutMinutes` 15, `tokenBudget`), a feature (or `"research": true`) gets one read-only Pi briefing per revision. Product questions: Needs you; build proceeds on the recommendation, a differing answer requests rework, failure never blocks.

## Automatic dispatch at submit

A candidate passing the build gate gets, in `autoDispatch`, one producer request per proof group (`unit`, `integration`, `manual` for `producerProofs`), then a review request once its unit and integration proofs pass (`proofs-pending` until then; failure returns it to its worker). `*-postmerge` proofs are refused. **The loop launches each request within 30 seconds**: every `dispatchIntervalSeconds` it starts the reviewer profile (`run.reviewerProfile`) and one producer session per proof group on a `master producer add FILE` profile ([template](../examples/master/claude-producer.json)), recorded in `.graphyard/reviews.json` and `.graphyard/producers.json`. A reviewer launch awaits the head's bot reviews (`run.awaitReviewers`) for `awaitReviewersMinutes` (default 8, 0 disables), skipping one that last posted a usage-limit notice until it next reviews (`skipped: <bot> exhausted since <time>`; `dispatch.botReviewers`).

**Concurrency is per role.** A profile's `concurrency` (1–20, default 1) caps its simultaneous sessions, each with a name unique to its request above one. It applies without a restart; lowering it drains sessions first; see `longestWaitMs`; a role starved ten minutes counts in `counts.concurrencyStarved`.

**Requests always settle.** A gone pane (`pane_not_found`) is closed. No request outlives its own token: expired, unreported by Herdr, it settles `expired`; one still pending counts in `dispatch.sessionReconcile.stuck`. Unanswered sessions relaunch elsewhere (12 per request, then `dispatch.abandoned`); an unposted reviewer is reminded first.

**Every role, approvers too, fails over on spent quota** or waits as one `capacity` line.

The master never launches reviews or producers by hand, except `master review GY-N [PROFILE]` once the loop stops relaunching it.

### Proofs must exercise their criterion

With a pass, the producer records `"exercise"`: the same proof run with the criterion's behaviour removed.

```json
"exercise":{"criterion":"AC-1","behaviour":"the lease expiry check in claim()","result":"fail","executed":4}
```

A pass is trusted only when that stripped run failed with a case executed; otherwise it is recorded as not exercising its criterion rather than as passing (`unexercised`, `evidence.exercise.refused`); the loop requests rework quoting it. `decide attest` adds `exercise` (fails on base), approver-confirmed; unexercised `manual:` proofs: re-attest, never rework.

## Guarded merges

`master merge GY-N|--all` asks [GitHub to merge](github.md#merge-queue) only under a current authorization for the exact head, base and policy. Protocol skew refuses (`server runs <sha>, CLI expects <sha>: deploy main first`).

### Repair lane

The sole exception to the no-admin-bypass rule: once a `"repair": "merge-path"` item (`mergePath` files only) stalls 15 minutes with checks passed and an approver agent's `master decide GY-N repair-merge REASON` naming the fault, the App's ruleset bypass merges its head, audited (`repair.merged`) and flagged until a normal merge.

Unresolved review threads are the reviewer's inputs, not merge blockers (`reviewThreads`); its approval names each on `Resolved threads:`, `Follow-up threads:` or `Overridden threads:` ([rules](coordination.md#review-gate-verdicts-not-threads)).
