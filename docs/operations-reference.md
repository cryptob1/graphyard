<!-- page: Operate Graphyard | 7 | every procedure in full, credentials, proof authority, drift, and scale limits. -->
# Operations reference

The full detail behind the [operations page](operations.md): the perpetual master loop and its terminal condition, every recovery procedure, credentials, proof authority, the readiness checklist, setup drift, scale limits, and dashboard behaviour. Terms follow the [glossary](glossary.md).

## Perpetual master loop

Keep a dedicated master coordinator running until both parts of the terminal
condition hold: (1) every in-scope item is Done or has a genuinely external blocker
recorded in Graphyard; and (2) every merged change is deployed and live-verified against
the exact deployed release, or a genuinely external deployment blocker is recorded
in Graphyard. Repeatedly run status, dispatch ready work, shepherd review and trusted
proof collection, request guarded merges, and verify deployment and live behavior
against the exact deployed release. Close finished agent sessions and return to
status after every material event. The [durable loop](#master-coordination-loop)
runs the mechanical steps; the coordinator's judgment calls sit on top of it and
follow the same terminal condition.

Ordinary review findings, rework, idle workers, and proof setup are not stopping
conditions. They are work for the coordinator to route and follow through. A local
or stale check is not deployment verification, and blockers must be recorded in
Graphyard rather than inferred from an inactive session. Done marks an observed
merge, so it never authorizes stopping before deployment and live verification
against the exact deployed release.

Blockers have exactly two records. A per-item blocker is written by the lease holder
with `graphyard blocked GY-N EPOCH "reason"` and cleared as described under
[blocked item with no owner](#blocked-item-with-no-owner). A deployment blocker
cannot be written on the delivered item — delivered work is immutable — so it is a
follow-up work item that names the delivered item, its merge commit, and the
genuinely external cause. Until that release is live-verified, `daemon.deployment`
lists the delivery under `pending` (or `unavailable` when no probe answers) and
`delivered` keeps it `awaiting-deployment` or `awaiting-smoke`; those observations
are the coordinator's evidence that verification is still owed, and the follow-up
item is the only record that lets the loop stop without it. Never satisfy the
deployment step from a local checkout, a stale observation, or a delivery the
release has since moved past.

The deployment step is `master verify-deployment GY-N`, run once per delivered item
after the merge is observed; it is never a pre-merge gate. It observes the deployed
release through the probe configured with `master init --deployment-url`, checks
that the launcher checkout is that exact release with no uncommitted changes, reads
the instructions the release emits (`master guide`, and a fresh `init` into a scratch
checkout outside the repository), and records the observation on the item bound to
the exact commit observed. Each refusal names its cause and the fix:

- *unobserved*: no probe is configured or it did not answer — configure
  `--deployment-url` or wait for the endpoint, then rerun;
- *stale*: the observation is older than five minutes — rerun; the command observes
  afresh each time;
- *does not serve the merge yet*: the rollout is lagging — keep cycling; record a
  follow-up item only for a genuinely external cause;
- *local checkout*: the launcher is at another commit or is dirty — `git fetch` and
  check out the deployed commit in the Graphyard checkout, then rerun;
- *already records deployment*: the release moved on after verification — verify
  the new release through a follow-up item.

## Daily checks

- `/healthz` should return 200, confirm database connectivity, and name the release (`version`, `revision`), the deployed `commit` and the schema generation you expect to be running.
- Authenticated `/api/status` should show no persistent integration errors, no `delegationLimits.attention`, and no open `production.incidents`.
- Inspect the delivery graph for old work, stale observations, and blockers.
- Keep backups and verify a restore in an isolated environment periodically: `graphyard db backup`, `db verify` and `db restore` are the shipped procedure — see [backup, upgrade, rollback](deployment.md#backup-upgrade-rollback).
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
  item that stays put is waiting on a human-operator action recorded in `escalations` — reviewer
  capacity, an operator-witnessed proof, a blocker, or an approval.
- **Deployment lag.** `daemon.deployment` names the commit the running release serves and which
  delivered items it covers. Items under `pending` are merged but not yet live. It is an observation,
  never a gate; an unreachable probe reports `unavailable` and leaves every delivery pending rather
  than assuming it shipped.
- **Post-deploy proof.** For a delivery whose policy sets `deploySmoke`, the loop records the
  deployment on the item once the release serves its merge, requests the trusted smoke workflow
  (`--smoke-workflow`), and escalates a failed verdict with rollback guidance. `delivered` in master
  status lists each such item with its state: `awaiting-deployment`, `awaiting-smoke`,
  `smoke-passed`, or `delivered-with-failure`. `counts.awaitingSmoke` and `counts.postDeployFailures`
  total them, and the cycle metrics carry `production` (creation to observed deployment),
  `postDeploy` (merge to verdict) and `postDeployFailures`.
- **Worker profiles.** A failed launch cools its profile off for ten minutes and work routes to
  another profile. `daemon.profiles` holds the reason. A profile that never recovers usually has an
  unreadable credential file or an agent name already taken in Herdr.
- **GitHub administration.** `master status` reports browser-driven administration under
  `administration`: the last five audit entries with who did what and whether the API verified it,
  and `sudo` when a flow is waiting on GitHub's *Confirm access* prompt — approve it on your device
  and choose the two-digit code shown. A refused flow names its record directory under
  `.graphyard/master-actions/`; `record.json` and the numbered screenshots show exactly what the
  page offered. See [GitHub administration through the browser](master-agent.md#github-administration-through-the-browser).

## Lost worker before submission

The lease expires after 120 seconds without a heartbeat. Reconciliation clears the lease; a new worker can claim with a higher epoch. Old API mutations refuse. Preserve the old worktree for inspection and create a new branch/path for the new attempt. Do not assume the old process has stopped merely because its lease expired.

The lapse is classified from the events ledger when it is recorded. A `blocked` report the worker recorded for that epoch and did not withdraw, or a `rework --previous-worker-stopped` / `recover-containment --previous-worker-stopped` attestation the human operator recorded for it, makes the lapse `lease.expired` history with its cause (`blocked-awaiting-operator`, `stopped-by-attestation`), and nothing escalates. Only a lapse nothing explains — a worker that silently vanished — raises a `lease-loss` escalation, which refuses the merge gate until a declared human session resolves it. If you stopped the worker yourself, attest it with `rework --previous-worker-stopped`; an attestation recorded after the lapse settles a standing `lease-loss` for that epoch on the next tick (`escalation.auto-settled`), or any `admin` settles it at once with `graphyard resolve GY-N lease-loss --attestation stopped-worker "reason"` (`--attestation blocked` for a carried report); the server verifies the citation against the ledger. See [slice-lead delegation](delegation.md#who-may-settle-what).

## Supervisor died leaving a containment quarantine

A foreground worker's supervisor settles its containment quarantine on verified shutdown. If the supervisor itself dies first, the fence stays up on purpose: the item is undispatchable, its exclusive resources stay reserved, and its requirements stay immutable. Expired authority is not evidence that a process stopped.

Two paths lower it. On the machine that ran the worker, `graphyard master settle-containment GY-N "reason"` verifies, on that host, that the worker lease and launch authority have both been expired past their grace window — the lease deadline is retained on the quarantine, so reconciliation clearing the lease record does not shorten it — and that no supervisor process, no workspace process, and no live containment scope holding a process it cannot attribute to another assignment survives; the control plane re-checks all of it and records the verification. `master status` shows the same assessment per work row under `containment` before you run anything: the recorded scope unit and supervisor pid (`containment.scope`), what systemd reports for that unit, and every process still holding the fence (`containment.held`) with its pid, command line, and working directory. Anything it cannot prove — an unreachable host, a failed scope or process query, a surviving process, disagreeing clocks — refuses, and the refusal prints the same list. Read it before stopping anything: a neighbouring `graphyard-watch-*` scope is attributed to the live supervisor whose pid its name carries, so another item's running worker is not this item's fence, and a process you cannot attribute from the report belongs to someone.

When it refuses, or when the worker ran on a machine, user, or systemd manager this coordinator cannot inspect, confirm the worker stopped yourself and use the attestation path: `graphyard rework GY-N --previous-worker-stopped "reason"` for undelivered work, or `graphyard recover-containment GY-N --previous-worker-stopped "reason"` once the work is delivered. Never attest a stop you have not confirmed; the fence exists to prevent two workers in one workspace.

## Blocked item with no owner

The human operator can clear an existing blocker with `graphyard unblock GY-N "Contract verified"`. The CLI sends the task revision it just read and the reason is recorded in the event ledger; stale requests and attempts to clear no blocker are refused. A scoped operator agent may do the same within its scope, and similarly releases unreleased backlog work with `graphyard ready GY-N "Requirements approved"`, which carries the current revision and reason. Workers may only clear their own blockers while holding the current lease. After the blocker is resolved and the old lease expires, a new worker can claim normally.

An escalation is not a blocker: it refuses the merge gate until the human operator clears it with `graphyard resolve GY-N TRIGGER "audit reason"`. The request must name one standing trigger and carries the task revision the CLI just read, so each concern is cleared individually and a stale request cannot clear a later incident that shares a trigger; the reason is recorded in the event ledger. Resolution requires a credential declaring `sessionKind: "human"`, so no AI principal — lead, worker, producer, scoped operator agent, or an `admin` credential that declares `ai` or declares nothing — can resolve one. The single exception is a `lease-loss` the control plane raised for a lapse the ledger already explains: any `admin` credential, whatever its declared session kind, settles it by citing the explanation — `graphyard resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"` — and the server refuses a citation the ledger does not hold; reconciliation settles the same escalations on its own each tick. Lead-raised escalations, `security-concern`, `requirement-weakening`, and `evidence-policy-conflict` stay human-only. See [slice-lead delegation](delegation.md#who-may-settle-what).

## Submitted implementation needs rework

An active owner may keep its heartbeat running and update the assigned branch. GitHub observations automatically invalidate old evidence after a push. To reassign: stop the previous worker, then run `graphyard rework GY-N --previous-worker-stopped "Reproduce review failure"` as the human operator. This fences old API commands, closes the build gate, and wakes integration reconciliation. If the stopped worker still held its lease, reopening the item records its end as `lease.expired` with cause `stopped-by-attestation` against that epoch — your `--previous-worker-stopped` attestation in the same command is what explains it — so no `lease-loss` escalation is raised, and one already standing for that epoch settles itself on the next tick. A new worker claims with a higher epoch and registers the existing PR branch in a fresh workspace, usually in another clone or on another host. Resubmit the same PR with the new epoch. Keep the old worktree for inspection. GitHub check revocation is asynchronous; suspend merging until the refusing check is visible. Merged work requires a follow-up item.

## Accepted evidence turns out to be wrong

A trusted run can be invalidated after it was accepted — the wrong artifact was measured, the runner is now known to have been misconfigured, or the reported result was withdrawn upstream. Revoking is narrower than a requirement revision: it leaves criteria, policy revision, review and the submitted attempt untouched and only withdraws the runs that no longer stand.

```sh
cat > revoke.json <<'JSON'
{ "proof": "integration:claim-safety", "sha": "HEAD_SHA", "baseSha": "BASE_SHA", "policyRevision": 1,
  "reason": "Producer retracted the reported run" }
JSON
graphyard revoke GY-N revoke.json
```

Run it as an `admin` (the human operator), or as the `producer` principal whose live [proof grant](#proof-authority-grants) covers that proof; workers, coordinators, operator agents, and other producers are refused. The acceptance gate closes immediately and names the withdrawal, merge authorization is dropped, an in-flight merge execution is cancelled rather than waited out, and reconciliation republishes a refusing GitHub check. Do not wait for that check before revoking — the ledger is authoritative the moment the command returns, and the [merge broker](github.md#enforcement-boundary) refuses the candidate whether or not GitHub has caught up. If the broker's final provider commit already won serialization, revocation refuses instead of claiming it recalled an irrevocable provider call, and keeps refusing after the execution's authority expires until GitHub has been observed for it; wait for that reconciliation — the withdrawal is accepted once the pull request is seen unmerged after the expiry — and use a follow-up item if the merge landed. The [merge queue](github.md#merge-queue) treats the withdrawal like a failed proof: the entry is ejected so the items behind it are not held up, and the same commit does not re-enter — a fresh trusted run satisfies acceptance again, but a new candidate is what lands, at the back of the queue. Delivered work is immutable and needs a follow-up item instead.

## Worktree creation failed

The reservation is deliberately retained. Inspect Git output and the local branch/worktree state. If no files were created, the human operator can run the exact intended Git worktree operation locally. If ownership expired, use a new attempt and fresh path. Never run blanket worktree deletion across worker machines.

## GitHub job fails

Jobs keep the error and retry after 45 seconds. Expired job leases are recoverable after 90 seconds. Check App installation access, permission changes, API availability, branch protection, and whether the PR still matches the registered branch. A task revision conflict during observation is usually a normal retry.

A permission error is different. The server compares the installed App's permissions with the [declared set](github.md#app-permissions) at startup, every five minutes, and after any 403; a shortfall is an attention item in `GET /api/status` (`appPermissions`), the dashboard, and `master status`, naming the missing permission and the installation page. Jobs that need the missing permission are held rather than retried — `diagnose GY-N` shows `integration-held` — and a job that hits an unexpected 401/403 retries at most three times before it is held for thirty minutes, and a passing preflight releases it only if the installation reading changed since the hold (otherwise it re-checks once per hold, so attempts stay bounded even for a 403 the declaration does not explain). Accept the pending permission request (`github-setup --update-permissions` prints the exact steps) and the next preflight releases every job held on it; nothing needs restarting. See [migrating an existing App](github.md#migrating-an-existing-app).

Own-App check webhooks are ignored. Other signed webhook deliveries wake jobs, but periodic polling is the fallback. Missing webhooks should delay progress rather than permanently strand it — and a webhook that has gone silent is named as such (see [webhook liveness](#webhook-liveness)) rather than compensated for without a word.

## GitHub request budget

GitHub gives the App installation a fixed number of requests an hour (5,000 for the smallest installation; the limit itself is read from every response) and reports what is left on every response. Before GY-117 observation ignored that: every open candidate was observed again twenty seconds after its last observation whatever state it was in, an observation costs on the order of ten requests, and twenty candidates spent the hour in about forty minutes. The remaining twenty were a blackout in which every gate read stale, including the merge gate of a candidate that had nothing left to prove. The budget is now read from every response and spent by state.

### The live budget

The control plane reads `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset` from every installation response and keeps: requests remaining, the reset time, and the spend rate over the last ten minutes (`perMinute`), from which it projects when the budget reaches zero (`projectedExhaustionAt`) and whether that lands before the reset (`exhaustsBeforeReset`). A conditional read GitHub answers with `304 Not Modified` costs nothing and is counted as a request made, not as budget spent. `GET /api/status` and `graphyard status` report all of it under `githubBudget`; `master status` raises an attention item naming the projected exhaustion time whenever the spend rate would exhaust the budget before the reset. The budget is the process's own reading: one replica, one client, one account of what it spent.

### Observation cadence by state

Polling cadence is a function of what an observation can change, decided from the item's own [next action](master-agent.md#typed-next-actions-and-stateless-executors) after each observation:

| Band | State | Cadence | Why |
| --- | --- | --- | --- |
| `merge` | At the merge gate with every other gate passing | 20 seconds | The merge executor refuses an observation older than two minutes and spends most of that on its own critical path |
| `active` | Waiting on something GitHub can still deliver: a check, a review, a base refresh | 60 seconds | The webhook usually gets there first; polling covers a missed delivery |
| `steady` | `active`, and the last observation came back with head, base tip, check state and review state unchanged | 2 minutes, stretched by the fleet bound below | The webhook wakes it the moment any of that moves; polling is the safety net |
| `idle` | The next action is a dispatch, a rework or an escalation | 5 minutes; when unchanged, stretched by the same fleet bound if longer | Nothing on GitHub can move it |

A webhook delivery wakes every job at once whatever its band (`woken` on the claimed job), so a slow-cadence item is observed immediately when GitHub says something changed. Observation is webhook-first and polling is the safety net: for any non-merge candidate whose head, base tip, check state and review state are unchanged since its last observation, the fleet-wide steady-state spend is bounded to a documented share of the hourly limit — **at most 40%** (`steadyStateShare`) — by stretching its interval so every open candidate polling for an hour stays inside that share, counting every request (a free 304 included) and using the measured mean cost per observation (ten requests until one is measured). The interval is never under two minutes, and an idle candidate also keeps its five-minute minimum. `githubBudget.steadyState` reports the open candidates, the mean cost and the interval in force. The merge path, webhook wakes and the master session's own reads always have the remaining headroom.

### The merge-path reserve

When the remaining budget falls below a reserve sized for the merge path — **500 requests** by default, `GRAPHYARD_GITHUB_RESERVE` on the deployment for an installation with a different limit — non-merge observations yield: they are rescheduled past the reset rather than spent, and `githubBudget.deferrals` lists each one with the reason naming the reserve. Merge-gate candidates, webhook wakes and merge verification (the exact-head read the guarded merge makes) continue, so a candidate that has nothing left to prove still lands while the rest of the fleet waits for the reset.

The reading expires with its reset. A deferred observation makes no request, so only a spent request refreshes the count; once `resetAt` has passed, GitHub has replenished the budget and the count from before it is no longer what is left. `githubBudget` then reports `remaining`, `used` and `resetAt` as unknown (`null`) with `expiredResetAt` naming the reset that passed, the reserve never defers on an unknown reading, and the first observation due after the reset (or after a pause lifts, whose refusal reported zero remaining) is made rather than held: its response reads the fresh budget, and that reading decides the observations that follow.

### What an observation costs

Every request carries its `ETag`, and GitHub charges nothing for the `304` it answers with, so a candidate whose head, base tip and check state are unchanged since the last observation costs at most two uncached requests, usually none. The request count of each observation — every request, and the ones GitHub actually charged — is recorded against the job that made it (`githubBudget.observations.jobs`, with the band and cadence it earned) and `graphyard status` reports the mean cost per observation over the last hour (`githubBudget.observations.meanRequests`, `meanUncached`). The conditional-read cache holds 4,096 entries, enough for tens of open candidates; an entry evicted between two observations of the same candidate turns a free 304 back into a charged read.

### What a pause means for gates

A `403`/`429` GitHub answers for rate limiting pauses every request until the reset (or the `retry-after`, whichever is later). The pause is one incident, not twenty identical job errors: `master status` and the dashboard show one attention item stating that GitHub requests are paused, until when, what exhausted the budget (requests in the last hour by kind: `pulls`, `check-runs`, `compare`, `contents`, …), and that gates read stale until it lifts. Each stopped job keeps its own refusal in the ledger and comes back when the pause lifts rather than retrying into the same refusal every 45 seconds. While paused, the merge gate refuses observations older than two minutes as it always does, so nothing merges on stale evidence; the merge-path reserve exists so that a pause is rare rather than routine.

### Reading the budget

- `graphyard status` (or `GET /api/status`) → `githubBudget`: `remaining` of `limit`, `resetAt`, `perMinute`, `projectedExhaustionAt`, `exhaustsBeforeReset`, `reserve`/`belowReserve`, `paused`, `lastHour.byKind`, `cadence`, `steadyState`, `observations`, `deferrals`. `remaining: null` with `expiredResetAt` set means the last reading's reset has passed and the next spent request refreshes it; `remaining: null` with `observedAt: null` means no installation response has been read yet.
- `graphyard master status` → `attentionItems` with subject `github`: the pause in force, the projected exhaustion, or the silent webhook, each with who resolves it and what to run.
- The dashboard's home page shows the pause as one notice.

### Webhook liveness

Polling that quietly compensates for a broken webhook hides the fault and spends the budget doing it. `GET /api/status` and `graphyard status` report `webhooks`: the time of the last verified delivery received (`lastDeliveryAt`), the count in the last hour (`lastHour`), whether a secret is configured, the App settings page (`settingsUrl`) and the open pull requests that could be woken. `master status` raises an attention item when no delivery has arrived for an hour while pull requests are open, naming the App webhook settings page (`https://github.com/settings/apps/APP-SLUG`, or the organization equivalent; recent deliveries under `…/advanced`) and the webhook URL `https://YOUR-HOST/api/github/webhook` the App must post to. A delivery that arrives clears it.

## GitHub or Graphyard outage

The database merge gate refuses observations older than two minutes. GitHub's last successful check may still exist; it does not expire automatically. Routine master merges acquire a short-lived server authority, transactionally record a final GitHub verification, and freeze relevant Graphyard mutations around the exact-head provider call. A direct GitHub merge has no verified execution and cannot complete its Graphyard work item. Repository rules must restrict alternative merge identities when the merge itself must also be prevented during an outage.

## Bootstrap mode for a self-proving change

An item can require a proof that does not exist yet, because the same change is what introduces the
harness. The protected harness refuses to run against a base that lacks the contract, so the item
cannot prove itself and stalls until someone re-sequences requirements by hand. Bootstrap mode is
the audited way through, and it is a human-operator decision.

Mark the one criterion whose proof is not yet runnable:

```sh
graphyard requirements GY-N revision.json
```

```json
{
  "expectedPolicyRevision": 3,
  "reason": "The herdr-recovery harness ships in this change",
  "criteria": [
    {"id": "AC-1", "text": "Herdr recovery is proven end to end", "proofs": ["integration:herdr-recovery"],
     "bootstrap": {"reason": "This candidate introduces the harness the proof needs",
                   "contractPaths": ["src/herdr/recovery.ts"]}},
    {"id": "AC-2", "text": "The supervisor stops cleanly", "proofs": ["unit:supervisor-stop"]}
  ],
  "dependencies": [],
  "plannedFiles": ["src/herdr/", "tests/"],
  "exclusiveResources": []
}
```

The same declaration can be made at creation, or from **Revise requirements** in the dashboard.
Contract paths must lie inside the item's planned files. Declaring or changing bootstrap mode
requires the `policy:bootstrap` capability; an operator-agent scoped to `policy:requirements` alone
is refused, and implementation workers cannot revise their own criteria at all. Graphyard stamps who
declared the deferral and when, and records the declaration and its reason in append-only history.

A criterion with an `e2e:` proof cannot be deferred: its scenario version is pinned per work item
and cannot travel with the obligation. Sequence those through the test-case registry instead.

What stays in force: independent review, every required CI check, the merge queue, and every proof
of every criterion that is not marked. A bootstrap candidate with a failing check or no approval
does not advance. Bootstrap mode buys sequencing, not a lower bar.

What is owed: the deferred proof becomes an obligation on its contract paths. The next work item
whose planned files touch that contract inherits the proof as a required criterion automatically —
its acceptance gate names the originating item and criterion — and that item cannot defer it again.
The obligation clears only when some change is delivered with trusted, passing, complete evidence
for that proof. No command retires it.

Review what is outstanding before planning new work:

```sh
graphyard obligations
graphyard diagnose GY-N
```

The dashboard shows the same facts on the work item: a bootstrap badge and the declaring identity on
the criterion, `deferred` on the required-proof list, inherited obligations on the items that pick
them up, and a **Bootstrap obligations** ledger of everything still owed. If an obligation has no
inheritor and the harness now exists on main, create the follow-up item that runs it rather than
leaving the proof owed indefinitely.

## Delivered with a failed smoke proof

A delivered item whose trusted post-deployment smoke proof failed stays Done — the merge happened and
history is never rewritten — and is marked **delivered with failure**. `master status` lists it under
`delivered` with `rollback` guidance, the loop records the same guidance as an escalation, and the
dashboard shows the failure on the card, in the work detail's Post-deployment section, and in the
post-deploy flow node. The guidance names the commit the deployment was serving when the smoke ran,
the item's merge commit, and the base branch.

1. Decide between rolling the deployment back to the last release whose smoke proof passed and
   reverting the merge commit on the base branch. A revert is a new work item: it is reviewed,
   checked, queued and merged under the same gates as any change, and gets its own proof.
2. Do not backfill passing evidence for the failed delivery, and do not delete the failure. A later
   run of the smoke workflow at the same deployed commit may supersede the verdict if the failure was
   in the probe rather than the release; every run stays in the evidence ledger.
3. If the release moved on before the smoke ran — the deployment now serves a newer commit — the item
   stays `awaiting-smoke`: the producer refuses to attribute a run to a commit that is no longer
   serving. The smoke request stops after three attempts; the newer delivery's own proof covers what
   is live now.

Graphyard v0.1 does not execute rollbacks or reverts itself.

## Merged but not deployed

A merged commit that production never served is a **deployment incident**, recorded by the control
plane's [production observation](deployment.md#production-deployment-observation) within five minutes
of the merge: immediately when the provider reports the deployment `FAILED` or `CRASHED`, and after the
five-minute grace period when no deployment of the merge is observed at all. The incident is an
append-only `delivery.deployment-incident` event on the delivered item; it appears in `GET /api/status`
under `production.incidents`, in `graphyard doctor` as `next`, and in `graphyard master status` under
`controlPlane.production` with the attention line `main is N commits ahead of production (serving …):
<reason>`. `/healthz` stays green throughout, because the previous release is still serving — that is
exactly why the observation exists.

1. Read the reason. A provider failure names the deployment and its URL; open the provider's build or
   deploy log for the exit. A start-up refusal is printed there verbatim — for a capacity limit it names
   the variable and value to set, such as `set GRAPHYARD_MAX_REVIEWERS=4 on the deployment`.
2. Fix the deployment, not the ledger: set the variable, or land the fix through a new work item. Do not
   revert the merge to clear the incident unless the change itself is wrong.
3. When a deployment containing the merge serves, the watch appends `delivery.deployment-recovered` and
   the attention line clears on the next pass. Nothing is edited or deleted.
4. If `master merge` refuses with `server runs <sha>, CLI expects <sha>: deploy main first`, the CLI
   checkout speaks a newer merge protocol than the deployed server: deploy main and retry rather than
   downgrading the CLI.

Without a Railway token the control plane still detects the miss from its own build commit and asks for
`RAILWAY_API_TOKEN` in the incident reason so the next one carries the provider's failure.

## Capacity variables no longer cover the principals

`delegationLimits.attention` in `/api/status`, `doctor`, and `master status` names each
`GRAPHYARD_MAX_*`/`GRAPHYARD_MIN_*` variable whose deployed value (or unset default) no longer covers
the configured principals, with the value to set. The server has already derived a working limit and
started; set the variable as asked and redeploy so the value is explicit. Re-running the installer does
the same and reports the drift. Adding a principal beyond an explicit limit is the one case that refuses
start-up, with the same sentence, and the previous release keeps serving until the variable is raised.

## Merge bypass

An observed merge with unsatisfied gates creates a permanent violation. Do not backfill evidence and pretend the merge was authorized. Inspect what bypassed protection, repair access rules, and create a follow-up investigation or repair task. v0.1 does not automatically revert code or deploy rollbacks.

## Credentials

A scoped operator agent uses the transactional credential registry and secret-safe CLI described in [Scoped operator-agent automation](operator-automation.md). It must never use an entry from `GRAPHYARD_PRINCIPALS` with the `admin` role.

Add or rotate principals in `GRAPHYARD_PRINCIPALS`, then redeploy. Which proof names a producer may attest is *not* configured there after bootstrap; see [Proof authority grants](#proof-authority-grants). Use a unique ID for each coordinator and worker principal and a unique secret for every principal. Rotation invalidates the old credential on restarted replicas; coordinate rolling replicas so old credentials do not remain accepted indefinitely. Revoke GitHub App keys separately from worker credentials. The master's `coordinator` credential holds no lease, evidence, or requirement authority at the Graphyard API; beyond reads it may only acquire the bounded merge execution, settle a verified-dead containment quarantine, and record a deployment observation. Its local GitHub CLI access separately controls whether it can invoke the guarded routine-merge flow.

The dashboard keeps its sign-in token in browser session storage. Sign out on shared machines. Producer credentials should be held by trusted reporters, never by arbitrary PR code. Logs intentionally omit tokens, but operator-provided blocker text and evidence URLs can still contain sensitive data; avoid submitting secrets as engineering metadata.

Environment files, `.graphyard/`, and private-key file extensions are excluded from Git and Docker build context. Only `.env.example` is allowed in Git. CI runs a pinned, checksum-verified Gitleaks release against all fetched history. GitHub secret scanning and push protection are enabled on the public upstream repository. A clean scan is not a guarantee against unknown secret formats: if a credential is ever committed, revoke it first, then handle history and cached copies. Local Compose and isolated-test passwords are public development fixtures, never production credentials.

## Proof authority grants

Proof authority is Graphyard state, not deployment configuration. The human operator (`admin`)
grants a producer principal the right to produce trusted evidence for exact proof names or
bounded patterns, and every change takes effect on the next request without a restart or redeploy.

```
graphyard grants                                   # live authority per principal and its source
graphyard grants grant ci "integration:*,unit:*" "CI runner produces integration and unit proof"
graphyard grants grant witness "manual:gy-43/*" "Designated acceptance witness for GY-43"
graphyard grants revoke ci "integration:claim-safety" "Runner decommissioned"
graphyard grants history ci                        # append-only record of every change
```

The dashboard shows the same live set under **Proof authority**, including which required
proof names currently have no authorized producer. Only an `admin` may grant or revoke.

A pattern is one of three shapes and nothing else:

| Pattern | Authorizes | Does not authorize |
| --- | --- | --- |
| `integration:claim-safety` | exactly that name | `integration:claim-safety-extra` |
| `integration:*` | every `integration:` proof | any other proof kind |
| `manual:gy-43/*` | `manual:gy-43/docs-ui` and deeper | `manual:gy-43`, `manual:gy-430/docs` |

Authority is bounded by role before it is bounded by name. `worker`, `reader`,
`coordinator` and `operator-agent` principals can never receive a grant, so an
implementation agent cannot acquire producer authority by any route. An `admin` holds the
`manual:*` operator-witness lane by role and cannot be granted anything further. Trust
still follows the credential: a grant names a principal that already exists in
`GRAPHYARD_PRINCIPALS`, and adding a new producer identity still requires a credential.

`GRAPHYARD_PRINCIPALS[].proofs` is a bootstrap seed only. On startup Graphyard
materializes each producer's environment allowlist into a grant record once; from then on
the grant record decides. A later environment edit neither adds authority nor resurrects a
revoked name, and a restart never undoes a revocation. Naming a new proof no longer
requires editing production configuration.

Every grant and revoke appends an immutable history row and an event, recording the actor,
the reason, the patterns applied, and the resulting effective set. Read one principal's
record with `graphyard grants history ID`; the ledger itself rejects updates and deletes.

## Readiness checklist per completion profile

`graphyard doctor --profile through-merge|preview-validation|production-verification` prints an explicit checklist for the selected [completion profile](turnkey-delivery-roadmap.md#product-promise-and-boundary). Every item states what was observed and, when it is `missing` or `unknown`, the direct command or setting that resolves it: the repository remote, the control-plane connection and the credential's role, the reviewed-and-applied setup proposal and its drift, the dedicated GitHub App and the permissions it lacks, discovered required checks, worker profiles, the review provider, and — for preview validation — the Playwright suite, the immutable environment, runner/collector/builder registrations and the approved bundle. Detected test frameworks are mapped to the [report adapter](report-adapters.md) that accepts their output; a framework with no adapter is reported as unsupported with the recovery, never as covered.

`unknown` is never `ready`: an item the command could not judge (no server, a worker credential that cannot read validation definitions) says what it depends on. `production-verification` stays `missing` until release observations ship (roadmap D3); until then production verification is an explicit manual proof. A ready checklist is configuration, not evidence — the first real PR still has to pass every gate visibly.

## Setup proposals and drift

`graphyard init --scan` replaces hand-authored setup with a reviewed proposal. The scan reads package manifests, CI workflows, deploy configuration, and the test layout, then writes `.graphyard/setup-proposal.json` (ignored by Git, mode 0600) proposing required check names, build/test commands with proof names, deploy verification, the candidate environment topology, review provider, worker/reviewer profiles for runtimes found on that machine, and the GitHub App registration. It changes nothing else.

`graphyard init --scan --apply` applies exactly the stored proposal after the human operator reviews it: it performs the GitHub App manifest flow, writes the managed `AGENTS.md` section, records principals and proof grants in `.graphyard/principals.json` (install the array as `GRAPHYARD_PRINCIPALS` on the deployment), and writes profile files under `.graphyard/profiles/`. Principals come only from the reviewed proposal: apply registers the operator, coordinator, and producer principals plus exactly the worker principals the proposal's profiles declare, so a machine with no agent runtime gets no worker credential rather than an unreviewed one; install an agent CLI and rerun `init --scan --apply` to add one. Applying is idempotent: unchanged artifacts are left alone, existing principal tokens are preserved so a re-run never invalidates a deployed configuration, operator-edited profiles are reported as drift and kept rather than overwritten, and a repository that changed after apply is reported as drift by later scans. If the repository changes between review and apply, apply refuses and the stored proposal is left untouched.

### Environment topology chosen by the scan

The candidate-bound-environment invariant is declared explicitly in every proposal: ephemeral where the stack allows, pooled or partial with data isolation where it does not.

| Detected stack | Deploy target | Topology chosen | Declaration |
| --- | --- | --- | --- |
| Node package with `railway.json`/`railway.toml` | Railway | `ephemeral` | Each candidate deploys to its own Railway environment built from its commit and destroyed after review; backing datastores must be per-candidate copies seeded from structure, never shared live state. |
| Python project with `Dockerfile`/compose | Container registry | `pooled` | Candidates deploy as isolated containers, but a shared backing datastore (compose database, driver dependency, or connection URL) was detected; every candidate must receive isolated data — a per-candidate schema or database seeded from structure only — so concurrent candidates cannot observe each other. |
| Static site (`index.html`, `.nojekyll`/`CNAME`) | GitHub Pages | `ephemeral` | Each candidate deploys to a disposable static target created from its own commit and discarded after review; nothing persists between candidates. |
| Any stack with no deploy configuration | none | `partial` | Only CI-level isolation exists; the operator must add a deploy target or accept partial environment verification, and any shared backing service requires declared data isolation between candidates. |

Railway, Vercel, and Fly detections choose the same ephemeral pattern as the Railway row, with target-specific SHA verification instructions (for example, comparing `RAILWAY_GIT_COMMIT_SHA`, Vercel deployment metadata, or `fly status` releases with the candidate SHA). Container deployments propose SHA-tagged images and digest verification. The pooled choice is deliberate conservatism: containers are disposable, but the detected datastore is not, so the proposal requires isolation instead of assuming per-candidate copies the platform has not promised.

Drift is informational, never auto-repaired: rerun `init --scan`, compare the refreshed proposal against what was applied, and reapply only after the human operator reviews it. `graphyard doctor` reports the stored proposal, the applied setup record, and current drift.

## Scale limits

The kernel serializes short coordination mutations. The initial reconciler processes up to four provider jobs per tick per replica. The list API returns all work, while the event API returns the most recent 300 events. These are deliberate MVP bounds, not a benchmark claiming hundreds of agents at production load. Monitor latency, database lock wait, job lag, memory, and the [GitHub request budget](#github-request-budget) before increasing concurrency.

## Dashboard connection and keyboard behavior

The dashboard verifies the access token before displaying work or integration status. Leading and trailing whitespace is removed from pasted tokens. A rejected or revoked token returns to the sign-in form with an explicit error and clears previously loaded work. During initial verification, unknown counts are not presented as zero and unknown GitHub connectivity is not reported as disconnected.

After a successful load, polling failures retain the last snapshot with a disconnected/stale-data warning and last-success timestamp. Polling retries every five seconds; requests time out after fifteen seconds. A successful refresh clears the warning. The snapshot is informational: the server still authorizes every mutation. Sign out remains available on narrow screens and clears the dashboard sign-in token.

Work details, new-work forms, and test-case forms move keyboard focus inside when opened. Tab and Shift-Tab remain inside the dialog, Escape closes it, and focus returns to the opening control.

Run `npm run test:browser` after `npx playwright install chromium` to exercise these behaviors in headless Chromium. The tests serve the UI locally and intercept API calls with isolated fixtures. They cover client behavior, not server authorization or successful production writes; the real-Postgres and protected acceptance suites cover coordination separately. Required CI runs both the ordinary tests and browser regressions.

Signing out invalidates pending work mutations and their dashboard refreshes locally. Responses from a previous sign-in cannot restore its data or errors after another token is entered. A write already accepted by the server remains in the work ledger.

The work-detail History panel retains its last loaded entries during periodic refresh and temporary event-fetch failures. Selecting different work or signing out clears those entries.

### Bounded work history

The work detail drawer shows 20 history entries at a time inside a keyboard-accessible, height-limited scroll area. Consecutive GitHub observations from the same actor are grouped with a count and time range; this groups observation activity, not a claim that their payloads are identical. Turn off grouping to inspect individual event rows, and use **Show more history** or **Show less history** to change the visible count. Refreshes preserve this choice; opening another work item resets it.

The dashboard receives the latest 300 events per work item. Its display limits do not delete or truncate the append-only database audit ledger; older events remain in storage.

### Concurrent reconciliation

If a task changes while GitHub is being read, or the integration lease expires before a review request can be recorded, Graphyard rejects that stale snapshot and schedules another observation after two seconds (or immediately when newer work has already queued a wakeup). This expected concurrency retry does not appear as an integration error in the dashboard. The existing revision and job-lease checks still prevent stale success publication, and failed checks are conservatively revoked where possible. Actual integration failures, such as API or permission errors, remain visible and retry durably.

## Coordination diagnosis and recovery drills

Use `graphyard diagnose GY-N` or the work-detail Coordination section for concrete next steps. See [coordination](coordination.md) for requirement revisions, overlap warnings, declared-resource reservations and the two-machine drill, and the [automated recovery contract](herdr.md#automated-recovery-contract) for the refusals a trusted run establishes on every candidate. A drill procedure is not completed execution evidence.
