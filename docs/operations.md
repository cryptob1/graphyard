<!-- page: Operate Graphyard | 8 | checklist, incidents. -->
# Operations and recovery

## Daily checklist

- `/healthz` healthy at expected `commit`; `/api/status` without job errors, `delegationLimits.attention` or `production.incidents`.
- `master status`: `daemon.liveness` `running`, attention owned; recent verified `graphyard db backup`.

## Incident decision tree

- **Item not moving**: fix refusal's cause. Never weaken requirements.
  - Escalation: declared human session runs `graphyard resolve GY-N TRIGGER "reason"` ([settling](delegation.md#who-may-settle-what)).
  - Expired unsubmitted: [lost worker](operations-reference.md#lost-worker-before-submission); another attempt: [rework](operations-reference.md#submitted-implementation-needs-rework); fenced: [quarantine](operations-reference.md#supervisor-died-leaving-a-containment-quarantine).
  - Moving waits fault late: owed `request-rework` (`owed-decision`) 30min; lapsed containment 10min past grace; unanswered watched decision 15min after last approver launch; unwatched decision, owed escalation or blocker 30min (`masterTurnWaitBoundMs`); stale non-release 30min; unre-asked refusal once (`decision-refused`); `actorless` head behind base 30min.
  - Plane-wide failures (502–504, startup 503, refused, timeout) retry without `loop`/`session-liveness` fault; dispatch reads `plane-unavailable`. Slow fault/deployment reads defer (`faults:deferred`, `deployment:deferred`); `loop-cost` names the slowest share.
  - A failed manual proof a producer may run returns to worker, never to an operator escalation; one no producer may run needs operator witness, an unexecuted one an attestation.
- **Merge refused**: wait or repair; never bypass. Auto-merge `BLOCKED` 10min with passing gates retries head-bound; after 30min one `merge-blocked` item names GitHub's answer. **Merged outside Graphyard**: [bypass](operations-reference.md#merge-bypass). **Wrong accepted evidence**: [revoke](operations-reference.md#accepted-evidence-turns-out-to-be-wrong). **GitHub paused or webhook silent**: [budget](operations-reference.md#github-request-budget). **Smoke proof failed**: [delivered with failure](operations-reference.md#delivered-with-a-failed-smoke-proof).
- **Main ahead of production**: [deployment incident](deployment.md#production-deployment-observation). An up-to-date release takes no coordination locks; a migrating release fails fast within health check, touching only tables whose DDL changed since its per-table digest, retrying deadlocks and expired lock waits with backoff in one 30-second lock budget, each attempt waiting ≤3 s per lock so live writes never queue longer.
- **Diagnosis `waiting`**: provider quota hold ([diagnosis](master-agent.md#research-and-diagnosis)). **Loop down**: [loop](operations-reference.md#master-coordination-loop). **Self-proving change**: [bootstrap](operations-reference.md#bootstrap-mode-for-a-self-proving-change).

## Recovery recipes

```sh
graphyard rework GY-N --previous-worker-stopped "reason"                # worker stopped
graphyard master settle-containment GY-N "reason"                       # settleable
graphyard recover-containment GY-N --previous-worker-stopped "reason"   # delivered, stop confirmed
graphyard unblock GY-N "reason"                                         # unowned blocker
systemctl --user restart graphyard-master-OWNER-NAME                    # loop down, supervised (units.json)
graphyard master checkout-restore "reason"                              # dirty: refs/graphyard/checkout-restore/
```

Never attest a stop you have not confirmed; merged work changes only via follow-ups. Outside the lock's PID namespace `master status` judges the loop by stall bound alone; if stalled or absent: stop hand-started loops, install `examples/master/graphyard-master.service`, `systemctl --user daemon-reload && systemctl --user enable --now graphyard-master`.

## Worker host keyring proxy

Confined masters, approvers, producers read GitHub login (`gh auth git-credential`) via a keyring-only D-Bus proxy; workers and reviewers use their own. Per host: copy `deploy/systemd/graphyard-secrets-bus.socket`, `graphyard-secrets-bus.service` and `graphyard-secrets-bus-filter.service`, then `systemctl --user enable --now graphyard-secrets-bus.socket`. Listens at `$XDG_RUNTIME_DIR/graphyard-secrets-bus` (or `GRAPHYARD_SECRETS_BUS`); absent, sessions push with `GH_TOKEN`.

## Safety facts that never change

- Workers never hold `admin`/`coordinator`/`producer` tokens. No AI principal can hold `admin`.
- Proof authority: live [grant](operations-reference.md#proof-authority-grants); `admin` attests only `manual:` proofs; operator agents only add requirements.
- GitHub merges on passing gates: no bypass, no lifecycle-state endpoint.
- History is append-only; only routine rows past retention are [compacted](operations-reference.md#storage-retention).

## Deeper references

[Operations reference](operations-reference.md), [delegation](delegation.md).

## Resources and disk

`resourceRegistry` declares bounded resources ([remedies](operations-reference.md#control-plane-resources)). Loop reclaims finished worktrees after `run.reclaimIdleHours` (never dirty/unpushed; a Git refuse is held a day), stale temps, idle unowned [panes](master-agent-sessions.md#panes-are-closed-and-reclaimed) seen twice; `disk` attention below `run.diskThresholdGb`. Clean detached coordinator HEAD on a verified-release base descendant self-recovers (`upgrade:recovered`); otherwise `escalation:dirty-checkout` says restart onto it, never roll back. Dirty, non-detached or non-forward stays refused (naming paths, HEAD, suspected-writer panes).

Main guard revert approver ([provisioning](deployment.md#manual-fallback)): redeploy; verify `/api/status` `mainGuard.revertApprover` names it, `mainGuard.attention` empty, `doctor` `revert-approver` ready.
