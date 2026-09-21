<!-- page: Operate Graphyard | 7 | checklist, recipes. -->
# Operations and recovery

For the human operator with three minutes: what to check, and what never changes.

## Daily checklist

- `/healthz`: 200, database connectivity, expected `version` and deployed `commit`.
- `/api/status`: no persistent integration errors, `delegationLimits.attention`, or open `production.incidents`.
- `graphyard master status`: `daemon.running` true, `unresolved` empty, every `escalations` entry owned, `disk` above its threshold.
- Delivery graph: no stale observations or unexplained blockers; `graphyard db backup` restore-verified recently; Postgres size watched, nothing pruned.

## Incident decision tree

- **An item is not moving.** Read the refusal; a gate naming a cause re-evaluates once fixed. Never weaken requirements.
  - **In `escalations`:** a declared human session runs `graphyard resolve GY-N TRIGGER "reason"`. No AI principal can, except for a `lease-loss` the ledger explains ([who may settle what](delegation.md#who-may-settle-what)).
  - **Lease expired unsubmitted, another attempt needed, or a `containment` quarantine:** the [recipes](#recovery-recipes) below.
  - **Unowned blocker:** `graphyard unblock GY-N "reason"`.
- **A merge is refused.** Stale observation, closed gate or queue position behind the head is normal: wait or repair; never bypass, never have a worker rebase a queued candidate. One that bypassed Graphyard is a [permanent violation](operations-reference.md#merge-bypass).
- **[Accepted evidence was wrong](operations-reference.md#accepted-evidence-turns-out-to-be-wrong):** `graphyard revoke GY-N revoke.json` (`admin` or granted `producer` only) cancels any uncommitted merge execution.
- **[Integration jobs fail](github.md#preflight-and-holds):** App access, protection and registered branch, then `github-setup --update-permissions`.
- **[Smoke proof failed post-deploy](deployment.md#after-the-merge):** stays Done, delivered with failure; roll back or revert through a new item under the same gates.
- **Main ahead of production, or a capacity variable flagged:** a deployment incident named within five minutes while `/healthz` stays green; fix the deployment, never the ledger.
- **[Master loop down](operations-reference.md#master-coordination-loop):** restart `graphyard master run` freely: the cursor reconciles on start, a second loop refuses while one is alive.
- **Free space low:** lower `run.reclaimIdleHours`, or run `master run --once` ([worktree disk](operations-reference.md#worktree-disk), [checkout root](deployment.md#agent-hosts-the-managed-worktree-root)).

## Recovery recipes

Each procedure in full, with what it verifies and what it refuses:

- [Lost worker before submission](operations-reference.md#lost-worker-before-submission) — keep the old worktree
- [Rework a submitted implementation](operations-reference.md#submitted-implementation-needs-rework) — stop the previous worker yourself first
- [Settle a containment quarantine](operations-reference.md#supervisor-died-leaving-a-containment-quarantine) — Never attest a stop you have not confirmed
- [Merge bypass](operations-reference.md#merge-bypass) — never backfill evidence; only a two-party `merge` decision reconciles it

## Bootstrap mode

One criterion whose proof harness ships with it may be [deferred](operations-reference.md#bootstrap-mode-for-a-self-proving-change) under `policy:bootstrap`, other gates staying in force; the next item touching its `contractPaths` owes the proof.

## Safety facts that never change

The guarded merge is the only merge path: no bypass, no lifecycle-state endpoint, over an append-only history nothing rewrites. [Who decides what](glossary.md#who-decides), [the boundaries that do not move](how-graphyard-works.md#the-boundaries-that-do-not-move), [who may settle what](delegation.md#who-may-settle-what).

## Deeper references

Every procedure is in the [operations reference](operations-reference.md); then the [master guide](master-agent.md), [coordination](coordination.md) and [GitHub enforcement](github.md).
