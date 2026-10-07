<!-- page: Operate Graphyard | 1 | variables, backups. -->
# Deployment

## The one command

One stateless container, Postgres: `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --apply` ([install](install.md)). Tag `vX.Y.Z` publishes `ghcr.io/cryptob1/graphyard:X.Y.Z`; alert on `/healthz?strict` (503 if unhealthy).

## Variables

`DATABASE_URL`; `HOST`/`PORT` (`0.0.0.0`/`4310`); `GITHUB_REPOSITORY`/`GITHUB_BASE_BRANCH` (`owner/repo`/`main`); App `GITHUB_APP_ID`/`GITHUB_INSTALLATION_ID`/`GITHUB_PRIVATE_KEY` (or `_FILE`)/`GITHUB_WEBHOOK_SECRET`; trusted `GITHUB_CI_APP_IDS`; [reviewer](github.md#identity-bound-agent-review) `GRAPHYARD_REVIEWER_APPS`; [revert approver](delivery.md#pre-merge-gate-and-release-candidate-validation) `GRAPHYARD_REVERT_APPROVER_APP_ID`/`_INSTALLATION_ID`/`_PRIVATE_KEY` (or `_FILE`); `GRAPHYARD_GENERATED_FILES`; `GRAPHYARD_BUILD_SHA` (image commit); optional `RAILWAY_API_TOKEN`; `GRAPHYARD_ARTIFACT_BACKEND` (`postgres`/[`s3`](recovery.md#artifact-backends-capacity-and-migration)); `GRAPHYARD_SIGNIN_CLAIM` ([host](install.md#self-contained-host) single-use sign-in hash); and:

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

`GRAPHYARD_CI_PRODUCER_TOKEN` and `GRAPHYARD_URL` live in default-branch-only `graphyard-reporting` environment; `scripts/configure-integrations.mjs --apply` merges `.graphyard/credentials.json` into the live roster (`--remove ID`, `--rotate ID`, `--deploy`).

### Production deployment observation

A merge unserved five minutes after a new `GRAPHYARD_BUILD_SHA` is a `delivery.deployment-incident`; until then, or with a provider attempt past the serving commit in flight, `production` shows `aheadBy`, `rollingOut: true`, no "main is N commits ahead of production" attention. With `release/production` (`GRAPHYARD_PRODUCTION_BRANCH`) production is measured against it (unpromoted merges: pipeline lag). Deployments: Railway's API (`RAILWAY_API_TOKEN`/`RAILWAY_TOKEN`), else App-read GitHub deployments under the [production environment name](#production-environment-name); in-flight holds incident, failed names log URL. A lagging list yields to a `master verify-deployment` endpoint observation of the exact release tip <15 min old, newer than its newest success, no failed or removed attempt there (`servingSource: endpoint`). The running build (`/healthz` commit) outranks it: holding the release tip or the list's newest success, it is served (`servingSource: build`), so lagging or mis-attributed records raise neither release-ahead attention nor missing incident; open ones recover (`verifiedBy: served-identity`); a build older than the record leaves the record serving. Missing incidents name that commit and the provider's report. Probe: `master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`. The loop reuses its last verified observation (no GitHub reads) for `run.deploymentReuseMinutes` (15; `master config deploymentReuseMinutes=N`, `0` reads every cycle) while nothing is pending.

Deliveries awaiting not-yet-due or validating [promotion](delivery.md) are skipped by release lag, `loaded-revision` [resource](operations-reference.md#control-plane-resources), naming `nextDueAt`, owing no restart; unavailable observations grant no grace. Sandboxed `systemctl --user` probes read supervision unverified, not absent, given cursor's packaged unit.

After verifying a deployment the loop (coordinator credential) measures GY-87's throughput claim on the served release over deliveries since GY-87's release began serving, into `.graphyard/measurements/throughput` (newest 30; same-millisecond records take `_N`), with backoff: an unverified release re-measured hourly, a verified one never. Every attempt (loop or `scripts/measure-throughput.mjs --record`), failed reads included, appends deliveries, timestamps, output and blocker to `ledger.json`, one writer at a time. 48 h after the first unverified attempt `master status` escalates the blocker (missing credentials, unreachable URL, or no session-free deliveries); only the first and last are the operator's.

### Deployment incident

Railway deploys `release/production` within a minute of promotion. `/healthz` `commit` at the tip: `graphyard master verify-deployment GY-N` per pending delivery; else `railway deployment list --service graphyard --environment production` shows a failed build; redeploy the tip (dashboard, [manual fallback](#manual-fallback)), await `/healthz`, verify.

#### Production environment name

Railway reports to GitHub as `<project> / production` (`graphyard / production`). Startup takes the ledger's master-published `production.environment` (run field `productionEnvironment`), else `GRAPHYARD_PRODUCTION_ENVIRONMENT` (`.railway/railway.ts`), else `production`; changes apply at restart. Check: startup line `production observation via GitHub deployments to NAME`, `/api/status` `production.providerDescription`.

## Backup, upgrade, rollback

**Backup:** `graphyard db backup ./graphyard.json` (with `DATABASE_URL`), `graphyard db verify FILE`; `graphyard db fence` before move (`--release` undoes). **Upgrade:** back up, deploy, check `/healthz` `commit`, run any [App-permission migration](install.md#upgrading-an-existing-installation); **rollback** only to same-schema-generation image. **Restore:** `graphyard db migrate` an empty database, then `graphyard db restore FILE`.

## Manual fallback

Set the variables table by hand, then `node "$GRAPHYARD_CLI" github-setup https://YOUR-DOMAIN` and `doctor`.

- Compose: `cp .env.example .env`, replace secrets, `docker compose --profile full up -d`; TLS on 4310, Postgres private.
- Kubernetes: `helm install graphyard deploy/helm/graphyard --set secrets.existingSecret=graphyard-credentials …`.
- Railway: `railway init`, `railway add --database postgres`, variables, `railway up`. Production redeploy: never `init`; clean tip checkout, `railway link --project graphyard --environment production --service graphyard`, then `railway up`.
- Existing installs: `graphyard master setup` plans missing variables saved credentials derive (bound reviewer App wins); `--apply` sets them via its adapter (Railway: `variable set --stdin`), printing fingerprints, auditing each (`.graphyard/setup-audit.jsonl`); an unread listing applies nothing. No install record: `--provider railway --service graphyard --link-dir DIR`. The loop applies it hourly, backing off failures. `park` refuses host-doable asks (repository the gh login administers, derived variable, held credential).
- Railway revert approver by hand: `node scripts/provision-railway.mjs` sets `GRAPHYARD_REVERT_APPROVER_*` from `.graphyard/revert-approver.json` (0600) or `--revert-approver-stdin`, refusing an armed guard without them; `--revert-approver-only` sets only those, from the reviewer App's record; a full run refuses if `GRAPHYARD_PRINCIPALS` holds principals `credentials.json` lacks or Railway's variables are unreadable. Redeploy; `--verify` (with `GRAPHYARD_URL`) exits 0 once the live guard names that App.
