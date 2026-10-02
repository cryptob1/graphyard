<!-- page: Agent protocol | 3 | leases, workspaces, `watch`. -->
# Leases, workspaces and supervision

Claims last 120 seconds, renewed at least every 30. Every owner mutation carries the epoch; an expired epoch is refused and cannot be revived.

## Workspaces

Register the exact branch, path and host ID (`graphyard register GY-1 workspace.json`) before submitting. Branches begin `graphyard/`, globally unique; paths are unique per host (historical reservations included); put the epoch in both.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` strips Graphyard credentials from the child and on lease loss sends SIGTERM, then SIGKILL, to the process group; it is no sandbox. A contained launch first records a **quarantine** naming its systemd scope unit. If the supervisor dies, the item is fenced until `POST /api/work/UUID/autosettle` (`coordinator` or `admin`) proves authority expired 120 seconds ago and no supervisor, workspace process or scope member is alive, or an operator attests the stop. The host verification records each process list up to its bound (200 per scope) with the full count and `truncated: true`; a truncated scope is judged live, so it fences its own quarantine and any quarantine it still holds processes for, while other quarantines in the same verification settle normally. A host with more than 50 containment scopes records the first 50 and the full count, and refuses every settlement, because an unrecorded scope cannot be proven stopped. Settlement excuses only the recorded pane's idle, childless shell, which the loop closes.

### Push credential

A worker never pushes with the host's `gh` login: its session bus is masked, so the keyring behind `gh auth git-credential` is unreachable (GY-999). Before a worker starts, the launcher mints its credential into `worker-sessions/GY-N-EPOCH` beside the profile's credential file (0700, files 0600) and sets `GH_CONFIG_DIR` there, empties `GH_TOKEN`/`GITHUB_TOKEN`, resets every git credential helper to one reading that token, and pushes ssh origins over https; a launch that cannot mint one is refused and its claim released. `POST /api/work/UUID/push-credential` with `{"epoch": N}` (the lease holder only; CLI `graphyard push-credential GY-N EPOCH DIR`) mints a Graphyard App installation token for this repository alone with `contents`, `pull_requests` and `workflows` write (a base sync may carry a workflow change; an installation that has not accepted `workflows` refuses that with 422, and the mint retries once with `contents` and `pull_requests` alone), its stated expiry capped at the **lease bound** (claim plus the 4-hour implementation time box); nothing is minted for a lapsed, submitted or overdue epoch — checked again after the mint, revoking a token whose lease moved meanwhile — and the token is never stored. When `GH_CONFIG_DIR` holds that attempt's credential, `watch` re-mints it within 15 minutes of expiry on a renewal, revoking the old token, and revokes and removes it when the session ends; a token GitHub does not confirm revoking (204, or 401) is kept in `revoke.json` until it does or expires, and a killed supervisor's expired credential is revoked and removed at that profile's next launch.

**Limitation (GY-1066):** no token is minted (409) while a merge queue on the base lets the App bypass it, or its bypass list is hidden from the App, because that token could merge past the queue. An organization repository whose managed ruleset makes the control-plane App its bypass actor therefore launches no worker until workers push as a separate App the queue does not exempt, which Graphyard does not provide yet; the launch failure names this. A ruleset GitHub fails to answer transiently is a retryable 502.

An attempt blocked by a GitHub credential failure (git's or `gh`'s own refusal, or a 401 naming GitHub) is ended in the next cycle, keeping its work on its branch, and relaunched with a fresh credential. Each such ending counts as a failed attempt, as one that outruns its time box does: relaunches wait 5, then 15 minutes, and a third in a row holds the item for an approver's decision.

## How a lease ends

- `submit` (CLI `complete`) ends it; later heartbeats are refused with `Implementation lease for epoch N ended when GY-N was submitted; stop heartbeating after complete`.
- `park` records a human-only request and releases it.
- A coordinator `capacity` report (`event: "exhausted"`) releases it for another account.
- Otherwise it expires, classified from the unsubmitted epoch's ledger: an unwithdrawn `blocked` report is `lease.expired` with cause `blocked-awaiting-operator`; an admin `--previous-worker-stopped` attestation is `stopped-by-attestation`; `capacity.exhausted` is `exhausted-capacity`; nothing is a `lease-loss` escalation, auto-settled if a record later explains it ([settling](../delegation.md#who-may-settle-what)).


