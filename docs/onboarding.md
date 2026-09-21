<!-- page: Start here | 3 | seven-step setup. -->
# Onboard a repository

For the operator connecting a real repository: the seven steps, and who owns each.

## 1. Deploy one control plane

One server and one Postgres database serve all workers ([deployment](deployment.md)).

- **Principals:** one per role, each with its own random token of at least 32 characters:
  - `admin`: human operator, declaring `sessionKind: "human"`;
  - `coordinator`: master;
  - `worker`: one per concurrent worker session, never given an `admin`, `coordinator` or `producer` token;
  - `reader`: dashboards;
  - `producer`: each proof producer, limited to proof names its grant allows.
- **Set** `GRAPHYARD_PRINCIPALS`, `GITHUB_REPOSITORY`, `GITHUB_BASE_BRANCH` and `GITHUB_CI_APP_IDS`, then sign in with the admin token.

## 2. Connect GitHub

- Run `graphyard github-setup https://YOUR-GRAPHYARD-HOST` from the managed repository, or [create the App by hand](github.md#create-and-install-the-app) for an organization account; one registered before the merge queue must be [migrated](github.md#migrating-an-existing-app) to Contents: read and write. Copy its private values into the service, and configure CI and review protection now, requiring `Graphyard / merge` once published.
- Later permission changes and their acceptance are the master's, through `master browser` flows driven by the profile `master init --browser-profile` names; the only human-only step: approving a *Confirm access* prompt on GitHub Mobile.
- Confirm exact CI check names and their App IDs: GitHub Actions uses `15368`.

## 3. Connect a worker and Herdr

From a worker-only checkout on a worker machine:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

### What the generated instructions authorize

The managed `AGENTS.md` section is the coordination contract every agent runtime reads from the repository, and it states the one thing launched sessions need: every session Graphyard launches receives its instruction as the session's own first request, never as pasted text.

It is generated because Herdr's bracketed paste reaches a coding agent as untrusted data rather than its operator's request — right against prompt injection, wrong for a launch. Sessions now start without anybody sending `go`, and the generated statement is what lets the two pastes that remain — the loop's single re-prompt, and the reviewer's reminder to post a verdict it already judged — be taken as the operator's instruction. A Claude Code session under a role file loads only the user settings, which leaves `AGENTS.md` out, so the launcher passes the same statement as `--append-system-prompt`; nothing else pasted carries that authority, and the role files under `.graphyard/harness/` hold permissions, not instructions.

## 4. Start the master

Use a clean checkout under a dedicated coordinator OS identity, no worker connection and no worker session able to read its merge-capable GitHub CLI credentials:

```sh
herdr workspace list
node "$GRAPHYARD_CLI" master init --url https://YOUR-GRAPHYARD-HOST \
  --herdr-workspace HERDR_WORKSPACE_ID --browser-profile Default --token-stdin
node "$GRAPHYARD_CLI" master start codex     # or: master start claude
```

## 5. Register the reviewer identity

Independent review needs [the reviewer App](github.md#the-reviewer-app), a second GitHub identity.

- `master reviewer setup`: open the printed local URL, confirm the App, install it on the managed repository only — that click and your provider logins are the only hand-run steps. Its key and IDs stay outside every worktree at mode 0600.
- `master reviewer bind FILE --key-stdin` binds an App you already created: put its IDs in a secret-free file, send the PEM on stdin.
- `master reviewer add PROFILE.json` adds one reviewer launch profile ([Claude](../examples/master/claude-reviewer.json), [Cursor](../examples/master/cursor-reviewer.json) or [opencode](../examples/master/opencode-reviewer.json)); it holds no Graphyard credential.
- `master protection`, then `master protection --apply`, match branch protection to every open item's review policy.

## 6. Add workers

### Agent environments

- **Agent environment:** every agent CLI account's own isolated config and login home, one directory per account named `<agent>-<letter>` under `~/.coding_agents` (`--directory DIR`, or `GRAPHYARD_AGENT_ENVIRONMENTS`, uses another root).

Each runtime's variable, login file and login command:

- **Claude Code:** `CLAUDE_CONFIG_DIR`, `.credentials.json`, `CLAUDE_CONFIG_DIR=… claude` then `/login`
- **Codex:** `CODEX_HOME`, `auth.json`, `CODEX_HOME=… codex login`
- **OpenCode:** `XDG_DATA_HOME` (data under `opencode/`), `opencode/auth.json`, `XDG_DATA_HOME=… opencode auth login`
- **Cursor:** `CURSOR_CONFIG_DIR`, `cli-config.json`, `CURSOR_CONFIG_DIR=… cursor-agent login`

- **Tokens:** each worker principal's in `~/.config/graphyard/workers/PRINCIPAL.token`, each producer's in `~/.config/graphyard/producers/PRINCIPAL.token`, mode 0600, beside the coordinator credential (`$GRAPHYARD_CONFIG_HOME` if set).

```sh
node "$GRAPHYARD_CLI" master environments                                # discover; report login and quota
node "$GRAPHYARD_CLI" master environments --create claude,codex --apply  # add claude-<next>, codex-<next>
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-a claude                       # /login, once per new environment
node "$GRAPHYARD_CLI" master environments --apply                        # generate the profiles
```

- **Without `--apply`** writes nothing; lists every environment: whether logged in, quota it could read, login command for each that is not.
- **With `--apply`** records environments in `.graphyard/master.json`, sets the one runtime setting an unattended Claude launch needs (`skipDangerousModePermissionPrompt`) and generates profiles: one worker profile per worker token verified as that principal with the `worker` role; one producer profile per producer token verified for the `producer` role, never sharing a principal with a worker; one reviewer profile per logged-in environment, the first answering automatic reviews. Each profile's `accounts` lists logged-in environments in failover order, its own runtime first, rotated so profiles start on different accounts.
- **An existing profile** keeps its order, gains accounts logged in since, a home it pinned with `CLAUDE_CONFIG_DIR` becomes its first account.
- **Rerun** after logging another account in; launcher checks: [agent environments](master-agent.md#agent-environments).

### Profiles by hand

- **Start from a template** ([Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [Cursor](../examples/master/cursor-worker.json), [Muse](../examples/master/muse-worker.json) or an [existing Herdr session](../examples/master/existing-worker.json)), store each worker token in a mode-0600 file outside the repository, then `master worker add /path/to/profile.json` and `master status`.
- **Profile files** stay in the ignored `.graphyard/profiles/` directory; a profile may contain no Graphyard variable or secret-looking value: provider login and Graphyard identity are separate.
- **A `launch` profile** is supervised, can receive new work; an `existing` profile only adds health visibility.
- **Local launch profiles** share the coordinator host and need Linux with a working systemd user manager: use them only for trusted dogfooding. Prefer workers on other machines, with GitHub identities that can push branches but not merge the base branch; version 0.1 launches no supervised Herdr tab across hosts.

### Approval modes

Every launch profile carries `approvals`:

- `auto` (default) adds that runtime's non-interactive startup contract;
- `prompt` adds nothing: a human answers in the session tab.

`master worker add` and `master reviewer add` print what a profile will start with.

What `auto` adds per runtime, and what it costs:

- **Claude Code:** `--permission-mode bypassPermissions`; no tool-approval prompts, and the command classifier stops classifying for that session
- **Codex:** `--ask-for-approval never --sandbox workspace-write`, with `-c sandbox_workspace_write.network_access=true` and `--add-dir` for what the role writes; no directory-trust or per-command approval, only the widened workspace-write sandbox still limiting a command
- **Cursor:** `--force --trust`; no "Run Everything" or fresh-worktree workspace trust, every proposed command running in the assigned worktree
- **opencode:** `OPENCODE_PERMISSION` allowing every permission (`*`, `edit`, `bash`, `webfetch`, `external_directory`, `doom_loop`); no permission prompt, so edits, shell commands, fetches and paths outside the worktree happen without asking
- **Muse:** nothing generated; the [template](../examples/master/muse-worker.json) passes `--approval-mode never --trust-workspace` in `agentArgs`, so tool calls run without asking inside Muse's own sandbox

- **Each** is that runtime's broadest non-interactive mode; `master start` launches the master session the same way. Codex keeps its sandbox, widened to what the role writes: network access for every role, the repository's shared Git directory for a worker, and for a producer or reviewer its own [session checkout](master-agent.md#session-checkouts) plus that directory.
- **Credentials** do not widen with it: a worker holds only its worker credential, a reviewer only its hour-long token, a producer only its producer credential.

## 7. Prove the first PR

1. Read the [readiness checklist](install.md#readiness-checklist) for the profile you will enforce: a ready checklist is configuration, not proof.
2. Create a small real work item using the repository's exact CI check names and acceptance proofs, then dispatch it: `master dispatch GY-1 codex-primary` for a trusted local profile, or a remote worker's own `claim`, `worktree` and `watch`.
3. The worker pushes its branch, opens a pull request, runs `complete GY-1 EPOCH PR_NUMBER`; the loop launches the reviewer and producers for that head; `master review GY-1` is only the recovery path.
4. Connect acceptance evidence before merging: a narrowly scoped `producer` token in protected CI that pull-request code cannot read, an approved `attest` decision for a `manual:` proof.
5. When `Graphyard / merge` first appears, add it to branch protection with `strict` off, then `master merge GY-1`; Done means Graphyard observed that authorized merge, not deployment.
6. Before adding workers, rehearse [a lost worker](operations-reference.md#lost-worker-before-submission) on that item.
