<!-- page: Start here | 3 | first repository. -->
# Onboard a repository

## 1. Install the control plane

Follow [install](install.md): review `--plan`, then `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --apply`.

## 2. Add machines

Each concurrent session needs a worker identity and host ID: raise `install --workers` or connect:

```sh
graphyard init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

Commit `AGENTS.md`, `.gitignore`, `graphyard.json`, never `.graphyard/`. Without the master, `graphyard watch GY-1 EPOCH -- COMMAND` runs a worker, stopped on lease loss.

### Documentation policy

`init --scan --apply` records found docs (`docs/`, `site/`, `README*`, `CHANGELOG*`) in `graphyard.json` (`{"documentation":{"paths":["site/"],"changelog":"CHANGELOG.md"}}`); deploy the printed `GRAPHYARD_DOCUMENTATION` (default `docs/`, `README.md`, `AGENTS.md`) or `doctor` reports `documentation.drift`. Features and bugs carry *Documentation reflects this change*: a diff there or `complete --no-docs "WHY"`, reviewer-judged. Only an optional `"wordBudget":{"total":N,"perPage":N}` (`paths` narrows it) is [counted](development.md#documentation): near its total the loop files a trim item; a queue overflow ejects the entry crossing it.

### What the generated instructions authorize

The managed `AGENTS.md` section states that **every session Graphyard launches receives its instruction as the session's own first request, on the runtime's command line, never as pasted text**; later pastes (the loop's single re-prompt, the reviewer's reminder, the master's event wake) come from that launcher, acted on unconfirmed. Agents treat bracketed paste as untrusted data (prompt injection), so sessions start without anybody sending `go`; Claude Code also gets `--append-system-prompt-file`; role files under `.graphyard/harness/` hold permissions, not instructions.

### Connect an account

Settings › **Agents** takes a provider key, sealed in-browser to the host's public key (the server relays ciphertext), or a login via the shown URL and code (Claude: **Paste the code**; **Cancel** stops). The host's executor writes the 0600 auth file, smoke-tests provider and model (admins' **Retry** re-enters a failed credential), and adds strong accounts to worker and reviewer, cheap ones to approver, producer and, if the host's research command is the account's wrapper, research; **change** edits roles.

### Agent environments

`~/.coding_agents` login homes are set by `CLAUDE_CONFIG_DIR` (Claude Code), `CODEX_HOME` (Codex), `XDG_DATA_HOME` (OpenCode), `CURSOR_CONFIG_DIR` (Cursor: `CURSOR_CONFIG_DIR=HOME agent login`); tokens go in `~/.config/graphyard/workers/` and `producers/` (0600):

```sh
graphyard master environments --create claude,codex --apply  # new homes
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-a claude           # /login once
graphyard master environments --apply                        # quota, profiles
```

Profiles default to [`"approvals": "auto"`](master-agent-sessions.md#approval-modes) (trade-off: unattended sessions); `"prompt"` is refused at launch.

### Configure the fleet

The **agent registry** (Settings › **Agents**) records runtimes, accounts, roles and policies, proposed from `~/.coding_agents`:

```sh
node "$GRAPHYARD_CLI" master registry propose
node "$GRAPHYARD_CLI" master registry propose --apply
```

### Add a runtime

Advanced, or the CLI (dash-led values join their flag with `=`):

```sh
node "$GRAPHYARD_CLI" master registry runtime set aider --kind aider --arg=--yes-always \
  --home-variable AIDER_HOME --model-flag=--model --login 'AIDER_HOME={home} aider --login' --login-file session.json \
  --reason "Aider"
```

### Add an account

Connect it, or record each login:

```sh
node "$GRAPHYARD_CLI" master registry model set opus --provider Anthropic --id claude-opus-5 \
  --input-cost 15 --output-cost 75 --tier frontier --context 1000000 --reason "Pricing"
node "$GRAPHYARD_CLI" master registry account set claude-b --runtime claude --model opus \
  --home ~/.coding_agents/claude-b --max-sessions 2 --reason "Plan"
node "$GRAPHYARD_CLI" master registry account quota opencode-a exhausted --resets-at 2026-09-22T00:00:00Z --reason "Exhausted"
```

`--key-file zai.key --key-variable ZAI_API_KEY` exports a 0600 key per run. New or changed Pi accounts are smoke-tested (a failure bars one until retested); two unjudged runs bench it from that role an hour.

### Add a role

Preferred account first; applies next launch:

```sh
node "$GRAPHYARD_CLI" master registry role set worker claude-b,claude-c,codex-a --concurrency 4 --reason "Overflow"
node "$GRAPHYARD_CLI" master registry role set reviewer codex-a,claude-c --concurrency 2 --tool Read --model opus --reason "Read-only"
```

`--concurrency` counts settled sessions: registry reads end those whose lease or request lapsed (`sessions-settled`, with reasons, in `master registry history`).

### Size review and proof capacity

A candidate needs one review and one producer session per proof group; `"concurrency"` caps a profile's sessions without a restart. Adding workers? For worker count `W`, `G` proof groups: `⌈W / 2⌉` review and `G × ⌈W / 2⌉` producer slots, over ≥ 2 producer principals; watch `longestWaitMs`.

## 3. Start the master

```sh
graphyard master init --url https://YOUR-GRAPHYARD-HOST --herdr-workspace HERDR_WORKSPACE_ID \
  --browser-profile Default --token-stdin < ~/.config/graphyard/INSTALL/tokens/INSTALL-master.token
graphyard init --url https://YOUR-GRAPHYARD-HOST   # installs the executors
graphyard master start codex                       # or claude
```

Use an OS identity whose GitHub credentials workers cannot read. `--browser-profile` is a Chrome profile signed in to GitHub as admin (`master browser`); *Confirm access* in GitHub Mobile stays human-only. `master reviewer setup` and `master reviewer add PROFILE` ([template](../examples/master/claude-reviewer.json)) add the reviewer; its manifest flow is the only App confirmation. Onboarding writes [shared-infrastructure](github.md#optimistic-merges) globs to `mergeQueue.optimisticExclude` in `.graphyard/master.json`, kept on re-runs.

### The loop must be supervised

`master init` from the coordinator checkout writes `~/.config/systemd/user/graphyard-master.service`, runs `systemctl --user enable --now` and `loginctl enable-linger` (restart on crash, reboot, hang); never a side effect: worker checkouts and temp directories are refused. `master init --token-stdin --replace-supervisor` from a new checkout moves it; `master status` reports `setup.supervisor` and the merger.

## 4. Prove the first PR

`graphyard doctor --profile through-merge` names what is missing; `master run` dispatches a small item, merged once branch protection requires `Graphyard / merge`; `"systemDriven": false` allows [hand actions](master-agent.md#system-driven-items).

CI workflows should cancel superseded pull-request runs: group by `${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}` with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`; runs on main are never cancelled. `graphyard master protection` lists each required check whose workflow lacks cancel-in-progress under `advisories`.

## What stays manual

Logins (provider, GitHub, browser profile, agent environments), the App confirmation, plan approval, *Confirm access*, producer grants and [human-only decisions](glossary.md#who-decides).
