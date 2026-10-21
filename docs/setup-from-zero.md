<!-- page: Start here | 0 | setup checklist. -->
# From zero to a running Graphyard

> set up Graphyard for OWNER/REPO following docs/setup-from-zero.md

The setup agent acts as the **master** identity `install --apply` records; the operator credential stays with the human.

## One command: graphyard up

```sh
git clone https://github.com/cryptob1/graphyard.git ~/graphyard && (cd ~/graphyard && npm ci)
cd /path/to/REPO && node ~/graphyard/bin/graphyard.mjs up --agent --repo OWNER/REPO   # --provider compose (default) or local
```

`up` runs: preflight, control plane, host supervisor, Herdr, deploy key and master identities (`master autonomy --apply`; no admin credential: exit 2; `--local` skips them, [supervised](onboarding.md#supervised-mode-up---local)), onboarding, accounts, harness, master loop, goal — filed with the operator's admin credential (else the master's operator-agent identity; neither: exit 2). The loop merges onboarding's change; goals wait. Reruns skip `.graphyard/up.json` steps, redoing `master-loop` until the loop runs this CLI's commit.

## The Setup page

A step needing a person prints a Setup-page link (`SERVER/#sign-in=CODE&setup`) and waits until green. Once green, **Describe what you want built** records a goal.

## Agent setup: up --agent

`up --agent` takes `[--goal FILE] [--url URL]`; exit `0`/`1`/`2`/`3` (green/failed/prerequisite/waiting). The deploy key is the only GitHub access. Missing repo: `gh repo create --source . --push`; preflight refuses `/tmp`, `/var/tmp`.

## Troubleshooting: manual steps

`graphyard doctor` prints `PASS`/`FAIL` per prerequisite; **HUMAN** marks agent-impossible steps; `FAIL unit-overrides` names each systemd drop-in and its removal command.

## 1. Machine prerequisites

```sh
node --version          # v24+
gh auth status          # scope repo (registers the deploy key)
docker compose version
herdr --version
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --share-net --die-with-parent -- true
```

**HUMAN:** `gh auth login` as a repository admin.

## 2. Graphyard and the repository

Needs a GitHub `origin` the deploy key pushes to over SSH. **Verify:** doctor readiness `repository` and `test-formats`.

## 3. Install the control plane

`gy install --provider compose --repo OWNER/REPO --plan`, then `--apply` ([install](install.md)); it records `.graphyard/master.json` with its `0600` credential. **Verify:** `control-plane` passes.

### Control-plane merger

`install --apply` (and `up`) creates an ed25519 deploy key and registers it read-write on OWNER/REPO for the [merge writer](delivery-redesign.md#the-merger), which trial-merges each submitted head and pushes through an SSH origin ([deploy key](install.md#step-3-deploy-key)). Nothing else is registered on the remote, and nothing asks for it. **Verify:** `gh repo deploy-key list -R OWNER/REPO` lists `graphyard-merge-writer-HOST`.

## 6. Onboard the checkout

`gy init --scan --apply --url SERVER`; merge `AGENTS.md .gitignore graphyard.json` to the base. **Verify:** `setup-proposal` is `ready`.

## 8. Agent environments

Connect accounts; host-logged-in accounts register with `gy master registry propose --apply`, profiles with `gy master environments --apply`. **Verify:** one `agent-environment:NAME` line passes per environment.

## 9. Worker sandbox and harness rules

**Verify:** [`worker-sandbox`](master-agent-sessions.md#worker-sandbox) passes.

## 10. Start the master

[Start the master](onboarding.md#3-start-the-master): `gy master init --token-stdin < "$(node -p "require('./.graphyard/master.json').credentialFile")"`, then `gy master restart`. **Verify:** `gy master status` shows `setup.supervisor` active.

## 12. First item end to end

The Setup page's goal, or `gy master create item.json REASON`. **Verify:** `gy status GY-1` reaches `done`.
