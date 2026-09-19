<!-- page: Operate Graphyard | 5 | routing, recovery, and guarded merges. -->
# Master-agent operating mode

The master is a dedicated coordinator session. It reads Graphyard, watches Herdr health, routes ready work, handles handoffs, requests guarded merges, and administers the managed repository's GitHub App, installation, and branch protection — through the API when it can and through the operator's own browser profile when only a GitHub page can do it. It does not implement work, hold worker leases, or produce evidence.

Graphyard remains the source of truth. Herdr only reports live session health.

## Install

Requires Node 24, Herdr 0.7.1 or newer, a Graphyard checkout, and GitHub CLI authenticated as an identity allowed to merge the protected base branch.

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

Run the coordinator under a dedicated OS identity or machine. Implementation agents running as the same OS user may read its GitHub CLI credentials; Graphyard tokens cannot create a filesystem boundary.

## Add a worker

Use a template:

- [Codex](../examples/master/codex-worker.json)
- [Claude](../examples/master/claude-worker.json)
- [Cursor](../examples/master/cursor-worker.json)
- [existing session](../examples/master/existing-worker.json)

Keep profile files in the ignored `.graphyard/profiles/` directory so the master can write them itself. A launch profile points to a mode-0600 worker-token file outside every repository worktree:

```sh
node "$GRAPHYARD_CLI" master worker add /path/to/profile.json
node "$GRAPHYARD_CLI" master status
```

Provider login and Graphyard identity are separate. Profiles cannot contain Graphyard variables or secret-looking environment values.

Every launch profile carries an approval mode; see [approval modes](#approval-modes).

`launch` profiles are supervised and can receive new work. `existing` profiles add health visibility for a session that already owns work; Graphyard will not inject a new assignment into an unsupervised process.

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

Each cycle:

1. **closes finished worker sessions** — a launched agent whose principal holds no active lease has
   no authority left, so its pane is closed rather than left holding a provider seat. `complete`
   ends the worker's lease, so a submitted item's session is closed here on the next cycle; a
   lease that lapses after submission is history (`lease.expired`), never an incident;
2. **dispatches claimable work** to a healthy worker profile, through the same launcher
   `master dispatch` uses: the worker claims under its own identity and the loop holds no lease;
3. **shepherds reviews and proofs** — one recorded request per exact candidate, a request to the
   trusted producer workflow when automatable proof is missing, and an escalation for anything only
   a human or a producer may resolve;
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

Judgment calls stay with an agent or a human: reading a worker's report, deciding whether a review
finding needs rework, choosing how to route a novel failure. The loop keeps the mechanical steps
running underneath them.

## Operate

```sh
node "$GRAPHYARD_CLI" master status
node "$GRAPHYARD_CLI" master dispatch GY-42 codex-primary
node "$GRAPHYARD_CLI" master review GY-42
node "$GRAPHYARD_CLI" master settle-containment GY-42 "Supervisor died on provider usage limit"
node "$GRAPHYARD_CLI" master merge GY-42
node "$GRAPHYARD_CLI" master merge --all
```

Run `status` at startup, after dispatch, when a worker reports completion, and when an integration event arrives. Owners, stages, refusals, merge candidates, and pending and completed reviews come from Graphyard. Missing Herdr telemetry never erases an assignment.

`delivered` lists every delivery whose policy sets `deploySmoke`, with the recorded deployment, the smoke verdict, `postDeployMs`, `productionLatencyMs`, and — for a failed verdict — `rollback` guidance. Act on that guidance through a follow-up item; never backfill evidence or clear the failure. See [operations](operations.md#delivered-with-a-failed-smoke-proof).

For work using the [identity-bound agent review provider](github.md#identity-bound-agent-review-providers), each row carries a `review` object with the currently dispatched reviewer profile and runtime, plus the failover entries recorded for the current candidate; `counts.reviewFailover` totals the items that failed over. A reviewer runs out of quota or goes silent past its timeout, Graphyard records that and moves to the next configured profile on its own — no master action is required. When every profile is exhausted the row is flagged for attention and the review gate stays closed. That is a capacity decision for the operator: add reviewer capacity, wait for quota, or revise the review policy. Never treat exhaustion as an approval, and never merge around a closed review gate.

`master status` also reports facts about the installation itself under `controlPlane`: `attention` lists a GitHub App permission the installation lacks (with the installation page where the pending request is accepted), a preflight that could not verify the permissions, and the number of integration jobs held on that shortfall; `appPermissions` carries the missing entries and when they were last verified; `counts.attention` includes these items. A permission shortfall is an operator action, not a merge decision: the affected jobs are held rather than retried, the gates they feed stay closed, and `graphyard github-setup --update-permissions` on the machine holding the App credentials prints the exact steps. `master init` reports the same attention in its result. See [App permissions](github.md#app-permissions).

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

The trade-off is real: an `auto` session runs whatever it decides to run inside its own worktree, under its own provider and Graphyard credentials. What it cannot do is change: it still holds only a worker credential, still works in one assigned worktree, and still cannot merge, produce trusted evidence, or weaken a requirement. Use `prompt` when a human should stay in the loop for a particular profile. A profile that already sets the runtime's own approval flags keeps exactly those; Graphyard never overrides an explicit choice.

`master worker add` and `master reviewer add` print the resolved launch contract, so what a profile will start with is visible before it starts.

## Independent review

The reviewer is a separate GitHub identity: not the pull-request author, and not the Graphyard control-plane App that publishes the gate check.

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
- **Human-only decisions.** The guides mark these human-only: choosing which review provider an item uses, releasing backlog work, revising requirements, clearing blockers, satisfying a manual proof, authorizing rework, and approving a merge when automatic merging is disabled stay with a person. The flows change nothing outside the three targets above.

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

A live scope is dismissed only when every member it still holds is positively attributed to another assignment, by following that member's ancestry to a live supervisor naming a different work key or epoch. Another worker's scope on the same machine is therefore ordinary; an orphaned scope left by a dead supervisor is not, and it fences until an operator attests.

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
- PR head, base, draft state, and mergeability;
- CI producer identity and current-head review;
- branch protection and the App-owned required check, including that "require branches to be up to date" is off, which the merge queue requires;
- a short-lived, single-use merge execution.

The command never uses an admin bypass. Graphyard marks Done only after independently observing the matching merge. Direct or late merges remain visible violations.

Use `master init --no-auto-merge` when an operator must approve each merge request. This preference does not weaken the checks.

## Merge queue

Candidates that pass their own gates enter a single merge queue and land in order. `master status` reports the queue directly:

- `queue` lists every entry with its `position`, `size`, `predictedBase`, `predictedTip`, `ahead` keys, `validated` flag, `waitMinutes`, and refusal `reasons`;
- each work row carries the same placement under `queue`, and `counts.queued` totals the entries.

Only the head of the queue can hold a merge authorization, so `master merge --all` merges one entry per pass and the rest stay refused with an explicit position reason. That is normal, not a fault. Immediately before the provider call the master also rechecks that what lands is a Graphyard-published queue tip for exactly the authorized commit, and that the base branch still lets it land its tested tree: either the base is exactly the commit the candidate was validated on, or it advanced only through earlier queue merges, which leave that tree untouched. Any other advance, or an authorization with no published tip behind it, refuses the merge.

Entries behind the head are re-based by Graphyard, not by the worker. Do not request rework, reassign, or ask an agent to rebase a queued candidate because its position or predicted tip changed; check `queue` and the entry's refusal reason first. An entry that fails its speculative validation is ejected with a recorded reason and must be repaired and re-queued — there is no command to reinsert or reorder it. The mechanism and its invariants are in [GitHub enforcement](github.md#merge-queue).

For the full correctness model, see [GitHub enforcement](github.md) and [architecture](architecture.md).

## Recovery

For a dead worker or provider change:

1. stop the old worker and supervisor;
2. release or let the lease expire, and settle any containment quarantine it left; a submitted
   attempt has no lease left to release, because `complete` ended it;
3. request operator rework if a candidate was already submitted;
4. claim with the replacement worker at a higher epoch;
5. create a fresh workspace and preserve the old attempt.

A `lease-loss` escalation stands only for an attempt abandoned before it submitted, or for an
assignment a replacement claim or rework discarded, and only a declared human session resolves it.
A lease that expired after `complete` raises nothing, and a standing `lease-loss` whose epoch
already has a bound submission is settled by reconciliation itself (`escalation.auto-settled`,
`auto-settled: submitted before expiry`) — do not ask the operator to resolve one, and do not
treat a submitted item whose worker session has ended as an incident needing rework.

The master does not clear blockers, revise requirements, or satisfy human gates on its own. See [operations](operations.md) for recovery commands, including [restarting the durable loop](operations.md#master-coordination-loop).

## Master commands

| Command | Purpose |
| --- | --- |
| `master init --token-stdin [--browser-profile PROFILE]` | Install the operating mode; name the operator's browser profile |
| `master start KIND` | Launch the visible master session with its harness rules |
| `master status` | Work truth, session health, reviews, queue, and `administration` (recent browser actions, pending sudo code) |
| `master dispatch GY-N PROFILE` | Invite a worker to claim ready work |
| `master review GY-N [PROFILE]` | Launch the independent reviewer on the exact candidate |
| `master protection [--apply]` | Reconcile branch protection through the API |
| `master browser app-permissions` | Raise the control-plane App's permissions through the browser |
| `master browser installation-accept` | Accept the installation's pending permission request through the browser |
| `master browser protection [--dry-run]` | Reconcile branch protection through the browser |
| `master harness [KIND] [--apply]` | Generate the master's own harness permissions |
| `master merge GY-N\|--all` | Guarded merge of authorized candidates |
| `master run [--once]` | The durable coordination loop |
