<!-- page: Operate Graphyard | 1 | versioned images, Railway, Docker Compose, the Helm chart, backups, upgrades, and restores. -->
# Deployment

If this is the first Graphyard installation for a repository, follow [Repository onboarding](onboarding.md) for the complete sequence through Herdr, the master, workers, and the first PR. This guide is the deployment reference for that path.

Graphyard ships one application Docker image and uses a separate Postgres service. The container serves the compiled UI, HTTP API, and reconciliation loop. It stores no durable application data on its filesystem. Worktrees live on worker machines, not inside the control-plane container.

## Versioned images

Every tagged release `vX.Y.Z` publishes `ghcr.io/cryptob1/graphyard:X.Y.Z` from `.github/workflows/release.yml`. The tag must equal the `package.json` version; the build stamps that version and the Git revision into the image (`GRAPHYARD_VERSION`, `GRAPHYARD_BUILD_REVISION`, and the matching `org.opencontainers.image.version` / `revision` labels), and the image is published only after `scripts/verify-image-release.mjs` has started it against an isolated database and confirmed the release contract: `/healthz` reports `{ok, version, revision, schema}`, `db status` shows the schema generation the release expects, and the shipped `db backup` / `db restore` commands carry a live ledger — an assignment under lease, its history — into a fresh database that then serves it unchanged. The same contract runs against every pull request's candidate image in CI.

Pin a digest where immutability matters: `docker image inspect --format '{{index .RepoDigests 0}}' ghcr.io/cryptob1/graphyard:X.Y.Z` after pulling, or the `image-digest` artifact on the release run. Build your own with the same stamps:

```sh
docker build --build-arg GRAPHYARD_VERSION=X.Y.Z --build-arg GRAPHYARD_BUILD_REVISION=$(git rev-parse HEAD) -t graphyard:X.Y.Z .
node scripts/verify-image-release.mjs graphyard:X.Y.Z X.Y.Z $(git rev-parse HEAD)
```

A running deployment names its release at `/healthz` without a credential and under `release` in authenticated `/api/status`, so an upgrade can be confirmed from outside the container.

## Railway

1. Create a Railway project and add Postgres.
2. Add an application service from this GitHub repository, using `main`.
3. Railway builds the root `Dockerfile`. `.railway/railway.ts` defines the application, Postgres, volume, health check, and restart policy. Review with `railway config plan` and apply with `railway config apply`.
4. Configure the variables below before deploying.
5. Generate a Railway domain for the app's HTTP port, and verify `/healthz` returns `{"ok":true,"version":…,"revision":…,"schema":…}` naming the release you deployed.
6. Configure the GitHub App webhook URL as `https://YOUR-DOMAIN/api/github/webhook`.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Reference `${{Postgres.DATABASE_URL}}` to use Railway private networking |
| `HOST` | `0.0.0.0` for Railway/container ingress |
| `PORT` | `4310`, or the port supplied by Railway |
| `GRAPHYARD_PRINCIPALS` | JSON array of principals: the human operator's `admin`, the master's `coordinator`, `slice-lead`, `worker`, `reader`, and `producer` credentials, each with a `sessionKind`. A producer's optional `proofs` allowlist scopes acceptance-evidence collection only; a separate optional `deploymentProviders` allowlist is what authorizes recording that provider's production deployments (see [shipping pulse](shipping-pulse.md)). Grant each lane to the credential that needs it rather than widening the other. |
| `GITHUB_REPOSITORY` | `owner/repository`; one repository per control plane |
| `GITHUB_BASE_BRANCH` | Usually `main` |
| `GITHUB_APP_ID` | Dedicated Graphyard GitHub App ID |
| `GITHUB_INSTALLATION_ID` | Installation ID for the managed repository |
| `GITHUB_PRIVATE_KEY` | Full PEM key in a secret variable; alternatively mount `GITHUB_PRIVATE_KEY_FILE` |
| `GITHUB_WEBHOOK_SECRET` | Random shared secret for GitHub signature verification |
| `GITHUB_CI_APP_IDS` | Comma-separated IDs of trusted CI Apps; verify the correct IDs in your installation |
| `GRAPHYARD_ARTIFACT_BACKEND` | Optional `postgres` (default) or `s3`; with `s3`, the `GRAPHYARD_ARTIFACT_S3_*` variables and optional `GRAPHYARD_ARTIFACT_CAPACITY_BYTES` described in [recovery](recovery.md#artifact-backends-capacity-and-migration) |
| `GRAPHYARD_PRODUCTION_ENVIRONMENT` | Optional deployment-provider environment name (default `production`) whose successful deployments end the [flow analytics](flow-analytics.md#the-production-environment) production phase |
| `GRAPHYARD_REVIEWER_APPS` | Optional JSON array registering reviewer GitHub App identities for [agent review](github.md#identity-bound-agent-review-providers); contains no secrets |

The app starts without GitHub credentials to allow setup, but merge gates remain closed. `GITHUB_REPOSITORY` alone is not an active integration.

Example CLI setup, using your installed Railway CLI:

```sh
railway init --name graphyard --workspace YOUR_WORKSPACE_ID
railway add --database postgres
railway add --service graphyard
railway variable set --service graphyard 'DATABASE_URL=${{Postgres.DATABASE_URL}}' HOST=0.0.0.0 PORT=4310
# Send GRAPHYARD_PRINCIPALS and GitHub secrets using Railway's dashboard or --stdin.
railway config plan
railway config apply
railway up --service graphyard --detach
railway domain --service graphyard --port 4310
```

Do not paste secrets into committed configuration, screenshots, or issue reports. Each worker should receive only its own token. The initial provisioning helper in `scripts/provision-railway.mjs` is specific to this project's personal Railway deployment; generic installs should follow the variables table.

For a multi-agent installation, add one `coordinator` principal for the recommended [master-agent operating mode](master-agent.md). This principal can read control-plane state and request the guarded merge but cannot claim work, revise requirements, or submit evidence. Keep its token in the master's ignored mode-0600 configuration. Give every concurrent implementation session a different `worker` principal.

The checked-in `.railway/railway.ts` describes this project's existing personal deployment, including preserved values. It is not a universal fresh-project template: adapt resource/source identities and supply your own secrets before planning a new installation. `preserve()` retains existing values; it does not generate credentials for new services.

## Docker Compose

```sh
cp .env.example .env
# Replace all example secrets.
docker compose --profile full up -d            # the versioned release image
docker compose --profile full up -d --build    # or the same image built from this checkout
```

The `server` service runs `ghcr.io/cryptob1/graphyard:X.Y.Z` for the checked-out version by default; set `GRAPHYARD_IMAGE` to pin another release or a digest, and use `--build` on a checkout whose version has not been tagged and published yet. The database volume `graphyard-data` holds durable state and `graphyard-backups` receives logical backups. Both published ports bind loopback by default. Put a TLS reverse proxy in front of port 4310 if remote workers need access. Never expose Postgres publicly just so agent sessions can connect; sessions use the HTTP API.

The sample Compose password is for local development. Set a unique database password for any shared installation and update `DATABASE_URL` accordingly.

## Kubernetes

`deploy/helm/graphyard` is the chart, and it follows the topology above: a stateless control-plane Deployment whose replicas share one Postgres ledger, a Service, an Ingress terminating TLS, and a Secret the pods read credentials from. There is no worktree volume. What the chart adds beyond wrapping the container:

- **Migrations before pods roll.** A `pre-upgrade` hook Job (also `pre-install` with an external database) runs `graphyard db migrate` from the image being rolled out. It applies the additive schema and records the generation it reached, and it refuses when the database was already migrated by a newer release — so a rollback under an unknown schema stops at the hook instead of replacing healthy pods.
- **Secrets by reference.** Set `secrets.existingSecret` to a Secret carrying `DATABASE_URL`, `GRAPHYARD_PRINCIPALS`, `GITHUB_PRIVATE_KEY` (mounted as a file; may be empty until GitHub is connected) and `GITHUB_WEBHOOK_SECRET`. The chart refuses to render with nowhere to hold credentials. `secrets.create=true` renders one from values for evaluation only.
- **Scheduled backups.** `backup.enabled=true` adds a CronJob running `graphyard db backup` onto a PersistentVolumeClaim, verifying each file and pruning after `backup.retainDays`. Use `backup.persistence.existingClaim` so the backups outlive the release.
- **Evaluation Postgres.** `postgresql.enabled=true` adds a single-replica StatefulSet on a PersistentVolumeClaim. Production points `DATABASE_URL` at managed Postgres with its own backups.
- **`helm test`.** The release's health test checks `/healthz` and that the running version is the one the chart deployed. The test pod is kept after it succeeds so `helm test --logs` shows what it saw; the next run replaces it.

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

Upgrade with `helm upgrade graphyard deploy/helm/graphyard --set image.tag=X.Y.Z …`; the hook migrates, then the Deployment rolls with `maxUnavailable: 0`. Pods run as a non-root user with a read-only root filesystem and no capabilities.

The chart's behaviour is exercised, not asserted: `deploy/helm/exercise.sh IMAGE` installs it on the current cluster with the evaluation database, runs `helm test`, seeds an assignment under lease through the API, upgrades to another image and checks that the ledger and its epoch survive the roll, takes a backup with the CronJob, uninstalls and deletes the database volume, reinstalls empty and restores the backup with a Job from the same image, then reads the ledger back. `.github/workflows/helm.yml` runs it on a kind cluster.

## Replicas and availability

API replicas share Postgres. Coordination locks and job leases live in the database; there is no sticky session requirement. Startup migrations acquire the same coordination lock and commit transactionally. For the MVP, migration DDL is additive/idempotent; future schema changes must use explicit ordered migrations before rollout.

`/healthz` checks database connectivity, not GitHub freshness. Monitor `/api/status` for integration job errors and check the delivery graph for stale observations. Keep one replica initially, then exercise the concurrency tests and load profile before scaling aggressively.

## Backup, upgrade, rollback

The ledger is in Postgres; backing up the application image is insufficient. Two kinds of backup apply, and neither replaces the other:

- **Physical/provider backups** — Railway's scheduled database backups, a managed Postgres provider's snapshots, or `pg_dump` with a client that matches the server's major version. Verify restoration in a separate project, and define retention to match the value of your work ledger.
- **Logical Graphyard backups** — `graphyard db backup FILE` on the control-plane host, which writes every ledger table from one consistent snapshot — work, history, credentials, validation state, releases with their approvals and deployment observations, and the proof-grant ledger with its append-only history — the serial sequences that order work, events, grant history and observations, the schema generation the rows were written at, and a digest over all of it. `graphyard db verify FILE` checks a file without touching a database. The format is what the documented upgrade and restore exercises are held to, and it is the one the Helm CronJob and the release verification use.

A backup holds private validation artifacts, evidence and credential hashes. Keep it where the database itself is allowed to be; the Compose volume and the chart's claim are private by default.

```sh
# Compose
docker compose exec server node bin/graphyard.mjs db backup /backups/graphyard-$(date -u +%Y%m%dT%H%M%SZ).json
# Kubernetes
kubectl exec deploy/graphyard-graphyard -- node bin/graphyard.mjs db backup /tmp/ledger.json
# Railway (any shell with DATABASE_URL for the database, and this checkout)
DATABASE_URL=… node bin/graphyard.mjs db backup ./graphyard.json
```

**Upgrade.** Run CI, take a backup, review the release notes for schema changes, then deploy the tested image: `GRAPHYARD_IMAGE=ghcr.io/cryptob1/graphyard:X.Y.Z docker compose --profile full up -d`, `helm upgrade --set image.tag=X.Y.Z`, or a Railway redeploy of `main`. The server applies the additive migration under the coordination lock on start (the chart runs it in a hook first), then records the schema generation. Validate `/healthz` — it names the new version — authenticated status, work counts and job recovery. Assignments, leases, event history, scenario revisions and pending validation requests are preserved across the upgrade; `tests/backup-restore.test.ts` and `scripts/verify-image-release.mjs` demonstrate this on every build. A release that declares a new GitHub App permission holds the jobs that need it and reports the shortfall in `graphyard doctor` (the `github-permissions` readiness item and `appPermissions`); complete the [App-permission migration](install.md#upgrading-an-existing-installation) after the image is up.

**Rollback.** Redeploy the previous known-good image only if its schema generation is the one the database carries. A release refuses to start — and the chart's hook refuses to roll — against a database a newer release migrated, because rolling back under an unknown schema is how columns and rows go missing silently. Roll forward instead, or restore a backup taken at the older generation into an empty database.

**Restore.** Restoring is a decision, not a retry. `graphyard db restore FILE` verifies the digest and generation, requires a database that is migrated and **empty**, inserts every table in one transaction, and sets the sequences so new work and history continue after the restored rows. It refuses a live ledger: restoring over current state would resurrect expired ownership beside current assignments and discard evidence submitted since the backup. Proof authority is part of what comes back: the grants the human operator's `admin` credential made inside Graphyard and the patterns it revoked are restored as recorded, and the release's bootstrap seed then finds every producer already materialized, so the environment allowlist cannot resurrect a revoked pattern. For the same reason the target must not have been started by a release with producers in `GRAPHYARD_PRINCIPALS` — that first start seeds proof grants, and the restore refuses the occupied table. To restore, stop the old deployment, provision a fresh database, migrate it with `graphyard db migrate` from the release that took the backup or a newer one (the chart's pre-install hook does this), restore, then start the release and validate `/api/work`, events, proof grants and pending validation requests before pointing workers at it.

The app responds to SIGTERM, stops scheduling new ticks, closes the HTTP server, and exits within ten seconds. An interrupted job is reclaimable after its 90-second database lease expires. External operations may repeat and must remain idempotent.
