<!-- page: Operate Graphyard | 11 | bottlenecks, phases. -->
# Flow analytics

For an operator asking where delivery waits, and what the figures cannot answer.

- **Graphyard ledger** — stage transitions, gate refusals, lease claims and losses, blockers, rework, merge authorization — appended in the mutation's transaction
- **GitHub observation** — pull requests, reviews, merge time and commit, CI check names, results and transitions — collected by the control plane's own App
- **Evidence records** — proof, result, executed and skipped counts, trust, expiry — whose trust follows the submitting credential, a worker assertion never counting
- **Deployment-provider observation** — environment, artifact commit, contained merge commits, state, start and finish — recorded through `POST /api/deployments` with a `producer` or `admin` credential

## Lineage and bounds

Ledger events are projected into `flow_facts`, a normalized, append-only, trigger-protected table.

- **Runs:** in the reconciliation loop and as a catch-up before each read, reporting lag in `coverage.projection`, shown as **stale**
- **A provider that deletes a pull request, check run or deployment record** cannot erase a stored fact

## Windows and metrics

- **Timestamps:** all UTC
- **Window:** `[from, to)`: `to` is the observation instant, `from` is `to` minus 7, 30 or 90 days
- **Daily buckets:** start at the window start
- **A provider timestamp ahead of the observation instant:** falls outside until the next read, never discarded

Metrics:

- **Stage dwell:** Entering to leaving a stage, for transitions completed inside the window; an open stage counts as work in progress
- **Work in progress and aging:** Items whose latest durable stage fact has no delivered fact; age: observation instant minus stage entry
- **Cumulative flow:** Created undelivered items per stage at each daily boundary, from stage facts plus carried-in state
- **Queue versus active time:** Active: union of lease intervals clipped to the window; queue: released, undelivered time with no active lease
- **Phase durations:** Per candidate episode: pull request created, review start and complete, evidence complete, merge authorized, merged, production
- **CI duration, failure, retry:** Per check name and commit, first pending to first terminal observation, plus terminal failures and repeat transitions
- **Operations:** Blockers, gate refusals, dependency critical path, unblocked work, review rounds and findings, rework rate, lease lifecycle, queue depth
- **Deployment:** Frequency, latency from observed merge to deployment start, failure rate and rollbacks

## Bottlenecks, filters and states

Every undelivered item falls into exactly one category, read from its latest durable gate fact (which records `queued` and `mergeBlockers`), not live queue state:

- **not released**, **blocked**, **dependency-blocked**, **in implementation**, **waiting on review**, **waiting on acceptance evidence**, **merge blocked**, **merge ready**

The page shows exactly one state:

- **Unavailable:** the control plane refused or is unreachable; figures on screen are labelled an earlier observation
- **Empty:** no work item matches the window and filter
- **Partial:** the scan bound was reached; the report names the covered interval in `window.covered`
- **Stale:** the projection is behind the ledger, or the observation older than two minutes
- **Sparse:** too few records for representative distributions
- **Complete:** every record in the window is included

## Privacy boundary and API

Flow analytics describes observed work, queueing and capacity, never people:

- No principal ID, provider login or producer identity is stored in a flow fact or returned by the API
- Review facts record only whether an approval was independent of the author
- No per-person view or ranking

Endpoints:

- `GET /api/analytics/flow[/drilldown|/export]`: The report, one metric's records (up to 200 rows), or those rows as a deterministic export
- `GET /api/analytics/attribution[/drilldown]`: The [attribution](attribution.md#cost-and-metrics) report, and up to 200 rows for one metric
- `GET /api/deployments`: Latest deployment-provider observations; audit roles only, else 403

Query parameters; any other is refused:

- `window`: 7, 30 or 90, default 30
- `asOf`: observation instant, never later than the server clock
- `metric`, `key`: drill-down metric and the key narrowing it; an unknown metric's response lists the `supported` ones
- `type`, `stage`, `slice`, `format` (`json` or `csv`): flow only

Identifiers by role:

- **Audit roles** (`admin`, `coordinator`, `producer`): also see evidence, artifact, request, attempt and build identifiers
- `authorized`: which view a drill-down served

The submit-to-merge target, its `master status` figures and the measurement script are in the [master guide](master-agent.md#pipeline-speed).
