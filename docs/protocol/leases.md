<!-- page: Agent protocol | 3 | leases, workspaces, `watch`. -->
# Leases, workspaces and supervision

Claims last 120 s; renew every ≤30 s. Owner mutations carry the epoch; expired epochs stay refused. Register branch, path, host ID (`graphyard register GY-1 workspace.json`) before submitting. Branches (`graphyard/…`) are globally unique, paths unique per host including past reservations; both carry the epoch.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` strips Graphyard credentials and, on lease loss, SIGTERMs then SIGKILLs its process group (no sandbox). Contained launches first record a **quarantine** naming their systemd scope unit. A dead supervisor fences the item until an operator attests the stop, or `POST /api/work/UUID/autosettle` (`coordinator`/`admin`) proves authority expired 120+ s ago and no supervisor, workspace process or scope member lives. The loop closes the recorded pane's excused idle, childless shell.

### Push credential

Workers never push with the host's `gh` login; their session bus is masked (GY-999). Before a worker starts, the launcher mints a credential into `worker-sessions/GY-N-EPOCH` beside the profile's credential file (0700, files 0600), sets `GH_CONFIG_DIR` there, empties `GH_TOKEN`/`GITHUB_TOKEN`, resets git credential helpers to that token and pushes ssh origins over https; a launch that cannot mint one is refused and its claim released. `POST /api/work/UUID/push-credential` `{"epoch": N}` (lease holder only; CLI `graphyard push-credential GY-N EPOCH DIR`) mints an unstored Graphyard App installation token for this repository with `contents` and `pull_requests` write, expiring by the **lease bound** (claim plus the 4-hour time box); none for a lapsed, submitted or overdue epoch. `watch` re-mints it within 15 minutes of expiry, revoking the old one, and revokes and removes it when the session ends; a killed supervisor's credential is revoked at the profile's next launch. The token acts as the Graphyard App, the merge-queue ruleset's bypass actor, so branch protection's required reviews and checks bind it.

An attempt blocked by a GitHub credential failure (a git or `gh` refusal, or a 401 naming GitHub) ends next cycle, keeping its branch, and relaunches with a fresh credential. Each counts as a failed attempt, like one outrunning its time box: relaunches wait 5, then 15 minutes; a third in a row holds the item for an approver's decision.

## How a lease ends

- `submit` (CLI `complete`); later heartbeats are refused.
- `park` (files a human-only request).
- Coordinator `capacity` report (`event: "exhausted"`): freed for another account.
- Expiry, by the epoch's ledger: unwithdrawn `blocked` report → `lease.expired` cause `blocked-awaiting-operator`; admin `--previous-worker-stopped` → `stopped-by-attestation`; `capacity.exhausted` → `exhausted-capacity`; nothing → `lease-loss` escalation, auto-settled once a record explains it ([settling](../delegation.md#who-may-settle-what)).
