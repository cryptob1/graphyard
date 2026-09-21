<!-- page: Build integrations | 7 | capacity, artifacts, rollback. -->
# Runner capacity, artifact operations and delivery recovery

For an operator running the validation path: why a request waits, and when a rollback is complete.

## Runner capacity and request diagnostics

`graphyard validation capacity` (`GET /api/validation/capacity`) reports:

- **Per runner registration:** last dispatch poll, whether executing, requests queued and for how long, queue limit
- **Backpressure:** a registration may set `queueLimit` (1–100, default 20); a request for a runner already holding that many queued refuses with HTTP 429 and the count — wait for dwell to drain, cancel stale requests or register another runner
- **Every reserved protected resource:** request and attempt holding it, whether that lease is live
- Retained-artifact usage
- One diagnosed condition per live request:
  - `queued-starved`: No dispatch poll since request creation: start or repair the runner, enable a current registration revision, or re-request on a polling runner
  - `queued-waiting-for-slot`: A needed resource held by an attempt under a live lease: wait for it to settle, or add a registration if dwell grows
  - `queued-resource-held`: A needed resource reserved by an attempt whose settlement was never verified: verify execution stopped, then `validation settle` with evidence; never release on a timer
  - `unacknowledged`: Dispatched, not acknowledged inside the ACK window: no execution authorized, an expired window settles itself, `validation retry` queues another
  - `heartbeat-missing`: Acknowledged, not renewed within the 20-second interval while the lease is live: runner may still be executing; leave its reservations until the collector observes settlement or an operator settles it with evidence
  - `collection-stalled`: Collector holds authority but stopped renewing: check the collector process; an expired collection keeps the barrier closed
  - `awaiting-settlement`: Terminal, reservations held by an unsettled attempt: verify termination and its external operations, then `validation settle` with evidence
  - `retryable`: Settled, attempts and deadline remaining: `validation retry`
  - `running`, `collecting`, `settled`: Healthy or finished

## Artifact backends, capacity and migration

Private artifacts keep their authorization, digest, retention and request binding on the row whatever holds the bytes.

- **postgres** (default): bytes in the row
- **s3:** S3-compatible store reached with path-style SigV4: `GRAPHYARD_ARTIFACT_BACKEND=s3`, `GRAPHYARD_ARTIFACT_S3_ENDPOINT`, `GRAPHYARD_ARTIFACT_S3_BUCKET`, `GRAPHYARD_ARTIFACT_S3_REGION` (default `us-east-1`), `GRAPHYARD_ARTIFACT_S3_ACCESS_KEY_ID`, `GRAPHYARD_ARTIFACT_S3_SECRET_ACCESS_KEY`, optional `GRAPHYARD_ARTIFACT_S3_PREFIX`. Only the server holds that credential; collectors upload through the same call with their scoped Graphyard credential
- Provider I/O stays outside coordination transactions: an upload is reserved under the lock as `pending`, bytes move with the lock released, the row becomes `stored` only after the same authority is rechecked. Every read verifies the SHA-256 recorded at upload; a substituted object refuses with an integrity error.
- A row is `pending`, `stored`, `upload-failed` or `expired`; the last two refuse with their own reason, beside `missing`. A failed upload refuses the collector with 503 and resumes on retry with the same idempotency key and bytes; an upload exceeding `GRAPHYARD_ARTIFACT_CAPACITY_BYTES` refuses with 507, storing nothing.
- Expiry recorded first, under the lock, so reads refuse from that instant; the sweep then deletes the object, confirms with `HEAD`, only then records the deletion; a refused deletion is retried, never assumed.
- `graphyard validation artifact-migrate s3|postgres [LIMIT]` copies each artifact's bytes, reads them back, compares with the recorded digest before the row names the new backend, listing a failed copy under `refused`; retention, bindings and access rules do not move. Run it until `remaining` is zero, then switch the backend variable on every replica.

## Rollback

A rollback is four records plus a repair-work link; register the executor as a service-scoped `rollback` registration:

```json
{
  "kind": "registration",
  "id": "production-rollback",
  "expectedRevision": 0,
  "principalId": "railway-rollback",
  "role": "rollback",
  "environment": {"id": "production", "revision": 1},
  "adapterVersion": "custom-v1",
  "proofs": [],
  "enabled": true,
  "services": ["api", "web"],
  "rollback": {"fencing": "provider", "automatic": true}
}
```

| Fencing | Meaning | May be automatic | Effect on successors |
| --- | --- | --- | --- |
| `provider` | Write conditioned provider-side on the deployment that should still be running (`precondition.expectedRunning`) and this operation's `generation` and `token` | Yes | A newer selection may supersede the target; the delayed write fails at the provider its late report recorded as non-authoritative |
| `serialized` | Adapter observes its own operation settle but cannot fence the write | Yes | No selection, rollback or other environment mutation is authorized until the operation is settled or resolved; lease expiry alone releases nothing |
| `none` | Neither | **No**: definition refuses `automatic: true`; claiming an automatic rollback refuses | Same serialized barrier |

### Request, claim and settle

The operator, or a promoter through its `delegate` lease, requests one with `POST /api/delivery/rollback`:

```json
{
  "environment": {"id": "production", "revision": 1},
  "target": {"id": "2026.09.17-4", "revision": 1},
  "expectedGeneration": 7,
  "reason": "Generation 7 degraded: api-2 unhealthy after 2026.09.18-1",
  "repairWorkId": "2f7d1a5e-3b8c-4d9e-8f10-1a2b3c4d5e6f"
}
```

The executor claims it and reports the operation; with its host lost, an operator settles it with evidence:

```json
{"rollbackId": "6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01", "registration": {"id": "production-rollback", "revision": 1}, "epoch": 3}
```

```json
{"rollbackId": "6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01", "operationId": "b8c9d0e1-2f3a-4b5c-8d6e-7f8091a2b3c4", "registration": {"id": "production-rollback", "revision": 1}, "epoch": 3, "outcome": "applied", "providerOperationId": "railway:deployment:01J8Q5"}
```

```json
{"rollbackId": "6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01", "operationId": "b8c9d0e1-2f3a-4b5c-8d6e-7f8091a2b3c4", "outcome": "applied", "reason": "Provider console shows deployment 01J8Q5 succeeded; executor host was lost", "evidence": "https://railway.app/project/example/deployments/01J8Q5"}
```

### Completion and automatic rollback

- **`applied`:** the provider's word
- **`verified`:** complete, only when the sweep verifies the generation it selected, as in [delivery verification](delivery.md#verification); record then carries `verifiedAt` and the interval
- **`superseded`:** one superseded first, its operation record intact

`"automaticRollback": true` in the environment's `delivery` policy lets the sweep open one when a verified generation degrades. It:

1. Selects the most recent release that verified here
2. Requires its approval to still bind where the policy asks
3. Checks an enabled `rollback` registration with `provider` or `serialized` fencing and `automatic: true` covers the environment
4. Opens the rollback with incident IDs

- **Anything missing:** refusal shown once as `automaticRollbackRefusal`
- **Limits:** one rollback per generation; an unfenced executor cannot claim it
- **Views:** `graphyard delivery` lists rollbacks with their history; **Releases** view shows state, executor, fencing and outcome
