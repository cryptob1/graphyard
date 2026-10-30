<!-- page: Operate Graphyard | 1 | variables -->
# Deployment

## The one command

One stateless container, Postgres: `node "$GRAPHYARD_CLI" install --provider compose --repo OWNER/REPO --apply` ([install](install.md)). `/healthz?strict` alerts (503); CI runners pull Docker Hub images through the `mirror.gcr.io` mirror.

## Variables

`DATABASE_URL`; `HOST`/`PORT` (`0.0.0.0`/`4310`); `GITHUB_REPOSITORY`/`GITHUB_BASE_BRANCH`; no remote-side credential variable (the merge writer pushes with the [deploy key](install.md#step-3-deploy-key)); `GRAPHYARD_REVIEWER_APPS`; `GRAPHYARD_GENERATED_FILES`/`GRAPHYARD_REPOSITORY_POLICY`; `GRAPHYARD_BUILD_SHA`; `GRAPHYARD_ARTIFACT_BACKEND` (`postgres`/`s3`); `GRAPHYARD_SIGNIN_CLAIM`:

| Variable | Purpose
| --- | ---
| `GRAPHYARD_PRINCIPALS` | Principals JSON (`role`, `sessionKind`: operator `human`, AI `admin` `ai`)
| `GRAPHYARD_MAX_SLICE_LEADS` | Slice leads (3)
| `GRAPHYARD_MIN_REVIEWERS` | Reviewers with a lead (1)
| `GRAPHYARD_MAX_REVIEWERS` | ≥ `producer` count (2)

CI proofs publish via one producer principal; its posted run binding is Graphyard's record of the job, never read back from the remote.

### Production deployment observation

A merge unserved five minutes after new `GRAPHYARD_BUILD_SHA` is `delivery.deployment-incident`; the serving commit comes from the configured endpoint (`master init --deployment-url …`). The loop reuses observations `run.deploymentReuseMinutes` (15). Self-upgrades [deploy](delivery.md) the tip first; `.graphyard/held-cli.json` pins the loop to a dirty checkout's snapshot.

### Serving the managed repository's app

A repository whose main declares `.graphyard/serve.json` gets its merged main built and served on a loopback port after every merge — no shell loop beside the install. The declaration names how to build the app and how to serve it:

```json
{ "build": ["npm", "run", "build"], "serve": ["npx", "vite", "preview", "--host", "127.0.0.1", "--port", "4400"], "port": 4400 }
```

(the Open City scaffold's declaration). The install's deploy unit (`graphyard-deploy`) checks each new main out into its own serve checkout under the managed root's local `.graphyard/` — never the coordinator's or a worker's checkout, and created only once a declaration exists — runs `npm ci` and the declared build, and restarts the declared serve command only when the build passed: a failing build keeps the previous build serving and is recorded, with why, in `.graphyard/served.json`. A serve counts as served only once it answers its port: one that cannot bind or fails to start is recorded as the failure it is, with nothing claimed served, and the process it spawned stays tracked for the next restart to stop. When the served commit is still main but nothing answers it (a reboot, a crashed serve), the pass serves the build the checkout already holds again and records the new process's pid, so the next restart stops the process that actually holds the port. Once a new commit serves, the pass live-verifies it: the commit's own required cases from its `e2e/cases/` run against the served URL, and the verdict is recorded in `.graphyard/served.json` for that exact commit — a failing case is the release health the master acts on, never a reason to stop serving or roll back. `master status`'s serving block and the dashboard's release line name the served commit, whether it is main, the URL, the last build failure, and the verdict — verified, the failing case and step, or not yet run; `doctor` prints a FAIL line naming the URL when a declared serve does not answer. A repository that declares no `serve.json` is untouched: the pass only fetches main into the managed root's remote-tracking ref — no serve checkout, no build, no serve, nothing recorded, nothing changed in any report.

### Deployment incident

`/healthz` `commit` behind tip: `install --logs` shows failures; redeploy ([manual fallback](#manual-fallback)). The serving environment name comes from `production.environment`, else `GRAPHYARD_PRODUCTION_ENVIRONMENT`, else `production`. `/api/github/*` is not served.

## Backup, upgrade, rollback

**Backup:** `graphyard db backup`, `db verify`, `db fence` before move. **Upgrade:** [upgrade](install.md#upgrading-an-existing-installation); the continuous deploy follows Graphyard's main: build and restart from the install's build worktree, `/healthz?strict` reporting the deployed commit, then the watched checkout moved to the served commit and pinned — a worker CLI's checkout, when the unit watches it, never leads the server (GY-2978) — and it rolls a failed deploy or health check back leaving the checkout as it was; a lease command (`heartbeat`, `claim`, `complete`, `blocked`, `defer`) run from a checkout the server does not match yet proceeds with a one-line warning, every other command refuses by name. **Restore:** `db migrate`, `db restore`.

## Manual fallback

Set the variables table, register a read-write deploy key ([step 3](install.md#step-3-deploy-key)), then `doctor`. Compose: `cp .env.example .env`, `docker compose --profile full up -d`.
- `graphyard master setup` plans variables saved credentials derive; `--apply` sets them, audited in `.graphyard/setup-audit.jsonl`. `park` refuses host-doable asks (repository, derived variable, held credential, Confirm-access capture, coordinator checkout or unit record, agent identity); a person's sign-in, enrolment or browser profile stays human.
- No main guard or revert approver remains; leftover `GRAPHYARD_REVERT_APPROVER_*` are unread and may be deleted.
