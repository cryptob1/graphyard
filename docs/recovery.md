<!-- page: Build integrations | 7 | runner capacity, artifacts, fenced rollback. -->
# Runner capacity, artifact operations and delivery recovery

For an operator running the validation path: why a request waits, and when a rollback is complete.

## Runner capacity and request diagnostics

`graphyard validation capacity` (`GET /api/validation/capacity`) reports, per runner registration, its last dispatch poll, whether it is executing, how many requests are queued against it and for how long, and its queue limit; every reserved protected resource with the request and attempt holding it and whether that lease is live; retained-artifact usage; and one diagnosed condition per live request.

| Condition | Meaning | Next step |
| --- | --- | --- |
| `queued-starved` | No dispatch poll from the request's runner registration since the request was created | Start or repair the runner process, enable a current registration revision, or re-request on a runner that polls |
| `queued-waiting-for-slot` | The runner polled, but a resource this request needs is in use by an attempt under a live lease | Wait for that attempt to settle; add a runner registration if dwell keeps growing |
| `queued-resource-held` | The runner polled, but a needed resource is reserved by an attempt whose settlement was never verified | Verify that execution stopped, then `validation settle` with evidence; never release on a timer |
| `unacknowledged` | Dispatched, not acknowledged inside the ACK window | No execution was authorized; an expired window settles itself and `validation retry` queues another attempt; inspect the runner's attempt log |
| `heartbeat-missing` | Acknowledged, but not renewed within the 20-second interval while the lease is still live | The runner is stalled or partitioned and may still be executing; leave its reservations alone until the collector observes settlement or the human operator settles it with evidence |
| `collection-stalled` | The collector holds authority but stopped renewing | Check the collector process; an expired collection keeps the barrier closed |
| `awaiting-settlement` | Terminal, with reservations held by an unsettled attempt | Verify termination and its external operations, then `validation settle` with evidence |
| `retryable` | Settled, with attempts and deadline remaining | `validation retry` |
| `running`, `collecting`, `settled` | Healthy or finished | Nothing |

## Artifact backends, capacity and migration

Private artifacts keep their authorization, digest, retention and request binding on the row whatever holds the bytes. **postgres** (the default) keeps bytes in the row; **s3** uses an S3-compatible store reached with path-style SigV4, configured with `GRAPHYARD_ARTIFACT_BACKEND=s3`, `GRAPHYARD_ARTIFACT_S3_ENDPOINT`, `GRAPHYARD_ARTIFACT_S3_BUCKET`, `GRAPHYARD_ARTIFACT_S3_REGION` (default `us-east-1`), `GRAPHYARD_ARTIFACT_S3_ACCESS_KEY_ID`, `GRAPHYARD_ARTIFACT_S3_SECRET_ACCESS_KEY` and optional `GRAPHYARD_ARTIFACT_S3_PREFIX`. Only the server holds that credential; collectors upload through the same call with their scoped Graphyard credential, and bucket policies should grant nothing beyond the prefix.

- Provider I/O never happens inside a coordination transaction: an upload is authorized and reserved under the lock as `pending`, the bytes move with the lock released, and the row is published as `stored` only after the same authority is rechecked.
- The store's acknowledgement is verified, and every read verifies the SHA-256 recorded at upload, so a substituted object refuses with an integrity error.
- A row is `pending`, `stored`, `upload-failed` or `expired`; `upload-failed` and `expired` are refusals with their own reason, beside `missing`. A failed upload refuses the collector with HTTP 503 and resumes on a retry with the same idempotency key and bytes; a different payload under that key refuses.
- `GRAPHYARD_ARTIFACT_CAPACITY_BYTES` bounds retained bytes; an upload that would exceed it refuses with HTTP 507 and stores nothing.
- Expiry is recorded first, under the lock, so reads refuse from that instant; the sweep then deletes the object, confirms with a `HEAD` that it is gone, and only then records the deletion — a refused deletion is retried, never assumed.
- `graphyard validation artifact-migrate s3|postgres [LIMIT]` copies each artifact's bytes, reads them back and compares them with the recorded digest before the row names the new backend; a copy failing its digest is discarded and listed under `refused`. Retention, bindings and access rules do not move. Run it until `remaining` is zero, then switch the backend variable on every replica.

## Rollback

A rollback is an integration workflow with four records plus a link to repair work. Register the executor as a service-scoped `rollback` registration:

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
| `provider` | The write is conditioned provider-side on the deployment that should still be running (`precondition.expectedRunning`) and this operation's `generation` and `token` | Yes | A newer selection may supersede the target; the delayed write fails at the provider and its late report is recorded as non-authoritative |
| `serialized` | The adapter observes its own operation settle but cannot fence the write | Yes | No selection, rollback or other mutation of the environment is authorized until the operation is settled or resolved; lease expiry alone releases nothing |
| `none` | Neither | **No** — definition refuses `automatic: true`, and a claim of an automatic rollback refuses | Same serialized barrier as above |

### Request, claim and settle

The operator, or a promoter through its `delegate` lease, requests a rollback with `POST /api/delivery/rollback`:

```json
{
  "environment": {"id": "production", "revision": 1},
  "target": {"id": "2026.09.17-4", "revision": 1},
  "expectedGeneration": 7,
  "reason": "Generation 7 degraded: api-2 unhealthy after 2026.09.18-1",
  "repairWorkId": "2f7d1a5e-3b8c-4d9e-8f10-1a2b3c4d5e6f"
}
```

The executor then claims it, reports the operation, and — when the executor host is lost — an operator settles it with external evidence:

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

`applied` is the provider's word. A rollback is `verified` — complete — only when the sweep verifies the generation it selected, exactly as in [delivery verification](delivery.md#verification); the record then carries `verifiedAt` and the interval, and one superseded before that is `superseded` with its operation record intact. `"automaticRollback": true` in the environment's `delivery` policy lets the sweep open one when a verified generation degrades: it selects the most recent release that verified here before, requires its approval to still bind where the policy asks for one, checks that an enabled `rollback` registration with `provider` or `serialized` fencing and `automatic: true` covers the whole environment, and opens the rollback with the incident IDs. Anything missing is a refusal shown once as `automaticRollbackRefusal`, not a guess. One rollback per generation, and an unfenced executor cannot claim it. `graphyard delivery` lists rollbacks with their history, and the **Releases** view shows state, executor, fencing and outcome.
