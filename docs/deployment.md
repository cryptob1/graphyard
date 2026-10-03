<!-- page: Operate Graphyard | 1 | variables, observation, backups. -->
# Deployment

## The one command

One stateless container plus Postgres: `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply` ([install](install.md)). Tag `vX.Y.Z` publishes `ghcr.io/cryptob1/graphyard:X.Y.Z`; `/healthz` reports version and `commit` (`?strict`: 503 if unhealthy).

## Variables

`DATABASE_URL`, `HOST`/`PORT` (`0.0.0.0`/`4310`), `GITHUB_REPOSITORY`/`GITHUB_BASE_BRANCH` (`owner/repo`/`main`), App `GITHUB_APP_ID`/`GITHUB_INSTALLATION_ID`/`GITHUB_PRIVATE_KEY` (or `_FILE`)/`GITHUB_WEBHOOK_SECRET`, trusted `GITHUB_CI_APP_IDS`, [reviewer](github.md#identity-bound-agent-review) `GRAPHYARD_REVIEWER_APPS`, `GRAPHYARD_GENERATED_FILES` (`node scripts/check-docs.mjs --list`), `GRAPHYARD_BUILD_SHA` (image commit, else `RAILWAY_GIT_COMMIT_SHA`), `GRAPHYARD_ARTIFACT_BACKEND` (`postgres` or [`s3`](recovery.md#artifact-backends-capacity-and-migration)), optional `RAILWAY_API_TOKEN` (deployment incidents), and:

| Variable | Purpose |
| --- | --- |
| `GRAPHYARD_PRINCIPALS` | Principals JSON (`role`, `sessionKind` each) |
| `GRAPHYARD_MAX_SLICE_LEADS` | Slice leads (default 3) |
| `GRAPHYARD_MAX_ENGINEERS_PER_LEAD` | Engineers per lead (default 2) |
| `GRAPHYARD_MIN_REVIEWERS` | Reviewers with a lead (default 1) |
| `GRAPHYARD_MAX_REVIEWERS` | ≥ `producer` count (default 2) |

Unset limits derive from the principals (`delegationLimits` drift).

### CI producer

[Proofs in CI](github.md#proofs-in-ci) publish through one principal (refused `manual:*`, `e2e:*`):

```json
{"id":"ci-proofs","role":"producer","runtime":"github-actions","proofs":["unit:*","integration:*"],"token":"…"}
```

`GRAPHYARD_CI_PRODUCER_TOKEN` and `GRAPHYARD_URL` live in the default-branch-only `graphyard-reporting` environment; `scripts/configure-integrations.mjs --apply` updates the roster.

### Production deployment observation

A merge unserved five minutes after a new `GRAPHYARD_BUILD_SHA` is a `delivery.deployment-incident`; `master status` reports `main is N commits ahead of production`. Probe: `master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`.

## Backup, upgrade, rollback

**Backup:** `graphyard db backup ./graphyard.json` (with `DATABASE_URL`), `graphyard db verify FILE`. **Upgrade:** back up, deploy, check `/healthz` `commit`, run any [App-permission migration](install.md#upgrading-an-existing-installation). **Rollback** only to a same-schema-generation image. **Restore:** `graphyard db migrate` an empty database, then `graphyard db restore FILE`.

## Manual fallback

Elsewhere: set the variables table by hand, run `node "$GRAPHYARD_CLI" github-setup https://YOUR-DOMAIN`, then `doctor`.

- Compose: `cp .env.example .env`, replace secrets, `docker compose --profile full up -d`; TLS on 4310, Postgres private.
- Kubernetes: `helm install graphyard deploy/helm/graphyard --set secrets.existingSecret=graphyard-credentials`.
- Railway: `railway init`, `railway add --database postgres`, set variables, `railway up`; `preserve()` them in `.railway/railway.ts`.
