<!-- page: Start here | 0 | install, upgrade. -->
# Install Graphyard

> install Graphyard for OWNER/REPO on PROVIDER following docs/install.md

Ask only: **Which provider**; **Provider login**; **Approval of the printed plan**. Graphyard registers no GitHub App; the merge writer pushes with the install deploy key.

## Hard rules

- **Never print, echo, `cat`, log, paste, or commit a credential.**
- **One principal per role** (`--workers N`); never share worker credentials.
- **Workers never receive an admin, coordinator, or producer credential.**
- **Proof producers get explicit grants only** (`--producer-proof NAME`).
- Credentials only under `$GRAPHYARD_CONFIG_HOME` (default `~/.config/graphyard`): plan's `installDirectory`, `init --apply`'s `workers/` (`0700`/`0600`).

## Preconditions

Node 24, `OWNER/REPO` checkout, `export GRAPHYARD_CLI=/abs/path/graphyard/bin/graphyard.mjs`, `gh auth status` scope `repo` as a repository admin, every provider (it registers the deploy key; `--observe-only` only reads); worker/non-Actions unit-proof hosts pass [`bwrap` probe](setup-from-zero.md#1-machine-prerequisites).

### Providers

- `railway`: `npm i -g @railway/cli`, `railway login`. Stamps `GRAPHYARD_BUILD_SHA` (unknown/dirty refuses), uploads `--path-as-root`; failed upload/unserved commit (10 min) fails `provider.deploy`.
- `hetzner`: `brew install hcloud`, `hcloud context create graphyard`; `--ssh-key NAME`/`--domain`. `manual:…install…-live` coordinators need `HCLOUD_TOKEN`, `HETZNER_SPEND_CAP_USD_MONTHLY` in repo-root `.env` (`0600`, uncommitted), optionally `HETZNER_SSH_KEY`.
- `docker-host`: `ssh USER@HOST 'curl -fsSL https://get.docker.com | sh'`; `--ssh-host`/`--domain`.
- `compose` (local): `curl -fsSL https://get.docker.com | sh`. Publishes `127.0.0.1:4310`, else first free port ≤4329, kept on reruns (`up`/`master init` use it); a taken `--port N` fails preflight. `up` failures' `next` carries last 20 redacted lines. Stale `already exists in network` endpoint: disconnected, retried once.
- `local` (`graphyard up --local`, no other `--provider`): no Docker; embedded Postgres (`npm install` without `--omit=optional`), cluster `INSTALL/postgres`; user unit `graphyard-local-INSTALL.service` migrates (`db migrate`), serves (no systemd: prints command).

## Step 1: plan and approve

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan
```

`--workers N`/`--producer-proof NAME`/`--required-check NAME` ([`init --scan`](operations-reference.md#setup-proposals-and-drift)); `delivery`/`release.*` plan [candidates](delivery.md#managed-repositories). **Verify** `secretsRedacted`, `preflight[].ok` (else `fix`; `HUMAN:` ones human's); human approves plan/`drift`. Elsewhere-bound plugins fail `Herdr plugin` until `--herdr-instance`/`--herdr-rebind`/`--no-herdr`. No GitHub App, webhook or branch protection is planned: `github.deploy-key` is the only GitHub step. `--github-app`, `--reuse-app`, `--reviewer`, `--no-github-app` and `app import|list|bind` are gone (unknown option). `--observe-only` (implies `--no-herdr`; refuses `--workers`/`--producer-proof`/`--target`, `--provider local`) deploys control-plane, rest `held` (deploy key included); Railway variables unread, checkout never uploaded; reruns: done steps `satisfied`. `up` prints Herdr's attach (`XDG_CONFIG_HOME=DIR herdr session attach NAME`). Own-instance session `graphyard-INSTALL` (`gy-HASH`, then directory, ≤107 socket-path bytes, else refused). No `--base-branch`: `master` if only `origin/master`. `compose` mounts main checkout (not worktrees) at `/repo` (`GRAPHYARD_REPOSITORY_ROOT`; unreadable: `/healthz` cause, `?strict` 503); the merge writer observes submitted heads there; reviews run as control-plane sessions.

## Step 2: apply

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

Writes credentials, [variables](deployment.md#variables); deploys; registers the deploy key; writes no branch protection. One apply at once (`apply.lock`, partials too; dead/pid-reused holders reclaimed). An install from before GY-2010 that recorded protection (`protection-record.json`) restores it with `--restore-protection --plan|--apply`, re-read-verified; unrecorded/unreadable/other-branch refuses. **Verify** `/healthz`.

## Step 3: deploy key

`--apply` generates `INSTALL/deploy-key` (ed25519, `0600`; a host generates its own, below) when absent and registers it read-write on OWNER/REPO with `gh repo deploy-key add` unless already listed (title `graphyard-merge-writer-HOST`). It is the only credential Graphyard holds on GitHub: Graphyard calls no GitHub API, mints no installation token and serves no webhook (`/api/github/webhook` is 404). The merge writer trial-merges each submitted head and pushes the base with it alone over an SSH origin; the loop re-registers a missing key each setup run. An install set up with an App may delete it, its rulesets and webhook; a bundle rewrite drops `GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRET` and `GRAPHYARD_REVERT_APPROVER_*`, which the control plane no longer reads. **Verify** `gh repo deploy-key list -R OWNER/REPO` lists it.

## Step 4: summary

**Verify** `health`, `deployKey`, `profiles.master.configured`, `status.role` `admin`; follow `nextSteps`; never read `tokenFile`.

## Step 5: first item

Dispatch a [small item](onboarding.md#4-prove-the-first-change); the merge writer trials and pushes it, no pull request involved.

## Principal roster

`principal add ID --role ROLE [--grant external-runs:import|delivery:observe-sha] [--proof unit:*|…] [--token-file PATH]`/`principal remove ID`: one non-installer `install.json` entry, kept by `--apply` (planned-ID collisions refuse); writes only `GRAPHYARD_PRINCIPALS`, reads back, idempotent, under `apply.lock`; producers need `--grant`/`--proof` ([lanes](validation.md#release-verdicts)); `--proof` needs its recorded grant (`grants grant`); `--token-file` reuses a credential (recorded IDs: fingerprint-matched; not self-contained). `delivery:observe-sha`: one dedicated principal, never moved (GY-1912+).

## Self-contained host

`--target host --ssh-host HOST` (or `--target hetzner`): server/Postgres/loop/executors/Herdr/runtimes on one systemd machine; credentials in `~graphyard/.config/graphyard/<install>/`. Public IPv4: `<ip>.sslip.io`, else `--domain`. Unpullable images build at installer's commit. The host generates the deploy key (`<install>/<install>/deploy-key`, never copied off), this machine's `gh` registers its public half, and the managed checkout is cloned over SSH with it; workers commit as Graphyard and push nothing. An older host's App token helper, `gh` wrapper and App key are removed. `--apply --profiles-only`: `master environments --apply` there.

Price: `--confirm-price`/`--max-monthly`; `--migrate` stops loop, fences `GRAPHYARD_MIGRATE_DATABASE_URL` (`db fence`), restores.

## Upgrading an existing installation

`graphyard upgrade [--to VERSION|stable] [--workspace RAILWAY] [--plan]`: needs clean checkout+`DATABASE_URL`+`GRAPHYARD_URL`; records release; checkout+`npm ci`/backup/recorded-roster redeploy/loop+executor restart/rescan+apply/healthy `/healthz`; refuses older schemas; failures name step/rollback (migrated: roll-forward). `--apply` fixes `delegationLimits` drift (`Set GRAPHYARD_MAX_REVIEWERS=N`), undeclared `sessionKind`.

## Failure handling

| Symptom | Action
| --- | ---
| `Preflight is incomplete` | run its `fix`
| `Railway workspace` `false` | `--workspace`
| `did not become healthy` | `install … --logs`
| `gh repo deploy-key` fails | `gh auth login --scopes repo` as a repository admin
| `Unknown option '--no-github-app'` (or another App flag) | drop it: no App is registered
| `Another install --apply` … `holds the lock` | let it finish, apply again
| `Generating the merge writer's deploy key` (host) | install `openssh-client` there, rerun
| `Cloning OWNER/REPO` (host) | `gh repo deploy-key list` shows the host's key, rerun
| `inside the managed repository` | `GRAPHYARD_CONFIG_HOME` outside worktrees
| fresh database (401) | `up` re-issues credentials, refiles onboarding/goal, archives cursor

## Agent execution contract

Run steps 1–5 (1, 2, 4 with `--observe-only`); never weaken gates.

## Manual fallback (unsupported platforms)

[Deployment](deployment.md#manual-fallback).
