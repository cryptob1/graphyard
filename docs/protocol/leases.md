<!-- page: Agent protocol | 3 | leases, workspaces, `watch`, blockers. -->
# Leases, workspaces and supervision

Claims last 120 seconds, renewed at least every 30. Every owner mutation carries the epoch; an expired epoch is refused and cannot be revived.

## Workspaces

Register the exact branch, path and host ID (`graphyard register GY-1 workspace.json`) before submitting. Branches begin `graphyard/`, globally unique; paths are unique per host (historical reservations included); put the epoch in both. `graphyard worktree` detaches an earlier attempt's worktree still holding the branch (ending any rebase, merge or cherry-pick) after recording its refs and diff; the branch never moves. A worktree it cannot build releases the claim without spending the epoch or cooling the profile; redispatch backs off, doubling.

## `watch`

`graphyard watch GY-N EPOCH -- COMMAND` strips Graphyard credentials from the child and on lease loss sends SIGTERM, then SIGKILL, to the process group; it is no sandbox. A contained launch first records a **quarantine** naming its systemd scope unit. If the supervisor dies, the item is fenced until `POST /api/work/UUID/autosettle` (`coordinator` or `admin`) proves authority expired 120 seconds ago and no supervisor, workspace process or scope member is alive, or an operator attests the stop. The wait is waived when the record shows the loop ended that attempt (a worker exhaustion, or its close of a submitted session) and the supervisor is verified gone, so the loop settles in the ending action. A supervisor unable to lower its fence notes why on the item; a 5xx or stale-verification refusal is retried next cycle. The host verification records each process list up to its bound (200 per scope) with the full count and `truncated: true`; a truncated scope is judged live, so it fences its own quarantine and any quarantine it still holds processes for, while other quarantines in the same verification settle normally. A host with more than 50 containment scopes records the first 50 and the full count, and refuses every settlement, because an unrecorded scope cannot be proven stopped. Settlement excuses only the recorded pane's idle, childless shell, which the loop closes. The loop bounds its host clock against the plane's with one timed `HEAD /` a cycle, taken only while a quarantine on that host is past its grace window. The `Date` header is the answering hop's clock, so a proxy or edge in front of the plane must keep time with it. Should the read fail, the snapshot read's wider bound stands; a bound wider than the 5 s tolerance is refused naming the read and its round trip, and that escalation is recorded again only when its cause changes, not the measurement.

### Push credential

A worker never pushes with the host's `gh` login: its session bus is masked, so the keyring behind `gh auth git-credential` is unreachable (GY-999). Before a worker starts, the launcher mints its credential into `worker-sessions/GY-N-EPOCH` beside the profile's credential file (0700, files 0600) and sets `GH_CONFIG_DIR` there, empties `GH_TOKEN`/`GITHUB_TOKEN`, resets every git credential helper to one reading that token, and pushes ssh origins over https; a launch that cannot mint one is refused and its claim released. `POST /api/work/UUID/push-credential` with `{"epoch": N}` (the lease holder only; CLI `graphyard push-credential GY-N EPOCH DIR`) mints a Graphyard App installation token for this repository alone with `contents`, `pull_requests` and `workflows` write (a base sync may carry a workflow change), asking only for those the installation grants: a missing one is left out and raised as `appPermissions` attention naming it and `master browser installation-accept`, never a failed launch (GY-1100); its stated expiry capped at the **lease bound** (claim plus the 4-hour implementation time box); nothing is minted for a lapsed, submitted or overdue epoch — checked again after the mint, revoking a token whose lease moved meanwhile — and the token is never stored. When `GH_CONFIG_DIR` holds that attempt's credential, `watch` re-mints it within 15 minutes of expiry on a renewal, revoking the old token, and revokes and removes it when the session ends; a token GitHub does not confirm revoking (204, or 401) is kept in `revoke.json` until it does or expires, and a killed supervisor's expired credential is revoked and removed at that profile's next launch.

**Limitation (GY-1066):** no token is minted (409) while a merge queue on the base lets the App bypass it, or its bypass list is hidden from the App, because that token could merge past the queue. An organization repository whose managed ruleset makes the control-plane App its bypass actor therefore launches no worker until workers push as a separate App the queue does not exempt, which Graphyard does not provide yet; the launch failure names this. A ruleset GitHub fails to answer transiently is a retryable 502.

An attempt blocked by a GitHub credential failure (git's or `gh`'s own refusal, or a 401 naming GitHub) ends with its `blocked` report, keeping its work on its branch; the loop closes its pane, and once the `github-credential` blocker clears the item is relaunched with a fresh credential. Each such ending counts as a failed attempt, as one that outruns its time box does: relaunches wait 5, then 15 minutes, and a third in a row holds the item for an approver's decision.

## How a lease ends

- `submit` (CLI `complete`) ends it; later heartbeats are refused with `Implementation lease for epoch N ended when GY-N was submitted; stop heartbeating after complete`.
- `park` records a human-only request and releases it; `blocked` with a reason records the blocker and releases it, keeping the attempt's partial work.
- A coordinator `capacity` report (`event: "exhausted"`) releases it for another account.
- Otherwise it expires, classified from the unsubmitted epoch's ledger: an unwithdrawn `blocked` report (only rows from before a blocked report released the lease itself) is `lease.expired` with cause `blocked-awaiting-operator`; an admin `--previous-worker-stopped` attestation is `stopped-by-attestation`; `capacity.exhausted` is `exhausted-capacity`; nothing is a `lease-loss` escalation, auto-settled if a record later explains it ([settling](../delegation.md#who-may-settle-what)).

## Blocked work unblocks itself

`blocked GY-N EPOCH REASON` commits uncommitted work (`WIP: GY-N attempt N blocked`) and, in the blocker's transaction, releases the lease; the capacity record carries `blocked on epoch N: REASON` (`credential-blocked attempt on epoch N` for a GitHub credential failure) for the next attempt. Each cycle (`blockers` step) the loop classes every standing blocker (`src/model/blocker-class.ts`). Credential and path probes run in the confinement the next worker gets: its runtime sandbox, inside the read-only coordinator mount every non-sandboxed runtime starts in; a probe that cannot be confined fails.

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
