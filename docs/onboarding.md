<!-- page: Start here | 3 | machines, accounts. -->
# Onboard a repository

## 1. Install the control plane

[Install](install.md): `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --apply` after `--plan`.

## 2. Add machines

Per concurrent session: worker identity, host ID (`install --workers`) or:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

Commit `AGENTS.md`, `.gitignore`, `graphyard.json`, workflows ([candidates](delivery.md#managed-repositories); with no workflow on `pull_request`, `graphyard-delivery.yml`: build, test, `graphyard-gate`, the only required check), never `.graphyard/`; masterless: `graphyard watch GY-1 EPOCH -- COMMAND` ([worker](protocol/leases.md#watch)).

### Documentation policy

`init --scan --apply` records found `docs/`, `site/`, `README*`, `CHANGELOG*` as `{"documentation":{"paths":["site/"],"changelog":"CHANGELOG.md"}}`; deploy printed `GRAPHYARD_DOCUMENTATION` (differing: `doctor` names it). Features and `bug`s owe *Documentation reflects this change* (docs diff or `complete --no-docs "WHY"`); optional `"wordBudget":{"total":N,"perPage":N}` ([counted](development.md#documentation)).

### What the generated instructions authorize

Generated `AGENTS.md`: **every session Graphyard launches receives its instruction as the session's own first request** (Claude Code also `--append-system-prompt-file`), so sessions start without anybody sending `go`; launcher pastes (the loop's single re-prompt, the reviewer's reminder, master wakes) need no confirmation; other bracketed paste: untrusted data (prompt injection).

### Agent environments

Login homes (`~/.coding_agents`, or `GRAPHYARD_AGENT_ENVIRONMENTS`: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`, `CURSOR_CONFIG_DIR`): `master environments --create claude,codex --apply`, log in, rerun it ([step 8](setup-from-zero.md#8-agent-environments)). Profiles default to [`"approvals": "auto"`](master-agent-sessions.md#approval-modes); `"prompt"` refused at launch.

### Connect an account

Settings › **Agents** › **Connect an account** writes, smoke-tests 0600 auth file (**Pi (z.ai key)**: `auth.json` in `pi-<letter>` home).

### Configure the fleet

Propose **Agent registry** (Settings › **Agents**) from login homes:

```sh
node "$GRAPHYARD_CLI" master registry propose
node "$GRAPHYARD_CLI" master registry propose --apply
```

### Add a runtime

**Advanced** or CLI (dash-led values use `=`): `master registry runtime set NAME --kind KIND --arg=FLAG --home-variable VAR --model-flag=FLAG --login 'VAR={home} CMD --login' --reason REASON`.

### Add an account

```sh
node "$GRAPHYARD_CLI" master registry model set opus --provider Anthropic --id claude-opus-5 \
  --input-cost 15 --output-cost 75 --reason "Pricing"
node "$GRAPHYARD_CLI" master registry account set claude-b --runtime claude --model opus \
  --home ~/.coding_agents/claude-b --max-sessions 2 --reason "Plan"
```

`--plan NAME` groups accounts under one provider quota (`none` clears; `auth.json`-only logins need it); `--key-file zai.key --key-variable ZAI_API_KEY` exports 0600 key file per run; pasted keys refused; `master registry account quota` records one.

### Add a role

Preferred account first; `--concurrency` counts settled sessions:

```sh
node "$GRAPHYARD_CLI" master registry role set worker claude-b,claude-c,codex-a --concurrency 4 --reason "Overflow"
node "$GRAPHYARD_CLI" master registry role set reviewer codex-a,claude-c --concurrency 2 --tool Read --model opus --reason "Read-only"
```

Adding workers: worker count `W` and `G` proof groups need `⌈W/2⌉` review and `G×⌈W/2⌉` producer slots (profile `"concurrency"`, live without a restart); watch `longestWaitMs`.

## 3. Start the master

`master init`, executor `init`, `master start` ([setup](setup-from-zero.md#10-start-the-master)) as OS user whose GitHub credentials workers can't read; `--browser-profile`: Chrome as GitHub admin (`master browser`); App confirmation and GitHub Mobile *Confirm access* stay human-only. Reviewer: `master reviewer setup` or `master reviewer add PROFILE`.

### The loop must be supervised

`master init` (coordinator checkout) writes `~/.config/systemd/user/graphyard-master-OWNER-NAME.service`, runs `systemctl --user enable --now`, `loginctl enable-linger`; never a side effect (worker checkouts, temp directories refused). `master status`: `setup.supervisor`. The loop and `graphyard up` preflight refuse a dirty CLI checkout; its research scratch is a worktree of the managed repository, not the CLI checkout.

Installs share hosts: units named per repository (executors too) in `.graphyard/units.json`; setup never touches another checkout's unit; each needs its `--herdr-workspace`.

### The pipeline doctor

Every `run.doctor.intervalMinutes` (10) a Pi **doctor** fixes stuck work: `master scope`, `requirements`, `unblock`, `decide`+`approver`, `settle-containment`, `close`, `create`, `release`, `checkout-restore` (never merging, dispatching, evidencing); it runs a `master-role` refusal's command, then unblocks; posts findings (`master status` `doctor`), escalates or files faults (deduped; GY-1632, GY-1713, GY-1705 hold). Off: `run.doctor.enabled=false`.

### Supervised mode (up --local)

`graphyard up --local` writes `"supervision": "supervised"` and your login (`operatorLogin`) to `master.json`; absent is autonomous. No reviewer App, no `master autonomy`: your GitHub approval of the exact head passes review and auto-merge lands it; the loop launches no reviewer, approver or escalation. `master status` prints `supervision`. Promote: `master reviewer setup`, `master reviewer add`, then `master promote --admin-token-stdin` ([promotion](master-agent-reference.md#promotion-to-autonomy)).

## 4. Prove the first PR

`graphyard doctor --profile through-merge` names gaps; `master run` dispatches small item, merged once protection requires `Graphyard / merge`; `"systemDriven": false` allows [hand actions](master-agent.md#system-driven-items).

CI workflows should cancel superseded pull-request runs: group `${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}` with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`; `graphyard master protection` lists each required check lacking it under `advisories`.

## 5. Inventory PRs

`graphyard onboard inventory --repo OWNER/REPO [--mapping FILE] [--out FILE]` labels open PRs and drafts: `continue`, `hold` (draft), `adopt` (mergeable; protection, ruleset checks clean per App) or `superseded` (base holds the head). Read-only; `--mapping` binds keys.

`master adopt GY-N --pr NUMBER --head SHA [--source-key KEY --source-url URL] REASON` binds an existing PR at its live head to the held item (source kept); its attempt works on the PR's own branch, `complete` accepts only that PR. Moved head: refused naming the live head; a PR another item or open attempt holds: refused naming the holder; the same adoption again: a no-op. Adoption never writes to GitHub and never weakens a criterion; the old head's checks stay history, the next head is gated afresh, release is a separate decision.
