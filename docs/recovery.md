<!-- page: Build integrations | 7 | runner capacity, artifact retention and migration, and fenced rollback as an observed workflow. -->
# Runner capacity, artifact operations and delivery recovery

Graphyard now reports what each runner is doing and why each request is waiting, bounds how much work a runner queue accepts, stores private artifacts in Postgres or an S3-compatible backend with verified retention and migration, and runs rollback as an authorized, fenced, observed workflow rather than a shell command.

**This is D4 of the [delivery roadmap](turnkey-delivery-roadmap.md): operating the runner path and recovering delivery failures.** Nothing here relaxes D2's execution-resource guarantees: a reservation still opens only on independently verified settlement, a lost heartbeat still releases nothing, and every diagnosis below says so. A rollback selects a previously verified release and records one provider operation with a durable identity; it is complete only when the target is observed running and the environment [verifies](delivery.md#verification). It never claims a migration or an external side effect was undone.

## Runner capacity and request diagnostics

`GET /api/validation/capacity` (`graphyard validation capacity`) reports, for every runner registration, its last dispatch poll, whether it is executing a request, how many requests are queued against it and for how long, and its queue limit; every reserved protected resource with the request and attempt holding it and whether that holder's lease is live; retained-artifact usage; and one diagnosed condition per live request with the step that resolves it. The dashboard's **Validation** view shows the same beside each request.

Each condition is distinct because its next step is:

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

Every poll is recorded in `validation_runner_polls`, and each attempt records `acknowledgedAt` and `lastHeartbeatAt`, so a starved queue is told apart from a busy one and a stalled runner from a slow one. `dwellSeconds` is how long a queued request has waited.

**Backpressure.** A runner registration may set `queueLimit` (1–100, default 20). Creating a request for a runner whose queue already holds that many refuses with HTTP 429 and the count, so a request that could not be reached within its one-hour deadline is refused up front instead of expiring later. Cancel stale requests, wait for dwell to drain, or register another runner.

## Artifact backends, capacity and migration

Private artifacts keep their authorization, digest, retention and request/attempt binding on the `validation_artifacts` row whatever holds the bytes. Two backends are supported:

- **postgres** (default): bytes in the row, as in D2.
- **s3**: an S3-compatible object store reached with path-style SigV4 requests. Configure it on the server with `GRAPHYARD_ARTIFACT_BACKEND=s3`, `GRAPHYARD_ARTIFACT_S3_ENDPOINT`, `GRAPHYARD_ARTIFACT_S3_BUCKET`, `GRAPHYARD_ARTIFACT_S3_REGION` (default `us-east-1`), `GRAPHYARD_ARTIFACT_S3_ACCESS_KEY_ID`, `GRAPHYARD_ARTIFACT_S3_SECRET_ACCESS_KEY` and optionally `GRAPHYARD_ARTIFACT_S3_PREFIX`. Only the Graphyard server holds this credential; collectors keep their scoped Graphyard credential and upload through the same `POST /api/validation/artifacts` call, and readers still go through `GET /api/validation/artifacts/REQUEST/ARTIFACT` with the same authorization rules. Bucket policies should grant the credential nothing beyond the prefix.

Provider I/O never happens inside a coordination transaction. An upload to an external backend is authorized and reserved under the lock (`pending`), the bytes move with the lock released, and the row is published (`stored`) only after the same authority is checked again. The store's own acknowledgement is verified: a single-part `PUT` must return the MD5 ETag of the bytes sent. Every read verifies the SHA-256 recorded at upload against the bytes the backend returned, so a substituted object refuses with an integrity error.

**Visible states.** An artifact row is `pending`, `stored`, `upload-failed` or `expired`, and a result reports each required name accordingly: `upload-failed` and `expired` are refusals with their own reason and appear on the evidence as artifact availability, beside `missing`. A failed upload refuses the collector with HTTP 503 and is resumed by retrying with the same idempotency key and the same bytes; a different payload under that key refuses. If collection authority ends while bytes are in flight, the row is marked `upload-failed` and the object is removed by the sweep.

**Capacity.** `GRAPHYARD_ARTIFACT_CAPACITY_BYTES` (default 2 GiB, minimum 8 MiB) bounds retained bytes across `stored` and `pending` rows. An upload that would exceed it refuses with HTTP 507 naming the usage; nothing is stored. The capacity report shows used and available bytes, retained, pending, failed and expired counts, artifacts expiring within 24 hours, and objects awaiting verified deletion.

**Retention.** Expiry is recorded first, under the lock, so reads refuse from that instant. For an external backend the sweep then deletes the object with the lock released, confirms with a `HEAD` that it is gone, and only then records `deleted_at` and a `validation.artifact-deleted` event; a deletion the store refused is retried on the next sweep, never assumed. Failed uploads and objects left behind by a migration into Postgres are removed the same way.

**Migration.** `graphyard validation artifact-migrate s3|postgres [LIMIT]` (`POST /api/validation/artifacts/migrate`, the human operator's `admin` credential only) moves up to `LIMIT` (default 20, maximum 100) retained, unexpired artifacts per call between the row and the configured backend. Each artifact's bytes are copied, read back and compared with the recorded digest before the row names the new backend; a copy that fails its digest is discarded and the source stays, listed under `refused` with the reason. Retention (`expires_at`), the request/attempt binding, the evidence reference and every access rule are row state and do not move. The old copy is removed after the move — from the object store with verified deletion, from the row by clearing its bytes. Run it until `remaining` is zero, then switch `GRAPHYARD_ARTIFACT_BACKEND` on every replica; a server that is not configured for a row's backend refuses to read it rather than guessing.

## Rollback

A rollback is an integration workflow with four records: the failed candidate (the expected release when the incident occurred, with its incident IDs), the approved target, the provider operation, and the observations that verify it, plus a link to repair work. Register the executor as a service-scoped `rollback` registration:

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

`fencing` declares what the adapter's provider write enforces:

| Fencing | Meaning | May be automatic | Effect on successors |
| --- | --- | --- | --- |
| `provider` | The write is conditioned provider-side on the deployment that should still be running (`precondition.expectedRunning`) and this operation's `generation` and `token` | Yes | A newer selection may supersede the target; the delayed write fails at the provider and its late report is recorded as non-authoritative |
| `serialized` | The adapter observes its own operation settle but cannot fence the write | Yes | No selection, rollback or other mutation of the environment is authorized until the operation is settled or resolved; lease expiry alone releases nothing |
| `none` | Neither | **No** — definition refuses `automatic: true`, and a claim of an automatic rollback refuses | Same serialized barrier as above |

An `unknown` outcome blocks successors whatever the fencing, until the human operator resolves it with evidence.

The executor holds a lease like an observer: `POST /api/delivery/lease` with its registration, renewed with the epoch, re-acquired after a partition.

### Request

The human operator (`admin`), or a promoter through its `delegate` lease, requests a rollback with `POST /api/delivery/rollback`:

```json
{
  "environment": {"id": "production", "revision": 1},
  "target": {"id": "2026.09.17-4", "revision": 1},
  "expectedGeneration": 7,
  "reason": "Generation 7 degraded: api-2 unhealthy after 2026.09.18-1",
  "repairWorkId": "2f7d1a5e-3b8c-4d9e-8f10-1a2b3c4d5e6f"
}
```

The target must be a release revision that verified in this environment before — the tested, reversible action — defined for the current policy revision and, where the policy requires approval, covered by an approval that still binds it. The request is a selection: it advances the generation to the target exactly like `select`, keeps the failed generation's verification in history, and opens the rollback in state `requested`. Requests, claims and selections refuse while a serialized or unknown operation is unresolved.

### Claim and settle

The executor claims the operation with `POST /api/delivery/rollback-claim` `{"rollbackId", "registration", "epoch"}`. The response carries the operation identity, the target manifest and source, and the precondition the provider write must be conditioned on:

```json
{
  "rollbackId": "6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01",
  "registration": {"id": "production-rollback", "revision": 1},
  "epoch": 3
}
```

One executor holds the operation. A retry of the claim — after a restart, with a fresh idempotency key — returns the same operation, so the provider sees one operation however many times the claim is sent; a different executor is refused while it is in flight. The executor performs the provider mutation outside Graphyard, conditioned on `precondition.expectedRunning` (the manifest hash that should still be running) and, where the provider supports it, `precondition.token`, and reports with `POST /api/delivery/rollback-settle`:

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

A report is accepted only for the claimed operation, from the executor that claimed it, under a lease that is current now. An executor whose lease lapsed re-acquires it and reports against the same operation with the new epoch; a report for a superseded target, or after the rollback already completed, is retained with `authoritative: false` and its reasons. `applied` moves the rollback to `applied`, `failed` releases the barrier, `unknown` blocks everything until resolved.

`POST /api/delivery/rollback-resolve` (human operator, `admin`) cancels an unclaimed rollback, or declares an in-flight or unknown operation `applied`, `failed` or `cancelled` with a `reason` and settlement `evidence` — a URL to the independent provider record that proves the outcome:

```json
{
  "rollbackId": "6c2f0e2e-5c3a-4c65-9d2b-1f1c8a3f9e01",
  "operationId": "b8c9d0e1-2f3a-4b5c-8d6e-7f8091a2b3c4",
  "outcome": "applied",
  "reason": "Provider console shows deployment 01J8Q5 succeeded; executor host was lost",
  "evidence": "https://railway.app/project/example/deployments/01J8Q5"
}
```

### Completion

`applied` is the provider's word. The rollback is `verified` — complete — only when the sweep verifies the generation it selected: every service of the target manifest observed running with measured identity, complete instance listings, healthy instances and successful deployments, over a common interval within the freshness bound, exactly as in [delivery verification](delivery.md#verification). The record then carries `verifiedAt` and the interval. A rollback whose generation is superseded before that is `superseded`; its operation record stays.

### Automatic rollback

Set `"automaticRollback": true` in the environment's `delivery` policy. When a verified generation degrades, the sweep selects the most recent release that verified in this environment before, requires its approval to still bind where the policy asks for one, checks that an enabled `rollback` registration with `provider` or `serialized` fencing and `automatic: true` covers the whole environment, and opens the rollback as `graphyard` with the incident IDs. Anything missing is a refusal shown on the environment (`automaticRollbackRefusal`) and recorded once as `delivery.rollback-refused`, not a guess. One rollback per generation; an unfenced executor cannot claim it.

### Inspect

```bash
graphyard delivery                                  # environments, releases and rollbacks
graphyard delivery rollback|rollback-claim|rollback-settle|rollback-resolve FILE.json
```

`GET /api/delivery` lists rollbacks with their history; the **Releases** view shows each environment's rollbacks with their state, executor, fencing and outcome.

## Acceptance checks

`npm test` runs `tests/recovery.test.ts` against a disposable Postgres database and an in-process S3-compatible stub. Its tests are named after the D4 acceptance checks in the [roadmap](turnkey-delivery-roadmap.md#d4-operate-runners-and-recover-delivery-failures): D4-1 distinct next steps for starvation, unacknowledged dispatch and missing heartbeat (and backpressure), D4-2 partition recovery never grants two attempts one protected resource, D4-3 upload failure and expired retention as visible proof states, verified deletion and digest-checked migration in both directions, D4-4 a rollback is complete only when the target is observed and verified, D4-5 restart preserves the operation identity without duplicate side effects, D4-6 delayed provider calls, lease expiry, target supersession and ambiguous outcomes, the unfenced-adapter refusal and the serialized barrier. The JSON samples above are parsed by the same schemas the API uses.
