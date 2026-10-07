<!-- page: Start here | 0 | the one command and upgrades. -->
# Install Graphyard

> install Graphyard for OWNER/REPO on PROVIDER following docs/install.md

Ask only: **Which provider**; **Provider login**; **the GitHub App confirmation click**, once; **Approval of the printed plan**. Never invent a fifth.

## Hard rules

- **Never print, echo, `cat`, log, paste, or commit a credential.**
- **One principal per role:** `--workers N`; never share a worker credential.
- **Workers never receive an admin, coordinator, or producer credential.**
- **Proof producers get explicit grants only** (`--producer-proof NAME`).
- Credentials only under `$GRAPHYARD_CONFIG_HOME` (default `~/.config/graphyard`): the plan's `installDirectory`, and `workers/` from `init --apply` (directories `0700`, files `0600`).

## Preconditions

Node 24, `OWNER/REPO` checkout, `export GRAPHYARD_CLI=/abs/path/graphyard/bin/graphyard.mjs`, `gh auth status` as repository admin with scope `repo` (and `admin:repo_hook`, except compose); preflight checks. Worker and non-Actions unit-proof hosts pass Graphyard's probe `bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --share-net --die-with-parent -- true`.

### Providers

- `railway`: `npm i -g @railway/cli`, `railway login`.
- `hetzner`: `brew install hcloud`, `hcloud context create graphyard`; `--ssh-key NAME`, optional `--domain` (else Caddy certifies `<ip>.sslip.io`). A coordinator producing `manual:host-install-live` or a Hetzner `manual:…install…-live` proof needs `HCLOUD_TOKEN` and `HETZNER_SPEND_CAP_USD_MONTHLY` in repo-root `.env` (`0600`, uncommitted), else launch is refused; optional `HETZNER_SSH_KEY` names a registered key (else a throwaway one).
- `docker-host`: `ssh USER@HOST 'curl -fsSL https://get.docker.com | sh'`; `--ssh-host`, `--domain`.
- `compose`: `curl -fsSL https://get.docker.com | sh`; local evaluation only.

## Step 1: plan and approve

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan
```

Options: `--workers N`, `--producer-proof NAME`, `--required-check NAME` ([`init --scan`](operations-reference.md#setup-proposals-and-drift)); `delivery`, `release.*` plan the [candidate pipeline](delivery.md#managed-repositories). **Verify** `secretsRedacted` and every `preflight[].ok` are `true` (else run its `fix`); human approves plan and `drift`.

## Step 2: apply

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

Writes credentials, [variables](deployment.md#variables); deploys; [protects](github.md#require-the-check) the branch. **Verify** `GET /healthz`.

## Step 3: App confirmation

`--apply` serves and prints `http://127.0.0.1:4311`, opening no browser; the human installs the App there; **Verify** *App registered and installation verified*.

## Step 4: summary

**Verify** `health`, `webhook.delivered` (compose polls), `profiles.master.configured` `true`, `status.role` `admin`. Follow `nextSteps`; never read a `tokenFile`.

## Step 5: first pull request

Dispatch a [small item](onboarding.md#4-prove-the-first-pr); once `Graphyard / merge` appears, rerun `--apply` to require it and `graphyard/landable`. **Verify** both are required on the base branch; `--apply` is idempotent.

## Self-contained host

`--target host --ssh-host HOST` (or `--target hetzner`) runs server, Postgres, loop, executors, Herdr and the agent runtimes on one systemd machine, credentials `0600` in `~graphyard/.config/graphyard/<install>/`; without `--domain` a public IPv4 is served as `<ip>.sslip.io` (a private or `--local` address needs `--domain`); bootstrap installs gh and bubblewrap and checks its namespaces as `graphyard`. When the release image cannot be pulled, the host builds it from its Graphyard checkout at the installer's commit. Workers push and open pull requests as the App: git's credential helper and the `gh` wrapper mint one-hour tokens scoped to the repository from the App key in `<install>/github/`, so nobody logs into the host. Sign in with the printed link, then connect each runtime's account in Settings › Agents (Pi: **Pi (z.ai key)**). A re-apply that cannot read the host's credentials refuses rather than rotating them.

**Sizing:** 3 GB per concurrent agent, 2 GB per verification slot, 2 GB base, max(10%, 4 GB) spare; confirmed with `--confirm-price` / `--max-monthly`.

**GitHub App:** an App already saved for the repository (`--github-app FILE`, this install's, or the checkout's `.graphyard/github-app.json`) is reused once it mints a token, so one command reaches a running fleet; a webhook still serving another live installation stays there until `--migrate`. Only a first App registration is a human browser click.

**Moving:** `--migrate` stops the old loop, fences `GRAPHYARD_MIGRATE_DATABASE_URL` (`db fence`), restores; a failure before cutover releases the fence. Local logins move, others reconnect.

## Upgrading an existing installation

[Back up, deploy](deployment.md#backup-upgrade-rollback); beside `.graphyard/github-app.json` run `node "$GRAPHYARD_CLI" github-setup --update-permissions --wait 600` until `doctor` shows `appPermissions.missing` empty. `--apply` fixes `delegationLimits` drift (`Set GRAPHYARD_MAX_REVIEWERS=N`) and declares undeclared principals' `sessionKind`.

## Failure handling

| Symptom | Action |
| --- | --- |
| `Preflight is incomplete` | nothing created; run its `fix`, rerun |
| `Railway workspace` `false` | pass a listed `--workspace` |
| `... must be able to read ...github-private-key.pem` | connect as `root` or run printed `chown 1000:1000` |
| `did not become healthy` | `install --provider PROVIDER --repo OWNER/REPO --logs` |
| `The GitHub App confirmation did not complete in time` | rerun `--apply` (resumes) |
| `webhook.delivered` `false`, 401 | rerun `--apply` (rewrites secrets) |
| `Branch protection could not be applied` | admin `gh auth login`, rerun |
| worktree dependencies `failed` | [bubblewrap](#preconditions) |
| `Refusing to store installation credentials inside the managed repository` | `GRAPHYARD_CONFIG_HOME` outside every worktree |

## Agent execution contract

Run steps 1–5, report verifications; never weaken a gate.

## Manual fallback (unsupported platforms)

See [deployment](deployment.md#manual-fallback).
