<!-- page: Operate Graphyard | 6 | profiles, launches. -->
# Master-agent sessions

`master worker add FILE`, `master reviewer add FILE`; `master producer replace|remove` applies next tick; `master status` `sessions` lists handles.

## Approval modes

[`"approvals": "auto"`](onboarding.md#agent-environments) adds per-runtime unattended flags: Claude Code `--permission-mode bypassPermissions`; Codex `--ask-for-approval never --sandbox workspace-write`; opencode `OPENCODE_PERMISSION`; others likewise; Pi none. Never started: `"prompt"`, `refusedLaunchKinds`, runtimes without command-line requests; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}`.

## The coordinator checkout is confined at the OS level

Non-master launches get own checkouts, the coordinator's unwritable (Codex sandbox, others bubblewrap); unconfinable refused.

### Worker sandbox

Codex `--add-dir` roots: `.git/worktrees/NAME`, `objects`, `refs/remotes`, `refs/heads/graphyard`, `logs/`; never `.git`.

Launches take the first account under `run.quotaCeilingPercent`, else fail over; limit notices hold the account (`capacity.exhausted`), among them Z.AI's 429 `Rate limit reached` envelope (`{"code":"1302",…}`), which names no reset and holds its account 15 minutes. Concurrent launches spread across provider plans before any plan takes a second live session, so one plan's limit cannot take the fleet down. Reviewers/producers: profile `kind` only. A rework worktree starts from the submission head in the shared object store, pushing no worker branch.

## The loop's own master session

`master registry role set master ACCOUNTS …`: one session; loop and `master start` adopt live `masterAgentName`. Relaunched once gone from Herdr. `master registry propose` proposes the master role beside the others — the reviewer's accounts, concurrency 1 — so a fresh install's loop launches its own session; renaming the role's accounts replaces that proposal.

### A closed Herdr workspace is replaced

Each cycle checks `herdrWorkspace` against `herdr workspace list`, as does the next reload after any launch refused with `workspace_not_found`. A workspace Herdr no longer lists is replaced in `.graphyard/master.json` by the one `masterAgentName` runs in (else the first listed), recorded as a `config` action with its reason, and items blocked on dispatches into the closed workspace are unblocked.

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

**`awaiting consent`**: answers only `hooks-continue-untrusted` (**Continue without trusting**), `telemetry-decline`, never one that grants hook execution or a sandbox escape; others (**credential**, **payment**) wait for the human. Held: `.graphyard/launch/NAME.consent` (`herdr pane attach`); after **15 minutes** the supervisor stops renewing; the item dispatches.

Reviewers/producers are `awaiting acknowledgement` until 30s active, re-prompted once quiet past `run.acknowledgementSeconds` (90); resultless is **`never started`**: relaunched ≤3 times (`retry.neverStarted`), [then elsewhere](master-agent-reference.md#producer-runtime-faults).

**Worker stall** (`run.inactivityMinutes`, 10): a worker session Herdr reports idle with no recorded activity for the window is re-prompted once with its own work; still idle a whole window after that re-prompt, the close step ends it as **`stalled`**: the pane closes, the attempt releases with its lease (a provider limit notice on the pane holds its account — Z.AI's 429 envelope for 15 minutes), and the item dispatches again next cycle.

**Reviewer verdict**: launch writes `review-binding.json` (0600: head, base, policy revision; `verdictToken`, `previousHead`) into `GH_CONFIG_DIR`; no binding, no session. Verdicts post once via `graphyard review post --event …`; refused on a moved head. **Self-review**: before `complete`, workers run `graphyard review self GY-N`.

**Registry slot**: the launch's agent-registry session rides its ledger record; the loop's close step ends it once the verdict is recorded, the item leaves review, or the pane is gone from Herdr (the reason names the pane), so a finished review or proof stops consuming its role's concurrency. Producers likewise. A session whose launching loop restarted away has no handle the successor loop tracks; each dispatch tick also judges every registry session the control plane lists live for this host by the pane its ledger record names, and ends it on the second consecutive miss.

**Unsubmitted past the bound** (lease 60min): `unsubmitted-attempt` shown; from 130min renewal refused. Open scope asks exempt.
