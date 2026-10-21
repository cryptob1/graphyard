<!-- page: Build integrations | 4 | release API. -->
# Releases and delivery

Releases: `admin` sets policy; `builder`s build; `admin`/`promoter` select; `observer`s lease (`POST /api/delivery/lease`).

**The master loop deploys continuously** (compose/local installs): each new base tip runs `graphyard upgrade`'s steps (build, restart), then `/healthz?strict` must report the deployed commit; passing, the loop restarts onto it. The redeploy stamps from the deployed commit's tree, so `/healthz` names it while the loop runs a held snapshot. Failing the deploy or the health check, the recorded release is redeployed (`promotion.deploy`: `deploy of SHA failed at STEP: REASON; rolled back to SHA`); two tries until main moves, unless the tip migrated the database. Merge-writer trials run required cases uncredentialed; timeouts re-queue. `release GY-N EPOCH` leases; `release status` and `graphyard delivery` print ledger and pipeline. Main moves only by the merge writer's push. Base failures file nothing.

The deploy runs off the cycle: the loop cycles on, starts no second meanwhile and records the settled success or rollback.

A tip whose post-deploy E2E failed is not deployed again: the same commit fails identically, so the loop waits for main to move.

### E2E record credential

`e2e record` uses `GRAPHYARD_E2E_RECORD_TOKEN`.

### One delivery path

Exact-head gates merge; the loop deploys. Only Graphyard writes main ([redesign](delivery-redesign.md)).

## Managed repositories

`init --scan` splits checks (`delivery.mergeGate`); `--apply` writes the policy to `graphyard.json`. `deploy.adapter`: `railway`|`command`; `install --plan` lists.

`mode: local` (`control-plane` default): previews local, `command` adapter; `delivery.applications`/`delivery.cases` bind cases to static or Compose apps. Bound cases preview items: static builds publish `/preview/KEY/`; Compose apps run isolated.

An environment registers `{"kind":"environment","services":[…]}`; an observer `{"kind":"registration","role":"observer"}`.

**`graphyard.json` policy**: `risk.sensitive` `{rule,glob}`; `review.normalChanges` `post-merge`/`pre-merge`; `e2e.pendingOutcomes` `non-blocking`/`blocking`; deployed `GRAPHYARD_REPOSITORY_POLICY`.

`POST /api/delivery/build` records a build:

```json
{"registration":{"id":"production-builder","revision":1},"sourceSha":"0123456789abcdef0123456789abcdef01234567","buildInputsDigest":"sha256:5b8e0d3a7f21c94e6082d5b1a3f7c0e94d26b8a15f309c7e4b1d02a6f8395c7e","artifacts":[{"service":"api","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"}],"provenanceUrl":"https://ci.example.test/builds/812"}
```

`POST /api/delivery/release` selects its manifest members (reverted members excluded, noted); `POST /api/delivery/approve` selects the release by `approvalId` and `expectedGeneration`.

## Observe and verify

`POST /api/delivery/observe` carries every service's instances with digests measured by host attestation, never a self-report. `POST /api/delivery/observe-sha` marks contained merges Deployed: every service and an exact 40-hex `sha`. Smoke-required work needs an `e2e:deploy-smoke` pass naming that `sha`. Complete listings verify (`POST /api/delivery/notify`); `graphyard delivery sweep` runs per `freshnessSeconds`. `master status` `delivery` reports `readyToMerged`/`mergedToProduction`/`stages` p50/p90; a merge counts as served from the loop's first verified deploy of a main commit containing it. `POST /api/validation/result` binds manifest/signature/measurements; mismatches void passes as `attribution-undermined`.

## Rollback

Rollback registrations carry `rollback.fencing` `provider`/`serialized`/`none` (never automatic with `none`); `POST /api/delivery/rollback` requests one; the rollback actor `POST`s `/api/delivery/rollback-claim`, then `rollback-settle` (`applied`/`failed`/`unknown`); `unknown` blocks until `rollback-resolve` names the provider operation and evidence. `"automaticRollback": true` reverts degraded generations.

## Coordinator recovery

Self-merge stalled the loop: `graphyard master recover [--to SHA] --admin-token-stdin` repins, restarts; deploys repin, keeping the new pin, the one it replaced and the one the running loop loaded from.
