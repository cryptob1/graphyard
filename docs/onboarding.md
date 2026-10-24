<!-- page: Start here | 3 | machines -->
# Onboard a repository

## 1. Install the control plane

[Install](install.md): `install --provider compose --repo OWNER/REPO --workers 1 --apply` after `--plan`.

## 2. Add machines

Per session: worker identity, host ID, or `init --url https://YOUR-HOST --herdr --host-id NAME --token-stdin`. Commit `AGENTS.md`, `.gitignore`, `graphyard.json`, never `.graphyard/`; the merge writer's trial is the gate; masterless: `graphyard watch GY-N EPOCH -- COMMAND` ([worker](protocol/work-commands.md#watch)).

`init --scan --apply` writes the delivery policy to `graphyard.json`.

### What the generated instructions authorize

Generated `AGENTS.md`: **every session Graphyard launches receives its instruction as the session's own first request** (Claude Code also `--append-system-prompt-file`); launcher pastes need no confirmation; other bracketed paste: untrusted data. Role files under `.graphyard/harness/` hold permissions, not instructions.

### Agent environments

Login homes (`~/.coding_agents`, or `GRAPHYARD_AGENT_ENVIRONMENTS` naming the runtime's home): `master environments --create claude,codex --apply`. Profiles default to `"approvals": "auto"`.

### Connect an account

Settings › **Agents** › **Connect an account** writes and smoke-tests the 0600 auth file.

### Configure the fleet

Propose **Agent registry** from login homes: `master registry propose`, then `--apply`. The proposal names every role, master included — the reviewer's accounts at concurrency 1, so the loop launches its own session.

`master registry account set NAME --runtime claude --model opus --home ~/.coding_agents/NAME --reason "Plan"`; `--plan NAME` groups accounts under one provider quota.

`master registry role set worker claude-b,claude-c --concurrency 4` — `--concurrency` counts settled sessions. `W` workers and `G` proof groups need `⌈W/2⌉` review and `G×⌈W/2⌉` producer slots.

## 3. Start the master

`master init`, `master start` ([setup](setup-from-zero.md#10-start-the-master)) as an OS user whose credentials workers can't read. Reviewer: `master reviewer add PROFILE` ([template](../examples/master/claude-reviewer.json)); `master review GY-N` relaunches.

### The loop must be supervised

`master init` writes the user unit, `systemctl --user enable --now`, `loginctl enable-linger`. Move: `master init --token-stdin --replace-supervisor` there. Shared hosts: units are per repository in `.graphyard/units.json`.

### Supervised mode (up --local)

`graphyard up --local` writes `"supervision": "supervised"`; absent is autonomous: an agent reviewer reviews each head, the control plane merges it. Promote: `master reviewer add`, then `master promote` ([promotion](master-agent-reference.md#promotion-to-autonomy)).

## 4. Prove the first change

`graphyard doctor --profile through-merge` names gaps; `master run` dispatches a small item, merged when the merge writer's trial passes and pushes main with its deploy key; `"systemDriven": false` allows [hand actions](master-agent.md#system-driven-items).

## The dashboard

Serves `127.0.0.1:4310` ([install](install.md)); a green `up` ends with a single-use `signIn` link (10min), later `graphyard login` (no options) mints one from the install's operator credential; the session lasts 30 days. Status: **Todo**/**Doing**/**Checking**/**Done** — Done = merged, off the board; items are *Delivered* at merge, *Live* once served. **Needs you** cards name the ask and numbered steps. **Settings › Agents**: launch readiness, accounts, roles ([Configure the fleet](#configure-the-fleet)).
