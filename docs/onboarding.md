<!-- page: Start here | 3 | GitHub to first PR. -->
# Onboard a repository

For the operator connecting a real repository.

## 1. Deploy one control plane

One server and one Postgres database serve all workers ([deployment](deployment.md)). Create one principal per role, each with its own random token of at least 32 characters: `admin` for the human operator, declaring `sessionKind: "human"`; `coordinator` for the master; one `worker` per concurrent worker session; `reader` for dashboards; and `producer` for each proof producer, limited to the proof names its grant allows. Set `GRAPHYARD_PRINCIPALS`, `GITHUB_REPOSITORY`, `GITHUB_BASE_BRANCH` and `GITHUB_CI_APP_IDS`, never give a worker an `admin`, `coordinator` or `producer` token, then sign in with the admin token.

## 2. Connect GitHub

Run `graphyard github-setup https://YOUR-GRAPHYARD-HOST` from the managed repository, or [create the App by hand](github.md#create-and-install-the-app) for an organization account; an App registered before the merge queue must be [migrated](github.md#migrating-an-existing-app) to Contents: read and write. Copy its private values into the service and configure CI and review protection now, requiring `Graphyard / merge` as soon as it is published. Later permission changes and their acceptance are the master's, through the `master browser` flows driven by the profile `master init --browser-profile` names; approving a *Confirm access* prompt on GitHub Mobile is the only human step left. Confirm the exact CI check names and their App IDs — GitHub Actions uses `15368`.

## 3. Connect a worker and Herdr

From a worker-only checkout on a worker machine:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

## 4. Start the master

Use a clean checkout under a dedicated coordinator OS identity, with no worker connection and no worker session able to read its merge-capable GitHub CLI credentials:

```sh
herdr workspace list
node "$GRAPHYARD_CLI" master init --url https://YOUR-GRAPHYARD-HOST \
  --herdr-workspace HERDR_WORKSPACE_ID --browser-profile Default --token-stdin
node "$GRAPHYARD_CLI" master start codex     # or: master start claude
```

## 5. Register the reviewer identity

Independent review needs a GitHub identity that is neither the pull-request author nor the control-plane App ([the reviewer App](github.md#the-reviewer-app)). Run `master reviewer setup`, open the printed local URL, confirm the App and install it on the managed repository only — that click and your provider logins are the only hand-run steps; its key and IDs are stored outside every worktree at mode 0600. To bind an App you already created, put its IDs in a secret-free file and send the PEM on stdin with `master reviewer bind FILE --key-stdin`. Add one reviewer launch profile — [Claude](../examples/master/claude-reviewer.json), [Cursor](../examples/master/cursor-reviewer.json) or [opencode](../examples/master/opencode-reviewer.json) — with `master reviewer add /path/to/reviewer-profile.json`; it holds no Graphyard credential. Then run `master protection` and `master protection --apply` to match branch protection to every open item's review policy.

## 6. Add workers

### Agent environments

Every agent CLI account gets its own isolated config and login home — an *agent environment*, one directory per account named `<agent>-<letter>` under `~/.coding_agents` (`--directory DIR`, or `GRAPHYARD_AGENT_ENVIRONMENTS`, uses another root): two Claude subscriptions are `claude-a` and `claude-b`, a single Codex login may be `codex`. Logging each one in to its provider is yours to do once.

| Agent | Variable naming the environment | Login held inside it | Log in with |
| --- | --- | --- | --- |
| Claude Code | `CLAUDE_CONFIG_DIR` | `.credentials.json` | `CLAUDE_CONFIG_DIR=… claude`, then `/login` |
| Codex | `CODEX_HOME` | `auth.json` | `CODEX_HOME=… codex login` |
| OpenCode | `XDG_DATA_HOME` (data under `opencode/`) | `opencode/auth.json` | `XDG_DATA_HOME=… opencode auth login` |
| Cursor | `CURSOR_CONFIG_DIR` | `cli-config.json` | `CURSOR_CONFIG_DIR=… cursor-agent login` |

Store each worker principal's token in `~/.config/graphyard/workers/PRINCIPAL.token` and each producer's in `~/.config/graphyard/producers/PRINCIPAL.token`, mode 0600, beside the coordinator credential (`$GRAPHYARD_CONFIG_HOME` if you set one). Then:

```sh
node "$GRAPHYARD_CLI" master environments                                # discover; report login and quota
node "$GRAPHYARD_CLI" master environments --create claude,codex --apply  # add claude-<next>, codex-<next>
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-a claude                       # /login, once per new environment
node "$GRAPHYARD_CLI" master environments --apply                        # generate the profiles
```

Without `--apply` nothing is written: it lists every environment with whether it is logged in, the quota it could read, and the login command for each one that is not. With `--apply` it records the environments in `.graphyard/master.json`, sets the one runtime setting an unattended Claude launch needs (`skipDangerousModePermissionPrompt`) and generates the profiles: one worker profile per worker token, verified as that principal with the `worker` role; one producer profile per producer token, verified for the `producer` role and never sharing a principal with a worker; one reviewer profile per logged-in environment, the first answering automatic reviews; and every profile's `accounts` listing the logged-in environments in failover order, its own runtime first and rotated so profiles start on different accounts. An existing profile keeps its order, gains accounts that logged in since, and a home it pinned with `CLAUDE_CONFIG_DIR` becomes its first account. Rerun after logging another account in; what the launcher checks per launch is in [agent environments](master-agent.md#agent-environments).

### Profiles by hand

Start from a template — [Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [Cursor](../examples/master/cursor-worker.json), [Muse](../examples/master/muse-worker.json) or an [existing Herdr session](../examples/master/existing-worker.json) — store each worker token in a mode-0600 file outside the repository, then `master worker add /path/to/profile.json` and `master status`. Keep profile files in the ignored `.graphyard/profiles/` directory; a profile may contain no Graphyard variable or secret-looking value, since provider login and Graphyard identity are separate. A `launch` profile is supervised and can receive new work; an `existing` profile only adds health visibility. Local launch profiles share the coordinator host and need Linux with a working systemd user manager, so use them only for trusted dogfooding; the recommended setup puts workers on other machines with GitHub identities that can push branches but cannot merge the base branch. Version 0.1 does not remotely launch supervised Herdr tabs across hosts.

### Approval modes

A launched session that stops to ask "run everything?" cannot start without a keypress, so every launch profile carries `approvals`: the default `auto` adds that runtime's non-interactive startup contract, `prompt` adds nothing so a human answers in the session tab, and `master worker add` and `master reviewer add` print what a profile will start with.

| Runtime | What `auto` adds | What it removes | What it costs |
| --- | --- | --- | --- |
| Claude Code | `--permission-mode bypassPermissions` | tool-approval prompts | the command classifier stops classifying for that session |
| Codex | `--ask-for-approval never --sandbox workspace-write`, with `-c sandbox_workspace_write.network_access=true` and `--add-dir` for what the role writes | directory-trust and per-command approval | only the widened workspace-write sandbox still limits a command |
| Cursor | `--force --trust` | "Run Everything" and fresh-worktree workspace trust | every proposed command runs in the assigned worktree |
| opencode | `OPENCODE_PERMISSION` allowing every permission (`*`, `edit`, `bash`, `webfetch`, `external_directory`, `doom_loop`) | every permission prompt | edits, shell commands, fetches and paths outside the worktree happen without asking |
| Muse | nothing generated; the [template](../examples/master/muse-worker.json) passes `--approval-mode never --trust-workspace` in `agentArgs` | tool-approval and workspace-trust prompts | tool calls run without asking inside Muse's own sandbox |

Each is that runtime's broadest non-interactive mode. Codex keeps its sandbox, widened to what the role writes: network access for every role, the repository's shared Git directory for a worker, `/tmp` plus that directory for a producer building in a detached worktree. `master start` launches the master session the same way. Credentials do not widen with it — a worker still holds only its worker credential, a reviewer only its hour-long token, a producer only its producer credential.

## 7. Prove the first PR

Read the [readiness checklist](install.md#readiness-checklist) for the profile you intend to enforce: a ready checklist is configuration, not proof. Create a small real work item using the repository's exact CI check names and acceptance proofs, then dispatch it — `master dispatch GY-1 codex-primary` for a trusted local profile, or a remote worker's own `claim`, `worktree` and `watch`. The worker pushes its branch, opens a pull request and runs `complete GY-1 EPOCH PR_NUMBER`; the loop launches the reviewer and producers for that head, so `master review GY-1` is only the recovery path. Connect acceptance evidence before merging: a narrowly scoped `producer` token in protected CI that pull-request code cannot read, and an approved `attest` decision for a `manual:` proof. When `Graphyard / merge` first appears, add it to branch protection with `strict` off, then `master merge GY-1`; Done means Graphyard observed that authorized merge, not that it is deployed. Before adding workers, stop one, let its lease expire, reclaim with another identity, and confirm the old epoch can no longer heartbeat or submit.

