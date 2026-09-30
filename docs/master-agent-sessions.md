<!-- page: Operate Graphyard | 6 | profiles, accounts, launches. -->
# Master-agent sessions

## Launch profiles

Add a worker with `master worker add FILE` ([Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [Cursor](../examples/master/cursor-worker.json), [Muse](../examples/master/muse-worker.json)).

Add reviewers with `master reviewer setup` and `master reviewer add FILE` ([Claude](../examples/master/claude-reviewer.json), [opencode](../examples/master/opencode-reviewer.json)).

`master producer replace`, `master producer remove` and `master reviewer remove` apply next tick; `setup.attention` reports launch-stopping setup.

### Session handles

`master status` `sessions` lists handles (runtime, host, pane, transcript, attach).

### Approval modes

Sessions run in no-approval mode (`"approvals": "auto"`): `--permission-mode bypassPermissions`, `.claude.json` trust (Claude Code); `--ask-for-approval never --sandbox workspace-write`, network, `--add-dir` (Codex); `--force --trust` (Cursor); allow-all `OPENCODE_PERMISSION` (opencode); `--yolo` (Gemini, Qwen); `--allow-all-tools --allow-all-paths` (Copilot); `--approval-mode never --trust-workspace` (Muse); none (Pi). `"prompt"`, `refusedLaunchKinds` and runtimes lacking command-line requests never start; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}` in their arguments.

### The coordinator checkout is confined at the OS level

Every launch runs with the checkout unwritable to shell commands (GY-888). A codex `--sandbox workspace-write` confines only while every grant touching the checkout or its `.git` stays in the session's worktree and admin directory; wider grants give up the claim. Every other launch runs under bubblewrap: the checkout mounted read-only, PIDs unshared, `/proc` fresh, channels hidden (session bus, systemd, `/run/dbus`), only the session's directory (the assigned worktree, or the checkout a reviewer or producer gets beside the root it starts from) and worktree-admin directories re-exposed beside the shared Git areas (objects, `graphyard/` branches, remote refs, `FETCH_HEAD`), each masked at its canonical path. A launch unable to apply it (bubblewrap missing, non-Linux, refused namespaces, confinement off, an underivable checkout) is refused with the reason. The master session is exempt. The loop and executors never start, self-upgrade or restart on a dirty checkout; escalation names the paths and their leases.

## Accounts and failover

A profile's `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`) unless the [agent registry](onboarding.md#configure-the-fleet) defines the role. A launch takes the first logged-in account under `run.quotaCeilingPercent`, else **fails over** (`dispatch.accounts`).

On a runtime's own limit notice (never agent text) the loop commits worker changes as unpushed `WIP:`, records `capacity.exhausted` (not `lease-loss`), relaunches on the next account or awaits reset.

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

The runtime is **ready** when Herdr reports it active with no prompt or its banner shows (`the claude runtime is on screen while Herdr reports it unknown`). Ready within **60 seconds** (`run.launchStartSeconds`) starts; one still starting gets **120 seconds** (`started.extended`). It is refused with the case and the pane's last non-empty line, never Herdr's own `agent_not_found`: `the claude runtime never started within 60 s (command still echoing)`, `… was still starting after 120 s`, `… is blocked before it is ready`; retried as `Automatic producer launch for GY-N refused 1 time(s)`. A failed launch stops its supervisor, closes its pane, releases its claim.

#### First-run consent prompts

A runtime stopped on a first-run prompt is **`awaiting consent`**. The launcher answers only `hooks-continue-untrusted` (**Continue without trusting**) and `telemetry-decline` — the least-privilege options, never one that grants hook execution or a sandbox escape; everything else, above all a **credential** or **payment** prompt, is escalated. A worker is held in `.graphyard/launch/NAME.consent` (attach: `herdr pane attach`); after **15 minutes** its supervisor stops renewing and stops it; the item is dispatchable again.

### Acknowledgement, the one re-prompt, and never started

A reviewer or producer is `awaiting acknowledgement` until 30 s active (`counts.dispatchAwaiting`); quiet past `run.acknowledgementSeconds` (default 90) it is re-prompted once; settling resultless makes it **`never started`**, relaunched cost-free a minute later until three exhaust the request (`retry.neverStarted`).

### Resume, idle-with-lease and exited sessions

When a live attempt's blocker or scope request resolves, its inactive session is re-prompted once (item, epoch, change, `complete GY-N EPOCH PR`); blocking again on that epoch ends the attempt and its blocker; a fresh session, preferably another runtime, takes over. **Idle-with-lease** (30 quiet minutes, nothing open) is re-prompted once, then after 30 more handed to a new attempt on its branch.

Every paste goes to the **pane on the attempt's own session handle**, never the profile's reusable agent name another session may hold (GY-852); a gone pane hands the attempt on.

### Panes are closed and reclaimed

Every launch records its pane on the item's session handle; when the loop ends that session — finished, failed, ended by the loop, a lead it cannot keep — it closes the pane in the same step and records the close. Research and triage run headless, opening no pane. A per-cycle sweep on **this host** is the backstop, closing at most **10** a pass (300 drain within an hour): once agentless past the launch bound (**120 s**), a recorded pane whose session ended or worktree is gone, and any pane in a Graphyard worktree (`.graphyard/worktrees/GY-N-EPOCH`) whatever its record says; after a **60 s** grace, an agent pane whose Herdr name equals the name its ended session recorded. Never a pane whose exact item and epoch holds a live lease, nor an unrecorded pane outside the worktrees. Each pass records the host's pane count and oldest agentless pane (`master status` `daemon.actions`), raising attention once agentless panes exceed **20** (`daemon.escalations`) and recording the drain at zero.

### The dispatcher's own state

- **The dispatcher bounds its own state where it composes it**, each cut marked with an ellipsis.
- **A cursor that fails its schema is repaired, not fatal**; the repair is logged once with the
  path that failed.
- **A tick failure is attributed and surfaced.** `dispatch.lastFailure` names it. Three consecutive failures raise one attention item: no reviewer or producer session is being launched for any item. `graphyard master restart` repairs the cursor.

**A session that exits at launch is classified from its pane.** `herdr agent get` answers only `agent_not_found` for a runtime that exits **at launch**, so the dispatcher uses `herdr pane read`: a **provider limit notice** fails over exactly as a mid-session exhaustion does; any other cause is refused with the pane's last words and retried.
