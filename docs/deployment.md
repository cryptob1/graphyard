<!-- page: Operate Graphyard | 1 | variables, backups. -->
# Deployment

## The one command

One stateless container, Postgres: `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply` ([install](install.md)). Tag `vX.Y.Z` publishes `ghcr.io/cryptob1/graphyard:X.Y.Z`; `/healthz?strict` alerts (503 unhealthy). CI and release-candidate runners pull Docker Hub images through the `mirror.gcr.io` mirror.

## Variables

`DATABASE_URL`; `HOST`/`PORT` (`0.0.0.0`/`4310`); `GITHUB_REPOSITORY`/`GITHUB_BASE_BRANCH` (`owner/repo`/`main`); App `GITHUB_APP_ID`/`GITHUB_INSTALLATION_ID`/`GITHUB_PRIVATE_KEY` (or `_FILE`)/`GITHUB_WEBHOOK_SECRET`; trusted `GITHUB_CI_APP_IDS`; [reviewer](github.md#identity-bound-agent-review) `GRAPHYARD_REVIEWER_APPS`; [revert approver](delivery.md#pre-merge-gate-and-release-candidate-validation) `GRAPHYARD_REVERT_APPROVER_APP_ID`/`_INSTALLATION_ID`/`_PRIVATE_KEY` (or `_FILE`); `GRAPHYARD_GENERATED_FILES`/`GRAPHYARD_REPOSITORY_POLICY`; `GRAPHYARD_BUILD_SHA` (image commit); `RAILWAY_API_TOKEN`; `GRAPHYARD_ARTIFACT_BACKEND` (`postgres`/[`s3`](recovery.md#artifact-backends-capacity-and-migration)); `GRAPHYARD_SIGNIN_CLAIM` ([host](install.md#self-contained-host) single-use sign-in hash):

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

`GRAPHYARD_CI_PRODUCER_TOKEN`, `GRAPHYARD_URL` in default-branch-only `graphyard-reporting` environment; `scripts/configure-integrations.mjs --apply` merges `.graphyard/credentials.json` into live roster (`--remove ID`, `--rotate ID`, `--deploy`).

### Production deployment observation

A merge unserved five minutes after new `GRAPHYARD_BUILD_SHA` is `delivery.deployment-incident`; earlier or mid-deploy `production` shows `aheadBy`, `rollingOut: true`, no attention. Deployments: Railway's API (`RAILWAY_API_TOKEN`/`RAILWAY_TOKEN`), else GitHub's ([environment name](#production-environment-name)). A fresh `master verify-deployment` (`servingSource: endpoint`) outranks a lagging list, the build's `/healthz` commit (`servingSource: build`) both. Probe: `master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`. Idle, the loop reuses observations `run.deploymentReuseMinutes` (15; `0` every cycle).

Release lag and `loaded-revision` [resource](operations-reference.md#control-plane-resources) skip deliveries awaiting [promotion](delivery.md). Self-upgrades await production serving them (`release-lagged`, `upgrade:held`); `.graphyard/held-cli.json` pins `bin/graphyard.mjs`, executors, loops to it; held executors' owed restarts aren't faults.

Observing a release releases its post-deploy follow-ups (lacking operator-agent identity, deployment unrecorded); one awaiting its window is Up next. The loop records throughput, judging the serving release over trailing 72h merges less operator-touched and grant-refused superseded idle charged from window start; ≥20 all excluded, or ≥10 missing 48h+, escalates once/release on an owner item, requesting its unchanged-budget decision.

### Deployment incident

Railway deploys `release/production` in ~1min. `/healthz` `commit` at tip: `graphyard master verify-deployment GY-N` per pending delivery; else `railway deployment list --service graphyard --environment production` shows failures; redeploy ([manual fallback](#manual-fallback)), verify.

#### Production environment name

Railway reports `<project> / production`. Startup uses `production.environment`, else `GRAPHYARD_PRODUCTION_ENVIRONMENT`, else `github-pages` if workflows run `actions/deploy-pages`, else `production`; the loop publishes it.

### Webhook delivery

Hosted: `failing` ([liveness](operations-reference.md#webhook-liveness)) codes 0/404 → URL ≠ `https://YOUR-HOST/api/github/webhook`; 401 → secret ≠ `GITHUB_WEBHOOK_SECRET`. Fix, redeliver (`webhooks.settingsUrl` Advanced).

## Backup, upgrade, rollback

**Backup:** `graphyard db backup ./graphyard.json` (`DATABASE_URL`), `graphyard db verify FILE`; `graphyard db fence` before move (`--release` undoes). **Upgrade:** back up, deploy, check `/healthz` `commit`, run [App-permission migrations](install.md#upgrading-an-existing-installation); **rollback** only to same-schema images. **Restore:** `graphyard db migrate` empty database, `graphyard db restore FILE`.

## Manual fallback

Set the variables table; `node "$GRAPHYARD_CLI" github-setup https://YOUR-DOMAIN` and `doctor`.

- Compose: `cp .env.example .env`, set secrets, `docker compose --profile full up -d`; TLS on 4310, Postgres private.
- Kubernetes: `helm install graphyard deploy/helm/graphyard --set secrets.existingSecret=graphyard-credentials …`.
- Railway: `railway init`, `railway add --database postgres`, variables, `railway up`. Production redeploy (no `init`): `railway link --project graphyard --environment production --service graphyard`, `railway up`.
- `graphyard master setup` plans variables saved credentials derive; `--apply` sets them (Railway: `variable set --stdin`), audited in `.graphyard/setup-audit.jsonl`; no install record: `--provider railway --service graphyard --link-dir DIR`. `park` refuses host-doable asks (repository, derived variable, held credential, Confirm-access capture, coordinator checkout or unit record, agent identity); a person's sign-in, enrolment or browser profile stays human.
- Railway revert approver: `node scripts/provision-railway.mjs` sets `GRAPHYARD_REVERT_APPROVER_*` from `.graphyard/revert-approver.json` (0600) or `--revert-approver-stdin` (`--revert-approver-only`: only those). Redeploy; `--verify` exits 0 once the live guard names it.
