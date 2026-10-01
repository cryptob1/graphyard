<!-- page: Operate Graphyard | 8 | checklist, incident tree. -->
# Operations and recovery

## Daily checklist

- `/healthz` healthy at the expected `commit`; `/api/status` free of job errors, `delegationLimits.attention` and `production.incidents`; `graphyard master status` shows `daemon.liveness` `running`, every attention item owned; a recent `graphyard db backup` verified.

## Incident decision tree

- **Item not moving**: fix the refusal's cause. Never weaken requirements. Escalations [settle](delegation.md#who-may-settle-what) via `graphyard resolve GY-N TRIGGER "reason"`. See [lease expired unsubmitted](operations-reference.md#lost-worker-before-submission), [another attempt](operations-reference.md#submitted-implementation-needs-rework), [fenced](operations-reference.md#supervisor-died-leaving-a-containment-quarantine). A failed manual proof a producer may run returns to a worker, never to an operator escalation; one no producer may run needs an operator witness, an unexecuted one an attestation.
- **Merge refused**: wait or repair the cause; never bypass.
- [Merged outside Graphyard](operations-reference.md#merge-bypass), [wrong accepted evidence](operations-reference.md#accepted-evidence-turns-out-to-be-wrong) (revoke it), [GitHub paused or webhook silent](operations-reference.md#github-request-budget), [smoke proof failed](operations-reference.md#delivered-with-a-failed-smoke-proof), [loop down](operations-reference.md#master-coordination-loop), [a change must prove itself](operations-reference.md#bootstrap-mode-for-a-self-proving-change).
- **Main ahead of production**: a [deployment incident](operations-reference.md#merged-but-not-deployed). An up-to-date release starts without taking coordination locks; a migrating release fails fast within the health check. It touches only the tables whose DDL changed since it recorded a digest per table (unchanged tables are skipped without any lock), locks each before rebuilding its trigger, retries a deadlock or expired lock wait with backoff (30-second lock budget; failed locks release at once); each attempt waits at most 3 seconds for a lock, so live writes never queue behind it longer. Migrations and backups lock separately; the first `work_index` rebuild briefly locks `work_items`.

## Recovery recipes

```sh
graphyard rework GY-N --previous-worker-stopped "reason"                     # stopped worker
graphyard master settle-containment GY-N "reason"                            # when settleable
graphyard recover-containment GY-N --previous-worker-stopped "reason"        # delivered, stop confirmed
graphyard unblock GY-N "reason"                                              # unowned blocker
```

Never attest a stop you have not confirmed. Merged work changes only through a follow-up item.

## Safety facts that never change

- Workers never hold `admin`, `coordinator` or `producer` tokens. No AI principal can hold `admin`. Proof authority is a live [grant](operations-reference.md#proof-authority-grants); `admin` attests only `manual:` proofs. Operator agents add requirements, never remove.
- Only guarded or audited [repair-lane](master-agent.md#repair-lane) merges: no bypass, no lifecycle-state endpoint. History is append-only; routine rows past retention are [compacted](operations-reference.md#storage-retention) in audited batches.

## Deeper references

- [Operations reference](operations-reference.md), [master agent](master-agent.md), [coordination](coordination.md)
