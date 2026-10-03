<!-- page: Agent protocol | 3 | leases, workspaces, `watch`, blockers. -->
# Leases, workspaces and supervision

Claims last 120 s; renew every ≤30 s. Owner mutations carry the epoch; expired epochs stay refused. Register branch, path, host ID (`graphyard register GY-1 workspace.json`) before submitting. Branches (`graphyard/…`) are globally unique, paths unique per host including past reservations; both carry the epoch.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` strips Graphyard credentials and, on lease loss, SIGTERMs then SIGKILLs its process group (no sandbox). Contained launches first record a **quarantine** naming their systemd scope unit. A dead supervisor fences the item until an operator attests the stop, or `POST /api/work/UUID/autosettle` (`coordinator`/`admin`) proves authority expired 120+ s ago and no supervisor, workspace process or scope member lives. Verification records ≤200 processes per scope (more is judged live) and ≤50 scopes.

### Push credential

Workers never push with the host's `gh` login. The launcher keeps a credential in `worker-sessions/GY-N-EPOCH` (0700, files 0600) via `GH_CONFIG_DIR`, emptying `GH_TOKEN`/`GITHUB_TOKEN`. `POST /api/work/UUID/push-credential` `{"epoch": N}` (lease holder only; `graphyard push-credential GY-N EPOCH DIR`) mints an unstored App token (`contents`, `pull_requests`, `workflows` write) within the 4-hour lease bound, never for lapsed, submitted or overdue epochs; `watch` re-mints near expiry and revokes at session end. A base merge queue allowing App bypass refuses minting (409).

**Limitation (GY-1066):** no token is minted (409) while a base merge queue lets the App bypass it or hides its bypass list, so a ruleset making the control-plane App its bypass actor launches no worker (the launch failure says so); a transient ruleset read is a retryable 502.

A GitHub credential failure (git's or `gh`'s refusal, or a 401 naming GitHub) ends the attempt with its `blocked` report, keeping its work; once the `github-credential` blocker clears the item relaunches with a fresh credential. Each counts as a failed attempt: relaunches wait 5, then 15 minutes; a third in a row holds for an approver.

## How a lease ends

- `submit` (CLI `complete`); later heartbeats are refused.
- `park` (files a human-only request); `blocked` with a reason (records the blocker, keeps partial work).
- Coordinator `capacity` report (`event: "exhausted"`): freed for another account.
- Expiry, by the epoch's ledger: unwithdrawn `blocked` report → `lease.expired` cause `blocked-awaiting-operator`; admin `--previous-worker-stopped` → `stopped-by-attestation`; `capacity.exhausted` → `exhausted-capacity`; nothing → `lease-loss` escalation, auto-settled once a record explains it ([settling](../delegation.md#who-may-settle-what)).

## Blocked work unblocks itself

`blocked GY-N EPOCH REASON` commits uncommitted work (`WIP: GY-N attempt N blocked`) and releases the lease in the blocker's transaction; the capacity record carries `blocked on epoch N: REASON` for the next attempt. Each cycle (`blockers` step) the loop classes every standing blocker (`src/model/blocker-class.ts`), probing credentials and paths in the confinement the next worker gets (an unconfinable probe fails).

| Class | Probe, every cycle | Cleared when |
| --- | --- | --- |
| `github-credential` | `gh auth status`, `git ls-remote`, `git push --dry-run` under the attempt's own launch | all pass |
| `control-plane-error` | server health | healthy |
| `sandbox-path` | write the path (`.git/` via `git rev-parse --git-path`) in that sandbox | it succeeds |
| `worktree-mismatch` | the attempt's lease | ended |
| `outside-scope-test-failure` | base branch tip | moved |
| `planned-file-scope` | additive `requirements` widening for the approver | files covered |
| `needs-decision` | approver launched and supervised | none requested |

Probes are recorded (`POST /api/work/KEY/blocker-probe`) on change or every five minutes; a pass clears the blocker (`blocker.cleared`). `genuine` and `human-only` blockers, a fourth clear without a submission, and scope no fold fits never clear; they need someone in `master status` and the board (class, last and next probe).
