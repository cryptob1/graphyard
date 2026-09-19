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
to one supported provider. The GitHub CLI must be authenticated as an identity that
administers the base branch. Agent providers such as Codex or Claude must already be signed
in on the machine that runs them; Herdr 0.7.1+ is optional and is bound automatically when
it is installed.

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
runtime, confirms each GitHub App in the browser once in the manifest flow, approves the plan,
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
