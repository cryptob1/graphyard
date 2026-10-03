<!-- page: Operate Graphyard | 1 | variables, observation, backups. -->
# Deployment

## The one command

One stateless container plus Postgres: `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply` ([install](install.md)). Tag `vX.Y.Z` publishes `ghcr.io/cryptob1/graphyard:X.Y.Z`; alert on `/healthz?strict` (503 if unhealthy).

## Variables

`DATABASE_URL`; `HOST`/`PORT` (`0.0.0.0`/`4310`); `GITHUB_REPOSITORY`/`GITHUB_BASE_BRANCH` (`owner/repo`/`main`); App `GITHUB_APP_ID`/`GITHUB_INSTALLATION_ID`/`GITHUB_PRIVATE_KEY` (or `_FILE`)/`GITHUB_WEBHOOK_SECRET`; trusted `GITHUB_CI_APP_IDS`; [reviewer](github.md#identity-bound-agent-review) `GRAPHYARD_REVIEWER_APPS`; `GRAPHYARD_GENERATED_FILES`; `GRAPHYARD_BUILD_SHA` (image commit); optional `RAILWAY_API_TOKEN` (deployment incidents); `GRAPHYARD_ARTIFACT_BACKEND` (`postgres`/[`s3`](recovery.md#artifact-backends-capacity-and-migration)); and:

| Variable | Purpose
| --- | ---
| `GRAPHYARD_PRINCIPALS` | Principals JSON (`role`, `sessionKind`); operator declared `human`, rotation refuses the rest
| `GRAPHYARD_MAX_SLICE_LEADS` | Slice leads (default 3)
| `GRAPHYARD_MAX_ENGINEERS_PER_LEAD` | Engineers per lead (default 2)
| `GRAPHYARD_MIN_REVIEWERS` | Reviewers with a lead (default 1)
| `GRAPHYARD_MAX_REVIEWERS` | ≥ `producer` count (default 2)

Installers derive these from the principals; an unset one is `delegationLimits` drift.

### CI producer

[CI proofs](github.md#proofs-in-ci) publish via one principal (refused `manual:*`, `e2e:*`):

```json
{"id":"ci-proofs","role":"producer","runtime":"github-actions","proofs":["unit:*","integration:*"],"token":"…"}
```

`GRAPHYARD_CI_PRODUCER_TOKEN`, `GRAPHYARD_URL`: default-branch-only `graphyard-reporting` environment. `scripts/configure-integrations.mjs --apply` merges `.graphyard/credentials.json` into the live roster (`--remove ID` drops a principal, `--rotate ID` rotates a producer, `--deploy` sets the GitHub secret).

### Production deployment observation

A new `GRAPHYARD_BUILD_SHA` checks undeployed merges once; one unserved after five minutes is a `delivery.deployment-incident` (shown in `master status`). Probe: `master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`.

## Backup, upgrade, rollback

**Backup:** `graphyard db backup ./graphyard.json` (with `DATABASE_URL`), `graphyard db verify FILE`. **Upgrade:** back up, deploy, check `/healthz` `commit`, run any [App-permission migration](install.md#upgrading-an-existing-installation). **Rollback** only to a same-schema-generation image. **Restore:** `graphyard db migrate` an empty database, then `graphyard db restore FILE` (retries deadlocks `40P01` up to 5 times).

## Manual fallback

Unsupported or existing deployments: set the variables table by hand, `node "$GRAPHYARD_CLI" github-setup https://YOUR-DOMAIN`, `doctor`.

- Compose: `cp .env.example .env`, replace secrets, `docker compose --profile full up -d`; TLS on 4310, Postgres private.
- Kubernetes: `helm install graphyard deploy/helm/graphyard --set secrets.existingSecret=graphyard-credentials …`.
- Railway: `railway init`, `railway add --database postgres`, set variables, `railway up`.
