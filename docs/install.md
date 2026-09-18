# Install Graphyard

One command installs a complete Graphyard control plane for a GitHub repository on the
compute you choose. This page is the runbook for that command. It is written so that
`claude`, `codex`, `cursor-agent`, `opencode`, or a person can execute it end to end from a
single instruction:

> install Graphyard for OWNER/REPO on PROVIDER following docs/install.md

Everything else — Postgres, the application container, an HTTPS URL, every credential, the
GitHub App, the webhook, branch protection, CI identity discovery, agent profiles, and the
verification pass — is performed by the installer.

## What a person is asked for

Exactly four things, and nothing else:

1. **Which provider**, supplied in the instruction.
2. **Provider login**, once, in a terminal (`railway login`, `hcloud context create`, an SSH key, or a local Docker daemon).
3. **The GitHub App confirmation click**, once, in a browser page the installer opens.
4. **Approval of the printed plan**, before anything is applied.

If you are an agent executing this runbook, stop and ask the human only for those four
things. Never invent a fifth.

## Hard rules

These are not style preferences. Breaking one invalidates the installation.

- **Never print, echo, `cat`, log, paste, or commit a credential.** The installer redacts
  every secret it emits; do not defeat that by reading a token file yourself.
- **One principal per role.** Admin, coordinator, reader, and each concurrent worker get a
  separate crypto-random credential. Use `--workers N` for N concurrent implementation
  sessions; never share one worker credential between two sessions.
- **Workers never receive an admin, coordinator, or producer credential.** An
  implementation agent that holds one can manufacture its own proof.
- **Proof producers get explicit grants only.** A producer principal is created only when
  you pass `--producer-proof NAME`, once per proof that runner is allowed to submit.
  Never widen an existing producer's allowlist to a proof from another lane.
- **Credentials live only under `~/.config/graphyard/<install>/`**, directory mode `0700`,
  files mode `0600`. Never inside a repository, never in `.env`, never in a chat message.
- If a credential is exposed by accident, treat it as compromised: rerun the installer with
  a fresh installation directory and revoke the old principal on the server.

## Preconditions

Check each one before starting. Every row has a command and the output that means "ready".

| Requirement | Check | Ready when | If not ready |
| --- | --- | --- | --- |
| Node 24 | `node --version` | starts with `v24.` | Install Node 24 |
| Git | `git --version` | any version prints | Install Git |
| The managed repository checkout | `git remote get-url origin` | prints a `github.com` URL for `OWNER/REPO` | `cd` into the correct checkout |
| Graphyard CLI | `node "$GRAPHYARD_CLI" help` | prints the command list | `export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs` |
| GitHub CLI, authenticated | `gh auth status` | reports a logged-in account | `gh auth login --scopes repo,admin:repo_hook` |
| Repository administration | `gh api repos/OWNER/REPO --jq .permissions.admin` | `true` | Use an account that administers the repository |
| Provider access | see the provider table below | the provider check succeeds | run the provider's login command |

Graphyard is not published to npm yet, so the CLI is invoked from a Graphyard checkout:

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
```

### Providers

| Provider | Check | Login | Notes |
| --- | --- | --- | --- |
| `railway` | `railway whoami` | `railway login` | Managed Postgres, managed TLS domain |
| `hetzner` | `hcloud context active` | `hcloud context create graphyard` | Creates the server, volume, Docker, and Caddy TLS |
| `docker-host` | `ssh USER@HOST docker version` | your SSH key | Any existing Docker host; pass `--ssh-host` |
| `compose` | `docker compose version` | none | One machine, loopback only, for evaluation |

`hetzner` and `docker-host` need `--domain` for publicly trusted TLS. Point the domain's A
record at the host first. Without a domain, Caddy issues an internal certificate and the
endpoint is encrypted but not publicly trusted; the installer says so rather than hiding it.

## Step 1 — print the plan

The plan applies nothing. It touches no provider, no repository, and no file on this
machine — not even the credential directory, which is why a first plan shows `"note":
"generated on apply"` where a later one shows a fingerprint. It is safe to run repeatedly.

```sh
cd /path/to/OWNER/REPO
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan
```

Add the options the instruction called for:

| Option | Use |
| --- | --- |
| `--domain HOST` | The public hostname to serve on |
| `--workers N` | Number of concurrent implementation sessions (default 1) |
| `--producer-proof NAME` | Allow a CI producer to submit exactly this proof; repeatable |
| `--reviewer NAME` | Also register a separate reviewer GitHub App |
| `--review-policy github\|agent` | Native approvals (default) or Graphyard-bound agent review. It raises a weaker branch to the policy's count and never lowers a stricter one |
| `--ssh-host HOST` / `--ssh-user USER` | Target for `docker-host` |
| `--base-branch NAME` | Protected base branch (default `main`) |
| `--port N` | Host port for a local `compose` install (default 4310) |

**Expected output** is a JSON plan:

```json
{
  "version": 1,
  "repository": "OWNER/REPO",
  "provider": "PROVIDER",
  "installDirectory": "/home/you/.config/graphyard/owner-repo",
  "existing": false,
  "secretsRedacted": true,
  "preflight": [ { "name": "Railway CLI", "ok": true, "detail": "…" } ],
  "actions": [ { "id": "local.credentials", "state": "create", "title": "…" } ],
  "drift": [],
  "humanSteps": [ "…" ]
}
```

**Verify before continuing:**

- `secretsRedacted` is `true` and every `values[].value` of a secret is `[redacted]`.
- Secrets that do not exist yet carry `"note": "generated on apply"`; existing ones carry a
  12-character `fingerprint`, which is a hash prefix and not a credential.
- Every `preflight[].ok` is `true`.
- `actions` ends with `local.herdr`, and contains `provider.env.core`, `github.app`,
  `github.protection`, `verify.status`, and `verify.webhook`.

**If a preflight item is `false`**, its `fix` field holds the exact command to run. Run it,
then rerun `--plan`. Do not continue with a failing preflight: `--apply` rechecks preflight
itself, refuses to start, and changes nothing — it creates no credential directory, generates
no token, and writes no database password until every item passes. Stopping here leaves
nothing on this machine to clean up or rotate.

## Step 2 — approve the plan

Show the plan to the human and get an explicit approval. An agent must not approve on the
human's behalf. Ask about anything in `drift` before applying it.

## Step 3 — apply

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

The installer performs the plan in order:

1. Rechecks preflight, then generates one credential per principal under
   `~/.config/graphyard/<install>/tokens/` (mode `0600`). Nothing is written before that check
   passes; an existing installation keeps the credentials it already has.
2. Provisions Postgres and the application container on the provider.
3. Sets `HOST`, `PORT`, `DATABASE_URL`, `GRAPHYARD_PRINCIPALS`, `GITHUB_REPOSITORY`, and `GITHUB_BASE_BRANCH`.
4. Deploys and obtains a public HTTPS URL.
5. Verifies `GET /healthz`.
6. Opens the GitHub App manifest flow — **this is the human click**, see Step 4.
7. Writes `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_PRIVATE_KEY`, and `GITHUB_WEBHOOK_SECRET` to the server and redeploys.
8. Points the App webhook at `https://YOUR-HOST/api/github/webhook` with the secret the server holds.
9. Detects the GitHub App IDs publishing checks on the base branch and sets `GITHUB_CI_APP_IDS`.
10. Applies branch protection: strict status checks, conversation resolution, administrator enforcement,
    no force pushes, no branch deletion, and at least the approving-review count of the chosen review
    policy. Protection is read-modify-write and only ever tightens: an existing check, reviewer
    restriction, dismissal restriction, higher review count, or branch lock is preserved, so
    `--review-policy agent` never lowers a branch that already requires human approvals. A branch that
    still allows force pushes or deletion is reported as drift and corrected, whatever else it already
    requires: evidence is bound to a commit, and a force push replaces the commit underneath it.
11. Verifies authenticated `GET /api/status` and one real webhook delivery.
12. Registers master, reviewer, and worker profiles for the authenticated agent runtimes on this machine, and binds Herdr when it is installed.

## Step 4 — the GitHub App confirmation

While Step 3 runs, the installer prints one line:

```text
Open http://127.0.0.1:4311 in a browser on this machine and confirm the Graphyard App,
then install it on OWNER/REPO. Over SSH, forward port 4311 first.
```

Ask the human to open that page, register the App, and install it on the managed
repository. GitHub returns the App ID, private key, and webhook secret directly to this
machine; nothing is copied by hand and no key is printed.

Over SSH, forward the port first:

```sh
ssh -L 4311:127.0.0.1:4311 USER@HOST
```

With `--reviewer NAME` there is a second, clearly announced confirmation for the reviewer
App. A reviewer is a separate GitHub identity that reads code and writes pull request
comments; it can never publish Graphyard's merge check or change branch protection.

**Verification:** the page reports *App registered and installation verified*, and the
installer continues on its own.

## Step 5 — read the summary

`--apply` prints a redacted summary:

```json
{
  "url": "https://YOUR-HOST",
  "webhookUrl": "https://YOUR-HOST/api/github/webhook",
  "check": "Graphyard / merge",
  "principals": [ { "id": "owner-repo-operator", "role": "admin", "fingerprint": "…", "tokenFile": "…" } ],
  "github": { "appId": 123456, "installationId": 654321, "ciAppIds": [15368] },
  "protection": "strict checks test, typecheck; 1 approving review(s); admin enforcement",
  "health": true,
  "status": { "role": "admin", "repository": "OWNER/REPO" },
  "webhook": { "delivered": true, "statusCode": 202 },
  "nextSteps": [ "…" ]
}
```

**Verify every one of these:**

| Field | Required value |
| --- | --- |
| `health` | `true` |
| `status.role` | `admin` |
| `status.repository` | `OWNER/REPO` |
| `status.githubAppId` | the same number as `github.appId` |
| `webhook.delivered` | `true` |
| `protection` | names the base branch checks and administrator enforcement |
| `profiles.master.configured` | `true` |
| `profiles.workers` | one entry per `--workers` |

`principals[].fingerprint` is a hash prefix, not a credential. `tokenFile` is a path; do not
read it, print it, or copy its contents anywhere.

Then read `nextSteps` and do what it says. It is generated from what actually happened, so
it is the authoritative list of what is still missing.

## Step 6 — the first pull request

```sh
open https://YOUR-HOST   # sign in with the admin credential file named in the summary
```

Create one small work item with real acceptance criteria, mark it ready, and dispatch a
worker. See [the first PR](first-pr.md) and [repository onboarding](onboarding.md#5-prove-the-first-pr).

`Graphyard / merge` does not exist on GitHub until Graphyard publishes it on the first
linked pull request. The installer therefore does not require a check that cannot yet pass.
When the summary's `nextSteps` says so, rerun `--apply` after that first pull request; the
installer then binds `Graphyard / merge` to the Graphyard App in branch protection.

## Re-running the installer

`--plan` and `--apply` are both idempotent and both safe to repeat.

- An existing installation is detected from `~/.config/graphyard/<install>/install.json` and
  from the provider itself. Actions that are already done are reported as `"state":
  "satisfied"` rather than proposed again.
- A value that differs from what the installer would set is reported in `drift`, with
  secrets compared by fingerprint (`sha:…`) and never shown.
- Credentials are never rotated by a re-run. An existing principal keeps its token, so live
  workers keep working, and the database password is generated once and reused.

Read `drift` before applying it. Drift is usually either a deliberate manual change someone
made on the provider, or a sign that two installations are pointed at one repository.

## Failure handling

| Symptom | Cause | Action |
| --- | --- | --- |
| `Preflight is incomplete` | a CLI is missing or not authenticated | nothing was created; run the `fix` command printed for that item, then rerun |
| `Run graphyard install from the checkout of the repository being managed` | wrong working directory | `cd` into the `OWNER/REPO` checkout |
| `This checkout is X; rerun from Y` | `--repo` and the Git origin disagree | correct `--repo` or change directory |
| `did not become healthy` | the container cannot start or reach Postgres | `node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --logs` |
| `The GitHub App confirmation did not complete in time` | nobody opened the browser page | rerun `--apply`; it resumes from the saved App credentials |
| `webhook.delivered` is `false` with `statusCode: 401` | the App webhook secret and `GITHUB_WEBHOOK_SECRET` differ | rerun `--apply`; it rewrites both sides |
| `webhook.delivered` is `false` with no delivery | GitHub cannot reach the URL | confirm the HTTPS URL is public and `GET /healthz` answers from outside |
| `Branch protection could not be applied` | `gh` is not an administrator of the repository | `gh auth login` as an admin account, then rerun |
| `No authenticated agent runtime was found` | no supported runtime is signed in here | sign in to a runtime and rerun, or add a profile with `master worker add` |
| `Refusing to store installation credentials inside the managed repository` | `GRAPHYARD_CONFIG_HOME` points inside the checkout | unset it, or point it outside every worktree |

Provider logs are scrubbed of every generated secret before they are shown:

```sh
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --logs
```

## Agent execution contract

An agent executing this runbook performs exactly this sequence and nothing more.

```sh
cd /path/to/OWNER/REPO
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs

# 1. Preconditions. Stop and report if any check fails.
node --version; git remote get-url origin; gh auth status

# 2. Plan. Report the plan to the human and wait for approval.
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --plan

# 3. Apply. Ask the human to open the printed browser page exactly once.
node "$GRAPHYARD_CLI" install --provider PROVIDER --repo OWNER/REPO --apply
```

Report the summary's verification table and `nextSteps` verbatim. Do not read a token file,
do not echo a credential, do not weaken a proof, a gate, or a protection setting to make the
installation finish, and do not continue past a failed verification.

## Manual fallback

The installer is the supported path. If you must configure a provider by hand — an
unsupported platform, or an existing deployment being adopted — use the provider reference
and the complete variables table in [deployment](deployment.md#manual-fallback). The manual
path sets the same variables the installer sets; it is slower and easier to get wrong.

## Related

- [How Graphyard works](how-graphyard-works.md) — the lifecycle and authority model.
- [Repository onboarding](onboarding.md) — what happens after the install command.
- [Deployment reference](deployment.md) — variables, replicas, backup, upgrade, rollback.
- [GitHub enforcement](github.md) — App permissions, protection, CI producers, reviewers.
- [Operations](operations.md) — stalled work, expired leases, rework, outages.
