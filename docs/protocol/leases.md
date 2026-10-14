<!-- page: Agent protocol | 3 | leases, `watch`. -->
# Leases and supervision

Claims last 120s, renewed every ≤30s; owner mutations carry epoch (expired refused). Before submitting, register branch, path, host (`graphyard register GY-1 workspace.json`): branches unique, paths unique per host; `graphyard worktree` [frees the branch](../coordination.md#dispatch-optimistically-smallest-scope-first) first.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` strips Graphyard credentials; lease loss sends process group SIGTERM→SIGKILL. Launch calls, release and settlement retry 5xx/408/429, dropped connections, timeouts, backing off 90s; refusals stop at once. An agent exiting, or SIGTERM/SIGINT/SIGHUP to `watch`, before lease end releases it with the cause, not `lease-loss`. Contained launches' quarantine names systemd scope unit. A dead supervisor fences item (delivered too) until attested stop or `POST /api/work/UUID/autosettle` (`coordinator`/`admin`) proves authority expired 120+s ago, nothing alive; loop-ended attempts (exhaustion; submitted, unleased past grace: supervisor stopped, pane closed once this host verifies it gone) settle in ending action. Unsettled: supervisors record why. Loop settlements send `origin: "loop"` (server records `lapsedAt`); [interventions](../dashboard.md) count them past grace+10min, hand ones (`master settle-containment` refused sooner) always.

### Push credential

Workers never use host `gh` logins; launchers mint into `worker-sessions/GY-N-EPOCH` (0700), set `GH_CONFIG_DIR`. `POST /api/work/UUID/push-credential` `{"epoch":N}` (`graphyard push-credential GY-N EPOCH DIR`) mints unstored App token (`contents`, `pull_requests`, `workflows` write) expiring by claim + 4h; refused for lapsed/submitted epochs or base queue allowing App bypass; `watch` re-mints near expiry, revokes at exit. GitHub credential failures block attempt (branch kept), relaunching with backoff once `github-credential` clears; a third consecutive holds it for approver.

## How a lease ends

- `submit` (CLI `complete`); later heartbeats get `Implementation lease for epoch N ended when GY-N was submitted; stop heartbeating after complete`.
- `park` (human-only request naming every human step; file widenings (409) or deferred steps refused: `scope-request`) or `blocked` releases.
- Coordinator `capacity` (`event: "exhausted"`): freed for another account; every attempt end closes its scope request.
- Expiry, classed by epoch's ledger: unwithdrawn pre-release `blocked` report → `lease.expired` cause `blocked-awaiting-operator`; admin `--previous-worker-stopped` → `stopped-by-attestation`; `capacity.exhausted` → `exhausted-capacity`; renewed to the 130-min no-submission refusal unsubmitted → `no-submission-bound`; none → `lease-loss` escalation, auto-settled once a record explains it, a newer attempt supersedes it, or 5 min after raising once every attempt ended without lease or fence ([settling](../delegation.md#who-may-settle-what)).

## Blocked work unblocks itself

`blocked GY-N EPOCH REASON` commits uncommitted work, releases, carries `blocked on epoch N: REASON` over. The `blockers` step probes environmental [classes](../master-agent.md#session-liveness-is-reconciled-not-trusted); `host-supervisor` needs user manager and loop unit answering. The `host supervision` step revives an unanswering user manager (`loginctl enable-linger`, ≤30min backoff) and `enable --now`s down declared `graphyard-executor@N` slots; 3 restarts within an hour fail it. A pass (`POST /api/work/KEY/blocker-probe`) emits `blocker.cleared`; `genuine`, `human-only`, `master-role` and a fourth submissionless clear stay in `master status`. Exception (GY-1768): an unleased loop-held item (loop-owned or awaiting the loop's own reading) whose report is a worker's inability to take the owed reading clears itself; actionable faults stand.
