<!-- page: Start here | 0 | setup checklist. -->
# From zero to a running Graphyard

> set up Graphyard for OWNER/REPO following docs/setup-from-zero.md

The setup agent acts as the **master** identity `install --apply` records; the operator credential stays with the human. The [install hard rules](install.md#hard-rules) apply.

## One command: graphyard up

```sh
git clone https://github.com/cryptob1/graphyard.git ~/graphyard && (cd ~/graphyard && npm ci)
cd /path/to/REPO && node ~/graphyard/bin/graphyard.mjs up --repo OWNER/REPO   # --provider compose (default), railway or hetzner
```

A new Hetzner server waits (exit 3) for price approval; rerun: `--confirm-price X` or `--max-monthly N` and `--ssh-key NAME`.

`up` runs, in order: preflight, control plane, host supervisor and Herdr, master identities (`master autonomy --apply`; host installs: on the server; no admin credential: exit 2; `--local`: none, you review and merge, [supervised](onboarding.md#supervised-mode-up---local)), onboarding, accounts (host logins; asks for empty roles), harness, master loop. Onboarding files its `graphyard/onboarding` pull request for the loop to review and merge (a host install leaves it to a person); goals wait. Reruns skip steps `.graphyard/up.json` records finished, reusing its `--repo`/`--provider`. A Herdr plugin bound elsewhere stays (`--no-herdr`). Preflight failures (exit 2) name the [prerequisite](#1-machine-prerequisites).

## The Setup page

A step needing a person prints one link (`SERVER/#sign-in=CODE&setup`, minted from the operator credential or a host install's claim) and waits until green; it signs you in once (within 10 minutes) to the Setup page (also Settings → Agents). Green runs end with a fresh link; [phone access](dashboard.md#from-your-phone). Items:

| Item | Button
| --- | ---
| GitHub App, reviewer App | **Create the GitHub App** opens `up`'s App page
| Coding and reviewing accounts | **Connect an account** (API key or subscription sign-in)
| Branch protection, coordinator running | none (automatic)
| Onboarding change: its wait | **Open the change**

Once green (onboarding merged), **Describe what you want built** records a goal (`graphyard goal`).

## Agent setup: up --agent

Agents run `graphyard up --agent --repo OWNER/REPO [--goal FILE] [--browser-profile PROFILE]`: JSON events on stderr, summary stdout; exit `0` green, `1` failed, `2` prerequisite, `3` waiting. It creates the Apps in a GitHub-signed-in Chrome profile (passed, else the master's; neither, without `--reuse-app` or saved Apps for both: exit `2`), recorded under `.graphyard/master-actions/`; sets deployment variables from saved credentials, records FILE as one goal. Only a device step becomes a `handoff`: a subscription login's approval, or *Confirm access*, saying if the drive shares your live Chrome (profile path) or a copy (profile name), offering: confirm in your Chrome on the named page (shared only; re-checked every 10 s); a code via the App page or `up --sudo-code CODE|email` (never recorded); `--github-mobile` (password link after 60 s); or, with no live moment, create both Apps at github.com/settings/apps/new as listed (no webhook URL), `graphyard app import` each, then `up --reuse-app SLUG --reuse-app REVIEWER_SLUG` (`--no-wait` exits `3` here). A drive giving up hands off the still-served App page. Human waits last `--wait MINUTES` (default 20); a same-repository/provider/profile rerun resumes pending *Confirm access*. Preflight refuses `/tmp` and `/var/tmp` checkouts.

## Troubleshooting: manual steps

What `up` runs; **HUMAN**: agents cannot. `graphyard doctor` prints `setupFromZero.lines`: `PASS`/`FAIL` per prerequisite, failures naming their step, `next` the first gap.

## 1. Machine prerequisites

```sh
node --version          # v24 or later
gh auth status          # scope repo; non-compose providers also admin:repo_hook
docker compose version
herdr --version
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --share-net --die-with-parent -- true
```

**Verify:** each exits 0; `gh repo view OWNER/REPO --json viewerPermission -q .viewerPermission` prints `ADMIN`. **HUMAN:** `gh auth login` as a repository admin; user namespaces for `bwrap`; a free-plan private repository goes public.

## 2. Graphyard and the repository

The repository needs a GitHub `origin` and an Actions `pull_request` test workflow (the required check). **Verify:** doctor readiness `repository`, `required-checks` and `test-formats` are `ready`.

## 3. Install the control plane

`gy install --provider compose --repo OWNER/REPO --reviewer claude --plan`, then `--apply` ([install](install.md); `gy` is `node ~/graphyard/bin/graphyard.mjs`). Before the App step, `--apply` records the master connection `.graphyard/master.json`, its `0600` credential under the plan's `installDirectory`; `gy doctor` reads as it; `GRAPHYARD_TOKEN_FILE` overrides that credential (approver sessions require it). **Verify:** `control-plane` and `credentials-file` pass.

## 4. Register the GitHub App

`--apply` serves `http://127.0.0.1:4311` and prints it; it opens no browser ([900 s, then `resume`](install.md#step-3-app-confirmation)). **HUMAN:** create the App, install it on OWNER/REPO only. **Verify:** `github-app` passes; on `missing permissions`, `gy github-setup --update-permissions --wait 600` ([permissions](github.md#app-permissions)).

## 5. Reviewer and revert-approver Apps

`--reviewer claude` registers the reviewer App and revert approver (`GRAPHYARD_REVERT_APPROVER_*`, reset by every `--apply`). **Verify:** `reviewer-app` and readiness `revert-approver` pass; outside `install`, `gy master reviewer setup` and [variables](deployment.md#variables).

## 6. Onboard the checkout

`gy init --scan` (reads `node --test` as `node:test`, reporting `junit-xml-v1`), then `gy init --scan --apply --url http://127.0.0.1:4310`; merge `AGENTS.md .gitignore graphyard.json .github/workflows` to the base (never `.graphyard/`). **Verify:** readiness `setup-proposal` is `ready` ([onboarding](onboarding.md#documentation-policy)).

## 7. Branch protection

`--apply` protects the base branch; once the first pull request shows `Graphyard / merge`, rerun it (or `up`) to require that check. **Verify:** `branch-protection` passes.

## 8. Agent environments

Connect each account in Settings → Agents ([dashboard](dashboard.md#settings-agents)); host-logged-in accounts register with `gy master registry propose --apply`. **Verify:** one `agent-environment:NAME` line passes per environment (Claude: `skipDangerousModePermissionPrompt` consent, `hasCompletedOnboarding`); then [roles](onboarding.md#configure-the-fleet).

## 9. Worker sandbox and harness rules

**Verify:** `worker-sandbox` passes ([worker sandbox](master-agent-sessions.md#worker-sandbox)). `gy master harness claude --apply` allows the master's GitHub administration; merges stay [denied](master-agent-reference.md#github-administration-through-the-browser).

## 10. Start the master

[Start the master](onboarding.md#3-start-the-master):

```sh
gy master init --browser-profile Default \
  --token-stdin < "$(node -p "require('./.graphyard/master.json').credentialFile")"
gy master restart
```

**HUMAN:** `--browser-profile` names a GitHub-signed-in Chrome profile. **Verify:** `gy master status` shows `setup.supervisor` active.

## 11. Hosted variables (Railway only)

Set `RAILWAY_API_TOKEN` (**HUMAN:** the account owner issues it) and size `GRAPHYARD_DATABASE_POOL_SIZE` ([limits](operations-reference.md)). **Verify:** doctor `production` has no `error`.

## 12. First item end to end

The Setup page's goal, or `gy master create item.json REASON` ([work.json](../examples/work.json)). **Verify:** `gy status GY-1` reaches `done`; doctor `production.serving` reaches the merge commit, `production.incidents` `[]` ([production observation](deployment.md#production-deployment-observation)). Without a deploy job, merged ends it.
