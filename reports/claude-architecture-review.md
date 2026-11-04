# Claude architecture review: autonomous delivery

**Judged commit:** `2982438bc640f9c2edae3c93eff0f65dd88c48aa` (main, the serving control plane and CLI). Every `file:line` refers to that commit.
**Author:** the Claude Code CLI running model `claude-opus-5-5` (Opus 5.5). Runtime session `21417c67-6d03-43cb-b77d-cdd1c0185a93` on account `claude-c`, as `.graphyard/dispatch/dispatched-GY-3067.json` records. The ledger principal is `graphyard-cursor-1`. That a Claude session holds a principal named for Cursor is itself evidence for finding 3.
**Scope:** read-only. No application code changed. Historical context: `reviews/architecture-2026-10-31.md`, which covered dead code and module structure. This review covers runtime behaviour seen in incidents.

## Executive summary

The ledger did its job. Item events showed the main failure of the last 24 hours within minutes: **about 350 attempts across GY-3060, GY-3061, GY-3064 and GY-3065 each ended the same way. The agent process exited with code 1 about 20 s after launch, and the item was dispatched again about every 5 minutes, for up to 12 hours.** GY-3064 alone went through epochs 2 to 126, from 2026-11-03 11:54 to 2026-11-04 00:08 UTC. The launch record says each of those sessions ran `codex`, but the ledger recorded them as `claude`.

GY-3059 is fixing that particular trigger (the Codex/mise launch environment). It does not fix how the loop reacts. A runtime that starts and then dies counts as a successful dispatch, so:

- no cooldown applies;
- no stall is counted;
- the master is not woken;
- the screen that said why is closed unread.

The next environment regression of any kind will loop the same way.

The smallest high-value changes:

- Record an early exit as a failed dispatch action, so the existing master wake carries its cause and the existing stall backoff slows the item (1).
- Read the pane before closing it (2).
- Record the runtime that actually launched (3).
- Let a worker block *on another item* as a dependency rather than as free text (4).
- Stop item documents growing with every attempt (5).

None of these adds a new layer or a manual gate. Each one either reuses existing machinery or deletes stored state.

## Existing open repairs (not new findings)

Status as of 2026-11-04 01:30 UTC, from `graphyard status` and the operator's notes. Each judgement holds for the head named; a later head needs its own look.

| Item | Pending head | Problem it fixes | Judgement |
|---|---|---|---|
| GY-3059 | `5b6f6c419d01` (PR 743) | A mise trust prompt or idle shell is taken for a started agent; launches miss the installed runtime environment. | Right fix for the trigger. At that head it changes only start detection (`src/master/launch.ts`, `confinement.ts`), so it does not cover a runtime that passes start detection and then exits. See finding 1. |
| GY-3060 | `43989d0af489` (PR 741) | `src/master/conversation.ts:84,151,179` read a whole transcript with `readFile`, which fails past 2 GiB. `src/daemon/cycle.ts:618-625` then `return`s before the master wake and heartbeat. | Confirmed on base. This is why nothing woke the master during the crash loops. Keep the fix narrow: a continuity failure must never skip the wake. |
| GY-3063 | `f758761150ac` (PR 753; approved, full canonical trial running) | The Landlock socket rule implicitly denies REFER, so renames within worker storage fail with EXDEV. | Correct, narrow repair. No comment. |
| GY-3064 | preserved `6539a743b455`, waiting on GY-3061 | Master rework guidance is missing from pre-submit retries (`src/master/dispatch.ts`, `rework-brief.ts`). | Correct. Its own blocker is the case for finding 4. |
| GY-3065 | none yet | Verification slots owned by a container-namespace PID are never reclaimed. | Correct. Keep the fix inside `verification-slots.ts`. |
| GY-3066 | `ec2bc13fdfef7ded417a08bed06645e82dccd6f3` (PR 752; 71 native affected tests passed, plus its own verify and base exercise; independent review pending). An earlier head, `52979855a64c`, had 13 main-containment fixture failures. | A stopping loop recorded a false orphan/unpushed refusal on GY-3061's live intent. The real trial then passed and pushed `2982438`, but `reconcileIntents` ignores refused states. | Correct direction: reconcile against the original intent and base. Do not retry on current main, where the fix would become its own baseline. |

GY-3051: the native fixture was rerun at `e38dfc5`. No actual agent has succeeded on it yet. It is outside this review.

## Findings, ranked

### 1. A runtime that starts and then dies is a "successful" dispatch, so the slot crash-loops (new, high)

**Evidence:**
- `graphyard events GY-N --kind release` counts:
  - GY-3061: 141 releases (132 on `graphyard-claude-1`);
  - GY-3064: 125 releases;
  - GY-3060: 66 releases;
  - GY-3065: 17 releases.
- Every release carries the same cause: `Watch supervisor ended attempt N: the agent process exited (code 1) while its lease was live`.
- A typical cycle for GY-3064 epoch 123:
  - claim at 23:51:22;
  - session recorded `running` at 23:51:27;
  - release at 23:51:46;
  - next claim at 23:56:49.

**Source:**
- `src/daemon/cycle.ts:587`: `launchWorker` calls `clearProfileFailure` as soon as `effects.dispatch` returns.
- `cycle.ts:595`: `recordProfileFailure` (a 10-minute cooldown, `src/daemon/state-cursor.ts:24`) runs only when the dispatch itself throws.
- `src/master/dispatch.ts:254`: account start failures are cleared once the runtime "started".
- `src/supervisor.ts:537`: the later exit becomes an ordinary lease release.
- `src/model/action-progress.ts` (`actionStallThreshold = 3`) never trips, because each epoch's dispatch row succeeds and a new row starts at zero.

**Trigger:** any runtime that draws enough to pass start detection and then exits. Examples are a bad PATH or mise configuration, a logged-out CLI, a provider DNS failure in the sandbox, or a broken binary update.

**Impact:**
- A worker slot and an attempt are burned every 5 minutes for as long as the cause lasts. That was 12 hours here.
- The items it blocks wait the whole time.
- The ledger grows with every cycle (see finding 5).
- No signal reaches the master: profile cooldowns are not wake causes (see below).

**Throttling alone is not enough.** `masterCauses` (`src/daemon/master-stalled-delivery.ts:34-52`) reads only work items and `state.actions`. It never reads `state.profiles`, where `recordProfileFailure` writes. A profile cooldown therefore never wakes the master, and a failure shared by every profile (one host environment, one runtime binary) still retries forever, just rotating through profiles. The fix has to put the cause where the master's wake already looks.

**Smallest fix:** record a short-lived attempt as a failed dispatch action, the one kind of record that already turns into a master wake.
1. In `closeStep` (`cycle.ts:206-217`), when an ended implementation attempt lived less than a short window (`resumeExitWindowMs`, 60 s, already in `src/master/session-resume.ts:28`) and committed nothing, write one `state.actions` row through the existing `record()`, with:
   - a stable key per item, `early-exit:${item.id}`;
   - `kind: 'dispatch'`, `state: 'failed'`, `epoch: null`;
   - `detail` set to the release cause plus the screen tail from finding 2, with no epoch number in it;
   - `attempts` counting consecutive early exits.

   `masterCauses` (`master-stalled-delivery.ts:46-50`) already turns a failed `dispatch` row into a wake cause, and `epoch: null` keeps it current across epochs. The subject key and the digest stay stable while the failure text is unchanged, so `cycle.ts:609-646` wakes the master **once per distinct failure**, not once per crash. The master then has the cause in hand and acts on it with its existing typed commands (file or advance the repair, mark the account, block the item). No new process and no approval step.
2. In `dispatchStep` (`cycle.ts:441-449`), skip an item whose `early-exit:` row has reached `actionStallThreshold` attempts until `actionStallDelay(attempts)` has passed. Both helpers already exist (`src/model/action-progress.ts`). This item-level backoff is independent of which profile the next launch would use, so a shared failure grows from a 5-minute to a 30-minute retry instead of looping at full speed.
3. Clear the row, and the profile failure, when an attempt outlives the window or commits. Also stop clearing the profile failure at dispatch time (`cycle.ts:587`), so the existing per-profile cooldown (`recordProfileFailure`, called from the same branch) still steers a single bad profile aside.

   Do not use `recordAccountStartFailure` for this. It is written (`dispatch.ts:322`), but only its own `record`/`clear` helpers read it back (`dispatch.ts:324,331`), and no account selection consults it. Either make selection read it or delete it: it is a second, unread copy of this fact.

**Validation:** a daemon-cycle test with a fake runtime that starts and exits 1 within 5 s, repeated across two profiles:
- the first early exit produces exactly one master wake whose prompt contains the exit cause;
- further identical exits produce no further wake, but a changed failure text produces one;
- after the stall threshold, the item is not re-dispatched before `actionStallDelay`, whichever profile is free;
- an attempt that lives past the window clears the row, and a later early exit wakes again.

No counterfactual: this review did not measure or simulate how many of GY-3064's 125 attempts the fix would have saved. The wake itself also depends on GY-3060, because on base a continuity failure returns before any wake is sent (`cycle.ts:618-625`).

### 2. The only record of *why* the runtime exited is closed unread (new, high)

**Evidence:**
- The release cause carries only the exit code, from `supervisor.ts:537`.
- The child is spawned with `stdio: 'inherit'` (`supervisor.ts:527`), so its output exists only in the Herdr pane.
- `closeStep` closes that pane (`cycle.ts:214`) about 15 s after the release, and never calls `effects.sessionScreen`.
- `effects.sessionScreen` exists and is already read for limit notices (`cycle.ts:353,374`) and prompts (`cycle.ts:406`).
- Result: 349 failures and not one error message on the ledger. Diagnosing GY-3059 needed an operator to look at live panes.

**Trigger:** every early exit.

**Impact:** an agent (or the resolver) cannot diagnose a crash loop from the ledger, so a person has to watch panes. That defeats the autonomy contract.

**Smallest fix:** in `closeStep`, before `closeSession`, read `effects.sessionScreen(session)` for an attempt that ended inside the finding-1 window. Append its last ~20 lines (credential-masked like the other screen reads) to the session `outcome` and to the finding-1 failure reason. Do this only for early exits; no new store.

**Validation:**
- With the finding-1 fake runtime printing `error: codex not found`, the session outcome and the `master status` profile reason both contain that line.
- The pane is still closed afterwards.

### 3. The ledger records the profile's runtime, not the runtime that actually launched (new, medium)

**Evidence:**
- GY-3064's sessions say `runtime: "claude"` under principal `graphyard-opencode-1`.
- `.graphyard/dispatch/dispatched-GY-3064.json` says `"runtime":"codex","account":"codex"`.
- GY-3060, 3061 and 3065 are the same.
- The cause is `cycle.ts:585`, which writes `runtime: profile.kind ?? profile.mode`. Account fallback (`dispatch.ts:233-275`, GY-417) routinely runs a different runtime under a profile.
- `engine.ts:918` copies `runtime` into `lastAssignment` only from the static principal roster. GY-3067's own `lastAssignment` has no runtime at all.

**Trigger:** any account fallback across runtimes.

**Impact:**
- The operator cannot tell which agent actually did the work. This item exists because of that ("an actual Claude worker, not a Codex agent with a Claude-named profile").
- `detectRuntimeExhaustion(screen, session.runtime, …)` at `cycle.ts:354,375` applies the wrong runtime's limit-notice reader. A Codex limit screen in a session labelled `claude` can be missed, so the account is not held.

**Smallest fix:** `effects.dispatch` already returns the launch plan, and the dispatch record holds `launch.kind` and the account. At `cycle.ts:585`, record `runtime` from the launched kind, not from the profile. No schema change: `session.runtime` exists.

**Validation:**
- A dispatch test whose `claude` profile falls back to a `codex` account records `session.runtime === 'codex'`.
- A Codex limit screen in that session is detected.

### 4. A wait on another item is free-text blocker, so only a master wake can release it (new, medium)

**Evidence:**
- GY-3064's blocker reads "waiting on the shared private-root runner repair GY-3061 … Master will unblock/reclaim", yet its `dependencies` are `[]`.
- `dispatchable` (`src/coordination.ts:60`) holds on any blocker. Only `master unblock` clears it.
- The master was not being woken (GY-3060), so nothing would have released GY-3064 when GY-3061 delivered.
- Dependencies are already first-class: `coordination.ts:142` holds and releases on them without anyone acting.

**Trigger:** every "blocked until GY-M lands" report. These are common while a shared runner or gate repair is in flight.

**Impact:** a dependent item waits for a master decision it does not need, and an outage of the master wake extends that wait without limit.

**Smallest fix:** in the `blocked` command (`src/cli/lease.ts:114-122`, engine `command === 'blocked'` at `engine.ts:952`), accept `--after GY-M`. It adds M to `dependencies` in the same transaction and ends the attempt the way `blocked` already does, without setting `blocker`. One flag; no new state.

**Validation:**
- Block A `--after` B: A is not dispatchable.
- Deliver B: A dispatches in the next cycle with no master action.
- A plain `blocked` is unchanged.

### 5. Item documents grow with every attempt and are rewritten whole (new, low-medium)

**Evidence:**
- `graphyard status GY-3064` is 178 KB:
  - `actionQueue` 52 KB;
  - `sessions` 32 KB (40 kept);
  - `workspaces` 20 KB (127 entries, 126 of them ended attempts whose worktrees are gone).
- `engine.ts:1090` appends to `workspaces` and nothing removes the entry when an attempt ends (only the GY-860 untouched-claim undo at `engine.ts:946` does).
- `engine.ts:1087` scans every item's `workspaces` on each `worktree` registration.
- A crash loop (finding 1) multiplies all of this, and slow snapshot reads are why `dispatchIntervalSeconds` was raised to 30 s.

**Trigger:** many attempts on one item.

**Impact:** every mutation of that item, and every worktree registration fleet-wide, does more work under the coordination lock.

**Smallest fix (a deletion):** when an attempt ends (`endAttempt` and the lapse reconciliation), drop its `workspaces` entry unless it is the submission's epoch, which rework reuses (`engine.ts:1088`). The attempt history stays in `pipeline.attempts` and the events.

**Validation:**
- After N released attempts, `workspaces` holds at most the live and submitted epochs.
- Existing branch-reservation and rework-branch tests pass unchanged.

## What to keep

- **Leases, epochs and one transaction per mutation, with append-only events.** `graphyard events GY-N --kind release` reduced a day-long incident to one query. Every fix above is a few lines because the facts are already recorded.
- **Typed release with a cause** (`supervisor.ts:228-240`). The cause line was the key evidence; finding 2 only makes it complete.
- **Profile cooldowns and action stall classification.** They are the right tools; finding 1 only feeds them the missing case. Do not add a new watchdog or supervisor.
- **First-class dependencies.** Use them for cross-item waits (finding 4) instead of master prose.
- **One merge writer.** GY-3066 is a reconciliation gap in that design, not a reason to change it.

## Not recommended

- A new coordinator or supervisor process, manual approval gates, or retry caps that need an operator to lift them.
- A broad rewrite of `engine.ts`, `auto-dispatch.ts` or `supervisor.ts` for this class of failure. The October 31 review's structural items stand on their own; none of them would have stopped this loop.

## How this was reviewed

- `graphyard status` and `graphyard events` for GY-3059, 3060, 3061, 3063, 3064, 3065 and 3066.
- The `.graphyard/dispatch/dispatched-*.json` launch records.
- `git diff --stat` of each pending head against `2982438`.
- Reading `src/daemon/cycle.ts`, `src/daemon/sessions.ts`, `src/supervisor.ts`, `src/master/dispatch.ts`, `src/master/session-resume.ts`, `src/master/conversation.ts`, `src/engine.ts`, `src/coordination.ts` and `src/model/action-progress.ts`.
- The system journal was not readable from this sandbox. Loop-side timing, such as the ~5-minute redispatch cadence, comes from event timestamps, not from logs.
