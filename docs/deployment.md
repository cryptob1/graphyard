<!-- page: Operate Graphyard | 1 | provider reference behind the installer: versioned images, the variables table, a manual fallback for Railway, Docker Compose and the Helm chart, backups, upgrades, and restores. -->
# Deployment

Graphyard is one stateless application container plus Postgres.

## The one command

```sh
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --plan
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply
```

[Install Graphyard](install.md) is the supported path. This page is the reference behind it.

## Versioned images

Tag `vX.Y.Z` (equal to `package.json`) publishes `ghcr.io/cryptob1/graphyard:X.Y.Z` after
`scripts/verify-image-release.mjs` passes against an isolated database. Pin a digest where
immutability matters. Build your own:

```sh
docker build --build-arg GRAPHYARD_VERSION=X.Y.Z --build-arg GRAPHYARD_BUILD_REVISION=$(git rev-parse HEAD) -t graphyard:X.Y.Z .
node scripts/verify-image-release.mjs graphyard:X.Y.Z X.Y.Z $(git rev-parse HEAD)
```

`/healthz` reports `{ok, version, revision, schema, commit}`.

## Provider reference

| Provider | Compute | Postgres | TLS |
| --- | --- | --- | --- |
| `railway` | service from the root `Dockerfile` | managed, `${{Postgres.DATABASE_URL}}` | Railway domain |
| `hetzner` | new server with a data volume | `postgres:17-alpine` on the volume | Caddy for `--domain` |
| `docker-host` | existing host over SSH | `postgres:17-alpine` | Caddy for `--domain` |
| `compose` | this machine | `postgres:17-alpine` | none; loopback |

`.railway/railway.ts` describes only this project's own deployment.

## Variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `HOST` / `PORT` | `0.0.0.0` / `4310` |
| `GRAPHYARD_PRINCIPALS` | JSON array of principals (`admin`, `coordinator`, `slice-lead`, `worker`, `reader`, `producer`), each with a `sessionKind`; a producer's `proofs` and `deploymentProviders` allowlists are separate lanes |
| `GITHUB_REPOSITORY` / `GITHUB_BASE_BRANCH` | `owner/repo` / `main` |
| `GITHUB_APP_ID` / `GITHUB_INSTALLATION_ID` | the control-plane App |
| `GITHUB_PRIVATE_KEY` | PEM, or mount `GITHUB_PRIVATE_KEY_FILE` (mode `0600`, owned by uid 1000) |
| `GITHUB_WEBHOOK_SECRET` | webhook signature secret |
| `GITHUB_CI_APP_IDS` | trusted CI App IDs |
| `GRAPHYARD_REVIEWER_APPS` | reviewer App identities for [agent review](github.md#identity-bound-agent-review-providers) |
| `GRAPHYARD_MAX_SLICE_LEADS` | slice-lead capacity (default 3) |
| `GRAPHYARD_MAX_ENGINEERS_PER_LEAD` | engineers per lead (default 2) |
| `GRAPHYARD_MIN_REVIEWERS` | independent reviewers once a lead exists (default 1) |
| `GRAPHYARD_MAX_REVIEWERS` | at least the number of `producer` principals (default 2) |
| `GRAPHYARD_GENERATED_FILES` | what `node scripts/check-docs.mjs --list` prints |
| `GRAPHYARD_BUILD_SHA` | commit the image was built from (Railway supplies `RAILWAY_GIT_COMMIT_SHA`) |
| `GRAPHYARD_DATABASE_MAX_BYTES` | volume size; `/healthz` goes unhealthy at it |
| `GRAPHYARD_ARTIFACT_BACKEND` | `postgres` or `s3` ([recovery](recovery.md#artifact-backends-capacity-and-migration)) |
| `RAILWAY_API_TOKEN` | optional; lets the plane record failed or missing deployments as incidents |

Without GitHub credentials the app starts but merge gates stay closed.

### CI producer

[Proofs in CI](github.md#proofs-in-ci) publish through one principal:

```json
{ "id": "ci-proofs", "role": "producer", "runtime": "github-actions", "proofs": ["unit:*", "integration:*"], "token": "…" }
```

It is refused `manual:*` and `e2e:*`; give it nothing else. Store its token as
`GRAPHYARD_CI_PRODUCER_TOKEN` on the `graphyard-reporting` environment (restricted to the default
branch) with `GRAPHYARD_URL` set; `graphyard init --scan --apply` prints the commands under
`ciProofs.next`.

`scripts/configure-integrations.mjs --apply` merges `.graphyard/credentials.json` into the
live roster by id, previews changes without tokens, and refuses to drop or demote a live principal
unless named with `--remove ID`. `--rotate ID` rotates one producer; a changed token needs
`--deploy`, which sets the GitHub secret only after the deployed server accepts the token.

### Delegation capacity variables

Installers derive the four limits from the deployed principals (default, widened to the role's
count). An unset limit is derived at start-up and reported as `delegationLimits` drift in
`doctor` and `master status`, e.g. `Set GRAPHYARD_MAX_REVIEWERS=4 on the deployment`; only a
principal newly added beyond an explicit limit refuses start-up. `GRAPHYARD_GENERATED_FILES` is
drift-checked against the manifest the same way.

### Production deployment observation

Every minute the plane compares recent merges with the serving commit (`GRAPHYARD_BUILD_SHA`,
or Railway's list with `RAILWAY_API_TOKEN`). A `FAILED`/`CRASHED` deployment, or a merge not
served five minutes later, appends a `delivery.deployment-incident`. `master status` shows
`main is N commits ahead of production`; `master merge` refuses with `deploy main first` when
the server is older than the CLI. Probe it from the master:
`graphyard master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`.

## Manual fallback

Only for an unsupported platform or an existing deployment. Set the variables listed above by
hand.

### Railway, by hand

```sh
railway init --name graphyard --workspace YOUR_WORKSPACE_ID
railway add --database postgres
railway add --service graphyard
railway variables --service graphyard --skip-deploys --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' --set HOST=0.0.0.0 --set PORT=4310
railway variable set --service graphyard --skip-deploys --stdin GRAPHYARD_PRINCIPALS
railway up --service graphyard --detach
railway domain --service graphyard --port 4310
```

Then run `node "$GRAPHYARD_CLI" github-setup https://YOUR-DOMAIN`, copy the App values into the
service, set the webhook to `https://YOUR-DOMAIN/api/github/webhook`, and configure protection
per [GitHub enforcement](github.md). Verify with `doctor` (`appPermissions.missing` empty).
Declare every hand-set variable with `preserve()` in `.railway/railway.ts` before `railway config
apply`. `scripts/provision-railway.mjs` serves this project's own deployment only.

### Docker Compose, by hand

```sh
cp .env.example .env    # replace every example secret, add the capacity variables
docker compose --profile full up -d
```

Set `GRAPHYARD_IMAGE` to pin a release. Ports bind loopback; put TLS in front of 4310 and never
expose Postgres.

### Kubernetes, with the Helm chart

```sh
kubectl create secret generic graphyard-credentials \
  --from-literal=DATABASE_URL='postgres://…' --from-literal=GRAPHYARD_PRINCIPALS='[…]' \
  --from-file=GITHUB_PRIVATE_KEY=./graphyard-app.pem --from-literal=GITHUB_WEBHOOK_SECRET='…'
helm install graphyard deploy/helm/graphyard \
  --set secrets.existingSecret=graphyard-credentials \
  --set config.githubRepository=OWNER/REPO --set config.githubAppId=… --set config.githubInstallationId=… \
  --set ingress.enabled=true --set ingress.hosts[0].host=graphyard.example.com --set backup.enabled=true
helm test graphyard
```

A pre-upgrade hook runs `graphyard db migrate`; `backup.enabled` adds a backup CronJob;
`postgresql.enabled` is for evaluation only. `deploy/helm/exercise.sh IMAGE` exercises the chart.

## Agent hosts: the managed worktree root

Hosts running `graphyard master run` keep checkouts under
`$GRAPHYARD_DATA_HOME/worktrees/REPOSITORY-ID` (override with `run.worktreeRoot`). Never on a
tmpfs; `master init` refuses one or less than `run.worktreeRootMinFreeGb` (default 2) free.
Allow about 200 MB per proof session. See [the managed worktree root](master-agent-reference.md#the-managed-worktree-root).

## Replicas and availability

Replicas share Postgres; no sticky sessions. `/healthz` answers 200 with `healthy` and `causes`
([resources](operations-reference.md#control-plane-resources)) and 500 only when the database is
unreachable; alert on `/healthz?strict` (503 when unhealthy). Monitor `/api/status` for job
errors, `delegationLimits.attention` and `production.incidents`.

## Backup, upgrade, rollback

```sh
docker compose exec server node bin/graphyard.mjs db backup /backups/graphyard-$(date -u +%Y%m%dT%H%M%SZ).json
DATABASE_URL=… node bin/graphyard.mjs db backup ./graphyard.json   # any host
node bin/graphyard.mjs db verify FILE
```

Also keep provider backups (Railway backups, volume snapshots). Backups hold secrets' hashes and
evidence; store them like the database.

**Upgrade:** back up, deploy the tested image (`GRAPHYARD_IMAGE=...:X.Y.Z docker compose --profile
full up -d`, `helm upgrade --set image.tag=X.Y.Z`, or a Railway redeploy), confirm `/healthz`
names the new commit, then finish any [App-permission migration](install.md#upgrading-an-existing-installation).

**Rollback:** only to an image with the database's schema generation; otherwise roll forward or
restore.

**Restore:** stop the old deployment, `graphyard db migrate` a fresh empty database, run
`graphyard db restore FILE` (it refuses a non-empty ledger), start, and check `/api/work`, events
and proof grants before pointing workers at it.
