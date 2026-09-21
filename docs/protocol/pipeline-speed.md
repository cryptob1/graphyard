<!-- page: Agent protocol | 9 | the per-item timeline. -->
# Pipeline timeline

For an integration author reading pipeline figures: where each one comes from.

Every work document carries `pipeline`, a small timeline the control plane appends to as the lifecycle commands run. It reports what the ledger already did: nothing in it moves a gate, no command writes it directly.

```json
{
  "attempts": [{ "epoch": 1, "owner": "graphyard-claude-2", "claimedAt": "…", "endedAt": "…", "end": "submitted" }],
  "submittedAt": "…", "resubmittedAt": "…", "reworkRounds": 1,
  "interventions": { "blocked": 0, "requirements": 0 }
}
```

- `attempts`: one entry per lease epoch. `claim` opens it; `submit` (`end: submitted`), `release` (`released`), a lapse that reconciliation, a replacement claim or a requirements revision records (`expired`, at the lease's deadline) or `rework` of a live lease (`reworked`) closes it. An attempt still open when a later claim arrives is closed as `expired`.
- `submittedAt`: the first `submit`; the submit→merge clock starts here; a resubmission after rework does not restart it.
- `resubmittedAt`: the latest `submit`.
- `reworkRounds`: `rework` commands for an item that had already submitted. Rework of an unsubmitted item only ends its attempt.
- `interventions`: hand-offs to a master or operator: every `blocked` report with a reason, every `requirements` revision of an item somebody has already claimed. Clearing a blocker (`reason: null`) counts nothing.

Documents created before the timeline existed gain one at their next lifecycle command; a delivery without a recorded `submittedAt` is reported as unmeasured, never estimated.

## Derived figures

`graphyard master status` reports, on every open and delivered row under `speed`, what `src/pipeline-speed.ts` derives from the timeline:

- `executionMs`: lease time summed over attempts, the active one counting up to now.
- `waitMs`: `openMs`, from the first claim to the accepted merge or now, minus `executionMs`.
- `submitToMergeMs`: first submission to the accepted merge on the repository clock (`delivery.mergedAtRepository`, else `mergedAt`); `null` until delivered.
- `sinceSubmitMs`: while in flight.
- `reworkRounds`, `interventions`: as recorded.
- `routine`: at most one rework round and no intervention.

The top-level `speed` is the [periodic measurement](../master-agent.md#pipeline-speed) over every measured delivery.
