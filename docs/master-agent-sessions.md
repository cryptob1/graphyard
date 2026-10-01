<!-- page: Operate Graphyard | 6 | profiles, accounts, launches. -->
# Master-agent sessions

## Launch profiles

Workers: `master worker add FILE` ([Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [Cursor](../examples/master/cursor-worker.json), [Muse](../examples/master/muse-worker.json)). Reviewers: `master reviewer setup`, then `master reviewer add FILE` ([Claude](../examples/master/claude-reviewer.json), [opencode](../examples/master/opencode-reviewer.json)). `master producer replace`, `master producer remove` and `master reviewer remove` apply next tick; `setup.attention` reports launch-stopping setup.

### Session handles

`master status` `sessions` lists handles (runtime, host, pane, transcript, attach).

### Approval modes

Sessions run with `"approvals": "auto"`: `--permission-mode bypassPermissions` plus `.claude.json` trust (Claude Code); `--ask-for-approval never --sandbox workspace-write`, network, `--add-dir` (Codex); `--force --trust` (Cursor, run and logged in as `agent`, not the IDE's `cursor` or non-interactive `cursor-agent`); allow-all `OPENCODE_PERMISSION` (opencode); `--yolo` (Gemini, Qwen); `--allow-all-tools --allow-all-paths` (Copilot); `--approval-mode never --trust-workspace` (Muse); none (Pi). `"prompt"`, `refusedLaunchKinds` and runtimes without command-line requests never start; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}` in their arguments.

### The coordinator checkout is confined at the OS level

Launched shell commands find the checkout unwritable. Codex `--sandbox workspace-write` confines only while every grant touching the checkout or its `.git` stays in the session's worktree and admin directory. Other launches run under bubblewrap: checkout read-only, PIDs unshared, fresh `/proc`, session bus, systemd and `/run/dbus` hidden; only the session's directory (assigned worktree, or a reviewer's or producer's checkout beside its starting root), worktree-admin directories and shared Git areas (objects, `graphyard/` branches, remote refs, `FETCH_HEAD`) are re-exposed, at canonical paths. A launch that cannot apply this (no bubblewrap, non-Linux, refused namespaces, confinement off, underivable checkout) is refused with the reason; the master session is exempt. The loop and executors never start, self-upgrade or restart on a dirty checkout, escalating the paths and their leases.

## Accounts and failover

A profile's `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`) unless the [agent registry](onboarding.md#configure-the-fleet) defines the role. A launch takes the first logged-in account under `run.quotaCeilingPercent`, else **fails over** (`dispatch.accounts`). On a runtime's own limit notice (never agent text), the loop commits worker changes as unpushed `WIP:`, records `capacity.exhausted` (not `lease-loss`) and relaunches on the next account or awaits reset.

## The loop's own master session

The master session is a fleet role (`master registry role set master ACCOUNTS …`; unconfigured, none), one session holding its registry slot until the loop ends it; the loop and `master start` adopt a live session named `masterAgentName`. Its first request is the master prompt plus a durable handover naming standing judgement work. It relaunches on exit (two missed readings; an unreadable inventory counts none), a limit notice (account held), or past `run.masterSessionMinutes` (default 240, deferred at most 30 minutes for an open item's merge); a failed registry end retries each cycle. Each cycle wakes it naming changed subjects; `run.masterHeartbeatMinutes` (default 30) of silence buys a heartbeat. Status: `daemon.master`.

## How a session starts

### The request is the session's first message

Never pasted ([authorization](onboarding.md#what-the-generated-instructions-authorize)).

#### How the request reaches the runtime

The launcher writes `.graphyard/launch/NAME.request` (and Claude's `NAME.role`), mode 0600, removed with the checkout, and types a line bounded at **512 bytes** whatever the request is:

```
GY=/path/to/checkout/.graphyard/launch/NAME; claude … --settings /path/to/repo/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

#### The start bound reads the pane

A runtime is ready when Herdr reports it active with no prompt or its banner shows (`the claude runtime is on screen while Herdr reports it unknown`): within **60 seconds** (`run.launchStartSeconds`), or **120 seconds** if still starting (`started.extended`). Otherwise it is refused with the case and the pane's last non-empty line, never Herdr's own `agent_not_found`: `the claude runtime never started within 60 s (command still echoing)`, `… was still starting after 120 s`, `… is blocked before it is ready`. One that exits to its shell fails at once (`… exited back to the shell … it last printed: …`), retried as `Automatic producer launch for GY-N refused 1 time(s)`. A failed launch stops its supervisor, closes its pane and releases its claim.

#### First-run consent prompts

A runtime stopped on a first-run prompt is **`awaiting consent`**. The launcher answers only `hooks-continue-untrusted` (**Continue without trusting**) and `telemetry-decline`, never one that grants hook execution or a sandbox escape; anything else, notably a **credential** or **payment** prompt, escalates. The worker is held in `.graphyard/launch/NAME.consent` (attach: `herdr pane attach`); after **15 minutes** its supervisor stops renewing and stops it, leaving the item dispatchable.

### Acknowledgement

A reviewer or producer is `awaiting acknowledgement` until 30 s active (`counts.dispatchAwaiting`), re-prompted once if quiet past `run.acknowledgementSeconds` (default 90); settling resultless makes it **`never started`**, relaunched free a minute later until three exhaust the request (`retry.neverStarted`).

### Resume and idle sessions

When a live attempt's blocker or scope request resolves, its inactive session is re-prompted once (item, epoch, change, `complete GY-N EPOCH PR`); blocking again that epoch ends attempt and blocker, and a fresh session, preferably another runtime, takes over. **Idle-with-lease** (30 quiet minutes, nothing open) is re-prompted once, then 30 minutes later handed to a new attempt on its branch. Pastes go to the **pane on the attempt's own session handle**, never a reusable agent name another session may hold; a gone pane hands the attempt on.

### Panes are closed and reclaimed

Ending a session (finished, failed, ended by the loop, an unkept lead) closes its handle's pane in the same step, recorded; research and triage run headless. A per-cycle backstop closes at most **6** panes a pass that Graphyard launched **on this host** (per its launchers' records) whose session ended or worktree is gone, once agentless past the launch bound (**120 s**), never one with an agent or a live-lease worktree. Each pass records the host's pane count and oldest agentless pane (`master status` `daemon.actions`); past **20** agentless panes it raises attention (`daemon.escalations`), recording the drain at zero.

### The dispatcher's own state

**The dispatcher bounds its own state where it composes it**, each cut marked with an ellipsis. **A cursor that fails its schema is repaired, not fatal**, logged once with the
path that failed. **A tick failure is attributed and surfaced** in `dispatch.lastFailure`. Three consecutive failures raise one attention item: no reviewer or producer session is being launched for any item. `graphyard master restart` repairs the cursor.

**A session that exits at launch is classified from its pane.** For a runtime that exits **at launch**, `herdr agent get` answers only `agent_not_found`, so the dispatcher reads `herdr pane read`: a **provider limit notice** fails over exactly as a mid-session exhaustion does; any other cause is refused with the pane's last words and retried.
