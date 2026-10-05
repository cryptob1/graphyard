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
- **Merge refused**: wait or repair; never bypass. Auto-merge `BLOCKED` 10m with every gate passing is retried as a head-bound merge; after 30m one `merge-blocked` attention item names GitHub's answer. **Merged outside Graphyard**: [bypass](operations-reference.md#merge-bypass). **Wrong accepted evidence**: [revoke](operations-reference.md#accepted-evidence-turns-out-to-be-wrong). **GitHub paused or webhook silent**: [budget](operations-reference.md#github-request-budget). **Smoke proof failed**: [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).
- **Main ahead of production**: a [deployment incident](operations-reference.md#merged-but-not-deployed). An up-to-date release starts without taking coordination locks; a migrating release fails fast within the health check: it touches only the tables whose DDL changed since it recorded a digest per table (unchanged tables are skipped without any lock), and retries a deadlock or expired lock wait with backoff inside one 30-second lock budget; each attempt waits at most 3 seconds for a lock, so live writes never queue behind it longer.
- **Loop down**: [loop](operations-reference.md#master-coordination-loop). **A change must prove itself**: [bootstrap](operations-reference.md#bootstrap-mode-for-a-self-proving-change).

## Recovery recipes

```sh
graphyard rework GY-N --previous-worker-stopped "reason"                # worker stopped
graphyard master settle-containment GY-N "reason"                       # settleable
graphyard recover-containment GY-N --previous-worker-stopped "reason"   # delivered, stop confirmed
graphyard unblock GY-N "reason"                                         # unowned blocker
```

Never attest a stop you have not confirmed; merged work changes only via follow-up items.

## Worker host keyring proxy

A confined master, approver or proof producer reads its GitHub login with `gh auth git-credential` through a keyring-only D-Bus proxy; workers and reviewers carry their own credential and never get it. Install it once per host: copy `deploy/systemd/graphyard-secrets-bus.socket`, `graphyard-secrets-bus.service` and `graphyard-secrets-bus-filter.service` to `~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl --user enable --now graphyard-secrets-bus.socket` (an earlier install that enabled `graphyard-secrets-bus.service` itself disables it first). The socket listens at `$XDG_RUNTIME_DIR/graphyard-secrets-bus` (else `/run/user/<uid>/graphyard-secrets-bus`); `GRAPHYARD_SECRETS_BUS` in the launcher's environment names another socket. Without a live socket the session bus is masked by `/dev/null`, and a session pushes with `GH_TOKEN` from its environment.

The filter admits only the Secret Service methods a credential read needs, but by method and path, not by item: a session can read every unlocked item, not only the GitHub login. On such a host keep other secrets out of that keyring, or leave the proxy uninstalled and use `GH_TOKEN`.

## Safety facts that never change

- Workers never hold `admin`/`coordinator`/`producer` tokens; No AI principal can hold `admin`.
- Proof authority is a live [grant](operations-reference.md#proof-authority-grants); `admin` attests only `manual:` proofs.
- Operator agents add requirements, never remove.
- Only guarded/audited [repair-lane](master-agent.md#repair-lane) merges: no bypass, no lifecycle-state endpoint.
- Coordination-lock writes read whole only their item, overlaps and dependencies: under 500 ms at 1,000 items.
- History is append-only; only routine rows past retention are [compacted](operations-reference.md#storage-retention), each batch audited.

## Deeper references

- [Operations reference](operations-reference.md), [master agent](master-agent.md), [coordination](coordination.md), [delegation](delegation.md)

## Resources and disk

`resourceRegistry` declares bounded resources, reported in `resources` ([remedies](operations-reference.md#control-plane-resources)). The loop removes finished worktrees after `run.reclaimIdleHours` (never dirty or unpushed; `.graphyard/worktree-reclaim.jsonl`), stale [test temp entries](operations-reference.md#control-plane-resources) and idle `/tmp/tsx-<uid>`; unowned idle profile panes close ([panes](master-agent-sessions.md#panes-are-closed-and-reclaimed)); `disk` attention below `run.diskThresholdGb`. Checkouts: `run.worktreeRoot`.
