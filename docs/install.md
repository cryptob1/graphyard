<!-- page: Start here | 0 | install, upgrade. -->
# Install Graphyard

> install Graphyard for OWNER/REPO on PROVIDER following docs/install.md

Ask only: **Which provider**; **Provider login**; **GitHub App confirmation click**, once (none with `--no-github-app`); **Approval of the printed plan**. Never invent a fifth.

## Hard rules

- **Never print, echo, `cat`, log, paste, or commit a credential.**
- **One principal per role** (`--workers N`); never share a worker credential.
- **Workers never receive an admin, coordinator, or producer credential.**
- **Proof producers get explicit grants only** (`--producer-proof NAME`).
- Credentials only under `$GRAPHYARD_CONFIG_HOME` (default `~/.config/graphyard`): the plan's `installDirectory`, `workers/` from `init --apply` (directories `0700`, files `0600`).

## Preconditions

Node 24, `OWNER/REPO` checkout, `export GRAPHYARD_CLI=/abs/path/graphyard/bin/graphyard.mjs`, admin `gh auth status` with scope `repo` (and `admin:repo_hook`, except compose and local; preflight checks; `--no-github-app` needs `gh` only for release-candidate `release.*`); worker and non-Actions unit-proof hosts pass [`bwrap` probe](setup-from-zero.md#1-machine-prerequisites).

### Providers

- `railway`: `npm i -g @railway/cli`, `railway login`.
- `hetzner`: `brew install hcloud`, `hcloud context create graphyard`; `--ssh-key NAME`, `--domain`. `manual:host-install-live` or `manual:…install…-live` coordinators need `HCLOUD_TOKEN`, `HETZNER_SPEND_CAP_USD_MONTHLY` in repo-root `.env` (`0600`, uncommitted); optional `HETZNER_SSH_KEY` names registered key (else throwaway).
- `docker-host`: `ssh USER@HOST 'curl -fsSL https://get.docker.com | sh'`; `--ssh-host`, `--domain`.
- `compose` (local): `curl -fsSL https://get.docker.com | sh`. It polls GitHub: its Apps have no webhook and subscribe to no events, so webhook steps are skipped. It publishes `127.0.0.1:4310`, or (port held) the first free one up to 4329, kept on reruns; a taken `--port N` fails preflight. Under `graphyard up`, a failed step's `next` carries its last 20 output lines, credentials redacted.
- `local` (`graphyard up --local`, refused beside another `--provider`): no Docker. Same server on embedded Postgres (`npm install` without `--omit=optional`), cluster in `INSTALL/postgres`; user unit `graphyard-local-INSTALL.service` starts it, migrates (`db migrate`) and serves (without systemd the plan prints the foreground command). Polls GitHub like compose.

## Step 1: plan and approve

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan
```

`--workers N`, `--producer-proof NAME`, `--required-check NAME` ([`init --scan`](operations-reference.md#setup-proposals-and-drift)); `delivery`, `release.*` plan [candidates](delivery.md#managed-repositories). **Verify** `secretsRedacted`, `preflight[].ok` (else `fix`; `fix` starting `HUMAN:` is the human's); human approves plan, `drift`. `Branch protection` fails on a free-plan private repository (go public or upgrade). A Herdr `graphyard` plugin bound elsewhere fails `Herdr plugin` until `--herdr-instance`, `--herdr-rebind` or `--no-herdr`. `--no-github-app` (not with `--target`, `--github-app`, `--reuse-app`, `--reviewer`): no App; `GITHUB_APP_*` stay unset, `/api/status.github` is false, no webhook, protection or reviewer; recorded so `master setup --apply` reintroduces none; a bound App or Railway/local leftovers refuse before any change. `up` prints Herdr's attach command (`XDG_CONFIG_HOME=DIR herdr session attach NAME`).

## Step 2: apply

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

Writes credentials, [variables](deployment.md#variables); deploys; [protects](github.md#require-the-check) branch (not with `--no-github-app`). **Verify** `GET /healthz`.

## Step 3: App confirmation

Skip with `--no-github-app`. Else `--apply` serves and prints `http://127.0.0.1:4311` (no browser) for 900 s; human installs the App; one installed elsewhere is found and recorded. **Verify** *App registered and installation verified*. Unconfirmed: exit 1; the summary's `resume` is the exact rerun.

## Step 4: summary

**Verify** `health`, `webhook.delivered` (compose, local, `--no-github-app`: `webhook.skipped`), `profiles.master.configured`, `status.role` `admin`; follow `nextSteps`, never read `tokenFile`.

## Step 5: first pull request

Skip with `--no-github-app` until a rerun without it binds an App. Else dispatch [small item](onboarding.md#4-prove-the-first-pr); once `Graphyard / merge` appears, rerun idempotent `--apply` to require it and `graphyard/landable`.

## Self-contained host

`--target host --ssh-host HOST` (or `--target hetzner`): server, Postgres, loop, executors, Herdr, runtimes on one systemd machine; credentials in `~graphyard/.config/graphyard/<install>/`. Public IPv4 serves `<ip>.sslip.io`; private/`--local` needs `--domain`. Unpullable images build on the host at the installer's commit. Workers push and open PRs as the App via one-hour repository tokens.

Price consent: `--confirm-price`, `--max-monthly`. Saved Apps (`--github-app FILE`, this install's, `.graphyard/github-app.json`) are reused once minting a token; `--reuse-app SLUG` (or the App page) reuses a host-saved App installed on the account. `--migrate` stops old loop, fences `GRAPHYARD_MIGRATE_DATABASE_URL` (`db fence`), restores; local logins move.

## Upgrading an existing installation

[Back up, deploy](deployment.md#backup-upgrade-rollback); beside `.graphyard/github-app.json`, `node "$GRAPHYARD_CLI" github-setup --update-permissions --wait 600` until `appPermissions.missing` is empty. `--apply` fixes `delegationLimits` drift (`Set GRAPHYARD_MAX_REVIEWERS=N`), undeclared `sessionKind`.

## Failure handling

| Symptom | Action
| --- | ---
| `Preflight is incomplete` | nothing created; run its `fix`
| `Railway workspace` `false` | a listed `--workspace`
| `did not become healthy` | `install --provider PROVIDER --repo OWNER/REPO --logs`
| `was not confirmed within 900 s` | summary's `resume` once confirmed
| `already serves a GitHub App setup page` | finish the App there, or stop its process
| `webhook.delivered` `false`, 401 | rerun (rewrites secrets)
| `Branch protection could not be applied` | admin `gh auth login`
| `already binds` / `still holds GITHUB_APP_` / `could not be read` | remove the binding or variables and rerun, or drop `--no-github-app`
| `Refusing to store installation credentials inside the managed repository` | `GRAPHYARD_CONFIG_HOME` outside worktrees

## Agent execution contract

Run steps 1–5 (1, 2, 4 with `--no-github-app`); never weaken gates.

## Manual fallback (unsupported platforms)

[Deployment](deployment.md#manual-fallback).
