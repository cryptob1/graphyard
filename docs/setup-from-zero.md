<!-- page: Start here | 0 | set up and diagnose prerequisites -->
# From zero to a running Graphyard

Setup uses the recorded master identity. The operator credential stays with the human.

## One command: graphyard up

```sh
git clone https://github.com/cryptob1/graphyard.git ~/graphyard
cd ~/graphyard && npm ci
cd /path/to/REPO
node ~/graphyard/bin/graphyard.mjs up --agent --repo OWNER/REPO
```

Compose is default; `--provider local` uses embedded Postgres. `up` installs the control plane, supervisors, Herdr, deploy key, identities, onboarding and fleet. Reruns resume `.graphyard/up.json`; master-loop repeats until the loop loads this CLI's commit. `master autonomy --apply` needs admin authority; `--local` skips autonomy setup and selects [supervised mode](onboarding.md#supervised-mode-up---local).

## The Setup page

Missing personal accounts or credentials produce a Setup link. Agents handle routine commands without human approval.

## Agent setup: up --agent

`up --agent [--url URL]` exits 0 (ready), 1 (failed), 2 (prerequisite) or 3 (waiting). Authorized agents can create a missing repository with `gh repo create --source . --push`. Installs under `/tmp` and `/var/tmp` refuse.

## Troubleshooting: manual steps

`doctor` prints PASS/FAIL and the checklist step that fixes each failure. HUMAN means a person's prerequisite. `FAIL unit-overrides` names conflicting systemd drop-ins and removal commands. Below, `gy` means `node "$GRAPHYARD_CLI"`.

## 1. Machine prerequisites

Check Node 24+, repository-admin `gh auth status`, `herdr --version`, and `docker compose version` for Compose. Probe confinement:

```sh
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --share-net --die-with-parent -- true
```

## 2. Graphyard and the repository

`up` sets SSH origin. If needed: `git remote set-url origin git@github.com:OWNER/REPO.git`. Verify doctor's `repository` and `test-formats`.

## 3. Install the control plane

Follow [install](install.md): plan, then `--apply` records `.graphyard/master.json` with the master credential path. Verify `control-plane` passes.

### Control-plane merger

Apply registers the [deploy key](install.md#step-3-deploy-key). Nothing else is registered on the remote.

## 6. Onboard the checkout

`gy init --scan --apply --url SERVER` writes repository instructions and policy. `up` submits them as GY-1 through normal gates. Verify `setup-proposal` is ready and `gy status GY-1` exists.

## 8. Agent environments

[Connect accounts and configure roles](onboarding.md#agent-environments). Each `agent-environment:NAME` should pass.

## 9. Worker sandbox and harness rules

Verify [worker-sandbox](master-agent-sessions.md#worker-sandbox) passes.

## 10. Start the master

Run `gy master init --token-stdin < "$(node -p "require('./.graphyard/master.json').credentialFile")"`, then `gy master restart`. Verify `master status` → `setup.supervisor` is active. [Cycles alone do not prove delivery](master-agent.md#master-wake-and-delivery-progress).

## 12. First item end to end

`gy master create item.json REASON`; follow Done, serving commit and required live checks.
