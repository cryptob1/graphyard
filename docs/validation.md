<!-- page: Build integrations | 3 | candidates, dispatch, attempts, and trusted result collection. -->
# Validation candidates and runner protocol

The human operator pins a source/artifact candidate, an approved test bundle and separate runner and collector identities. Runners acknowledge an attempt, renew its lease and execute outside the control plane; only the pinned collector publishes the result. The packaged runner and collector are in [runner setup](runner-setup.md).

## Identities and trust

| Identity | Credential role | Authority |
| --- | --- | --- |
| Human operator | `admin` | Define environments, approve bundles, register principals, select candidates, request/cancel/recover |
| Runner | `worker` + runner registration | Poll dispatch, ACK and heartbeat its attempt |
| Build producer | `producer` + builder registration | Attest the source → artifact mapping |
| Collector | `producer` + collector registration and matching `proofs` | Verify execution, inventory, target, artifacts and settlement; publish the result |

Registrations name principal IDs, never tokens. A collector that also produced the candidate's build attestation is refused. Registrations have immutable revisions (`expectedRevision`). **Rotate** by disabling the registration, replacing the credential on every replica, then enabling a fresh revision.

## Inspect and invoke

```bash
graphyard validation                      # latest 20 requests; `requests NEXT_CURSOR` pages
graphyard validation definitions
graphyard validation show-candidate CANDIDATE_UUID
graphyard validation define environment.json
graphyard validation build attestation.json
graphyard validation candidate candidate.json
graphyard validation request request.json
graphyard validation dispatch dispatch.json
graphyard validation ack attempt.json
graphyard validation heartbeat attempt.json
graphyard validation result result.json
```

The API is `GET /api/validation?cursor=…`, `GET /api/validation/definitions?cursor=…`, `GET /api/validation/candidate/UUID`, and `POST /api/validation/ACTION`. Every mutation needs an `Idempotency-Key`; read the work `revision` right before commands that take `expectedWorkRevision`.

## Configure a candidate

Define an [E2E scenario](test-cases.md) and create work requiring `e2e:SCENARIO_ID`. Then define the environment (an optional `delivery` block sets its [release policy](delivery.md#environment-policy)):

```json
{
  "kind": "environment",
  "id": "preview",
  "expectedRevision": 0,
  "repository": "owner/repository",
  "url": "https://preview.example.test",
  "instance": "immutable-deployment-123",
  "immutable": true,
  "services": ["api"],
  "resources": ["booking-test-account"]
}
```

`immutable: true` is a declaration; the collector must still measure the target. `immutable: false` (shared staging) is granted only against an observed match ([attribution](attribution.md)). `resources` name shared external state, reserved globally.

Runner registration:

```json
{
  "kind": "registration",
  "id": "preview-runner",
  "expectedRevision": 0,
  "principalId": "runner-1",
  "role": "runner",
  "environment": {"id": "preview", "revision": 1},
  "adapterVersion": "custom-v1",
  "executionHost": "unix:///var/run/docker.sock",
  "attestationPublicKey": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n",
  "executionNetwork": "gy-preview-isolated",
  "testAccountDigest": "sha256:5b8e0d3a7f21c94e6082d5b1a3f7c0e94d26b8a15f309c7e4b1d02a6f8395c7e",
  "proofs": [],
  "enabled": true
}
```

`executionHost` must be a local `unix://` socket; `executionNetwork` cannot be `host`, `bridge`, `default` or `none`; `testAccountDigest` (from `graphyard runner account-digest FILE`) pins the approved test account. Collectors use `role: collector` with their `e2e:` proofs; build producers `role: builder`. `observer`, `promoter` and `rollback` roles are for [delivery](delivery.md) and [recovery](recovery.md#rollback).

Approve a `kind: bundle` with `id`, `expectedRevision`, `scenario`, `scenarioRevision`, `scenarioHash`, `digest`, `runnerImageDigest` and optional `reportFormat` ([report adapters](report-adapters.md); default `graphyard-playwright-v1`). Changed executable bytes need a new scenario revision and new work.

The build producer submits `registration`, `workId`, `expectedWorkRevision`, `sourceSha`, `baseSha`, `buildInputsDigest`, the full `artifacts: [{service, digest}]` manifest and `provenanceUrl`. The operator then creates the candidate with `workId`, `expectedWorkRevision`, `proof`, `environment` and `bundle` references, `buildAttestationId` and `requiredArtifacts` (e.g. `["report", "trace"]`).

## Requests and attempts

A request names `candidateId`, `expectedWorkRevision`, `runner` and `collector` references, a `deadline` within the hour and `maxAttempts` 1–5. It binds the candidate manifest and the observed target; a target already running another manifest refuses it, and one that moves later supersedes and [re-anchors](attribution.md#re-anchoring) it.

The runner polls `dispatch` with `{"registration":{"id":"preview-runner","revision":1}}` and must `ack` `{requestId, attemptId, epoch}` **before any execution** (30-second window), then heartbeat at least every 20 seconds (lease up to 60). The collector calls `collection-authority` first, which revokes the runner and moves the request to `collecting`; it renews with `collection-heartbeat`. `graphyard validation capacity` diagnoses stuck requests ([recovery](recovery.md#runner-capacity-and-request-diagnostics)).

## Trusted results

The collector's `result` carries `{requestId, attemptId, epoch}`, `execution` (`completed`, `cancelled`, `timed_out`), `behavior` (`passed`, `failed`, `blocked`, `unmeasured`), `executed`, `skipped`, `inventoryComplete`, `target: {instance, artifacts, measurement, coversEntireRun, attribution}`, the executed `bundleDigest` and `runnerImageDigest`, verified `artifacts: [{name, digest, url}]`, `artifactState` and `executionSettled`.

Only `measurement` `provider` or `host-attestation`, `attribution: matched` with whole-run coverage, `artifactState: verified` and settled execution can pass. `{accepted: true}` means the report belongs to a current attempt, **not** that tests passed. Stale results return `accepted: false` and are audited.

## Recovery

Operator commands take `{requestId, epoch, reason}`: `cancel` stops authorization (running reservations remain); `settle` also needs `settlementEvidence`, a URL proving the process stopped; `retry` queues another attempt after settlement. Replay and reuse are in [evidence reuse](evidence-reuse.md).
