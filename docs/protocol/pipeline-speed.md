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

Documents created before the timeline existed gain one at their next lifecycle command, or from their own history by the [backfill](#backfill-from-the-ledger). A delivery whose `submittedAt` cannot be recovered is reported as unmeasured with the reason, never estimated.

## Backfill from the ledger

Every lifecycle command wrote its work document into the append-only ledger. The bounded catch-up behind `GET /api/work-snapshot` replays that history (`src/pipeline-backfill.ts`) for each item, delivered ones included, whose timeline was never reconstructed.

- **The read:** never selects an event's payload. It projects in SQL only the snapshot's `updatedAt`, `lease` and `submission` and four fields of `details`, 400 rows a page, on a plain pool connection, so the coordination lock is never held while ledger rows are read
- **The write:** one short coordination transaction per item. It re-reads the document, may write only `pipeline`, refuses if anything else would change, and appends a `pipeline.backfilled` event
- **Bounds:** one run reads at most 20,000 ledger rows over at most 25 items, one catch-up at a time per process. A longer ledger is continued: the marker records `resume` with `truncated: true`, the next run resumes after `toEvent`, and the timeline is written only once the ledger is read to its end; until then the item is `awaiting-backfill`
- **A failure:** belongs to its item. It is recorded, the item is set aside for the five-minute settle window, then retried; the run moves on
- **The union:** the replay runs the engine's own functions at the recorded instants (`updatedAt`, or a raw ledger entry's `at`), then is united with the live timeline, which is only as old as the timeline feature: attempts unite by epoch (the live record wins), `submittedAt` is the earliest of the two, `resubmittedAt` the latest, and a replayed count can raise a recorded one, never lower it

```json
"backfill": { "at": "…", "source": "ledger", "events": 412, "fromEvent": "1207", "toEvent": "5109", "retained": true, "truncated": false, "passes": 1 }
```

- `retained`: false when the item's `create` row has left the ledger, so the timeline starts mid-life.
- `truncated`: true only while a reconstruction is unfinished.
- `passes`: the bounded runs it took.
- `pipelineBackfill` on `/api/status`: the last run with the rows it read, the items set aside as `failed` with their errors, and a failure of the run itself; none fails the read.

## Derived figures

`graphyard master status` reports, on every open and delivered row under `speed`, what `src/pipeline-speed.ts` derives from the timeline:

- `executionMs`: lease time summed over attempts, the active one counting up to now.
- `waitMs`: `openMs`, from the first claim to the accepted merge or now, minus `executionMs`.
- `submitToMergeMs`: first submission to the accepted merge on the repository clock (`delivery.mergedAtRepository`, else `mergedAt`); `null` until delivered.
- `sinceSubmitMs`: while in flight.
- `reworkRounds`, `interventions`: as recorded.
- `routine`: at most one rework round and no intervention.
- `coverage`: `measured`, `awaiting-backfill` (the reconstruction has not reached or finished the item), `events-pruned` (its ledger no longer reaches its creation) or `no-submission` (the ledger, read to its end, records none); `backfill` carries the marker above.

The top-level `speed` is the [periodic measurement](../master-agent.md#pipeline-speed) over every measured delivery. Its `items` report execution versus wait, rework rounds and hand-offs per delivered item. Its `coverage` accounts for every delivery in the window: how many are measured, `awaitingBackfill`, `eventsPruned` or `noSubmission`, the key and reason of each unmeasured one, `complete` when none is left, and a `statement`.
