# Deployment

If this is the first Graphyard installation for a repository, follow [Repository onboarding](onboarding.md) for the complete sequence through Herdr, the master, workers, and the first PR. This guide is the deployment reference for that path.

Graphyard ships one application Docker image and uses a separate Postgres service. The container serves the compiled UI, HTTP API, and reconciliation loop. It stores no durable application data on its filesystem. Worktrees live on worker machines, not inside the control-plane container.

## Railway

1. Create a Railway project and add Postgres.
2. Add an application service from this GitHub repository, using `main`.
3. Railway builds the root `Dockerfile`. `.railway/railway.ts` defines the application, Postgres, volume, health check, and restart policy. Review with `railway config plan` and apply with `railway config apply`.
4. Configure the variables below before deploying.
5. Generate a Railway domain for the app's HTTP port, and verify `/healthz` returns `{"ok":true}`.
6. Configure the GitHub App webhook URL as `https://YOUR-DOMAIN/api/github/webhook`.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Reference `${{Postgres.DATABASE_URL}}` to use Railway private networking |
| `HOST` | `0.0.0.0` for Railway/container ingress |
| `PORT` | `4310`, or the port supplied by Railway |
| `GRAPHYARD_PRINCIPALS` | JSON array of individual operator, coordinator, worker, reader, and proof-producer credentials. A producer's optional `proofs` allowlist scopes acceptance-evidence collection only; a separate optional `deploymentProviders` allowlist is what authorizes recording that provider's production deployments (see [shipping pulse](shipping-pulse.md)). Grant each lane to the credential that needs it rather than widening the other. |
| `GITHUB_REPOSITORY` | `owner/repository`; one repository per control plane |
| `GITHUB_BASE_BRANCH` | Usually `main` |
| `GITHUB_APP_ID` | Dedicated Graphyard GitHub App ID |
| `GITHUB_INSTALLATION_ID` | Installation ID for the managed repository |
| `GITHUB_PRIVATE_KEY` | Full PEM key in a secret variable; alternatively mount `GITHUB_PRIVATE_KEY_FILE` |
| `GITHUB_WEBHOOK_SECRET` | Random shared secret for GitHub signature verification |
| `GITHUB_CI_APP_IDS` | Comma-separated IDs of trusted CI Apps; verify the correct IDs in your installation |

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

For a multi-agent installation, add one `coordinator` principal for the recommended [master-agent operating mode](master-agent.md). This identity can read control-plane state but cannot claim work, revise requirements, or submit evidence. Keep its token in the master's ignored mode-0600 configuration. Give every concurrent implementation session a different `worker` principal.

The checked-in `.railway/railway.ts` describes this project's existing personal deployment, including preserved values. It is not a universal fresh-project template: adapt resource/source identities and supply your own secrets before planning a new installation. `preserve()` retains existing values; it does not generate credentials for new services.

## Docker Compose

```sh
cp .env.example .env
# Replace all example secrets.
docker compose --profile full up -d --build
```

The database volume `graphyard-data` holds durable state. Both published ports bind loopback by default. Put a TLS reverse proxy in front of port 4310 if remote workers need access. Never expose Postgres publicly just so agents can connect; agents use the HTTP API.

The sample Compose password is for local development. Set a unique database password for any shared installation and update `DATABASE_URL` accordingly.

## Kubernetes

A Helm chart is not required for Railway. No chart ships in v0.1. A Kubernetes deployment would run this image with a managed Postgres endpoint, a Secret for credentials, an Ingress for TLS, and `/healthz` readiness. It would not need a worktree volume. We will add a tested chart when Kubernetes becomes a supported deployment target.

## Replicas and availability

API replicas share Postgres. Coordination locks and job leases live in the database; there is no sticky session requirement. Startup migrations acquire the same coordination lock and commit transactionally. For the MVP, migration DDL is additive/idempotent; future schema changes must use explicit ordered migrations before rollout.

`/healthz` checks database connectivity, not GitHub freshness. Monitor `/api/status` for integration job errors and check the delivery graph for stale observations. Keep one replica initially, then exercise the concurrency tests and load profile before scaling aggressively.

## Backup, upgrade, rollback

Enable scheduled Railway volume/database backups and verify restoration in a separate project. Define retention to match the value of your work ledger. Backing up the application image is insufficient; the ledger is in Postgres.

Before an upgrade: run CI, create a database backup, review migrations, then deploy the tested image. Validate health, authenticated status, work counts, and job recovery. For an application rollback, redeploy the previous known-good image only if its schema remains compatible. Never blindly restore an old database over current assignments; that can resurrect expired ownership and discard evidence.

The app responds to SIGTERM, stops scheduling new ticks, closes the HTTP server, and exits within ten seconds. An interrupted job is reclaimable after its 90-second database lease expires. External operations may repeat and must remain idempotent.
