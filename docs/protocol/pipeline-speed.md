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
each item whose timeline has never been reconstructed. It reaches delivered items, because those
are what a delivery measurement is about.

Reading the ledger and recording the result are kept apart, because they cost differently:

- **The read never selects an event's payload.** Every row embeds the whole work document, and
  the routine rows that are most of a long-lived item's ledger are thousands of them. The replay
  needs the snapshot's `updatedAt`, `lease` and `submission` and four fields of `details`, so the
  read projects exactly those JSON paths in SQL (a row is a few hundred bytes whatever the
  document has grown to), a page of 400 rows at a time, folds each page into the replay and drops
  it. It runs on a plain pool connection: the coordination lock every claim, heartbeat and submit
  serializes on is never held while ledger rows are transferred or parsed.
- **The write is one short coordination transaction per item.** It re-reads the document, may
  write only `pipeline`, refuses if anything else on the document would change, and appends a
  `pipeline.backfilled` event like any other mutation.

One run reads at most 20,000 ledger rows over at most 25 items, and one catch-up runs at a time
in a process. An item whose ledger outlasts the bound is continued, not given up on: the marker
records where the replay stood (`resume`) with `truncated: true`, the next run resumes from the
row after `toEvent`, and the timeline is written only once the ledger has been read to its end.
Until then the item is `awaiting-backfill` — it is never reported as a ledger that records no
submission.

A failure belongs to its item. It is recorded, the item is set aside for the five-minute settle
window and the run moves on, so one item that cannot be reconstructed never blocks the ones queued
behind it; it is retried once the window has passed.

The replay runs through the same functions the engine calls, at the instants the commands
recorded (`updatedAt`, or a raw ledger entry's own `at`), so a reconstruction and a live timeline
are the same arithmetic over the same facts. The two are then united rather than one chosen. An
attempt a command recorded stands as recorded, but a live timeline is only as old as the timeline
itself: an item that first submitted before it shipped and was reworked after holds its
*resubmission* as its first submission and lacks the early attempts. So attempts are united by
epoch (the live record of an epoch wins), `submittedAt` is the earliest of the two,
`resubmittedAt` the latest, and a count the replay derives can raise a recorded one but never
lower it. Each item keeps the marker of what was read:

```json
"backfill": { "at": "…", "source": "ledger", "events": 412, "fromEvent": "1207", "toEvent": "5109", "retained": true, "truncated": false, "passes": 1 }
```

`retained` is false when the item's own `create` row is no longer in the ledger, so the timeline
starts mid-life; `truncated` is true only while a reconstruction is unfinished, and `passes`
counts the bounded runs it took. `/api/status` reports what the catch-up has done in the process
(`pipelineBackfill`): the last run with the rows it read, the items it set aside as `failed` with
their errors, and a failure of the run itself — none of which fails the read.

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
and the reconstruction has not reached it, or has not finished reading it, yet), `events-pruned` (its ledger no longer reaches its
creation) or `no-submission` (the ledger, read to its end, records none), and `backfill` carries the marker above.

The top-level `speed` of the same status is the [periodic measurement](../master-agent.md#pipeline-speed): nearest-rank p50/p90 of `submitToMergeMs` over every measured delivery and over the routine ones, the rework-round median and distribution, hand-off counts, execution share, and the target verdict. Its `items` report execution versus wait, rework rounds and hand-offs per delivered item, and its `coverage` accounts for every delivery in the window: how many are measured, how many are `awaitingBackfill`, `eventsPruned` or `noSubmission`, the key and reason of each one that is not, `complete` when none is left, and a `statement` saying so. An unmeasured delivery is therefore named, never silently absent.
