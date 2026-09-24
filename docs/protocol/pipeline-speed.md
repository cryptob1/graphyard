<!-- page: Agent protocol | 16 | the per-item pipeline timeline. -->
# Pipeline timeline

Every work document carries `pipeline`, appended by lifecycle commands; it never moves a gate.

```json
{
  "attempts": [{ "epoch": 1, "owner": "graphyard-claude-2", "claimedAt": "…", "endedAt": "…", "end": "submitted" }],
  "submittedAt": "…", "resubmittedAt": "…", "reworkRounds": 1,
  "interventions": { "blocked": 0, "requirements": 0 }
}
```

An attempt ends `submitted`, `released`, `expired` or `reworked`. `submittedAt` is the first submit and is not reset by rework. Older items are backfilled from the ledger (`pipeline.backfilled`; progress in `/api/status` → `pipelineBackfill`).

`graphyard master status` derives per row under `speed`: `executionMs` (lease time), `waitMs`, `submitToMergeMs`, `sinceSubmitMs`, and `routine` (at most one rework, no intervention), with `coverage` `measured`, `awaiting-backfill`, `events-pruned` or `no-submission`. The top-level `speed` is the [periodic measurement](../master-agent-reference.md#pipeline-speed).
