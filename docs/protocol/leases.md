<!-- page: Agent protocol | 3 | leases, `watch`. -->
# Leases and supervision

Claims last 120s, renewed every ≤30s; owner mutations carry epoch (expired refused). Before submitting, register branch, path, host (`graphyard register GY-1 workspace.json`): branches unique, paths unique per host; `graphyard worktree` [frees the branch](../coordination.md#dispatch-optimistically-smallest-scope-first) first.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` strips Graphyard credentials; lease loss SIGTERM→SIGKILLs the process group. Launch calls, release, settlement and renewal ride 5xx/408/429, dropped connections and timeouts 90s with backoff; a renewal unanswered 15s is retried afresh, the deadline unmoved (the worker stops at the server's expiry); refusals stop at once. An agent exiting or signalled before lease end releases with cause, not `lease-loss`. Contained launches' quarantine names the scope unit. A dead supervisor fences the item (delivered too) until attested stop or `POST /api/work/UUID/autosettle` (`coordinator`/`admin`) proves authority expired 120+s ago, nothing alive; loop-ended attempts (exhaustion; submitted, unleased past grace, supervisor stopped, pane gone) settle in the ending action. Unsettled: supervisors record why. Loop settlements send `origin: "loop"` (server records `lapsedAt`); [interventions](../dashboard.md) count them past grace+10min, hand ones sooner.

### Push credential

Workers never use host `gh` logins; launchers mint into `worker-sessions/GY-N-EPOCH` (0700), set `GH_CONFIG_DIR`. `POST /api/work/UUID/push-credential` `{"epoch":N}` (`graphyard push-credential GY-N EPOCH DIR`) mints an unstored App token (`contents`, `pull_requests`, `workflows` write) expiring claim + 4h; refused for lapsed/submitted epochs or an App-bypassing base queue; `watch` re-mints near expiry, revokes at exit. GitHub credential failures block the attempt (branch kept), relaunching with backoff once `github-credential` clears; a third holds it for the approver.

## How a lease ends

- `submit` (CLI `complete`); later heartbeats get `Implementation lease for epoch N ended when GY-N was submitted; stop heartbeating after complete`.
- `park` (human-only request naming every human step; widenings and deferred steps refuse: `scope-request`) or `blocked` releases.
- Coordinator `capacity` (`event: "exhausted"`) frees another account; attempt ends close scope requests.
- Expiry, classed by epoch's ledger (`lease.expired` cause): `blocked-awaiting-operator` (unwithdrawn pre-release `blocked` report), `stopped-by-attestation` (admin `--previous-worker-stopped`), `exhausted-capacity` (`capacity.exhausted`), `control-plane-stall` (lapse inside a recorded `plane.stall`: the plane's lease-pool tick, stamped as it lands, gaps recorded once at startup before heartbeats and each pass), `no-submission-bound` (renewed to the 130-min no-submission refusal); none: `lease-loss` escalation, auto-settled on the record alone (a later stall only when covering the expiry; [settling](../delegation.md#who-may-settle-what)).

## Blocked work unblocks itself

`blocked GY-N EPOCH REASON` commits uncommitted work, releases, carries `blocked on epoch N: REASON` over. The `blockers` step probes environmental [classes](../master-agent.md#session-liveness-is-reconciled-not-trusted); `host-supervisor` needs user manager and loop unit answering. The `host supervision` step revives an unanswering user manager (`loginctl enable-linger`, ≤30min backoff) and `enable --now`s down declared `graphyard-executor@N` slots; 3 restarts/hour fail it. A pass (`POST /api/work/KEY/blocker-probe`) emits `blocker.cleared`; `genuine`, `human-only`, `master-role` and a fourth submissionless clear stay in `master status`. Exception (GY-1768): an unleased loop-owned item blocked only on the worker's inability to take the owed reading self-clears; actionable faults stand.
