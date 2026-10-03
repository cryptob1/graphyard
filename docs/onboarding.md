<!-- page: Start here | 3 | machines, accounts, master, first PR. -->
# Onboard a repository

## 1. Install the control plane

Follow [install](install.md): `node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --apply` after reviewing `--plan`.

## 2. Add machines

Each concurrent session needs a worker identity and host ID; raise `install --workers` or connect:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

Commit `AGENTS.md`, `.gitignore`, `graphyard.json`; never `.graphyard/`. Without the master, `graphyard watch GY-1 EPOCH -- COMMAND` runs a worker, stopped on lease loss.

### Documentation policy

`init --scan --apply` writes found documentation paths (`docs/`, `site/`, `README*`, `CHANGELOG*`) to `graphyard.json` (`{"documentation":{"paths":["site/"],"changelog":"CHANGELOG.md"}}`). Deploy the printed `GRAPHYARD_DOCUMENTATION` (default `docs/`, `README.md`, `AGENTS.md`); `doctor` reports `documentation.drift` if the committed file differs. Features and bugs carry *Documentation reflects this change*: a diff there or `complete --no-docs "WHY"`, reviewer-judged. An optional `"wordBudget":{"total":N,"perPage":N}` (`paths` narrows the counted Markdown pages) is checked against those paths: near the total, `master status` raises `docs` and the loop files a trim item; a queue overflow ejects the entry that crossed it. Without one, nothing is counted.

### What the generated instructions authorize

The managed `AGENTS.md` section states that **every session Graphyard launches receives its instruction as the session's own first request, on the runtime's command line, never as pasted text**; the only later paste (the loop's single re-prompt, the reviewer's reminder, or its event wake of the master session) comes from the same launcher and is acted on without confirmation.

Agents treat bracketed paste as untrusted data (prompt injection), so sessions start without anybody sending `go`; Claude Code also gets `--append-system-prompt-file`. The role files under `.graphyard/harness/` hold permissions, not instructions.

### Connect an account

Settings › **Agents** › **Connect an account**: pick a provider; paste a key (sealed to the host's public key in the browser — the server relays ciphertext only) or start a login. The host writes the provider's auth file (0600) and smoke-tests provider and model; the card shows the result. A subscription login shows its URL and code — finish it in your browser; for Claude, **Paste the code** its page shows (**Cancel** stops it). **Retry** on a failed card is admins-only: it re-enters the credential. The host's executor must run: strong accounts join worker and reviewer, cheap ones approver and producer (**Pi (z.ai key)** writes Pi's own `auth.json` in a `pi-<letter>` home); research joins when the host makes the account's wrapper its research command; **change** edits roles. The shell steps below remain for scripted setups.

### Agent environments

Each account's `~/.coding_agents` login home is selected by `CLAUDE_CONFIG_DIR` (Claude Code), `CODEX_HOME` (Codex), `XDG_DATA_HOME` (OpenCode) or `CURSOR_CONFIG_DIR` (Cursor, whose login is `CURSOR_CONFIG_DIR=HOME agent login`). Tokens go in `~/.config/graphyard/workers/` and `producers/` (mode 0600). Then:

```sh
node "$GRAPHYARD_CLI" master environments --create claude,codex --apply  # new login homes
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-a claude                       # /login once
node "$GRAPHYARD_CLI" master environments --apply                        # report quota, write profiles
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

Connect it in the UI, or record one login each:

```sh
node "$GRAPHYARD_CLI" master registry model set opus --provider Anthropic --id claude-opus-5 \
  --input-cost 15 --output-cost 75 --tier frontier --context 1000000 --reason "Model pricing"
node "$GRAPHYARD_CLI" master registry account set claude-b --runtime claude --model opus \
  --home ~/.coding_agents/claude-b --max-sessions 2 --reason "Second subscription"
node "$GRAPHYARD_CLI" master registry account quota opencode-a exhausted --resets-at 2026-09-22T00:00:00Z --reason "Plan exhausted"
```

`--key-file zai.key --key-variable ZAI_API_KEY`: a 0600 key file, exported per run. New or changed Pi accounts are smoke-tested; failure bars it until retested; two unjudged runs bench it from that role an hour. Any registry write (CLI, dashboard or API) is refused when a field looks like a pasted key: a known prefix, a PEM block, a JWT, a z.ai key, or a long random letter-and-digit token. A model id built of words, numbers and short version parts is exempt.

### Add a role

Preferred first:

```sh
node "$GRAPHYARD_CLI" master registry role set worker claude-b,claude-c,codex-a --concurrency 4 --reason "Codex overflow"
node "$GRAPHYARD_CLI" master registry role set reviewer codex-a,claude-c --concurrency 2 --tool Read --model opus --reason "Read-only"
```

`--concurrency` counts settled sessions: any registry read ends those whose lease or request lapsed (`sessions-settled`, with reasons, in `master registry history`).

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

Run it as an OS identity whose GitHub credentials workers cannot read. `--browser-profile` is the Chrome profile signed in to GitHub as admin (`master browser`); *Confirm access* in GitHub Mobile stays human-only. Add the reviewer with `master reviewer setup` and `master reviewer add PROFILE` ([Claude](../examples/master/claude-reviewer.json) template); its manifest flow is the only App confirmation.

Onboarding writes and explains `mergeQueue` in `.graphyard/master.json`: `parallelTips` (default 4) queue positions validated at once, needing parallelTips × pull-request jobs concurrent Actions jobs — declare your limit as `ciConcurrency` and `master protection` flags a lower one — and the [shared-infrastructure](github.md#optimistic-merges) `optimisticExclude` globs never merged optimistically over. Tune both there; re-runs keep them; `mergeQueue.optimistic: false` turns the lane off.

### The loop must be supervised

`master init` from the coordinator checkout writes `~/.config/systemd/user/graphyard-master.service`, runs `systemctl --user enable --now` and `loginctl enable-linger`, restarting on crash, reboot and hang; never a side effect: worker checkouts and temp directories are refused. Move it with `master init --token-stdin --replace-supervisor` from the new checkout; `master status` reports `setup.supervisor` and the merger.

## 4. Prove the first PR

`graphyard doctor --profile through-merge` names every missing piece. `master run` dispatches a small item; the loop merges once branch protection requires `Graphyard / merge`. `"systemDriven": false` allows [hand actions](master-agent.md#system-driven-items).

CI workflows should cancel superseded pull-request runs: group each by `${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}` with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`; runs on main are never cancelled. `graphyard master protection` lists each required check whose workflow lacks cancel-in-progress under `advisories`.
