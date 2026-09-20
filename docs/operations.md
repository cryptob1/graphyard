<!-- page: Operate Graphyard | 7 | checklist, decisions, recipes. -->
# Operations and recovery

For the human operator with three minutes: what to check, and what never changes.

## Daily checklist

- `/healthz`: 200, database connectivity, expected `version` and deployed `commit`.
- `/api/status`: no persistent integration errors, `delegationLimits.attention`, or open `production.incidents`.
- `graphyard master status`: `daemon.running` true, `unresolved` empty, every `escalations` entry owned, `disk` above its threshold.
- Delivery graph: no stale observations or unexplained blockers; `graphyard db backup` restore-verified recently; Postgres size watched, nothing pruned.

## Incident decision tree

- **An item is not moving.** Read the refusal; a gate naming a cause re-evaluates once it is fixed. Never weaken requirements. In `escalations` → a declared human session runs `graphyard resolve GY-N TRIGGER "reason"`. No AI principal can, except that any `admin` settles a control-plane-raised `lease-loss` the ledger explains (`--attestation`), and explained lapses self-settle ([who may settle what](delegation.md#who-may-settle-what)). Lease expired unsubmitted → [lost worker](#lost-worker-before-submission); needs another attempt → [rework](#rework-a-submitted-implementation); `containment` quarantine → [settle it](#settle-a-containment-quarantine); unowned blocker → `graphyard unblock GY-N "reason"`.
- **A merge is refused.** A stale observation, a closed gate or a queue position behind the head is normal: wait or repair; never bypass, and never have a worker rebase a queued candidate. One that bypassed Graphyard is a [permanent violation](#merge-bypass).
- **Accepted evidence was wrong** → `graphyard revoke GY-N revoke.json` (`admin` or granted `producer` only) cancels any uncommitted merge execution. [Detail](operations-reference.md#accepted-evidence-turns-out-to-be-wrong)
- **Integration jobs fail** → App access, protection and registered branch, then `github-setup --update-permissions`. [Detail](github.md#preflight-and-holds)
- **Smoke proof failed post-deploy** → it stays Done, delivered with failure; roll back or revert through a new item under the same gates. [Detail](deployment.md#after-the-merge)
- **Main ahead of production, or a capacity variable flagged** → a deployment incident named within five minutes while `/healthz` stays green; fix the deployment, never the ledger.
- **Master loop down** → restart `graphyard master run` freely: the cursor reconciles on start and a second loop refuses while one is alive. [Detail](operations-reference.md#master-coordination-loop)
- **Free space low** → lower `run.reclaimIdleHours`, or run `master run --once` ([worktree disk](operations-reference.md#worktree-disk)).

## Recovery recipes

### Lost worker before submission

Expiry does not prove the process stopped, so keep the old worktree; the next worker claims at a higher epoch and old-epoch commands refuse. [Detail](operations-reference.md#lost-worker-before-submission)

### Rework a submitted implementation

Stop the previous worker yourself, then `graphyard rework GY-N --previous-worker-stopped "Reproduce review failure"`: old commands are fenced, the build gate closes, and a held lease ends as `lease.expired`, not `lease-loss`. [Detail](operations-reference.md#submitted-implementation-needs-rework)

### Settle a containment quarantine

`settleable: true` in `master status` → `graphyard master settle-containment GY-N "reason"`; otherwise attest, with `rework … --previous-worker-stopped` undelivered and `recover-containment GY-N --previous-worker-stopped "reason"` delivered. Never attest a stop you have not confirmed. [Detail](operations-reference.md#supervisor-died-leaving-a-containment-quarantine)

### Merge bypass

An observed merge with unsatisfied gates is permanent: without a verified execution the item cannot complete. Never backfill evidence; repair the access rules and open a follow-up item. [Detail](operations-reference.md#merge-bypass)

## Bootstrap mode

One criterion whose proof harness ships with it may be deferred (`policy:bootstrap`); other gates stay in force, and the next item touching its `contractPaths` owes the proof. [Detail](operations-reference.md#bootstrap-mode-for-a-self-proving-change)

## Safety facts that never change

- Workers never hold `admin`, `coordinator`, or `producer` tokens; an operator agent is never `admin`.
- Proof authority is a live, append-only [grant](operations-reference.md#proof-authority-grants) to a `producer`; only an `admin` grants or revokes, and `admin` attests only `manual:` proofs.
- Only a declared human session resolves an unexplained escalation; an operator agent adds requirements, never removes them.
- The guarded merge is the only merge path: no bypass, no lifecycle-state endpoint.
- History is append-only: nothing is deleted, rewritten, or backfilled.

## Deeper references

[Operations reference](operations-reference.md) holds every procedure in full, with [proof authority grants](operations-reference.md#proof-authority-grants), the [readiness checklist](operations-reference.md#readiness-checklist-per-completion-profile), drift and scale limits; then [master-agent operating mode](master-agent.md), [coordination](coordination.md), [slice-lead delegation](delegation.md) and [GitHub enforcement](github.md).
