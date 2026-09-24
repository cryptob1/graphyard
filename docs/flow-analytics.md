<!-- page: Operate Graphyard | 11 | delivery bottlenecks, phase durations, and their data lineage. -->
# Flow analytics

Flow analytics answers **where is delivery waiting, and for how long?** It describes the system, never people: no aggregate is keyed by a principal, and there is no per-person view.

Open **Flow analytics** in the sidebar or `GET /api/analytics/flow`. The same page carries the [attribution](attribution.md#metrics) section.

## Sources

Figures come from the append-only ledger (stages, gates, leases, blockers, rework, merges), the control plane's own GitHub observations (PRs, reviews, check runs, merges), evidence records (trust follows the credential), and deployment observations (`POST /api/deployments`, see [the protocol](protocol/deployment-observations.md)). Ledger events are projected incrementally and idempotently into the append-only `flow_facts` table; when the projection lags, the report says so in `coverage.projection`. Release-pipeline delivery records ([delivery](delivery.md)) are a separate lineage and not read here.

All times are UTC. A window is `[now − 7|30|90 days, now)`; daily buckets start at the window start.

## Metrics

| Metric | Formula |
| --- | --- |
| Stage dwell | Completed stage transitions inside the window |
| WIP and aging | Undelivered items by latest stage; age since entering it |
| Cumulative flow | Items per stage at each daily boundary |
| Throughput | Observed deliveries per day |
| Lead time | Delivered minus created, p50/p75/p90 |
| Queue vs active | Active is the union of lease intervals; queue is released time with no lease |
| Merge-ready dwell | From becoming merge-ready to the next refusal, the merge, or now |
| Phase durations | Per candidate episode: PR created, review start/complete, evidence complete, merge authorized, merged, production |
| CI | Duration, failures and retries per check and commit |
| Evidence | Wait after review, expiry, staleness |
| Deployment | Frequency, merge→deploy latency, failure rate, rollbacks |

Percentiles interpolate linearly; `n` is always reported; an empty sample is `null`; fewer than five is **sparse**; outliers are kept. A phase with a missing endpoint is counted under `unknown` with its reason, never estimated.

### The production environment

The `merged-to-production` phase ends only at a successful deployment to `GRAPHYARD_PRODUCTION_ENVIRONMENT` (default `production`), reported as `productionEnvironment`. Other environments never close it.

### Bottleneck categories

Each undelivered item falls into one, from its latest gate fact: **Not released**, **Blocked**, **Dependency-blocked**, **In implementation**, **Waiting on review**, **Waiting on acceptance evidence**, **Merge blocked** (a merge-gate reason other than queue sequencing), **Merge ready**.

## Filters, coverage and states

Filters: window (7, 30, 90), `type` (`feature`, `bug`, `chore`), `stage`, and `slice` (top-level repository area, from observed changed files or else `plannedFiles`). Every report carries `coverage` and `exclusions`; metrics with no data are listed in `unavailable`. When a scan bound is hit, `window.covered` states the interval actually read and the page shows **partial**.

The page shows one state: Loading, Unavailable, Empty, Partial, Stale (projection behind or older than two minutes), Sparse, or Complete.

## Drill-down and export

Every aggregate drills down to up to 200 underlying records; evidence, artifact and provider identifiers are shown only to `admin`, `coordinator` and `producer`. `GET /api/analytics/flow/export?format=csv|json` returns the bounded rows with metric definitions, window, filters and coverage in its header; exports are deterministic.

Query parameters: `window`, `type`, `stage`, `slice`, `asOf`, `metric`, `key`, `format`.
