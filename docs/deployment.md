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

A merge unserved five minutes after a new `GRAPHYARD_BUILD_SHA` is a `delivery.deployment-incident`; when `release/production` (or `GRAPHYARD_PRODUCTION_BRANCH`) exists, production is measured against it instead, and an unpromoted merge is pipeline lag, not an incident. Measured against main, the "main is N commits ahead of production" attention line waits out the same five minutes: while every unserved merge is younger (or a provider attempt past the serving commit is in flight), `production` still reports `aheadBy` with `rollingOut: true`, but raises no deployment attention. The deployment list comes from Railway's API when `RAILWAY_API_TOKEN` or `RAILWAY_TOKEN` is set, else from the GitHub deployments Railway reports to the `production` environment (`GRAPHYARD_PRODUCTION_ENVIRONMENT`), read with the App: an in-flight deployment holds the incident, a failed one names its log URL. Probe: `master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`.

## Backup, upgrade, rollback

**Backup:** `graphyard db backup ./graphyard.json` (with `DATABASE_URL`), `graphyard db verify FILE`; `graphyard db fence` before a move (`--release` undoes). **Upgrade:** back up, deploy, check `/healthz` `commit`, run any [App-permission migration](install.md#upgrading-an-existing-installation). **Rollback** only to a same-schema-generation image. **Restore:** `graphyard db migrate` an empty database, then `graphyard db restore FILE`.

## Manual fallback

Otherwise set the variables table by hand, then `node "$GRAPHYARD_CLI" github-setup https://YOUR-DOMAIN` and `doctor`.

- Compose: `cp .env.example .env`, replace secrets, `docker compose --profile full up -d`; TLS on 4310, Postgres private.
- Kubernetes: `helm install graphyard deploy/helm/graphyard --set secrets.existingSecret=graphyard-credentials …`.
- Railway: `railway init`, `railway add --database postgres`, set variables, `railway up`.
- Railway revert approver: `node scripts/provision-railway.mjs` sets the three `GRAPHYARD_REVERT_APPROVER_*` variables from `.graphyard/revert-approver.json` (mode 0600; `{"appId", "installationId", "privateKey"}` or `"privateKeyFile"`) or `--revert-approver-stdin`, sends the key over stdin, prints none, and refuses an armed guard without them. On a running control plane add `--revert-approver-only`: it sets those three variables and nothing else (the reviewer App's record under `~/.config/graphyard/reviewers/` serves as the input), while a full run refuses when the deployment's `GRAPHYARD_PRINCIPALS` holds principals `credentials.json` lacks, naming them instead of dropping them, or when Railway's variable list cannot be read. Then `railway redeploy --service graphyard -y`; `GRAPHYARD_URL=… node scripts/provision-railway.mjs --verify` exits 0 once the live guard names that App.
