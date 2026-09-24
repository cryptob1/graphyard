<!-- page: Start here | 3 | the human prompts, more machines, the master, and the first PR. -->
# Onboard a repository

From an existing GitHub repository to a working fleet. One command installs the control
plane ([install](install.md) is the full runbook); this guide covers what surrounds it. Start
with one worker; add capacity after the first PR reaches Done. Roles: [glossary](glossary.md).

![Who holds which authority: the human operator, the control plane, Herdr-hosted sessions, and the independent reviewer and producer.](diagrams/roles-and-authority.svg)

Text equivalent: the **human operator** holds `admin` and makes the human-only decisions; the **master** dispatches ready items to **workers**, each with its own lease and worktree; workers push and open PRs; the **reviewer** approves the exact head; **proof producers** submit evidence; Graphyard merges only through the guarded path; Herdr hosts the sessions ([details](how-graphyard-works.md#four-ai-agent-sessions)).

## Before you start

Node 24, Git, a Graphyard checkout, a GitHub repository you administer, an authenticated
GitHub CLI, and one provider. Install the agent CLIs where they run; each account logs in once
in its own [agent environment](#agent-environments). Herdr 0.7.1+ is optional.

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
```

## 1. Install the control plane

```sh
cd /path/to/your-repository
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --plan
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --apply
```

Providers are `railway`, `hetzner`, `docker-host` and `compose`. You are prompted for the
provider (on Railway add `--workspace` if you have several), its login, the GitHub App
confirmation (confirm and install it on this repository), and plan approval (`--apply`).

The App requests the [declared permission set](github.md#app-permissions); later changes are
the master's job (`master browser app-permissions`).

One credential per role is stored under `~/.config/graphyard/<install>/` (mode `0600`), never
printed. Add `--producer-proof NAME` per proof a CI runner may submit and `--reviewer NAME` for
a separate reviewer App. [Operator automation](operator-automation.md) comes after bootstrap.

## 2. Read the summary

`--apply` ends with a redacted summary. Confirm `health`, `status.role`, `status.repository`,
`webhook.delivered`, `protection` and the profiles, then work through `nextSteps`, the
authoritative list of what is missing (often a rerun once `Graphyard / merge` appears). Sign in to the Graphyard URL with the admin credential it names.

## 3. Add machines and capacity

For another worker machine, rerun the installer with a higher `--workers`, or connect it alone:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

Paste that machine's own worker token, Enter, Ctrl-D. Setup updates the managed `AGENTS.md`
section and `.gitignore` (commit both, never `.graphyard/`) and enables the Herdr plugin. Every
concurrent session needs its own worker identity and host ID.

### What the generated instructions authorize

The managed `AGENTS.md` section states that **every session Graphyard launches receives its instruction as the session's own first request, on the runtime's command line, never as pasted text**, and that the one later paste it may receive — the loop's single re-prompt of an inactive session, or the reviewer's reminder to post a verdict it already judged — comes from the same launcher and is to be acted on without confirmation.

Herdr types through bracketed paste, which an agent rightly treats as untrusted data (a prompt injection defence); with the request on the command line ([details](master-agent-sessions.md#the-request-is-the-sessions-first-message)), sessions start without anybody sending `go`. A Claude Code session under a role file loads only user settings, so the launcher writes the statement to `.graphyard/launch/NAME.role` and loads it with `--append-system-prompt-file`. Nothing else pasted carries that authority, and the role files under `.graphyard/harness/` hold permissions, not instructions.

### Agent environments

Each agent CLI account gets its own login home under `~/.coding_agents`, named `<agent>-<letter>` (`claude-a`, `claude-b`, `codex`); `--directory` or `GRAPHYARD_AGENT_ENVIRONMENTS` changes the root.

| Agent | Variable | Login file | Log in with |
| --- | --- | --- | --- |
| Claude Code | `CLAUDE_CONFIG_DIR` | `.credentials.json` | `CLAUDE_CONFIG_DIR=… claude`, then `/login` |
| Codex | `CODEX_HOME` | `auth.json` | `CODEX_HOME=… codex login` |
| OpenCode | `XDG_DATA_HOME` | `opencode/auth.json` | `XDG_DATA_HOME=… opencode auth login` |
| Cursor | `CURSOR_CONFIG_DIR` | `cli-config.json` | `CURSOR_CONFIG_DIR=… cursor-agent login` |

Put worker tokens in `~/.config/graphyard/workers/PRINCIPAL.token` and producer tokens in `~/.config/graphyard/producers/PRINCIPAL.token` (mode 0600). Then:

```sh
node "$GRAPHYARD_CLI" master environments                                # report login and quota
node "$GRAPHYARD_CLI" master environments --create claude,codex --apply  # add claude-<next>, codex-<next>
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-a claude                       # /login, once per environment
node "$GRAPHYARD_CLI" master environments --apply                        # generate the profiles
```

Without `--apply` it reports login state, quota and login commands; with it, it generates a verified profile per worker and producer token and a reviewer profile per logged-in environment, each listing `accounts` in failover order.

### Configure the fleet

Runtimes, accounts, models and which accounts serve each role live in the control plane's **agent registry**; a profile in `.graphyard/master.json` is only a session's Graphyard identity.

```sh
node "$GRAPHYARD_CLI" master registry propose           # what this host has, and the registry it implies
node "$GRAPHYARD_CLI" master registry propose --apply   # store it
node "$GRAPHYARD_CLI" master registry                   # every account, and why any is ineligible
```

A rerun proposes only what is new. Change the fleet from the CLI, `/api/agent-registry` or the dashboard's **Agent fleet** page; `master run` follows without a restart.

### Add a runtime

A runtime is an agent CLI and its launch contract. `claude`, `codex`, `cursor`, `opencode` and `muse` are known; add any other:

```sh
node "$GRAPHYARD_CLI" master registry runtime set aider --kind aider --arg=--yes-always \
  --home-variable AIDER_HOME --model-flag=--model --login 'AIDER_HOME={home} aider --login' --login-file session.json \
  --reason "Add the Aider runtime"
```

Write a value that starts with a dash onto its flag with `=`. A contract never carries a secret.

### Add an account

An account is one login, held by reference (host and home directory), never the credential itself. Record its model first:

```sh
node "$GRAPHYARD_CLI" master registry model set opus --provider Anthropic --id claude-opus-5 \
  --input-cost 15 --output-cost 75 --tier frontier --context 1000000 --reason "Record the model and its price"
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-b claude        # /login, once
node "$GRAPHYARD_CLI" master registry account set claude-b --runtime claude --model opus \
  --home ~/.coding_agents/claude-b --max-sessions 2 --reason "Second Claude subscription"
```

Only an executor on the account's host (`--host`, default this one) launches it, reporting login and quota first; mark what no probe sees yourself:

```sh
node "$GRAPHYARD_CLI" master registry account quota opencode-a exhausted --resets-at 2026-09-22T00:00:00Z --reason "Plan cut off until Monday"
node "$GRAPHYARD_CLI" master registry account quota opencode-a available --reason "Plan renewed"
```

### Add a role

A role lists its accounts, most preferred first, and its concurrency:

```sh
node "$GRAPHYARD_CLI" master registry role set worker claude-b,claude-c,codex-a --concurrency 4 --reason "Prefer Claude; Codex is overflow"
node "$GRAPHYARD_CLI" master registry role set reviewer codex-a,claude-c --concurrency 2 --reason "Review on a different model than the author"
```

Each launch takes its role's first eligible account (on this host, logged in, within quota and limits) ([agent registry](master-agent-sessions.md#the-agent-registry)).

### Size review and proof capacity

Every candidate needs one review and one producer session per proof group; each reviewer and producer profile runs `"concurrency"` sessions at once (1–20, default 1). Edit it in `.graphyard/master.json`; the next tick applies it without a restart, and lowering it drains running sessions.

```json
"reviewers": [{ "name": "claude-reviewer", "agentName": "review-claude", "kind": "claude", "accounts": ["claude-a", "claude-b"], "concurrency": 3 }]
```

Size the gates against your worker count `W` and the `G` proof groups a typical item needs:

- Review slots across reviewer profiles: at least `⌈W / 2⌉`, and at least 2 once there is more than one worker.
- Producer slots: at least `G × ⌈W / 2⌉`, over at least two producer principals (an implementer's principal is refused its own item's evidence).
- One logged-in environment per two or three slots; sessions on one account share its quota.

So per two added workers, add one review slot, `G` producer slots, and accounts. `master status` shows `concurrency` per role (`running`, `limit`, `waiting`, `longestWaitMs`); a role starved for ten minutes counts in `counts.concurrencyStarved`.

### Judge mechanical criteria with a closed question

An item may list yes-or-no proofs in `closedQuestions`. Before launching a producer, the loop has `POST /api/work/GY-N/closed-question` judge each at the exact head through the `GRAPHYARD_RESPONDER` (a local command or HTTP endpoint). A confident answer (probability at least 0.9) is recorded as evidence with the state hash and no session launches; anything else, or any proof without a responder, takes the ordinary producer path. `exclude.sources` (default `pull-request-body`, `comments`) and `exclude.paths` keep untrusted text from the responder. Measure agreement first (`accuracyStudy` in `src/model/closed-question.ts`).

### Profiles by hand

Add a [template](master-agent-sessions.md#add-a-worker) with `master worker add PROFILE`. Launch profiles default to `"approvals": "auto"`, so sessions never block on a permission prompt (the trade-off: an unattended session); `"approvals": "prompt"` is the opt out ([approval modes](master-agent-sessions.md#approval-modes)). Local profiles need Linux with a systemd user manager; otherwise run workers elsewhere, under GitHub identities that cannot merge the base branch.

## 4. Start the master

```sh
node "$GRAPHYARD_CLI" master start codex
```

The master routes work, merges through the guarded path and administers GitHub; it never implements or submits evidence. Run it under an OS identity whose GitHub credentials workers cannot read.

For `master browser` administration, give it the Chrome profile signed in to GitHub as repository administrator:

```sh
node "$GRAPHYARD_CLI" master init \
  --url https://YOUR-GRAPHYARD-HOST \
  --browser-profile Default \
  --token-stdin < ~/.config/graphyard/INSTALL/tokens/INSTALL-master.token
```

It never stores or exports the cookies ([details](master-agent-reference.md#github-administration-through-the-browser)); you only approve *Confirm access* in GitHub Mobile with the code `master status` shows.

### Executors, supervised

Executors claim and run each item's next action. From the coordinator checkout, after `master init`, `node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST` writes `.graphyard/executors.json` and installs [`graphyard-executor@.service`](../examples/master/graphyard-executor@.service) instances ([details](master-agent-reference.md#running-executors-under-supervision)).

`master start claude` writes the master's harness permissions to `.claude/settings.local.json` (review with `master harness claude`); `master harness codex` prints Codex's trust block.

To add a reviewer: `master reviewer setup` (or `master reviewer bind FILE --key-stdin`), then `master reviewer add PROFILE` ([Claude](../examples/master/claude-reviewer.json) template). The only App confirmation is the manifest flow's; the master reconciles protection itself.

### The loop must be supervised

An unsupervised `master run` that dies stays down. `master init` from the coordinator checkout (never `graphyard install`) writes `~/.config/systemd/user/graphyard-master.service`, runs `systemctl --user enable --now graphyard-master.service` and `loginctl enable-linger`; the unit restarts on crash, reboot and hang.

Installing it is explicit, never a side effect: tests, worker checkouts and temporary directories are refused. To move it, run `master init --token-stdin --replace-supervisor` from the new checkout.

```sh
node "$GRAPHYARD_CLI" master status   # setup.supervisor: installed, enabled, active, linger
journalctl --user -u graphyard-master.service -f
```

A missing or stopped supervisor is an attention item naming its fix. Without systemd, use an always-restart supervisor.

## 5. Prove the first PR

```sh
node "$GRAPHYARD_CLI" doctor --profile through-merge
```

Every `missing` item names its fix. Create a small real item with the exact CI check names and proofs and dispatch it (`master dispatch GY-1 PROFILE`), or on a remote worker:

```sh
node "$GRAPHYARD_CLI" claim GY-1
node "$GRAPHYARD_CLI" worktree GY-1 EPOCH origin/YOUR_BASE_BRANCH
cd .graphyard/worktrees/GY-1-EPOCH
node "$GRAPHYARD_CLI" watch GY-1 EPOCH -- YOUR_AGENT_COMMAND
```

The worker pushes its branch, opens a PR and runs `complete GY-1 EPOCH PR_NUMBER`; it never force-pushes ([push rights](master-agent-reference.md#worker-push-rights)). Review starts automatically (`master review GY-1` is the recovery path). Evidence comes from a `producer` in protected CI or a producer session; a `manual:` proof is attested through an approved decision ([evidence](protocol/evidence.md)).

When `Graphyard / merge` appears, add it to branch protection with "require branches to be up to date" off ([merge queue](github.md#merge-queue)), then `master merge GY-1`. Done means Graphyard observed the authorized merge, not that it is deployed.

Before adding workers, let one lease expire, reclaim with another identity, and confirm the old epoch can no longer heartbeat or submit.

## What is still manual

Logging in the provider CLI, GitHub CLI and agent environments; confirming the App once; approving the plan; signing in the browser profile and approving *Confirm access*; granting producers their proofs; and the human-only decisions (goals and priorities, spending money or opening accounts, issuing credentials to people). Every intervention counts as product feedback ([interventions](interventions.md)).
