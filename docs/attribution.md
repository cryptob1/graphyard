<!-- page: Build integrations | 7 | manifests, exact targets, re-anchoring, metrics. -->
# Candidate-to-deployment attribution

A validation pass is a claim about one artifact on one target. Each request binds the candidate's manifest, a compatibility signature, and what observers measured running across the execution window. Endpoints: [protocol page](protocol/attribution.md).

## Manifests and exact targets

A manifest maps each service to an artifact digest and source SHA at one environment revision, derived from a release ([delivery](delivery.md#define-and-select-a-release)) or the candidate's build attestation ([validation](validation.md#configure-a-candidate)); workers, self-reports and client-supplied SHAs establish nothing. A target already running another manifest refuses the request before any paid run. Shared staging passes only if the observed identity stayed `matched` for the whole window. The signature hashes `manifest`, `build-inputs`, `test-bundle`, `configuration`, `source`, `policy` and `artifacts`; any change supersedes earlier requests (`signature-regenerated`).

## Re-anchoring

When an observation measures another manifest, the request is superseded (never edited). If trusted records of this environment show the observed target contains the change, a fresh candidate and request are created with `reanchoredFrom` and must execute again; otherwise the binding is **blocked** on the item (`validation[proof].reanchor`) with its reasons until a later observation resolves it. A mismatch during a running attempt records `target-changed`; one inside an accepted pass's window records `attribution-undermined` and the pass stops counting.

## Metrics

`GET /api/analytics/attribution` and the **Attribution** section of [flow analytics](flow-analytics.md) report target mismatches, paid runs avoided, requests superseded and rescheduled, blocked re-anchors, convergence waits, candidate-to-release drift, signature regeneration, immutable-preview share, unsupported-success claims prevented, and cost in paid runs: **spent**, **attributed**, **wasted**, **saved**. Unknown is never shown as zero.
