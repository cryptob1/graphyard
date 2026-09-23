<!-- page: Operate Graphyard | 10 | throughput, lag. -->
# Shipping pulse

For an operator watching delivery flow: what each figure counts, and on which clock.

A repository view, not a worker scorecard, under the same [privacy boundary](flow-analytics.md#privacy-boundary-and-api): no rankings, effort estimates or causal claims.

## Source and definitions

Every value comes from the append-only `events` ledger.

- **Never counted:** work snapshots, claims, submissions and lease activity
- **Delivered once:** decided across the whole ledger before any window applies

**Clocks.** Only measurement relates GitHub's merge timestamp, the repository clock and a provider's. A delivery records:

- `delivery.mergedAt`: as GitHub reported it
- `delivery.mergedAtRepository`: that instant on the repository clock, using the *lower bound* of the offset measured at merge verification, which refuses one wider than twenty seconds

Every window, bucket and interval uses the repository instant, older deliveries the provider timestamp.

**Intent-to-merge** runs from the earliest `create` event to the accepted merge timestamp, reported as the ordinary median; records missing an endpoint or ordered wrongly are excluded, never fabricated, with both sample sizes reported.

**PR-to-production** runs from GitHub's observed pull-request `createdAt`, splits at the merge, and ends at the earliest successful production deployment independently recording containment of that exact merge SHA.

- **`clockOffset`:** each deployment observation's measured bracket relative to the repository clock

`GET /api/shipping-pulse` is authenticated and not offered to operator agents: their scoped API serves no repository-wide aggregate, and their navigation hides the entry.
