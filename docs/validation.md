<!-- page: Build integrations | 3 | candidates, dispatch, attempts, and trusted results. -->
# Validation candidates and runner protocol

The operator pins a candidate, an approved test bundle and separate runner and collector identities; only the pinned collector publishes a result. The packaged path is in [runner setup](runner-setup.md).

## Identities and trust

| Identity | Credential | Authority |
| --- | --- | --- |
| Human operator | `admin` | Define environments and bundles, register, select candidates, request/cancel/recover |
| Runner | `worker` + runner registration | Dispatch, ACK, heartbeat its attempt |
| Build producer | `producer` + builder registration | Attest source → artifacts |
| Collector | `producer` + collector registration | Verify and publish the result |

Registrations name principal IDs and have immutable revisions; a collector that attested the candidate's build is refused. Rotate by disabling, replacing the credential, then enabling a new revision.

## Commands

```bash
graphyard validation [requests CURSOR]
graphyard validation definitions
graphyard validation show-candidate CANDIDATE_UUID
graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json
```

API: `GET /api/validation`, `/definitions`, `/candidate/UUID`; `POST /api/validation/ACTION` with an `Idempotency-Key`.

## Configure a candidate

Define an [E2E scenario](test-cases.md), create work requiring `e2e:SCENARIO_ID`, then define the environment (`delivery` sets its [release policy](delivery.md#environment-policy)):

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

`immutable: false` (shared staging) is granted only against an observed match ([attribution](attribution.md)). A runner registration:

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

`executionHost` must be a local `unix://` socket; `executionNetwork` cannot be a built-in network; `testAccountDigest` comes from `graphyard runner account-digest FILE`. Collectors use `role: collector`, builders `role: builder`; `observer`, `promoter` and `rollback` are for [delivery](delivery.md) and [recovery](recovery.md#rollback).

A `kind: bundle` pins `scenario`, `scenarioRevision`, `scenarioHash`, `digest`, `runnerImageDigest` and optional `reportFormat` ([report adapters](report-adapters.md)). The builder attests `sourceSha`, `baseSha`, `buildInputsDigest`, `artifacts` and `provenanceUrl`; the operator then creates the candidate with `proof`, `environment`, `bundle`, `buildAttestationId` and `requiredArtifacts`.

## Requests and attempts

A request names the candidate, runner and collector, a `deadline` within the hour and `maxAttempts` 1–5, and binds the observed target; a moved target [re-anchors](attribution.md#re-anchoring) it. The runner polls `dispatch`, must `ack` `{requestId, attemptId, epoch}` **before executing** (30-second window) and heartbeats every 20 seconds. The collector's `collection-authority` call revokes the runner. `graphyard validation capacity` diagnoses stuck requests ([recovery](recovery.md#runner-capacity-and-request-diagnostics)).

## Trusted results

`result` carries the attempt identity, `execution`, `behavior`, `executed`, `skipped`, `inventoryComplete`, `target` (`measurement`, `coversEntireRun`, `attribution`), executed digests, verified `artifacts`, `artifactState` and `executionSettled`. Only measured, whole-run `matched` targets with `verified` artifacts and settled execution pass. `accepted: true` means the report is current, **not** that tests passed.

## Recovery

`cancel`, `settle` (with `settlementEvidence` proving the process stopped) and `retry` take `{requestId, epoch, reason}`. Replay and reuse: [evidence reuse](evidence-reuse.md).
