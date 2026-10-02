<!-- page: Agent protocol | 3 | leases, workspaces, `watch`. -->
# Leases, workspaces and supervision

Claims last 120 s, renewed every ≤30 s; owner mutations carry the epoch; expired epochs stay refused. Before submitting, register branch, path, host ID (`graphyard register GY-1 workspace.json`): branches (`graphyard/…`) globally unique, paths per host, both with the epoch.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` strips Graphyard credentials; lease loss → SIGTERM, then SIGKILL, to the process group (no sandbox). Contained launches first record a **quarantine** naming their systemd scope unit. A dead supervisor fences the item until an operator attests the stop or `POST /api/work/UUID/autosettle` (`coordinator`/`admin`) proves authority expired 120+ s ago, with no supervisor, workspace process, scope member alive.

### Push credential

Workers never push via the host's `gh` login. Launchers mint into `worker-sessions/GY-N-EPOCH` beside the profile's credential file (0700, files 0600), set `GH_CONFIG_DIR` there, empty `GH_TOKEN`/`GITHUB_TOKEN`, point git credential helpers at it, push ssh origins over https; mint failure refuses the launch. `POST /api/work/UUID/push-credential` `{"epoch": N}` (lease holder; CLI `graphyard push-credential GY-N EPOCH DIR`) mints an unstored Graphyard App installation token (this repository; `contents`, `pull_requests`, `workflows` write; an installation that has not accepted `workflows` answers 422 and the mint retries once without it) expiring by the **lease bound** (claim + 4-hour time box); none for lapsed, submitted, overdue epochs, rechecked after minting (revoking on a moved lease). With that attempt's credential in `GH_CONFIG_DIR`, `watch` re-mints on renewal within 15 minutes of expiry (revoking the old), revoking and removing it at session end. As the Graphyard App (merge-queue bypass actor), branch protection's required reviews and checks bind it. **Limitation (GY-1066):** no token is minted (409) while a base merge queue lets the App bypass it or hides its bypass list, so such a repository launches no worker.

A GitHub credential failure ends the attempt next cycle, branch kept, relaunching freshly credentialed. Counted failed (like time-box overruns): relaunches back off; a third consecutive holds the item for an approver.

## How a lease ends

- `submit` (CLI `complete`); later heartbeats get `Implementation lease for epoch N ended when GY-N was submitted; stop heartbeating after complete`.
- `park`: records a human-only request, releases.
- Coordinator `capacity` report (`event: "exhausted"`): freed for another account.
- Expiry, classified by the epoch's ledger: unwithdrawn `blocked` report → `lease.expired` cause `blocked-awaiting-operator`; admin `--previous-worker-stopped` → `stopped-by-attestation`; `capacity.exhausted` → `exhausted-capacity`; none → `lease-loss` escalation, auto-settled once a record explains it ([settling](../delegation.md#who-may-settle-what)).
