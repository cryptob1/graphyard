<!-- page: Agent protocol | 15 | reading release manifests, a work item's attribution history, and the attribution analytics; the ledger has no write endpoint. -->
# Attribution reads and the attribution ledger

The [attribution guide](../attribution.md) explains manifests, exact-target validation, re-anchoring and the metrics. This page lists what the API exposes. Every attribution endpoint is a read: the ledger is written only by validation and observation ingest inside their own transactions, so no credential can move a request, attempt, result or evidence record through these routes, and a `POST` to any of them is not found.

## Endpoints

| Method and path | Who | Result |
| --- | --- | --- |
| `GET /api/attribution/manifest/RELEASE_ID/REVISION` | Any authenticated credential | The release manifest: `hash`, `digestHash`, `environment`, `configurationRevision`, `services: [{service, digest, sourceSha}]`, `source` (`kind: release` with build, source and members) |
| `GET /api/attribution/work/UUID` | Any credential that may read the item; a worker only its own assignment | `{workId, workKey, authorized, records}` — the item's ledger, newest last, at most 200 rows |
| `GET /api/analytics/attribution?window=30` | Any authenticated non-operator-agent credential | The report: `metrics`, `coverage`, `exclusions`, `unavailable`, `blockedNow`, `definitions`, `window`, `trust` |
| `GET /api/analytics/attribution/drilldown?window=30&metric=ID[&key=K]` | Same | Up to 200 rows with `workKey, kind, recordedAt, environment, release, request, attempt, evidence, artifact, detail` |

Query parameters: `window` (7, 30 or 90; anything else is 400), `asOf` (an ISO instant no later than the server clock), `metric` and `key`. `metric` is one of `targetMismatches`, `paidRunsAvoided`, `superseded`, `rescheduled`, `reanchors`, `blocked`, `convergenceWait`, `multiServiceConvergence`, `candidateToReleaseDrift`, `signatureRegenerations`, `immutablePreviewShare`, `unsupportedClaims`, `cost`; `key` narrows a drill-down to one record kind, target state, signature component or target kind.

Identifiers beyond the work key — request, attempt, candidate, evidence, build and observation identities — require an `admin`, `coordinator` or `producer` credential. Other readers receive counts, kinds and reasons, with `requires audit role` where an identifier exists. `authorized` on each response says which view was served.

## Ledger records

`attribution_records` is append-only and database-trigger protected. Each row carries `workId`, `workKey`, `proof`, `environmentId`, the `candidateId`, `requestId` and `attemptId` it concerns, a `kind`, `recordedAt`, a `dedupe` key that makes each cause write once, and `details`.

| Kind | Written when |
| --- | --- |
| `target-checked` | The observed target identity was compared with the candidate manifest at `details.phase`: `request`, `dispatch`, `dispatch-withheld`, `observed`, `execution` or `result` |
| `target-mismatch` | A check measured another manifest for at least one service (`details.mismatchedServices`, `partialConvergence`) |
| `paid-run-avoided` | A request or grant was refused on a known mismatch before any acknowledged attempt |
| `superseded` | A request was preserved and superseded because its target moved or its pass was undermined |
| `rescheduled` | A fresh candidate and request were minted; `details` names the superseded request, the trusted build or release and `via` |
| `reanchor-blocked` | No fresh request could be minted; `details.reasons` says why and `contains` is `false` or `null` |
| `signature-regenerated` | A later candidate's compatibility signature differs; `details.changed` lists the components |
| `target-changed` | An observation measured another manifest while an attempt was running, collecting, or across its window at result time |
| `attribution-undermined` | A delayed observation contradicted the window of an accepted pass; `details.evidenceId` names the preserved evidence |
| `unsupported-claim-refused` | A client-supplied SHA (`details.claim: client-supplied-sha`), a collector's unsupported match (`collector-target`) or a rejected passing report (`result`) |
| `evidence-bound` | A result became evidence; `details` repeats the evidence attribution |

`attribution_reanchors` holds one row per superseded request — the idempotency fence — naming the fresh request and candidate and the trigger (kind, principal, observation, registration and lease epoch).

## Record shapes

A validation request carries `attribution` from creation and it is never rewritten:

```json
{
  "workKey": "GY-39", "environmentId": "preview", "environmentRevision": 1, "targetKind": "immutable-preview",
  "manifestHash": "…", "digestHash": "…", "signature": "…", "buildId": "5d7c…",
  "target": {"state": "matched", "observationIds": ["…"], "observedAt": "2026-09-18T20:15:07.000Z", "digestHash": "…"},
  "reanchoredFrom": {"requestId": "…", "attemptId": null, "observationIds": ["…"], "trigger": "observation"}
}
```

Each dispatched attempt records `target` — the identity pinned at the grant. A candidate carries `manifestHash`, `digestHash`, `signature`, `signatureComponents` and, when minted by re-anchoring, `reanchoredFrom`. Trusted evidence produced by a validation result carries:

```json
{"attribution": {"manifestHash": "…", "digestHash": "…", "signature": "…", "environmentId": "preview", "environmentRevision": 1,
  "targetKind": "immutable-preview", "targetState": "matched", "targetObservationIds": ["…"]}}
```

A blocked re-anchor stands on the work item until a later observation resolves it:

```json
{"validation": {"e2e:checkout": {"candidateId": "…", "reanchor": {"state": "blocked", "reasons": ["…"], "supersededRequestId": "…", "environmentId": "preview", "at": "…"}}}}
```

## Refusals

- `POST /api/validation/request` returns 409 when the environment's observers already report another manifest; the mismatch and the avoided run are ledgered although no request exists.
- `POST /api/validation/result` returns 400 when the body carries `sha`, `sourceSha`, `baseSha`, `commit` or `commitSha` anywhere at the top level or under `target`, before the report is parsed; the refusal is ledgered against the request it names.
- A result with `target.attribution: matched` and `target.measurement: unknown`, or one whose window an observer contradicted, is accepted as a report and fails as evidence; the unsupported claim is ledgered.
- An environment defined with `immutable: false` is shared staging: its requests are granted only against a measured match and pass only with whole-window observed identity.
