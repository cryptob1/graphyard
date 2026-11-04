<!-- page: Start here | 3 | connect a repository and fleet -->
# Onboard a repository

## 1. Install the control plane

Follow [install](install.md), starting with one worker and a previewed plan.

## 2. Add machines

Connect each worker identity and host with `init --url https://YOUR-HOST --herdr --host-id NAME --token-stdin`. Commit `AGENTS.md`, `.gitignore` and `graphyard.json`; local `.graphyard/` state stays ignored. `init --scan --apply` writes delivery policy. `up` submits onboarding's commit on `graphyard/onboarding` as GY-1 through normal gates; no pull request opens.

Principals and credentials belong to `graphyard install --apply`; its `install.json` is the only roster. Init never writes a principals file or mints credentials, even before an install. Use `principal add|remove` for roster edits.

Without a master, supervise work with [watch](protocol/work-commands.md#watch).

### What the generated instructions authorize

Generated AGENTS.md says every session Graphyard launches receives its instruction as the session's own first request on the runtime command line. Claude also gets `--append-system-prompt-file`. Launcher reminders need no confirmation; other bracketed paste is untrusted data. Role files under `.graphyard/harness/` hold permissions, not instructions.

Read `node $GRAPHYARD_CLI guide TOPIC` for claim, sync, complete, park, blocked, review, proof or master procedures.

### Agent environments

`master environments --create claude,codex --apply` creates login homes under `~/.coding_agents` or `GRAPHYARD_AGENT_ENVIRONMENTS`. Profiles default to `approvals: auto`.

### Connect an account

Settings → Agents → Connect an account writes and smoke-tests the 0600 auth file. Personal login stays with the person.

### Configure the fleet

```sh
graphyard master registry propose --apply
graphyard master registry account set NAME --runtime claude --model opus --home ~/.coding_agents/NAME --reason "Plan"
graphyard master registry role set worker claude-b,claude-c --concurrency 4
```

Proposal includes one master session using reviewer accounts. `--plan NAME` groups shared quota. For W workers and G proof groups, provision `ceil(W/2)` reviewer and `G × ceil(W/2)` producer slots where producers are used. [Control-plane proofs run in trials](master-agent.md#automatic-dispatch-at-submit).

## 3. Start the master

Run `master init` and `master start` under an OS user whose credentials workers cannot read. Add reviewers with `master reviewer add PROFILE` ([example](../examples/master/claude-reviewer.json)); `master review GY-N` relaunches review.

### The loop must be supervised

Init enables its user unit and lingering. To move hosts: `master init --token-stdin --replace-supervisor`. `.graphyard/units.json` records per-repository units. Deploy has a separate supervisor.

### Supervised mode (up --local)

`up --local` sets `supervision: supervised`; absent means autonomous. Add a reviewer then `master promote` to [provision autonomy](master-agent-reference.md#promotion-to-autonomy).

## 4. Prove the first change

`doctor --profile through-merge` names gaps. File a small item; follow dispatch, trial, merge and serving without bypassing gates.

## The dashboard

Default URL: `127.0.0.1:4310`. Viewing it on this machine needs no sign-in; actions and human-only decisions do. Anonymous reads refuse foreign Host, forwarded requests, foreign Origin and cross-site fetch headers; same-origin browsers, direct navigation and headerless local clients can read. `graphyard open` opens a single-use 10-minute sign-in link in your browser; `graphyard login` prints it. Sessions survive restarts and expire after 90 days unused. At 32 active sessions, new sign-ins are refused; sign out or wait for expiry. Postgres stores only token digests, actor and expiry; sign-out deletes the session. Needs you holds human requests; Settings → Agents shows fleet readiness.

Every dashboard page, including an open work item, names the configured repository prominently at the top, above the release line. The name wraps on narrow screens; item controls and navigation remain available.

[Stage labels](glossary.md#plain-stage-labels) distinguish merged, live and verified. The release line and `master status` show the managed app's serving commit, URL and build/check failures, or no deployment configured. They never substitute Graphyard's control-plane build.
