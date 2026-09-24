<!-- page: Start here | 0 | the one command, the agent-executable runbook behind it, and the App-permission migration an upgrade can require. -->
# Install Graphyard

One command installs a complete control plane (Postgres, container, HTTPS URL, credentials,
GitHub App, webhook, branch protection, agent profiles, verification). An agent or a person
executes this runbook from one instruction:

> install Graphyard for OWNER/REPO on PROVIDER following docs/install.md

A person is asked for exactly four things: **Which provider** (and `--workspace` on a
multi-workspace Railway account); **Provider login** with an account they own; **the GitHub App confirmation click**,
once; **Approval of the printed plan**. Never invent a fifth.

## Hard rules

- **Never print, echo, `cat`, log, paste, or commit a credential.**
- **One principal per role.** Use `--workers N`; never share a worker credential.
- **Workers never receive an admin, coordinator, or producer credential.**
- **Proof producers get explicit grants only** (`--producer-proof NAME`, one per proof); never
  widen a producer to another lane.
- Credentials live only under `~/.config/graphyard/<install>/`: directory `0700`, files `0600`.
- An exposed credential is compromised: reinstall into a fresh directory and revoke the old principal.

## Preconditions

| Requirement | Check | Ready when |
| --- | --- | --- |
| Node 24 | `node --version` | `v24.` |
| Managed checkout | `git remote get-url origin` | `github.com` URL for `OWNER/REPO` |
| Graphyard CLI | `node "$GRAPHYARD_CLI" help` | command list (`export GRAPHYARD_CLI=/abs/path/graphyard/bin/graphyard.mjs`) |
| GitHub CLI | `gh auth status` | logged in (`gh auth login --scopes repo,admin:repo_hook`) |
| Repo admin | `gh api repos/OWNER/REPO --jq .permissions.admin` | `true` |

### Providers

| Provider | Check | Install the CLI | Notes |
| --- | --- | --- | --- |
| `railway` | `railway whoami` | `npm i -g @railway/cli`, `railway login` | Managed Postgres and TLS; several workspaces need `--workspace` |
| `hetzner` | `hcloud context active` | `brew install hcloud`, `hcloud context create graphyard` | Needs `--domain` and `--ssh-key NAME` |
| `docker-host` | `ssh USER@HOST docker version` | `ssh USER@HOST 'curl -fsSL https://get.docker.com \| sh'` | Needs `--ssh-host` and `--domain` |
| `compose` | `docker compose version` | `curl -fsSL https://get.docker.com \| sh` | Loopback only, for evaluation |

A missing CLI is not a reason to stop: install it and rerun. Only the billed account is the
human's. `--domain` must already resolve to the host.

## Step 1 — print the plan

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan
```

Options: `--domain HOST`, `--workers N`, `--producer-proof NAME`, `--reviewer NAME`,
`--review-policy github|agent`, `--workspace`, `--ssh-host`/`--ssh-user`, `--ssh-key`,
`--base-branch`, `--port`, `--image REF` (default the [versioned image](deployment.md#versioned-images)),
`--required-check NAME`, `--review-count N`. The plan changes nothing.

**Verify:** `secretsRedacted` is `true`; every `preflight[].ok` is `true` (else run its `fix`
and re-plan; `--apply` refuses a failing preflight and writes nothing); `actions` include
`provider.env.core`, `github.app`, `github.protection`, `verify.status`, `verify.webhook`.

## Step 2 — approve the plan

Show the plan and any `drift` to the human. **Verify** explicit approval; an agent never
approves on the human's behalf.

## Step 3 — apply

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

It writes credentials (`0600`), provisions Postgres and the container, sets `DATABASE_URL`,
`GRAPHYARD_PRINCIPALS`, the capacity limits and `GRAPHYARD_GENERATED_FILES`, deploys, runs the
App flow, points the webhook at `/api/github/webhook`, sets `GITHUB_CI_APP_IDS`, applies
branch protection (only tightens; "up to date" is off for the [merge queue](github.md#merge-queue);
force pushes and deletion forbidden), and registers agent profiles.
**Verify** `GET /healthz` answers.

## Step 4 — the GitHub App confirmation

The installer prints `Open http://127.0.0.1:4311 ...` (over SSH: `ssh -L 4311:127.0.0.1:4311
USER@HOST`). The human registers and installs the App; `--reviewer` adds a second confirmation.
**Verification:** the page reports *App registered and installation verified*.

## Step 5 — read the summary

**Verify:** `health` `true`; `status.role` `admin`; `status.repository` `OWNER/REPO`;
`webhook.delivered` `true` (a local `compose` install stays `false` by design); `protection`
names the checks and admin enforcement; `profiles.master.configured` `true`. Then follow
`nextSteps`. Never read a `tokenFile`.

## Step 6 — the first pull request

Create a small item with real criteria and dispatch it ([the first PR](first-pr.md)). After
`Graphyard / merge` first appears, rerun `--apply` when `nextSteps` says so to require it.
**Verify** the check is required on the base branch.

## Re-running the installer

`--plan` and `--apply` are idempotent. Done actions show `"satisfied"`; differing values are
reported in `drift` (secrets by fingerprint); credentials are never rotated by a re-run.

## Upgrading an existing installation

A release needing a new App permission raises an attention item (in `doctor`, the dashboard and
`master status`) and holds the jobs that need it. Back up and deploy
([backup, upgrade, rollback](deployment.md#backup-upgrade-rollback)), then on the machine holding
`.graphyard/github-app.json` run the [migration](github.md#migrating-an-existing-app):

```sh
node "$GRAPHYARD_CLI" github-setup --update-permissions --wait 600
```

Confirm `doctor` shows `appPermissions.missing` empty and `heldJobs` `0`. Unset capacity
limits are derived from the principals; `doctor` reports `delegationLimits` drift such as
`Set GRAPHYARD_MAX_REVIEWERS=N on the deployment`, and a re-run sets it. Confirm `/healthz`
reports the deployed `commit` ([production observation](deployment.md#production-deployment-observation)).

## Failure handling

| Symptom | Action |
| --- | --- |
| `Preflight is incomplete` | nothing was created; run the item's `fix`, rerun |
| `Railway workspace` preflight `false` | rerun with `--workspace` from the listed names |
| `Public hostname` preflight `false` | pass `--domain` with its record pointed |
| `SSH key` preflight `false` | rerun with `--ssh-key` from `hcloud ssh-key list` |
| `<cli> exited with N: ...` | act on the diagnostic, rerun `--apply` |
| `... must be able to read ...github-private-key.pem` | connect as `root` or run the printed `chown 1000:1000` |
| `did not become healthy` | `install --provider PROVIDER --repo OWNER/REPO --logs` |
| `The GitHub App confirmation did not complete in time` | rerun `--apply`; it resumes |
| `webhook.delivered` `false`, 401 | rerun `--apply`; it rewrites both secrets |
| `Branch protection could not be applied` | `gh auth login` as a repository admin, rerun |
| `Refusing to store installation credentials inside the managed repository` | point `GRAPHYARD_CONFIG_HOME` outside every worktree |

## Agent execution contract

```sh
node --version; git remote get-url origin; gh auth status
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan   # wait for approval
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

Report the verification and `nextSteps`. Never read a token file or weaken a gate to finish.

## Manual fallback

Only for unsupported platforms: use the variables table in
[deployment](deployment.md#manual-fallback).
