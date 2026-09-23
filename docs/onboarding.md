<!-- page: Start here | 3 | seven-step setup. -->
# Onboard a repository

For the operator connecting a real repository: the seven steps, and who owns each.

## 1. Deploy one control plane

One server and one Postgres database serve all workers ([deployment](deployment.md)).

  - `admin`: human operator, declaring `sessionKind: "human"`;
  - `coordinator`: master;
  - `worker`: one per concurrent worker session, never given an `admin`, `coordinator` or `producer` token;
  - `reader`: dashboards;
  - `producer`: each proof producer, limited to proof names its grant allows.
- **Set** `GRAPHYARD_PRINCIPALS`, `GITHUB_REPOSITORY`, `GITHUB_BASE_BRANCH` and `GITHUB_CI_APP_IDS`, then sign in with the admin token.

## 2. Connect GitHub

- Run `graphyard github-setup https://YOUR-GRAPHYARD-HOST` from the managed repository, or [create the App by hand](github.md#create-and-install-the-app) for an organization account; one registered before the merge queue must be [migrated](github.md#migrating-an-existing-app) to Contents: read and write. Copy its private values into the service, and configure CI and review protection now, requiring `Graphyard / merge` once published.
- Later permission changes and their acceptance are the master's, through `master browser` flows driven by the profile `master init --browser-profile` names; the only human-only step: approving a *Confirm access* prompt on GitHub Mobile.
- Confirm exact CI check names and their App IDs: GitHub Actions uses `15368`.

## 3. Connect a worker and Herdr

From a worker-only checkout on a worker machine:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

### What the generated instructions authorize

The managed `AGENTS.md` section is the coordination contract every agent runtime reads from the repository, and it states the one thing launched sessions need: every session Graphyard launches receives its instruction as the session's own first request, never as pasted text.

It is generated because Herdr's bracketed paste reaches a coding agent as untrusted data rather than its operator's request — right against prompt injection, wrong for a launch. Sessions now start without anybody sending `go`, and the generated statement is what lets the two pastes that remain — the loop's single re-prompt, and the reviewer's reminder to post a verdict it already judged — be taken as the operator's instruction. A Claude Code session under a role file loads only the user settings, which leaves `AGENTS.md` out, so the launcher writes the same statement to that session's role file (`.graphyard/launch/NAME.role` in its checkout) and loads it with `--append-system-prompt-file`; the request itself reaches the runtime the same way, so what is typed into the pane stays short whatever the request holds ([how the request reaches the runtime](master-agent.md#the-request-is-the-sessions-first-message)). Nothing else pasted carries that authority, and the role files under `.graphyard/harness/` hold permissions, not instructions.

## 4. Start the master

Use a clean checkout under a dedicated coordinator OS identity, no worker connection and no worker session able to read its merge-capable GitHub CLI credentials:

```sh
herdr workspace list
node "$GRAPHYARD_CLI" master init --url https://YOUR-GRAPHYARD-HOST \
  --herdr-workspace HERDR_WORKSPACE_ID --browser-profile Default --token-stdin
node "$GRAPHYARD_CLI" master start codex     # or: master start claude
```

### The loop must be supervised

`master run` is a process, and an unsupervised process stays down: Graphyard reports an absent or stalled loop as its top attention item, but nothing acts on that item unless a supervisor does. Treat an unsupervised loop as an incomplete installation.

`master init`, run by you from the coordinator checkout, installs it. On a Linux host with a systemd user manager it writes `~/.config/systemd/user/graphyard-master.service` from this installation's own checkout, launcher and interval, reloads systemd if the file changed, and runs `systemctl --user enable --now graphyard-master.service` and `loginctl enable-linger`, so the loop restarts after a crash (`Restart=always`, no start limit), a reboot, and a hang (`WatchdogSec` against the loop's per-cycle keep-alive). Re-running it is idempotent, and setup prints what it did under `supervisor.performed`.

Installing the unit is that explicit operator action and never a side effect: no library call, no test run (refused by one shared guard any home outside the system temporary directory) and no worker, reviewer or producer checkout writes it. `master init` itself refuses, by name and without failing the rest of setup, a checkout under the temporary directory, one inside a managed `.graphyard` directory, and a directory with no `.graphyard/master.json`; it also refuses to replace a unit running a different checkout or launcher unless you re-run it with `--replace-supervisor`. Refusals appear under `supervisor.refused` with the command that resolves them, and at the top of `attention` and `next`.

```sh
node "$GRAPHYARD_CLI" master status   # setup.supervisor: installed, enabled, active, linger
systemctl --user status graphyard-master.service
journalctl --user -u graphyard-master.service -f
```

`master status` reads the answer from systemd every time, lingering included, and a supervisor missing, disabled, stopped or unreadable becomes an attention item naming the exact command that fixes it. Where Graphyard cannot install one — any non-Linux host, or no reachable systemd user manager — setup says so and prints what you must run instead: `master run` under that platform's own always-restart supervisor, configured to start at boot.

## 5. Register the reviewer identity

Independent review needs [the reviewer App](github.md#the-reviewer-app), a second GitHub identity.

- `master reviewer setup`: open the printed local URL, confirm the App, install it on the managed repository only — that click and your provider logins are the only hand-run steps. Its key and IDs stay outside every worktree at mode 0600.
- `master reviewer bind FILE --key-stdin` binds an App you already created: put its IDs in a secret-free file, send the PEM on stdin.
- `master reviewer add PROFILE.json` adds one reviewer launch profile ([Claude](../examples/master/claude-reviewer.json), [Cursor](../examples/master/cursor-reviewer.json) or [opencode](../examples/master/opencode-reviewer.json)); it holds no Graphyard credential.
- `master protection`, then `master protection --apply`, match branch protection to every open item's review policy.

## 6. Add workers

### Agent environments

- **Agent environment:** every agent CLI account's own isolated config and login home, one directory per account named `<agent>-<letter>` under `~/.coding_agents`.

Each runtime's variable, login file and login command:

- **Claude Code:** `CLAUDE_CONFIG_DIR`, `.credentials.json`, `CLAUDE_CONFIG_DIR=… claude` then `/login`
- **Codex:** `CODEX_HOME`, `auth.json`, `CODEX_HOME=… codex login`
- **OpenCode:** `XDG_DATA_HOME` (data under `opencode/`), `opencode/auth.json`, `XDG_DATA_HOME=… opencode auth login`
- **Cursor:** `CURSOR_CONFIG_DIR`, `cli-config.json`, `CURSOR_CONFIG_DIR=… cursor-agent login`

```sh
node "$GRAPHYARD_CLI" master environments                                # discover; report login and quota
node "$GRAPHYARD_CLI" master environments --create claude,codex --apply  # add claude-<next>, codex-<next>
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-a claude                       # /login, once per new environment
node "$GRAPHYARD_CLI" master environments --apply                        # generate the profiles
```

- **Without `--apply`** writes nothing; lists every environment: whether logged in, quota it could read, login command for each that is not.
- **Rerun** after logging another account in; launcher checks: [agent environments](fleet.md#agent-environments).
- **Paths:** environments live one directory per account under `~/.coding_agents` (`--directory DIR`, or `GRAPHYARD_AGENT_ENVIRONMENTS`, uses another root); worker and producer tokens sit in `~/.config/graphyard/workers/` and `~/.config/graphyard/producers/`, mode 0600, beside the coordinator credential (`$GRAPHYARD_CONFIG_HOME` if set).

### Configure the fleet

Which runtime, account and model a launch runs on is decided by the [agent registry](fleet.md#the-agent-registry) in the control plane, not by a file; a profile is only the Graphyard identity a session acts under. `master init` prints a proposal from what the host already has, and so does `master registry propose [--apply]`: one runtime per CLI found with its launch contract, one account per logged-in login (the isolated environments above, plus each runtime's own default home and an installed `muse`), a placeholder `<runtime>-default` model, and all five roles over those accounts. Nothing is stored without `--apply`, and afterwards the fleet changes from anywhere holding the coordinator credential, a running `master run` following on its next action.

Adding capacity by hand follows the same order, because each entry names the one before it — a **runtime**, then a **model**, then an **account**, then a **role**:

```sh
node "$GRAPHYARD_CLI" master registry runtime set aider --kind aider --arg=--yes-always \
  --home-variable AIDER_HOME --model-flag=--model --login 'AIDER_HOME={home} aider --login' --login-file session.json --reason "Add the Aider runtime"
node "$GRAPHYARD_CLI" master registry model set opus --provider Anthropic --id claude-opus-5 \
  --input-cost 15 --output-cost 75 --tier frontier --context 1000000 --notes "Frontier" --reason "Record the model and its price"
node "$GRAPHYARD_CLI" master registry account set claude-b --runtime claude --model opus \
  --home ~/.coding_agents/claude-b --host $(hostname) --max-sessions 2 --note "Second subscription" --reason "Add capacity"
node "$GRAPHYARD_CLI" master registry role set worker claude-b,claude-c --concurrency 4 --reason "Prefer Claude"
```

A value starting with a dash is written onto its flag with `=` (`--arg=--yes-always`), since written apart the shell hands the CLI two flags and it refuses.

### Size review and proof capacity

Every candidate passes one review and one producer session per proof group, and those lanes run only as many sessions at once as the fleet declares ([per-role concurrency](fleet.md#per-role-concurrency)). For `W` workers and `G` proof groups a typical item needs, about half the workers can have a candidate at the gates at once: at least `⌈W / 2⌉` review slots summed over every reviewer profile (at least 2 once there is more than one worker), at least `G × ⌈W / 2⌉` producer slots spread over at least two producer principals, and one logged-in agent environment per two or three slots, since two sessions on one account share its rate limits. Set `"concurrency"` on each reviewer and producer profile, then read `concurrency` in `master status`: a role whose `running` sits at `limit` while `waiting` is above zero and `longestWaitMs` keeps climbing is starving, so raise `concurrency` on a profile whose accounts have quota left, or add a profile on another account.

### Profiles by hand

- **Start from a template** ([Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [Cursor](../examples/master/cursor-worker.json), [Muse](../examples/master/muse-worker.json) or an [existing Herdr session](../examples/master/existing-worker.json)), store each worker token in a mode-0600 file outside the repository, then `master worker add /path/to/profile.json` and `master status`.

### Approval modes

Every launch profile carries `approvals`:

- `auto` (default) adds that runtime's non-interactive startup contract;
- `prompt` adds nothing: a human answers in the session tab.

`master worker add` and `master reviewer add` print what a profile will start with.

What `auto` adds per runtime, and what it costs:

## 7. Prove the first PR

1. Read the [readiness checklist](install.md#readiness-checklist) for the profile you will enforce: a ready checklist is configuration, not proof.
2. Create a small real work item using the repository's exact CI check names and acceptance proofs, then dispatch it: `master dispatch GY-1 codex-primary` for a trusted local profile, or a remote worker's own `claim`, `worktree` and `watch`.
3. The worker pushes its branch, opens a pull request, runs `complete GY-1 EPOCH PR_NUMBER`; the loop launches the reviewer and producers for that head; `master review GY-1` is only the recovery path.
4. Connect acceptance evidence before merging: a narrowly scoped `producer` token in protected CI that pull-request code cannot read, an approved `attest` decision for a `manual:` proof.
6. Before adding workers, rehearse [a lost worker](operations-reference.md#lost-worker-before-submission) on that item.
