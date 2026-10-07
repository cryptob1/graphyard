<!-- page: Operate Graphyard | 1 | variables, observation, backups. -->
# Deployment

## The one command

One stateless container plus Postgres: `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply` ([install](install.md)). Tag `vX.Y.Z` publishes `ghcr.io/cryptob1/graphyard:X.Y.Z`; alert on `/healthz?strict` (503 if unhealthy).

## Variables

`DATABASE_URL`; `HOST`/`PORT` (`0.0.0.0`/`4310`); `GITHUB_REPOSITORY`/`GITHUB_BASE_BRANCH` (`owner/repo`/`main`); App `GITHUB_APP_ID`/`GITHUB_INSTALLATION_ID`/`GITHUB_PRIVATE_KEY` (or `_FILE`)/`GITHUB_WEBHOOK_SECRET`; trusted `GITHUB_CI_APP_IDS`; [reviewer](github.md#identity-bound-agent-review) `GRAPHYARD_REVIEWER_APPS`; [main guard revert approver](delivery.md#pre-merge-gate-and-release-candidate-validation) `GRAPHYARD_REVERT_APPROVER_APP_ID`/`_INSTALLATION_ID`/`_PRIVATE_KEY` (or `_FILE`); `GRAPHYARD_GENERATED_FILES`; `GRAPHYARD_BUILD_SHA` (image commit); optional `RAILWAY_API_TOKEN` (deployment list; without it, GitHub deployments); `GRAPHYARD_ARTIFACT_BACKEND` (`postgres`/[`s3`](recovery.md#artifact-backends-capacity-and-migration)); `GRAPHYARD_SIGNIN_CLAIM` ([host](install.md#self-contained-host) single-use sign-in hash); and:

| Variable | Purpose
| --- | ---
| `GRAPHYARD_PRINCIPALS` | Principals JSON (`role`, `sessionKind`: operator `human`, retro-judging AI `admin` `ai`)
| `GRAPHYARD_MAX_SLICE_LEADS` | Slice leads (3)
| `GRAPHYARD_MAX_ENGINEERS_PER_LEAD` | Engineers per lead (2)
| `GRAPHYARD_MIN_REVIEWERS` | Reviewers with a lead (1)
| `GRAPHYARD_MAX_REVIEWERS` | ≥ `producer` count (2)

Installers derive the limits; an unset one is `delegationLimits` drift.

### CI producer

[CI proofs](github.md#proofs-in-ci) publish via one principal (refused `manual:*`, `e2e:*`):

```json
{"id":"ci-proofs","role":"producer","runtime":"github-actions","proofs":["unit:*","integration:*"],"token":"…"}
```

`GRAPHYARD_CI_PRODUCER_TOKEN`, `GRAPHYARD_URL` live in the default-branch-only `graphyard-reporting` environment. `scripts/configure-integrations.mjs --apply` merges `.graphyard/credentials.json` into the live roster (`--remove ID`, `--rotate ID`, `--deploy`).

### Production deployment observation

A merge unserved five minutes after a new `GRAPHYARD_BUILD_SHA` is a `delivery.deployment-incident`; when `release/production` (or `GRAPHYARD_PRODUCTION_BRANCH`) exists, production is measured against it, and an unpromoted merge is pipeline lag. Against main, the "main is N commits ahead of production" line waits out the same five minutes: while every unserved merge is younger (or a provider attempt past the serving commit is in flight), `production` reports `aheadBy` with `rollingOut: true` but no attention. The deployment list is Railway's API with `RAILWAY_API_TOKEN` or `RAILWAY_TOKEN`, else the GitHub deployments Railway reports under the [production environment name](#production-environment-name), read with the App: an in-flight deployment holds the incident, a failed one names its log URL. When the list lags, a `master verify-deployment` endpoint observation of the exact release tip under 15 minutes old, newer than the list's newest success and with no failed or removed attempt at that SHA, is served (`servingSource: endpoint`). The running build (`/healthz` commit) outranks the list too: when it holds the release tip or the list's newest success, it is served (`servingSource: build`), so a lagging or mis-attributed record raises no release-ahead attention or missing incident, and an open one recovers with `verifiedBy: served-identity`; a build older than the record leaves the record serving. A missing incident names the `/healthz` commit and provider's report. Probe: `master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`. The loop reuses its last verified observation without reading GitHub while it is younger than `run.deploymentReuseMinutes` (default 15; `master config deploymentReuseMinutes=N`, `0` reads every cycle) and nothing is pending.

A delivery a verified release does not yet serve, while its [promotion](delivery.md) is not yet due or is in validation, is the promotion window: `master status` release lag and the `loaded-revision` [resource](operations-reference.md#control-plane-resources) leave it uncounted, name the promotion's `nextDueAt`, and never prescribe restarting a loop already on the verified release. An unavailable observation grants no such grace. A `systemctl --user` probe that cannot reach the user manager (a sandboxed board read) reads the loop's supervision as unverified, not absent, when the cursor records it under the packaged unit.

After verifying a deployment the loop records GY-87's throughput claim once per served release, with its coordinator credential, under `.graphyard/measurements/throughput` (newest 30 kept); while another revision is served it waits, retried on the failure backoff. The read is bounded to deliveries since GY-87's release began serving. `master status` reports the claim verified or names the shortfall. `scripts/measure-throughput.mjs --record` runs the same measurement by hand: a record never overwrites one from the same millisecond (it takes the next `_N` suffix), the newest 30 of its own records are kept, and other files there are never read or retired.

### Deployment incident

Railway auto-deploys `release/production` within a minute of promotion. Compare the `/healthz` `commit` with the tip: when it serves the tip, run `graphyard master verify-deployment GY-N` per pending delivery; otherwise `railway deployment list --service graphyard --environment production` shows whether the build failed; redeploy the tip (dashboard or [manual fallback](#manual-fallback)), wait for `/healthz` to report it, then verify.

#### Production environment name

Railway reports deployments to GitHub under `<project> / production` (here `graphyard / production`), not `production`. At startup the watch takes the name the master publishes to the ledger (`production.environment`, from run field `productionEnvironment`), else `GRAPHYARD_PRODUCTION_ENVIRONMENT` (declared in `.railway/railway.ts`), else `production`. Check: the startup log's `production observation via GitHub deployments to NAME` line, or `production.providerDescription` in `/api/status`. A new name applies at the next restart.

## Backup, upgrade, rollback

**Backup:** `graphyard db backup ./graphyard.json` (with `DATABASE_URL`), `graphyard db verify FILE`; `graphyard db fence` before a move (`--release` undoes). **Upgrade:** back up, deploy, check `/healthz` `commit`, run any [App-permission migration](install.md#upgrading-an-existing-installation). **Rollback** only to a same-schema-generation image. **Restore:** `graphyard db migrate` an empty database, then `graphyard db restore FILE`.

## Manual fallback

Otherwise set the variables table by hand, then `node "$GRAPHYARD_CLI" github-setup https://YOUR-DOMAIN` and `doctor`.

- Compose: `cp .env.example .env`, replace secrets, `docker compose --profile full up -d`; TLS on 4310, Postgres private.
- Kubernetes: `helm install graphyard deploy/helm/graphyard --set secrets.existingSecret=graphyard-credentials …`.
- Railway: `railway init`, `railway add --database postgres`, set variables, `railway up`. Redeploying production: never `init`; from a clean tip checkout, `railway link --project graphyard --environment production --service graphyard`, then `railway up`.
- Existing installs: `graphyard master setup` plans each variable saved credentials derive (bound reviewer App wins) that the deployment lacks; `--apply` sets them via its adapter (Railway: `variable set --stdin`), printing fingerprints, auditing each (`.graphyard/setup-audit.jsonl`); an unread listing applies nothing. No install record: `--provider railway --service graphyard --link-dir DIR`. The loop applies it hourly (failures back off). `park` refuses host-doable asks (repository the gh login administers, derived variable, held credential).
- Revert approver by hand: `node scripts/provision-railway.mjs` sets the `GRAPHYARD_REVERT_APPROVER_*` variables from `.graphyard/revert-approver.json` (mode 0600) or `--revert-approver-stdin`; `--revert-approver-only` sets only those, from the reviewer App's record; a full run refuses when `GRAPHYARD_PRINCIPALS` holds principals `credentials.json` lacks or Railway's variable list is unreadable. Then redeploy; `--verify` (with `GRAPHYARD_URL`) exits 0 once the live guard names that App.
