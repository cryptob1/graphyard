<!-- page: Agent protocol | 3 | leases, workspaces, `watch`. -->
# Leases, workspaces and supervision

Claims last 120 seconds; renew at least every 30. Owner mutations carry the epoch; expired epochs are refused, never revived.

## Workspaces

Before submitting, register branch, path and host ID (`graphyard register GY-1 workspace.json`). Branches start `graphyard/` (globally unique); paths are unique per host, past reservations included; both carry the epoch.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` (no sandbox) strips Graphyard credentials from the child; on lease loss it sends SIGTERM, then SIGKILL, to the process group. A contained launch first records a **quarantine** naming its systemd scope unit; if the supervisor dies, the item stays fenced until an operator attests the stop or `POST /api/work/UUID/autosettle` (`coordinator`, `admin`) proves authority expired 120 seconds ago and no supervisor, workspace process or scope member lives ([settling](../operations-reference.md#supervisor-died-leaving-a-containment-quarantine)).

## How a lease ends

- `submit` (CLI `complete`); later heartbeats are refused (`stop heartbeating after complete`).
- `park`, recording a human-only request.
- A coordinator `capacity` report (`event: "exhausted"`) frees it for another account.
- Expiry: `lease.expired`, its cause from the unsubmitted epoch's ledger: `blocked-awaiting-operator` (unwithdrawn `blocked` report), `stopped-by-attestation` (admin `--previous-worker-stopped`) or `exhausted-capacity` (`capacity.exhausted`); with none, a `lease-loss` escalation, auto-settled once a record explains it ([settling](../delegation.md#who-may-settle-what)).
