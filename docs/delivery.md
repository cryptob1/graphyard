<!-- page: Build integrations | 4 | release API. -->
# Releases and delivery

Records each environment's intended release, verified only by service-scoped observers ([rollback](recovery.md#rollback)): `admin` sets policy, approves; `builder` producers build; `admin`/`promoter` select; `observer` producers lease (`POST /api/delivery/lease`), observe.

## Release candidates

Own deployment: main → candidate → uat → production; `.railway/railway.ts` deploys `release/uat`, `release/production`, moved only by `graphyard release` to candidate's exact SHA.

- `release cut [--trigger schedule|manual] [--max-prs N]` tags `rc/ID` with items: at most N first-parent merges after the last candidate (`GRAPHYARD_RC_MAX_PRS`, default 10; GY-1491), cut at the Nth in merge order, rest queued for the next; a failed candidate's successor starts after it. Merges never pause. `.github/workflows/release-candidate.yml` cuts on loop dispatch (six-hourly cron only a fallback), running [long suites](#pre-merge-gate-and-release-candidate-validation).
- `release uat ID` deploys `uat` (own Postgres, no `GITHUB_*` credentials), refused while UAT serves unjudged candidate <4 h old; push leased on observed tip.
- `release validate ID --url UAT_URL [--api] [--suite NAME=COMMAND]...` awaits UAT's `/healthz` `commit`; runs endpoint, API (`GRAPHYARD_UAT_TOKEN`), `browser` (sign-in, Work view), suites (container, chart, `zero-touch` gate; soak, timing advisory; `GRAPHYARD_UAT_URL`, never `GRAPHYARD_TOKEN`); records `rc-uat/ID`.
- `release promote ID` needs that (or [accepted flaky cases](validation.md#release-verdicts)), deploys production leased on last promoted SHA, records `rc-production/ID`; `release verify --url URL` confirms.
- Failed candidates file [hold](validation.md#release-holds) per failed outcome, else one follow-up (`release follow-up ID` retries); fix forward.
- `release soak ID --sha SHA --result success|failure|cancelled [--run URL] [--report NAME]` (GY-1513) records the advisory soak's verdict as `rc-soak/ID` on the candidate's exact SHA, with its run and timing-report artifact; `release-candidate-soak.yml`'s `record` job runs it. First record stands; promotion never reads it.

**The master loop drives promotion continuously** (GY-1488): dispatching the workflow (`promote=true`) once main differs from the last `rc-production/` and cut SHAs, no run is queued, and `run.promoteEveryMinutes` (`graphyard master config promoteEveryMinutes=N`; 10, `0` off) has passed, unless the last run promoted (GY-1513); failed dispatches raise `promotion:failed` with backoff. Runs are read once an interval while a candidate is in validation, once a minute otherwise. `master status` `promotion` shows `lastPromotedSha`, `behind`, `nextDueAt`, `candidates` (each with its advisory `soak`: `running`, else the recorded `passed`/`failed`/`cancelled`). `release status` lists candidates with `uat`, `soak`, `production`; `release GY-N EPOCH` yields a lease. Needs `vars.UAT_URL`, `vars.PRODUCTION_URL`, `GRAPHYARD_UAT_TOKEN`, `GRAPHYARD_RELEASE_TOKEN`.

### Pre-merge gate and release-candidate validation

Required: `typecheck`, `test` (`.github/workflows/ci.yml`), under ten minutes; soak/timing files (`releaseCandidateTests` in `scripts/ci-tests.mjs`), container and Helm checks run per candidate. The advisory soak and timing budgets run in `release-candidate-soak.yml`, dispatched with the candidate's SHA, so the next candidate is cut while it soaks. UAT's `zero-touch` suite runs `tests/zero-touch-onboarding.test.ts`: `up --agent --goal` against a fake GitHub must reach a merged first item; any human step but the App approval blocks promotion.

### One delivery path

Exact-head CI and review; GitHub's merge into main after build, review, required checks is the delivery (no authorization, execution, proof, queue or observation age intervenes; failing heads' merges are held violations); UAT validates [candidates](#release-candidates); promotion deploys validated ones.

Every 30 s the main guard reruns the failed jobs of a merge failing a required check its parent passed (a pass records a flake), then reverts it (`graphyard-revert/` PR), reopening the item. The revert approver App (`GRAPHYARD_REVERT_APPROVER_APP_ID`/`_INSTALLATION_ID`/`_PRIVATE_KEY` or `_FILE`; never the control-plane App) approves only a green exact inverse; a missing one is named by `graphyard doctor` (`revert-approver`). The third refusal abandons (`approval-refused`); non-inverse, conflicting, failing or stalled reverts close after one attempt.

## Managed repositories

`init --scan` splits checks: `delivery.mergeGate` (pull requests), per-candidate; `--apply` writes `delivery`, renders `graphyard-release-candidate.yml` (cut on `candidateSchedule`, `--candidate-cron CRON|off`) and `graphyard-promotion.yml` (promote UAT-passed SHA, verify), pinning installing CLI. `deploy.adapter`: `railway` (`deploy.project`) or `command` (`deploy.uat`/`deploy.production` with `GRAPHYARD_CANDIDATE_SHA`; unset generates no workflows); UAT reports SHA at `/healthz` as `commit` or `revision`. `--delivery per-pr` (`"mode": "per-pr"`) keeps every check per pull request; `install --plan` lists resources, `human` ones needing `--apply --create-environments`.

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

`POST /api/delivery/release` names build and members with merge SHAs (reverted ones stay, `included: false`):

```json
{"id":"2026.09.18-1","expectedRevision":0,"environment":{"id":"production","revision":1},"sourceSha":"0123456789abcdef0123456789abcdef01234567","buildId":"5d7c6b7e-8c35-4b3f-9c4a-0a1f2e3d4c5b","manifest":[{"service":"api","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111"},{"service":"web","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222"}],"members":[{"workId":"2f7d1a5e-3b8c-4d9e-8f10-1a2b3c4d5e6f","mergeSha":"89abcdef0123456789abcdef0123456789abcdef","included":true},{"workId":"3a8e2b6f-4c9d-4eaf-9021-2b3c4d5e6f70","mergeSha":"9abcdef0123456789abcdef0123456789abcdef0","included":false,"note":"Reverted in #812"}]}
```

`POST /api/delivery/approve` `{"release":{...},"environment":{...}}`, then select (one per generation wins):

```json
{"environment":{"id":"production","revision":1},"release":{"id":"2026.09.18-1","revision":1},"expectedGeneration":3,"approvalId":"0c1d2e3f-4a5b-4c6d-8e7f-90a1b2c3d4e5"}
```

## Observe and verify

Observers `POST /api/delivery/observe`:

```json
{"registration":{"id":"production-observer","revision":1},"epoch":4,"environment":{"id":"production","revision":1},"expectedGeneration":4,"snapshotId":"railway:snapshot:01J8Q4Z0Y3","observedAt":"2026-09-18T20:15:07Z","validFrom":"2026-09-18T20:12:31Z","validTo":"2026-09-18T20:15:07Z","services":[{"service":"api","complete":true,"deployment":{"id":"dep-a1","status":"success","deployedAt":"2026-09-18T20:12:31Z"},"instances":[{"instance":"api-1","digest":"sha256:1111111111111111111111111111111111111111111111111111111111111111","measurement":"host-attestation","healthy":true}]},{"service":"web","complete":true,"deployment":{"id":"dep-w7","status":"success","deployedAt":"2026-09-18T20:12:40Z"},"instances":[{"instance":"web-1","digest":"sha256:2222222222222222222222222222222222222222222222222222222222222222","measurement":"host-attestation","healthy":true}]}]}
```

Only complete listings verify; repeated `snapshotId`s return original receipt; `POST /api/delivery/notify` only hints. Sweeps (`graphyard delivery sweep` forces) verify generations once services share interval within `freshnessSeconds`, adding `releaseDeliveries` to items; `graphyard delivery` shows state.

`master status` `delivery`: `readyToMerged`, `mergedToProduction`, `stages` (ready, implementation, build, review+rework, proof, merge, production; summing to ready→production) p50/p90 over `24h`/`7d`. 7-day p90 over master.json `deliverySpeed` (2 h; merged→production 45 min) raises attention naming the slowest tenth's stage (`statements` says why).

`POST /api/validation/result` binds manifest, signature, measurements, refusing top-level SHAs; mismatches record `attribution-undermined`, voiding passes; `GET /api/analytics/attribution` reports mismatches, cost.
