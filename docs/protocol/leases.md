<!-- page: Agent protocol | 3 | leases, workspaces, `watch`. -->
# Leases, workspaces and supervision

Claims last 120 s; renew every ≤30 s. Owner mutations carry the epoch; expired epochs stay refused. Register branch, path, host ID (`graphyard register GY-1 workspace.json`) before submitting. Branches (`graphyard/…`) are globally unique, paths unique per host including past reservations; both carry the epoch.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` strips Graphyard credentials and, on lease loss, SIGTERMs then SIGKILLs its process group (no sandbox). Contained launches first record a **quarantine** naming their systemd scope unit. A dead supervisor fences the item until an operator attests the stop, or `POST /api/work/UUID/autosettle` (`coordinator`/`admin`) proves authority expired 120+ s ago and no supervisor, workspace process or scope member lives. Verification records ≤200 processes per scope (`truncated: true`, judged live) and ≤50 scopes, refusing all settlement beyond. The loop closes the recorded pane's excused idle, childless shell.

### Push credential

Workers never push with the host's `gh` login; their session bus is masked (GY-999). Before a worker starts, the launcher mints a credential into `worker-sessions/GY-N-EPOCH` beside the profile's credential file (0700, files 0600), sets `GH_CONFIG_DIR` there, empties `GH_TOKEN`/`GITHUB_TOKEN`, resets git credential helpers to that token and pushes ssh origins over https; a launch that cannot mint one is refused and its claim released. `POST /api/work/UUID/push-credential` `{"epoch": N}` (lease holder only; CLI `graphyard push-credential GY-N EPOCH DIR`) mints an unstored repository Graphyard App installation token (`contents`, `pull_requests`, `workflows` write, as a base sync may carry a workflow change; on a 422 for `workflows` it retries once without it) expiring by the **lease bound** (claim plus the 4-hour time box); none for a lapsed, submitted or overdue epoch, rechecked after minting. `watch` re-mints it within 15 minutes of expiry, revoking the old one, and revokes and removes it at session end (unconfirmed revocations wait in `revoke.json`); a killed supervisor's is revoked at the profile's next launch.

**Limitation (GY-1066):** no token is minted (409) while the base's merge queue lets the App bypass it or hides its bypass list, so such a repository launches no worker until workers push as a separate, non-exempt App (not yet provided). A transient ruleset read failure is a retryable 502.

An attempt blocked by a GitHub credential failure (git or `gh` refusal, or a 401 naming GitHub) ends next cycle, keeping its branch, and relaunches with a fresh credential; like an overrun time box, relaunches wait 5, then 15 minutes, and a third in a row holds the item for an approver.

## How a lease ends

- `submit` (CLI `complete`); later heartbeats are refused.
- `park` (files a human-only request).
- Coordinator `capacity` report (`event: "exhausted"`): freed for another account.
- Expiry, by the epoch's ledger: unwithdrawn `blocked` report → `lease.expired` cause `blocked-awaiting-operator`; admin `--previous-worker-stopped` → `stopped-by-attestation`; `capacity.exhausted` → `exhausted-capacity`; nothing → `lease-loss` escalation, auto-settled once a record explains it ([settling](../delegation.md#who-may-settle-what)).
