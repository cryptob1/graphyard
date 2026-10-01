<!-- page: Operate Graphyard | 1 | variables, observation, backups. -->
# Deployment

Graphyard is one stateless container plus Postgres.

## The one command

`node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply` ([install](install.md)) is the supported path. Tag `vX.Y.Z` publishes `ghcr.io/cryptob1/graphyard:X.Y.Z`; `/healthz` reports version and `commit`; alert on `/healthz?strict` (503 when unhealthy).

## Variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL`, `HOST` / `PORT` | Postgres connection string, `0.0.0.0` / `4310` |
| `GRAPHYARD_PRINCIPALS` | JSON array of principals, each with `role` and `sessionKind` |
| `GITHUB_REPOSITORY` / `GITHUB_BASE_BRANCH` | `owner/repo` / `main` |
| `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY` (or `_FILE`), `GITHUB_WEBHOOK_SECRET` | Control-plane App |
| `GITHUB_CI_APP_IDS` / `GRAPHYARD_REVIEWER_APPS` | Trusted CI App IDs / [reviewer Apps](github.md#identity-bound-agent-review) |
| `GRAPHYARD_MAX_SLICE_LEADS` | Slice leads (3) |
| `GRAPHYARD_MAX_ENGINEERS_PER_LEAD` | Engineers per lead (2) |
| `GRAPHYARD_MIN_REVIEWERS` | Reviewers once a lead exists (1) |
| `GRAPHYARD_MAX_REVIEWERS` | ≥ the `producer` principal count (2) |
| `GRAPHYARD_GENERATED_FILES` | Output of `node scripts/check-docs.mjs --list` |
| `GRAPHYARD_BUILD_SHA` | Image source commit (Railway: `RAILWAY_GIT_COMMIT_SHA`) |
| `GRAPHYARD_ARTIFACT_BACKEND` | `postgres` or `s3` ([artifacts](recovery.md#artifact-backends-capacity-and-migration)) |
| `RAILWAY_API_TOKEN` | Optional; failed or missing deployments become incidents |

Defaults in parentheses. Installers derive the four capacity limits from deployed principals; one left unset is derived at start-up as `delegationLimits` drift.

### CI producer

[Proofs in CI](github.md#proofs-in-ci) publish through one principal, refused `manual:*` and `e2e:*`: `{"id":"ci-proofs","role":"producer","runtime":"github-actions","proofs":["unit:*","integration:*"],"token":"…"}`. Store its token as `GRAPHYARD_CI_PRODUCER_TOKEN`, with `GRAPHYARD_URL`, on the `graphyard-reporting` environment (default branch only). `scripts/configure-integrations.mjs --apply` merges `.graphyard/credentials.json` into the live roster; `--remove ID` drops a principal, `--rotate ID` rotates a producer, `--deploy` sets the GitHub secret.

### Production deployment observation

When the serving commit (`GRAPHYARD_BUILD_SHA`) changes, undeployed merges are compared once and recorded (`delivery.deployment-contained`, `production.deployment-pending`); same-commit restarts compare nothing. A merge unserved after five minutes is a `delivery.deployment-incident`; `master status` shows `main is N commits ahead of production`. Probe: `master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`.

## Backup, upgrade, rollback

**Back up** with `DATABASE_URL` set: `node bin/graphyard.mjs db backup ./graphyard.json`, then `node bin/graphyard.mjs db verify FILE`. **Upgrade:** back up, deploy, confirm `/healthz` names the new commit, run any [App-permission migration](install.md#upgrading-an-existing-installation). **Roll back** only to a same-schema-generation image. **Restore:** `graphyard db migrate` an empty database, then `graphyard db restore FILE`.

## Manual fallback

For an unsupported platform or existing deployment, set the variables table by hand, run `node "$GRAPHYARD_CLI" github-setup https://YOUR-DOMAIN` and verify with `doctor`.

- Compose: `cp .env.example .env`, replace every secret, `docker compose --profile full up -d`; front 4310 with TLS; never expose Postgres.
- Kubernetes: `helm install graphyard deploy/helm/graphyard --set secrets.existingSecret=graphyard-credentials …`.
- Railway: `railway init`, `railway add --database postgres`, set variables, `railway up`; declare hand-set ones with `preserve()` in `.railway/railway.ts`.
