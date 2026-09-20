<!-- page: Operate Graphyard | 10 | throughput and deployment lag. -->
# Shipping pulse

For an operator watching delivery flow: what each figure counts, and on which clock.

A repository view, not a worker scorecard: no rankings, lines of code, effort estimates, productivity measures or causal claims.

## Source and definitions

Every value comes from the append-only `events` ledger. A delivery counts only from the first `github.observed` event whose immutable payload carries an accepted `delivery`, exact pull request, exact merge commit and provider merge timestamp; work snapshots, claims, submissions and lease activity never count, and an item is delivered once, decided across the whole ledger before any window applies.

**Clocks.** GitHub's merge timestamp, the repository clock and a provider's clock are related only by measurement. A delivery records `delivery.mergedAt` as GitHub reported it and `delivery.mergedAtRepository`, that instant carried onto the repository clock using the *lower bound* of the offset measured at merge verification, which refuses an offset wider than twenty seconds; every window, bucket and interval uses the repository instant, and older deliveries fall back to the provider timestamp.

**Intent-to-merge** runs from the earliest `create` event to the accepted merge timestamp; the median is the ordinary middle value, and records missing an endpoint or ordered wrongly are excluded rather than fabricated, with both sample sizes reported.

**PR-to-production** runs from GitHub's observed pull-request `createdAt`, splits at the merge, and ends at the earliest successful production deployment independently recording containment of that exact merge SHA. Each deployment observation carries `clockOffset`, its measured bracket relative to the repository clock; ingestion refuses a bracket wider than twenty seconds, an inverted one, or one placing the clocks more than thirty days apart. A deployment counts as post-merge when its latest bound reaches the merge instant, which clamps its lower bound, so a duration is never negative and is published only to the measurement precision of its endpoints.

## Bounds and states

`GET /api/shipping-pulse` is authenticated and not offered to operator agents, whose scoped API cannot serve a repository-wide aggregate, so its navigation entry is hidden rather than leading to a denial.
