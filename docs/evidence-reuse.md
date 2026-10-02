<!-- page: Build integrations | 6 | E2E passes. -->
# Evidence reuse and replay

With an operator `reuse` policy (`graphyard validation define`), the newest compatible E2E pass stands for new heads:

```json
{"kind":"reuse","id":"preview-reuse","expectedRevision":0,"environment":{"id":"preview","revision":1},"enabled":true,"freshnessSeconds":86400,"artifacts":"identical","relevant":{"dependencies":["package.json","**/package.json"],"lockfiles":["package-lock.json","**/yarn.lock"],"buildInputs":["Dockerfile","tsconfig.json",".github/workflows/**"],"configuration":["config/**",".env.example","compose.yaml"],"migrations":["migrations/**"],"services":{"api":["src/**"]}},"ignorable":["docs/**","*.md"]}
```

`relevant.services` lists every service. Changed relevant paths forbid reuse; paths in neither list are **unknown, and unknown refuses**. `identical`: same artifact manifest; `scoped`: unchanged build inputs, only ignorable changes.

Per attested new head: `graphyard validation reuse decision.json`:

```json
{"workId":"9a7d6b2f-4e1c-4c5a-9f3e-2b8d1c0a7e51","expectedWorkRevision":12,"proof":"e2e:confirmed-booking-sends-sms","policy":{"id":"preview-reuse","revision":1},"buildAttestationId":"5c2e9a1b-7d3f-4a8e-b6c4-0f1d2e3a4b5c"}
```

Refused, with reasons, unless the newest attempt is a fresh settled pass on the same pinned revisions and base. A grant's `reuse` block expires at `freshnessSeconds`.

## Replay

`graphyard validation replay REQUEST ATTEMPT` re-runs the pinned report adapter over retained artifacts; target, bundle, deployment health stay `not-covered`. A replay authorizes nothing (`liveVerification`: `not-established`). `graphyard validation analytics`: outcomes, cost per proof and runner.
