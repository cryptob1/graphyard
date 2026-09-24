<!-- page: Build integrations | 6 | releases, approvals, and observed production delivery. -->
# Releases and observed production delivery

Graphyard records which release each environment should run and verifies it only from what service-scoped observers measured running. An observer is a process you run with its own `producer` credential; unmeasurable identity shows as unknown. Rollback: [recovery](recovery.md#rollback).

## Records and who may change them

| Record | Written by |
| --- | --- |
| Environment `delivery` policy | `admin` |
| Release build | `producer` with a `builder` registration |
| Release revision | `admin`, or a `promoter` registration with a current lease |
| Approval | `admin` |
| Expected release selection | `admin` or promoter; fenced by `expectedGeneration` |
| Deployment observation | `producer` with an `observer` registration and a current lease |
| Notification | Any non-worker credential; a hint only |
| Verification, incidents, attribution | Graphyard's sweep |

Registrations name a principal, an environment and the `services` they cover. `POST /api/delivery/lease` `{"registration": {"id", "revision"}}` grants a 60-second epoch; pass `epoch` to renew. A superseded epoch is refused.

## Environment policy

Without `delivery`, the defaults are a 300-second freshness bound and a required approval.

```json
{
  "kind": "environment",
  "id": "production",
  "expectedRevision": 0,
  "repository": "owner/repository",
  "url": "https://app.example.test",
  "instance": "production-cluster",
  "immutable": true,
  "services": ["api", "web"],
  "resources": ["production-smoke-account"],
  "delivery": { "freshnessSeconds": 300, "approvalRequired": true }
}
```

```json
{
  "kind": "registration",
  "id": "production-observer",
  "expectedRevision": 0,
  "principalId": "railway-observer",
  "role": "observer",
  "environment": {"id": "production", "revision": 1},
  "adapterVersion": "custom-v1",
  "proofs": [],
  "enabled": true,
  "services": ["api", "web"]
}
```

A promoter has the same shape with `role: promoter` and must cover every service. Deployment identities count toward `GRAPHYARD_MAX_REVIEWERS` ([delegation](delegation.md#capacity-and-identity)).

## Define and select a release

`POST /api/delivery/build` attests the full manifest:

```json
{
  "registration": {"id": "production-builder", "revision": 1},
  "sourceSha": "0123456789abcdef0123456789abcdef01234567",
  "buildInputsDigest": "sha256:5b8e0d3a7f21c94e6082d5b1a3f7c0e94d26b8a15f309c7e4b1d02a6f8395c7e",
  "artifacts": [
    {"service": "api", "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111"},
    {"service": "web", "digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222"}
  ],
  "provenanceUrl": "https://ci.example.test/builds/812"
}
```

`POST /api/delivery/release` names the build and its explicit membership; each member cites its recorded merge SHA, and a reverted change stays listed with `included: false`. A promoter adds `"delegate": {"registration": {...}, "epoch": N}`.

```json
{
  "id": "2026.09.18-1",
  "expectedRevision": 0,
  "environment": {"id": "production", "revision": 1},
  "sourceSha": "0123456789abcdef0123456789abcdef01234567",
  "buildId": "5d7c6b7e-8c35-4b3f-9c4a-0a1f2e3d4c5b",
  "manifest": [
    {"service": "api", "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111"},
    {"service": "web", "digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222"}
  ],
  "members": [
    {"workId": "2f7d1a5e-3b8c-4d9e-8f10-1a2b3c4d5e6f", "mergeSha": "89abcdef0123456789abcdef0123456789abcdef", "included": true},
    {"workId": "3a8e2b6f-4c9d-4eaf-9021-2b3c4d5e6f70", "mergeSha": "9abcdef0123456789abcdef0123456789abcdef0", "included": false, "note": "Reverted in #812"}
  ]
}
```

Approve with `POST /api/delivery/approve` `{"release": {"id", "revision"}, "environment": {"id", "revision"}}`, then select with `POST /api/delivery/select`; exactly one concurrent selection per generation succeeds:

```json
{
  "environment": {"id": "production", "revision": 1},
  "release": {"id": "2026.09.18-1", "revision": 1},
  "expectedGeneration": 3,
  "approvalId": "0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5"
}
```

## Observe

The observer submits what it measured through `POST /api/delivery/observe`:

```json
{
  "registration": {"id": "production-observer", "revision": 1},
  "epoch": 4,
  "environment": {"id": "production", "revision": 1},
  "expectedGeneration": 4,
  "snapshotId": "railway:snapshot:01J8Q4Z0Y3",
  "observedAt": "2026-09-18T20:15:07Z",
  "validFrom": "2026-09-18T20:12:31Z",
  "validTo": "2026-09-18T20:15:07Z",
  "services": [
    {"service": "api", "complete": true, "deployment": {"id": "dep-a1", "status": "success", "deployedAt": "2026-09-18T20:12:31Z"},
      "instances": [{"instance": "api-1", "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111", "measurement": "host-attestation", "healthy": true}]},
    {"service": "web", "complete": true, "deployment": {"id": "dep-w7", "status": "success", "deployedAt": "2026-09-18T20:12:40Z"},
      "instances": [{"instance": "web-1", "digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222", "measurement": "host-attestation", "healthy": true}]}
  ]
}
```

Only complete listings with `measurement` `provider` or `host-attestation` can verify. A stale generation or superseded lease is kept as non-authoritative history; a repeated `snapshotId` returns the original receipt. `POST /api/delivery/notify` records a webhook as a hint only.

## Verification

Every two seconds a sweep folds up to fifty observations per environment into coverage (`graphyard delivery sweep` drains sooner). Status is `unselected`, `unobserved`, `mismatched`/`unknown`/`unhealthy`/`incomplete`, `no-common-interval`, `stale`, `verified` or `degraded`. Verification needs a common interval across every service within the freshness bound; it happens once per generation and adds a `releaseDeliveries` entry to each included work item. Degradation records incidents and rewrites nothing.

```bash
graphyard delivery
graphyard delivery observations ENV [CURSOR]
graphyard delivery sweep
graphyard delivery build|release|approve|select|lease|observe|notify FILE.json
```
