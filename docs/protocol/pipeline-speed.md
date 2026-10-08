<!-- page: Agent protocol | 6 | `pipeline` field. -->
# Pipeline timeline

Lifecycle commands append to each item's `pipeline`, never moving a gate.

```json
{"attempts":[{"epoch":1,"owner":"graphyard-claude-2","claimedAt":"…","endedAt":"…","end":"submitted"}],
"submittedAt":"…","resubmittedAt":"…","reworkRounds":1,"interventions":{"blocked":0,"requirements":0}}
```

`end`: `submitted`, `released`, `expired`, `reworked`; `submittedAt` (first) survives rework; old items backfill (`pipeline.backfilled`). `master status` row `speed` ([target](../master-agent-reference.md#pipeline-speed)); `coverage`: `measured`, `awaiting-backfill`, `events-pruned`, `no-submission`.

`lastAssignment.startedAt` is the epoch's first lease renewal, sent by the supervisor just before the agent starts; it is set once, never by another epoch. The loop's `daemon.budget` splits ready→first push into `launchOverhead` (claim→start) and `working` (start→first push) percentiles, and a ready→first push breach names both p90s.
