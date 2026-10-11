<!-- page: Operate Graphyard | 8 | checklist, incidents. -->
# Operations and recovery

## Daily checklist

- `/healthz` at expected `commit`; `/api/status` without job errors, `delegationLimits.attention`, `production.incidents`.
- `master status`: `daemon.liveness` `running`, attention owned, recent `graphyard db backup`.

## Incident decision tree

- **Item not moving**: fix refusal's cause. Never weaken requirements.
  - Escalation: a human session runs `graphyard resolve GY-N TRIGGER "reason"` ([settling](delegation.md#who-may-settle-what)).
  - Expired unsubmitted: [lost worker](operations-reference.md#lost-worker-before-submission); another attempt: [rework](operations-reference.md#submitted-implementation-needs-rework); fenced: [quarantine](operations-reference.md#supervisor-died-leaving-a-containment-quarantine).
  - Moving waits fault late (`owed-decision`, `decision-refused`): owed `request-rework`, unwatched decision, owed escalation, blocker, stale non-release or `actorless` head behind base 30min; lapsed containment 10min past grace; watched decision 15min after last approver launch; unre-asked refusal once.
  - Plane-wide failures (502–504, startup 503, refused, timeout) retry without `loop`/`session-liveness` fault (dispatch: `plane-unavailable`); slow fault/deployment reads defer (`faults:deferred`, `deployment:deferred`).
  - A failed manual proof a producer may run returns to worker, never to an operator escalation; one no producer may run needs operator witness, an unexecuted one an attestation.
- **Merge refused**: wait or repair; never bypass. Auto-merge `BLOCKED` 10min with passing gates retries head-bound; after 30min `merge-blocked` quotes GitHub. **Merged outside Graphyard**: [bypass](operations-reference.md#merge-bypass). **Wrong evidence**: [revoke](operations-reference.md#accepted-evidence-turns-out-to-be-wrong). **GitHub paused**: [budget](operations-reference.md#github-request-budget). **Smoke failed**: [delivered](operations-reference.md#delivered-with-a-failed-smoke-proof).
- **Main ahead of production**: [deployment incident](deployment.md#production-deployment-observation). An up-to-date release takes no coordination locks; a migrating release fails fast within health check, touching only tables whose DDL changed since its per-table digest, retrying deadlocks and expired lock waits with backoff in one 30-second lock budget, each attempt waiting ≤3 s per lock so live writes never queue longer.
- **Diagnosis `waiting`**: quota hold ([diagnosis](master-agent.md#research-and-diagnosis)). **Loop down**: [loop](operations-reference.md#master-coordination-loop). **Self-proving**: [bootstrap](operations-reference.md#bootstrap-mode-for-a-self-proving-change).

## Recovery recipes

```sh
graphyard rework GY-N --previous-worker-stopped "reason"                # worker stopped
graphyard master settle-containment GY-N "reason"                       # settleable
graphyard recover-containment GY-N --previous-worker-stopped "reason"   # delivered
graphyard unblock GY-N "reason"                                         # unowned blocker
systemctl --user restart graphyard-master-OWNER-NAME                    # loop down (units.json)
graphyard master checkout-restore "reason"                              # dirty, moved HEAD or stale loop
```

Never attest a stop you have not confirmed; merged work changes via follow-ups. Outside the lock's PID namespace `master status` judges the loop by stall bound; stalled or absent: stop hand-started loops, enable `examples/master/graphyard-master.service`.

## Worker host keyring proxy

Confined masters, approvers, producers read GitHub login (`gh auth git-credential`) via keyring-only D-Bus proxy; workers, reviewers don't. Per host: install `deploy/systemd/graphyard-secrets-bus*` units, enable the socket (`$XDG_RUNTIME_DIR/graphyard-secrets-bus` or `GRAPHYARD_SECRETS_BUS`); absent, sessions push `GH_TOKEN`.

## Safety facts that never change

- Workers never hold `admin`/`coordinator`/`producer` tokens. No AI principal can hold `admin`.
- Proof authority: live [grant](operations-reference.md#proof-authority-grants); `admin` attests only `manual:` proofs; operator agents only add requirements.
- GitHub merges on passing gates: no bypass, no lifecycle-state endpoint.
- History is append-only; routine rows past retention are [compacted](operations-reference.md#storage-retention).

## Deeper references

[Operations reference](operations-reference.md), [delegation](delegation.md).

## Resources and disk

`resourceRegistry` declares bounded resources ([remedies](operations-reference.md#control-plane-resources)). Loop reclaims finished worktrees after `run.reclaimIdleHours` (never dirty/unpushed), idle unowned [panes](master-agent-sessions.md#panes-are-closed-and-reclaimed); `disk` attention below `run.diskThresholdGb`. Clean detached coordinator HEAD descending from a verified-release base self-recovers (`upgrade:recovered`); otherwise `escalation:dirty-checkout` says restart onto it, never roll back, or refuses dirty/non-detached, naming paths, HEAD, writer panes. `master checkout-restore` runs in a detached shared clone of the verified serving release (else `origin/BASE`) under a credential-signed single-use grant naming its issuing pid (the cursor lock holder), never loop-loaded code: no serve-capable release → `failed`; clean moved HEAD → `adopted`; a loop whose cursor `release` predates it is restarted first, its `handoff`-marked request waiting (failed restart: command fails); a cwd-unreadable same-user process is judged by its live threads: inside → writer, all EACCES → skipped, else refused.

Main guard revert approver: [provision](deployment.md#manual-fallback), redeploy.
