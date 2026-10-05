<!-- page: Operate Graphyard | 6 | profiles, accounts, launches. -->
# Master-agent sessions

## Launch profiles

Add a worker with `master worker add FILE` ([Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [Cursor](../examples/master/cursor-worker.json), [Muse](../examples/master/muse-worker.json)).

Add reviewers with `master reviewer setup` and `master reviewer add FILE` ([Claude](../examples/master/claude-reviewer.json), [opencode](../examples/master/opencode-reviewer.json)).

`master producer replace`, `master producer remove` and `master reviewer remove` apply next tick; `setup.attention` reports blocking setup.

### Session handles

`master status` `sessions` lists handles (runtime, host, pane, transcript, attach).

### Approval modes

Sessions run in no-approval mode (`"approvals": "auto"`): `--permission-mode bypassPermissions`, `.claude.json` trust (Claude Code); `--ask-for-approval never --sandbox workspace-write`, network, `--add-dir` (Codex); `--force --trust` (Cursor, started and logged in as `agent`: `cursor` is the IDE launcher and `cursor-agent` refuses interactive runs); allow-all `OPENCODE_PERMISSION` (opencode); `--yolo` (Gemini, Qwen); `--allow-all-tools --allow-all-paths` (Copilot); `--approval-mode never --trust-workspace` (Muse); `--dangerously-skip-permissions`, `trustedWorkspaces` trust, `--prompt-interactive` (Antigravity `agy`); none (Pi). `"prompt"`, `refusedLaunchKinds` and runtimes lacking command-line requests never start; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}` in their arguments.

### The coordinator checkout is confined at the OS level

Every launch runs with the checkout unwritable to shell commands (GY-888). A codex `--sandbox workspace-write` confines only while every grant touching the checkout or its `.git` stays in the session's worktree and admin directory; wider grants give up the claim. Every other launch runs under bubblewrap: the checkout mounted read-only, PIDs unshared, `/proc` fresh, channels hidden (systemd, `/run/dbus`; the session bus is a [keyring-only proxy](operations.md#worker-host-keyring-proxy)), only the session's worktree or checkout and worktree-admin directories re-exposed beside the shared Git areas (objects, `graphyard/` branches, remote refs, `FETCH_HEAD`), each masked at its canonical path. A launch unable to apply it (no bubblewrap, non-Linux, refused namespaces, confinement off, underivable checkout) is refused. The master session is exempt; every other session starts in its own checkout. The loop and executors never start, self-upgrade or restart on a dirty or moved checkout ([details](master-agent.md#operate)).

## Accounts and failover

A profile's `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`) unless the [agent registry](onboarding.md#configure-the-fleet) defines the role. A launch takes the first logged-in account under `run.quotaCeilingPercent`, else **fails over** (`dispatch.accounts`).

A runtime failing to start fails over too, named in `master status` (`opencode-a failed to start: …; launched on claude-b`); three in a row raise an attention item until a start.

On a runtime's limit notice (never agent text), even mid-retry, the loop commits work as unpushed `WIP:`, records `capacity.exhausted`, relaunches on another account or awaits reset.

## The loop's own master session

The loop launches the master session as a fleet role (`master registry role set master ACCOUNTS …`) pinned to one session, holding its registry slot until the loop ends it; unconfigured, nothing launches. Either path (`master start` too) adopts a live session named `masterAgentName`. Its first request is the master prompt plus a durable handover naming standing judgement work. It relaunches on exit (two missed readings; an unreadable inventory is none), a limit notice (account held), or past `run.masterSessionMinutes` (default 240), deferred at most 30 minutes for an open item's merge. A failed registry end is retried each cycle. Each cycle wakes it naming changed subjects; `run.masterHeartbeatMinutes` (default 30) of silence buys one heartbeat. `master status` shows `daemon.master`.

## How a session starts

### The request is the session's first message

Never pasted ([authorization](onboarding.md#what-the-generated-instructions-authorize)).

#### How the request reaches the runtime

The launcher writes `.graphyard/launch/NAME.request` (and Claude's `NAME.role`), mode 0600, removed with the checkout, and types:

```
GY=/path/to/checkout/.graphyard/launch/NAME; claude … --settings /path/to/repo/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

The typed line is bounded at **512 bytes** whatever the request is.

#### The start bound reads the pane

The runtime is **ready** when Herdr reports it active with no prompt or its banner shows (`the claude runtime is on screen while Herdr reports it unknown`). Ready within **60 seconds** (`run.launchStartSeconds`) starts; one still starting gets **120 seconds** (`started.extended`). A launch command holding the foreground is starting: its supervisor prints `graphyard: establishing containment for GY-N epoch E` before any control-plane call. It is refused with the case and the pane's last non-empty line, never Herdr's own `agent_not_found`: `the claude runtime never started within 60 s (command still echoing)`, `… was still starting after 120 s`, `… is blocked before it is ready`. A runtime that printed below its command and returned the pane to its shell fails at once, quoting its last lines; retried as `Automatic producer launch for GY-N refused 1 time(s)`. A failed launch stops its supervisor, closes its pane, releases its claim.

OpenCode 1.18 is ready at `Ask anything…`/`tab agents` ([fixture](../tests/fixtures/opencode-1.18-start-screen.txt)).

#### First-run consent prompts

A runtime stopped on a first-run prompt is **`awaiting consent`**. The launcher answers only `hooks-continue-untrusted` (**Continue without trusting**) and `telemetry-decline`, never one that grants hook execution or a sandbox escape; everything else, above all a **credential** or **payment** prompt, is escalated. Workspace-trust prompts fail the launch, unheld. A worker is held in `.graphyard/launch/NAME.consent` (`herdr pane attach`); after **15 minutes** its supervisor stops renewing and stops it; the item is dispatchable again.

### Acknowledgement, the one re-prompt, and never started

A reviewer or producer is `awaiting acknowledgement` until 30 s active (`counts.dispatchAwaiting`); quiet past `run.acknowledgementSeconds` (default 90) it is re-prompted once; settling resultless makes it **`never started`**, relaunched free a minute later, three at most (`retry.neverStarted`), [then elsewhere](master-agent-reference.md#producer-runtime-faults).

### Resume, idle-with-lease and exited sessions

When a live attempt's blocker or scope request resolves, its idle session is re-prompted once (item, epoch, change, `complete GY-N EPOCH PR`); blocking again ends the attempt and a fresh session, preferably another runtime, takes over. **Idle-with-lease** (30 quiet minutes, nothing open) is re-prompted once, then after 30 more handed to a new attempt on its branch.

Headless Pi runs (`.graphyard/runs/`, systemd-scoped) survive restarts and are re-adopted; lost ones retry free (approvers thrice per decision). Only Pi is confined; triage and diagnosis runs end with the loop.

Every paste goes to the **pane on the attempt's own session handle**, never the profile's reusable agent name another session may hold (GY-852); a gone pane hands the attempt on.

### Panes are closed and reclaimed

Every launch records its pane on the item's session handle; ending that session closes the pane in the same step. Research and triage run headless. A per-cycle sweep closes panes Graphyard launched **on this host** whose session ended or worktree is gone, once agentless past **120 s**, at most **6** a pass — never a pane Graphyard did not launch, with an agent, or whose worktree holds a live lease. Each pass records the pane count (`daemon.actions`), raising attention past **20** agentless panes (`daemon.escalations`).

### The dispatcher's own state

- **The dispatcher bounds its own state where it composes it**, each cut marked with an ellipsis.
- **A cursor that fails its schema is repaired, not fatal**, logged once with the path that failed.
- **A tick failure is attributed and surfaced.** `dispatch.lastFailure` names it. Three consecutive failures raise one attention item: no reviewer or producer session is being launched for any item. `graphyard master restart` repairs the cursor.

**A session that exits at launch is classified from its pane.** `herdr agent get` answers only `agent_not_found` for a runtime that exits **at launch**, so the dispatcher uses `herdr pane read`: a **provider limit notice** fails over exactly as a mid-session exhaustion does; any other cause is refused with the pane's last words and retried.
