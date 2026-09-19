# Onboard a repository

This is the supported path from an existing GitHub repository to Graphyard, Herdr, one master, and one worker. Start with one worker; add capacity after the first PR reaches Done. Roles are defined in the [glossary](glossary.md).

![Who holds which authority in Graphyard: the human operator sends human-only decisions to the Graphyard control plane; the Herdr runtime hosts the master, slice lead, and worker sessions, each with one credential; the reviewer, proof producer, and optional operator agent sit beside them; sessions send authenticated commands to Graphyard, the worker pushes its branch and opens the pull request on GitHub, the reviewer approves the exact head, and Graphyard observes GitHub facts and merges only through the guarded path.](diagrams/roles-and-authority.svg)

Text equivalent: you, the **human operator**, hold the `admin` credential and make the human-only decisions. The **master** (`coordinator`) reads work and gate state from Graphyard, dispatches ready items to supervised **workers** (`worker`, each with its own lease and assigned worktree), notices stalls, and performs routine exact-candidate merges when every configured gate passes. Workers push branches and open pull requests on GitHub; the **reviewer** (a separate GitHub identity) approves the exact head; **proof producers** (`producer`) submit acceptance evidence; Graphyard observes GitHub and merges only through the guarded path. Herdr hosts the sessions and reports their health. A fuller description accompanies the same diagram in [How Graphyard works](how-graphyard-works.md#four-ai-agent-sessions).

You keep talking directly to the master. GitHub owns code review and CI facts; proof producers produce acceptance evidence.

The initial setup works with one worker. Add more workers or machines only after the first PR has completed the full loop.

Do not create an operator-agent credential during this bootstrap. After the repository is connected and its gates have completed the protected loop, the human operator may optionally configure [scoped operator automation](operator-automation.md). That mode keeps operator agent, master, worker, and reviewer/proof producer as four distinct AI agent sessions; it does not replace human goals, approvals, exceptions, or oversight.

## Before you start

You need Node 24, Git, Docker, Herdr 0.7.1+, a Graphyard checkout, a GitHub repository, and a Railway account or another Docker host. Agent providers such as Codex or Claude must already be authenticated on the machine that runs them. The coordinator also needs GitHub CLI authenticated as an identity allowed to merge the protected base branch.

Graphyard is not published to npm yet. In the commands below:

```sh
export GRAPHYARD_CLI=/absolute/path/to/graphyard/bin/graphyard.mjs
```

For every `--token-stdin` prompt, paste the token, press Enter, then press Ctrl-D to send EOF.

## 1. Deploy one control plane

Use one Graphyard server and one Postgres database for all workers. Follow [deployment](deployment.md) for Railway or Docker Compose.

Create one principal with a separate cryptographically random token of at least 32 characters for each role:

| Role | Held by | Use |
| --- | --- | --- |
| `admin` | The human operator; declare `sessionKind: "human"` | Setup, work creation, requirements, and recovery |
| `coordinator` | The master | Master status and guarded merge authority |
| `worker` | One worker session each | One principal per concurrent worker session |
| `reader` | Dashboards | Read-only dashboards |
| `producer` | A proof producer (CI or trusted runner) | Only the proof names its grant allows |

Set `GRAPHYARD_PRINCIPALS`, `GITHUB_REPOSITORY`, `GITHUB_BASE_BRANCH`, and `GITHUB_CI_APP_IDS` on the server. Never give a worker an `admin`, `coordinator`, or `producer` token.

Open the Graphyard URL and sign in with the admin token.

## 2. Connect GitHub

From the repository being managed:

```sh
cd /path/to/your-repository
node "$GRAPHYARD_CLI" github-setup https://YOUR-GRAPHYARD-HOST
```

This guided flow supports personal-account Apps. For organization-owned repositories, create the App manually using [GitHub enforcement](github.md#create-and-install-the-app).

The manifest requests exactly the [declared control-plane permission set](github.md#app-permissions); an App registered before the merge queue must be [migrated](github.md#migrating-an-existing-app) to Contents: read and write. Install the App only on the managed repository and copy its private values into the Graphyard service. Configure normal CI and review protection now. The new `Graphyard / merge` check may appear only after the first linked PR; require it as soon as Graphyard publishes it, before merging.

Later permission changes to this App, and the installation's acceptance of them, are the master's job, not yours: once the master is started with a browser profile it performs them with `master browser app-permissions` and `master browser installation-accept`.

Confirm the exact CI check names and their GitHub App IDs. GitHub Actions uses App ID `15368`; other CI providers do not.

## 3. Connect a worker and Herdr

On a worker machine, from a worker-only checkout:

```sh
cd /path/to/your-repository
node "$GRAPHYARD_CLI" init \
  --url https://YOUR-GRAPHYARD-HOST \
  --herdr \
  --host-id UNIQUE_MACHINE_NAME \
  --token-stdin
```

Supply that worker's token on standard input. Setup:

- verifies the repository and worker identity;
- updates one managed section in `AGENTS.md`;
- adds the `.graphyard/` ignore rule;
- stores the private connection locally;
- links and enables the Herdr plugin.

Commit `AGENTS.md` and `.gitignore`. Never commit `.graphyard/`. Repeat on each worker machine with a different worker identity and host ID.

## 4. Start the master

Use a clean checkout under a dedicated coordinator OS identity or machine. It must not contain a worker connection or expose its merge-capable GitHub CLI credentials to worker sessions.

```sh
cd /path/to/coordinator-checkout
herdr workspace list
node "$GRAPHYARD_CLI" master init \
  --url https://YOUR-GRAPHYARD-HOST \
  --herdr-workspace HERDR_WORKSPACE_ID \
  --browser-profile Default \
  --token-stdin
node "$GRAPHYARD_CLI" master start codex
```

Supply the coordinator token. Use `master start claude` if preferred. Commit the managed `AGENTS.md` update.

`--browser-profile` names the Chrome profile on this machine that is signed in to GitHub as the repository administrator (`agent-browser profiles` lists them). With it, the master administers the control-plane App, its installation, and branch protection itself — through the API where one exists and otherwise through that profile, headless, with every step recorded, verified, and audited (see [GitHub administration through the browser](master-agent.md#github-administration-through-the-browser)). The profile is your identity: the master never stores or exports its cookies and uses it only for those flows. The one thing it still needs from you is approving GitHub's *Confirm access* prompt on your device when a page asks for it; `master status` shows the two-digit GitHub Mobile code to choose.

The master reads Graphyard truth, watches runtime health, routes work, requests guarded merges, and administers GitHub for the managed repository. It does not implement work or submit evidence.

`master start claude` also writes the master's own harness permissions to `.claude/settings.local.json` before the session starts, so routine master commands do not stop for an approval keypress and the auto-mode classifier does not refuse the GitHub administration flows as permission grants or CI bypasses. Review them with `master harness claude`; every rule is printed with the reason it exists. The generated rules grant no merge path and no credential read. For Codex, `master harness codex` prints the `trust_level = "trusted"` block to add to `$CODEX_HOME/config.toml`; Graphyard does not edit that shared user file for you.

## 5. Register the reviewer identity

Independent review needs a GitHub identity that is neither the pull-request author nor the Graphyard control-plane App. Register it once:

```sh
node "$GRAPHYARD_CLI" master reviewer setup
```

Open the printed local URL, click through GitHub's App confirmation, and install the App on the managed repository only. That click and your provider logins are the only hand-run steps in this section. The reviewer App requests Metadata read, Contents read, and Pull requests write; it cannot write code, publish the `Graphyard / merge` check, or read branch protection. Its private key and IDs are stored outside every worktree with mode 0600, and only the App ID, installation ID, and slug are recorded in `.graphyard/master.json`.

To bind an App you already created, put its IDs in a file that contains no secret and send the PEM on standard input:

```sh
printf '{"appId":123456,"installationId":654321,"slug":"graphyard-reviewer-your-repo"}' > /tmp/reviewer.json
node "$GRAPHYARD_CLI" master reviewer bind /tmp/reviewer.json --key-stdin < /path/to/reviewer.private-key.pem
```

Then add one reviewer launch profile:

- [Claude](../examples/master/claude-reviewer.json)
- [Cursor](../examples/master/cursor-reviewer.json)
- [opencode](../examples/master/opencode-reviewer.json)

```sh
node "$GRAPHYARD_CLI" master reviewer add /path/to/reviewer-profile.json
```

A reviewer profile holds no Graphyard credential: a reviewer reads a candidate and posts one GitHub verdict. Finally, make branch protection match the review policy of every open item:

```sh
node "$GRAPHYARD_CLI" master protection
node "$GRAPHYARD_CLI" master protection --apply
```

From here on the master reconciles protection itself after every review-policy change, through the API or, when only the settings page can make the change, with `master browser protection`.

## 6. Add workers

For a trusted worker on the coordinator host, start from a template:

- [Codex](../examples/master/codex-worker.json)
- [Claude](../examples/master/claude-worker.json)
- [existing Herdr session](../examples/master/existing-worker.json)

Store each worker token in a mode-0600 file outside the repository, edit the template, then:

```sh
node "$GRAPHYARD_CLI" master worker add /path/to/profile.json
node "$GRAPHYARD_CLI" master status
```

Every launch profile starts non-interactively by default (`"approvals": "auto"`): Graphyard adds that runtime's own startup flags so a fresh session never blocks on an approval or workspace-trust prompt. `master worker add` prints exactly what it will start with and what that costs. Set `"approvals": "prompt"` to opt out per profile; the session then waits for a human in its tab. See [approval modes](master-agent.md#approval-modes).

Local launch profiles share the coordinator host. They require Linux with a working systemd user manager for durable containment. Use them only for trusted dogfooding or inside a real OS/container boundary that hides coordinator GitHub credentials. On macOS or a Linux host without user systemd, use the remote-worker flow below.

For the recommended separated setup, workers run on other machines with GitHub identities that can push branches and open PRs but cannot merge the protected base branch. Version 0.1 does not remotely launch supervised Herdr tabs across hosts; the master selects work and the remote worker claims it.

## 7. Prove the first PR

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

Connect that evidence before merging. Version 0.1 has no general-purpose runner: put a narrowly scoped `producer` token in protected CI that pull-request code cannot read, then submit the current candidate's actual result. For a criterion explicitly defined with a `manual:` proof, the human operator inspects and submits it from a separate `admin`-authenticated terminal or dashboard sign-in; never expose that credential to the worker checkout. An `admin` cannot certify automated proof names. See [evidence submission](protocol.md#evidence).

When `Graphyard / merge` first appears, add it to branch protection — with "require branches to be up to date" off, which the [merge queue](github.md#merge-queue) requires. After every gate passes:

```sh
node "$GRAPHYARD_CLI" master merge GY-1
```

Done means Graphyard observed that authorized merge. It does not yet mean deployed or production-verified.

Before adding more workers, stop one worker, let its lease expire, reclaim with another identity, and confirm the old epoch can no longer heartbeat or submit.

## Current manual steps

Version 0.1 still requires the human operator to deploy the server, provision principals, authenticate agent providers, sign the browser profile in to GitHub once, approve GitHub's *Confirm access* prompt on their device when a page asks for it, and connect project-specific trusted evidence. Registering each App is still a first-time click in the manifest flow; App permission updates, installation acceptance, and branch-protection reconciliation are the master's (`master browser …` and `master protection --apply`), and Graphyard still refuses to create protection that is missing the `Graphyard / merge` binding or a classic rule for the base branch. Decisions the guides mark human-only — releasing work, revising requirements, choosing review providers, clearing blockers, manual proofs, rework, and merge approval without automatic merging — stay with you. A hosted signup flow and general turnkey E2E execution are not shipped.

Use the [documentation index](README.md) for deeper setup, operations, and protocol details.
