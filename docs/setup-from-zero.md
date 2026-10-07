<!-- page: Start here | 0 | setup checklist. -->
# From zero to a running Graphyard

> set up Graphyard for OWNER/REPO following docs/setup-from-zero.md

Run each step's command, then its **Verify**, before the next. **HUMAN** marks the steps an agent cannot do. The [install hard rules](install.md#hard-rules) apply throughout.

`graphyard doctor` prints `setupFromZero.lines`, one `PASS`/`FAIL` line per prerequisite naming the step that fixes it; `next` names the first gap.

## 1. Machine prerequisites

```sh
node --version          # v24 or later
gh auth status          # scopes repo, admin:repo_hook
docker compose version
herdr --version
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --share-net --die-with-parent -- true
```

**Verify:** every command exits 0 and `gh repo view OWNER/REPO --json viewerPermission -q .viewerPermission` prints `ADMIN`. **HUMAN:** `gh auth login` as a repository admin; a failing `bwrap` probe needs user namespaces.

## 2. Graphyard and the repository

```sh
git clone https://github.com/cryptob1/graphyard.git ~/graphyard && (cd ~/graphyard && npm ci)
export GRAPHYARD_CLI=~/graphyard/bin/graphyard.mjs
gy() { node "$GRAPHYARD_CLI" "$@"; }
cd /path/to/REPO && gy init --scan
```

The repository needs `origin` on GitHub, a test suite (`node --test` is detected as `junit-xml-v1`) and a `pull_request` workflow running it, whose job name becomes the required check. **Verify:** `gy doctor` readiness items `repository`, `required-checks` and `test-formats` are `ready`.

## 3. Install the control plane

```sh
gy install --provider compose --repo OWNER/REPO --reviewer claude --plan
gy install --provider compose --repo OWNER/REPO --reviewer claude --apply
```

**HUMAN:** approve the printed plan ([install](install.md)). **Verify:** `preflight[].ok` and `secretsRedacted` are `true` and `curl -s http://127.0.0.1:4310/healthz` answers `{"ok":true,…}`; then point the CLI at it with the operator credential:

```sh
export GRAPHYARD_URL=http://127.0.0.1:4310
export GRAPHYARD_TOKEN_FILE=~/.config/graphyard/OWNER-REPO/tokens/OWNER-REPO-operator.token
```

**Verify:** `gy doctor` passes `control-plane` and `credentials-file` (mode `0600`).

## 4. Register the GitHub App

`--apply` opens `http://127.0.0.1:4311`. **HUMAN:** click **Create GitHub App**, install it on OWNER/REPO only, approve any *Confirm access* GitHub Mobile code. **Verify:** `github-app` passes; on `missing permissions`, `gy github-setup --update-permissions --wait 600` and accept on the installation page ([permissions](github.md#app-permissions)).

## 5. Reviewer and revert-approver Apps

`--reviewer claude` registers the independent reviewer App (**HUMAN:** one more confirmation), without which no review gate passes, and makes it the main guard's revert approver (`GRAPHYARD_REVERT_APPROVER_*`). **Verify:** `reviewer-app` passes and readiness `revert-approver` is `ready`. Outside `install`, `gy master reviewer setup` registers it and you set the [variables](deployment.md#variables).

## 6. Onboard the checkout

```sh
gy init --scan --apply --url http://127.0.0.1:4310
git add AGENTS.md .gitignore graphyard.json .github/workflows && git commit -m "Adopt Graphyard" && git push
```

Use a pull request if `main` is protected; never commit `.graphyard/`. **Verify:** readiness `setup-proposal` is `ready` ([documentation policy](onboarding.md#documentation-policy), [generated instructions](onboarding.md#what-the-generated-instructions-authorize)).

## 7. Branch protection

`--apply` protects the base branch; once the first pull request shows `Graphyard / merge`, rerun step 3's `--apply` to require it; `gy master protection --apply` reconciles review policies. **Verify:** `branch-protection` passes (`Graphyard / merge` and `graphyard/landable` required, admin enforcement on, "up to date" off).

## 8. Agent environments

```sh
gy master environments --create claude,codex --apply
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-a claude   # HUMAN: /login, first-run screens
CODEX_HOME=~/.coding_agents/codex-a codex login       # HUMAN: browser login
gy master environments --apply
```

The second `--apply` records Claude Code's bypass-permissions consent; folder trust is written per checkout at launch. **Verify:** one `agent-environment:NAME` line per environment passes; then configure the [registry and roles](onboarding.md#configure-the-fleet).

## 9. Worker sandbox and harness rules

Workers write only their worktree and shared Git paths ([worker sandbox](master-agent-sessions.md#worker-sandbox)); **Verify:** `worker-sandbox` passes. `gy master harness claude --apply` (or `codex`) allows routine GitHub administration; merges stay [denied](master-agent-reference.md#github-administration-through-the-browser).

## 10. Start the master

```sh
gy master init --url http://127.0.0.1:4310 --herdr-workspace HERDR_WORKSPACE_ID --browser-profile Default \
  --token-stdin < ~/.config/graphyard/OWNER-REPO/tokens/OWNER-REPO-master.token
gy init --url http://127.0.0.1:4310   # each executor checkout
gy master start claude
```

`herdr workspace list` prints the ID; **HUMAN:** `--browser-profile` names a Chrome profile signed in to GitHub. **Verify:** `gy master status` shows `setup.supervisor` active.

## 11. Hosted variables (Railway only)

Set `RAILWAY_API_TOKEN` (**HUMAN:** the account owner issues it) and `GRAPHYARD_DATABASE_POOL_SIZE` ([limits](operations-reference.md)). **Verify:** `gy doctor` `production` has no `error`.

## 12. First item end to end

Write an item like [work.json](../examples/work.json) with one small criterion, then `gy master create item.json`; the loop dispatches, reviews and proves it, and GitHub merges once `Graphyard / merge` is green. **Verify:** `gy status GY-1` reaches stage `done`, and `gy doctor` reports `production.serving` at or past the merge commit with `production.incidents` `[]` ([production observation](deployment.md#production-deployment-observation)); with no deploy job, `production.latest` is `null` and merged is the end state.
