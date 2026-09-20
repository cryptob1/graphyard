<!-- page: Agent protocol | 3 | leases, supervision, containment, workspaces. -->
# Leases, supervision and workspaces

For a worker or supervisor author: what ownership means and when it ends.

## Lease end and its cause

A lease ends when the worker submits, releases it or lets it expire 120 seconds after the last heartbeat; each end is a `lease.expired` entry naming its cause. `submitted` means it ended at `complete`; `blocked-awaiting-operator` that the worker recorded a `blocked` report and stopped to wait; `stopped-by-attestation` that an `admin` attested the stop with `rework` or `recover-containment --previous-worker-stopped`. Only a lapse with none of those raises a `lease-loss` escalation ([who settles it](../delegation.md#who-may-settle-what)).

## Workspaces

Register the exact branch and a stable machine ID before submitting the pull request. Branches must begin `graphyard/` and are globally unique in this control plane; paths are unique per host, including historical reservations, so use the assignment epoch in both names. Paths are normalized lexically, and aliases through `..`, repeated separators and nested reservations on the same host are rejected as overlaps; the server cannot resolve remote symlinks or detect two host IDs naming one machine, so use canonical paths and stable host IDs. For submitted rework, `next` includes the item and `worktree` preserves the linked branch — fetch it first in a replacement clone, because Git refuses a branch already checked out locally. Host and path registration is worker-reported while branch matching is provider-observed, and workspace cleanup is manual and must preserve uncommitted work.

## Foreground containment

A foreground contained launch persists an epoch-bound quarantine recording the exact systemd scope unit the session runs in (`graphyard-watch-PID-UUID.scope`) and the supervisor's pid; `watch` refuses to launch unless the confirmed quarantine names them.

- Establishment uses a parent-only settlement capability and one request key per invocation, retries ambiguous responses with the same body and key, and launches only on a confirmed response; the capability never enters the child environment or durable history.
- Immediately before spawn the supervisor re-reads `work-snapshot` and requires the authenticated principal, live unexpired lease epoch, capability hash, exclusive-resource fence and exact epoch workspace registration to be unchanged. A stale, reassigned, expired, mismatched or ambiguous read never launches a child, and a receipt replay is never launch authority.
- A separate 120-second launch-authority deadline recorded in that transaction stops an in-flight response authorizing a stale later spawn. While quarantined, requirements including exclusive resources stay immutable.
- Signal handlers are installed before establishment and retained through reconciliation, verification and settlement. After SIGKILL the supervisor polls the scope until systemd reports it inactive or failed; only `LoadState=not-found` counts an unloaded transient scope as empty, and manager connection errors stay unverifiable.
- Settlement reuses one immutable capability-bearing body and idempotency key: 408 and 429 stay ambiguous, only a structured refusal on another 4xx is definitive, and success must reconcile the exact epoch, capability hash and resource fence. Persistent ambiguity fails closed with the quarantine retained.
- Claims stay refused after lease expiry until settlement or an attested stop through rework. Once delivery reaches Done, `recover-containment --previous-worker-stopped` clears only the quarantine, preserving Done, candidate, merge, requirement, evidence and delivery history.

### Automatic containment settlement

A supervisor that dies without settling leaves a quarantine no capability can lower. `POST /api/work/UUID/autosettle` lets a `coordinator` or `admin` settle it by *proving* the supervisor is gone, carrying the quarantine's epoch and settlement hash, an audit reason and a host verification record. The control plane re-checks what it can itself and never trusts the report for those facts:

- the quarantine still exists at exactly that epoch and hash, and no lease of another epoch supersedes it;
- the worker lease and the launch authority have each been expired for at least a 120-second grace window, measured from the lease deadline the quarantine retains; a quarantine recording no lease deadline refuses;
- the verification names the host and path registered for that epoch, was observed within the last 120 seconds, is not dated after the control-plane clock, and reports clock bounds agreeing within five seconds;
- it reports Linux process and systemd scope inspection that found no surviving process, no containment scope holding processes of the assigned workspace, and no signal it failed to collect.

