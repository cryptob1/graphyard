<!-- page: Start here | 0 | install, upgrade. -->
# Install Graphyard

> install Graphyard for OWNER/REPO on PROVIDER following docs/install.md

Ask only: **Which provider**; **Provider login**; **GitHub App confirmation click**, once (none with `--no-github-app`/`--observe-only`); **Approval of the printed plan**. Never invent a fifth.

## Hard rules

- **Never print, echo, `cat`, log, paste, or commit a credential.**
- **One principal per role** (`--workers N`); never share a worker credential.
- **Workers never receive an admin, coordinator, or producer credential.**
- **Proof producers get explicit grants only** (`--producer-proof NAME`).
- Credentials only under `$GRAPHYARD_CONFIG_HOME` (default `~/.config/graphyard`): the plan's `installDirectory`, `workers/` from `init --apply` (directories `0700`, files `0600`).

## Preconditions

Node 24, `OWNER/REPO` checkout, `export GRAPHYARD_CLI=/abs/path/graphyard/bin/graphyard.mjs`, admin `gh auth status` with scope `repo` (and `admin:repo_hook` except compose/local; `--no-github-app` needs `gh` only for release-candidate `release.*`); worker and non-Actions unit-proof hosts pass [`bwrap` probe](setup-from-zero.md#1-machine-prerequisites).

### Providers

- `railway`: `npm i -g @railway/cli`, `railway login`.
- `hetzner`: `brew install hcloud`, `hcloud context create graphyard`; `--ssh-key NAME`, `--domain`. `manual:…install…-live` coordinators need `HCLOUD_TOKEN`, `HETZNER_SPEND_CAP_USD_MONTHLY` in repo-root `.env` (`0600`, uncommitted); optional `HETZNER_SSH_KEY` (else throwaway).
- `docker-host`: `ssh USER@HOST 'curl -fsSL https://get.docker.com | sh'`; `--ssh-host`, `--domain`.
- `compose` (local): `curl -fsSL https://get.docker.com | sh`. Polls GitHub, skipping webhook steps; publishes `127.0.0.1:4310`, else the first free port to 4329, kept on reruns (`up`, `master init` use it); a taken `--port N` fails preflight. Under `up`, a failed step's `next` carries its last 20 redacted lines. A stale `already exists in network` endpoint is disconnected, `up` retried once; others stand.
- `local` (`graphyard up --local`, not with another `--provider`): no Docker; embedded Postgres (`npm install` without `--omit=optional`), cluster in `INSTALL/postgres`; user unit `graphyard-local-INSTALL.service` starts, migrates (`db migrate`) and serves it (no systemd: prints foreground command). Polls GitHub like compose.

## Step 1: plan and approve

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan
```

`--workers N`/`--producer-proof NAME`/`--required-check NAME` ([`init --scan`](operations-reference.md#setup-proposals-and-drift)); `delivery`/`release.*` plan [candidates](delivery.md#managed-repositories). **Verify** `secretsRedacted`, `preflight[].ok` (else `fix`; a `HUMAN:` `fix` is the human's); human approves plan, `drift`. `Branch protection` fails on free-plan private repositories. A `graphyard` plugin bound elsewhere fails `Herdr plugin` until `--herdr-instance`/`--herdr-rebind`/`--no-herdr`. `--no-github-app` (not with `--target`/`--github-app`/`--reuse-app`/`--reviewer`): no App, `GITHUB_APP_*` unset, `/api/status.github` false; a bound App or Railway/local leftovers refuse. `--observe-only` (implies `--no-github-app --no-herdr`; refuses `--provider local`, recorded worker/producer rosters, unowned Railway services; replaces unrecorded docker-host/Hetzner environments) deploys only the control-plane, rest `held`; Railway variables unread; reruns: done steps `satisfied`. `up --merger control-plane` runs `install --no-github-app`, then deploy-key (each-run ruleset: key-only pushes; other read-write keys refuse, naming their delete commands; prior protection kept, reported), `POST /api/merger`. `up` prints Herdr's attach (`XDG_CONFIG_HOME=DIR herdr session attach NAME`). Own-instance session `graphyard-INSTALL` (`gy-HASH` session, then directory, within 107 socket-path bytes; else refused). No `--base-branch`: `master` if only `origin/master` exists. `compose` mounts the checkout at `/repo` (`GRAPHYARD_REPOSITORY_ROOT`) plus a worktree's Git directory; merger `control-plane` (App or not) observes heads there, reviews control-plane.

## Step 2: apply

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

Writes credentials, [variables](deployment.md#variables); deploys; [protects](github.md#require-the-check) branch (not with `--no-github-app`/`--observe-only`). **Verify** `/healthz`.

## Step 3: App confirmation

Skip with `--no-github-app`/`--observe-only`; else `--apply` serves `http://127.0.0.1:4311` (no browser) 900s; human installs the App (existing installs count). **Verify** *App registered and installation verified*; unconfirmed: exit 1, `resume`.

## Step 4: summary

**Verify** `health`, `webhook.delivered` (compose/local/`--no-github-app`: `webhook.skipped`), `profiles.master.configured`, `status.role` `admin`; follow `nextSteps`, never read `tokenFile`.

## Step 5: first pull request

Skip with `--no-github-app` until an App binds; else dispatch a [small item](onboarding.md#4-prove-the-first-pr); once `Graphyard / merge` appears, rerun idempotent `--apply` requiring it and `graphyard/landable`.

## Self-contained host

`--target host --ssh-host HOST` (or `--target hetzner`): server/Postgres/loop/executors/Herdr/runtimes on one systemd machine; credentials in `~graphyard/.config/graphyard/<install>/`. Public IPv4 serves `<ip>.sslip.io`; else `--domain`. Unpullable images build there at the installer's commit. Workers push/open PRs as the App (one-hour tokens).

Price: `--confirm-price`/`--max-monthly`. Saved Apps (`--github-app FILE`/this install's/`.graphyard/github-app.json`) are reused if they mint a token; `--reuse-app SLUG` (or App page) reuses host-saved Apps. `--migrate` stops loop, fences `GRAPHYARD_MIGRATE_DATABASE_URL` (`db fence`), restores; logins move.

## Upgrading an existing installation

[Back up, deploy](deployment.md#backup-upgrade-rollback); beside `.graphyard/github-app.json`, `node "$GRAPHYARD_CLI" github-setup --update-permissions --wait 600` until `appPermissions.missing` empties. `--apply` fixes `delegationLimits` drift (`Set GRAPHYARD_MAX_REVIEWERS=N`) and undeclared `sessionKind`.

## Failure handling

| Symptom | Action
| --- | ---
| `Preflight is incomplete` | run its `fix`
| `Railway workspace` `false` | `--workspace`
| `did not become healthy` | `install … --logs`
| `not confirmed within 900 s` | confirm, `resume`
| `already serves a GitHub App setup page` | finish/stop it
| `webhook.delivered` `false`, 401 | rerun
| `Branch protection could not be applied` | admin `gh auth login`
| `already binds`/`still holds GITHUB_APP_`/`could not be read` | remove binding/variables or drop `--no-github-app`
| `inside the managed repository` | `GRAPHYARD_CONFIG_HOME` outside worktrees
| fresh database (401) | `up` re-issues credentials, refiles onboarding/goal, archives cursor (on host)

## Agent execution contract

Run steps 1–5 (1,2,4 with `--no-github-app`/`--observe-only`); never weaken gates.

## Manual fallback (unsupported platforms)

[Deployment](deployment.md#manual-fallback).
