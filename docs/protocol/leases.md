<!-- page: Agent protocol | 3 | leases, workspaces, `watch`. -->
# Leases, workspaces and supervision

Claims last 120 s; renew every ≤30 s. Owner mutations carry the epoch; expired epochs stay refused. Register branch, path, host ID (`graphyard register GY-1 workspace.json`) before submitting. Branches (`graphyard/…`) are globally unique, paths unique per host including past reservations; both carry the epoch.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` strips Graphyard credentials and, on lease loss, SIGTERMs then SIGKILLs its process group (no sandbox). Contained launches first record a **quarantine** naming their systemd scope unit. A dead supervisor fences the item until an operator attests the stop, or `POST /api/work/UUID/autosettle` (`coordinator`/`admin`) proves authority expired 120+ s ago and no supervisor, workspace process or scope member lives. The loop closes the recorded pane's excused idle, childless shell.

## How a lease ends

- `submit` (CLI `complete`); later heartbeats are refused.
- `park` (files a human-only request).
- Coordinator `capacity` report (`event: "exhausted"`): freed for another account.
- Expiry, by the epoch's ledger: unwithdrawn `blocked` report → `lease.expired` cause `blocked-awaiting-operator`; admin `--previous-worker-stopped` → `stopped-by-attestation`; `capacity.exhausted` → `exhausted-capacity`; nothing → `lease-loss` escalation, auto-settled once a record explains it ([settling](../delegation.md#who-may-settle-what)).
