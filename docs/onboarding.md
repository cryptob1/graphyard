<!-- page: Start here | 3 | machines, accounts. -->
# Onboard a repository

## 1. Install the control plane

[Install](install.md): `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --apply` after `--plan`.

## 2. Add machines

Per concurrent session: worker identity, host ID (`install --workers`) or:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

Commit `AGENTS.md`, `.gitignore`, `graphyard.json`, workflows ([candidates](delivery.md#managed-repositories); none on `pull_request`: init renders `graphyard-delivery.yml` (build, test, `graphyard-gate`, the only required check; edits kept as drift)), never `.graphyard/`; masterless: `graphyard watch GY-1 EPOCH -- COMMAND` ([worker](protocol/leases.md#watch)).

### Documentation policy

`init --scan --apply` records found `docs/`, `site/`, `README*`, `CHANGELOG*` as `{"documentation":{"paths":["site/"],"changelog":"CHANGELOG.md"}}` (drift vs the deployed `GRAPHYARD_DOCUMENTATION`: `doctor`'s `documentation.drift`). Features and `bug`s owe *Documentation reflects this change* (docs diff or `complete --no-docs "WHY"`); optional `"wordBudget":{"total":N,"perPage":N}` ([counted](development.md#documentation)).

### What the generated instructions authorize

Generated `AGENTS.md`: **every session Graphyard launches receives its instruction as the session's own first request**, so no `go` is sent; launcher pastes (loop re-prompt, reviewer reminder, master wakes) need no confirmation; other bracketed paste is untrusted (prompt injection). Role files under `.graphyard/harness/` hold permissions, not instructions.

### Agent environments

Login homes (`~/.coding_agents`, or `GRAPHYARD_AGENT_ENVIRONMENTS`: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME`, `CURSOR_CONFIG_DIR`): `master environments --create claude,codex --apply`, log in, rerun it ([step 8](setup-from-zero.md#8-agent-environments)). Profiles default to [`"approvals": "auto"`](master-agent-sessions.md#approval-modes); `"prompt"` refused at launch.

### Configure the fleet

Propose the **Agent registry** (Settings › **Agents**) from login homes:

```sh
node "$GRAPHYARD_CLI" master registry propose --apply
```

### Add a runtime

**Advanced** or CLI (dash-led values use `=`):

```sh
node "$GRAPHYARD_CLI" master registry runtime set aider --kind aider --home-variable AIDER_HOME \
  --login 'AIDER_HOME={home} aider --login'
```

### Add an account

```sh
node "$GRAPHYARD_CLI" master registry model set opus --provider Anthropic --id claude-opus-5 \
  --input-cost 15 --output-cost 75
node "$GRAPHYARD_CLI" master registry account set claude-b --runtime claude --model opus \
  --home ~/.coding_agents/claude-b --max-sessions 2
node "$GRAPHYARD_CLI" master registry account quota opencode-a exhausted --resets-at INSTANT
```

`--plan NAME` groups accounts under one provider quota (`none` clears; inferred from host+home or Z.AI keys; `auth.json`-only logins need it); `--key-file` + `--key-variable` export a 0600 key file per run; pasted keys refused.

### Add a role

Preferred account first; `--concurrency` counts settled sessions:

```sh
node "$GRAPHYARD_CLI" master registry role set worker claude-b,claude-c,codex-a --concurrency 4
node "$GRAPHYARD_CLI" master registry role set reviewer codex-a,claude-c --concurrency 2 --tool Read --model opus
```

### Size review and proof capacity

Adding workers: `W` workers and `G` proof groups need `⌈W/2⌉` review and `G×⌈W/2⌉` producer slots (profile `"concurrency"`); watch `longestWaitMs`.

## 3. Start the master

`master init`, executor `init`, `master start` ([setup](setup-from-zero.md#10-start-the-master)) as OS user whose GitHub credentials workers can't read; `--browser-profile`: Chrome as GitHub admin (`master browser`); App confirmation and GitHub Mobile *Confirm access* stay human-only. Reviewer: `master reviewer setup` or `master reviewer add PROFILE` ([template](../examples/master/claude-reviewer.json)); `master review GY-N` relaunches one.

### The loop must be supervised

`master init` (coordinator checkout) writes `~/.config/systemd/user/graphyard-master-OWNER-NAME.service`, runs `systemctl --user enable --now`, `loginctl enable-linger`; never a side effect (worker checkouts, temp directories refused). Move: `master init --token-stdin --replace-supervisor` from new checkout. `master status`: `setup.supervisor`. The loop and `graphyard up` preflight refuse a dirty CLI checkout (exit 2, naming its paths); the loop's research scratch is a worktree of the managed repository, never of the CLI checkout.

Installs share hosts: units named per repository (`graphyard-executor-OWNER-NAME@N.service` too) in `.graphyard/units.json`; setup never touches another checkout's unit. Each install needs its own `--herdr-workspace`.

### The pipeline doctor (on by default)

Every `run.doctor.intervalMinutes` (10) a Pi **doctor** fixes stuck work: `master scope`, `requirements`, `unblock`, `decide`+`approver`, `settle-containment`, `close`, `create`, `release`, `checkout-restore` (never merging, dispatching, evidencing); it runs a refused `master-role` command, then unblocks; posts findings (`master status` `doctor`) and escalates or files deduped faults. Off: `run.doctor.enabled=false`.

### Supervised mode (up --local)

`graphyard up --local` writes `"supervision": "supervised"` and your login (`operatorLogin`) to `master.json`; absent is autonomous: no reviewer App, no `master autonomy`, and the loop launches no reviewer, approver or escalation session. Items keep `review: true`: your GitHub approval of the exact head passes review and auto-merge lands it; `master status` prints `supervision`, flags PRs your login authored. Promote: `master reviewer setup`, `master reviewer add`, then `master promote --admin-token-stdin` ([promotion](master-agent-reference.md#promotion-to-autonomy)).

## 4. Prove the first PR

`graphyard doctor --profile through-merge` names gaps; `master run` dispatches a small item, merged once protection requires `Graphyard / merge`; `"systemDriven": false` allows [hand actions](master-agent.md#system-driven-items); CI workflows should cancel superseded pull-request runs (`cancel-in-progress` on the `pull_request` group; main never cancelled); `graphyard master protection` lists required checks whose workflow lacks it under `advisories`.

## 5. Inventory open pull requests

`graphyard onboard inventory --repo OWNER/REPO [--mapping FILE] [--out FILE] [--json]` lists a repository's open and draft pull requests (number, base, head branch, exact head sha, draft, URL) with detected release/deploy workflow triggers and required checks, each fact detected or unknown, and proposes one disposition each: `continue`, `hold` (a draft: nothing acts on it), `adopt` (same-PR adoption eligible: no failing required check, no conflict), `superseded` (only when a compare shows the base holds every commit of the head). It closes nothing, writes nothing but `--out`; `--mapping FILE` binds source keys and URLs to repository and number, reruns are byte-identical, and a key on two pull requests or a pull request under two keys is a named conflict.
