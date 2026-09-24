<!-- page: Agent protocol | 5 | leases, `watch`, containment, rework. -->
# Leases and supervision

Claims last 120 seconds; renew at least every 30. Every owner mutation carries the epoch; an expired or superseded epoch is refused and cannot be revived. If communication fails, stop editing and pushing.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` runs from the registered workspace with a `worker` credential, strips Graphyard credentials from the child, and on lease loss or exit sends SIGTERM then SIGKILL to the process group. It is not a sandbox. A contained launch first records a **quarantine** naming its systemd scope unit, and spawns only after the control plane confirms the live epoch and fence. If the supervisor cannot settle it, the item stays fenced until an automatic [containment settlement](containment-settlement.md) or an operator attestation (`rework --previous-worker-stopped`, or `recover-containment --previous-worker-stopped` when delivered). Automatic settlement holds every process the recorded scope still contains and reports each with pid, command line and working directory.

## How a lease ends

- `submit` (CLI `complete`) ends it in the same transaction; later heartbeats are refused with `Implementation lease for epoch N ended when GY-N was submitted; stop heartbeating after complete`.
- `park` records a human-only request and releases it.
- A coordinator `capacity` report (`event: "exhausted"`, `role: "worker"`) releases it for another account.

## Lapse classification

| Ledger holds for the unsubmitted epoch | Recorded as |
| --- | --- |
| An unwithdrawn `blocked` report | `lease.expired`, cause `blocked-awaiting-operator` |
| An admin `--previous-worker-stopped` attestation | `lease.expired`, cause `stopped-by-attestation` |
| `capacity.exhausted` | `lease.expired`, cause `exhausted-capacity` |
| Nothing | `lease-loss` escalation |

Reconciliation auto-settles a `lease-loss` that one of these records (or a submission) explains. Otherwise any `admin` may cite a ledger attestation: `resolve GY-N lease-loss --attestation blocked|stopped-worker REASON`. See [delegation](../delegation.md#escalation).

## Rework

Stop the previous process, then `rework`: ownership clears and the build gate closes. The next claim gets a higher epoch and registers the same PR branch in a fresh path. Merged work needs a follow-up item.
