<!-- page: Understand or contribute | 2 | gaps a fresh setup hit, and their fixes. -->
# Setup-from-zero audit

Two walks of [the checklist](setup-from-zero.md): GY-1352's dry walk on the compose path, and GY-1384's pilot on a real repository. Each gap names its fix in the pull request that found it; no follow-up item was needed.

## GY-1384 pilot: cryptob1/graphyard-install-proof

The pilot runs as Graphyard runs everything: a worker session on vishrog, under lease, holding only its item's credential, parking at each **HUMAN** step. Elapsed time is wall clock from the round's first command to the step's Verify.

| Round | Step | Elapsed | Outcome |
| --- | --- | --- | --- |
| 1 — 2026-10-07 01:14 UTC, `graphyard-codex-2` | 1 | 8 min | FAIL: `gh repo view` 404 (no repository); the session's `gh` is the item's App token, scoped to cryptob1/graphyard; the operator's `gh` login on the host was invalid. Parked for the repository and a sealed admin token |

Attempt 1 (`graphyard-opencode-2`, 00:51 UTC) had parked after one minute for three human steps at once (repository, both Apps, agent logins); the human pressed the default **Approve**, which provisions nothing, and after 21 minutes the loop redispatched an item that still could not start.

| # | Gap | Kind | Fix |
| --- | --- | --- | --- |
| 25 | Step 1 assumed OWNER/REPO exists; nothing said to create it | missing | Step 1 **HUMAN**: create it when `gh repo view` says 404 |
| 26 | Step 1's `gh auth login` presumes the agent shares the human's shell; a worker session holds a repo-scoped App token it cannot replace | undocumented | Step 1 names the sealed-choice path: `park … --choice-secret`, then `unseal GY-N` fed to `gh auth login --with-token` under a scratch `GH_CONFIG_DIR` |
| 27 | "Ask for exactly that" let an attempt bundle three human steps into one request; the default **Approve** answered none of them | ambiguous | The intro asks for one thing per park, as a choice whose answer is the thing itself, never an approval |

## GY-1352 dry walk (2026-10-06, 05:01–05:28 UTC)

A fresh agent's walk on the compose path: a scratch repository (`git init`, one `node --test` suite, a `pull_request` workflow, `origin` an unused GitHub name), empty `GRAPHYARD_CONFIG_HOME` and `GRAPHYARD_AGENT_ENVIRONMENTS`; `install --plan` and `--apply` up to the GitHub App confirmation page (nothing created on GitHub, containers removed), `init --scan`, `doctor`, `master environments`, and `doctor` against this repository's live installation. Rows 8, 9, 23 and 24 came from its review; tests pin their fixes.

| # | Gap | Kind | Fix |
| --- | --- | --- | --- |
| 1 | No ordered path to a merged item; human steps unmarked | missing | This checklist: command, Verify and **HUMAN** per step |
| 2 | `doctor` named no prerequisite or fix step | missing doctor check | `setupFromZero.lines` (`control-plane`, `credentials-file`, `github-app`, `reviewer-app`, `branch-protection`, `agent-environment:NAME`, `worker-sandbox`), each `FAIL` naming its step |
| 3 | Claude Code's bypass-permissions consent holds a launch | undocumented | Step 8; doctor requires `skipDangerousModePermissionPrompt` |
| 4 | Claude Code's first-run screens hold a launch | missing doctor check | Step 8 (**HUMAN**); doctor checks `hasCompletedOnboarding` |
| 5 | Codex folder trust in fresh checkouts | ambiguous | Written per checkout at launch; doctor requires `config.toml`/`.claude.json` rewritable |
| 6 | App permission requests need GitHub Mobile *Confirm access* | undocumented | Step 4 **HUMAN**; `github-app` lists missing permissions |
| 7 | The reviewer App registration was never asked for | missing | Step 5 (`--reviewer NAME`); doctor `reviewer-app` |
| 8 | `master reviewer setup` refused a loopback origin | misleading | The manifest's origin rule (HTTPS or loopback `http://`) decides |
| 9 | No installer set the main guard's revert approver; `server.env` takes no PEM | missing | `install --apply` sets `GRAPHYARD_REVERT_APPROVER_*`; compose mounts `_PRIVATE_KEY_FILE`; step 5 verifies `revert-approver` |
| 10 | Railway variables in no setup path | undocumented | Step 11 (token **HUMAN**) |
| 11 | No local branch-protection check | missing doctor check | Step 7; `branch-protection` judges as `master protection` does |
| 12 | Protection plan cited the removed merge queue (GY-1236) | misleading CLI message | Plan, drift and apply say a candidate merges on its own base |
| 13 | Sandbox Git paths failed only at first launch | missing doctor check | Step 9; `worker-sandbox` probes bubblewrap |
| 14 | Harness deny rules can refuse the master's GitHub administration | undocumented | Step 9: `master harness KIND --apply` |
| 15 | Preflight passed for a missing or non-admin repository | wrong | Step 1 verifies `viewerPermission` `ADMIN`; `branch-protection` fails on non-admin `gh` |
| 16 | `install --apply` connected the checkout as a worker | ambiguous | Step 3: operator credential via `GRAPHYARD_TOKEN_FILE` |
| 17 | `master environments` without `master.json`: bare `lstat` ENOENT | misleading CLI message | Master commands name `install --apply` or `master init` |
| 18 | Next steps named no first-item command | ambiguous | They name `master create FILE` and step 12 |
| 19 | `init --scan` missed `node --test` | misleading | `node:test` maps to `junit-xml-v1` (`--test-reporter=junit`) |
| 20 | Compose CI cannot publish `unit:*` proofs to loopback | undocumented | Step 12: local producers; hosted installs use [CI proofs](github.md#proofs-in-ci) |
| 21 | Compose `--apply` refused its loopback origin at the App step | wrong | Loopback accepted, webhook off (compose polls) |
| 22 | Generated `AGENTS.md` never pointed at setup | missing | Its block names this checklist and `setupFromZero` |
| 23 | Step 12 had no deploy proof | ambiguous | Verifies `production.serving`, `aheadBy` `0`, `incidents` `[]` |
| 24 | Step 10 hid the master's commands behind a link | ambiguous | Spells out `master init`, `init --url`, `master start`, the workspace ID |
