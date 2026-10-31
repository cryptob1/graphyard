<!-- page: Build integrations | 4 | release API. -->
# Releases and delivery

Releases: `admin` sets policy; `builder`s build; `admin`/`promoter` select; `observer`s lease (`POST /api/delivery/lease`).

**`graphyard-deploy.service` deploys continuously** (compose/local installs, beside `graphyard-master.service`; `master init` installs both; the loop installs a missing deploy unit): `graphyard upgrade --watch --checkout <install>/deploy/src` fetches origin; each new base tip is checked out there, built, restarted and `/healthz`-checked for its release, then `graphyard-local:<sha12>` images except the serving and previous tips' are removed; failing, it rolls back and waits. `.graphyard/deploy.json` records the served tip and its repository (the watch's first pass names a record an older watcher left unnamed, GY-2957); the loop restarts onto it, and `master status` reads it as release health only when it names that repository (GY-2955). The same unit serves the managed repository's app (GY-2976): a main declaring [`.graphyard/serve.json`](deployment.md#serving-the-managed-repositorys-app) is checked out into the install's serve checkout, built and served on its port, restarting only when it builds; `.graphyard/served.json` records the served commit, URL and last build failure for `master status`, the dashboard and `doctor`. Merge-writer trials run required cases uncredentialed; timeouts re-queue. A running trial reports its step and start in `mergeWriter.inFlight`; a merge reads as stalled once no step advances for 30 minutes or its trial exits with no verdict (GY-2963). A crashed trial's leftover checkout is reclaimed beside the trial's own, and its log records each step's duration (GY-2963). A served commit failing a required case past the last verified commit reverts only the merge that broke it — the item whose own `e2e:` proof names the failing case, else the newest, and a second failing case on the same serve names that culprit — through normal trial and push, and the loop files one `Re-land GY-N` item carrying its criteria plus the failing case (GY-2990). A revert that fails its trial is held and named in `master status`; one its trial cannot judge yet — base failure, lost race, thrown trial — waits the base-failure hold unless the tip moves, so the queue's repair goes first. Without `scripts/ci-tests.mjs` the trial runs the `graphyard.json` `delivery.mergeGate.preMerge` commands (else `npm test` / `npm run typecheck`); with none configured, trial, status and `doctor` record `no test check configured` (GY-2958). A failing repository check's refusal names the failing files and first case (`timed out` for time-outs only); the check also runs on the base tip; a failure main already has is held as a `base failure` (GY-2960). A bug item's proofs also run on the base tip; all passing there refuses the head `not reproduced` (GY-2984). `release GY-N EPOCH` leases; `release status` and `graphyard delivery` print ledger and pipeline. Main moves only by the merge writer's push.

### E2E record credential

`e2e record` uses `GRAPHYARD_E2E_RECORD_TOKEN`.

### One delivery path

Exact-head gates merge; the deploy unit deploys. Only Graphyard writes main ([redesign](delivery-redesign.md)).

## Managed repositories

`init --scan` splits checks (`delivery.mergeGate`); `--apply` writes the policy to `graphyard.json`. `deploy.adapter`: `railway`|`command`; `install --plan` lists.

`mode: local` (`control-plane` default): previews local, `command` adapter; `delivery.applications`/`delivery.cases` bind cases to static (published under `/preview/KEY/`) or Compose (isolated) apps.

An environment registers `{"kind":"environment","services":[…]}`; an observer `{"kind":"registration","role":"observer"}`.

**`graphyard.json` policy**: `risk.sensitive` `{rule,glob}`; `e2e.pendingOutcomes` `non-blocking`/`blocking`; deployed `GRAPHYARD_REPOSITORY_POLICY`.

`POST /api/delivery/build` records a build:

```json
{"registration":{"id":"production-builder","revision":1},"sourceSha":"0123456789abcdef0123456789abcdef01234567","buildInputsDigest":"sha256:5b8e0d3a7f21c94e6082d5b1a3f7c0e94d26b8a15f309c7e4b1d02a6f8395c7e","artifacts":[{"service":"api","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"}],"provenanceUrl":"https://ci.example.test/builds/812"}
```

`POST /api/delivery/release` selects its manifest members (reverted members excluded, noted); `POST /api/delivery/approve` selects the release by `approvalId` and `expectedGeneration`.

## Observe and verify

`POST /api/delivery/observe` carries every service's instances with digests measured by host attestation, never a self-report. `POST /api/delivery/observe-sha` marks contained merges Deployed: every service and an exact 40-hex `sha`. Smoke-required work needs an `e2e:deploy-smoke` pass naming that `sha`. Complete listings verify (`POST /api/delivery/notify`); `graphyard delivery sweep` runs per `freshnessSeconds`. `POST /api/validation/result` binds manifest/signature/measurements; mismatches void passes as `attribution-undermined`.

## Rollback

Rollback registrations carry `rollback.fencing` (`provider`/`serialized`/`none`, never automatic with `none`); `POST /api/delivery/rollback` requests one, claimed then settled (`applied`/`failed`/`unknown`) by the rollback actor, with `unknown` blocking until `rollback-resolve` names the provider operation and evidence. `"automaticRollback": true` reverts degraded generations.

## Coordinator recovery

Self-merge stalled the loop: `graphyard master recover [--to SHA] --admin-token-stdin` repins and restarts it.
