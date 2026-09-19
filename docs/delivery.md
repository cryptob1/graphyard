<!-- page: Build integrations | 5 | release builds, approvals, and observed production delivery. -->
# Releases and observed production delivery

Graphyard records which release each environment is expected to run, and verifies it only from what authenticated, service-scoped observers measured actually running. Desired state, provider-reported deployment success and independently observed runtime state are three separate records, and a merge that completed work is a fourth: a green merge never stands in for verified production behavior.

**This is D3 of the [delivery roadmap](turnkey-delivery-roadmap.md): the release model, the observation protocol and bounded reconciliation.** It ships no provider adapter. An observer is a process the human operator runs with its own `producer` credential that reads a provider or host and submits what it measured; the packaged runner path in [runner setup](runner-setup.md) is unrelated to it. Railway's API reports deployment status and the commit a build was requested for, not the digest of the bytes each instance serves, so a Railway observer built on it today could only report `unknown` runtime identity — which this protocol refuses to verify. That refusal is the design: where independent runtime identity cannot be established, the environment shows unknown instead of falling back to an application self-report. Behavioral checks against production (a validation request bound to a release rather than to a work item's candidate) are not part of this increment. Rolling an environment back to a previously verified release is the D4 workflow in [delivery recovery](recovery.md#rollback).

## Records and who may change them

| Record | Written by | Meaning |
| --- | --- | --- |
| Environment `delivery` policy | Human operator (`admin`), as an environment definition revision | Freshness bound for a verified interval; whether selection needs an approval |
| Release build | `producer` with a `builder` registration | Source → artifact manifest for one environment, independently established |
| Release revision | Human operator (`admin`), or `producer` with a `promoter` registration and a current lease | Immutable manifest, source and explicit membership |
| Approval | Human operator (`admin`) | Binds one release revision, manifest hash, build and policy revision |
| Expected release selection | Human operator (`admin`) or promoter | Advances the environment's generation; fenced by `expectedGeneration` |
| Deployment observation | `producer` with an `observer` registration and a current lease | Append-only runtime facts for the observer's services |
| Rollback request, operation, resolution | Human operator (`admin`) or promoter; `producer` with a `rollback` registration and a current lease; human operator (`admin`) | The [D4 rollback workflow](recovery.md#rollback): a selection of a previously verified release plus one fenced provider operation |
| Notification | Any authenticated non-worker credential | A provider webhook relayed as a hint; recorded, never authoritative |
| Verification, incidents, attribution | Graphyard's bounded sweep | Derived from observations; never asserted by a client |

Implementation workers can do none of this. An observer registration cannot define or select releases, and a promoter cannot submit observations: the registration role is checked, not just the credential's role. Registration is the identity boundary described in [validation](validation.md): a registration names a principal, an environment and — for these two roles — the `services` it covers, which must be services of that environment. Registration revisions are authorization generations; disabling one supersedes every observation and promotion it authorized.

Leases bind a running adapter to its registration. `POST /api/delivery/lease` with `{"registration": {"id", "revision"}}` acquires a new epoch for 60 seconds; passing the current `epoch` renews it. Acquiring without the epoch, or after expiry, supersedes the previous holder. Every observation and every delegated promotion carries its epoch, and a superseded epoch is refused: an adapter that lost its lease during a partition cannot publish what it read before losing it.

## Environment policy

Add `delivery` to an environment definition to set its release policy; without it the defaults are a 300-second freshness bound and a required approval.

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

Register the deployment identities as `kind: registration` definitions with `role: observer` or `role: promoter`, no proofs and no execution authority:

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

A promoter registration is the same shape with `role: promoter`; it must cover every service of the environment to select a release for it. Define a `role: builder` registration for the release build producer exactly as for validation. Each deployment identity is a `producer` credential in `GRAPHYARD_PRINCIPALS` and counts toward the shared review/proof agent limit described in [slice-lead delegation](delegation.md#capacity-and-identity); set `GRAPHYARD_MAX_REVIEWERS` to cover them.

## Define and select a release

The build producer attests the manifest through `POST /api/delivery/build`:

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

It must cover the complete service manifest of the builder's environment. The response carries the build `id`.

A release names that build and lists its membership explicitly through `POST /api/delivery/release`:

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

The manifest must equal the attested artifacts and cover exactly the environment's services. Each member cites the merge SHA GitHub reported when that work item was delivered; a member whose work is not delivered, or whose merge SHA differs from the recorded delivery, refuses. Ancestry is never inferred. A reverted change stays listed with `included: false`, so the revert is visible and the change is not attributed. A promoter includes `"delegate": {"registration": {...}, "epoch": N}`; an operator omits it. Revising a release — a changed manifest, a corrected membership — is a new immutable revision under the same `id`.

Where the policy requires it, an operator approves the exact revision with `POST /api/delivery/approve` `{"release": {"id", "revision"}, "environment": {"id", "revision"}}`. The approval binds the release revision, manifest hash, build and environment (policy) revision; a release revision with a different manifest, or an environment redefined since, is not covered by it.

Select the expected release with `POST /api/delivery/select`:

```json
{
  "environment": {"id": "production", "revision": 1},
  "release": {"id": "2026.09.18-1", "revision": 1},
  "expectedGeneration": 3,
  "approvalId": "0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5"
}
```

`expectedGeneration` is the environment's current generation; concurrent selections race on it and exactly one succeeds. The release must have been defined for the environment's current revision. Selection advances the generation, resets coverage and verification, and closes the previous selection: a release that had been verified keeps that outcome and gains `supersededAt`; one that never verified is recorded as `skipped`. Superseded is not unhealthy.

## Observe

An observer reads its provider outside any Graphyard transaction and submits what it measured through `POST /api/delivery/observe`:

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

- `observedAt` is the adapter's trusted observation time; `validFrom`/`validTo` is the interval over which the provider or host establishes that these instances ran these bytes. An atomic snapshot has `validFrom = validTo = observedAt`. Graphyard records its own receipt time separately, and `deployment.deployedAt` is the provider's deployment time.
- `complete` states that the instance list is the whole set of the service's instances. A truncated listing is `incomplete` and cannot verify, so a rolling deployment's not-yet-listed instance is never assumed.
- `measurement` is `provider` or `host-attestation` for independently measured identity, `self-report` for anything the application said about itself, and `unknown`. Only measured identity counts: a self-reported digest that matches the expected one is still `unknown`, and only a measured digest can be `mismatched`.
- `expectedGeneration` and `epoch` are what the adapter read when it started this observation. A stale generation or a superseded lease is retained as explicitly non-authoritative history — `{"authoritative": false, "rejection": [...]}` — and never touches coverage. So is a service outside the observer's scope or a superseded registration or environment revision. A registration whose principal is not the caller is refused outright.
- `snapshotId` is the provider's identity for this snapshot. Submitting it again returns the original receipt: a duplicate cannot refresh the observation time, and the idempotency key on the request has the same effect for retries of one submission.

A provider webhook relayed through `POST /api/delivery/notify` `{"environment", "provider", "payload"}` is recorded with a payload hash and shown as the last notification. It is a reason to observe again; nothing in it is applied to runtime state, and an environment that never receives one converges through the observer's own periodic reads.

## Verification

Every two seconds the server sweeps each environment: it folds at most fifty new observations into the environment's coverage, then re-evaluates. The cursor is stored with the environment, so a sweep interrupted at its bound — or a restarted server — resumes at the next observation and never skips one; an operator can run `graphyard delivery sweep` to drain a backlog sooner. Coverage keeps, per service, the merged intervals during which every listed instance matched the expected digest under measured identity, and the most recently observed state by `observedAt`. Validity histories may overlap: a later observation that finds a service unhealthy or mismatched invalidates current health even when its interval ends before an earlier, longer match, while the matched intervals already recorded stay as history.

The environment's status is derived, in this order:

| Status | Meaning |
| --- | --- |
| `unselected` | No expected release |
| `unobserved` | Some required service has no authoritative observation for this generation |
| `mismatched`, `unknown`, `unhealthy`, `incomplete` | The latest observation of some service is in that state; a mixed-version rollout is `mismatched` until it converges |
| `no-common-interval` | Every service matched at some point, but never at a common instant: A matching only before B matched cannot pass |
| `stale` | A common interval exists, but ended longer ago than the freshness bound |
| `verified` | The latest common interval covers the whole manifest and is within the bound |
| `degraded` | Verified earlier in this generation, and a later observation no longer matches |

Verification happens once per generation. It records the common interval and time, marks the selection `verified`, and attributes the release to every included member: each work item gains one `releaseDeliveries` entry per environment, the first release that verifies while it is a member. A later release that also contains the change records nothing again, so work is never completed twice; the release's membership stays visible in full. A `degraded` environment keeps its `verifiedAt`, its historical interval and every attribution, and records an incident per offending observation. Nothing rewrites the historical authorization.

## Inspect

```bash
graphyard delivery                       # environments, selections, verification, incidents, releases
graphyard delivery observations ENV      # newest 50 observations, then `... ENV CURSOR`
graphyard delivery sweep                 # drain observations now (operator)
graphyard delivery build|release|approve|select|lease|observe|notify FILE.json
```

`GET /api/delivery` is readable by every authenticated credential except operator agents. The dashboard's **Releases** view shows each environment's expected release, its status with the refusing reasons, its membership with excluded members marked, incidents and selection history; a work item's detail shows its observed deliveries separately from its merge.

## Acceptance checks

`npm test` runs `tests/delivery.test.ts` against a disposable Postgres database. Its tests are named after the D3 acceptance checks in the [roadmap](turnkey-delivery-roadmap.md#d3-releases-and-observed-production-delivery): D3-1 mixed versions, D3-2 staggered, missing, gapped and stale observations, D3-3 wrong-scope, superseded-lease, stale-generation and webhook inputs plus duplicates, D3-4 promotion authority, generation fencing, stale delegates and changed manifests, D3-5 unknown runtime identity, D3-6 self-reported identity, D3-7 dropped-webhook recovery, D3-8 multi-PR attribution, D3-9 interrupted sweeps, D3-10 later failures. The documented JSON samples above are parsed by the same schemas the API uses.
