<!-- page: Operate Graphyard | 8 | checklist and incident tree. -->
# Operations and recovery

## Daily checklist

- `/healthz` healthy at the expected `commit`; `/api/status` without job errors, `delegationLimits.attention`, `production.incidents`.
- `graphyard master status`: `daemon.liveness` `running`, attention owned.
- Recent verified `graphyard db backup`.

## Incident decision tree

- **Item not moving**: fix the refusal's cause. Never weaken requirements.
  - Escalation: declared human session runs `graphyard resolve GY-N TRIGGER "reason"`; explained `lease-loss` needs only `admin --attestation` ([who](delegation.md#who-may-settle-what)).
  - Expired unsubmitted: [lost worker](operations-reference.md#lost-worker-before-submission); another attempt: [rework](operations-reference.md#submitted-implementation-needs-rework); fenced: [quarantine](operations-reference.md#supervisor-died-leaving-a-containment-quarantine).
  - A failed manual proof a producer may run returns to a worker, never to an operator escalation; one no producer may run needs an operator witness, an unexecuted one an attestation.
- **Merge refused**: wait or repair; never bypass. **Merged outside Graphyard**: [bypass](operations-reference.md#merge-bypass). **Wrong accepted evidence**: [revoke](operations-reference.md#accepted-evidence-turns-out-to-be-wrong). **GitHub paused or webhook silent**: [budget](operations-reference.md#github-request-budget). **Smoke proof failed**: [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).
- **Main ahead of production**: a [deployment incident](operations-reference.md#merged-but-not-deployed). An up-to-date release starts without coordination locks; a migrating release fails fast in health check. A migration touches only tables whose DDL changed (unchanged tables skipped without lock) and retries deadlock or expired lock wait with backoff in a 30s lock budget; each attempt waits ≤3s for a lock, so live writes never queue longer.
- **Loop down**: [loop](operations-reference.md#master-coordination-loop). **A change must prove itself**: [bootstrap](operations-reference.md#bootstrap-mode-for-a-self-proving-change).

## Recovery recipes

```sh
graphyard rework GY-N --previous-worker-stopped "reason"                # worker stopped
graphyard master settle-containment GY-N "reason"                       # settleable
graphyard recover-containment GY-N --previous-worker-stopped "reason"   # delivered, stop confirmed
graphyard unblock GY-N "reason"                                         # unowned blocker
```

Never attest a stop you have not confirmed; merged work changes only via follow-up items.

## Safety facts that never change

- Workers never hold `admin`/`coordinator`/`producer` tokens; No AI principal can hold `admin`.
- Proof authority is a live [grant](operations-reference.md#proof-authority-grants); `admin` attests only `manual:` proofs.
- Operator agents add requirements, never remove.
- Only guarded/audited [repair-lane](master-agent.md#repair-lane) merges: no bypass, no lifecycle-state endpoint.
- History is append-only; only routine rows past retention are [compacted](operations-reference.md#storage-retention), each batch audited.

## Deeper references

- [Operations reference](operations-reference.md), [master agent](master-agent.md), [coordination](coordination.md), [delegation](delegation.md)
