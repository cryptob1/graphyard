<!-- page: Agent protocol | 3 | leases, `watch`. -->
# Leases and supervision

Claims last 120 s, renewed every ≤30 s; owner mutations carry epoch (expired refused). Before submitting, register branch, path, host (`graphyard register GY-1 workspace.json`): branches (`graphyard/…`) unique, paths unique per host; `graphyard worktree` [frees the branch](../coordination.md#dispatch-optimistically-smallest-scope-first) first.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` strips Graphyard credentials; lease loss sends process group SIGTERM, then SIGKILL. Contained launches' quarantine names systemd scope unit. A dead supervisor fences the item until an attested stop or `POST /api/work/UUID/autosettle` (`coordinator`/`admin`) proves authority expired 120+ s ago, nothing alive; loop-ended attempts (exhaustion, closed submitted session), supervisor verified gone, settle in ending action. Unsettled: supervisors record why; 5xx/stale-verification refusals retry next cycle. Loop settlements send `origin: "loop"` (server records `lapsedAt`); [interventions](../dashboard.md) count them only past grace plus 10 minutes, hand ones always.

### Push credential

Workers never use host `gh` logins; launchers mint into `worker-sessions/GY-N-EPOCH` (0700), set `GH_CONFIG_DIR`. `POST /api/work/UUID/push-credential` `{"epoch": N}` (`graphyard push-credential GY-N EPOCH DIR`) mints unstored App token (`contents`, `pull_requests`, `workflows` write) expiring by claim + 4h; refused for lapsed/submitted epochs or base queue allowing App bypass; `watch` re-mints near expiry, revokes at exit. GitHub credential failures block attempt (branch kept), relaunching with backoff once `github-credential` clears; a third in a row holds the item for an approver.

## How a lease ends

- `submit` (CLI `complete`); later heartbeats get `Implementation lease for epoch N ended when GY-N was submitted; stop heartbeating after complete`.
- `park` (a human-only request naming every human step; file widenings (409) or deferred steps refused: `scope-request`) or `blocked` releases.
- Coordinator `capacity` (`event: "exhausted"`): freed for another account; like every attempt end, closes the attempt's scope request, lifting its refusal blocker.
- Expiry, classed by the epoch's ledger: unwithdrawn pre-release `blocked` report → `lease.expired` cause `blocked-awaiting-operator`; admin `--previous-worker-stopped` → `stopped-by-attestation`; `capacity.exhausted` → `exhausted-capacity`; none → `lease-loss` escalation, auto-settled once a record explains it, a newer attempt supersedes it, or 5 min after raising once every attempt ended with no lease or fence ([settling](../delegation.md#who-may-settle-what)).

## Blocked work unblocks itself

`blocked GY-N EPOCH REASON` commits uncommitted work (`WIP: GY-N attempt N blocked`), releases, carries `blocked on epoch N: REASON` to the next attempt. Each cycle (`blockers` step) loop classes standing blockers (`src/model/blocker-class.ts`) and probes them in the next worker's confinement: `github-credential`, `control-plane-error`, `sandbox-path`, `worktree-mismatch`, `outside-scope-test-failure`, `dispatch-failure`, `planned-file-scope`, `needs-decision` (approver); `host-supervisor` (masked user bus) on the loop's host, until the user manager answers and the loop unit is active. The prior `host supervision` step revives an unanswering user manager (`loginctl enable-linger`; retries 1, 2, 4 … ≤30 min; one failing `config` run until it answers) and `enable --now`s down declared `graphyard-executor@N` slots: never disabled ones (`systemctl --user disable --now`: permanent), not again within 10 min; 3 restarts within an hour of the first (manager-outage-ending starts excluded) mark it failed, down until it runs. It reports, never starts, `graphyard-master.service` under a loop outside it; manager-unreachable `is-active` reads `unreachable`, not down; such blockers are `blocker` faults, not `sandbox-blocker`. A pass (`POST /api/work/KEY/blocker-probe`) emits `blocker.cleared`; `genuine`, `human-only` and a fourth submissionless clear stay in `master status`. A scope blocker naming files but no commit is `planned-file-scope` (blocked attempt's kept head); `park` refuses (409) a decision naming files outside plannedFiles: that is a `scope-request`. Coordinator widenings of untouched backlog/ready items (unclaimed or only empty lapsed launches; unasked, unblocked) are planning, not `scope-widening`, until an attempt releases, submits or is reworked.
