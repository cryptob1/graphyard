<!-- page: Build integrations | 5 | rollback. -->
# Runner capacity and rollback

## Runner capacity and request diagnostics

`graphyard validation capacity` classes requests: `queued-starved`, `queued-waiting-for-slot` (add runner), `queued-resource-held`/`awaiting-settlement` (`validation settle`), `unacknowledged`/`retryable` (`validation retry`), `heartbeat-missing`, `collection-stalled`.

## Artifact backends, capacity and migration

Postgres (default) or S3 (`GRAPHYARD_ARTIFACT_BACKEND=s3`, `GRAPHYARD_ARTIFACT_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, `_PREFIX`); over `GRAPHYARD_ARTIFACT_CAPACITY_BYTES` (2GiB): 507. `graphyard validation artifact-migrate s3|postgres [LIMIT]` moves ≤100 a call.

## Rollback

Completes when target [verifies](delivery.md#observe-and-verify). Service-scoped executor:

```json
{"kind":"registration","id":"production-rollback","expectedRevision":0,"principalId":"railway-rollback","role":"rollback","environment":{"id":"production","revision":1},"adapterVersion":"custom-v1","proofs":[],"enabled":true,"services":["api","web"],"rollback":{"fencing":"provider","automatic":true}}
```

Fencing: `provider`, `serialized`, `none` (never automatic). Operators request verified release (`POST /api/delivery/rollback`):

```json
{"environment":{"id":"production","revision":1},"target":{"id":"2026.09.17-4","revision":1},"expectedGeneration":7,"reason":"api-2-unhealthy","repairWorkId":"2f7d1a5e-3b8c-4d9e-8f10-1a2b3c4d5e6f"}
```

Executors claim (`POST /api/delivery/rollback-claim`), report `applied`/`failed`/`unknown` (`POST /api/delivery/rollback-settle`); `unknown` blocks successors until `admin` resolves it (`POST /api/delivery/rollback-resolve`):

```json
{"rollbackId":"6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01","registration":{"id":"production-rollback","revision":1},"epoch":3}
```

```json
{"rollbackId":"6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01","operationId":"b8c9d0e1-2f3a-4b5c-8d6e-7f8091a2b3c4","registration":{"id":"production-rollback","revision":1},"epoch":3,"outcome":"applied","providerOperationId":"railway:deployment:01J8Q5"}
```

```json
{"rollbackId":"6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01","operationId":"b8c9d0e1-2f3a-4b5c-8d6e-7f8091a2b3c4","outcome":"applied","reason":"provider-shows-applied","evidence":"https://railway.app/project/example/deployments/01J8Q5"}
```

`"automaticRollback": true` rolls degraded generations back when fenced automatic executors cover every service.

## Main watch

Unexplained main commits are reported once (`master status` `mainWatch`). `GRAPHYARD_MAIN_WATCH_FREEZE=true` freezes promotion until an admin runs `graphyard master main-watch acknowledge SHA --reason TEXT --admin-token-stdin` or `POST /api/main-watch/acknowledge` (`Idempotency-Key`).
