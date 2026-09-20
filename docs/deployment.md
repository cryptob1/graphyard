<!-- page: Operate Graphyard | 1 | images, hosts, variables, backup, restore. -->
# Deployment

For whoever runs the control plane.

## Versioned images

- Every tagged release `vX.Y.Z` publishes `ghcr.io/cryptob1/graphyard:X.Y.Z`; the tag must equal the `package.json` version.
- The build stamps that version and the Git revision into the image as `GRAPHYARD_VERSION`, `GRAPHYARD_BUILD_REVISION` and the matching OCI labels.
- Publication happens only after `scripts/verify-image-release.mjs` confirms the release contract against an isolated database: `/healthz` reports `{ok, version, revision, schema}`, `db status` shows the expected schema generation, and `db backup`/`db restore` carry a live ledger into a fresh database that then serves it unchanged. The same contract runs against every candidate image.
- A running deployment names its release at `/healthz` without a credential and under `release` in authenticated `/api/status`. Pin a digest where immutability matters.

## Variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection; on Railway reference `${{Postgres.DATABASE_URL}}` |
| `HOST`, `PORT` | `0.0.0.0` for container ingress, and `4310` or the platform's port |
| `GRAPHYARD_PRINCIPALS` | JSON array of principals — the operator's `admin`, the master's `coordinator`, plus `slice-lead`, `worker`, `reader` and `producer` credentials, each with a `sessionKind`. A producer's optional `proofs` allowlist seeds acceptance-evidence authority only; a separate `deploymentProviders` allowlist authorizes recording that provider's production deployments |
| `GITHUB_REPOSITORY`, `GITHUB_BASE_BRANCH` | `owner/repository`, one per control plane, and usually `main` |
| `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID` | The dedicated App and its installation on the managed repository |
| `GITHUB_PRIVATE_KEY` | Full PEM in a secret variable, or mount `GITHUB_PRIVATE_KEY_FILE` |
| `GITHUB_WEBHOOK_SECRET` | Random shared secret for GitHub signature verification |
| `GITHUB_CI_APP_IDS` | Comma-separated IDs of trusted CI Apps; verify what your check runs report |
| `GRAPHYARD_REVIEWER_APPS` | Optional JSON array registering reviewer App identities for [agent review](github.md#trusted-producers-smoke-proof-and-review-providers); no secrets |
| `GRAPHYARD_GENERATED_FILES` | Comma-separated exact paths the regression guard treats as generated; unset, no file is exempt ([generated files](coordination.md#generated-files-never-conflict)) |
| `GRAPHYARD_PRODUCTION_ENVIRONMENT` | Deployment-provider environment (default `production`) whose successful deployments end the [flow analytics](flow-analytics.md) production phase |
| `GRAPHYARD_MAX_SLICE_LEADS` | [Capacity variable](#delegation-capacity-variables); default 3 |
| `GRAPHYARD_MAX_ENGINEERS_PER_LEAD` | Capacity variable; default 2 |
| `GRAPHYARD_MIN_REVIEWERS` | Capacity variable; default 1 |
| `GRAPHYARD_MAX_REVIEWERS` | Capacity variable; default 2 |
| `GRAPHYARD_BUILD_SHA` | The 40-character commit the image was built from; Railway supplies `RAILWAY_GIT_COMMIT_SHA` |
| `GRAPHYARD_ARTIFACT_BACKEND` | `postgres` (default) or `s3`, with `GRAPHYARD_ARTIFACT_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY`, optional `_PREFIX`, and `GRAPHYARD_ARTIFACT_CAPACITY_BYTES` ([artifact backends](recovery.md#artifact-backends-capacity-and-migration)) |
| `RAILWAY_API_TOKEN` | Optional account or team token that may read the linked service's deployment list (`RAILWAY_TOKEN`, a project token, is accepted instead), which lets the control plane record failed and missing deployments as incidents. `RAILWAY_SERVICE_ID`, `RAILWAY_ENVIRONMENT_ID` and `RAILWAY_PROJECT_ID` are injected by Railway; set `GRAPHYARD_RAILWAY_SERVICE_ID`, `GRAPHYARD_RAILWAY_ENVIRONMENT_ID` or `GRAPHYARD_RAILWAY_PROJECT_ID` to watch a different service and `GRAPHYARD_RAILWAY_API` to reach another endpoint |

### CI producer

`{ "id": "ci-proofs", "role": "producer", "runtime": "github-actions", "proofs": ["unit:*", "integration:*"], "token": "…" }` is the principal [proofs in CI](first-pr.md#proofs-in-ci) publish through. The `github-actions` runtime is what makes it the CI producer: the control plane accepts a `ciRun` binding only from it, refuses `manual:*` and `e2e:*` proofs from it whatever it is granted, and verifies every record against the GitHub job that produced it. Give it no `deploymentProviders`, no `slice` and no other capability; it counts toward `GRAPHYARD_MAX_REVIEWERS`. Its token is stored once more as the `GRAPHYARD_CI_PRODUCER_TOKEN` secret of the `graphyard-reporting` environment, after that environment is restricted to the default branch; `GRAPHYARD_URL` is the variable both reporters read, and rotating the token means redeploying the principal and setting the secret in one change.

### Changing the roster safely

`scripts/configure-integrations.mjs --apply` never rebuilds `GRAPHYARD_PRINCIPALS` from a local file. It reads the live roster from the host first and merges `.graphyard/credentials.json` into it by id — a local entry updates or adds a principal, every live principal it does not mention is kept — then previews each principal's id, role, change and token state (`unchanged`, `rotated`, `new`, `removed`), never a token. Before writing anything it refuses a roster that would drop or demote the coordinator, an admin or another live principal unless it is named with `--remove ID`. Generated producers keep their live tokens; `--rotate ID` rotates one. A changed producer token requires `--deploy`, which stages the variables, redeploys, waits until the deployed server authenticates the new token and only then sets its GitHub secret, so CI never holds a token the live roster rejects; a token the deployment does not serve in time is reported and its secret left unchanged. Every owed secret sync is recorded by producer id and token digest in the ignored `.graphyard/pending-secret-sync.json` and cleared only once set, so a rerun after a timed-out deployment still sets it. With no token change, nothing is deployed and no secret is touched.

### Delegation capacity variables

Every `producer` counts toward `GRAPHYARD_MAX_REVIEWERS` and every `slice-lead` toward `GRAPHYARD_MAX_SLICE_LEADS`. Set all four explicitly from the principal set you deploy which is what every installer adapter derives and writes beside `GRAPHYARD_PRINCIPALS`. An unset variable does not refuse a running installation: the server derives the limit, starts, logs it, and reports the derivation as drift under `delegationLimits` in `/api/status`, `doctor` and `master status`, naming the variable and the value to set. Only a principal *added* beyond an explicit limit refuses start-up, because that is a configuration the operator authored in the same change; separation-of-duties rules refuse outright.

## Hosts

**Railway.** Create a project with Postgres, add an application service from this repository on `main`, and let Railway build the root `Dockerfile`; `.railway/railway.ts` defines the application, Postgres, volume, health check and restart policy, reviewed with `railway config plan` and applied with `railway config apply`. Configure the variables, generate a domain, verify `/healthz`, and set the App webhook to `https://YOUR-DOMAIN/api/github/webhook`. The checked-in file describes this project's deployment rather than a universal template, and declares every hand-set variable with `preserve()`, which retains an existing value but never creates one.

**Docker Compose.** `cp .env.example .env`, replace every example secret, then `docker compose --profile full up -d` for the released `ghcr.io/cryptob1/graphyard:X.Y.Z` image, or `--build` to build this checkout. `GRAPHYARD_IMAGE` pins another release or digest. The volume `graphyard-data` holds durable state and `graphyard-backups` receives logical backups; both published ports bind loopback, so put a TLS reverse proxy in front of 4310 for remote workers and never expose Postgres publicly. Set a unique database password for any shared installation, add the four capacity variables to `.env`, and set `GRAPHYARD_BUILD_SHA=$(git rev-parse HEAD)` when you build so the deployed commit is reported.

**Kubernetes.** `deploy/helm/graphyard` is the chart: a stateless Deployment whose replicas share one Postgres ledger, a Service, an Ingress terminating TLS and a Secret, with no worktree volume. A `pre-upgrade` hook Job (also `pre-install` with an external database) runs `graphyard db migrate` from the image being rolled out and refuses when a newer release already migrated the database, so a rollback stops at the hook instead of replacing healthy pods. Point `secrets.existingSecret` at a Secret carrying `DATABASE_URL`, `GRAPHYARD_PRINCIPALS`, `GITHUB_PRIVATE_KEY` (mounted as a file, possibly empty) and `GITHUB_WEBHOOK_SECRET`; the chart refuses to render with nowhere to hold credentials, and `secrets.create=true` renders one for evaluation only. `backup.enabled=true` adds a CronJob running `graphyard db backup` onto a claim, verifying each file and pruning after `backup.retainDays`; `backup.persistence.existingClaim` makes backups outlive the release. `postgresql.enabled=true` adds an evaluation StatefulSet; production points `DATABASE_URL` at managed Postgres. `helm test` checks `/healthz` and that the running version is the one deployed, keeping the pod so `helm test --logs` shows what it saw. Upgrade with `helm upgrade … --set image.tag=X.Y.Z`: the hook migrates, then the Deployment rolls with `maxUnavailable: 0`, and pods run non-root with a read-only root filesystem and no capabilities. `deploy/helm/exercise.sh IMAGE` exercises install, `helm test`, a leased assignment across an upgrade, a CronJob backup, uninstall, reinstall and restore on a kind cluster through `.github/workflows/helm.yml`.

## Replicas and availability

API replicas share Postgres, with coordination locks and job leases in the database and no sticky-session requirement; startup migrations take the same lock and commit transactionally, and migration DDL is additive and idempotent. `/healthz` checks database connectivity, not GitHub freshness, and reports the running `commit`. Monitor `/api/status` for integration job errors, `delegationLimits.attention` and `production.incidents`. Keep one replica initially, then exercise the concurrency tests and load profile before scaling.

## Production deployment observation

Graphyard marks work Done when it observes the merge; whether that commit reached production is observed separately, every minute, and gates nothing. The running build identifies itself with `GRAPHYARD_BUILD_SHA` or `RAILWAY_GIT_COMMIT_SHA`, and `/healthz` reports it as `commit` with the merge `protocol` the server speaks. Each delivery merged in the last 14 days is compared with the serving commit through the App, and `GET /api/status` carries `production`: the serving commit, how far the base branch is ahead, the newest provider deployment with its status, the pending and deployed items, and the open incidents. Point the master loop's probe at the same fact with `master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`.

## After the merge

- A merged commit production never served is a **deployment incident**, recorded within five minutes: at once when the provider reports `FAILED` or `CRASHED`, and after a five-minute grace period when no deployment of the merge is observed. It is an append-only `delivery.deployment-incident` event, visible in `production.incidents`, in `doctor` as `next`, and in `master status` as `main is N commits ahead of production (serving …): <reason>`. `/healthz` stays green throughout, because the previous release is still serving.
- Read the reason and fix the deployment, not the ledger; a start-up refusal is printed verbatim and, for a capacity limit, names the variable and value to set. Revert the merge only if the change itself is wrong. When a deployment containing it serves, the watch appends `delivery.deployment-recovered`.
- `master merge` refusing with `server runs <sha>, CLI expects <sha>: deploy main first` means the CLI speaks a newer merge protocol than the deployed server. Without a Railway token the control plane still detects the miss from its own build commit and asks for `RAILWAY_API_TOKEN` in the incident reason.
- A delivery whose trusted smoke proof failed stays Done, marked **delivered with failure** and listed under `delivered` with `rollback` guidance naming the serving commit, the merge commit and the base branch. Choose between rolling the deployment back to the last release whose smoke proof passed and reverting the merge through a new work item under the same gates. Never backfill a pass and never delete the failure: a later run at the same deployed commit may supersede the verdict if the probe was at fault, and every run stays in the ledger. If the release moved on before the smoke ran, the item stays `awaiting-smoke`. Graphyard v0.1 executes no rollbacks or reverts itself.

## Backup, upgrade, restore

The ledger is in Postgres, so backing up the image is insufficient.

- **Physical or provider backups:** scheduled database backups, managed snapshots, or `pg_dump` with a matching client — should be restore-verified in a separate project.
- **Logical backups:** `graphyard db backup FILE` on the control-plane host — write every ledger table from one consistent snapshot, the serial sequences that order work, events, grant history and observations, the schema generation and a digest over all of it; `graphyard db verify FILE` checks a file without touching a database, and `graphyard db restore FILE` loads one into an empty database. That format is what the documented upgrade and restore exercises, the Helm CronJob and the release verification use.
- A backup holds private validation artifacts, evidence and credential hashes: keep it where the database itself is allowed to be.
