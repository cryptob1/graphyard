<!-- page: Build integrations | 6 | E2E passes. -->
# Evidence reuse and replay

Under an operator `reuse` policy (`graphyard validation define`) newest compatible E2E pass covers new heads:

```json
{"kind":"reuse","id":"preview-reuse","expectedRevision":0,"environment":{"id":"preview","revision":1},"enabled":true,"freshnessSeconds":86400,"artifacts":"identical","relevant":{"dependencies":["package.json","**/package.json"],"lockfiles":["package-lock.json"],"buildInputs":["Dockerfile","tsconfig.json"],"configuration":["config/**"],"migrations":["migrations/**"],"services":{"api":["src/**"]}},"ignorable":["docs/**"]}
```

`relevant.services` covers every service; changed relevant or **unknown** paths refuse; `artifacts`: `identical`/`scoped`.

Per attested head, `graphyard validation reuse decision.json`; only fresh settled passes on identical pins and base qualify:

```json
{"workId":"9a7d6b2f-4e1c-4c5a-9f3e-2b8d1c0a7e51","expectedWorkRevision":12,"proof":"e2e:confirmed-booking-sends-sms","policy":{"id":"preview-reuse","revision":1},"buildAttestationId":"5c2e9a1b-7d3f-4a8e-b6c4-0f1d2e3a4b5c"}
```

Collector results and `graphyard validation replay REQUEST ATTEMPT` (authorizes nothing; `liveVerification`: `not-established`) judge retained artifacts keeping each attempt's time, evaluator, outcome, cause: `evaluator-error` retries on the same evidence ≤2 times, `fail` never; a pass wins; spent retries are a fault (`validation.PROOF.fault`), not a failed proof; replay cost sums all reads. `graphyard validation analytics`: outcomes, faults, cost.
