<!-- page: Operate Graphyard | 5 | routing, recovery, and guarded merges. -->
# Master-agent operating mode

The master is the coordinator: a `coordinator` principal run as the durable `master run` loop plus an optional visible master session. It reads Graphyard, watches Herdr session health, routes ready work, launches the independent reviewer and the proof producers the control plane requests for every submitted head, handles findings and handoffs, requests guarded merges, and administers the managed repository's GitHub App, installation, and branch protection — through the API when it can and through the human operator's own browser profile when only a GitHub page can do it. It does not implement work, hold worker leases, review candidates, or produce evidence.

Graphyard remains the source of truth. Herdr only reports live session health. Terms follow the [glossary](glossary.md).

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

## Durable loop

A chat session is a poor coordinator. Its transcript grows without bound, it dies with its
provider's credits, and recovering it needs a human to hand the role to another session. The
deterministic part of coordination does not need a language model at all, so run it as a supervised
process:

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

Each cycle:

1. **closes finished worker sessions** — a launched agent whose principal holds no active lease has
   no authority left, so its pane is closed rather than left holding a provider seat. `complete`
   ends the worker's lease, so a submitted item's session is closed here on the next cycle; a
   lease that lapses after submission, under a `blocked` report, or after your stopped-worker
   attestation is history (`lease.expired` with its cause), never an incident;
2. **dispatches claimable work** to a healthy worker profile, through the same launcher
   `master dispatch` uses: the worker claims under its own identity and the loop holds no lease.
   Ready items are offered [smallest planned scope first](#conflict-avoidance) within a priority,
   and an item whose `plannedFiles` overlap a claimed or unmerged item is held rather than
   dispatched — the loop never overrides a hold; only `master dispatch --allow-overlap` does;
3. **shepherds reviews and proofs** — the reviewer and producer sessions the control plane
   requested for each exact head are launched on the dispatcher's own cadence (see
   [automatic dispatch at submit](#automatic-dispatch-at-submit)), a request goes to the trusted
   producer workflow when automatable proof is missing and one is configured, and anything only a
   human may resolve is escalated;
4. **invokes only the guarded merge**, when automatic merging is enabled;
5. **verifies the deployed SHA** against what Graphyard recorded as delivered, and for a delivery
   whose policy sets `deploySmoke` records that observation on the item, requests the trusted smoke
   workflow once per deployed commit, and escalates a failed verdict with rollback guidance (see the
   [post-deployment smoke proof](github.md#post-deployment-smoke-proof));
6. **records stage p50/p90** for every open stage, delivered lead time, creation-to-deployment
   latency, and merge-to-smoke-verdict post-deploy time with the failure count.

Every action lands in `master status` under `daemon`: the current cycle, its measurements, the
deployment observation, per-profile health, recent actions, and anything still unresolved.

### Restartability

The loop keeps a private cursor next to the coordinator credential, outside every worktree. It is
written before and after each external action, so a daemon killed mid-action leaves a record that
the next start resolves **against Graphyard, not against the cursor**: an assignment that landed is
closed, one that never landed is released for a fresh attempt, and a review request for a candidate
that already has one is never sent twice. Restarting is therefore always safe, and the supervisor
may restart it as often as it likes.

Whether an assignment landed is read from the attempt epoch, which only a claim advances, and never
from the presence of a submission: an item returned to the worker by `rework` keeps the previous
attempt's submission until the new attempt resubmits, so treating that as success would leave the
rework waiting for a dispatch that never comes.

One loop owns a repository at a time. A second refuses while the first is alive; a lock left by a
killed daemon on the same host is reclaimed as soon as that process is gone.

### What the loop will not do

The daemon holds exactly one credential: the coordinator token. It cannot claim a lease, submit
evidence, revise requirements, release backlog work, or approve a review, and it refuses to start
if that credential is also allowed to produce evidence. The one fact it writes besides the guarded
merge is its own deployment observation on a delivered item; the smoke verdict itself comes from
the workflow's producer, never from the loop. Provider exhaustion, a failing reviewer, a
missing manual proof, and an unhealthy worker profile are all escalations, never shortcuts. A
refused merge is the gate working: the loop records the refusal and keeps cycling.

An unhealthy profile — an unreadable credential, a name already busy in Herdr, or a recent failed
launch — is routed around for a ten-minute cool-off while other profiles keep receiving work.

Judgment calls stay with the visible master session or the human operator: reading a worker's
report, deciding whether a review finding needs rework, choosing how to route a novel failure. The
loop keeps the mechanical steps running underneath them.

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
  head outside every Graphyard worktree, and submits each proof with `graphyard evidence` bound
  to that exact head, base and policy revision — a failing run as `fail`, never omitted. With
  fewer free producer profiles than groups the remaining groups wait and `master status` says
  so; add profiles for parallelism.

A launch happens **once per request id**: the reviewer ledger (`.graphyard/reviews.json`) and
the producer ledger (`.graphyard/producers.json`) record which request each session answers,
so a restart, a second tick or a re-read snapshot never doubles a session, and a request the
control plane satisfied or cancelled is never launched. The ledgers record launch, completion
and outcome per session: a reviewer session completes on its verdict and expires with its
token; a producer session completes when every proof of its group has a trusted outcome (or
one failed), expires after `producerTimeoutMinutes`, and is recorded as `failed` when Herdr
reports it finished five minutes without submitting. A session whose head the control plane
cancelled is closed on the next tick with its token withdrawn and the reason on the record — a
head change cancels the in-flight sessions for the old head.

A launch the loop could not perform — a stale observation, a busy profile, Herdr refusing — is
recorded in the dispatch cursor beside the coordinator credential with a widening retry
(30 seconds, doubling to 10 minutes, at most twelve attempts), and `master status` raises it as
that row's `attention`. Once its cause is fixed, `master review GY-N [PROFILE]` is the recovery
path for a reviewer request past its attempts; producers retry on their own once a profile is
free.

`master status` shows it all per candidate under each row's `dispatch`: the open review and
producer requests with `requestedAt`, `sinceMs` and the recorded reason; the `session` launched
for each (profile, agent, state, verdict or per-proof outcome, and how long it has run); any
`failure` standing against it; and `recent`, the last resolved requests with their resolution.
`producers` lists the pending and recent producer sessions, `dispatch` reports the dispatcher's
cadence, last tick and failures, and `counts.dispatchRequested` and `counts.dispatchRunning`
total the requests and the sessions running for them.

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

In-scope work is every item Graphyard has released: unreleased backlog is the human
operator's (or a scoped operator agent's, with `intent:ready`) to release with `ready`,
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

For work using the [identity-bound agent review provider](github.md#identity-bound-agent-review-providers), each row carries a `review` object with the currently dispatched reviewer profile and runtime, plus the failover entries recorded for the current candidate; `counts.reviewFailover` totals the items that failed over. A reviewer runs out of quota or goes silent past its timeout, Graphyard records that and moves to the next configured profile on its own — no master action is required. When every profile is exhausted the row is flagged for attention and the review gate stays closed. That is a capacity decision for the operator: add reviewer capacity, wait for quota, or revise the review policy. Never treat exhaustion as an approval, and never merge around a closed review gate.

`master status` also reports facts about the installation itself under `controlPlane`: `attention` lists a GitHub App permission the installation lacks (with the installation page where the pending request is accepted), a preflight that could not verify the permissions, the number of integration jobs held on that shortfall, every capacity variable that no longer covers the configured principals (`Set GRAPHYARD_MAX_REVIEWERS=N on the deployment`, under `delegationLimits`), and how far the base branch is ahead of what production serves; `appPermissions` carries the missing entries and when they were last verified; `counts.attention` includes these items. `controlPlane.production` is the control plane's own [deployment observation](deployment.md#production-deployment-observation): the serving commit, `aheadBy`, the newest provider deployment with its status, the pending and deployed items, and the open incidents; when main is ahead the attention line reads `main is N commits ahead of production (serving …): <failing deployment reason>`. `controlPlane.build` is the commit and merge protocol the server runs, `versionSkew` is the refusal `master merge` would raise (`null` when the CLI and server agree), and `latency.mergeToProduction` is the merge-to-production p50/p90 over every delivery with an observed deployment, which the periodic measurement records beside `delivered[].mergeToProductionMs`. A permission shortfall is an administration action — the human operator, or the master through the operator's browser profile — not a merge decision: the affected jobs are held rather than retried, the gates they feed stay closed, and `graphyard github-setup --update-permissions` on the machine holding the App credentials prints the exact steps. `master init` reports the same attention in its result. See [App permissions](github.md#app-permissions).

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
| Codex | `--ask-for-approval never --sandbox workspace-write` | directory-trust and per-command approval | only the workspace-write sandbox still limits a command |
| Cursor | `--force --trust` | "Run Everything" and fresh-worktree workspace trust | every proposed command runs in the assigned worktree |
| opencode | `OPENCODE_PERMISSION={"edit":"allow","bash":"allow","webfetch":"allow"}` | edit, bash, and webfetch prompts | edits, shell commands, and fetches happen without asking |
| Muse | nothing generated; the [template](../examples/master/muse-worker.json) passes `--approval-mode never --trust-workspace` in `agentArgs` | tool-approval and workspace-trust prompts | tool calls run without asking inside Muse's own sandbox |

The trade-off is real: an `auto` session runs whatever it decides to run inside its own worktree, under its own provider and Graphyard credentials. What it cannot do is change: it still holds only a worker credential, still works in one assigned worktree, and still cannot merge, produce trusted evidence, or weaken a requirement. Use `prompt` when a human should stay in the loop for a particular profile. A profile that already sets the runtime's own approval flags keeps exactly those; Graphyard never overrides an explicit choice.

`master worker add` and `master reviewer add` print the resolved launch contract, so what a profile will start with is visible before it starts.

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
4. launches the reviewer profile in its own Herdr tab with a read-only prompt naming the exact head, base, and policy revision, and the commit-bound command that posts the verdict;
5. records the request in `.graphyard/reviews.json`.

`master status` reconciles pending requests: when the reviewer identity posts an `APPROVED` or `CHANGES_REQUESTED` review on that exact commit, Graphyard closes the session, removes its credential directory, and moves the record to completed. A verdict on another commit, from another identity, or a bare comment settles nothing. An unanswered request expires with its token. If Herdr cannot confirm the pane is gone, the record stays pending with the reason attached rather than claiming the credential was withdrawn.

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
- **Human-only decisions.** The guides mark these human-only: choosing which review provider an item uses, releasing backlog work, revising requirements, clearing blockers, satisfying a manual proof, authorizing rework, and approving a merge when automatic merging is disabled stay with the human operator. The flows change nothing outside the three targets above.

### What the master must never do

The browser profile is the operator's identity. The master never stores, exports, or copies its cookies or saved state, never uses `agent-browser`'s auth vault, restore, or state files, and never drives the profile outside the three flows: the harness denies every direct `agent-browser` command, so the only way the session reaches the profile is `master browser`, and the only way to inspect what a flow saw is its record directory. It also never adds a repository to an installation or replaces protection through the API; installation writes happen only through `master browser installation-accept`, and protection writes only through `master protection --apply`, `master browser protection`, or a subresource `PATCH`. It never uses an administrative merge bypass, never edits a candidate or pushes code, never posts a review verdict, never mints an installation token, and never reads a worker, reviewer, or coordinator credential — those rules are denied in the harness and stated in the generated instructions.

## Harness permissions

A master running inside a harness with its own command classifier stops on its own routine commands until someone approves them. In Claude Code's auto mode the classifier goes further: it refuses branch-protection reads and writes as CI-bypass reconnaissance, installation and App permission changes as permission grants, launching a second agent as a permission grant, and browser control as self-modification — so a master without generated rules cannot perform the administration it owns. `master start claude` writes project-scoped rules to `.claude/settings.local.json` (git-ignored, machine-specific) before the session starts; `master harness claude` previews them and `master harness claude --apply` writes them. Every rule prints the reason it exists.

Allowed: the master's own CLI subcommands at their absolute path, with the reviewer launcher (`master review`) and the browser flows (`master browser`, which invoke `agent-browser` themselves) listed on their own; `herdr`; read-only `gh pr` commands; `gh api user`; `gh api` reads of the managed base branch's protection and `--method PATCH` writes to its subresources; `gh api user/installations` reads; `gh api apps/*` reads; `jq`; the audited-thread wrapper `scripts/resolve-thread.mjs`; reads of `.graphyard/master-actions/`; and writes to `.graphyard/profiles/`.

Denied: `gh pr merge`, `gh pr review`, any `gh api` call that merges, posts a review, mints an access token, uses GraphQL, or uses `PUT`, `POST`, or `DELETE` wherever the method flag sits (replacing whole branch protection, adding a repository to an installation, deleting protection or an installation); every direct `agent-browser` command, so the operator's profile, cookies, state, and auth vault are reachable only through the recorded flows; `git push`; and reads of the coordinator credential home, `.graphyard/connection.json`, `*.pem`, and `*.token`.

Existing entries are never removed and regeneration is idempotent. `master harness codex` prints the `trust_level = "trusted"` block for `$CODEX_HOME/config.toml` instead of editing that shared user file.

A harness allowlist is a prompt policy, not an authority boundary. The enforced boundary stays branch protection plus the App-bound Graphyard check: Graphyard's guarded merge is the only path that rechecks the exact candidate before delivery.

## Containment quarantines

A foreground worker runs inside a containment quarantine that its supervisor settles on verified shutdown. When the supervisor itself dies — a crash, a provider usage limit, a killed terminal — the capability dies with it and the fence stays up: the item is undispatchable, its exclusive resources stay reserved, and its requirements stay immutable until someone proves the worker stopped.

`master status` reports every such quarantine on each work row under `containment`, with `counts.quarantined` and `counts.settleableQuarantines` totalling them. For a quarantine whose workspace is registered on this coordinator's host, status also verifies it: it checks that the worker lease and the launch authority have both been expired past their grace window — measured from the lease deadline the quarantine retains, since reconciliation clears the expired lease record long before that window closes — then inspects this host for any surviving supervisor process, any process running in the assigned workspace, and any live `graphyard-watch` containment scope.

The quarantine records the exact scope unit the session was launched in and the supervisor's pid (`containment.scope`), and status reports what systemd says of that unit. Everything the recorded scope still holds fences this item, whatever a member's working directory or ancestry says. Any other live `graphyard-watch-*` scope is dismissed only when its members are positively attributed to another assignment: by the live supervisor whose pid the scope name carries, when that supervisor runs `watch` for a different work key or epoch from another workspace, or by following a member's own ancestry to such a supervisor. Another worker's scope on the same machine is therefore ordinary, even when its session has reparented away from its supervisor; an orphaned scope left by a dead supervisor is not, and it fences until an operator attests. Every process still holding the fence is listed in `containment.held`, and printed by `master settle-containment`, with its pid, cmdline and cwd — read them before stopping anything.

- `settleable: true` with no `refusals` means the supervisor is verifiably gone. Run `master settle-containment GY-N "reason"`. The control plane re-checks the deadlines and the verification before clearing the fence, and records the verification in the event ledger.
- Any `refusals` entry means something could not be proven — the host is unreachable or not the registered one, a scope or process query failed, a process is still present, or the clocks disagree. Automatic settlement refuses, and so does the control plane. Stop the supervisor yourself and use the operator attestation path (`rework GY-N --previous-worker-stopped`, or `recover-containment GY-N --previous-worker-stopped` once the work is delivered).

The record it sends names every process and containment scope it found, and counts the privileged host processes that withheld inspection. Settlement lowers the fence and nothing else. It does not authorize rework, reopen delivered work, or satisfy any gate; a submitted item still needs an operator's rework decision before reassignment. Verification is bounded by what this host can see: a supervisor launched on another machine, by another user, or outside this coordinator's systemd user manager is never reported as absent — those remain the operator's attestation. See [the protocol](protocol/containment-settlement.md) for the exact checks.

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

Before any candidate is read, the broker compares the merge protocol it speaks with the one the server reports in `GET /api/status` (`build.protocol`; a server that reports none is protocol 1). A mismatch refuses with `server runs <sha>, CLI expects <sha>: deploy main first` — the deployment has not served the commit the CLI runs, typically because the container failed to start — instead of failing later with an invalid gate verification. The durable loop makes the same check at start-up and before every guarded merge. Deploy main (see [merged but not deployed](operations.md#merged-but-not-deployed)) and retry; never downgrade the CLI to match a stale server.

Use `master init --no-auto-merge` when an operator must approve each merge request. This preference does not weaken the checks.

## Merge queue

Candidates that pass their own gates enter a single merge queue and land in order. `master status` reports the queue directly:

- `queue` lists every entry with its `position`, `size`, `predictedBase`, `predictedTip`, `ahead` keys, `validated` flag, `waitMinutes`, and refusal `reasons`;
- each entry's `binding` says how it is bound to its published tip: `base` names the bound base and tree, whether the placement binds it exactly or as a tree-identical advance, and `carriedTo` when the base branch advanced only by such a commit; `approval` and each `evidence` entry are `exact` (bound to the tip itself), `carried` (carried across a Graphyard-authored tip, with the reviewer, original sha or evidence id) or `required` (a fresh review or proof is needed), each with the recorded reason;
- each work row carries the same placement under `queue`, and `counts.queued` totals the entries.

Only the head of the queue can hold a merge authorization, so `master merge --all` merges one entry per pass and the rest stay refused with an explicit position reason. That is normal, not a fault. Before acquiring authority, again under the acquired execution, and once more immediately before the provider call, the master rechecks that what lands is a Graphyard-published queue tip for exactly the authorized commit, and that the base branch still lets it land its tested tree: either the base is exactly the commit the candidate was validated on, or it advanced only through earlier queue merges, which leave that tree untouched. Any other advance, or an authorization with no published tip behind it, refuses the merge.

The real-base rule: every one of those checks reads the base branch's head from `refs/heads/<base>` (`gh api repos/OWNER/REPO/git/ref/heads/BASE`) and compares that commit's tree with the tree the tip was validated on. The pull request's `baseRefOid` is never consulted — GitHub caches it and refreshes it only on a push to the pull request's head, so right after a predecessor merges it still names the pre-merge base and would refuse every follower in the queue, the exact case the queue exists to make cheap. A refusal names both commits and both trees (`its head <sha> (tree <tree>) is not tree-identical to validated base <sha> (tree <tree>)`); a base whose tree differs from the validated tree is refused no matter what the pull request reports.

Entries behind the head are re-based by Graphyard, not by the worker. Do not request rework, reassign, or ask an agent to rebase a queued candidate because its position or predicted tip changed; check `queue` and the entry's refusal reason first. An entry that fails its speculative validation is ejected with a recorded reason and must be repaired and re-queued — there is no command to reinsert or reorder it. The mechanism and its invariants are in [GitHub enforcement](github.md#merge-queue).

A follower whose predecessor merges keeps its tip and bindings: the base branch advanced only by a commit tree-identical to the tip it was validated on, and the row's `binding.base.carriedTo` names that advance. When Graphyard replaces an approved head with its own authored tip, the approval and the scope-disjoint proofs carry to it under the rule in [binding carry](github.md#binding-carry-across-a-graphyard-authored-tip); a `required` binding in the row names exactly what the predecessor touched and what must be produced afresh. Launch a review or a proof only for a `required` binding, never because a tip's sha changed. GitHub dismisses reviews on Graphyard's own tip push; `master merge` re-posts a carried approval through the bound reviewer App before it acquires authority, and the result reports it under `carriedApproval`. A carried approval given by a human reviewer cannot be re-posted: the provider may then still require a fresh native approval, which the row and the merge result say.

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
(also listed under `schedule.highConflict`): ask the operator to narrow such a scope before
dispatching it beside anything else.

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

## Recovery

For a dead worker or provider change:

1. stop the old worker and supervisor;
2. release or let the lease expire, and settle any containment quarantine it left; a submitted
   attempt has no lease left to release, because `complete` ended it;
3. request operator rework if a candidate was already submitted;
4. claim with the replacement worker at a higher epoch;
5. create a fresh workspace and preserve the old attempt.

A `lease-loss` escalation stands only for a worker that silently vanished: a lease that lapsed
with no submission, no carried `blocked` report and no stopped-worker attestation for its epoch.
Every other lapse is `lease.expired` history with its cause — `submitted` (the lease ended at
`complete`), `blocked-awaiting-operator` (the worker reported `blocked` and stopped to wait on
you), or `stopped-by-attestation` (you stopped the worker and said so with
`rework --previous-worker-stopped` or `recover-containment --previous-worker-stopped`, before or
after the lapse) — and raises nothing. Do not treat any of those as an incident needing the human
operator.

Who settles what:

- reconciliation settles, on deploy and every later tick, a standing `lease-loss` whose epoch has
  a bound submission, a carried blocked report, or a stopped-worker attestation in the ledger
  (`escalation.auto-settled`, with the note and the attestation it rests on). Attest first, then
  wait a tick: your `rework --previous-worker-stopped` for the lapsed epoch is the attestation;
- you, with your `admin` credential — this path does not require a declared human session —
  settle a control-plane-raised `lease-loss` yourself by citing the attestation:
  `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`. The server verifies the
  citation against the ledger and refuses one that is not there; the `escalation.resolved` entry
  records who, why and which attestation;
- a lapse nothing explains — no report, no attestation — is a vanished worker and stays for a
  declared human session, as do `security-concern`, `requirement-weakening`,
  `evidence-policy-conflict` and any lease-loss a lead raised. Never work around those.

Before `master settle-containment` stops anything, read its report: the quarantine records the
exact scope unit and supervisor pid the session was launched in (`containment.scope`), and a
refusal prints every process still holding the fence with its cmdline and cwd, and says what
systemd reports for the recorded scope. A neighbouring `graphyard-watch-*` scope is attributed to
its own live supervisor by the pid in its name, so another item's running worker is not this
item's fence; a scope you cannot attribute from that report belongs to someone — verify whose
before stopping it.

The master does not clear blockers, revise requirements, or satisfy human gates on its own. See [operations](operations.md) for recovery commands, including [restarting the durable loop](operations-reference.md#master-coordination-loop).

## Master commands

| Command | Purpose |
| --- | --- |
| `master init --token-stdin [--browser-profile PROFILE]` | Install the operating mode; name the operator's browser profile |
| `master start KIND` | Launch the visible master session with its harness rules |
| `master status` | Work truth, session health, reviews, queue, `schedule` (dispatch order, overlap holds, high-conflict scopes), per-candidate `conflicts`, per-row `dispatch` (requested reviews and producers), and `administration` (recent browser actions, pending sudo code) |
| `master dispatch GY-N PROFILE [--allow-overlap]` | Invite a worker to claim ready work; `--allow-overlap` dispatches over a planned-file overlap hold |
| `master producer add FILE` | Add a proof-producer launch profile with its own producer credential |
| `master review GY-N [PROFILE]` | Launch the independent reviewer on the exact candidate (the loop does this on its own; recovery path) |
| `master protection [--apply]` | Reconcile branch protection through the API |
| `master browser app-permissions` | Raise the control-plane App's permissions through the browser |
| `master browser installation-accept` | Accept the installation's pending permission request through the browser |
| `master browser protection [--dry-run]` | Reconcile branch protection through the browser |
| `master harness [KIND] [--apply]` | Generate the master's own harness permissions |
| `master merge GY-N\|--all` | Guarded merge of authorized candidates |
| `master run [--once]` | The durable coordination loop, with the dispatcher that launches requested reviews and producers |
