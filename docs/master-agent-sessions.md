<!-- page: Operate Graphyard | 6 | profiles, launches. -->
# Master-agent sessions

`master worker add FILE`, `master reviewer add FILE`; `master producer replace|remove` applies next tick; `master status` `sessions` lists handles.

## Approval modes

[`"approvals": "auto"`](onboarding.md#agent-environments) adds per-runtime unattended flags: Claude Code `--permission-mode bypassPermissions`; Codex `--ask-for-approval never --sandbox workspace-write`; opencode `OPENCODE_PERMISSION`; others likewise; Pi none. A worker launch derives opencode's document from the checkout it serves (GY-2959): the repository tree — `<repository>/**` and `<repository>/.graphyard/**` — is granted so a second worktree beside the assigned one never prompts, and everything outside the repository is denied; a profile's own document lays over it. Never started: `"prompt"`, `refusedLaunchKinds`, runtimes without command-line requests; [registry](onboarding.md#configure-the-fleet) runtimes need `{request}`.

## The coordinator checkout is confined at the OS level

Non-master launches get own checkouts, the coordinator's unwritable (Codex sandbox, others bubblewrap); unconfinable refused.

### Worker sandbox

Codex `--add-dir` roots: `.git/worktrees/NAME`, `objects`, `refs/remotes`, `refs/heads/graphyard`, `logs/`; never `.git`.

The read-only mount re-exposes the common `.git` directory writable (GY-2967): every ref transaction a worker runs — commit, merge, reset, `branch -f`, `update-ref`, a cherry-pick's cleanup — takes the common `packed-refs` lock once anything has packed a ref (git gc does), and rewrites that file under the lock. Inside it, the checkout's own state is re-bound read-only — `index`, `HEAD`, `config`, `hooks`, the refs outside `refs/heads/graphyard`, and the shared `worktrees` area for a session with its own worktree admin — where the read-only bind still lets git take its `.lock` (the directory stays writable) but refuses the write and the rename that commits it, so the coordinator's index, HEAD, config and the base branch keep the protection they had.

Launches take the first account under `run.quotaCeilingPercent`, else fail over; limit notices hold the account (`capacity.exhausted`), among them Z.AI's 429 `Rate limit reached` envelope (`{"code":"1302",…}`), which names no reset and holds its account 15 minutes, and Claude's `You've hit your session limit · resets 1:30am (America/Los_Angeles)` and `You've reached your Fable limit. …` (GY-2962): the session limit holds until the reset it names, a session or usage limit with no readable reset holds 6 hours, and a Fable limit — which names no reset — until the next 08:00 local. Concurrent launches spread across provider plans before any plan takes a second live session, so one plan's limit cannot take the fleet down. Reviewers/producers: profile `kind` only. A rework worktree starts from the submission head in the shared object store, pushing no worker branch.

## The loop's own master session

`master registry role set master ACCOUNTS …`: one session; loop and `master start` adopt live `masterAgentName`. Relaunched once gone from Herdr. `master registry propose` proposes the master role beside the others — the reviewer's accounts, concurrency 1 — so a fresh install's loop launches its own session; renaming the role's accounts replaces that proposal.

### A pane stopped on its provider's limit is absent (GY-2949)

Each cycle reads the master pane's recent output with the same limit-notice judge workers use. A usage or session limit notice (`You've hit your session limit · resets 1:30am`) is treated as absent: the account is held until the parsed reset (the hold rides every selection, so the spent plan is not asked again), the pane closes, and the role's next account launches the master in the same cycle. A pane whose runtime reports exited is closed and relaunched the same way, with no hold. `master status` shows the session's state on its one page: `working`, `idle` (Herdr reports the pane idle), `limited until T` while the hold stands, and `absent` once the pane is closed with no hold standing.

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

**Worker stall** (`run.inactivityMinutes`, 10): a worker session Herdr reports idle with no recorded activity for the window is re-prompted once with its own work; still idle a whole window after that re-prompt, the close step ends it as **`stalled`**: the pane closes, the attempt releases with its lease (a provider limit notice on the pane holds its account — Z.AI's 429 envelope for 15 minutes), and the item dispatches again next cycle. A session that has stopped, whose pane's last lines already carry a recognised limit notice — Claude's `You've reached your Fable limit. …` or `You've hit your session limit` among them — ends at once on it, with no window waited and no re-prompt: the attempt ends as a limit, the lease releases, and the account is held for the notice's reset (GY-2962).

**Blocked on its runtime's own prompt** (GY-2959): a worker Herdr reports `blocked` is answered by the close step, not renewed under — the loop reads the prompt off the pane and sends its reject key once (OpenCode's external-directory Allow once / Always allow / Reject chooses Reject, which leaves the worker inside its worktree; a destructive command's No is declined the same way); one still blocked a whole window after the answer ends as **`stalled`** naming the prompt text, lease released, item dispatchable. One that unblocked after the key is left alone, and a new prompt gets a fresh answer. The launch instruction names the external-directory prompt beside the rm/mv one, and the worker launch pre-grants the repository tree so the prompt does not appear for a worktree beside the assigned one.

**The next attempt resumes the last one's session** (GY-2971): a Claude Code worker launches with `--session-id ID`, and the item's launch record (`.graphyard/dispatch/dispatched-KEY.json`) keeps the id with its runtime, account and worktree. The item's next attempt or rework round — on the same runtime and account — launches `claude --resume ID` in its own worktree under its own epoch, its complete brief (head, findings, rework reason) still the first request; only the conversation carries over. Another runtime, an account the selection passed over (limited, logged out), no recorded id, or a resume that fails its start bound launches fresh as before, logging `attempt N launches a fresh session: WHY`; a failed resume relaunches the same attempt under the lease it holds. `master status` reads `attempt N (resumed from M)`. Measure it by each item's `pipeline.attempts` count and `pipeline.reworkRounds`:

| Measure | Read from |
|---|---|
| attempts per item | `pipeline.attempts.length` |
| rework rounds | `pipeline.reworkRounds` |

**Reviewer verdict**: launch writes `review-binding.json` (0600: head, base, policy revision; `verdictToken`, `previousHead`) into `GH_CONFIG_DIR`; no binding, no session. Verdicts post once via `graphyard review post --event …`; refused on a moved head. **Self-review**: before `complete`, workers run `graphyard review self GY-N`.

**Registry slot**: the launch's agent-registry session rides its ledger record; the loop's close step ends it once the verdict is recorded, the item leaves review, or the pane is gone from Herdr (the reason names the pane), so a finished review or proof stops consuming its role's concurrency. Producers likewise. A session whose launching loop restarted away has no handle the successor loop tracks; each dispatch tick also judges every registry session the control plane lists live for this host by the pane its ledger record names, and ends it on the second consecutive miss.

**The attempt bound is a progress bound** (GY-2961): an attempt whose worktree shows a new commit or changed files within the last 20 minutes, and whose lease renews, runs past the bound and is stopped only at the **ceiling** (default 8h); one with neither is stopped at the **bound** (default 130min since the claim). Each cycle the loop reads the attempt's worktree and records what changed on the session handle, so the control plane's renewal refusal counts the same progress. The stop keeps the attempt's uncommitted work as one WIP commit on its branch — a successor receives the diff — and releases the lease. The launch brief names the end instant, the rule and the ceiling (`run.attemptBoundMinutes` / `run.attemptCeilingMinutes` set both per install), and `master status` shows each live attempt's remaining time. **Unsubmitted past the bound** (lease 60min): `unsubmitted-attempt` shown; from 130min renewal refused as the backstop when no progress of either kind is on the record. Open scope asks exempt.
