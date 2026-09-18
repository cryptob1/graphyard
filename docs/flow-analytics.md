# Flow analytics

Flow analytics answers one question: **where is delivery waiting, and for how long?**

It is a diagnostic view of the system, not a measure of the people in it. Every figure is
derived from Graphyard's append-only event ledger and from independently observed provider
facts. No number on this surface comes from a client claim, and no aggregate is keyed by a
person.

Open it from the control plane sidebar (**Flow analytics**) or read it from
`GET /api/analytics/flow`.

## What establishes a fact

| Source | Examples | Trust |
| --- | --- | --- |
| Graphyard ledger | stage transitions, gate refusals, lease claims and losses, blockers, rework, merge authorization | Server-evaluated and appended in the same transaction as the mutation |
| GitHub observation | pull-request creation time, review submission and state, merge time and merge commit | Collected by the control plane's own App credential |
| CI observation | check run name, result, and transitions | Observed through the same GitHub observation |
| Evidence records | proof, result, executed and skipped counts, trust, expiry | Trust follows the submitting credential; a worker assertion is stored and never counted as trusted |
| Deployment-provider observation | environment, artifact commit, contained merge commits, state, start and finish | Recorded through `POST /api/deployments` with a producer or operator credential |

A work item's current document is a *mutable snapshot*. It is never used as evidence here.
The present state shown by the bottleneck summary is read back from the last durable gate
fact in the ledger, so editing a stored document cannot move a number.

## Data lineage and retention

Ledger events are projected into `flow_facts`, a normalized, append-only, database-trigger
protected table. The projection is incremental and bounded: it reads events after a stored
checkpoint in batches, derives facts with exact identities (review result ID, check-run ID
and attempt, evidence ID, commit SHA, ledger sequence), and inserts them idempotently. A
pending review is not a completed-review fact, and repeated CI outcomes from distinct runs
remain distinct. GitHub collection requests all bounded, paginated check runs for the
candidate rather than only the latest result, so an unobserved intermediate state cannot
hide a retry with the same terminal outcome. Delivery gates select the newest trusted run
per required check by immutable GitHub run ID, while analytics retains every run. Replaying
the same ledger event inserts nothing
new, and two replicas projecting at once cannot duplicate a fact.

The projection runs in the server's reconciliation loop and as a short catch-up before each
analytics read. When it is behind, the report says so in `coverage.projection` and the page
shows a **stale** state.

Normalization is what makes the metrics durable. A provider that deletes a pull request, a
check run, or a deployment record cannot erase a fact that Graphyard already observed and
stored, so future windows keep reporting on that history.

Deployment observations and their exact contained merge identities live in the append-only
`deployment_observations` and `deployment_merge_observations` tables. A release or artifact
commit may contain many independently observed PR merge commits; production phases and
pull-requests-per-deployment join through those immutable containment records, never by
assuming the artifact SHA equals a PR merge SHA. They are repository-wide: slice, type,
and stage filters do not narrow them.
Repeating a deployment identity is accepted only when every immutable observation field and
contained merge identity matches the original record.

## Timezone, windows, and buckets

All timestamps are **UTC**. A window is the half-open interval `[from, to)` where `to` is
the observation instant and `from` is `to` minus 7, 30, or 90 days. Daily buckets start at
the window start and are labelled by their start instant, so a bucket boundary is not
midnight unless the observation instant is.

A provider timestamp slightly ahead of the observation instant (GitHub reports merge time
rounded up to a whole second) falls outside the window until the next read. It is never
discarded.

## Metrics

Each metric family is also described, with its formula and sources, in the `definitions`
block of every report and in every export.

| Metric | Formula |
| --- | --- |
| Stage dwell | Interval between entering and leaving a stage, for transitions completed inside the window. Open stages are excluded and reported as work in progress instead. |
| Work in progress and aging | Items whose latest durable stage fact places them in a stage with no delivered fact. Age is the observation instant minus the time that stage was entered. |
| Cumulative flow | At each daily boundary, the number of created, undelivered items in each stage, reconstructed from stage facts plus the carried-in state from before the window. |
| Throughput | Delivered facts per daily bucket. A delivered fact is written only when an authorized merge is independently observed. |
| Lead time | Delivered observation time minus work-created time, reported as a daily trend and as p50/p75/p90 bands. |
| Queue versus active work time | Active time is the union of lease intervals clipped to the window. Queue time is released, undelivered time with no active lease. |
| Merge-ready dwell | From the gate fact where no gate refuses to the observed merge, or to the observation instant for items still merge ready. |
| Phase durations | Per candidate episode: pull-request created, review start, review complete, evidence complete, merge authorized, merged, production. |
| CI duration, failure, retry | Per check name and commit, first pending observation to first terminal observation, plus terminal failures and repeat terminal transitions. |
| Evidence wait, expiry, staleness | Wait is review completion to the completing evidence record. Expiry counts evidence whose expiry precedes the observation instant; staleness counts evidence bound to a superseded commit. |
| Operations | Recorded blockers, gate refusal reasons, dependency critical path, currently unblocked work, review rounds and findings, rework rate, lease lifecycle, queue depth. |
| Deployment | Frequency, latency from observed merge to deployment start, failure rate, and rollbacks, from deployment-provider observations. |

Percentiles use linear interpolation between the two nearest ranks of the sorted sample.
`n` is always reported next to a statistic. An empty sample is `null`, never `0`, and the
page renders it as an em dash. A sample smaller than five is flagged **sparse**. Values
above three times p90 are counted as outliers and **retained**, never dropped.

### Candidate episodes

A phase is measured inside one *candidate episode*: the interval from observing one commit
as the candidate to observing the next. A new push therefore starts a new measurement
rather than silently extending the previous one, and a superseded observation cannot
contaminate a later phase.

A phase with a missing endpoint is not estimated. It is counted under `unknown` with the
reason: `pull-request-creation-time-not-observed`, `not-observed`,
`episode-started-before-window`, or `clock-inverted` when the end precedes the start.

### Bottleneck categories

Every undelivered item in scope falls into exactly one category, decided by its latest
durable gate fact:

1. **Not released** — intent an operator has not released.
2. **Blocked** — an explicit blocker is recorded.
3. **Dependency-blocked** — the ready gate refuses because a prerequisite is not delivered.
4. **In implementation** — released and unblocked, no candidate observed yet.
5. **Waiting on review** — a candidate is observed and the review gate is not satisfied for it.
6. **Waiting on acceptance evidence** — review is satisfied, a required proof is still missing trusted passing evidence.
7. **Merge blocked** — review and acceptance pass, the merge gate still refuses.
8. **Merge ready** — every gate passes and no merge has been observed.

An item whose worker was replaced still appears under **waiting on review** while its
observed candidate has no satisfying approval: the candidate, not the assignment, is what
review is waiting on.

## Filters and slices

- **Window**: 7, 30, or 90 days.
- **Work type**: `feature`, `bug`, or `chore`.
- **Stage**: selects the cohort of items whose latest durable stage is the requested stage
  for every item-scoped metric, including WIP, cumulative flow, throughput, lead time,
  queue/active time, merge-ready dwell, phases, CI, evidence, and operational counts.
  Historical stage dwell instead selects completed transitions whose `from` stage is the
  requested stage, across the work-type and slice population; this preserves completed
  dwell after an item leaves that stage. Repository-wide deployment metrics are explicitly
  unaffected by the stage filter. Aggregate drill-downs use the same populations.
- **Delivery slice**: the top-level repository area a work item changes. Observed changed
  files (a trusted GitHub observation) define it; when no candidate has been observed yet,
  the declared planned scope is used and reported separately as `declared` provenance.

`coverage.slices` reports how many items were classified by observation, by declaration, and
not at all.

## Coverage, exclusions, and honest states

Every report carries `coverage` (items, records, scan bound, projection lag, provenance
counts) and `exclusions` (each reason with a count and the work items affected, such as
`clock-inverted-transition`, `missing-created-fact`, `ci-start-not-observed`, or
`deployment-without-observed-merge`). Metrics with no data at all are listed in
`unavailable` with a reason.
Deployment exclusions use deterministic non-provider labels; provider deployment IDs are
never included in the reader-visible report. Exact provider identifiers remain restricted
to audit roles through the deployment endpoint and authorized drill-downs.

The page shows exactly one state:

| State | Meaning |
| --- | --- |
| Loading | A read is in flight; no figure is claimed yet. |
| Unavailable | The control plane refused or is unreachable. Any figures on screen are labelled as an earlier observation. |
| Empty | No work item matches this window and filter. |
| Partial | The scan bound was reached, so some records in the window are not included. |
| Stale | The projection is behind the ledger, or the observation is older than two minutes. |
| Sparse | Too few records for the distributions to be representative. |
| Complete | Every record in this window is included. |

## Drill-down and export

Every aggregate drills down to the underlying records: the work item, the exact pull
request and commit, and evidence or artifact identifiers where the role allows. Readers see
results and counts; administrators, coordinators, and producers additionally see evidence
and artifact identifiers. The raw deployment-observation endpoint has the same audit-role
restriction. Deployment drill-down and export redact artifact SHAs, provider names, and
external deployment IDs for ordinary readers.
Summary cards may preview only the first 25 deterministic rows, but drill-downs are rebuilt
from the complete bounded population and independently return up to 200 rows.

The selected bounded result exports as CSV or JSON. Both formats begin with the metric,
its definition, the observation instant, the timezone, the window and its boundary rule,
the active filters, coverage, exclusions, and the row counts, so an exported file remains
interpretable away from the dashboard. Exports are deterministic: the same bounded result
produces identical bytes, with rows in a stable order.

## Privacy boundary

Flow analytics describes observed work, queueing, and capacity. It does not describe people.

- No principal ID, provider login, or producer identity is stored in a flow fact or returned
  by the API. Review facts record only whether the approval was independent of the author.
- No aggregate is grouped by actor, and there is no per-person view, ranking, or export.
- Queue and lease metrics describe the *system's* capacity and idle time, not an individual's
  utilization. A high review queue means reviews are waiting, not that a reviewer is slow.

Do not use this surface to evaluate individuals. It cannot answer that question, and its
definitions are deliberately built so that it never will.

## Bounds

Aggregation is bounded in date range (7, 30, or 90 days), work items scanned, records
scanned, deployment observations, daily buckets, drill-down rows, and payload size.
Reaching a bound is reported, never hidden: `coverage.truncated`,
`coverage.workItemsTruncated`, `coverage.deploymentsTruncated`,
`coverage.deploymentMergesTruncated`, and the **partial** state
say so. Reads use indexed
access paths on `flow_facts` — `(observed_at, id)`, `(work_id, observed_at, id)`,
`(kind, observed_at, id)`, and `(work_id, kind, observed_at DESC, id DESC)` for bounded
latest-state lookups — with deterministic ordering, so repeating a bounded query
returns the same rows in the same order.

## Reading it well

- Start with the bottleneck summary. It says where work is waiting *now*; the distributions
  say whether that is normal.
- Compare the same window before and after a change. Comparing a 7-day to a 90-day window
  compares different populations.
- Treat any figure marked sparse, partial, or stale as a prompt to look at the drill-down,
  not as a measurement.
- A long review wait with a low review-round count usually means reviews are not starting.
  A short wait with many rounds means they are starting and not converging. The phase table
  separates the two.
- Deployment metrics stay unavailable until a deployment provider records observations. That
  is a missing integration, not a zero deployment rate.

## API

| Method and path | Result |
| --- | --- |
| `GET /api/analytics/flow` | The full report for a window and filter |
| `GET /api/analytics/flow/drilldown` | Bounded underlying records for one metric |
| `GET /api/analytics/flow/export` | The same bounded records as deterministic CSV or JSON |
| `GET /api/deployments` | The latest recorded deployment observations |
| `POST /api/deployments` | Record one deployment-provider observation |

Query parameters: `window` (7, 30, 90; default 30), `type`, `stage`, `slice`, `asOf`
(never later than the server clock), `metric`, `key`, and `format` (`json` or `csv`).

A deployment observation is recorded by a producer or operator credential:

```json
{
  "provider": "railway",
  "externalId": "deployment-1234",
  "environment": "production",
  "sha": "cccccccccccccccccccccccccccccccccccccccc",
  "containedMergeShas": ["dddddddddddddddddddddddddddddddddddddddd"],
  "state": "succeeded",
  "startedAt": "2026-09-17T05:04:00.000Z",
  "finishedAt": "2026-09-17T05:05:30.000Z"
}
```

`state` is `succeeded`, `failed`, or `rolled_back`. `sha` is the full artifact commit SHA.
`containedMergeShas` contains one to 200 full GitHub merge SHAs independently verified as
part of that artifact. Abbreviations are refused. The same provider, external ID, and state
is recorded once; a semantically identical repeat is reported as a duplicate (JSON object
key order is immaterial), while a repeat that changes any immutable field or containment is
refused.
Implementation workers do not hold producer credentials, so they cannot record deployment
observations.

See also [architecture](architecture.md), [agent protocol and API](protocol.md), and
[operations](operations.md).
