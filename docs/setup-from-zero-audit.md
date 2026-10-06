<!-- page: Understand or contribute | 2 | gaps a fresh setup hit, and their fixes. -->
# Setup-from-zero audit

GY-1352 walked [the checklist](setup-from-zero.md) on 2026-10-06 as a fresh agent would: a scratch repository (`git init`, one `node --test` suite, a `pull_request` CI workflow, `origin` set to an unused GitHub name) on the compose path, with `GRAPHYARD_CONFIG_HOME` and `GRAPHYARD_AGENT_ENVIRONMENTS` pointing at empty scratch directories. It ran `install --plan`, `install --apply` (image, Postgres, server, health, `0600` tokens under `~/.config/graphyard/OWNER-REPO/tokens/`) up to the GitHub App confirmation page (a human step; no App or repository was created, and the containers were removed afterwards), `init --scan`, `doctor` and `master environments`. `doctor` also ran against this repository's live installation.

Every gap found, fixed in this pull request:

| # | Gap | Kind | Fix |
| --- | --- | --- | --- |
| 1 | No single ordered path to a merged item: steps spread over five pages and the CLI, human-only steps unmarked | missing | [setup-from-zero.md](setup-from-zero.md), linked first from README.md: each step has a command and a Verify; **HUMAN** steps say exactly what the human does |
| 2 | `doctor` had no per-prerequisite answer and named no fix step | missing doctor check | `doctor` prints `setupFromZero.lines` (`control-plane`, `credentials-file`, `github-app`, `reviewer-app`, `branch-protection`, `agent-environment:NAME`, `worker-sandbox`), each `FAIL` naming its step |
| 3 | Claude Code's bypass-permissions consent dialog, once per config dir, holds an unattended launch | undocumented | Checklist step 8 (`master environments --apply` records it); doctor's `agent-environment:NAME` fails until `skipDangerousModePermissionPrompt` is set |
| 4 | Claude Code's first-run screens (theme, login) also hold a launch in a fresh config dir | missing doctor check | Step 8 (**HUMAN** finishes them once); doctor checks `hasCompletedOnboarding` |
| 5 | Codex folder trust in fresh review checkouts | ambiguous | The launcher writes trust per checkout at launch; step 8 says so, and doctor fails when `config.toml` (Codex) or `.claude.json` (Claude) cannot be rewritten |
| 6 | GitHub App permission requests need a GitHub Mobile *Confirm access* (sudo) approval | undocumented | Step 4 marks it **HUMAN**; install's App step now says it; doctor's `github-app` lists missing permissions (it found `deployments: read` missing on this repository's live App) |
| 7 | The reviewer App is a separate registration nobody is told to make; without it no review passes | missing | Step 5 (`--reviewer NAME`); `doctor` `reviewer-app`; install's next steps say when none is registered |
| 8 | `master reviewer setup` refuses a loopback origin, so it cannot register a reviewer for a compose install | misleading | Step 5 uses `install --reviewer NAME`, which works on compose |
| 9 | The main guard's revert approver App is configured by no installer; compose's `server.env` takes no multi-line PEM and is rewritten on every `--apply` | missing | Step 5 states the hosted variables (the reviewer App serves) and that compose cannot take it yet, so its main guard cannot revert unaided |
| 10 | Railway variables (`RAILWAY_API_TOKEN`, database pool size) appear in no setup path | undocumented | Step 11 (Railway only; the token is **HUMAN**) |
| 11 | Branch protection had no local check outside `master protection` | missing doctor check | Step 7; doctor's `branch-protection` reads protection with `gh` and judges it as `master protection` does |
| 12 | install's protection plan said "up to date" off is what "the merge queue needs"; the queue was removed (GY-1236) | misleading CLI message | The plan, drift and apply text now say a candidate merges on the base it was built on |
| 13 | Worker sandbox Git paths fail only at a worker's first launch | missing doctor check | Step 9; doctor's `worker-sandbox` probes bubblewrap writing the shared Git paths |
| 14 | Harness deny rules: the master's GitHub administration can be refused by a fresh harness | undocumented | Step 9 runs `master harness KIND --apply` |
| 15 | install's preflight passes for a repository that does not exist, or that `gh` cannot administer | wrong | Step 1's Verify checks `viewerPermission` is `ADMIN`; doctor's `branch-protection` fails on a non-admin `gh` |
| 16 | `install --apply` connects the checkout with a worker credential, so `doctor` there reads as a worker | ambiguous | Step 3 points the CLI at the operator credential through `GRAPHYARD_TOKEN_FILE` |
| 17 | `master environments` before `.graphyard/master.json` exists failed with a bare `lstat` ENOENT | misleading CLI message | Every master command now names `install --apply` or `master init` and the checklist steps |
| 18 | install's next steps said "create the first work item … dispatch a worker" without a command | ambiguous | They name `master create FILE` and step 12 |
| 19 | `init --scan` did not recognise Node's built-in `node --test`, so `test-formats` said "add an executable test suite" to a repository that had one | misleading | The scan detects `node:test` from the test script and maps it to `junit-xml-v1` (`node --test --test-reporter=junit`) |
| 20 | On compose, CI cannot reach a loopback control plane, so `unit:*` proofs cannot be published from Actions | undocumented | Step 12 relies on the local proof producers the loop launches; hosted installs use [CI proofs](github.md#proofs-in-ci) |
| 21 | Compose `--apply` stopped at the App step with "Use the deployed HTTPS origin": the manifest flow refused compose's loopback `http://` origin, so no compose install could register its App | wrong | A loopback origin is accepted and its App is registered with the webhook off (compose polls); the walk then reached the App confirmation page |
| 22 | Generated `AGENTS.md` never pointed an agent at setup | missing | The generated block names this checklist and `doctor`'s `setupFromZero` lines |

