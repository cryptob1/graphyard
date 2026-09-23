<!-- page: Start here | 3 | the human prompts, more machines, the master, and the first PR. -->
# Onboard a repository

This is the supported path from an existing GitHub repository to a working fleet. One
command installs the control plane — see [install](install.md) for the full runbook — and
this guide covers what surrounds it: the human prompts, adding machines, starting the
master, and proving the first pull request. Start with one worker; add capacity after the
first PR reaches Done. Roles are defined in the [glossary](glossary.md).

![Who holds which authority in Graphyard: the human operator sends human-only decisions to the Graphyard control plane; the Herdr runtime hosts the master, slice lead, and worker sessions, each with one credential; the reviewer, proof producer, and optional operator agent sit beside them; sessions send authenticated commands to Graphyard, the worker pushes its branch and opens the pull request on GitHub, the reviewer approves the exact head, and Graphyard observes GitHub facts and merges only through the guarded path.](diagrams/roles-and-authority.svg)

Text equivalent: you, the **human operator**, hold the `admin` credential and make the human-only decisions. The **master** (`coordinator`) reads work and gate state from Graphyard, dispatches ready items to supervised **workers** (`worker`, each with its own lease and assigned worktree), notices stalls, and performs routine exact-candidate merges when every configured gate passes. Workers push branches and open pull requests on GitHub; the **reviewer** (a separate GitHub identity) approves the exact head; **proof producers** (`producer`) submit acceptance evidence; Graphyard observes GitHub and merges only through the guarded path. Herdr hosts the sessions and reports their health. A fuller description accompanies the same diagram in [How Graphyard works](how-graphyard-works.md#four-ai-agent-sessions).

You keep talking directly to the master. GitHub owns code review and CI facts; proof producers produce acceptance evidence.

The initial setup works with one worker. Add more workers or machines only after the first PR has completed the full loop.

## Before you start

You need Node 24, Git, a Graphyard checkout, a GitHub repository you administer, and access
to one supported provider — a Railway account, a Hetzner account, any Docker host, or Docker
locally for the `compose` provider. The GitHub CLI must be authenticated as an identity that
administers the base branch. The agent CLIs (Claude Code, Codex, OpenCode, Cursor) must be
installed on the machine that runs them, and each provider account is logged in once, in its
own [agent environment](#agent-environments); Herdr 0.7.1+ is optional and is bound
automatically when it is installed.

Graphyard is not published to npm yet. In the commands below:

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
```

## 1. Install the control plane

One command replaces the former sequence of deploying a server, generating a token per role,
setting eleven variables, creating a domain, running the GitHub App flow, configuring the
webhook and branch protection, discovering CI App IDs, connecting a worker, and initializing
the master.

```sh
cd /path/to/your-repository
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --plan
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --apply
```

Follow [install](install.md) for the full runbook: preconditions, per-step verification, and
failure handling. Providers are `railway`, `hetzner`, `docker-host`, and `compose`.

You are prompted for exactly four things:

| Prompt | What to do |
| --- | --- |
| Which provider | Already answered by `--provider`; on Railway, add `--workspace NAME-OR-ID` when the account belongs to several workspaces |
| Provider login | Run the login command the installer prints, once |
| The GitHub App confirmation | Open the printed page, confirm the App, install it on this repository |
| Plan approval | Read the plan, then rerun with `--apply` |

The App manifest the installer opens requests exactly the
[declared control-plane permission set](github.md#app-permissions), and the App is installed
only on the managed repository. An App registered before the merge queue must be
[migrated](github.md#migrating-an-existing-app) to Contents: read and write; the
[upgrade order](install.md#upgrading-an-existing-installation) covers that. Later permission
changes to the control-plane App, and the installation's acceptance of them, are the master's
job, not yours: once the master runs with a browser profile it
performs them with `master browser app-permissions` and `master browser installation-accept`
(see [step 4](#4-start-the-master)).

The installer reads the CI check names and their GitHub App IDs from the checks already
published on the base branch and prints them in the plan; confirm them there. GitHub Actions
uses App ID `15368`; other CI providers do not.

The installer generates one credential per role, stores each under
`~/.config/graphyard/<install>/` with mode `0600`, and never prints one. Add
`--producer-proof NAME` for each proof a CI runner may submit; without it no producer
principal is created, which is the safe default. Add `--reviewer NAME` to also register a
separate reviewer GitHub App for [agent review](github.md#identity-bound-agent-review-providers).

Do not create an operator-agent credential during this bootstrap. After the repository is
connected and its gates have completed the protected loop, the human operator may
optionally configure [scoped operator automation](operator-automation.md). That mode keeps
operator agent, master, worker, and reviewer/proof producer as four distinct AI agent
sessions; it does not replace human goals, approvals, exceptions, or oversight.

## 2. Read the summary

`--apply` ends with a redacted summary. Confirm `health`, `status.role`, `status.repository`,
`webhook.delivered`, `protection`, and the registered profiles, then work through its
`nextSteps`. Those steps are generated from what actually happened, so they are the
authoritative list of anything still missing — commonly a rerun once Graphyard has published
`Graphyard / merge` on the first pull request.

Open the Graphyard URL and sign in with the admin credential named in the summary.

## 3. Add machines and capacity

The installer configures this machine: the repository connection, the Herdr plugin when
Herdr is present, the master profile, and one worker profile per `--workers`.

For another worker machine, rerun the installer there with a higher `--workers` count, or
connect that machine alone against the existing control plane:

```sh
cd /path/to/your-repository
node "$GRAPHYARD_CLI" init \
  --url https://YOUR-GRAPHYARD-HOST \
  --herdr \
  --host-id UNIQUE_MACHINE_NAME \
  --token-stdin
```

Supply that machine's own worker token on standard input; paste it, press Enter, then
Ctrl-D. Setup verifies the repository and worker identity, updates one managed section in
`AGENTS.md`, adds the `.graphyard/` ignore rule, stores the private connection locally, and
links and enables the Herdr plugin. Commit `AGENTS.md` and `.gitignore`. Never commit
`.graphyard/`. Give every concurrent session a different worker identity and host ID.

### What the generated instructions authorize

The managed `AGENTS.md` section is the coordination contract every agent runtime reads from the repository (Codex, Cursor and OpenCode natively; Claude Code where the project has no `CLAUDE.md`), and it carries one statement the launched sessions need in order to start on their own: **every session Graphyard launches receives its instruction as the session's own first request, on the runtime's command line, never as pasted text — and the one message it may later receive as a paste comes from that same launcher, repeating the session's own request, and is to be acted on without waiting for confirmation.**

It is generated because of how sessions used to fail. Herdr types a prompt into a running session through bracketed paste, and a coding agent treats pasted text as untrusted data rather than as a request from its operator — the right behaviour against prompt injection, and the wrong outcome for a launch: a producer, reviewer or approver session would end its first turn having refused to act, until a human typed `go` into its tab, and the loop would record the attempt as failed and spend a retry on work that was never attempted. The launchers now put the request on the runtime's command line ([the request is the session's first message](master-agent.md#the-request-is-the-sessions-first-message)), so a new installation's producer, reviewer and approver sessions start without anybody sending `go`; the generated statement is what lets the two pastes a session can still receive — the loop's single re-prompt of a session that has shown no activity, and the reviewer's reminder to post a verdict it already judged — be taken as the operator's instruction. A Claude Code session that the master launches under a role file loads only the user settings, which leaves `AGENTS.md` out, so the launcher writes the same statement to that session's role file (`.graphyard/launch/NAME.role` in the session's checkout) and loads it on the command line (`--append-system-prompt-file`); the request itself reaches the runtime the same way, from `NAME.request`, so what is typed into the pane stays short whatever the request holds ([how the request reaches the runtime](master-agent.md#how-the-request-reaches-the-runtime)). Nothing else pasted into a session carries that authority, and no other generated file grants any: the role files under `.graphyard/harness/` hold permissions, not instructions.

### Agent environments

Every agent CLI account gets its own isolated config and login home, an *agent environment*: one directory per account, named `<agent>-<letter>`, under `~/.coding_agents` (pass `--directory DIR` or set `GRAPHYARD_AGENT_ENVIRONMENTS` to use another root). Two Claude subscriptions are `claude-a` and `claude-b`; a single Codex login may simply be `codex`. The launcher selects an environment with the runtime's own variable, so accounts never share a login:

| Agent | Variable set to the environment | Login held inside it | Log in with |
| --- | --- | --- | --- |
| Claude Code | `CLAUDE_CONFIG_DIR` | `.credentials.json` | `CLAUDE_CONFIG_DIR=… claude`, then `/login` |
| Codex | `CODEX_HOME` | `auth.json` | `CODEX_HOME=… codex login` |
| OpenCode | `XDG_DATA_HOME` (data under `opencode/`) | `opencode/auth.json` | `XDG_DATA_HOME=… opencode auth login` |
| Cursor | `CURSOR_CONFIG_DIR` | `cli-config.json` | `CURSOR_CONFIG_DIR=… cursor-agent login` |

Store each worker principal's token in `~/.config/graphyard/workers/PRINCIPAL.token` and each proof producer's in `~/.config/graphyard/producers/PRINCIPAL.token` (mode 0600; the directory beside the coordinator credential `master init` stored, so `$GRAPHYARD_CONFIG_HOME` if you set it). Then:

```sh
node "$GRAPHYARD_CLI" master environments                                # discover; report login and quota
node "$GRAPHYARD_CLI" master environments --create claude,codex --apply  # add claude-<next>, codex-<next>
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-a claude                       # /login, once per new environment
node "$GRAPHYARD_CLI" master environments --apply                        # generate the profiles
node "$GRAPHYARD_CLI" master status
```

Without `--apply` the command writes nothing: it lists every environment with whether it is logged in, the provider quota it could read (Claude's 5-hour and 7-day usage, Codex's last reported rate-limit windows; OpenCode and Cursor expose none, reported as `unknown`), and the exact login command for each one that is not. With `--apply` it records the environments in `.graphyard/master.json`, sets the one runtime setting an unattended Claude launch needs (`skipDangerousModePermissionPrompt`), and generates profiles from the logged-in environments — no profile JSON by hand:

- one worker profile per worker token, each verified against Graphyard as that principal with the `worker` role;
- one producer profile per producer token, verified for the `producer` role and never shared with a worker principal;
- one reviewer profile per logged-in environment, with the first one answering automatic reviews;
- every profile's `accounts` lists the logged-in environments in failover order, its own runtime's first and rotated so profiles start on different accounts. An existing profile keeps the order it has and gains accounts that logged in since; a home it pinned with `CLAUDE_CONFIG_DIR` becomes its first account.

Rerun `master environments --apply` after logging in another account; nothing changes when nothing new logged in. These profiles give each session its Graphyard identity; which runtime, account and model a launch runs on is decided by the agent registry, configured next.

### Configure the fleet

The fleet — which agent CLIs exist, which logins each has, what model each login runs, and which logins may serve which role — lives in the control plane's **agent registry**, not in a file on the coordinator host. A profile in `.graphyard/master.json` is only the Graphyard identity a session acts under (its principal and credential file); the runtime, account and model a launch actually runs on are chosen from the registry, per action. Setup proposes the registry from what the host already has:

```sh
node "$GRAPHYARD_CLI" master registry propose           # what is logged in on this host, and the registry it implies
node "$GRAPHYARD_CLI" master registry propose --apply   # store it in the control plane
node "$GRAPHYARD_CLI" master registry                   # every account, and why any is ineligible
```

`master init` prints the same proposal at the end of the install. Discovery reads the isolated environments above, each runtime's own default login home (`~/.claude`, `~/.codex`, `~/.cursor`, OpenCode's data directory), and notes an installed `muse`; it proposes one runtime per CLI found with its launch contract, one account per logged-in login (the home it found, on this host), a placeholder `<runtime>-default` model per runtime, and all five roles — worker, reviewer, producer, approver, escalation handler — over those accounts. Nothing is stored without `--apply`, a rerun proposes only what is new, and an order you arranged is never reshuffled. After that the fleet is changed from anywhere that holds the coordinator credential — this CLI, the API (`/api/agent-registry`), or the dashboard's **Agent fleet** page — and a running `master run` follows on its next action: no restart, no file edit.

Adding capacity by hand follows the same order the proposal does, because each entry names the one before it.

### Add a runtime

A runtime is an agent CLI and its **launch contract**: what to start, the arguments every session of it starts with, the variable that points it at one login home, the flag that selects a model, and how to log in. The five runtimes Graphyard knows (`claude`, `codex`, `cursor`, `opencode`, `muse`) are proposed with their contracts; any other CLI is one command:

```sh
node "$GRAPHYARD_CLI" master registry runtime set aider --kind aider --arg=--yes-always \
  --home-variable AIDER_HOME --model-flag=--model --login 'AIDER_HOME={home} aider --login' --login-file session.json \
  --reason "Add the Aider runtime"
```

`--kind` is the executable (Herdr's agent kind); a value that starts with a dash is written onto its flag with `=`, as `--arg=--yes-always` and `--model-flag=--model` are here — written apart, the shell hands the CLI two flags and it refuses. `--login-file` is a path inside the login home whose presence means "logged in", for runtimes whose login and quota Graphyard cannot read itself. A contract never carries a secret: a variable named like a token, a `GRAPHYARD_` variable, or a value that looks like a credential is refused.

### Add an account

An account is one login of a runtime. It holds the credential **by reference** — the host whose disk holds the login and the home directory it lives in — and never the credential itself. Record the model it runs first, with what it costs and what it is good for, then the account:

```sh
node "$GRAPHYARD_CLI" master registry model set opus --provider Anthropic --id claude-opus-5 \
  --input-cost 15 --output-cost 75 --tier frontier --context 1000000 --reason "Record the model and its price"
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-b claude        # /login, once: the credential stays in this home
node "$GRAPHYARD_CLI" master registry account set claude-b --runtime claude --model opus \
  --home ~/.coding_agents/claude-b --max-sessions 2 --reason "Second Claude subscription"
```

`--host` defaults to this host; an account is *placed* where its login is, so only an executor on that host launches it, and a fleet may span several hosts. `--max-sessions` bounds how many sessions share the login at once. A `set` names only what changes — `account set claude-b --model sonnet --reason …` moves the model and keeps the rest. Executors observe each account's login and provider quota before every launch and report it to the registry (state, usage windows and reset time); for what no probe can see, mark it yourself — the mark holds until its reset or until you clear it:

```sh
node "$GRAPHYARD_CLI" master registry account quota opencode-a exhausted --resets-at 2026-09-22T00:00:00Z --reason "Plan cut off until Monday"
node "$GRAPHYARD_CLI" master registry account quota opencode-a available --reason "Plan renewed"
```

### Add a role

A role names the accounts that may serve it, **most preferred first**, and how many of its sessions may run at once:

```sh
node "$GRAPHYARD_CLI" master registry role set worker claude-b,claude-c,codex-a --concurrency 4 --reason "Prefer Claude; Codex is overflow"
node "$GRAPHYARD_CLI" master registry role set reviewer codex-a,claude-c --concurrency 2 --reason "Review on a different model than the author"
```

Every worker dispatch, reviewer, producer and approver launch then runs on the first account of its role that is placed on the executor's host, logged in, within quota, under its own session limit, with the role under its concurrency limit. The control plane makes the choice, and records it with its reason and every account it passed over; `master registry` and the Agent fleet page show each account's runtime, model, roles, live sessions, quota, reset time and — when it cannot launch — exactly why. Removing capacity is the same kind of change: `master registry account remove NAME --reason …` takes the account out of every role, and `master registry runtime remove NAME --reason …` removes the runtime with its accounts, so each role falls back to the accounts that remain, in the order they held. A role the registry does not define yet keeps launching from its local profile, so an existing installation moves onto the registry one role at a time. See [the agent registry](master-agent.md#the-agent-registry).

### Size review and proof capacity

Workers scale horizontally, but every candidate they produce must then pass one review and one
producer session per proof group, and those gates run only as many sessions at once as the fleet
declares. Each reviewer and producer profile carries `"concurrency"` (1–20; absent means 1): how
many sessions it runs at the same time. A profile that runs one session keeps its fixed Herdr
name; one that runs more names each session for the request it answers, so reviews of different
items run side by side. Set it in the profile file `master reviewer add` or `master producer add`
reads, or edit `.graphyard/master.json` while the loop runs: the next dispatch tick honours the
new limit without a restart, and lowering it lets the running sessions drain rather than stopping
one. Concurrency is declared per role — the reviewer profiles together bound the review lane, the
producer profiles the proof lane — and `master environments --apply` generates every profile at
one, so an installation sizes the gates itself, against its worker count, before it adds workers:

```json
"reviewers": [{ "name": "claude-reviewer", "agentName": "review-claude", "kind": "claude", "accounts": ["claude-a", "claude-b"], "concurrency": 3 }],
"producers": [{ "name": "producer-a", "principal": "proof-runner", "agentName": "produce-a", "kind": "claude", "credentialFile": "/home/me/.config/graphyard/producers/proof-runner.token", "concurrency": 2 }]
```

The rule of thumb, for `W` workers and `G` proof groups a typical item needs (`unit` and
`integration`; `manual` too when items list `producerProofs`): a build occupies a worker for hours
while a review occupies a reviewer for minutes, and a proof group for tens of minutes, so about
half the workers can have a candidate at the gates at once.

- Review slots, summed over every reviewer profile: at least `⌈W / 2⌉`, and at least 2 once
  there is more than one worker, so a second candidate is never queued behind the one under
  review.
- Producer slots, summed over every producer profile: at least `G × ⌈W / 2⌉`, spread over at
  least two producer principals, so that an item its implementer's principal is barred from still
  has an independent producer; a principal that held an assignment on an item is refused that
  item's evidence however many slots its profile has.
- One logged-in agent environment per two or three slots, listed in the profiles' `accounts`:
  every session draws on the provider quota of the account it runs on, so two sessions on one
  account share its rate limits and spend it twice as fast. Add environments with
  `master environments --create … --apply` and log each one in.

So an operator adding workers adds, with them: one review slot per two workers, `G` producer
slots per two workers, and the accounts to carry them. Then read `master status`: `concurrency`
lists, per role, `running` against `limit`, `waiting`, and `longestWaitMs` — how long the longest
request has waited for a slot. A role whose `running` sits at `limit` while `waiting` is above zero
and `longestWaitMs` keeps climbing is starving; after ten minutes `master status` raises it as
`reviewer concurrency` or `producer concurrency` in `attentionItems`, addressed to the master with
the remedy, and counts it in `counts.concurrencyStarved`. Raise `concurrency` on a profile whose
accounts have quota left, or add a profile on another account. See
[per-role concurrency](master-agent.md#automatic-dispatch-at-submit) for what the dispatcher does
with the limit.

### Profiles by hand

Worker profile templates, for a profile added by hand:

- [Codex](../examples/master/codex-worker.json)
- [Claude](../examples/master/claude-worker.json)
- [existing Herdr session](../examples/master/existing-worker.json)

```sh
node "$GRAPHYARD_CLI" master worker add /path/to/profile.json
node "$GRAPHYARD_CLI" master status
```

Every launch profile starts non-interactively by default (`"approvals": "auto"`): Graphyard adds that runtime's own startup flags so a fresh session never blocks on an approval or workspace-trust prompt. `master worker add` prints exactly what it will start with and what that costs. Set `"approvals": "prompt"` to opt out per profile; the session then waits for a human in its tab. See [approval modes](master-agent.md#approval-modes).

Local launch profiles share the coordinator host. They require Linux with a working systemd
user manager for durable containment. Use them only for trusted dogfooding or inside a real
OS or container boundary that hides coordinator GitHub credentials. On macOS, or a Linux host
without user systemd, run workers on other machines with GitHub identities that can push
branches and open pull requests but cannot merge the protected base branch. Version 0.1 does
not remotely launch supervised Herdr tabs across hosts; the master selects work and the
remote worker claims it.

## 4. Start the master

```sh
node "$GRAPHYARD_CLI" master start codex
```

Use the agent kind reported as `profiles.master.kind` in the summary; `master start claude`
if you prefer. The master reads Graphyard truth, watches runtime health, routes work,
requests guarded merges, and administers GitHub for the managed repository. It does not
implement work or submit evidence. Run it from a checkout under a dedicated coordinator OS
identity that does not expose its merge-capable GitHub CLI credentials to worker sessions.

To let the master administer the control-plane App, its installation, and branch protection
itself, give it the Chrome profile on this machine that is signed in to GitHub as the
repository administrator (`agent-browser profiles` lists them). The installer wrote
`.graphyard/master.json` without one; add it by re-running master setup with the coordinator
credential the installer stored, redirected from its file so it is never printed:

```sh
node "$GRAPHYARD_CLI" master init \
  --url https://YOUR-GRAPHYARD-HOST \
  --browser-profile Default \
  --token-stdin < ~/.config/graphyard/INSTALL/tokens/INSTALL-master.token
```

`INSTALL` is the `installDirectory` name from the summary. Master setup is idempotent: the
existing worker and reviewer profiles are kept. With a browser profile the master performs
GitHub administration through the API where one exists and otherwise through that profile,
headless, with every step recorded, verified, and audited (see [GitHub administration through
the browser](master-agent.md#github-administration-through-the-browser)). The profile is your
identity: the master never stores or exports its cookies and uses it only for those flows. The
one thing it still needs from you is approving GitHub's *Confirm access* prompt on your device
when a page asks for it; `master status` shows the two-digit GitHub Mobile code to choose.

`master start claude` also writes the master's own harness permissions to
`.claude/settings.local.json` before the session starts, so routine master commands do not
stop for an approval keypress and the auto-mode classifier does not refuse the GitHub
administration flows as permission grants or CI bypasses. Review them with `master harness
claude`; every rule is printed with the reason it exists. The generated rules grant no merge
path and no credential read. For Codex, `master harness codex` prints the
`trust_level = "trusted"` block to add to `$CODEX_HOME/config.toml`; Graphyard does not edit
that shared user file for you.

The installer registers the reviewer App and its launch profile when you pass `--reviewer
NAME`. To add or replace one later, use `master reviewer setup`, `master reviewer bind FILE
--key-stdin` for an App you already created, and `master reviewer add PROFILE` with one of
the shipped reviewer profiles — [Claude](../examples/master/claude-reviewer.json),
[Cursor](../examples/master/cursor-reviewer.json), or
[opencode](../examples/master/opencode-reviewer.json); see
[master-agent mode](master-agent.md). A reviewer profile holds no Graphyard credential: a
reviewer reads a candidate and posts one GitHub verdict. From here on the master reconciles
branch protection itself after every review-policy change with `master protection --apply`,
or, when only the settings page can make the change, with `master browser protection`.

### The loop must be supervised

The coordination loop (`master run`) is a process, and a process that is not supervised stays down. Graphyard reports a loop that is absent or stalled as its top attention item with the command that restarts it, but nothing acts on that item unless a supervisor does: on 2026-09-21 an unsupervised loop was down for four hours, twenty-one requests queued behind it, and the pipeline still read as busy. Treat an unsupervised loop as an incomplete installation.

`graphyard install` writes the master profile but never installs the supervisor, because installing it is an explicit operator action (below): run the `master init` command above from the coordinator checkout once the install succeeds. `master init`, run by you from the coordinator checkout, installs the supervisor. On a Linux host with a systemd user manager it writes `~/.config/systemd/user/graphyard-master.service` from this installation's own checkout, launcher, and cycle interval, reloads systemd if the file changed, runs `systemctl --user enable --now graphyard-master.service`, and runs `loginctl enable-linger` so this user's manager starts at boot. The unit restarts the loop after a crash (`Restart=always` with no start limit), after a reboot (`WantedBy=default.target` plus lingering), and after a *hang*: the loop sends systemd a keep-alive at the end of every cycle, so `WatchdogSec` restarts it when the cycles stop rather than only when the process does. Re-running `master init` is idempotent — an unchanged unit is left alone and nothing is reloaded; a unit rewritten for a changed interval is reloaded and restarted — and setup prints exactly what it did under `supervisor.performed`.

Installing the unit is that explicit operator action and never a side effect. Nothing else writes it: not a library call, not the test suite (which is refused, by one shared guard, any home outside the system temporary directory; the guard reads the test runner's mark from its own process, so nothing a test passes or omits can switch it off), and not a worker, reviewer, or producer checkout. `master init` itself refuses, by name and without failing the rest of setup, a checkout under the system temporary directory (`/tmp`, `/var/tmp`, `$TMPDIR`), a checkout inside a managed `.graphyard` directory (an assignment worktree or session checkout), and a directory that holds no `.graphyard/master.json`. It also refuses to replace a unit that already runs a different checkout or launcher: if that unit is the coordinator you mean to replace, re-run `master init --token-stdin --replace-supervisor` from the new checkout. A refusal is reported under `supervisor.refused` with the command that resolves it, and at the top of `attention` and `next`.

Confirm it, on this host, rather than assuming it:

```sh
node "$GRAPHYARD_CLI" master status   # setup.supervisor: installed, enabled, active, linger
systemctl --user status graphyard-master.service
journalctl --user -u graphyard-master.service -f
```

`master status` reads the answer from systemd every time it runs, lingering included (`loginctl show-user` for this user). A supervisor that is missing, disabled, stopped, or unreadable becomes an attention item naming the exact command that fixes it (`systemctl --user enable --now graphyard-master.service` for a disabled unit, `systemctl --user start graphyard-master.service` for a stopped one, `loginctl enable-linger` when this user's manager would not start at boot, and `master init` on this host when no unit is installed), and the same facts appear under `setup.supervisor`.

On a host where Graphyard cannot install one — any non-Linux host, or a container or session with no reachable systemd user manager — setup says so instead of leaving the promise unkept, and prints what you must run: keep `master run` alive under that platform's own always-restart supervisor (launchd, an init service, a container restart policy), configured to start at boot. The self-healing described above does not happen on such a host until you provide it.

## 5. Prove the first PR

Before the first PR, read the readiness checklist for the completion profile you intend to enforce:

```sh
node "$GRAPHYARD_CLI" doctor --profile through-merge
```

Every `missing` item names the command or setting that resolves it — a missing credential, an App permission, an unapplied proposal, an unsupported test format. A ready checklist is configuration, not proof; the PR below is what demonstrates enforcement.

Create a small real work item in the UI. Use the repository's exact CI check names and acceptance proofs.

A trusted local profile can be dispatched with:

```sh
node "$GRAPHYARD_CLI" master dispatch GY-1 codex-primary
```

A remote worker uses Herdr or the CLI:

```sh
git fetch origin YOUR_BASE_BRANCH
node "$GRAPHYARD_CLI" claim GY-1
node "$GRAPHYARD_CLI" worktree GY-1 EPOCH origin/YOUR_BASE_BRANCH
cd .graphyard/worktrees/GY-1-EPOCH
node "$GRAPHYARD_CLI" watch GY-1 EPOCH -- YOUR_AGENT_COMMAND
```

The worker pushes the assigned branch, opens a PR, and runs `node "$GRAPHYARD_CLI" complete GY-1 EPOCH PR_NUMBER`. Graphyard waits for current-head review, CI, and trusted acceptance evidence.

Launch the independent review from the master; it verifies the exact observed candidate first and binds the session to that head, base, and policy revision:

```sh
node "$GRAPHYARD_CLI" master review GY-1
node "$GRAPHYARD_CLI" master status
```

`master status` lists pending and completed reviews. When the reviewer posts its verdict on that exact commit, Graphyard closes the session and removes its credential.

Connect that evidence before merging. Version 0.1 has no general-purpose runner: put a narrowly scoped `producer` token in protected CI that pull-request code cannot read, then submit the current candidate's actual result. For a criterion explicitly defined with a `manual:` proof, the human operator inspects and submits it from a separate `admin`-authenticated terminal or dashboard sign-in; never expose that credential to the worker checkout. An `admin` cannot certify automated proof names. See [evidence submission](protocol/evidence.md).

When `Graphyard / merge` first appears, add it to branch protection — with "require branches to be up to date" off, which the [merge queue](github.md#merge-queue) requires. After every gate passes:

```sh
node "$GRAPHYARD_CLI" master merge GY-1
```

Done means Graphyard observed that authorized merge. It does not yet mean deployed or production-verified.

Before adding more workers, stop one worker, let its lease expire, reclaim with another identity, and confirm the old epoch can no longer heartbeat or submit.

## What is still manual

The installer covers deployment, identities, GitHub integration, protection, profiles, and
verification. The human operator still authenticates the provider CLI, the GitHub CLI, and each agent
environment in to its provider, confirms each GitHub App in the browser once in the manifest flow, approves the plan,
signs the master's browser profile in to GitHub once and approves GitHub's *Confirm access*
prompt on their device when a page asks for it, and connects project-specific trusted evidence
by granting a producer its proof names. App permission updates, installation acceptance, and
branch-protection reconciliation are the master's (`master browser …` and `master protection
--apply`), and Graphyard still refuses to create protection that is missing the
`Graphyard / merge` binding or a classic rule for the base branch. Decisions the guides mark
human-only — releasing work, revising requirements, choosing review providers, clearing
blockers, manual proofs, rework, and merge approval without automatic merging — stay with
you. Self-hosting is the complete product: versioned images, Compose, the Helm chart, backups
and restores need no hosted account. A hosted signup flow is not shipped, and turnkey E2E
execution covers the [packaged Playwright runner](runner-setup.md) and the
[report adapters](report-adapters.md) it accepts.

Use the [documentation index](README.md) for deeper setup, operations, and protocol details.
