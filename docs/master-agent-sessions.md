<!-- page: Operate Graphyard | 6 | profiles, accounts, launches. -->
# Master-agent sessions

## Launch profiles

Add a worker with `master worker add FILE` from a template ([Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [Cursor](../examples/master/cursor-worker.json), [Muse](../examples/master/muse-worker.json)); its token stays outside every worktree.

Add reviewers with `master reviewer setup` and `master reviewer add FILE` ([Claude](../examples/master/claude-reviewer.json), [opencode](../examples/master/opencode-reviewer.json)); `master review GY-N [PROFILE]` relaunches a refused one.

`master producer replace FILE`, `master producer remove NAME` and `master reviewer remove NAME` apply next tick; `setup.attention` reports launch-stopping setup.

### Session handles

`master status` `sessions` lists each handle (runtime, host, pane, transcript, attach command).

### Approval modes

Sessions run in no-approval mode (`"approvals": "auto"`): `--permission-mode bypassPermissions`, `.claude.json` trust (Claude Code); `--ask-for-approval never --sandbox workspace-write`, network, `--add-dir` (Codex); `--force --trust` (Cursor); allow-all `OPENCODE_PERMISSION` (opencode); `--yolo` (Gemini, Qwen); `--allow-all-tools --allow-all-paths` (Copilot); `--approval-mode never --trust-workspace` (Muse); none (Pi). `"prompt"`, `refusedLaunchKinds` and runtimes without command-line requests never start; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}` in their arguments. Codex's sandbox gets `.git/worktrees/GY-N-E` and shared `.git` via `--add-dir`, probed first (`Worker launch failed: the codex sandbox cannot write PATH`).

## Accounts and failover

A profile's `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`), in order, unless the [agent registry](onboarding.md#configure-the-fleet) defines the role. A launch takes the first logged-in account under `run.quotaCeilingPercent`, else **fails over** to the next (`dispatch.accounts`).

On a mid-session limit notice the loop commits worker changes as unpushed `WIP:`, records `capacity.exhausted` (not `lease-loss`) and relaunches on the next account or after the first reset.

## How a session starts

### The request is the session's first message

Every instruction is the session's first command-line request, never pasted ([authorization](onboarding.md#what-the-generated-instructions-authorize)).

#### How the request reaches the runtime

The launcher writes `.graphyard/launch/NAME.request` (and a Claude session's `NAME.role`), mode 0600, removed with the checkout, then types:

```
GY=/path/to/checkout/.graphyard/launch/NAME; claude --permission-mode bypassPermissions --setting-sources user --settings /path/to/repo/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

The typed line is at most **512 bytes**.

#### The start bound reads the pane

The runtime is **ready** when Herdr reports it active with no prompt, or its banner shows (`the claude runtime is on screen while Herdr reports it unknown`). Ready within **60 seconds** (`run.launchStartSeconds`) is started; one still starting gets **120 seconds** (`started.extended`). Otherwise it is refused naming the case and the pane's last non-empty line, not Herdr's `agent_not_found`: `the claude runtime never started within 60 s in pane w1V:pR6 (command still echoing)`, `… was still starting after 120 s` or `… is blocked before it is ready`; retried as `Automatic producer launch for GY-N refused 1 time(s): …`. A failed launch stops its supervisor, pane and claim.

#### First-run consent prompts

A runtime stopped on a first-run prompt is **`awaiting consent`**. The launcher answers only `hooks-continue-untrusted` (**Continue without trusting**) and `telemetry-decline`, with the least-privilege option, never one that grants hook execution or a sandbox escape; anything else (a **credential** or **payment** prompt above all) is escalated. A worker is held in `.graphyard/launch/NAME.consent` (attach: `herdr pane attach`); after **15 minutes** its supervisor stops it and the item is dispatchable again.

### Acknowledgement, the one re-prompt, and never started

A reviewer or producer is `awaiting acknowledgement` until 30 s of activity (`counts.dispatchAwaiting`). Quiet after `run.acknowledgementSeconds` (default 90), it is re-prompted once; settling resultless, it is **`never started`** and relaunched a minute later at no retry cost. Three exhaust the request (`retry.neverStarted`).

### Resume, idle-with-lease and exited sessions

When a live attempt's blocker or scope request resolves, its inactive session is re-prompted once (item, epoch, change, `complete GY-N EPOCH PR`), recorded on its handle. **Idle-with-lease** (30 quiet minutes, nothing open) shows on its handle, is re-prompted once, and after 30 more goes to a new attempt on its branch. Sessions with an agentless pane, or whose item left build, close with a reason.

### Lost runs and spent producer requests

A producer run killed before a verdict (exit 143/137, vanished session, dead `launcherPid`) settles `lost:`, relaunches next tick and counts in `retry.lost`; `retry.started` counts failing, unexercised, empty or timed-out runs. 12 sessions per request bound both.

Spent attempts raise `escalation:proof-exhausted` (group, each attempt, next owner); a cycle later the loop requests one **rework** per head quoting them. An unrequestable `--proof-workflow` escalates too.

### The dispatcher's own state

- **The dispatcher bounds its own state where it composes it**, each cut marked with an ellipsis.
- **A cursor that fails its schema is repaired, not fatal**, logged once with the failing path.
- **A tick failure is attributed and surfaced.** `dispatch.lastFailure` names it. Three consecutive failures raise one attention item: no reviewer or producer is launching. `graphyard master restart` repairs the cursor.

**A session that exits at launch is classified from its pane.** `herdr agent get` only answers `agent_not_found` for it, so the dispatcher reads the pane: a **provider limit notice** fails over like a mid-session exhaustion; any other cause is refused with the pane's last words and retried.
