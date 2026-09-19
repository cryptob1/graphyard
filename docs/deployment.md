<!-- page: Operate Graphyard | 1 | Railway, Docker Compose, backups, and upgrades. -->
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
| `GRAPHYARD_ARTIFACT_BACKEND` | Optional `postgres` (default) or `s3`; with `s3`, the `GRAPHYARD_ARTIFACT_S3_*` variables and optional `GRAPHYARD_ARTIFACT_CAPACITY_BYTES` described in [recovery](recovery.md#artifact-backends-capacity-and-migration) |
| `GRAPHYARD_PRODUCTION_ENVIRONMENT` | Optional deployment-provider environment name (default `production`) whose successful deployments end the [flow analytics](flow-analytics.md#the-production-environment) production phase |
| `GRAPHYARD_REVIEWER_APPS` | Optional JSON array registering reviewer GitHub App identities for [agent review](github.md#identity-bound-agent-review-providers); contains no secrets |
| `GRAPHYARD_MAX_SLICE_LEADS` | Slice-lead capacity; set it to at least the number of `slice-lead` principals (default 3). See [Delegation capacity variables](#delegation-capacity-variables) |
| `GRAPHYARD_MAX_ENGINEERS_PER_LEAD` | Active engineers per slice lead (default 2) |
| `GRAPHYARD_MIN_REVIEWERS` | Independent review/proof agents required once any slice lead exists (default 1) |
| `GRAPHYARD_MAX_REVIEWERS` | Review/proof agent capacity; set it to at least the number of `producer` principals, including the builder, observer and promoter deployment identities (default 2) |
| `GRAPHYARD_BUILD_SHA` | The 40-character commit the image was built from. Railway supplies `RAILWAY_GIT_COMMIT_SHA` automatically; other hosts set this from their build step so `/healthz`, `master status` and the version-skew guard know what production runs. See [Production deployment observation](#production-deployment-observation) |
| `RAILWAY_API_TOKEN` | Optional Railway account or team token that may read the linked service's deployment list; `RAILWAY_TOKEN` (a project token) is accepted instead. With either set, the control plane records failed and missing deployments of merged commits as delivery incidents. `RAILWAY_SERVICE_ID`, `RAILWAY_ENVIRONMENT_ID` and `RAILWAY_PROJECT_ID` are injected by Railway; set `GRAPHYARD_RAILWAY_SERVICE_ID` / `GRAPHYARD_RAILWAY_ENVIRONMENT_ID` only to watch a different service |

The app starts without GitHub credentials to allow setup, but merge gates remain closed. `GITHUB_REPOSITORY` alone is not an active integration.

### Delegation capacity variables

Every `producer` credential in `GRAPHYARD_PRINCIPALS` counts toward `GRAPHYARD_MAX_REVIEWERS` and every `slice-lead` toward `GRAPHYARD_MAX_SLICE_LEADS` ([slice-lead delegation](delegation.md#capacity-and-identity)). Set the four `GRAPHYARD_MAX_*`/`GRAPHYARD_MIN_*` variables explicitly, from the principal set you deploy: the default for each limit, widened to the number of principals of that role. Every installer adapter derives them that way (`delegationLimitAssignments` in `src/install/limits.ts`) from the principal set it deploys and writes them beside `GRAPHYARD_PRINCIPALS`: `scripts/provision-railway.mjs` from `.graphyard/credentials.json`, `scripts/configure-integrations.mjs` from those credentials plus the `trusted-acceptance` producer it generates, and `graphyard init --scan --apply` prints the lines to set (`capacity.lines`) for the principals it registers in `.graphyard/principals.json`; a Compose install puts the same lines in `.env`.

A variable that is unset does not refuse an installation that was already running. The server derives the missing limit from the principals it is configured with — the default, or the roster size when the roster is larger — starts, logs `Delegation limits: …`, and reports the derivation as drift under `delegationLimits` in `GET /api/status`, in `graphyard doctor`, and under `controlPlane.attention` in `graphyard master status`, each naming the variable and the value to set (for example `Set GRAPHYARD_MAX_REVIEWERS=4 on the deployment`). An explicit value that a growing roster has outgrown is reported the same way, and the server still starts as long as every over-limit principal is one this installation already ran with (the seeded proof-grant roster). Only a principal *added* beyond an explicit limit refuses start-up, with the same variable and value in the refusal, because that is a configuration the operator authored in the same change. Separation-of-duties rules — a producer bound to a slice, a lead sharing a credential — still refuse outright.

Re-running the installer after the principal set changes reports every deployed value that no longer covers the principals before it sets the corrected ones. Each adapter reads the deployed values from the running server's `delegationLimits.deployed` with the operator credential (`scripts/provision-railway.mjs` when `GRAPHYARD_URL` is set, `scripts/configure-integrations.mjs` at its fixed production URL, `init --apply` through the configured connection) and prints `Drift: …` for each; when the server cannot be read it says so instead of reporting no drift.

### Production deployment observation

Graphyard marks work Done when it observes the merge. Whether the merged commit reached production is observed separately by the control plane, every minute, and never gates anything:

- The running build identifies itself with `GRAPHYARD_BUILD_SHA` or Railway's `RAILWAY_GIT_COMMIT_SHA`; `/healthz` reports it as `commit` together with the merge `protocol` the server speaks.
- With a Railway token configured, the control plane reads the linked service's deployment list through Railway's GraphQL API after every reconciliation pass (bounded to one read a minute) and takes the newest successful deployment as what production serves; without one it falls back to its own build commit.
- Each delivery merged in the last 14 days is compared with the serving commit through the GitHub App (`compare`). A merge the provider reports as `FAILED` or `CRASHED` is a delivery incident immediately; a merge that is neither served nor being deployed five minutes after it landed is a `missing` incident. Incidents are append-only `delivery.deployment-incident` events on the delivered item, and a later serving deployment appends `delivery.deployment-recovered`; the server log announces each new incident once.
- `GET /api/status` carries `production`: the serving commit, how far the base branch is ahead of it, the newest provider deployment with its status, the pending and deployed items, and the open incidents. `graphyard master status` raises the same facts under `controlPlane.production` and, when main is ahead, as the attention line `main is N commits ahead of production (serving …): <failing deployment reason>`; `graphyard doctor` points at the first incident in `next`.

Point the master loop's own deployment probe at the same fact so delivered items record their deployment: `graphyard master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`.

Example CLI setup, using your installed Railway CLI:

```sh
railway init --name graphyard --workspace YOUR_WORKSPACE_ID
railway add --database postgres
railway add --service graphyard
railway variable set --service graphyard 'DATABASE_URL=${{Postgres.DATABASE_URL}}' HOST=0.0.0.0 PORT=4310
# Send GRAPHYARD_PRINCIPALS and GitHub secrets using Railway's dashboard or --stdin, then the
# capacity variables derived from that principal set (see Delegation capacity variables).
railway variable set --service graphyard GRAPHYARD_MAX_SLICE_LEADS=3 GRAPHYARD_MAX_ENGINEERS_PER_LEAD=2 GRAPHYARD_MIN_REVIEWERS=1 GRAPHYARD_MAX_REVIEWERS=4
railway config plan
railway config apply
railway up --service graphyard --detach
railway domain --service graphyard --port 4310
```

Do not paste secrets into committed configuration, screenshots, or issue reports. Each worker should receive only its own token. The initial provisioning helper in `scripts/provision-railway.mjs` is specific to this project's personal Railway deployment; generic installs should follow the variables table. The helper is safe to re-run after editing `.graphyard/credentials.json`: it derives the capacity variables from the principals, reports drift against the deployed values, and sets both.

For a multi-agent installation, add one `coordinator` principal for the recommended [master-agent operating mode](master-agent.md). This identity can read control-plane state but cannot claim work, revise requirements, or submit evidence. Keep its token in the master's ignored mode-0600 configuration. Give every concurrent implementation session a different `worker` principal.

The checked-in `.railway/railway.ts` describes this project's existing personal deployment, including preserved values. It is not a universal fresh-project template: adapt resource/source identities and supply your own secrets before planning a new installation. `preserve()` retains existing values; it does not generate credentials for new services. Every variable the adapters or the operator set by hand — the four capacity variables and `RAILWAY_API_TOKEN` included — is declared there with `preserve()`, so applying the configuration cannot drop them; declare any further variable you add the same way before `railway config apply`, and set it on the service first, as `preserve()` keeps a value but never creates one.

## Docker Compose

```sh
cp .env.example .env
# Replace all example secrets.
docker compose --profile full up -d --build
```

The database volume `graphyard-data` holds durable state. Both published ports bind loopback by default. Put a TLS reverse proxy in front of port 4310 if remote workers need access. Never expose Postgres publicly just so agents can connect; agents use the HTTP API.

The sample Compose password is for local development. Set a unique database password for any shared installation and update `DATABASE_URL` accordingly. Add the four capacity variables to `.env` from the principals you configure there (`GRAPHYARD_MAX_REVIEWERS` at least the number of producers), and set `GRAPHYARD_BUILD_SHA=$(git rev-parse HEAD)` in the same file when you build the image so the deployed commit is reported.

## Kubernetes

A Helm chart is not required for Railway. No chart ships in v0.1. A Kubernetes deployment would run this image with a managed Postgres endpoint, a Secret for credentials, an Ingress for TLS, and `/healthz` readiness. It would not need a worktree volume. We will add a tested chart when Kubernetes becomes a supported deployment target.

## Replicas and availability

API replicas share Postgres. Coordination locks and job leases live in the database; there is no sticky session requirement. Startup migrations acquire the same coordination lock and commit transactionally. For the MVP, migration DDL is additive/idempotent; future schema changes must use explicit ordered migrations before rollout.

`/healthz` checks database connectivity, not GitHub freshness, and reports the running `commit`. Monitor `/api/status` for integration job errors, `delegationLimits.attention`, and `production.incidents`, and check the delivery graph for stale observations. Keep one replica initially, then exercise the concurrency tests and load profile before scaling aggressively.

## Backup, upgrade, rollback

Enable scheduled Railway volume/database backups and verify restoration in a separate project. Define retention to match the value of your work ledger. Backing up the application image is insufficient; the ledger is in Postgres.

Before an upgrade: run CI, create a database backup, review migrations, then deploy the tested image. Validate health, authenticated status, work counts, and job recovery. A deployment that fails to start leaves the previous release serving and `/healthz` green; the control plane's own [production observation](#production-deployment-observation) is what reports it — `main is N commits ahead of production` in `master status` with the provider's failure — and `master merge` refuses with `deploy main first` when the CLI is ahead of the server's merge protocol. For an application rollback, redeploy the previous known-good image only if its schema remains compatible. Never blindly restore an old database over current assignments; that can resurrect expired ownership and discard evidence.

The app responds to SIGTERM, stops scheduling new ticks, closes the HTTP server, and exits within ten seconds. An interrupted job is reclaimable after its 90-second database lease expires. External operations may repeat and must remain idempotent.
