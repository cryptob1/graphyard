<!-- page: Operate Graphyard | 1 | images, hosts, variables, backups. -->
# Deployment

For whoever runs the control plane: which variables, host and backup path to choose.

## Versioned images

- Every tagged release `vX.Y.Z` publishes `ghcr.io/cryptob1/graphyard:X.Y.Z`, the tag equal to the `package.json` version; the build stamps it and the Git revision into the image as `GRAPHYARD_VERSION`, `GRAPHYARD_BUILD_REVISION` and the matching OCI labels.
- Published only after `scripts/verify-image-release.mjs` confirms the release contract against an isolated database, as for every candidate image: `/healthz` reports `{ok, version, revision, schema}`, `db status` shows the expected schema generation, and `db backup`/`db restore` carry a live ledger into a fresh database that serves it unchanged.
- A running deployment names its release at `/healthz` without a credential and under `release` in `/api/status`; pin a digest where immutability matters.

## Variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection; on Railway reference `${{Postgres.DATABASE_URL}}` |
| `HOST`, `PORT` | `0.0.0.0` for container ingress; `4310` or the platform's port |
| `GRAPHYARD_PRINCIPALS` | JSON array of principals: `admin`, `coordinator`, `slice-lead`, `worker`, `reader` and `producer`, each with a `sessionKind`. A producer's optional `proofs` allowlist seeds acceptance-evidence authority only; `deploymentProviders` authorizes recording that provider's production deployments |
| `GITHUB_REPOSITORY`, `GITHUB_BASE_BRANCH` | `owner/repository`, one per control plane; usually `main` |
| `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID` | Dedicated App and its installation on the managed repository |
| `GITHUB_PRIVATE_KEY` | Full PEM in a secret variable, or mount `GITHUB_PRIVATE_KEY_FILE` |
| `GITHUB_WEBHOOK_SECRET` | Random shared secret for GitHub signature verification |
| `GITHUB_CI_APP_IDS` | Comma-separated IDs of trusted CI Apps; verify what your checks report |
| `GRAPHYARD_REVIEWER_APPS` | Optional JSON array registering reviewer App identities for [agent review](github.md#trusted-producers-smoke-proof-and-review-providers) |
| `GRAPHYARD_GENERATED_FILES` | Comma-separated paths the regression guard treats as generated — here `docs/protocol.md,docs/README.md`, what `node scripts/check-docs.mjs --list` prints; unset, none is exempt; an unparsable value refuses start-up ([generated files](coordination.md#generated-files-never-conflict)) |
| `GRAPHYARD_PRODUCTION_ENVIRONMENT` | Provider environment (default `production`) whose successful deployments end the [flow analytics](flow-analytics.md) production phase |
| `GRAPHYARD_MAX_SLICE_LEADS` | [Capacity variable](#delegation-capacity-variables); default 3 |
| `GRAPHYARD_MAX_ENGINEERS_PER_LEAD` | Capacity variable; default 2 |
| `GRAPHYARD_MIN_REVIEWERS` | Capacity variable; default 1 |
| `GRAPHYARD_MAX_REVIEWERS` | Capacity variable; default 2 |
| `GRAPHYARD_BUILD_SHA` | Commit the image was built from; Railway supplies `RAILWAY_GIT_COMMIT_SHA` |
| `GRAPHYARD_ARTIFACT_BACKEND` | `postgres` (default) or `s3`, with `GRAPHYARD_ARTIFACT_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, optional `_PREFIX`, and `GRAPHYARD_ARTIFACT_CAPACITY_BYTES` ([backends](recovery.md#artifact-backends-capacity-and-migration)) |
| `RAILWAY_API_TOKEN` | Optional account or team token reading the linked service's deployment list (`RAILWAY_TOKEN`, a project token, also works), so failed and missing deployments become incidents. Railway injects `RAILWAY_SERVICE_ID`, `RAILWAY_ENVIRONMENT_ID` and `RAILWAY_PROJECT_ID`; `GRAPHYARD_RAILWAY_SERVICE_ID`, `GRAPHYARD_RAILWAY_ENVIRONMENT_ID`, `GRAPHYARD_RAILWAY_PROJECT_ID` watch another service and `GRAPHYARD_RAILWAY_API` another endpoint |

### CI producer

- `{ "id": "ci-proofs", "role": "producer", "runtime": "github-actions", "proofs": ["unit:*", "integration:*"], "token": "…" }` is the principal [proofs in CI](github.md#proofs-in-ci) publish through.
- **`github-actions` runtime** makes it the CI producer: only from it is a `ciRun` binding accepted, `manual:*` and `e2e:*` refuse whatever it is granted, and every record is verified against the GitHub job.
- **Capabilities:** no `deploymentProviders`, no `slice`, no other capability; counts toward `GRAPHYARD_MAX_REVIEWERS`.
- **Token:** also the `GRAPHYARD_CI_PRODUCER_TOKEN` secret of the `graphyard-reporting` environment, set after restricting it to the default branch; both reporters read `GRAPHYARD_URL`. Rotation: redeploy the principal and set the secret in one change.

### Changing the roster safely

- `scripts/configure-integrations.mjs --apply` never rebuilds `GRAPHYARD_PRINCIPALS` from a local file: it reads the live roster and merges `.graphyard/credentials.json` into it by id, keeping every live principal the file omits.
- **Preview:** each id, role, change and token state (`unchanged`, `rotated`, `new`, `removed`), never a token.
- `--remove ID`: dropping or demoting the coordinator, an admin or another live principal is refused without it; `--rotate ID` rotates one.
- `--deploy`, required by a changed producer token: variables staged, service redeployed, GitHub secret set only once the deployed server authenticates the new token. With no token change nothing is deployed.
- **A token the deployment does not serve in time** is reported with its secret unchanged; the owed sync is recorded in the ignored `.graphyard/pending-secret-sync.json` until set.

### Delegation capacity variables

- **Every `producer`** counts toward `GRAPHYARD_MAX_REVIEWERS`, every `slice-lead` toward `GRAPHYARD_MAX_SLICE_LEADS`; set all four explicitly from the principal set you deploy, as every installer adapter does beside `GRAPHYARD_PRINCIPALS`.
- **An unset variable** does not refuse a running installation: the server derives the limit, starts, logs it and reports the derivation as drift under `delegationLimits` in `/api/status`, `doctor` and `master status`, naming the variable and value to set.
- Only a principal *added* beyond an explicit limit refuses start-up; separation-of-duties rules refuse outright.

### Generated-files variable

- **Derived alike by every installer** (`generatedFilesAssignment` in `src/install/generated-files.ts`) from the managed repository's manifest, written beside `GRAPHYARD_PRINCIPALS`: `scripts/provision-railway.mjs` and `scripts/configure-integrations.mjs` set it on the Railway service, `.railway/railway.ts` preserves it, `graphyard init --scan --apply` reports the line under `generatedFiles`, and `.env.example` declares it for Compose
- **Source:** the manifest JSON (`node scripts/check-docs.mjs --manifest`) wins whenever it parses; a well-formed `--list` line serves a script predating it; a failing script, prose or an unparsable value is refused with a clear message, and a repository without the script leaves the variable unset
- **Drift:** the deployed value is reported under `delegationLimits.deployed`; `master status` compares it with the manifest and raises the fix as an attention item (`Set GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md on the deployment`)

## Hosts

| Host | Bring it up | Specifics |
| --- | --- | --- |
| **Railway** | Project with Postgres, an application service from this repository on `main` building the root `Dockerfile`; `railway config plan`, then `railway config apply` | `.railway/railway.ts` defines the application, Postgres, volume, health check and restart policy, declaring every hand-set variable with `preserve()`, which retains an existing value but never creates one. Generate a domain, verify `/healthz`, point the App webhook at `/api/github/webhook` |
| **Docker Compose** | `cp .env.example .env`, replace every example secret, `docker compose --profile full up -d` (`--build` builds this checkout) | `GRAPHYARD_IMAGE` pins a release or digest; `graphyard-data` holds durable state and `graphyard-backups` the logical backups. Both published ports bind loopback, so put a TLS reverse proxy before 4310 and never expose Postgres; set a unique database password, the four capacity variables, and `GRAPHYARD_BUILD_SHA=$(git rev-parse HEAD)` when you build |
| **Kubernetes** | `deploy/helm/graphyard`: `helm upgrade … --set image.tag=X.Y.Z`, then `helm test` | Stateless Deployment over one Postgres ledger, a Service, a TLS Ingress and a Secret, no worktree volume. Details below |

- **The chart's `pre-upgrade` hook Job** (also `pre-install` with an external database) runs `graphyard db migrate` from the image being rolled out and refuses when a newer release already migrated the database, so a rollback stops at the hook instead of replacing healthy pods.
- `secrets.existingSecret`: a Secret carrying `DATABASE_URL`, `GRAPHYARD_PRINCIPALS`, `GITHUB_PRIVATE_KEY` (a file, possibly empty) and `GITHUB_WEBHOOK_SECRET`; the chart refuses to render with nowhere to hold credentials, and `secrets.create=true` renders one for evaluation only.
- `backup.enabled=true` adds a CronJob running `graphyard db backup` onto a claim, verifying each file and pruning after `backup.retainDays`, with `backup.persistence.existingClaim` outliving the release; `postgresql.enabled=true` adds an evaluation StatefulSet, production pointing `DATABASE_URL` at managed Postgres.
- `helm test` checks `/healthz` and the running version, keeping the pod for `--logs`; the Deployment rolls with `maxUnavailable: 0`, pods run non-root, read-only and without capabilities.
- `deploy/helm/exercise.sh IMAGE` exercises install, test, a leased assignment across an upgrade, a CronJob backup, uninstall, reinstall and restore on a kind cluster through `.github/workflows/helm.yml`.

## Replicas and availability

- **API replicas** share Postgres, with coordination locks and job leases in the database and no sticky sessions; startup migrations take the same lock and commit transactionally, over additive idempotent DDL.
- `/healthz` checks database connectivity, not GitHub freshness, and reports the running `commit`; monitor `/api/status` for integration job errors, `delegationLimits.attention` and `production.incidents`.
- **One replica** initially; exercise the concurrency tests and load profile before scaling.

## Production deployment observation

Work is Done when the merge is observed; whether that commit reached production is observed separately, every minute, and gates nothing.

- **Build:** `GRAPHYARD_BUILD_SHA` or `RAILWAY_GIT_COMMIT_SHA`; `/healthz` reports it as `commit` with the merge `protocol` the server speaks.
- **Each delivery** merged in the last 14 days is compared with the serving commit through the App, and `GET /api/status` carries `production`: the serving commit, how far the base branch is ahead, the newest provider deployment and its status, pending and deployed items, and open incidents.
- **Point the loop's probe** at the same fact with `master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`.

## After the merge

- A merged commit production never served is a **deployment incident**, recorded within five minutes: at once when the provider reports `FAILED` or `CRASHED`, after a five-minute grace period when no deployment of the merge is observed. An append-only `delivery.deployment-incident` event, visible in `production.incidents`, in `doctor` as `next` and in `master status` as `main is N commits ahead of production (serving …): <reason>`; `/healthz` stays green because the previous release is still serving. Fix the deployment, not the ledger: a start-up refusal is printed verbatim and, for a capacity limit, names the variable and value to set; revert the merge only if the change itself is wrong; when a deployment containing it serves, the watch appends `delivery.deployment-recovered`.
- `master merge` refusing with `server runs <sha>, CLI expects <sha>: deploy main first` means the CLI speaks a newer merge protocol than the deployed server.
- A delivery whose trusted smoke proof failed stays Done, marked **delivered with failure** and listed under `delivered` with `rollback` guidance naming the serving commit, the merge commit and the base branch: roll the deployment back to the last release whose smoke proof passed, or revert the merge through a new item under the same gates. Never backfill a pass and never delete the failure: a later run at the same deployed commit may supersede the verdict; if the release moved on before the smoke ran, the item stays `awaiting-smoke`. Graphyard v0.1 executes no rollbacks or reverts itself.

## Backup, upgrade, restore

The ledger is in Postgres, so backing up the image is insufficient.

- **Physical or provider backups:** scheduled database backups, managed snapshots or `pg_dump` with a matching client, restore-verified in a separate project.
- **Logical backups:** `graphyard db backup FILE` on the control-plane host writes every ledger table from one consistent snapshot, the serial sequences ordering work, events, grant history and observations, the schema generation and a digest over it all; `graphyard db verify FILE` checks a file without touching a database and `graphyard db restore FILE` loads one into an empty database. The documented upgrade, the Helm CronJob and the release verification use that format.
- A backup holds private validation artifacts, evidence and credential hashes: keep it where the database itself may be.
