<!-- page: Operate Graphyard | 8 | checklist, incidents. -->
# Operations and recovery

## Daily checklist

- `/healthz` at expected `commit` (CLI at another release refuses: `graphyard upgrade`); `/api/status`: no job errors, `delegationLimits.attention`, `production.incidents`.
- `master status`: `daemon.liveness` `running`, attention owned; recent verified `graphyard db backup`.

## Incident decision tree

- **Item not moving**: fix refusal's cause; `master status` flags no progress 60min or merges unreleased 90min, filing nothing. Never weaken requirements.
  - Escalation: declared human runs `graphyard resolve GY-N TRIGGER "reason"` ([settling](delegation.md#who-may-settle-what)).
  - Expired unsubmitted: [lost worker](operations-reference.md#lost-worker-before-submission); retry: [rework](operations-reference.md#submitted-implementation-needs-rework); fenced: [quarantine](operations-reference.md#supervisor-died-leaving-a-containment-quarantine).
  - Late-fault waits: 30min: owed `request-rework` (`owed-decision`), unwatched decision, owed escalation/blocker, stale non-release, `actorless` head behind base; a queue-held trial or push refusal is the writer's motion ([fault classes](master-agent-reference.md#fault-classes)); 10min: containment past grace; 15min: watched decision post-launch; once: unre-asked refusal (`decision-refused`).
  - Plane-wide failures (502–504, refused, timeout; proxy 502s) retry faultless: outage-refused preserves, coordinates re-sent across restarts (`plane-unavailable`); slow fault/deployment reads defer (`faults:deferred`, `deployment:deferred`); `loop-cost` names the slowest.
  - A failed producer-runnable manual proof returns to worker, never to an operator escalation; one no producer may run needs operator witness, an unexecuted one an attestation.
- **Merge refused**: wait or repair, never bypass; `BLOCKED` retries head-bound 10min, `merge-blocked` 30min quotes GitHub. **Merged outside**: [bypass](operations-reference.md#merge-bypass). **Wrong evidence**: [revoke](operations-reference.md#accepted-evidence-turns-out-to-be-wrong). **GitHub paused/webhook silent**: [budget](operations-reference.md#github-request-budget). **Smoke failed**: [delivered](operations-reference.md#delivered-with-a-failed-smoke-proof).
- **Main ahead of production**: [deployment incident](deployment.md#production-deployment-observation). An up-to-date release takes no coordination locks; a migrating release fails fast within health check, touching only tables whose DDL changed since its per-table digest, retrying deadlocks and expired lock waits with backoff in one 30-second lock budget, each attempt ≤3 s per lock so live writes never queue longer.
- **Diagnosis `waiting`**: [provider quota](master-agent.md#research-and-diagnosis). **Loop down**: [loop](operations-reference.md#master-coordination-loop). **Self-proving change**: [bootstrap](operations-reference.md#bootstrap-mode-for-a-self-proving-change).

## Recovery recipes

```sh
graphyard rework GY-N --previous-worker-stopped "reason"
graphyard master settle-containment GY-N "reason"                       # settleable
graphyard recover-containment GY-N --previous-worker-stopped "reason"   # delivered
graphyard unblock GY-N "reason"                                         # unowned
systemctl --user restart graphyard-master-OWNER-NAME                    # loop down
graphyard master checkout-restore "reason"                              # dirty/drifted/diverged
```

Never attest a stop you have not confirmed. Outside its namespace, `master status` judges by stall bound; stalled/absent: stop hand-started loops, install `examples/master/graphyard-master.service`, `systemctl --user daemon-reload && systemctl --user enable --now graphyard-master`.

## Worker host keyring proxy

Confined masters/approvers/producers (not workers/reviewers) read GitHub through a keyring-only D-Bus proxy: copy `deploy/systemd/graphyard-secrets-bus*`, `systemctl --user enable --now graphyard-secrets-bus.socket` (`GRAPHYARD_SECRETS_BUS`); absent, sessions push `GH_TOKEN`.

## Safety facts that never change

- Workers never hold `admin`/`coordinator`/`producer` tokens. No AI principal can hold `admin`.
- Proof authority: live [grant](operations-reference.md#proof-authority-grants); `admin` attests only `manual:` proofs; operator agents only add requirements.
- GitHub merges on passing gates: no bypass, no lifecycle-state endpoint.
- History is append-only; routine rows past retention get [compacted](operations-reference.md#storage-retention).

## Deeper references

[Operations reference](operations-reference.md), [delegation](delegation.md).

## Resources and disk

`resourceRegistry` bounds resources ([remedies](operations-reference.md#control-plane-resources)); worktrees reclaimed after `run.reclaimIdleHours` (never dirty/unpushed), idle unowned [panes](master-agent-sessions.md#panes-are-closed-and-reclaimed); `disk` attention under `run.diskThresholdGb` is answered (reported, faultless) while the latest worktree-reclaim pass is ≤30 min old and out of reach (nothing disposable now, no backlog or error, its removals included; no fault standing); ≤ half the threshold, or ENOSPC/EDQUOT, always raises; a standing low reading holds to a tenth of the threshold above it, whatever the pass answers. Clean detached verified-release descendant self-recovers (`upgrade:recovered`); otherwise `escalation:dirty-checkout`. Dirty checkout: loop (loaded-code executors) restarts via a `.graphyard/held-cli` snapshot's launcher though commands run its `bin/graphyard.mjs` (return it to HEAD); lifting the pin needs the checkout on its commit clean, not merely clean paths. `master checkout-restore` serves a snapshot; moved: `adopted`; diverged: `refs/graphyard/checkout-restore/diverged-*`; stale: `handoff`.

Main guard revert approver ([provisioning](deployment.md#manual-fallback)): redeploy; verify `mainGuard.revertApprover`, empty `mainGuard.attention`, `doctor`.

`/tmp` pass (own, unheld, same-device): test temps 2h; agent checkouts/`opencode`+`claude-UID` scratch 24h; `tsx-UID`/`node-compile-cache` 6h; `.pnpm-store` 7d; low inodes keep 12 newest. Entries another account's subtree traps stay, marked `<entry>.foreign`, unfaulted.
