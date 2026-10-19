<!-- page: Start here | 0 | install, upgrade. -->
# Install Graphyard

> install Graphyard for OWNER/REPO on PROVIDER following docs/install.md

Ask only: **Which provider**; **Provider login**; **Approval of the printed plan**. Never invent a fourth. Install registers no GitHub App and writes no branch protection or ruleset; the merge writer deploy key is the only GitHub access.

## Hard rules

- **Never print, echo, `cat`, log, paste, or commit a credential.**
- **One principal per role** (`--workers N`); never share worker credentials.
- **Workers never receive an admin, coordinator, or producer credential.**
- **Proof producers get explicit grants only** (`--producer-proof NAME`).
- Credentials only under `$GRAPHYARD_CONFIG_HOME` (default `~/.config/graphyard`): plan's `installDirectory`, `init --apply`'s `workers/` (`0700`/`0600`).

## Preconditions

Node 24, `OWNER/REPO` checkout, `export GRAPHYARD_CLI=/abs/path/graphyard/bin/graphyard.mjs`, admin `gh auth status` scope `repo` (deploy-key registration); worker/non-Actions unit-proof hosts pass [`bwrap` probe](setup-from-zero.md#1-machine-prerequisites).

### Providers

- `railway`: `npm i -g @railway/cli`, `railway login`. Stamps `GRAPHYARD_BUILD_SHA` (unknown/dirty refuses), uploads `--path-as-root`; failed upload/unserved commit (10 min) fails `provider.deploy`.
- `hetzner`: `brew install hcloud`, `hcloud context create graphyard`; `--ssh-key NAME`/`--domain`. `manual:…install…-live` coordinators need `HCLOUD_TOKEN`, `HETZNER_SPEND_CAP_USD_MONTHLY` in repo-root `.env` (`0600`, uncommitted), optionally `HETZNER_SSH_KEY`.
- `docker-host`: `ssh USER@HOST 'curl -fsSL https://get.docker.com | sh'`; `--ssh-host`/`--domain`.
- `compose` (local): `curl -fsSL https://get.docker.com | sh`. Publishes `127.0.0.1:4310`, else first free port ≤4329, kept on reruns; a taken `--port N` fails preflight.
- `local` (`graphyard up --local`): no Docker; embedded Postgres; user unit migrates and serves. Polls nothing on GitHub for merge gates.

## Step 1: plan and approve

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan
```

`--workers N`/`--producer-proof NAME` ([`init --scan`](operations-reference.md#setup-proposals-and-drift)); `delivery` plans [the policy](delivery.md#managed-repositories). **Verify** `secretsRedacted`, `preflight[].ok` (else `fix`; `HUMAN:` ones human's); human approves plan/`drift`. The plan lists the merge writer deploy key and no GitHub App, branch-protection or ruleset step. Elsewhere-bound plugins fail `Herdr plugin` until `--herdr-instance`/`--herdr-rebind`/`--no-herdr`. `--observe-only` (implies `--no-herdr`; refuses `--provider local`, unowned Railway services; replaces unrecorded docker-host/Hetzner environments) deploys the control plane only; rest `held`; Railway variables unread, checkout never uploaded; reruns: done steps `satisfied`. `app bind SLUG [--plan]` (docker-host `--ssh-host`, Railway `--workspace`) binds `app import`'s App (`GITHUB_APP_ID`/`GITHUB_INSTALLATION_ID`/`GITHUB_PRIVATE_KEY`/`GITHUB_WEBHOOK_SECRET`/`GITHUB_CI_APP_IDS`; Railway serving-SUCCESS redeploy/refuse-latest≠SUCCESS/await/no-source-upload/no-`GRAPHYARD_BUILD_SHA`; else deploy) once `/api/status` confirms; `--observe-only` reruns keep it. `up` runs install, then registers the deploy key (idempotent), and prints Herdr's attach (`XDG_CONFIG_HOME=DIR herdr session attach NAME`). Own-instance session `graphyard-INSTALL` (`gy-HASH`, then directory, ≤107 socket-path bytes, else refused). No `--base-branch`: `master` if only `origin/master`. `compose` mounts main checkout (not worktrees) at `/repo` (`GRAPHYARD_REPOSITORY_ROOT`; unreadable: `/healthz` cause, `?strict` 503), submodule Git directory beside; merger `control-plane` observes heads there, reviews control-plane.

## Step 2: apply

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

Writes credentials, [variables](deployment.md#variables); deploys; registers the merge writer deploy key; never writes branch protection or rulesets. One apply at once (`apply.lock`). **Verify** `/healthz`.

## Step 3: summary

**Verify** `health`, `webhook.skipped` (no App), `profiles.master.configured`, `status.role` `admin`, `status.github` false; follow `nextSteps`; never read `tokenFile`.

## Principal roster

`principal add ID --role ROLE [--grant external-runs:import|delivery:observe-sha] [--proof unit:*|…] [--token-file PATH]`/`principal remove ID`: one non-installer `install.json` entry, kept by `--apply` (planned-ID collisions refuse); writes only `GRAPHYARD_PRINCIPALS`, reads back, idempotent, under `apply.lock`; producers need `--grant`/`--proof` ([lanes](validation.md#verdicts)); `--proof` needs its recorded grant (`grants grant`); `--token-file` reuses a credential (recorded IDs: fingerprint-matched; not self-contained). `delivery:observe-sha`: one dedicated principal, never moved (GY-1912+).

## Self-contained host

`--target host --ssh-host HOST` (or `--target hetzner`): server/Postgres/loop/executors/Herdr/runtimes on one machine. Price: `--confirm-price`/`--max-monthly`. `--migrate` stops loop, fences `GRAPHYARD_MIGRATE_DATABASE_URL`.

## Upgrading an existing installation

`graphyard upgrade [--to VERSION|stable] [--workspace RAILWAY] [--plan]`: needs clean checkout+`DATABASE_URL`+`GRAPHYARD_URL`; records release; redeploy; healthy `/healthz`. A bound App: `node "$GRAPHYARD_CLI" github-setup --update-permissions --wait 600` until `appPermissions.missing` empties. `--apply` fixes `delegationLimits` drift (`Set GRAPHYARD_MAX_REVIEWERS=N`).

## Failure handling

| Symptom | Action
| --- | ---
| `Preflight is incomplete` | run its `fix`
| `Railway workspace` `false` | `--workspace`
| `did not become healthy` | `install … --logs`
| `deploy key` / `gh` refused | `gh auth login --scopes repo`, rerun
| `Another install --apply` | let it finish, apply again (dead holders reclaimed)
| `already binds`/`still holds GITHUB_APP_` | drop binding/variables
| `inside the managed repository` | `GRAPHYARD_CONFIG_HOME` outside worktrees
| fresh database (401) | `up` re-issues credentials
| `Unknown option '--github-app'` (or `--reuse-app`, `--restore-protection`) | install takes no App or protection flag (GY-2009); drop it

## Agent execution contract

Run steps 1–3; never weaken gates.

## Manual fallback (unsupported platforms)

[Deployment](deployment.md#manual-fallback).

## Done when

Plan listed the deploy key and no App or protection; apply registered the key; `/api/status.github` is false; documentation reflects this (or `--no-docs` is true).
