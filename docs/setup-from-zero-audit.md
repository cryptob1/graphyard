<!-- page: Understand or contribute | 2 | gaps a fresh setup hit, and their fixes. -->
# Setup-from-zero audit

GY-1352 walked [the checklist](setup-from-zero.md) on 2026-10-06, 05:01–05:28 UTC, as a fresh agent would, on the compose path: a scratch repository (`git init`, one `node --test` suite, a `pull_request` CI workflow, `origin` an unused GitHub name), with `GRAPHYARD_CONFIG_HOME` and `GRAPHYARD_AGENT_ENVIRONMENTS` empty scratch directories. It ran `install --plan`, `install --apply` (image, Postgres, server, health, `0600` tokens) up to the GitHub App confirmation page (a human step; nothing was created on GitHub, and the containers were removed), `init --scan`, `doctor` and `master environments`, and `doctor` against this repository's live installation.

Every gap is fixed in this pull request; none needed a follow-up item. Rows 8, 9, 23 and 24 came from the first round's independent review; tests, not a re-walk, pin their fixes.

| # | Gap | Kind | Fix |
| --- | --- | --- | --- |
| 1 | No single ordered path to a merged item; human-only steps unmarked | missing | [setup-from-zero.md](setup-from-zero.md), linked first from README.md, with a command and Verify per step and **HUMAN** steps |
| 2 | `doctor` had no per-prerequisite answer and named no fix step | missing doctor check | `doctor` prints `setupFromZero.lines` (`control-plane`, `credentials-file`, `github-app`, `reviewer-app`, `branch-protection`, `agent-environment:NAME`, `worker-sandbox`), each `FAIL` naming its step |
| 3 | Claude Code's bypass-permissions consent, once per config dir, holds an unattended launch | undocumented | Step 8 (`master environments --apply` records it); `agent-environment:NAME` fails until `skipDangerousModePermissionPrompt` is set |
| 4 | Claude Code's first-run screens (theme, login) also hold a launch in a fresh config dir | missing doctor check | Step 8 (**HUMAN** finishes them once); doctor checks `hasCompletedOnboarding` |
| 5 | Codex folder trust in fresh review checkouts | ambiguous | The launcher writes trust per checkout; step 8 says so, and doctor fails when `config.toml` (Codex) or `.claude.json` (Claude) is not rewritable |
| 6 | GitHub App permission requests need a GitHub Mobile *Confirm access* (sudo) approval | undocumented | Step 4 marks it **HUMAN**, as install's App step now does; `github-app` lists missing permissions (it found `deployments: read` missing on this repository's live App) |
| 7 | The reviewer App is a separate registration nobody is told to make; without it no review passes | missing | Step 5 (`--reviewer NAME`); `doctor` `reviewer-app`; install's next steps say when none is registered |
| 8 | `master reviewer setup` refused a loopback origin, so it could not register a reviewer for a compose install | misleading | Its HTTPS-only guard is gone: the manifest's origin rule (HTTPS, or loopback `http://`) decides, before the page opens |
| 9 | No installer configured the main guard's revert approver; compose's `server.env` takes no multi-line PEM | missing | `install --apply` sets `GRAPHYARD_REVERT_APPROVER_*` from the reviewer App's registration; compose mounts its key as a file (`_PRIVATE_KEY_FILE`). Step 5 verifies readiness `revert-approver` |
| 10 | Railway variables (`RAILWAY_API_TOKEN`, pool size) were in no setup path | undocumented | Step 11 (Railway only; the token is **HUMAN**) |
| 11 | Branch protection had no local check outside `master protection` | missing doctor check | Step 7; `branch-protection` reads it with `gh` and judges it as `master protection` does |
| 12 | install's protection plan said "up to date" off is what "the merge queue needs"; the queue was removed (GY-1236) | misleading CLI message | The plan, drift and apply text now say a candidate merges on the base it was built on |
| 13 | Worker sandbox Git paths fail only at a worker's first launch | missing doctor check | Step 9; `worker-sandbox` probes bubblewrap writing them |
| 14 | A fresh harness's deny rules can refuse the master's GitHub administration | undocumented | Step 9 runs `master harness KIND --apply` |
| 15 | install's preflight passes for a repository that does not exist, or that `gh` cannot administer | wrong | Step 1 verifies `viewerPermission` is `ADMIN`; `branch-protection` fails on a non-admin `gh` |
| 16 | `install --apply` connects the checkout with a worker credential, so `doctor` there reads as a worker | ambiguous | Step 3 points the CLI at the operator credential through `GRAPHYARD_TOKEN_FILE` |
| 17 | `master environments` before `.graphyard/master.json` exists failed with a bare `lstat` ENOENT | misleading CLI message | Master commands now name `install --apply` or `master init` and their steps |
| 18 | install's next steps said "create the first work item … dispatch a worker" without a command | ambiguous | They name `master create FILE` and step 12 |
| 19 | `init --scan` missed Node's built-in `node --test`, so `test-formats` asked for a test suite the repository had | misleading | The scan detects `node:test` from the test script and maps it to `junit-xml-v1` (`--test-reporter=junit`) |
| 20 | On compose, CI cannot reach a loopback control plane to publish `unit:*` proofs | undocumented | Step 12 relies on the loop's local proof producers; hosted installs use [CI proofs](github.md#proofs-in-ci) |
| 21 | Compose `--apply` stopped at the App step with "Use the deployed HTTPS origin": the manifest flow refused compose's loopback `http://` origin, so no compose install could register its App | wrong | A loopback origin is accepted, its webhook off (compose polls); the walk then reached the App confirmation page |
| 22 | Generated `AGENTS.md` never pointed at setup | missing | Its block names this checklist and the `setupFromZero` lines |
| 23 | Step 12 named no command proving the merge deployed | ambiguous | Step 12 verifies `production.serving`, `aheadBy` `0` and `incidents` `[]`, and what a repository with no deploy job shows |
| 24 | Step 10 elided the master's commands behind a link | ambiguous | Step 10 spells out `master init`, `init --url` and `master start`, and where the Herdr workspace ID comes from |
