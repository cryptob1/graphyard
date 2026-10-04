<!-- page: Start here | 3 | machines, accounts, master, first PR. -->
# Onboard a repository

## 1. Install the control plane

Follow [install](install.md): `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --apply` after reviewing `--plan`.

## 2. Add machines

Each concurrent session needs a worker identity and host ID:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

Commit `AGENTS.md`, `.gitignore`, `graphyard.json`, workflows, not `.graphyard/`. Masterless, `graphyard watch GY-1 EPOCH -- COMMAND` runs a worker.

### Documentation policy

`init --scan --apply` writes documentation paths (`docs/`, `site/`, `README*`, `CHANGELOG*`) to `graphyard.json` (`{"documentation":{"paths":["site/"],"changelog":"CHANGELOG.md"}}`). Deploy the printed `GRAPHYARD_DOCUMENTATION` (default `docs/`, `README.md`, `AGENTS.md`); `doctor` reports a differing committed file as `documentation.drift`. Features and bugs carry *Documentation reflects this change*: a docs diff or `complete --no-docs "WHY"`, reviewer-judged. An optional `"wordBudget":{"total":N,"perPage":N}` (`paths` narrows counted Markdown pages) is checked: near the total, `master status` raises `docs` and the loop files a trim item; queue overflow ejects the crossing entry. Otherwise nothing is counted.

### Merge gate and release candidates

Repositories default to Graphyard's [delivery model](delivery.md#managed-repositories). `init --scan` prints `mergeGate`: pull requests require build, typecheck, lint and fast unit checks; integration, E2E, soak and unrecognised checks run per candidate. `--apply` writes the confirmed split as `delivery` in `graphyard.json` (move a check there, rescan) and generates `graphyard-release-candidate.yml` (main's tip cut every six hours or on demand, `--candidate-cron CRON|off`; suites at the pinned SHA; UAT through the deploy adapter) and `graphyard-promotion.yml` (production only from a UAT-passed SHA). Opt out with `init --scan --delivery per-pr`: every check stays required per pull request.

### What the generated instructions authorize

`AGENTS.md` states that **every session Graphyard launches receives its instruction as the session's own first request, on the runtime's command line, never as pasted text**; the only later paste (the loop's single re-prompt, the reviewer's reminder, or its event wake) comes from the same launcher and is acted on without confirmation.

Agents treat bracketed paste as untrusted data (prompt injection), so sessions start without anybody sending `go`; Claude Code also gets `--append-system-prompt-file`. The role files under `.graphyard/harness/` hold permissions, not instructions.

### Connect an account

Settings › **Agents** › **Connect an account**: pick a provider; paste a key (sealed to the host's key in the browser; the server relays only ciphertext) or start a login. The host writes and smoke-tests the auth file (0600). For a subscription login, finish its URL and code in a browser; Claude: **Paste the code** (**Cancel** stops it). Admins' **Retry** re-enters the credential. With the host's executor running, strong accounts join worker and reviewer, cheap ones approver and producer; **change** edits roles.

### Agent environments

An account's `~/.coding_agents` login home is set by `CLAUDE_CONFIG_DIR` (Claude Code), `CODEX_HOME` (Codex), `XDG_DATA_HOME` (OpenCode) or `CURSOR_CONFIG_DIR` (Cursor, whose login is `CURSOR_CONFIG_DIR=HOME agent login`). Tokens go in `~/.config/graphyard/workers/` and `producers/` (0600). Then:

```sh
node "$GRAPHYARD_CLI" master environments --create claude,codex --apply  # new login homes
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-a claude                       # /login once
node "$GRAPHYARD_CLI" master environments --apply                        # report quota, write profiles
```

Profiles default to [`"approvals": "auto"`](master-agent-sessions.md#approval-modes) (trade-off: unattended); `"prompt"` is refused at launch.

### Configure the fleet

The **agent registry** records runtimes, accounts, roles and policies, proposed from `~/.coding_agents`:

```sh
node "$GRAPHYARD_CLI" master registry propose
node "$GRAPHYARD_CLI" master registry propose --apply
```

### Add a runtime

The CLI (dash-led values join their flag with `=`):

```sh
node "$GRAPHYARD_CLI" master registry runtime set aider --kind aider --arg=--yes-always \
  --home-variable AIDER_HOME --model-flag=--model --login 'AIDER_HOME={home} aider --login' --login-file session.json \
  --reason "Aider"
```

### Add an account

UI, or one login each:

```sh
node "$GRAPHYARD_CLI" master registry model set opus --provider Anthropic --id claude-opus-5 \
  --input-cost 15 --output-cost 75 --tier frontier --context 1000000 --reason "Model pricing"
node "$GRAPHYARD_CLI" master registry account set claude-b --runtime claude --model opus \
  --home ~/.coding_agents/claude-b --max-sessions 2 --reason "Second subscription"
node "$GRAPHYARD_CLI" master registry account quota opencode-a exhausted --resets-at 2026-09-22T00:00:00Z --reason "Plan exhausted"
```

`--plan NAME` names an account's provider plan (`none` clears); otherwise one host and home share a plan, as do `pi-X` and `opencode-X`. A plan's accounts share one failover budget: one exhausted bars the rest.

`--key-file zai.key --key-variable ZAI_API_KEY`: a 0600 key file, exported per run. New or changed Pi accounts are smoke-tested, failures barred until retested; two unjudged runs bench it from that role an hour. Registry writes refuse any field that looks like a pasted key; model ids are exempt.

### Add a role

Preferred account first; next launch applies:

```sh
node "$GRAPHYARD_CLI" master registry role set worker claude-b,claude-c,codex-a --concurrency 4 --reason "Codex overflow"
node "$GRAPHYARD_CLI" master registry role set reviewer codex-a,claude-c --concurrency 2 --tool Read --model opus --reason "Read-only"
```

`--concurrency` counts settled sessions: registry reads end those whose lease or request lapsed (`sessions-settled` in history).

### Size review and proof capacity

Each candidate needs one review and one producer session per proof group; `"concurrency"` caps a profile's sessions without a restart:

```json
"reviewers":[{"name":"claude-reviewer","agentName":"review-claude","kind":"claude","accounts":["claude-a","claude-b"],"concurrency":3}]
```

Adding workers? For worker count `W` and `G` proof groups: `⌈W / 2⌉` review slots and `G × ⌈W / 2⌉` producer slots over ≥ 2 producer principals. Watch `longestWaitMs`.

## 3. Start the master

```sh
node "$GRAPHYARD_CLI" master init --url https://YOUR-GRAPHYARD-HOST --herdr-workspace HERDR_WORKSPACE_ID \
  --browser-profile Default --token-stdin < ~/.config/graphyard/INSTALL/tokens/INSTALL-master.token
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST   # now installs the executors
node "$GRAPHYARD_CLI" master start codex     # or: master start claude
```

Run it as an OS identity whose GitHub credentials workers can't read; `--browser-profile` is the Chrome profile signed in as GitHub admin (`master browser`); *Confirm access* in GitHub Mobile stays human-only. Add the reviewer with `master reviewer setup` and `master reviewer add PROFILE` ([template](../examples/master/claude-reviewer.json)); its manifest flow is the only App confirmation.

Onboarding writes and explains `mergeQueue` in `.graphyard/master.json`: `parallelTips` (default 4) positions validated at once, needing parallelTips × pull-request jobs concurrent Actions jobs (declare `ciConcurrency`; `master protection` flags a lower one), and [shared-infrastructure](github.md#optimistic-merges) `optimisticExclude` globs never merged optimistically. Re-runs keep them; `mergeQueue.optimistic: false` turns the lane off.

### The loop must be supervised

`master init` (coordinator checkout) writes `~/.config/systemd/user/graphyard-master.service`, runs `systemctl --user enable --now` and `loginctl enable-linger`, restarting on crash, reboot, hang; never a side effect (worker checkouts, temp directories refused). Move it with `master init --token-stdin --replace-supervisor` from the new checkout; `master status` reports `setup.supervisor` and the merger.

### The pipeline doctor (on by default)

Every `run.doctor.intervalMinutes` (default 10) the loop launches the **doctor**, a Pi session fixing stuck and overdue work through sanctioned commands only (`master scope`, `requirements`, `unblock`, `decide`+`approver`, `settle-containment`, `close`, `create`, `release`), never merging, dispatching or submitting evidence. Each run posts per-item findings and a summary (`doctor` in `master status`); unactionable ones escalate or file deduplicated fault items. The loop itself settles submitted lapsed fences, clears covered blockers and relaunches unanswered approvers. Off: `run.doctor.enabled=false`.

## 4. Prove the first PR

`graphyard doctor --profile through-merge` names missing pieces. `master run` dispatches a small item; the loop merges once protection requires `Graphyard / merge`. `"systemDriven": false` allows [hand actions](master-agent.md#system-driven-items).

CI workflows should cancel superseded pull-request runs, grouped by `${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}` with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`; runs on main are never cancelled. `graphyard master protection` lists each required check whose workflow lacks cancel-in-progress under `advisories`. Logins (provider, GitHub, browser profile), the App confirmation, plan approval, *Confirm access*, producer grants and the [human-only decisions](glossary.md#who-decides) stay manual.
