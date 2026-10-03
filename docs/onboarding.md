<!-- page: Start here | 3 | machines, accounts, master, first PR. -->
# Onboard a repository

## 1. Install the control plane

Follow [install](install.md) (`install --provider`).

## 2. Add machines

Per concurrent session: a worker identity and host ID (`install --workers`), or:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

Commit `AGENTS.md`, `.gitignore`, `graphyard.json`; never `.graphyard/`. Masterless: [`graphyard watch`](protocol/leases.md#watch).

### Documentation policy

`init --scan --apply` writes docs paths to `graphyard.json` (`{"documentation":{"paths":["site/"],"changelog":"CHANGELOG.md"}}`); deploy `GRAPHYARD_DOCUMENTATION` (else `documentation.drift`). Features/bugs owe *Documentation reflects this change*: docs diff or `complete --no-docs "WHY"`. `"wordBudget":{"total":N,"perPage":N}`: at 97% `master status` raises `docs` and files a trim item; queue overflow ejects.

### What the generated instructions authorize

Generated `AGENTS.md`: **every session Graphyard launches receives its instruction as the session's own first request** (Claude Code also `--append-system-prompt-file`), so sessions start without anybody sending `go`; launcher pastes (the loop's single re-prompt, the reviewer's reminder, master wakes) need no confirmation; any other bracketed paste is untrusted data (prompt injection). The role files under `.graphyard/harness/` hold permissions, not instructions.

### Agent environments

Login homes (`~/.coding_agents`): `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME` (OpenCode), `CURSOR_CONFIG_DIR` (`CURSOR_CONFIG_DIR=HOME agent login`). Tokens: `~/.config/graphyard/workers/`, `producers/` (0600).

```sh
node "$GRAPHYARD_CLI" master environments --create claude,codex --apply
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-a claude            # /login
node "$GRAPHYARD_CLI" master environments --apply
```

Profiles default to [`"approvals": "auto"`](master-agent-sessions.md#approval-modes); `"prompt"` is refused at launch.

### Connect an account

Settings › **Agents** › **Connect an account** (via the host's executor) seals a key or login into a smoke-tested 0600 auth file.

### Configure the fleet

Propose the **agent registry** (runtimes, accounts, roles) from login homes:

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
  --home ~/.coding_agents/claude-b --max-sessions 2 --reason "Second"
node "$GRAPHYARD_CLI" master registry account quota opencode-a exhausted --resets-at 2026-09-22T00:00:00Z --reason "Exhausted"
```

`--plan NAME` names the account's provider plan (`none` clears; else inferred: same host and home, or `pi-X`/`opencode-X` on Z.AI); a plan's accounts share one failover budget. `--key-file zai.key --key-variable ZAI_API_KEY` exports a 0600 key per run. Two unjudged Pi runs bench an account from a role an hour. Registry writes refuse pasted secrets (PEM, JWT, z.ai key, long tokens), except word-built model ids.

### Add a role

Preferred account first; applies next launch. `--concurrency` counts settled sessions (`sessions-settled` in `master registry history`):

```sh
node "$GRAPHYARD_CLI" master registry role set worker claude-b,claude-c,codex-a --concurrency 4 --reason "Overflow"
node "$GRAPHYARD_CLI" master registry role set reviewer codex-a,claude-c --concurrency 2 --tool Read --model opus --reason "Read-only"
```

### Size review and proof capacity

Candidates need one review and one producer session per proof group; a profile's `"concurrency"` caps its sessions without a restart. Adding workers? A worker count `W` and `G` proof groups need `⌈W/2⌉` review and `G×⌈W/2⌉` producer slots over ≥2 producer principals; watch `longestWaitMs`.

## 3. Start the master

```sh
node "$GRAPHYARD_CLI" master init --url https://YOUR-GRAPHYARD-HOST --herdr-workspace HERDR_WORKSPACE_ID \
  --browser-profile Default --token-stdin < ~/.config/graphyard/INSTALL/tokens/INSTALL-master.token
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST   # executors
node "$GRAPHYARD_CLI" master start codex
```

Use an OS user whose GitHub credentials workers can't read; `--browser-profile` is Chrome signed in as GitHub admin (`master browser`); GitHub Mobile *Confirm access* stays human-only. Reviewer: `master reviewer setup`, `master reviewer add PROFILE` ([template](../examples/master/claude-reviewer.json)); its manifest flow is the only App confirmation. Setup writes [`mergeQueue.optimisticExclude`](github.md#optimistic-merges) to `.graphyard/master.json`.

### The loop must be supervised

`master init` in the coordinator checkout writes `~/.config/systemd/user/graphyard-master.service`, runs `systemctl --user enable --now` and `loginctl enable-linger`, never a side effect; worker checkouts and temp directories are refused. Move it: `master init --token-stdin --replace-supervisor` in the new checkout. `master status` reports `setup.supervisor`.

## 4. Prove the first PR

`graphyard doctor --profile through-merge` names gaps; `master run` dispatches a small item, merged once protection requires `Graphyard / merge`.

CI workflows should cancel superseded pull-request runs: group by `${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}` with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`; runs on main are never cancelled. `graphyard master protection` lists each required check whose workflow lacks cancel-in-progress under `advisories`.
