<!-- page: Start here | 0 | setup checklist. -->
# From zero to a running Graphyard

> set up Graphyard for OWNER/REPO following docs/setup-from-zero.md

The setup agent acts as the **master** identity `install --apply` records; the operator credential stays with the human. The [install hard rules](install.md#hard-rules) apply.

## One command: graphyard up

```sh
git clone https://github.com/cryptob1/graphyard.git ~/graphyard && (cd ~/graphyard && npm ci)
cd /path/to/REPO && node ~/graphyard/bin/graphyard.mjs up --agent --repo OWNER/REPO   # --provider compose (default), railway or hetzner
```

Its only human step: approving a GitHub Mobile prompt (none with `--merger control-plane`).

A new Hetzner server waits (exit 3) for price approval; rerun: `--confirm-price X` or `--max-monthly N` and `--ssh-key NAME`.

`up` runs, in order: preflight, control plane, host supervisor and Herdr, (`--merger control-plane`: deploy key, merger setting,) master identities (`master autonomy --apply`; no admin credential: exit 2; `--local`: none, you review and merge, [supervised](onboarding.md#supervised-mode-up---local)), onboarding, accounts (host logins), harness, master loop. Onboarding files its `graphyard/onboarding` pull request for the loop to merge (a host install: a person); goals wait. Reruns skip steps `.graphyard/up.json` records. Every run sets Herdr up (host target: `install --herdr-only`).

## The Setup page

A step needing a person prints one link (`SERVER/#sign-in=CODE&setup`) and waits until green; it signs you in once (within 10 minutes) to the Setup page (also Settings → Agents). Green runs end with a fresh link; [phone access](dashboard.md#from-your-phone). Items:

| Item | Button
| --- | ---
| GitHub App, reviewer App | **Create the GitHub App** opens `up`'s App page (GitHub merger); [control-plane](delivery-redesign.md#the-merger-setting): Done, not required
| Coding and reviewing accounts | **Connect an account** (API key or subscription sign-in)
| Branch protection, coordinator running | none (automatic; control-plane: Done, not required)
| Onboarding change: its wait | **Open the change**

Once green, **Describe what you want built** records a goal (`graphyard goal`).

## Agent setup: up --agent

`up --agent` takes `[--goal FILE] [--browser-profile PROFILE]`: JSON events on stderr (`step-failed`: failing child's argv, stderr); exit `0` green, `1` failed (quoting GitHub's rejection), `2` prerequisite, `3` waiting. `--merger control-plane`: no Apps, browser profile, Mobile approval or `--reviewer`; a missing repository: `gh repo create --source . --push`; no `--local`. Otherwise it creates the Apps in a GitHub-signed-in Chrome profile (passed, else the master's, else a same-login install's; none, without `--reuse-app` or saved Apps: exit `2`), recorded under `.graphyard/master-actions/`. Only a device step becomes a `handoff`: a subscription login's approval, or *Confirm access*: a GitHub Mobile number. Without Mobile: confirm in your Chrome; give a code via `up --sudo-code CODE|email` (never recorded); or create both Apps at github.com/settings/apps/new, `graphyard app import` each, then `up --reuse-app SLUG --reuse-app REVIEWER_SLUG` (`--no-wait` exits `3`). Waits last `--wait MINUTES` (default 20). Preflight refuses `/tmp`, `/var/tmp` checkouts.

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

### Control-plane merger

`up --merger control-plane` creates an ed25519 deploy key, registers it read-write on OWNER/REPO through your `gh` login and sets the [merger](delivery-redesign.md#the-merger-setting) (`POST /api/merger`); the merge writer pushes with that key; no App, no branch protection. **Verify:** `github-app`, `reviewer-app` and `branch-protection` print `PASS ... not required (merger: control-plane)`.

## 4. Register the GitHub App

GitHub merger only. `--apply` serves `http://127.0.0.1:4311` and prints it; it opens no browser ([900 s, then `resume`](install.md#step-3-app-confirmation)). **HUMAN:** create the App, install it on OWNER/REPO only. **Verify:** `github-app` passes; on `missing permissions`, `gy github-setup --update-permissions --wait 600` ([permissions](github.md#app-permissions)). Reviewer and revert-approver Apps: `--reviewer claude` registers both (else `gy master reviewer setup`); **Verify:** `reviewer-app`. Branch protection: `--apply` protects the base; rerun once `Graphyard / merge` appears to require it; **Verify:** `branch-protection`.

## 6. Onboard the checkout

`gy init --scan`, then `gy init --scan --apply --url SERVER`; merge `AGENTS.md .gitignore graphyard.json .github/workflows` to the base (never `.graphyard/`). Control-plane: worker block says `complete GY-N EPOCH --head SHA`. **Verify:** readiness `setup-proposal` is `ready` ([onboarding](onboarding.md#documentation-policy)).

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
