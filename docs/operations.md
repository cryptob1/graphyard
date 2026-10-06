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
  - An owed `request-rework` head counts as an `owed-decision` fault only after 30 minutes (`reworkDecisionWaitBoundMs`).
  - A lapsed containment fence counts as a `containment` fault only 10 minutes past its grace window (`containmentSettleWaitBoundMs`), while the loop verifies and settles it; a fence the loop settled is no fault in that cycle.
  - Decision waits the product is moving count late too: the owed line restating a fence counts as that fence; an unanswered decision whose watch has launches left counts 15 minutes after its latest approver launch (`approverRelaunchWaitBoundMs`); a refusal counts 30 minutes after it (`refusalAnswerWaitBoundMs`) and not at all once its requester asks the item for another decision.
  - A plane-wide control-plane failure (502–504, refused connection, call timeout) is no `loop` fault: refused decides and fault-class filings retry next cycle, and failed dispatch ticks read as the `plane-unavailable` outage, never `dispatch-failures`, nor count toward the dispatch blocker. The faults step stops reading after a fifth of the interval (`faults:deferred`) and observes again next cycle. An approver's refused diagnosis decision counts once, as `decision-refused`.
  - A failed manual proof a producer may run returns to a worker, never to an operator escalation; one no producer may run needs an operator witness, an unexecuted one an attestation.
- **Merge refused**: wait or repair; never bypass. Auto-merge `BLOCKED` 10m with every gate passing is retried as a head-bound merge; after 30m one `merge-blocked` attention item names GitHub's answer. **Merged outside Graphyard**: [bypass](operations-reference.md#merge-bypass). **Wrong accepted evidence**: [revoke](operations-reference.md#accepted-evidence-turns-out-to-be-wrong). **GitHub paused or webhook silent**: [budget](operations-reference.md#github-request-budget). **Smoke proof failed**: [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).
- **Main ahead of production**: a [deployment incident](operations-reference.md#merged-but-not-deployed). An up-to-date release starts without taking coordination locks; a migrating release fails fast within the health check: it touches only the tables whose DDL changed since it recorded a digest per table (unchanged tables are skipped without any lock), and retries a deadlock or expired lock wait with backoff inside one 30-second lock budget; each attempt waits at most 3 seconds for a lock, so live writes never queue behind it longer.
- **Diagnosis `waiting`**: a provider quota hold, not a fault; see [diagnosis](master-agent.md#research-and-diagnosis). **Loop down**: [loop](operations-reference.md#master-coordination-loop). **A change must prove itself**: [bootstrap](operations-reference.md#bootstrap-mode-for-a-self-proving-change).

## Recovery recipes

```sh
graphyard rework GY-N --previous-worker-stopped "reason"                # worker stopped
graphyard master settle-containment GY-N "reason"                       # settleable
graphyard recover-containment GY-N --previous-worker-stopped "reason"   # delivered, stop confirmed
graphyard unblock GY-N "reason"                                         # unowned blocker
```

Never attest a stop you have not confirmed; merged work changes only via follow-up items.

## Worker host keyring proxy

A confined master, approver or proof producer reads its GitHub login (`gh auth git-credential`) through a keyring-only D-Bus proxy; workers and reviewers use their own credential. Install once per host: copy `deploy/systemd/graphyard-secrets-bus.socket`, `graphyard-secrets-bus.service` and `graphyard-secrets-bus-filter.service` to `~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl --user enable --now graphyard-secrets-bus.socket` (disable an earlier-enabled `graphyard-secrets-bus.service` first). It listens at `$XDG_RUNTIME_DIR/graphyard-secrets-bus` unless `GRAPHYARD_SECRETS_BUS` names another; without it the bus is masked and sessions push with `GH_TOKEN`.

The filter cannot select keyring items: keep other secrets out of that keyring, or skip the proxy and use `GH_TOKEN`.

## Safety facts that never change

- Workers never hold `admin`/`coordinator`/`producer` tokens; No AI principal can hold `admin`.
- Proof authority is a live [grant](operations-reference.md#proof-authority-grants); `admin` attests only `manual:` proofs.
- Operator agents add requirements, never remove.
- GitHub merges on passing gates: no bypass, no lifecycle-state endpoint.
- Non-master sessions run in their own checkout, never the coordinator's.
- Coordination-lock writes read whole only their item, overlaps and dependencies: under 500 ms at 1,000 items; a worker's heartbeat takes only its item's lock.
- History is append-only; only routine rows past retention are [compacted](operations-reference.md#storage-retention), each batch audited.

## Deeper references

- [Operations reference](operations-reference.md), [delegation](delegation.md)

## Resources and disk

`resourceRegistry` declares bounded resources, reported in `resources` ([remedies](operations-reference.md#control-plane-resources)). The loop removes finished worktrees after `run.reclaimIdleHours` (never dirty or unpushed), stale test temp entries and idle unowned [panes](master-agent-sessions.md#panes-are-closed-and-reclaimed) seen by two passes. `disk` attention below `run.diskThresholdGb`. Every non-master session's checkout lives under `run.worktreeRoot`. Each cycle a dirty coordinator checkout, or a HEAD other than the commit the loop runs, raises `escalation:dirty-checkout` naming the paths, HEAD and sessions pointing at it, and blocks self-upgrade until clean.
