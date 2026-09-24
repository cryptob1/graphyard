<!-- page: Agent protocol | 16 | the per-item pipeline timeline the engine keeps, and how execution, wait, rework rounds and submit→merge are derived from it. -->
# Pipeline timeline

Every work document carries `pipeline`, appended by lifecycle commands. It is a report; nothing in it moves a gate.

```json
{
  "attempts": [{ "epoch": 1, "owner": "graphyard-claude-2", "claimedAt": "…", "endedAt": "…", "end": "submitted" }],
  "submittedAt": "…", "resubmittedAt": "…", "reworkRounds": 1,
  "interventions": { "blocked": 0, "requirements": 0 }
}
```

- `attempts` — one per epoch; ended by `submitted`, `released`, `expired` (at the lease deadline) or `reworked`.
- `submittedAt` — first submit; the submit→merge clock does not restart on resubmission.
- `reworkRounds` — `rework` of an already-submitted item.
- `interventions` — `blocked` reports with a reason, and `requirements` revisions after a claim.

Items older than the timeline are backfilled from the ledger by a bounded catch-up behind `GET /api/work-snapshot` (`src/pipeline-backfill.ts`: 20,000 rows over 25 items per run, resumable, recorded as `pipeline.backfilled` with a `backfill` marker). `/api/status` reports its progress as `pipelineBackfill`.

## Derived figures

`graphyard master status` reports per row under `speed`:

| Field | Meaning |
| --- | --- |
| `executionMs` | Lease time summed over attempts |
| `waitMs` | First claim to merge (or now) minus `executionMs` |
| `submitToMergeMs` | First submission to the merge on the repository clock |
| `sinceSubmitMs` | First submission to now, while in flight |
| `routine` | At most one rework round and no intervention |

`coverage` is `measured`, `awaiting-backfill`, `events-pruned` or `no-submission`. The top-level `speed` is the [periodic measurement](../master-agent.md#pipeline-speed): p50/p90 submit→merge, rework distribution and coverage, naming every unmeasured delivery.
