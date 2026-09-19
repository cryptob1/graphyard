<!-- page: Operate Graphyard | 1 | provider reference behind the installer: versioned images, the variables table, a manual fallback for Railway, Docker Compose and the Helm chart, backups, upgrades, and restores. -->
# Deployment

Graphyard is one application container plus Postgres. The container serves the compiled UI,
the HTTP API, and the reconciliation loop. It stores no durable application data on its
filesystem; worktrees live on worker machines, not inside the control-plane container.

## The one command

```sh
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --plan
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply
```

[Install Graphyard](install.md) is the supported path and the primary install
documentation. It provisions Postgres and the application, sets every variable, obtains an
HTTPS URL, completes the GitHub App and webhook, applies branch protection, registers agent
profiles, and verifies the result. This page is the reference behind it: what each provider
does, what every variable means, and how to operate the deployment afterwards.

## Versioned images

Every tagged release `vX.Y.Z` publishes `ghcr.io/cryptob1/graphyard:X.Y.Z` from `.github/workflows/release.yml`. The tag must equal the `package.json` version; the build stamps that version and the Git revision into the image (`GRAPHYARD_VERSION`, `GRAPHYARD_BUILD_REVISION`, and the matching `org.opencontainers.image.version` / `revision` labels), and the image is published only after `scripts/verify-image-release.mjs` has started it against an isolated database and confirmed the release contract: `/healthz` reports `{ok, version, revision, schema}`, `db status` shows the schema generation the release expects, and the shipped `db backup` / `db restore` commands carry a live ledger — an assignment under lease, its history — into a fresh database that then serves it unchanged. The same contract runs against every pull request's candidate image in CI.

Pin a digest where immutability matters: `docker image inspect --format '{{index .RepoDigests 0}}' ghcr.io/cryptob1/graphyard:X.Y.Z` after pulling, or the `image-digest` artifact on the release run. Build your own with the same stamps:

```sh
docker build --build-arg GRAPHYARD_VERSION=X.Y.Z --build-arg GRAPHYARD_BUILD_REVISION=$(git rev-parse HEAD) -t graphyard:X.Y.Z .
node scripts/verify-image-release.mjs graphyard:X.Y.Z X.Y.Z $(git rev-parse HEAD)
```

A running deployment names its release at `/healthz` without a credential and under `release` in authenticated `/api/status`, so an upgrade can be confirmed from outside the container.

## Provider reference

| Provider | Compute | Postgres | TLS | Provider login |
| --- | --- | --- | --- | --- |
| `railway` | Railway service built from the root `Dockerfile` | Railway managed Postgres, referenced as `${{Postgres.DATABASE_URL}}` | Railway domain | `railway login` |
| `hetzner` | Hetzner Cloud server created with a Docker cloud-init and an attached data volume | `postgres:17-alpine` on the volume | Caddy, automatic certificates for `--domain` | `hcloud context create graphyard` |
| `docker-host` | Any existing Docker host reached over SSH | `postgres:17-alpine` in the same Compose project | Caddy, automatic certificates for `--domain` | your SSH key |
| `compose` | This machine | `postgres:17-alpine` | none; loopback only | none |

On `railway`, the project is created without a terminal, so an account that belongs to more
than one workspace passes `--workspace NAME-OR-ID`; the plan's `Railway workspace` preflight
item lists the choices until one is given, and an account with a single workspace needs
nothing.

Every self-hosted provider runs the same Compose bundle: `db`, `server`, and — when the
deployment is reachable from outside — a `proxy` service terminating TLS. `hetzner` and
`docker-host` need `--domain` for a publicly trusted certificate; without one, Caddy issues
an internal certificate and the installer reports that the endpoint is not publicly trusted.

The installer never touches `.railway/railway.ts`. That file describes this project's own
personal Railway deployment, including preserved values, and is not a template for a fresh
installation. Kubernetes is not an installer provider; the [Helm chart](#kubernetes-with-the-helm-chart) below
is a manual path.

## Variables

The installer sets all of these. They are listed here so an operator can audit a running
deployment, and for the manual fallback below.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string; on Railway, reference `${{Postgres.DATABASE_URL}}` to use private networking |
| `HOST` | `0.0.0.0` for container ingress |
| `PORT` | `4310`, or the port supplied by the platform |
| `GRAPHYARD_PRINCIPALS` | JSON array of principals: the human operator's `admin`, the master's `coordinator`, `slice-lead`, `worker`, `reader`, and `producer` credentials, each with a `sessionKind`. A producer's optional `proofs` allowlist scopes acceptance-evidence collection only; a separate optional `deploymentProviders` allowlist is what authorizes recording that provider's production deployments (see [shipping pulse](shipping-pulse.md)). Grant each lane to the credential that needs it rather than widening the other. The [CI producer](#ci-producer) is the `producer` whose `runtime` is `github-actions`. |
| `GITHUB_REPOSITORY` | `owner/repository`; one repository per control plane |
| `GITHUB_BASE_BRANCH` | Usually `main` |
| `GITHUB_APP_ID` | Dedicated Graphyard GitHub App ID |
| `GITHUB_INSTALLATION_ID` | Installation ID for the managed repository |
| `GITHUB_PRIVATE_KEY` | Full PEM key in a secret variable; alternatively mount `GITHUB_PRIVATE_KEY_FILE` |
| `GITHUB_WEBHOOK_SECRET` | Shared secret for GitHub signature verification |
| `GITHUB_CI_APP_IDS` | Comma-separated IDs of trusted CI Apps; the installer discovers these from the checks published on the base branch |
| `GRAPHYARD_ARTIFACT_BACKEND` | Optional `postgres` (default) or `s3`; with `s3`, the `GRAPHYARD_ARTIFACT_S3_*` variables and optional `GRAPHYARD_ARTIFACT_CAPACITY_BYTES` described in [recovery](recovery.md#artifact-backends-capacity-and-migration) |
| `GRAPHYARD_PRODUCTION_ENVIRONMENT` | Optional deployment-provider environment name (default `production`) whose successful deployments end the [flow analytics](flow-analytics.md#the-production-environment) production phase |
| `GRAPHYARD_REVIEWER_APPS` | Optional JSON array registering reviewer GitHub App identities for [agent review](github.md#identity-bound-agent-review-providers); contains no secrets |
| `GRAPHYARD_MAX_SLICE_LEADS` | Slice-lead capacity; set it to at least the number of `slice-lead` principals (default 3). See [Delegation capacity variables](#delegation-capacity-variables) |
| `GRAPHYARD_MAX_ENGINEERS_PER_LEAD` | Active engineers per slice lead (default 2) |
| `GRAPHYARD_MIN_REVIEWERS` | Independent review/proof agents required once any slice lead exists (default 1) |
| `GRAPHYARD_MAX_REVIEWERS` | Review/proof agent capacity; set it to at least the number of `producer` principals, including the builder, observer and promoter deployment identities (default 2) |
| `GRAPHYARD_BUILD_SHA` | The 40-character commit the image was built from. Railway supplies `RAILWAY_GIT_COMMIT_SHA` automatically; other hosts set this from their build step so `/healthz`, `master status` and the version-skew guard know what production runs. See [Production deployment observation](#production-deployment-observation) |
| `RAILWAY_API_TOKEN` | Optional Railway account or team token that may read the linked service's deployment list; `RAILWAY_TOKEN` (a project token) is accepted instead. With either set, the control plane records failed and missing deployments of merged commits as delivery incidents. `RAILWAY_SERVICE_ID`, `RAILWAY_ENVIRONMENT_ID` and `RAILWAY_PROJECT_ID` are injected by Railway; set `GRAPHYARD_RAILWAY_SERVICE_ID` / `GRAPHYARD_RAILWAY_ENVIRONMENT_ID` only to watch a different service |

The app starts without GitHub credentials so that setup can proceed, but merge gates remain
closed. `GITHUB_REPOSITORY` alone is not an active integration.

### CI producer

[Proofs in CI](github.md#proofs-in-ci) publish through one dedicated producer principal that every installer provisions beside the others:

```json
{ "id": "ci-proofs", "role": "producer", "runtime": "github-actions", "proofs": ["unit:*", "integration:*"], "token": "…" }
```

`runtime: "github-actions"` is what makes it the CI producer: the control plane accepts a `ciRun` binding only from that principal, refuses `manual:*` and `e2e:*` proofs from it whatever it is granted, and verifies every record against the GitHub job that produced it (see [CI-produced evidence](protocol/evidence.md#ci-produced-evidence)). Give it no `deploymentProviders`, no `slice`, and no other capability. It counts toward `GRAPHYARD_MAX_REVIEWERS` like every producer.

Its token is stored once more, as the `GRAPHYARD_CI_PRODUCER_TOKEN` secret of the `graphyard-reporting` environment beside `GRAPHYARD_PRODUCER_TOKEN`, after that environment is restricted to the default branch; `GRAPHYARD_URL` is the environment variable both reporters read. `scripts/configure-integrations.mjs --apply` generates the principal, deploys it in `GRAPHYARD_PRINCIPALS`, derives the capacity variables from the roster including it, and stores the secret; `graphyard init --scan --apply` registers it in `.graphyard/principals.json` (keeping its token across re-runs) and prints the `gh secret set` and `gh variable set` commands under `ciProofs.next`. Rotating the token means redeploying the principal and setting the secret in the same change.

### Delegation capacity variables

Every `producer` credential in `GRAPHYARD_PRINCIPALS` counts toward `GRAPHYARD_MAX_REVIEWERS` and every `slice-lead` toward `GRAPHYARD_MAX_SLICE_LEADS` ([slice-lead delegation](delegation.md#capacity-and-identity)). Set the four `GRAPHYARD_MAX_*`/`GRAPHYARD_MIN_*` variables explicitly, from the principal set you deploy: the default for each limit, widened to the number of principals of that role. Every installer adapter derives them that way (`delegationLimitAssignments` in `src/install/limits.ts`) from the principal set it deploys and writes them beside `GRAPHYARD_PRINCIPALS`: `graphyard install` on every provider (the plan lists them under `provider.env.core`), this project's own Railway helpers under the [manual fallback](#manual-fallback) from `.graphyard/credentials.json` (plus the `trusted-acceptance` and `ci-proofs` producers the integrations helper generates), and `graphyard init --scan --apply` prints the lines to set (`capacity.lines`) for the principals it registers in `.graphyard/principals.json`, the CI producer included; a manual Compose install puts the same lines in `.env`.

A variable that is unset does not refuse an installation that was already running. The server derives the missing limit from the principals it is configured with — the default, or the roster size when the roster is larger — starts, logs `Delegation limits: …`, and reports the derivation as drift under `delegationLimits` in `GET /api/status`, in `graphyard doctor`, and under `controlPlane.attention` in `graphyard master status`, each naming the variable and the value to set (for example `Set GRAPHYARD_MAX_REVIEWERS=4 on the deployment`). An explicit value that a growing roster has outgrown is reported the same way, and the server still starts as long as every over-limit principal is one this installation already ran with (the seeded proof-grant roster). Only a principal *added* beyond an explicit limit refuses start-up, with the same variable and value in the refusal, because that is a configuration the operator authored in the same change. Separation-of-duties rules — a producer bound to a slice, a lead sharing a credential — still refuse outright.

Re-running the installer after the principal set changes reports every deployed value that no longer covers the principals before it sets the corrected ones. Each adapter reads the deployed values from the running server's `delegationLimits.deployed` with the human operator's `admin` credential (`graphyard install` from the variables it observes on the provider, reported as `drift` on `provider.env.core`; the Railway helpers when `GRAPHYARD_URL` is set or at their fixed production URL; `init --apply` through the configured connection) and prints `Drift: …` for each; when the server cannot be read it says so instead of reporting no drift.

### Production deployment observation

Graphyard marks work Done when it observes the merge. Whether the merged commit reached production is observed separately by the control plane, every minute, and never gates anything:

- The running build identifies itself with `GRAPHYARD_BUILD_SHA` or Railway's `RAILWAY_GIT_COMMIT_SHA`; `/healthz` reports it as `commit` together with the merge `protocol` the server speaks.
- With a Railway token configured, the control plane reads the linked service's deployment list through Railway's GraphQL API after every reconciliation pass (bounded to one read a minute) and takes the newest successful deployment as what production serves; without one it falls back to its own build commit.
- Each delivery merged in the last 14 days is compared with the serving commit through the GitHub App (`compare`). A merge the provider reports as `FAILED` or `CRASHED` is a delivery incident immediately; a merge that is neither served nor being deployed five minutes after it landed is a `missing` incident. Incidents are append-only `delivery.deployment-incident` events on the delivered item, and a later serving deployment appends `delivery.deployment-recovered`; the server log announces each new incident once.
- `GET /api/status` carries `production`: the serving commit, how far the base branch is ahead of it, the newest provider deployment with its status, the pending and deployed items, and the open incidents. `graphyard master status` raises the same facts under `controlPlane.production` and, when main is ahead, as the attention line `main is N commits ahead of production (serving …): <failing deployment reason>`; `graphyard doctor` points at the first incident in `next`.

Point the master loop's own deployment probe at the same fact so delivered items record their deployment: `graphyard master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`.

## Identities

Create a separate cryptographically random credential of at least 32 characters for each
role. The installer does this and stores each one under
`~/.config/graphyard/<install>/tokens/` with mode `0600`.

| Role | Use |
| --- | --- |
| `admin` | Setup, work creation, requirements, and recovery |
| `coordinator` | Master status and guarded merge authority |
| `worker` | One identity per concurrent implementation session |
| `reader` | Read-only dashboards |
| `producer` | Only the proof names that runner may submit |

Never give an implementation worker an admin, coordinator, or producer credential, and never
widen an existing producer's proof allowlist to another lane. Do not paste a credential into
committed configuration, a screenshot, or an issue report.

## Manual fallback

Use this only for a platform the installer does not support, or to adopt a deployment that
already exists. It sets exactly the variables listed above, by hand, with no verification
pass. The supported path is [install](install.md).

### Railway, by hand

```sh
railway init --name graphyard --workspace YOUR_WORKSPACE_ID
railway add --database postgres
railway add --service graphyard
railway variables --service graphyard --skip-deploys --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' --set HOST=0.0.0.0 --set PORT=4310
# Send GRAPHYARD_PRINCIPALS and the GitHub secrets over stdin, never as arguments, then the
# capacity variables derived from that principal set (see Delegation capacity variables):
railway variable set --service graphyard --skip-deploys --stdin GRAPHYARD_PRINCIPALS
railway variable set --service graphyard --skip-deploys GRAPHYARD_MAX_SLICE_LEADS=3 GRAPHYARD_MAX_ENGINEERS_PER_LEAD=2 GRAPHYARD_MIN_REVIEWERS=1 GRAPHYARD_MAX_REVIEWERS=4
railway config plan
railway config apply
railway up --service graphyard --detach
railway domain --service graphyard --port 4310
```

Then generate one token per role, assemble `GRAPHYARD_PRINCIPALS` yourself, run
`node "$GRAPHYARD_CLI" github-setup https://YOUR-DOMAIN` (the manifest requests exactly the
[declared control-plane permission set](github.md#app-permissions); install the App only on
the managed repository), copy the App values into the service, set the webhook URL to
`https://YOUR-DOMAIN/api/github/webhook`, and configure branch protection and CI App IDs as
described in [GitHub enforcement](github.md). Verify with `node "$GRAPHYARD_CLI" doctor`:
`appPermissions.missing` must be empty, and `/healthz` must return
`{"ok":true,"version":…,"revision":…,"schema":…}` naming the release you deployed.

Do not paste secrets into committed configuration, screenshots, or issue reports. Each worker should receive only its own token. The initial provisioning helper in `scripts/provision-railway.mjs` is specific to this project's personal Railway deployment; generic installs use `graphyard install`, and a manual install follows the variables table. The helper is safe to re-run after editing `.graphyard/credentials.json`: it derives the capacity variables from the principals, reports drift against the deployed values, and sets both.

For a multi-agent installation, add one `coordinator` principal for the recommended [master-agent operating mode](master-agent.md). This principal can read control-plane state and request the guarded merge but cannot claim work, revise requirements, or submit evidence. Keep its token in the master's ignored mode-0600 configuration. Give every concurrent implementation session a different `worker` principal.

The checked-in `.railway/railway.ts` describes this project's existing personal deployment, including preserved values. It is not a universal fresh-project template: adapt resource/source identities and supply your own secrets before planning a new installation. `preserve()` retains existing values; it does not generate credentials for new services. Every variable the adapters or the operator set by hand — the four capacity variables and `RAILWAY_API_TOKEN` included — is declared there with `preserve()`, so applying the configuration cannot drop them; declare any further variable you add the same way before `railway config apply`, and set it on the service first, as `preserve()` keeps a value but never creates one.

### Docker Compose, by hand

```sh
cp .env.example .env
# Replace all example secrets.
docker compose --profile full up -d            # the versioned release image
docker compose --profile full up -d --build    # or the same image built from this checkout
```

The `server` service runs `ghcr.io/cryptob1/graphyard:X.Y.Z` for the checked-out version by default; set `GRAPHYARD_IMAGE` to pin another release or a digest, and use `--build` on a checkout whose version has not been tagged and published yet. The database volume `graphyard-data` holds durable state and `graphyard-backups` receives logical backups. Both published ports bind loopback by default. Put a TLS reverse proxy in front of port 4310 if remote workers need access. Never expose Postgres publicly just so agent sessions can connect; sessions use the HTTP API.

The sample Compose password is for local development. Set a unique database password for any shared installation and update `DATABASE_URL` accordingly. Add the four capacity variables to `.env` from the principals you configure there (`GRAPHYARD_MAX_REVIEWERS` at least the number of producers), and set `GRAPHYARD_BUILD_SHA=$(git rev-parse HEAD)` in the same file when you build the image so the deployed commit is reported.

### Kubernetes, with the Helm chart

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

API replicas share Postgres. Coordination locks and job leases live in the database; there is
no sticky session requirement. Startup migrations acquire the same coordination lock and
commit transactionally. For the MVP, migration DDL is additive and idempotent; future schema
changes must use explicit ordered migrations before rollout.

`/healthz` checks database connectivity, not GitHub freshness, and reports the running
`commit`. Monitor `/api/status` for integration job errors, `delegationLimits.attention`, and
`production.incidents`, and check the delivery graph for stale observations. Keep one replica
initially, then exercise the concurrency tests and load profile before scaling aggressively.

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

**Upgrade.** Run CI, take a backup, review the release notes for schema changes, then deploy the tested image: `GRAPHYARD_IMAGE=ghcr.io/cryptob1/graphyard:X.Y.Z docker compose --profile full up -d`, `helm upgrade --set image.tag=X.Y.Z`, or a Railway redeploy of `main`. The server applies the additive migration under the coordination lock on start (the chart runs it in a hook first), then records the schema generation. Validate `/healthz` — it names the new version — authenticated status, work counts and job recovery. Assignments, leases, event history, scenario revisions and pending validation requests are preserved across the upgrade; `tests/backup-restore.test.ts` and `scripts/verify-image-release.mjs` demonstrate this on every build. A release that declares a new GitHub App permission holds the jobs that need it and reports the shortfall in `graphyard doctor` (the `github-permissions` readiness item and `appPermissions`); complete the [App-permission migration](install.md#upgrading-an-existing-installation) after the image is up. A deployment that fails to start leaves the previous release serving and `/healthz` green; the control plane's own [production observation](#production-deployment-observation) is what reports it — `main is N commits ahead of production` in `master status` with the provider's failure — and `master merge` refuses with `deploy main first` when the CLI is ahead of the server's merge protocol.

**Rollback.** Redeploy the previous known-good image only if its schema generation is the one the database carries. A release refuses to start — and the chart's hook refuses to roll — against a database a newer release migrated, because rolling back under an unknown schema is how columns and rows go missing silently. Roll forward instead, or restore a backup taken at the older generation into an empty database.

**Restore.** Restoring is a decision, not a retry. `graphyard db restore FILE` verifies the digest and generation, requires a database that is migrated and **empty**, inserts every table in one transaction, and sets the sequences so new work and history continue after the restored rows. It refuses a live ledger: restoring over current state would resurrect expired ownership beside current assignments and discard evidence submitted since the backup. Proof authority is part of what comes back: the grants the human operator's `admin` credential made inside Graphyard and the patterns it revoked are restored as recorded, and the release's bootstrap seed then finds every producer already materialized, so the environment allowlist cannot resurrect a revoked pattern. For the same reason the target must not have been started by a release with producers in `GRAPHYARD_PRINCIPALS` — that first start seeds proof grants, and the restore refuses the occupied table. To restore, stop the old deployment, provision a fresh database, migrate it with `graphyard db migrate` from the release that took the backup or a newer one (the chart's pre-install hook does this), restore, then start the release and validate `/api/work`, events, proof grants and pending validation requests before pointing workers at it.

On `hetzner`, the Postgres volume is the thing to snapshot; on `railway`, enable the managed
backups; a logical `graphyard db backup` complements either.

The app responds to SIGTERM, stops scheduling new ticks, closes the HTTP server, and exits
within ten seconds. An interrupted job is reclaimable after its 90-second database lease
expires. External operations may repeat and must remain idempotent.
