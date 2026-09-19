# Operations and recovery

Three minutes for the human operator. Detail: [operations reference](operations-reference.md); terms: [glossary](glossary.md).

## Daily checklist

- `/healthz` returns 200 with database connectivity.
- `/api/status` shows no persistent integration errors.
- `graphyard master status`: `daemon.running` true, `unresolved` empty, every `escalations` entry owned.
- The delivery graph shows no stale observations or unexplained blockers.
- A backup restore was verified recently in isolation.
- Postgres size is watched; nothing is ever pruned.

## Incident decision tree

- **An item is not moving.** Read the refusal on the card.
  - A gate names a cause → fix it; it re-evaluates. Never weaken requirements.
  - Listed in `escalations` → a declared human session runs `graphyard resolve GY-N TRIGGER "reason"`. No AI principal can.
  - Lease expired, nothing submitted → [lost worker](#lost-worker-before-submission).
  - Submitted, needs another attempt → [rework](#rework-a-submitted-implementation).
  - `containment` shows a quarantine → [settle it](#settle-a-containment-quarantine).
  - Blocker with no owner → `graphyard unblock GY-N "reason"`.
- **A merge is refused.** A stale observation, closed gate, or queue position behind the head is normal. Wait or repair; never bypass, never have a worker rebase a queued candidate.
- **A merge bypassed Graphyard** → [merge bypass](#merge-bypass).
- **Integration jobs fail** → [GitHub jobs and outages](#github-jobs-and-outages).
- **A smoke proof failed after deploy** → [delivered with failure](#delivered-with-a-failed-smoke-proof).
- **The master loop is down** → [restart it](#restart-the-master-loop).

## Recovery recipes

### Lost worker before submission

The lease expires 120 seconds after the last heartbeat; a new worker claims at a higher epoch and old-epoch commands refuse. Keep the old worktree; the new attempt gets a fresh branch. Expiry does not prove the old process stopped. [Detail](operations-reference.md#lost-worker-before-submission)

### Rework a submitted implementation

Stop the previous worker yourself, then:

```sh
graphyard rework GY-N --previous-worker-stopped "Reproduce review failure"
```

This fences old commands, closes the build gate, and records a `lease-loss` escalation if a lease was held; resolve it once the replacement is verified. The new worker registers the PR branch in a fresh workspace and resubmits. Merged work needs a follow-up item. [Detail](operations-reference.md#submitted-implementation-needs-rework)

### Settle a containment quarantine

A dead supervisor leaves the fence up deliberately. When `master status` shows `settleable: true` with no refusals, run `graphyard master settle-containment GY-N "reason"`; the control plane re-verifies. Otherwise confirm the worker stopped yourself, then attest: `rework … --previous-worker-stopped` (undelivered) or `graphyard recover-containment GY-N --previous-worker-stopped "reason"` (delivered). Never attest a stop you have not confirmed. [Detail](operations-reference.md#supervisor-died-leaving-a-containment-quarantine)

### Restart the master loop

Restart `graphyard master run` freely: its cursor reconciles on start; nothing is dispatched twice or lost. Never edit the cursor. A second loop refuses while the first is alive. [Detail](operations-reference.md#master-coordination-loop)

### GitHub jobs and outages

Jobs retry after 45 seconds and recover expired leases after 90. Check App access, protection, and the registered branch. A missing App permission (`appPermissions`) holds its jobs until accepted; fix with `github-setup --update-permissions`. The merge gate refuses observations older than two minutes; a direct GitHub merge has no verified execution and cannot complete its item. [Detail](operations-reference.md#github-job-fails)

### Merge bypass

An observed merge with unsatisfied gates is a permanent violation. Never backfill evidence. Repair the access rules and open a follow-up item. [Detail](operations-reference.md#merge-bypass)

### Delivered with a failed smoke proof

The item stays Done, delivered with failure. Roll back or revert through a new work item under the same gates; never delete the failure or backfill a pass. [Detail](operations-reference.md#delivered-with-a-failed-smoke-proof)

## Bootstrap mode

The human operator may defer one criterion whose proof harness ships in the same change: a `bootstrap` declaration naming `contractPaths` inside the planned files. It needs `policy:bootstrap`, leaves every other gate in force, and becomes an obligation for the next item touching those paths. [Detail](operations-reference.md#bootstrap-mode-for-a-self-proving-change)

## Safety facts that never change

- Workers never hold `admin`, `coordinator`, or `producer` tokens; an operator agent is never an `admin`.
- Proof authority is a live grant to a `producer` principal; `admin` attests only `manual:` proofs.
- Only a declared human session resolves an escalation; an operator agent adds requirements but never removes them.
- The guarded merge is the only merge path: no bypass, no lifecycle-state endpoint.
- History is append-only: nothing is deleted, rewritten, or backfilled.

## Deeper references

- [Operations reference](operations-reference.md) — every procedure in full, credentials, proof authority grants, setup drift, scale limits, dashboard behaviour.
- [Master-agent operating mode](master-agent.md) — the loop, reviews, browser administration, queue.
- [Coordination](coordination.md) — requirement revisions, overlap, shared resources, the two-machine drill.
- [Slice-lead delegation](delegation.md) — rulings, holds, escalations.
- [GitHub enforcement](github.md) — protection, merge queue, smoke proof.
