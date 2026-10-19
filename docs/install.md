<!-- page: Start here | 0 | install -->
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

Node 24, an `OWNER/REPO` checkout, `GRAPHYARD_CLI` exported, `gh` scope `repo` as a repository admin (it registers the deploy key); worker hosts pass the [`bwrap` probe](setup-from-zero.md#1-machine-prerequisites).

### Providers

- `railway`: `npm i -g @railway/cli`, `railway login`.
- `hetzner`: `brew install hcloud`, `hcloud context create graphyard`.
- `docker-host`, `compose`: `curl -fsSL https://get.docker.com | sh`.
- `local` (`graphyard up --local`): no Docker; embedded Postgres.

## Step 1: plan and approve

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan
```

**Verify** `secretsRedacted` and `preflight[].ok` (else run each `fix`; `HUMAN:` ones are the human's); the human approves the plan. The deploy key is the only GitHub step. `compose` mounts the checkout at `/repo`.

## Step 2: apply

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

Writes credentials, [variables](deployment.md#variables); deploys; registers the deploy key; reruns idempotent. **Verify** `/healthz`.

## Step 3: deploy key

`--apply` generates `INSTALL/deploy-key` (ed25519, `0600`) when absent and registers it read-write on OWNER/REPO with `gh repo deploy-key add` unless listed. The merge writer trial-merges each submitted head and pushes the base with it alone; setup re-registers a missing key. **Verify** `gh repo deploy-key list -R OWNER/REPO` lists it.

## Step 4: summary

**Verify** `health`, `deployKey`, `profiles.master.configured`, `status.role` `admin`.

## Step 5: first item

Dispatch a [small item](onboarding.md#4-prove-the-first-change); the merge writer trials and pushes it.

## Roster and self-contained host

`principal add ID --role ROLE [--grant …] [--proof …]` writes only `GRAPHYARD_PRINCIPALS`. `--target host` (or `--target hetzner`) puts server, Postgres, loop, Herdr and runtimes on one systemd machine; the host generates the deploy key (never copied off). Price: `--confirm-price`/`--max-monthly`.

## Upgrading an existing installation

`graphyard upgrade [--to VERSION|stable] [--workspace RAILWAY] [--plan]`: needs a clean checkout with `DATABASE_URL` and `GRAPHYARD_URL`; backs up, redeploys a build stamped from the target (`install --source-root DIR`), restarts the loop, waits for healthy `/healthz`; refuses older schemas; failures name step and rollback (migrated: roll-forward).

## Failure handling

| Symptom | Action
| --- | ---
| `Preflight is incomplete` | run its `fix`
| `Railway workspace` `false` | `--workspace`
| `did not become healthy` | `install --logs`
| `gh repo deploy-key` fails | `gh auth login --scopes repo` as a repository admin
| `Another install --apply` … `holds the lock` | let it finish, apply again
| `Generating the merge writer's deploy key` (host) | install `openssh-client`, rerun
| `Cloning OWNER/REPO` (host) | `gh repo deploy-key list`, rerun
| `inside the managed repository` | `GRAPHYARD_CONFIG_HOME` outside worktrees

## Agent execution contract

Run steps 1–5; never weaken gates.

## Manual fallback (unsupported platforms)

[Deployment](deployment.md#manual-fallback). Done when the plan listed the deploy key, apply registered it, and documentation reflects this (or `--no-docs`).
