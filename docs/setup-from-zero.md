<!-- page: Start here | 0 | setup checklist. -->
# From zero to a running Graphyard

> set up Graphyard for OWNER/REPO following docs/setup-from-zero.md

The setup agent acts as the **master** identity `install --apply` records; the operator credential stays with the human. The [install hard rules](install.md#hard-rules) apply.

## One command: graphyard up

```sh
git clone https://github.com/cryptob1/graphyard.git ~/graphyard && (cd ~/graphyard && npm ci)
cd /path/to/REPO && node ~/graphyard/bin/graphyard.mjs up --agent --repo OWNER/REPO   # --provider compose (default), railway or hetzner
```

Its only human step: approving a GitHub Mobile prompt; `--help` lists options.

A new Hetzner server waits (exit 3) for price approval; rerun: `--confirm-price X` or `--max-monthly N` and `--ssh-key NAME`.

`up` runs: preflight, control plane, host supervisor and Herdr, master identities (`master autonomy --apply`; no admin credential: exit 2; `--local`: none, [supervised](onboarding.md#supervised-mode-up---local)), onboarding, accounts, harness, master loop. Onboarding files `graphyard/onboarding` for merge; goals wait. Reruns skip finished steps in `.graphyard/up.json`. Every run sets Herdr up (`install --herdr-only` on host). Preflight failures (exit 2) name the [prerequisite](#1-machine-prerequisites).

## The Setup page

A step needing a person prints one link (`SERVER/#sign-in=CODE&setup`) and waits until green; it signs you in once (within 10 minutes) to the Setup page (also Settings → Agents). Green runs end with a fresh link; [phone access](dashboard.md#from-your-phone). Items:

| Item | Button
| --- | ---
| GitHub App, reviewer App | **Create the GitHub App** opens `up`'s App page (GitHub merger); [control-plane](delivery-redesign.md#the-merger-setting): Done, not required
| Coding and reviewing accounts | **Connect an account** (API key or subscription sign-in)
| Branch protection, coordinator running | none (automatic; control-plane: Done, not required)
| Onboarding change: its wait | **Open the change**

Once green (onboarding merged), **Describe what you want built** records a goal (`graphyard goal`).

## Agent setup: up --agent

`up --agent` takes `[--goal FILE] [--browser-profile PROFILE]`: JSON on stderr; exit `0` green, `1` failed, `2` prerequisite, `3` waiting. Apps are created in a signed-in Chrome profile (passed, master's, or same-login install's; none without `--reuse-app`/saved Apps: exit `2`), under `.graphyard/master-actions/`. Device `handoff`: subscription approval or GitHub Mobile (≤3 prompts). Without Mobile: confirm in Chrome, `up --sudo-code CODE|email`, or `graphyard app import` both Apps then `up --reuse-app SLUG --reuse-app REVIEWER_SLUG` (`--no-wait` exits `3`). Waits `--wait MINUTES` (20); same repo/provider/profile resumes *Confirm access*. Preflight refuses `/tmp` and `/var/tmp`.

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

`gy install --provider compose --repo OWNER/REPO --reviewer claude --plan`, then `--apply` ([install](install.md); `gy` is `node ~/graphyard/bin/graphyard.mjs`). Before the App step, `--apply` records the master connection `.graphyard/master.json`, its `0600` credential under the plan's `installDirectory`; `gy doctor` reads as it; `GRAPHYARD_TOKEN_FILE` overrides it. **Verify:** `control-plane` and `credentials-file` pass.

## 4. Register the GitHub App

GitHub merger only (`control-plane`: `PASS github-app: not required (merger: control-plane)`). `--apply` serves `http://127.0.0.1:4311` (no browser; [900 s then `resume`](install.md#step-3-app-confirmation)). **HUMAN:** create and install the App on OWNER/REPO. **Verify:** `github-app` passes; on `missing permissions`, `gy github-setup --update-permissions --wait 600` ([permissions](github.md#app-permissions)).

## 5. Reviewer and revert-approver Apps

GitHub merger only (`control-plane`: same PASS for `reviewer-app`). `--reviewer claude` registers the reviewer App and revert approver (`GRAPHYARD_REVERT_APPROVER_*`). **Verify:** `reviewer-app` and readiness `revert-approver` pass; outside `install`, `gy master reviewer setup` and [variables](deployment.md#variables).

## 6. Onboard the checkout

`gy init --scan`, then `gy init --scan --apply --url http://127.0.0.1:4310`; merge `AGENTS.md .gitignore graphyard.json .github/workflows` to the base (never `.graphyard/`). Control-plane: worker block says `complete GY-N EPOCH --head SHA`. **Verify:** readiness `setup-proposal` is `ready` ([onboarding](onboarding.md#documentation-policy)).

## 7. Branch protection

GitHub merger only (`control-plane`: same PASS for `branch-protection`). `--apply` protects the base branch; once the first pull request shows `Graphyard / merge`, rerun it (or `up`) to require that check. **Verify:** `branch-protection` passes.

## 8. Agent environments

Connect each account in Settings → Agents ([dashboard](dashboard.md#settings-agents)); host-logged-in accounts register with `gy master registry propose --apply`. **Verify:** one `agent-environment:NAME` line passes per environment; then [roles](onboarding.md#configure-the-fleet).

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

The Setup page's goal, or `gy master create item.json REASON` ([work.json](../examples/work.json)). **Verify:** `gy status GY-1` reaches `done`; doctor `production.serving` reaches the merge commit, `production.incidents` `[]` ([production observation](deployment.md#production-deployment-observation)).
