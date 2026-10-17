<!-- page: Build integrations | 4 | release API. -->
# Releases and delivery

Releases ([rollback](recovery.md#rollback)): `admin` sets policy; `builder`s build; `admin`/`promoter` select; `observer`s lease (`POST /api/delivery/lease`).

## Release candidates

Main→candidate→uat→production; `.railway/railway.ts` deploys `release/uat`/`release/production` (moved by `graphyard release`) to candidate SHAs.

- `release cut [--trigger schedule|manual] [--max-prs N]` tags `rc/ID` with ≤N new first-parent merges (`GRAPHYARD_RC_MAX_PRS`=10; rest queue); `.github/workflows/release-candidate.yml` cuts on loop dispatch.
- `release uat ID` deploys `uat`; refused under an unjudged <4h candidate.
- `release validate ID --url UAT_URL [--api] [--suite NAME=COMMAND]...` awaits `/healthz`; runs endpoint/API (`GRAPHYARD_UAT_TOKEN`)/`browser`/suites ([below](#pre-merge-gate-and-release-candidate-validation); `GRAPHYARD_UAT_URL`); records `rc-uat/ID`; [pending](validation.md#release-verdicts) blocks only if `e2e.pendingOutcomes: blocking`.
- `release promote ID` (needs that or [accepted flakes](validation.md#release-verdicts)) deploys production as `rc-production/ID`; `release verify --url URL` confirms. A direct promotion seals the [imported-run hold](validation.md#release-verdicts) it read before any deployer runs — an import landing in between refuses it; `admin`/`operator-agent` seal a **released** hold only ([release-filing credential](#release-filing-credential) in workflows, the loop's operator agent); unsealable refuses.
- `GRAPHYARD_RELEASE_BUILD` records cuts' per-service digests; with `GRAPHYARD_DEPLOY_DIGESTS` (`GRAPHYARD_DEPLOY_ENVIRONMENT`/`_MANIFEST`/`_GENERATION`) `uat`/`promote` deploy them, else SHA. A recorded build promotes by digest, never rebuilt, once UAT names it. `verify`/UAT `digests` check `GRAPHYARD_INSTANCE_DIGESTS`. Deploys take `rc-deploy/ENV/N`, then `rc-deployed/ENV/N`.
- Failures file a [hold](validation.md#release-holds) per outcome, else `release follow-up ID` ([filing credential](#release-filing-credential)).
- `release soak ID --sha SHA --result success|failure|cancelled [--run URL] [--report NAME]` (`release-candidate-soak.yml`) records `rc-soak/ID`.

**The master loop promotes** (`promote=true`) once main differs from the last `rc-production/`/cut SHAs, nothing queued, `run.promoteEveryMinutes` (`graphyard master config promoteEveryMinutes=N`; 10, `0` off) passed; failures raise `promotion:failed`. Under a `control-plane` merger the loop cuts (`run.candidates.everyMerges` 10, `idleMinutes` 15), validates, promotes and verifies (`GRAPHYARD_UAT_URL`/`GRAPHYARD_PRODUCTION_URL`; no workflow; managed repositories run [required cases](validation.md)); a failed required E2E case reverts the newest candidate item a matching verification map covers (`candidateReverts`; reopened); a main-watch freeze holds all. A `GRAPHYARD_UAT_STATIC` site's [merge-writer](delivery-redesign.md#merge-writer) trials run required/uat cases uncredentialed: a failing or secret-declaring required one, or none runnable, fails; timeouts re-queue (`mergeLedger.trial.preview`). `release status` lists; `release GY-N EPOCH` leases; needs `vars.UAT_URL`/`PRODUCTION_URL`.

### Release filing credential

UAT's `GRAPHYARD_TOKEN` (`GRAPHYARD_RELEASE_TOKEN`) files holds/follow-ups as `graphyard-release-follow-up` (only `intent:create`, work items `*`). The loop's hourly `master setup --apply` keeps it; else `master status` names the administrator's step (`graphyard operator-agent setup FILE --token-stdin`, FILE holding the identity document). `doctor`: `FAIL release-filing`. `e2e record` uses `GRAPHYARD_E2E_RECORD_TOKEN`, likewise `graphyard-e2e-recorder` with only `e2e:record`, never admin.

### Pre-merge gate and release-candidate validation

Required: `typecheck`, `test` (`ci.yml`); per candidate `releaseCandidateTests`/container/chart, soak/timing (advisory); UAT's `zero-touch` suite (`up --agent --goal`) merges a first item; human steps block.

`deploy/helm/exercise.sh` forwards a kubectl-chosen free port, re-forwarding a lost or foreign one within `FORWARD_BUDGET` seconds; waits for the rollout's new Ready pod, retrying transient API failures (empty reply, reset, stall, non-2xx, bodiless 2xx), else ending `api METHOD /api/PATH failed after 15 attempts: status STATUS, body: BODY`.

### One delivery path

Exact-head gates merge; [candidates](#release-candidates) deploy ([redesign](delivery-redesign.md)).

### Main guard

Every 30s the guard reruns, reverting merges failing checks parents passed; the [revert approver App](deployment.md#variables) approves only green exact inverses; three refusals abandon (`approval-refused`). A revert failing the merge's named tests closes `base-failure`: an attention row/P0 item name them; later merges failing only that set are covered (`coveredBy`) until main passes. Failing trial files rerun on merge, then base: [flakes](validation.md#flake-ledger) land; base failures (per case) hold 30min, file P0; no rework/proof loss.

## Managed repositories

`init --scan` splits checks (`delivery.mergeGate`/per-candidate); `--apply` renders `graphyard-release-candidate.yml` (`candidateSchedule`/`--candidate-cron CRON|off`), `graphyard-promotion.yml`. `deploy.adapter`: `railway` or `command` (`deploy.uat`/`deploy.production` with `GRAPHYARD_CANDIDATE_SHA`; unset none). `--delivery per-pr` keeps per-PR checks; `install --plan` lists resources.

**`graphyard.json` policy**: `risk.sensitive` `{rule,glob}` (`only`: `risk`/`lane`), else generic; `review.normalChanges` `post-merge`/`pre-merge`; `e2e.pendingOutcomes` `non-blocking`/`blocking`; deployed `GRAPHYARD_REPOSITORY_POLICY`; `doctor` prints it.

## Observe and verify

`POST /api/delivery/build` registers a build (source and inputs digests, per-service `artifacts`, provenance); `release` selects one (`manifest`, per-merge `members`); `approve` picks a generation; `observe`/`observe-sha` (producer, paged) record per-service instance digests and health.

Complete listings verify (`POST /api/delivery/notify`); `graphyard delivery sweep` per `freshnessSeconds`; `graphyard delivery` shows state.

`release status` lists; `release GY-N EPOCH` leases; needs `vars.UAT_URL`/`PRODUCTION_URL`. `master status` `delivery`: stage p50/p90, 7-day `deliverySpeed` p90 alerts.

`POST /api/validation/result` binds manifest/signature/measurements; mismatches void passes as `attribution-undermined` (`GET /api/analytics/attribution`). Loop-owned post-deploy observation items never dispatch; no-smoke deliveries backfill five per pass.
