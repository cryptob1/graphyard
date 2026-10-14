<!-- page: Build integrations | 4 | release API. -->
# Releases and delivery

Records environments' intended releases, observers verifying ([rollback](recovery.md#rollback)): `admin` sets policy, approves; `builder`s build; `admin`/`promoter` select; `observer`s lease (`POST /api/delivery/lease`).

## Release candidates

Main→candidate→uat→production; `.railway/railway.ts` deploys `release/uat`, `release/production` (moved only by `graphyard release`) to candidates' exact SHAs.

- `release cut [--trigger schedule|manual] [--max-prs N]` tags `rc/ID` with ≤N first-parent merges since the last candidate (`GRAPHYARD_RC_MAX_PRS`, 10; rest queue); `.github/workflows/release-candidate.yml` cuts on loop dispatch (cron fallback).
- `release uat ID` deploys `uat` (own Postgres, no `GITHUB_*` credentials), refused while an unjudged candidate <4h old serves.
- `release validate ID --url UAT_URL [--api] [--suite NAME=COMMAND]...` awaits `/healthz`; runs endpoint, API (`GRAPHYARD_UAT_TOKEN`), `browser`, suites ([below](#pre-merge-gate-and-release-candidate-validation); `GRAPHYARD_UAT_URL`, never `GRAPHYARD_TOKEN`); records `rc-uat/ID`.
- `release promote ID` (needs that or [accepted flakes](validation.md#release-verdicts)) deploys production as `rc-production/ID`; `release verify --url URL` confirms.
- Failed candidates file a [hold](validation.md#release-holds) per failed outcome, else a follow-up (`release follow-up ID` retries) as the [filing credential](#release-filing-credential).
- `release soak ID --sha SHA --result success|failure|cancelled [--run URL] [--report NAME]` (`release-candidate-soak.yml`) records advisory `rc-soak/ID` (promotion ignores it).

**The master loop drives promotion** (`promote=true`) once main differs from the last `rc-production/` and cut SHAs, nothing queued, and `run.promoteEveryMinutes` (`graphyard master config promoteEveryMinutes=N`; 10, `0` off) passed; failures raise `promotion:failed`. Under a `control-plane` merger the loop cuts (`run.candidates.everyMerges` 10, `idleMinutes` 15), validates, promotes and verifies (`GRAPHYARD_UAT_URL`, `GRAPHYARD_PRODUCTION_URL`; no workflow; managed repositories run [required cases](validation.md)); a failed required E2E case reverts the newest candidate item a matching verification map covers (`candidateReverts`; reopened); a main-watch freeze holds all. A `GRAPHYARD_UAT_STATIC` site's passing [merge-writer](delivery-redesign.md#merge-writer) trials run pre-build required/uat cases served uncredentialed: failing/secret-declaring required ones, or none runnable, fail it; timeouts/errors re-queue; `mergeLedger.trial.preview` records. `release status` lists candidates; `release GY-N EPOCH` leases. Needs `vars.UAT_URL`/`PRODUCTION_URL`, `GRAPHYARD_UAT_TOKEN`/`RELEASE_TOKEN`/`E2E_RECORD_TOKEN`.

### Release filing credential

UAT's `GRAPHYARD_TOKEN` (`GRAPHYARD_RELEASE_TOKEN`) files holds and follow-ups as operator agent `graphyard-release-follow-up` (only `intent:create`, work items `*`). The loop's hourly `master setup --apply` keeps it with the install's admin token (issuing, narrowing, rotating; storing the uat secret via `gh`; failures retry from ten minutes, backing off; `setup.attention`); without one, `master status` names the administrator's one-token step (`graphyard operator-agent setup FILE --token-stdin`, FILE `{"id":"graphyard-release-follow-up","displayName":"Release follow-up","capabilities":["intent:create"],"scope":{"repositories":["OWNER/REPO"],"workItems":["*"]},"reason":"..."}`, then the uat secret). `doctor`: `FAIL release-filing` when refused/broader. `e2e record` uses `GRAPHYARD_E2E_RECORD_TOKEN`, likewise `graphyard-e2e-recorder` with only `e2e:record`, never admin.

### Pre-merge gate and release-candidate validation

Required: `typecheck`, `test` (`ci.yml`) under ten minutes; per candidate `releaseCandidateTests`, container, chart, soak/timing (advisory); UAT's `zero-touch` suite (`up --agent --goal`, fake GitHub) must merge a first item; any human step but App approval blocks.

`deploy/helm/exercise.sh` forwards a kubectl-chosen free port, re-forwarding a lost or foreign one within `FORWARD_BUDGET` seconds; waits for the rollout's new Ready pod, retrying transient API failures (empty reply, reset, stall, non-2xx, bodiless 2xx), else ending `api METHOD /api/PATH failed after 15 attempts: status STATUS, body: BODY`.

### One delivery path

Exact-head gates merge; [candidates](#release-candidates) deploy. [The redesign](delivery-redesign.md) has only Graphyard write main.

### Main guard

Every 30 s the main guard reruns, then reverts, merges failing required checks their parents passed (`graphyard-revert/`). The [revert approver App](deployment.md#variables) approves only a green exact inverse (`doctor` names missing); a third refusal abandons (`approval-refused`).

## Managed repositories

`init --scan` splits checks (`delivery.mergeGate`, per-candidate); `--apply` renders `graphyard-release-candidate.yml` (cut on `candidateSchedule`, `--candidate-cron CRON|off`) and `graphyard-promotion.yml`. `deploy.adapter`: `railway` (`deploy.project`) or `command` (`deploy.uat`/`deploy.production` with `GRAPHYARD_CANDIDATE_SHA`; unset renders none); UAT's `/healthz` reports `commit` or `revision`. `--delivery per-pr` keeps per-PR checks; `install --plan` lists resources (`human`: `--apply --create-environments`).

```json
{"kind":"environment","id":"production","expectedRevision":0,"repository":"owner/repository","url":"https://app.example.test","instance":"production-cluster","immutable":true,"services":["api","web"],"resources":["production-smoke-account"],"delivery":{"freshnessSeconds":300,"approvalRequired":true}}
```

```json
{"kind":"registration","id":"production-observer","expectedRevision":0,"principalId":"railway-observer","role":"observer","environment":{"id":"production","revision":1},"adapterVersion":"custom-v1","proofs":[],"enabled":true,"services":["api","web"]}
```

`POST /api/delivery/build` attests manifest:

```json
{"registration":{"id":"production-builder","revision":1},"sourceSha":"0123456789abcdef0123456789abcdef01234567","buildInputsDigest":"sha256:5b8e0d3a7f21c94e6082d5b1a3f7c0e94d26b8a15f309c7e4b1d02a6f8395c7e","artifacts":[{"service":"api","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"},{"service":"web","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}],"provenanceUrl":"https://ci.example.test/builds/812"}
```

`POST /api/delivery/release` names build, members (reverted: `included: false`):

```json
{"id":"2026.09.18-1","expectedRevision":0,"environment":{"id":"production","revision":1},"sourceSha":"0123456789abcdef0123456789abcdef01234567","buildId":"5d7c6b7e-8c35-4b3f-9c4a-0a1f2e3d4c5b","manifest":[{"service":"api","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"},{"service":"web","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}],"members":[{"workId":"2f7d1a5e-3b8c-4d9e-8f10-1a2b3c4d5e6f","mergeSha":"89abcdef0123456789abcdef0123456789abcdef","included":true},{"workId":"3a8e2b6f-4c9d-4eaf-9021-2b3c4d5e6f70","mergeSha":"9abcdef0123456789abcdef0123456789abcdef0","included":false,"note":"Reverted"}]}
```

`POST /api/delivery/approve` `{"release":{...},"environment":{...}}`, then select (one per generation):

```json
{"environment":{"id":"production","revision":1},"release":{"id":"2026.09.18-1","revision":1},"expectedGeneration":3,"approvalId":"0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5"}
```

## Observe and verify

Observers `POST /api/delivery/observe`:

```json
{"registration":{"id":"production-observer","revision":1},"epoch":4,"environment":{"id":"production","revision":1},"expectedGeneration":4,"snapshotId":"railway:snapshot:01J8Q4Z0Y3","observedAt":"2026-09-18T20:15:07Z","validFrom":"2026-09-18T20:12:31Z","validTo":"2026-09-18T20:15:07Z","services":[{"service":"api","complete":true,"deployment":{"id":"dep-a1","status":"success","deployedAt":"2026-09-18T20:12:31Z"},"instances":[{"instance":"api-1","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","measurement":"host-attestation","healthy":true}]},{"service":"web","complete":true,"deployment":{"id":"dep-w7","status":"success","deployedAt":"2026-09-18T20:12:40Z"},"instances":[{"instance":"web-1","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222","measurement":"host-attestation","healthy":true}]}]}
```

Only complete listings verify (`POST /api/delivery/notify` hints); `graphyard delivery sweep` verifies generations per `freshnessSeconds`; `graphyard delivery` shows state.

`master status` `delivery`: `readyToMerged`, `mergedToProduction`, `stages` p50/p90; 7-day p90 over `deliverySpeed` (2h; merged→production 45min) raises attention.

`POST /api/validation/result` binds manifest, signature, measurements; mismatches record `attribution-undermined`, voiding passes (`GET /api/analytics/attribution`).

A loop-owned post-deploy observation item is never dispatched: deployment verification reads it; a pass closes it `delivered-observation`, a fail escalates.
