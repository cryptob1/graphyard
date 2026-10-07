<!-- page: Operate Graphyard | 6 | profiles, launches. -->
# Master-agent sessions

## Launch profiles

`master worker add FILE`: workers ([template](../examples/master/claude-worker.json)); `master reviewer setup` or `master reviewer add FILE` reviewers ([Claude](../examples/master/claude-reviewer.json), [opencode](../examples/master/opencode-reviewer.json)); `master producer replace`, `master producer remove`, `master reviewer remove` apply next tick; `setup.attention` reports blocking setup.

### Session handles

`master status` `sessions`.

### Approval modes

`"approvals": "auto"` adds: Claude Code `--permission-mode bypassPermissions`, `.claude.json` trust; Codex `--ask-for-approval never --sandbox workspace-write`, network, `--add-dir`, `config.toml` `[projects."DIR"] trust_level = "trusted"`; Cursor `--force --trust`, runs/logs in as `agent` (not `cursor`/`cursor-agent`); opencode allow-all `OPENCODE_PERMISSION`; Gemini, Qwen `--yolo`; Copilot `--allow-all-tools --allow-all-paths`; Muse `--approval-mode never --trust-workspace`; Antigravity `agy` `--dangerously-skip-permissions`, `trustedWorkspaces`, `--prompt-interactive`; Pi none. Never started: `"prompt"`, `refusedLaunchKinds`, runtimes without command-line requests; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}` in arguments.

### The coordinator checkout is confined at the OS level

Non-master launches get own checkouts, coordinator's unwritable (Codex `--sandbox workspace-write`, others bubblewrap, session bus a [keyring-only proxy](operations.md#worker-host-keyring-proxy)); unconfinable ones are refused; the loop refuses dirty/moved checkouts ([details](master-agent.md#operate)).

#### Worker sandbox

Codex `--add-dir` roots: `.git/worktrees/NAME` (index, HEAD, `FETCH_HEAD`), `objects`, `refs/remotes`, `refs/heads/graphyard`, `logs/`; never `.git` (its read-only `.git/.git` mount kills every command). A failed (bubblewrap) write probe fails the launch, naming the path.

Profile `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`) unless the registry defines role. Launches take the first account under `run.quotaCeilingPercent`, else (or failed start) **fail over** (`dispatch.accounts`). A runtime limit notice (never agent text; mid-session only beside `[retrying in 4s]`; agy `Individual quota reached`) commits unpushed `WIP:`, sets `capacity.exhausted`, relaunches elsewhere/after reset. Reviewers/producers use only their profile's `kind` (others skipped `cross-runtime`; profile waits).

## The loop's own master session

`master registry role set master ACCOUNTS …` (unset: none): one session; loop and `master start` adopt live `masterAgentName`. Starts on master prompt plus standing-judgement handover; relaunches on exit, limit notice, `run.masterSessionMinutes` (240); changed subjects wake it; `run.masterHeartbeatMinutes` (30) silent sends heartbeat (`daemon.master`).

### The request is the session's first message

Never pasted ([authorization](onboarding.md#what-the-generated-instructions-authorize)).

#### How the request reaches the runtime

Written to `.graphyard/launch/NAME.request` (Claude also `NAME.role`), mode 0600, removed with the checkout; the typed line is bounded at **512 bytes** whatever the request is:

```
GY=…/.graphyard/launch/NAME; claude … --settings …/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

#### The start bound reads the pane

**Ready**: Herdr active with no prompt, or banner shown (`the claude runtime is on screen while Herdr reports it unknown`; OpenCode 1.18 `Ask anything…`/`tab agents`, [fixture](../tests/fixtures/opencode-1.18-start-screen.txt)). Ready within **60 seconds** (`run.launchStartSeconds`) starts; still starting gets **120 seconds** (`started.extended`); supervisor first prints `graphyard: establishing containment for GY-N epoch E`. Refusals quote case and the pane's last non-empty line, never Herdr's own `agent_not_found` (`the claude runtime never started within 60 s (command still echoing)`, `… was still starting after 120 s`, `… is blocked before it is ready`), retry as `Automatic producer launch for GY-N refused 1 time(s)`, releasing pane, supervisor, claim.

#### First-run consent prompts

**`awaiting consent`**: answers only `hooks-continue-untrusted` (**Continue without trusting**), `telemetry-decline`, never one that grants hook execution or a sandbox escape; others (**credential**, **payment**) escalate; workspace-trust prompts fail launch. Trust records reread before start; dropped refuses, naming the config. Held: `.graphyard/launch/NAME.consent` (`herdr pane attach`); after **15 minutes** the supervisor stops renewing, stopping it, item dispatchable.

Reviewers/producers are `awaiting acknowledgement` until 30 s active (`counts.dispatchAwaiting`), re-prompted once quiet past `run.acknowledgementSeconds` (90); settling resultless is **`never started`**: relaunched minute later, ≤3 (`retry.neverStarted`), [then elsewhere](master-agent-reference.md#producer-runtime-faults).

**Idle-with-lease** (25 quiet minutes, nothing open): one re-prompt; quiet 45 min after first idle, 10 after re-prompt (brief replies don't count): new attempt on its branch <60 min from last activity. **Blocked** (Herdr `blocked`; pane read by agent name, then id): destructive-command prompts declined; folder-trust dialog relaunches, recording trust; others fail after **5 min**; unreadable screens aren't timed. Headless Pi runs (`.graphyard/runs/`) survive restarts.

### Panes are closed and reclaimed

Ended sessions' panes close; each cycle closes ≤12 more, never a live lease's: agentless shells in `.graphyard/worktrees` after **120 s** (never elsewhere), agents named for ended sessions after **60 s**. Over 20 agentless: `daemon.escalations` attention.

### The dispatcher's own state

The dispatcher bounds its own state where it composes it, each cut marked with an ellipsis; cursor failing its schema is repaired, not fatal, logged once with the path that failed. A tick failure is attributed and surfaced (`dispatch.lastFailure`). Three consecutive failures raise one attention item: no reviewer or producer session is being launched for any item; `graphyard master restart` repairs cursor. A session that exits at launch is classified from its pane: `herdr agent get` answers only `agent_not_found` for one that exits **at launch**, so the dispatcher uses `herdr pane read`; **provider limit notice** fails over exactly as a mid-session exhaustion does, others are refused with the pane's last words and retried.
