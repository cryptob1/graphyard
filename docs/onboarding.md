<!-- page: Start here | 3 | the human prompts, more machines, the master, and the first PR. -->
# Onboard a repository

The supported path from an existing GitHub repository to a working fleet. One command
installs the control plane — see [install](install.md) for the full runbook — and this guide
covers what surrounds it. Start with one worker; add capacity after the first PR reaches
Done. Roles are defined in the [glossary](glossary.md).

![Who holds which authority in Graphyard: the human operator sends human-only decisions to the control plane; Herdr hosts the master, lead and worker sessions, each with one credential; the reviewer, proof producer and optional operator agent sit beside them; the worker pushes and opens the PR, the reviewer approves the exact head, and Graphyard merges only through the guarded path.](diagrams/roles-and-authority.svg)

The **human operator** holds `admin` and the human-only decisions. The **master**
(`coordinator`) dispatches ready items to **workers** (each with its own lease and worktree)
and merges exact candidates when every gate passes. The **reviewer** (a separate GitHub
identity) approves the exact head; **proof producers** submit acceptance evidence. See
[How Graphyard works](how-graphyard-works.md#four-ai-agent-sessions).

## Before you start

Node 24, Git, a Graphyard checkout, a GitHub repository you administer, an authenticated
GitHub CLI, and one provider: Railway, Hetzner, any Docker host, or local Docker for
`compose`. Install the agent CLIs (Claude Code, Codex, OpenCode, Cursor) where they run; each
account logs in once in its own [agent environment](#agent-environments). Herdr 0.7.1+ is
optional and bound automatically.

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
```

## 1. Install the control plane

```sh
cd /path/to/your-repository
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --plan
node "$GRAPHYARD_CLI" install --provider railway --repo OWNER/REPO --workers 1 --apply
```

Providers are `railway`, `hetzner`, `docker-host` and `compose`. You are prompted for four
things: the provider (`--provider`; on Railway add `--workspace` if you have several), the
provider login, the GitHub App confirmation (confirm and install it on this repository), and
plan approval (rerun with `--apply`).

The App requests the [declared permission set](github.md#app-permissions); later permission
changes are the master's job (`master browser app-permissions`). The plan lists the CI check
names and App IDs read from the base branch.

One credential per role is stored under `~/.config/graphyard/<install>/` (mode `0600`) and
never printed. Add `--producer-proof NAME` for each proof a CI runner may submit (none by
default) and `--reviewer NAME` to register a separate reviewer App. Do not create an
operator-agent credential during bootstrap; [operator automation](operator-automation.md) is
optional later.

## 2. Read the summary

`--apply` ends with a redacted summary. Confirm `health`, `status.role`, `status.repository`,
`webhook.delivered`, `protection` and the profiles, then work through `nextSteps` — the
authoritative list of what is still missing (commonly a rerun once `Graphyard / merge` has
appeared on the first PR). Sign in to the Graphyard URL with the admin credential it names.

## 3. Add machines and capacity

For another worker machine, rerun the installer with a higher `--workers`, or connect it alone:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

Paste that machine's own worker token, Enter, Ctrl-D. Setup updates the managed `AGENTS.md`
section and `.gitignore` (commit both; never commit `.graphyard/`) and enables the Herdr
plugin. Every concurrent session needs a different worker identity and host ID.

### What the generated instructions authorize

The managed `AGENTS.md` section states that **every session Graphyard launches receives its instruction as the session's own first request, on the runtime's command line, never as pasted text**, and that the one later paste it may receive — the loop's single re-prompt of an inactive session, or the reviewer's reminder to post a verdict it already judged — comes from the same launcher and is to be acted on without confirmation.

Herdr types through bracketed paste, which an agent rightly treats as untrusted data (a prompt injection defence); with the request on the command line ([details](master-agent-sessions.md#the-request-is-the-sessions-first-message)), sessions start without anybody sending `go`. A Claude Code session launched under a role file loads only user settings, so the launcher writes the statement to `.graphyard/launch/NAME.role` and loads it with `--append-system-prompt-file`. Nothing else pasted carries that authority, and the role files under `.graphyard/harness/` hold permissions, not instructions.

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

Without `--apply` it only reports login state, quota and login commands. With `--apply` it generates a verified profile per worker and producer token and a reviewer profile per logged-in environment, each listing `accounts` in failover order.

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

Only an executor on the account's host (`--host`, default this one) launches it. Executors report login and quota before each launch; mark what no probe sees yourself:

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

Each launch runs on the first eligible account of its role (on this host, logged in, within quota and limits), and the choice is recorded. See [the agent registry](master-agent-sessions.md#the-agent-registry).

### Size review and proof capacity

Every candidate needs one review and one producer session per proof group, and each reviewer and producer profile runs only `"concurrency"` sessions at once (1–20, default 1). Edit it in `.graphyard/master.json`; the next tick applies it without a restart, and lowering it drains running sessions.

```json
"reviewers": [{ "name": "claude-reviewer", "agentName": "review-claude", "kind": "claude", "accounts": ["claude-a", "claude-b"], "concurrency": 3 }]
```

Size the gates against your worker count `W` and the `G` proof groups a typical item needs:

- Review slots across reviewer profiles: at least `⌈W / 2⌉`, and at least 2 once there is more than one worker.
- Producer slots: at least `G × ⌈W / 2⌉`, over at least two producer principals (an implementer's principal is refused its own item's evidence).
- One logged-in environment per two or three slots; sessions on one account share its quota.

So when adding workers, add one review slot and `G` producer slots per two workers, plus accounts. `master status` shows `concurrency` per role (`running`, `limit`, `waiting`, `longestWaitMs`); a role starved for ten minutes becomes an attention item and counts in `counts.concurrencyStarved`.

### Judge mechanical criteria with a closed question

An item may list yes-or-no proofs in `closedQuestions`. Before launching a producer, the loop asks `POST /api/work/GY-N/closed-question` to judge each at the exact head through the responder named by `GRAPHYARD_RESPONDER` (a local command or HTTP endpoint). A confident answer (probability at least 0.9) is recorded as evidence with the state hash and no session launches; anything else takes the ordinary producer path, as does every proof when no responder is set. `exclude.sources` (default `pull-request-body`, `comments`) and `exclude.paths` keep untrusted text from the responder. Measure agreement first with `accuracyStudy` in `src/model/closed-question.ts`.

### Profiles by hand

Templates: [Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [existing Herdr session](../examples/master/existing-worker.json); add one with `master worker add PROFILE`. Launch profiles default to `"approvals": "auto"` so sessions never block on a permission prompt — the trade-off is an unattended session; `"approvals": "prompt"` is the opt out ([approval modes](master-agent-sessions.md#approval-modes)). Local profiles need Linux with a systemd user manager; otherwise run workers on other machines whose GitHub identities cannot merge the base branch.

## 4. Start the master

```sh
node "$GRAPHYARD_CLI" master start codex
```

The master routes work, merges through the guarded path and administers GitHub; it never implements or submits evidence. Run it under an OS identity whose GitHub credentials workers cannot read.

To let it administer the App, installation and branch protection through `master browser`, give it the Chrome profile signed in to GitHub as the repository administrator:

```sh
node "$GRAPHYARD_CLI" master init \
  --url https://YOUR-GRAPHYARD-HOST \
  --browser-profile Default \
  --token-stdin < ~/.config/graphyard/INSTALL/tokens/INSTALL-master.token
```

The master never stores or exports its cookies ([details](master-agent-reference.md#github-administration-through-the-browser)); you only approve *Confirm access* in GitHub Mobile with the code `master status` shows.

### Executors, supervised

Executors claim each item's next action and run it. From the coordinator checkout, after `master init`, run `node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST`: it writes `.graphyard/executors.json` and installs [`graphyard-executor@.service`](../examples/master/graphyard-executor@.service) instances under systemd.

```json
{ "version": 1, "count": 2, "kinds": null, "intervalSeconds": 5 }
```

Change it with `node scripts/graphyard-executor.mjs --install --count 2`. See [running executors under supervision](master-agent-reference.md#running-executors-under-supervision).

`master start claude` writes the master's harness permissions to `.claude/settings.local.json`; review them with `master harness claude` (no merge path, no credential read). For Codex, `master harness codex` prints the trust block to add yourself.

To add a reviewer later: `master reviewer setup` (or `master reviewer bind FILE --key-stdin`) and `master reviewer add PROFILE` with a shipped profile — [Claude](../examples/master/claude-reviewer.json), [Cursor](../examples/master/cursor-reviewer.json), [opencode](../examples/master/opencode-reviewer.json). The only App confirmation is the one in the manifest flow; the master reconciles protection with `master protection --apply` or `master browser protection`.

### The loop must be supervised

An unsupervised `master run` that dies stays down. `master init` from the coordinator checkout (never `graphyard install`) writes `~/.config/systemd/user/graphyard-master.service`, runs `systemctl --user enable --now graphyard-master.service` and `loginctl enable-linger`; the unit restarts on crash, reboot and hang.

Installing it is an explicit operator action, never a side effect: tests, worker checkouts and temporary directories are refused. To move it, run `master init --token-stdin --replace-supervisor` from the new checkout.

```sh
node "$GRAPHYARD_CLI" master status   # setup.supervisor: installed, enabled, active, linger
journalctl --user -u graphyard-master.service -f
```

A missing or stopped supervisor is an attention item naming its fix. Without systemd, use the platform's own always-restart supervisor.

## 5. Prove the first PR

```sh
node "$GRAPHYARD_CLI" doctor --profile through-merge
```

Every `missing` item names its fix. Create a small real item with the exact CI check names and proofs, and dispatch it (`master dispatch GY-1 PROFILE`), or on a remote worker:

```sh
node "$GRAPHYARD_CLI" claim GY-1
node "$GRAPHYARD_CLI" worktree GY-1 EPOCH origin/YOUR_BASE_BRANCH
cd .graphyard/worktrees/GY-1-EPOCH
node "$GRAPHYARD_CLI" watch GY-1 EPOCH -- YOUR_AGENT_COMMAND
```

The worker pushes its branch, opens a PR and runs `complete GY-1 EPOCH PR_NUMBER`. It never force-pushes; to restore a contaminated tip it uses `restore-branch` ([worker push rights](master-agent-reference.md#worker-push-rights)). Review starts automatically; `master review GY-1` is the recovery path. Evidence comes from a `producer` token in protected CI or from a producer session; a `manual:` proof is attested through an approved decision ([evidence](protocol/evidence.md)).

When `Graphyard / merge` appears, add it to branch protection with "require branches to be up to date" off ([merge queue](github.md#merge-queue)), then `master merge GY-1`. Done means Graphyard observed the authorized merge, not that it is deployed.

Before adding workers, let one lease expire, reclaim with another identity, and confirm the old epoch can no longer heartbeat or submit.

## What is still manual

Logging in the provider CLI, GitHub CLI and agent environments; confirming the App once; approving the plan; signing in the browser profile and approving *Confirm access*; granting producers their proofs. The human-only decisions are goals and priorities, spending money or opening accounts, and issuing credentials to people. Every intervention counts as product feedback ([interventions](interventions.md)).
