<!-- page: Build integrations | 5 | diagnostics, storage, rollback. -->
# Runner capacity, artifacts and rollback

## Runner capacity and request diagnostics

`graphyard validation capacity` gives each live request's condition: `queued-starved` (fix the runner), `queued-waiting-for-slot` (add a runner), `queued-resource-held`/`awaiting-settlement` (once the holder stopped, `validation settle`), `unacknowledged`/`retryable` (`validation retry`), `heartbeat-missing` (keep reservations), `collection-stalled` (check the collector).

## Artifact backends, capacity and migration

Artifacts live in Postgres (default) or S3: `GRAPHYARD_ARTIFACT_BACKEND=s3`, `GRAPHYARD_ARTIFACT_S3_{ENDPOINT,BUCKET,REGION,ACCESS_KEY_ID,SECRET_ACCESS_KEY}`, optional `_PREFIX`. Only the server holds the credential; reads verify SHA-256. Failed uploads return 503 (retry, same key); past `GRAPHYARD_ARTIFACT_CAPACITY_BYTES` (default 2 GiB), 507. `graphyard validation artifact-migrate s3|postgres [LIMIT]` moves ≤100 per call; at `remaining` 0, switch every replica.

## Rollback

A rollback completes once the target [verifies](delivery.md#observe-and-verify). Register a service-scoped executor:

```json
{"kind":"registration","id":"production-rollback","expectedRevision":0,"principalId":"railway-rollback","role":"rollback","environment":{"id":"production","revision":1},"adapterVersion":"custom-v1","proofs":[],"enabled":true,"services":["api","web"],"rollback":{"fencing":"provider","automatic":true}}
```

Fencing: `provider` conditions the write on the running release; `serialized` freezes the environment until settled; `none` never runs automatically. The human operator or a promoter's `delegate` lease requests a release verified here (`POST /api/delivery/rollback`):

```json
{"environment":{"id":"production","revision":1},"target":{"id":"2026.09.17-4","revision":1},"expectedGeneration":7,"reason":"api-2 unhealthy","repairWorkId":"2f7d1a5e-3b8c-4d9e-8f10-1a2b3c4d5e6f"}
```

The executor claims (`POST /api/delivery/rollback-claim`, idempotent):

```json
{"rollbackId":"6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01","registration":{"id":"production-rollback","revision":1},"epoch":3}
```

then reports `applied`, `failed` or `unknown` (`POST /api/delivery/rollback-settle`):

```json
{"rollbackId":"6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01","operationId":"b8c9d0e1-2f3a-4b5c-8d6e-7f8091a2b3c4","registration":{"id":"production-rollback","revision":1},"epoch":3,"outcome":"applied","providerOperationId":"railway:deployment:01J8Q5"}
```

`unknown` blocks successors until an `admin` settles it with evidence (`POST /api/delivery/rollback-resolve`):

```json
{"rollbackId":"6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01","operationId":"b8c9d0e1-2f3a-4b5c-8d6e-7f8091a2b3c4","outcome":"applied","reason":"provider shows 01J8Q5 succeeded","evidence":"https://railway.app/project/example/deployments/01J8Q5"}
```

`"automaticRollback": true` (environment `delivery` policy) rolls a degraded generation back to the last verified release when fenced automatic executors cover every service; else `automaticRollbackRefusal` says why.
