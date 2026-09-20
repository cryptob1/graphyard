<!-- page: Agent protocol | 3 | leases, supervision, workspaces. -->
# Leases, supervision and workspaces

For a worker or supervisor author: what ownership means and when it ends.

## Lease end and its cause

A lease ends when the worker submits, releases it or lets it expire 120 seconds after the last heartbeat, each end a `lease.expired` entry naming its cause.

- **`submitted`:** ended at `complete`.
- **`blocked-awaiting-operator`:** the worker recorded a `blocked` report and stopped to wait.
- **`stopped-by-attestation`:** an `admin` attested the stop with `rework` or `recover-containment --previous-worker-stopped`.

Only a lapse with none of those raises a `lease-loss` escalation ([who settles it](../delegation.md#who-may-settle-what)).

## Workspaces

Register the exact branch and a stable machine ID before submitting the pull request.

- **Branches:** must begin `graphyard/`; globally unique here.
- **Paths:** unique per host, historical reservations included, so use the assignment epoch in both names.
- **Normalization:** lexical; aliases through `..`, repeated separators and nested reservations on the same host rejected as overlaps.
- **Undetected:** the server resolves no remote symlink and cannot detect two host IDs naming one machine, so use canonical paths and stable host IDs.
- **Submitted rework:** `next` includes the item and `worktree` preserves the linked branch; fetch it first in a replacement clone: Git refuses a branch already checked out.
- **Registration:** host and path worker-reported, branch matching provider-observed.
- **Workspace cleanup:** manual, preserving uncommitted work.

## Foreground containment

A foreground contained launch persists an epoch-bound quarantine recording the exact systemd scope unit the session runs in (`graphyard-watch-PID-UUID.scope`) and the supervisor's pid; `watch` refuses to launch unless the confirmed quarantine names them.

- **Establishment:** uses a parent-only settlement capability and one request key per invocation, retries an ambiguous response with the same body and key, launches only on a confirmed one; the capability never enters the child environment or durable history.
- **Immediately before spawn:** the supervisor re-reads `work-snapshot` and requires the authenticated principal, live unexpired lease epoch, capability hash, exclusive-resource fence and exact epoch workspace registration to be unchanged; a stale, reassigned, expired, mismatched or ambiguous read never launches a child; a receipt replay is never launch authority. A 120-second launch-authority deadline recorded in that transaction stops an in-flight response authorizing a stale later spawn; requirements including exclusive resources stay immutable while quarantined.
- **Signal handlers:** installed before establishment and retained throughout; after SIGKILL the supervisor polls the scope until systemd reports it inactive or failed, only `LoadState=not-found` counts an unloaded transient scope as empty; manager connection errors stay unverifiable.
- **Settlement:** reuses one immutable capability-bearing body and idempotency key: 408 and 429 stay ambiguous, only a structured refusal on another 4xx is definitive, success must reconcile the exact epoch, capability hash and resource fence; persistent ambiguity fails closed with the quarantine retained.
- **Claims:** stay refused after lease expiry until settlement or an attested stop through rework. Once delivery reaches Done, `recover-containment --previous-worker-stopped` clears only the quarantine, preserving Done, candidate, merge, requirement, evidence and delivery history.

### Automatic containment settlement

A supervisor that dies without settling leaves a quarantine no capability can lower. `POST /api/work/UUID/autosettle` lets a `coordinator` or `admin` settle it by *proving* the supervisor is gone.

- **Body:** the quarantine's epoch and settlement hash, an audit reason and a host verification record.
 The control plane re-checks what it can and never trusts the report for it; all must hold:

- **Quarantine:** still exists at exactly that epoch and hash with no later epoch superseding it.
- **Expiry:** the worker lease and launch authority each expired for at least 120 seconds, measured from the lease deadline the quarantine retains; one recording no deadline refuses.
- **Verification:** names the host and path registered for that epoch, observed within the last 120 seconds, not dated after the control-plane clock, reporting clock bounds agreeing within five seconds.
- **Inspection:** it reports Linux process and systemd scope inspection finding no surviving process, no containment scope holding processes of the assigned workspace, and no signal it failed to collect.
