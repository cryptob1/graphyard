<!-- page: Operate Graphyard | 5 | master install, worker, reviewer and producer profiles, provider accounts, and how sessions launch. -->
# Master-agent sessions

How the [master](master-agent.md) is installed, what it launches sessions on, and how a launch becomes a working session.

## Install

Install requires Node 24, Herdr 0.7.1 or newer, a Graphyard checkout, and a GitHub CLI authenticated as an identity that may merge the protected base branch. Create a `coordinator` principal, then run the following from a clean coordinator checkout:

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
herdr workspace list
node "$GRAPHYARD_CLI" master init --url https://YOUR-GRAPHYARD-HOST \
  --herdr-workspace HERDR_WORKSPACE_ID --browser-profile Default --token-stdin
node "$GRAPHYARD_CLI" master start codex     # or: master start claude
```

Paste the token, then press Enter and Ctrl-D. `master init --browser-profile PROFILE` names the Chrome profile that is signed in to GitHub as the repository administrator, which the [browser flows](master-agent-reference.md#github-administration-through-the-browser) use. `master start` also installs the master's [harness rules](master-agent-reference.md#harness-permissions). Run the coordinator under a dedicated OS identity or machine: workers running as the same OS user can read its GitHub CLI credentials.

## Add a worker

Start from a template: [Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [Cursor](../examples/master/cursor-worker.json), [Muse](../examples/master/muse-worker.json), or [existing session](../examples/master/existing-worker.json). Keep profiles in the ignored `.graphyard/profiles/` directory. A profile points to a mode-0600 worker-token file outside every worktree:

```sh
node "$GRAPHYARD_CLI" master worker add /path/to/profile.json
```

A `launch` profile is supervised and receives new work. An `existing` profile only adds health visibility for a session that already owns work. Profiles hold no Graphyard variables and no secret-looking values. Local dispatch needs Linux with a systemd user manager.

### Muse

A `kind: "muse"` profile takes the same supervised path as every runtime, under its own worker credential. It needs Herdr 0.9.1 or newer and a logged-in `muse` binary; the template passes `--approval-mode never --trust-workspace`. Muse's states are telemetry only: the lease stays the ownership authority. Never start `muse` directly for dispatched work.

## Agent environments

An *agent environment* is one isolated login home for one agent CLI account: `~/.coding_agents/claude-b` is Claude Code under `CLAUDE_CONFIG_DIR`, and Codex uses `CODEX_HOME`, OpenCode `XDG_DATA_HOME`, Cursor `CURSOR_CONFIG_DIR`. [Onboarding](onboarding.md#agent-environments) discovers or creates them:

```sh
node "$GRAPHYARD_CLI" master environments [--create claude,codex] [--apply]
```

A profile's `accounts` lists the environments it may run on, in failover order. Before every launch, the launcher picks the first account that is logged in and has no usage window at or above `run.quotaCeilingPercent` (default 95). An account whose quota Graphyard cannot read counts as `unknown` and does not block a launch. When an account fails a check, the launch **fails over** to the next one, recording the reason. A worker profile with no usable account claims nothing, so the loop routes the item to another profile. `dispatch.accounts` in `master status` shows every environment as the last check saw it.

### The agent registry

The **agent registry** is the fleet as control-plane state. It holds runtimes, their accounts (by host and login home, with observed quota), each account's model, and the roles `worker`, `reviewer`, `producer`, `approver` and `escalation-handler`, each with its eligible accounts in preference order and a concurrency limit. Configure it with `master registry …`, `/api/agent-registry`, or the dashboard's Agent fleet page. `master registry propose --apply` builds it from the logins a host already has. The control plane picks the first eligible account of the role for each launch and records the pick as `agent-registry.selected`, with every account it passed over. Changes apply on the next action, without a restart. A role the registry does not define falls back to the profile's own `accounts`. `master status` reports the registry under `fleet`. The fleet is the master's to change; logging an account in, or buying one, is the only human part.

### Exhaustion in the middle of a session

When an account runs out mid-session, its runtime prints a limit notice (`You've hit your weekly limit · resets …`) and stops. The loop reads the pane of every idle, done or blocked session, and on a notice it:

1. commits a worker's uncommitted changes on its attempt branch as `WIP: GY-N attempt E interrupted by provider quota exhaustion`, unpushed;
2. holds the account as exhausted until the reset the notice names, or for one hour;
3. records `capacity.exhausted` on the item and ends the attempt as `released`, so no `lease-loss` is raised;
4. relaunches the work on the next account or profile, about twenty seconds later.

A worker that dies without submitting keeps its work the same way, recorded as `capacity.interrupted`. The next attempt's prompt names the commit to cherry-pick.

### When a role has no account left

When every account of a role is spent, that is capacity, not a launch failure. Each waiting item records one `capacity.escalations[]` entry with the reset times. The loop stops launching that role until the first reset, and every other role carries on. `master status` says so in one line under `capacity`. A logged-out account is not capacity: it stays a launch refusal addressed to the master, who logs it in or reorders accounts with `master config accounts:PROFILE=a,b`.

## How a session starts

### The request is the session's first message

Every session Graphyard launches receives its instruction as its own first request, on the runtime's command line. It is never pasted into a running session, because a coding agent rightly treats pasted text as untrusted. `master status` shows `delivery: request`, or `paste` for a runtime Graphyard has no request contract for.

#### How the request reaches the runtime

The launcher writes the request to `.graphyard/launch/NAME.request`, and a Claude session's authorization to `NAME.role`, both mode 0600, inside the session's own checkout. It then types a short command that references them:

```
GY=/path/to/checkout/.graphyard/launch/NAME; claude --permission-mode bypassPermissions --setting-sources user --settings /path/to/repo/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

The shell expands the request into the runtime's first argument (OpenCode takes it through `--prompt`). The typed line is bounded at **512 bytes** whatever the request is. The files are removed with the checkout. `agentArgs` must not end in a variadic flag such as `--add-dir`, or that flag would swallow the request. Because a role-file session does not load the repository's `AGENTS.md`, the same authorization reaches it through `--append-system-prompt-file`, which is the file form of `--append-system-prompt`.

#### The start bound reads the pane

After typing, the launcher reads the pane every half second with `herdr agent get` and `herdr pane read`. The runtime is **ready** when Herdr reports it working, idle or done with no consent prompt on screen, or when its banner or spinner is showing. `started.detail` records `the claude runtime is on screen while Herdr reports it unknown` for that case. It is **starting** when its process exists but nothing is drawn yet. It is **awaiting consent** when a first-run prompt is showing, and **blocked** when Herdr reports a dialog that is not a consent prompt.

A runtime ready within **30 seconds** has started. One still starting at 30 seconds gets up to **120 seconds**, recorded as `started.extended`. Anything else is refused, naming the case and the pane's last non-empty line, never Herdr's own `agent_not_found`:

- `the claude runtime never started within 30 s in pane w1V:pR6 (command still echoing); …`: the host is overloaded, or the pane was not at a prompt;
- `… (no runtime under the pane); the pane last showed: "claude: command not found"`;
- `the claude runtime was still starting after 120 s …`;
- `the claude runtime is blocked before it is ready …`: the last line is the dialog.

A refusal appears in the row's attention (`Automatic producer launch for GY-N refused 1 time(s): …`), and the loop retries on a widening schedule.

#### First-run consent prompts

A runtime may stop before reading its request on a first-run prompt: Codex's untrusted-hooks menu, Claude Code's folder trust, or a telemetry question. Such a session is reported **`awaiting consent`** with the prompt's text. The launcher answers only its allow-list, always with the least-privilege option, and never one that grants hook execution or a sandbox escape:

| Rule | Prompt | Answer |
|---|---|---|
| `hooks-continue-untrusted` | new or changed hooks | **Continue without trusting** (hooks do not run) |
| `telemetry-decline` | telemetry, usage statistics, crash reports | the decline option |

Every other prompt is escalated: folder trust, anything unrecognised, and above all a **credential** or **payment** prompt, which is a human's. A reviewer or producer launch is refused and retried. A worker is held instead, with the hold written to `.graphyard/launch/NAME.consent`. `master status` names the pane and the command to answer it (`herdr pane attach P --workspace W`). A held slot is released after **15 minutes**. If the prompt is still showing then, the watch supervisor stops renewing the lease, releases it, and stops the session, so the item is dispatchable again.

#### Confirmed prompt delivery

Three messages are still pasted: a request to a runtime with no request contract, the loop's one re-prompt, and the reviewer's verdict reminder. Each counts only once the runtime visibly accepts it; after three stalled deliveries the session is relaunched.

### Acknowledgement, the one re-prompt, and never started

A reviewer or producer session shows as `awaiting acknowledgement` until thirty seconds of activity have been seen (`counts.dispatchAwaiting`). A session still quiet after `run.acknowledgementSeconds` (30–900, default 90) is re-prompted once with its request. If it then settles without a result, it is recorded as **`never started`**, with the last words on its screen. A never-started session does not spend the retry budget and is relaunched a minute later. Three of them exhaust the request (`retry.neverStarted`).

### The dispatcher's own state

The dispatch cursor (`*.dispatch.json` beside the coordinator credential) records ticks, refused launches and capacity holds. Three rules keep it working:

- **The dispatcher bounds its own state where it composes it.** Every stored string is capped, and each cut is marked with an ellipsis rather than hidden.
- **A cursor that fails its schema is repaired, not fatal.** An over-long string is truncated, and the repair is logged once with the
  path that failed.
- **A tick failure is attributed and surfaced.** `dispatch.lastFailure` names the field, request and item. Three consecutive failures raise one attention item saying that no reviewer or producer session is being launched for any item, and why. `graphyard master restart` repairs the cursor.

**A session that exits at launch is classified from its pane.** `herdr agent get` answers `agent_not_found` for a runtime that exits **at launch**, which says nothing about why, so the dispatcher uses `herdr pane read`. A **provider limit notice** means the account is exhausted: the launch fails over exactly as a mid-session exhaustion does, holding the account and relaunching on the next one. Any other cause is refused with the case seen and the pane's last words, and retried.

## Approval modes

Every profile carries `approvals`. `auto` (the default) adds the runtime's own non-interactive startup contract; `prompt` adds nothing, and a human answers prompts in the tab.

| Runtime | What `auto` adds |
| --- | --- |
| Claude Code | `--permission-mode bypassPermissions` |
| Codex | `--ask-for-approval never --sandbox workspace-write`, network access, and `--add-dir` for what the role writes |
| Cursor | `--force --trust` |
| opencode | `OPENCODE_PERMISSION` allowing every permission |
| Muse | nothing; the template's `agentArgs` pass its flags |

The trade-off is real: an `auto` session runs whatever it decides to run inside its own worktree. What it cannot do stays fixed: it holds only its role credential and still cannot merge, produce trusted evidence, or weaken a requirement. Use `prompt` to opt out for a profile. A profile that sets its own approval flags keeps them. `master worker add` and `master reviewer add` print the resolved launch contract.

### Worker sandbox

A worker writes three places: its worktree `.graphyard/worktrees/GY-N-E`, the worktree's Git admin directory `.git/worktrees/GY-N-E`, and the shared `.git`. Under Codex's `workspace-write` sandbox, the launcher adds `--add-dir` for the last two. Claude Code, Cursor and opencode run unsandboxed as the operator's user. Before starting the tab, the launcher writes a probe file in each path inside the sandbox, and fails the launch with `Worker launch failed: the codex sandbox cannot write PATH` when a probe cannot write. When `graphyard sync` hits a read-only path, it records `Environment, not the item: …` as the blocker. Grant the path in the profile's sandbox arguments, then `master unblock GY-N REASON` and dispatch again.

## Independent review

The reviewer is a separate GitHub App identity: neither the PR author nor the control-plane App. Once it is registered and a profile exists, the loop launches it for every submitted head.

```sh
node "$GRAPHYARD_CLI" master reviewer setup
node "$GRAPHYARD_CLI" master reviewer add /path/to/reviewer-profile.json
node "$GRAPHYARD_CLI" master review GY-42 claude-reviewer   # recovery path
```

Templates: [Claude](../examples/master/claude-reviewer.json), [Cursor](../examples/master/cursor-reviewer.json), [opencode](../examples/master/opencode-reviewer.json). `master reviewer setup` registers the App through the manifest flow (the App confirmation page, which the master drives itself), with Metadata read, Contents read and Pull requests write. The key is stored outside every worktree. `master review GY-N [PROFILE]` verifies the exact candidate and mints an hour-long read-only token into a private `GH_CONFIG_DIR`. It reserves the session in `.graphyard/reviews.json` before launching, so one request gets one session and one verdict. An `APPROVED` or `CHANGES_REQUESTED` review of that exact commit settles the request. When two verdicts from the reviewer identity answer one request, both are withheld and a fresh review is requested.

### Managing profiles

The loop adopts profile changes on its next tick:

| Command | Effect |
| --- | --- |
| `master producer add FILE` | Add a producer profile; its credential must authenticate exactly its principal as a producer |
| `master producer replace FILE` | Replace the producer profile of the same name, verified like `add` |
| `master producer remove NAME` | Remove a producer profile; its sessions settle as usual |
| `master reviewer remove NAME` | Remove a reviewer profile, clearing a `run.reviewerProfile` that names it |

`setup.attention` in `master status` reports setup that would silently stop every launch: a reviewer App that was registered but never bound, a missing reviewer credential, or a `herdrWorkspace` that Herdr no longer lists.
