<!-- page: Build integrations | 5 | diagnostics, storage, rollback. -->
# Runner capacity, artifacts and rollback

## Runner capacity and request diagnostics

`graphyard validation capacity` gives one condition per live request: `queued-starved` (start or repair the runner), `queued-waiting-for-slot` (add a runner), `queued-resource-held` or `awaiting-settlement` (verify the holder stopped, then `validation settle`), `unacknowledged` or `retryable` (`validation retry`), `heartbeat-missing` (leave reservations) or `collection-stalled` (check the collector).

## Artifact backends, capacity and migration

Artifacts live in Postgres (default) or S3 (`GRAPHYARD_ARTIFACT_BACKEND=s3` with `GRAPHYARD_ARTIFACT_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, optional `_PREFIX`); only the server holds the S3 credential; every read checks the recorded SHA-256. A failed upload returns 503 (retry with the same key); over `GRAPHYARD_ARTIFACT_CAPACITY_BYTES` (default 2 GiB) uploads return 507. `graphyard validation artifact-migrate s3|postgres [LIMIT]` moves up to 100 per call until `remaining` is zero, then switch every replica's backend.

## Rollback

A rollback completes only when the target [verifies](delivery.md#observe-and-verify). Register a service-scoped executor:

```json
{"kind":"registration","id":"production-rollback","expectedRevision":0,"principalId":"railway-rollback","role":"rollback",
 "environment":{"id":"production","revision":1},"adapterVersion":"custom-v1","proofs":[],"enabled":true,
 "services":["api","web"],"rollback":{"fencing":"provider","automatic":true}}
```

Fencing `provider` conditions the write on the expected running release; `serialized` freezes the environment until the operation settles; `none` is never automatic. The human operator, or a promoter's `delegate` lease, requests `POST /api/delivery/rollback` to a release previously verified here:

```json
{"environment":{"id":"production","revision":1},"target":{"id":"2026.09.17-4","revision":1},"expectedGeneration":7,
 "reason":"api-2 unhealthy after 2026.09.18-1","repairWorkId":"2f7d1a5e-3b8c-4d9e-8f10-1a2b3c4d5e6f"}
```

The executor claims with `POST /api/delivery/rollback-claim` (a retry returns the same operation):

```json
{"rollbackId":"6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01","registration":{"id":"production-rollback","revision":1},"epoch":3}
```

It performs the write and reports `applied`, `failed` or `unknown` with `POST /api/delivery/rollback-settle`:

```json
{"rollbackId":"6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01","operationId":"b8c9d0e1-2f3a-4b5c-8d6e-7f8091a2b3c4",
 "registration":{"id":"production-rollback","revision":1},"epoch":3,"outcome":"applied","providerOperationId":"railway:deployment:01J8Q5"}
```

An `unknown` outcome blocks every successor until an `admin` settles it with evidence through `POST /api/delivery/rollback-resolve`:

```json
{"rollbackId":"6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01","operationId":"b8c9d0e1-2f3a-4b5c-8d6e-7f8091a2b3c4","outcome":"applied",
 "reason":"Provider shows 01J8Q5 succeeded; executor host lost",
 "evidence":"https://railway.app/project/example/deployments/01J8Q5"}
```

With `"automaticRollback": true` in the environment's `delivery` policy, a degraded generation rolls back to the last verified release when a fenced, automatic executor covers every service, else `automaticRollbackRefusal` says why.
