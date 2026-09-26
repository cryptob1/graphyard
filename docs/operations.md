<!-- page: Operate Graphyard | 8 | checklist and incident tree. -->
# Operations and recovery

## Daily checklist

- `/healthz` is healthy at the expected `commit`; `/api/status` shows no persistent job errors, `delegationLimits.attention` or `production.incidents`.
- `graphyard master status`: `daemon.liveness` `running`, every attention item owned.
- A recent `graphyard db backup` verified.

## Incident decision tree

- **Item not moving**: fix the cause. Never weaken requirements.
  - Escalation: a declared human session runs `graphyard resolve GY-N TRIGGER "reason"`. No AI principal can alone, except an `admin` settling an explained `lease-loss` with `--attestation`.
  - Lease expired unsubmitted: [lost worker](operations-reference.md#lost-worker-before-submission). Needs another attempt: [rework](operations-reference.md#submitted-implementation-needs-rework). Fenced: [quarantine](operations-reference.md#supervisor-died-leaving-a-containment-quarantine).
- **Merge refused**: wait or repair its cause; never bypass.
- **Merged outside Graphyard**: [merge bypass](operations-reference.md#merge-bypass).
- **Wrong accepted evidence**: [revoke it](operations-reference.md#accepted-evidence-turns-out-to-be-wrong).
- **GitHub paused or webhook silent**: [request budget](operations-reference.md#github-request-budget).
- **Smoke proof failed**: [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).
- **Main ahead of production**: deployment incident: [merged but not deployed](operations-reference.md#merged-but-not-deployed). An up-to-date release starts without taking coordination locks; a migrating release fails fast within the health check; migrations and backups lock separately. The first `work_index` rebuild briefly locks `work_items` (SHARE ROW EXCLUSIVE).
- **Loop down**: [master coordination loop](operations-reference.md#master-coordination-loop).
- **A change must prove itself**: [bootstrap mode](operations-reference.md#bootstrap-mode-for-a-self-proving-change).

## Recovery recipes

```sh
graphyard rework GY-N --previous-worker-stopped "Reproduce review failure"   # worker stopped first
graphyard master settle-containment GY-N "reason"                            # master status shows settleable: true
graphyard recover-containment GY-N --previous-worker-stopped "reason"        # delivered item, stop confirmed
graphyard unblock GY-N "reason"                                              # unowned blocker
graphyard revoke GY-N revoke.json                                            # withdraw wrong evidence
```

Never attest a stop you have not confirmed. Merged work changes only through a follow-up item.

## Safety facts that never change

- Workers never hold `admin`, `coordinator` or `producer` tokens. No AI principal can hold `admin`.
- Proof authority is a live [grant](operations-reference.md#proof-authority-grants); `admin` attests only `manual:` proofs.
- Operator agents add requirements, never remove them.
- Only guarded or audited [repair-lane](master-agent.md#repair-lane) merges: no bypass, no lifecycle-state endpoint.
- History is append-only.

## Deeper references

- [Operations reference](operations-reference.md) · [Master agent](master-agent.md)
