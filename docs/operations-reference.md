<!-- page: Operate Graphyard | 7 | procedures, credentials, grants, limits. -->
# Operations reference

For an operator or master in an incident: the procedure behind each [recipe](operations.md).

## Perpetual master loop

The terminal condition, the cycle and the non-stopping conditions are in the [master-agent guide](master-agent.md#operate). Blockers have two records: a per-item blocker the lease holder writes with `graphyard blocked GY-N EPOCH "reason"`, and a deployment blocker as a follow-up item naming the delivered item, its merge commit and the cause. `master verify-deployment GY-N` names a cause and fix on every refusal: *unobserved*, *stale*, *does not serve the merge yet*, *local checkout*, *already recorded*.

## Master coordination loop

`graphyard master run` is the durable coordinator; run it under systemd or Herdr ([service unit](../examples/master/graphyard-master.service)), never as a chat session. It re-reads `.graphyard/master.json` before every cycle and dispatch tick, so profiles, `herdrWorkspace`, `autoMerge` and every `run` setting apply without a restart.

- `--interval SECONDS`: Seconds between cycles, 5–900; default 20
- `--dispatch-interval SECONDS`: Seconds between reads of review and producer requests, 5–30; default 10
- `--reviewer-profile NAME`: The reviewer profile automatic dispatch launches when several are configured
- `--producer-timeout MINUTES`: How long a producer session may run before it expires, 5–1440; default 120
- `--proof-workflow FILE`: Workflow the loop runs when a candidate is missing automatable proof
- `--deployment-url URL`: JSON endpoint reporting the commit the running release serves
- `--deployment-sha-field PATH`: Dotted field holding that commit; default `commit`
- `--smoke-workflow FILE`: Workflow run against the live deployment for a `deploySmoke` delivery

## Worktree disk

Every attempt checks the repository out again, so the loop bounds both halves of the cost itself.

- **One install, shared.** An assignment worktree lives under the repository, so the runtime's upward lookup resolves its install: nothing is created, and the worker's prompt names it. A worktree outside it gets a mirror of that install, a directory of links still covered by the `node_modules/` ignore rule. The install must answer for that exact head: a differing `package-lock.json` installs its own, and a worktree that already has one is reported and left alone.
- **Finished assignments give theirs back.** The loop removes the dependency directories of finished assignments' worktrees every ten minutes — every cycle while free space is below the threshold — and nothing else: checkouts keep their files and Git metadata, branches every commit, and workspace records are never written, so a reclaimed worktree is one `npm install` from working. `daemon.reclaim` reports what went, how much it returned and what it kept.

| Disposition | What the loop does |
| --- | --- |
| `delivered` | Removed: the item is Done |
| `superseded` | Removed: a later attempt replaced that epoch |
| `idle` | Removed: nothing changed for longer than the idle bound |
| `live` | Kept: the registered epoch still holds the lease |
| `recent` | Kept: changed inside the idle bound |

`master status` reports free space under `disk` with the worktrees a reclaim would empty, and below the threshold raises an attention item owned by the master while writes still succeed; a write that fails for want of room, whether the kernel reports it or only a command's output does (`pwd: write error: Disk quota exceeded`), is named as that. With no loop running, `master run --once` reclaims and cycles once.

| Setting in `.graphyard/master.json` | Meaning |
| --- | --- |
| `run.reclaimIdleHours` | How long a worktree may sit untouched before its dependency directories are disposable, 0.25–720; default 3 |
| `run.diskThresholdGb` | Free space below which `master status` raises disk pressure, 0.1–10000; default 10 |

## Recovery procedures

### Lost worker before submission

The lease expires 120 seconds after the last heartbeat; a new worker claims at a higher epoch and old-epoch mutations refuse. Preserve the old worktree and use a new branch and path: expiry does not prove the process stopped. Only a lapse nothing explains raises `lease-loss`; if you stopped the worker, attest it, and an attestation recorded after the lapse settles a standing escalation next tick ([classification](delegation.md#escalation)).

### Submitted implementation needs rework

An active owner may keep heartbeating and update its branch; a push invalidates old evidence. To reassign, stop the previous worker, then run `graphyard rework GY-N --previous-worker-stopped "Reproduce review failure"`: old commands are fenced, the build gate closes, and a lease still held ends as `lease.expired` with cause `stopped-by-attestation`, so no `lease-loss` is raised and a standing one settles next tick. The next worker claims at a higher epoch, registers the existing PR branch in a fresh workspace and resubmits the same PR. Check revocation is asynchronous: suspend merging until the refusing check is visible, and merged work needs a follow-up item.

### Supervisor died leaving a containment quarantine

A foreground worker's supervisor settles its quarantine on verified shutdown. If the supervisor dies first the fence stays up: the item is undispatchable, its exclusive resources stay reserved and its requirements immutable, since expired authority is not evidence that a process stopped.

Run `graphyard master settle-containment GY-N "reason"` on the machine that ran the worker; it verifies there what [automatic containment settlement](protocol/leases.md#automatic-containment-settlement) requires, and the control plane re-checks all of it. The same assessment is in `master status` under [`containment`](master-agent.md#containment-and-recovery). Anything it cannot prove — unreachable host, failed query, surviving process, disagreeing clocks — refuses and prints what it found; then, or where this coordinator cannot inspect the host, confirm the stop yourself and attest with `rework GY-N --previous-worker-stopped "reason"` undelivered, `recover-containment GY-N --previous-worker-stopped "reason"` delivered.

### Worktree creation failed

The reservation is retained. Inspect the Git output and the local branch and worktree state; if no files were created, run the intended `git worktree` operation locally, and if ownership expired use a new attempt with a fresh path — never blanket worktree deletion across worker machines.

### Merge bypass

An observed merge whose gates were not satisfied is a permanent violation: with no verified merge execution the item can never complete. Never backfill evidence or re-run the gates against the merged head. Repair the access rules that allowed it and carry the remaining work in a new item under the full gate set.

## Accepted evidence turns out to be wrong

Revoking leaves criteria, policy revision, review and the submitted attempt untouched, withdrawing only runs that no longer stand.

```json
{ "proof": "integration:claim-safety", "sha": "HEAD_SHA", "baseSha": "BASE_SHA", "policyRevision": 1,
  "reason": "Producer retracted the reported run" }
```

## Bootstrap mode for a self-proving change

An item may require a proof that does not exist yet, when the same change introduces the harness. Mark that criterion with a `bootstrap` declaration in a `requirements` revision — `reason` plus `contractPaths` inside the item's own `plannedFiles` — which needs the `policy:bootstrap` capability. The deferred proof becomes an obligation the next item touching those paths inherits and cannot defer again, cleared only when some change is delivered with trusted, passing, complete evidence; `graphyard obligations` and `diagnose GY-N` list what is outstanding ([bootstrap mode](protocol/bootstrap-mode.md)).

## Credentials

Add or rotate principals in `GRAPHYARD_PRINCIPALS`, then redeploy, each with a unique ID and secret; rotation invalidates the old credential on restarted replicas, and App keys are revoked separately.

- **Proof authority:** A live [grant](#proof-authority-grants), never a `GRAPHYARD_PRINCIPALS` setting after bootstrap
- **The master's `coordinator`:** Beyond reads, only the bounded merge execution, settling a verified-dead quarantine and recording a deployment observation
- **Operator agents:** In the [operator-agent registry](operator-automation.md), never an `admin` entry
- **Where secrets sit:** The dashboard keeps its sign-in token in browser session storage; producer credentials belong to trusted reporters, never pull-request code; logs omit tokens, though blocker text and evidence URLs can carry sensitive data
- **Out of Git:** Environment files, `.graphyard/` and private-key extensions, excluded from the Docker build context too; CI runs a pinned, checksum-verified Gitleaks over all fetched history, a scan and not a guarantee — a committed credential is revoked first, then cleaned from history and caches

## Proof authority grants

Proof authority is Graphyard state, not deployment configuration: an `admin` grants a `producer` exact proof names or bounded patterns, effective on the next request.

```sh
graphyard grants                                   # live authority per principal and its source
graphyard grants grant ci "integration:*,unit:*" "CI runner produces integration and unit proof"
graphyard grants revoke ci "integration:claim-safety" "Runner decommissioned"
graphyard grants history ci                        # append-only record of every change
```

| Pattern | Authorizes | Does not authorize |
| --- | --- | --- |
| `integration:claim-safety` | that exact name | `integration:claim-safety-extra` |
| `integration:*` | every `integration:` proof | any other kind |
| `manual:gy-43/*` | `manual:gy-43/docs-ui` and deeper | `manual:gy-43`, `manual:gy-430/docs` |

## Readiness checklist per completion profile

`graphyard doctor --profile through-merge|preview-validation|production-verification` prints the checklist for one [completion profile](turnkey-delivery-roadmap.md#product-promise-and-boundary); every `missing` or `unknown` item names what resolves it, and `unknown` is never `ready` ([per profile](install.md#readiness-checklist)).

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json` (Git-ignored, mode 0600) and nothing else; `--apply` applies exactly that stored proposal after review, registering only the principals it declares — operator, coordinator, producer, one worker per proposed profile — so a machine with no agent runtime gets no worker credential. Apply is idempotent: unchanged artifacts left alone, existing tokens preserved, operator-edited profiles reported as drift and kept, and a repository that changed between review and apply refuses. Every proposal declares the candidate-bound-environment invariant.

| Detected stack | Deploy target | Topology | Declaration |
| --- | --- | --- | --- |
| Node package with `railway.json`/`railway.toml` | Railway | `ephemeral` | Own environment per candidate, destroyed after review; datastores copied per candidate from structure |
| Python project with `Dockerfile`/compose | Container registry | `pooled` | Isolated containers over a shared datastore, so each candidate needs its own schema or database |
| Static site (`index.html`, `.nojekyll`/`CNAME`) | GitHub Pages | `ephemeral` | A disposable static target per commit |
| Any stack with no deploy configuration | none | `partial` | CI-level isolation only; add a deploy target or accept partial verification |

Vercel and Fly use the Railway pattern with target-specific SHA verification (`RAILWAY_GIT_COMMIT_SHA`, Vercel deployment metadata, `fly status` releases); container deployments propose SHA-tagged images and digest verification. Drift is informational and never auto-repaired: rerun `init --scan`, compare, reapply after review, and `graphyard doctor` reports the stored proposal, the applied setup record and current drift.

## Scale limits

The kernel serializes short coordination mutations, the reconciler processes up to four provider jobs per tick per replica, the list API returns all work, and the event API the most recent 300 events.

### Concurrent reconciliation

A task that changes while GitHub is being read, or an integration lease that expires before a review request is recorded, rejects that stale snapshot and schedules another observation after two seconds, or at once when newer work queued a wakeup.
