<!-- page: Operate Graphyard | 1 | variables, backups. -->
# Deployment

## The one command

One stateless container, Postgres: `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply` ([install](install.md)). Tag `vX.Y.Z` publishes `ghcr.io/cryptob1/graphyard:X.Y.Z`; alert on `/healthz?strict` (503 if unhealthy).

## Variables

`DATABASE_URL`; `HOST`/`PORT` (`0.0.0.0`/`4310`); `GITHUB_REPOSITORY`/`GITHUB_BASE_BRANCH` (`owner/repo`/`main`); App `GITHUB_APP_ID`/`GITHUB_INSTALLATION_ID`/`GITHUB_PRIVATE_KEY` (or `_FILE`)/`GITHUB_WEBHOOK_SECRET`; trusted `GITHUB_CI_APP_IDS`; [reviewer](github.md#identity-bound-agent-review) `GRAPHYARD_REVIEWER_APPS`; [revert approver](delivery.md#pre-merge-gate-and-release-candidate-validation) `GRAPHYARD_REVERT_APPROVER_APP_ID`/`_INSTALLATION_ID`/`_PRIVATE_KEY` (or `_FILE`); `GRAPHYARD_GENERATED_FILES`; `GRAPHYARD_BUILD_SHA` (image commit); optional `RAILWAY_API_TOKEN`; `GRAPHYARD_ARTIFACT_BACKEND` (`postgres`/[`s3`](recovery.md#artifact-backends-capacity-and-migration)); `GRAPHYARD_SIGNIN_CLAIM` ([host](install.md#self-contained-host) single-use sign-in hash):

| Variable | Purpose
| --- | ---
| `GRAPHYARD_PRINCIPALS` | Principals JSON (`role`, `sessionKind`: operator `human`, retro-judging AI `admin` `ai`)
| `GRAPHYARD_MAX_SLICE_LEADS` | Slice leads (3)
| `GRAPHYARD_MAX_ENGINEERS_PER_LEAD` | Engineers per lead (2)
| `GRAPHYARD_MIN_REVIEWERS` | Reviewers with a lead (1)
| `GRAPHYARD_MAX_REVIEWERS` | ≥ `producer` count (2)

Installers derive limits; unset ones are `delegationLimits` drift.

### CI producer

[CI proofs](github.md#proofs-in-ci) publish via one principal (`manual:*`, `e2e:*` refused):

```json
{"id":"ci-proofs","role":"producer","runtime":"github-actions","proofs":["unit:*","integration:*"],"token":"…"}
```

`GRAPHYARD_CI_PRODUCER_TOKEN` and `GRAPHYARD_URL` live in default-branch-only `graphyard-reporting` environment; `scripts/configure-integrations.mjs --apply` merges `.graphyard/credentials.json` into live roster (`--remove ID`, `--rotate ID`, `--deploy`).

### Production deployment observation

A merge unserved five minutes after new `GRAPHYARD_BUILD_SHA` is `delivery.deployment-incident`; before then, or with a provider attempt in flight, `production` shows `aheadBy`, `rollingOut: true` and no "main is N commits ahead of production" attention. With `release/production` (`GRAPHYARD_PRODUCTION_BRANCH`) production is measured against it (unpromoted merges are pipeline lag). Deployments: Railway's API (`RAILWAY_API_TOKEN`/`RAILWAY_TOKEN`), else App-read GitHub deployments under [production environment name](#production-environment-name); in-flight holds the incident; a failed one names its log URL. A fresh `master verify-deployment` endpoint observation (`servingSource: endpoint`) outranks a lagging list; the running build's `/healthz` commit outranks both (`servingSource: build`). Probe: `master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`. Loop reuses last verified observation for `run.deploymentReuseMinutes` (15; `master config deploymentReuseMinutes=N`, `0` reads every cycle) while nothing is pending.

Deliveries awaiting not-yet-due or validating [promotion](delivery.md) are skipped by release lag and the `loaded-revision` [resource](operations-reference.md#control-plane-resources), naming `nextDueAt`.

After a verified deployment the loop measures throughput on the served release into `.graphyard/measurements/throughput` (`scripts/measure-throughput.mjs --record` too), excluding deliveries a master, operator or human hand touched; all ≥20 window deliveries excluded raises `escalation:throughput:GY-N:REV` once, and the loop files an owner item.

### Deployment incident

Railway deploys `release/production` within a minute of promotion. `/healthz` `commit` at tip: `graphyard master verify-deployment GY-N` per pending delivery; else `railway deployment list --service graphyard --environment production` shows failed build; redeploy tip (dashboard, [manual fallback](#manual-fallback)), await `/healthz`, verify.

#### Production environment name

Railway reports to GitHub as `<project> / production` (`graphyard / production`). Startup takes ledger's master-published `production.environment` (run field `productionEnvironment`), else `GRAPHYARD_PRODUCTION_ENVIRONMENT` (`.railway/railway.ts`), else `production`; changes apply at restart. Check: startup line `production observation via GitHub deployments to NAME`, `/api/status` `production.providerDescription`.

## Backup, upgrade, rollback

**Backup:** `graphyard db backup ./graphyard.json` (with `DATABASE_URL`), `graphyard db verify FILE`; `graphyard db fence` before move (`--release` undoes). **Upgrade:** back up, deploy, check `/healthz` `commit`, run any [App-permission migration](install.md#upgrading-an-existing-installation); **rollback** only to same-schema-generation image. **Restore:** `graphyard db migrate` empty database, then `graphyard db restore FILE`.

## Manual fallback

Set the variables table by hand, then `node "$GRAPHYARD_CLI" github-setup https://YOUR-DOMAIN` and `doctor`.

- Compose: `cp .env.example .env`, replace secrets, `docker compose --profile full up -d`; TLS on 4310, Postgres private.
- Kubernetes: `helm install graphyard deploy/helm/graphyard --set secrets.existingSecret=graphyard-credentials …`.
- Railway: `railway init`, `railway add --database postgres`, variables, `railway up`. Production redeploy: never `init`; clean tip checkout, `railway link --project graphyard --environment production --service graphyard`, `railway up`.
- Existing installs: `graphyard master setup` plans missing variables saved credentials derive; `--apply` sets them via adapter (Railway: `variable set --stdin`), printing fingerprints, auditing each (`.graphyard/setup-audit.jsonl`). No install record: `--provider railway --service graphyard --link-dir DIR`. Loop applies it hourly. `park` refuses host-doable asks (repository gh login administers, derived variable, held credential).
- Railway revert approver by hand: `node scripts/provision-railway.mjs` sets `GRAPHYARD_REVERT_APPROVER_*` from `.graphyard/revert-approver.json` (0600) or `--revert-approver-stdin` (`--revert-approver-only` sets only those, from the reviewer App's record). Redeploy; `--verify` (with `GRAPHYARD_URL`) exits 0 once the live guard names that App.
