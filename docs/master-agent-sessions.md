<!-- page: Operate Graphyard | 5 | install, profiles, accounts, and launches. -->
# Master-agent sessions

How the [master](master-agent.md) is installed, what it launches sessions on, and how a launch starts.

## Install

Install needs Node 24, Herdr 0.7.1+, a Graphyard checkout, and a GitHub CLI authenticated as an identity that may merge the protected base branch. Create a `coordinator` principal, then, from a clean coordinator checkout:

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
herdr workspace list
node "$GRAPHYARD_CLI" master init --url https://YOUR-GRAPHYARD-HOST \
  --herdr-workspace HERDR_WORKSPACE_ID --browser-profile Default --token-stdin
node "$GRAPHYARD_CLI" master start codex     # or: master start claude
```

Paste the token, then Enter and Ctrl-D. `--browser-profile` names the Chrome profile signed in to GitHub as repository administrator, for the [browser flows](master-agent-reference.md#github-administration-through-the-browser). `master start` also installs the master's [harness rules](master-agent-reference.md#harness-permissions). Run the coordinator under a dedicated OS identity or machine: workers under the same OS user can read its GitHub CLI credentials.

## Add a worker

Start from a template: [Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [Cursor](../examples/master/cursor-worker.json), [Muse](../examples/master/muse-worker.json), or [existing session](../examples/master/existing-worker.json). Keep profiles in the ignored `.graphyard/profiles/`; each points to a mode-0600 worker-token file outside every worktree:

```sh
node "$GRAPHYARD_CLI" master worker add /path/to/profile.json
```

A `launch` profile is supervised and receives new work; an `existing` profile only adds health visibility for a session already owning work. Profiles hold no Graphyard variables or secret-looking values. Local dispatch needs Linux with a systemd user manager.

### Muse

A `kind: "muse"` profile takes the same supervised path, under its own worker credential. It needs Herdr 0.9.1+ and a logged-in `muse`; the template passes `--approval-mode never --trust-workspace`. Muse's states are telemetry; the lease stays the ownership authority. Never start `muse` directly for dispatched work.

## Agent environments

An *agent environment* is one isolated login home per agent CLI account (`~/.coding_agents/claude-b` under `CLAUDE_CONFIG_DIR`; see [onboarding](onboarding.md#agent-environments)):

```sh
node "$GRAPHYARD_CLI" master environments [--create claude,codex] [--apply]
```

A profile's `accounts` lists the environments it may run on, in failover order. Each launch picks the first account that is logged in with no usage window at or above `run.quotaCeilingPercent` (default 95); an unreadable quota counts as `unknown` and does not block. An account failing a check **fails over** to the next, recording the reason. A worker profile with no usable account claims nothing, so the item goes to another profile. `dispatch.accounts` in `master status` shows each environment's last check.

### The agent registry

The **agent registry** is the fleet as control-plane state: runtimes, accounts (host and login home, observed quota, model), and the roles `worker`, `reviewer`, `producer`, `approver` and `escalation-handler`, each with eligible accounts in preference order and a concurrency limit. Configure it with `master registry …`, `/api/agent-registry`, or the dashboard's Agent fleet page. `master registry propose --apply` builds it from a host's logins. Each launch takes the role's first eligible account, recorded as `agent-registry.selected` with every account passed over. Changes apply on the next action. A role the registry does not define falls back to the profile's `accounts`. `master status` reports it under `fleet`. The fleet is the master's to change; logging in or buying an account is the only human part.

### Exhaustion in the middle of a session

An account that runs out mid-session prints a limit notice (`You've hit your weekly limit · resets …`) and stops. The loop reads every idle, done or blocked pane; on a notice it:

1. commits a worker's uncommitted changes on its attempt branch as `WIP: GY-N attempt E interrupted by provider quota exhaustion`, unpushed;
2. holds the account as exhausted until the reset the notice names, or for one hour;
3. records `capacity.exhausted` and ends the attempt as `released`, raising no `lease-loss`;
4. relaunches the work on the next account or profile, about twenty seconds later.

A worker that dies without submitting keeps its work the same way (`capacity.interrupted`); the next attempt's prompt names the commit to cherry-pick.

### When a role has no account left

A role with every account spent is capacity, not a launch failure: each waiting item records one `capacity.escalations[]` entry with the reset times, and that role stops launching until the first reset while others carry on (`capacity` in `master status`). A logged-out account is not capacity but a launch refusal for the master, who logs it in or reorders accounts with `master config accounts:PROFILE=a,b`.

## How a session starts

### The request is the session's first message

Every session Graphyard launches receives its instruction as its own first request, on the runtime's command line, never pasted: a coding agent rightly treats pasted text as untrusted. `master status` shows `delivery: request`, or `paste` for a runtime without a request contract.

#### How the request reaches the runtime

The launcher writes the request to `.graphyard/launch/NAME.request`, and a Claude session's authorization to `NAME.role`, both mode 0600 in the session's checkout (removed with the checkout), then types a short command referencing them:

```
GY=/path/to/checkout/.graphyard/launch/NAME; claude --permission-mode bypassPermissions --setting-sources user --settings /path/to/repo/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

The shell expands the request into the runtime's first argument (OpenCode: `--prompt`). The typed line is bounded at **512 bytes** whatever the request is. `agentArgs` must not end in a variadic flag such as `--add-dir`, which would swallow the request. A role-file session does not load `AGENTS.md`, so the authorization reaches it through `--append-system-prompt-file`.

#### The start bound reads the pane

The launcher then polls `herdr agent get` and `herdr pane read` every half second. The runtime is **ready** when Herdr reports it working, idle or done with no consent prompt on screen, or when its banner or spinner is showing. `started.detail` records `the claude runtime is on screen while Herdr reports it unknown` for that case. It is **starting** when its process exists but nothing is drawn, **awaiting consent** on a first-run prompt, and **blocked** on any other Herdr-reported dialog.

Ready within **30 seconds** means started; one still starting then gets up to **120 seconds** (`started.extended`). Anything else is refused, naming the case and the pane's last non-empty line, never Herdr's own `agent_not_found`:

- `the claude runtime never started within 30 s in pane w1V:pR6 (command still echoing); …`: the host is overloaded, or the pane was not at a prompt;
- `… (no runtime under the pane); the pane last showed: "claude: command not found"`;
- `the claude runtime was still starting after 120 s …`;
- `the claude runtime is blocked before it is ready …`: the last line is the dialog.

A refusal shows in the row's attention (`Automatic producer launch for GY-N refused 1 time(s): …`); the loop retries on a widening schedule.

#### First-run consent prompts

A runtime may stop on a first-run prompt (Codex's untrusted-hooks menu, Claude Code's folder trust, a telemetry question), reported **`awaiting consent`** with the prompt's text. The launcher answers only its allow-list, always with the least-privilege option, and never one that grants hook execution or a sandbox escape:

| Rule | Prompt | Answer |
|---|---|---|
| `hooks-continue-untrusted` | new or changed hooks | **Continue without trusting** (hooks do not run) |
| `telemetry-decline` | telemetry, usage statistics, crash reports | the decline option |

Every other prompt is escalated: folder trust, anything unrecognised, and above all a **credential** or **payment** prompt, which is a human's. A reviewer or producer launch is refused and retried; a worker is held, recorded in `.graphyard/launch/NAME.consent`. `master status` names the pane and the command to answer it (`herdr pane attach P --workspace W`). A held slot is released after **15 minutes**; if the prompt still shows, the watch supervisor stops renewing and releases the lease and stops the session, so the item is dispatchable again.

#### Confirmed prompt delivery

Three messages are still pasted (a request to a runtime without a request contract, the loop's one re-prompt, the reviewer's verdict reminder); each counts only once visibly accepted, and three stalled deliveries relaunch the session.

### Acknowledgement, the one re-prompt, and never started

A reviewer or producer session is `awaiting acknowledgement` until thirty seconds of activity are seen (`counts.dispatchAwaiting`). A session still quiet after `run.acknowledgementSeconds` (30–900, default 90) is re-prompted once with its request. If it then settles without a result, it is **`never started`**, with its last on-screen words; that spends no retry budget and relaunches a minute later. Three of them exhaust the request (`retry.neverStarted`).

### The dispatcher's own state

The dispatch cursor (`*.dispatch.json` beside the coordinator credential) records ticks, refused launches and capacity holds:

- **The dispatcher bounds its own state where it composes it.** Every stored string is capped, each cut marked with an ellipsis.
- **A cursor that fails its schema is repaired, not fatal.** An over-long string is truncated, and the repair is logged once with the
  path that failed.
- **A tick failure is attributed and surfaced.** `dispatch.lastFailure` names the field, request and item. Three consecutive failures raise one attention item saying no reviewer or producer session is being launched for any item, and why. `graphyard master restart` repairs the cursor.

**A session that exits at launch is classified from its pane.** `herdr agent get` answers only `agent_not_found` for a runtime that exits **at launch**, so the dispatcher uses `herdr pane read`. A **provider limit notice** fails over exactly as a mid-session exhaustion does. Any other cause is refused with the case seen and the pane's last words, and retried.

## Approval modes

Every profile carries `approvals`: `auto` (default) adds the runtime's non-interactive startup contract; `prompt` adds nothing, leaving prompts to a human.

| Runtime | What `auto` adds |
| --- | --- |
| Claude Code | `--permission-mode bypassPermissions` |
| Codex | `--ask-for-approval never --sandbox workspace-write`, network access, and `--add-dir` for what the role writes |
| Cursor | `--force --trust` |
| opencode | `OPENCODE_PERMISSION` allowing every permission |
| Muse | nothing; the template's `agentArgs` pass its flags |

An `auto` session runs whatever it decides inside its own worktree, but holds only its role credential and cannot merge, produce trusted evidence, or weaken a requirement. `prompt` opts a profile out; a profile's own approval flags are kept. `master worker add` and `master reviewer add` print the resolved launch contract.

### Worker sandbox

A worker writes its worktree `.graphyard/worktrees/GY-N-E`, its Git admin directory `.git/worktrees/GY-N-E`, and the shared `.git`. Under Codex's `workspace-write` sandbox, the launcher adds `--add-dir` for the last two. Claude Code, Cursor and opencode run unsandboxed. The launcher first probes a write to each path inside the sandbox, failing with `Worker launch failed: the codex sandbox cannot write PATH` otherwise. `graphyard sync` hitting a read-only path records `Environment, not the item: …` as the blocker. Grant the path in the profile's sandbox arguments, then `master unblock GY-N REASON` and dispatch again.

## Independent review

The reviewer is a separate GitHub App identity: neither the PR author nor the control-plane App. Once registered with a profile, the loop launches it for every submitted head.

```sh
node "$GRAPHYARD_CLI" master reviewer setup
node "$GRAPHYARD_CLI" master reviewer add /path/to/reviewer-profile.json
node "$GRAPHYARD_CLI" master review GY-42 claude-reviewer   # recovery path
```

Templates: [Claude](../examples/master/claude-reviewer.json), [Cursor](../examples/master/cursor-reviewer.json), [opencode](../examples/master/opencode-reviewer.json). `master reviewer setup` registers the App through the manifest flow (the master drives the confirmation page) with Metadata read, Contents read and Pull requests write; the key stays outside every worktree. `master review GY-N [PROFILE]` verifies the exact candidate and mints an hour-long token into a private `GH_CONFIG_DIR`. Reserving the session in `.graphyard/reviews.json` first gives one request one session and one verdict. An `APPROVED` or `CHANGES_REQUESTED` review of that exact commit settles the request; two verdicts for one request are both withheld and a fresh review requested.

### Managing profiles

The loop adopts profile changes on its next tick:

| Command | Effect |
| --- | --- |
| `master producer add FILE` | Add a producer profile; its credential must authenticate exactly its principal as a producer |
| `master producer replace FILE` | Replace the producer profile of the same name, verified like `add` |
| `master producer remove NAME` | Remove a producer profile; its sessions settle as usual |
| `master reviewer remove NAME` | Remove a reviewer profile, clearing a `run.reviewerProfile` that names it |

`setup.attention` in `master status` reports setup that would silently stop every launch: a reviewer App registered but never bound, a missing reviewer credential, or a `herdrWorkspace` that Herdr no longer lists.
