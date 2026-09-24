<!-- page: Build integrations | 7 | runner diagnostics, artifact storage, and fenced rollback. -->
# Runner capacity, artifact operations and delivery recovery

A lost heartbeat releases nothing, and a rollback completes only when the target [verifies](delivery.md#verification). Agent-account exhaustion: [master guide](master-agent-sessions.md#exhaustion-in-the-middle-of-a-session).

## Runner capacity and request diagnostics

`graphyard validation capacity` reports runners, reserved resources, artifact usage, and one condition per live request:

| Condition | Next step |
| --- | --- |
| `queued-starved` (runner never polled) | Start or repair the runner, or re-request on one that polls |
| `queued-waiting-for-slot` | Wait; add a runner if dwell grows |
| `queued-resource-held` (holder never settled) | Verify it stopped, then `validation settle` with evidence |
| `unacknowledged` | Nothing ran; `validation retry` after the window |
| `heartbeat-missing` | The runner may still execute; leave reservations until settlement is observed |
| `collection-stalled` | Check the collector |
| `awaiting-settlement` | Verify termination, then `validation settle` |
| `retryable` | `validation retry` |

A runner registration's `queueLimit` (1–100, default 20) makes further requests refuse with 429.

## Artifact backends, capacity and migration

Artifacts are stored in Postgres (default) or an S3-compatible store: `GRAPHYARD_ARTIFACT_BACKEND=s3`, `GRAPHYARD_ARTIFACT_S3_ENDPOINT`, `_BUCKET`, `_REGION` (default `us-east-1`), `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, optional `_PREFIX`. Only the server holds the S3 credential; uploads and reads go through `/api/validation/artifacts`. Every read checks the recorded SHA-256.

- States: `pending`, `stored`, `upload-failed`, `expired`. A failed upload returns 503; retry with the same key and bytes.
- `GRAPHYARD_ARTIFACT_CAPACITY_BYTES` (default 2 GiB) bounds retained bytes; over it, uploads return 507.
- Expiry refuses reads immediately; the sweep deletes objects and confirms with `HEAD`.
- `graphyard validation artifact-migrate s3|postgres [LIMIT]` (`admin`) copies, verifies and moves up to 100 artifacts per call. Repeat until `remaining` is zero, then switch `GRAPHYARD_ARTIFACT_BACKEND` on every replica.

## Rollback

Register a service-scoped executor:

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

| Fencing | Meaning | Automatic? |
| --- | --- | --- |
| `provider` | The provider write is conditioned on `precondition.expectedRunning` and the operation token | Yes |
| `serialized` | Unfenced; the environment is frozen until the operation settles | Yes |
| `none` | Neither | No |

An `unknown` outcome blocks every successor until the human operator resolves it. The executor holds a lease via `POST /api/delivery/lease`.

The human operator, or a promoter's `delegate` lease, requests with `POST /api/delivery/rollback`; the target must have verified in this environment before:

```json
{
  "environment": {"id": "production", "revision": 1},
  "target": {"id": "2026.09.17-4", "revision": 1},
  "expectedGeneration": 7,
  "reason": "Generation 7 degraded: api-2 unhealthy after 2026.09.18-1",
  "repairWorkId": "2f7d1a5e-3b8c-4d9e-8f10-1a2b3c4d5e6f"
}
```

The executor claims with `POST /api/delivery/rollback-claim` (a retry returns the same operation):

```json
{
  "rollbackId": "6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01",
  "registration": {"id": "production-rollback", "revision": 1},
  "epoch": 3
}
```

It performs the provider write and reports with `POST /api/delivery/rollback-settle` (`applied`, `failed` or `unknown`):

```json
{
  "rollbackId": "6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01",
  "operationId": "b8c9d0e1-2f3a-4b5c-8d6e-7f8091a2b3c4",
  "registration": {"id": "production-rollback", "revision": 1},
  "epoch": 3,
  "outcome": "applied",
  "providerOperationId": "railway:deployment:01J8Q5"
}
```

`POST /api/delivery/rollback-resolve` (`admin`) settles an in-flight or unknown operation with evidence:

```json
{
  "rollbackId": "6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01",
  "operationId": "b8c9d0e1-2f3a-4b5c-8d6e-7f8091a2b3c4",
  "outcome": "applied",
  "reason": "Provider console shows deployment 01J8Q5 succeeded; executor host was lost",
  "evidence": "https://railway.app/project/example/deployments/01J8Q5"
}
```

The rollback becomes `verified` only when the sweep verifies the selected generation. With `"automaticRollback": true` in the environment's `delivery` policy, a degraded generation triggers a rollback to the last verified release when a fenced, automatic executor covers every service; otherwise `automaticRollbackRefusal` says why.

```bash
graphyard delivery
graphyard delivery rollback|rollback-claim|rollback-settle|rollback-resolve FILE.json
```
