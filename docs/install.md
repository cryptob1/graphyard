<!-- page: Start here | 0 | the one command and upgrades. -->
# Install Graphyard

> install Graphyard for OWNER/REPO on PROVIDER following docs/install.md

Ask only: **Which provider** (`--workspace` for multi-workspace Railway); **Provider login**; **the GitHub App confirmation click**; **Approval of the printed plan**. Never invent a fifth.

## Hard rules

- **Never print, echo, `cat`, log, paste, or commit a credential.**
- **One principal per role:** `--workers N`; never share a worker credential.
- **Workers never receive an admin, coordinator, or producer credential.**
- **Proof producers get explicit grants only:** `--producer-proof NAME` per proof.
- Credentials live only in `~/.config/graphyard/<install>/`: directory `0700`, files `0600`.

## Preconditions

Node 24, a checkout of `OWNER/REPO`, `export GRAPHYARD_CLI=/abs/path/graphyard/bin/graphyard.mjs`, `gh auth status` as repository admin (`repo,admin:repo_hook`). Worker and non-Actions unit-proof hosts must pass `bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --share-net --die-with-parent -- true` (Ubuntu 24.04: `sysctl kernel.apparmor_restrict_unprivileged_userns=0`).

### Providers

- `railway`: `npm i -g @railway/cli`, `railway login`; `--domain`, `--workspace NAME`.
- `hetzner`: `brew install hcloud`, `hcloud context create graphyard`; `--domain`, `--ssh-key NAME`. `manual:install-hetzner-live` producers also need `HCLOUD_TOKEN` and `HETZNER_SPEND_CAP_USD_MONTHLY` in the repo-root `.env` (mode `0600`).
- `docker-host`: `ssh USER@HOST 'curl -fsSL https://get.docker.com | sh'`; `--ssh-host`, `--domain`.
- `compose`: `curl -fsSL https://get.docker.com | sh`; local evaluation only.

## Step 1: plan and approve

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan
```

Add `--workers N`, `--producer-proof NAME`, `--required-check NAME` ([`init --scan`](operations-reference.md#setup-proposals-and-drift) proposes names). **Verify** `secretsRedacted` and each `preflight[].ok` are `true` (else run its `fix`); the human approves plan and `drift`.

## Step 2: apply

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

Deploys and [protects](github.md#require-the-check) the branch. **Verify** `GET /healthz`.

## Step 3: App confirmation

The human installs the App at the printed `http://127.0.0.1:4311`; **Verify** *App registered and installation verified*.

## Step 4: summary

**Verify** `health`, `webhook.delivered` (compose polls), `profiles.master.configured` `true`, `status.role` `admin`. Follow `nextSteps`; never read a `tokenFile`.

## Step 5: first pull request

Dispatch a [small item](onboarding.md#4-prove-the-first-pr); once `Graphyard / merge` appears, rerun `--apply` to require it and `graphyard/landable`. **Verify** both checks required on the base branch. `--plan`/`--apply` are idempotent (`"satisfied"`, `drift`); tokens never rotate.

## Upgrading an existing installation

[Back up, deploy](deployment.md#backup-upgrade-rollback), then beside `.graphyard/github-app.json` run `node "$GRAPHYARD_CLI" github-setup --update-permissions --wait 600` until `doctor` shows `appPermissions.missing` empty. `--apply` fixes `delegationLimits` drift (`Set GRAPHYARD_MAX_REVIEWERS=N`) and undeclared [`sessionKind`](deployment.md#variables).

## Failure handling

| Symptom | Action |
| --- | --- |
| `Preflight is incomplete` | run its `fix`, rerun |
| `Railway workspace` `false` | pass a listed `--workspace` |
| `...github-private-key.pem` unreadable | connect as `root` or run printed `chown` |
| `did not become healthy` | rerun with `--logs` |
| `did not complete in time` | rerun `--apply` (resumes) |
| `webhook.delivered` `false`, 401 | rerun `--apply` (rewrites secrets) |
| `Branch protection could not be applied` | `gh auth login` as admin, rerun |
| `inside the managed repository` | set `GRAPHYARD_CONFIG_HOME` outside every worktree |

## Agent execution contract

Run steps 1–5, reporting each verification and `nextSteps`; never weaken a gate.

## Manual fallback for unsupported platforms

See [deployment](deployment.md#manual-fallback).
