<!-- page: Build integrations | 6 | E2E passes. -->
# Evidence reuse and replay

Reuse lets the newest compatible E2E pass stand for a new head.

## Reuse policy

Reuse is off until the operator defines a `reuse` policy (`graphyard validation define`):

```json
{"kind":"reuse","id":"preview-reuse","expectedRevision":0,"environment":{"id":"preview","revision":1},"enabled":true,
 "freshnessSeconds":86400,"artifacts":"identical",
 "relevant":{"dependencies":["package.json","**/package.json"],"lockfiles":["package-lock.json","**/yarn.lock"],
  "buildInputs":["Dockerfile","tsconfig.json",".github/workflows/**"],"configuration":["config/**",".env.example","compose.yaml"],
  "migrations":["migrations/**"],"services":{"api":["src/**"]}},
 "ignorable":["docs/**","*.md"]}
```

`relevant.services` must name every environment service. A changed relevant path forbids reuse, and a path matching neither list is **unknown, and unknown refuses**. `identical` requires the same artifact manifest; `scoped` allows another when build inputs are unchanged and every change ignorable.

## Reuse decisions

After a builder attests the new head, `graphyard validation reuse decision.json`:

```json
{"workId":"9a7d6b2f-4e1c-4c5a-9f3e-2b8d1c0a7e51","expectedWorkRevision":12,"proof":"e2e:confirmed-booking-sends-sms",
 "policy":{"id":"preview-reuse","revision":1},"buildAttestationId":"5c2e9a1b-7d3f-4a8e-b6c4-0f1d2e3a4b5c"}
```

It is refused, listing every reason, unless the newest attempt is a fresh settled pass with the same pinned revisions and base and no relevant or unknown change; a grant records evidence whose `reuse` block expires at the freshness bound.

## Replay and analytics

`graphyard validation replay REQUEST ATTEMPT` re-verifies retained artifacts, re-running the pinned report adapter; target, bundle and deployment health are always `not-covered`. A replay authorizes nothing (`liveVerification`: `not-established`). `graphyard validation analytics` reports outcomes and cost per proof and runner.
