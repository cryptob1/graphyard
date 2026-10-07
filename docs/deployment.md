<!-- page: Operate Graphyard | 1 | variables, backups. -->
# Deployment

## The one command

One stateless container plus Postgres: `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply` ([install](install.md)). Tag `vX.Y.Z` publishes `ghcr.io/cryptob1/graphyard:X.Y.Z`; alert on `/healthz?strict` (503 if unhealthy).

## Variables

`DATABASE_URL`; `HOST`/`PORT` (`0.0.0.0`/`4310`); `GITHUB_REPOSITORY`/`GITHUB_BASE_BRANCH` (`owner/repo`/`main`); App `GITHUB_APP_ID`/`GITHUB_INSTALLATION_ID`/`GITHUB_PRIVATE_KEY` (or `_FILE`)/`GITHUB_WEBHOOK_SECRET`; trusted `GITHUB_CI_APP_IDS`; [reviewer](github.md#identity-bound-agent-review) `GRAPHYARD_REVIEWER_APPS`; [revert approver](delivery.md#pre-merge-gate-and-release-candidate-validation) `GRAPHYARD_REVERT_APPROVER_APP_ID`/`_INSTALLATION_ID`/`_PRIVATE_KEY` (or `_FILE`); `GRAPHYARD_GENERATED_FILES`; `GRAPHYARD_BUILD_SHA` (image commit); optional `RAILWAY_API_TOKEN`; `GRAPHYARD_ARTIFACT_BACKEND` (`postgres`/[`s3`](recovery.md#artifact-backends-capacity-and-migration)); `GRAPHYARD_SIGNIN_CLAIM` ([host](install.md#self-contained-host) single-use sign-in hash); and:

| Variable | Purpose
| --- | ---
| `GRAPHYARD_PRINCIPALS` | Principals JSON (`role`, `sessionKind`: operator `human`, retro-judging AI `admin` `ai`)
| `GRAPHYARD_MAX_SLICE_LEADS` | Slice leads (3)
| `GRAPHYARD_MAX_ENGINEERS_PER_LEAD` | Engineers per lead (2)
| `GRAPHYARD_MIN_REVIEWERS` | Reviewers with a lead (1)
| `GRAPHYARD_MAX_REVIEWERS` | ≥ `producer` count (2)

Installers derive the limits; an unset one is `delegationLimits` drift.

### CI producer

[CI proofs](github.md#proofs-in-ci) publish via one principal (`manual:*`, `e2e:*` refused):

```json
{"id":"ci-proofs","role":"producer","runtime":"github-actions","proofs":["unit:*","integration:*"],"token":"…"}
```

`GRAPHYARD_CI_PRODUCER_TOKEN` and `GRAPHYARD_URL` live in the default-branch-only `graphyard-reporting` environment; `scripts/configure-integrations.mjs --apply` merges `.graphyard/credentials.json` into the live roster (`--remove ID`, `--rotate ID`, `--deploy`).

### Production deployment observation

Unserved five minutes after a new `GRAPHYARD_BUILD_SHA`, a merge is a `delivery.deployment-incident`; until then, or while a provider attempt past the serving commit is in flight, `production` shows `aheadBy`, `rollingOut: true` and the "main is N commits ahead of production" attention waits. With `release/production` (`GRAPHYARD_PRODUCTION_BRANCH`) production is measured against it; an unpromoted merge is pipeline lag. Deployments: Railway's API (`RAILWAY_API_TOKEN`/`RAILWAY_TOKEN`), else App-read GitHub deployments to `production` (`GRAPHYARD_PRODUCTION_ENVIRONMENT`); in-flight holds the incident, failed names its log URL. Probe: `master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`. The loop reuses its last verified observation without reading GitHub while it is younger than `run.deploymentReuseMinutes` (15; `master config deploymentReuseMinutes=N`, `0` reads every cycle) and serves every delivery with none pending; a new or pending delivery reads live.

The loop (coordinator credential) records GY-87's throughput claim once per verified served release in `.graphyard/measurements/throughput` (newest 30), waiting on failure backoff while another revision serves, reading only deliveries since that release; `master status` reports it verified or the shortfall (`scripts/measure-throughput.mjs --record` by hand).

## Backup, upgrade, rollback

**Backup:** `graphyard db backup ./graphyard.json` (with `DATABASE_URL`), `graphyard db verify FILE`; `graphyard db fence` before a move (`--release` undoes). **Upgrade:** back up, deploy, check `/healthz` `commit`, run any [App-permission migration](install.md#upgrading-an-existing-installation); **rollback** only to a same-schema-generation image. **Restore:** `graphyard db migrate` an empty database, then `graphyard db restore FILE`.

## Manual fallback

Set the variables table by hand, then `node "$GRAPHYARD_CLI" github-setup https://YOUR-DOMAIN` and `doctor`.

- Compose: `cp .env.example .env`, replace secrets, `docker compose --profile full up -d`; TLS on 4310, Postgres private.
- Kubernetes: `helm install graphyard deploy/helm/graphyard --set secrets.existingSecret=graphyard-credentials …`.
- Railway: `railway init`, `railway add --database postgres`, set variables, `railway up`.
- Railway revert approver: `node scripts/provision-railway.mjs` sets `GRAPHYARD_REVERT_APPROVER_*` (key via stdin, unprinted) from `.graphyard/revert-approver.json` (0600; `{"appId", "installationId", "privateKey"}` or `"privateKeyFile"`) or `--revert-approver-stdin`, refusing an armed guard without them; a full run also refuses `GRAPHYARD_PRINCIPALS` entries `credentials.json` lacks (named) or unreadable Railway variables; `--revert-approver-only` sets only those three on a running plane, from `~/.config/graphyard/reviewers/`. Then `railway redeploy --service graphyard -y`; `GRAPHYARD_URL=… node scripts/provision-railway.mjs --verify` exits 0 once the live guard names that App.
