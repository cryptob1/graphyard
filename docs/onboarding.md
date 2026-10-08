<!-- page: Start here | 3 | machines, accounts. -->
# Onboard a repository

## 1. Install the control plane

[Install](install.md): `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --apply` after `--plan`.

## 2. Add machines

Per concurrent session: worker identity, host ID (`install --workers`) or:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

Commit `AGENTS.md`, `.gitignore`, `graphyard.json`, workflows ([candidates](delivery.md#managed-repositories); with no workflow on `pull_request`, `graphyard-delivery.yml`: build, test, `graphyard-gate`, the only required check; edits are kept as drift), never `.graphyard/`; masterless: `graphyard watch GY-1 EPOCH -- COMMAND` ([worker](protocol/leases.md#watch)).

### Documentation policy

`init --scan --apply` records found `docs/`, `site/`, `README*`, `CHANGELOG*` as `{"documentation":{"paths":["site/"],"changelog":"CHANGELOG.md"}}`; deploy printed `GRAPHYARD_DOCUMENTATION` (differing: `doctor`'s `documentation.drift`). Features and `bug`s owe *Documentation reflects this change* (docs diff or `complete --no-docs "WHY"`); optional `"wordBudget":{"total":N,"perPage":N}` ([counted](development.md#documentation)).

### What the generated instructions authorize

Generated `AGENTS.md`: **every session Graphyard launches receives its instruction as the session's own first request** (Claude Code also `--append-system-prompt-file`), so sessions start without anybody sending `go`; launcher pastes (the loop's single re-prompt, the reviewer's reminder, master wakes) need no confirmation; other bracketed paste: untrusted data (prompt injection). The role files under `.graphyard/harness/` hold permissions, not instructions.

### Agent environments

Login homes (`~/.coding_agents`, or `GRAPHYARD_AGENT_ENVIRONMENTS`: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`, `CURSOR_CONFIG_DIR`): `master environments --create claude,codex --apply`, log in, rerun `master environments --apply` ([step 8](setup-from-zero.md#8-agent-environments)). Profiles default to [`"approvals": "auto"`](master-agent-sessions.md#approval-modes) (trade-off: unattended); `"prompt"` refused at launch.

### Connect an account

Settings › **Agents** › **Connect an account** (key or login) writes, smoke-tests 0600 auth file (**Pi (z.ai key)**: `auth.json` in `pi-<letter>` home).

### Configure the fleet

Propose **Agent registry** (Settings › **Agents**) from login homes:

```sh
node "$GRAPHYARD_CLI" master registry propose
node "$GRAPHYARD_CLI" master registry propose --apply
```

### Add a runtime

**Advanced** or CLI (dash-led values use `=`):

```sh
node "$GRAPHYARD_CLI" master registry runtime set aider --kind aider --arg=--yes-always --home-variable AIDER_HOME \
  --model-flag=--model --login 'AIDER_HOME={home} aider --login' --login-file session.json --reason "Aider"
```

### Add an account

```sh
node "$GRAPHYARD_CLI" master registry model set opus --provider Anthropic --id claude-opus-5 \
  --input-cost 15 --output-cost 75 --tier frontier --context 1000000 --reason "Pricing"
node "$GRAPHYARD_CLI" master registry account set claude-b --runtime claude --model opus \
  --home ~/.coding_agents/claude-b --max-sessions 2 --reason "Plan"
node "$GRAPHYARD_CLI" master registry account quota opencode-a exhausted --resets-at 2026-09-22T00:00:00Z --reason "Exhausted"
```

`--plan NAME` groups accounts under one provider quota (`none` clears; inferred from host+home or Z.AI keys; `auth.json`-only logins need it); `--key-file zai.key --key-variable ZAI_API_KEY` exports 0600 key file per run; pasted keys refused.

### Add a role

Preferred account first; `--concurrency` counts settled sessions (`sessions-settled` in `master registry history`):

```sh
node "$GRAPHYARD_CLI" master registry role set worker claude-b,claude-c,codex-a --concurrency 4 --reason "Overflow"
node "$GRAPHYARD_CLI" master registry role set reviewer codex-a,claude-c --concurrency 2 --tool Read --model opus --reason "Read-only"
```

### Size review and proof capacity

Adding workers: worker count `W` and `G` proof groups need `⌈W/2⌉` review and `G×⌈W/2⌉` producer slots (profile `"concurrency"`, applied without a restart); watch `longestWaitMs`.

## 3. Start the master

`master init`, executor `init`, `master start` ([setup](setup-from-zero.md#10-start-the-master)) as OS user whose GitHub credentials workers can't read; `--browser-profile`: Chrome as GitHub admin (`master browser`); App confirmation and GitHub Mobile *Confirm access* stay human-only. Reviewer: `master reviewer setup` or `master reviewer add PROFILE` ([template](../examples/master/claude-reviewer.json)); `master review GY-N` relaunches one.

### The loop must be supervised

`master init` (coordinator checkout) writes `~/.config/systemd/user/graphyard-master-OWNER-NAME.service`, runs `systemctl --user enable --now`, `loginctl enable-linger` (restart on crash, reboot, hang); never a side effect (worker checkouts, temp directories refused). Move: `master init --token-stdin --replace-supervisor` from new checkout. `master status`: `setup.supervisor`. The loop refuses a dirty CLI checkout; `graphyard up` preflight refuses one first, resumed runs too (exit 2, naming its paths), and a refusing loop fails `up`'s `master-loop` step with its reason. The loop's research scratch is a worktree of the managed repository, never of the CLI checkout.

Installs share hosts: units named per repository (`graphyard-executor-OWNER-NAME@N.service` too; short-hashed where names collide) in `.graphyard/units.json` (fails closed unreadable); a host whose `graphyard-master.service` runs this checkout keeps legacy names as recorded alias. With no record, legacy unit running another checkout makes every unit-name read refuse, naming unit and checkout, until `master init` records this install's own. Setup refuses, naming checkout, to overwrite or restart another checkout's unit; master harness restarts only its loop unit. Each install needs its own `--herdr-workspace`: sweeps (idle-pane close, reclaim, liveness, tab cleanup) act only on its panes.

### The pipeline doctor (on by default)

Every `run.doctor.intervalMinutes` (10) a Pi **doctor** fixes stuck, overdue work via `master scope`, `requirements`, `unblock`, `decide`+`approver`, `settle-containment`, `close`, `create`, `release` (never merging, dispatching or evidencing); posts findings, summary (`master status` `doctor`); escalates the rest or files fault items, deduplicated against open ones at settle (proof IDs normalised; create refusals escalate, control-plane ones retry). Reportless (models died, loop stopped) or restart-lost runs record failed, no `loop` fault; the next re-covers. Loop settles submitted lapsed fences, clears covered blockers, relaunches unanswered approvers. Off: `run.doctor.enabled=false`.

## 4. Prove the first PR

`graphyard doctor --profile through-merge` names gaps; `master run` dispatches small item, merged once protection requires `Graphyard / merge`; `"systemDriven": false` allows [hand actions](master-agent.md#system-driven-items).

CI workflows should cancel superseded pull-request runs: group `${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}`, `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`; runs on main are never cancelled; `graphyard master protection` lists each required check whose workflow lacks cancel-in-progress under `advisories`.
