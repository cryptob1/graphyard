<!-- page: Start here | 0 | a new repository to a merged first item, step by step. -->
# From zero to a running Graphyard

> set up Graphyard for OWNER/REPO following docs/setup-from-zero.md

One ordered checklist from "a repository and nothing else" to a merged, deployed item. Run each step's command, then its **Verify**; start the next only when it passes. **HUMAN** marks the steps an agent cannot do: ask for that one thing as a choice whose answer is the thing itself (`park … --choice-secret` or "Done"), never several at once. The [install hard rules](install.md#hard-rules) apply: never print a credential.

`graphyard doctor` prints `setupFromZero.lines`, one `PASS`/`FAIL` line per prerequisite, each failure naming the step that fixes it; `next` names the first gap (a readiness item's recovery, then the first `FAIL`).

## 1. Machine prerequisites

```sh
node --version          # v24 or later
gh auth status          # logged in; scopes repo, admin:repo_hook
docker compose version  # the compose path
herdr --version         # sessions run in Herdr panes
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --share-net --die-with-parent -- true
```

**Verify:** every command exits 0, and `gh repo view OWNER/REPO --json viewerPermission -q .viewerPermission` prints `ADMIN`. **HUMAN:** create OWNER/REPO if `gh repo view` says 404; `gh auth login` as its admin; a failing `bwrap` probe: the host administrator allows unprivileged user namespaces. In a Graphyard worker session `gh` holds only the item's App token (`x-access-token`): the human answers a sealed choice with an admin token, and the resumed worker feeds `unseal GY-N` to `gh auth login --with-token` in a scratch `GH_CONFIG_DIR`.

## 2. Graphyard and the repository

```sh
git clone https://github.com/cryptob1/graphyard.git ~/graphyard && (cd ~/graphyard && npm ci)
export GRAPHYARD_CLI=~/graphyard/bin/graphyard.mjs
gy() { node "$GRAPHYARD_CLI" "$@"; }
cd /path/to/REPO && gy init --scan
```

The repository needs `origin` on GitHub, its default branch pushed, a test suite, and a GitHub Actions workflow running it on `pull_request`, whose job name becomes the required check. **Verify:** `gy doctor` readiness `repository`, `required-checks` and `test-formats` are `ready` (`recovery` names the fix).

## 3. Install the control plane

```sh
gy install --provider compose --repo OWNER/REPO --reviewer claude --plan
gy install --provider compose --repo OWNER/REPO --reviewer claude --apply
```

[Install](install.md) explains every field; other providers differ only in `--provider`. **HUMAN:** approve the printed plan. **Verify:** every `preflight[].ok` and `secretsRedacted` are `true`; `curl -s http://127.0.0.1:4310/healthz` is `{"ok":true,…}`. Point the CLI at it with the operator credential (never a worker's):

```sh
export GRAPHYARD_URL=http://127.0.0.1:4310
export GRAPHYARD_TOKEN_FILE=~/.config/graphyard/OWNER-REPO/tokens/OWNER-REPO-operator.token
```

**Verify:** `gy doctor` passes `control-plane` and `credentials-file` (`GRAPHYARD_TOKEN_FILE`, or `.graphyard/connection.json`, mode `0600`).

## 4. Register the GitHub App

`--apply` opens `http://127.0.0.1:4311`. **HUMAN:** click **Create GitHub App**, then install it on OWNER/REPO only. GitHub may ask to *Confirm access* (sudo) by GitHub Mobile: human only. **Verify:** `github-app` passes; on `missing permissions`, run `gy github-setup --update-permissions --wait 600` and the human accepts it on the installation page ([permissions](github.md#app-permissions)).

## 5. Reviewer and revert-approver Apps

`--reviewer claude` registers the independent reviewer App (**HUMAN:** one more confirmation, same page); no review gate passes without it. The same `--apply` makes that App the main guard's revert approver (`GRAPHYARD_REVERT_APPROVER_*`; compose mounts its key as a file), so the guard reverts a broken `main` unaided; hand-set values are reset to it. **Verify:** `reviewer-app` passes, and readiness `revert-approver` is `ready`. Outside `install`, `gy master reviewer setup` (loopback `http://` accepted) registers it and sets the [variables](deployment.md#variables).

## 6. Onboard the checkout

```sh
gy init --scan --apply --url http://127.0.0.1:4310
git add AGENTS.md .gitignore graphyard.json .github/workflows && git commit -m "Adopt Graphyard" && git push
```

Commit through a pull request if `main` is already protected; never commit `.graphyard/`. **Verify:** readiness `setup-proposal` is `ready`. [Documentation policy](onboarding.md#documentation-policy) and [generated instructions](onboarding.md#what-the-generated-instructions-authorize) say what the files authorize.

## 7. Branch protection

`--apply` protects the base branch; once the first pull request shows `Graphyard / merge`, rerun step 3's `--apply` to require it. `gy master protection --apply` reconciles review policies. **Verify:** `branch-protection` passes (`Graphyard / merge` and `graphyard/landable` required from the App, administrator enforcement on, "up to date" off).

## 8. Agent environments

```sh
gy master environments --create claude,codex --apply
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-a claude   # HUMAN: /login, finish the first-run screens
CODEX_HOME=~/.coding_agents/codex-a codex login       # HUMAN: complete the browser login
gy master environments --apply
```

The second `--apply` records Claude Code's bypass-permissions consent (`skipDangerousModePermissionPrompt`); folder trust (Claude `.claude.json`, Codex `config.toml`) is written per checkout at launch; both files must stay writable. **Verify:** one `agent-environment:NAME` line per environment passes. Then the [registry and roles](onboarding.md#configure-the-fleet).

## 9. Worker sandbox and harness rules

Workers write only their worktree and shared Git paths ([worker sandbox](master-agent-sessions.md#worker-sandbox)). **Verify:** `worker-sandbox` passes (bubblewrap writes `objects`, `refs/remotes`, `refs/heads/graphyard` and their logs). Run `gy master harness claude --apply` (or `codex`): the master's routine GitHub administration is allowed, merges stay [denied](master-agent-reference.md#github-administration-through-the-browser).

## 10. Start the master

[Start the master](onboarding.md#3-start-the-master) with the master token:

```sh
gy master init --url http://127.0.0.1:4310 --herdr-workspace HERDR_WORKSPACE_ID --browser-profile Default \
  --token-stdin < ~/.config/graphyard/OWNER-REPO/tokens/OWNER-REPO-master.token
gy init --url http://127.0.0.1:4310   # each executor checkout
gy master start claude                # or codex
```

`herdr workspace list` prints the workspace ID. **HUMAN:** `--browser-profile` names a Chrome profile signed in to GitHub. **Verify:** `gy master status` shows `setup.supervisor` active and executors live.

## 11. Hosted variables (Railway only)

Compose skips this. On Railway set `RAILWAY_API_TOKEN` (**HUMAN:** the account owner issues it) and size `GRAPHYARD_DATABASE_POOL_SIZE` ([limits](operations-reference.md)). **Verify:** `gy doctor` `production` has no `error`.

## 12. First item end to end

Write an item like [work.json](../examples/work.json) with one small criterion and `"policy":{"checks":["test"],"review":true}`, then `gy master create item.json`. The loop dispatches it; the worker's pull request, the reviewer App's verdict and the producers' proofs follow, and GitHub merges on green `Graphyard / merge`. **Verify:** `gy status GY-1` reaches stage `done` with the PR merged (`gh pr view N --json state`: `MERGED`). **Verify the deploy:** `gy doctor` reports `production.serving` at (or past) the merge commit, `production.aheadBy` `0` and `production.incidents` `[]`. Graphyard reads it from Railway's API or the deploy job's GitHub deployments ([production observation](deployment.md#production-deployment-observation)). With no deploy job, `production.latest` is `null` and merged is the end state.

Gaps found walking it, and their fixes: [setup-from-zero audit](setup-from-zero-audit.md).
