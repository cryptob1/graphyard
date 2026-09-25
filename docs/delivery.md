<!-- page: Build integrations | 4 | releases and observed delivery. -->
# Releases and observed production delivery

Graphyard records which release each environment should run and verifies it only from what service-scoped observers measured running. Rollback is in [recovery](recovery.md#rollback).

## Who writes what

Policy and approvals are `admin`'s; builds from a `producer` with a `builder` registration, selection from `admin` or a `promoter`, observations from a `producer` with an `observer` registration and a lease (`POST /api/delivery/lease`).

```json
{"kind":"environment","id":"production","expectedRevision":0,"repository":"owner/repository",
 "url":"https://app.example.test","instance":"production-cluster","immutable":true,"services":["api","web"],
 "resources":["production-smoke-account"],"delivery":{"freshnessSeconds":300,"approvalRequired":true}}
```

```json
{"kind":"registration","id":"production-observer","expectedRevision":0,"principalId":"railway-observer","role":"observer",
 "environment":{"id":"production","revision":1},"adapterVersion":"custom-v1","proofs":[],"enabled":true,"services":["api","web"]}
```

## Define, approve and select a release

`POST /api/delivery/build` attests the manifest:

```json
{"registration":{"id":"production-builder","revision":1},"sourceSha":"0123456789abcdef0123456789abcdef01234567",
 "buildInputsDigest":"sha256:5b8e0d3a7f21c94e6082d5b1a3f7c0e94d26b8a15f309c7e4b1d02a6f8395c7e",
 "artifacts":[{"service":"api","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"},
              {"service":"web","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}],
 "provenanceUrl":"https://ci.example.test/builds/812"}
```

`POST /api/delivery/release` names the build and its explicit membership; each member cites its merge SHA, and a reverted change stays listed with `included: false`:

```json
{"id":"2026.09.18-1","expectedRevision":0,"environment":{"id":"production","revision":1},
 "sourceSha":"0123456789abcdef0123456789abcdef01234567","buildId":"5d7c6b7e-8c35-4b3f-9c4a-0a1f2e3d4c5b",
 "manifest":[{"service":"api","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"},
             {"service":"web","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}],
 "members":[{"workId":"2f7d1a5e-3b8c-4d9e-8f10-1a2b3c4d5e6f","mergeSha":"89abcdef0123456789abcdef0123456789abcdef","included":true},
            {"workId":"3a8e2b6f-4c9d-4eaf-9021-2b3c4d5e6f70","mergeSha":"9abcdef0123456789abcdef0123456789abcdef0","included":false,"note":"Reverted in #812"}]}
```

Approve with `POST /api/delivery/approve` `{"release": {...}, "environment": {...}}`, then select; one concurrent selection per generation wins:

```json
{"environment":{"id":"production","revision":1},"release":{"id":"2026.09.18-1","revision":1},
 "expectedGeneration":3,"approvalId":"0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5"}
```

## Observe and verify

The observer submits what it measured through `POST /api/delivery/observe`:

```json
{"registration":{"id":"production-observer","revision":1},"epoch":4,"environment":{"id":"production","revision":1},
 "expectedGeneration":4,"snapshotId":"railway:snapshot:01J8Q4Z0Y3","observedAt":"2026-09-18T20:15:07Z",
 "validFrom":"2026-09-18T20:12:31Z","validTo":"2026-09-18T20:15:07Z",
 "services":[
  {"service":"api","complete":true,"deployment":{"id":"dep-a1","status":"success","deployedAt":"2026-09-18T20:12:31Z"},
   "instances":[{"instance":"api-1","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","measurement":"host-attestation","healthy":true}]},
  {"service":"web","complete":true,"deployment":{"id":"dep-w7","status":"success","deployedAt":"2026-09-18T20:12:40Z"},
   "instances":[{"instance":"web-1","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222","measurement":"host-attestation","healthy":true}]}]}
```

Only complete listings measured by `provider` or `host-attestation` can verify; a repeated `snapshotId` returns the original receipt, and `POST /api/delivery/notify` is a hint only. A sweep every two seconds (`graphyard delivery sweep` drains sooner) verifies a generation once every service shares a common interval within the freshness bound, adding a `releaseDeliveries` entry to each included item. Otherwise status reads `unobserved`, `mismatched`, `unknown`, `unhealthy`, `incomplete`, `no-common-interval`, `stale` or `degraded`. `graphyard delivery` shows the state.

## Attribution

A validation pass is a claim about one artifact on one target. Each request binds the candidate's manifest, a compatibility signature (manifest, build inputs, test bundle, configuration, source, policy, artifacts) and what observers measured across the run; workers and client-supplied SHAs establish nothing, and `POST /api/validation/result` refuses a top-level SHA field. A mismatch inside an accepted pass's window records `attribution-undermined` and the pass stops counting. `GET /api/analytics/attribution` reports mismatches and paid-run cost.
