<!-- page: Operate Graphyard | 6 | profiles, accounts and launches. -->
# Master-agent sessions

## Launch profiles

Add a worker with `master worker add FILE` from a template ([Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [Cursor](../examples/master/cursor-worker.json), [Muse](../examples/master/muse-worker.json)); it points to a mode-0600 token file outside every worktree.

Add reviewers with `master reviewer setup` and `master reviewer add FILE` ([Claude](../examples/master/claude-reviewer.json), [opencode](../examples/master/opencode-reviewer.json)); the loop launches each review; `master review GY-N [PROFILE]` recovers a refused launch or unsatisfied attempt.

`master producer replace FILE`, `master producer remove NAME` and `master reviewer remove NAME` apply next tick; `setup.attention` reports launch-stopping setup.

### Session handles

`master status` → `sessions` lists each handle: runtime, host, pane, transcript, attach command.

### Approval modes

Sessions run in no-approval mode (`"approvals": "auto"`): `--permission-mode bypassPermissions`, folder pre-trusted in `.claude.json` (Claude Code); `--ask-for-approval never --sandbox workspace-write`, network, `--add-dir` (Codex); `--force --trust` (Cursor); allow-all `OPENCODE_PERMISSION` (opencode); `--yolo` (Gemini, Qwen); `--allow-all-tools --allow-all-paths` (Copilot); `--approval-mode never --trust-workspace` (Muse); none (Pi). Profile flags merge in; asking values refused. `"prompt"`, `refusedLaunchKinds` (Kimi, Amp: one-shot only) and runtimes without command-line requests never start; [registry](onboarding.md#configure-the-fleet) runtimes need registered arguments including `{request}`.

### Worker sandbox

Codex's sandbox gets `.git/worktrees/GY-N-E` and the shared `.git` via `--add-dir`, each write probed first (`Worker launch failed: the codex sandbox cannot write PATH`).

## Accounts and failover

A profile's `accounts` lists [agent environments](onboarding.md#agent-environments) (`master environments`) in failover order, unless the [agent registry](onboarding.md#configure-the-fleet) defines the role. A launch takes the first account logged in and under `run.quotaCeilingPercent` (default 95), else **fails over** to the next (`dispatch.accounts`).

On a mid-session limit notice the loop commits a worker's changes as unpushed `WIP:`, records `capacity.exhausted` (not `lease-loss`) and relaunches on the next account; a role with none left waits for a reset.

## How a session starts

### The request is the session's first message

Every session's instruction is its first request on the runtime's command line, never pasted (authorization: [onboarding](onboarding.md#what-the-generated-instructions-authorize)).

#### How the request reaches the runtime

The launcher writes `.graphyard/launch/NAME.request` (and a Claude session's authorization to `NAME.role`), mode 0600, in the checkout, then types:

```
GY=/path/to/checkout/.graphyard/launch/NAME; claude --permission-mode bypassPermissions --setting-sources user --settings /path/to/repo/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

The typed line is at most **512 bytes**.

#### The start bound reads the pane

The runtime is **ready** when Herdr reports it working, idle or done with no prompt on screen, or its banner shows. Ready within **60 seconds** (`run.launchStartSeconds`) means started; one still starting gets up to **120 seconds** (`started.extended`). Otherwise it is refused and retried, naming the case and the pane's last non-empty line: `the claude runtime never started within 60 s in pane w1V:pR6 (command still echoing)`. A failed launch closes its pane, stopping any supervisor first, then releases its claim.

#### First-run consent prompts

A runtime stopped on a first-run prompt is **`awaiting consent`**. The launcher answers only `hooks-continue-untrusted` (**Continue without trusting**) and `telemetry-decline`, with the least-privilege option, never one that grants hook execution or a sandbox escape; everything else, above all a **credential** or **payment** prompt, is escalated. A worker is held in `.graphyard/launch/NAME.consent` (`master status` names `herdr pane attach P --workspace W`); after **15 minutes** the lease is released and the session stopped.

### Acknowledgement, the one re-prompt, and never started

A reviewer or producer is `awaiting acknowledgement` until 30 s of activity (`counts.dispatchAwaiting`). Quiet after `run.acknowledgementSeconds` (30–900, default 90), it is re-prompted once; settling then without a result, it is **`never started`**, relaunched a minute later free of retry budget. Three exhaust the request (`retry.neverStarted`).

### The dispatcher's own state

- **The dispatcher bounds its own state where it composes it**, each cut marked with an ellipsis.
- **A cursor that fails its schema is repaired, not fatal**, logged once with the failing path.
- **A tick failure is attributed and surfaced.** `dispatch.lastFailure` names it. Three in a row raise one attention item: no review or proof session is launching. `graphyard master restart` repairs the cursor.

**A session that exits at launch is classified from its pane** (`herdr pane read`; `herdr agent get` answers only `agent_not_found`): a **provider limit notice** fails over like a mid-session exhaustion; anything else is refused with the pane's last words and retried.
