<!-- page: Build integrations | 8 | replay of retained artifacts with explicit coverage, scoped reuse of the newest compatible attempt, and execution cost analytics. -->
# Evidence replay, scoped reuse and execution analytics

Replay re-runs the verifier over retained artifacts; reuse lets the newest compatible pass stand for a new head under an operator policy; analytics report attempt cost and time. None relaxes what a live attempt proves. "Newest attempt" means the highest dispatch `sequence` (`validation_attempts.seq`), never result arrival order.

## Reuse policy

Reuse is off until the operator defines a `reuse` policy with `graphyard validation define`:

```json
{
  "kind": "reuse",
  "id": "preview-reuse",
  "expectedRevision": 0,
  "environment": {"id": "preview", "revision": 1},
  "enabled": true,
  "freshnessSeconds": 86400,
  "artifacts": "identical",
  "relevant": {
    "dependencies": ["package.json", "**/package.json"],
    "lockfiles": ["package-lock.json", "**/yarn.lock"],
    "buildInputs": ["Dockerfile", "tsconfig.json", ".github/workflows/**"],
    "configuration": ["config/**", ".env.example", "compose.yaml"],
    "migrations": ["migrations/**"],
    "services": {"api": ["src/**"]}
  },
  "ignorable": ["docs/**", "*.md"]
}
```

Every environment service must be named under `relevant.services`. A changed relevant path forbids reuse; a path matching neither list is **unknown, and unknown refuses**. `**` spans directories, `*` one segment. `artifacts: identical` requires the same artifact manifest; `scoped` allows a different one when build inputs are unchanged and every change is ignorable. `freshnessSeconds` is 60 seconds to 30 days. Any change of requirement, scenario, proof policy, bundle or environment revision refuses.

## Reuse decisions

After a builder attests the new head's build:

```sh
graphyard validation reuse decision.json
graphyard validation decisions
```

```json
{
  "workId": "9a7d6b2f-4e1c-4c5a-9f3e-2b8d1c0a7e51",
  "expectedWorkRevision": 12,
  "proof": "e2e:confirmed-booking-sends-sms",
  "policy": {"id": "preview-reuse", "revision": 1},
  "buildAttestationId": "5c2e9a1b-7d3f-4a8e-b6c4-0f1d2e3a4b5c"
}
```

`POST /api/validation/reuse` (operator) records a decision either way. It is **refused**, listing every reason, when a request for the proof is live or the newest attempt is not a settled accepted pass; the pass is stale, its artifacts expired or its collector has since held the item; any pinned revision or the base SHA differs; build inputs (or, under `identical`, the manifest) differ; or a changed path is relevant or unknown. File changes come from Graphyard's own GitHub observations.

A **granted** decision selects a derived candidate and records trusted evidence for the new head with a `reuse` block and an `expiresAt` at the freshness bound. Any new live request supersedes it.

## Replay

```sh
graphyard validation replay REQUEST_UUID ATTEMPT_UUID
graphyard validation replays
```

`POST /api/validation/replay` (operator or audit reader) verifies each retained artifact's digest and re-runs the pinned [report adapter](report-adapters.md). Coverage: `inventory` and `behavior` are `covered` only when the files were retained and parsed; `artifactIntegrity` when every digest matched; `bundleIdentity`, `targetAttribution`, `settlement` and `deploymentHealth` are always `not-covered`. `outcome` is `consistent`, `inconsistent`, `uncompared` or `unmeasured`. A replay `authorizes` nothing: `liveVerification` is always `not-established`. Expired artifacts are not read, and records are redacted of credential-shaped strings.

## Execution analytics

`graphyard validation analytics` (`GET /api/validation/analytics`) groups attempts by proof, environment and runner, reporting outcomes, observed timings (queue, ACK, execution, collection), runner-reported duration and CPU, and cost as **observed**, **estimated** or **unavailable** — never zero when nobody metered it. Collectors may attach `measurements: {durationMs, cpuSeconds, cost: {amount, currency, basis, source}}` to a result. The reuse and replay ledgers are summarised too. Groups are never ranked.
