<!-- page: Operate Graphyard | 1 | configure and serve -->
# Deployment

## The one command

```sh
node "$GRAPHYARD_CLI" install --provider compose --repo OWNER/REPO --apply
```

Preview with `--plan` first ([install](install.md)). Compose runs one stateless container and Postgres. `/healthz?strict` returns 503 for alerts. CI pulls Docker Hub images through `mirror.gcr.io`.

## Variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection. |
| `HOST`, `PORT` | Listen address, default `0.0.0.0:4310`. |
| `GITHUB_REPOSITORY`, `GITHUB_BASE_BRANCH` | Managed repository and base. |
| `GRAPHYARD_PRINCIPALS` | Principal roster: role and sessionKind. Human admin uses `human`; AI never holds admin. |
| `GRAPHYARD_REVIEWER_APPS` | Reviewer configuration. |
| `GRAPHYARD_GENERATED_FILES` | Generated-file paths. |
| `GRAPHYARD_REPOSITORY_POLICY` | Deployed repository policy. |
| `GRAPHYARD_BUILD_SHA` | Control-plane build commit. |
| `GRAPHYARD_ARTIFACT_BACKEND` | `postgres` or `s3`. |
| `GRAPHYARD_SIGNIN_CLAIM` | Sign-in claim configuration. |
| `GRAPHYARD_MAX_SLICE_LEADS` | Slice-lead limit, default 3. |
| `GRAPHYARD_MIN_REVIEWERS` | Reviewers with a lead, default 1. |
| `GRAPHYARD_MAX_REVIEWERS` | At least producer count, default 2. |

There is no remote-side token variable: the merge writer uses the [deploy key](install.md#step-3-deploy-key). CI posts proof runs under its producer identity; Graphyard does not read them back from GitHub.

### Production deployment observation

`master init --deployment-url …` sets the commit endpoint. Unserved merges after five minutes raise `delivery.deployment-incident`. `run.deploymentReuseMinutes` (15) permits reused observations. Self-upgrades [deploy](delivery.md) the tip before loop reload. The launcher runs the checkout's own code; every `up` removes stale `.graphyard/held-cli.json`, even when the loop is current.

### Serving the managed repository's app

Declare build, serve command and port on main in `.graphyard/serve.json`:

```json
{"build":["npm","run","build"],"serve":["npx","vite","preview","--host","127.0.0.1","--port","4400"],"port":4400}
```

The deploy supervisor builds main in a separate `.graphyard/` serve checkout with npm ci and the declared build. Only a passing build restarts serving; failures keep the previous build. The process must answer its own port: foreign holders fail and receive no case runs. Spawned PIDs remain tracked for restart.

If main is still served but the process died, the supervisor restarts the existing build. Each new serve runs its required cases and writes commit, URL, failure and verdict to `.graphyard/served.json`. Failed cases remain visible for [recovery](delivery.md#merge-trials); the serve pass keeps the app running.

Status/dashboard read that record; doctor reports unreachable declared apps. Without a declaration, only the remote-tracking ref updates: no checkout, build or serve.

### Deployment incident

If `/healthz` reports an old commit, read `install --logs`, diagnose the failure and use the [fallback](#manual-fallback) if needed. Environment name comes from `production.environment`, then `GRAPHYARD_PRODUCTION_ENVIRONMENT`, then `production`. `/api/github/*` is not served.

## Backup, upgrade, rollback

Back up with `graphyard db backup`, verify with `db verify`, and fence before a move with `db fence`. Restore with `db migrate` then `db restore`.

[Upgrade](install.md#upgrading-an-existing-installation) builds and restarts from the install's build worktree, checks the served SHA, then moves and pins the watched checkout. A failed deploy or health check restores the previous release when safe and leaves that checkout unchanged. Lease commands (`heartbeat`, `claim`, `complete`, `blocked`, `defer`) from a mismatched CLI commit warn and proceed; other commands refuse with the mismatch.

## Manual fallback

Set the variables, register a read-write deploy key, then run `doctor`. For Compose: `cp .env.example .env`, then `docker compose --profile full up -d`.

`master setup --apply` sets derivable variables and appends `.graphyard/setup-audit.jsonl`. Agents run host-doable steps; park refuses those asks. Personal sign-in, enrolment and browser profiles remain human.

Old `GRAPHYARD_REVERT_APPROVER_*` variables are unread; no main guard or revert approver remains.
