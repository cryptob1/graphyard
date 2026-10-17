<!-- page: Operate Graphyard | 6 | profiles, launches. -->
# Master-agent sessions

## Launch profiles

`master worker add FILE`: workers ([template](../examples/master/claude-worker.json)); `master reviewer setup` or `master reviewer add FILE` reviewers ([Claude](../examples/master/claude-reviewer.json), [opencode](../examples/master/opencode-reviewer.json)); `master producer replace`, `master producer remove`, `master reviewer remove` apply next tick; `setup.attention` reports blockers.

### Session handles

`master status` `sessions`.

### Approval modes

`"approvals": "auto"` adds: Claude Code `--permission-mode bypassPermissions`, `.claude.json` trust; Codex `--ask-for-approval never --sandbox workspace-write` with network, `--add-dir` and trusted `config.toml` projects; missing `.agents`/`.codex` created, symlinked ones refused; Cursor `--force --trust`; opencode allow-all `OPENCODE_PERMISSION`; Gemini, Qwen `--yolo`; Copilot `--allow-all-tools --allow-all-paths`; Muse `--approval-mode never --trust-workspace`; Antigravity `agy` `--dangerously-skip-permissions`, `trustedWorkspaces`, `--prompt-interactive`; Pi none. Never started: `"prompt"`, `refusedLaunchKinds`, runtimes without command-line requests; registry needs `{request}`.

### The coordinator checkout is confined at the OS level

Non-master launches get own checkouts (master: `.graphyard` writable, host acts loop-served), coordinator's unwritable (Codex `--sandbox workspace-write`, others bubblewrap, session bus a [keyring-only proxy](operations.md#worker-host-keyring-proxy)); unconfinable refused; loop refuses dirty/moved checkouts ([details](master-agent.md#operate)).

#### Worker sandbox

Codex `--add-dir` roots: `.git/worktrees/NAME`, `objects`, `refs/remotes`, `refs/heads/graphyard`, `logs/`; never `.git`. Reviewers/producers: same grants and probe plus `.git/worktrees`; fetch `--no-write-fetch-head`.

Profile `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`) unless registry defines roles. Launches take first account under `run.quotaCeilingPercent`, else (or failed start) **fail over** (`dispatch.accounts`). Runtime limit notices (never agent text) or silent done with unpushed `WIP:` hold the launch account (`capacity.exhausted`), relaunch elsewhere/after reset. An item's two latest consecutive epochs' account (within 2h, reset unpassed) is re-held first; unwritable holds refuse dispatch. Reviewers/producers use only profile `kind` (else `cross-runtime`).

## The loop's own master session

`master registry role set master ACCOUNTS …` (unset: none): one session; loop and `master start` adopt live `masterAgentName`. Relaunches on exit, limit notice, `run.masterSessionMinutes` (240); changed subjects wake it; `run.masterHeartbeatMinutes` (30) sends heartbeat (`daemon.master`).

### The request is the session's first message

Never pasted ([authorization](onboarding.md#what-the-generated-instructions-authorize)).

#### How the request reaches the runtime

Written to `.graphyard/launch/NAME.request` (Claude also `NAME.role`), mode 0600, removed with the checkout; typed line bounded at **512 bytes**:

```
GY=…/.graphyard/launch/NAME; claude … --settings …/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

#### The start bound reads the pane

**Ready**: Herdr active with no prompt, or banner shown (`the claude runtime is on screen while Herdr reports it unknown`; [fixture](../tests/fixtures/opencode-1.18-start-screen.txt)). Ready within **60 seconds** (`run.launchStartSeconds`) starts; still starting gets **120 seconds** (`started.extended`). Refusals quote case and pane's last non-empty line (`the claude runtime never started within 60 s (command still echoing)`, `… was still starting after 120 s`, `… is blocked before it is ready`), never Herdr's own `agent_not_found`; retrying `Automatic producer launch for GY-N refused 1 time(s)`.

**Approvers**: replaced panes' bounds run from first sight; failed relaunches adopt a started same-name approver at its registry end.

#### First-run consent prompts

**`awaiting consent`**: answers only `hooks-continue-untrusted` (**Continue without trusting**), `telemetry-decline`, never one that grants hook execution or a sandbox escape; others (**credential**, **payment**) escalate; workspace-trust prompts, by question or menu labels, fail launch; dropped trust records refuse the start. Held: `.graphyard/launch/NAME.consent` (`herdr pane attach`); after **15 minutes** supervisor stops renewing, item dispatchable.

Reviewers/producers are `awaiting acknowledgement` until 30s active (`counts.dispatchAwaiting`), re-prompted once quiet past `run.acknowledgementSeconds` (90); resultless is **`never started`**: relaunched ≤3 times (`retry.neverStarted`), [then elsewhere](master-agent-reference.md#producer-runtime-faults).

**Reviewer verdict**: launch writes `review-binding.json` (0600: head, base, policy revision, listed threads; control-plane: `mode`, `verdictToken`) into the session's `GH_CONFIG_DIR`; no binding, no session. Reviewer posts only via `graphyard review post --event APPROVE|REQUEST_CHANGES|COMMENT [--body TEXT]` (body else stdin); raw review calls denied. Nothing posts on missing binding, `GRAPHYARD_REVIEW` ≠ `KEY@SHA`, moved head, `mergeable` UNKNOWN after 2min, an unlisted thread, or an approval leaving a listed thread unclassified; else one review POST.

**Idle-with-lease** (25 quiet minutes, nothing open): one re-prompt; quiet 45min after first idle, 10 after re-prompt: new attempt on its branch <60min from last activity. **Unsubmitted past the bound** (lease held 60min without submission): `unsubmitted-attempt` shown, a stalled-gate fault past 120min; without submission progress the loop stops the supervisor, ending the attempt; reclaim requeues it, branch and worktree kept; from 130min renewal is refused (`no-submission-bound`, not lease loss). Open scope requests exempt it. **Blocked**: destructive prompts declined; usage-limit menu fails over; folder-trust dialog relaunches; others fail after **5min**.

### Panes are closed and reclaimed

Ended sessions' panes close; ≤12 more each cycle, never a standing attempt's: agentless `.graphyard/worktrees` shells after **120s**, ended namesakes after **60s**. `master status` counts them (`herdr pane list`); over 20: `daemon.escalations`.

### The dispatcher's own state

Dispatcher bounds its own state where it composes it, marking each cut with an ellipsis; schema-failing cursor is repaired, not fatal, logged once with the failing path. Tick failures are attributed (`dispatch.lastFailure`); three in a row raise one attention item (no reviewer or producer session launches for any item); `graphyard master restart` repairs it. A session exiting **at launch** is classified by `herdr pane read`: a **provider limit notice** fails over like a mid-session exhaustion; others refused with the pane's last words, retried.
