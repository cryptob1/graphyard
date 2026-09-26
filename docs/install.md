<!-- page: Start here | 0 | the one command and upgrades. -->
# Install Graphyard

An agent or person runs this runbook from one instruction:

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

### Providers

- `railway`: `npm i -g @railway/cli`, `railway login`.
- `hetzner`: `brew install hcloud`, `hcloud context create graphyard`; needs `--domain` and `--ssh-key NAME`.
- `docker-host`: `ssh USER@HOST 'curl -fsSL https://get.docker.com | sh'`; needs `--ssh-host` and `--domain`.
- `compose`: `curl -fsSL https://get.docker.com | sh`; local evaluation only.

## Step 1: print the plan

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan
```

Options: `--workers N`, `--producer-proof NAME`, `--required-check NAME`, `--domain`; `init --scan` [proposes](operations-reference.md#setup-proposals-and-drift) check and proof names.

**Verify:** `secretsRedacted` and every `preflight[].ok` are `true` (else run its `fix` and re-plan).

## Step 2: approve the plan

Show the human the plan and any `drift`. **Verify** their explicit approval; an agent never approves.

## Step 3: apply

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

It writes credentials, sets [variables](deployment.md#variables), deploys, runs the App flow, applies [branch protection](github.md#require-the-check). **Verify** `GET /healthz` answers.

## Step 4: the GitHub App confirmation

The installer prints `Open http://127.0.0.1:4311 ...`; the human registers and installs the App. **Verify:** the page reports *App registered and installation verified*.

## Step 5: read the summary

**Verify:** `health` `true`, `status.role` `admin`, `webhook.delivered` `true` (a `compose` install polls instead), `profiles.master.configured` `true`. Then follow `nextSteps`; never read a `tokenFile`.

## Step 6: the first pull request

Dispatch a small item ([onboarding](onboarding.md#4-prove-the-first-pr)); after `Graphyard / merge` first appears, rerun `--apply` when `nextSteps` says so. **Verify** the check is required on the base branch.

`--plan` and `--apply` are idempotent: done actions show `"satisfied"`, differences `drift`; credentials never rotate.

## Self-contained host

`--target host --ssh-host HOST` or `--target hetzner` runs server, Postgres, loop, executors, Herdr, Claude Code, Codex, OpenCode, Pi on one machine under systemd, credentials `0600` in its `graphyard` account. Sign in once via `signIn`; connect accounts under **Agents**.

**Sizing:** 3 GB per concurrent agent, 2 GB per verification slot, 2 GB base, plus max(10%, 4 GB) free. **Verify** `price`; apply with `--confirm-price X` or `--max-monthly N`.

**Moving:** `--migrate` stops the old loop and restores a verified backup of `GRAPHYARD_MIGRATE_DATABASE_URL` there.

## Upgrading an existing installation

[Back up, deploy](deployment.md#backup-upgrade-rollback); a new App permission holds its jobs until, on the machine holding `.graphyard/github-app.json`:

```sh
node "$GRAPHYARD_CLI" github-setup --update-permissions --wait 600
```

Then `doctor` shows `appPermissions.missing` empty.

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
| `Refusing to store installation credentials inside the managed repository` | point `GRAPHYARD_CONFIG_HOME` outside every worktree |

## Agent execution contract

Follow steps 1–6, reporting verification and `nextSteps`; never read a token file or weaken a gate to finish.

## Manual fallback for unsupported platforms

See [deployment](deployment.md#manual-fallback).
