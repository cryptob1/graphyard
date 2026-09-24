<!-- page: Operate Graphyard | 7 | daily checklist, incident tree, recovery recipes. -->
# Operations and recovery

Deeper: [operations reference](operations-reference.md).

## Daily checklist

- `/healthz`: 200, expected `version` and `commit`.
- `/api/status`: no persistent integration errors, `delegationLimits.attention`, `production.incidents`.
- `graphyard master status`: `daemon.running`, `unresolved` empty, every escalation owned.
- A recent `graphyard db backup` restore verified in isolation; Postgres size watched.

## Incident decision tree

- **Item not moving** — read the refusal and fix its cause. Never weaken requirements.
  - Escalation → a declared human session runs `graphyard resolve GY-N TRIGGER "reason"`. No AI principal can, except that any `admin` settles an explained `lease-loss` with `--attestation`.
  - Lease expired unsubmitted → [lost worker](#lost-worker-before-submission). Needs another attempt → [rework](#rework-a-submitted-implementation). Quarantine → [settle it](#settle-a-containment-quarantine). Unowned blocker → `graphyard unblock GY-N "reason"`.
- **Merge refused** — stale observation, closed gate or queue position: wait or repair; never bypass.
- **Merge bypassed Graphyard** → [merge bypass](#merge-bypass).
- **Wrong accepted evidence** → `graphyard revoke GY-N revoke.json` ([detail](operations-reference.md#accepted-evidence-turns-out-to-be-wrong)).
- **GitHub paused or webhook silent** → [request budget](operations-reference.md#github-request-budget).
- **Smoke proof failed** → [delivered with a failed smoke proof](#delivered-with-a-failed-smoke-proof). **Main ahead of production** → [merged but not deployed](#merged-but-not-deployed).

## Recovery recipes

### Lost worker before submission

Leases expire 120 seconds after the last heartbeat; the next claim gets a higher epoch and old-epoch commands refuse. Keep the worktree. [Detail](operations-reference.md#lost-worker-before-submission)

### Rework a submitted implementation

```sh
graphyard rework GY-N --previous-worker-stopped "Reproduce review failure"
```

Only after the previous worker is stopped. Merged work needs a follow-up item. [Detail](operations-reference.md#submitted-implementation-needs-rework)

### Settle a containment quarantine

If `master status` shows `settleable: true`, run `graphyard master settle-containment GY-N "reason"`. Otherwise confirm the stop and attest with `rework … --previous-worker-stopped` or, when delivered, `graphyard recover-containment GY-N --previous-worker-stopped "reason"`. Never attest a stop you have not confirmed. [Detail](operations-reference.md#supervisor-died-leaving-a-containment-quarantine)

### Restart the master loop

Restart `graphyard master run` freely; it reconciles and never dispatches twice. [Detail](operations-reference.md#master-coordination-loop)

### Merge bypass

A merge with unsatisfied gates is a permanent violation; never backfill evidence. Repair access and open a follow-up. [Detail](operations-reference.md#merge-bypass)

### Delivered with a failed smoke proof

It stays Done, delivered with failure. Revert or roll back through a new item. [Detail](operations-reference.md#delivered-with-a-failed-smoke-proof)

### Merged but not deployed

A merge production never served is a deployment incident named in `production.incidents` and `master status`. Fix the deployment, not the ledger. [Detail](operations-reference.md#merged-but-not-deployed)

## Bootstrap mode

The human operator (or `policy:bootstrap`) may defer one criterion whose proof harness ships with the change; the next item touching its `contractPaths` owes the proof. [Detail](operations-reference.md#bootstrap-mode-for-a-self-proving-change)

## Safety facts that never change

- Workers never hold `admin`, `coordinator` or `producer` tokens. No AI principal can hold `admin`.
- Proof authority is a live [grant](operations-reference.md#proof-authority-grants); `admin` attests only `manual:` proofs.
- Operator agents add requirements, never remove them.
- The guarded merge is the only path: no bypass, no lifecycle-state endpoint.
- History is append-only.

## Deeper references

- [Operations reference](operations-reference.md)
- [Master agent](master-agent.md) · [Coordination](coordination.md) · [Delegation](delegation.md) · [GitHub](github.md)
