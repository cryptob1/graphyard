<!-- page: Build integrations | 4 | the release API. -->
# Releases and observed delivery

Graphyard records which release each environment should run, verified only by service-scoped observers' measurements. Rollback is in [recovery](recovery.md#rollback).

## Release candidates

Graphyard's own deployment runs main → frozen candidate → uat → that exact SHA in production. Neither Railway environment deploys main; `.railway/railway.ts` points the `uat` service at `release/uat` and production at `release/production`; only `graphyard release` moves them, always to a candidate's exact SHA.

- `release cut [--trigger schedule|manual]` tags main's tip as `rc/ID`, recording the SHA and the items delivered since the last promoted candidate. It only writes a tag, so merges never pause. `.github/workflows/release-candidate.yml` cuts every two hours or on demand, then runs the [long suites](#pre-merge-gate-and-release-candidate-validation) on that SHA before UAT.
- `release uat ID` deploys the candidate to `uat`, which has its own Postgres and no `GITHUB_*` variable: it holds no credential that can write to the production repository and never merges, dispatches or spends the App's budget. It refuses while UAT serves an unjudged candidate cut within four hours, so a manual deploy never moves UAT under a running validation; its push is leased on the tip it observed.
- `release validate ID --url UAT_URL [--api] [--suite NAME=COMMAND]...` waits until `/healthz` on UAT reports the candidate SHA as `commit`, runs the suites against that deployment, confirms it still serves that SHA, and records `rc-uat/ID`. `endpoints` probes `/healthz?strict` and `/`; `--api` drives UAT's API with `GRAPHYARD_UAT_TOKEN`: a work item's create, replay and list, the board and status. The workflow runs both and a `browser` suite (Chromium signs in to UAT's dashboard and opens the Work view), plus one `--suite` per container and chart job carrying that job's verdict, so a failed container or chart run fails the candidate; the soak and timing-budget suites are advisory. A `--suite` command gets `GRAPHYARD_UAT_URL` but never `GRAPHYARD_TOKEN`.
- `release promote ID` refuses unless that record passed on the candidate SHA, then deploys the SHA to production (leased on the last promoted SHA, so a hand-moved `release/production` is refused) and records `rc-production/ID`. `release verify --url URL` confirms production serves a promoted candidate; `master verify-deployment` then records that SHA on each delivery it carries.
- A failed candidate files one follow-up item naming the failing suite and SHA (`release follow-up ID` retries a failed filing). Its deliveries stay delivered; fix forward, and the next cut carries both.

`release status` lists candidates with their UAT verdict and promotion. `release GY-N EPOCH` still gives up a work item's lease. The workflow needs `vars.UAT_URL`, `vars.PRODUCTION_URL`, a `GRAPHYARD_UAT_TOKEN` for a principal in UAT's `GRAPHYARD_PRINCIPALS`, and a `GRAPHYARD_RELEASE_TOKEN` that may create work. Create `release/production` at production's current SHA before applying the Railway configuration.

### Pre-merge gate and release-candidate validation

The required pre-merge set is `typecheck` and `test` (`.github/workflows/ci.yml`): build, docs check, Node and browser suites, each bounded so the set finishes under ten minutes. The soak and timing-budget test files (`releaseCandidateTests` in `scripts/ci-tests.mjs`), container acceptance and recovery and the Helm chart never run on a pull request: `.github/workflows/release-candidate.yml` runs them against one pinned SHA: each [release candidate](#release-candidates), or a dispatched `sha` or `rc-*` tag alone.

With `GRAPHYARD_DELIVERY=github` on the server, GitHub merges: once a candidate's build, review and required checks pass, the observation that saw it enables auto-merge on that head. No proof, queue or observation age gates the merge, the loop skips its guarded merge, and proofs are neither requested nor counted against the loop's silence; UAT validates before promotion.

To keep main green under parallel merges, every 30 s the main guard reverts a merge commit failing a required check its parent passed through a `graphyard-revert/` pull request the App merges once its own checks pass, and reopens the item naming the check and commit. A revert that conflicts, fails or stalls an hour is closed after one attempt with one attention line naming the merge, check and revert PR; nothing waits on it: fix main forward.

## Managed repositories

Installed repositories get the same model. `init --scan` classifies its checks into `delivery.mergeGate` and shows the split; `init --scan --apply` writes it as `delivery` in `graphyard.json` and renders two workflows from it (re-rendered on every apply, so edit `graphyard.json`, not them):

- `.github/workflows/graphyard-release-candidate.yml` runs `release cut` on `candidateSchedule` (`--candidate-cron`, default six hours; `null` is on demand), runs each `perCandidate` check that has a command at the candidate's exact SHA, moves `release/uat` with `release uat`, deploys through `deploy.adapter`, and records `release validate` with one `--suite` per check.
- `.github/workflows/graphyard-promotion.yml` runs after a successful candidate run (or by dispatch) and calls `release promote`, then `release verify`.

Both run the Graphyard CLI pinned to the installing commit (`GRAPHYARD_BUILD_SHA` when the build stamps one). `deploy.adapter` is `railway` (services tracking `release/uat` and `release/production` in `deploy.project`) or `command` (`deploy.uat` and `deploy.production` run with `GRAPHYARD_CANDIDATE_SHA`; an unset command is reported and leaves the workflows ungenerated). UAT must report the candidate SHA at `/healthz` as `commit` or `revision`.

Branch protection requires only the `preMerge` set, or every check with `"mode": "per-pr"`, which also generates no workflow. `install --plan` lists the release branches, the `uat` and `production` GitHub environments and every resource the adapter creates; each that costs money or opens an account carries `human`, and `--apply` creates those only with `--create-environments`.

## Who writes what

Policy and approvals are `admin`'s; builds come from a `producer` with a `builder` registration, selection from `admin` or a `promoter`, observations from a `producer` with an `observer` registration and lease (`POST /api/delivery/lease`).

```json
{"kind":"environment","id":"production","expectedRevision":0,"repository":"owner/repository",
 "url":"https://app.example.test","instance":"production-cluster","immutable":true,"services":["api","web"],
 "resources":["production-smoke-account"],"delivery":{"freshnessSeconds":300,"approvalRequired":true}}
```

```json
{"kind":"registration","id":"production-observer","expectedRevision":0,"principalId":"railway-observer","role":"observer",
 "environment":{"id":"production","revision":1},"adapterVersion":"custom-v1","proofs":[],"enabled":true,"services":["api","web"]}
```

## Define, approve and select a release

`POST /api/delivery/build` attests the manifest:

```json
{"registration":{"id":"production-builder","revision":1},"sourceSha":"0123456789abcdef0123456789abcdef01234567",
 "buildInputsDigest":"sha256:5b8e0d3a7f21c94e6082d5b1a3f7c0e94d26b8a15f309c7e4b1d02a6f8395c7e",
 "artifacts":[{"service":"api","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"},
              {"service":"web","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}],
 "provenanceUrl":"https://ci.example.test/builds/812"}
```

`POST /api/delivery/release` names the build and explicit members, each citing its merge SHA; a reverted change stays listed, `included: false`:

```json
{"id":"2026.09.18-1","expectedRevision":0,"environment":{"id":"production","revision":1},
 "sourceSha":"0123456789abcdef0123456789abcdef01234567","buildId":"5d7c6b7e-8c35-4b3f-9c4a-0a1f2e3d4c5b",
 "manifest":[{"service":"api","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"},
             {"service":"web","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}],
 "members":[{"workId":"2f7d1a5e-3b8c-4d9e-8f10-1a2b3c4d5e6f","mergeSha":"89abcdef0123456789abcdef0123456789abcdef","included":true},
            {"workId":"3a8e2b6f-4c9d-4eaf-9021-2b3c4d5e6f70","mergeSha":"9abcdef0123456789abcdef0123456789abcdef0","included":false,"note":"Reverted in #812"}]}
```

Approve with `POST /api/delivery/approve` `{"release": {...}, "environment": {...}}`, then select (one concurrent selection per generation wins):

```json
{"environment":{"id":"production","revision":1},"release":{"id":"2026.09.18-1","revision":1},
 "expectedGeneration":3,"approvalId":"0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5"}
```

## Observe and verify

The observer posts measurements to `POST /api/delivery/observe`:

```json
{"registration":{"id":"production-observer","revision":1},"epoch":4,"environment":{"id":"production","revision":1},
 "expectedGeneration":4,"snapshotId":"railway:snapshot:01J8Q4Z0Y3","observedAt":"2026-09-18T20:15:07Z",
 "validFrom":"2026-09-18T20:12:31Z","validTo":"2026-09-18T20:15:07Z",
 "services":[
  {"service":"api","complete":true,"deployment":{"id":"dep-a1","status":"success","deployedAt":"2026-09-18T20:12:31Z"},
   "instances":[{"instance":"api-1","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","measurement":"host-attestation","healthy":true}]},
  {"service":"web","complete":true,"deployment":{"id":"dep-w7","status":"success","deployedAt":"2026-09-18T20:12:40Z"},
   "instances":[{"instance":"web-1","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222","measurement":"host-attestation","healthy":true}]}]}
```

Only complete `provider` or `host-attestation` listings verify; a repeated `snapshotId` returns the original receipt; `POST /api/delivery/notify` is a hint. A two-second sweep (`graphyard delivery sweep` drains sooner) verifies a generation once every service shares a common interval within the freshness bound, adding `releaseDeliveries` to each included item. Otherwise status reads `unobserved`, `mismatched`, `unknown`, `unhealthy`, `incomplete`, `no-common-interval`, `stale` or `degraded`. `graphyard delivery` shows the state.

## Delivery speed

`master status` `delivery` measures items merged into main: `readyToMerged`, first `ready` event (or creation) to GitHub's merge, and `mergedToProduction`, merge to the first production promotion serving that commit. Each has `count`, `p50Ms` and `p90Ms` for `24h` and `7d`; unpromoted merges count as `pending`. Targets: p90 ≤ 2 hours and ≤ 8 hours, set by master.json `deliverySpeed` (`readyToMergedP90Ms`, `mergedToProductionP90Ms`). A 7-day p90 over target raises one attention line naming the slowest items.

## Attribution

Each validation request binds the candidate's manifest, a compatibility signature (manifest, build inputs, test bundle, configuration, source, policy, artifacts) and the run's observed measurements; workers and client-supplied SHAs establish nothing; `POST /api/validation/result` refuses a top-level SHA field. A mismatch inside an accepted pass's window records `attribution-undermined`; the pass stops counting. `GET /api/analytics/attribution` reports mismatches and paid-run cost.
