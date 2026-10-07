<!-- page: Operate Graphyard | 8 | checklist, incidents. -->
# Operations and recovery

## Daily checklist

- `/healthz` healthy at the expected `commit`; `/api/status` without job errors or `production.incidents`.
- `graphyard master status`: `daemon.liveness` `running`, attention owned; a recent verified `graphyard db backup`.

## Incident decision tree

- **Item not moving**: fix the refusal's cause. Never weaken requirements.
  - Escalation: a declared human session runs `graphyard resolve GY-N TRIGGER "reason"`; explained `lease-loss` needs only `admin --attestation` ([who](delegation.md#who-may-settle-what)).
  - Expired unsubmitted: [lost worker](operations-reference.md#lost-worker-before-submission); another attempt: [rework](operations-reference.md#submitted-implementation-needs-rework); fenced: [quarantine](operations-reference.md#supervisor-died-leaving-a-containment-quarantine).
  - Waits count as faults only past their configured bounds; an approver refusal counts once; a plane-wide control-plane failure (502–504, refused, timeout) retries as `plane-unavailable`.
  - A failed manual proof a producer may run returns to a worker, never to an operator escalation; one no producer may run needs an operator witness, an unexecuted one an attestation.
- **Merge refused**: wait or repair; never bypass. A `BLOCKED` auto-merge with every gate passing is retried; after 30m one `merge-blocked` attention item names GitHub's answer. **Merged outside Graphyard**: [bypass](operations-reference.md#merge-bypass). **Wrong accepted evidence**: [revoke](operations-reference.md#accepted-evidence-turns-out-to-be-wrong). **GitHub paused or webhook silent**: [budget](operations-reference.md#github-request-budget). **Smoke proof failed**: [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).
- **Main ahead of production**: a [deployment incident](operations-reference.md#merged-but-not-deployed). An up-to-date release starts without taking coordination locks; a migrating release fails fast within the health check, touching only tables whose DDL changed (unchanged tables take no lock) and retrying a deadlock or expired lock wait with backoff inside one 30-second lock budget, each attempt waiting at most 3 seconds for a lock so live writes never queue behind it.
- **Diagnosis `waiting`**: a provider quota hold, not a fault ([diagnosis](master-agent.md#research-and-diagnosis)). **Loop down**: [loop](operations-reference.md#master-coordination-loop). **A change must prove itself**: [bootstrap](operations-reference.md#bootstrap-mode-for-a-self-proving-change).

## Recovery recipes

```sh
graphyard rework GY-N --previous-worker-stopped "reason"                # worker stopped
graphyard master settle-containment GY-N "reason"                       # settleable
graphyard recover-containment GY-N --previous-worker-stopped "reason"   # delivered
graphyard unblock GY-N "reason"                                         # unowned blocker
systemctl --user restart graphyard-master                               # loop down
```

Never attest a stop you have not confirmed; merged work changes only via follow-up items. A stalled or absent loop with no unit yet: copy `examples/master/graphyard-master.service` to `~/.config/systemd/user/` and run `systemctl --user daemon-reload && systemctl --user enable --now graphyard-master`.

## Worker host keyring proxy

A confined master, approver or proof producer reads its GitHub login (`gh auth git-credential`) through a keyring-only D-Bus proxy; workers and reviewers use their own credential. Per host, copy `deploy/systemd/graphyard-secrets-bus.socket`, `graphyard-secrets-bus.service` and `graphyard-secrets-bus-filter.service` to `~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl --user enable --now graphyard-secrets-bus.socket`. Without it (`GRAPHYARD_SECRETS_BUS` names the socket) sessions push with `GH_TOKEN`; keep other secrets out of that keyring.

## Safety facts that never change

- Workers never hold `admin`/`coordinator`/`producer` tokens; No AI principal can hold `admin`.
- Proof authority is a live [grant](operations-reference.md#proof-authority-grants); `admin` attests only `manual:` proofs; operator agents add requirements, never remove.
- GitHub merges on passing gates: no bypass, no lifecycle-state endpoint.
- History is append-only; only routine rows past retention are [compacted](operations-reference.md#storage-retention).

## Deeper references

[Operations reference](operations-reference.md), [delegation](delegation.md).

## Resources and disk

Bounded resources are reported in `resources` ([remedies](operations-reference.md#control-plane-resources)). The loop removes finished worktrees after `run.reclaimIdleHours` (never dirty or unpushed) and idle unowned [panes](master-agent-sessions.md#panes-are-closed-and-reclaimed); `disk` attention below `run.diskThresholdGb`. A clean, detached, forward-moved coordinator HEAD served by a verified release self-recovers (`upgrade:recovered`); a dirty tree, non-detached HEAD or non-forward move raises `escalation:dirty-checkout` and blocks self-upgrade.
