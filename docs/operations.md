# Operations and recovery

## Daily checks

- `/healthz` should return 200 and confirm database connectivity.
- Authenticated `/api/status` should show no persistent integration errors.
- Inspect the delivery graph for old work, stale observations, and blockers.
- Keep backups and verify a restore in an isolated environment periodically.
- Monitor Postgres size: events contain work snapshots and evidence is retained. The MVP has no automatic retention pruning.

## Lost worker before submission

The lease expires after 120 seconds without a heartbeat. Reconciliation clears the lease; a new worker can claim with a higher epoch. Old API mutations refuse. Preserve the old worktree for inspection and create a new branch/path for the new attempt. Do not assume the old process has stopped merely because its lease expired.

## Blocked item with no owner

An operator can clear the blocker with `graphyard unblock GY-N "Contract verified"`. The reason is recorded in the event ledger. Workers may only clear their own blockers while holding the current lease. After the operator resolves an abandoned blocker and the old lease expires, a new worker can claim normally.

## Submitted implementation needs rework

An active owner may keep its heartbeat running and update the assigned branch. GitHub observations automatically invalidate old evidence after a push. To reassign: stop the previous worker, then run `graphyard rework GY-N --previous-worker-stopped "Reproduce review failure"` as an operator. This fences old API commands, closes the build gate, and wakes integration reconciliation. A new worker claims with a higher epoch and registers the existing PR branch in a fresh workspace, usually in another clone or on another host. Resubmit the same PR with the new epoch. Keep the old worktree for inspection. GitHub check revocation is asynchronous; suspend merging until the refusing check is visible. Merged work requires a follow-up item.

## Worktree creation failed

The reservation is deliberately retained. Inspect Git output and the local branch/worktree state. If no files were created, an operator can run the exact intended Git worktree operation locally. If ownership expired, use a new attempt and fresh path. Never run blanket worktree deletion across worker machines.

## GitHub job fails

Jobs keep the error and retry after 45 seconds. Expired job leases are recoverable after 90 seconds. Check App installation access, permission changes, API availability, branch protection, and whether the PR still matches the registered branch. A task revision conflict during observation is usually a normal retry.

Own-App check webhooks are ignored. Other signed webhook deliveries wake jobs, but periodic polling is the fallback. Missing webhooks should delay progress rather than permanently strand it.

## GitHub or Graphyard outage

The database merge gate refuses observations older than two minutes. GitHub's last successful check may still exist; it does not expire automatically. Suspend merging operationally during an integration outage if this matters to your policy. The future merge-broker design should remove reliance on that manual outage response.

## Merge bypass

An observed merge with unsatisfied gates creates a permanent violation. Do not backfill evidence and pretend the merge was authorized. Inspect what bypassed protection, repair access rules, and create a follow-up investigation or repair task. v0.1 does not automatically revert code or deploy rollbacks.

## Credentials

Add or rotate principals in `GRAPHYARD_PRINCIPALS`, then redeploy. Use a unique ID for each worker identity and a unique secret for every principal. Rotation invalidates the old credential on restarted replicas; coordinate rolling replicas so old credentials do not remain accepted indefinitely. Revoke GitHub App keys separately from worker credentials.

The UI keeps its token in session storage. Sign out on shared machines. Producer credentials should be held by trusted reporters, never by arbitrary PR code. Logs intentionally omit tokens, but operator-provided blocker text and evidence URLs can still contain sensitive data; avoid submitting secrets as engineering metadata.

## Scale limits

The kernel serializes short coordination mutations. The initial reconciler processes up to four provider jobs per tick per replica. The list API returns all work, while the event API returns the most recent 300 events. These are deliberate MVP bounds, not a benchmark claiming hundreds of agents at production load. Monitor latency, database lock wait, job lag, memory, and GitHub rate limits before increasing concurrency.
