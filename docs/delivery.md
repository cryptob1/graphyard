<!-- page: Build integrations | 4 | release API. -->
# Releases and delivery

Releases ([rollback](recovery.md#rollback)): `admin` sets policy; `builder`s build; `admin`/`promoter` select; `observer`s lease (`POST /api/delivery/lease`).

## Release candidates

Main→candidate→uat→production; `.railway/railway.ts` deploys `release/uat`/`release/production` (`graphyard release`).

- `release cut [--trigger schedule|manual] [--max-prs N]` tags `rc/ID` with ≤N merges (`GRAPHYARD_RC_MAX_PRS`=10).
- `POST /api/candidates` (`admin`/`coordinator`/`intent:create`; Idempotency-Key; `trigger`/`waitMinutes`/`since`/`sinceSha`): ≤5 oldest uncut → `C-N` (`members`/`sourceSha`/`identity`); `schedule` waits five/`waitMinutes`; floor: newest `rc/`. Tags `rc/ID` at `sourceSha`; one validation (identical replays, else 409). `everyMerges`>5→5. `POST /api/candidates/ID/promotion` selects once on ≤4h validation passing all required cases at `sha`/`identity`/`artifact`/`release`, else 409; `/api/delivery` keeps last.
- `release uat ID` deploys `uat`, refused while unjudged <4h candidates serve; a verdictless job tags `rc-uat/ID` cancelled (git-only; unpromotable).
- `release validate ID --url UAT_URL [--api] [--suite NAME=COMMAND]...` awaits `/healthz`, re-reading it 120s post-suites (an unreadable read recovering to the candidate SHA passes; unreadable past the window fails unreadable); runs endpoint/API (`GRAPHYARD_UAT_TOKEN`)/`browser`/suites ([validation](validation.md#release-verdicts); `GRAPHYARD_UAT_URL`, never `GRAPHYARD_TOKEN`); records `rc-uat/ID`.
- `release promote ID` (or [accepted flakes](validation.md#release-verdicts)) deploys `rc-production/ID`; `release verify --url URL` confirms; workflow tags `YYYY.M.D[.N]`+`stable`, `version`/`/healthz` report. Direct promotion seals [imported-run hold](validation.md#release-verdicts); `admin`/`operator-agent` seal **released** holds only ([filing credential](#release-filing-credential)); unsealable refuses; planes without operator agents promote unsealed.
- `GRAPHYARD_RELEASE_BUILD` records digests; with `GRAPHYARD_DEPLOY_DIGESTS` `uat`/`promote` deploy them, else SHA. A recorded build promotes by digest, never rebuilt, once UAT names it.
- Failures file [holds](validation.md#release-holds), else `release follow-up ID`.
- `release soak ID --sha SHA --result success|failure|cancelled [--run URL] [--report NAME]` (`release-candidate-soak.yml`) records `rc-soak/ID`.

**The master loop deploys continuously** (compose/local installs): between cycles each new base tip runs `graphyard upgrade`'s steps, `/healthz?strict` and every `e2e/cases/` case — the cases as the install's own `<installId>-e2e` identity, an admin the installer issues with the roster, since a case's first step creates an item the loop's coordinator may not; passing, `promotion` names it and the loop restarts onto it. Failing, the recorded release is redeployed, every redeploy building the image with the deployed commit's stamp (`unreleased SHA` or its tag) so `/healthz` names it (`promotion.deploy`: `deploy of SHA failed at STEP: REASON; rolled back to SHA`), unless the tip migrated the database; two tries until main moves; `graphyard master config promoteEveryMinutes` no longer applies. `release.onFailure` `hold` (default `revert`) names each failing case, step and would-be target or `no map matched`, reverting/reopening nothing; `release.revertUnmatched: false` holds an unmatched failure instead of the newest item. `GRAPHYARD_UAT_STATIC` [merge-writer](delivery-redesign.md#merge-writer) trials run required/uat cases uncredentialed: failing, secret-declaring or unrunnable fail; timeouts re-queue. `release status` lists; `release GY-N EPOCH` leases.

### Release filing credential

UAT's `GRAPHYARD_TOKEN` (`GRAPHYARD_RELEASE_TOKEN`) files holds/follow-ups as `graphyard-release-follow-up` (only `intent:create`, items `*`); the loop's hourly `master setup --apply` keeps it, else `master status` names the administrator's step (`graphyard operator-agent setup FILE --token-stdin`). `e2e record` uses `GRAPHYARD_E2E_RECORD_TOKEN`, likewise `graphyard-e2e-recorder` with only `e2e:record`, never admin. Uat imports first run read-only `release seal-check ID` (`GET /api/validation/import/seal-authority`, recording `rc-seal-check/ID.AT`); refusal fails pre-seal, named in `master status`.

### Pre-merge gate and release-candidate validation

Required: `typecheck`, `test`; per candidate `releaseCandidateTests`/container/chart/`upgrade` (`scripts/upgrade-from-stable.mjs`: `stable` compose upgrades intact, `/healthz`=candidate version+commit; none: skipped); UAT's `zero-touch` merges an item.

`deploy/helm/exercise.sh` forwards a kubectl-chosen free port, re-forwarding a lost or foreign one within `FORWARD_BUDGET` seconds; waits for the rollout's new Ready pod, retrying transient API failures (empty reply, reset, stall, non-2xx, bodiless 2xx), else ending `api METHOD /api/PATH failed after 15 attempts: status STATUS, body: BODY`.

### One delivery path

Exact-head gates merge; [candidates](#release-candidates) deploy. Only Graphyard writes main ([redesign](delivery-redesign.md)).

### Main

No main guard runs (GY-2010): main moves only by the merge writer's push of a trialled merge commit, and the report-only main watch explains every commit. Failing trial files rerun (merge, base): a pass on the rerun lands, filing nothing; base failures file P0.

## Managed repositories

`init --scan` splits checks (`delivery.mergeGate`/per-candidate); `--apply` writes the policy to `graphyard.json` (`candidateSchedule`/`--candidate-cron CRON|off`), writes no `.github/workflows` file and removes generated `graphyard-release-candidate.yml`/`graphyard-promotion.yml` copies. `deploy.adapter`: `railway`|`command` (`deploy.uat`/`deploy.production`, given `GRAPHYARD_CANDIDATE_SHA`). `--delivery local|per-pr` overrides; `install --plan` lists.

`mode: local` (`control-plane` default): `{"previews":"local","candidateMaxChanges":5,"productionVerification":true}`, `command` adapter, generated workflows removed; `delivery.applications` `{id,kind:"static",directory,build}`/`{id,kind:"compose",file,service,port}`; `delivery.cases` case→application; invalid refuse `init`/`install`/`/api/status` (`project.error`); **Delivery** shows it.

Bound cases preview items (head/main; `GRAPHYARD_PREVIEW_TITLE`): static builds publish `/preview/KEY/`; Compose apps run isolated (own project/state/database/images; no `.env`/`include`/`extends`; refuse credentials/sockets/privileges/outside paths; `GRAPHYARD_PREVIEW_CPUS`/`_MEMORY_MB`/`_PIDS`/`_LIFETIME_MINUTES`/`_COMPOSE_LIMIT`/`_SERVICES`); `GRAPHYARD_PREVIEW_ORIGIN` serves, else sandboxed; endings/restarts remove containers/volumes/networks/images first.

**`graphyard.json` policy**: `risk.sensitive` `{rule,glob}` (else generic); `review.normalChanges` `post-merge`/`pre-merge`; `e2e.pendingOutcomes` `non-blocking`/`blocking`; `release.onFailure` `revert`/`hold`; deployed `GRAPHYARD_REPOSITORY_POLICY`; `doctor` prints it.

```json
{"kind":"environment","id":"production","expectedRevision":0,"repository":"owner/repository","url":"https://app.example.test","instance":"production-cluster","immutable":true,"services":["api","web"],"resources":["production-smoke-account"],"delivery":{"freshnessSeconds":300,"approvalRequired":true}}
```

```json
{"kind":"registration","id":"production-observer","expectedRevision":0,"principalId":"railway-observer","role":"observer","environment":{"id":"production","revision":1},"adapterVersion":"custom-v1","proofs":[],"enabled":true,"services":["api","web"]}
```

`POST /api/delivery/build`:

```json
{"registration":{"id":"production-builder","revision":1},"sourceSha":"0123456789abcdef0123456789abcdef01234567","buildInputsDigest":"sha256:5b8e0d3a7f21c94e6082d5b1a3f7c0e94d26b8a15f309c7e4b1d02a6f8395c7e","artifacts":[{"service":"api","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"},{"service":"web","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}],"provenanceUrl":"https://ci.example.test/builds/812"}
```

`POST /api/delivery/release`:

```json
{"id":"2026.09.18-1","expectedRevision":0,"environment":{"id":"production","revision":1},"sourceSha":"0123456789abcdef0123456789abcdef01234567","buildId":"5d7c6b7e-8c35-4b3f-9c4a-0a1f2e3d4c5b","manifest":[{"service":"api","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"},{"service":"web","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}],"members":[{"workId":"2f7d1a5e-3b8c-4d9e-8f10-1a2b3c4d5e6f","mergeSha":"89abcdef0123456789abcdef0123456789abcdef","included":true},{"workId":"3a8e2b6f-4c9d-4eaf-9021-2b3c4d5e6f70","mergeSha":"9abcdef0123456789abcdef0123456789abcdef0","included":false,"note":"Reverted"}]}
```

`POST /api/delivery/approve` selects:

```json
{"environment":{"id":"production","revision":1},"release":{"id":"2026.09.18-1","revision":1},"expectedGeneration":3,"approvalId":"0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5"}
```

## Observe and verify

`POST /api/delivery/observe`:

```json
{"registration":{"id":"production-observer","revision":1},"epoch":4,"environment":{"id":"production","revision":1},"expectedGeneration":4,"snapshotId":"railway:snapshot:01J8Q4Z0Y3","observedAt":"2026-09-18T20:15:07Z","validFrom":"2026-09-18T20:12:31Z","validTo":"2026-09-18T20:15:07Z","services":[{"service":"api","complete":true,"deployment":{"id":"dep-a1","status":"success","deployedAt":"2026-09-18T20:12:31Z"},"instances":[{"instance":"api-1","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","measurement":"host-attestation","healthy":true}]},{"service":"web","complete":true,"deployment":{"id":"dep-w7","status":"success","deployedAt":"2026-09-18T20:12:40Z"},"instances":[{"instance":"web-1","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222","measurement":"host-attestation","healthy":true}]}]}
```

`POST /api/delivery/observe-sha` marks contained merges Deployed (any producer, or a `delivery:observe-sha` principal; [install](install.md)). Needs every service and an exact 40-hex `sha`; optionally `release`/`artifact`:

```json
{"environment":{"id":"production","revision":1},"sha":"0123456789abcdef0123456789abcdef01234567","services":["api","web"],"observedAt":"2026-09-18T20:15:07Z","release":"20260918T200000Z","artifact":"tree:89abcdef0123456789abcdef0123456789abcdef"}
```

An observation never yields Production verified: smoke-required work needs an `e2e:deploy-smoke` pass naming that `sha`, executed, none skipped. Complete listings verify (`POST /api/delivery/notify`); `graphyard delivery sweep` per `freshnessSeconds`; `graphyard delivery` shows it. Candidates verify on newest `observe-sha`/sweep (`GRAPHYARD_PRODUCTION_IDENTITY_URL`) matching `release`/`sourceSha`/`artifact`; else `mismatched`/`unknown`.

`master status` `delivery`: `readyToMerged`/`mergedToProduction`/`stages` p50/p90.

`POST /api/validation/result` binds manifest/signature/measurements; mismatches void passes as `attribution-undermined` (`GET /api/analytics/attribution`). A loop-owned post-deploy observation item never dispatches: deployment verification reads it; a pass closes it `delivered-observation`, a fail escalates; no-smoke deliveries backfill five per pass.
