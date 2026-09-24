<!-- page: Agent protocol | 6 | the per-item timeline. -->
# Pipeline timeline

Every work document carries `pipeline`, appended by lifecycle commands; it never moves a gate.

```json
{"attempts":[{"epoch":1,"owner":"graphyard-claude-2","claimedAt":"…","endedAt":"…","end":"submitted"}],
 "submittedAt":"…","resubmittedAt":"…","reworkRounds":1,"interventions":{"blocked":0,"requirements":0}}
```

An attempt ends `submitted`, `released`, `expired` or `reworked`; `submittedAt` is the first submit and survives rework. Older items are backfilled from the ledger (`pipeline.backfilled`). `master status` derives each row's `speed` from it ([pipeline speed](../master-agent-reference.md#pipeline-speed)), with `coverage` `measured`, `awaiting-backfill`, `events-pruned` or `no-submission`.
