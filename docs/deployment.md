<!-- page: Operate Graphyard | 1 | provider reference behind the installer, the variables table, a manual fallback, backups, and upgrades. -->
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
installation.

## Variables

The installer sets all of these. They are listed here so an operator can audit a running
deployment, and for the manual fallback below.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string; on Railway, reference `${{Postgres.DATABASE_URL}}` to use private networking |
| `HOST` | `0.0.0.0` for container ingress |
| `PORT` | `4310`, or the port supplied by the platform |
| `GRAPHYARD_PRINCIPALS` | JSON array of individual admin, coordinator, worker, reader, and proof-producer credentials. A producer's optional `proofs` allowlist scopes acceptance-evidence collection only; a separate optional `deploymentProviders` allowlist is what authorizes recording that provider's production deployments (see [shipping pulse](shipping-pulse.md)). Grant each lane to the credential that needs it rather than widening the other. |
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

The app starts without GitHub credentials so that setup can proceed, but merge gates remain
closed. `GITHUB_REPOSITORY` alone is not an active integration.

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
# Send GRAPHYARD_PRINCIPALS and the GitHub secrets over stdin, never as arguments:
railway variable set --service graphyard --skip-deploys --stdin GRAPHYARD_PRINCIPALS
railway up --service graphyard --detach
railway domain --service graphyard --port 4310
```

Then generate one token per role, assemble `GRAPHYARD_PRINCIPALS` yourself, run
`node "$GRAPHYARD_CLI" github-setup https://YOUR-DOMAIN` (the manifest requests exactly the
[declared control-plane permission set](github.md#app-permissions); install the App only on
the managed repository), copy the App values into the service, set the webhook URL to
`https://YOUR-DOMAIN/api/github/webhook`, and configure branch protection and CI App IDs as
described in [GitHub enforcement](github.md). Verify with `node "$GRAPHYARD_CLI" doctor`:
`appPermissions.missing` must be empty.

### Docker Compose, by hand

```sh
cp .env.example .env
# Replace all example secrets.
docker compose --profile full up -d --build
```

The database volume `graphyard-data` holds durable state. Both published ports bind loopback
by default. Put a TLS reverse proxy in front of port 4310 if remote workers need access.
Never expose Postgres publicly just so agents can connect; agents use the HTTP API. The
sample Compose password is for local development only.

## Kubernetes

A Helm chart is not required for the supported providers, and none ships in v0.1. A
Kubernetes deployment would run this image with a managed Postgres endpoint, a Secret for
credentials, an Ingress for TLS, and `/healthz` readiness. It would not need a worktree
volume. We will add a tested chart when Kubernetes becomes a supported target.

## Replicas and availability

API replicas share Postgres. Coordination locks and job leases live in the database; there is
no sticky session requirement. Startup migrations acquire the same coordination lock and
commit transactionally. For the MVP, migration DDL is additive and idempotent; future schema
changes must use explicit ordered migrations before rollout.

`/healthz` checks database connectivity, not GitHub freshness. Monitor `/api/status` for
integration job errors and check the delivery graph for stale observations. Keep one replica
initially, then exercise the concurrency tests and load profile before scaling aggressively.

## Backup, upgrade, rollback

Enable scheduled database backups and verify restoration in a separate project. On
`hetzner`, the Postgres volume is the thing to snapshot; on `railway`, enable the managed
backups. Define retention to match the value of your work ledger. Backing up the application
image is insufficient; the ledger is in Postgres.

Before an upgrade: run CI, create a database backup, review migrations, then deploy the
tested image. Validate health, authenticated status, work counts, and job recovery. For an
application rollback, redeploy the previous known-good image only if its schema remains
compatible. Never blindly restore an old database over current assignments; that can
resurrect expired ownership and discard evidence.

The app responds to SIGTERM, stops scheduling new ticks, closes the HTTP server, and exits
within ten seconds. An interrupted job is reclaimable after its 90-second database lease
expires. External operations may repeat and must remain idempotent.
