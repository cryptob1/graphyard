<!-- page: Build integrations | 6 | releases, observations. -->
# Releases and observed production delivery

For an integrator recording what production runs: which identity may write each record.

## Records and who may change them

Record (written by): meaning.

- **Approval** (`admin`): Binds one release revision, manifest hash, build and policy revision
- **Expected release selection** (`admin` or promoter): Advances the environment's generation; fenced by `expectedGeneration`
- **Rollback request, operation, resolution** (`admin` or promoter; a `rollback` registration; `admin`): The [rollback workflow](recovery.md#rollback)
- **Notification** (any authenticated non-worker credential): A provider webhook relayed as a hint, never authoritative
- **Verification, incidents, attribution** (Graphyard's bounded sweep): Derived from observations, never asserted by a client

## Environment policy

Add `delivery` to an environment definition; defaults: 300-second freshness bound, required approval.

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
  "delivery": {"freshnessSeconds": 300, "approvalRequired": true}
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

## Define and select a release

The build producer attests the manifest through `POST /api/delivery/build`:

```json
{
  "registration": {"id": "production-builder", "revision": 1},
  "sourceSha": "0123456789abcdef0123456789abcdef01234567",
  "buildInputsDigest": "sha256:5b8e0d3a7f21c94e6082d5b1a3f7c0e94d26b8a15f309c7e4b1d02a6f8395c7e",
  "artifacts": [{"service": "api", "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111"}, {"service": "web", "digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222"}],
  "provenanceUrl": "https://ci.example.test/builds/812"
}
```

```json
{
  "id": "2026.09.18-1",
  "expectedRevision": 0,
  "environment": {"id": "production", "revision": 1},
  "sourceSha": "0123456789abcdef0123456789abcdef01234567",
  "buildId": "5d7c6b7e-8c35-4b3f-9c4a-0a1f2e3d4c5b",
  "manifest": [{"service": "api", "digest": "sha256:1111111111111111111111111111111111111111111111111111111111111111"}, {"service": "web", "digest": "sha256:2222222222222222222222222222222222222222222222222222222222222222"}],
  "members": [
    {"workId": "2f7d1a5e-3b8c-4d9e-8f10-1a2b3c4d5e6f", "mergeSha": "89abcdef0123456789abcdef0123456789abcdef", "included": true},
    {"workId": "3a8e2b6f-4c9d-4eaf-9021-2b3c4d5e6f70", "mergeSha": "9abcdef0123456789abcdef0123456789abcdef0", "included": false, "note": "Reverted in #812"}
  ]
}
```

```json
{
  "environment": {"id": "production", "revision": 1},
  "release": {"id": "2026.09.18-1", "revision": 1},
  "expectedGeneration": 3,
  "approvalId": "0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5"
}
```

## Observe

An observer reads its provider outside any Graphyard transaction, submitting measurements to `POST /api/delivery/observe`:

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

## Verification

- **`graphyard delivery sweep`:** drains a backlog sooner

States:

- `unselected`: No expected release
- `unobserved`: A required service lacks an authoritative observation for this generation
- `no-common-interval`: Every service matched at some point, never at a common instant
- `stale`: A common interval ended longer ago than the freshness bound
- `verified`: The latest common interval covers the whole manifest within the bound
- `degraded`: Verified earlier in this generation; a later observation no longer matches

## Inspect

```bash
graphyard delivery                       # environments, selections, verification, incidents, releases
graphyard delivery observations ENV [CURSOR]
graphyard delivery sweep                 # drain observations now (operator)
graphyard delivery build|release|approve|select|lease|observe|notify FILE.json
```

