<!-- page: Build integrations | 4 | the release API. -->
# Releases and observed delivery

Graphyard records which release each environment should run, verified only by service-scoped observers; rollback: [recovery](recovery.md#rollback).

## Release candidates

Graphyard's own deployment runs main → frozen candidate → uat → that exact SHA in production. Neither Railway environment deploys main; `.railway/railway.ts` points the `uat` service at `release/uat` and production at `release/production`, and only `graphyard release` moves them, always to a candidate's exact SHA.

- `release cut [--trigger schedule|manual]` tags main's tip as `rc/ID`, recording the SHA and the delivered items it carries since the last promoted candidate. It writes a tag and nothing else, so merges never pause. `.github/workflows/release-candidate.yml` cuts every two hours or on demand, then runs the [long suites](#pre-merge-gate-and-release-candidate-validation) on that SHA before UAT.
- `release uat ID` deploys the candidate to `uat`, which has its own Postgres and no `GITHUB_*` variable: it holds no credential that can write to the production repository and never merges, dispatches or spends the App's budget. It refuses while UAT serves an unjudged candidate cut within four hours, so no deploy moves UAT under a running validation; its push is leased on the tip it observed.
- `release validate ID --url UAT_URL [--api] [--suite NAME=COMMAND]...` waits until UAT's `/healthz` reports the candidate SHA as `commit`, runs the suites, confirms that SHA is still served, and records `rc-uat/ID`. `endpoints` probes `/healthz?strict` and `/`; `--api` drives UAT's own API with `GRAPHYARD_UAT_TOKEN`, creating, replaying and listing a work item and reading the board and status. The workflow runs both, a `browser` suite (Chromium signs in to UAT's dashboard and opens the Work view), and one `--suite` per container and chart job carrying its verdict, so a failed one fails the candidate; the soak and timing-budget suites are advisory. A `--suite` command gets `GRAPHYARD_UAT_URL` but never `GRAPHYARD_TOKEN`.
- `release promote ID` refuses unless that record passed on the candidate SHA, then deploys the SHA to production (leased on the last promoted SHA, so a hand-moved `release/production` is refused) and records `rc-production/ID`. `release verify --url URL` confirms production serves a promoted candidate; `master verify-deployment` then records that SHA on each delivery it carries.
- A failed candidate files one fix-forward item naming the failing suites and proofs, the SHA and the commit range since the last promoted candidate (`release follow-up ID` retries a failed filing). Its items are never reworked or reverted; the next cut carries them and the fix.

### Merged-pending-release

A merged item is `merged-pending-release`, not Done: immutable, its `integration:` and `e2e:` proofs owed to the candidate. `release proofs ID` lists each distinct owed proof; `release validate` runs each as suite `proof NAME`, the test cases naming it in the candidate checkout (`--no-proofs` skips them; none found fails). `validate` and `promote` post the ledger state to `POST /api/release-candidates` (`GRAPHYARD_RELEASE_TOKEN`, coordinator or admin; `release settle ID|all` resends); the item is Done only when a candidate containing its merge commit passes UAT and is promoted. Merging never waits on a candidate. `master status` lists each under `releasePending` with its candidate, UAT state and next step, never as attention; the item page names the release testing it. Earlier merges read as Done.

`release status` lists candidates with UAT verdict and promotion. `release GY-N EPOCH` still gives up an item's lease. The workflow needs `vars.UAT_URL`, `vars.PRODUCTION_URL`, a `GRAPHYARD_UAT_TOKEN` for a principal in UAT's `GRAPHYARD_PRINCIPALS`, and a `GRAPHYARD_RELEASE_TOKEN` that may create work, available to both the `uat` and `production` environments. Create `release/production` at production's current SHA before applying the Railway configuration.

### Pre-merge gate and release-candidate validation

The merge gate is build, typecheck, the pre-merge unit set and one independent review: required `typecheck` and `test` (`.github/workflows/ci.yml`: build, docs check, Node and browser suites, under ten minutes), `unit:` proofs, and high-lane `manual:` attestations. `integration:` and `e2e:` proofs are never merge gates. The soak and timing-budget test files (`releaseCandidateTests` in `scripts/ci-tests.mjs`), container acceptance, container recovery and the Helm chart skip pull requests: `.github/workflows/release-candidate.yml` runs them on each [release candidate](#release-candidates)'s pinned SHA, or a dispatched `sha` or `rc-*` tag.

With `GRAPHYARD_DELIVERY=github` on the server, GitHub merges: once a candidate's build, review and required checks pass, the observation that saw it enables auto-merge on that head. No proof, queue or observation age gates it, the loop skips its guarded merge, proofs are not requested; UAT validates before promotion.

## Managed repositories

Installing Graphyard gives a repository the same model. `init --scan` classifies its checks into `delivery.mergeGate` and shows the split; `init --scan --apply` writes it as `delivery` in `graphyard.json` and renders two workflows from it (re-rendered on every apply, so edit `graphyard.json`, not them):

- `.github/workflows/graphyard-release-candidate.yml` runs `release cut` on `candidateSchedule` (`--candidate-cron`, default six hours; `null` is on demand), runs each `perCandidate` check that has a command at the candidate's exact SHA, moves `release/uat` with `release uat`, deploys through `deploy.adapter`, and records `release validate` with one `--suite` per check.
- `.github/workflows/graphyard-promotion.yml` runs after a successful candidate run (or by dispatch) and calls `release promote`, which refuses any candidate without a passing UAT record on its exact SHA, then deploys that SHA to production and runs `release verify`.

Both run the Graphyard CLI pinned to the installing commit (`GRAPHYARD_BUILD_SHA` when the build stamps one). `deploy.adapter` is `railway` (services tracking `release/uat` and `release/production` in `deploy.project`) or `command` (`deploy.uat` and `deploy.production` run with `GRAPHYARD_CANDIDATE_SHA`; nothing is guessed, so an unset command leaves the workflows ungenerated and is reported). UAT must report the candidate SHA at `/healthz` as `commit` or `revision`.

Branch protection requires only the `preMerge` set, or every check with `"mode": "per-pr"`, which also generates no workflow. `install --plan` lists the release branches, the `uat` and `production` GitHub environments and every resource the adapter creates; each that costs money or opens an account carries `human`, and `--apply` creates those only with `--create-environments`.

## Who writes what

Policy and approvals are `admin`'s; builds need a `builder`-registered `producer`, selection `admin` or `promoter`, observations an `observer`-registered, leased `producer` (`POST /api/delivery/lease`).

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

Approve with `POST /api/delivery/approve`, then select (one selection per generation wins):

```json
{"environment":{"id":"production","revision":1},"release":{"id":"2026.09.18-1","revision":1},
 "expectedGeneration":3,"approvalId":"0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5"}
```

## Observe and verify

The observer submits measurements through `POST /api/delivery/observe`:

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

Only complete `provider` or `host-attestation` listings verify; a repeated `snapshotId` returns the first receipt; `POST /api/delivery/notify` only hints. A two-second sweep (`graphyard delivery sweep` drains sooner) verifies a generation once every service's common interval fits the freshness bound, adding `releaseDeliveries` to included items. Otherwise status reads `unobserved`, `mismatched`, `unknown`, `unhealthy`, `incomplete`, `no-common-interval`, `stale` or `degraded`; `graphyard delivery` shows it.

## Attribution

Each validation request binds the candidate's manifest, a compatibility signature (manifest, build inputs, test bundle, configuration, source, policy, artifacts) and the measurements; workers and client-supplied SHAs establish nothing; `POST /api/validation/result` refuses any top-level SHA. A mismatch inside an accepted pass's window records `attribution-undermined`; it stops counting. `GET /api/analytics/attribution` reports mismatches and paid-run cost.
