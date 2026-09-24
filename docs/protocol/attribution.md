<!-- page: Agent protocol | 15 | reading release manifests, a work item's attribution history, and the attribution analytics; the ledger has no write endpoint. -->
# Attribution reads and the attribution ledger

The [attribution guide](../attribution.md) explains the concepts. Every endpoint here is a read; the ledger is written only by validation and observation ingest.

| Method and path | Result |
| --- | --- |
| `GET /api/attribution/manifest/RELEASE_ID/REVISION` | The release manifest: `hash`, `digestHash`, `environment`, `services: [{service, digest, sourceSha}]`, `source` |
| `GET /api/attribution/work/UUID` | `{workId, workKey, authorized, records}`, at most 200 rows (a worker reads only its own item) |
| `GET /api/analytics/attribution?window=30` | `metrics`, `coverage`, `exclusions`, `unavailable`, `blockedNow`, `definitions` (not for operator agents) |
| `GET /api/analytics/attribution/drilldown?window=30&metric=ID[&key=K]` | Up to 200 underlying rows |

`window` is 7, 30 or 90; `asOf` is an ISO instant. Request, attempt, evidence and build identifiers need `admin`, `coordinator` or `producer`; others see counts and `requires audit role`.

## Ledger records

`attribution_records` is append-only (trigger-protected), one row per cause (`dedupe`). Kinds: `target-checked`, `target-mismatch`, `paid-run-avoided`, `superseded`, `rescheduled`, `reanchor-blocked`, `signature-regenerated`, `target-changed`, `attribution-undermined`, `unsupported-claim-refused`, `evidence-bound`. `attribution_reanchors` holds one row per superseded request.

## Refusals

- `POST /api/validation/request` returns 409 when observers already report another manifest.
- `POST /api/validation/result` returns 400 when the body carries `sha`, `sourceSha`, `baseSha`, `commit` or `commitSha` at the top level or under `target`.
- A pass with `target.measurement: unknown`, or whose window an observer contradicted, fails as evidence.
- A shared (`immutable: false`) environment grants only against a measured match.
