<!-- page: Start here | 3 | machines, accounts, master, first PR. -->
# Onboard a repository

## 1. Install the control plane

Follow [install](install.md): `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --apply` after reviewing `--plan`.

## 2. Add machines

Each concurrent session needs a worker identity and host ID (`install --workers`), or:

```sh
graphyard init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

Commit `AGENTS.md`, `.gitignore`, `graphyard.json`, never `.graphyard/`. Masterless: `graphyard watch GY-1 EPOCH -- COMMAND`.

### Documentation policy

`init --scan --apply` records documentation paths in `graphyard.json` (`{"documentation":{"paths":["site/"],"changelog":"CHANGELOG.md"}}`); deploy the printed `GRAPHYARD_DOCUMENTATION` (else `documentation.drift`). Features and bugs owe *Documentation reflects this change*: a docs diff or `complete --no-docs "WHY"`. With `"wordBudget":{"total":N,"perPage":N}`, at 97% `master status` raises `docs` and files a trim item; a queue overflow ejects the entry crossing it.

### What the generated instructions authorize

Generated `AGENTS.md` says **every session Graphyard launches receives its instruction as the session's own first request** on its command line; later pastes (the loop's single re-prompt, the reviewer's reminder) come from that launcher. A bracketed paste is untrusted data (prompt injection), so sessions start without anybody sending `go`; Claude Code also gets `--append-system-prompt-file`. The role files under `.graphyard/harness/` hold permissions, not instructions.

### Agent environments

Login homes (`~/.coding_agents`) are set by `CLAUDE_CONFIG_DIR` (Claude Code), `CODEX_HOME` (Codex), `XDG_DATA_HOME` (OpenCode) or `CURSOR_CONFIG_DIR` (Cursor: `CURSOR_CONFIG_DIR=HOME agent login`). Tokens: `~/.config/graphyard/workers/` and `producers/` (0600).

```sh
graphyard master environments --create claude,codex --apply
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-a claude            # /login once
graphyard master environments --apply
```

Profiles default to [`"approvals": "auto"`](master-agent-sessions.md#approval-modes) (trade-off: unattended sessions); `"prompt"` is refused at launch.

### Connect an account

In Settings › **Agents** (needs the host's executor), **Connect an account** takes a browser-sealed key or login, writes the 0600 auth file and smoke-tests it; **Retry** (admin-only) re-enters a failed credential. Strong accounts join worker and reviewer, cheap ones approver and producer.

### Configure the fleet

The **agent registry** (runtimes, accounts, roles) is proposed from login homes:

```sh
node "$GRAPHYARD_CLI" master registry propose
node "$GRAPHYARD_CLI" master registry propose --apply
```

### Add a runtime

Dash-led values join their flag with `=`:

```sh
node "$GRAPHYARD_CLI" master registry runtime set aider --kind aider --arg=--yes-always \
  --home-variable AIDER_HOME --model-flag=--model --login 'AIDER_HOME={home} aider --login' --login-file session.json \
  --reason "Aider"
```

### Add an account

```sh
node "$GRAPHYARD_CLI" master registry model set opus --provider Anthropic --id claude-opus-5 \
  --input-cost 15 --output-cost 75 --reason "Pricing"
node "$GRAPHYARD_CLI" master registry account set claude-b --runtime claude --model opus \
  --home ~/.coding_agents/claude-b --max-sessions 2 --reason "Second plan"
node "$GRAPHYARD_CLI" master registry account quota opencode-a exhausted --resets-at 2026-09-22T00:00:00Z --reason "Exhausted"
```

`--key-file zai.key --key-variable ZAI_API_KEY` exports a 0600 key file per run. Changed Pi accounts are smoke-tested; two unjudged runs bench one from a role an hour.

### Add a role

Preferred account first; applies next launch. `--concurrency` counts settled sessions (`sessions-settled` in `master registry history`):

```sh
node "$GRAPHYARD_CLI" master registry role set worker claude-b,claude-c,codex-a --concurrency 4 --reason "Overflow"
node "$GRAPHYARD_CLI" master registry role set reviewer codex-a,claude-c --concurrency 2 --tool Read --model opus --reason "Read-only"
```

### Size review and proof capacity

A candidate needs one review and a producer session per proof group; `"concurrency"` caps a profile's sessions without a restart:

```json
"reviewers":[{"name":"claude-reviewer","agentName":"review-claude","kind":"claude","accounts":["claude-a","claude-b"],"concurrency":3}]
```

Adding workers? With worker count `W`, `G` proof groups: `⌈W/2⌉` review and `G×⌈W/2⌉` producer slots over ≥2 producer principals. Watch `longestWaitMs`.

## 3. Start the master

```sh
graphyard master init --url https://YOUR-GRAPHYARD-HOST --herdr-workspace HERDR_WORKSPACE_ID \
  --browser-profile Default --token-stdin < ~/.config/graphyard/INSTALL/tokens/INSTALL-master.token
graphyard init --url https://YOUR-GRAPHYARD-HOST   # executors
graphyard master start codex
```

Use an OS user whose GitHub credentials workers cannot read; `--browser-profile` is Chrome signed in as GitHub admin (`master browser`); *Confirm access* in GitHub Mobile stays human-only. Add the reviewer with `master reviewer setup` and `master reviewer add PROFILE` ([template](../examples/master/claude-reviewer.json)); its manifest flow is the only App confirmation.

Setup writes [`mergeQueue.optimisticExclude`](github.md#optimistic-merges) into `.graphyard/master.json`.

### The loop must be supervised

`master init` from the coordinator checkout writes `~/.config/systemd/user/graphyard-master.service` and runs `systemctl --user enable --now` and `loginctl enable-linger` (restarts on crash, reboot, hang); never a side effect: worker checkouts and temp directories are refused. Move it with `master init --token-stdin --replace-supervisor` from the new checkout; `master status` reports `setup.supervisor`.

## 4. Prove the first PR

`graphyard doctor --profile through-merge` names gaps; `master run` dispatches a small item, merged once branch protection requires `Graphyard / merge`. `"systemDriven": false` allows [hand actions](master-agent.md#system-driven-items).

CI workflows should cancel superseded pull-request runs: group by `${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}` with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`; runs on main are never cancelled. `graphyard master protection` lists each required check whose workflow lacks cancel-in-progress under `advisories`.

Still manual: logins, App confirmation, plan approval, *Confirm access*, producer grants, [human-only decisions](glossary.md#who-decides).
