<!-- page: Operate Graphyard | 6 | profiles, accounts, launches. -->
# Master-agent sessions

## Launch profiles

`master worker add FILE` adds workers ([Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [Cursor](../examples/master/cursor-worker.json), [Muse](../examples/master/muse-worker.json)); `master reviewer setup` or `master reviewer add FILE` reviewers ([Claude](../examples/master/claude-reviewer.json), [opencode](../examples/master/opencode-reviewer.json)). `master producer replace`, `master producer remove`, `master reviewer remove` apply next tick; `setup.attention` reports blocking setup.

### Session handles

`master status` `sessions` lists handles.

### Approval modes

`"approvals": "auto"` adds: Claude Code `--permission-mode bypassPermissions`, `.claude.json` trust; Codex `--ask-for-approval never --sandbox workspace-write`, network, `--add-dir`; Cursor `--force --trust`, run and logged in as `agent` (not `cursor` or `cursor-agent`); opencode allow-all `OPENCODE_PERMISSION`; Gemini, Qwen `--yolo`; Copilot `--allow-all-tools --allow-all-paths`; Muse `--approval-mode never --trust-workspace`; Antigravity `agy` `--dangerously-skip-permissions`, `--prompt-interactive`; Pi none. `"prompt"`, `refusedLaunchKinds` and runtimes lacking command-line requests never start; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}` in arguments.

### The coordinator checkout is confined at the OS level

Every launch but the master session's gets the checkout unwritable to shell commands: Codex by `--sandbox workspace-write` while every grant on the checkout or `.git` stays in its worktree and admin directory; others by bubblewrap (checkout read-only, PIDs unshared, fresh `/proc`, session bus a keyring-only proxy), re-exposing only the session worktree or checkout, worktree-admin directories and shared Git areas (objects, remote refs, `FETCH_HEAD`). Refused with reason: missing bubblewrap, non-Linux, refused namespaces, confinement off, underivable checkout. Loop and executors never start, self-upgrade or restart on dirty checkouts.

## Accounts and failover

A profile's `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`) unless the [registry](onboarding.md#configure-the-fleet) defines the role. Launches take the first logged-in account under `run.quotaCeilingPercent`, else **fail over** (`dispatch.accounts`); so does a runtime failing to start (three in a row → one attention item). A runtime limit notice commits work as unpushed `WIP:`, sets `capacity.exhausted`, and relaunches on next account or after reset.

## The loop's own master session

Fleet role `master registry role set master ACCOUNTS …` (unconfigured, nothing launches), one session holding its registry slot until the loop ends it; loop and `master start` adopt a live `masterAgentName`. Starts on the master prompt plus durable handover of standing judgement work; relaunches on exit, a limit notice (account held), or past `run.masterSessionMinutes` (default 240; open merge defers ≤30 min). Changed subjects wake it; `run.masterHeartbeatMinutes` (default 30) of silence sends a heartbeat (`master status` `daemon.master`).

### The request is the session's first message

Never pasted ([authorization](onboarding.md#what-the-generated-instructions-authorize)).

#### How the request reaches the runtime

The launcher writes `.graphyard/launch/NAME.request` (and Claude's `NAME.role`), mode 0600, removed with the checkout, and types a line bounded at **512 bytes** whatever the request is:

```
GY=/path/to/checkout/.graphyard/launch/NAME; claude … --settings /path/to/repo/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

#### The start bound reads the pane

Herdr reporting the runtime active with no prompt, or its banner on screen, is **ready**. Ready within **60 seconds** (`run.launchStartSeconds`) starts; still starting gets **120 seconds** (`started.extended`); its supervisor prints `graphyard: establishing containment for GY-N epoch E` first. Otherwise the launch is refused quoting the pane's last line (`the claude runtime never started within 60 s (command still echoing)`), retried as `Automatic producer launch for GY-N refused 1 time(s)`, and its pane, supervisor and claim are released.

OpenCode 1.18 is ready at `Ask anything…`/`tab agents` ([fixture](../tests/fixtures/opencode-1.18-start-screen.txt)).

#### First-run consent prompts

On a first-run prompt: **`awaiting consent`**; the launcher answers only `hooks-continue-untrusted` (**Continue without trusting**) and `telemetry-decline`, never one that grants hook execution or a sandbox escape; anything else (e.g. **credential**, **payment**) escalates. Held workers: `.graphyard/launch/NAME.consent` (`herdr pane attach`); after **15 minutes** the supervisor stops renewing and stops it; the item is dispatchable.

### Acknowledgement, resume and idle sessions

Reviewers and producers are `awaiting acknowledgement` until 30 s active (`counts.dispatchAwaiting`), re-prompted once if quiet past `run.acknowledgementSeconds` (default 90); settling resultless is **`never started`**: relaunched free a minute later, three at most (`retry.neverStarted`).

A resolved blocker or scope request re-prompts the inactive session once (item, epoch, change, `complete GY-N EPOCH PR`); re-blocking that epoch ends attempt and blocker for a fresh session. **Idle-with-lease** (30 quiet minutes, nothing open): re-prompted once, after 30 more handed to a new attempt on its branch.

Headless Pi runs (`.graphyard/runs/`, systemd-scoped) survive restarts; lost ones retry free.

### Panes are closed and reclaimed

Ending a session closes its pane; each cycle closes ≤**6** more launched **on this host** with session or worktree gone, agentless past **120 s**, never one with an agent or live-leased worktree; over **20** agentless → attention (`daemon.escalations`).

### The dispatcher's own state

The dispatcher bounds the state it composes (cuts end in an ellipsis) and repairs a schema-failing cursor, logging the path once. `dispatch.lastFailure` names a tick failure; three in a row raise one attention item, and `graphyard master restart` repairs the cursor. A session exiting at launch is classified by `herdr pane read`: a provider limit notice fails over like mid-session exhaustion; anything else is refused with the pane's last words and retried.
