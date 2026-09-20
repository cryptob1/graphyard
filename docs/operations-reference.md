<!-- page: Operate Graphyard | 7 | every procedure, credentials, grants, limits. -->
# Operations reference

For an operator or master in an incident: the procedure behind each [recipe](operations.md).

## Perpetual master loop

The terminal condition, the cycle and the non-stopping conditions are stated once, in the [master-agent guide](master-agent.md#operate). Blockers have two records: a per-item blocker the lease holder writes with `graphyard blocked GY-N EPOCH "reason"`, and a deployment blocker recorded as a follow-up item naming the delivered item, its merge commit and the external cause. `master verify-deployment GY-N` names a cause and fix on every refusal: *unobserved* (configure `--deployment-url`), *stale* (rerun), *does not serve the merge yet* (keep cycling), *local checkout*, *already records deployment*.

## Master coordination loop

`graphyard master run` is the durable coordinator; run it under systemd or Herdr ([service unit](../examples/master/graphyard-master.service)), never as a chat session. It re-reads `.graphyard/master.json` before every cycle and dispatch tick, so profiles, `herdrWorkspace`, `autoMerge` and every `run` setting apply without a restart.

- `--interval SECONDS`: Seconds between cycles, 5–900; default 20
- `--dispatch-interval SECONDS`: Seconds between reads of review and producer requests, 5–30; default 10
- `--reviewer-profile NAME`: The reviewer profile automatic dispatch launches when more than one is configured
- `--producer-timeout MINUTES`: How long a producer session may run before it is recorded as expired, 5–1440; default 120
- `--proof-workflow FILE`: Workflow the loop asks GitHub to run when a candidate is missing automatable proof
- `--deployment-url URL`: JSON endpoint reporting the commit the running release serves
- `--deployment-sha-field PATH`: Dotted field holding that commit; default `commit`
- `--smoke-workflow FILE`: Workflow run against the live deployment for a `deploySmoke` delivery

## Recovery procedures

### Lost worker before submission

The lease expires 120 seconds after the last heartbeat; a new worker claims at a higher epoch and old-epoch mutations refuse. Preserve the old worktree and use a new branch and path: expiry does not prove the process stopped. Only a lapse nothing explains raises `lease-loss`; if you stopped the worker, attest it, and an attestation recorded after the lapse settles a standing escalation on the next tick ([classification](delegation.md#escalation)).

### Submitted implementation needs rework

An active owner may keep heartbeating and update its branch; a push invalidates old evidence automatically. To reassign, stop the previous worker, then run `graphyard rework GY-N --previous-worker-stopped "Reproduce review failure"`. That fences old commands, closes the build gate and wakes reconciliation; a lease still held ends as `lease.expired` with cause `stopped-by-attestation`, explained by the attestation in the same command, so no `lease-loss` is raised and a standing one settles next tick. The next worker claims at a higher epoch, registers the existing PR branch in a fresh workspace and resubmits the same PR. Check revocation is asynchronous, so suspend merging until the refusing check is visible; merged work needs a follow-up item.

### Supervisor died leaving a containment quarantine

A foreground worker's supervisor settles its quarantine on verified shutdown. If the supervisor dies first the fence stays up on purpose: the item is undispatchable, its exclusive resources stay reserved and its requirements stay immutable, because expired authority is not evidence that a process stopped.

Run `graphyard master settle-containment GY-N "reason"` on the machine that ran the worker. It verifies there what [automatic containment settlement](protocol/leases.md#automatic-containment-settlement) requires, and the control plane re-checks all of it and records the verification. Read the same assessment first in `master status` under [`containment`](master-agent.md#containment-and-recovery). Anything the command cannot prove — unreachable host, failed query, surviving process, disagreeing clocks — refuses and prints what it found. When it refuses, or the worker ran where this coordinator cannot inspect, confirm the stop yourself and attest: `graphyard rework GY-N --previous-worker-stopped "reason"` undelivered, `graphyard recover-containment GY-N --previous-worker-stopped "reason"` delivered.

### Worktree creation failed

The reservation is deliberately retained. Inspect the Git output and the local branch and worktree state; if no files were created, run the intended `git worktree` operation locally, and if ownership expired use a new attempt with a fresh path. Never run blanket worktree deletion across worker machines.

### Merge bypass

An observed merge whose gates were not satisfied is a permanent violation: Graphyard holds no verified merge execution, so the item can never complete. Never backfill evidence or re-run the gates against the merged head. Repair the access rules that allowed it — branch protection, App installation, human merge rights — and carry the remaining work in a new item under the full gate set.

## Accepted evidence turns out to be wrong

Revoking leaves criteria, policy revision, review and the submitted attempt untouched and withdraws only the runs that no longer stand.

```json
{ "proof": "integration:claim-safety", "sha": "HEAD_SHA", "baseSha": "BASE_SHA", "policyRevision": 1,
  "reason": "Producer retracted the reported run" }
```

## Bootstrap mode for a self-proving change

An item can require a proof that does not exist yet, because the same change introduces the harness. Mark that criterion with a `bootstrap` declaration in a `requirements` revision — `reason` plus `contractPaths` inside the item's own `plannedFiles` — which needs the `policy:bootstrap` capability. The deferred proof becomes an obligation the next item touching those paths inherits and cannot defer again, cleared only when some change is delivered with trusted, passing, complete evidence; `graphyard obligations` and `diagnose GY-N` list what is outstanding ([bootstrap mode](protocol/bootstrap-mode.md)).

## Credentials

Add or rotate principals in `GRAPHYARD_PRINCIPALS`, then redeploy, each with a unique ID and secret; rotation invalidates the old credential on restarted replicas, and App keys are revoked separately.

- **Proof authority:** Not configured in `GRAPHYARD_PRINCIPALS` after bootstrap — it is a live [grant](#proof-authority-grants)
- **The master's `coordinator`:** Beyond reads it may only acquire the bounded merge execution, settle a verified-dead quarantine and record a deployment observation
- **Operator agents:** Live in the [operator-agent registry](operator-automation.md), never as an `admin` entry
- **Where secrets sit:** The dashboard keeps its sign-in token in browser session storage; producer credentials belong to trusted reporters, never to arbitrary pull-request code; logs omit tokens, though blocker text and evidence URLs can carry sensitive data
- **Out of Git:** Environment files, `.graphyard/` and private-key extensions, excluded from the Docker build context too; CI runs a pinned, checksum-verified Gitleaks over all fetched history

Gitleaks is not a guarantee: if a credential is ever committed, revoke it first, then handle history and cached copies.

## Proof authority grants

Proof authority is Graphyard state, not deployment configuration. An `admin` grants a `producer` the right to produce trusted evidence for exact proof names or bounded patterns, effective on the next request without a restart.

```sh
graphyard grants                                   # live authority per principal and its source
graphyard grants grant ci "integration:*,unit:*" "CI runner produces integration and unit proof"
graphyard grants revoke ci "integration:claim-safety" "Runner decommissioned"
graphyard grants history ci                        # append-only record of every change
```

| Pattern | Authorizes | Does not authorize |
| --- | --- | --- |
| `integration:claim-safety` | exactly that name | `integration:claim-safety-extra` |
| `integration:*` | every `integration:` proof | any other proof kind |
| `manual:gy-43/*` | `manual:gy-43/docs-ui` and deeper | `manual:gy-43`, `manual:gy-430/docs` |

## Readiness checklist per completion profile

`graphyard doctor --profile through-merge|preview-validation|production-verification` prints the checklist for one [completion profile](turnkey-delivery-roadmap.md#product-promise-and-boundary); every `missing` or `unknown` item names the command or setting that resolves it, and `unknown` is never `ready` ([what each profile covers](install.md#readiness-checklist)).

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json` (Git-ignored, mode 0600) and changes nothing else; `--apply` applies exactly that stored proposal after review. Apply registers only the principals the proposal declares — operator, coordinator, producer and one worker per proposed profile — so a machine with no agent runtime gets no worker credential; install a runtime and rerun to add one. Apply is idempotent: unchanged artifacts are left alone, existing principal tokens are preserved, and operator-edited profiles are reported as drift and kept rather than overwritten. A repository that changed between review and apply makes apply refuse, leaving the stored proposal untouched.

The candidate-bound-environment invariant is declared in every proposal: `ephemeral` where the stack allows it, `pooled` or `partial` with declared data isolation where it does not.

| Detected stack | Deploy target | Topology | Declaration |
| --- | --- | --- | --- |
| Node package with `railway.json`/`railway.toml` | Railway | `ephemeral` | Each candidate deploys to its own environment built from its commit and destroyed after review; datastores are per-candidate copies seeded from structure |
| Python project with `Dockerfile`/compose | Container registry | `pooled` | Isolated containers but a shared datastore was detected, so each candidate needs its own schema or database seeded from structure only |
| Static site (`index.html`, `.nojekyll`/`CNAME`) | GitHub Pages | `ephemeral` | A disposable static target per commit, discarded after review |
| Any stack with no deploy configuration | none | `partial` | Only CI-level isolation exists; add a deploy target or accept partial verification |

Vercel and Fly detections choose the Railway pattern with target-specific SHA verification (`RAILWAY_GIT_COMMIT_SHA`, Vercel deployment metadata, `fly status` releases); container deployments propose SHA-tagged images and digest verification. Drift is informational and never auto-repaired: rerun `init --scan`, compare, and reapply only after review. `graphyard doctor` reports the stored proposal, the applied setup record and current drift.

## Scale limits

The kernel serializes short coordination mutations, the reconciler processes up to four provider jobs per tick per replica, the list API returns all work, and the event API returns the most recent 300 events.

### Concurrent reconciliation

If a task changes while GitHub is being read, or the integration lease expires before a review request can be recorded, Graphyard rejects that stale snapshot and schedules another observation after two seconds, or immediately when newer work has queued a wakeup.
