# Shipping pulse

Shipping pulse summarizes repository delivery flow. It is deliberately a repository view, not a worker scorecard: it contains no rankings, lines of code, effort estimates, individual productivity measures, or causal claims.

## Source and definitions

Every value comes from the append-only `events` ledger. A delivery is counted only from the first `github.observed` event for a work item whose immutable event payload contains an accepted `delivery`, exact pull request, exact merge commit, and provider merge timestamp. Mutable `work_items` snapshots, claims, submissions, lease activity, and inferred implementation activity are never counted.

The repository PostgreSQL clock defines “now” and all boundaries use UTC. The 7-day and 30-day counts include exact merge timestamps at both `now - N days` and `now`. Weekly bars use Monday 00:00 UTC through Sunday 23:59:59.999 UTC, except the current week ends at `now`; both endpoints are inclusive. The API returns exactly 12 weeks.

Intent-to-merge begins at the earliest append-only `create` event for the delivered work item and ends at its exact accepted merge timestamp. The median is the ordinary middle value, or the mean of the two middle values for an even sample. Records missing either endpoint, or with an endpoint in the wrong order, are excluded rather than fabricated. The UI reports both included and excluded sample sizes.

PR-to-production begins at GitHub's durable observed pull-request `createdAt`, splits at the exact accepted merge time, and ends at the earliest successful production deployment that independently records containment of that exact merge SHA. A trusted producer records normalized provider observations through `POST /api/production-observations`; implementation workers cannot use this endpoint. Each observation retains provider/deployment identity, immutable commit or artifact identity, provider time, receipt time, source URL, producer, and up to 500 exact contained merge SHAs in append-only indexed tables, so later Railway retention does not erase the history.

The production statistics cover exact merges in the same 12-week UTC reporting window. They report average, median, nearest-rank p90, sample size, coverage, excluded count/reasons, and average PR-created-to-merge and merge-to-production components. Missing GitHub creation observations, missing verifiable containment, superseded deployments, rollbacks, and invalid clock ordering are excluded rather than guessed. A deployment may contain multiple PR merge SHAs. A superseding observation invalidates that deployment; a later valid deployment may become the first endpoint. Samples below five are prominently labeled sparse. Empty metrics are unavailable, not zero-duration.

## Bounds and states

`GET /api/shipping-pulse` is authenticated. Its indexed event query is limited to the 12-week time range and 1,001 rows. Production joins use indexed exact merge identities and inspect at most 101 successful deployment observations per merge; reaching that overflow marks the response conservatively partial rather than silently claiming complete history. The ingestion request accepts at most 500 merge identities. At most 1,000 deliveries feed metrics, 12 weekly buckets are returned, recent delivery output is limited to 10 records, and each delivery exposes at most 10 policy-violation messages. Ordering is merge timestamp descending, then work identity, so equal timestamps are deterministic.

The response is `complete` when the bounded result fits and `partial` when the cap is exceeded. The interface separately presents loading, unavailable, empty, partial, stale (older than two minutes), and complete states. Unavailable or absent values are labeled and are never rendered as zero or success. A partial response explicitly says its counts and median are lower-bound samples.

Recent entries link to the exact pull request and merge commit when repository identity is available. Quality context is limited to proof totals and recorded policy violations at delivery. The weekly visual has a screen-reader list with the same values, links and controls are keyboard accessible, and layouts collapse to a single column on narrow screens.
