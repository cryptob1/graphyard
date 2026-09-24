<!-- page: Agent protocol | 15 | attribution reads and ledger. -->
# Attribution reads and the attribution ledger

Concepts: [attribution guide](../attribution.md). Every endpoint is a read; only validation and observation ingest write the ledger.

| Method and path | Result |
| --- | --- |
| `GET /api/attribution/manifest/RELEASE_ID/REVISION` | Release manifest with `hash`, `digestHash`, `services`, `source` |
| `GET /api/attribution/work/UUID` | An item's ledger rows (at most 200) |
| `GET /api/analytics/attribution?window=30` | Metrics, coverage, exclusions, definitions |
| `GET /api/analytics/attribution/drilldown?window=30&metric=ID[&key=K]` | Up to 200 rows |

Identifiers beyond the work key need `admin`, `coordinator` or `producer`. `attribution_records` kinds: `target-checked`, `target-mismatch`, `paid-run-avoided`, `superseded`, `rescheduled`, `reanchor-blocked`, `signature-regenerated`, `target-changed`, `attribution-undermined`, `unsupported-claim-refused`, `evidence-bound`.

## Refusals

- `POST /api/validation/request` returns 409 when observers already report another manifest.
- `POST /api/validation/result` returns 400 for any `sha`, `sourceSha`, `baseSha`, `commit` or `commitSha` field at the top level or under `target`.
- A pass on an `unknown` measurement, or contradicted by an observer, fails as evidence.
