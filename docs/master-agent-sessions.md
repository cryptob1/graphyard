<!-- page: Operate Graphyard | 6 | profiles, launches. -->
# Master-agent sessions

## Launch profiles

`master worker add FILE`: workers ([template](../examples/master/claude-worker.json)); `master reviewer setup` or `master reviewer add FILE` reviewers ([Claude](../examples/master/claude-reviewer.json), [opencode](../examples/master/opencode-reviewer.json)); `master producer replace`, `master producer remove`, `master reviewer remove` apply next tick; `setup.attention` reports blocking setup.

### Session handles

`master status` `sessions`.

### Approval modes

`"approvals": "auto"` adds: Claude Code `--permission-mode bypassPermissions`, `.claude.json` trust; Codex `--ask-for-approval never --sandbox workspace-write`, network, `--add-dir`, `config.toml` `[projects."DIR"] trust_level = "trusted"`; Cursor `--force --trust` (binary `agent`); opencode allow-all `OPENCODE_PERMISSION`; Gemini, Qwen `--yolo`; Copilot `--allow-all-tools --allow-all-paths`; Muse `--approval-mode never --trust-workspace`; Antigravity `agy` `--dangerously-skip-permissions`, `trustedWorkspaces`, `--prompt-interactive`; Pi none. Never started: `"prompt"`, `refusedLaunchKinds`, runtimes without command-line requests; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}` in arguments.

### The coordinator checkout is confined at the OS level

Non-master launches get own checkouts, coordinator's unwritable (Codex `--sandbox workspace-write`, others bubblewrap, session bus a [keyring-only proxy](operations.md#worker-host-keyring-proxy)); unconfinable refused; loop refuses dirty/moved checkouts ([details](master-agent.md#operate)).

#### Worker sandbox

Codex `--add-dir` roots: `.git/worktrees/NAME` (index, HEAD, `FETCH_HEAD`), `objects`, `refs/remotes`, `refs/heads/graphyard`, `logs/`; never `.git` (read-only `.git/.git` mount kills every command). Failed bubblewrap write probes fail the launch. Reviewer and producer launches get the same Git grants and probe, plus `.git/worktrees`, and fetch with `--no-write-fetch-head`.

Profile `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`) unless registry defines role. Launches take first account under `run.quotaCeilingPercent`, else (or failed start) **fail over** (`dispatch.accounts`). Runtime limit notices (never agent text; mid-session only beside `[retrying in 4s]`; agy `Individual quota reached`) commit unpushed `WIP:`, set `capacity.exhausted`, relaunch elsewhere/after reset. Reviewers/producers use only profile `kind` (others skipped `cross-runtime`; profile waits).

## The loop's own master session

`master registry role set master ACCOUNTS …` (unset: none): one session; loop and `master start` adopt live `masterAgentName`. Relaunches on exit, limit notice, `run.masterSessionMinutes` (240); changed subjects wake it; `run.masterHeartbeatMinutes` (30) silent sends heartbeat (`daemon.master`).

### The request is the session's first message

Never pasted ([authorization](onboarding.md#what-the-generated-instructions-authorize)).

#### How the request reaches the runtime

Written to `.graphyard/launch/NAME.request` (Claude also `NAME.role`), mode 0600, removed with the checkout; typed line is bounded at **512 bytes** whatever the request is:

```
GY=…/.graphyard/launch/NAME; claude … --settings …/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

#### The start bound reads the pane

**Ready**: Herdr active with no prompt, or banner shown (`the claude runtime is on screen while Herdr reports it unknown`; OpenCode 1.18 `Ask anything…`/`tab agents`, [fixture](../tests/fixtures/opencode-1.18-start-screen.txt)). Ready within **60 seconds** (`run.launchStartSeconds`) starts; still starting gets **120 seconds** (`started.extended`); supervisor first prints `graphyard: establishing containment for GY-N epoch E`. Refusals quote case and pane's last non-empty line, never Herdr's own `agent_not_found` (`the claude runtime never started within 60 s (command still echoing)`, `… was still starting after 120 s`, `… is blocked before it is ready`), retried (`Automatic producer launch for GY-N refused 1 time(s)`).

#### First-run consent prompts

**`awaiting consent`**: answers only `hooks-continue-untrusted` (**Continue without trusting**), `telemetry-decline`, never one that grants hook execution or a sandbox escape; others (**credential**, **payment**) escalate; workspace-trust prompts fail launch. Dropped trust records refuse the start. Held: `.graphyard/launch/NAME.consent` (`herdr pane attach`); after **15 minutes** supervisor stops renewing, item dispatchable.

Reviewers/producers are `awaiting acknowledgement` until 30 s active (`counts.dispatchAwaiting`), re-prompted once quiet past `run.acknowledgementSeconds` (90); resultless is **`never started`**: relaunched ≤3 times (`retry.neverStarted`), [then elsewhere](master-agent-reference.md#producer-runtime-faults).

**Reviewer verdict**: launch writes `review-binding.json` (0600: head, base, policy revision, listed threads) into the session's `GH_CONFIG_DIR`; no binding, no session. Reviewer posts only via `graphyard review post --event APPROVE|REQUEST_CHANGES|COMMENT [--body TEXT]` (body else stdin); raw review calls denied. It posts nothing, printing reason and correct invocation, on missing binding, `GRAPHYARD_REVIEW` ≠ `KEY@SHA`, moved head, `mergeable` UNKNOWN after 2 min, unlisted thread ID, or an approval leaving a listed thread unclassified; else one review POST on the bound head, printing its id.

**Idle-with-lease** (25 quiet minutes, nothing open): one re-prompt; quiet 45 min after first idle, 10 after re-prompt: new attempt on its branch <60 min from last activity. **Unsubmitted past the bound** (lease held 60 min without submission): `unsubmitted-attempt` stalled-gate fault; at 120 min without submission progress (new PR or head within 15 min) the loop stops its supervisor, keeps its branch and ends the attempt; reclaim requeues the item, worktree kept; from 130 min renewal is refused (lapse cause `no-submission-bound`, not lease loss). An attempt awaiting its own open scope request is exempt; the bound runs from its answer or withdrawal. **Blocked** (Herdr `blocked`): destructive-command prompts declined; folder-trust dialog relaunches, recording trust; others fail after **5 min**; unreadable screens aren't timed. Headless Pi runs (`.graphyard/runs/`) survive restarts.

### Panes are closed and reclaimed

Ended sessions' panes close; each cycle closes ≤12 more, never a live lease's: agentless shells in `.graphyard/worktrees` after **120 s**, agents named for ended sessions after **60 s**. Over 20 agentless: `daemon.escalations` attention.

### The dispatcher's own state

Dispatcher bounds its own state where it composes it, marking each cut with an ellipsis; schema-failing cursor is repaired, not fatal, logged once with the failing path. Tick failures are attributed (`dispatch.lastFailure`); three in a row raise one attention item (no reviewer or producer session launches for any item); `graphyard master restart` repairs it. A session exiting **at launch** is classified by `herdr pane read` (`herdr agent get` answers only `agent_not_found`): a **provider limit notice** fails over like a mid-session exhaustion; others refused with the pane's last words and retried.
