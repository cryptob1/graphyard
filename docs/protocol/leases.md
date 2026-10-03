<!-- page: Agent protocol | 3 | leases, workspaces, `watch`. -->
# Leases, workspaces and supervision

Claims last 120 s; renew every ≤30 s. Owner mutations carry the epoch; expired epochs stay refused. Register branch, path, host ID (`graphyard register GY-1 workspace.json`) before submitting. Branches (`graphyard/…`) are globally unique, paths unique per host including past reservations; both carry the epoch.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` strips Graphyard credentials and, on lease loss, SIGTERMs then SIGKILLs its process group (no sandbox). Contained launches first record a **quarantine** naming their systemd scope unit. A dead supervisor fences the item until an operator attests the stop, or `POST /api/work/UUID/autosettle` (`coordinator`/`admin`) proves authority expired 120+ s ago and no supervisor, workspace process or scope member lives. Verification records ≤200 processes per scope (`truncated: true`, judged live) and ≤50 scopes, refusing all settlement beyond. The loop closes the recorded pane's excused idle, childless shell.

### Push credential

Workers never push with the host's `gh` login; the session bus is masked. The launcher mints a credential in `worker-sessions/GY-N-EPOCH` (0700, files 0600), sets `GH_CONFIG_DIR`, empties `GH_TOKEN`/`GITHUB_TOKEN`, and sets git credentials to push https. `POST /api/work/UUID/push-credential` `{"epoch": N}` (lease holder only; `graphyard push-credential GY-N EPOCH DIR`) mints an unstored GitHub App token (`contents`, `pull_requests`, `workflows` write; retries without `workflows` on 422) expiring by the 4-hour lease bound; none for lapsed, submitted or overdue epochs. `watch` re-mints within 15 minutes of expiry and revokes on session end. A base merge queue allowing App bypass refuses token minting (409; transient ruleset read: 502).

GitHub credential failures end the attempt and relaunch with a fresh credential (backoff 5, then 15 minutes; three hold for an approver).

## How a lease ends

- `submit` (CLI `complete`); later heartbeats are refused.
- `park` (files a human-only request).
- Coordinator `capacity` report (`event: "exhausted"`): freed for another account.
- Expiry, by the epoch's ledger: unwithdrawn `blocked` report → `lease.expired` cause `blocked-awaiting-operator`; admin `--previous-worker-stopped` → `stopped-by-attestation`; `capacity.exhausted` → `exhausted-capacity`; nothing → `lease-loss` escalation, auto-settled once a record explains it ([settling](../delegation.md#who-may-settle-what)).
