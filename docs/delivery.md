<!-- page: Build integrations | 4 | release API. -->
# Releases and delivery

Releases: `admin` sets policy; `builder`s build; `admin`/`promoter` select; `observer`s lease (`POST /api/delivery/lease`).

**The master loop deploys continuously** (compose/local installs): each new base tip runs `graphyard upgrade`'s steps, `/healthz?strict` and every `e2e/cases/` case as the install's `<installId>-e2e` identity, closing pass or fail, obsolete, naming the run, whatever its cases created; passing, the loop restarts onto it. The deploy runs off the cycle: the loop cycles on, starts no second meanwhile and records the settled success or rollback. The redeploy stamps the deployed commit's tree, so `/healthz` names it while the loop runs a held snapshot. Failing, the recorded release is redeployed (`promotion.deploy`: `deploy of SHA failed at STEP: REASON; rolled back to SHA`); two tries until main moves, unless the tip migrated the database. `release.onFailure` `hold` (default `revert`) names each failing case, step and would-be target or `no map matched`, reverting/reopening nothing; `release.revertUnmatched: false` holds an unmatched failure instead of the newest item. Merge-writer trials run required cases uncredentialed; timeouts re-queue. `release GY-N EPOCH` leases; `release status` and `graphyard delivery` print ledger and pipeline. Main moves only by the merge writer's push; the report-only main watch explains every commit. Base failures file P0.

### Release filing credential

`GRAPHYARD_RELEASE_TOKEN` files holds/follow-ups; the loop's hourly `master setup --apply` keeps it. `e2e record` uses `GRAPHYARD_E2E_RECORD_TOKEN`.

`deploy/helm/exercise.sh` forwards a kubectl-chosen free port, re-forwarding a lost or foreign one within `FORWARD_BUDGET` seconds; waits for the rollout's new Ready pod, retrying transient API failures (empty reply, reset, stall, non-2xx, bodiless 2xx), else ending `api METHOD /api/PATH failed after 15 attempts: status STATUS, body: BODY`.

## Managed repositories

`--apply` writes `init --scan`'s split checks (`delivery.mergeGate`) to `graphyard.json`. `deploy.adapter`: `railway`|`command`; `install --plan` lists.

`mode: local` (`control-plane` default): previews local, `command` adapter; `delivery.applications`/`delivery.cases` bind cases to static or Compose apps. Bound cases preview items: static builds publish `/preview/KEY/`; Compose apps run isolated.

An environment registers `{"kind":"environment","services":[…]}`; an observer `{"kind":"registration","role":"observer"}`.

**`graphyard.json` policy**: `risk.sensitive` `{rule,glob}`; `review.normalChanges` `post-merge`/`pre-merge`; `e2e.pendingOutcomes` `non-blocking`/`blocking`; `release.onFailure` `revert`/`hold`; deployed `GRAPHYARD_REPOSITORY_POLICY`.

`POST /api/delivery/build` records a build:

```json
{"registration":{"id":"production-builder","revision":1},"sourceSha":"0123456789abcdef0123456789abcdef01234567","buildInputsDigest":"sha256:5b8e0d3a7f21c94e6082d5b1a3f7c0e94d26b8a15f309c7e4b1d02a6f8395c7e","artifacts":[{"service":"api","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"}],"provenanceUrl":"https://ci.example.test/builds/812"}
```

`POST /api/delivery/release` selects its manifest members (reverted excluded); `POST /api/delivery/approve` selects it by `approvalId` and `expectedGeneration`.

## Observe and verify

`POST /api/delivery/observe` carries every service's instances with host-attested digests, never a self-report. `POST /api/delivery/observe-sha` marks contained merges Deployed: every service and an exact 40-hex `sha`. Smoke-required work needs an `e2e:deploy-smoke` pass naming it. Complete listings verify (`POST /api/delivery/notify`); `graphyard delivery sweep` runs per `freshnessSeconds`. `master status` `delivery` reports `readyToMerged`/`mergedToProduction`/`stages` p50/p90. `POST /api/validation/result` binds manifest/signature/measurements; mismatches void passes as `attribution-undermined`.

## Main watch

`graphyard master main-watch status` prints the unexplained commits; `GET /api/main-watch` returns the acknowledgements and direct-merge windows. `GRAPHYARD_MAIN_WATCH_FREEZE=true` freezes promotion until an admin runs `graphyard master main-watch acknowledge SHA --reason TEXT --admin-token-stdin` or `POST /api/main-watch/acknowledge` (`Idempotency-Key`).

## Rollback

Rollback registrations carry `rollback.fencing` `provider`/`serialized`/`none` (never automatic with `none`); `POST /api/delivery/rollback` requests one; executors `POST /api/delivery/rollback-claim`, then `rollback-settle` (`applied`/`failed`/`unknown`); `unknown` blocks until `rollback-resolve` names the operation and evidence. `"automaticRollback": true` reverts degraded generations.

## Coordinator recovery

Self-merge stalled the loop, or main-watch froze: `graphyard master recover [--to SHA] --admin-token-stdin` repins, restarts; deploys repin.
