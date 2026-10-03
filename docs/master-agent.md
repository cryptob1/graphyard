<!-- page: Operate Graphyard | 5 | loop, dispatch, merges. -->
# Master-agent operating mode

The master (`coordinator`) routes and administers GitHub unasked; never implements, reviews or proves. Human-only: goals, priorities, money, third-party accounts, people's credentials ([who decides](glossary.md#who-decides)); the rest it does itself or via an approver agent, never asking a human to run what an agent may.

## Operate

Cycle: `master status`; `master run` dispatches (`schedule.order`); merge gate-passing candidates; rework findings; close finished sessions; verify deployment (`master verify-deployment GY-N`, [refusals](operations-reference.md#perpetual-master-loop)). Stop only when in-scope items are Done or externally blocked, and merges verified or deployment-blocked. Findings, rework, idle workers and proof setup never stop the loop. `controlPlane.production` flags main ahead of production.

`master run` is the `graphyard-master.service` unit ([supervision](onboarding.md#the-loop-must-be-supervised)); on `daemon.liveness` `stalled`/`absent`: `systemctl --user restart graphyard-master`, never from a [dirty checkout](master-agent-sessions.md#the-coordinator-checkout-is-confined-at-the-os-level). The loop launches, wakes and rotates the [master session](master-agent-sessions.md#the-loops-own-master-session).

### System-driven items

Unless created `"systemDriven": false`, items refuse hand `dispatch`, `merge`, `review`, `decide attest|merge`, except stopped-loop recovery, unproduced `manual:` attestations, and `decide merge` when unauthorized or without an operator agent.

### Session liveness is reconciled, not trusted

**The control plane closes sessions, not the master.** Each dispatch tick (`run.dispatchIntervalSeconds`, default 10, at most 30) sweeps handles: one missed by two consecutive sweeps closes (unobserved ones get 3 minutes; other hosts' handles are left to their loop). `dispatch.sessionReconcile` reports closures: **vanished**, **ended** (agentless or terminal; `idle`, `done`, `blocked` are not), **superseded** (a review or proof for an outdated head) and **duplicate**. A closure decides no gate, ends no lease and stops no process; `sessions.unseen` lists stale handles. Past its role's maximum (4h implementation, 1h review, `run.producerTimeoutMinutes`, 12h coordination) a session raises attention. For a finished or dead session do nothing (`graphyard master run --once` sweeps); never mark another session's handle finished to free a slot.

### System invariants

Each cycle (`daemon.invariants.lines`): `follow-ups-per-parent` (1 open), `lingering-sessions` (30 min), `refresh-churn` (3 per own head), `merge-stall` (10 min), `cycle-p90` (30 s), `untriaged-backlog` (24 h), `deploy-lease-loss` (0). Faults per class; thresholds: `invariants` in `.graphyard/master.json`; `tests/soak.test.ts` enforces.

## Machine-filed backlog

Follow-ups wait on their item (`pendingFollowUps`) until ship, joining its follow-up item; closing unshipped drops them ([follow-ups](followups.md)). Triage skips unshipped parents. Pi (`run.research`) triages follow-up and fault items (release, close, merge; closure needs approval), `triageConcurrency` (default 2) at once; untriaged past 24h raises attention; status counts `machineUntriaged`/`operatorBacklog`.

`Recurring <class> faults` and `invariant:` faults get a read-only diagnostician (`run.diagnostician`): approved, its fix releases or closes as duplicate. Restores owed under 30m and restart-resumed merges are self-handled, not `merge` faults.

## Automatic dispatch at submit

Past the build gate (`autoDispatch`): a producer request per proof group (`unit`, `integration`; `manual` with `producerProofs`), then, once they pass, a review request (`proofs-pending` until then). **The loop launches each request within 30 seconds**: every `dispatchIntervalSeconds` it starts the reviewer profile (`run.reviewerProfile`) and one producer session per proof group on a `master producer add FILE` profile ([template](../examples/master/claude-producer.json); `.graphyard/reviews.json`, `.graphyard/producers.json`). Reviewer launches await the head's bot reviews (`run.awaitReviewers`) up to `awaitReviewersMinutes`, skipping a bot that posted a usage-limit notice until it next reviews (`skipped: <bot> exhausted since <time>`; `dispatch.botReviewers`).

- **Concurrency is per role**: `concurrency` (1–20, default 1; above 1, each session takes a name unique to its request) applies without a restart (`run.reviewerProfile` defaults to 4 sessions); lowering it drains first (`longestWaitMs`); starved minutes count in `counts.concurrencyStarved`.
- **Launches bind heads**: stale refusals wake observation and retry; 15m+ waiting reviews raise attention.
- Requests always settle: `pane_not_found` panes close, as do settled reviewers' open panes. No request outlives its own token: expired and unreported by Herdr, it settles `expired`; pending ones count in `dispatch.sessionReconcile.stuck`. Unanswered sessions relaunch (12 per request, then `dispatch.abandoned`); vanished producer runs spend no attempt, exhausted ones raise `escalation:proof-exhausted`, then a quoting rework.
- **Every role fails over on spent quota** or waits as one uncounted `capacity` line.

The master never launches reviews or producers by hand, except `master review GY-N [PROFILE]` after relaunching stops.

### Proofs must exercise their criterion

A passing producer records `"exercise"`: rerun without the criterion's behaviour, the proof must fail with a case executed, else the pass is recorded as not exercising its criterion rather than as passing (`unexercised`, `evidence.exercise.refused`). Once all an automated group's remaining proofs are such findings, the next action is `request-rework` naming proof, criterion and surviving mutation. `decide attest` adds an approver-confirmed `exercise`; unexercised `manual:` proofs re-attest, never rework. Attestations carry only on a kept patch-id.

## Guarded merges

`master merge GY-N|--all` asks [GitHub to merge](github.md#merge-queue) only when currently authorized for exact head, base and policy; protocol skew refuses (`… deploy main first`).

### Repair lane

No-admin-bypass exceptions (head-bound, App's ruleset bypass):
- A `"repair": "merge-path"` item stalled 15m with checks passed, given an approver's `master decide GY-N repair-merge REASON` naming the fault; audited (`repair.merged`).
- The main guard's [revert](github.md#optimistic-merges) of a confirmed main required-suite failure's culprit, unless later merges touched its files (`optimistic.revert.*`); reopens as rework.

Unresolved review threads are the reviewer's inputs, not merge blockers (`reviewThreads`); approvals list each under `Resolved threads:`, `Follow-up threads:` or `Overridden threads:` ([rules](coordination.md#review-gate-verdicts-not-threads)).
