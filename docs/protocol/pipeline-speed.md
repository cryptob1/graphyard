<!-- page: Agent protocol | 6 | the `pipeline` field. -->
# Pipeline timeline

Lifecycle commands append to each item's `pipeline`; it never moves a gate.

```json
{"attempts":[{"epoch":1,"owner":"graphyard-claude-2","claimedAt":"…","endedAt":"…","end":"submitted"}],
"submittedAt":"…","resubmittedAt":"…","reworkRounds":1,"interventions":{"blocked":0,"requirements":0}}
```

`end`: `submitted`, `released`, `expired`, `reworked`; `submittedAt` (first) survives rework; old items backfill (`pipeline.backfilled`). `master status` row `speed` ([target](../master-agent-reference.md#pipeline-speed)); `coverage`: `measured`, `awaiting-backfill`, `events-pruned`, `no-submission`.
