<!-- page: Start here | 0 | the one command and upgrades. -->
# Install Graphyard

> install Graphyard for OWNER/REPO on PROVIDER following docs/install.md

A person gives only: **Which provider** (plus `--workspace` on multi-workspace Railway); **Provider login** (their own account); **the GitHub App confirmation click**, once; **Approval of the printed plan**. Never invent a fifth.

## Hard rules

- **Never print, echo, `cat`, log, paste, or commit a credential.**
- **One principal per role** (`--workers N`), never shared.
- **Workers never receive an admin, coordinator, or producer credential.**
- **Proof producers get explicit grants only** (`--producer-proof NAME` each).
- Credentials stay in `~/.config/graphyard/<install>/` (`0700`, files `0600`).

## Preconditions

Node 24; a checkout of `OWNER/REPO`; `export GRAPHYARD_CLI=/abs/path/graphyard/bin/graphyard.mjs`; `gh auth status` as repository admin with `repo,admin:repo_hook`. Worker and non-Actions unit-proof hosts need bubblewrap: `bwrap --unshare-all --ro-bind / / -- true` succeeds (Ubuntu 24.04: `sysctl kernel.apparmor_restrict_unprivileged_userns=0`).

### Providers

- `railway`: `npm i -g @railway/cli`, `railway login`.
- `hetzner`: `brew install hcloud`, `hcloud context create graphyard`; `--domain`, `--ssh-key NAME`.
- `docker-host`: `ssh USER@HOST 'curl -fsSL https://get.docker.com | sh'`; `--ssh-host`, `--domain`.
- `compose`: `curl -fsSL https://get.docker.com | sh`; local evaluation only.

## Step 1: plan

`node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan` takes `--workers N`, `--producer-proof NAME`, `--required-check NAME`, `--domain`; `init --scan` [proposes](operations-reference.md#setup-proposals-and-drift) names. **Verify:** `secretsRedacted` and each `preflight[].ok` are `true` (else run its `fix`). The human then approves the plan and any `drift`.

## Step 2: apply

`node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply` writes credentials, sets [variables](deployment.md#variables), deploys and applies [branch protection](github.md#require-the-check). **Verify** `GET /healthz`.

## Step 3: App confirmation

The human registers and installs the App at the printed `http://127.0.0.1:4311`. **Verify:** *App registered and installation verified*.

## Step 4: summary

**Verify:** `health` `true`, `status.role` `admin`, `webhook.delivered` `true` (compose polls), `profiles.master.configured` `true`. Follow `nextSteps`; never read a `tokenFile`.

## Step 5: first pull request

Dispatch a small [first item](onboarding.md#4-prove-the-first-pr); once `Graphyard / merge` appears, rerun `--apply`. **Verify** it is required on the base branch. `--plan` and `--apply` are idempotent (`"satisfied"`, `drift`); tokens never rotate.

## Upgrading an existing installation

Jobs needing a newly released App permission hold. [Back up, deploy](deployment.md#backup-upgrade-rollback), then beside `.graphyard/github-app.json` run `node "$GRAPHYARD_CLI" github-setup --update-permissions --wait 600` until `doctor` shows `appPermissions.missing` empty. Re-runs fix `delegationLimits` drift (`Set GRAPHYARD_MAX_REVIEWERS=N`) and declare an undeclared operator `sessionKind human`, agents `ai`, keeping tokens.

## Failure handling

Fix, then rerun.

| Symptom | Action |
| --- | --- |
| `Preflight is incomplete` | nothing created; run its `fix` |
| `Railway workspace` preflight `false` | pass a listed `--workspace` |
| `... must be able to read ...github-private-key.pem` | connect as `root` or run the printed `chown 1000:1000` |
| `did not become healthy` | `install --provider PROVIDER --repo OWNER/REPO --logs` |
| `App confirmation did not complete` | `--apply` resumes |
| `webhook.delivered` `false`, 401 | `--apply` rewrites both secrets |
| `Branch protection could not be applied` | `gh auth login` as repository admin |
| worktree dependencies `failed` | [bubblewrap](#preconditions) |
| `... inside the managed repository` | `GRAPHYARD_CONFIG_HOME` outside every worktree |

## Agent execution contract

Follow steps 1–5, report verification and `nextSteps`, never weaken a gate.

## Manual fallback for unsupported platforms

See [deployment](deployment.md#manual-fallback).
