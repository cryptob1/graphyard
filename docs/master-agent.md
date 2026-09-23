<!-- page: Operate Graphyard | 5 | routing, recovery, and guarded merges. -->
# Master-agent operating mode

The master is the coordinator: a `coordinator` principal run as the durable `master run` loop plus an optional visible master session. It reads Graphyard, watches Herdr session health, routes ready work, launches the independent reviewer and the proof producers the control plane requests for every submitted head, handles findings and handoffs, requests guarded merges, and administers the managed repository's GitHub App, installation, and branch protection — through the API when it can and through the human operator's own browser profile when only a GitHub page can do it. It does not implement work, hold worker leases, review candidates, or produce evidence.

Graphyard remains the source of truth. Herdr only reports live session health. Terms follow the [glossary](glossary.md).

## Autonomy: agents approve agents

Autonomy is the default. The master acts without asking; the human operator sets goals and priorities, and keeps only two other decisions: spending money or opening third-party accounts, and issuing credentials to people (approving a GitHub sudo prompt on their own device is one). Every other decision names the agent that makes it and the independent agent that approves it ([who decides](glossary.md#who-decides)):

- **Intent the master applies alone**, as its own operator-agent identity: `master create FILE REASON`, `master release GY-N REASON`, `master unblock GY-N REASON`, and `master requirements GY-N FILE REASON` for additions. None of it weakens anything, and the reviewer and proof producers judge every candidate that follows.
- **Two-party decisions**, requested by the master and approved by the separate approver agent: requirement rewrites and removals, escalation resolution, `manual:` attestation, rework and containment recovery (attesting the previous worker stopped), proof grants to a producer, and merge approval when automatic merging is off. Request with `master decide GY-N ACTION [JSON|@FILE] REASON`, launch the approver session with `master approver GY-N DECISION`, and read the outcome with `master decisions GY-N`. The approver runs `master approve GY-N DECISION REASON` from its own session, or `master refuse GY-N DECISION REASON` to decline it: a decline is recorded, never expressed by exiting. The server refuses self-approval and any approver that held an assignment on the item, produced the evidence the decision rests on, or would receive the grant, naming the conflict. See [two-party decisions](operator-automation.md#two-party-decisions).
- **Routine operations**: principal-roster rotation for agent principals (`master principals` previews it and refuses to drop a live principal or change its role; `--apply` deploys it), restarting the durable loop (`master restart`), GitHub administration through the API and the browser flows, dispatch, review and proof shepherding, and the guarded merge.

Onboarding provides the identities once: `master autonomy --admin-token-stdin --apply` provisions the master's operator-agent identity and the approver identity and installs the master's harness rules; dispatch installs each worker's own rules in its worktree, so a worker pushes its assigned branch and opens its pull request without a keypress. Every attention item in `master status` carries `attentionOwner` — the resolving `role` (`master`, `reviewer`, `control plane`, or `human` only for the three human-only decisions), whether the approver agent must approve, and the `next` command — and `attentionItems` lists them all. Never ask a human to run a command an agent identity is permitted to run.

## Install

Requires Node 24, Herdr 0.7.1 or newer, a Graphyard checkout, and GitHub CLI authenticated as an identity allowed to merge the protected base branch. Muse profiles require Herdr 0.9.1 or newer, which recognizes kind `muse` natively, and an installed, provider-authenticated `muse` executable on the coordinator host.

Create a `coordinator` principal on the Graphyard server. From a clean coordinator checkout, list Herdr workspaces and bind the master to this repository's workspace:

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
herdr workspace list
node "$GRAPHYARD_CLI" master init \
  --url https://YOUR-GRAPHYARD-HOST \
  --herdr-workspace HERDR_WORKSPACE_ID \
  --browser-profile Default \
  --token-stdin
node "$GRAPHYARD_CLI" master start codex
```

At the token prompt, paste the token, press Enter, then press Ctrl-D to send EOF. Use `master start claude` if preferred. Setup preserves existing repository instructions and stores the coordinator token outside the repository.

`master init --browser-profile PROFILE` names the Chrome profile (`agent-browser profiles` lists them) or profile directory that is signed in to GitHub as the repository administrator. It is what lets the master perform [GitHub administration through the browser](#github-administration-through-the-browser) instead of handing those clicks back to you; `--browser-executable PATH` selects a non-default Chrome. Without it the master must still ask you for App permission updates, installation acceptance, and page-only protection changes.

`master start` also installs the master's own harness permissions for harnesses that have a command classifier. See [harness permissions](#harness-permissions).

Run the coordinator under a dedicated OS identity or machine. Worker sessions running as the same OS user may read its GitHub CLI credentials; Graphyard tokens cannot create a filesystem boundary.

## Add a worker

Use a template:

- [Codex](../examples/master/codex-worker.json)
- [Claude](../examples/master/claude-worker.json)
- [Cursor](../examples/master/cursor-worker.json)
- [Muse](../examples/master/muse-worker.json)
- [existing session](../examples/master/existing-worker.json)

Keep profile files in the ignored `.graphyard/profiles/` directory so the master can write them itself. A launch profile points to a mode-0600 worker-token file outside every repository worktree:

```sh
node "$GRAPHYARD_CLI" master worker add /path/to/profile.json
node "$GRAPHYARD_CLI" master status
```

Provider login and Graphyard identity are separate. Profiles cannot contain Graphyard variables or secret-looking environment values.

Every launch profile carries an approval mode; see [approval modes](#approval-modes).

`launch` profiles are supervised and can receive new work. `existing` profiles add health visibility for a session that already owns work; Graphyard will not inject a new assignment into an unsupervised process.

### Muse

Muse is an adapter at the runtime boundary, not a second control plane. A profile with `kind: "muse"` (template: [`muse-worker.json`](../examples/master/muse-worker.json)) goes through exactly the path every other launched runtime takes:

1. `master dispatch` reads the profile's own mode-0600 worker credential and refuses one that does not authenticate as that profile's principal with the `worker` role;
2. the claim and the assigned worktree are created under that credential alone — the tab receives `GRAPHYARD_TOKEN_FILE` for the Muse worker's file, never `GRAPHYARD_TOKEN`, the coordinator token, an operator token, a trusted evidence-producer token, or another worker's file;
3. Herdr starts the installed `muse` binary inside `graphyard watch`, so the supervisor heartbeats the lease, filters server credentials out of the environment, and terminates the process on lease loss or epoch supersession;
4. the prompt is delivered only after Herdr reports the session ready; a launch that never becomes visible, blocks before it is ready, or refuses the prompt is closed and its epoch released, and one Herdr cannot confirm closed keeps the epoch fenced.

Prerequisites: Herdr 0.9.1 or newer and a `muse` executable on the coordinator host that is already logged in to its provider (`muse login`); provider credentials live in that login, never in the profile. Graphyard generates no `auto` startup contract for Muse yet, so the template carries Muse's own non-interactive flags in `agentArgs` (`--approval-mode never --trust-workspace`); `master worker add` reports that Graphyard added nothing. Muse's OS sandbox stays on with those flags; use `--yolo` in `agentArgs` only when that trade-off is acceptable for the profile.

Herdr reports a Muse session as `working`, `idle`, `blocked`, `done`, or absent, which `master status` shows as `offline`. Those states are health telemetry only: a working session does not extend a lease, an exited or missing session does not release one, and a session named after a principal does not become its owner. Graphyard's authenticated lease and epoch remain the sole ownership and lifecycle authority; a `blocked`, `done`, or `offline` session under an active lease is flagged for attention, and an expired lease shows no owner regardless of what Muse reports.

There is no supported unsupervised path: do not start `muse` directly for dispatched work, adopt an already-running Muse session with an `existing` profile (it stays observable only), reuse the coordinator credential, or grant the Muse worker principal operator or trusted evidence-producer authority.

Local dispatch requires Linux with a working systemd user manager for durable containment. On macOS or Linux without user systemd, route work to a separately supervised remote worker instead.

## Agent environments

A Graphyard principal and a provider account are different things: the principal is who claims, reviews or proves; the account is whose subscription the session spends. An *agent environment* is one isolated config and login home for one agent CLI account — `~/.coding_agents/claude-b` is Claude Code under `CLAUDE_CONFIG_DIR`, `codex` is Codex under `CODEX_HOME`, `opencode-a` is OpenCode under `XDG_DATA_HOME`, `cursor-a` is Cursor under `CURSOR_CONFIG_DIR`. [Onboarding](onboarding.md#agent-environments) discovers or creates them and generates profiles from the logged-in ones:

```sh
node "$GRAPHYARD_CLI" master environments [--create claude,codex] [--directory DIR] [--apply]
```

A profile lists the environments it may run on in `accounts`, in failover order. Worker, reviewer and producer profiles all take it; the generated ones list every logged-in environment.

**Before every launch** — `master dispatch`, the durable loop's worker dispatch, and the automatic reviewer and producer launches alike — the launcher checks the profile's accounts in order and runs on the first that is healthy:

- *logged in*: the environment holds the runtime's login (for Claude, a subscription login in `.credentials.json`);
- *quota left*: no provider usage window at or above `run.quotaCeilingPercent` (default 95) that has not reset yet. Claude's 5-hour and 7-day windows come from the provider's usage endpoint; Codex's from the rate limits its newest session recorded. OpenCode and Cursor expose no quota Graphyard can read, so theirs is `unknown`, which does not block a launch. An unreadable quota is `unknown` too.

An account that fails either check is skipped with its reason — `claude-a quota is exhausted (7d window at 100% until …; ceiling 95%)`, `claude-b is not logged in` — and the launch **fails over** to the next account. A session on another runtime's account runs that runtime, without the profile's own `agentArgs` (they belong to its runtime). A worker profile none of whose accounts can launch claims nothing and is unavailable in `master status` (`workers[].credential`, with each account's reason), so the loop routes the item to another profile. Automatic review fails over from `run.reviewerProfile` to the other reviewer profiles, and a producer request to the next independent producer profile; the tick records which profiles it skipped.

`master status` shows, under `dispatch.accounts`, every environment as the last launch check saw it (login, quota, usage windows, the login command when it is logged out) and the recent launches that skipped an account, with role, profile, item and reason. The same record is kept beside the coordinator credential (`*.environments.json`, mode 0600); it never holds a provider token.

### The agent registry

The fleet is control-plane state. The **agent registry** stores the *runtimes* (each agent CLI with its launch contract), the *accounts* of each runtime (a credential held by reference — host and login home — with the quota state and reset time executors observed), the *model* each account runs with its cost and capability, and the *roles* — `worker`, `reviewer`, `producer`, `approver`, `escalation-handler` — each naming its eligible accounts in preference order with a concurrency limit. It is configured through the API (`/api/agent-registry`), `graphyard master registry …`, and the dashboard's Agent fleet page, by the admin or the coordinator identity; [onboarding](onboarding.md#configure-the-fleet) adds a runtime, an account and a role in that order, and `master registry propose --apply` builds the whole thing from the logins a host already has. Changing the fleet is the master's own call, not the operator's — logging an account in, or buying one, is the only human part.

**Selection.** When an executor runs an action — a worker dispatch, a reviewer or producer launch, an approver session — it probes the logins on its own host, reports what it saw, and asks the control plane for a session. Inside the coordination transaction the control plane folds those observations in, closes sessions whose work has moved on, and picks **the first account of the role, in the role's order,** that is enabled, placed on the asking host, logged in, within quota, and under its session limit, provided the role is under its concurrency limit. It records the choice as an `agent-registry.selected` event with its reason and every account passed over (`claude-c is the first eligible account for worker (preference 3 of 4; 2 of 4 concurrent) — passed over codex-a quota is exhausted until …; claude-b is not logged in`), and a refusal once per distinct reason. The launch then uses the registry runtime's contract and the account's model; the profile contributes only the Graphyard identity (and its own `agentArgs` when it is the same runtime). Because selection is serialized in the control plane, the limits hold across every executor host.

**Live sessions** need no bookkeeping by the executor: a worker session lives as long as its item's lease, a reviewer or producer session as long as the request it answers stands, an approver session for thirty minutes, and every session through a five-minute launch grace. A launch that fails gives its session back at once, on every path — worker, reviewer, producer and approver alike — for every failure after the choice: a credential mismatch, a token mint, a session harness, a Herdr tab, a prompt the runtime never took. And a request supersedes the session it replaces before any limit is counted: a relaunch for the same work — the next attempt of a request, a review of a new head — takes over the slot of the session it follows (a producer within its own proof group, so the groups of one item still run side by side), so a role is never refused by the session of its own previous attempt. The one end the control plane cannot infer — a launcher killed mid-flight, a host that went away — is `master registry session end ID --reason …`.

**No restart, no file edit.** Nothing is cached between actions, so adding an account, marking one exhausted, reordering a role or removing a whole runtime takes effect on the next action of a running `master run`. An operator's exhausted mark holds against the probe until its reset or until it is cleared; a probe-observed exhaustion clears itself when its window resets. If the control plane cannot be reached, a role the registry decides launches nothing until it answers — an outage never hands a role back to a file. A role the registry does not define yet launches from the profile's own `accounts` as described above, which is how an installation migrates role by role; `master status` says so under `fleet.next` while no role is configured.

**Visibility.** `master status` reports the registry under `fleet`: per account its runtime, model (id, cost, capability tier), host, role eligibility with its place in each role's order, live sessions, login, quota, usage windows, reset time, and `ineligible` — the reason it cannot take a session now; per role the account its next action would run on, or what blocks it; the recent selections with their reasons; and the recent refusals. A blocked role, an account that serves no role, and an unconfigured role are raised as `fleet` attention items the master resolves itself with `master registry`. The dashboard's Agent fleet page shows the same view and carries the forms that configure it. The registry is kept on the append-only event ledger (every change and selection is an `agent-registry.*` event carrying the resulting registry), so its full history is `master registry history` and every logical backup carries it.

### Exhaustion in the middle of a session

The launch check reads an account before a session starts. An account that runs out **while its session works** does not fail: the runtime prints its provider's limit notice — `You've hit your weekly limit · resets …`, `Weekly usage limit reached … reset at …`, `You've reached your spend limit … resets on 10/8` — and the session stops there, holding its lease or its request. Until GY-89 a master noticed by reading panes and repointed profiles by hand, at 20–60 minutes each. The durable loop now does it on the cycle it sees it:

1. **Detect, from the session's own output.** For every launched worker, reviewer and producer session that Herdr reports `idle`, `done` or `blocked`, the loop reads the tail of its terminal (`herdr agent read`, last 40 lines) and matches the providers' limit notices on short single lines. The notice must also **lead** its line, behind at most a two-word label — `Error: Weekly usage limit reached`, `Claude AI usage limit reached|…`: every runtime prints its banner that way, while a session reaching the phrase through a sentence of its own (`Added a test for the rate limit reached path`) is writing prose, not printing a banner. A session that is still `working` is never judged on what it prints either, so a worker discussing usage limits is not a notice. The reset time is read from the notice: an absolute timestamp, a Unix time, a wait (`try again in 3 days 4 hours`), or a wall clock in the host's zone (`resets 3pm`, `resets Sep 26`); a notice that names none records an unknown reset rather than a guess.
2. **Keep the partial work.** For a worker on this host, uncommitted changes in the attempt worktree are committed on the attempt's own branch as `WIP: GY-N attempt E interrupted by provider quota exhaustion` — unpushed, never stashed. It is `git add -A`, so anything the attempt left in the worktree that `.gitignore` does not cover is committed with it; the commit stays local to that worktree's branch, and the next attempt reads it before it pushes anything. If they cannot be committed the worktree is reset and the record says `discarded`; an attempt never ends with changes that are neither kept nor gone. The next attempt's prompt names the commit, branch and worktree so it can cherry-pick instead of redoing the work.
3. **Hold the account.** The account is recorded as exhausted beside the coordinator credential (`*.environments.json`, `exhausted`) until its reset time — one hour when the notice named none — and every launcher skips it with that reason, including for OpenCode and Cursor accounts whose quota Graphyard cannot read. A profile that names no `accounts` is held under `profile:NAME`.
4. **Record it.** `POST /api/work/GY-N/capacity` with the coordinator credential writes a `capacity.exhausted` history entry — role, profile, account, runtime, the provider's notice, the reset time and how the partial work was kept — onto `capacity.exhaustions` of the item. For a worker the same transaction ends the attempt as `released`, so nothing waits for a lease nobody renews to lapse and no `lease-loss` is raised. The loop then stops the watch supervisor through the containment scope it recorded, which is the path that settles its own quarantine.
5. **Re-queue.** A worker's item is claimable again once that quarantine settles, and the dispatch step of the next cycle launches it on the profile's next account or on another profile — twenty seconds after detection at the default interval, inside the two-minute bound. A reviewer or producer session is ended on its ledger as `failed` with the exhaustion as its resolution and its request is launched again at once, the exhausted profile last.

Each failover is one `failover` action in `daemon.actions`, and `master status` shows the item's recent exhaustions under `work[].capacity`.

A session that exits **at launch** on the same notice — the account was spent before its session started, and the launch check did not see it — is classified by the automatic dispatcher from what its pane printed and failed over the same three ways (hold, record, relaunch on the next account) without a ledger record to end; see [a session that exits at launch](#the-dispatchers-own-state).

### When a role has no account left

When **every** launch profile of a role is unavailable for the same reason — each of its accounts is spent — that is capacity, not a launch failure. A logged-out account, an unreadable credential, or an `accounts:` name that is not a configured environment is something a master can fix in one command, so it is never capacity: the account selector carries *why* it passed each account over, and only a profile every one of whose accounts was passed over as spent reports itself out of capacity. The daemon and the automatic reviewer/producer dispatcher both key on that, so a role whose accounts are merely logged out keeps its counted launch refusal, its widening retry and its `launch-review` / `launch-producer` attention item addressed to the master, rather than reading as a wait for a provider reset that would never come.

- Every item whose next action needs that role records **one capacity escalation**: `capacity.escalations[]` with each account, its profile, its reset time and the reason, plus `retryAt`, the first reset among them. It is a `capacity.escalated` history entry, written once per distinct set of accounts and resets, never per cycle. It blocks nothing and nobody has to clear it.
- **The loop stops launching that role.** The worker dispatch step is skipped entirely, so there are no failed dispatches, no profile cool-offs and no `No worker profile can take GY-N` escalations. The automatic reviewer/producer dispatcher treats a launch that ran out of quota on every account as a wait, not a refusal: it counts toward no failure limit (a request that waited out a week-long reset still launches), and the role is not launched again until its accounts are due to be read, one minute later. The pause lasts only as long as it is true: the launch that succeeds clears it, and so does a launch the role refuses for anything else, so the summary never reports a provider reset beside a fault a master can fix now.
- **Nothing else is delayed.** Reviews, proofs, merges, deployment verification and every item that needs a different role run in the same cycle exactly as before.
- **`master status` says it in one line** per spent role, under `capacity` and as one attention item: `worker capacity is exhausted on every configured account (claude-a resets …, zai resets …); worker launches are paused until …, and nothing else is delayed; waiting: GY-7, GY-9`. Launch refusals and session retries that are only that capacity are not listed per item.
- The cycle an account reports quota again — its reset passed, or a master added a logged-in account with `master environments --apply` and `master config accounts:PROFILE=…` — the loop withdraws the escalation (`capacity.restored`) and dispatches what was waiting. Buying quota or opening a provider account remains the human's decision.

### The request is the session's first message

Every session Graphyard launches — a worker under `watch`, the reviewer and producer sessions the loop starts, the approver, the master itself — receives its instruction as the session's own first request, on the runtime's command line: Claude Code, Codex and Cursor take it as the positional prompt after their flags, OpenCode through `--prompt`. It is never typed into the running session. `herdr agent prompt` delivers text through bracketed paste, and a coding agent treats pasted text as untrusted data rather than as a request from its operator — correctly, against prompt injection — so a session launched that way often ended its first turn having refused to act, and the loop recorded it as failed with `finished (done) without trusted evidence` and spent a retry on work that was never attempted (GY-93). `master status` shows `delivery: request` on the session, or `paste` for a runtime Graphyard has no request contract for, which is still prompted after it starts.

#### How the request reaches the runtime

The request is not typed into the pane. Herdr types a launch command into an interactive shell keystroke by keystroke, and the shell redraws the line as it grows, so a request of several kilobytes took the whole start bound just to echo on a loaded host and the runtime was declared dead before it existed (GY-121). The launcher writes the request and, for a Claude Code session under a [role file](#session-harness-rules), the launch authorization to files inside the session's own checkout directory — `.graphyard/launch/NAME.request` and `NAME.role`, mode 0600, under the worker's assigned worktree, the reviewer's or producer's session checkout, or the repository root for the master, an approver and an escalation handler — and types a short command line that references them through their shared stem:

```
GY=/path/to/checkout/.graphyard/launch/NAME; claude --permission-mode bypassPermissions --setting-sources user --settings /path/to/repo/.graphyard/harness/producer-PROFILE.json --append-system-prompt-file "$GY.role" "$(cat "$GY.request")"
```

The pane's shell (a POSIX shell: bash or zsh) expands `"$(cat "$GY.request")"` before the runtime starts, so the request is still the runtime's own first argument — the positional prompt for Claude Code, Codex and Cursor, `--prompt` for OpenCode — and never a paste; a worker's line carries the same references after `node CLI watch GY-N EPOCH -- KIND`. What is typed holds only the runtime, its flags and one path, and is bounded at **512 bytes** whatever the request is: a line that would exceed it is refused before anything is typed, naming its length, which only a very long repository path, managed worktree root or `agentArgs` can cause. The files are replaced on every launch under the same name and removed with the checkout; those in the repository root stay under `.graphyard/launch/` (ignored by Git) until the next launch under that name overwrites them.

The positional request follows the profile's `agentArgs` and the role harness on the command line. A runtime that takes a variadic flag (Claude Code's `--add-dir` and `--allowedTools`, for example) would read the request as one more value of that flag if it were the last thing before the request, so `agentArgs` must not end in such a flag: put its values first and a single-valued flag (`--model …`) or nothing after it. When the launcher passes a [role file](#session-harness-rules), its flags come between the profile's arguments and the request; otherwise the request follows `agentArgs` directly.

#### The start bound reads the pane

The start bound is not a guess against a clock. The producers this was filed for died with Claude Code on screen — the request under its own `∙` spinner — while Herdr still reported the pane's runtime `unknown` at 30 seconds, and the launcher, which adopted a timed-out start only on Herdr's `working`, `idle` or `done`, closed a live session. After typing the command the launcher now reads the pane every half second — `herdr agent get` for the runtime Herdr sees occupying it and its state, `herdr pane read` for the terminal text — and distinguishes these cases. The runtime is **ready** once Herdr reports the expected kind `idle`, `done` or `working` (already at work on its request), or once Herdr reports the runtime under the pane in any state and the runtime's own screen is showing — its banner, its status line, or its spinner (`∙ ✻ ✶ ✳ ✢`) at the start of a line; the launch is reported started and Herdr's record of the pane takes the session's name (`started.detail` says which sighting it was, `the claude runtime is on screen while Herdr reports it unknown` for the case above). A runtime Graphyard has no request contract for, which is prompted after it starts, is ready only on Herdr's `idle` or `done`. It is **starting** when the launch command has been accepted and the runtime's process exists under the pane but nothing of it is drawn yet, or the runtime's banner is on screen before Herdr sees a process. It is **blocked** when Herdr reports it at a dialog before it was ever ready — the folder-trust question, an approval — which no launcher answers: refused at once, with the dialog as the pane's last line. It is **absent** when none of these holds: the command is still echoing, the shell is back at its prompt after an error, or the pane holds something else.

A runtime ready within **30 seconds** has started. One that is *starting* at 30 seconds is given more time, up to a ceiling of **120 seconds**, and the launch result says so (`started.extended`); one that is *absent* at 30 seconds, or still starting at the ceiling, is refused. The refusal names which case was seen and the pane's last non-empty line (bounded to 200 characters), never Herdr's own `agent_not_found`:

- `the claude runtime never started within 30 s in pane w1V:pR6 (command still echoing); the pane last showed: "… ❯ GY=…; claude --permission-mode …"` — the shell had not finished taking the command: the host is overloaded, or the pane was not at a prompt.
- `the claude runtime never started within 30 s in pane w1V:pR6 (no runtime under the pane); the pane last showed: "claude: command not found"` — the runtime's own error, or the shell's: the last line is what to fix.
- `the claude runtime was still starting after 120 s in pane w1V:pR6 (the claude runtime process exists under the pane, Herdr reports it unknown); the pane last showed: "…"` — the runtime's process exists but nothing of it ever reached the screen.
- `the claude runtime is blocked before it is ready in pane w1V:pR6 (Herdr reports it blocked); the pane last showed: "Yes, I trust this folder"` — a dialog the runtime raised before taking its request; what it asks is the last line.

A refused start is recorded with that reason wherever launches are recorded: the dispatcher's `failures` for a reviewer or producer request, the row's `attention` in `master status` (`Automatic producer launch for GY-N refused 1 time(s): the claude runtime never started …`), and a worker dispatch's error. The tab is closed and, for a reviewer or producer, the session checkout removed; the loop retries on its widening schedule. One case is not a refusal: a reviewer or producer runtime whose pane shows its provider's limit notice exited on it, and the automatic dispatcher fails the launch over to the next account instead, without waiting for the bound — see [a session that exits at launch](#the-dispatchers-own-state).

#### Confirmed prompt delivery

The paste path remains for the three messages that are typed into a running session: the request of a runtime without a request contract, the loop's one re-prompt of a session that has shown no activity, and the reviewer's reminder to post a verdict it already judged. Each is recorded only once its runtime visibly accepted it: Herdr submits the text and waits for the agent to leave `idle`. A runtime that reports ready before its input is (OpenCode does while its UI loads) drops the text and stays idle, which Herdr reports as a stalled prompt. A stalled prompt is delivered again, up to three times; a session that still has not taken its request is closed — for a worker, the claim is released too — and launched once more from scratch before the launch is reported refused. A session is never left idle until a timeout.

The generated `AGENTS.md` section ([onboarding](onboarding.md#3-connect-a-worker-and-herdr)) tells every runtime that reads it what those pastes are: the session's own request again, from the launcher that started it, to act on without waiting for confirmation. A Claude Code session launched under a [role file](#session-harness-rules) loads only the user settings, which leaves the repository's `AGENTS.md` out, so the launcher writes the same authorization to the session's role file and loads it on the command line (`--append-system-prompt-file`, see [how the request reaches the runtime](#how-the-request-reaches-the-runtime)).

### Acknowledgement, the one re-prompt, and never started

A launched reviewer or producer session is *running* only once it has visibly taken up its request; until then `master status` shows it as `awaiting acknowledgement` (`session.activity`, and `counts.dispatchAwaiting` beside `counts.dispatchRunning`). The loop judges that from Herdr alone: a session is acknowledged once activity — `working` or `blocked`, or a screen that keeps changing while a long command runs, which Herdr reports as `idle` for Claude Code — has been seen across thirty seconds of consecutive sightings, or once its verdict or evidence exists. One sighting proves nothing, because a refusal is often caught `working` for the seconds its answer takes; the first read of a screen is a baseline rather than a change, and a sighting that is not active closes the window.

A session still quiet `run.acknowledgementSeconds` (30–900, default 90) after its launch is re-prompted exactly once, with its request, and the record says when (`repromptedAt`); a reviewer's re-prompt is the same reminder it gets for a verdict it stopped short of posting, which carries the request for a session that never reviewed anything. The re-prompt starts the activity window afresh, and a quiet sighting closes one, so neither a second refusal nor a single later screen change can acknowledge the session. A session that then settles without its result is recorded as **`never started: …`**, with the session's own last words from its screen, when it was never acknowledged and either left Herdr or stayed quiet through a whole interval after its re-prompt; otherwise it is recorded as before, `finished (done) without …`, with its last words appended. `master status` raises a re-prompted session that is still unacknowledged as the row's `attention`.

The five-minute grace that already applies to a finished session and the configured interval are kept from cutting each other short: a session still in Herdr that has not taken up its request is never settled before its re-prompt and the interval after it, however short the grace, and the grace is what settles a session that was acknowledged or that left Herdr. With the interval at 600 seconds, a session that refuses at once stays pending through the grace, is re-prompted at 600 seconds, and is recorded never started at 1200 — not as a genuine failure at 310. The producer timeout (`run.producerTimeoutMinutes`, at least 5) is the outer bound on all of this and expires a session regardless.

A never-started session is a launch that failed, not work that failed, and it does not spend the retry budget: it counts neither toward the four sessions nor toward the widening wait, and the request is launched again one minute after it closed. Three never-started sessions for one request exhaust it on their own (`retry.neverStarted`, `retry.unstartedLimit`): more launches will not fix a launcher that is not starting sessions.

## Durable loop

A chat session is a poor coordinator. Its transcript grows without bound, it dies with its
provider's credits, and recovering it needs a human to hand the role to another session. A pipeline
that waits for one is worse: measured over the eleven deliveries of 2026-09-19/20, 95% of the
create→merge time had no event anywhere in the system, and work resumed within ninety seconds every
time the master session came back. The deterministic part of coordination does not need a language
model at all, so run it as a supervised process, and let it decide the routine cases itself:

```sh
node "$GRAPHYARD_CLI" master run              # cycle until stopped
node "$GRAPHYARD_CLI" master run --once       # one cycle, for cron or a smoke check
node "$GRAPHYARD_CLI" master run --interval 30
```

Supervise it with systemd (see [`examples/master/graphyard-master.service`](../examples/master/graphyard-master.service))
or a Herdr tab. `master init` accepts the loop's settings:

| Flag | Meaning |
| --- | --- |
| `--interval SECONDS` | Seconds between cycles, 5–900; default 20 |
| `--proof-workflow FILE` | Workflow file, such as `acceptance.yml`, that the loop asks GitHub to run when a candidate is missing automatable proof |
| `--deployment-url URL` | JSON endpoint that reports the commit the running release serves |
| `--deployment-sha-field PATH` | Dotted field holding that commit; default `commit` |
| `--smoke-workflow FILE` | Workflow file, such as `deploy-smoke.yml`, that the loop asks GitHub to run against the live deployment once it serves a delivery whose policy sets `deploySmoke` |
| `--dispatch-interval SECONDS` | Seconds between reads of the control plane's review and producer requests, 5–30; default 10 (see [automatic dispatch at submit](#automatic-dispatch-at-submit)) |
| `--reviewer-profile NAME` | The reviewer profile automatic dispatch launches when more than one is configured |
| `--producer-timeout MINUTES` | How long a launched producer session may run before it is recorded as expired, 5–1440; default 120 |

A running loop re-reads `.graphyard/master.json` before every cycle and every dispatch tick, so
worker, reviewer and producer profiles, `herdrWorkspace`, every `run` setting (including both
intervals when `--interval` was not passed) and `autoMerge` apply without a restart: the change
is adopted on the next pass and recorded as a `config` action naming the settings that changed.
What the loop is bound to — `url`, `repository`, `baseBranch`, `githubAppId`, `hostId`,
`credentialFile`, `cliPath` and `masterAgentName` — cannot change under it. Such a change is
refused by name (`master.json changes url, which a running master loop is bound to; restart
master run to adopt it`), recorded once as an escalation, and shown under `daemon.config` in
`master status`; the loop keeps every setting it last loaded, the other changes in that write
included, until it is restarted. A file that no longer parses is refused the same way.

Each cycle:

1. **closes finished worker sessions** — a launched agent whose principal holds no active lease has
   no authority left, so its pane is closed rather than left holding a provider seat. `complete`
   ends the worker's lease, so a submitted item's session is closed here on the next cycle; a
   lease that lapses after submission, under a `blocked` report, or after your stopped-worker
   attestation is history (`lease.expired` with its cause), never an incident;
2. **decides the open worker scope requests** — a worker that needs a file outside `plannedFiles`
   records a structured request and keeps working; the loop asks the control plane to decide it on
   the cycle it appears, and a request the item itself already implies is applied to the live item
   without ending its attempt (see [scope requests the loop decides](#scope-requests-the-loop-decides));
3. **reclaims the disk finished assignments hold** — the dependency directories of worktrees whose
   assignment is delivered, superseded by a later epoch, or untouched beyond the idle bound are
   removed, before anything in the cycle asks the host for more room, on a ten-minute cadence or
   every cycle while free space is below the threshold (see [worktree disk](#worktree-disk));
4. **reclaims the items whose sessions died** — a supervised launch fences its worker in a scope
   unit, and that fence outlives the session, so a dead worker's item cannot be claimed again until
   somebody settles the quarantine. Once the lease has lapsed and the grace window has run, the
   loop verifies on the registered host that the supervisor is gone — the same probe
   `master settle-containment` runs, re-evaluated by the control plane — and settles it, so the
   next step can offer the item again. A signal it cannot verify is an escalation, never a
   settlement (see [containment quarantines](#containment-quarantines));
5. **dispatches claimable work** to a healthy worker profile, through the same launcher
   `master dispatch` uses: the worker claims under its own identity and the loop holds no lease.
   Ready items are offered [smallest planned scope first](#conflict-avoidance) within a priority,
   and an item whose `plannedFiles` overlap a claimed or unmerged item is held rather than
   dispatched — the loop never overrides a hold; only `master dispatch --allow-overlap` does;
6. **requests the routine decisions**, launches an approver session for each, and looks at every
   one of them again on every cycle until it is applied — a standing verdict, a base branch
   Graphyard could not merge in, a delivered item still fenced, and the merge itself where
   automatic merging is off (see [unattended decisions](#unattended-decisions));
7. **shepherds reviews and proofs** — the reviewer and producer sessions the control plane
   requested for each exact head are launched on the dispatcher's own cadence (see
   [automatic dispatch at submit](#automatic-dispatch-at-submit)), a request goes to the trusted
   producer workflow when automatable proof is missing and one is configured, and anything that needs
   a judgement no rule covers is surfaced in `master status` with its owner and next command;
8. **invokes only the guarded merge** for a candidate whose gates are all green. With automatic
   merging off it merges exactly the candidate an approver agent approved, and step 6 is what asked
   for that approval;
9. **verifies the deployed SHA** against what Graphyard recorded as delivered, and for a delivery
   whose policy sets `deploySmoke` records that observation on the item, requests the trusted smoke
   workflow once per deployed commit, and escalates a failed verdict with rollback guidance (see the
   [post-deployment smoke proof](github.md#post-deployment-smoke-proof));
10. **records what it could act on, what it did, and how long each passage took** — stage p50/p90
    for every open stage, delivered lead time, creation-to-deployment latency, merge-to-smoke-verdict
    post-deploy time with the failure count, scope-request latency with the longest request still
    undecided, and the four delivery latencies of [liveness and silence](#liveness-and-silence).

Every action lands in `master status` under `daemon`: the current cycle, its measurements, the
deployment observation, per-profile health, recent actions, and anything still unresolved.

The configured interval is the idle cadence, not a bound on how long ready work may sit: while
anything is actionable the loop comes back within thirty seconds, whatever `run.intervalSeconds`
says, so a long interval cannot push a claim past its dispatch budget.

### Unattended decisions

A verdict lands, a base conflicts, a session dies, a worker asks for one more file. Each has one
correct answer, and each used to wait for a master session to notice — which is where the idle time
went. The loop makes them, with the master's own two identities and no shortcut through the
separation the server enforces:

| What the loop sees | What it does | Who applies it |
| --- | --- | --- |
| A change request standing against the exact current head: a `CHANGES_REQUESTED` GitHub review of it, or an agent or Codex review carrying `verdict: changes-requested` for it and for the recorded request | Requests `rework` and launches the approver session for it, then dispatches the next attempt | The approver agent |
| A base branch the control plane could not merge into the candidate | Requests `rework` naming the conflict — only a fresh attempt can resolve it | The approver agent |
| A delivered item still fenced by a quarantine whose supervisor this host verified gone | Requests `recover` | The approver agent |
| Every gate green while automatic merging is off | Requests `merge` for that exact candidate, then merges once it is approved | The approver agent |
| A lapsed quarantine this host verifies dead | Settles it with the coordinator credential, as `master settle-containment` does | The loop |
| An open scope request from the lease that raised it | Asks the control plane to decide it; a request the item already implies is applied without ending the attempt, anything wider is refused and escalated (see [scope requests the loop decides](#scope-requests-the-loop-decides)) | The control plane |

An agent or Codex review that has not approved is not, by itself, a verdict. The observers report
`approved: false` for a review not yet dispatched, one still running, a retry, an unready pull
request and exhausted reviewer profiles, and a submission ends the worker's lease — so the loop acts
only on the structural `verdict` the observer sets where the reviewer itself asked for changes on
that exact head, and never on the refusal's reason text. A head in any other state is asked for
nothing and keeps its proof requests.

Rework and recovery carry the requester's attestation that the previous worker is stopped, and the
engine lowers the containment fence on it, so the loop attests only what it verified. It requests
neither while a lease is live, nor while a fence is inside its grace window. With the lease ended it
requests one in exactly two cases: no fence stands for the item — the worker's own supervisor
settled it at exit, or the loop settled it in step 4 — or the fence has lapsed and the same cycle's
probe on the registered host verified that epoch's supervisor gone. The request's reason states
which, because the approver cannot verify the host and judges the attestation on what the requester
says it checked. A round is requested once: a verdict or a base conflict keeps matching the head it
was found on until a new head is pushed, so once rework is requested neither asks again — a round
whose worker dies before pushing is recovered by settling its fence and dispatching, not by a second
decision. A lapsed fence the host could not verify withholds the decision: it is escalated
with the probe's refusals (`decision-withheld` for a delivered item or a fence on another host; the
step 4 containment escalation otherwise), it stays on the silence measure, and nothing is requested.

It never approves what it requested: the approver session judges from its own identity, and the
server refuses self-approval, an approver that held an assignment on the item, and one that
produced the evidence the decision rests on.

### Refused and unanswered decisions

An approver has two writes, and a decline is one of them: **a decline is recorded, never expressed
by exiting.** `master refuse GY-N DECISION REASON` (`POST /api/work/GY-N/approve` with
`{ action: "refuse", decision, reason }`) moves a `requested` decision to the terminal `refused`
state, carrying `refusal: { approver, reason, at }` in `master decisions GY-N` and a
`decision.declined` ledger entry. Like `master approve` it runs only in the approver session, under
its own `GRAPHYARD_TOKEN_FILE`: the master's session and the master's own credentials are refused
before anything is sent, and the server refuses the requester — which takes its own request back
with `master withdraw` instead — and every identity that could not have approved it.

A refused decision is not re-requestable unchanged. A new request of the same action and input is
refused, naming the refusal, the approver and its reason, unless its `REASON` cites the refused
decision's id and says something the refused request did not — the same rule as answering a
refused reconciliation. `master status` lists it under `terminalDecisions` (`state: refused`, the
reason, `refusedBy`), counts it in `counts.refusedDecisions` while it is the latest decision of its
action, and raises it for the master: `Decision … was refused by APPROVER: REASON. Answer the
refusal: …`, whose `next` is a request citing it — or acting on the refusal instead. The durable
loop never re-requests a refused decision — it settles its watch and leaves the answer to the master
— and any unchanged re-request is refused the same way, so a refusal is never silently retried. The
approver session's own request names `master refuse` for a decline; it is never told to state its
reason in its tab and stop.

A decision still `requested` whose approver session is not running — gone from Herdr, or `done` —
with no outcome recorded is **unanswered**: a stall, not a refusal. `master status` lists each under
`unansweredDecisions` with the session it was put to and its age, counts them in
`counts.unansweredDecisions`, and raises `Decision … is unanswered after AGE: approver session NAME is
not running and recorded no outcome — a stall, not a refusal`, whose `next` puts it to a fresh
approver. Nothing is concluded while Herdr cannot be read.

**A request is not the end of it.** The approver is a launched session like any other: it can die,
drop its prompt, hit an account limit, decline, or hang. The loop keeps a watch per requested
decision (`daemon.approvals` in `master status`) and on every cycle reads the decision back from the
control plane and the session back from Herdr:

| What it sees | What it does |
| --- | --- |
| The decision is `applied` | Closes the approver's finished tab and retires the watch once the item has moved on |
| The decision ended `refused` | Closes the approver's tab and settles the watch: no replacement session and no re-request. Escalates once with the approver's reason; `master status` names the refusal and the next step is the master's: answer it (see [refused and unanswered decisions](#refused-and-unanswered-decisions)) |
| Still `requested` (or `approved` but not yet applied) and the session is working, inside ten minutes | Waits |
| The session is gone, ended `idle`/`done`/`blocked` without approving or refusing — a stall, never a decline — or has worked past ten minutes | Closes it and launches a replacement — at most three sessions per decision |
| The decision ended `failed`, `stale` or `withdrawn`, or the server no longer holds it, and the item still needs it | Requests it again — at most three requests per binding, on the usual widening retry interval |
| Three sessions spent and still unjudged | Escalates once with the decision, how each session ended, and `master approver GY-N DECISION`; stops spending sessions; leaves the request standing |
| A `merge` decision standing for an earlier candidate | Withdraws it as its requester — it can never apply, and the server refuses a second request while it stands — then requests one for the current candidate |
| A decision it requested, still `requested`, that the item no longer calls for — the round was requested another way, a new head arrived | Withdraws it as its requester and closes its session, so it is never adopted for a later round on a reason that describes an older head. A decision the item still calls for but the loop cannot attest this cycle is left standing, and adopted once it can |
| Herdr or the decision history cannot be read | Concludes nothing this cycle |

Each decision's session has its own name, `graphyard-approver-<key>-<start of the decision id>`, so
the finished tab of one decision can never refuse the launch of the next on the same item; a session
a master started for the same decision with `master approver` is adopted rather than doubled. The
name is built inside the runtime's own limit — at most 32 characters, starting with a lowercase
letter, made of lowercase letters, digits, `-` and `_` — and built so that what a human reads first
survives it: the work key is kept whole and the decision id takes what the limit leaves, up to
eight characters. A key long enough to crowd the decision id out shortens the role word instead
(`gy-approver-<key>-<decision>`), because a cut-short key says less than an abbreviated role does;
only a key too long for even that carries a digest of the whole identity, so a shortened name still
names one decision only. Every other session name Graphyard generates (worker, reviewer, producer,
master, escalation handler) is built and checked the same way, where it is constructed: a profile
whose `agentName` Herdr could not launch is refused when the profile is read, not when its first
pane has already been allocated — and a proposal `master init` writes is held to that same rule, so
`master worker add` never fails on a name Graphyard itself produced. A proposed worker is named
after its repository, its runtime and which of them it is (`owner-orders-api-claude-1`); where the
repository is long enough to pass the limit the runtime and the ordinal are what stay whole, since
they are what tells one proposed worker from the other, and the repository gives way to a digest of
the whole identity (`kubernetes-sig-5fb19c57-claude-1`). A launch a runtime refuses for the name it
was given is reported as that — the limit, the name attempted and the command that retries it — and
`master status` shows the decision as awaiting an approver that could not start, with the loop's own
refusal, rather than as a decision waiting for a session nobody can find. A decision stays on the
[silence measure](#liveness-and-silence) from the moment the item needs it until it is applied: waiting on an approver is the pipeline waiting on its
own agent, a replacement session restarts that wait, and a decision nobody judges reaches the
twenty-minute attention item like any other silence. With automatic merging off the merge wait in
`daemon.escalations` names the decision and the session it is with, so it is raised again whenever
either changes. A loop with no operator-agent identity provisioned (`master autonomy --admin-token-stdin
--apply`) changes nothing about the rest of the cycle: `master run` wires the decision effects only
while the live configuration names that identity, so each routine decision becomes an escalation
in `master status` naming the two commands a master session runs instead — not a request that fails
on every retry — and provisioning the identity is picked up on the next configuration reload.

Everything else is still a judgement: how to route a novel failure, whether a requirement should
change, what a finding means. Those reach `master status` with their owner and next command.

### Liveness and silence

Two questions the installation could not answer before: is the loop cycling, and is anything
waiting on it?

**The loop's own liveness** comes first on the attention list, because a coordinator that stopped is
why nothing else on that list is moving. `master status` reports `daemon.liveness` as `running`,
`stalled` (no completed cycle for more than two intervals) or `absent` (no lock, or a lock whose
process is gone on this host), each with the command that restarts it — `master restart` — and a
supervised deployment needs no command at all: the packaged unit sets `Restart=always` with no start
limit, and the loop sends its supervisor a keep-alive after every cycle, completed or failed, so a
cycle that hangs is restarted as surely as a process that exits. That restart is reserved for a hung
process, which only the watchdog detects; a cycle that throws is not one (see
[a cycle that fails](#a-cycle-that-fails)), and a loop waiting out a failed-cycle backoff announces
when its next cycle is due, so it reads as `running` until that cycle is overdue by two intervals.
`WatchdogSec` must stay longer than two cycle intervals; a window that would restart a healthy loop
mid-cycle is recorded by name in `master status` rather than obeyed. The keep-alive is sent with `systemd-notify`, a short-lived
child the unit admits with `NotifyAccess=all`. From systemd 246 that tool waits until the manager
has processed the message, so it cannot exit before it is attributed to the unit; on an older
systemd one can be lost to that race, which is why the packaged window is 180 seconds against a
cycle of at most thirty — a healthy loop would have to lose six in a row to be restarted.

**Silence** is measured against what the loop could act on. Every cycle records both halves — the
actionable inventory (claimable work, a routine decision from the moment the item needs it until it
is applied — requested, waiting on an approver, or withheld for want of a verified attestation — a
scope request, a settleable quarantine, a mergeable candidate, a proof missing on a head no verdict
stands against, a pending base refresh, a delivery awaiting its deployment or smoke) and the
actions it took — and each subject's wait restarts when the loop acts on it and the action
succeeds. A refused action moves nothing, so it restarts nothing: a request the server refuses on
every retry reaches the twenty-minute bound like any other silence. The
longest current wait is `daemon.silence.longestIdleMs`, with the subject behind it; past twenty
minutes it becomes an attention item naming what nothing has acted on. An item nobody is waiting on
is not silence: a claimed attempt under way asks nothing of the loop.

**The delivery budgets** are measured from what the loop itself observed, cycle by cycle, so no
figure can disagree with the state it acted on. `daemon.budget` reports each one with `met` and the
reasons behind it; `met` is null while fewer than ten deliveries are measured, and a per-candidate
bound is judged on every sample. A delivery is sampled once, from the clock the loop kept while the
item was open: an item delivered before the loop watched it, or already sampled, is history and
adds nothing, so the figures are of passages this loop saw and a recorded breach is not outvoted or
evicted by the ledger's past. The verdict → rework figure is taken when the request is made,
whether or not its first approver session could be launched:

| Budget | Bound |
| --- | --- |
| ready → claim | p90 at or under 2 minutes |
| ready → first push | p90 at or under 15 minutes |
| approval → merge | p90 at or under 10 minutes over at least ten deliveries |
| mergeable → merge | 5 minutes, per candidate |
| standing verdict → rework requested | 5 minutes, per candidate |

### A cycle that fails

A rejection that escapes a cycle — the control plane's snapshot read aborting on its timeout, a
Herdr command that fails, a `.graphyard/master.json` reload that no longer parses — fails that
cycle and nothing more. The process does not exit. The cycle counter advances, the failure is
written to the cursor and logged with its cycle number, and the next cycle runs after a delay; a
cycle that hangs is the watchdog's to restart, and a cycle that threw has just proved it did not
hang. Before GY-119 the same rejection ended the process with exit status 1, costing the in-flight
cycle, the dispatcher beside it and every approver watch in memory, and under a longer network fault
the unit crash-looped at `RestartSec` cadence while `master status` advised restarting a loop that
was restarting itself every ten seconds.

**Where to read it.** `master status` reports the loop's own failures under `daemon.failures`:

| Field | Meaning |
| --- | --- |
| `consecutive` | Failed cycles since the last one that completed; the backoff and the attention item read it |
| `total` | Every failed cycle this cursor has seen, so a loop that failed and recovered still says so |
| `last` | The most recent failure: its `cycle`, when (`at`), the `phase` (`cycle` or `reload`), the `call` it escaped from (`snapshot`, `credentials`, `merge`, ... or `reload`), the runtime's `reason`, and the `delayMs` and `nextAt` chosen for the next cycle |
| `unhandled` | Unhandled rejections and uncaught exceptions the process caught and survived |
| `lastUnhandled` | The most recent of those: `origin` (`unhandledRejection` or `uncaughtException`), `reason`, and the cycle it landed during |

The journal carries the same facts as one line per event: `cycle 41 failed in the snapshot call:
The operation was aborted due to timeout; 2 consecutive failure(s), the next cycle runs in 40s at
…`, and `cycle 43 complete … recovered after 2 failed cycle(s)` when the run ends. `master run
--once` reports `failedCycles` and `lastFailure` beside `cycles` in its result.

**Backoff.** The first failure waits the configured interval, as any cycle would: one timed-out read
is not a fault. Each consecutive failure doubles the wait — 20, 40, 80, 160 seconds on the default
interval — to a ceiling of five minutes, or the interval itself when that is longer. Under a
supervisor with a watchdog the ceiling is half the watchdog window (90 seconds against the packaged
180), so a loop backing off is never mistaken for one that hung. The first cycle that completes
resets the count and the wait; `total` keeps the history.

**Attention.** Three consecutive failures raise an attention item at the head of the list, naming
the failing call and its reason — `The master loop has failed 3 consecutive cycles, the last (cycle
42 at …) in the snapshot call: The operation was aborted due to timeout` — and saying that the loop
keeps cycling in-process, with `daemon.failures` as the place to read it. Its owner is the master:
the next command is to clear what that call is refusing on (a control plane that is not answering,
a Herdr that is not running), because a restart does not clear a read that times out every time.

**Outside the cycle.** An unhandled rejection or uncaught exception anywhere in the loop process — a
detached promise in the dispatcher, an approver watch, a Herdr read nobody awaited — is caught at
the process level, logged with its origin (`unhandledRejection caught at the process level during
cycle 41 …`), counted under `daemon.failures.unhandled`, and survived. It is not a failed cycle:
the cycle it landed during completes as usual. Only a stop signal ends the loop.

### Restartability

The loop keeps a private cursor next to the coordinator credential, outside every worktree. It is
written before and after each external action, so a daemon killed mid-action leaves a record that
the next start resolves **against Graphyard, not against the cursor**: an assignment that landed is
closed, one that never landed is released for a fresh attempt, a review request for a candidate
that already has one is never sent twice, and an interrupted decision request is made again — the
request already standing on the item is adopted rather than doubled, and so is an approver session
already listed under that decision's name. Restarting is therefore always safe, and the supervisor
may restart it as often as it likes.

Whether an assignment landed is read from the attempt epoch, which only a claim advances, and never
from the presence of a submission: an item returned to the worker by `rework` keeps the previous
attempt's submission until the new attempt resubmits, so treating that as success would leave the
rework waiting for a dispatch that never comes.

One loop owns a repository at a time. A second refuses while the first is alive; a lock left by a
killed daemon on the same host is reclaimed as soon as that process is gone.

Each cycle reads the repository's Git worktree inventory. A registered worktree whose path is
missing or hidden — a proof worktree a producer removed without `git worktree remove`, or one
under a mount this process cannot see — is compared by its registered path and never stops the
loop. Producer and reviewer sessions run in Herdr, outside the unit, and create their detached
checkouts under the [managed worktree root](#the-managed-worktree-root); a unit that hides that
directory from the loop (`ProtectHome`, a private mount) would hide every checkout the loop has to
reclaim, so the example systemd unit sets neither.

### Worktree disk

Every attempt and every rework checks the repository out again, and a checkout that installs its own
dependencies costs about as much as the source it builds. Left alone that is unbounded: a long
running installation ends with hundreds of worktrees, tens of gigabytes of `node_modules`, and a
host that starts refusing writes in the middle of a cycle — reported, until the loop knew better, as
whatever command happened to notice first.

Two halves keep it bounded, and neither needs a decision from anyone.

**One install, shared.** When the launcher prepares an assignment worktree it settles the
dependency question before the session starts. An assignment worktree lives under the repository, so
the runtime's ordinary upward lookup already resolves the repository's own install: nothing is
created, and the worker's prompt says the install is there, naming it, so the attempt does not spend
its first minutes and another gigabyte installing what it already has. A worktree outside the
repository — a detached proof worktree, a checkout on another volume — resolves nothing on its own,
and is given a mirror of that install instead: a real directory of links, one per installed package,
so the repository's `node_modules/` ignore rule still covers it and the checkout stays clean.

Either way the install has to answer for that exact head: the same `package-lock.json`, byte for
byte. A head whose lockfile differs installs its own dependencies, and a worktree that already has
an install of its own is reported and left exactly as it is. The attempt still starts from a clean
checkout of its exact head — sharing never shows up as a change to it.

**Finished assignments give theirs back.** The loop removes the dependency directories of
worktrees whose assignment is finished. Scanning the worktree directory is not free, so it keeps to
a ten-minute cadence — except while the last scan found free space below the threshold, when it
reclaims on every cycle instead:

| Disposition | Meaning |
| --- | --- |
| `delivered` | the item is Done; the attempt that used the worktree is over |
| `superseded` | the worktree belongs to an epoch a later attempt replaced |
| `idle` | nothing in the working tree has changed for longer than the idle bound |
| `live` | the registered epoch still holds the lease — never touched, however idle it looks |
| `recent` | changed inside the idle bound — left for the session that may still be using it |

It removes dependency directories and nothing else. Checkouts keep their files and their Git
metadata, branches keep every commit they hold — pushed or not — and Graphyard's registered
workspace records are never written, so a reclaimed worktree is one `npm install` away from
working and no assignment loses history the control plane still refers to. What it removed, how
much room that returned, and what it kept are in `master status` under `daemon.reclaim`.

**Before the volume fills.** `master status` reports the host's free space under `disk`, with the
worktrees a reclaim would empty. Below the configured threshold it raises an attention item owned by
the master, naming the free space, what a reclaim would return and how to get more of it, while
writes still succeed. A write that does fail for want of room — a full volume or an exhausted user
quota, reported by the kernel or only in a command's own output (`pwd: write error: Disk quota
exceeded`) — is named as exactly that, with the path that could not be written, the same guidance
and the reclaim command (`graphyard master run --once`), rather than left as an unexplained command
error.

A running loop is already reclaiming, so the lever is `run.reclaimIdleHours`: lowering it makes more
worktrees disposable on the next cycle. With no loop running, `master run --once` reclaims and
cycles once. Room the reclaimer cannot return is a host that needs fewer concurrent assignments or a
larger volume, and `master status` shows which worktrees it kept and why.

Both bounds live in `.graphyard/master.json` under `run`, and a running loop adopts a change on its
next cycle:

| Setting | Meaning |
| --- | --- |
| `run.reclaimIdleHours` | How long a worktree may sit untouched before its dependency directories count as disposable, 0.25–720; default 3 |
| `run.diskThresholdGb` | Free space below which `master status` raises disk pressure, 0.1–10000; default 10 |
| `run.acknowledgementSeconds` | How long a launched reviewer or producer session may show no activity before the loop re-prompts it once, and how long after that it is recorded as never started, 30–900; default 90. An unacknowledged session still in Herdr is never settled sooner, whatever the finished-session grace (see [acknowledgement](#acknowledgement-the-one-re-prompt-and-never-started)) |

### The managed worktree root

Proof and review checkouts are not assignment worktrees, and they do not belong in the system
temporary directory: `/tmp` is a tmpfs on many hosts, so each checkout there is paid for in memory —
150–200 MB once it has installed — and shares one quota with everything else that writes there.
Graphyard owns one **managed worktree root** on durable storage instead, and every ephemeral
checkout is created under it:

- **Where.** `run.worktreeRoot` in `.graphyard/master.json`, an absolute path. Unset, it is
  `worktrees/REPOSITORY-ID` inside the installation's data directory — `$GRAPHYARD_DATA_HOME`, or
  `~/.local/share/graphyard` — one root per checkout of the managed repository, so two installations
  on one host never reclaim each other's sessions. It is never derived from the temporary directory,
  and never from `XDG_DATA_HOME`, which an OpenCode session repoints at its account home.
- **Still outside every worktree.** The root, and each directory allocated under it, passes the same
  check as every credential path: a root inside the repository, an assignment worktree or another
  checkout is refused before anything is created there.
- **One directory per session.** A launch allocates `graphyard-proof-KEY-SHA-ID` (or
  `graphyard-review-…`) under the root and records it on the session. The detached worktree is
  `checkout` inside it; the install, build output and evidence files stay beside it. The session's
  prompt names that path and no other, a sandboxed runtime may write there and to the shared Git
  directory only, and a reviewer's harness allows `git worktree add` at that one path.
- **Removed when the session resolves.** Completed, failed, expired or cancelled — and a launch that
  never became a session — the worktree's registration and the whole directory go, dependency
  directory included. A directory that could not be removed is noted on the record as
  `checkoutFailure` and taken back by the reclaim pass.
- **Reclaimed when a session died.** The loop's reclaim step also removes every session directory no
  pending producer or reviewer record owns — what a crash between launch and ledger write, or a host
  that went down mid-proof, leaves behind — once it is fifteen minutes old. Only a directory with a
  Graphyard session name directly inside the root is ever removed. `graphyard master run --once`
  runs the pass immediately; `daemon.reclaim.checkouts` in `master status` says what it took back.
  The same pass sweeps neighbouring default roots whose repository checkout is gone, and only when
  they hold nothing: every removal there is a plain `rmdir`, so a root that contains a file is never touched.

**Preflight.** `master init` verifies the root before it writes anything, and every launch repeats
the check: a tmpfs or ramfs is refused with the reason and the setting to change, and so is a volume
with less than `run.worktreeRootMinFreeGb` free. A root that does not exist yet is judged by its
nearest existing ancestor, and created by the first launch.

**Before the volume or quota is exhausted.** `master status` reports the root under
`disk.worktreeRoot` — free space, size, checkouts, and how many no live session owns — and raises an
attention item owned by the master, naming `graphyard master run --once`, when free space falls
below the minimum or the root reaches four fifths of `run.worktreeRootBudgetGb`. The budget exists
because a user quota is invisible in a volume's free space: the host that prompted this ran out at
24 GB of a 32 GB tmpfs. A root found on a tmpfs — a configuration that predates the check — is an
attention item too.

| Setting | Meaning |
| --- | --- |
| `run.worktreeRoot` | Absolute path of the managed worktree root, on durable storage outside every worktree; default `worktrees/REPOSITORY-ID` in the data directory |
| `run.worktreeRootMinFreeGb` | Free space setup and every launch require of the root's volume, and below which `master status` raises attention, 0.1–10000; default 2 |
| `run.worktreeRootBudgetGb` | Size the root may reach; `master status` raises attention at four fifths of it, 0.1–10000; default 10 |

### Scope requests the loop decides

A worker that finds it needs a file outside its item's `plannedFiles` records a structured request
and keeps its lease:

```sh
node "$GRAPHYARD_CLI" scope-request GY-N EPOCH docs/master-agent.md -- The guide documents the behaviour this item changes
```

That request is state, not prose: the paths, the reason, the requester and the epoch. The loop
asks the control plane to decide it on the cycle it appears (`POST /api/work/:id/autoscope`,
the coordinator's only scope call), and the control plane recomputes the verdict from the item
itself — never from what the caller claims — exactly as it recomputes containment death for
`autosettle`. Two kinds of request are **approved**, with the implication as the audited reason:

- **documentation this repository requires updating when behaviour changes** — `docs/`, `AGENTS.md`
  and `README.md` (AGENTS.md: *"Update the relevant guide under `docs/` when behavior changes"*),
  named file by file rather than as a whole tree;
- **source files the item's own criteria name** — a criterion that says `src/master-daemon.ts` has
  already put that file in the item's scope, whoever writes it.

The approval is a purely additive planned-files widening applied to the live item, so the attempt
keeps its lease and its containment fence exactly as an operator widening does
(the same rule an operator's own additive widening follows). Everything else is **refused and
escalated with the reason**, and the item stays blocked on its `Scope request refused: …` blocker
until an operator decides it:

- a path neither the criteria nor the documentation rule imply — that is new scope, and scope is
  the operator's to give: `graphyard master scope GY-N REASON`;
- a request that would drop planned paths, or one that rewrites criteria or proofs — that is
  intent, decided by an operator and approved by an independent agent:
  `graphyard master requirements GY-N FILE REASON`.

Withdrawing the request (`scope-request GY-N EPOCH -`) lifts the refusal it earned, and so does an
operator answering it; a blocker anyone else wrote is never touched. A request whose attempt has
lost the lease is never decided — a fresh attempt asks afresh.

The loop is measured on this. `master status` reports request-to-decision `p50`/`p90` under
`daemon.metrics.scope` with the longest still-undecided request in `scopeOpenMs`, and the loop
escalates when it breaks either bound: a p90 above five minutes over the last ten or more
decisions, or any request left undecided for more than fifteen minutes — which can only mean the
loop is not running, because a running one decides on its next cycle. Before GY-85 approving one
of these requests took a master session running a command, and GY-82's implementation sat finished
for 647 minutes waiting for it.

### Human-only waits

Agents decide everything except three things: goals and priorities, spending money or opening third-party accounts, and issuing credentials to people. A worker whose item reaches one of them does not write a prose blocker and does not keep its lease (GY-49 sat that way for hours, found only when a master read the text). Its prompt tells it to record a **typed request** and stop:

```sh
node "$GRAPHYARD_CLI" park GY-N EPOCH money-or-accounts A Hetzner Cloud project with an API token for the live-install proofs -- The proofs provision real servers; opening the account is the operator's
```

`KIND` is `goals-and-priorities`, `money-or-accounts` or `credentials-for-people`; the words before `--` are the exact thing needed, the words after it the reason. That one transaction (`POST /api/work/GY-N/park`, the lease holder only) writes `humanRequest` on the item, ends the attempt as `released`, sets the blocker `Waiting on a human-only decision (…): NEEDED`, and appends a `human.requested` history entry. The session exits holding nothing: its supervisor's next renewal is refused and it stops, no `lease-loss` is raised, and the item is not claimable. The loop names the parked item once (a `human` action) and dispatches everything else as usual.

The human sees what waits on them in one list — the dashboard's **Work → Needs you** tab, `graphyard human-requests`, `GET /api/human-requests`, and `humanRequests` in `master status` — each row with the decision, the exact thing needed, the reason, who asked, how long it has waited, and the command that answers it. In `master status` the attention item is addressed to the **human**, not to the master.

```sh
graphyard answer GY-N [REQUEST] The project exists; its token is in the ops vault under hetzner-ci
graphyard answer GY-N [REQUEST] --decline We are not opening a Hetzner account this quarter
```

Only a declared human `admin` session may answer (`POST /api/work/GY-N/answer`); an agent holding an admin credential is refused. A provided answer clears the request and its blocker in one transaction (`human.answered`), which leaves the item claimable, and **the loop dispatches it on its next cycle** — the next attempt's prompt carries the answer. No master session computes or executes anything in between. A declined answer keeps the item parked with the human's words as its blocker, for the master to re-scope.

### What the loop will not do

The loop runs on the coordinator credential, and reads the master's own operator-agent credential
for exactly the requests in [unattended decisions](#unattended-decisions) — requesting `rework`,
`recover` and `merge`. It never reads the approver's credential, never approves a decision (its own
least of all), never claims a lease, never submits evidence, never revises a requirement, never
releases backlog work, and refuses to start if its coordinator credential is also allowed to
produce evidence. Deciding a scope request is no exception: the loop asks, the control plane
decides and applies, and a widening the item does not already imply comes back refused to the loop
exactly as it would to anyone else. Besides the guarded merge, the facts it writes are its own
deployment observation on a delivered item and the settlement of a quarantine it verified on this
host, and what it observed about provider capacity ([exhaustion in the middle of a
session](#exhaustion-in-the-middle-of-a-session)), which for a worker ends the attempt the spent
account can no longer run; the smoke verdict itself comes from the workflow's producer, never from
the loop. Provider exhaustion, a failing reviewer, a missing manual proof, and an unhealthy worker profile are all
escalations, never shortcuts. A refused merge is the gate working: the loop records the refusal and
keeps cycling.

An unhealthy profile — an unreadable credential, a name already busy in Herdr, or a recent failed
launch — is routed around for a ten-minute cool-off while other profiles keep receiving work.

Judgement no rule covers belongs to the visible master session, and a decision that weakens
anything belongs to it and the approver agent together: reading a worker's report, rewriting a
requirement, choosing how to route a novel failure. The loop keeps everything mechanical running
underneath them, and asks for nothing while it can decide.

## Typed next actions and stateless executors

A master session is not the planner any more, and does not have to be running for work to move.
The control plane computes what each item needs next — one typed action with the inputs whoever
runs it needs — and keeps a durable, leased row for it; stateless executors claim those rows and
run them. The full model is in
[architecture](architecture.md#inverted-coordination-typed-actions-and-stateless-executors).

Nine kinds exist: `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`,
`reclaim`, `merge`, `verify-deployment` and `escalate`. `master status` reports them under
`actions`: what each open item needs, which executor holds which row and since when, and every
row that has waited past the five-minute idle bound. An item with nothing named needs nothing
from anybody — it is delivered, or it is waiting on another item's action (an unfinished
dependency, a predecessor's place in the merge queue).

What an item needs is named per provider, never per gate sentence. Only a `github` approval is
answered by a reviewer session an executor launches, so only that item is named `request-review`.
An item on the `codex` or `agent` [review provider](github.md#identity-bound-agent-review-providers)
is named `resync`: the control plane dispatches those reviews through its own observation job, and
waking it is what posts the request and reads the verdict back. An item whose reviewer profiles are
all exhausted is named `escalate`, because that is a reviewer-capacity decision — add a profile on
another provider, wait for quota, or select another review provider — and never an action that
waits on a reviewer which cannot run.

An item fenced by an unsettled [containment quarantine](#containment-quarantines) with no live
lease is named `escalate` for the same reason. `reclaim` asks the control plane to re-read the item
and reconcile it, which clears a lapsed lease but never lowers a fence: that takes the worker's
settlement capability, a verified containment assessment (`master settle-containment GY-N REASON`,
which the loop also applies on its own when it can verify the supervisor is gone) or an operator's
stopped-worker recovery. The escalation names which, and the `reclaim` handler refuses an item
whose quarantine still stands rather than reporting it free.

An executor holds a coordinator credential, a host name, and one handler per kind it can run.
Graphyard ships one:

```sh
node scripts/graphyard-executor.mjs                      # claim, run, report, repeat; Ctrl-C stops it
node scripts/graphyard-executor.mjs --once               # one claim-run-settle step
node scripts/graphyard-executor.mjs --kinds merge,resync  # a narrower one; run several with different kinds
```

It reads this host's `.graphyard/master.json` for the launch profiles the dispatching actions need
and authenticates with the coordinator credential named there — the same credential `master run`
uses, and nothing broader. Run as many as you like, on as many hosts; none of them is a master, and
stopping any of them costs the one claim it held. The routes underneath, for an executor written
elsewhere:

```sh
POST /api/actions/claim   {"host": "runner-3", "kinds": ["dispatch", "merge", "resync"]}
POST /api/actions/ID/settle {"result": "done", "reason": "reviewer session launched on aaaaaaaaaaaa", "executor": "runner-3"}
GET  /api/actions          # the queue, the computed actions, open requests and running sessions
```

A claim records both the executor name and the credential it was made with, and only that pair may
settle it: several executors may run behind one coordinator credential, and a settlement that named
the wrong one would be refused after the handler had already run — the claim would then expire and
the action run twice. `POST /api/work/GY-N/resync` is the one route the mechanical kinds add: it
schedules the provider reading the server already knows how to make and reconciles the item, which
is what `resync` and `reclaim` mean.

It keeps nothing between calls and knows nothing about other executors: two of them on two hosts
claiming at the same instant are serialized by the coordination lock, and the loser takes the next
row. An executor that dies mid-action renews nothing, its claim expires, another takes the row as
a further attempt, and the dead one's late settlement is refused — so nothing is run twice. A
handler that throws returns its row to the queue with the reason and a widening backoff.

### A row that keeps failing for the same reason

A retry is a bet that something about the next attempt can change, and three identical failures say
it cannot. Three consecutive failures with an unchanged reason classify the row as **stalled**
rather than retrying: it is not waiting out a transient fault, it is re-running an impossibility.
One reason that differs from the last ends the run, and the widening backoff comes back with it.

A stall is the signal for a fleet that reads as idle and is not. A row inside its backoff can be
claimed by nobody, so before this it appeared in no count and no list: on 21 September 2026 three
items each held a `request-review` action failing for the identical reason — one reviewer profile,
one fixed session name, so the second and third reviews could never be launched while the first
ran — and for ninety-seven minutes `master status` reported eight pending actions, none of them
those three, while the board showed the items at review. Where a stall is now visible:

- `master status` → `actions.stalled`, one entry per stalled row with the reason it keeps failing,
  the failures that shared it, every attempt it has made and when it is offered again;
  `actions.backoff` lists the rows waiting out a backoff and `actions.open` counts every open row,
  so `pending + claimed + settling + backingOff` accounts for all of them;
- one attention item per stall, naming the item, the action kind, the unchanged reason and the
  master as the agent that resolves it — raised as soon as the row is classified, which is inside
  the five-minute idle bound a row nobody is acting on has;
- the dashboard, on the item's own card: the step that keeps failing, how many times, and for how
  long, in place of the gate sentence the stalled action was going to clear.

Clearing the condition the reason names is the whole of the fix — reviewer or producer capacity, an
overlap ahead of a dispatch, a credential, a provider — and nothing needs a forced retry
afterwards. A stalled row rechecks once a minute whatever its attempt count, rather than waiting
out the ten-minute ceiling its attempts against the impossibility would have earned, so a condition
that clears is acted on within a minute. Backoff earned while a blocking condition stood never
outlives it.

A claim is a two-minute lease, and the handlers are not two-minute operations: a dispatch prepares
a worktree and waits on a runtime, and a guarded merge chains provider calls that each have their
own timeout. An executor that is still inside a handler says so every thirty seconds and keeps the
row:

```sh
POST /api/actions/ID/renew  {"executor": "runner-3"}
```

Only the executor named on the claim, holding the credential the claim was made with, may renew
it, and only while it is still live — a claim that already expired may have been taken by somebody
else, and renewing it would put two executors inside one action. A slow executor therefore keeps
its row; a dead one loses it within the lease, which is the difference the queue has to make.

### Running executors beside the daemon

`master run` and any number of executors can run against the same control plane. They do not
coordinate with each other and do not have to: the queue serializes the rows, and every merge is
brokered under its own **execution instance** — `principal#instance`, minted once per process
(the daemon's `daemon-…`, each executor's `executor-…`, one per interactive `master merge`). An
execution another instance holds is refused rather than resumed, so two brokers never drive one
merge even when they share a coordinator credential; the one that finds a foreign execution stands
down, its action backs off, and it retries after the first has finished or its authority has
lapsed. Nothing has to be turned off to add an executor.

The daemon claims nothing from the queue, so a window in which both ran shows deliveries the
executors settled *and* steps the daemon pushed, and the queue's own history says which was which:
a row names the executor that settled it, and a step the daemon took appears in the item's ledger
with no row at all.

An executor claims only the kinds it has a handler for, and two kinds may never have one:
`escalate` and `request-rework` are judgments made in the step itself rather than inside a session
the step starts, so the shipped executor refuses to start with a handler for either. The other seven
it ships — it launches a worker, reviewer or producer session, asks the control plane to apply the
scope rule, re-reads a pull request, brokers the guarded merge, or records a deployment reading.
Configure no escalation handling and the fleet still delivers: every language model is invoked
inside what an action starts — implementing, reviewing, producing evidence, approving a two-party
decision, resolving an escalation — and never in the loop that starts it. That is what the master
session is now for: the escalations, the findings and the two-party decisions, outside the
critical path.

### Workers pull their own work

A free worker session asks for its next assignment rather than waiting to be dispatched into:

```sh
node scripts/graphyard-pull.mjs            # ask once; exits non-zero when there is nothing to take
node scripts/graphyard-pull.mjs --watch    # keep asking every 30s until there is
```

```sh
POST /api/assignments/claim   {"host": "vishrog"}
```

The control plane offers the items it already names as needing a dispatch, in the dispatch order
it already uses, and the worker claims under its own identity through every ordinary claim rule.
An item another worker just took is skipped rather than returned as an error. Polling every
thirty seconds keeps ready-to-claim inside two minutes with no central runtime-health tracking:
nothing has to know which session is alive for work to reach it.

A pull carries an idempotency key like every other mutation, and the shipped worker keeps that one
key across every transport retry, so a pull that timed out after its claim committed replays that
claim instead of taking a second item — a worker never holds a lease nobody told it about. One key
can only ever claim one item: a concurrent retry that reaches a different offer first is refused
for reusing the key with different input and replays the assignment the winner made. Under
`--watch` a control plane the worker cannot reach at all is waited out rather than ending the
session.

### Typed requests instead of prose questions

A session that needs something records a typed request and exits, giving up its lease in the same
transaction, so the item is free instead of held at a prompt:

```sh
POST /api/work/GY-N/request
{"type": "scope-request", "epoch": 3, "paths": ["docs/"], "reason": "the guide describes this contract"}
```

Recording one is the same write as the command it replaces — a `blocker` sets the blocker the ready
gate reads, an `escalation` fences every in-flight merge — so it needs the same authority: the live
lease of the attempt that is asking, named by its epoch. Only a `note`, which moves nothing a gate
reads, may be recorded without one. Closing a request is the decider's, never the asker's: a
session cannot record a request for an approver agent or the operator and then answer it itself,
and `master status` keeps showing it until the party the record names closes it.

Each type names exactly one decider: a `scope-request` is the additive planned-files widening rule,
which the control plane applies in the same transaction the request is recorded in — the same
verdict [the scope requests the loop decides](#scope-requests-the-loop-decides) computes, so the ask is answered
before the session has finished exiting, and a refusal becomes the item's blocker; a `decision` is
an independent approver agent; a `blocker` is a tracked follow-up item; a `note` is recorded and
decided by nobody; an `escalation` is an approver agent —
unless the request names one of the three human-only decisions (goals and priorities, spending
money or opening third-party accounts, issuing credentials to people), which routes to the
operator whatever its type. `master status` lists every open request with its decider, the command
that answers it, and how long it has waited. A session that ends waiting on input instead is
recorded as failed with that reason, naming the request it should have made.

### Session handles

Every launched session records a durable handle on the item: runtime, host, Herdr workspace, tab
and pane, its transcript, and what it is working on. `master status` reports them under
`sessions`, and the dashboard drawer shows the same per item, each with the one command or link
that attaches to it — `herdr pane attach PANE` while it runs, its transcript once it has finished.
Watching a specific agent never needs a master to relay a pane identifier.

Every launcher records one: the worker dispatch (loop or executor), and the reviewer and producer
launches in automatic dispatch — the dispatcher derives the coordinator mutation it records them
with from its own configuration, so its launches are as visible as an executor's wherever it runs.
Each records what it knows —
the runtime it launched, the host, the Herdr workspace, the pane and the command that attaches to
it — and names the principal whose session it is. What a launcher cannot know, the tab the runtime
opened under its own control and the transcript the agent writes, the session records for itself
with `POST /api/work/GY-N/session`, which is the only party that has them; a handle is merged
field by field, so the two halves meet on one record.

A handle is a fact, but the attach command on it is an instruction somebody runs, so updating one
that already exists belongs to the session it names, the coordinator that launched it, or an admin.
Any other credential — a producer token on a CI runner, a worker with no part in that session — is
refused rather than allowed to mark a running session finished or replace the command an operator
is about to run.

Creating one is the same authority, for the same reason. An implementation session records its
handle under the attempt epoch it holds. A handle with no epoch is recorded by its launcher — a
coordinator or an admin — or by the session of a live dispatch request on that item, whose id the
handle carries. Nothing else may create one: otherwise a credential that merely reaches the item
could squat the predictable id of a session about to be launched, fixing the ownership on itself,
or record enough handles to push somebody's running session off a bounded list. The bound itself
retires finished handles first and never evicts a running one to make room.

A session Herdr reports blocked is waiting on input, not gone: the attempt is recorded as failed
with that reason, and the handle stays `running` carrying why, so the attach command still works
at the one moment somebody needs it.

### Session liveness is reconciled, not trusted

**The control plane reconciles session liveness; closing finished sessions is not the master's
manual duty.** A handle used to say `running` until a session, its launcher or an admin said
otherwise, and a session that died said nothing — so a crashed, killed or vanished session stayed
recorded as running for good, and every reader believed it, including the launcher's own busy check.
That is what made a dead session hold its role slot until a person noticed.

**On what interval.** The liveness sweep runs on every automatic-dispatch tick — `run.dispatchIntervalSeconds`
in `.graphyard/master.json`, 10 seconds by default and 30 at most. It is a sweep, not a reaction to
something reporting in, because a session that died reports nothing. A handle whose session the
runtime no longer reports is left alone for a 60-second grace first, counted from the first sweep
that missed it and never shorter than the handle's own age, since a session recorded at launch
appears in its runtime's listing a moment later and one listing that comes back short is not a
death. So a vanished session's record is closed within 90 seconds of the runtime dropping it, and a
session the runtime reports again in the meantime starts the grace over. `master status` reports the
bound, the closures the last tick made, how many handles are inside their grace, and any closure it
could not write back, under `dispatch.sessionReconcile`.

The sweep judges what this host's runtime answers for. A handle another host launched is left to
that host's loop — this inventory was never asked about it — and holds its slot until then, exactly
as an unreadable runtime does.

**What it closes, and with which reason.**

- **Vanished** — the runtime has not reported the pane or the session name its launcher recorded
  for the whole grace. This is how a coding session that exited is recognised: it is simply absent
  from the runtime's listing. The outcome names that it vanished, from which runtime and host, how
  long the runtime has not reported it, and how long after its last observed activity.
- **Ended** — the runtime still lists it and reports one of that runtime's terminal states
  (`src/harness.ts`), which today only Muse has (`exited-error`, `terminated`). `idle`, `done` and
  `blocked` are deliberately not terminal anywhere: each is a live session waiting at its prompt —
  Herdr reports `done` for one that finished work nobody has looked at yet, the same underlying
  state as `idle` — and that is the one moment somebody needs its attach command.
- **Superseded** — a review or proof session bound to something the item has moved past: a candidate
  that merged, an item already delivered, a head the item no longer has, or an item returned to a
  worker for rework. The outcome names which of those it was. A delivered item is closed the same
  way as any other: delivery makes an item's decisions immutable, and ending a handle it still
  carries decides nothing. An implementation session is never closed this way; its lease decides
  what it may still do.
- **Duplicate** — two live review or proof sessions for one role and head cannot both stand, so the
  older is closed naming the session that holds the slot. One item holds one live review of a head
  and one producer session per proof group of it. Implementation handles are left alone here too.

A closure is a record, never authority: it decides no gate, ends no lease, and stops no process —
the runtime already did, or the session is stalled rather than gone.

**The role slot follows the reconciled record.** A profile's concurrency is counted against live
sessions only: the runtime's own listing, plus every recorded handle the sweep has not judged over.
So a handle holds its profile's slot even before the runtime lists the session and across a restart
of the loop, and a name is busy only while a live session has it. A launcher still refuses a name
the runtime lists in any state — a name in use cannot be taken again, whatever state it is in.

**A session that is running and making no progress** is not closed, because only a reader can tell
whether it is working. It is surfaced instead: `master status` raises one attention item per session
past its role's maximum — 4h implementation, 1h review, `run.producerTimeoutMinutes` for a producer
session, 12h coordination — naming the item, the role, how long it has run, when it was last
observed doing anything, and whether the runtime still reports it live. A session that died is as
visible as one that is stuck, and neither needs a person to go looking.

**So what an operator or a master does instead of closing sessions by hand:** nothing, for a session
that finished or died — the sweep closes its record and frees its slot on the next tick, and
`graphyard master run --once` does one sweep when the loop is stopped. For a session the attention
item names as live but overlong, attach to it with the command on the handle and see what it is
doing; stop it there if it is stuck, and the record closes within the bound on its own. Never mark
another session's handle finished to free a slot: the handle belongs to the session it names, its
launcher or an admin, and the slot was never held by anything but a live session.

### A reviewer or producer request always settles

A reviewer or producer request stays `pending` in `.graphyard/reviews.json` or
`.graphyard/producers.json` until reconciliation closes its session's pane, and a pending request
refuses every later launch of that role for its item (`already pending on SHA; reconcile it with
master status before launching another`). Two rules keep a request whose session is over from
pending for good:

- **A pane that is already gone counts as closed.** When Herdr answers the close with
  `pane_not_found` — the pane was closed by hand, which is safe to do, or the runtime exited —
  reconciliation treats the session as closed, settles the request in its terminal state, and
  names that on its `resolution` (`pane … was already gone when the session was closed`), with no
  close failure recorded. A close that fails for any other reason is still a failure: it is kept on
  the request as `attention`, and the close is retried on the next pass.
- **No request outlives its own token.** A request whose `tokenExpiresAt` (a producer's
  `expiresAt`) has passed, and whose session Herdr no longer reports, is settled as `expired` on the
  next reconcile pass whatever its pane's state; a close that failed stays on the record as
  attention rather than holding it open. Reconciliation runs on every dispatch tick and every
  `master status`, so the bound is 30 seconds after the expiry. A session Herdr still lists past
  its expiry is closed, and settles once the close succeeds or its pane is gone.

**Reading a request pending past its expiry.** `master status` reconciles first, so a request
still pending there past its expiry, or holding a close failure, is genuinely stuck. It is counted
under `dispatch.sessionReconcile.stuck` (with `sessionReconcile.stuckRequests` listing each item,
request, since when and why) and in `counts.stuckRequests`, and raised as an attention item naming
the item, the request, how long it has been stuck and the remedy: close its pane in Herdr
(`herdr pane close PANE`) or stop the session it names — a pane that is already gone is fine —
and the next `master status` settles the request, as expired within 30 seconds once Herdr no
longer reports the session. The next launch for the item then proceeds on its own.

## Automatic dispatch at submit

Review and proof collection start the moment a candidate is ready for them, not when someone
notices it. The control plane and the loop each own half of that:

**The control plane records what the exact head needs.** Whenever a work item is evaluated —
a submission, a GitHub observation, evidence, a queue publication, a policy change — and its
candidate passes the build gate (submitted, observed, open, not a draft, not awaiting rework),
it records on the item, under `autoDispatch`:

- one **review request** when the policy expects a GitHub verdict and no approval binds the
  head: neither an exact approval of it nor one the merge queue [carried](#merge-queue) onto a
  Graphyard-authored tip. A head that does not contain the base tip is not requested until it
  does, because a review of it would be dismissed when GitHub recomputes the merge base. `codex`
  and `agent` policies are dispatched by the control plane through GitHub itself and record no
  request here;
- one **producer request per proof group** — `unit`, `integration`, and `manual` for the
  proofs the item lists in `producerProofs` — naming every proof of that group that no trusted
  passing evidence binds, exactly or carried. A proof whose trusted evidence already failed on
  this head is not requested again: that is a finding to route, not a run to repeat.

Every request is bound to head, base and policy revision. A head change, a base change, or a
policy revision cancels each request with the reason (`head changed from … to …`) and requests
the new head afresh unless a carried binding covers it; an observed approval, a `CHANGES_REQUESTED`
verdict, or trusted evidence satisfies it; rework, closure and merge cancel it. Each transition
is a `dispatch.requested`, `dispatch.satisfied` or `dispatch.cancelled` entry in the item's
history, and the last fifty resolved requests stay on the record under `autoDispatch.history`.

**The loop launches them within 30 seconds.** `master run` reads those requests every
`dispatchIntervalSeconds` (5–30, default 10) beside its coordination cycle and, for every open
request that has no session yet:

- launches the reviewer profile — `run.reviewerProfile`, or the only configured one — through
  the same launcher as `master review GY-N`: exact head verified, an hour-long read-only App
  token in a private `GH_CONFIG_DIR`, the runtime's approval contract pre-seeded so no keystroke
  is needed, and a prompt that polls `gh pr view --json mergeable` until GitHub has recomputed the
  merge base before the verdict is posted;
- launches one producer session per proof group on a free, independent producer profile. A
  producer profile is a `kind`, a producer credential file and an environment declared in
  `.graphyard/master.json` next to the worker profiles (`master producer add FILE`, template
  [examples/master/claude-producer.json](../examples/master/claude-producer.json)); its credential
  is verified to authenticate exactly the named principal in the producer role, and it can never
  share a principal with a worker profile, because the control plane refuses evidence from an
  identity that has implemented the item — a profile whose principal has held an assignment on
  the item is skipped for that item for the same reason. The session receives the credential as a
  path in `GRAPHYARD_TOKEN_FILE`, never as a value, works in a detached worktree of the exact
  head in the session directory allocated for it under the
  [managed worktree root](#the-managed-worktree-root), outside every Graphyard worktree, and submits each proof with `graphyard evidence` bound
  to that exact head, base and policy revision — a failing run as `fail`, never omitted. The
  launcher selects among the independent profiles up to each one's concurrency (below); with
  fewer free slots than groups the remaining groups wait and `master status` says which limit
  they wait on.

**Each role runs as many sessions at once as its profiles declare.** A reviewer or producer
profile carries `concurrency` (1–20; absent means 1): how many sessions it runs at the same time.
Concurrency is declared per role in the fleet configuration — the reviewer profiles bound the
review lane, the producer profiles the proof lane — never implied by a profile's single agent
name, which is what once serialised every review and every proof run across the whole
installation. A profile that runs one session keeps its fixed `agentName`; one that runs more
gives each session a name unique to its request (`<agentName>-<first 8 hex of the request id>`,
with the attempt appended after the first, composed inside Herdr's 32-character limit so a long
profile name gives way to a digest while the tail stays whole), so a second review on another
item launches while the first runs and the two never share a Herdr name, a tab label or a
session directory. The
dispatcher counts a profile's running sessions from Herdr's inventory on every tick — every agent
carrying one of its names, and every agent a pending ledger record of the profile names — and
launches on the first profile with a slot left; a request no profile has room for waits, and the
tick names the limit (`every reviewer profile is busy: claude-reviewer: at its concurrency limit
(3 running, limit 3)`). The limit is read from `.graphyard/master.json` before each tick like
every other profile setting, so raising it starts more sessions on the next tick without a
restart, and lowering it launches nothing new until the running sessions drain — none is stopped.
A producer's independence stays per item, never per process: a profile whose principal has held
an assignment on the item is skipped for that item however many slots it has, and the control
plane refuses that principal's evidence for the item regardless of who launched the session.

A request has **one live session at a time**: the reviewer ledger (`.graphyard/reviews.json`)
and the producer ledger (`.graphyard/producers.json`) record which request each session answers,
so a restart, a second tick or a re-read snapshot never doubles a session, and a request the
control plane satisfied or cancelled is never launched. The ledgers record launch, completion
and outcome per session: a reviewer session completes on its verdict and expires with its
token; a producer session completes when every proof of its group has a trusted outcome (or
one failed) and expires after `producerTimeoutMinutes`. Either is recorded as `failed` when
Herdr reports it finished, gone, or blocked on a prompt for five minutes without its verdict or
evidence — the resolution says which, and a blocked one says it ended waiting on input. A
reviewer session is prompted once, in place, the first time it is seen that way: the loop tells
it to post the verdict it already judged, so a session that stopped short of posting usually
answers the prompt instead of costing a relaunch, and the five minutes run from that first
sight. The master never sends that prompt by hand. A session whose head the control plane
cancelled is closed on the next tick with its token withdrawn and the reason on the record — a
head change cancels the in-flight sessions for the old head, and a pending record for such a
head never blocks the launch for the new one.

**A failed or expired session is relaunched for the same request.** It does not strand the
request until the head changes: the loop launches the request again as its next `attempt`
after a widening wait — 1, 4, then 16 minutes after the last session closed, never more than 30
— up to four sessions in all. `master status` shows each such request's `retry` (attempts, the
limit, `nextAt`, whether it is exhausted, and the last session's state and resolution) beside its
`session`, and raises it as the row's `attention` (`Producer session for integration proofs of
GY-N failed after attempt 1 of 4: …; next attempt at …`). An exhausted reviewer request is
recovered with `master review GY-N` once its cause is fixed. A session recorded `never started`
(see [acknowledgement](#acknowledgement-the-one-re-prompt-and-never-started)) is relaunched a
minute later without counting toward those four or widening the wait; three of them exhaust
the request on their own.

**A dismissed approval is not an answer.** GitHub withdraws an approval — `dismiss_stale_reviews`
is on for a protected branch, so every approval that lands just before a push becomes one, and a
recomputed merge base or a dismissal by hand does the same — and the review gate goes on refusing,
because a dismissed approval is not an approval. A session that collected one is therefore recorded
`failed`, never `completed`: unanswered, with the dismissal and its cause on the record, and
relaunched as the request's next attempt on the same widening wait as any other unanswered session.
The cause distinguishes the two, because they need different heads: dismissed *and* the head moved
(`the approval of … was dismissed and head changed from … to …`) means the request for the old head
is cancelled and the new head is reviewed afresh; dismissed *while the candidate is unchanged*
(`… was dismissed while it was still the candidate`) means the same commit is reviewed again, with
no new head and no rework round for a candidate nobody found fault with. A relaunch never reads the
dismissed review back as its own verdict: the verdicts an earlier session of the same head recorded
are skipped when the next one observes GitHub. An approval can also be withdrawn *after* its session
closed, and nothing revisits a settled record — so while a request for that exact head still stands,
a closed session carrying the approval the control plane is waiting for is re-read, and a dismissal
reopens it unanswered the same way.

**A request whose session settled without satisfying its gate is attention, not silence.** An
`APPROVED` or `CHANGES_REQUESTED` verdict answers the request — the control plane resolves it on its
next observation — but no attempt follows a settled session, so a request whose session ended with
anything else has no session running, no refused launch and no retry — nothing but a `sinceMs` climbing while the gate refuses. `master status` names each one
in `attentionItems` with the verdict that settled it, how long the request has stood and the command
that answers it (`Review request for GY-N has stood unanswered for 1h3m: its session failed with
verdict DISMISSED after attempt 4 — …`), and counts them in `counts.dispatchUnanswered`, apart from
the requests with a session actually running in `counts.dispatchRunning`. `master run` reports the
same request as `waiting` on every tick rather than skipping it in silence.

`master review GY-N [PROFILE]` **forces the next attempt** for such a request. The launch answers
the control plane's own open request for the exact current head — recorded with that `requestId` as
its next `attempt`, the earlier sessions kept in the ledger — so it is a further attempt at the
request rather than a session the record knows nothing about, and a request the loop will not
relaunch is recoverable without producing a new head. A head with no open request (the recovery path
for a refused launch) records none, as before. A producer request in the same state is recovered
through `master decide GY-N rework REASON`: the proofs its group needs are requested afresh on the
next head.

**Every launched session decides and acts on its own.** The reviewer, producer and worker
prompts require it: post the verdict, submit pass or fail evidence, or record a blocker naming
the exact command that was blocked and its error — a reviewer as a `COMMENT` review on the
exact commit, a producer as `fail` evidence, a worker with `graphyard blocked GY-N EPOCH
REASON` — and never stop to ask a human for confirmation or offer a menu of options. A session
that ends waiting on input anyway is recorded as failed with that reason (a worker blocked on a
prompt while it holds its assignment becomes a `session` action in `master status`), and a
reviewer or producer request is relaunched as above.

A launch the loop could not perform — a stale observation, a busy profile, Herdr refusing — is
recorded in the dispatch cursor beside the coordinator credential with a widening retry
(30 seconds, doubling to 10 minutes, at most twelve attempts), and `master status` raises it as
that row's `attention`. Once its cause is fixed, `master review GY-N [PROFILE]` is the recovery
path for a reviewer request past its attempts; producers retry on their own once a profile is
free.

`master status` shows it all per candidate under each row's `dispatch`: the open review and
producer requests with `requestedAt`, `sinceMs` and the recorded reason; the `session` launched
for each (profile, agent, state, `activity` — `awaiting acknowledgement` or `running` —
`acknowledgedAt`, `repromptedAt`, verdict or per-proof outcome, and how long it has run); any
`failure` standing against it; and `recent`, the last resolved requests with their resolution.
`producers` lists the pending and recent producer sessions, `dispatch` reports the dispatcher's
cadence, last tick and failures, and `counts.dispatchRequested`, `counts.dispatchRunning` and
`counts.dispatchAwaiting` total the requests, the acknowledged sessions running for them, and
the sessions still awaiting acknowledgement.

Queueing at the gates is visible without reading a session list: `concurrency` reports, per role,
`running` against `limit` (the sum of the role's profile concurrencies, with each profile's own
`running`, `limit` and session names under `profiles`), `waiting` — the open requests with no
session that nothing but a slot holds: no refused launch, no retry still backing off, no settled
session that no attempt follows, and for a producer request at least one profile independent of
the item — `longestWaitMs` with the request that has waited longest under `longest`, and `starved`
when `running` has reached `limit` with requests waiting. A role starved for ten minutes is raised
in `attentionItems` as `reviewer concurrency` or `producer concurrency`, addressed to the master
with the remedy (raise `concurrency` on a profile, or add a profile on another account), and
counted in `counts.concurrencyStarved`. How to size the limits against the worker count is in
[onboarding](onboarding.md#size-review-and-proof-capacity).

A tick whose snapshot read fails or times out is retried promptly with a widening wait, and
each consecutive failure doubles the bound on the next read (8 s, 16 s, 32 s…), up to the
dispatch interval or the 8 s base, whichever is longer. A server that has merely become slower than the bound is therefore read on a
later attempt instead of timing out on every retry and leaving the dispatcher blind for good.

### The dispatcher's own state

The dispatch cursor (`*.dispatch.json` beside the coordinator credential) is the dispatcher's
memory: its tick count, the last tick's counts and the reasons nothing launched, every refused
launch with its widening retry, and each role's capacity hold. Every string in it has a cap, and
until GY-120 the cap was checked only when the cursor was persisted: a refusal whose error text
reached the failure reason's cap (a Herdr JSON error, for one) was wrapped in a longer wait
sentence on the next tick, the sentence failed the cursor's schema, the tick failed, and the
dispatcher retried the identical tick forever — no reviewer or producer launched for *any* item,
while the tick count and the cursor's timestamp made it look alive. Three rules now hold:

- **The dispatcher bounds its own state where it composes it.** Every string it writes into the
  cursor — a tick reason, a failure reason, a capacity reason, a session resolution it wraps — is
  bounded before it is stored, and each cut is marked with an ellipsis rather than hidden. The
  bounds nest: a stored failure reason (300 characters) leaves room for the wait sentence that
  wraps it (`launch refused 12 time(s): …; no further automatic attempt`), and that sentence is
  bounded again (500) before it becomes a tick reason, so a failure reason at its cap still
  yields a valid tick. A launch that fails with a 2,000-character error is a refusal whose
  reason ends in `…`, not a tick that cannot persist.
- **A cursor that fails its schema is repaired, not fatal.** On load and again before every
  persist, a string past its cap is truncated in place and the repair is logged once with the
  path that failed (`[graphyard-dispatch] repaired the dispatch cursor while persisting it:
  lastTick.reasons[1] — 612 characters exceeded its cap of 500 and it was truncated`). A defect
  of this class degrades one reason string; it never takes launching away from the other items.
  Anything else the schema refuses — a count out of range, a missing field — is still refused,
  naming its path, and `master status` reports a cursor it cannot read as one attention item
  rather than a dispatcher silently absent.
- **A tick failure is attributed and surfaced.** A tick that cannot persist names the field it
  could not write and the request and item that field was composed for: `master status` shows it
  under `dispatch.lastFailure` (`field`, `kind`, `request`, `work`) beside `consecutiveFailures`
  and `lastSuccessAt`. Three consecutive failures raise one attention item, addressed to the
  master, saying that no reviewer or producer session is being launched for any item and why —
  the reason, and for a persist failure the field and the request behind it — with the repair
  path (`graphyard master restart` re-reads and repairs the cursor) or the fault to fix (the
  control plane, its credential, Herdr). Every request keeps reading as `waiting` meanwhile, so
  the dispatcher's own health is named before the requests it is not launching.

**A session that exits at launch is classified from its pane.** The launcher types the launch
into the pane and [reads the pane](#the-start-bound-reads-the-pane) until the runtime is ready:
`herdr agent get` answers `agent_not_found` while the runtime is not there, which says nothing
about why, and `herdr pane read` shows what the runtime printed. A runtime that printed its
provider's limit notice and exited leaves the notice under its banner, and the banner alone would
hold the start bound to its 120-second ceiling before the refusal. The dispatcher therefore
watches each launch's own reads of the pane it typed into — the pane is read no more often than
the launcher reads it, and never after the launcher closed it — and classifies from the last read:

- a **provider limit notice** (the same notices [mid-session detection](#exhaustion-in-the-middle-of-a-session)
  matches) is account exhaustion: the launch is refused at the launcher's next pause between
  polls, within seconds rather than at the bound, and the exit is recorded for the account the
  launcher selected — `profile:NAME` for a profile that names no `accounts` — and it
  fails over exactly as a mid-session exhaustion does: the account is held until the reset the notice named,
  `capacity.exhausted` is recorded on the item with `requestId`, profile, account and runtime, and
  the same profile launches again at once on its next account; a profile with no account left
  fails over to the next profile, or the role waits for capacity. The tick's launch entry lists
  each account passed over this way under `failover`, and `master status` shows the hold under
  `dispatch.accounts`. A refusal the launcher raised at its bound while the notice was on the pane
  is classified the same way; a runtime Herdr found at a dialog (`blocked`) did not exit and is not;
- **any other cause** is the refusal the launcher worded — which case it saw (`no runtime under
  the pane`, `command still echoing`, the dialog) and the pane's last words as the reason — rather
  than the CLI's error, and it is retried on the usual widening schedule. A dispatcher wired
  without an account hold records the notice itself as the refusal
  (`the session exited within seconds of its launch on its provider's limit notice: …`).

### Managing profiles

Profiles change while the loop runs; it adopts each change on its next tick.

| Command | Effect |
| --- | --- |
| `master producer add FILE` | Add a producer profile; its credential must authenticate exactly its principal as a producer |
| `master producer replace FILE` | Replace the producer profile of the same name — a new principal, credential, kind or agent name — verified like `add` |
| `master producer remove NAME` | Remove a producer profile; sessions it launched stay in the ledger and settle as usual |
| `master reviewer remove NAME` | Remove a reviewer profile; a `run.reviewerProfile` naming it is cleared with it |
| `concurrency` in a profile | How many sessions the reviewer or producer profile runs at once (1–20, default 1); set it in the profile file `add` reads or edit `.graphyard/master.json`, and the next tick honours it |

`master status` reports setup that would silently stop every launch under `setup.attention`: a
reviewer App that `master reviewer setup` registered but that was never bound (the flow stopped
before the installation was verified, or the bind failed), a bound reviewer App whose credential
file is gone, and a configured `herdrWorkspace` that Herdr no longer lists. `setup.reviewer` and
`setup.herdrWorkspace` carry the details; only the App's public facts are read from its
registration.

What this leaves the master — the loop's judgment half, or the visible session — is the
findings: read a `CHANGES_REQUESTED` verdict or a failed proof, decide whether it needs rework,
route it, and merge when every gate passes. The master handles findings, reworks and merges; it
never launches reviews or producers by hand, never approves a candidate, and never submits
evidence.

## Operate

The master is a perpetual coordinator, not a one-shot dispatcher. Whether the
mechanical steps run in the [durable loop](#durable-loop) or the visible master session
drives them by hand, keep cycling through these steps until both parts of the terminal
condition hold: (1) every in-scope work item is Done or has a genuinely external
blocker recorded in Graphyard; and (2) every merged change is deployed and
live-verified against the exact deployed release, or a genuinely external deployment
blocker is recorded in Graphyard:

1. Run `master status` and treat Graphyard as progression truth.
2. Dispatch ready work to an appropriate worker profile, in the order `schedule.order` gives
   and leaving `schedule.held` items for the item ahead of them to merge (see
   [conflict avoidance](#conflict-avoidance)).
3. Route review findings and failed proofs to rework; the reviewer and the producers for every
   submitted head are launched by the loop, never by hand.
4. Request a guarded merge only when the exact candidate passes every gate.
5. Run [deployment verification](#deployment-verification) for each delivery with
   `master verify-deployment GY-N`: the required live behavior is established against
   the exact deployed release, and local or stale observations are refused rather than
   counted.
6. Close finished agent sessions, then return to status and continue the cycle.

Ordinary review findings, rework, idle workers, and proof setup are not stopping
conditions. Resolve or route them and continue. Done marks an observed merge, not a
deployed release, so the last merge never satisfies the terminal condition before
step 5. Stop only when every in-scope work item is Done or genuinely externally
blocked, and either the exact deployed release has passed live verification or a
genuinely external deployment blocker is recorded in Graphyard.

In-scope work is every item Graphyard has released: unreleased backlog is released by the
master (`master release GY-N REASON`, in the priority order the human operator set),
so it neither blocks nor satisfies the terminal condition. A per-item blocker is the `blocked` record the lease holder writes on the
item; a session that went quiet without one is not a blocker, it is work to dispatch
again.

A deployment blocker has its own record because delivered work is immutable and
accepts no `blocked` mutation. When a delivery cannot be verified live for a
genuinely external reason — the provider will not roll out, the release endpoint is
gone, or a rollback decision is pending — record it as a follow-up work item naming
the delivered item, its merge commit, and the external cause; `daemon.deployment`
keeps listing the delivery under `pending` (or `unavailable` when no probe can
answer), and `delivered` keeps it `awaiting-deployment` or `awaiting-smoke`, until
the release serves it. Only that recorded follow-up satisfies part (2) without live
verification. An unverified deployment with no such record is never terminal, and
neither is a delivery whose release moved on before the smoke ran; see
[operations](operations.md#delivered-with-a-failed-smoke-proof) for the failure path.

### Deployment verification

Done marks an observed merge. What the running release serves is a separate fact, and
the loop establishes it after delivery with one command per delivered item:

```sh
node "$GRAPHYARD_CLI" master verify-deployment GY-42
```

It is an operational step the master performs and records after delivery, never a
pre-merge gate: nothing about it changes which candidates merge. The command

1. observes the deployed release through the loop's deployment probe (`--deployment-url`,
   or the provider's deployment record for the base branch) and refuses when nothing
   answers, when the observation is older than five minutes, or when the release does not
   yet contain the item's merge commit;
2. identifies the checkout whose CLI emits the instructions — the commit the configured
   launcher's checkout is at — and refuses a local-only reading: a checkout at any commit
   other than the deployed release, or one with uncommitted changes;
3. reads what that release emits the way the human operator would: `master guide`, and the
   `AGENTS.md` a fresh `init --url` writes into a scratch git checkout outside every
   repository, with no Graphyard credential in the environment. Both must carry the
   perpetual cycle, deployment verification as a step of it, the terminal condition, the
   exact-release requirement, the non-stopping conditions, and the finished-agent closure
   duty. This check applies when the launcher is a checkout of the managed repository —
   Graphyard verifying its own release; for another managed repository the release's
   coverage of the merge is the whole check;
4. records the observation on the delivered item as its deployment observation
   (`delivery.deployment`, and a `deployment` event in the item's history), bound to the
   exact commit observed, the merge commit it covers, the probe source, and the observation
   time. The control plane accepts one observation per delivery and refuses a second, so a
   later rollout is verified through a follow-up item, never by rewriting the record.

A refusal prints every reason, exits nonzero, and records nothing; the loop keeps cycling.
A verification that already stands for the same release reports `recorded: existing`
and writes nothing twice. `master status` shows the recorded observation under
`delivered` for deliveries whose policy sets `deploySmoke`; the item's `events` show it
for every delivery.

```sh
node "$GRAPHYARD_CLI" master status
node "$GRAPHYARD_CLI" master dispatch GY-42 codex-primary
node "$GRAPHYARD_CLI" master review GY-42
node "$GRAPHYARD_CLI" master settle-containment GY-42 "Supervisor died on provider usage limit"
node "$GRAPHYARD_CLI" master merge GY-42
node "$GRAPHYARD_CLI" master merge --all
node "$GRAPHYARD_CLI" master verify-deployment GY-42
```

Run `status` at startup, after dispatch, when a worker reports completion, and when an integration event arrives. Owners, stages, refusals, merge candidates, and pending and completed reviews come from Graphyard. Missing Herdr telemetry never erases an assignment.

`delivered` lists every delivery whose policy sets `deploySmoke`, with the recorded deployment, the smoke verdict, `postDeployMs`, `productionLatencyMs`, and — for a failed verdict — `rollback` guidance. Act on that guidance through a follow-up item; never backfill evidence or clear the failure. See [operations](operations.md#delivered-with-a-failed-smoke-proof).

For work using the [identity-bound agent review provider](github.md#identity-bound-agent-review-providers), each row carries a `review` object with the currently dispatched reviewer profile and runtime, plus the failover entries recorded for the current candidate; `counts.reviewFailover` totals the items that failed over. A reviewer runs out of quota or goes silent past its timeout, Graphyard records that and moves to the next configured profile on its own — no master action is required. When every profile is exhausted the row is flagged for attention and the review gate stays closed. That is a capacity decision for the master: add a reviewer profile on another provider (`master reviewer add`), wait for quota, or select another review provider; buying more quota is spending money, the human's call. Never treat exhaustion as an approval, and never merge around a closed review gate.

`master status` also reports facts about the installation itself under `controlPlane`: `attention` lists a GitHub App permission the installation lacks (with the installation page where the pending request is accepted), a preflight that could not verify the permissions, the number of integration jobs held on that shortfall, every capacity variable that no longer covers the configured principals (`Set GRAPHYARD_MAX_REVIEWERS=N on the deployment`, under `delegationLimits`), and how far the base branch is ahead of what production serves; `appPermissions` carries the missing entries and when they were last verified; `counts.attention` includes these items. `controlPlane.production` is the control plane's own [deployment observation](deployment.md#production-deployment-observation): the serving commit, `aheadBy`, the newest provider deployment with its status, the pending and deployed items, and the open incidents; when main is ahead the attention line reads `main is N commits ahead of production (serving …): <failing deployment reason>`. `controlPlane.build` is the commit and merge protocol the server runs, `versionSkew` is the refusal `master merge` would raise (`null` when the CLI and server agree), and `latency.mergeToProduction` is the merge-to-production p50/p90 over every delivery with an observed deployment, which the periodic measurement records beside `delivered[].mergeToProductionMs`. A permission shortfall is an administration action — the master's, through the API or the operator's browser profile — not a merge decision: the affected jobs are held rather than retried, the gates they feed stay closed, and `graphyard github-setup --update-permissions` on the machine holding the App credentials prints the exact steps. `master init` reports the same attention in its result. See [App permissions](github.md#app-permissions).

Dispatch:

1. verifies the item is claimable;
2. authenticates the selected worker profile;
3. fetches the current base;
4. claims under the worker's identity;
5. creates the assigned worktree;
6. launches the agent under `graphyard watch`;
7. cleans up and releases only when failed launch shutdown is confirmed.

Prompt delivery is an invitation, not ownership.

## Approval modes

A launched session that stops to ask "run everything?" or "trust this folder?" is a session the master cannot start without a keypress. Each profile therefore carries `approvals`:

| Mode | Behaviour |
| --- | --- |
| `auto` (default) | Graphyard adds that runtime's own non-interactive startup contract when it launches the session. |
| `prompt` | Graphyard adds nothing; a human answers the runtime's prompts in the session tab. |

| Runtime | What `auto` adds | What it removes | What it costs |
| --- | --- | --- | --- |
| Claude Code | `--permission-mode bypassPermissions` | tool-approval prompts | the command classifier stops classifying for that session |
| Codex | `--ask-for-approval never --sandbox workspace-write`, plus `-c sandbox_workspace_write.network_access=true` and `--add-dir` for what the role writes | directory-trust and per-command approval | only the workspace-write sandbox still limits a command |
| Cursor | `--force --trust` | "Run Everything" and fresh-worktree workspace trust | every proposed command runs in the assigned worktree |
| opencode | `OPENCODE_PERMISSION` allowing every permission (`*`, `edit`, `bash`, `webfetch`, `external_directory`, `doom_loop`) | every permission prompt | edits, shell commands, fetches, and paths outside the worktree happen without asking |
| Muse | nothing generated; the [template](../examples/master/muse-worker.json) passes `--approval-mode never --trust-workspace` in `agentArgs` | tool-approval and workspace-trust prompts | tool calls run without asking inside Muse's own sandbox |

The trade-off is real: an `auto` session runs whatever it decides to run inside its own worktree, under its own provider and Graphyard credentials. What it cannot do is change: it still holds only a worker credential, still works in one assigned worktree, and still cannot merge, produce trusted evidence, or weaken a requirement. Use `prompt` when a human should stay in the loop for a particular profile. A profile that already sets the runtime's own approval flags keeps exactly those; Graphyard never overrides an explicit choice.

`master worker add` and `master reviewer add` print the resolved launch contract, so what a profile will start with is visible before it starts.

Each of these is the runtime's broadest non-interactive mode. Codex keeps its sandbox, widened to exactly what the role needs: network access for every role, the repository's shared Git directory for a worker (its worktree commits there), and its own session directory under the [managed worktree root](#the-managed-worktree-root) plus that Git directory for a producer or a reviewer (a producer builds in a detached worktree there; a reviewer may read the exact head from one). The master session gets the same treatment: `master start` launches it with its runtime's broadest mode, Codex widened to the private state beside the coordinator credential. Role credentials do not change with it — a worker still holds only its worker credential file, a reviewer only its hour-long reviewer token, a producer only its producer credential.

## Independent review

The reviewer is a separate GitHub identity: not the pull-request author, and not the Graphyard control-plane App that publishes the gate check. Once it is registered and a reviewer profile exists, `master run` launches it for every submitted head on its own (see [automatic dispatch at submit](#automatic-dispatch-at-submit)); `master review` remains the launcher the loop uses and the recovery path when a launch was refused.

```sh
node "$GRAPHYARD_CLI" master reviewer setup
node "$GRAPHYARD_CLI" master reviewer add /path/to/reviewer-profile.json
node "$GRAPHYARD_CLI" master review GY-42 claude-reviewer
```

Templates: [Claude](../examples/master/claude-reviewer.json), [Cursor](../examples/master/cursor-reviewer.json), [opencode](../examples/master/opencode-reviewer.json).

`master reviewer setup` registers the reviewer App through the same local manifest flow as repository setup, with reviewer-only permissions (Metadata read, Contents read, Pull requests write). It refuses to reuse the control-plane App, stores the private key and IDs outside every worktree with mode 0600, and records only the App ID, installation ID, and slug in master configuration. `master reviewer bind FILE --key-stdin` binds an App you already created; the file carries the IDs and the PEM arrives on standard input.

`master review GY-N [PROFILE]`:

1. verifies the exact current candidate — submitted, independently observed within the last two minutes, open, not a draft, not awaiting rework, and on a policy that expects a GitHub verdict;
2. mints an installation token scoped to this repository, to read and review only, valid for at most an hour, and refuses a token that could write code;
3. writes that token to a private `GH_CONFIG_DIR` outside the repository, never to a command line;
4. cancels any pending record of the same item whose head, base, or policy revision the candidate has superseded — a session for a head that no longer exists decides nothing, so it never blocks the current head's review. A pending record for the *exact* current candidate still refuses the launch: one live session per candidate;
5. launches the reviewer profile in its own Herdr tab with a read-only prompt naming the exact head, base, and policy revision, and the commit-bound command that posts the verdict. Posting that verdict is granted to the reviewer role — the launch allows exactly that one call and the prompt says so — so the session never has to ask for it;
6. records the request in `.graphyard/reviews.json`.

`master status` reconciles pending requests: when the reviewer identity posts an `APPROVED` or `CHANGES_REQUESTED` review on that exact commit, Graphyard closes the session, removes its credential directory, and moves the record to completed — whether the verdict came on the first attempt or after the loop's retry prompt. A verdict on another commit, from another identity, or a bare comment settles nothing. An unanswered request expires with its token. A session that stopped without posting is prompted once, by the dispatch loop itself, to post the verdict it already judged — or, for a session that never took up its request, with that request — through the same [confirmed delivery](#confirmed-prompt-delivery) a paste uses; one still silent after the five-minute grace is recorded as failed, or as [never started](#acknowledgement-the-one-re-prompt-and-never-started), and the request relaunched as its next attempt (see [automatic dispatch at submit](#automatic-dispatch-at-submit)). No master ever sends that retry by hand, and no master ever edits the ledger to unstick a record.

Settling a record always withdraws its credential: the session directory is removed even when Herdr could not confirm the pane is gone, because nothing revisits a settled record, so a token left there would sit on disk until it expired on its own. What an unconfirmed pane costs instead is the record's outcome. A verdict, and a superseded head, settle the record regardless — GitHub has already proven the one, and the candidate has already replaced the other — with the close failure kept on the record and shown as `attention` in `master status`. A session that merely failed or expired, which has proven nothing, stays pending with the reason attached, so the next reconcile retries the close.

A reviewer session holds no Graphyard credential and no lease. Its verdict is an ordinary GitHub review: Graphyard's review gate still requires an approval of the current head from someone other than the author, and the merge gate still rechecks everything.

## Branch protection

GitHub's native approval requirement and a work item's review policy must agree, or one of them is unenforceable. Reconcile them after selecting or switching a policy:

```sh
node "$GRAPHYARD_CLI" master protection
node "$GRAPHYARD_CLI" master protection --apply
```

The plan prints the open items on each provider, the current review settings, and the exact changes. `--apply` patches only the review subresource, leaving the App-bound `Graphyard / merge` check, the merge queue's `strict`-off setting, and administrator enforcement as observed, then re-reads protection and refuses unless GitHub reports the reconciled state. When the operator's token cannot patch protection, or `strict` and administrator enforcement themselves need toggling, `master browser protection` makes the same reconciliation through the [browser](#github-administration-through-the-browser) and verifies it the same way.

- Open items on `github` review: at least one required approval, last-push approval, and stale-review dismissal.
- Open items on `codex` or `agent` review: native approval count zero and no last-push approval, so Graphyard's own gate decides. Both providers share this side: the split is the model's `nativeReviewRequired`, which only the `github` provider satisfies, so a policy Graphyard accepts is never one the branch cannot enforce.
- A mix of native and non-native items: refused, naming the conflicting items and their providers. Move the open items onto one provider first; leaving protection inconsistent with an open item's policy is not an option Graphyard offers.
- `strict` ("require branches to be up to date") left enabled, missing administrator enforcement or App-bound check, or a required CODEOWNERS approval: refused before any change. The [merge queue](github.md#merge-queue) needs `strict` off.

## GitHub administration through the browser

The master owns three pieces of GitHub administration for the managed repository: control-plane App permission updates, acceptance of the installation permission request those updates raise, and branch-protection reconciliation. Routine cases go through the API — `master protection --apply`, and the `gh api` reads and subresource writes its harness allows. GitHub offers no API for App manifest confirmation, permission-request acceptance, or a sudo prompt, so for those the master runs `master browser FLOW`, which drives the operator's own authenticated browser profile headless through `agent-browser --profile PROFILE` on the master's behalf, and never stops to ask the operator to click. The session never runs `agent-browser` itself; the harness denies it.

```sh
node "$GRAPHYARD_CLI" master browser app-permissions
node "$GRAPHYARD_CLI" master browser installation-accept
node "$GRAPHYARD_CLI" master browser protection
node "$GRAPHYARD_CLI" master browser protection --dry-run
```

| Flow | Page | What it does | Verified afterwards by |
| --- | --- | --- | --- |
| `app-permissions` | `github.com/settings/apps/SLUG/permissions` | Raises every control-plane permission below what Graphyard needs (Metadata read, Contents write, Pull requests write, Issues read, Checks write, Administration read) and saves | `gh api apps/SLUG` reports each permission at or above the requirement |
| `installation-accept` | `github.com/settings/installations/ID/permissions/update` (or the organization's equivalent) | Accepts the pending permission request the update raised for this repository's installation | `gh api user/installations` shows the installation granting them |
| `protection` | `github.com/OWNER/REPO/settings/branches` → the classic rule for the base branch | Sets `strict` off, administrator enforcement on, and the required approval count, stale-review dismissal, and last-push approval the open review policies need, then saves | the protection plan re-read through `gh api …/protection` is consistent |

Every flow:

1. reads the current state through the API and refuses before opening a page when the change is impossible from a form (no classic rule, no App-bound check, a CODEOWNERS requirement, an App that does not yet request what the installation should accept);
2. records each page action under `.graphyard/master-actions/<time>-<flow>-<id>/` — `record.json` lists every step with its arguments and result, and a numbered PNG screenshot follows every navigation and mutation;
3. verifies the outcome through the API, never by trusting the page;
4. appends an entry to the audit ledger `.graphyard/master-actions/ledger.json` (mode 0600, append-only): who (the signed-in browser login, the profile, the `gh` identity, the OS user, the host, and the coordinator principal), what (flow and target), when, before and after, the outcome (`applied`, `unchanged`, or `refused`) and whether verification passed, and the record directory. `master status` shows the last five entries under `administration`.

A browser-driven change is therefore as attributable as a CLI one, and a refusal is diagnosable from the record rather than from memory.

### The only operator interactions left

- **Device approval.** When GitHub answers with its *Confirm access* page, the flow clicks *Use GitHub Mobile*, reads the two-digit pairing code, writes it to `.graphyard/master-actions/sudo.json`, and reports it in the session output and in `master status` under `administration.sudo` with the instruction to approve the prompt on your device and choose that code. It then waits with a bounded, retrying poll — three seconds between reads, three minutes in total, and an expired code re-issued at most three times — and continues where it was once the approval lands. A prompt nobody approves fails with the code and the rerun command rather than hanging; a prompt without a GitHub Mobile option is refused rather than guessed at with a password or authenticator.
- **Human-only decisions.** Only three decisions are human-only: goals and priorities, spending money or opening third-party accounts, and issuing credentials to people. Review-provider selection, releasing backlog work, revising requirements, clearing blockers, satisfying a manual proof, authorizing rework, and approving a merge when automatic merging is disabled are [agent decisions](#autonomy-agents-approve-agents). The flows change nothing outside the three targets above.

### What the master must never do

The browser profile is the operator's identity. The master never stores, exports, or copies its cookies or saved state, never uses `agent-browser`'s auth vault, restore, or state files, and never drives the profile outside the three flows: the harness denies every direct `agent-browser` command, so the only way the session reaches the profile is `master browser`, and the only way to inspect what a flow saw is its record directory. It also never adds a repository to an installation or replaces protection through the API; installation writes happen only through `master browser installation-accept`, and protection writes only through `master protection --apply`, `master browser protection`, or a subresource `PATCH`. It never uses an administrative merge bypass, never edits a candidate or pushes code, never posts a review verdict, never mints an installation token, and never reads a worker, reviewer, or coordinator credential — those rules are denied in the harness and stated in the generated instructions.

## Harness permissions

A master running inside a harness with its own command classifier stops on its own routine commands until someone approves them. In Claude Code's auto mode the classifier goes further: it refuses branch-protection reads and writes as CI-bypass reconnaissance, installation and App permission changes as permission grants, launching a second agent as a permission grant, and browser control as self-modification — so a master without generated rules cannot perform the administration it owns. `master start claude` writes project-scoped rules to `.claude/settings.local.json` (git-ignored, machine-specific) before the session starts; `master harness claude` previews them and `master harness claude --apply` writes them. Every rule prints the reason it exists.

Allowed: the master's own CLI subcommands at their absolute path, with the reviewer launcher (`master review`) and the browser flows (`master browser`, which invoke `agent-browser` themselves) listed on their own; `herdr`; read-only `gh pr` commands; `gh api user`; `gh api` reads of the managed base branch's protection and `--method PATCH` writes to its subresources; `gh api user/installations` reads; `gh api apps/*` reads; `jq`; the audited-thread wrapper `scripts/resolve-thread.mjs`; reads of `.graphyard/master-actions/`; and writes to `.graphyard/profiles/`.

The rules also cover everything else the master owns, so no routine master action waits for a human: reading its configuration (`.graphyard/master.json`) and tuning the settings it owns through `master config FIELD=VALUE…` (loop and dispatch cadence, proof and smoke workflows, deployment URL and SHA field, reviewer profile, producer timeout, quota ceiling, and a profile's account order with `accounts:PROFILE=a,b`); restarting, starting, stopping and reading the durable loop's unit (`systemctl --user restart graphyard-master.service`, `journalctl --user -u graphyard-master.service`); deployment administration (`railway status`, `logs`, `deployment`, `redeploy`, and `master verify-deployment` for the release a delivery serves); and CI runs (`gh run list`, `view`, `watch`, `rerun`, plus `gh workflow run` of the configured proof and smoke workflows).

There is deliberately no direct edit of `.graphyard/master.json`: the file holds `autoMerge`, the merge method, and every credential and identity path, and those stay operator-only. `master config` writes the owned fields through the same validated path as the operator's own commands and refuses any other field, and the harness grants no `Edit` or `Write` rule for the file. The systemd rules name the loop's unit exactly, so no other unit can be restarted, and no allow rule lets `curl` take extra arguments — `master verify-deployment` reads the deployed release.

Denied: `gh pr merge`, `gh pr review`, any `gh api` call that merges, posts a review, mints an access token, uses GraphQL, or uses `PUT`, `POST`, or `DELETE` wherever the method flag sits (replacing whole branch protection, adding a repository to an installation, deleting protection or an installation); every direct `agent-browser` command, so the operator's profile, cookies, state, and auth vault are reachable only through the recorded flows; `git push`; and reads of the coordinator credential home, `.graphyard/connection.json`, `*.pem`, and `*.token`.

Existing entries are never removed and regeneration is idempotent. `master harness codex` prints the `trust_level = "trusted"` block for `$CODEX_HOME/config.toml` instead of editing that shared user file.

A harness allowlist is a prompt policy, not an authority boundary. The enforced boundary stays branch protection plus the App-bound Graphyard check: Graphyard's guarded merge is the only path that rechecks the exact candidate before delivery.

### Session harness rules

Claude Code loads `.claude/settings.local.json` for every session started anywhere under the repository, assigned worktrees included, so the master's rules would otherwise bind the sessions it launches: its `git push` deny would refuse a worker's push to its own branch, and its review-call deny would refuse the reviewer's verdict. Worker, reviewer and producer sessions therefore never inherit them. When the repository carries Claude project or local settings, each Claude session is launched with `--setting-sources user --settings .graphyard/harness/ROLE-PROFILE.json`: the operator's user settings plus its own role file, and never the repository's project or local settings where the master's rules live.

- **worker** — the same rules dispatch writes into the assigned worktree's own `.claude/settings.local.json`: it may `git push` its assigned branch (`origin BRANCH`, `-u`, `HEAD:BRANCH`), run its item's Graphyard commands and open its pull request; it may not force-push, push the base branch, rebase, merge, post a review or submit evidence. The worktree file alone is not enough — Claude Code still loads the repository's settings above it, master denies included — which is why the session is launched with its role file instead.
- **reviewer** — may read the diff and post the one verdict it was launched for (`gh api --method POST repos/OWNER/REPO/pulls/N/reviews`); may not push, commit, claim, submit evidence, or edit files.
- **producer** — may fetch, add and remove its detached worktree under the managed worktree root and submit evidence; may not push, commit, claim or post a review.

Every role is denied reads of credential directories, `.graphyard/connection.json`, `credentials.json`, `github-app.json`, `*.pem` and `*.token`, and every raw merge. The master's own rules are unchanged: it still cannot push. Runtimes that do not read Claude settings (Codex, Cursor, opencode) inherit no master rule and are launched with their profile arguments unchanged.

## Containment quarantines

A foreground worker runs inside a containment quarantine that its supervisor settles on verified shutdown. When the supervisor itself dies — a crash, a provider usage limit, a killed terminal — the capability dies with it and the fence stays up: the item is undispatchable, its exclusive resources stay reserved, and its requirements stay immutable until someone proves the worker stopped.

`master status` reports every such quarantine on each work row under `containment`, with `counts.quarantined` and `counts.settleableQuarantines` totalling them. For a quarantine whose workspace is registered on this coordinator's host, status also verifies it: it checks that the worker lease and the launch authority have both been expired past their grace window — measured from the lease deadline the quarantine retains, since reconciliation clears the expired lease record long before that window closes — then inspects this host for any surviving supervisor process, any process running in the assigned workspace, and any live `graphyard-watch` containment scope.

The quarantine records the exact scope unit the session was launched in and the supervisor's pid (`containment.scope`), and status reports what systemd says of that unit. Everything the recorded scope still holds fences this item, whatever a member's working directory or ancestry says. Any other live `graphyard-watch-*` scope is dismissed only when its members are positively attributed to another assignment: by the live supervisor whose pid the scope name carries, when that supervisor runs `watch` for a different work key or epoch from another workspace, or by following a member's own ancestry to such a supervisor. Another worker's scope on the same machine is therefore ordinary, even when its session has reparented away from its supervisor; an orphaned scope left by a dead supervisor is not, and it fences until an operator attests. Every process still holding the fence is listed in `containment.held`, and printed by `master settle-containment`, with its pid, cmdline and cwd — read them before stopping anything.

- `settleable: true` with no `refusals` means the supervisor is verifiably gone. Run `master settle-containment GY-N "reason"`. The control plane re-checks the deadlines and the verification before clearing the fence, and records the verification in the event ledger.
- Any `refusals` entry means something could not be proven — the host is unreachable or not the registered one, a scope or process query failed, a process is still present, or the clocks disagree. Automatic settlement refuses, and so does the control plane. Stop the supervisor yourself and use the stopped-worker attestation path: a two-party `rework` decision (`master decide GY-N rework REASON`), or `recover` once the work is delivered, approved by the approver agent.

The record it sends names every process and containment scope it found, and counts the privileged host processes that withheld inspection. Settlement lowers the fence and nothing else. It does not authorize rework, reopen delivered work, or satisfy any gate; a submitted item still needs a rework decision before reassignment. Verification is bounded by what this host can see: a supervisor launched on another machine, by another user, or outside this coordinator's systemd user manager is never reported as absent — those need the stopped-worker attestation of a two-party `rework` or `recover` decision, made after someone on that host confirms the stop. See [the protocol](protocol/containment-settlement.md) for the exact checks.

## Secure multi-machine topology

The recommended boundary is:

- master and merge-capable GitHub CLI on a coordinator machine or OS identity;
- workers on separate machines or identities;
- worker GitHub credentials can push and open PRs but cannot merge the protected branch.

Version 0.1 cannot remotely launch a supervised Herdr tab on another host. The master selects the item; the remote worker claims it through its local plugin or CLI. Local launch profiles are for trusted dogfooding or a real isolation boundary.

## Guarded merges

A master merge succeeds only when Graphyard has a current authorization for the exact PR head, base, and policy. Immediately before the GitHub call, Graphyard rechecks:

- every gate and current evidence;
- PR head, base branch, draft state, and mergeability, with the base tip read from `refs/heads/<base>` rather than the pull request's cached `baseRefOid` (see [merge queue](#merge-queue));
- CI producer identity and current-head review;
- branch protection and the App-owned required check, including that "require branches to be up to date" is off, which the merge queue requires;
- a short-lived, single-use merge execution.

The command never uses an admin bypass. Graphyard marks Done only after independently observing the matching merge. Direct or late merges remain visible violations.

### One executor per execution

A merge execution is owned by the executor instance that acquired it, never by the coordinator principal alone. The durable loop is one instance for the life of its process; each `master merge` command is one instance named by its request id, so a replay under the same `GRAPHYARD_REQUEST_ID` resumes its own execution. Every merge step names the instance, and the engine records the owner as `principal#instance` and refuses `merge-verify`, `merge-commit` and above all `merge-cancel` from any other instance, even under the same credential.

The consequence for operating: running `master merge GY-N` beside a running loop is safe, and one of the two stands down. Whichever executor reads an execution another instance holds refuses before acquiring anything — `GY-N does not have a current all-gates-passing merge authorization for this executor: merge execution … is held by graphyard-master#daemon-… until …; this executor stands down without cancelling it` — and a confirmed `Merge execution was already verified` or `already committed` refusal mid-flight makes the executor stand down the same way, leaving the execution intact for its owner or for the observation that reconciles it. A stand-down is not a fault and cancels nothing; do not retry it against the holding instance, and do not resolve it by hand. An execution its owner never finishes lapses at its expiry and reconciliation clears it; the next cycle attempts the candidate afresh.

Before any candidate is read, the broker compares the merge protocol it speaks with the one the server reports in `GET /api/status` (`build.protocol`; a server that reports none is protocol 1). A mismatch refuses with `server runs <sha>, CLI expects <sha>: deploy main first` — the deployment has not served the commit the CLI runs, typically because the container failed to start — instead of failing later with an invalid gate verification. The durable loop makes the same check at start-up and before every guarded merge. Deploy main (see [merged but not deployed](operations.md#merged-but-not-deployed)) and retry; never downgrade the CLI to match a stale server.

Use `master init --no-auto-merge` when each merge needs an explicit approval. The approval is an agent's: request `master decide GY-N merge REASON`, the approver agent approves it for the exact candidate, and `master merge` refuses any candidate without an applied merge decision matching its head, base and policy revision (`master merge --all` skips them). This preference does not weaken the checks.

## Merge queue

Candidates that pass their own gates enter a single merge queue and land in order. `master status` reports the queue directly:

- `queue` lists every entry with its `position`, `size`, `predictedBase`, `predictedTip`, `ahead` keys, `validated` flag, `waitMinutes`, and refusal `reasons`;
- each entry's `binding` says how it is bound to its published tip: `base` names the bound base and tree, whether the placement binds it exactly or as a tree-identical advance, and `carriedTo` when the base branch advanced only by such a commit; `approval` and each `evidence` entry are `exact` (bound to the tip itself), `carried` (carried across a Graphyard-authored tip, with the reviewer, original sha or evidence id) or `required` (a fresh review or proof is needed), each with the recorded reason;
- each work row carries the same placement under `queue`, and `counts.queued` totals the entries.

Only the head of the queue can hold a merge authorization, so `master merge --all` merges one entry per pass and the rest stay refused with an explicit position reason. That is normal, not a fault. Before acquiring authority, again under the acquired execution, and once more immediately before the provider call, the master rechecks that what lands is a Graphyard-published queue tip for exactly the authorized commit, and that the base branch still lets it land its tested tree: either the base is exactly the commit the candidate was validated on, or it advanced only through earlier queue merges, which leave that tree untouched. Any other advance, or an authorization with no published tip behind it, refuses the merge.

The real-base rule: every one of those checks reads the base branch's head from `refs/heads/<base>` (`gh api repos/OWNER/REPO/git/ref/heads/BASE`) and compares that commit's tree with the tree the tip was validated on. The pull request's `baseRefOid` is never consulted — GitHub caches it and refreshes it only on a push to the pull request's head, so right after a predecessor merges it still names the pre-merge base and would refuse every follower in the queue, the exact case the queue exists to make cheap. A refusal names both commits and both trees (`its head <sha> (tree <tree>) is not tree-identical to validated base <sha> (tree <tree>)`); a base whose tree differs from the validated tree is refused no matter what the pull request reports.

Entries behind the head are re-based by Graphyard, not by the worker. Do not request rework, reassign, or ask an agent to rebase a queued candidate because its position or predicted tip changed; check `queue` and the entry's refusal reason first. An entry that fails its speculative validation is ejected with a recorded reason and must be repaired and re-queued — there is no command to reinsert or reorder it. The mechanism and its invariants are in [GitHub enforcement](github.md#merge-queue).

A follower whose predecessor merges keeps its tip and bindings: the base branch advanced only by a commit tree-identical to the tip it was validated on, and the row's `binding.base.carriedTo` names that advance. When Graphyard replaces an approved head with its own authored tip, the approval and the scope-disjoint proofs carry to it under the rule in [binding carry](github.md#binding-carry-across-a-graphyard-authored-tip); a `required` binding in the row names exactly what the predecessor touched and what must be produced afresh. Launch a review or a proof only for a `required` binding, never because a tip's sha changed. GitHub dismisses reviews on Graphyard's own tip push; `master merge` re-posts a carried approval through the bound reviewer App before it acquires authority, and the result reports it under `carriedApproval`. A carried approval given by a human reviewer cannot be re-posted: the provider may then still require a fresh native approval, which the row and the merge result say.

### Speculative tips and branch protection

A speculative tip is published on the pull-request branch itself — the item's own reviewed head merged onto its predicted base — because that is the only place the required checks, the review and every proof can bind one commit. Branch protection sees each publication as a push, and on `github` review policies it is armed exactly as `master protection` declares: stale-review dismissal and last-push approval. Three consequences follow, and the control plane answers each of them rather than the reviewer or the worker.

**An approval must survive a tip publication.** The publication moves the branch head from the reviewed head to the tip, and GitHub dismisses the approval it carried. The record already answers for that: the approval carries onto the tip when the predecessor changed no reviewed file ([binding carry](github.md#binding-carry-across-a-graphyard-authored-tip)), the review gate passes on the carried binding, no review is requested for the tip, and `master merge` re-posts the carried approval through the reviewer App before it acquires authority. A publication never costs the candidate a review round; only a predecessor that touched a reviewed file does, and the row's `binding.approval` names the file. The same holds for a tip rebuilt where the reviewed head already contains its new predicted base — the entry ahead was ejected and the base branch did not move — which is the reviewed head itself, republished over the earlier tip with no commit produced (`queue.speculation.tip` equals `reviewedHead`, `merge` is null): its bindings carry by the same per-file rule, decided on the files that changed between the earlier tip's bound base and the predicted base (`queue.speculation.baseChanges`), and the reviewer App re-posts the approval on the very commit it was given on. None of this rests on how GitHub worded the dismissal: a push dismissal names the commit and no reason, and the record alone passes the gate. Between a tip's publication and its observation nothing is requested for the head it replaces, either: no review or proof request is opened for a queued entry whose published tip is not yet its observed head. What the carry does not cover is a branch restored after its own ejection: nothing carries across a restore, so an ejected entry's restored head is reviewed afresh on the proofs already bound to it.

Two limits keep the carry honest. The reviewed files are the reviewed head's own — the pull request's files while that head was observed, or what the decision that carried its bindings recorded (`carry.reviewedFiles`) — never the replaced tip's: GitHub lists a tip's files against the base branch, so a tip built behind an unlanded entry lists that entry's files too, and a rebuild after the entry's ejection would otherwise be refused for files nobody reviewed. And an approval or a proof carries only from the head the tip is built from: given on that head, or carried onto it by a recorded decision (a base refresh, an earlier tip). One given on any other commit never saw the content the tip holds, and the tip is reviewed and proved afresh.

**A merge-base dismissal is not a reviewer withdrawing a verdict.** When the base branch moves under a branch that carries a queued predecessor — the predecessor lands, or an entry ahead republishes — GitHub recomputes the pull request's merge base and dismisses the approval with `The merge-base changed after approval.`, though the head the reviewer approved is the head the branch still has. Every observation now records, on each dismissed review, GitHub's dismissal reason, the verdict the dismissed review carried, the head the approval was given on and who dismissed it (`observation.reviews[].dismissal`: `reason`, `mergeBase`, `verdict`, `commit`, `at`, `by`). `mergeBase` is true only for GitHub's exact message: a person dismissing a verdict with a message that merely mentions the merge base ("merge base moved, will re-review after rebase") withdrew it, and it is treated as withdrawn. `verdict` is read from the timeline's `dismissed_review.state` (`approved`, `changes_requested` or `commented`), because the review list shows a dismissed change request and a dismissed approval with the same `DISMISSED` state. An approval of exactly the current head, by an identity other than the author, dismissed with the merge-base reason — `mergeBase` true and `verdict` `approved` — is restored by the control plane as the binding approval — carried from the head to itself, with the reason on the record and a `review.restored` event on the ledger — so the review gate passes, no review request is opened, no reviewer session and no attempt is spent, and `master merge` re-posts the same approval through the reviewer App before the merge. A dismissal with any other message — a reviewer or an administrator withdrawing the verdict — restores nothing, and neither does a merge-base dismissal of a change request or of a review whose verdict the timeline does not name: a dismissed change request is the change request the reviewer gave, never an approval, so the gate refuses and the head is reviewed afresh, as before. `master status` names a restored approval on the row under `restoredApproval` and lists them all under `branches.restoredApprovals`; `counts.restoredApprovals` counts them. A dismissal that lands on a head whose refresh conflicted, or whose repair is requested and not yet run, restores nothing and leaves that record as it is: such a head is replaced before it could land, no review is asked for it meanwhile, and the conflict the worker owes and the pending repair stay named. Never ask the reviewer to approve the same commit again because GitHub shows its approval dismissed: read the row first.

**A branch must never keep another item's unlanded commits.** Every tip is built from the item's own reviewed head (`queue.speculation.reviewedHead`): the last head a worker pushed or the control plane brought onto the base, never the tip it replaces. A branch whose head is a tip is moved back to that head before the new predicted base is merged onto it, so the tip's parents are exactly the reviewed head and its predicted base, and a tip rebuilt behind a different predecessor carries nothing of the one it was built behind before. When an entry is ejected, the branch it leaves behind still carries its predecessors: the control plane restores it on its own — reset to the reviewed head, then merged onto the base branch exactly as a base refresh would — and the entries behind it rebuild their tips from their own heads. The prediction on the record (`queueHistory[].predecessors`, `.from`) is what tells the ejection what it owes. The record of the restore is `baseRefresh.restore` (`contaminated`, `foreign`, `own`, `cause`, `requested`, `performedAt`, `outcome`), the ledger records `branch.restored`, `branch.restore-conflict` or `branch.unrepairable`, and the restored head is observed, checked, reviewed and proved as any new head is. A restore whose merge onto the base conflicts leaves the branch at the reviewed head with the conflict named on the build gate; it is the worker's, exactly as a base-refresh conflict is. How an already contaminated branch is found and repaired is under [a contaminated branch](#a-contaminated-branch).

For the full correctness model, see [GitHub enforcement](github.md) and [architecture](architecture.md).

## Conflict avoidance

The queue lands validated tips in order, but it cannot prevent a conflict git itself reports:
whichever of two overlapping candidates lands second is sent through a sync → review → proof round.
Most of those rounds have two causes — items with overlapping `plannedFiles` built concurrently,
and shared generated files that nearly every pull request regenerated — and `master status`
reports both so the master can schedule around them.

**Overlap-aware dispatch.** An item's `plannedFiles` are a soft exclusive resource against every
item that is *claimed* (a live lease, or a quarantine still holding its assignment) or *submitted
but not merged*. Such an item is not dispatched, by the loop or by `master dispatch`; the row's
`overlap` says `held: true`, lists each item `ahead` with the overlapping `paths` on both sides, and
`schedule.held` repeats the hold with its reason. Two ready items that overlap each other hold
nothing: the first to be dispatched then holds the other. The hold is advisory with an operator
override — `master dispatch GY-N PROFILE --allow-overlap` dispatches anyway and records the
overlap in its result — and the loop never uses the override. Exclusive resources, dependencies,
blockers and quarantines refuse exactly as before; `--allow-overlap` lifts nothing else.

**Smallest scope first.** Among ready items of the same operator priority, `schedule.order` offers
the smallest planned scope first: fewest root-level directory scopes (`src/`, `docs/`, `tests/`),
then fewest directory scopes, then fewest files, then the older item. A small item that lands early
is one fewer re-integration for everything that would otherwise have waited behind it. Each row's
`scope` carries that breadth, and a root-level directory scope marks the item `highConflict`
(also listed under `schedule.highConflict`): narrow such a scope with a two-party `requirements`
decision before dispatching it beside anything else.

**Per-candidate conflict sets.** For every open candidate, `master status` runs
`git merge-tree --write-tree` between its head and each other open candidate's head — a real
three-way merge from their merge base, done in memory over the fetched PR branches — and reports
the result on the row under `conflicts`: the `candidates` it cannot merge with, the conflicting
`files` per pair, and `unprobed` candidates whose head this checkout could not fetch (never
reported as conflict-free). `conflicts.sequence` orders the open candidates fewest-conflicts
first and `conflicts.conflicting` lists every pair, so the master can sequence merges to force the
fewest re-integration rounds; `conflicts.available` and `reason` say when the fetch failed. The
probe reports what git will report at merge time; it does not judge semantic conflicts.

**Generated files never conflict.** The docs indexes are generated in full and `graphyard sync`
regenerates them, and the managed `AGENTS.md` blocks, instead of asking the worker to resolve them;
the control plane's regression guard treats the files named by `GRAPHYARD_GENERATED_FILES` as
generated rather than owned. Every remaining conflict `sync` reports names the shipped items that
landed it. See [coordination](coordination.md#generated-files-never-conflict).

## Pipeline speed

The target for a routine item — one with at most one rework round and no hand-off to a master or
operator between submit and merge — is a submit→merge p50 of at most 30 minutes and p90 of at most
60 minutes, judged over at least ten deliveries, with a median of at most one rework round. Every
step between `complete` and the merge is the control plane's or the loop's: the regression guard
refuses the revert that used to cost a rework round, the reviewer and the producers are requested
and launched on the exact head, automatable proofs run as trusted CI on the published tip, overlap
holds keep colliding items apart, and the master's only remaining part is routing a genuine finding
or taking a human-only decision. The measurement says whether that holds, and where the time goes
when it does not.

`master status` reports it in two places. Each work row's `speed` — derived from the item's own
[pipeline timeline](protocol/pipeline-speed.md) — carries `executionMs` (lease time summed over
attempts), `waitMs` (everything else since the first claim), `reworkRounds`, `interventions`
(`blocked` reports and `requirements` revisions, the hand-offs), `sinceSubmitMs` while in flight
and `submitToMergeMs` once delivered, and `routine`. The top-level `speed` is the periodic
measurement over every delivery with a recorded submission: `speed.submitToMerge` (nearest-rank
p50/p90 and count), `speed.routine.submitToMerge` (the population the target is stated for),
`speed.reworkRounds` (median, p90, distribution), `speed.interventions`, `speed.execution` (total
execution versus wait, and the execution share), `speed.unmeasured` (deliveries that predate the
timeline, reported and never estimated), and the verdict: `met` is `true` or `false` once ten
routine deliveries are measured, with `reason` naming the figure that misses, and `null` with the
count until then. `speed.items` lists the measured deliveries in merge order with their figures.

The same figures are recorded outside a status read by the measurement script, which the
3-hourly measurement runs and which `manual:speed-target-met` reads:

```sh
GRAPHYARD_URL=… GRAPHYARD_TOKEN_FILE=… node scripts/measure-pipeline-speed.mjs \
  --split GY-55,GY-64,GY-65,GY-66 --record .graphyard/measurements/pipeline-speed
```

It reads the work snapshot with any read-capable credential (the coordinator's will do), prints the
overall summary, and for each `--split` item prints the same summary for the deliveries merged
before and after that item landed, so the effect of a change is measured rather than asserted;
`--since` and `--until` bound the window, `--json` prints the whole report, and `--record DIR`
writes it as one timestamped file. The arithmetic is the module master status uses, so the two
never disagree. Deliveries before the timeline shipped are `unmeasured`; the baseline for those is
the [flow analytics](flow-analytics.md) phase durations and the ledger figures recorded on GY-54.

A missed target is routed like any other finding: `speed.items` names the slow deliveries, each
row's `interventions` and `reworkRounds` say whether the time went to a hand-off or a rework round,
and the flow analytics bottleneck summary says which wait category held the rest. Never trade a
gate, a proof, an identity rule or a lease rule for the number.

### A required check that failed on the clock

Some assertions in the required `test` check are about elapsed real time: the 2 s p95 of the
coordination snapshot, the dispatcher's recovery after a failed read, a coordination cycle inside
its interval. Their budgets are real — the loop depends on them — but a shared runner can miss one
without any defect in the candidate, and a red `test` check alone cannot say which happened. So
every such assertion goes through one helper (`tests/helpers/timing.ts`), which makes it measure
the system rather than the runner and makes its failure say what it is:

- A latency figure is steady state. Warmup reads are taken and discarded before sampling, so
  connection setup, JIT warmup and cold query plans never count, and the sample is large enough
  that the percentile is the one it names: a hundred reads leave five above the p95, where twenty
  made the "p95" the second-worst read. The budget is unchanged.
- The run records every timing-dependent assertion, passed or failed, with what it measured, its
  budget, its sample count and its distribution, as one JSON line in the file
  `GRAPHYARD_TIMING_RECORD` names. CI sets it, uploads the record as the `graphyard-timing-record`
  artifact, and lists every measurement in the job summary beside the recorded spread.
- A failure is a `[timing-dependent]` assertion error naming the measured value against the budget,
  and the `test` job annotates its own check run with it, saying how many tests failed beside the
  timing-dependent ones. The annotation changes no verdict: the check stays failed and the test
  gate stays refused until a run passes.

`master status` reads those annotations for every open candidate whose required check failed, so
the row's `refusal` and `attention` no longer read `Required CI check test has not passed on the
current candidate` but, for example:

```text
Required CI check test failed on a timing-dependent assertion, not on behaviour:
work-snapshot-latency.p95 (integration:work-snapshot-latency) measured p95 2092ms against its
budget of < 2000ms over 100 samples after 5 discarded warmup reads; every other test in the run passed
```

The item raises attention at once instead of sitting behind a red check until its dwell time is
noticed. It is the master's: `next` is the one command that reruns that job
(`gh api --method POST repos/OWNER/REPO/actions/jobs/ID/rerun`). Rerun it once. A second
measurement over budget is a latency regression, not noise — return it with `graphyard master
decide GY-N rework REASON`, quoting the measurement. When other tests failed in the same run the
line says so and offers no rerun: those failures are the worker's. A check run whose annotations
cannot be read is reported exactly as before. Never relax a budget, widen a window or skip the
assertion to get a candidate through.

No behavioural test may depend on how long the runner took between engine calls. A case that needs
a merge instant, an execution window or a clock offset pins it to the instants the engine recorded
(`tests/helpers/merge-instants.ts` derives the provider merge instant from the recorded commit)
rather than to an earlier step plus an assumed elapsed time.

Nor may a test's verdict depend on which file the scheduler started first. Test files run in
parallel, each with its own Postgres on `GRAPHYARD_TEST_PORT` plus a per-file offset; two files
that resolve the same port fail each other whenever they overlap. The required check sets
`GRAPHYARD_EVENTS_TEST_PORT` to keep the one known pair apart, and the suite refuses any two test
files that still share a port under the required check's environment.

The stability of the required check on an unchanged tree is measured, not assumed:

```sh
npx tsx tests/helpers/timing-stability.ts                # twenty consecutive runs of npm test
npx tsx tests/helpers/timing-stability.ts --record tests/helpers/timing-baseline.json
```

It runs the check twenty times on the same commit, refuses to call the result stable if any run
failed or the tree changed under it, and records the run-to-run spread of every timing-dependent
assertion (minimum, median, maximum, headroom to the budget). `manual:suite-stability-twenty-runs`
reads that output. The committed `tests/helpers/timing-baseline.json` is the spread a future
regression is judged against: the CI job summary prints each run's measurement beside it, and the
suite refuses a timing-dependent assertion whose spread was never recorded. On a machine whose
`/tmp` is under a quota, point `TMPDIR` at a sticky directory outside it for the run.

## Escalation context

A master that carries the project's rules, an item's history and the precedent of earlier decisions in its own window hits a context ceiling, dies with its provider credits, and drifts between sessions. The control plane therefore assembles an escalation's context from the project, so a master spawned for one escalation decides as well as a long-lived one and precedent, not session continuity, keeps judgements consistent. `GET /api/work/GY-N/context?trigger=TRIGGER&budget=BYTES` returns it; `master context GY-N [TRIGGER] [--budget N]` prints the same document, read by key and nothing else, after verifying its fingerprint. It has four layers:

| Layer | What it holds | Where it comes from |
| --- | --- | --- |
| `rules` | The repository's own operating rules and the item's policy | `AGENTS.md` of the repository under review, read through the control-plane App at the base tip the item was last observed against (`rules.source` names the path, ref and blob), plus `policy`. Never a template: an installation managing another codebase escalates against that codebase's rules and goals, and a repository without the file gets `rules.unavailable` saying so |
| `goals` | The current goals and priorities | The item's priority, the reasons recorded with its `create`, `ready`, `requirements` and `unblock` intents, the open graph in priority order, and its dependencies and dependents |
| `item` | The item slice | Requirements (criteria, retired criteria, planned files, producer proofs), the standing refusal (the escalation, every standing trigger, the gates, blocker and violations), the candidate, submission and lease, and a typed history summary: every ledger kind counted with its first and last row, the newest typed rows summarised to their reason, trigger, epoch, decision or proof, routine rows (`github.observed`, `heartbeat`) counted but never listed |
| `precedent` | Recent decisions of the same action | Every `resolve` decision across the graph with its requester, reason, approver, approval reason, outcome and the precedent it cited itself — the escalation's own trigger first, newest first; the rest counted per trigger and state |

Assembly is deterministic and bounded. The same escalation and graph state produce a byte-identical document: every ledger read runs in one snapshot, the wire form is canonical, and `fingerprint` is the SHA-256 of every byte but itself, so a handler can prove what it saw. The document stays within its budget (`GRAPHYARD_ESCALATION_CONTEXT_BUDGET`, default 32,000 bytes, or the request's `budget`) by summarising rather than truncating: `budget.level` records how many history rows and precedent decisions are shown in full, and every row not shown is still counted (`history.omitted`, `precedent.omitted`, `precedent.summary`). The rules layer is never shortened; when even the summary floor does not fit, `budget.exceeded` says so instead of cutting.

A spawned handler receives that context and the escalation inside it, holds no other state, and records its decision with the reason and the precedent it relied on: `master decide GY-N resolve '{"trigger":"…"}' --precedent DECISION_ID[,DECISION_ID] --context FINGERPRINT REASON`. The request carries `precedent` and `context` into the ledger and `master decisions GY-N` shows them; a cited id that is not a recorded decision of the same action is refused, so the precedent a decision names can always be followed; a second handler that reaches the same line while the first request stands is recorded as a concurrence on that decision (`concurrences`) rather than refused, while a request citing a different precedent is still refused as a competing request. The independent approver judges the decision as before. `master escalation GY-N [TRIGGER] [precedent|KIND]` spawns a handler: `precedent` (the default) is the built-in judgement — follow the newest applied decision of the same trigger, cite it, and decline when there is none, since a reason given for another kind of incident cannot apply and a judging session weighs those rows instead — run in this process; an agent `KIND` launches a judging session whose entire input is the context written to one private file under `.graphyard/escalations/`, with the instruction to read nothing else and to record its decision with `master decide … --precedent --context`; like every session Graphyard launches it receives that instruction as its own first request, and the result's `delivery` says how.

## Recovery

### Merged without a valid execution

An item GitHub merged while no valid execution covered the merge — the execution was cancelled before the merge cutoff, expired, or never existed — records the violation `Merge observed without a prior authorization for this candidate` and stays out of Done; every later observation re-derives that verdict from immutable history, so no cycle recovers it on its own. The merge cannot be re-run, so this is the one place a lost race would cost a delivery for good. `master status` therefore names such an item as the violation it is, with the merge commit and time, the owner `master`, and the recovery command; the row carries `merged` (`at`, `sha`, `violation`, and the last `refusal`), `counts.mergedUnreconciled` counts them apart from `counts.mergeCandidates`, and the loop records one escalation naming the recovery instead of offering the item to the guarded merge every cycle.

A merged item whose content is **not on the base branch** is reported as that, not as an ordinary unreconciled merge. Each observation of a merged, undelivered pull request compares every file it shipped with the base-branch tip: a file the tip holds exactly as the base held it before the merge — or does not hold at all — is missing, while a file somebody changed afterwards is not. The observation records `revertedDelivery` (`base`, the missing `files`, and `removedBy`: the merge that removed them, found from the branch's own history of the path when the content was once on the branch, and otherwise the merged candidate whose head carried this item's commits without their content — the merge that made GitHub record this pull request merged). `master status` then names the item, the files missing from the base and that merge in one attention line — `GY-N was merged on GitHub (…) and its content is not on the base branch: 2 files missing from base … — removed by merge … of GY-M, pull request #P … This is a reverted delivery, not an unreconciled merge` — so a silent revert is visible without reading a diff. The row carries `merged.reverted`, `counts.revertedDeliveries` counts such items apart from `counts.mergedUnreconciled`, and the next action is a follow-up item that restores the named files: no merge decision is requested for the item until the base branch holds its content, because a reconciliation would record a delivery for work that is not there. The check that stops this from happening again is the [landing re-check](coordination.md#the-landing-re-check).

The recovery is a two-party decision: `master decide GY-N merge REASON`, then the independent approver (`master approver GY-N DECISION`). It must be requested after the merge — a merge approval given before the merge is not a judgement of it. On the next observation Graphyard re-checks the record as it stood immediately before the merge: the merge authorization for that exact head, base and policy revision, every gate passed, no violation standing, every required proof's trusted evidence live at that instant, and a GitHub observation less than two minutes old. When that holds, the item is delivered on the decision: the delivery cites `authorizationRevision` and `evidenceAsOf` from the historical snapshot, carries `reconciliation` (the decision, requester, approver, both reasons, the cutoff, the snapshot revision and the judgement), and the ledger records `merge.reconciled`. When it does not, nothing is delivered: the item records `Reconciliation by decision … refused: …` with every reason, once, the ledger records `merge.reconciliation.refused`, and the row's attention line carries the refusal. A refusal is answered by a new decision, never by re-approving the refused one; a new decision that names no reason the refusal lacked is refused for the same reasons.

The record re-checked is the last snapshot that precedes the merge itself. GitHub reports `mergedAt` to the second and the merge broker records a bounded clock offset between GitHub and the database, so the merge cutoff Graphyard judges at is `mergedAt` plus one second plus the offset's upper bound: that allowance widens the window an authorization may fall in, and it admits no post-merge record — a snapshot whose own observation already reports the pull request merged was written after the merge whatever its timestamp, and is never the one re-checked. Nor does anything the merge itself wrote refuse the reconciliation: the unauthorized-merge violation it exists to clear, a refusal of an earlier decision, and a merge gate that only reports the queue position the merge left behind are not reasons. Everything else the record lacked still is. (GY-81 was refused on exactly that poisoned snapshot; GY-94 fixed the selection.)

#### A queue entry that can never publish

An item merged this way while it held a merge queue entry cannot leave the queue on its own: its pull request is closed, so no speculative tip can be published for it, no validation failure ejects it, and every entry behind it waits for a tip that never comes (`Waiting for GY-N to publish its speculative tip`). `master status` names the condition on the row — `merged.queue` carries the entry's `sequence`, `position`, `size`, `unpublishable: true` and the keys waiting `behind` it — and the attention line says which entries wait and what resolves it. The exit is the same two-party merge decision, with no administrative bypass: a reconciliation the record accepts delivers the item, which drops the entry with it; a reconciliation the record refuses removes the entry as the refusal is recorded, delivering nothing — the item keeps its violations and its stage, `queueEjection` names the refused decision, the ledger records `queue.ejected` beside `merge.reconciliation.refused`, and the entries behind it are woken to predict against the real base branch. A standing refusal recorded before this rule shipped removes the entry on the next reconciliation tick the same way.

#### A contaminated branch

A branch that already carries another item's unlanded commits — a tip published before the rule above, a tip ejected while the loop was down — is detected on every observation of an open candidate: the landing check lists, under `observation.landing.foreign`, every other open candidate whose head, or whose own reviewed head under a tip of its own, is in this head's history (the entries a live queue tip is published behind are its predecessors, not contamination). The record answers as well: an ejected tip still at the branch head, built behind entries that have not landed. The ledger records `branch.contaminated` naming the head and the items, and `master status` names the branch on the row under `contamination` (`head`, `foreign`, `source`, and the `restore` owed, requested or ran), in one attention line with the remedy, and under `branches.contaminated`; `counts.contaminatedBranches` counts them. Kept, such a head is refused as an out-of-scope regression; landed, it would record the other item merged without its content. No head a worker may push can pass, and workers may not force-push, so nobody is asked for one.

The remedy is the control plane's. An ejected tip is restored on the next reconciliation without a request. Any other contaminated head is repaired on the coordinator's request:

```sh
node "$GRAPHYARD_CLI" master repair GY-42 The branch carries GY-40's ejected tip
```

`master repair` records the request on the item with the coordinator's identity (the `repair` command; refused for a live queue entry, a head that carries nothing foreign, a head whose repair is already requested, and a head a restore already found unrepairable). The reconciliation job then resets the branch to the item's own reviewed head — named by the record, or found by walking the branch's first parents through the item's own tip merges (a tip the queue history recorded, or a commit GitHub attributes to the control-plane App that carries the tip message; the message alone is something any worker can write, and a commit the walk stops at is kept) — and merges the base branch onto it: no worker force-push and no operator shell. The result is on the row and the ledger as for an ejection; `outcome: unrepairable` means the foreign commits sit under something the control plane cannot move (a worker's commit on top of a contaminated tip), and the way back is a rework decision for a fresh attempt. A head found unrepairable, or one whose repair is requested and not yet run, is not brought onto a moved base branch: a refresh would carry the foreign commits along and replace the record that names the remedy.

#### A delivery an operator authorized outside the guarded path

When the record at the cutoff refuses the reconciliation — a gate was open, a proof was missing, the last observation was stale — and the merge nevertheless happened because an operator authorized it administratively, the delivery is recorded as exactly that, never as a reconciliation. It takes a further merge decision whose `REASON` cites the refused decision's id, with the operator's own admin credential on one side: either the operator requests it through the API, or the master requests it (`master decide GY-N merge REASON`) and the operator approves it with `GRAPHYARD_TOKEN_FILE=ADMIN_TOKEN_FILE graphyard master approve GY-N DECISION REASON`. The master's agent pair alone cannot record one — a pair of operator-agent identities citing the refusal is refused again, saying so — and a decision that cites no refusal is a plain reconciliation attempt. The row's `attentionOwner.next` carries the exact command once a refusal stands.

On the next observation the item is delivered with `delivery.operatorAuthorization`: `execution: null` (the statement that no merge execution authorized this merge), the `operator`, the decision with requester, approver and both reasons, the `refusedDecision` it overrides, `unmet` (every reason the record refused), the cutoff, the snapshot revision and a judgement that says all of it in one sentence. `authorizationRevision` is the pre-merge snapshot's revision; there is no execution to cite. The ledger records `merge.operator-authorized` under the operator's identity, never `merge.reconciled`. `master status` lists both kinds apart under `deliveries.reconciled` and `deliveries.operatorAuthorized` (with `counts.reconciledDeliveries` and `counts.operatorAuthorizedDeliveries`); an operator-authorized row carries `authorization: 'operator'`, `execution: null`, the operator and `unmet`, a reconciled row carries `authorization: 'reconciled'` and the judgement that every gate had passed. Neither is a routine merge, and neither is mistaken for the other.

### Dead worker or provider change

A session whose provider account ran out mid-work needs none of this: the loop fails it over on
its own ([exhaustion in the middle of a session](#exhaustion-in-the-middle-of-a-session)). For any other dead worker or provider change:

1. stop the old worker and supervisor;
2. release or let the lease expire, and settle any containment quarantine it left; a submitted
   attempt has no lease left to release, because `complete` ended it;
3. request a two-party `rework` decision if a candidate was already submitted;
4. claim with the replacement worker at a higher epoch;
5. create a fresh workspace and preserve the old attempt.

A `lease-loss` escalation stands only for a worker that silently vanished: a lease that lapsed
with no submission, no carried `blocked` report and no stopped-worker attestation for its epoch.
Every other lapse is `lease.expired` history with its cause — `submitted` (the lease ended at
`complete`), `blocked-awaiting-operator` (the worker reported `blocked` and stopped to wait on
you), or `stopped-by-attestation` (you stopped the worker and said so with
`rework --previous-worker-stopped` or `recover-containment --previous-worker-stopped`, before or
after the lapse) — and raises nothing. Do not treat any of those as an incident needing anyone.

Who settles what:

- reconciliation settles, on deploy and every later tick, a standing `lease-loss` whose epoch has
  a bound submission, a carried blocked report, or a stopped-worker attestation in the ledger
  (`escalation.auto-settled`, with the note and the attestation it rests on). Attest first, then
  wait a tick: an applied two-party `rework` decision for the lapsed epoch (or an `admin`'s
  `rework --previous-worker-stopped`) is the attestation;
- an `admin` session — this path does not require a declared human session — settles a
  control-plane-raised `lease-loss` by citing the attestation:
  `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`. The server verifies the
  citation against the ledger and refuses one that is not there; the `escalation.resolved` entry
  records who, why and which attestation;
- a lapse nothing explains — no report, no attestation — is a vanished worker; it, and
  `security-concern`, `requirement-weakening`, `evidence-policy-conflict` and any lease-loss a
  lead raised, are resolved by a two-party `resolve` decision (`master decide GY-N resolve
  '{"trigger":"TRIGGER"}' REASON`) that the approver agent approves after checking the cause, or
  by a declared human session. Never work around those.

Before `master settle-containment` stops anything, read its report: the quarantine records the
exact scope unit and supervisor pid the session was launched in (`containment.scope`), and a
refusal prints every process still holding the fence with its cmdline and cwd, and says what
systemd reports for the recorded scope. A neighbouring `graphyard-watch-*` scope is attributed to
its own live supervisor by the pid in its name, so another item's running worker is not this
item's fence; a scope you cannot attribute from that report belongs to someone — verify whose
before stopping it.

The master clears blockers and adds requirements as its operator-agent identity; everything else it cannot do alone goes through a two-party decision, never around a gate. See [operations](operations.md) for recovery commands, including [restarting the durable loop](operations-reference.md#master-coordination-loop).

## Master commands

| Command | Purpose |
| --- | --- |
| `master init --token-stdin [--browser-profile PROFILE] [--replace-supervisor]` | Install the operating mode and, run by an operator from the coordinator checkout, the loop's systemd user unit; name the operator's browser profile; `--replace-supervisor` takes over a unit that runs another checkout or launcher |
| `master environments [--create KINDS] [--apply]` | Discover or create agent environments, report login and quota, generate profiles from the logged-in ones |
| `master registry` | The fleet the control plane holds: every account with its runtime, model, roles, live sessions, quota, reset and ineligible reason ([the agent registry](#the-agent-registry)) |
| `master registry propose [--directory DIR] [--apply]` | Discover the agent CLIs logged in on this host and propose (or store) the runtimes, models, accounts and roles for them |
| `master registry runtime\|model\|account\|role set … --reason R` | Add or change one registry entry; a `set` names only what changes |
| `master registry account quota NAME exhausted\|available\|unknown [--resets-at ISO] --reason R` | Mark an account's quota by hand; an exhausted mark holds until its reset or until cleared |
| `master registry runtime\|model\|account\|role remove NAME --reason R` | Remove an entry; removing a runtime removes its accounts, and roles fall back in order |
| `master registry history [--limit N]` | Every registry change and selection, newest first |
| `master start KIND` | Launch the visible master session with its harness rules |
| `master status` | Work truth, session health, reviews, queue, `schedule` (dispatch order, overlap holds, high-conflict scopes), per-candidate `conflicts`, per-row `dispatch` (requested reviews and producers), per-row `merged` (an observed merge no execution authorized, with its recovery), per-row `contamination` and `restoredApproval` with `branches` ([speculative tips and branch protection](#speculative-tips-and-branch-protection)), `disk` (free space and what a reclaim would return), and `administration` (recent browser actions, pending sudo code) |
| `master dispatch GY-N PROFILE [--allow-overlap]` | Invite a worker to claim ready work; `--allow-overlap` dispatches over a planned-file overlap hold |
| `master producer add FILE` | Add a proof-producer launch profile with its own producer credential |
| `master producer replace FILE` | Replace the producer profile of the same name, verified like `add` |
| `master producer remove NAME` | Remove a proof-producer launch profile |
| `master reviewer remove NAME` | Remove a reviewer launch profile |
| `master review GY-N [PROFILE]` | Launch the independent reviewer on the exact candidate (the loop does this on its own; recovery path) |
| `master protection [--apply]` | Reconcile branch protection through the API |
| `master browser app-permissions` | Raise the control-plane App's permissions through the browser |
| `master browser installation-accept` | Accept the installation's pending permission request through the browser |
| `master browser protection [--dry-run]` | Reconcile branch protection through the browser |
| `master harness [KIND] [--apply]` | Generate the master's own harness permissions |
| `master config FIELD=VALUE…` | Tune the settings the master owns (run cadence, workflows, deployment, reviewer profile, producer timeout, quota ceiling, `accounts:PROFILE=a,b`); `autoMerge` and credential paths stay operator-only |
| `master merge GY-N\|--all` | Guarded merge of authorized candidates as one executor instance; with automatic merging off, only candidates with an approved merge decision; stands down from an execution the loop holds |
| `master autonomy [--admin-token-stdin --apply]` | Provision the master's operator-agent and approver identities and harness rules (once, at onboarding) |
| `master create FILE REASON`, `master release GY-N REASON`, `master unblock GY-N REASON`, `master requirements GY-N FILE REASON` | The master's own non-weakening intent, as its operator-agent identity |
| `master scope GY-N [REASON]` | Apply a scope request the loop refused, while the attempt keeps its lease; requests the item already implies are decided by the loop ([scope requests the loop decides](#scope-requests-the-loop-decides)) |
| `master repair GY-N REASON` | Ask the control plane to restore a branch found carrying another item's unlanded commits to the item's own reviewed head merged onto the base ([a contaminated branch](#a-contaminated-branch)) |
| `master decide GY-N ACTION [JSON\|@FILE] [--precedent ID[,ID]] [--context FINGERPRINT] REASON` | Request a two-party decision: `release`, `unblock`, `requirements`, `resolve`, `attest`, `merge`, `rework`, `recover`, `grant`; a handler cites the precedent it followed and the context it judged from |
| `master context GY-N [TRIGGER] [--budget N]` | The assembled [escalation context](#escalation-context), read by key alone and verified against its fingerprint |
| `master escalation GY-N [TRIGGER] [--budget N] [precedent\|KIND]` | Spawn a fresh handler on that context alone: `precedent` follows the newest applied line in this process, an agent `KIND` launches a judging session |
| `master decisions GY-N` | An item's decisions with requester, approver, reasons, outcome, and refusals |
| `master approver GY-N DECISION [KIND]` | Launch the independent approver session for one decision, on the registry's `approver` role (KIND overrides the runtime) |
| `master approve GY-N DECISION REASON` | Approve, from the approver session only |
| `master refuse GY-N DECISION REASON` | Record a considered refusal, from the approver session only; the decision ends `refused` with the reason |
| `master principals [--apply]` | Preview or apply an agent-principal roster rotation that keeps every live principal |
| `master restart` | Stop this host's durable loop and start it again detached |
| `master run [--once]` | The durable coordination loop, with the dispatcher that launches requested reviews and producers; its cycle also reclaims [worktree disk](#worktree-disk) |
