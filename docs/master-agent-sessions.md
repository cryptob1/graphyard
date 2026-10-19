<!-- page: Operate Graphyard | 6 | profiles, launches. -->
# Master-agent sessions

`master worker add FILE`, `master reviewer add FILE`; `master producer replace|remove` applies next tick; `master status` `sessions` lists handles.

## Approval modes

[`"approvals": "auto"`](onboarding.md#agent-environments) adds per-runtime unattended flags: Claude Code `--permission-mode bypassPermissions`; Codex `--ask-for-approval never --sandbox workspace-write`; opencode `OPENCODE_PERMISSION`; others likewise; Pi none. Never started: `"prompt"`, `refusedLaunchKinds`, runtimes without command-line requests; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}`.

## The coordinator checkout is confined at the OS level

Non-master launches get own checkouts, the coordinator's unwritable (Codex sandbox, others bubblewrap); unconfinable refused.

### Worker sandbox

Codex `--add-dir` roots: `.git/worktrees/NAME`, `objects`, `refs/remotes`, `refs/heads/graphyard`, `logs/`; never `.git`.

Launches take the first account under `run.quotaCeilingPercent`, else **fail over**; limit notices hold the account (`capacity.exhausted`), relaunch elsewhere. Reviewers/producers: profile `kind` only. A rework worktree starts from the submission head in the shared object store, pushing no worker branch.

## The loop's own master session

`master registry role set master ACCOUNTS …`: one session; loop and `master start` adopt live `masterAgentName`. Relaunches on exit, limit notice, `run.masterSessionMinutes` (240); changed subjects wake it.

### The request is the session's first message

Never pasted.

#### How the request reaches the runtime

Written to `.graphyard/launch/NAME.request` (Claude also `NAME.role`), 0600, removed with the checkout; the typed line is bounded at **512 bytes**:

```
claude … --settings …/.graphyard/harness/ROLE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

#### The start bound reads the pane

**Ready**: Herdr active without prompt, or banner shown (`the claude runtime is on screen while Herdr reports it unknown`). Ready within **60 seconds** (`run.launchStartSeconds`) starts; starting gets **120 seconds** (`started.extended`). Refusals quote case and pane's last non-empty line, never Herdr's own `agent_not_found`.

#### First-run consent prompts

**`awaiting consent`**: answers only `hooks-continue-untrusted` (**Continue without trusting**), `telemetry-decline`, never one that grants hook execution or a sandbox escape; others (**credential**, **payment**) escalate. Held: `.graphyard/launch/NAME.consent` (`herdr pane attach`); after **15 minutes** the supervisor stops renewing; the item dispatches.

Reviewers/producers are `awaiting acknowledgement` until 30s active, re-prompted once quiet past `run.acknowledgementSeconds` (90); resultless is **`never started`**: relaunched ≤3 times (`retry.neverStarted`), [then elsewhere](master-agent-reference.md#producer-runtime-faults).

**Reviewer verdict**: launch writes `review-binding.json` (0600: head, base, policy revision; `verdictToken`, `previousHead`) into `GH_CONFIG_DIR`; no binding, no session. Verdicts post once via `graphyard review post --event …`; refused on a moved head. **Self-review**: before `complete`, workers run `graphyard review self GY-N`.

**Idle-with-lease** (25 quiet minutes): one re-prompt; from 45min quiet a new attempt starts. **Unsubmitted past the bound** (lease 60min): `unsubmitted-attempt` shown, stalled-gate fault past 120min; from 130min renewal refused. Open scope asks exempt. **Blocked**: destructive prompts declined; usage-limit menu fails over; others fail after **5min**.
