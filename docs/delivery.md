<!-- page: Build integrations | 4 | the release API. -->
# Releases and observed delivery

Records which release each environment should run, verified only by service-scoped observers ([rollback](recovery.md#rollback)). `admin`: policy, approvals. `producer` + `builder` registration: builds. `admin`/`promoter`: selection. `producer` + `observer` registration and lease (`POST /api/delivery/lease`): observations.

## Release candidates

Graphyard's own deployment: main → candidate → uat → production. `.railway/railway.ts` deploys `release/uat` and `release/production`, which only `graphyard release` moves, always to a candidate's exact SHA.

- `release cut [--trigger schedule|manual]` tags main's tip `rc/ID` with the items it carries; merges never pause. `.github/workflows/release-candidate.yml` cuts on dispatch (the loop's, below) or on its two-hourly cron, a best-effort backup, and runs the [long suites](#pre-merge-gate-and-release-candidate-validation).
- `release uat ID` deploys to `uat` (own Postgres, no `GITHUB_*` credentials), refused while UAT serves an unjudged candidate cut within four hours; its push is leased on the observed tip.
- `release validate ID --url UAT_URL [--api] [--suite NAME=COMMAND]...` waits for UAT's `/healthz` `commit` to match, runs endpoint, API (`GRAPHYARD_UAT_TOKEN`), `browser` (dashboard sign-in, Work view) and suite checks (container and chart jobs gate; soak and timing are advisory), and records `rc-uat/ID`. Suites get `GRAPHYARD_UAT_URL`, never `GRAPHYARD_TOKEN`.
- `release promote ID` requires that passing record (or [accepted flaky cases](validation.md#release-verdicts)), deploys the SHA to production (leased on the last promoted SHA) and records `rc-production/ID`; `release verify --url URL` confirms production serves it.
- A failed candidate files a [hold](validation.md#release-holds) per failed outcome, one follow-up for other failures (`release follow-up ID` retries); fix forward.

**The master loop drives promotion**, not GitHub's cron (scheduled runs are best-effort; four in a row never fired on 2026-10-05). A scheduled run that does fire still cuts and promotes, and counts as the last dispatch. Each cycle the loop dispatches that workflow with `promote=true` once main differs from the last `rc-production/` SHA, no cut or scheduled run is queued or in progress, and `run.promoteEveryMinutes` (default 120) have passed since the last dispatch, its own or a run GitHub lists. It fetches main and the `rc-production/` tags at most every five minutes and lists runs at most once a minute, failed or not. A dispatch attempt counts as the last dispatch even when `gh` fails, so a refused dispatch (a token without `actions: write`) is retried an interval later, not every cycle; failures are recorded as the `promotion:failed` action and retried with backoff. Change the cadence with `graphyard master config promoteEveryMinutes=N` (`0` turns it off, an empty value restores 120). `master status` `promotion` reports `lastPromotedSha`, `behind` (first-parent merges production lacks) and `nextDueAt`.

`release status` lists candidates; `release GY-N EPOCH` still gives up an item's lease. The workflow needs `vars.UAT_URL`, `vars.PRODUCTION_URL`, `GRAPHYARD_UAT_TOKEN` and `GRAPHYARD_RELEASE_TOKEN`.

### Pre-merge gate and release-candidate validation

Required: `typecheck`, `test` (`.github/workflows/ci.yml`), under ten minutes. Soak/timing files (`releaseCandidateTests` in `scripts/ci-tests.mjs`), container and Helm checks run in `.github/workflows/release-candidate.yml` on each [release candidate](#release-candidates).

### One delivery path

1. **CI and review** of the exact head.
2. **GitHub merges into main** once build, review and required checks pass on that head, and that merge is the delivery: no authorization, execution, proof, queue or observation age intervenes. A failing head's merge is a held violation.
3. **UAT end-to-end** validates each [release candidate](#release-candidates).
4. **Promotion** deploys only a validated candidate to production.

Every 30 s the main guard reverts a merge commit failing a required check its parent passed, via a `graphyard-revert/` pull request the App merges once green, and reopens the item naming check and commit. Protection wants approval from someone other than the last pusher, and the App pushed the revert, so once its checks pass the guard compares its diff with the merge's: only the exact inverse (same files, each restoring exactly the lines the merge removed and dropping those it added) is approved once at its head by the revert approver App (`GRAPHYARD_REVERT_APPROVER_APP_ID`/`_INSTALLATION_ID`/`_PRIVATE_KEY` or `_FILE`, e.g. the reviewer App; never the control-plane App), then merged head-bound with no human or reviewer round. Without an approver the App merges on its ruleset bypass alone; under main's last-push-approval rule that is refused, so while the guard is armed (GitHub delivery with required checks) `graphyard doctor` (`revert-approver`) and master status's setup attention name the missing approver and its variables, and a refusal says no approver is configured. An approval or merge refused by GitHub's approval rule or the approver is retried, each time approving afresh and merging on the bypass, and abandoned (`approval-refused`) after the third refusal. A revert that is not the exact inverse, conflicts, fails or stalls an hour is closed after one attempt. An abandoned revert's attention line names its cause and repeats every cycle until main's failing check passes again; fix main forward.

## Managed repositories

`init --scan` splits checks into `delivery.mergeGate` (pull requests) and per-candidate; `--apply` writes `delivery` and renders `graphyard-release-candidate.yml` (cut on `candidateSchedule`, `--candidate-cron CRON|off`; checks at the exact SHA; UAT; validation) and `graphyard-promotion.yml` (promote a UAT-passed SHA, then verify), pinning the installing CLI. `deploy.adapter`: `railway` (`deploy.project`) or `command` (`deploy.uat`/`deploy.production` with `GRAPHYARD_CANDIDATE_SHA`; unset leaves workflows ungenerated). UAT reports the SHA at `/healthz` as `commit` or `revision`. `--delivery per-pr` (or `"mode": "per-pr"`) keeps every check required per pull request. `install --plan` lists the resources; `human` ones need `--apply --create-environments`.

```json
{"kind":"environment","id":"production","expectedRevision":0,"repository":"owner/repository","url":"https://app.example.test","instance":"production-cluster","immutable":true,"services":["api","web"],"resources":["production-smoke-account"],"delivery":{"freshnessSeconds":300,"approvalRequired":true}}
```

```json
{"kind":"registration","id":"production-observer","expectedRevision":0,"principalId":"railway-observer","role":"observer","environment":{"id":"production","revision":1},"adapterVersion":"custom-v1","proofs":[],"enabled":true,"services":["api","web"]}
```

`POST /api/delivery/build` attests the manifest:

```json
{"registration":{"id":"production-builder","revision":1},"sourceSha":"0123456789abcdef0123456789abcdef01234567","buildInputsDigest":"sha256:5b8e0d3a7f21c94e6082d5b1a3f7c0e94d26b8a15f309c7e4b1d02a6f8395c7e","artifacts":[{"service":"api","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"},{"service":"web","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}],"provenanceUrl":"https://ci.example.test/builds/812"}
```

`POST /api/delivery/release` names build and explicit members with merge SHAs (reverted ones stay, `included: false`):

```json
{"id":"2026.09.18-1","expectedRevision":0,"environment":{"id":"production","revision":1},"sourceSha":"0123456789abcdef0123456789abcdef01234567","buildId":"5d7c6b7e-8c35-4b3f-9c4a-0a1f2e3d4c5b","manifest":[{"service":"api","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"},{"service":"web","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}],"members":[{"workId":"2f7d1a5e-3b8c-4d9e-8f10-1a2b3c4d5e6f","mergeSha":"89abcdef0123456789abcdef0123456789abcdef","included":true},{"workId":"3a8e2b6f-4c9d-4eaf-9021-2b3c4d5e6f70","mergeSha":"9abcdef0123456789abcdef0123456789abcdef0","included":false,"note":"Reverted in #812"}]}
```

`POST /api/delivery/approve` `{"release": {...}, "environment": {...}}`, then select (one per generation wins):

```json
{"environment":{"id":"production","revision":1},"release":{"id":"2026.09.18-1","revision":1},"expectedGeneration":3,"approvalId":"0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5"}
```

## Observe and verify

Observers `POST /api/delivery/observe`:

```json
{"registration":{"id":"production-observer","revision":1},"epoch":4,"environment":{"id":"production","revision":1},"expectedGeneration":4,"snapshotId":"railway:snapshot:01J8Q4Z0Y3","observedAt":"2026-09-18T20:15:07Z","validFrom":"2026-09-18T20:12:31Z","validTo":"2026-09-18T20:15:07Z","services":[{"service":"api","complete":true,"deployment":{"id":"dep-a1","status":"success","deployedAt":"2026-09-18T20:12:31Z"},"instances":[{"instance":"api-1","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","measurement":"host-attestation","healthy":true}]},{"service":"web","complete":true,"deployment":{"id":"dep-w7","status":"success","deployedAt":"2026-09-18T20:12:40Z"},"instances":[{"instance":"web-1","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222","measurement":"host-attestation","healthy":true}]}]}
```

Only complete listings verify; repeated `snapshotId`s return the original receipt; `POST /api/delivery/notify` only hints. A sweep (`graphyard delivery sweep` forces one) verifies generations once services share an interval within `freshnessSeconds`, adding `releaseDeliveries` to items. `graphyard delivery` shows state.

`master status` `delivery`: `readyToMerged` and `mergedToProduction` p50/p90 over `24h`/`7d`; a 7-day p90 over master.json `deliverySpeed` targets (2 h, 8 h) raises attention.

Validation binds manifest, signature, measurements (`POST /api/validation/result` refuses top-level SHAs). Mismatches record `attribution-undermined`, voiding passes. `GET /api/analytics/attribution` reports mismatches, cost.
