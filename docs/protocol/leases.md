<!-- page: Agent protocol | 3 | leases, workspaces, `watch`, blockers. -->
# Leases, workspaces and supervision

Claims last 120 seconds, renewed at least every 30. Every owner mutation carries the epoch; an expired epoch is refused and cannot be revived.

## Workspaces

Register the exact branch, path and host ID (`graphyard register GY-1 workspace.json`) before submitting. Branches begin `graphyard/`, globally unique; paths are unique per host (historical reservations included); put the epoch in both.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` strips Graphyard credentials from the child and on lease loss sends SIGTERM, then SIGKILL, to the process group; it is no sandbox. A contained launch first records a **quarantine** naming its systemd scope unit. If the supervisor dies, the item is fenced until `POST /api/work/UUID/autosettle` (`coordinator` or `admin`) proves authority expired 120 seconds ago and no supervisor, workspace process or scope member is alive, or an operator attests the stop. Settlement excuses only the recorded pane's idle, childless shell, which the loop closes.

## How a lease ends

- `submit` (CLI `complete`) ends it; later heartbeats are refused with `Implementation lease for epoch N ended when GY-N was submitted; stop heartbeating after complete`.
- `park` records a human-only request and releases it; `blocked` with a reason records the blocker and releases it, keeping the attempt's partial work.
- A coordinator `capacity` report (`event: "exhausted"`) releases it for another account.
- Otherwise it expires, classified from the unsubmitted epoch's ledger: an unwithdrawn `blocked` report (only rows from before a blocked report released the lease itself) is `lease.expired` with cause `blocked-awaiting-operator`; an admin `--previous-worker-stopped` attestation is `stopped-by-attestation`; `capacity.exhausted` is `exhausted-capacity`; nothing is a `lease-loss` escalation, auto-settled if a record later explains it ([settling](../delegation.md#who-may-settle-what)).

## Blocked work unblocks itself

`blocked GY-N EPOCH REASON` commits uncommitted work (`WIP: GY-N attempt N blocked`) and, in the blocker's transaction, releases the lease; the capacity record carries `blocked on epoch N: REASON` for the next attempt. Each cycle (`blockers` step) the loop classes every standing blocker (`src/model/blocker-class.ts`):

| Class | Probe, every cycle | Cleared when |
| --- | --- | --- |
| `github-credential` | `gh auth status`, `git ls-remote`, `git push --dry-run` under the attempt's own launch | all pass |
| `control-plane-error` | server health | healthy |
| `sandbox-path` | write the path (`.git/` via `git rev-parse --git-path`) in that sandbox | it succeeds |
| `worktree-mismatch` | the attempt's lease | ended |
| `outside-scope-test-failure` | base branch tip | moved |
| `planned-file-scope` | additive `requirements` widening for the approver | files covered |
| `needs-decision` | approver launched and supervised | none requested |

Probes are recorded (`POST /api/work/KEY/blocker-probe`) on change or every five minutes; a pass clears the blocker (`blocker.cleared`, naming the probe). The plane refuses to clear a `genuine` or `human-only` blocker, or a fourth clear without a submission; only those, and scope no fold fits under the plannedFiles cap, need someone in `master status` and the board (class, last and next probe).
