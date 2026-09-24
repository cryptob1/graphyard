<!-- page: Agent protocol | 3 | leases, workspaces, `watch`. -->
# Leases, workspaces and supervision

Claims last 120 seconds; renew at least every 30. Every owner mutation carries the epoch; an expired epoch is refused and cannot be revived.

## Workspaces

Register the exact branch, path and host ID (`graphyard register GY-1 workspace.json`) before submitting. Branches begin `graphyard/` and are globally unique; paths are unique per host, including historical reservations. Put the epoch in both names.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` strips Graphyard credentials from the child and on lease loss sends SIGTERM then SIGKILL to the process group; it is not a sandbox. A contained launch first records a **quarantine** naming its systemd scope unit. If the supervisor dies, the item stays fenced until `POST /api/work/UUID/autosettle` (`coordinator` or `admin`) proves authority expired 120 seconds ago and no supervisor, workspace process or scope member is alive, or until an operator attests the stop. An ended or not-found recorded scope excuses a childless interactive pane shell outside any scope; the loop closes that pane.

## How a lease ends

- `submit` (CLI `complete`) ends it; later heartbeats are refused with `Implementation lease for epoch N ended when GY-N was submitted; stop heartbeating after complete`.
- `park` records a human-only request and releases it.
- A coordinator `capacity` report (`event: "exhausted"`) releases it for another account.
- Otherwise it expires, classified from the ledger for the unsubmitted epoch: an unwithdrawn `blocked` report is `lease.expired` with cause `blocked-awaiting-operator`; an admin `--previous-worker-stopped` attestation is `stopped-by-attestation`; `capacity.exhausted` is `exhausted-capacity`; nothing is a `lease-loss` escalation, auto-settled if a record later explains it ([who may settle what](../delegation.md#who-may-settle-what)).


