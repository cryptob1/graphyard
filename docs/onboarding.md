<!-- page: Start here | 3 | machines, accounts, the master, the first PR. -->
# Onboard a repository

## 1. Install the control plane

Follow [install](install.md): `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --apply` after reviewing `--plan`.

## 2. Add machines

Each concurrent session needs a worker identity and host ID: raise `install --workers`, or connect a machine:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

Commit `AGENTS.md`, `.gitignore`, `graphyard.json`; never `.graphyard/`. Without the master, `graphyard watch GY-1 EPOCH -- COMMAND` runs a worker, stopped on lease loss.

### Documentation policy

`init --scan --apply` writes the documentation paths found (`docs/`, `site/`, `README*`, package READMEs, `CHANGELOG*`) to `graphyard.json` (`{"documentation":{"paths":["site/"],"changelog":"CHANGELOG.md"}}`). Deploy the printed `GRAPHYARD_DOCUMENTATION` (default `docs/`, `README.md`, `AGENTS.md`). Features and bugs carry *Documentation reflects this change*, met by a diff there or `complete --no-docs "WHY"`, judged by the reviewer.

### What the generated instructions authorize

The managed `AGENTS.md` section states that **every session Graphyard launches receives its instruction as the session's own first request, on the runtime's command line, never as pasted text**; the only later paste (the loop's single re-prompt, or the reviewer's reminder) comes from the same launcher and is acted on without confirmation.

Agents treat Herdr's bracketed paste as untrusted data (prompt injection), so with the request on the command line sessions start without anybody sending `go`; Claude Code gets the statement through `--append-system-prompt-file`. The role files under `.graphyard/harness/` hold permissions, not instructions.

### Agent environments

Each agent account has a login home under `~/.coding_agents`, selected by `CLAUDE_CONFIG_DIR` (Claude Code), `CODEX_HOME` (Codex), `XDG_DATA_HOME` (OpenCode) or `CURSOR_CONFIG_DIR` (Cursor). Tokens go in `~/.config/graphyard/workers/` and `producers/` (mode 0600). Then:

```sh
node "$GRAPHYARD_CLI" master environments --create claude,codex --apply  # new login homes
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-a claude                       # /login once
node "$GRAPHYARD_CLI" master environments --apply                        # report quota, write profiles
```

Profiles default to `"approvals": "auto"` so sessions never block on a permission prompt (trade-off: unattended sessions); `"prompt"` is refused at launch ([approval modes](master-agent-sessions.md#approval-modes)).

### Configure the fleet

The **agent registry** (Settings › **Agents**) records runtimes, accounts, roles and policies, proposed from `~/.coding_agents`:

```sh
node "$GRAPHYARD_CLI" master registry propose
node "$GRAPHYARD_CLI" master registry propose --apply
```

### Add a runtime

Join a dash-led value to its flag with `=`:

```sh
node "$GRAPHYARD_CLI" master registry runtime set aider --kind aider --arg=--yes-always \
  --home-variable AIDER_HOME --model-flag=--model --login 'AIDER_HOME={home} aider --login' --login-file session.json \
  --reason "Add the Aider runtime"
```

### Add an account

An account is one login, held by reference:

```sh
node "$GRAPHYARD_CLI" master registry model set opus --provider Anthropic --id claude-opus-5 \
  --input-cost 15 --output-cost 75 --tier frontier --context 1000000 --reason "Record the model and its price"
node "$GRAPHYARD_CLI" master registry account set claude-b --runtime claude --model opus \
  --home ~/.coding_agents/claude-b --max-sessions 2 --reason "Second Claude subscription"
node "$GRAPHYARD_CLI" master registry account quota opencode-a exhausted --resets-at 2026-09-22T00:00:00Z --reason "Plan cut off until Monday"
```

### Add a role

Preferred account first; applies next launch:

```sh
node "$GRAPHYARD_CLI" master registry role set worker claude-b,claude-c,codex-a --concurrency 4 --reason "Prefer Claude; Codex is overflow"
node "$GRAPHYARD_CLI" master registry role set reviewer codex-a,claude-c --concurrency 2 --tool Read --model opus --reason "Read-only, frontier model"
```

### Size review and proof capacity

Each candidate needs one review and one producer session per proof group; a profile's `"concurrency"` caps its sessions, changed without a restart:

```json
"reviewers":[{"name":"claude-reviewer","agentName":"review-claude","kind":"claude","accounts":["claude-a","claude-b"],"concurrency":3}]
```

For `W` workers and `G` proof groups: `⌈W / 2⌉` review slots and `G × ⌈W / 2⌉` producer slots over 2+ producer principals. Watch `longestWaitMs`.

## 3. Start the master

```sh
node "$GRAPHYARD_CLI" master init --url https://YOUR-GRAPHYARD-HOST --herdr-workspace HERDR_WORKSPACE_ID \
  --browser-profile Default --token-stdin < ~/.config/graphyard/INSTALL/tokens/INSTALL-master.token
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST   # now installs the executors
node "$GRAPHYARD_CLI" master start codex     # or: master start claude
```

Run it under an OS identity whose GitHub credentials workers cannot read. `--browser-profile` is the Chrome profile signed in to GitHub as administrator, for `master browser` flows; *Confirm access* in GitHub Mobile stays human-only. Add the reviewer with `master reviewer setup` and `master reviewer add PROFILE` ([Claude](../examples/master/claude-reviewer.json) template); its manifest flow is the only App confirmation.

### The loop must be supervised

`master init` from the coordinator checkout writes `~/.config/systemd/user/graphyard-master.service`, runs `systemctl --user enable --now` and `loginctl enable-linger`; the unit restarts on crash, reboot and hang. It is never a side effect: worker checkouts and temporary directories are refused. Move it with `master init --token-stdin --replace-supervisor` from the new checkout. `master status` reports `setup.supervisor` and the merger.

## 4. Prove the first PR

`graphyard doctor --profile through-merge` names every missing piece. Create a small item: `master run` dispatches it; the loop merges once branch protection requires `Graphyard / merge`. `"systemDriven": false` allows [hand actions](master-agent.md#system-driven-items).

CI workflows should cancel superseded pull-request runs: group each by `${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}` with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`; runs on main are never cancelled. `graphyard master protection` lists each required check whose workflow lacks cancel-in-progress under `advisories`.

## What stays manual

Logins (provider, GitHub, agent environments, browser profile), the App confirmation, plan approval, *Confirm access*, producer grants, and the [human-only decisions](glossary.md#who-decides).
