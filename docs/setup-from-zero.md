<!-- page: Start here | 0 | setup checklist. -->
# From zero to a running Graphyard

> set up Graphyard for OWNER/REPO following docs/setup-from-zero.md

The setup agent acts as the **master** identity `install --apply` records; the operator credential stays with the human ([install hard rules](install.md#hard-rules)).

## One command: graphyard up

```sh
git clone https://github.com/cryptob1/graphyard.git ~/graphyard && (cd ~/graphyard && npm ci)
cd /path/to/REPO && node ~/graphyard/bin/graphyard.mjs up --agent --repo OWNER/REPO   # --provider compose (default), railway or hetzner
```

Only legacy `--merger github` needs a human (GitHub Mobile).

Hetzner waits (exit 3) for price approval: `--confirm-price`, `--max-monthly` or `--ssh-key`.

`up` runs, in order: preflight, control plane, host supervisor, Herdr, deploy key, merger setting (legacy: `github` only) and master identities (`master autonomy --apply`; no admin credential: exit 2; `--local` reviews and merges, [supervised](onboarding.md#supervised-mode-up---local)), onboarding, accounts (host logins), harness, master loop. The loop merges onboarding's pull request (host install: a person); goals wait. Reruns skip recorded `.graphyard/up.json` steps, redoing `master-loop` until loop and executors run this CLI's clean commit (`doctor`: `loop-code`); stale host executor launchers rebind (declared slots restart); foreign refused.

## The Setup page

A step needing a person prints one Setup-page link (`SERVER/#sign-in=CODE&setup`, valid 10 minutes), waits until green, then a fresh link; [phone access](dashboard.md#from-your-phone). Items:

| Item | Button
| --- | ---
| GitHub App, reviewer App | **Create the GitHub App** opens `up`'s App page (legacy merger); [control-plane](delivery-redesign.md#the-merger-setting): Done, not required
| Coding and reviewing accounts | **Connect an account** (API key or subscription sign-in)
| Branch protection, coordinator running | none (automatic; control-plane: Done, not required)
| Onboarding change: its wait | **Open the change**

Once green, **Describe what you want built** records a goal.

## Agent setup: up --agent

`up --agent` takes `[--goal FILE] [--browser-profile PROFILE] [--url URL]` (server: from `master.json` or install); exit `0`/`1`/`2`/`3` (green/failed/prerequisite/waiting), `step-failed` naming argv and stderr. Default: no Apps, browser profile or `--reviewer`; missing repo: `gh repo create --source . --push`; no `--local`. Apps in signed-in Chrome profile (passed, master's, same-login install's; none without `--reuse-app`/saved Apps: exit `2`) in `.graphyard/master-actions/`. Handoffs: subscription login approval, *Confirm access* Mobile number. Beside Mobile: App page (http://127.0.0.1:4311) in your browser; sudo code (`up --sudo-code`); import both Apps, `up --reuse-app SLUG --reuse-app REVIEWER_SLUG` (`--no-wait` → `3`). `--wait MINUTES` (20). Preflight refuses `/tmp`, `/var/tmp`.

## Troubleshooting: manual steps

`graphyard doctor` prints `setupFromZero.lines`: `PASS`/`FAIL` per prerequisite, naming its step; **HUMAN** marks agent-impossible steps.

## 1. Machine prerequisites

```sh
node --version          # v24+
gh auth status          # scope repo; non-compose providers also admin:repo_hook
docker compose version
herdr --version
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --share-net --die-with-parent -- true
```

**Verify:** each exits 0; `gh repo view OWNER/REPO --json viewerPermission -q .viewerPermission` prints `ADMIN`. **HUMAN:** `gh auth login` as a repository admin; user namespaces for `bwrap`; a free-plan private repository goes public.

## 2. Graphyard and the repository

Needs a GitHub `origin` and an Actions `pull_request` test workflow. **Verify:** doctor readiness `repository`, `required-checks` and `test-formats` are `ready`.

## 3. Install the control plane

`gy install --provider compose --repo OWNER/REPO --reviewer claude --plan`, then `--apply` ([install](install.md); `gy` is `node ~/graphyard/bin/graphyard.mjs`). `--apply` records the master connection `.graphyard/master.json`, its `0600` credential under `installDirectory`; `gy doctor` reads as it; `GRAPHYARD_TOKEN_FILE` overrides it. **Verify:** `control-plane` and `credentials-file` pass.

### Control-plane merger

`up --merger control-plane` creates an ed25519 deploy key, registers it read-write on OWNER/REPO and sets the [merger](delivery-redesign.md#the-merger-setting); no App, no branch protection. **Verify:** `github-app`, `reviewer-app` and `branch-protection` print `PASS ... not required (merger: control-plane)`; `merger` passes (github: FAIL; this migrates it).

## 4. Register the GitHub App

Legacy merger only. `--apply` serves `http://127.0.0.1:4311` and prints it; it opens no browser ([900 s, then `resume`](install.md#step-3-app-confirmation)). **HUMAN:** create the App, install it on OWNER/REPO only. **Verify:** `github-app` passes; on `missing permissions`, `gy github-setup --update-permissions --wait 600` ([permissions](github.md#app-permissions)). Reviewer and revert-approver Apps: `--reviewer claude` registers both (else `gy master reviewer setup`); **Verify:** `reviewer-app`. Branch protection: `--apply` protects the base; rerun once `Graphyard / merge` requires it; **Verify:** `branch-protection`.

## 6. Onboard the checkout

`gy init --scan`, then `gy init --scan --apply --url SERVER`; merge `AGENTS.md .gitignore graphyard.json .github/workflows` to the base (never `.graphyard/`). `--no-github-app` onboards App-less. **Verify:** readiness `setup-proposal` is `ready` ([onboarding](onboarding.md#documentation-policy)).

## 8. Agent environments

Connect accounts in Settings → Agents ([dashboard](dashboard.md#settings-agents)); host-logged-in accounts register with `gy master registry propose --apply`, profiles with `gy master environments --apply`; up runs both where the loop runs (host: `install --profiles-only`), issuing the install's `workers/` credentials and naming refused ones; account lines wait for both. Unknown-reviewer-profile refusals: one `gy master status` attention, uncounted five-minute retries. **Verify:** one `agent-environment:NAME` line passes per environment; then [roles](onboarding.md#configure-the-fleet).

## 9. Worker sandbox and harness rules

**Verify:** [`worker-sandbox`](master-agent-sessions.md#worker-sandbox) passes. `gy master harness claude --apply` allows the master's GitHub administration; merges stay [denied](master-agent-reference.md#github-administration-through-the-browser).

## 10. Start the master

[Start the master](onboarding.md#3-start-the-master):

```sh
gy master init --browser-profile Default \
  --token-stdin < "$(node -p "require('./.graphyard/master.json').credentialFile")"
gy master restart
```

**HUMAN:** `--browser-profile` names a GitHub-signed-in Chrome profile. **Verify:** `gy master status` shows `setup.supervisor` active.

## 11. Hosted variables (Railway only)

Set `RAILWAY_API_TOKEN` (**HUMAN:** issued by its owner) and size `GRAPHYARD_DATABASE_POOL_SIZE` ([limits](operations-reference.md)). **Verify:** doctor `production` has no `error`.

## 12. First item end to end

The Setup page's goal, or `gy master create item.json REASON` ([work.json](../examples/work.json)). **Verify:** `gy status GY-1` reaches `done`; doctor `production.serving` reaches the merge commit, `production.incidents` `[]` ([production observation](deployment.md#production-deployment-observation)).
