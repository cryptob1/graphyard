<!-- page: Operate Graphyard | 7 | daily checklist, incident decision tree, and recovery recipes in three minutes. -->
# Operations and recovery

Three minutes for the human operator. Deeper: [operations reference](operations-reference.md), [glossary](glossary.md).

## Daily checklist

- `/healthz`: 200, database connectivity, expected `version` and deployed `commit`.
- `/api/status`: no persistent integration errors, `delegationLimits.attention`, or open `production.incidents`.
- `graphyard master status`: `daemon.running` true, `unresolved` empty, every `escalations` entry owned.
- Delivery graph: no stale observations or unexplained blockers.
- `graphyard db backup` restore verified recently in isolation.
- Postgres size watched; nothing pruned.

## Incident decision tree

- **An item is not moving.** Read the refusal.
  - A gate names a cause → fix it; it re-evaluates. Never weaken requirements.
  - In `escalations` → a declared human session runs `graphyard resolve GY-N TRIGGER "reason"`. No AI principal can, except: any `admin` settles a control-plane-raised `lease-loss` explained by a `blocked` report or stopped-worker attestation (`--attestation`); explained lapses self-settle.
  - Lease expired unsubmitted → [lost worker](#lost-worker-before-submission).
  - Needs another attempt → [rework](#rework-a-submitted-implementation).
  - `containment` quarantine → [settle it](#settle-a-containment-quarantine).
  - Unowned blocker → `graphyard unblock GY-N "reason"`.
- **A merge is refused.** Stale observation, closed gate, or queue position behind the head is normal: wait or repair; never bypass or have a worker rebase a queued candidate.
- **A merge bypassed Graphyard** → [merge bypass](#merge-bypass).
- **Accepted evidence was wrong** → `graphyard revoke GY-N revoke.json` (`admin` or granted `producer` only) cancels any uncommitted merge execution. [Detail](operations-reference.md#accepted-evidence-turns-out-to-be-wrong)
- **Integration jobs fail** → [GitHub jobs and outages](#github-jobs-and-outages).
- **Smoke proof failed post-deploy** → [delivered with failure](#delivered-with-a-failed-smoke-proof).
- **Main ahead of production or capacity variable flagged** → [merged but not deployed](#merged-but-not-deployed).
- **Master loop down** → [restart it](#restart-the-master-loop).

## Recovery recipes

### Lost worker before submission

Leases expire 120 seconds after the last heartbeat; a new worker claims at a higher epoch and old-epoch commands refuse. Keep the old worktree: expiry does not prove it stopped. [Detail](operations-reference.md#lost-worker-before-submission)

### Rework a submitted implementation

Stop the previous worker yourself, then:

```sh
graphyard rework GY-N --previous-worker-stopped "Reproduce review failure"
```

Old commands are fenced, the build gate closes, a held lease becomes `lease.expired`, not `lease-loss`. Merged work needs a follow-up item. [Detail](operations-reference.md#submitted-implementation-needs-rework)

### Settle a containment quarantine

`settleable: true` in `master status` → `graphyard master settle-containment GY-N "reason"`; the control plane re-verifies. Otherwise confirm the worker stopped and attest: `rework … --previous-worker-stopped` (undelivered) or `graphyard recover-containment GY-N --previous-worker-stopped "reason"` (delivered). Never attest a stop you have not confirmed. [Detail](operations-reference.md#supervisor-died-leaving-a-containment-quarantine)

### Restart the master loop

Restart `graphyard master run` freely: the cursor reconciles on start; nothing dispatches twice or is lost. Never edit it; a second loop refuses while one is alive. It [cycles](operations-reference.md#perpetual-master-loop) until every released item is Done and live-verified or blocked on record. [Detail](operations-reference.md#master-coordination-loop)

### GitHub jobs and outages

Check App access, protection, and registered branch. A missing App permission holds its jobs until accepted: `github-setup --update-permissions`. [Detail](operations-reference.md#github-job-fails)

### Merge bypass

An observed merge with unsatisfied gates is a permanent violation: no verified execution, its item cannot complete. Never backfill evidence; repair the access rules and open a follow-up item. [Detail](operations-reference.md#merge-bypass)

### Delivered with a failed smoke proof

It stays Done, delivered with failure. Roll back or revert through a new item under the same gates; never delete the failure or backfill a pass. [Detail](operations-reference.md#delivered-with-a-failed-smoke-proof)

### Merged but not deployed

A merge production never served is a deployment incident; `production.incidents`, `doctor`, and `master status` name its reason within five minutes though `/healthz` stays green. Fix the deployment (often a `delegationLimits.attention` variable), never the ledger. [Detail](operations-reference.md#merged-but-not-deployed) · [Capacity variables](operations-reference.md#capacity-variables-no-longer-cover-the-principals)

## Bootstrap mode

The human operator may defer one criterion whose proof harness ships with it (`policy:bootstrap`); other gates stay in force; the next item touching its `contractPaths` owes the proof. [Detail](operations-reference.md#bootstrap-mode-for-a-self-proving-change)

## Safety facts that never change

- Workers never hold `admin`, `coordinator`, or `producer` tokens; an operator agent is never `admin`.
- Proof authority is a live, append-only [grant](operations-reference.md#proof-authority-grants) to a `producer`; only an `admin` grants or revokes, and `admin` attests only `manual:` proofs.
- Only a declared human session resolves an unexplained escalation; an operator agent adds requirements, never removes them.
- The guarded merge is the only merge path: no bypass, no lifecycle-state endpoint.
- History is append-only: nothing is deleted, rewritten, or backfilled.

## Deeper references

- [Operations reference](operations-reference.md) — every procedure in full, the perpetual master loop, credentials, [proof authority grants](operations-reference.md#proof-authority-grants), the [readiness checklist](operations-reference.md#readiness-checklist-per-completion-profile), setup drift, scale limits, dashboard behaviour.
- [Master-agent operating mode](master-agent.md) — the loop, reviews, browser administration, queue.
- [Coordination](coordination.md) — requirement revisions, overlap, shared resources, the two-machine drill.
- [Slice-lead delegation](delegation.md) — rulings, holds, escalations.
- [GitHub enforcement](github.md) — protection, merge queue, smoke proof.
