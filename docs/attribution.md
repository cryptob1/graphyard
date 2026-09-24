<!-- page: Build integrations | 7 | release manifests, exact-target validation, safe re-anchoring, and attribution analytics. -->
# Candidate-to-deployment attribution

A validation pass is a claim about one artifact on one target. Every request binds the exact manifest its candidate was built into, a compatibility signature, and what registered observers measured running across the execution window. When the target moves, Graphyard supersedes the request, never edits it. Endpoints are on the [protocol page](protocol/attribution.md).

## Manifests and trust

A manifest maps each service to an artifact digest and source SHA at one environment revision. It is derived, never supplied: from a release revision ([delivery](delivery.md#define-and-select-a-release)) or from the build attestation a candidate pins ([validation](validation.md#configure-a-candidate)). Only builders (source → artifact), the operator or a promoter (release identity), observers with `provider` or `host-attestation` measurement (what runs), and collectors (results, rechecked) establish facts. Workers, runners, self-reports and client-supplied SHAs establish nothing.

## Exact-target validation

A request binds the candidate's manifest and digest hash, its signature, the target kind (`immutable-preview` or `shared-staging`), and the observed target identity. A target already running another manifest refuses the request before any paid run. Shared staging is granted only once the candidate manifest is observed running and passes only if it stayed `matched` for the whole window; an immutable preview fails on any contradicting observation. A collector's `matched` claim on an `unknown` measurement fails and is ledgered. A pass is never reused by a new request. Prefer immutable previews.

## Compatibility signatures

The signature hashes `manifest`, `build-inputs`, `test-bundle`, `configuration`, `source`, `policy` and `artifacts` separately. Any change writes `signature-regenerated` naming the components, and the earlier candidate's requests are superseded.

## Re-anchoring

When an authoritative observation measures another manifest:

1. The request is superseded in place, history intact; an unacknowledged run is counted as avoided.
2. Graphyard checks, from trusted records of this environment only, whether the observed target contains the change (a build attestation for this item, or a release, whose manifest is the observed one).
3. If so, a fresh candidate and request are created with `reanchoredFrom`; fresh execution is required.
4. Otherwise the binding is **blocked** on the item (`validation[proof].reanchor`) with reasons — ambiguous history, unmeasured identity, no matching attestation or release, change not contained, or deadline passed — and the next observation retries.

One `attribution_reanchors` row per superseded request makes this idempotent across observers and replicas. A mismatch during a running attempt records `target-changed` and the result cannot pass; a delayed mismatch inside an accepted pass's window records `attribution-undermined` and the pass stops counting.

## Metrics

`GET /api/analytics/attribution` and the **Attribution** section of [flow analytics](flow-analytics.md) report, for 7, 30 or 90 days, each as `measured`, `unavailable` or `blocked`: target mismatches, paid runs avoided, requests superseded and rescheduled, re-anchors and blocked re-anchors, target-convergence wait, multi-service convergence, candidate-to-release drift, signature regeneration, immutable-preview share, unsupported-success claims prevented, and cost.

Cost counts paid runs (acknowledged attempts), never prices: **spent**, **attributed** (bound to the observed target), **wasted** (target changed or pass undermined) and **saved** (refused on a known mismatch). Every aggregate drills down to 200 rows; identifiers beyond the work key need `admin`, `coordinator` or `producer`.
