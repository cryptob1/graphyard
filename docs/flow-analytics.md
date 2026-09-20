<!-- page: Operate Graphyard | 11 | bottlenecks, phase durations, lineage. -->
# Flow analytics

For an operator asking where delivery waits, and what the figures cannot answer.

- **Graphyard ledger** (stage transitions, gate refusals, lease claims and losses, blockers, rework, merge authorization): server-evaluated and appended in the same transaction as the mutation
- **GitHub observation** (pull-request creation, review submission and state, merge time and commit; CI check names, results and transitions): collected by the control plane's own App credential
- **Evidence records** (proof, result, executed and skipped counts, trust, expiry): trust follows the submitting credential; a worker assertion never counts as trusted
- **Deployment-provider observation** (environment, artifact commit, contained merge commits, state, start and finish): recorded through `POST /api/deployments` with a `producer` or `admin` credential

## Lineage and bounds

Ledger events are projected into `flow_facts`, a normalized, append-only, trigger-protected table. The projection is incremental, bounded and idempotent on exact identities, so a replayed event inserts nothing new and two replicas projecting at once cannot duplicate a fact; a pending review is not a completed-review fact, and repeated CI outcomes from distinct runs stay distinct. It runs in the reconciliation loop and as a short catch-up before each read; when it is behind, the report says so in `coverage.projection` and the page shows **stale**. Normalization is what makes the metrics durable: a provider that deletes a pull request, check run or deployment record cannot erase a stored fact. Deployment observations and their contained merge identities are repository-wide, so slice, type and stage filters never narrow them, and production phases join through those immutable containment records rather than assuming an artifact SHA equals a merge SHA. Graphyard's own [release records](delivery.md) are a separate lineage flow analytics does not read yet, so a repository observed only through the release pipeline reports deployment metrics as unavailable rather than inferring them.

## Windows and metrics

All timestamps are UTC. A window is `[from, to)` where `to` is the observation instant and `from` is `to` minus 7, 30 or 90 days; daily buckets start at the window start. A provider timestamp slightly ahead of the observation instant falls outside the window until the next read and is never discarded.

- **Stage dwell:** Entering to leaving a stage, for transitions completed inside the window; open stages are reported as work in progress instead
- **Work in progress and aging:** Items whose latest durable stage fact has no delivered fact; age is the observation instant minus when that stage was entered
- **Cumulative flow:** Created undelivered items per stage at each daily boundary, from stage facts plus carried-in state
- **Throughput:** Delivered facts per bucket; a delivered fact is written only when an authorized merge is independently observed
- **Lead time:** Delivered observation time minus work-created time, as a daily trend and p50/p75/p90 bands
- **Queue versus active time:** Active is the union of lease intervals clipped to the window; queue is released, undelivered time with no active lease
- **Merge-ready dwell:** From becoming merge ready to the next refusing gate fact, the observed merge or the observation instant, clipped to the window; an interval ending before the window is excluded, not measured whole
- **Phase durations:** Per candidate episode: pull request created, review start and complete, evidence complete, merge authorized, merged, production
- **CI duration, failure, retry:** Per check name and commit, first pending to first terminal observation, plus terminal failures and repeat terminal transitions
- **Evidence wait, expiry, staleness:** Review completion to the completing evidence record; evidence expired before the observation instant, or bound to a superseded commit
- **Operations:** Blockers, gate refusal reasons, dependency critical path, unblocked work, review rounds and findings, rework rate, lease lifecycle, queue depth
- **Deployment:** Frequency, latency from observed merge to deployment start, failure rate and rollbacks

## Bottlenecks, filters and states

Every undelivered item falls into exactly one category, decided by its latest durable gate fact: **not released**, **blocked**, **dependency-blocked**, **in implementation**, **waiting on review**, **waiting on acceptance evidence**, **merge blocked** or **merge ready**. The gate fact records `queued` and `mergeBlockers`, so that distinction is read back from the ledger rather than live queue state.

## Privacy boundary and API

Flow analytics describes observed work, queueing and capacity, never people: no principal ID, provider login or producer identity is stored in a flow fact or returned by the API, review facts record only whether an approval was independent of the author, and there is no per-person view, ranking or export.

- `GET /api/analytics/flow`: The full report for a window and filter
- `GET /api/analytics/flow/drilldown`: Bounded underlying records for one metric
- `GET /api/analytics/flow/export`: The same bounded records as deterministic CSV or JSON
- `GET /api/analytics/attribution[/drilldown]`: The [attribution](attribution.md#cost-and-metrics) report and its records
- `GET /api/deployments`, `POST /api/deployments`: Read or record deployment-provider observations
