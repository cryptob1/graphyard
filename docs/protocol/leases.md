<!-- page: Agent protocol | 5 | lease renewal, `watch` supervision, foreground containment, and rework. -->
# Leases and supervision

Claims last 120 seconds; renew at least every 30 (the supervisor uses 25). Every owner mutation carries the epoch. Expiry or a superseding claim rejects the old owner; a heartbeat cannot revive an expired lease. If communication fails, stop editing and pushing.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` runs from the registered workspace with a `worker` credential. It renews with a fresh idempotency key each time, measures the lease on local monotonic time, strips Graphyard credential variables from the child, and on lease loss, interruption or exit sends SIGTERM to the process group and SIGKILL after five seconds. Environment filtering is not a sandbox: keep worker machines free of operator and producer secrets. Process-group containment targets Linux and macOS.

Before spawning, a foreground contained launch persists an epoch-bound **quarantine** naming the systemd scope unit (`graphyard-watch-PID-UUID.scope`) and supervisor pid, acknowledges the live epoch, settlement hash and resource fence, and re-reads the work snapshot; any mismatch or ambiguity means no launch. The settlement capability stays in the parent only. After shutdown is verified, the supervisor settles the quarantine; if it cannot, the item stays unclaimable until an automatic [containment settlement](containment-settlement.md) or an operator stopped-worker attestation (`rework --previous-worker-stopped`, or `recover-containment --previous-worker-stopped` for a delivered item). Signal handlers stay installed through establishment, shutdown and settlement.

## How a lease ends

- `submit` (CLI `complete`) ends the lease in the same transaction that binds the candidate. Later heartbeats are refused with `Implementation lease for epoch N ended when GY-N was submitted; stop heartbeating after complete`, and `watch` stops the session. Make `complete` the last action.
- `park` (lease holder) records a human-only request and ends the lease as `released`.
- A `capacity` report with `event: "exhausted"`, `role: "worker"` (coordinator) ends the lease so another account can claim.
- A lapse on a submitted epoch is a plain `lease.expired`, never an escalation.

## Lapse classification

A lapse on an unsubmitted epoch is classified from the events ledger:

| Ledger holds for that epoch | Recorded as |
| --- | --- |
| An unwithdrawn `blocked` report | `lease.expired`, cause `blocked-awaiting-operator` |
| An admin `--previous-worker-stopped` attestation | `lease.expired`, cause `stopped-by-attestation` |
| `capacity.exhausted` | `lease.expired`, cause `exhausted-capacity` |
| Nothing | `lease-loss` escalation |

Reconciliation auto-settles a standing `lease-loss` whose epoch has a submission or one of these records (`escalation.auto-settled`). Otherwise any `admin` may resolve it by citing an attestation the ledger holds: `resolve GY-N lease-loss --attestation blocked|stopped-worker REASON`. See [delegation](../delegation.md#escalation).

Automatic settlement inspects the recorded scope unit: it holds every process that scope still contains, attributes a neighbouring `graphyard-watch-*` scope to another live assignment only through its supervisor, and reports each fencing process with pid, command line and working directory.

## Rework

To reassign submitted work, stop the previous process and request `rework`: ownership clears and the build gate closes, keeping PR attribution. The next claim gets a higher epoch and registers the same PR branch in a fresh path. Rework of merged work is refused; create a follow-up.
