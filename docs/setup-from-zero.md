<!-- page: Start here | 0 | setup checklist. -->
# From zero to a running Graphyard

> set up Graphyard for OWNER/REPO following docs/setup-from-zero.md

The setup agent acts as the **master** identity `install --apply` records; the operator credential stays with the human ([install hard rules](install.md#hard-rules)).

## One command: graphyard up

```sh
git clone https://github.com/cryptob1/graphyard.git ~/graphyard && (cd ~/graphyard && npm ci)
cd /path/to/REPO && node ~/graphyard/bin/graphyard.mjs up --agent --repo OWNER/REPO   # --provider compose (default), railway or hetzner
```

No step needs a human.

Hetzner waits (exit 3) for price approval: `--confirm-price`, `--max-monthly` or `--ssh-key`.

`up` runs, in order: preflight, control plane, host supervisor, Herdr, deploy key and master identities (`master autonomy --apply`; no admin credential: exit 2; `--local` skips them, [supervised](onboarding.md#supervised-mode-up---local)), onboarding, accounts (host logins), harness, master loop, goal — filed with the operator's admin credential (else the master's operator-agent identity holding intent:create; neither present: exit 2, never the install's worker credential). The loop merges onboarding's pull request (host install: a person); goals wait. Reruns skip `.graphyard/up.json` steps, redoing `master-loop` until loop and executors run this CLI's clean commit (`doctor`: `loop-code`); stale host executor launchers rebind (declared slots restart); foreign refused; the loop reports its CLI's checkout, never the managed repository's, self-upgrading only when managing its project (same directory, worktree, origin); else `upgrade:refused`; `up` upgrades. Its `.graphyard/held-cli` pin and snapshots live there: `master status` names, `up` lifts, units read.

## The Setup page

A step needing a person prints one Setup-page link (`SERVER/#sign-in=CODE&setup`, valid 10 minutes), waits until green, then a fresh link; [phone access](dashboard.md#from-your-phone). Items:

| Item | Button
| --- | ---
| GitHub App, reviewer App | Done, not required ([merger](delivery-redesign.md#the-merger))
| Coding and reviewing accounts | **Connect an account** (API key or subscription sign-in)
| Coordinator running | none (automatic)
| Onboarding change: its wait | **Open the change**

Once green, **Describe what you want built** records a goal.

## Agent setup: up --agent

`up --agent` takes `[--goal FILE] [--browser-profile PROFILE] [--url URL]` (server: from `master.json` or install); exit `0`/`1`/`2`/`3` (green/failed/prerequisite/waiting), `step-failed` naming argv and stderr. No GitHub App, branch protection, ruleset or `--reviewer`: the merge writer's deploy key is the only GitHub access, and `--reuse-app` is refused (GY-2009). Missing repo: `gh repo create --source . --push`; no `--local`. Handoff: subscription login approval. `--wait MINUTES` (20). Preflight refuses `/tmp`, `/var/tmp`.

## Troubleshooting: manual steps

`graphyard doctor` prints `setupFromZero.lines`: `PASS`/`FAIL` per prerequisite; **HUMAN** marks agent-impossible steps.

## 1. Machine prerequisites

```sh
node --version          # v24+
gh auth status          # scope repo (deploy-key registration); no provider needs admin:repo_hook
docker compose version
herdr --version
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --share-net --die-with-parent -- true
```

**Verify:** each exits 0; `gh repo view OWNER/REPO --json viewerPermission -q .viewerPermission` prints `ADMIN`. **HUMAN:** `gh auth login` as a repository admin; user namespaces for `bwrap`.

## 2. Graphyard and the repository

Needs a GitHub `origin`. Install writes no Actions workflows; the merge writer's trial is the gate. **Verify:** doctor readiness `repository` and `test-formats` are `ready`.

## 3. Install the control plane

`gy install --provider compose --repo OWNER/REPO --reviewer claude --plan`, then `--apply` ([install](install.md); `gy` is `node ~/graphyard/bin/graphyard.mjs`). `--apply` records the master connection `.graphyard/master.json`, its `0600` credential under `installDirectory`; `gy doctor` reads as it; `GRAPHYARD_TOKEN_FILE` overrides it. **Verify:** `control-plane` and `credentials-file` pass.

### Control-plane merger

`up` creates an ed25519 deploy key and registers it read-write on OWNER/REPO for the [merge writer](delivery-redesign.md#the-merger), which pushes through an SSH origin; no App, no branch protection. The loop re-registers a missing key each setup run. **Verify:** `github-app` and `reviewer-app` print `PASS ... not required (merger: control-plane)`.

## 4. Register the GitHub App

Not required for the control-plane merger: install and `up` register no App and write no branch protection ([github](github.md)). Doctor `github-app` / `reviewer-app` print `PASS ... not required`. Optional legacy observation-only binding remains via `graphyard app import` / `app bind`. Reviewer and revert-approver Apps: only when an observation-only install still uses them.

## 6. Onboard the checkout

`gy init --scan`, then `gy init --scan --apply --url SERVER`; merge `AGENTS.md .gitignore graphyard.json` to the base (never `.graphyard/` or `.github/workflows` — setup writes none). Scans skip `.claude`. **Verify:** `setup-proposal` is `ready` ([onboarding](onboarding.md#documentation-policy)).

## 8. Agent environments

Connect accounts ([dashboard](dashboard.md#settings-agents)); host-logged-in accounts register with `gy master registry propose --apply`, profiles with `gy master environments --apply`; up runs both where the loop runs (host: `install --profiles-only`), issuing the install's `workers/` credentials and naming refused ones; account lines wait for both. Unknown-reviewer-profile refusals: one `gy master status` attention, uncounted five-minute retries. **Verify:** one `agent-environment:NAME` line passes per environment; then [roles](onboarding.md#configure-the-fleet).

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
