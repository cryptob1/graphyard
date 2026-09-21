<!-- page: Operate Graphyard | 7 | procedures, credentials. -->
# Operations reference

For an operator or master in an incident: the procedure behind each [recipe](operations.md).

## Perpetual master loop

Terminal condition, cycle and non-stopping conditions: [master-agent guide](master-agent.md#operate). A per-item blocker is the lease holder's `graphyard blocked GY-N EPOCH "reason"`; a deployment blocker is a follow-up item naming the delivered item, merge commit and cause. `master verify-deployment GY-N` names cause and fix on every refusal: *unobserved*, *stale*, *does not serve the merge yet*, *local checkout*, *already recorded*.

## Master coordination loop

- **`graphyard master run`:** durable coordinator; run under systemd or Herdr ([service unit](../examples/master/graphyard-master.service)), never as a chat session
- **`.graphyard/master.json`:** re-read before every cycle and dispatch tick: profiles, `herdrWorkspace`, `autoMerge` and every `run` setting apply without restart

Flags:

- `--interval SECONDS`: Between cycles, 5–900; default 20
- `--dispatch-interval SECONDS`: Between reads of review and producer requests, 5–30; default 10
- `--reviewer-profile NAME`: Reviewer profile automatic dispatch launches when several are configured
- `--producer-timeout MINUTES`: Producer session lifetime before expiry, 5–1440; default 120
- `--proof-workflow FILE`: Workflow the loop runs when a candidate lacks automatable proof
- `--deployment-url URL`: JSON endpoint reporting the commit the running release serves
- `--deployment-sha-field PATH`: Dotted field holding that commit; default `commit`
- `--smoke-workflow FILE`: Workflow run against the live deployment for a `deploySmoke` delivery
- **`master init` only:** `--no-auto-merge` (each merge then needs an approved [merge decision](master-agent.md#autonomy-agents-approve-agents)), `--merge-method merge|squash|rebase`, and `--cli-path PATH` (also on `init`) to record another launcher

## Worktree disk

- **One install, shared.** An assignment worktree under the repository resolves its install by upward lookup — nothing is created, and the worker's prompt names it — while one outside it gets a mirror, a directory of links still covered by the `node_modules/` ignore rule. The install must answer for that exact head: a differing `package-lock.json` installs its own, and a worktree that already has one is reported and left alone.
- **Finished assignments give theirs back.** The loop removes those worktrees' dependency directories every ten minutes, every cycle while free space is below the threshold, and nothing else — files, Git metadata, branches and workspace records stay, so a reclaimed worktree is one `npm install` from working. `daemon.reclaim` reports what went, how much it returned and what it kept.

Each worktree's disposition is `delivered` (the item is Done), `superseded` (a later attempt replaced that epoch) or `idle` (nothing changed for longer than the idle bound), all removed; `live` (the registered epoch still holds the lease) and `recent` (changed inside the idle bound) are kept.

- **`master status`:** free space under `disk` with worktrees a reclaim would empty; below the threshold raises a master-owned attention item while writes still succeed
- **A write that fails for want of room**, whether the kernel reports it or only a command's output does (`write error: Disk quota exceeded`), is named as that
- **No loop running:** `master run --once` reclaims and cycles once

Settings in `.graphyard/master.json`:

- `run.reclaimIdleHours`: Hours a worktree may sit untouched before its dependency directories are disposable, 0.25–720; default 3
- `run.diskThresholdGb`: Free space below which `master status` raises disk pressure, 0.1–10000; default 10

## Recovery procedures

### Lost worker before submission

- **Expiry:** 120 seconds after last heartbeat; a new worker claims at a higher epoch, old-epoch mutations refuse
- **Old worktree:** preserve it, use a new branch and path: expiry does not prove the process stopped
- **`lease-loss`:** raised only by a lapse nothing explains; if you stopped the worker, attest it ([classification and settlement](delegation.md#escalation))

### Submitted implementation needs rework

- **Active owner:** may keep heartbeating and update its branch, a push invalidating old evidence; to reassign, stop it, then `graphyard rework GY-N --previous-worker-stopped "Reproduce review failure"`
- **Effect:** old commands are fenced, build gate closes, a lease still held ends as `lease.expired` with cause `stopped-by-attestation`, raising no `lease-loss`
- **Next worker:** claims at a higher epoch, registers existing PR branch in a fresh workspace, resubmits the same PR
- **Check revocation is asynchronous:** suspend merging until the refusing check is visible; merged work needs a follow-up item

### Supervisor died leaving a containment quarantine

If a foreground worker's supervisor dies before settling its quarantine, the fence stays up: item undispatchable, exclusive resources reserved, requirements immutable.

- **Run** `graphyard master settle-containment GY-N "reason"` on the machine that ran the worker: it verifies there what [automatic containment settlement](protocol/leases.md#automatic-containment-settlement) requires, the control plane re-checking everything, and `master status` shows the same assessment under [`containment`](master-agent.md#containment-and-recovery)
- **Anything it cannot prove** — unreachable host, failed query, surviving process, disagreeing clocks — refuses and prints what it found
- **Then, or where this coordinator cannot inspect the host:** confirm the stop yourself, attest with `rework GY-N --previous-worker-stopped "reason"` undelivered, `recover-containment GY-N --previous-worker-stopped "reason"` delivered

### Worktree creation failed

- **Reservation:** retained; inspect the Git output and local branch and worktree state
- **No files created:** run the intended `git worktree` operation locally
- **Ownership expired:** new attempt, fresh path; never a blanket worktree deletion across worker machines

### Merge bypass

An observed merge no valid execution covered (cancelled before the merge cutoff, expired, or never existing) records the violation `Merge observed without a prior authorization for this candidate` and stays out of Done; every observation re-derives that verdict. Never backfill evidence or re-run the gates against the merged head.

- **Reported:** `master status` row `merged` (with the violation and last refusal), owner `master`, the recovery command and `counts.mergedUnreconciled` apart from `counts.mergeCandidates`; the loop escalates once and stops offering the item to the guarded merge
- **Recovery, requested after the merge** (an earlier merge approval does not judge it): `master decide GY-N merge REASON`, then `master approver GY-N DECISION`. The next observation re-checks the record as it stood immediately before the merge: merge authorization for that exact head, base and policy revision, every gate passed, no standing violation, every required proof's trusted evidence live, a GitHub observation under two minutes old
- **The snapshot re-checked:** the last preceding the merge. The cutoff is GitHub's `mergedAt` plus one second plus the upper bound of the merge broker's recorded clock offset; a snapshot whose observation reports the pull request merged never qualifies. What the merge wrote refuses nothing: the cleared violation, an earlier decision's refusal, a merge gate reporting only the queue position left behind
- **Holds:** delivered on the decision, citing that snapshot's `authorizationRevision` and `evidenceAsOf` and carrying `reconciliation` (decision, requester, approver, both reasons, cutoff, snapshot revision, judgement); ledger `merge.reconciled`
- **Fails:** nothing is delivered; the item records `Reconciliation by decision … refused: …` with every reason, once, the ledger `merge.reconciliation.refused`, the row's attention line the refusal. Answer it with a new decision, never by re-approving the refused one; one naming no new reason is refused again. Repair the access rules that allowed the merge, and carry remaining work in a new item under the full gate set
- **A queue entry that can never publish:** the merged item's pull request is closed; entries behind it wait (`Waiting for GY-N to publish its speculative tip`). The row's `merged.queue` carries `sequence`, `position`, `size`, `unpublishable: true` and the keys `behind`. The exit is the same decision: an accepted reconciliation delivers the item and drops the entry; a refused one removes it and delivers nothing, `queueEjection` naming the refused decision, the ledger recording `queue.ejected`, the entries behind predicting against the real base. A standing refusal removes the entry on the next reconciliation tick
- **Operator-authorized delivery:** when the record refuses a merge an operator authorized administratively, a further merge decision whose `REASON` cites the refused decision's id records it, the operator's admin credential on one side — the operator requests it through the API, or approves the master's with `GRAPHYARD_TOKEN_FILE=ADMIN_TOKEN_FILE graphyard master approve GY-N DECISION REASON`. An operator-agent pair citing the refusal is refused again, one citing no refusal is a plain reconciliation, and `attentionOwner.next` carries the exact command. Its record is `delivery.operatorAuthorization` — `execution: null`, the `operator`, the decision, the `refusedDecision`, `unmet`, the cutoff, the pre-merge snapshot's `authorizationRevision` and a judgement — with the ledger entry `merge.operator-authorized` under the operator's identity, never `merge.reconciled`
- **Listed apart:** `master status` `deliveries.reconciled` (`authorization: 'reconciled'`) and `deliveries.operatorAuthorized` (`authorization: 'operator'`), with `counts.reconciledDeliveries` and `counts.operatorAuthorizedDeliveries`

## Accepted evidence turns out to be wrong

Revoking leaves criteria, policy revision, review and the submitted attempt untouched, withdrawing only runs that no longer stand.

```json
{ "proof": "integration:claim-safety", "sha": "HEAD_SHA", "baseSha": "BASE_SHA", "policyRevision": 1,
  "reason": "Producer retracted the reported run" }
```

## Bootstrap mode for a self-proving change

- **Declare**, under `policy:bootstrap`: a `bootstrap` block on that criterion in a `requirements` revision, `reason` plus `contractPaths` inside the item's `plannedFiles`
- **Obligation:** the next item touching those paths inherits the proof and cannot defer it again, cleared only when some change is delivered with trusted, passing, complete evidence; `graphyard obligations` and `diagnose GY-N` list what is outstanding ([bootstrap mode](protocol/bootstrap-mode.md))

## Credentials

- **Add or rotate principals:** in `GRAPHYARD_PRINCIPALS`, then redeploy, each with a unique ID and secret ([safely](deployment.md#changing-the-roster-safely)); rotation invalidates the old credential on restarted replicas, App keys being revoked separately
- **Proof authority:** A live [grant](#proof-authority-grants), never a `GRAPHYARD_PRINCIPALS` setting after bootstrap
- **The master's `coordinator`:** Beyond reads, only bounded merge execution, settling a verified-dead quarantine and recording a deployment observation
- **Operator agents:** In the [operator-agent registry](operator-automation.md), never an `admin` entry
- **Where secrets sit:** Dashboard keeps its sign-in token in browser session storage; producer credentials belong to trusted reporters, never pull-request code; logs omit tokens, though blocker text and evidence URLs can carry sensitive data
- **Out of Git:** Environment files, `.graphyard/` and private-key extensions, excluded from the Docker build context too; CI runs a pinned, checksum-verified Gitleaks over all fetched history, a scan, not a guarantee; a committed credential is revoked first, then cleaned from history and caches

## Proof authority grants

Proof authority is Graphyard state, not deployment configuration: an `admin` grants a `producer` exact proof names or bounded patterns, effective on the next request.

```sh
graphyard grants                                   # live authority per principal and its source
graphyard grants grant ci "integration:*,unit:*" "CI runner produces integration and unit proof"
graphyard grants revoke ci "integration:claim-safety" "Runner decommissioned"
graphyard grants history ci                        # append-only record of every change
```

- `integration:claim-safety` authorizes that exact name, not `integration:claim-safety-extra`
- `integration:*` authorizes every `integration:` proof, no other kind
- `manual:gy-43/*` authorizes `manual:gy-43/docs-ui` and deeper, not `manual:gy-43` or `manual:gy-430/docs`

## Setup proposals and drift

- **`graphyard init --scan`:** writes `.graphyard/setup-proposal.json` (Git-ignored, mode 0600) and nothing else
- **`--apply`:** applies exactly that stored proposal, after review, registering only principals it declares (operator, coordinator, producer, one worker per proposed profile, none without an agent runtime)
- **Apply is idempotent:** unchanged artifacts left alone, existing tokens preserved, operator-edited profiles reported as drift and kept; a repository that changed between review and apply refuses
- **Every proposal:** declares the candidate-bound-environment invariant

- **What each stack proposes:** a Node package with `railway.json`/`railway.toml` gets Railway and `ephemeral`, an environment per candidate destroyed after review with datastores copied from structure; a Python project with `Dockerfile`/compose a container registry and `pooled`, isolated containers over a shared datastore each candidate needing its own schema; a static site (`index.html`, `.nojekyll`/`CNAME`) GitHub Pages and `ephemeral`; a stack with no deploy configuration no target and `partial`, CI-level isolation only. Vercel and Fly follow the Railway pattern with target-specific SHA verification (`RAILWAY_GIT_COMMIT_SHA`, Vercel deployment metadata, `fly status` releases); container deployments propose SHA-tagged images and digest verification
- **Drift:** informational, never auto-repaired: rerun `init --scan`, compare, reapply after review; `graphyard doctor` reports stored proposal, applied setup record and current drift

## Scale limits

The kernel serializes short coordination mutations; the list API returns all work and the [event API](protocol/read-endpoints.md) pages.

### Concurrent reconciliation

[Reconciliation](architecture.md#reconciliation) bounds each tick and rejects a stale snapshot, scheduling another observation.
