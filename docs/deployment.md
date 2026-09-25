<!-- page: Operate Graphyard | 1 | variables, observation, backups. -->
# Deployment

Graphyard is one stateless container plus Postgres.

## The one command

`node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply` ([install](install.md)) is the supported path; this page is its reference.

## Versioned images

Tag `vX.Y.Z` publishes `ghcr.io/cryptob1/graphyard:X.Y.Z`. `/healthz` reports the version and `commit`; alert on `/healthz?strict`, which returns 503 when unhealthy.

## Variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `HOST` / `PORT` | `0.0.0.0` / `4310` |
| `GRAPHYARD_PRINCIPALS` | JSON array of principals, each with a `role` and `sessionKind` |
| `GITHUB_REPOSITORY` / `GITHUB_BASE_BRANCH` | `owner/repo` / `main` |
| `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY` (or `_FILE`), `GITHUB_WEBHOOK_SECRET` | The control-plane App |
| `GITHUB_CI_APP_IDS` | Trusted CI App IDs |
| `GRAPHYARD_REVIEWER_APPS` | [Reviewer Apps](github.md#identity-bound-agent-review) |
| `GRAPHYARD_MAX_SLICE_LEADS` | Slice leads (default 3) |
| `GRAPHYARD_MAX_ENGINEERS_PER_LEAD` | Engineers per lead (default 2) |
| `GRAPHYARD_MIN_REVIEWERS` | Reviewers once a lead exists (default 1) |
| `GRAPHYARD_MAX_REVIEWERS` | At least the number of `producer` principals (default 2) |
| `GRAPHYARD_GENERATED_FILES` | What `node scripts/check-docs.mjs --list` prints |
| `GRAPHYARD_BUILD_SHA` | Commit the image was built from (Railway supplies `RAILWAY_GIT_COMMIT_SHA`) |
| `GRAPHYARD_ARTIFACT_BACKEND` | `postgres` or `s3` ([artifacts](recovery.md#artifact-backends-capacity-and-migration)) |
| `RAILWAY_API_TOKEN` | Optional; records failed or missing deployments as incidents |

Installers derive the four capacity limits from the deployed principals; an unset limit is derived at start-up and reported as `delegationLimits` drift.

### CI producer

[Proofs in CI](github.md#proofs-in-ci) publish through one principal, refused `manual:*` and `e2e:*`:

```json
{"id":"ci-proofs","role":"producer","runtime":"github-actions","proofs":["unit:*","integration:*"],"token":"…"}
```

Store its token as `GRAPHYARD_CI_PRODUCER_TOKEN` on the `graphyard-reporting` environment (default branch only) with `GRAPHYARD_URL`. `scripts/configure-integrations.mjs --apply` merges `.graphyard/credentials.json` into the live roster (dropping a live principal only with `--remove ID`); `--rotate ID` rotates one producer and `--deploy` sets the GitHub secret.

### Production deployment observation

When the serving commit (`GRAPHYARD_BUILD_SHA`) changes, undeployed merges are compared once; answers are recorded (`delivery.deployment-contained`, `production.deployment-pending`), so a same-commit restart compares nothing. One unserved after five minutes is a `delivery.deployment-incident`; `master status` shows `main is N commits ahead of production`. Probe: `master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`.

## Backup, upgrade, rollback

```sh
node bin/graphyard.mjs db backup ./graphyard.json   # with DATABASE_URL set
node bin/graphyard.mjs db verify FILE
```

**Upgrade:** back up, deploy, confirm `/healthz` names the new commit, then any [App-permission migration](install.md#upgrading-an-existing-installation). **Rollback** only to an image with the same schema generation. **Restore:** `graphyard db migrate` an empty database, then `graphyard db restore FILE`.

## Manual fallback

Only for an unsupported platform or an existing deployment: set the variables table above by hand, run `node "$GRAPHYARD_CLI" github-setup https://YOUR-DOMAIN`, and verify with `doctor`.

- Compose: `cp .env.example .env`, replace every secret, then `docker compose --profile full up -d`; put TLS in front of 4310 and never expose Postgres.
- Kubernetes: `helm install graphyard deploy/helm/graphyard --set secrets.existingSecret=graphyard-credentials …`.
- Railway by hand: `railway init`, `railway add --database postgres`, set the variables, `railway up`. Declare hand-set variables with `preserve()` in `.railway/railway.ts`.
