<!-- page: Operate Graphyard | 8 | checklist and incident tree. -->
# Operations and recovery

## Daily checklist

- `/healthz` healthy at the expected `commit`; `/api/status` without job errors, `delegationLimits.attention` or `production.incidents`.
- `graphyard master status`: `daemon.liveness` `running`, every attention item owned.
- A recent `graphyard db backup` verified.

## Incident decision tree

- **Item not moving**: fix the refusal's cause. Never weaken requirements.
  - Escalation: a declared human session runs `graphyard resolve GY-N TRIGGER "reason"`; an explained `lease-loss` is settleable by `admin --attestation` alone.
  - Lease expired unsubmitted: [lost worker](operations-reference.md#lost-worker-before-submission). Another attempt: [rework](operations-reference.md#submitted-implementation-needs-rework). Fenced: [quarantine](operations-reference.md#supervisor-died-leaving-a-containment-quarantine).
  - A new head owed by `request-rework` is a rework round the loop decides itself; it counts as an `owed-decision` fault only after 30 minutes (`reworkDecisionWaitBoundMs`). An owed escalation counts at once.
  - A failed manual proof a producer may run returns to a worker, never to an operator escalation; one no producer may run needs an operator witness, an unexecuted one an attestation.
- **Merge refused**: wait or repair the cause; never bypass. Auto-merge `BLOCKED` past ten minutes with every gate passing is asked of GitHub as a head-bound merge; GitHub's refusal is the item's merge refusal in `master status`, and after 30 minutes one `merge-blocked` attention item names the pull request and GitHub's last answer.
- **Merged outside Graphyard**: [merge bypass](operations-reference.md#merge-bypass).
- **Wrong accepted evidence**: [revoke it](operations-reference.md#accepted-evidence-turns-out-to-be-wrong).
- **GitHub paused or webhook silent**: [request budget](operations-reference.md#github-request-budget).
- **Smoke proof failed**: [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).
- **Main ahead of production**: a [deployment incident](operations-reference.md#merged-but-not-deployed). An up-to-date release starts without taking coordination locks; a migrating release fails fast within the health check, and live traffic migrates safely: it touches only the tables whose DDL changed since it recorded a digest per table (unchanged tables are skipped without any lock), locks each table before rebuilding its trigger, and retries a deadlock or expired lock wait with backoff inside one 30-second lock budget, failed locks release at once; each attempt waits at most 3 seconds for a lock, so live writes never queue behind it longer; migrations and backups lock separately. First `work_index` rebuild briefly locks `work_items`.
- **Loop down**: [master coordination loop](operations-reference.md#master-coordination-loop).
- **A change must prove itself**: [bootstrap mode](operations-reference.md#bootstrap-mode-for-a-self-proving-change).

## Recovery recipes

```sh
graphyard rework GY-N --previous-worker-stopped "reason"                     # stopped worker
graphyard master settle-containment GY-N "reason"                            # when settleable
graphyard recover-containment GY-N --previous-worker-stopped "reason"        # delivered, stop confirmed
graphyard unblock GY-N "reason"                                              # unowned blocker
```

Never attest a stop you have not confirmed. Merged work changes only through a follow-up item.

## Worker host keyring proxy

A confined master, approver or proof producer reads its GitHub login with `gh auth git-credential` through a keyring-only D-Bus proxy; workers and reviewers carry their own credential and never get it. Install it once per host: copy `deploy/systemd/graphyard-secrets-bus.socket`, `graphyard-secrets-bus.service` and `graphyard-secrets-bus-filter.service` to `~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl --user enable --now graphyard-secrets-bus.socket` (an earlier install that enabled `graphyard-secrets-bus.service` itself disables it first). The socket listens at `$XDG_RUNTIME_DIR/graphyard-secrets-bus` (else `/run/user/<uid>/graphyard-secrets-bus`); `GRAPHYARD_SECRETS_BUS` in the launcher's environment names another socket. Without a live socket the session bus is masked by `/dev/null`, and a session pushes with `GH_TOKEN` from its environment.

The filter admits only the Secret Service methods a credential read needs, but by method and path, not by item: a session can read every unlocked item, not only the GitHub login. On such a host keep other secrets out of that keyring, or leave the proxy uninstalled and use `GH_TOKEN`.

## Safety facts that never change

- Workers never hold `admin`, `coordinator` or `producer` tokens. No AI principal can hold `admin`.
- Proof authority is a live [grant](operations-reference.md#proof-authority-grants); `admin` attests only `manual:` proofs.
- Operator agents add requirements, never remove.
- Only guarded merges: no bypass, no lifecycle-state endpoint.
- Under the coordination lock a write reads whole only its item, overlapping open items and dependencies; the rest are cached projections or `work_index` summaries, so at 1,000 items claims, heartbeats, submissions and registry selects hold it under 500 ms and a reconcile pass under 5 s.
- History is append-only; only routine rows past their retention window are [compacted](operations-reference.md#storage-retention), each batch audited.

## Deeper references

- [Operations reference](operations-reference.md), [master agent](master-agent.md), [coordination](coordination.md), [delegation](delegation.md)

## Resources and disk

`resourceRegistry` declares every bounded resource, reported under `resources` ([remedies](operations-reference.md#control-plane-resources)). Each cycle the loop removes finished worktrees (`run.reclaimIdleHours`, at most `run.worktreeRemovalLimit`, never dirty or unpushed; logged to `.graphyard/worktree-reclaim.jsonl`), stale [test temp entries](operations-reference.md#control-plane-resources) and `/tmp/tsx-<uid>` (dead owner or 2h/6h idle, unheld, ≤100, one pass in flight), and raises `disk` attention below `run.diskThresholdGb`. Review and proof checkouts live under `run.worktreeRoot` (default `~/.local/share/graphyard/worktrees/REPOSITORY-ID`). Agentless panes Graphyard launched are swept each cycle ([panes](master-agent-sessions.md#panes-are-closed-and-reclaimed)); the reclaim closes any unowned, non-`working` pane on a profile's name, `unknown` or recordless included, once two passes 60 s apart saw it.
