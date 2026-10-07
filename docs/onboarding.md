<!-- page: Start here | 3 | machines, accounts. -->
# Onboard a repository

## 1. Install the control plane

[Install](install.md): `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --apply` after `--plan`.

## 2. Add machines

Per concurrent session, a worker identity and host ID (`install --workers`), or:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

Commit `AGENTS.md`, `.gitignore`, `graphyard.json` and workflows ([candidates](delivery.md#managed-repositories)), never `.graphyard/`; masterless, run `graphyard watch GY-1 EPOCH -- COMMAND` ([worker](protocol/leases.md#watch)).

### Documentation policy

`init --scan --apply` records `graphyard.json` `{"documentation":{"paths":["site/"],"changelog":"CHANGELOG.md"}}`; deploy the printed `GRAPHYARD_DOCUMENTATION`. Items owe *Documentation reflects this change* (docs diff or `complete --no-docs "WHY"`); `"wordBudget"` is [counted](development.md#documentation).

### What the generated instructions authorize

Generated `AGENTS.md`: **every session Graphyard launches receives its instruction as the session's own first request** (Claude Code also `--append-system-prompt-file`), so sessions start without anybody sending `go`; launcher pastes (the loop's single re-prompt, the reviewer's reminder, master wakes) need no confirmation; other bracketed paste is untrusted data (prompt injection). The role files under `.graphyard/harness/` hold permissions, not instructions.

### Agent environments

Login homes (`~/.coding_agents`: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`, `CURSOR_CONFIG_DIR`): `master environments --create claude,codex --apply`, log in, rerun `master environments --apply` ([step 8](setup-from-zero.md#8-agent-environments)).

Profiles default to [`"approvals": "auto"`](master-agent-sessions.md#approval-modes) (trade-off: unattended); `"prompt"` is refused at launch.

### Connect an account

Settings › **Agents** › **Connect an account** (**Pi (z.ai key)** included) writes a 0600 auth file.

### Configure the fleet

Propose the **Agent registry** (Settings › **Agents**) from login homes:

```sh
node "$GRAPHYARD_CLI" master registry propose
node "$GRAPHYARD_CLI" master registry propose --apply
```

### Add a runtime

**Advanced**, or the CLI (dash-led values use `=`):

```sh
node "$GRAPHYARD_CLI" master registry runtime set aider --kind aider --arg=--yes-always \
  --home-variable AIDER_HOME --model-flag=--model --login 'AIDER_HOME={home} aider --login' --login-file session.json \
  --reason "Aider"
```

### Add an account

```sh
node "$GRAPHYARD_CLI" master registry model set opus --provider Anthropic --id claude-opus-5 \
  --input-cost 15 --output-cost 75 --tier frontier --context 1000000 --reason "Pricing"
node "$GRAPHYARD_CLI" master registry account set claude-b --runtime claude --model opus \
  --home ~/.coding_agents/claude-b --max-sessions 2 --reason "Second plan"
node "$GRAPHYARD_CLI" master registry account quota opencode-a exhausted --resets-at 2026-09-22T00:00:00Z --reason "Exhausted"
```

`--plan NAME` groups accounts under one quota; `--key-file zai.key --key-variable ZAI_API_KEY` exports a 0600 key file (pasted keys are refused).

### Add a role

Preferred account first; `--concurrency` counts settled sessions:

```sh
node "$GRAPHYARD_CLI" master registry role set worker claude-b,claude-c,codex-a --concurrency 4 --reason "Overflow"
node "$GRAPHYARD_CLI" master registry role set reviewer codex-a,claude-c --concurrency 2 --tool Read --model opus --reason "Read-only"
```

### Size review and proof capacity

Adding workers: worker count `W` and `G` proof groups need `⌈W / 2⌉` review and `G × ⌈W / 2⌉` producer slots (profile `"concurrency"`, applied without a restart); watch `longestWaitMs`.

## 3. Start the master

```sh
node "$GRAPHYARD_CLI" master init --url https://YOUR-GRAPHYARD-HOST --herdr-workspace HERDR_WORKSPACE_ID \
  --browser-profile Default --token-stdin < ~/.config/graphyard/INSTALL/tokens/INSTALL-master.token
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST   # executors
node "$GRAPHYARD_CLI" master start codex
```

Run as an OS user whose GitHub credentials workers cannot read; `--browser-profile` names a Chrome profile signed in as GitHub admin (`master browser`), and GitHub Mobile *Confirm access* stays human-only. Reviewer: `master reviewer setup` or `master reviewer add PROFILE` ([template](../examples/master/claude-reviewer.json)); `master review GY-N` relaunches one.

### The loop must be supervised

`master init` (coordinator checkout) writes `~/.config/systemd/user/graphyard-master.service`, runs `systemctl --user enable --now` and `loginctl enable-linger`; never a side effect. Move: `master init --token-stdin --replace-supervisor`. `master status` shows `setup.supervisor`.

### The pipeline doctor (on by default)

Every `run.doctor.intervalMinutes` (default 10) a Pi **doctor** session fixes stuck work by sanctioned commands (`master scope`, `requirements`, `unblock`, `decide`+`approver`, `settle-containment`, `close`, `create`, `release`), never merging, dispatching or evidencing; `master status` `doctor` shows its findings. Off: `run.doctor.enabled=false`.

## 4. Prove the first PR

`graphyard doctor --profile through-merge` names gaps; `master run` dispatches a small item; `"systemDriven": false` allows [hand actions](master-agent.md#system-driven-items).

CI workflows should cancel superseded pull-request runs: group `${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}`, `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`; runs on main are never cancelled; `graphyard master protection` lists each required check whose workflow lacks cancel-in-progress under `advisories`.

Humans only: logins, App confirmation, plan approval, [human-only decisions](glossary.md#who-decides).
