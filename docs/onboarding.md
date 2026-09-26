<!-- page: Start here | 3 | machines, accounts, the master, the first PR. -->
# Onboard a repository

## 1. Install the control plane

Follow [install](install.md): review `--plan`, then `install --provider railway --repo OWNER/REPO --apply`.

## 2. Add machines

Each session needs a worker identity and host ID:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

Commit `AGENTS.md`, `.gitignore`, `graphyard.json`; never `.graphyard/`. Without the master, `graphyard watch GY-N EPOCH -- COMMAND` runs a worker, stopped on lease loss.

### Documentation policy

`init --scan --apply` writes the documentation paths found to `graphyard.json` (`{"documentation":{"paths":["site/"],"changelog":"CHANGELOG.md"}}`); deploy the printed `GRAPHYARD_DOCUMENTATION`. Items carry *Documentation reflects this change*: a diff there, or `--no-docs`.

### What the generated instructions authorize

The managed `AGENTS.md` states **every session Graphyard launches receives its instruction as the session's own first request**; the only later paste — the loop's single re-prompt, or the reviewer's reminder — is acted on without confirmation. Herdr's bracketed paste is untrusted data (prompt injection); with the request on the command line sessions start without anybody sending `go`, and Claude Code reads the statement through `--append-system-prompt-file`. role files under `.graphyard/harness/` hold permissions, not instructions.

### Connect an account

Accounts connect in the UI, no shell: Settings › **Agents** › **Connect an account**. Pick a provider (z.ai, Anthropic API, OpenAI API, Claude, ChatGPT/Codex or Cursor); paste its key or start its login. A pasted key is sealed to the host's public key in the browser (the server relays ciphertext only); the executor writes it into the login home's provider auth file (mode 0600), smoke-tests it, and the card turns healthy or shows the error. A subscription login shows the URL and code to finish in your own browser. The host executor registers host keys and performs connects; it must be running. Strong accounts default to worker and reviewer, cheap models (GLM, Flash-class) to research, approver and the unit producer — appended to each failover order; **change** opens the role editor.

### Agent environments

Every account has a login home under `~/.coding_agents`, selected by `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_DATA_HOME` or `CURSOR_CONFIG_DIR`; Graphyard's tokens go in `~/.config/graphyard/` (mode 0600). `master environments --create claude` makes a fresh home; `--apply` reports quota and writes profiles.

Profiles run `"approvals": "auto"`; `"prompt"` is refused at launch ([approval modes](master-agent-sessions.md#approval-modes)).

### Configure the fleet

The **agent registry** (Settings › **Agents**) records runtimes, accounts, roles and policies; **Advanced** holds its forms. A host with logged-in CLIs can propose:

```sh
node "$GRAPHYARD_CLI" master registry propose --apply
```

### Add a runtime

Advanced, or the CLI — dash-led values onto their flags with `=`:

```sh
node "$GRAPHYARD_CLI" master registry runtime set aider --kind aider --arg=--yes-always \
  --home-variable AIDER_HOME --model-flag=--model --login 'AIDER_HOME={home} aider --login' --login-file session.json \
  --reason "Add the Aider runtime"
```

### Add an account

Connect it in the UI; the CLI records an existing login:

```sh
node "$GRAPHYARD_CLI" master registry model set opus --provider Anthropic --id claude-opus-5 \
  --input-cost 15 --output-cost 75 --tier frontier --context 1000000 --reason "Record the model and its price"
node "$GRAPHYARD_CLI" master registry account set claude-b --runtime claude --model opus \
  --home ~/.coding_agents/claude-b --max-sessions 2 --reason "Second Claude subscription"
node "$GRAPHYARD_CLI" master registry account quota opencode-a exhausted --resets-at 2026-09-22T00:00:00Z --reason "Plan cut off until Monday"
```

### Add a role

Most preferred account first; policy applies next launch:

```sh
node "$GRAPHYARD_CLI" master registry role set worker claude-b,claude-c,codex-a --concurrency 4 --reason "Prefer Claude; Codex is overflow"
node "$GRAPHYARD_CLI" master registry role set reviewer codex-a,claude-c --concurrency 2 --tool Read --model opus --reason "Read-only, frontier model"
```

## 3. Start the master

```sh
node "$GRAPHYARD_CLI" master init --url https://YOUR-GRAPHYARD-HOST --herdr-workspace HERDR_WORKSPACE_ID \
  --browser-profile Default --token-stdin < ~/.config/graphyard/INSTALL/tokens/INSTALL-master.token
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST   # installs the executors
node "$GRAPHYARD_CLI" master start codex
```

Run it under an OS identity whose GitHub credentials workers cannot read. `--browser-profile` is the administrator's GitHub-signed-in Chrome profile, for `master browser` flows; *Confirm access* in GitHub Mobile stays human-only.

### The loop must be supervised

`master init` writes `~/.config/systemd/user/graphyard-master.service`, runs `systemctl --user enable --now` and `loginctl enable-linger`; the unit restarts on crash, reboot and hang, and is never a side effect. To move it, run `master init --token-stdin --replace-supervisor`. `master status` reports `setup.supervisor`.

### Size review and proof capacity

Each candidate needs one review and one producer session per proof group; a profile's `"concurrency"` bounds how many run at once, without a restart. Adding workers: for worker count `W` and `G` proof groups, at least `⌈W / 2⌉` review and `G × ⌈W / 2⌉` producer slots, over two or more producer principals; watch `longestWaitMs`.

## 4. Prove the first PR

`graphyard doctor --profile through-merge` names every missing piece. Create a small item; `master run` dispatches it; the loop merges once protection requires `Graphyard / merge`. CI workflows should cancel superseded pull-request runs: group each by `${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}` with `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`; runs on main are never cancelled. `graphyard master protection` lists each required check whose workflow lacks cancel-in-progress under `advisories`.

## What stays manual

The subscription and GitHub logins behind each account, the App confirmation, plan approval, *Confirm access*, producer grants, and the [human-only decisions](glossary.md#who-decides).
