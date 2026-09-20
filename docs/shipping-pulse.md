<!-- page: Operate Graphyard | 10 | throughput, intent-to-merge, deployment lag. -->
# Shipping pulse

For an operator watching delivery flow: what each figure counts, and on which clock.

Deliberately a repository view, not a worker scorecard: no rankings, lines of code, effort estimates, productivity measures or causal claims.

## Source and definitions

Every value comes from the append-only `events` ledger. A delivery is counted only from the first `github.observed` event whose immutable payload carries an accepted `delivery`, exact pull request, exact merge commit and provider merge timestamp; mutable work snapshots, claims, submissions and lease activity never count. An item is delivered once, and which event records it is decided across the whole ledger before any window applies, so a re-observation months later cannot count a second delivery.

**Clocks.** GitHub's merge timestamp, the repository clock and a provider's clock are three clocks, related only by measurement. A delivery records `delivery.mergedAt` as GitHub reported it and `delivery.mergedAtRepository`, that instant carried onto the repository clock using the *lower bound* of the offset measured at merge verification, so skew never inflates a derived duration; every window, bucket, ordering and interval uses the repository instant, and older deliveries fall back to the provider timestamp. Merge verification refuses an offset measurement wider than twenty seconds.

**Intent-to-merge** runs from the earliest append-only `create` event to the exact accepted merge timestamp; the median is the ordinary middle value, and records missing an endpoint or ordered wrongly are excluded rather than fabricated, with both sample sizes reported.

**PR-to-production** runs from GitHub's durable observed pull-request `createdAt`, splits at the merge, and ends at the earliest successful production deployment independently recording containment of that exact merge SHA. Every deployment observation carries `clockOffset`, its measured bracket relative to the repository clock; ingestion refuses a bracket wider than twenty seconds, an inverted one, and one placing the clocks more than thirty days apart, then carries the observation onto the repository clock once as the earliest and latest instants it can have occurred at, keeping the provider's own time beside them. A deployment counts as post-merge when its latest bound reaches the merge instant, which also clamps its lower bound, so a duration is never negative. Published durations are accurate to the recorded measurement precision of their endpoints, and the interface says so rather than calling them exact.

## Bounds and states

`GET /api/shipping-pulse` is authenticated and not offered to operator agents, whose scoped API cannot serve a repository-wide aggregate, so its navigation entry is hidden rather than leading to a denial.

