<!-- page: Operate Graphyard | 8 | checklist, incidents. -->
# Operations and recovery

## Daily checklist

- `/healthz` at expected `commit`; `/api/status` without job errors, `delegationLimits.attention`, `production.incidents`.
- `master status`: `daemon.liveness` `running`, attention owned; recent verified `graphyard db backup`.

## Incident decision tree

- **Item not moving**: fix refusal's cause. Never weaken requirements.
  - Escalation: a declared human runs `graphyard resolve GY-N TRIGGER "reason"` ([settling](delegation.md#who-may-settle-what)).
  - Expired unsubmitted: [lost worker](operations-reference.md#lost-worker-before-submission); another attempt: [rework](operations-reference.md#submitted-implementation-needs-rework); fenced: [quarantine](operations-reference.md#supervisor-died-leaving-a-containment-quarantine).
  - Moving waits fault late: 30min — owed `request-rework` (`owed-decision`), unwatched decision, owed escalation/blocker, stale non-release, `actorless` head behind base; 10min — containment past grace; 15min — watched decision after last approver launch; once — unre-asked refusal (`decision-refused`).
  - Plane-wide failures (502–504, refused, timeout) retry without `loop`/`session-liveness` fault (`plane-unavailable`); slow fault/deployment reads defer (`faults:deferred`, `deployment:deferred`); `loop-cost` names the slowest share.
  - A failed producer-runnable manual proof returns to worker, never an operator escalation; one no producer may run needs operator witness, an unexecuted one attestation.
- **Merge refused**: wait or repair; never bypass. Auto-merge `BLOCKED` retries head-bound at 10min; `merge-blocked` at 30min quotes GitHub. **Merged outside Graphyard**: [bypass](operations-reference.md#merge-bypass). **Wrong evidence**: [revoke](operations-reference.md#accepted-evidence-turns-out-to-be-wrong). **GitHub paused/webhook silent**: [budget](operations-reference.md#github-request-budget). **Smoke proof failed**: [delivered](operations-reference.md#delivered-with-a-failed-smoke-proof).
- **Main ahead of production**: [deployment incident](deployment.md#production-deployment-observation). Up-to-date releases take no locks; a migrating one fails fast within health check, touching only tables whose DDL digest changed, retrying deadlocks and lock waits with backoff in one 30-second budget, ≤3 s per lock.
- **Diagnosis `waiting`**: provider quota hold ([diagnosis](master-agent.md#research-and-diagnosis)). **Loop down**: [loop](operations-reference.md#master-coordination-loop). **Self-proving change**: [bootstrap](operations-reference.md#bootstrap-mode-for-a-self-proving-change).

## Recovery recipes

```sh
graphyard rework GY-N --previous-worker-stopped "reason"                # worker stopped
graphyard master settle-containment GY-N "reason"                       # settleable
graphyard recover-containment GY-N --previous-worker-stopped "reason"   # delivered
graphyard unblock GY-N "reason"                                         # unowned blocker
systemctl --user restart graphyard-master-OWNER-NAME                    # loop down
graphyard master checkout-restore "reason"                              # dirty, drifted or stale loop
```

Never attest a stop you have not confirmed; merged work changes only via follow-ups. Outside the lock's PID namespace `master status` judges the loop by stall bound; stalled/absent: stop hand-started loops, install `examples/master/graphyard-master.service` (`systemctl --user daemon-reload && systemctl --user enable --now graphyard-master`).

## Worker host keyring proxy

Confined masters, approvers, producers read GitHub login via a keyring-only D-Bus proxy (workers, reviewers don't): per host, copy the `deploy/systemd/graphyard-secrets-bus*` units, `systemctl --user enable --now graphyard-secrets-bus.socket` (`$XDG_RUNTIME_DIR/graphyard-secrets-bus` or `GRAPHYARD_SECRETS_BUS`); absent, sessions push `GH_TOKEN`.

## Safety facts that never change

- Workers never hold `admin`/`coordinator`/`producer` tokens. No AI principal can hold `admin`.
- Proof authority: live [grant](operations-reference.md#proof-authority-grants); `admin` attests only `manual:` proofs; operator agents only add requirements.
- GitHub merges on passing gates: no bypass, no lifecycle-state endpoint.
- History is append-only; routine rows past retention get [compacted](operations-reference.md#storage-retention).

## Deeper references

[Operations reference](operations-reference.md), [delegation](delegation.md).

## Resources and disk

`resourceRegistry` bounds resources ([remedies](operations-reference.md#control-plane-resources)); finished worktrees reclaimed after `run.reclaimIdleHours` (never dirty/unpushed), idle unowned [panes](master-agent-sessions.md#panes-are-closed-and-reclaimed) seen twice; `disk` attention below `run.diskThresholdGb`. Clean detached coordinator HEAD on a verified-release descendant self-recovers (`upgrade:recovered`); otherwise `escalation:dirty-checkout` (restart onto it, never roll back), remedied by `master checkout-restore` from a verified-serving-release snapshot under a signed single-use grant, never loop-loaded code: none → `failed`; clean moved HEAD → `adopted` (reverted on failed restart); stale loops restart first (`handoff`); cwd-unreadable processes: live threads judge, all-EACCES skipped; the loop continues cut-off entries' `checkout-restore-frozen` writers.

Main guard revert approver ([provisioning](deployment.md#manual-fallback)): redeploy; verify `/api/status` `mainGuard.revertApprover`, empty `mainGuard.attention`, `doctor` `revert-approver`.

`/tmp` pass (own, unheld, mount-free, same-device): test temps 2h; agent checkouts, `opencode` scratch 24h; `tsx-UID` files, `node-compile-cache` versions 6h; `.pnpm-store` files 7d; below a quarter inodes free, runtime roots keep 12 newest. `classes`: `testTemp`, `tsxCache`, `agentWorktree`, `runtimeScratch`, `packageStore`, `compileCache`.
