<!-- page: Start here | 0 | the one command and upgrades. -->
# Install Graphyard

One command installs the control plane; an agent or person runs this runbook from one instruction:

> install Graphyard for OWNER/REPO on PROVIDER following docs/install.md

A person is asked for exactly four things: **Which provider** (and `--workspace` on a multi-workspace Railway account); **Provider login** with an account they own; **the GitHub App confirmation click**, once; **Approval of the printed plan**. Never invent a fifth.

## Hard rules

- **Never print, echo, `cat`, log, paste, or commit a credential.**
- **One principal per role.** Use `--workers N`; never share a worker credential.
- **Workers never receive an admin, coordinator, or producer credential.**
- **Proof producers get explicit grants only** (`--producer-proof NAME`, one per proof).
- Credentials live only in `~/.config/graphyard/<install>/`: directory `0700`, files `0600`.

## Preconditions

Node 24; a checkout of `OWNER/REPO`; `export GRAPHYARD_CLI=/abs/path/graphyard/bin/graphyard.mjs`; `gh auth status` logged in as a repository admin with `repo,admin:repo_hook`.

Workers and non-Actions unit-proof hosts install dependencies only under bubblewrap: `bwrap --unshare-all --ro-bind / / -- true` must succeed (Ubuntu 24.04: `sysctl kernel.apparmor_restrict_unprivileged_userns=0`).

### Providers

- `railway`: `npm i -g @railway/cli`, `railway login`.
- `hetzner`: `brew install hcloud`, `hcloud context create graphyard`; needs `--domain` and `--ssh-key NAME`.
- `docker-host`: `ssh USER@HOST 'curl -fsSL https://get.docker.com | sh'`; needs `--ssh-host` and `--domain`.
- `compose`: `curl -fsSL https://get.docker.com | sh`; local evaluation only.

## Step 1: print the plan

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan
```

Common options: `--workers N`, `--producer-proof NAME`, `--required-check NAME`, `--domain`; `init --scan` [proposes](operations-reference.md#setup-proposals-and-drift) check and proof names.

**Verify:** `secretsRedacted` is `true` and every `preflight[].ok` is `true` (else run its `fix` and re-plan).

## Step 2: approve the plan

Show the human the plan and any `drift`. **Verify** their explicit approval; an agent never approves.

## Step 3: apply

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

It writes credentials, sets [variables](deployment.md#variables), deploys, runs the App flow, applies [branch protection](github.md#require-the-check). **Verify** `GET /healthz` answers.

## Step 4: the GitHub App confirmation

The installer prints `Open http://127.0.0.1:4311 ...`; the human registers and installs the App. **Verification:** the page reports *App registered and installation verified*.

## Step 5: read the summary

**Verify:** `health` `true`, `status.role` `admin`, `webhook.delivered` `true` (a `compose` install polls instead), `profiles.master.configured` `true`. Then follow `nextSteps`; never read a `tokenFile`.

## Step 6: the first pull request

Dispatch a small item ([onboarding](onboarding.md#4-prove-the-first-pr)); after `Graphyard / merge` first appears, rerun `--apply` when `nextSteps` says so. **Verify** the check is required on the base branch.

`--plan` and `--apply` are idempotent: done actions show `"satisfied"`, differences `drift`; credentials never rotate.

## Upgrading an existing installation

A release needing a new App permission holds the jobs using it. [Back up, deploy](deployment.md#backup-upgrade-rollback), then on the machine holding `.graphyard/github-app.json`:

```sh
node "$GRAPHYARD_CLI" github-setup --update-permissions --wait 600
```

Confirm `doctor` shows `appPermissions.missing` empty; `delegationLimits` drift such as `Set GRAPHYARD_MAX_REVIEWERS=N on the deployment` is fixed by a re-run.

## Failure handling

| Symptom | Action |
| --- | --- |
| `Preflight is incomplete` | nothing created; run its `fix`, rerun |
| `Railway workspace` preflight `false` | rerun with a listed `--workspace` |
| `... must be able to read ...github-private-key.pem` | connect as `root` or run the printed `chown 1000:1000` |
| `did not become healthy` | `install --provider PROVIDER --repo OWNER/REPO --logs` |
| `The GitHub App confirmation did not complete in time` | rerun `--apply`; it resumes |
| `webhook.delivered` `false`, 401 | rerun `--apply`; it rewrites both secrets |
| `Branch protection could not be applied` | `gh auth login` as a repository admin, rerun |
| worktree dependencies `failed` | install [bubblewrap](#preconditions) |
| `Refusing to store installation credentials inside the managed repository` | point `GRAPHYARD_CONFIG_HOME` outside every worktree |

## Agent execution contract

Run the preconditions and `--plan`, await approval, `--apply`, report verification and `nextSteps`. Never read a token file or weaken a gate to finish.

## Manual fallback for unsupported platforms

See [deployment](deployment.md#manual-fallback).
