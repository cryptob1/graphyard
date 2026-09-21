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
  - **Lease expired unsubmitted:** [lost worker](#recovery-recipes)
  - **Needs another attempt:** [rework](#recovery-recipes)
  - **`containment` quarantine:** [settle it](#recovery-recipes)
  - **Unowned blocker:** `graphyard unblock GY-N "reason"`
- **A merge is refused.** Stale observation, closed gate or queue position behind the head is normal: wait or repair; never bypass, never have a worker rebase a queued candidate. One that bypassed Graphyard is a [permanent violation](#recovery-recipes).
- **[Accepted evidence was wrong](operations-reference.md#accepted-evidence-turns-out-to-be-wrong):** `graphyard revoke GY-N revoke.json` (`admin` or granted `producer` only) cancels any uncommitted merge execution
- **[Integration jobs fail](github.md#preflight-and-holds):** App access, protection and registered branch, then `github-setup --update-permissions`
- **[Smoke proof failed post-deploy](deployment.md#after-the-merge):** stays Done, delivered with failure; roll back or revert through a new item under the same gates
- **Main ahead of production, or a capacity variable flagged:** deployment incident named within five minutes while `/healthz` stays green; fix the deployment, never the ledger.
- **[Master loop down](operations-reference.md#master-coordination-loop):** restart `graphyard master run` freely: the cursor reconciles on start, a second loop refuses while one is alive
- **Free space low:** lower `run.reclaimIdleHours`, or run `master run --once` ([worktree disk](operations-reference.md#worktree-disk)).

## Recovery recipes

- **[Lost worker before submission](operations-reference.md#lost-worker-before-submission):** keep the old worktree
- **[Rework a submitted implementation](operations-reference.md#submitted-implementation-needs-rework):** stop the previous worker yourself, then `graphyard rework GY-N --previous-worker-stopped "Reproduce review failure"`
- **[Settle a containment quarantine](operations-reference.md#supervisor-died-leaving-a-containment-quarantine):** `graphyard master settle-containment GY-N "reason"` while `settleable: true`; otherwise attest, `rework … --previous-worker-stopped` undelivered, `recover-containment GY-N --previous-worker-stopped "reason"` delivered. Never attest a stop you have not confirmed
- **[Merge bypass](operations-reference.md#merge-bypass):** an observed merge no valid execution covered stays out of Done until a two-party `merge` decision reconciles it; never backfill evidence

## Bootstrap mode

One criterion whose proof harness ships with it may be deferred (`policy:bootstrap`), other gates staying in force; the next item touching its `contractPaths` owes the proof. [Detail](operations-reference.md#bootstrap-mode-for-a-self-proving-change)

## Safety facts that never change

- Workers never hold `admin`, `coordinator` or `producer` tokens, and an operator agent is never `admin`.
- Proof authority is a live [grant](operations-reference.md#proof-authority-grants) to a `producer` that only an `admin` makes or revokes; `admin` attests only `manual:` proofs.
- Only a declared human session resolves an unexplained escalation; an operator agent adds requirements, never removes them.
- The guarded merge is the only merge path: no bypass, no lifecycle-state endpoint; history is append-only, nothing deleted, rewritten or backfilled.

## Deeper references

[Operations reference](operations-reference.md) holds every procedure in full; then the [master guide](master-agent.md), [coordination](coordination.md), [delegation](delegation.md) and [GitHub enforcement](github.md).
