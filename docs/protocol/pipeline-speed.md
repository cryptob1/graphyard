<!-- page: Agent protocol | 16 | the per-item pipeline timeline the engine keeps, and how execution, wait, rework rounds and submit→merge are derived from it. -->
# Pipeline timeline

Every work document carries `pipeline`, a small timeline the control plane appends to as the lifecycle commands run. It is a report of what the ledger already did — nothing in it moves a gate, and no command writes it directly.

```json
{
  "attempts": [{ "epoch": 1, "owner": "graphyard-claude-2", "claimedAt": "…", "endedAt": "…", "end": "submitted" }],
  "submittedAt": "…", "resubmittedAt": "…", "reworkRounds": 1,
  "interventions": { "blocked": 0, "requirements": 0 }
}
```

- `attempts` — one entry per lease epoch. `claim` opens it; `submit` (`end: submitted`), `release` (`released`), a lapse that reconciliation, a replacement claim or a requirements revision records (`expired`, at the lease's own deadline, never after the instant that recorded it) or `rework` of a live lease (`reworked`) closes it. An attempt still open when a later claim arrives is closed as `expired`.
- `submittedAt` — the first `submit`; the submit→merge clock starts here and a resubmission after rework does not restart it. `resubmittedAt` is the latest `submit`.
- `reworkRounds` — `rework` commands for an item that had already submitted. Rework of an unsubmitted item only ends its attempt.
- `interventions` — hand-offs to a master or operator: every `blocked` report with a reason, and every `requirements` revision of an item somebody has already claimed. Clearing a blocker (`reason: null`) counts nothing.

Documents created before the timeline existed gain one at their next lifecycle command — and, for
items that have no next command, from their own history: see [backfill](#backfill-from-the-ledger)
below. A delivery whose `submittedAt` cannot be recovered is reported as unmeasured with the
reason, never estimated.

## Backfill from the ledger

Every lifecycle command wrote the work document it produced into the append-only ledger, so an
item's attempts, submissions, reworks and hand-offs are recoverable from its own history. The
bounded catch-up behind `GET /api/work-snapshot` replays them (`src/pipeline-backfill.ts`) for
each item whose timeline has never been reconstructed, one item per transaction, appending a
`pipeline.backfilled` event like any other mutation. It reaches delivered items, because those
are what a delivery measurement is about; the only field it may write is `pipeline`, and the
transaction refuses if anything else on the document changed.

The replay runs through the same functions the engine calls, at the instants the commands
recorded (`updatedAt`, or a raw ledger entry's own `at`), so a reconstruction and a live timeline
are the same arithmetic over the same facts. Whatever a command recorded stands: the
reconstruction only fills what was never recorded, and a count it derives can raise a zero but
never lower a recorded one. Each item keeps the marker of what was read:

```json
"backfill": { "at": "…", "source": "ledger", "events": 412, "fromEvent": "1207", "toEvent": "5109", "retained": true, "truncated": false }
```

`retained` is false when the item's own `create` row is no longer in the ledger, so the timeline
starts mid-life; `truncated` is true when the item has more rows than one reconstruction reads.
`/api/status` reports what the catch-up has done in the process (`pipelineBackfill`), including a
failure, which never fails the read itself.

## Derived figures

`graphyard master status` reports, on every open and delivered row under `speed`, what `src/pipeline-speed.ts` derives from the timeline at the observation instant:

| Field | Meaning |
| --- | --- |
| `executionMs` | Lease time summed over attempts; the active attempt counts up to now |
| `waitMs` | `openMs` (first claim to the accepted merge, or to now) minus `executionMs` |
| `submitToMergeMs` | First submission to the accepted merge on the repository clock (`delivery.mergedAtRepository`, else `mergedAt`); `null` until delivered |
| `sinceSubmitMs` | First submission to now while still in flight |
| `reworkRounds`, `interventions` | As recorded |
| `routine` | At most one rework round and no intervention |

`coverage` says whether this item is `measured`, `awaiting-backfill` (its history is in the ledger
and the reconstruction has not reached it yet), `events-pruned` (its ledger no longer reaches its
creation) or `no-submission` (the ledger records none), and `backfill` carries the marker above.

The top-level `speed` of the same status is the [periodic measurement](../master-agent.md#pipeline-speed): nearest-rank p50/p90 of `submitToMergeMs` over every measured delivery and over the routine ones, the rework-round median and distribution, hand-off counts, execution share, and the target verdict. Its `items` report execution versus wait, rework rounds and hand-offs per delivered item, and its `coverage` accounts for every delivery in the window: how many are measured, how many are `awaitingBackfill`, `eventsPruned` or `noSubmission`, the key and reason of each one that is not, `complete` when none is left, and a `statement` saying so. An unmeasured delivery is therefore named, never silently absent.
