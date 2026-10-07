<!-- page: Start here | 0 | a new repository to a merged first item, step by step. -->
# From zero to a running Graphyard

> set up Graphyard for OWNER/REPO following docs/setup-from-zero.md

One command, then the page it prints. The setup agent acts as the **master** identity `install --apply` records; the operator credential stays with the human and is never given to an agent. The [install hard rules](install.md#hard-rules) apply: never print a credential.

## One command: graphyard up

```sh
git clone https://github.com/cryptob1/graphyard.git ~/graphyard && (cd ~/graphyard && npm ci)
cd /path/to/REPO && node ~/graphyard/bin/graphyard.mjs up --repo OWNER/REPO   # --provider compose (default), railway or hetzner
```

A new Hetzner server waits (exit 3) on the operator approving its price: rerun with `--confirm-price X` or `--max-monthly N` and `--ssh-key NAME`, passed to `install`.

`up` runs every machine step in order: preflight, control plane, host supervisor and Herdr, onboarding, accounts, harness, master loop. Onboarding opens a `graphyard/onboarding` pull request with its files; goals wait for it to merge. Finished steps are recorded in `.graphyard/up.json`: a rerun skips them, registering nothing twice. A Herdr plugin bound to another server is left alone (`--no-herdr`), never repointed. A preflight failure (exit 2) names the [prerequisite](#1-machine-prerequisites) to fix.

## The Setup page

When a step needs a person, `up` prints one link and waits until the step is green. The link (`SERVER/#sign-in=CODE&setup` from the operator credential, or a host install's `#claim=CODE&setup`) signs you in once, within 10 minutes, and opens the Setup page (also linked from Settings → Agents). Each item is live, with one sentence and one button:

| Item | Button |
| --- | --- |
| GitHub App, reviewer App | **Create the GitHub App** opens `up`'s App page; create it, install it on OWNER/REPO only |
| An account that writes code, one that reviews | **Connect an account**: Settings → Agents → Connect (an API key, or a subscription sign-in) |
| Branch protection, coordinator running | none: Graphyard does these |

When all are green, **Describe what you want built** records a goal, like `graphyard goal`. Once the first pull request reports `Graphyard / merge`, rerun `up` to require it.

## Agent setup: graphyard up --agent

An agent sets Graphyard up with `graphyard up --agent --repo OWNER/REPO [--goal FILE] [--browser-profile PROFILE]`: JSON events on stderr, summary on stdout, exit `0` green, `1` failed, `2` prerequisite, `3` still waiting (rerun resumes). It creates the Apps in a Chrome profile signed in to GitHub (passed, else the master's; with neither it exits `2` first), recorded under `.graphyard/master-actions/`; connects accounts logged in on the host; sets deployment variables from saved credentials; records FILE as a goal once, likewise. Only a person's own device is handed off (GitHub Mobile, passkey, a subscription login's browser approval): a `handoff` event with one sentence and a link or code; the run then resumes.

## Troubleshooting: the manual steps

What `up` runs, for when a step fails; **HUMAN** marks what agents cannot do. `graphyard doctor` prints `setupFromZero.lines`: one `PASS`/`FAIL` line per prerequisite, each failure naming its step below; `next` names the first gap.

## 1. Machine prerequisites

```sh
node --version          # v24+
gh auth status          # scope repo; providers other than compose also admin:repo_hook
docker compose version  # compose
herdr --version         # Herdr panes
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --share-net --die-with-parent -- true
```

**Verify:** each exits 0 and `gh repo view OWNER/REPO --json viewerPermission -q .viewerPermission` prints `ADMIN`. **HUMAN:** `gh auth login` as a repository admin; user namespaces for `bwrap`; a free-plan private repository goes public.

## 2. Graphyard and the repository

The repository needs `origin` on GitHub and a GitHub Actions workflow running its tests on `pull_request`; that job becomes the required check. **Verify:** doctor readiness `repository`, `required-checks` and `test-formats` are `ready`.

## 3. Install the control plane

`gy install --provider compose --repo OWNER/REPO --reviewer claude --plan`, then `--apply` ([install](install.md); `gy` is `node ~/graphyard/bin/graphyard.mjs`). Before the App step, `--apply` records the master connection `.graphyard/master.json`, its `0600` credential under the plan's `installDirectory`; `gy doctor` reads as it. **Verify:** `control-plane` and `credentials-file` pass.

## 4. Register the GitHub App

`--apply` serves `http://127.0.0.1:4311` and prints it; it opens no browser ([900 s, then `resume`](install.md#step-3-app-confirmation)). **HUMAN:** create the App, install it on OWNER/REPO only. **Verify:** `github-app` passes; on `missing permissions`, `gy github-setup --update-permissions --wait 600` ([permissions](github.md#app-permissions)).

## 5. Reviewer and revert-approver Apps

`--reviewer claude` registers the reviewer App on the same page, also the revert approver (`GRAPHYARD_REVERT_APPROVER_*`, reset by every `--apply`). **Verify:** `reviewer-app` and readiness `revert-approver` pass; outside `install`, `gy master reviewer setup` and [variables](deployment.md#variables).

## 6. Onboard the checkout

`gy init --scan`, then `gy init --scan --apply --url http://127.0.0.1:4310`; merge `AGENTS.md .gitignore graphyard.json .github/workflows` to the base (never `.graphyard/`). **Verify:** readiness `setup-proposal` is `ready` ([onboarding](onboarding.md#documentation-policy)).

## 7. Branch protection

`--apply` protects the base branch; once the first pull request shows `Graphyard / merge`, rerun it so that check is required. **Verify:** `branch-protection` passes.

## 8. Agent environments

Connect each account in Settings → Agents → Connect ([dashboard](dashboard.md#settings-agents)); accounts already logged in on the host register with `gy master registry propose --apply`. **Verify:** one `agent-environment:NAME` line passes per environment; then [roles](onboarding.md#configure-the-fleet).

## 9. Worker sandbox and harness rules

**Verify:** `worker-sandbox` passes ([worker sandbox](master-agent-sessions.md#worker-sandbox)). `gy master harness claude --apply` allows the master's GitHub administration; merges stay [denied](master-agent-reference.md#github-administration-through-the-browser).

## 10. Start the master

[Start the master](onboarding.md#3-start-the-master) with the master credential:

```sh
gy master init --browser-profile Default \
  --token-stdin < "$(node -p "require('./.graphyard/master.json').credentialFile")"
gy master restart
```

**HUMAN:** `--browser-profile` names a Chrome profile signed in to GitHub. **Verify:** `gy master status` shows `setup.supervisor` active.

## 11. Hosted variables (Railway only)

Set `RAILWAY_API_TOKEN` (**HUMAN:** the account owner issues it) and size `GRAPHYARD_DATABASE_POOL_SIZE` ([limits](operations-reference.md)). **Verify:** doctor `production` has no `error`.

## 12. First item end to end

The Setup page's goal, or `gy master create item.json REASON` ([work.json](../examples/work.json)). **Verify:** `gy status GY-1` reaches `done`; doctor `production.serving` reaches the merge commit, `production.incidents` `[]` ([production observation](deployment.md#production-deployment-observation)). Without a deploy job, merged ends it.

Gaps found walking it: [setup-from-zero audit](setup-from-zero-audit.md).
