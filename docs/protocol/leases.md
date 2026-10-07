<!-- page: Agent protocol | 3 | leases, workspaces, `watch`, blockers. -->
# Leases, workspaces and supervision

Claims last 120 s, renewed every ≤30 s; owner mutations carry the epoch, and expired epochs stay refused. Before submitting, register branch, path and host (`graphyard register GY-1 workspace.json`): branches (`graphyard/…`) are globally unique, paths unique per host. `graphyard worktree` [frees the branch](../coordination.md#dispatch-optimistically-smallest-scope-first) first.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` strips Graphyard credentials; lease loss sends SIGTERM, then SIGKILL, to the process group. Contained launches record a quarantine naming their systemd scope unit. A dead supervisor fences the item until an operator attests the stop or `POST /api/work/UUID/autosettle` (`coordinator`/`admin`) proves authority expired 120+ s ago with nothing alive; an attempt the loop ended on its record (exhaustion, closed submitted session) with its supervisor verified gone settles in that ending action. A supervisor unable to settle records why; 5xx or stale-verification refusals retry next cycle. The loop's settlement sends `origin: "loop"` and the server records the fence's `lapsedAt`; [interventions](../dashboard.md) count it only past grace plus 10 minutes, a hand settlement always.

### Push credential

Workers never push via host `gh` logins: launchers mint into `worker-sessions/GY-N-EPOCH` (0700) and set `GH_CONFIG_DIR`. `POST /api/work/UUID/push-credential` `{"epoch": N}` (`graphyard push-credential GY-N EPOCH DIR`) mints an unstored App token (`contents`, `pull_requests`, `workflows` write) expiring by claim + 4h, refused for lapsed or submitted epochs or a base queue allowing App bypass. `watch` re-mints near expiry and revokes at session end.

A GitHub credential failure ends the attempt `blocked`, branch kept; once the `github-credential` blocker clears it relaunches, backing off; a third consecutive failure holds the item for an approver.

## How a lease ends

- `submit` (CLI `complete`); later heartbeats get `Implementation lease for epoch N ended when GY-N was submitted; stop heartbeating after complete`.
- `park`: records a human-only request naming every human step at once (a scope widening or a deferred step is refused: use `scope-request`), releases; `blocked` with a reason records the blocker, releases, keeps partial work.
- Coordinator `capacity` report (`event: "exhausted"`): freed for another account.
- Expiry, classified by the epoch's ledger: unwithdrawn `blocked` report (from before a blocked release) → `lease.expired` cause `blocked-awaiting-operator`; admin `--previous-worker-stopped` → `stopped-by-attestation`; `capacity.exhausted` → `exhausted-capacity`; none → `lease-loss` escalation, auto-settled once a record explains it, a newer attempt supersedes it, or 5 min after raising once every attempt has ended with no lease and no fence ([settling](../delegation.md#who-may-settle-what)).

## Blocked work unblocks itself

`blocked GY-N EPOCH REASON` commits uncommitted work (`WIP: GY-N attempt N blocked`), releases the lease and carries `blocked on epoch N: REASON` to the next attempt. Each cycle (`blockers` step) the loop classes standing blockers (`src/model/blocker-class.ts`) and probes them in the next worker's confinement: `github-credential`, `control-plane-error`, `sandbox-path`, `worktree-mismatch`, `outside-scope-test-failure`, `dispatch-failure`, `planned-file-scope`, `needs-decision` (approver). A pass, recorded via `POST /api/work/KEY/blocker-probe`, emits `blocker.cleared`; `genuine` and `human-only` blockers, and a fourth clear without a submission, stay for someone in `master status`.
