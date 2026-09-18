# Operations and recovery

## Daily checks

- `/healthz` should return 200 and confirm database connectivity.
- Authenticated `/api/status` should show no persistent integration errors.
- Inspect the delivery graph for old work, stale observations, and blockers.
- Keep backups and verify a restore in an isolated environment periodically.
- Monitor Postgres size: events contain work snapshots and evidence is retained. The MVP has no automatic retention pruning.

## Master coordination loop

`graphyard master run` is the durable coordinator. Run it under systemd or Herdr, never as a chat
session: see [`examples/master/graphyard-master.service`](../examples/master/graphyard-master.service)
and the [operating guide](master-agent.md#durable-loop).

- **Health.** `graphyard master status` reports the loop under `daemon`. `running` is false when no
  cycle has completed within three intervals. `lagMs` is the age of the last cycle, `unresolved`
  lists actions interrupted mid-flight, and `escalations` lists what the loop deliberately left for
  a person. `journalctl --user -u graphyard-master` has the per-action log.
- **Restart.** Stop and start it freely. The cursor beside the coordinator credential is written
  before and after every external action and is reconciled against Graphyard on the next start, so a
  restart never re-dispatches an assignment that landed and never loses one that did not. Do not
  edit or delete the cursor to force a retry; change the Graphyard state the loop is reading.
- **Two loops.** A second daemon refuses while the first is alive. If a coordinator machine was
  reimaged or lost, the abandoned lock on another host clears after three intervals (at least two
  minutes); confirm the old process is really gone before starting elsewhere.
- **Stuck at a stage.** The loop does not clear blockers, revise requirements, release backlog work,
  approve reviews, or produce evidence, and it cannot: it holds only the coordinator credential. An
  item that stays put is waiting on an operator action recorded in `escalations` — reviewer capacity,
  an operator-witnessed proof, a blocker, or an approval.
- **Deployment lag.** `daemon.deployment` names the commit the running release serves and which
  delivered items it covers. Items under `pending` are merged but not yet live. It is an observation,
  never a gate; an unreachable probe reports `unavailable` and leaves every delivery pending rather
  than assuming it shipped.
- **Worker profiles.** A failed launch cools its profile off for ten minutes and work routes to
  another profile. `daemon.profiles` holds the reason. A profile that never recovers usually has an
  unreadable credential file or an agent name already taken in Herdr.

## Lost worker before submission

The lease expires after 120 seconds without a heartbeat. Reconciliation clears the lease; a new worker can claim with a higher epoch. Old API mutations refuse. Preserve the old worktree for inspection and create a new branch/path for the new attempt. Do not assume the old process has stopped merely because its lease expired.

## Blocked item with no owner

An operator can clear an existing blocker with `graphyard unblock GY-N "Contract verified"`. The CLI sends the task revision it just read and the reason is recorded in the event ledger; stale requests and attempts to clear no blocker are refused. Scoped operator agents similarly release unreleased backlog work with `graphyard ready GY-N "Requirements approved"`, which carries the current revision and reason. Workers may only clear their own blockers while holding the current lease. After the operator resolves an abandoned blocker and the old lease expires, a new worker can claim normally.

## Submitted implementation needs rework

An active owner may keep its heartbeat running and update the assigned branch. GitHub observations automatically invalidate old evidence after a push. To reassign: stop the previous worker, then run `graphyard rework GY-N --previous-worker-stopped "Reproduce review failure"` as an operator. This fences old API commands, closes the build gate, and wakes integration reconciliation. A new worker claims with a higher epoch and registers the existing PR branch in a fresh workspace, usually in another clone or on another host. Resubmit the same PR with the new epoch. Keep the old worktree for inspection. GitHub check revocation is asynchronous; suspend merging until the refusing check is visible. Merged work requires a follow-up item.

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

## Setup proposals and drift

`graphyard init --scan` replaces hand-authored setup with a reviewed proposal. The scan reads package manifests, CI workflows, deploy configuration, and the test layout, then writes `.graphyard/setup-proposal.json` (ignored by Git, mode 0600) proposing required check names, build/test commands with proof names, deploy verification, the candidate environment topology, review provider, worker/reviewer profiles for runtimes found on that machine, and the GitHub App registration. It changes nothing else.

`graphyard init --scan --apply` applies exactly the stored proposal after an operator review: it performs the GitHub App manifest flow, writes the managed `AGENTS.md` section, records principals and proof grants in `.graphyard/principals.json` (install the array as `GRAPHYARD_PRINCIPALS` on the deployment), and writes profile files under `.graphyard/profiles/`. Principals come only from the reviewed proposal: apply registers the operator, coordinator, and producer principals plus exactly the worker principals the proposal's profiles declare, so a machine with no agent runtime gets no worker credential rather than an unreviewed one; install an agent CLI and rerun `init --scan --apply` to add one. Applying is idempotent: unchanged artifacts are left alone, existing principal tokens are preserved so a re-run never invalidates a deployed configuration, operator-edited profiles are reported as drift and kept rather than overwritten, and a repository that changed after apply is reported as drift by later scans. If the repository changes between review and apply, apply refuses and the stored proposal is left untouched.

### Environment topology chosen by the scan

The candidate-bound-environment invariant is declared explicitly in every proposal: ephemeral where the stack allows, pooled or partial with data isolation where it does not.

| Detected stack | Deploy target | Topology chosen | Declaration |
| --- | --- | --- | --- |
| Node package with `railway.json`/`railway.toml` | Railway | `ephemeral` | Each candidate deploys to its own Railway environment built from its commit and destroyed after review; backing datastores must be per-candidate copies seeded from structure, never shared live state. |
| Python project with `Dockerfile`/compose | Container registry | `pooled` | Candidates deploy as isolated containers, but a shared backing datastore (compose database, driver dependency, or connection URL) was detected; every candidate must receive isolated data — a per-candidate schema or database seeded from structure only — so concurrent candidates cannot observe each other. |
| Static site (`index.html`, `.nojekyll`/`CNAME`) | GitHub Pages | `ephemeral` | Each candidate deploys to a disposable static target created from its own commit and discarded after review; nothing persists between candidates. |
| Any stack with no deploy configuration | none | `partial` | Only CI-level isolation exists; the operator must add a deploy target or accept partial environment verification, and any shared backing service requires declared data isolation between candidates. |

Railway, Vercel, and Fly detections choose the same ephemeral pattern as the Railway row, with target-specific SHA verification instructions (for example, comparing `RAILWAY_GIT_COMMIT_SHA`, Vercel deployment metadata, or `fly status` releases with the candidate SHA). Container deployments propose SHA-tagged images and digest verification. The pooled choice is deliberate conservatism: containers are disposable, but the detected datastore is not, so the proposal requires isolation instead of assuming per-candidate copies the platform has not promised.

Drift is informational, never auto-repaired: rerun `init --scan`, compare the refreshed proposal against what was applied, and reapply only after operator review. `graphyard doctor` reports the stored proposal, the applied setup record, and current drift.

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
