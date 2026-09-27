<!-- page: Operate Graphyard | 6 | profiles, accounts, launches. -->
# Master-agent sessions

## Launch profiles

Add a worker with `master worker add FILE` from a template ([Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [Cursor](../examples/master/cursor-worker.json), [Muse](../examples/master/muse-worker.json)); tokens stay outside every worktree.

Add reviewers with `master reviewer setup` and `master reviewer add FILE` ([Claude](../examples/master/claude-reviewer.json), [opencode](../examples/master/opencode-reviewer.json)).

`master producer replace|remove FILE|NAME` and `master reviewer remove NAME` apply next tick; `setup.attention` reports launch-stopping setup.

### Session handles

`master status` `sessions` lists handles (runtime, host, pane, transcript, attach command).

### Approval modes

Sessions run in no-approval mode (`"approvals": "auto"`): `--permission-mode bypassPermissions`, `.claude.json` trust (Claude Code); `--ask-for-approval never --sandbox workspace-write`, network, `--add-dir` (Codex); `--force --trust` (Cursor); allow-all `OPENCODE_PERMISSION` (opencode); `--yolo` (Gemini, Qwen); `--allow-all-tools --allow-all-paths` (Copilot); `--approval-mode never --trust-workspace` (Muse); none (Pi). `"prompt"`, `refusedLaunchKinds` and runtimes lacking command-line requests never start; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}` in their arguments. Codex's sandbox gets `.git/worktrees/GY-N-E` and shared `.git` via `--add-dir`, probed first.

### Workers are write-confined to their worktree

A worker writes only its assigned worktree and its Git directories (GY-857): codex keeps `--sandbox workspace-write`; an opencode profile sets `OPENCODE_PERMISSION` `"external_directory":"deny"`; Claude worker rules deny `Edit`/`Write` of the coordinator checkout; a profile turning confinement off is refused at launch. Neither the loop nor an executor starts, self-upgrades or restarts from a checkout holding uncommitted work; the escalation names the dirty paths and the live leases they match.

## Accounts and failover

A profile's `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`) in order, unless the [agent registry](onboarding.md#configure-the-fleet) defines the role. A launch takes the first logged-in account under `run.quotaCeilingPercent`, else **fails over** (`dispatch.accounts`).

On a mid-session limit notice the loop commits worker changes as unpushed `WIP:`, records `capacity.exhausted` (not `lease-loss`), then relaunches on the next account or waits for the first reset.

## How a session starts

### The request is the session's first message

Every instruction is the session's first command-line request, never pasted ([authorization](onboarding.md#what-the-generated-instructions-authorize)).

#### How the request reaches the runtime

The launcher writes `.graphyard/launch/NAME.request` (and a Claude session's `NAME.role`), mode 0600, removed with the checkout, then types:

```
GY=/path/to/checkout/.graphyard/launch/NAME; claude --permission-mode bypassPermissions --setting-sources user --settings /path/to/repo/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

The typed line is bounded at **512 bytes** whatever the request is.

#### The start bound reads the pane

The runtime is **ready** when Herdr reports it active with no prompt, or its banner shows. Ready within **60 seconds** (`run.launchStartSeconds`) is started; one still starting gets **120 seconds** (`started.extended`). Otherwise it is refused with the case and the pane's last non-empty line, never Herdr's own `agent_not_found`; retried as `Automatic producer launch for GY-N refused 1 time(s): …`. A failed launch stops its supervisor, closes its pane, releases its claim.

#### First-run consent prompts

A runtime stopped on a first-run prompt is **`awaiting consent`**. The launcher answers only `hooks-continue-untrusted` (**Continue without trusting**) and `telemetry-decline`, with the least-privilege option, never one that grants hook execution or a sandbox escape; everything else, above all a **credential** or **payment** prompt, is escalated. A worker is held in `.graphyard/launch/NAME.consent`; after **15 minutes** the supervisor stops renewing and stops the session, so the item is dispatchable again.

### Acknowledgement, the one re-prompt, and never started

A reviewer or producer is `awaiting acknowledgement` until 30 s of activity (`counts.dispatchAwaiting`). Quiet after `run.acknowledgementSeconds` (default 90), it is re-prompted once; settling resultless makes it **`never started`**, relaunched a minute later without retry cost. Three exhaust the request (`retry.neverStarted`).

### Resume, idle-with-lease and exited sessions

When a live attempt's blocker or scope request resolves, its inactive session is re-prompted once (item, epoch, change, `complete GY-N EPOCH PR`), recorded on its handle. **Idle-with-lease** (30 quiet minutes, nothing open) shows on its handle with the pane, re-prompted once, then after 30 more handed to a new attempt on its branch. Sessions with an agentless pane, or whose item left build, close with a reason.

### Panes are closed and reclaimed

Every launch records its pane on the item's session handle; when the loop ends that session — finished, failed, ended by the loop, or a lead it cannot keep — it closes the pane in the same step and records the close. Research and triage runs are headless and open no pane. A per-cycle sweep is the backstop: it closes agentless panes Graphyard launched **on this host** (by recorded pane id, matched only against the handles this host's launchers recorded) whose session has ended or whose worktree no longer exists, once they have stood agentless past the launch bound (**120 s**; a runtime that has not started yet looks the same), at most **6** per pass. It never touches a pane Graphyard did not launch, a pane with an agent in it, or a pane whose worktree holds a live lease. Each pass records the host's pane count, the agentless Graphyard panes and the oldest on the loop cursor (`master status` `daemon.actions`), and raises attention there once agentless panes exceed **20** (`daemon.escalations`). A host that once held a backlog records the drain when the count reaches zero, instead of leaving a stale backlog and oldest pane on the cursor.

### The dispatcher's own state

- **The dispatcher bounds its own state where it composes it**, each cut marked with an ellipsis.
- **A cursor that fails its schema is repaired, not fatal**; the repair is logged once with the
  path that failed.
- **A tick failure is attributed and surfaced.** `dispatch.lastFailure` names it. Three consecutive failures raise one attention item: no reviewer or producer session is being launched for any item. `graphyard master restart` repairs the cursor.

**A session that exits at launch is classified from its pane.** `herdr agent get` answers only `agent_not_found` for a runtime that exits **at launch**, so the dispatcher uses `herdr pane read`: a **provider limit notice** fails over exactly as a mid-session exhaustion does; any other cause is refused with the pane's last words and retried.
