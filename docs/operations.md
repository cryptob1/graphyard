<!-- page: Operate Graphyard | 8 | diagnose and recover -->
# Operations and recovery

## Daily checklist

Check `/healthz` for the expected commit, `/api/status` for job errors and `master status` for item holds, serving commit and main. Keep a recent `db backup`. Running cycles alone do not show delivery.

## Incident decision tree

Run `diagnose GY-N`; fix the named cause with requirements intact. Use lease recovery for expired workers and rework for failed implementations or producer-runnable manual proofs. The master handles routine recovery.

CLI requests wait out connection failures during a deploy restart, retrying every second for up to 60 seconds with the same idempotency key and body. HTTP errors fail immediately. If the plane stays unreachable, the error names the requested URL.

## Recovery recipes

```sh
graphyard rework GY-N --previous-worker-stopped "reason"
graphyard unblock GY-N "reason"
systemctl --user restart graphyard-master-OWNER-NAME
```

Confirm the worker stopped before attesting it. Use the recorded unit name; legacy units omit the repository suffix.

## Safety facts that never change

Workers hold no admin/coordinator/producer credentials. AI cannot hold admin. Only the merge writer moves main through gates. Mutations append history transactionally; retention compacts old rows. No endpoint sets lifecycle state.

## Deeper references

[Loop](#master-coordination-loop), [lost worker](#lost-worker-before-submission), [delivery](delivery.md), [deployment recovery](deployment.md#backup-upgrade-rollback).

## Resources and disk

Ended assignments use `git worktree remove` without force. Sessions and trials remove their own checkouts. ENOSPC/EDQUOT names the storage to free or expand.

## Master coordination loop

See the [five steps and wake limits](master-agent.md#the-loop). Systemd detects incomplete cycles; the AI master diagnoses delivery failures. The separate deploy supervisor reports `serving.failedDeploy`.

## Lost worker before submission

A lease lasts 120 seconds after heartbeat; control-plane stall uses the 30-second `stallRenewalWindowMs`. Lapse ends the attempt. A higher-epoch claim receives preserved work; the old worker stops immediately.

## Accepted evidence turns out to be wrong

`revoke GY-N revoke.json` withdraws the candidate's records.

## Submitted implementation needs rework

Stop the worker, then use [rework](#recovery-recipes). The successor submits a new head.

## Proof authority

Roster `--proof` patterns determine authority, including for admins. `principal add ID --role producer|coordinator|admin --proof PATTERN` records grants. Implementers never provide their own trusted acceptance evidence.

## Credentials

Rotate `GRAPHYARD_PRINCIPALS`; keep secrets outside Git. Operator agents have only listed capabilities.

## Setup proposals and drift

`init --scan` writes `.graphyard/setup-proposal.json`. Rescans report drift without repairing it.

## Scale limits

`GRAPHYARD_RECONCILE_BATCH_MS` defaults to 250; observation concurrency defaults to 8 per token. Idle observation workers check only the jobs table once per second. When a job is due, they read open items for the existing priority order, then claim with `SKIP LOCKED`; settled summaries are never read for observation scheduling. Successful observations remain due every 20 seconds.

### Concurrent reconciliation

Changed/due rows reconcile incrementally. Full runs use max(`GRAPHYARD_RECONCILE_FULL_MS` (300000), three times duration).

## Observation

Candidates come from the shared checkout, not remote checks, threads or webhooks. Serving comes from configured deployment/app records.

## Bootstrap mode for a self-proving change

Explicit `policy:bootstrap` holders may self-prove one change; ordinary workers receive no such credential.

## Control-plane resources

`/healthz` fails on refused writes or `GRAPHYARD_DATABASE_MAX_BYTES`; repair storage.

## Database crash

Dropped connections reconnect on the next request. After two minutes unreachable, a Compose loop runs `docker compose up -d`, at most every five minutes. Status → `controlPlane` reports outage, server exit and Docker free space.

## Withdrawal and credentials

The [merge writer](delivery-redesign.md#merge-writer) pushes main itself. Only its reconciled ledger record marks an item Done; an observation alone does not record delivery. Failed smoke proofs leave delivered items Done with failure visible.
