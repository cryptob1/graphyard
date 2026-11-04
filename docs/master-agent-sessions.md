<!-- page: Operate Graphyard | 6 | launch, isolate and recover sessions -->
# Master-agent sessions

Add profiles with `master worker add FILE`, `master reviewer add FILE` or `master producer replace|remove`. Changes apply next cycle; `master status` lists handles.

## Approval modes

`approvals: auto` selects unattended flags: Claude `--permission-mode bypassPermissions`, Codex `--ask-for-approval never` (the native harness selects `workspace-write`; confined launches override it as [described below](#worker-sandbox)), OpenCode `OPENCODE_PERMISSION`; Pi needs none. Prompt mode, refused kinds and runtimes without command-line requests cannot launch. Registry commands need `{request}`. OpenCode grants the repository tree, including sibling worktrees, denies outside paths, then overlays profile permissions.

## The coordinator checkout is confined at the OS level

Every role, including master, Codex and registered runtimes, runs inside an outer bubblewrap namespace with read-only host root. Launches require `/usr/bin/python3` and Linux Landlock ABI 9 for socket confinement; unavailable confinement refuses before agent commands start.

Merge-trial install, build, test and E2E commands run in disposable Docker containers. `install` builds `graphyard-trial:local` from the Dockerfile's `trial` target; preview changes with `install --plan`. Containers use a read-only private root, nonroot user, no capabilities, no-new-privileges, private PID/network namespaces and private temporary filesystems. Only allocated checkout/home/scratch directories are writable. Required Git objects, shared dependencies and the trusted E2E harness mount read-only; linked dependencies share a mount per destination, and explicit writable allocations take precedence. Host root, operator home and host command sockets are absent.

Launcher tooling retains host mise settings. Candidate commands use the image's Node/npm, locked Playwright Chromium and system libraries, with allocation-owned npm/browser caches. The walkthrough renderer and its test use the image's read-only `/opt/graphyard-browsers` directly. Serve commands and E2E clients share private loopback. For Compose cases, the trusted launcher validates and starts the bounded stack: checkout binds, file secrets and configs become copied container content, without host binds, custom host drivers or added privileges. Case commands share only the HTTP service's private network; they receive no Docker client or engine socket. The launcher removes the stack, volumes and networks after success or failure. Nested tests assert orchestration is unavailable; the host regression exercises real Compose.

Containers are removed on completion or cancellation. A separate supervisor watches launcher lifetime through a pipe and removes the named container after SIGKILL or output overflow, before releasing captured output pipes.

Outer trials inherit no host filesystem Landlock domain, which would forbid descendant mounts. Nested tests reconstruct a private root from the container toolchain and explicit allocations, establish bubblewrap mounts, then apply Landlock; they never request a host Docker socket. Docker seccomp is disabled for unprivileged user-namespace mounts; capabilities remain empty and privileged mode is never used. Ordinary host sessions retain mount and Landlock confinement.

### Worker sandbox

Confined Codex uses `--sandbox danger-full-access` inside Graphyard's mount and socket boundary. A second runtime sandbox would fail because Landlock denies later mounts. Standalone probes keep native workspace policy; confined probes exercise the outer boundary. OS writable grants and credential masks still apply to every command.

The outer boundary grants writable common `.git` for `packed-refs` locking/replacement, plus assigned worktree administration, objects, remote refs, graphyard branch refs and logs. Native Codex sandbox probes grant these through `--add-dir` too. Inside the mount, coordinator index/HEAD/config/hooks, other refs and shared worktree administration remain read-only. Directory locks cannot replace protected files.

### Host writes and scratch cleanup (GY-3045)

`master start codex` and `master start claude` explicitly retain their existing login directory: inherited `CODEX_HOME` or `CLAUDE_CONFIG_DIR`, otherwise `~/.codex` or `~/.claude`. Only that runtime directory is writable; the operator HOME stays read-only and the session HOME uses private scratch.

After establishing host-session mounts, the launcher applies an inherited Landlock socket policy before executing any runtime command. Pathname Unix sockets resolve only inside allocated writable directories, private scratch, or the existing filtered keyring proxy. Undeclared host sockets elsewhere are denied even when published after launch or reached through a symlink inside the worktree. Host abstract Unix sockets are also denied; local IPC created by the session remains available. This policy uses `LANDLOCK_ACCESS_FS_RESOLVE_UNIX` and `LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET` ([kernel documentation](https://docs.kernel.org/userspace-api/landlock.html)); a read-only mount alone does not prevent socket connections. Ordinary TCP networking remains available, subject to the declared host-executor refusal below.

Writable host paths are the allocated worktree or session checkout, its required Git state described above, the explicitly assigned verification-slot directory, its own runtime login/binding directories and private scratch. The master also keeps its managed `.graphyard` state and explicitly supplied coordinator state directory writable. Merge trials grant only their allocated checkout/session and temporary directories, never the coordinator root. Trial HOME uses a separate short allocation beside trial scratch so nested Unix socket paths fit; npm and Playwright browser caches live beneath it; dashboard checks install Chromium there even when the host cache is empty or a host cache override is set. These caches are removed with the trial. Other host-home and unrelated-project files stay read-only in host sessions and absent in outer trials. The OS denies these writes without an approval prompt; routine work and existing delivery gates stay unattended.

Each agent's `.graphyard/scratch` is mounted at `/tmp` and `/var/tmp` inside its namespace. Outer trials use private temporary filesystems there and bind their allocated disk scratch at its own path. These short paths stay on the allocated disk so checks can create Git fixtures and Unix sockets. `TMPDIR`, `TMP` and `TEMP` point there; trials preserve their short allocated temporary path so nested checks and cleanup retain its identity. HOME, runtime scratch and caches also live there. Explicit runtime login homes remain available, including accounts whose login variable is `HOME` or `XDG_CACHE_HOME`: an environment value pointing into an explicitly granted writable directory is preserved. Headless confinement uses the same effective environment as the child, including registry and per-run overrides, to mask Unix command endpoints and refuse remote ones. A refused merge trial releases its allocated checkout and temporary directories. `/dev` is a fresh minimal device filesystem. Host `/run`, host temporary directories, Docker runtime directories, and Herdr session directories and configured Unix Docker/Podman/BuildKit/SSH/Herdr endpoints are hidden; systemd buses stay masked (only the existing filtered keyring proxy may be re-exposed).

Create scratch with `scratch=$(mktemp -d)` in the session, keep that variable in the same shell, and clean only that directory after checking its value. Never use `HOME=$(mktemp -d) command; rm -rf "$HOME"`: the assignment affects only `command`, and the later expansion uses the parent HOME. After an incident, stop the command and inspect the exact allocated directory; never clean the operator HOME or infer a cleanup target from a missing CLI. Session checkout cleanup removes its scratch. `e2e/cases/worker-filesystem-isolation.json` runs the real namespace regression: disposable host-home sentinels, all roles, normal work, the command-scope mistake and host control sockets.

Declared host-control endpoints (`DOCKER_HOST`, `CONTAINER_HOST`, `BUILDKIT_HOST`) must use local `unix:///` sockets, which are masked. A TCP, SSH or other remote endpoint refuses the launch automatically before any command starts: mount isolation cannot constrain a host executor reached over the network. Ordinary network access remains available. Registered master runtimes keep only their configured account home directory writable, including a custom `homeVariable`; sibling account directories remain read-only.

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

Ready requires Herdr to identify the runtime through its screen or foreground process, without a prompt. An assigned agent name on an idle or working shell is insufficient. Registered absolute executable paths match the foreground executable; a `graphyard watch` supervisor alone does not identify a runtime. A different reported runtime is refused even when the requested runtime's old banner remains. `run.launchStartSeconds` defaults to 60 seconds; starting gets 120 (`started.extended`). Refusals quote the pane's last nonempty line.

Launches default to the install process's `PATH` and `MISE_NO_CONFIG=1`; registry runtime settings override them. The typed command reapplies that environment after shell startup so activation cannot shadow the installed runtime. A mise configuration trust dialog immediately fails launch and names the runtime PATH repair; it never gets trust or waits as agent consent. Failed-launch cleanup closes the pane and releases its lease epoch and registry capacity. The normal acknowledgement window still requires request activity after start.

When `/etc/resolv.conf` points into `/run`, confinement restores only its canonical public resolver file read-only after masking `/run`. Other host runtime files, control sockets and operator-home writes stay isolated. `e2e:runtime-launch-real-progress` checks failed and repaired `getent ahosts`, a wrapper trust dialog and installed-Codex worker/reviewer first requests, shell-tool results and completed responses through PTYs against a deterministic local provider, with Landlock intact and no provider credentials.

#### First-run consent prompts

Only Continue without trusting (`hooks-continue-untrusted`) and telemetry decline are answered automatically. Credential/payment prompts wait for the person's decision, recorded at `.graphyard/launch/NAME.consent`; inspect with `herdr pane attach`. After 15 minutes supervision stops renewing the lease.

Reviewers/producers acknowledge after 30 seconds active. Quiet sessions get one reminder at `run.acknowledgementSeconds` (90); resultless starts retry `retry.neverStarted` times (3), then another profile.

Session `observedAt` records liveness sightings; routine observations leave activity `updatedAt` unchanged. Session updates and changed worktree readings advance activity, including progress found in the current cycle. Working sessions and unavailable runtime inventories are not closed for inactivity. Idle workers get one reminder after `run.inactivityMinutes` (10); another idle window ends as stalled and releases the lease. Stopped sessions with recognized limits end immediately and hold the account. Runtime prompts receive one reject key (external-directory Reject, destructive-command No). Still blocked after a window ends stalled with the prompt recorded; a new prompt gets a fresh answer.

### Resume and attempt bounds

Applied master rework guidance also reaches retries before their first submission, in both fresh and resumed requests: the brief names the item, current attempt and applied time. A verification-only handoff needs no new source commit or prior change number. A later submission suppresses the reason it answered.

Claude records session ID, runtime, account and worktree in `.graphyard/dispatch/dispatched-KEY.json`. The next attempt on that account/runtime uses `--resume ID`, with its new epoch, worktree and brief. Missing/unsupported/unavailable resumes launch fresh and log why; failed starts retry under the same lease. Status names the resumed attempt. Measure `pipeline.attempts.length` and `pipeline.reworkRounds`.

`run.attemptBoundMinutes` defaults to 130; commits or file changes within 20 minutes extend it while leases renew. `run.attemptCeilingMinutes` defaults to 480 and never extends. The loop records progress; stops preserve a WIP commit and successor diff. Status shows time remaining. Open human scope requests are exempt from the no-submission backstop.

### Verdicts and registry slots

Reviews launch under the profile’s agent identity through the control plane. `master reviewer add|remove` manages profiles; no reviewer App, installation or private key is configured.

`review-binding.json` (0600 in `GH_CONFIG_DIR`) binds head/base/policy, verdictToken and previousHead. No binding means no launch. `review post --event …` posts once; moved heads refuse. Workers run `review self GY-N` before complete.

Verdict, stage change or missing pane ends the ledger-linked registry slot. Completed reviews release on the first eligible pane miss after launch grace; other orphaned slots close after two consecutive misses, including after loop restart. See [session liveness](master-agent.md#session-liveness-is-reconciled-not-trusted).

### One continuing master conversation

Claude and Codex masters resume their current native conversation on the same account/runtime. Another account/runtime starts a successor: its request names the predecessor's runtime, account, native id, full read-only transcript and last unanswered person input (explicitly `none` when answered). A→B→A continues B: successors supersede predecessors. Failed launches retain the conversation; native resumes never fall back fresh. Unsupported master runtimes refuse explicitly. Across repeated failovers, an unanswered input keeps its native-event reference.

`master.continuity` persists current/predecessor identities independently of registry allocations. `.graphyard/master-records/` holds full native transcripts, mounted read-only without granting another account home or credentials. `.graphyard/launch/LAUNCH.inputs.jsonl` records launch/wake/retry origins before submission, joined to native input events by unique markers. Tools and partial output never answer a person; a completed assistant final after the input batch does. Pre-upgrade/adopted sessions recover native records from their recorded account and import known delivery origins; failed recovery retains state and retries each cycle, with one standing diagnostic per unchanged failure. A live master still receives deduplicated incidents and bounded heartbeats while recovery fails; their marked origins survive later adoption. If the master is absent and native history cannot be read, the existing launcher starts one fresh master with current board priorities, work/delivery state, blockers and recorded operator goals, explicitly marking unread history and unknown unanswered inputs. `master.recoveryFailures` retains the old session, conversation references and error; adopted launch requests are preserved read-only under `master-records/` before their named delivery file is reused. The original native history, retained records and input origins remain intact for later recovery without approval. Successful recovery still resumes the full native record. Native JSONL is scanned one row at a time and copied byte-for-byte into read-only records, including transcripts larger than 2 GiB.

`master-large-transcript-wake` covers the size boundary, live recovery failures and absent-master replacement after an injected native read error, including restart deduplication and later recovery. A failed read preserves the previous retained record; recovery retries after its source is repaired. `master-session-resumes` and `master-continues-after-failover` run fixtures with user-only Claude settings under bubblewrap, inspecting records and transcript confinement.

Use `node $GRAPHYARD_CLI guide TOPIC` for the procedure named by the brief; standing rules remain in AGENTS.md.
