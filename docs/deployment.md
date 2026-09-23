<!-- page: Operate Graphyard | 1 | images, variables. -->
# Deployment

For whoever runs the control plane: which variables, host and backup path to choose.

## Versioned images

- Every tagged release `vX.Y.Z` publishes `ghcr.io/cryptob1/graphyard:X.Y.Z`, the tag equal to the `package.json` version, stamped with `GRAPHYARD_VERSION`, `GRAPHYARD_BUILD_REVISION` and matching OCI labels — only after `scripts/verify-image-release.mjs` confirms the release contract against an isolated database: `/healthz` reports `{ok, version, revision, schema}`, `db status` the expected schema generation, and `db backup`/`db restore` carry a live ledger into a fresh database that serves it unchanged.
- A deployment names its release at `/healthz` without a credential and under `release` in `/api/status`; pin a digest where immutability matters.

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
| `GRAPHYARD_GENERATED_FILES` | Comma-separated paths the regression guard treats as generated: here `docs/protocol.md,docs/README.md`, what `node scripts/check-docs.mjs --list` prints; unset, none is exempt; an unparsable value refuses start-up ([generated files](coordination.md#generated-files-never-conflict)) |
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
- **`github-actions` runtime** makes it the CI producer: only from it is a `ciRun` binding accepted, `manual:*` and `e2e:*` refuse whatever it is granted, every record is verified against the GitHub job.
- **Capabilities:** no `deploymentProviders`, no `slice`, no other capability; counts toward `GRAPHYARD_MAX_REVIEWERS`.
- **Token:** also the `GRAPHYARD_CI_PRODUCER_TOKEN` secret of the `graphyard-reporting` environment, beside the trusted-acceptance reporter's `GRAPHYARD_PRODUCER_TOKEN`, set after restricting it to the default branch; both reporters read `GRAPHYARD_URL`, set on it too. Rotation: redeploy the principal and set the secret in one change.

### Changing the roster safely

- `scripts/configure-integrations.mjs --apply` never rebuilds `GRAPHYARD_PRINCIPALS` from a local file: it merges `.graphyard/credentials.json` into the live roster by id, keeping every live principal the file omits. The preview shows each id, role, change and token state (`unchanged`, `rotated`, `new`, `removed`), never a token.

### Delegation capacity variables

- **Every `producer`** counts toward `GRAPHYARD_MAX_REVIEWERS`, every `slice-lead` toward `GRAPHYARD_MAX_SLICE_LEADS`; set all four explicitly from the principal set you deploy, as every installer adapter does beside `GRAPHYARD_PRINCIPALS`.
- **An unset variable** does not refuse a running installation: the server derives the limit, starts, logs it and reports the derivation as drift under `delegationLimits` in `/api/status`, `doctor` and `master status`, naming the variable and value to set.
- Only a principal *added* beyond an explicit limit refuses start-up; separation-of-duties rules refuse outright.

### Generated-files variable

- **Derived alike by every installer** (`generatedFilesAssignment` in `src/install/generated-files.ts`) from the managed repository's manifest, written beside `GRAPHYARD_PRINCIPALS`: `scripts/provision-railway.mjs` and `scripts/configure-integrations.mjs` set it on the Railway service, `.railway/railway.ts` preserves it, `graphyard init --scan --apply` reports it under `generatedFiles`, `.env.example` declares it for Compose
- **Drift:** the deployed value is under `delegationLimits.deployed`, and `master status` raises the fix as an attention item (`Set GRAPHYARD_GENERATED_FILES=docs/protocol.md,docs/README.md on the deployment`)

## Hosts

- **Docker Compose:** `cp .env.example .env`, replace every example secret, `docker compose --profile full up -d` (`--build` builds this checkout). `GRAPHYARD_IMAGE` pins a release or digest; `graphyard-data` holds durable state, `graphyard-backups` the logical backups. Both published ports bind loopback: put a TLS reverse proxy before 4310, never expose Postgres, and set a unique database password, the four capacity variables and `GRAPHYARD_BUILD_SHA=$(git rev-parse HEAD)` when you build
- **Kubernetes:** `deploy/helm/graphyard`, `helm upgrade … --set image.tag=X.Y.Z`, then `helm test`: a stateless Deployment over one Postgres ledger, a Service, a TLS Ingress and a Secret, no worktree volume
  - The chart's `pre-upgrade` hook Job (also `pre-install` with an external database) runs `graphyard db migrate` from the image being rolled out and refuses when a newer release already migrated the database, so a rollback stops at the hook rather than replacing healthy pods.
  - `secrets.existingSecret` carries `DATABASE_URL`, `GRAPHYARD_PRINCIPALS`, `GITHUB_PRIVATE_KEY` (a file, possibly empty) and `GITHUB_WEBHOOK_SECRET`; the chart refuses to render with nowhere to hold credentials, and `secrets.create=true` renders one for evaluation only. `backup.enabled=true` adds a CronJob running `graphyard db backup` onto a claim, verifying each file and pruning after `backup.retainDays`, `backup.persistence.existingClaim` outliving the release; `postgresql.enabled=true` adds an evaluation StatefulSet, production pointing `DATABASE_URL` at managed Postgres.

## Agent hosts: the managed worktree root

Every host running `graphyard master run` holds the assignment worktrees under `.graphyard/worktrees` and every ephemeral proof and review checkout under the **managed worktree root**: durable storage sized for the sessions running at once (~200 MB each), never `/tmp`, whose tmpfs pays for each in memory against one host-wide quota.

| Setting in `.graphyard/master.json` | Meaning |
| --- | --- |
| `run.worktreeRoot` | Absolute root outside every worktree of the repository, one per checkout of it; default `worktrees/REPOSITORY-ID` under `GRAPHYARD_DATA_HOME` (default `~/.local/share/graphyard`), never from `XDG_DATA_HOME` or the temporary directory |
| `run.worktreeRootMinFreeGb` | Free space its volume must have, 0.1–10000; default 2 |
| `run.worktreeRootBudgetGb` | Size it may reach, 0.1–10000; default 10 |

- **Preflight:** `master init` and every launch refuse a tmpfs or ramfs root or a volume below the minimum, judging one that does not exist yet by its nearest existing ancestor; the first launch creates it
- **`disk.worktreeRoot`** in `master status` reports free space, size, checkouts and how many no live session owns, raising `graphyard master run --once` as an attention item below the minimum, at four fifths of the budget (a user quota free space never shows) or on a tmpfs root
- [What the loop creates there and removes](fleet.md#session-checkouts)

## Replicas and availability

- **One replica** initially; exercise the concurrency tests and load profile before scaling.

## Production deployment observation

Whether a merged commit reached production is observed separately, every minute, and gates nothing.

- **Build:** `GRAPHYARD_BUILD_SHA` or `RAILWAY_GIT_COMMIT_SHA`; `/healthz` reports it as `commit` with the merge `protocol` the server speaks.
- **Each delivery** merged in the last 14 days is compared with the serving commit through the App; `GET /api/status` carries `production`: serving commit, how far the base branch is ahead, newest provider deployment and its status, pending and deployed items, open incidents.
- **Point the loop's probe** at it with `master init --deployment-url https://YOUR-DOMAIN/healthz --deployment-sha-field commit`.

## After the merge

- A merged commit production never served is a **deployment incident**, recorded at once when the provider reports `FAILED` or `CRASHED`, after a five-minute grace when no deployment of the merge is observed. An append-only `delivery.deployment-incident` event shows in `production.incidents`, `doctor` (`next`) and `master status` as `main is N commits ahead of production (serving …): <reason>`, `/healthz` staying green on the previous release. Fix the deployment, not the ledger — a start-up refusal is printed verbatim and, for a capacity limit, names the variable and value to set — and revert the merge only if the change is wrong; `delivery.deployment-recovered` is appended once a deployment containing it serves.

## Backup, upgrade, restore

- **Logical backups:** `graphyard db backup FILE` on the control-plane host writes every ledger table from one consistent snapshot, the serial sequences ordering work, events, grant history and observations, the schema generation and a digest over it all; `graphyard db verify FILE` checks a file without touching a database, `graphyard db restore FILE` loads one into an empty database. The documented upgrade, Helm CronJob and release verification use that format.
- A backup holds private validation artifacts, evidence and credential hashes: store it like the database.
