<!-- page: Operate Graphyard | 10 | throughput, lag. -->
# Shipping pulse

For an operator watching delivery flow: what each figure counts, and on which clock.

A repository view, not a worker scorecard, under the same [privacy boundary](flow-analytics.md#privacy-boundary-and-api): no rankings, effort estimates or causal claims.

## Source and definitions

Every value comes from the append-only `events` ledger.

- **A delivery counts** only from the first `github.observed` event whose immutable payload carries an accepted `delivery`, exact pull request, exact merge commit and provider merge timestamp
- **Never counted:** work snapshots, claims, submissions and lease activity
- **Delivered once:** decided across the whole ledger before any window applies

**Clocks.** Only measurement relates GitHub's merge timestamp, the repository clock and a provider's clock. A delivery records:

- `delivery.mergedAt`: as GitHub reported it
- `delivery.mergedAtRepository`: that instant on the repository clock, using the *lower bound* of the offset measured at merge verification, which refuses one wider than twenty seconds

Every window, bucket and interval uses the repository instant, older deliveries the provider timestamp.

**Intent-to-merge** runs from the earliest `create` event to the accepted merge timestamp.

- **Median:** the ordinary middle value
- **Records missing an endpoint or ordered wrongly:** excluded, never fabricated, both sample sizes reported

**PR-to-production** runs from GitHub's observed pull-request `createdAt`, splits at the merge, and ends at the earliest successful production deployment independently recording containment of that exact merge SHA.

- **`clockOffset`:** each deployment observation's measured bracket relative to the repository clock
- **Ingestion refuses:** a bracket wider than twenty seconds, an inverted one, or one placing the clocks more than thirty days apart
- **Post-merge:** a deployment counts when its latest bound reaches the merge instant, which clamps its lower bound, so a duration is never negative, published only to its endpoints' measurement precision

## Bounds and states

`GET /api/shipping-pulse` is authenticated and not offered to operator agents: their scoped API serves no repository-wide aggregate, their navigation hides the entry.
