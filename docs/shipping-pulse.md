<!-- page: Operate Graphyard | 10 | repository delivery flow: throughput, intent-to-merge, and deployment lag without rankings. -->
# Shipping pulse

A repository view of delivery flow: no rankings, lines of code or individual measures. `GET /api/shipping-pulse` (not offered to operator agents).

## Source and definitions

- **Delivery** — counted once, from the first `github.observed` event whose payload carries an accepted `delivery` with the exact PR, merge commit and merge time. Snapshots, claims and lease activity never count.
- **Merge instant** — `delivery.mergedAtRepository`: GitHub's `mergedAt` carried onto the repository (Postgres) clock with the offset measured at merge verification. All windows are UTC; weekly bars run Monday–Sunday; the API returns 12 weeks plus 7- and 30-day counts.
- **Intent-to-merge** — first `create` event to the merge instant; median.
- **PR-to-production** — PR `createdAt` to the first production instant for that merge SHA, split at the merge. The production instant comes from a provider observation that records containment of the merge (`POST /api/production-observations`), or else from the master's `verify-deployment` record (an upper bound). Reports average, median, p90, coverage and exclusions.

Exclusion reasons: `missing-pr-created-at`, `no-verifiable-production-deployment`, `superseded-deployment`, `production-observation-cap`, `invalid-clock-order`; the most frequent is `dominantExclusion`. With no provider observation and no master verification the response sets `configured: false` with an `unconfiguredReason`.

## Production observations

`POST /api/production-observations` needs a `producer` credential with an explicit `deploymentProviders` scope naming the provider (a `proofs` grant is not enough; otherwise 403). Each observation carries provider and deployment identity, commit or artifact identity, provider time, a measured `clockOffset` bracket (at most twenty seconds wide) and up to 500 contained merge SHAs; it is stored append-only on the repository clock. Failed and rolled-back deployments never end the phase.

## Master verification

`graphyard master verify-deployment GY-N` records the release serving a delivered item (its merge or a descendant) as the delivery's `deployment` record; the master loop runs it for each delivery. Its `at` is the latest instant production can have begun, so durations to it are upper bounds. A provider observation always takes precedence. `POST /api/deployments` feeds [flow analytics](flow-analytics.md), not this metric.

## Bounds and states

At most 1,000 deliveries feed metrics; beyond that the response is `partial` and `truncated`, and counts become lower bounds. Recent entries (10) show proof totals from the snapshot cited by `delivery.authorizationRevision` and any recorded policy violations. The page shows loading, unavailable, empty, partial, stale (no successful read for two minutes) or complete; samples under five are sparse; missing values are never shown as zero.
