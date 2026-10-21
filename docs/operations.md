<!-- page: Operate Graphyard | 8 | checklist, incidents. -->
# Operations and recovery

## Daily checklist

- `/healthz` at expected `commit` (another release refuses: `graphyard upgrade`); `/api/status`: no job errors.
- `master status`: `daemon.liveness` `running`, attention owned; recent `graphyard db backup`.

## Incident decision tree

- **Item not moving**: fix the refusal's cause; `master status` flags no progress 60min. Never weaken requirements. Escalation: a declared human runs `graphyard resolve GY-N TRIGGER "reason"` ([settling](master-agent-reference.md#recovery)). Expired unsubmitted: [lost worker](#lost-worker-before-submission); retry: [rework](#submitted-implementation-needs-rework); fenced: [quarantine](#supervisor-died-leaving-a-containment-quarantine). Late-fault waits (30min/10min/15min): a queue-held trial, push or `base failure` refusal is the writer's motion. A failed producer-runnable manual proof returns to worker, never to an operator escalation.

## Recovery recipes

```sh
graphyard rework GY-N --previous-worker-stopped "reason"
graphyard master settle-containment GY-N "reason"
graphyard recover-containment GY-N --previous-worker-stopped "reason"
graphyard unblock GY-N "reason"
systemctl --user restart graphyard-master-OWNER-NAME
graphyard master checkout-restore "reason"
```

Never attest a stop you have not confirmed.

`master checkout-restore` serves the verified snapshot under the loop's loader; an unstartable serve dies at its startup bound, never hanging.

## Safety facts that never change

- Workers never hold `admin`/`coordinator`/`producer` tokens. No AI principal can hold `admin`.
- Only the merge writer moves main, on passing gates: no bypass, no lifecycle-state endpoint.
- History is append-only; rows past retention get compacted.

## Deeper references

[The coordination loop](#master-coordination-loop), [merge bypass](#merge-bypass), [bootstrap mode](#bootstrap-mode-for-a-self-proving-change).

## Resources and disk

`resourceRegistry` bounds resources ([remedies](#control-plane-resources)); `disk` attention under `run.diskThresholdGb` is answered (reported, faultless) while the latest worktree-reclaim pass is ≤30 min old and out of reach (nothing disposable now, no backlog or error, its removals included; no fault standing); ≤ half the threshold, or ENOSPC/EDQUOT, always raises; a standing low reading holds to a tenth of the threshold above it, whatever the pass answers. Otherwise `escalation:dirty-checkout`.

## Master coordination loop

`master status` `daemon`: health, `cycleTime` (30-minute p50/p95); cycles >60s raise `loop`; `daemon.stepStalls` names one verified remedy per signature.

## Lost worker before submission

Leases expire 120s after last heartbeat (plane stall: 30s `stallRenewalWindowMs`, not another lease period); higher-epoch claim keeps worktree. Unexplained lapses raise [`lease-loss`](protocol/work-commands.md#how-a-lease-ends).

## Supervisor died leaving a containment quarantine

[`master settle-containment`](#recovery-recipes) verifies nothing survives; refused: confirm stop, then rework, or `recover-containment`.

## Retro synthesis

Minutely scan (`GET /api/interventions`) raises each crossed pattern as attention, never an item; a non-drafting operator agent approves. The merge writer reruns a trial's failing files; a pass lands, filing nothing (no job log is read, GY-2010).

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` closes that head's required checks.

## Submitted implementation needs rework

Stop worker; [rework](#recovery-recipes) `--previous-worker-stopped`; next resubmits.

## Proof authority grants

Only `admin` grants/revokes, to `producer` principals.

## Credentials

Operator agents hold only listed capabilities.

## Setup proposals and drift

`graphyard init --scan` writes `.graphyard/setup-proposal.json`; rescans report drift, never repair.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` (250) sizes batches; `GRAPHYARD_OBSERVATION_CONCURRENCY` workers (8) pace per token. Rotate [`GRAPHYARD_PRINCIPALS`](deployment.md#variables).

### Concurrent reconciliation

Reconcile evaluates changed and due rows, ≥ max(`GRAPHYARD_RECONCILE_FULL_MS` (300000), 3× length) running full.

## Observation

Graphyard observes no remote thread, check run or commit status; no request budget, webhook or observation cadence; every candidate is observed from the shared checkout.

## Bootstrap mode for a self-proving change

`policy:bootstrap` holders self-prove one change.

## Control-plane resources

Remedies: `graphyard master run --once`, `herdr pane close PANE`, raise a role's `concurrency`, grow `GRAPHYARD_DATABASE_MAX_BYTES`, code moves for `loaded-revision`.

## Withdrawal, credentials, grants

Nothing is queued or armed on the remote: the [merge writer](delivery-redesign.md#merge-writer) pushes the base itself. A merge outside the gates is a permanent violation: never bypass; a delivered item with a failed smoke proof stays Done.

## Merge bypass

Admin direct-merge window: `graphyard operator direct-merges on --since ISO REASON`.
