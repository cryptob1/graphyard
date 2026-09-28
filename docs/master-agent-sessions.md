<!-- page: Operate Graphyard | 6 | profiles, accounts, launches. -->
# Master-agent sessions

## Launch profiles

Add a worker with `master worker add FILE` from a [template](../examples/master/claude-worker.json) (Codex, Claude, Cursor, Muse); tokens stay outside every worktree.

Add reviewers with `master reviewer setup` and `master reviewer add FILE` ([Claude](../examples/master/claude-reviewer.json), [opencode](../examples/master/opencode-reviewer.json)).

`master producer replace FILE`, `master producer remove NAME` and `master reviewer remove NAME` apply next tick; `setup.attention` reports launch-stopping setup.

### Session handles

`master status` `sessions` lists handles (runtime, host, pane, transcript, attach command).

### Approval modes

Sessions run in no-approval mode (`"approvals": "auto"`): `--permission-mode bypassPermissions`, `.claude.json` trust (Claude Code); `--ask-for-approval never --sandbox workspace-write`, network, `--add-dir` (Codex); `--force --trust` (Cursor); allow-all `OPENCODE_PERMISSION` (opencode); `--yolo` (Gemini, Qwen); `--allow-all-tools --allow-all-paths` (Copilot); `--approval-mode never --trust-workspace` (Muse); none (Pi). `"prompt"`, `refusedLaunchKinds` and runtimes lacking command-line requests never start; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}` in their arguments. Codex's sandbox gets `.git/worktrees/GY-N-E` and shared `.git` via `--add-dir`, probed first.

### Workers are write-confined to their worktree

A worker writes only its assigned worktree and Git directories (GY-857): codex keeps `--sandbox workspace-write`; opencode denies external directories; Claude worker rules deny `Edit`/`Write` of the coordinator checkout; turning confinement off is refused at launch. The loop and executors never start, self-upgrade or restart from a dirty checkout; escalation names the dirty paths and the leases they match.

## Accounts and failover

A profile's `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`) in order, unless the [agent registry](onboarding.md#configure-the-fleet) defines the role. A launch takes the first logged-in account under `run.quotaCeilingPercent`, else **fails over** (`dispatch.accounts`).

On a mid-session limit notice the loop commits worker changes as unpushed `WIP:`, records `capacity.exhausted` (not `lease-loss`), then relaunches on the next account or awaits the first reset.

## The loop's own master session

The loop launches the master session as a fleet role (`master registry role set master ACCOUNTS …`), pinned to one live session; unconfigured, it launches nothing. `master start` stays: either path adopts a live session under `masterAgentName`, never two. The launch is a Herdr pane on the role's account, first request the master prompt plus a durable handover naming the standing judgement work. The loop relaunches from a fresh handover on exit (two missed readings: pane gone, or runtime gone from the pane), on a limit notice (account held), or past `run.masterSessionMinutes` (default 240), deferred during a merge. It wakes the session per cycle naming changed subjects; `run.masterHeartbeatMinutes` (default 30) of silence buys one heartbeat. `master status` shows it under `daemon.master`.

## How a session starts

### The request is the session's first message

Every instruction is the session's first command-line request, never pasted ([authorization](onboarding.md#what-the-generated-instructions-authorize)).

#### How the request reaches the runtime

The launcher writes `.graphyard/launch/NAME.request` (and a Claude session's `NAME.role`), mode 0600, removed with the checkout, then types:

```
GY=…/.graphyard/launch/NAME; claude --permission-mode bypassPermissions --setting-sources user --settings …/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

The typed line is bounded at **512 bytes** whatever the request is.

#### The start bound reads the pane

The runtime is **ready** when Herdr reports it active with no prompt, or its banner shows (`the claude runtime is on screen while Herdr reports it unknown`). Ready within **60 seconds** (`run.launchStartSeconds`) is started; one still starting gets **120 seconds** (`started.extended`). Otherwise it is refused with the case and the pane's last non-empty line, never Herdr's own `agent_not_found`: `the claude runtime never started within 60 s (command still echoing)`, `… was still starting after 120 s` or `… is blocked before it is ready`; retried as `Automatic producer launch for GY-N refused 1 time(s): …`. A failed launch stops its supervisor, closes its pane, releases its claim.

#### First-run consent prompts

A runtime stopped on a first-run prompt is **`awaiting consent`**. The launcher answers only `hooks-continue-untrusted` (**Continue without trusting**) and `telemetry-decline`, with the least-privilege option, never one that grants hook execution or a sandbox escape; everything else, above all a **credential** or **payment** prompt, is escalated. A worker is held in `.graphyard/launch/NAME.consent` (attach: `herdr pane attach`); after **15 minutes** the supervisor stops renewing, so the item is dispatchable again.

### Acknowledgement, the one re-prompt, and never started

A reviewer or producer is `awaiting acknowledgement` until 30 s of activity (`counts.dispatchAwaiting`); quiet past `run.acknowledgementSeconds` (default 90) it is re-prompted once, and settling resultless makes it **`never started`**, relaunched a minute later without retry cost — three exhaust the request (`retry.neverStarted`).

### Resume, idle-with-lease and exited sessions

When a live attempt's blocker or scope request resolves, its inactive session is re-prompted once (item, epoch, change, `complete GY-N EPOCH PR`) on its handle; blocking again on that epoch ends the attempt and its blocker, and a fresh session, preferably another runtime, takes over. **Idle-with-lease** (30 quiet minutes, nothing open) is re-prompted once, then after 30 more handed to a new attempt on its branch.

### Panes are closed and reclaimed

Every launch records its pane on the item's session handle; when the loop ends that session it closes the pane and records the close. Research and triage runs open no pane. A per-cycle sweep is the backstop: it closes panes Graphyard launched **on this host** whose session has ended or whose worktree is gone, once they have stood agentless past the launch bound (**120 s**; a runtime that has not started yet looks the same), at most **6** per pass — never a pane Graphyard did not launch, one with an agent in it, or one whose worktree holds a live lease. Each pass records the host's pane count and the oldest agentless panes on the cursor, raising attention past **20** agentless panes (`daemon.escalations`).

### The dispatcher's own state

- **The dispatcher bounds its own state where it composes it**, each cut marked with an ellipsis.
- **A cursor that fails its schema is repaired, not fatal**; logged once with the path that failed.
- **A tick failure is attributed and surfaced.** `dispatch.lastFailure` names it. Three consecutive failures raise one attention item: no reviewer or producer session is being launched for any item. `graphyard master restart` repairs the cursor.

**A session that exits at launch is classified from its pane.** `herdr agent get` answers only `agent_not_found` for one that exits **at launch**, so the dispatcher uses `herdr pane read`: a **provider limit notice** fails over exactly as a mid-session exhaustion; any other cause is refused with the pane's last words and retried.
