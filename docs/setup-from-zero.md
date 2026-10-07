<!-- page: Start here | 0 | setup checklist. -->
# From zero to a running Graphyard

> set up Graphyard for OWNER/REPO following docs/setup-from-zero.md

Run each step, then its **Verify**; ask a human only for **HUMAN** steps. [Hard rules](install.md#hard-rules) apply.

`graphyard doctor` prints `setupFromZero.lines`: `PASS`/`FAIL` per prerequisite (`control-plane`, `credentials-file`, `github-app`, `reviewer-app`, `branch-protection`, `agent-environment:NAME`, `worker-sandbox`), each `FAIL` naming its step; `next` names the first gap (readiness `recovery`, then `FAIL`). Generated `AGENTS.md` links here. `GRAPHYARD_CONFIG_HOME` relocates credentials, `GRAPHYARD_AGENT_ENVIRONMENTS` (`~/.coding_agents`) agent environments.

## 1. Machine prerequisites

```sh
node --version          # v24 or later
gh auth status          # scopes repo, admin:repo_hook
docker compose version
herdr --version
bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all --share-net --die-with-parent -- true
```

**Verify:** `gh repo view OWNER/REPO --json viewerPermission -q .viewerPermission` prints `ADMIN`. **HUMAN:** `gh auth login` as admin; a failing `bwrap` needs user namespaces allowed.

## 2. Graphyard and the repository

```sh
git clone https://github.com/cryptob1/graphyard.git ~/graphyard && (cd ~/graphyard && npm ci)
export GRAPHYARD_CLI=~/graphyard/bin/graphyard.mjs
gy() { node "$GRAPHYARD_CLI" "$@"; }
cd /path/to/REPO && gy init --scan
```

A repository (even fresh from `git init`) needs `origin` on GitHub with its default branch, tests, and a `pull_request` workflow whose job is the required check; `node:test` is detected as `junit-xml-v1` (`--test-reporter=junit`). **Verify:** readiness `repository`, `required-checks`, `test-formats` are `ready`.

## 3. Install the control plane

```sh
gy install --provider compose --repo OWNER/REPO --reviewer claude --plan
gy install --provider compose --repo OWNER/REPO --reviewer claude --apply
```

Providers differ only in `--provider` ([install](install.md)). **HUMAN:** approve the plan. **Verify:** `preflight[].ok`, `secretsRedacted` `true`; `curl -s http://127.0.0.1:4310/healthz` is `{"ok":true,…}`. `--apply` connects as a worker; use the human's operator credential:

```sh
export GRAPHYARD_URL=http://127.0.0.1:4310
export GRAPHYARD_TOKEN_FILE=~/.config/graphyard/OWNER-REPO/tokens/OWNER-REPO-operator.token
```

**Verify:** `control-plane`, `credentials-file` (or `.graphyard/connection.json`; mode `0600`).

## 4. Register the GitHub App

`--apply` opens `http://127.0.0.1:4311` (loopback `http://` accepted, webhook off: compose polls). **HUMAN:** **Create GitHub App**, install on OWNER/REPO only, approve any *Confirm access* (sudo) Mobile code. **Verify:** `github-app`; listed `missing permissions` (e.g. `deployments: read`) → `gy github-setup --update-permissions --wait 600`, accept on the installation page ([permissions](github.md#app-permissions)).

## 5. Reviewer and revert-approver Apps

`--reviewer NAME` registers the reviewer App every review needs (**HUMAN:** confirm) and makes it the main guard's revert approver (`GRAPHYARD_REVERT_APPROVER_*`; each `--apply` resets hand-set values); on compose the key mounts as a file (`_PRIVATE_KEY_FILE`; `server.env` takes no multi-line PEM). **Verify:** `reviewer-app`; readiness `revert-approver` `ready`. Otherwise `gy master reviewer setup` (HTTPS or loopback origin, checked before the page opens) plus the [variables](deployment.md#variables).

## 6. Onboard the checkout

```sh
gy init --scan --apply --url http://127.0.0.1:4310
git add AGENTS.md .gitignore graphyard.json .github/workflows && git commit -m "Adopt Graphyard" && git push
```

PR if `main` is protected; never commit `.graphyard/`. **Verify:** readiness `setup-proposal` ([documentation policy](onboarding.md#documentation-policy), [generated instructions](onboarding.md#what-the-generated-instructions-authorize)).

## 7. Branch protection

After the first pull request shows `Graphyard / merge`, step 3's `--apply` requires it; `gy master protection --apply` reconciles review policies. **Verify:** `branch-protection` (via admin `gh`): both App checks required, admin enforcement on, "up to date" off (candidates merge on their build base).

## 8. Agent environments

```sh
gy master environments --create claude,codex --apply
CLAUDE_CONFIG_DIR=~/.coding_agents/claude-a claude   # HUMAN: /login, first-run screens
CODEX_HOME=~/.coding_agents/codex-a codex login       # HUMAN: browser login
gy master environments --apply
```

The second `--apply` records `skipDangerousModePermissionPrompt`; launches write folder trust to `.claude.json`/`config.toml` (keep writable). Without `.graphyard/master.json`, master commands name `install --apply` or `master init` (not `lstat` ENOENT). **Verify:** each `agent-environment:NAME` (consent, `hasCompletedOnboarding`, writability); then [registry and roles](onboarding.md#configure-the-fleet).

## 9. Worker sandbox and harness rules

**Verify:** `worker-sandbox` (bubblewrap writes `objects`, `refs/remotes`, `refs/heads/graphyard`, their logs; [sandbox](master-agent-sessions.md#worker-sandbox)). `master harness KIND --apply` (`claude`/`codex`) allows GitHub administration; merges stay [denied](master-agent-reference.md#github-administration-through-the-browser).

## 10. Start the master

```sh
gy master init --url http://127.0.0.1:4310 --herdr-workspace HERDR_WORKSPACE_ID --browser-profile Default \
  --token-stdin < ~/.config/graphyard/OWNER-REPO/tokens/OWNER-REPO-master.token
gy init --url http://127.0.0.1:4310   # each executor checkout
gy master start claude                # or codex
```

ID: `herdr workspace list`; **HUMAN:** `--browser-profile` is a Chrome profile signed in to GitHub. **Verify:** `gy master status`: `setup.supervisor` active, executors live.

## 11. Hosted variables (Railway only)

`RAILWAY_API_TOKEN` (**HUMAN:** account owner) and `GRAPHYARD_DATABASE_POOL_SIZE` ([limits](operations-reference.md)). **Verify:** doctor `production` lacks `error`.

## 12. First item end to end

Write an item like [work.json](../examples/work.json) (`"policy":{"checks":["test"],"review":true}`), then `master create FILE`. Local producers prove `unit:*` on compose (CI cannot reach loopback); hosted installs use [CI proofs](github.md#proofs-in-ci). **Verify:** `gy status GY-1` is `done`; `gh pr view N --json state` is `MERGED`; doctor shows `production.serving` at or past the merge, `production.aheadBy` `0`, `production.incidents` `[]` ([observation](deployment.md#production-deployment-observation)); without a deploy job `production.latest` is `null`.
