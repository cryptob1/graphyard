<!-- page: Operate Graphyard | 1 | variables, backups. -->
# Deployment

## The one command

One stateless container, Postgres: `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply` ([install](install.md)). Tag `vX.Y.Z` publishes `ghcr.io/cryptob1/graphyard:X.Y.Z`; alert on `/healthz?strict` (503 unhealthy). CI and release-candidate runners pull Docker Hub images through the `mirror.gcr.io` mirror.

## Variables

`DATABASE_URL`; `HOST`/`PORT` (`0.0.0.0`/`4310`); `GITHUB_REPOSITORY`/`GITHUB_BASE_BRANCH` (`owner/repo`/`main`); App `GITHUB_APP_ID`/`GITHUB_INSTALLATION_ID`/`GITHUB_PRIVATE_KEY` (or `_FILE`)/`GITHUB_WEBHOOK_SECRET`; trusted `GITHUB_CI_APP_IDS`; [reviewer](github.md#identity-bound-agent-review) `GRAPHYARD_REVIEWER_APPS`; [revert approver](delivery.md#pre-merge-gate-and-release-candidate-validation) `GRAPHYARD_REVERT_APPROVER_APP_ID`/`_INSTALLATION_ID`/`_PRIVATE_KEY` (or `_FILE`); `GRAPHYARD_GENERATED_FILES`; `GRAPHYARD_BUILD_SHA` (image commit); `RAILWAY_API_TOKEN`; `GRAPHYARD_ARTIFACT_BACKEND` (`postgres`/[`s3`](recovery.md#artifact-backends-capacity-and-migration)); `GRAPHYARD_SIGNIN_CLAIM` ([host](install.md#self-contained-host) single-use sign-in hash):

| Variable | Purpose
| --- | ---
| `GRAPHYARD_PRINCIPALS` | Principals JSON (`role`, `sessionKind`: operator `human`, retro-judging AI `admin` `ai`)
| `GRAPHYARD_MAX_SLICE_LEADS` | Slice leads (3)
| `GRAPHYARD_MAX_ENGINEERS_PER_LEAD` | Engineers per lead (2)
| `GRAPHYARD_MIN_REVIEWERS` | Reviewers with a lead (1)
| `GRAPHYARD_MAX_REVIEWERS` | ≥ `producer` count (2)

### CI producer

[CI proofs](github.md#proofs-in-ci) publish via one principal (`manual:*`, `e2e:*` refused):

```json
{"id":"ci-proofs","role":"producer","runtime":"github-actions","proofs":["unit:*","integration:*"],"token":"…"}
```

`GRAPHYARD_CI_PRODUCER_TOKEN`, `GRAPHYARD_URL` live in default-branch-only `graphyard-reporting` environment; `scripts/configure-integrations.mjs --apply` merges `.graphyard/credentials.json` into live roster (`--remove ID`, `--rotate ID`, `--deploy`).

### Production deployment observation

A merge unserved five minutes after new `GRAPHYARD_BUILD_SHA` is `delivery.deployment-incident`; before then, or mid-deploy, `production` shows `aheadBy`, `rollingOut: true`, no attention. Deployments: Railway's API (`RAILWAY_API_TOKEN`/`RAILWAY_TOKEN`), else GitHub deployments under [production environment name](#production-environment-name); failures link logs. A fresh `master verify-deployment` observation (`servingSource: endpoint`) outranks a lagging list; the build's `/healthz` commit (`servingSource: build`) outranks both. Probe: `master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`. Idle, the loop reuses its verified observation `run.deploymentReuseMinutes` (15; `0` every cycle).

Release lag and `loaded-revision` [resource](operations-reference.md#control-plane-resources) skip deliveries awaiting [promotion](delivery.md). Self-upgrades await production serving their target (`release-lagged`, `upgrade:held`); `.graphyard/held-cli.json` pins `bin/graphyard.mjs`, executors, restarted loops to it; pinned executors aren't split; an owed, retried restart is in motion.

Post-deploy the loop records throughput (`.graphyard/measurements/throughput`, `scripts/measure-throughput.mjs --record`), judging the serving release over the trailing 72 hours' deliveries (never pre-GY-87) minus operator-touched, grant-refused superseded idle, idle charged from window start; ≥20 all excluded, or ≥10 missing 48h+, escalates once/release (`escalation:throughput:GY-N:REV`).

### Deployment incident

Railway deploys `release/production` in a minute. `/healthz` `commit` at tip: `graphyard master verify-deployment GY-N` per pending delivery; else `railway deployment list --service graphyard --environment production` shows failures; redeploy tip ([manual fallback](#manual-fallback)), verify.

#### Production environment name

Railway reports `<project> / production`. Startup takes `production.environment` (run `productionEnvironment`), else `GRAPHYARD_PRODUCTION_ENVIRONMENT` (`.railway/railway.ts`), else `production`; applies at restart. Check: startup line `production observation via GitHub deployments to NAME` or `production.providerDescription`.

### Webhook delivery

Hosted: no `webhooks.lastDeliveryAt` an hour with a PR open → broken. `webhooks.settingsUrl` → Advanced deliveries: none → inactive; connection error/404 → URL ≠ `https://YOUR-HOST/api/github/webhook`; 401 → secret ≠ `GITHUB_WEBHOOK_SECRET`. Fix, redeliver.

## Backup, upgrade, rollback

**Backup:** `graphyard db backup ./graphyard.json` (with `DATABASE_URL`), `graphyard db verify FILE`; `graphyard db fence` before move (`--release` undoes). **Upgrade:** back up, deploy, check `/healthz` `commit`, run [App-permission migrations](install.md#upgrading-an-existing-installation); **rollback** only to same-schema images. **Restore:** `graphyard db migrate` empty database, `graphyard db restore FILE`.

## Manual fallback

Set the variables table; `node "$GRAPHYARD_CLI" github-setup https://YOUR-DOMAIN` and `doctor`.

- Compose: `cp .env.example .env`, replace secrets, `docker compose --profile full up -d`; TLS on 4310, Postgres private.
- Kubernetes: `helm install graphyard deploy/helm/graphyard --set secrets.existingSecret=graphyard-credentials …`.
- Railway: `railway init`, `railway add --database postgres`, variables, `railway up`. Production redeploy (no `init`), clean tip: `railway link --project graphyard --environment production --service graphyard`, `railway up`.
- Existing installs: `graphyard master setup` plans variables saved credentials derive; `--apply` sets them (Railway: `variable set --stdin`), audited in `.graphyard/setup-audit.jsonl`. No install record: `--provider railway --service graphyard --link-dir DIR`. `park` refuses host-doable asks (repository gh login administers, derived variable, held credential).
- Railway revert approver: `node scripts/provision-railway.mjs` sets `GRAPHYARD_REVERT_APPROVER_*` from `.graphyard/revert-approver.json` (0600) or `--revert-approver-stdin` (`--revert-approver-only`: only those). Redeploy; `--verify` exits 0 once the live guard names it.
