<!-- page: Operate Graphyard | 11 | bottlenecks and phase durations. -->
# Flow analytics

For an operator asking where delivery waits, and what the figures cannot answer.

- **Graphyard ledger** (stage transitions, gate refusals, lease claims and losses, blockers, rework, merge authorization): appended in the same transaction as the mutation
- **GitHub observation** (pull-request creation, review submission and state, merge time and commit; CI check names, results and transitions): collected by the control plane's own App
- **Evidence records** (proof, result, executed and skipped counts, trust, expiry): trust follows the submitting credential; a worker assertion never counts
- **Deployment-provider observation** (environment, artifact commit, contained merge commits, state, start and finish): recorded through `POST /api/deployments` with a `producer` or `admin` credential

## Lineage and bounds

Ledger events are projected into `flow_facts`, a normalized, append-only, trigger-protected table.

- **Projection:** incremental, bounded and idempotent on exact identities: a replayed event inserts nothing, two replicas cannot duplicate a fact, a pending review is not a completed-review fact, repeated CI outcomes stay distinct
- **Runs:** in the reconciliation loop and as a catch-up before each read, reporting lag in `coverage.projection`, which the page shows as **stale**
- **A provider that deletes a pull request, check run or deployment record** cannot erase a stored fact
- **Deployment observations** and their contained merge identities are repository-wide, so slice, type and stage filters never narrow them; production phases join through those containment records, never assuming an artifact SHA equals a merge SHA
- **Graphyard's own [release records](delivery.md):** a separate lineage this report does not read yet, so a repository observed only through the release pipeline reports deployment metrics as unavailable

## Windows and metrics

- **Timestamps:** all UTC
- **Window:** `[from, to)`: `to` is the observation instant, `from` is `to` minus 7, 30 or 90 days
- **Daily buckets:** start at the window start
- **A provider timestamp ahead of the observation instant:** falls outside until the next read, never discarded

Metrics:

- **Stage dwell:** Entering to leaving a stage, for transitions completed inside the window; an open stage counts as work in progress
- **Work in progress and aging:** Items whose latest durable stage fact has no delivered fact; age: observation instant minus stage entry
- **Cumulative flow:** Created undelivered items per stage at each daily boundary, from stage facts plus carried-in state
- **Throughput and lead time:** Delivered facts per bucket, written only when an authorized merge is independently observed; delivered time minus created time as a trend with p50/p75/p90 bands
- **Queue versus active time:** Active: union of lease intervals clipped to the window; queue: released, undelivered time with no active lease
- **Merge-ready dwell:** Merge ready to the next refusing gate fact, the observed merge or the observation instant, clipped to the window; an interval ending before it is excluded
- **Phase durations:** Per candidate episode: pull request created, review start and complete, evidence complete, merge authorized, merged, production
- **CI duration, failure, retry:** Per check name and commit, first pending to first terminal observation, plus terminal failures and repeat transitions
- **Evidence wait, expiry, staleness:** Review completion to the completing evidence record; evidence expired before the observation instant, or on a superseded commit
- **Operations:** Blockers, gate refusals, dependency critical path, unblocked work, review rounds and findings, rework rate, lease lifecycle, queue depth
- **Deployment:** Frequency, latency from observed merge to deployment start, failure rate and rollbacks

## Bottlenecks, filters and states

Every undelivered item falls into exactly one category, decided by its latest durable gate fact, which records `queued` and `mergeBlockers`, so the distinction is read from the ledger, not live queue state:

- **not released**, **blocked**, **dependency-blocked**, **in implementation**, **waiting on review**, **waiting on acceptance evidence**, **merge blocked**, **merge ready**

## Privacy boundary and API

Flow analytics describes observed work, queueing and capacity, never people:

- No principal ID, provider login or producer identity is stored in a flow fact or returned by the API
- Review facts record only whether an approval was independent of the author
- No per-person view or ranking

Endpoints:

- `GET /api/analytics/flow`: Full report for a window and filter
- `GET /api/analytics/flow/drilldown`: Bounded underlying records for one metric
- `GET /api/analytics/flow/export`: Same bounded records as deterministic CSV or JSON
- `GET /api/analytics/attribution[/drilldown]`: The [attribution](attribution.md#cost-and-metrics) report and its records
- `GET /api/deployments`, `POST /api/deployments`: Read or record deployment-provider observations

## Pipeline speed

How long the hops between `complete` and the merge may take, what `master status` reports per item and overall, and how the measurement script records it are in the [master guide](master-agent.md#pipeline-speed).
