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

An operator can clear an existing blocker with `graphyard unblock GY-N "Contract verified"`. The CLI sends the task revision it just read and the reason is recorded in the event ledger; stale requests and attempts to clear no blocker are refused. Scoped operator agents similarly release unreleased backlog work with `graphyard ready GY-N "Requirements approved"`, which carries the current revision and reason. Workers may only clear their own blockers while holding the current lease. After the operator resolves an abandoned blocker and the old lease expires, a new worker can claim normally.

## Submitted implementation needs rework

An active owner may keep its heartbeat running and update the assigned branch. GitHub observations automatically invalidate old evidence after a push. To reassign: stop the previous worker, then run `graphyard rework GY-N --previous-worker-stopped "Reproduce review failure"` as an operator. This fences old API commands, closes the build gate, and wakes integration reconciliation. A new worker claims with a higher epoch and registers the existing PR branch in a fresh workspace, usually in another clone or on another host. Resubmit the same PR with the new epoch. Keep the old worktree for inspection. GitHub check revocation is asynchronous; suspend merging until the refusing check is visible. Merged work requires a follow-up item.

## Accepted evidence turns out to be wrong

A trusted run can be invalidated after it was accepted — the wrong artifact was measured, the runner is now known to have been misconfigured, or the reported result was withdrawn upstream. Revoking is narrower than a requirement revision: it leaves criteria, policy revision, review and the submitted attempt untouched and only withdraws the runs that no longer stand.

```sh
cat > revoke.json <<'JSON'
{ "proof": "integration:claim-safety", "sha": "HEAD_SHA", "baseSha": "BASE_SHA", "policyRevision": 1,
  "reason": "Producer retracted the reported run" }
JSON
graphyard revoke GY-N revoke.json
```

Run it as an operator, or as the producer allowlisted for that proof; nobody else may. The acceptance gate closes immediately and names the withdrawal, merge authorization is dropped, an in-flight merge execution is cancelled rather than waited out, and reconciliation republishes a refusing GitHub check. Do not wait for that check before revoking — the ledger is authoritative the moment the command returns, and the [merge broker](github.md#enforcement-boundary) refuses the candidate whether or not GitHub has caught up. A fresh trusted run for the same candidate re-authorizes it; delivered work is immutable and needs a follow-up item instead.

## Worktree creation failed

The reservation is deliberately retained. Inspect Git output and the local branch/worktree state. If no files were created, an operator can run the exact intended Git worktree operation locally. If ownership expired, use a new attempt and fresh path. Never run blanket worktree deletion across worker machines.

## GitHub job fails

Jobs keep the error and retry after 45 seconds. Expired job leases are recoverable after 90 seconds. Check App installation access, permission changes, API availability, branch protection, and whether the PR still matches the registered branch. A task revision conflict during observation is usually a normal retry.

Own-App check webhooks are ignored. Other signed webhook deliveries wake jobs, but periodic polling is the fallback. Missing webhooks should delay progress rather than permanently strand it.

## GitHub or Graphyard outage

The database merge gate refuses observations older than two minutes. GitHub's last successful check may still exist; it does not expire automatically. Routine master merges acquire a short-lived server authority, transactionally record a final GitHub verification, and freeze relevant Graphyard mutations around the exact-head provider call. A direct GitHub merge has no verified execution and cannot complete its Graphyard work item. Repository rules must restrict alternative merge identities when the merge itself must also be prevented during an outage.

## Merge bypass

An observed merge with unsatisfied gates creates a permanent violation. Do not backfill evidence and pretend the merge was authorized. Inspect what bypassed protection, repair access rules, and create a follow-up investigation or repair task. v0.1 does not automatically revert code or deploy rollbacks.

## Credentials

Scoped post-bootstrap operator automation uses the transactional credential registry and secret-safe CLI described in [Scoped operator-agent automation](operator-automation.md). It must never use an entry from `GRAPHYARD_PRINCIPALS` with the `admin` role.

Add or rotate principals in `GRAPHYARD_PRINCIPALS`, then redeploy. Use a unique ID for each coordinator and worker identity and a unique secret for every principal. Rotation invalidates the old credential on restarted replicas; coordinate rolling replicas so old credentials do not remain accepted indefinitely. Revoke GitHub App keys separately from worker credentials. A coordinator is read-only at the Graphyard API boundary; its local GitHub CLI access separately controls whether it can invoke the guarded routine-merge flow.

The UI keeps its token in session storage. Sign out on shared machines. Producer credentials should be held by trusted reporters, never by arbitrary PR code. Logs intentionally omit tokens, but operator-provided blocker text and evidence URLs can still contain sensitive data; avoid submitting secrets as engineering metadata.

Environment files, `.graphyard/`, and private-key file extensions are excluded from Git and Docker build context. Only `.env.example` is allowed in Git. CI runs a pinned, checksum-verified Gitleaks release against all fetched history. GitHub secret scanning and push protection are enabled on the public upstream repository. A clean scan is not a guarantee against unknown secret formats: if a credential is ever committed, revoke it first, then handle history and cached copies. Local Compose and isolated-test passwords are public development fixtures, never production credentials.

## Scale limits

The kernel serializes short coordination mutations. The initial reconciler processes up to four provider jobs per tick per replica. The list API returns all work, while the event API returns the most recent 300 events. These are deliberate MVP bounds, not a benchmark claiming hundreds of agents at production load. Monitor latency, database lock wait, job lag, memory, and GitHub rate limits before increasing concurrency.

## Dashboard connection and keyboard behavior

The dashboard verifies the access token before displaying work or integration status. Leading and trailing whitespace is removed from pasted tokens. A rejected or revoked token returns to the login form with an explicit error and clears previously loaded work. During initial verification, unknown counts are not presented as zero and unknown GitHub connectivity is not reported as disconnected.

After a successful load, polling failures retain the last snapshot with a disconnected/stale-data warning and last-success timestamp. Polling retries every five seconds; requests time out after fifteen seconds. A successful refresh clears the warning. The snapshot is informational: the server still authorizes every mutation. Sign out remains available on narrow screens and clears the browser session token.

Work details, new-work forms, and test-case forms move keyboard focus inside when opened. Tab and Shift-Tab remain inside the dialog, Escape closes it, and focus returns to the opening control.

Run `npm run test:browser` after `npx playwright install chromium` to exercise these behaviors in headless Chromium. The tests serve the UI locally and intercept API calls with isolated fixtures. They cover client behavior, not server authorization or successful production writes; the real-Postgres and protected acceptance suites cover coordination separately. Required CI runs both the ordinary tests and browser regressions.

Signing out invalidates pending work mutations and their dashboard refreshes locally. Responses from a previous session cannot restore its data or errors after another token is entered. A write already accepted by the server remains in the work ledger.

The work-detail History panel retains its last loaded entries during periodic refresh and temporary event-fetch failures. Selecting different work or ending the session clears those entries.

### Bounded work history

The work detail drawer shows 20 history entries at a time inside a keyboard-accessible, height-limited scroll area. Consecutive GitHub observations from the same actor are grouped with a count and time range; this groups observation activity, not a claim that their payloads are identical. Turn off grouping to inspect individual event rows, and use **Show more history** or **Show less history** to change the visible count. Refreshes preserve this choice; opening another work item resets it.

The dashboard receives the latest 300 events per work item. Its display limits do not delete or truncate the append-only database audit ledger; older events remain in storage.
### Concurrent reconciliation

If a task changes while GitHub is being read, or the integration lease expires before a review request can be recorded, Graphyard rejects that stale snapshot and schedules another observation after two seconds (or immediately when newer work has already queued a wakeup). This expected concurrency retry does not appear as an integration error in the dashboard. The existing revision and job-lease checks still prevent stale success publication, and failed checks are conservatively revoked where possible. Actual integration failures, such as API or permission errors, remain visible and retry durably.

## Coordination diagnosis and recovery drills

Use `graphyard diagnose GY-N` or the work-detail Coordination section for concrete next steps. See [coordination](coordination.md) for requirement revisions, overlap warnings, declared-resource reservations and the two-machine drill. A drill procedure is not completed execution evidence.
