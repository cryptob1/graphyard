<!-- page: Start here | 0 | the one command and upgrades. -->
# Install Graphyard

One instruction runs this runbook:

> install Graphyard for OWNER/REPO on PROVIDER following docs/install.md

A person is asked for four things: **Which provider** (and `--workspace` on multi-workspace Railway); **Provider login** they own; **the GitHub App confirmation click**, once; **Approval of the printed plan**. Never invent a fifth.

## Hard rules

- **Never print, echo, `cat`, log, paste, or commit a credential.**
- **One principal per role:** `--workers N`; never share a worker credential.
- **Workers never receive an admin, coordinator, or producer credential.**
- **Proof producers get explicit grants only** (`--producer-proof NAME` per proof).
- Credentials live only in `~/.config/graphyard/<install>/`: directory `0700`, files `0600`.

## Preconditions

Node 24; a checkout of `OWNER/REPO`; `export GRAPHYARD_CLI=…`; `gh auth status` as repository admin (`repo,admin:repo_hook`).

Worker and non-Actions unit-proof hosts need bubblewrap: `bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --share-net --die-with-parent -- true` (the probe Graphyard runs) must succeed (Ubuntu 24.04: `sysctl kernel.apparmor_restrict_unprivileged_userns=0`).

### Providers

- `railway`: `npm i -g @railway/cli`, `railway login`.
- `hetzner`: `hcloud context create graphyard` (`brew install hcloud` first); needs `--ssh-key NAME` (`--domain` optional; without it Caddy certifies `<ip>.sslip.io`).
  A coordinator that produces `manual:install-hetzner-live` also needs `HCLOUD_TOKEN` and `HETZNER_SPEND_CAP_USD_MONTHLY` in the repository-root `.env` (mode `0600`, never committed); without them that launch is refused.
- `docker-host`: `ssh USER@HOST 'curl -fsSL https://get.docker.com | sh'`; needs `--ssh-host` and `--domain`.
- `compose`: `curl -fsSL https://get.docker.com | sh`; local evaluation only.

## Step 1: print the plan

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan
```

Options: `--workers N`, `--producer-proof NAME`, `--required-check NAME`, `--domain`; `init --scan` [proposes](operations-reference.md#setup-proposals-and-drift) names.

**Verify:** `secretsRedacted` and every `preflight[].ok` `true` (else run its `fix`).

## Step 2: approve the plan

Show the human the plan and any `drift`.

## Step 3: apply

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

It writes credentials, sets [variables](deployment.md#variables), deploys, applies [branch protection](github.md#require-the-check); **Verify** `/healthz`.

## Step 4: the GitHub App confirmation

At the printed `http://127.0.0.1:4311` the human registers and installs the App; **Verify** *App registered and installation verified*.

## Step 5: read the summary

**Verify:** `health`, `webhook.delivered`, `profiles.master.configured` `true`, `status.role` `admin`; follow `nextSteps`; never read a `tokenFile`.

## Step 6: the first pull request

Dispatch a small item ([onboarding](onboarding.md#4-prove-the-first-pr)); once `Graphyard / merge` appears, rerun `--apply`, which requires it and `graphyard/landable`, both bound to the App. **Verify** both checks required on the base branch.

`--plan` and `--apply` are idempotent (`"satisfied"`, `drift`); tokens never rotate.

## Self-contained host

`--target host --ssh-host HOST` (or `--target hetzner`) runs server, Postgres, loop, executors, Herdr and the agent runtimes on one systemd machine, credentials `0600` in `~graphyard/.config/graphyard/<install>/`; without `--domain` a public IPv4 is served as `<ip>.sslip.io` (a private or `--local` address needs `--domain`); bootstrap installs gh and bubblewrap and checks its namespaces as `graphyard`. When the registry has no release image, the host builds it from its Graphyard checkout at the installer's commit. Workers push and open pull requests as the App: git's credential helper and the `gh` wrapper mint one-hour tokens scoped to the repository from the App key in `<install>/github/`, so nobody logs into the host. Sign in with the printed link, then connect each runtime's account in Settings › Agents (Pi: **Pi (z.ai key)**). A re-apply that cannot read the host's credentials refuses rather than rotating them.

**Sizing:** 3 GB per concurrent agent, 2 GB per verification slot, 2 GB base, max(10%, 4 GB) spare; confirmed with `--confirm-price` / `--max-monthly`.

**GitHub App:** an App already saved for the repository (`--github-app FILE`, this install's, or the checkout's `.graphyard/github-app.json`) is reused once it mints a token, so one command reaches a running fleet; a webhook still serving another live installation stays there until `--migrate`. Only a first App registration is a human browser click.

**Moving:** `--migrate` stops the old loop, fences `GRAPHYARD_MIGRATE_DATABASE_URL` (`db fence`), restores; a failure before cutover releases the fence. Local logins move, others reconnect.

## Upgrading an existing installation

A release needing a new App permission holds its jobs; [back up, deploy](deployment.md#backup-upgrade-rollback), then where `.graphyard/github-app.json` lives:

```sh
node "$GRAPHYARD_CLI" github-setup --update-permissions --wait 600
```

Confirm `doctor` shows `appPermissions.missing` empty; a re-run fixes `delegationLimits` drift (`GRAPHYARD_MAX_REVIEWERS`) and declares `sessionKind` (operator `human`, agents `ai`).

## Failure handling

| Symptom | Action |
| --- | --- |
| `Preflight is incomplete` | nothing created; run its `fix`, rerun |
| `Railway workspace` preflight `false` | rerun with a listed `--workspace` |
| `...github-private-key.pem` unreadable | connect as `root` or run the printed `chown 1000:1000` |
| `did not become healthy` | `install --provider PROVIDER --repo OWNER/REPO --logs` |
| `The GitHub App confirmation did not complete in time` | rerun `--apply`; it resumes |
| `webhook.delivered` `false`, 401 | rerun `--apply`; rewrites both secrets |
| `Branch protection could not be applied` | `gh auth login` as a repository admin, rerun |
| worktree dependencies `failed` | [bubblewrap](#preconditions) |
| `Refusing to store installation credentials inside the managed repository` | point `GRAPHYARD_CONFIG_HOME` outside every worktree |

## Agent execution contract

Follow steps 1–6; report verification; never weaken a gate.

## Manual fallback (unsupported platforms)

See [deployment](deployment.md#manual-fallback).
