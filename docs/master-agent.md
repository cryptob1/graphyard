<!-- page: Operate Graphyard | 5 | the loop, dispatch and merges. -->
# Master-agent operating mode

The master (`coordinator`) routes work, merges, verifies deployments and administers GitHub; it never implements, reviews or proves.

## Autonomy: agents approve agents

Only three decisions are human-only: goals and priorities, spending money or opening third-party accounts, and issuing credentials to people. Everything else it applies alone or through an approver agent ([who decides](glossary.md#who-decides)); never ask a human to run a command an agent identity may run.

## Operate

Keep cycling: status, dispatch, review, merge, deployment verification. Stop only when every in-scope item is Done or has a genuinely external blocker recorded in Graphyard, and every merged change is verified against the exact deployed release or has a recorded deployment blocker.

1. `master status`.
2. `master run` dispatches ready work in `schedule.order`.
3. Route findings to rework.
4. Merge only exact candidates passing every gate.
5. `master verify-deployment GY-N` after delivery ([refusals](operations-reference.md#perpetual-master-loop)). Railway: `master config productionEnvironment='graphyard / production'`.
6. Close finished agent sessions.

Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions. `controlPlane.production` flags main ahead of production.

`master run` runs this loop under the `graphyard-master.service` unit ([supervision](onboarding.md#the-loop-must-be-supervised)); restart it with `systemctl --user restart graphyard-master` when `daemon.liveness` is `stalled` or `absent`.

### System-driven items

Unless created `"systemDriven": false`, an item refuses hand `dispatch`, `merge`, `review` and `decide attest|merge`, naming the loop step, except stopped-loop recovery, unproduced `manual:` attestations, and `decide merge` of unauthorized merges or with no operator agent. Hand `dispatch` waits out live or just-released ones.

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness, not the master.** A sweep runs every automatic-dispatch tick (`run.dispatchIntervalSeconds`, default 10, at most 30). A handle closes at the second consecutive sweep
that misses it; an unobserved one is left 3 minutes, another host's to that host's loop. `master status` lists stale handles as `sessions.unseen`. `dispatch.sessionReconcile` reports each closure:

- **Vanished**: missing from two consecutive listings.
- **Ended**: agentless pane, or terminal state (`idle`, `done` and `blocked` are not).
- **Superseded**: a review or proof session for a head the item moved past; implementation sessions are left to the lease.
- **Duplicate**: the older of two sessions for one role and head.

A closure decides no gate, ends no lease, and stops no process. Concurrency counts live sessions only, and a name is busy only while a live session has it. A session past its role's maximum (4h implementation, 1h review, `run.producerTimeoutMinutes` for a producer, 12h coordination) raises attention and is never closed.

Close nothing by hand (a stopped loop sweeps with `graphyard master run --once`); attach to an overlong session with its handle's command. Never mark
another session's handle finished to free a slot.

### System invariants

Checked every cycle; each violation is one fault of its class (`daemon.invariants.lines` in `master status`; thresholds: `invariants` in `.graphyard/master.json`): at most one open follow-up per parent; no session open 30 min past delivery or settled decision; at most 3 base refreshes without an own head change; no merge-stage item mergeable 10 min unrefused; cycle p90 under 30 s over an hour; no machine-filed backlog untriaged 24 h; no lease lost to a deploy. `tests/soak.test.ts` holds them all in CI.

## Research before build

With `run.research` set (`model`, `timeoutMinutes` 15, `tokenBudget`), a feature (or `"research": true`) gets one read-only Pi briefing per requirements revision. Product questions go under Needs you; build proceeds on the recommendation, a differing answer requests rework, failure never blocks.

## Automatic dispatch at submit

When a candidate passes the build gate, `autoDispatch` records one producer request per proof group (`unit`, `integration`, and `manual` for `producerProofs`). The review request follows once the head's unit and integration proofs pass (`proofs-pending` until then; a failure returns it to its worker). `*-postmerge` proofs are refused (use `policy.deploySmoke`). **The loop launches each request within 30 seconds**: every `dispatchIntervalSeconds` it starts the reviewer profile (`run.reviewerProfile`) and one producer session per proof group on a `master producer add FILE` profile ([template](../examples/master/claude-producer.json)), recorded in `.graphyard/reviews.json` and `.graphyard/producers.json`. A reviewer launch first awaits the head's bot reviews (`run.awaitReviewers`) for `awaitReviewersMinutes` (default 8, 0 disables), skipping one that last posted a usage-limit notice until it next reviews (`skipped: <bot> exhausted since <time>`; `dispatch.botReviewers`).

**Concurrency is per role.** A profile's `concurrency` (1–20, default 1) is how many sessions it runs at once, each with a name unique to its request above one. Changes apply without a restart; lowering it drains sessions first; status reports `longestWaitMs`; a role starved ten minutes counts in `counts.concurrencyStarved`.

**Requests always settle.** A gone pane (`pane_not_found`) counts as closed. No request outlives its own token: expired and unreported by Herdr, it settles `expired`; one still pending counts in `dispatch.sessionReconcile.stuck`. Unanswered sessions relaunch on another profile (12 per request, then `dispatch.abandoned`); an unposted reviewer is reminded first.

**Every role fails over on spent quota**, skipping the account until reset, or waits as one `capacity` line.

The master never launches reviews or producers by hand, except `master review GY-N [PROFILE]` once the loop stops relaunching that review.

### Proofs must exercise their criterion

With a pass, the producer records `"exercise"`: the same proof run with the criterion's behaviour removed.

```json
"exercise":{"criterion":"AC-1","behaviour":"the lease expiry check in claim()","result":"fail","executed":4}
```

A pass is trusted only when that stripped run failed with a case executed; otherwise it is recorded as not exercising its criterion rather than as passing (`unexercised`, `evidence.exercise.refused`), and the loop requests rework.

## Guarded merges

`master merge GY-N|--all` (skipping system-driven items) asks [GitHub to merge](github.md#merge-queue) only under a current authorization for the exact head, base and policy. Protocol skew refuses: `server runs <sha>, CLI expects <sha>: deploy main first`.

Unresolved review threads are the reviewer's inputs, not merge blockers (`reviewThreads`); its approval names each on `Resolved threads:`, `Follow-up threads:` or `Overridden threads:` ([rules](coordination.md#review-gate-verdicts-not-threads)).
