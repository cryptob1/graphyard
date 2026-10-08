<!-- page: Start here | 0 | install, upgrade. -->
# Install Graphyard

> install Graphyard for OWNER/REPO on PROVIDER following docs/install.md

Ask only: **Which provider**; **Provider login**; **GitHub App confirmation click**, once; **Approval of the printed plan**. Never invent a fifth.

## Hard rules

- **Never print, echo, `cat`, log, paste, or commit a credential.**
- **One principal per role** (`--workers N`); never share a worker credential.
- **Workers never receive an admin, coordinator, or producer credential.**
- **Proof producers get explicit grants only** (`--producer-proof NAME`).
- Credentials only under `$GRAPHYARD_CONFIG_HOME` (default `~/.config/graphyard`): the plan's `installDirectory`, `workers/` from `init --apply` (directories `0700`, files `0600`).

## Preconditions

Node 24, `OWNER/REPO` checkout, `export GRAPHYARD_CLI=/abs/path/graphyard/bin/graphyard.mjs`, admin `gh auth status` with scope `repo` (and `admin:repo_hook`, except compose and local; preflight checks); worker and non-Actions unit-proof hosts pass [`bwrap` probe](setup-from-zero.md#1-machine-prerequisites).

### Providers

- `railway`: `npm i -g @railway/cli`, `railway login`.
- `hetzner`: `brew install hcloud`, `hcloud context create graphyard`; `--ssh-key NAME`, `--domain`. `manual:host-install-live` or `manual:…install…-live` coordinators need `HCLOUD_TOKEN`, `HETZNER_SPEND_CAP_USD_MONTHLY` in repo-root `.env` (`0600`, uncommitted); optional `HETZNER_SSH_KEY` names registered key (else throwaway).
- `docker-host`: `ssh USER@HOST 'curl -fsSL https://get.docker.com | sh'`; `--ssh-host`, `--domain`.
- `compose` (local): `curl -fsSL https://get.docker.com | sh`. It polls GitHub: its Apps have no webhook and subscribe to no events (GitHub refuses a loopback or private hook URL, and events without a hook), so webhook steps are skipped.
- `local` (`graphyard up --local`, refused beside another `--provider`): no Docker. Same server and Store on embedded Postgres (`npm install` without `--omit=optional`); preflight checks Node 24, the binaries, free loopback ports. Cluster in `INSTALL/postgres` (`0700`, `password` `0600`), variables `INSTALL/local-server.json` (`0600`), `127.0.0.1:--port`. User unit `graphyard-local-INSTALL.service` starts the cluster, migrates as `db migrate`, serves, restarts; on stop closes the store before the cluster. Without systemd the plan prints the foreground command. Polls GitHub like compose; reruns change nothing.

## Step 1: plan and approve

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan
```

`--workers N`, `--producer-proof NAME`, `--required-check NAME` ([`init --scan`](operations-reference.md#setup-proposals-and-drift)); `delivery`, `release.*` plan [candidates](delivery.md#managed-repositories). **Verify** `secretsRedacted`, `preflight[].ok` (else `fix`; `fix` starting `HUMAN:` is the human's); human approves plan, `drift`. `Branch protection` fails on GitHub's 403 *Upgrade to GitHub Pro* (free-plan private repositories cannot require `Graphyard / merge`: go public or upgrade); other failed reads (SSO, admin, 5xx) fail with GitHub's answer, never "not protected yet". `local.herdr` shows Herdr's `graphyard` plugin's fate; one bound elsewhere or with unreadable `config.json` fails `Herdr plugin` until `--herdr-rebind` (repoint) or `--no-herdr` (leave).

## Step 2: apply

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

Writes credentials, [variables](deployment.md#variables); deploys; [protects](github.md#require-the-check) branch. **Verify** `GET /healthz`.

## Step 3: App confirmation

`--apply` serves and prints `http://127.0.0.1:4311` (no browser) for 900 s; human installs the App; one installed elsewhere (a phone) is found through the App's own lookup and recorded, as is a saved App missing its installation, so no Install step or page appears. App names over 34 characters fall back to the repository name. **Verify** *App registered and installation verified*. Master configuration, profiles precede it (`master environments`, `master harness` work). Unconfirmed: exit 1, JSON summary `completed`, `github.app` `pending` (credentials saved only if GitHub returned them), `credentials.principals` (self-contained: host token directory), `stack.stop`, `resume` (exact rerun, every flag, keeping pre-App steps).

## Step 4: summary

**Verify** `health`, `webhook.delivered` (compose, local: `webhook.skipped`), `profiles.master.configured`, `status.role` `admin`; follow `nextSteps`, never read `tokenFile`.

## Step 5: first pull request

Dispatch [small item](onboarding.md#4-prove-the-first-pr); once `Graphyard / merge` appears, rerun idempotent `--apply` to require it and `graphyard/landable`.

## Self-contained host

`--target host --ssh-host HOST` (or `--target hetzner`): server, Postgres, loop, executors, Herdr, runtimes on one systemd machine; credentials in `~graphyard/.config/graphyard/<install>/`. Public IPv4 serves `<ip>.sslip.io`; private/`--local` needs `--domain`. Bootstrap installs gh, bubblewrap, checks namespaces as `graphyard`; unpullable images build from host checkout at installer's commit. Workers push and open PRs as the App: git's credential helper, `gh` wrapper mint one-hour repository tokens from `<install>/github/`. Re-apply refuses, never rotates, unreadable host credentials.

Sizing: 3 GB/agent, 2 GB/verification slot, 2 GB base, max(10%, 4 GB) spare (`--confirm-price`, `--max-monthly`). Saved Apps (`--github-app FILE`, this install's, `.graphyard/github-app.json`) are reused once minting a token; `--reuse-app SLUG` (or the App page) reuses host-saved App installed on the account, `gh` adding the repository if permissions fit. Refused: webhooks serving another live install (until `--migrate`), reviewer Apps beyond their declaration, two Apps per role. `--migrate` stops old loop, fences `GRAPHYARD_MIGRATE_DATABASE_URL` (`db fence`, released on pre-cutover failure), restores; local logins move.

## Upgrading an existing installation

[Back up, deploy](deployment.md#backup-upgrade-rollback); beside `.graphyard/github-app.json`, `node "$GRAPHYARD_CLI" github-setup --update-permissions --wait 600` until `appPermissions.missing` is empty. `--apply` fixes `delegationLimits` drift (`Set GRAPHYARD_MAX_REVIEWERS=N`), undeclared `sessionKind`.

## Failure handling

| Symptom | Action
| --- | ---
| `Preflight is incomplete` | nothing created; run its `fix`
| `Railway workspace` `false` | a listed `--workspace`
| `... must be able to read ...github-private-key.pem` | connect as `root` or `chown 1000:1000`
| `did not become healthy` | `install --provider PROVIDER --repo OWNER/REPO --logs`
| `was not confirmed within 900 s` | summary's `resume` once confirmed
| `already serves a GitHub App setup page` | finish the App there, or stop its process
| `webhook.delivered` `false`, 401 | rerun (rewrites secrets)
| `Branch protection could not be applied` | admin `gh auth login`
| worktree dependencies `failed` | [bubblewrap](#preconditions)
| `Refusing to store installation credentials inside the managed repository` | `GRAPHYARD_CONFIG_HOME` outside worktrees

## Agent execution contract

Run steps 1–5, reporting verifications; never weaken gates.

## Manual fallback (unsupported platforms)

[Deployment](deployment.md#manual-fallback).
