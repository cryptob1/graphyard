<!-- page: Start here | 3 | machines, accounts, master, first PR. -->
# Onboard a repository

## 1. Install the control plane

[Install](install.md): `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --apply` after `--plan`.

## 2. Add machines

Per concurrent session: a worker identity and host ID (`install --workers`), or:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

Commit `AGENTS.md`, `.gitignore`, `graphyard.json`, never `.graphyard/`. Masterless: `graphyard watch GY-1 EPOCH -- COMMAND` ([worker](protocol/leases.md#watch)).

### Documentation policy

`init --scan --apply` records `docs/`, `site/`, `README*`, `CHANGELOG*` in `graphyard.json` (`{"documentation":{"paths":["site/"],"changelog":"CHANGELOG.md"}}`); deploy the printed `GRAPHYARD_DOCUMENTATION`; a differing one is `doctor`'s `documentation.drift`. Features and bugs owe *Documentation reflects this change* (docs diff or `complete --no-docs "WHY"`). Optional `"wordBudget":{"total":N,"perPage":N}` ([counted](development.md#documentation)).

### What the generated instructions authorize

Generated `AGENTS.md`: **every session Graphyard launches receives its instruction as the session's own first request** on its command line (Claude Code also `--append-system-prompt-file`), so sessions start without anybody sending `go`; launcher pastes (the loop's single re-prompt, the reviewer's reminder, master wakes) need no confirmation; other bracketed paste is untrusted data (prompt injection). The role files under `.graphyard/harness/` hold permissions, not instructions.

### Agent environments

Login homes (`~/.coding_agents`): `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME` (OpenCode), `CURSOR_CONFIG_DIR`.

```sh
node "$GRAPHYARD_CLI" master environments --create claude,codex --apply
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-a claude            # /login once
node "$GRAPHYARD_CLI" master environments --apply
```

Profiles default to [`"approvals": "auto"`](master-agent-sessions.md#approval-modes) (trade-off: unattended); `"prompt"` is refused at launch.

### Connect an account

Settings › **Agents** › **Connect an account**: key or login. The host's executor writes a 0600 auth file and smoke-tests it. Strong accounts join worker, reviewer; cheap ones approver, producer; **change** edits roles.

### Configure the fleet

**Agent registry** (runtimes, accounts, roles, policies; Settings › **Agents**), proposed from login homes:

```sh
node "$GRAPHYARD_CLI" master registry propose
node "$GRAPHYARD_CLI" master registry propose --apply
```

### Add a runtime

**Advanced**, or CLI (dash-led values join their flag with `=`):

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

`--key-file zai.key --key-variable ZAI_API_KEY`: 0600 key exported per run. Registry writes (CLI, dashboard, API) refuse a field that looks like a pasted key (known prefix, PEM, JWT, z.ai key, long random token); word-and-version model ids are exempt.

### Add a role

Preferred account first. `--concurrency` counts settled sessions (`sessions-settled` in `master registry history`):

```sh
node "$GRAPHYARD_CLI" master registry role set worker claude-b,claude-c,codex-a --concurrency 4 --reason "Overflow"
node "$GRAPHYARD_CLI" master registry role set reviewer codex-a,claude-c --concurrency 2 --tool Read --model opus --reason "Read-only"
```

### Size review and proof capacity

Per candidate: one review, one producer session per proof group; profile `"concurrency"` caps sessions without a restart. Adding workers: with worker count `W`, `G` proof groups need `⌈W / 2⌉` review and `G × ⌈W / 2⌉` producer slots over ≥2 producer principals; watch `longestWaitMs`.

## 3. Start the master

```sh
node "$GRAPHYARD_CLI" master init --url https://YOUR-GRAPHYARD-HOST --herdr-workspace HERDR_WORKSPACE_ID \
  --browser-profile Default --token-stdin < ~/.config/graphyard/INSTALL/tokens/INSTALL-master.token
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST   # executors
node "$GRAPHYARD_CLI" master start codex     # or claude
```

Run as an OS user whose GitHub credentials workers cannot read. `--browser-profile`: Chrome signed in as GitHub admin (`master browser`); GitHub Mobile *Confirm access* stays human-only. Reviewer: `master reviewer setup`, `master reviewer add PROFILE` ([template](../examples/master/claude-reviewer.json)). Setup writes `mergeQueue` in `.graphyard/master.json`: `parallelTips` (default 4; needs parallelTips × pull-request jobs concurrent Actions jobs — declare `ciConcurrency`, `master protection` flags a lower one) and [`optimisticExclude`](github.md#optimistic-merges) globs.

### The loop must be supervised

`master init` (coordinator checkout) writes `~/.config/systemd/user/graphyard-master.service` and runs `systemctl --user enable --now` and `loginctl enable-linger` (restarts on crash, reboot, hang); never a side effect: worker checkouts and temp directories are refused. Move: `master init --token-stdin --replace-supervisor` from the new checkout. `master status` shows `setup.supervisor`.

## 4. Prove the first PR

`graphyard doctor --profile through-merge` names gaps; `master run` dispatches a small item, merged once protection requires `Graphyard / merge`; `"systemDriven": false` allows [hand actions](master-agent.md#system-driven-items).

CI workflows should cancel superseded PR runs: group `${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}`, `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`; runs on main are never cancelled; `graphyard master protection` lists required checks lacking cancel-in-progress under `advisories`.

Humans only: logins, App confirmation, plan approval, *Confirm access*, producer grants, [human-only decisions](glossary.md#who-decides).
