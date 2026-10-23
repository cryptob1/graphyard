<!-- page: Operate Graphyard | 8 | checklist, incidents. -->
# Operations and recovery

## Daily checklist

- `/healthz` at expected `commit` (another release refuses: `graphyard upgrade`); `/api/status`: no job errors.
- `master status`: serving commit at main's tip, `loop.state` `running`; recent `graphyard db backup`.

## Incident decision tree

- **Item not moving**: fix the refusal's cause. Never weaken requirements. Expired unsubmitted: [lost worker](#lost-worker-before-submission); retry: [rework](#submitted-implementation-needs-rework). A failed producer-runnable manual proof returns to worker.

## Recovery recipes

```sh
graphyard rework GY-N --previous-worker-stopped "reason"
graphyard unblock GY-N "reason"
systemctl --user restart graphyard-master-OWNER-NAME
```

Never attest a stop you have not confirmed.

## Safety facts that never change

- Workers never hold `admin`/`coordinator`/`producer` tokens. No AI principal can hold `admin`.
- Only the merge writer moves main, on passing gates: no bypass, no lifecycle-state endpoint.
- History is append-only; rows past retention get compacted.

## Deeper references

[The coordination loop](#master-coordination-loop), [merge bypass](#merge-bypass), [bootstrap mode](#bootstrap-mode-for-a-self-proving-change).

## Resources and disk

The loop removes an assignment worktree (`git worktree remove`, never forced) once its attempt ends; a settled session removes its checkout, the merge writer its trial checkout. ENOSPC/EDQUOT names the path.

## Master coordination loop

Snapshot, close, dispatch, merge writer, persist ([loop](master-agent.md#the-loop)); a step that throws is one log line and runs again next cycle. A failed deploy is `serving.failedDeploy` in `master status`.

## Lost worker before submission

Leases expire 120s after last heartbeat (plane stall: 30s `stallRenewalWindowMs`, not another lease period); the attempt ends and the item is claimable again; higher-epoch claim keeps worktree.

## Accepted evidence turns out to be wrong

`graphyard revoke GY-N revoke.json` closes that head's required checks.

## Submitted implementation needs rework

Stop worker; [rework](#recovery-recipes) `--previous-worker-stopped`; next resubmits.

## Proof authority

A principal proves exactly its roster entry's `--proof` patterns (`graphyard principal add ID --role producer|coordinator|admin --proof PATTERN`); admins included, nothing is granted at runtime.

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

`/healthz` fails writes refused or the database at `GRAPHYARD_DATABASE_MAX_BYTES`; grow it.

## Withdrawal and credentials

Nothing is queued or armed on the remote: the [merge writer](delivery-redesign.md#merge-writer) pushes the base itself. A merge outside the gates is a permanent violation: never bypass; a delivered item with a failed smoke proof stays Done.

## Merge bypass

Admin direct-merge window: `graphyard operator direct-merges on --since ISO REASON`.
