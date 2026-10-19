<!-- page: Start here | 3 | machines, accounts. -->
# Onboard a repository

## 1. Install the control plane

[Install](install.md): `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --apply` after `--plan`.

## 2. Add machines

Per concurrent session: worker identity, host ID (`install --workers`) or:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

Commit `AGENTS.md`, `.gitignore`, `graphyard.json`, never `.graphyard/`; setup writes no `.github/workflows` file: the merge writer's trial (build, tests, secret scan) is the gate; masterless: `graphyard watch GY-1 EPOCH -- COMMAND` ([worker](protocol/leases.md#watch)).

### Documentation policy

`init --scan --apply` records found `docs/`, `site/`, `README*`, `CHANGELOG*` as `{"documentation":{"paths":["site/"],"changelog":"CHANGELOG.md"}}`; deploy printed `GRAPHYARD_DOCUMENTATION`. Features and `bug`s owe *Documentation reflects this change* (docs diff or `complete --no-docs "WHY"`); `"wordBudget"` ([counted](development.md#documentation)).

### What the generated instructions authorize

Generated `AGENTS.md`: **every session Graphyard launches receives its instruction as the session's own first request** (Claude Code also `--append-system-prompt-file`), so sessions start without anybody sending `go`; launcher pastes (the loop's single re-prompt, the reviewer's reminder, master wakes) need no confirmation; other bracketed paste: untrusted data (prompt injection). The role files under `.graphyard/harness/` hold permissions, not instructions.

### Agent environments

Login homes (`~/.coding_agents`, or `GRAPHYARD_AGENT_ENVIRONMENTS`: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`, `CURSOR_CONFIG_DIR`): `master environments --create claude,codex --apply`, log in, rerun it. Profiles default to [`"approvals": "auto"`](master-agent-sessions.md#approval-modes) (trade-off: unattended); `"prompt"` refused at launch.

### Connect an account

Settings › **Agents** › **Connect an account** writes and smoke-tests the 0600 auth file (**Pi**: `pi-<letter>` home's `auth.json`).

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
  --model-flag=--model --login 'AIDER_HOME={home} aider --login' --reason "Aider"
```

### Add an account

```sh
node "$GRAPHYARD_CLI" master registry model set opus --provider Anthropic --id claude-opus-5 \
  --input-cost 15 --output-cost 75 --reason "Pricing"
node "$GRAPHYARD_CLI" master registry account set claude-b --runtime claude --model opus \
  --home ~/.coding_agents/claude-b --max-sessions 2 --reason "Plan"
node "$GRAPHYARD_CLI" master registry account quota NAME exhausted --resets-at 2026-09-22T00:00:00Z --reason "Quota"
```

`--plan NAME` groups accounts under one provider quota; `--key-file zai.key --key-variable ZAI_API_KEY` exports a 0600 key per run; pasted keys refused.

### Add a role

`--concurrency` counts settled sessions:

```sh
node "$GRAPHYARD_CLI" master registry role set worker claude-b,claude-c,codex-a --concurrency 4 --reason "Overflow"
node "$GRAPHYARD_CLI" master registry role set reviewer codex-a,claude-c --concurrency 2 --tool Read --model opus --reason "Read-only"
```

### Size review and proof capacity

Adding workers: worker count `W` and `G` proof groups need `⌈W/2⌉` review and `G×⌈W/2⌉` producer slots (profile `"concurrency"`, applied without a restart); watch `longestWaitMs`.

## 3. Start the master

`master init`, `master start` ([setup](setup-from-zero.md#10-start-the-master)) as OS user whose GitHub credentials workers can't read; `--browser-profile`: a GitHub-signed-in Chrome profile; GitHub Mobile *Confirm access* stays human-only. Reviewer: `master reviewer add PROFILE` ([template](../examples/master/claude-reviewer.json)); `master review GY-N` relaunches.

### The loop must be supervised

`master init` (coordinator checkout) writes `~/.config/systemd/user/graphyard-master-OWNER-NAME.service`, runs `systemctl --user enable --now`, `loginctl enable-linger`; never a side effect (worker checkouts, temp directories refused). Move: `master init --token-stdin --replace-supervisor` there. `master status`: `setup.supervisor`. The loop and `graphyard up` preflight refuse a dirty CLI checkout; its research scratch is a managed-repository worktree.

Shared hosts: units are per repository (`graphyard-master-OWNER-NAME.service`) in `.graphyard/units.json` (`graphyard-master.service` alias); setup never touches another checkout's; each install needs its `--herdr-workspace`.

### The pipeline doctor

Every `run.doctor.intervalMinutes` (5), or watchdog-fired, a Pi **doctor** acts, never asks people (`master scope/requirements/unblock/decide`+`approver`/`settle-containment`/`close`/`create`/`release`/`checkout-restore`); runs a `master-role` refusal's command, then unblocks; posts findings (`master status` `doctor`); files only code-change items (`create FILE 'why'`, reason required). Off: `run.doctor.enabled=false`.

### Supervised mode (up --local)

`graphyard up --local` writes `"supervision": "supervised"` and your login (`operatorLogin`) to `master.json`; absent is autonomous. Supervised: an agent reviewer reviews each head, the control plane merges it; no approver or escalation runs, so you answer decisions. `master status` prints `supervision`. Promote: `master reviewer add`, then `master promote --admin-token-stdin` ([promotion](master-agent-reference.md#promotion-to-autonomy)); it also needs a reviewer App bound before GY-2010, so a new install stays supervised.

## 4. Prove the first change

`graphyard doctor --profile through-merge` names gaps; `master run` dispatches small item, merged when the merge writer's trial passes and it pushes main with its deploy key (no branch protection); `"systemDriven": false` allows [hand actions](master-agent.md#system-driven-items).

## 5. Existing PRs

Graphyard reads no pull request, so there is no PR inventory (`graphyard onboard` is gone): open PRs stay with their existing controller; file work for one as an item.

`master adopt GY-N --pr NUMBER --head SHA …` is refused: adoption binds a PR's live head and Graphyard reads no GitHub API, so no new adoption binds; a replayed key answers from its receipt. Items adopted earlier keep their binding: attempts start at the stored adopted head from the shared object store and submit with `complete GY-N EPOCH --head`, never through the PR.
