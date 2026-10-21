<!-- page: Operate Graphyard | 1 | variables -->
# Deployment

## The one command

One stateless container, Postgres: `node "$GRAPHYARD_CLI" install --provider compose --repo OWNER/REPO --apply` ([install](install.md)). `/healthz?strict` alerts (503); CI runners pull Docker Hub images through the `mirror.gcr.io` mirror.

## Variables

`DATABASE_URL`; `HOST`/`PORT` (`0.0.0.0`/`4310`); `GITHUB_REPOSITORY`/`GITHUB_BASE_BRANCH`; no remote-side credential variable (the merge writer pushes with the [deploy key](install.md#step-3-deploy-key)); `GRAPHYARD_REVIEWER_APPS`; `GRAPHYARD_GENERATED_FILES`/`GRAPHYARD_REPOSITORY_POLICY`; `GRAPHYARD_BUILD_SHA`; `GRAPHYARD_ARTIFACT_BACKEND` (`postgres`/`s3`); `GRAPHYARD_SIGNIN_CLAIM`:

| Variable | Purpose
| --- | ---
| `GRAPHYARD_PRINCIPALS` | Principals JSON (`role`, `sessionKind`: operator `human`, retro-judging AI `admin` `ai`)
| `GRAPHYARD_MAX_SLICE_LEADS` | Slice leads (3)
| `GRAPHYARD_MAX_ENGINEERS_PER_LEAD` | Engineers per lead (2)
| `GRAPHYARD_MIN_REVIEWERS` | Reviewers with a lead (1)
| `GRAPHYARD_MAX_REVIEWERS` | ≥ `producer` count (2)

CI proofs publish via one producer principal; its posted run binding is Graphyard's record of the job, never read back from the remote.

### Production deployment observation

A merge unserved five minutes after new `GRAPHYARD_BUILD_SHA` is `delivery.deployment-incident`; the serving commit comes from the configured endpoint (`master init --deployment-url …`). The loop reuses observations `run.deploymentReuseMinutes` (15). Self-upgrades [deploy](delivery.md) the tip first; `.graphyard/held-cli.json` pins the loop to a dirty checkout's snapshot.

### Deployment incident

`/healthz` `commit` behind tip: `install --logs` shows failures; redeploy ([manual fallback](#manual-fallback)). The serving environment name comes from `production.environment`, else `GRAPHYARD_PRODUCTION_ENVIRONMENT`, else `production`. `/api/github/webhook` is not served (404).

## Backup, upgrade, rollback

**Backup:** `graphyard db backup`, `db verify`, `db fence` before move. **Upgrade:** [upgrade](install.md#upgrading-an-existing-installation); the loop rolls failed deploys back. **Restore:** `db migrate`, `db restore`.

## Manual fallback

Set the variables table, register a read-write deploy key ([step 3](install.md#step-3-deploy-key)), then `doctor`. Compose: `cp .env.example .env`, `docker compose --profile full up -d`.
- `graphyard master setup` plans variables saved credentials derive; `--apply` sets them, audited in `.graphyard/setup-audit.jsonl`. `park` refuses host-doable asks (repository, derived variable, held credential, Confirm-access capture, coordinator checkout or unit record, agent identity); a person's sign-in, enrolment or browser profile stays human.
- No main guard or revert approver remains; leftover `GRAPHYARD_REVERT_APPROVER_*` are unread and may be deleted.
