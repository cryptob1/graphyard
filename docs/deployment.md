<!-- page: Operate Graphyard | 1 | variables, backups. -->
# Deployment

## The one command

One stateless container plus Postgres: `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply` ([install](install.md)). Tag `vX.Y.Z` publishes `ghcr.io/cryptob1/graphyard:X.Y.Z`; alert on `/healthz?strict`.

## Variables

`DATABASE_URL`; `HOST`/`PORT`; `GITHUB_REPOSITORY`/`GITHUB_BASE_BRANCH`; App `GITHUB_APP_ID`/`GITHUB_INSTALLATION_ID`/`GITHUB_PRIVATE_KEY` (or `_FILE`)/`GITHUB_WEBHOOK_SECRET`; trusted `GITHUB_CI_APP_IDS`; [reviewer](github.md#identity-bound-agent-review) `GRAPHYARD_REVIEWER_APPS`; [revert approver](delivery.md#pre-merge-gate-and-release-candidate-validation) `GRAPHYARD_REVERT_APPROVER_APP_ID`/`_INSTALLATION_ID`/`_PRIVATE_KEY` (or `_FILE`); `GRAPHYARD_GENERATED_FILES`; `GRAPHYARD_BUILD_SHA`; optional `RAILWAY_API_TOKEN`; `GRAPHYARD_ARTIFACT_BACKEND` (`postgres`/[`s3`](recovery.md#artifact-backends-capacity-and-migration)); `GRAPHYARD_SIGNIN_CLAIM` ([host](install.md#self-contained-host) sign-in hash); and:

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

`GRAPHYARD_CI_PRODUCER_TOKEN` and `GRAPHYARD_URL` live in the `graphyard-reporting` environment; `scripts/configure-integrations.mjs --apply` merges `.graphyard/credentials.json` into the live roster (`--remove ID`, `--rotate ID`, `--deploy`).

### Production deployment observation

A merge unserved five minutes after a new `GRAPHYARD_BUILD_SHA` is a `delivery.deployment-incident` (until then `production` reports `rollingOut: true`); with `release/production` (or `GRAPHYARD_PRODUCTION_BRANCH`) production is measured against that branch. Deployments come from Railway's API (`RAILWAY_API_TOKEN`), else from GitHub deployments to `GRAPHYARD_PRODUCTION_ENVIRONMENT`. Probe: `master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`. After verifying a deployment the loop records the throughput claim once per served release under `.graphyard/measurements/throughput` (`scripts/measure-throughput.mjs --record` by hand); `master status` reports it verified or names the shortfall.

## Backup, upgrade, rollback

**Backup:** `graphyard db backup ./graphyard.json` (with `DATABASE_URL`), `graphyard db verify FILE`; `graphyard db fence` before a move (`--release` undoes). **Upgrade:** back up, deploy, check `/healthz` `commit`, run any [App-permission migration](install.md#upgrading-an-existing-installation); **rollback** only to a same-schema-generation image. **Restore:** `graphyard db migrate` an empty database, then `graphyard db restore FILE`.

## Manual fallback

Otherwise set the variables table by hand, then `node "$GRAPHYARD_CLI" github-setup https://YOUR-DOMAIN` and `doctor`.

- Compose: `cp .env.example .env`, replace secrets, `docker compose --profile full up -d`.
- Kubernetes: `helm install graphyard deploy/helm/graphyard --set secrets.existingSecret=graphyard-credentials`.
- Railway: `railway init`, `railway add --database postgres`, set variables, `railway up`.
- Railway revert approver: `node scripts/provision-railway.mjs` sets `GRAPHYARD_REVERT_APPROVER_*` from `.graphyard/revert-approver.json` (0600; `appId`, `installationId`, `privateKey` or `privateKeyFile`) or `--revert-approver-stdin`, printing no key; `--revert-approver-only` sets just those three on a running control plane (then `railway redeploy --service graphyard -y`), and `--verify` (with `GRAPHYARD_URL`) exits 0 once the live guard names that App.
