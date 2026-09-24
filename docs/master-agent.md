<!-- page: Operate Graphyard | 5 | the loop, dispatch and merges. -->
# Master-agent operating mode

The master (`coordinator`) routes work, merges, verifies deployments and administers GitHub; it never implements, reviews or produces evidence. `master guide` prints this page.

## Autonomy: agents approve agents

The master acts without asking. Only three decisions are human-only: goals and priorities, spending money or opening third-party accounts, and issuing credentials to people. Everything else it applies alone or through an approver agent ([who decides](glossary.md#who-decides)); never ask a human to run a command an agent identity may run.

## Operate

Keep cycling: status, dispatch ready work, shepherd review and proof collection, guarded merge, then deployment verification. Stop only when every in-scope item is Done or has a genuinely external blocker recorded in Graphyard, and every merged change is live-verified against the exact deployed release.

1. `master status` at startup and after every material event.
2. `master dispatch GY-N PROFILE` in `schedule.order`.
3. Route findings and failed proofs to rework.
4. Merge only when the exact candidate passes every gate.
5. `master verify-deployment GY-N` after delivery ([refusals](operations-reference.md#perpetual-master-loop)).
6. Close finished agent sessions, then return to status.

Ordinary review findings, rework, idle workers, and proof setup are not stopping conditions. `controlPlane.production` says when main is ahead of production.

`master run` is this loop as a process under the `graphyard-master.service` unit ([supervision](onboarding.md#the-loop-must-be-supervised)); restart it with `systemctl --user restart graphyard-master` when `daemon.liveness` is `stalled` or `absent`.

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness; closing finished sessions is not the master's
manual duty.** A sweep runs on every automatic-dispatch tick (`run.dispatchIntervalSeconds`, 10 seconds by default and 30 at most). A handle the runtime stops reporting gets a 60-second grace, counted from the first sweep
that missed it, so its record closes within 90 seconds of the runtime dropping it. A handle another host launched is left to
that host's loop. `dispatch.sessionReconcile` reports each closure:

- **Vanished**: absent from the runtime's listing for the whole grace.
- **Ended**: in a runtime terminal state. `idle`, `done` and
  `blocked` are deliberately not terminal.
- **Superseded**: a review or proof session for a head the item moved past; a delivered item is closed the same
  way as any other. Implementation sessions are left to the lease.
- **Duplicate**: the older of two sessions for one role and head.

A closure decides no gate, ends no lease, and stops no process. A profile's concurrency is counted against live
sessions only, and a name is busy only while a live session has it. A session past its role's maximum (4h implementation, 1h review, `run.producerTimeoutMinutes` for a producer, 12h coordination) raises attention and is never closed.

**So what an operator or a master does instead of closing sessions by hand:** nothing, for a session
that finished or died (with the loop stopped, `graphyard master run --once` sweeps once); for an overlong one, attach to it with the command on the handle. Never mark
another session's handle finished to free a slot.

## Automatic dispatch at submit

When a candidate passes the build gate, `autoDispatch` records one producer request per proof group (`unit`, `integration`, and `manual` for `producerProofs`), bound to the exact head, base and policy. The review request follows only once the head's unit and integration proofs pass (`proofs-pending` until then; a failed one returns the head to its worker). **The loop launches each recorded request within 30 seconds**: every `dispatchIntervalSeconds` it starts the reviewer profile (`run.reviewerProfile`) and one producer session per proof group on a producer profile added with `master producer add FILE` ([template](../examples/master/claude-producer.json)), recorded in `.graphyard/reviews.json` and `.graphyard/producers.json`.

**Concurrency is per role.** A profile's `concurrency` (1–20, default 1) is how many sessions it runs at once, each with a name unique to its request above one. Changes apply without a restart; after lowering it, running sessions drain first. `master status` reports `concurrency` (`running`, `limit`, `waiting`, `longestWaitMs`); a role starved ten minutes counts in `counts.concurrencyStarved`.

**Requests always settle.** A pane already gone (`pane_not_found`) counts as closed. No request outlives its own token: once expired and unreported by Herdr, it settles as `expired`. One still pending is counted in `dispatch.sessionReconcile.stuck`; close its pane.

The master never launches reviews or producers by hand; `master status` shows what is requested, what is running and since when.

### Proofs must exercise their criterion

With a pass, the producer records `"exercise"`: the same proof run with the criterion's behaviour removed.

```json
"exercise":{"criterion":"AC-1","behaviour":"the lease expiry check in claim()","result":"fail","executed":4}
```

A pass is trusted only when that stripped run failed with a case executed; otherwise it is recorded as not exercising its criterion rather than as passing (`unexercised`, `evidence.exercise.refused`).

## Guarded merges

`master merge GY-N|--all` merges only under a current authorization for the exact head, base and policy, rechecking every gate under a single-use execution and never using an administrative merge bypass. A server on another merge protocol refuses with `server runs <sha>, CLI expects <sha>: deploy main first`. Only the [merge queue](github.md#merge-queue)'s head merges.

With required conversation resolution, each unresolved thread fails the merge gate (`reviewThreads`). An unresolved review thread is a finding to fix: the head's reviewer resolves those fixed there; route others like `CHANGES_REQUESTED`, with `master decide GY-N rework REASON`. Resolving a thread the master did not write is not the master's call.
