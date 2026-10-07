<!-- page: Start here | 0 | install, upgrade. -->
# Install Graphyard

> install Graphyard for OWNER/REPO on PROVIDER following docs/install.md

Ask only: **Which provider**; **Provider login**; **the GitHub App confirmation click**, once; **Approval of the printed plan**. Never invent a fifth.

## Hard rules

- **Never print, echo, `cat`, log, paste, or commit a credential.**
- **One principal per role:** `--workers N`; never share a worker credential.
- **Workers never receive an admin, coordinator, or producer credential.**
- **Proof producers get explicit grants only** (`--producer-proof NAME`).
- Credentials only in `~/.config/graphyard/<install>/` (directory `0700`, files `0600`).

## Preconditions

Node 24, `export GRAPHYARD_CLI=/abs/path/graphyard/bin/graphyard.mjs`, `gh auth status` as admin (`repo,admin:repo_hook`); worker hosts pass the `bwrap` probe.

### Providers

- `railway`: `npm i -g @railway/cli`, `railway login`.
- `hetzner`: `brew install hcloud`, `hcloud context create graphyard`; `--ssh-key NAME`, `--domain`; `manual:host-install-live` proofs need `HCLOUD_TOKEN` and `HETZNER_SPEND_CAP_USD_MONTHLY` in an uncommitted `.env`.
- `docker-host` (`--ssh-host`, `--domain`), `compose` (local only): `curl -fsSL https://get.docker.com | sh`.

## Step 1: plan and approve

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan
```

Options: `--workers N`, `--producer-proof NAME`, `--required-check NAME` ([`init --scan`](operations-reference.md#setup-proposals-and-drift)); `delivery` plans [candidates](delivery.md#managed-repositories). **Verify** `secretsRedacted`, `preflight[].ok`; the human approves plan and `drift`.

## Step 2: apply

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

Writes credentials and [variables](deployment.md#variables), deploys, [protects](github.md#require-the-check) the branch. **Verify** `GET /healthz`.

## Step 3: App confirmation

The human installs the App at `http://127.0.0.1:4311`. **Verify** *App registered and installation verified*.

## Step 4: summary

**Verify** `health`, `webhook.delivered` (compose polls), `profiles.master.configured`, `status.role`; follow `nextSteps`, never read a `tokenFile`.

## Step 5: first pull request

Dispatch a [small item](onboarding.md#4-prove-the-first-pr); once `Graphyard / merge` appears, rerun `--apply` to require it and `graphyard/landable`. **Verify** both are required; `--apply` is idempotent.

## Self-contained host

`--target host --ssh-host HOST` (or `--target hetzner`) runs everything on one systemd machine, served as `<ip>.sslip.io` unless `--domain`; workers push as the App. Sizing: 3 GB per agent, 2 GB per verification slot, 2 GB base (`--confirm-price`, `--max-monthly`). `--github-app FILE` reuses a saved App; `--migrate` moves an installation (`GRAPHYARD_MIGRATE_DATABASE_URL`, `db fence`).

## Upgrading an existing installation

[Back up, deploy](deployment.md#backup-upgrade-rollback); `node "$GRAPHYARD_CLI" github-setup --update-permissions --wait 600` until `appPermissions.missing` is empty. `--apply` fixes `delegationLimits` drift (`Set GRAPHYARD_MAX_REVIEWERS=N`) and `sessionKind`.

## Failure handling

| Symptom | Action |
| --- | --- |
| `Preflight is incomplete` | run its `fix`, rerun |
| `Railway workspace` `false` | pass a listed `--workspace` |
| `... must be able to read ...github-private-key.pem` | run the printed `chown` |
| `did not become healthy` | rerun with `--logs` |
| `The GitHub App confirmation did not complete in time` | rerun `--apply` |
| `webhook.delivered` `false`, 401 | rerun `--apply` |
| `Branch protection could not be applied` | `gh auth login` as admin |
| worktree dependencies `failed` | [bubblewrap](#preconditions) |
| `Refusing to store installation credentials inside the managed repository` | `GRAPHYARD_CONFIG_HOME` outside worktrees |

## Agent execution contract

Run steps 1–5, report verifications; never weaken a gate.

## Manual fallback (unsupported platforms)

See [deployment](deployment.md#manual-fallback).
