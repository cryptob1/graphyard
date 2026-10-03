<!-- page: Agent protocol | 3 | leases, workspaces, `watch`. -->
# Leases, workspaces and supervision

Claims last 120 s, renewed every ≤30 s; owner mutations carry the epoch; expired epochs stay refused. Before submitting, register branch, path, host ID (`graphyard register GY-1 workspace.json`): branches (`graphyard/…`) globally unique, paths per host, both with the epoch.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` strips Graphyard credentials; lease loss sends SIGTERM, then SIGKILL, to the process group. Contained launches record a quarantine naming their systemd scope unit. A dead supervisor fences the item until an operator attests the stop or `POST /api/work/UUID/autosettle` (`coordinator`/`admin`) proves authority expired 120+ s ago with no supervisor, workspace process, or scope member alive (excuses idle childless shells). Timed `HEAD /` bounds host clock during quarantine grace (bounds wider than 5 s refuse).

### Push credential

Workers never push via host `gh` logins (`gh auth git-credential` unreachable). Launchers mint into `worker-sessions/GY-N-EPOCH` (0700, files 0600), set `GH_CONFIG_DIR`, clear tokens, and point credential helpers at it. `POST /api/work/UUID/push-credential` `{"epoch": N}` (CLI `graphyard push-credential GY-N EPOCH DIR`) mints an unstored App token (`contents`, `pull_requests`, `workflows` write) expiring by the lease bound (claim + 4h); refused for lapsed or submitted epochs, or if a base queue allows App bypass. `watch` re-mints within 15 minutes of expiry, revoking at session end.

A GitHub credential failure ends the attempt next cycle, branch kept, relaunching freshly credentialed. Counted failed: relaunches back off; a third consecutive holds the item for an approver.

## How a lease ends

- `submit` (CLI `complete`); later heartbeats get `Implementation lease for epoch N ended when GY-N was submitted; stop heartbeating after complete`.
- `park`: records a human-only request, releases.
- Coordinator `capacity` report (`event: "exhausted"`): freed for another account.
- Expiry, classified by the epoch's ledger: unwithdrawn `blocked` report → `lease.expired` cause `blocked-awaiting-operator`; admin `--previous-worker-stopped` → `stopped-by-attestation`; `capacity.exhausted` → `exhausted-capacity`; none → `lease-loss` escalation, auto-settled once a record explains it ([settling](../delegation.md#who-may-settle-what)).
