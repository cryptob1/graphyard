<!-- page: Operate Graphyard | 6 | launch, isolate and recover sessions -->
# Master-agent sessions

Add profiles with `master worker add FILE`, `master reviewer add FILE` or `master producer replace|remove`. Changes apply next cycle; `master status` lists handles.

## Approval modes

`approvals: auto` selects unattended flags: Claude `--permission-mode bypassPermissions`, Codex `--ask-for-approval never --sandbox workspace-write`, OpenCode `OPENCODE_PERMISSION`; Pi needs none. Prompt mode, refused kinds and runtimes without command-line requests cannot launch. Registry commands need `{request}`. OpenCode grants the repository tree, including sibling worktrees, denies outside paths, then overlays profile permissions.

## The coordinator checkout is confined at the OS level

Non-master sessions use separate checkouts with a read-only coordinator checkout, through Codex or bubblewrap. Unconfinable launches refuse.

### Worker sandbox

Both confinement layers must grant writable common `.git` for `packed-refs` locking/replacement, plus assigned worktree administration, objects, remote refs, graphyard branch refs and logs. Inside the mount, coordinator index/HEAD/config/hooks, other refs and shared worktree administration remain read-only. Lock creation cannot replace protected files.

### Credentials are hidden from confined sessions (GY-1856)

The wrapper masks Graphyard's whole config home, recorded coordinator/upstream credentials, deploy key and `confinement.maskPaths`. Files are masked at their containing directory; nonexistent paths hide nothing. Each session retains only its token (read-only), runtime home and reviewer/spec-check binding directory (writable). The master keeps its coordinator credential.

Install deploy code stays readable so sessions can run its CLI, while neighboring credentials remain hidden. Unreachable reviewer/spec-check CLIs refuse before launch and report configuration attention until repaired.

Accounts below `run.quotaCeilingPercent` are preferred; simultaneous launches spread across provider plans. Limits hold accounts: Z.AI 1302 for 15 minutes; Claude until the stated reset, or 6 hours if unreadable; Fable until next 08:00 local. Reviewers/producers use profile kind. Rework starts at the submitted head; workers push nothing.

## The loop's own master session

`master registry role set master ACCOUNTS …` configures one session. Registry proposal includes it using reviewer accounts. The loop or `master start` adopts `masterAgentName` or replaces it. See [master wakes and delivery progress](master-agent.md#master-wake-and-delivery-progress).

### A pane stopped on its provider's limit is absent (GY-2949)

Each cycle reads the master's recent output with the worker limit-notice judge. A provider limit holds the account until reset, closes the pane and launches the next account in the same cycle. Exited panes relaunch without a hold. Status is working, idle, limited until T or absent; none proves delivery.

### A closed Herdr workspace is replaced

Missing `herdrWorkspace` is replaced with the master's workspace or first listed. The loop records the config change and clears dispatch blockers caused by it. `workspace_not_found` triggers the same check.

### The request is the session's first message

Requests arrive on the runtime command line. Later authorized reminders come from the launcher ([authorization](onboarding.md#what-the-generated-instructions-authorize)).
#### How the request reaches the runtime

`.graphyard/launch/NAME.request` and Claude's `NAME.role` are 0600 and removed with the checkout. The typed line stays within 512 bytes:

```sh
claude … --settings …/.graphyard/harness/ROLE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

#### The start bound reads the pane

Ready means active without a prompt, or a visible runtime banner while Herdr reports unknown. `run.launchStartSeconds` defaults to 60 seconds; starting gets 120 (`started.extended`). Refusals quote the pane's last nonempty line.

#### First-run consent prompts

Only Continue without trusting (`hooks-continue-untrusted`) and telemetry decline are answered automatically. Credential/payment prompts wait for the person's decision, recorded at `.graphyard/launch/NAME.consent`; inspect with `herdr pane attach`. After 15 minutes supervision stops renewing the lease.

Reviewers/producers acknowledge after 30 seconds active. Quiet sessions get one reminder at `run.acknowledgementSeconds` (90); resultless starts retry `retry.neverStarted` times (3), then another profile.

Idle workers get one reminder after `run.inactivityMinutes` (10); another idle window ends as stalled and releases the lease. Stopped sessions with recognized limits end immediately and hold the account. Runtime prompts receive one reject key (external-directory Reject, destructive-command No). Still blocked after a window ends stalled with the prompt recorded; a new prompt gets a fresh answer.

### Resume and attempt bounds

Claude records session ID, runtime, account and worktree in `.graphyard/dispatch/dispatched-KEY.json`. The next attempt on that account/runtime uses `--resume ID`, with its new epoch, worktree and brief. Missing/unsupported/unavailable resumes launch fresh and log why; failed starts retry under the same lease. Status names the resumed attempt. Measure `pipeline.attempts.length` and `pipeline.reworkRounds`.

`run.attemptBoundMinutes` defaults to 130; commits or file changes within 20 minutes extend it while leases renew. `run.attemptCeilingMinutes` defaults to 480 and never extends. The loop records progress; stops preserve a WIP commit and successor diff. Status shows time remaining. Open human scope requests are exempt from the no-submission backstop.

### Verdicts and registry slots

`review-binding.json` (0600 in `GH_CONFIG_DIR`) binds head/base/policy, verdictToken and previousHead. No binding means no launch. `review post --event …` posts once; moved heads refuse. Workers run `review self GY-N` before complete.

Verdict, stage change or missing pane ends the ledger-linked registry slot. Completed reviews release on the first eligible pane miss after launch grace; other orphaned slots close after two consecutive misses, including after loop restart. See [session liveness](master-agent.md#session-liveness-is-reconciled-not-trusted).

### One continuing master conversation

Claude and Codex masters resume their current native conversation on the same account/runtime. Another account/runtime starts a successor: its request names the predecessor's runtime, account, native id, full read-only transcript and last unanswered person input (explicitly `none` when answered). A→B→A continues B: successors supersede predecessors. Failed launches retain the conversation; native resumes never fall back fresh. Unsupported master runtimes refuse explicitly. Across repeated failovers, an unanswered input keeps its native-event reference.

`master.continuity` persists current/predecessor identities independently of registry allocations. `.graphyard/master-records/` holds full native transcripts, mounted read-only without granting another account home or credentials. `.graphyard/launch/LAUNCH.inputs.jsonl` records launch/wake/retry origins before submission, joined to native input events by unique markers. Tools and partial output never answer a person; a completed assistant final after the input batch does. Pre-upgrade/adopted sessions recover native records from their recorded account and import known delivery origins; failed recovery retains state.

`master-session-resumes` and `master-continues-after-failover` run fixtures with user-only Claude settings under bubblewrap, inspecting records and transcript confinement.

Use `node $GRAPHYARD_CLI guide TOPIC` for the procedure named by the brief; standing rules remain in AGENTS.md.
