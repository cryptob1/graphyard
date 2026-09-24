<!-- page: Operate Graphyard | 10 | repository throughput and time to production. -->
# Shipping pulse

A repository view of delivery: no rankings or individual measures. `GET /api/shipping-pulse` (not for operator agents).

## Source and definitions

- **Delivery** — counted once, from the first ledger event carrying an accepted `delivery` with exact PR and merge commit.
- **Merge instant** — `delivery.mergedAtRepository`, GitHub's time corrected to the repository clock. Windows are UTC; 12 weekly bars plus 7- and 30-day counts.
- **Intent-to-merge** — first `create` event to the merge; median.
- **PR-to-production** — PR `createdAt` to the first production instant for the merge SHA: a provider observation containing the merge (`POST /api/production-observations`, a `producer` with a `deploymentProviders` scope), else the master's `verify-deployment` record (an upper bound).

Excluded deliveries carry a reason (such as `no-verifiable-production-deployment`). With no source at all, `configured: false` explains what to set up.

## Bounds and states

At most 1,000 deliveries feed the metrics; beyond that the response is `partial`. States: loading, unavailable, empty, partial, stale, complete; samples under five are sparse; missing values are never zero.
