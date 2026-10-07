<!-- page: Operate Graphyard | 8 | checklist, incidents. -->
# Operations and recovery

## Daily checklist

- `/healthz` healthy at expected `commit`; `/api/status` without job errors, `delegationLimits.attention` or `production.incidents`.
- `graphyard master status`: `daemon.liveness` `running`, attention owned; recent verified `graphyard db backup`.

## Incident decision tree

- **Item not moving**: fix refusal's cause. Never weaken requirements.
  - Escalation: a declared human session runs `graphyard resolve GY-N TRIGGER "reason"`; explained `lease-loss` needs only `admin --attestation` ([who](delegation.md#who-may-settle-what)).
  - Expired unsubmitted: [lost worker](operations-reference.md#lost-worker-before-submission); another attempt: [rework](operations-reference.md#submitted-implementation-needs-rework); fenced: [quarantine](operations-reference.md#supervisor-died-leaving-a-containment-quarantine).
  - Moving waits fault late: owed `request-rework` head (`owed-decision`) 30min (`reworkDecisionWaitBoundMs`); lapsed containment fence 10min past grace (`containmentSettleWaitBoundMs`), never one the loop settled that cycle, an owed line restating it counting as it; unanswered decision with watch launches left 15min after latest approver launch (`approverRelaunchWaitBoundMs`); unwatched one, owed non-containment escalation (carried too) 30min after request (`masterTurnWaitBoundMs`); stale non-release decision 30min after staling; refusal 30min after, unless re-asked, once (`decision-refused`).
  - Plane-wide failures (502–504, startup 503, refused, timeout) retry: no `loop`/`session-liveness` fault or pre-launch lease loss; dispatch ticks read `plane-unavailable`, outside `dispatch-failures` and the dispatch blocker. Faults/deployment steps fit a fifth of the interval: reads stop waiting (`faults:deferred`, `deployment:deferred`), rest carries (`faults:carried`); `loop-cost` names slowest step's share.
  - A failed manual proof a producer may run returns to a worker, never to an operator escalation; one no producer may run needs an operator witness, an unexecuted one an attestation.
- **Merge refused**: wait or repair; never bypass. Auto-merge `BLOCKED` 10min with gates passing retries head-bound; after 30min one `merge-blocked` item names GitHub's answer. **Merged outside Graphyard**: [bypass](operations-reference.md#merge-bypass). **Wrong accepted evidence**: [revoke](operations-reference.md#accepted-evidence-turns-out-to-be-wrong). **GitHub paused or webhook silent**: [budget](operations-reference.md#github-request-budget). **Smoke proof failed**: [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).
- **Main ahead of production**: [deployment incident](deployment.md#production-deployment-observation). An up-to-date release starts without taking coordination locks; a migrating release fails fast within the health check: it touches only the tables whose DDL changed since it recorded a digest per table (unchanged tables are skipped without any lock) and retries a deadlock or expired lock wait with backoff inside one 30-second lock budget; each attempt waits at most 3 seconds for a lock, so live writes never queue behind it longer.
- **Diagnosis `waiting`**: a provider quota hold ([diagnosis](master-agent.md#research-and-diagnosis)). **Loop down**: [loop](operations-reference.md#master-coordination-loop). **Self-proving change**: [bootstrap](operations-reference.md#bootstrap-mode-for-a-self-proving-change).

## Recovery recipes

```sh
graphyard rework GY-N --previous-worker-stopped "reason"               # worker stopped
graphyard master settle-containment GY-N "reason"                      # settleable
graphyard recover-containment GY-N --previous-worker-stopped "reason"  # delivered, stop confirmed
graphyard unblock GY-N "reason"                                        # unowned blocker
systemctl --user restart graphyard-master                              # loop down, supervised
```

Never attest a stop you have not confirmed; merged work changes only via follow-up items. Outside the lock's PID namespace, `master status` judges the loop by stall bound alone; stalled or absent, on the coordinator host (`/home/vish/code/graphyard`) stop hand-started loops, copy `examples/master/graphyard-master.service` to `~/.config/systemd/user/`, then `systemctl --user daemon-reload && systemctl --user enable --now graphyard-master`.

## Worker host keyring proxy

Confined masters, approvers and proof producers read their GitHub login (`gh auth git-credential`) via keyring-only D-Bus proxy; workers, reviewers use own. Per host: copy `deploy/systemd/graphyard-secrets-bus.socket`, `graphyard-secrets-bus.service`, `graphyard-secrets-bus-filter.service` to `~/.config/systemd/user/`, disable earlier-enabled `graphyard-secrets-bus.service`, `systemctl --user daemon-reload && systemctl --user enable --now graphyard-secrets-bus.socket`. It listens at `$XDG_RUNTIME_DIR/graphyard-secrets-bus` (or `GRAPHYARD_SECRETS_BUS`); absent, bus is masked and sessions push with `GH_TOKEN`. Keyring items aren't filtered: keep other secrets out or use `GH_TOKEN`.

## Safety facts that never change

- Workers never hold `admin`/`coordinator`/`producer` tokens. No AI principal can hold `admin`.
- Proof authority is a live [grant](operations-reference.md#proof-authority-grants); `admin` attests only `manual:` proofs; operator agents only add requirements.
- GitHub merges on passing gates: no bypass, no lifecycle-state endpoint.
- Non-master sessions use own checkouts under `run.worktreeRoot`.
- History is append-only; only routine rows past retention are [compacted](operations-reference.md#storage-retention), each batch audited.

## Deeper references

[Operations reference](operations-reference.md), [delegation](delegation.md).

## Resources and disk

`resourceRegistry` declares bounded resources (`resources`, [remedies](operations-reference.md#control-plane-resources)). The loop removes finished worktrees after `run.reclaimIdleHours` (never dirty/unpushed), stale test temp entries, and idle unowned [panes](master-agent-sessions.md#panes-are-closed-and-reclaimed) two passes saw; `disk` attention below `run.diskThresholdGb`. A clean detached coordinator HEAD moved forward onto a base-branch descendant served by a verified release self-recovers (`upgrade:recovered`: executors restart, loop re-executes); until possible (no verified release or supervisor unit) `escalation:dirty-checkout` says restart onto it, never roll back. Dirty, non-detached or non-forward stands refused, naming paths, HEAD and sessions, blocking self-upgrade.

Main guard revert approver ([provisioning](deployment.md#manual-fallback)): redeploy; verify `/api/status` `mainGuard.revertApprover` names it, `mainGuard.attention` empty, `graphyard doctor` `revert-approver` ready.
