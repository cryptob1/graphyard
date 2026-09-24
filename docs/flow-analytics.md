<!-- page: Operate Graphyard | 11 | where delivery waits, and for how long. -->
# Flow analytics

**Where is delivery waiting, and for how long?** A view of the system, never of people: nothing is keyed by a principal. Open **Flow analytics** or `GET /api/analytics/flow`; the page also carries [attribution](attribution.md#metrics).

## Sources

The append-only ledger, Graphyard's own GitHub observations, evidence records, and [deployment observations](protocol/deployment-observations.md), projected idempotently into `flow_facts`. All times are UTC; windows are the last 7, 30 or 90 days.

## Metrics

Stage dwell, WIP and aging, cumulative flow, throughput, lead time (p50/p75/p90), queue versus active time, per-candidate phase durations (PR created → review → evidence → merge authorized → merged → production), CI, evidence wait, and deployment frequency, latency, failure and rollback. `n` is always shown; fewer than five is **sparse**; missing endpoints count as `unknown` with a reason, never estimated.

### The production environment

The production phase ends only at a successful deployment to `GRAPHYARD_PRODUCTION_ENVIRONMENT` (default `production`).

### Bottleneck categories

**Not released**, **Blocked**, **Dependency-blocked**, **In implementation**, **Waiting on review**, **Waiting on acceptance evidence**, **Merge blocked**, **Merge ready** — one per undelivered item, from its latest gate fact.

## Filters, states and export

Filters: `window`, `type`, `stage`, `slice`, `asOf`. Reports carry `coverage`, `exclusions` and `unavailable`; a hit scan bound shows **partial** with `window.covered`. States: Loading, Unavailable, Empty, Partial, Stale, Sparse, Complete. `/drilldown` returns up to 200 rows (identifiers only for `admin`, `coordinator`, `producer`); `/export?format=csv|json` is deterministic.
