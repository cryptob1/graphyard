<!-- page: Start here | 3 | GitHub to first PR, in seven steps. -->
# Onboard a repository

For the operator connecting a real repository.

## 1. Deploy one control plane

One server and one Postgres database serve all workers ([deployment](deployment.md)). Create one principal per role with a separate cryptographically random token of at least 32 characters: `admin` for the human operator, declaring `sessionKind: "human"`; `coordinator` for the master; one `worker` per concurrent worker session; `reader` for dashboards; and `producer` for each proof producer, which may use only the proof names its grant allows. Set `GRAPHYARD_PRINCIPALS`, `GITHUB_REPOSITORY`, `GITHUB_BASE_BRANCH` and `GITHUB_CI_APP_IDS`, never give a worker an `admin`, `coordinator` or `producer` token, then sign in with the admin token.

## 2. Connect GitHub

Run `graphyard github-setup https://YOUR-GRAPHYARD-HOST` from the managed repository, or [create the App by hand](github.md#create-and-install-the-app) for an organization account; an App registered before the merge queue must be [migrated](github.md#migrating-an-existing-app) to Contents: read and write. Copy its private values into the service and configure CI and review protection now, requiring `Graphyard / merge` as soon as Graphyard publishes it. Later permission changes and the installation's acceptance of them are the master's job, through `master browser` flows driven by the profile `master init --browser-profile` names; approving a *Confirm access* sudo prompt on GitHub Mobile is the only human-only step left in that path. Confirm the exact CI check names and their App IDs — GitHub Actions uses `15368`.

## 3. Connect a worker and Herdr

From a worker-only checkout on a worker machine:

```sh
node "$GRAPHYARD_CLI" init --url https://YOUR-GRAPHYARD-HOST --herdr --host-id UNIQUE_MACHINE_NAME --token-stdin
```

## 4. Start the master

Use a clean checkout under a dedicated coordinator OS identity, containing no worker connection and exposing its merge-capable GitHub CLI credentials to no worker session:

```sh
herdr workspace list
node "$GRAPHYARD_CLI" master init --url https://YOUR-GRAPHYARD-HOST \
  --herdr-workspace HERDR_WORKSPACE_ID --browser-profile Default --token-stdin
node "$GRAPHYARD_CLI" master start codex     # or: master start claude
```

## 5. Register the reviewer identity

Independent review needs a GitHub identity that is neither the pull-request author nor the control-plane App ([the reviewer App](github.md#the-reviewer-app)). Run `master reviewer setup`, open the printed local URL, confirm the App and install it on the managed repository only — that click and your provider logins are the only hand-run steps here; its key and IDs are stored outside every worktree at mode 0600. To bind an App you already created, put its IDs in a secret-free file and send the PEM on stdin with `master reviewer bind FILE --key-stdin`. Add one reviewer launch profile — [Claude](../examples/master/claude-reviewer.json), [Cursor](../examples/master/cursor-reviewer.json) or [opencode](../examples/master/opencode-reviewer.json) — with `master reviewer add /path/to/reviewer-profile.json`; it holds no Graphyard credential. Finally run `master protection` and `master protection --apply` to match branch protection to every open item's review policy.

## 6. Add workers

Start from a template — [Codex](../examples/master/codex-worker.json), [Claude](../examples/master/claude-worker.json), [Cursor](../examples/master/cursor-worker.json), [Muse](../examples/master/muse-worker.json) or an [existing Herdr session](../examples/master/existing-worker.json) — store each worker token in a mode-0600 file outside the repository, then `master worker add /path/to/profile.json` and `master status`. Keep profile files in the ignored `.graphyard/profiles/` directory; provider login and Graphyard identity are separate, and a profile may contain no Graphyard variable or secret-looking value. A `launch` profile is supervised and can receive new work; an `existing` profile only adds health visibility. Local launch profiles share the coordinator host and need Linux with a working systemd user manager, so use them only for trusted dogfooding or inside a real isolation boundary; the recommended setup puts workers on other machines with GitHub identities that can push branches but cannot merge the base branch. Version 0.1 does not remotely launch supervised Herdr tabs across hosts.

### Approval modes

A launched session that stops to ask "run everything?" cannot start without a keypress, so every launch profile carries `approvals`. The default `auto` adds that runtime's own non-interactive startup contract; `prompt` adds nothing, so a human answers in the session tab. `master worker add` and `master reviewer add` print exactly what a profile will start with.

| Runtime | What `auto` adds | What it removes | What it costs |
| --- | --- | --- | --- |
| Claude Code | `--permission-mode bypassPermissions` | tool-approval prompts | the command classifier stops classifying for that session |
| Codex | `--ask-for-approval never --sandbox workspace-write` | directory-trust and per-command approval | only the workspace-write sandbox still limits a command |
| Cursor | `--force --trust` | "Run Everything" and fresh-worktree workspace trust | every proposed command runs in the assigned worktree |
| opencode | `OPENCODE_PERMISSION={"edit":"allow","bash":"allow","webfetch":"allow"}` | edit, bash and webfetch prompts | edits, shell commands and fetches happen without asking |
| Muse | nothing generated; the [template](../examples/master/muse-worker.json) passes `--approval-mode never --trust-workspace` in `agentArgs` | tool-approval and workspace-trust prompts | tool calls run without asking inside Muse's own sandbox |

## 7. Prove the first PR

Read the [readiness checklist](install.md#readiness-checklist) for the profile you intend to enforce: a ready checklist is configuration, not proof. Create a small real work item using the repository's exact CI check names and acceptance proofs, then dispatch it — `master dispatch GY-1 codex-primary` for a trusted local profile, or a remote worker's own `claim`, `worktree` and `watch`. The worker pushes its branch, opens a pull request and runs `complete GY-1 EPOCH PR_NUMBER`; the loop launches the reviewer and producers for that exact head, so `master review GY-1` is only the recovery path. Connect acceptance evidence before merging: a narrowly scoped `producer` token in protected CI that pull-request code cannot read, and for a `manual:` proof an approved `attest` decision. When `Graphyard / merge` first appears, add it to branch protection with `strict` off, then `master merge GY-1`. Done means Graphyard observed that authorized merge, not that it is deployed. Before adding workers, stop one, let its lease expire, reclaim with another identity, and confirm the old epoch can no longer heartbeat or submit.

