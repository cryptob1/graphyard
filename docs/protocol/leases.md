<!-- page: Agent protocol | 3 | leases, workspaces. -->
# Leases, supervision and workspaces

For a worker or supervisor author: what ownership means and when it ends.

## Lease end and its cause

A lease ends when the worker submits, releases it or lets it expire 120 seconds after the last heartbeat; each end is a `lease.expired` entry naming its cause.

- **`submitted`:** ended at `complete`.
- **`blocked-awaiting-operator`:** the worker recorded a `blocked` report and stopped to wait.
- **`stopped-by-attestation`:** an `admin` attested the stop with `rework` or `recover-containment --previous-worker-stopped`.

Only a lapse with none of those raises `lease-loss` ([who settles it](../delegation.md#who-may-settle-what)).

Two other transactions end an unsubmitted lease on the record, as `released`, so it never lapses. `park` (`POST /api/work/GY-N/park`, the lease holder only) records a typed human-only request and ends the lease with it: the session exits holding nothing, its supervisor's next renewal is refused, and the item stays unclaimable until the human answers. A `capacity` report with `event: "exhausted"` and `role: "worker"` (coordinator only, naming the current epoch) records that the attempt's provider account ran out mid-session and ends its lease, leaving the item claimable on another account once its containment quarantine settles. Neither raises `lease-loss`, and both leave a history entry — `human.requested`, `capacity.exhausted` — naming the owner and epoch whose lease ended.

## Workspaces

Register the exact branch and a stable machine ID before submitting the pull request.

- **Branches:** must begin `graphyard/`; globally unique here.
- **Paths:** unique per host, historical reservations included; use the assignment epoch in both names.
- **Normalization:** lexical; aliases through `..`, repeated separators and same-host nested reservations rejected as overlaps.
- **Registration:** host and path worker-reported, branch matching provider-observed.
- **Workspace cleanup:** manual, preserving uncommitted work.

## Foreground containment

A foreground contained launch persists an epoch-bound quarantine recording the session's exact systemd scope unit (`graphyard-watch-PID-UUID.scope`) and the supervisor's pid; `watch` refuses to launch unless the confirmed quarantine names them.

- **Claims:** stay refused after lease expiry until settlement or an attested stop through rework. After Done, `recover-containment --previous-worker-stopped` clears only the quarantine, preserving Done, candidate, merge, requirement, evidence and delivery history.

### Automatic containment settlement

A supervisor that dies unsettled leaves a quarantine no capability can lower. `POST /api/work/UUID/autosettle` lets a `coordinator` or `admin` settle it by *proving* the supervisor gone.

- **Body:** the quarantine's epoch and settlement hash, an audit reason and a host verification record.

The control plane re-checks what it can, never trusting the report for it; all must hold:

- **Quarantine:** still exists at exactly that epoch and hash, superseded by no later epoch.
