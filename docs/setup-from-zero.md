<!-- page: Start here | 0 | a new repository to a merged first item, step by step. -->
# From zero to a running Graphyard

> set up Graphyard for OWNER/REPO following docs/setup-from-zero.md

One ordered checklist from "a repository and nothing else" to an item Graphyard dispatched, reviewed, merged and deployed. Run each step's command, then its **Verify**; do not start the next step until it passes. **HUMAN** marks the only steps an agent cannot do: stop and ask for exactly that, nothing more. The [install hard rules](install.md#hard-rules) apply throughout: never print a credential.

`graphyard doctor` prints `setupFromZero.lines`: one `PASS`/`FAIL` line per prerequisite, each failure naming the step below that fixes it, and `next`, the first gap.

## 1. Machine prerequisites

```sh
node --version          # v24 or later
gh auth status          # logged in; scopes repo, admin:repo_hook
docker compose version  # the compose path
herdr --version         # sessions run in Herdr panes
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --share-net --die-with-parent -- true
```

**Verify:** every command exits 0, and `gh repo view OWNER/REPO --json viewerPermission -q .viewerPermission` prints `ADMIN`. **HUMAN:** `gh auth login` as a repository admin; a failing `bwrap` probe needs the host administrator to allow unprivileged user namespaces.

## 2. Graphyard and the repository

```sh
git clone https://github.com/cryptob1/graphyard.git ~/graphyard && (cd ~/graphyard && npm ci)
export GRAPHYARD_CLI=~/graphyard/bin/graphyard.mjs
gy() { node "$GRAPHYARD_CLI" "$@"; }
cd /path/to/REPO && gy init --scan
```

The repository needs `origin` on GitHub, its default branch pushed, a test suite, and a GitHub Actions workflow running it on `pull_request`; its job name becomes the required check. **Verify:** `gy doctor` readiness items `repository`, `required-checks` and `test-formats` are `ready` (their `recovery` names the fix).

## 3. Install the control plane

```sh
gy install --provider compose --repo OWNER/REPO --reviewer claude --plan
gy install --provider compose --repo OWNER/REPO --reviewer claude --apply
```

[Install](install.md) explains every field; Railway, Hetzner and hosts differ only in `--provider`. **HUMAN:** approve the printed plan. **Verify:** every `preflight[].ok` and `secretsRedacted` are `true`; `curl -s http://127.0.0.1:4310/healthz` is `{"ok":true,…}`. Point the CLI at it with the operator credential (the human's, never a worker's):

```sh
export GRAPHYARD_URL=http://127.0.0.1:4310
export GRAPHYARD_TOKEN_FILE=~/.config/graphyard/OWNER-REPO/tokens/OWNER-REPO-operator.token
```

**Verify:** `gy doctor` passes `control-plane` and `credentials-file` (`GRAPHYARD_TOKEN_FILE`, or `.graphyard/connection.json`, mode `0600`).

## 4. Register the GitHub App

`--apply` opens `http://127.0.0.1:4311`. **HUMAN:** click **Create GitHub App**, then install it on OWNER/REPO only. GitHub may ask to *Confirm access* (sudo) with a GitHub Mobile code: only the human can approve it. **Verify:** `github-app` passes; on `missing permissions`, run `gy github-setup --update-permissions --wait 600` and the human accepts the request on the installation page ([permissions](github.md#app-permissions)).

## 5. Reviewer and revert-approver Apps

`--reviewer claude` registers a second App, the independent reviewer (**HUMAN:** one more confirmation, same page). Without it no review gate can pass. **Verify:** `reviewer-app` passes. The main guard's revert approver must be an App other than the control plane's; the reviewer App serves. On a hosted install set `GRAPHYARD_REVERT_APPROVER_APP_ID`, `_INSTALLATION_ID` and `_PRIVATE_KEY` from `.graphyard/github-reviewer-claude.json` ([variables](deployment.md#variables)) and redeploy; **Verify:** readiness `revert-approver` is `ready`. Compose cannot take it yet (see the audit): the guard then cannot revert a broken `main` on its own.

## 6. Onboard the checkout

```sh
gy init --scan --apply --url http://127.0.0.1:4310
git add AGENTS.md .gitignore graphyard.json .github/workflows && git commit -m "Adopt Graphyard" && git push
```

Commit through a pull request if `main` is already protected; never commit `.graphyard/`. **Verify:** readiness `setup-proposal` is `ready`. [Documentation policy](onboarding.md#documentation-policy) and the [generated instructions](onboarding.md#what-the-generated-instructions-authorize) explain what the files authorize.

## 7. Branch protection

`--apply` protects the base branch; once the first pull request shows `Graphyard / merge`, rerun step 3's `--apply` so it is required. `gy master protection --apply` reconciles review policies. **Verify:** `branch-protection` passes (`Graphyard / merge` and `graphyard/landable` required from the App, administrator enforcement on, "up to date" off).

## 8. Agent environments

```sh
gy master environments --create claude,codex --apply
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-a claude   # HUMAN: /login, finish the first-run screens
CODEX_HOME=~/.coding_agents/codex-a codex login       # HUMAN: complete the browser login
gy master environments --apply
```

The second `--apply` records Claude Code's bypass-permissions consent (`skipDangerousModePermissionPrompt`); folder trust (Claude `.claude.json`, Codex `config.toml`) is written per checkout at launch, so both files must stay writable. **Verify:** one `agent-environment:NAME` line per environment passes. Then the [registry and roles](onboarding.md#configure-the-fleet).

## 9. Worker sandbox and harness rules

Workers write only their worktree and the shared Git paths ([worker sandbox](master-agent-sessions.md#worker-sandbox)). **Verify:** `worker-sandbox` passes (bubblewrap writes `objects`, `refs/remotes`, `refs/heads/graphyard` and their logs). Run `gy master harness claude --apply` (or `codex`) so the master's routine GitHub administration is allowed and merges stay [denied](master-agent-reference.md#github-administration-through-the-browser).

## 10. Start the master

[Start the master](onboarding.md#3-start-the-master) with the master token: `gy master init … --token-stdin`, `gy init --url …` for executors, `gy master start claude`. **HUMAN:** `--browser-profile` names a Chrome profile the human signed in to GitHub. **Verify:** `gy master status` shows `setup.supervisor` active and executors live.

## 11. Hosted variables (Railway only)

Compose skips this. On Railway set `RAILWAY_API_TOKEN` (**HUMAN:** only the account owner can issue it) and size `GRAPHYARD_DATABASE_POOL_SIZE` ([limits](operations-reference.md)). **Verify:** `gy doctor` `production` has no `error`.

## 12. First item end to end

Write an item like [work.json](../examples/work.json) with one small criterion and `"policy":{"checks":["test"],"review":true}`, then `gy master create item.json`. The loop dispatches it, the worker opens a pull request, the reviewer App posts a verdict, producers prove each criterion, and GitHub merges once `Graphyard / merge` is green. **Verify:** `gy status GY-1` reaches stage `done` with the PR merged; a deploy job then serves the merge ([production observation](deployment.md#production-deployment-observation)).

Gaps found walking this checklist, and their follow-ups: [setup-from-zero audit](setup-from-zero-audit.md).
