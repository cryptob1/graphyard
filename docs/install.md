<!-- page: Start here | 0 | install, upgrade. -->
# Install Graphyard

> install Graphyard for OWNER/REPO on PROVIDER following docs/install.md

Ask only: **Which provider**; **Provider login**; **the GitHub App confirmation click**, once; **Approval of the printed plan**. Never invent a fifth.

## Hard rules

- **Never print, echo, `cat`, log, paste, or commit a credential.**
- **One principal per role** (`--workers N`); never share a worker credential.
- **Workers never receive an admin, coordinator, or producer credential.**
- **Proof producers get explicit grants only** (`--producer-proof NAME`).
- Credentials only under `$GRAPHYARD_CONFIG_HOME` (default `~/.config/graphyard`): the plan's `installDirectory`, and `workers/` from `init --apply` (directories `0700`, files `0600`).

## Preconditions

Node 24, `OWNER/REPO` checkout, `export GRAPHYARD_CLI=/abs/path/graphyard/bin/graphyard.mjs`, admin `gh auth status` with scope `repo` (and `admin:repo_hook`, except compose; preflight checks); worker and non-Actions unit-proof hosts pass the [`bwrap` probe](setup-from-zero.md#1-machine-prerequisites).

### Providers

- `railway`: `npm i -g @railway/cli`, `railway login`.
- `hetzner`: `brew install hcloud`, `hcloud context create graphyard`; `--ssh-key NAME`, `--domain`. `manual:host-install-live` or `manual:…install…-live` coordinators need `HCLOUD_TOKEN`, `HETZNER_SPEND_CAP_USD_MONTHLY` in repo-root `.env` (`0600`, uncommitted); optional `HETZNER_SSH_KEY` names a registered key (else throwaway).
- `docker-host`: `ssh USER@HOST 'curl -fsSL https://get.docker.com | sh'`; `--ssh-host`, `--domain`.
- `compose` (local): `curl -fsSL https://get.docker.com | sh`.

## Step 1: plan and approve

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan
```

`--workers N`, `--producer-proof NAME`, `--required-check NAME` ([`init --scan`](operations-reference.md#setup-proposals-and-drift)); `delivery`, `release.*` plan [candidates](delivery.md#managed-repositories). **Verify** `secretsRedacted`, `preflight[].ok` (else `fix`); human approves plan, `drift`.

## Step 2: apply

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

Writes credentials, [variables](deployment.md#variables); deploys; [protects](github.md#require-the-check) branch. **Verify** `GET /healthz`.

## Step 3: App confirmation

`--apply` serves and prints `http://127.0.0.1:4311` (no browser opened); the human installs the App there; **Verify** *App registered and installation verified*.

## Step 4: summary

**Verify** `health`, `webhook.delivered` (compose polls), `profiles.master.configured`, `status.role` `admin`; follow `nextSteps`, never read `tokenFile`.

## Step 5: first pull request

Dispatch a [small item](onboarding.md#4-prove-the-first-pr); once `Graphyard / merge` appears, rerun idempotent `--apply` to require it and `graphyard/landable`.

## Self-contained host

`--target host --ssh-host HOST` (or `--target hetzner`): server, Postgres, loop, executors, Herdr, runtimes on one systemd machine; credentials in `~graphyard/.config/graphyard/<install>/`. Public IPv4 serves `<ip>.sslip.io`; private/`--local` needs `--domain`. Bootstrap installs gh, bubblewrap, checks namespaces as `graphyard`; unpullable image builds from the host checkout at the installer's commit. Workers push and open PRs as the App: git's credential helper and `gh` wrapper mint one-hour repository tokens from `<install>/github/`. Re-apply refuses, never rotates, unreadable host credentials.

Sizing: 3 GB per agent, 2 GB per verification slot, 2 GB base, max(10%, 4 GB) spare (`--confirm-price`, `--max-monthly`). A saved App (`--github-app FILE`, this install's, `.graphyard/github-app.json`) is reused once it mints token; another live installation's webhook stays until `--migrate`: stops old loop, fences `GRAPHYARD_MIGRATE_DATABASE_URL` (`db fence`, released on pre-cutover failure), restores; local logins move.

## Upgrading an existing installation

[Back up, deploy](deployment.md#backup-upgrade-rollback); beside `.graphyard/github-app.json`, `node "$GRAPHYARD_CLI" github-setup --update-permissions --wait 600` until `appPermissions.missing` is empty. `--apply` fixes `delegationLimits` drift (`Set GRAPHYARD_MAX_REVIEWERS=N`), undeclared `sessionKind`.

## Failure handling

| Symptom | Action
| --- | ---
| `Preflight is incomplete` | nothing created; run its `fix`
| `Railway workspace` `false` | a listed `--workspace`
| `... must be able to read ...github-private-key.pem` | connect as `root` or `chown 1000:1000`
| `did not become healthy` | `install --provider PROVIDER --repo OWNER/REPO --logs`
| `The GitHub App confirmation did not complete in time` | rerun `--apply` (resumes)
| `webhook.delivered` `false`, 401 | rerun (rewrites secrets)
| `Branch protection could not be applied` | admin `gh auth login`
| worktree dependencies `failed` | [bubblewrap](#preconditions)
| `Refusing to store installation credentials inside the managed repository` | `GRAPHYARD_CONFIG_HOME` outside worktrees

## Agent execution contract

Run steps 1–5, report verifications, never weaken gates.

## Manual fallback (unsupported platforms)

[Deployment](deployment.md#manual-fallback).
