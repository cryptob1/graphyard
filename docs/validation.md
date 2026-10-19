<!-- page: Build integrations | 2 | cases, runners. -->
# E2E validation

An `e2e:` proof passes from pinned candidate/bundle/separate [collector](runner-setup.md). `validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`: `admin` defines cases (**Settings → Test cases**, `scenario scenario.json`); runners (`worker`) poll/ack/heartbeat; builders/collectors (`producer`) attest/publish, never both; `e2e:ID` pins latest immutable revision; only trusted attempts append **Tests** runs.

## E2E case repository

`e2e/cases/ID.json`, code-reviewed: `id` (file name)/`title`, optional `description`/`tags`, `target` (`uat`/`any`), `required` (default `false`), ordered `steps`:

- `http`: `method`, `path`, optional `body`, `status`; `expect` checks dotted `path` (`equals`/`exists`/`type`/`includes`); `save` persists; GET `waitSeconds` (≤3600; pending 0; shared 1800 s release deadline) retries; an install delivering nothing (`github` merger, no App) pends its `candidates`/`delivery`/`production` cases (`suspendedDeliveries`; holds' post-suite probe must agree).
- `browser` (Playwright Chromium): `open` `path`, `fill` `label` with `value`, `click`/`expectText` `text`, optionally by `role`.
- `command`: `run` in the checkout with `TARGET_URL`, exit 0 passes, last 50 lines kept: `{"kind":"command","run":"npx playwright test"}`.
- `agent`: agent-browser pursues `goal` at `path` until `success` holds, ending `VERDICT: PASS|FAIL - reason`, screenshot kept: `{"kind":"agent","goal":"Win tic-tac-toe","success":["Board says You win"],"path":"/games"}`.

Both: `timeoutSeconds` (600). `secrets: ["NAME"]` from `~/.config/graphyard/INSTALL/e2e-secrets.TARGET.env` (0600, uncommitted) as variables and `{{secret:NAME}}`, redacted; missing fails, named. Saved: `{{token}}`/`{{run}}`/`{{case}}`. `e2e list` refuses malformed cases. `e2e sync` (`admin`, `e2e:record`) registers scenario revisions; edits make new ones; proofs keep theirs. `e2e run CASE|--tag T|--target uat|--all --url URL` (`GRAPHYARD_TOKEN`/`--token-file`, `--step-timeout` 30s, `--retries N` (none), `--no-record`): prints failing steps, exits non-zero.

**Every release candidate runs `uat` cases** in order as [`release validate`](delivery.md#release-candidates)'s `e2e` suite (`GRAPHYARD_UAT_URL`/`GRAPHYARD_UAT_TOKEN`, `GRAPHYARD_SUITE_DETAIL`), GOAL-1's seven cases on a fresh `init`-onboarded candidate-checkout plane (`scripts/onboarding-delivery-fixture.mjs`); `e2e record REPORT` records attempts ([`e2e:record` agent](delivery.md#release-filing-credential)). Static sites (no `GRAPHYARD_UAT_URL`): loopback serves `GRAPHYARD_UAT_STATIC`, built by `GRAPHYARD_UAT_BUILD`.

## Release verdicts

One retry: **passed**; **failed** (both); **flaky** (retry passed at same SHA; `RUN:attempt-1`/`-2`); **unrun** (stopped by failed required case); **blocked** (imported, couldn't run: `reason`); **pending** (required case whose outcome no done item serves: blocks only if a delivered outcome shares it or under [`e2e.pendingOutcomes: blocking`](delivery.md#managed-repositories)). Only failed or unaccepted flaky required cases block (imported: blocked/unrun/skipped too).

Flaky required cases block promotion until an `evidence` decision (`{"case":ID,"runId":RUN,"sha":FULL_SHA}` on hold item) accepts; `release promote` reads only that run's/SHA's decisions.

`POST /api/validation/import` (`external-runs:import` producers only; no evidence authority) binds runs to `sha`'s `rc/` candidate, first importer only (409), idempotent per `producer`+`runId`; `GET /api/validation/import/SHA[?candidate=ID]`: runs, hold (held/unread blocks promotion until window end/superseding cut; once-`required` cases release only passing); uat `imports` job (`release imports ID`, `GRAPHYARD_RELEASE_TOKEN`) seals released holds (`POST …/SHA/seal`; later imports 409), handing promotion `GRAPHYARD_PROMOTION_IMPORTS`. Import-only producers reach only it, own runs/hold, `GET /api/principals` (self); a `delivery:observe-sha` producer reaches only [`POST /api/delivery/observe-sha`](delivery.md#observe-and-verify) and self, nothing else. `{"format":"graphyard-external-run-v1","producer":"huck","sha":"<40-hex>","runId":"r7","cases":[{"id":"login","verdict":"skipped","required":true}]}`; malformed fields or links refused.

`e2e/contract.json` lists required customer outcomes: `id`/`title`, optional `criteria`, proving `cases`. `release contract` refuses a cut whose bound case is missing/invalid/optional/not `uat`-targeted or proves nothing.

`tests/fixtures/gy-1907-slow-tick-receipt`: `unit:slow-tick-names-cause`'s receipt; `integration:slow-tick-exact-head-twenty-consecutive` re-executes.

## Goals and acceptance

`goal FILE` records (`statement`/`users`/`constraints`/`deployTarget`). The `acceptance` role (`run.diagnostician` models) drafts outcomes (one required `uat` case each) and contract bindings in one approver-judged PR. `goal land` merges the approved head after CI, [revert approver App](deployment.md#variables) approving first; under a `control-plane` merger the draft is one unpushed `graphyard/goal-N-acceptance-R` commit the merge writer lands on the approver's exact-head verdict, and `goal land` records it. Stuck a day: `goal closed GOAL-N change -- REASON`. `complete`/later heads refuse protected case or `e2e/contract.json` changes lacking that item's `goal case-change`, approved by neither requester nor implementer; `master status`: `pendingCaseChanges`. [Planner](how-graphyard-works.md#from-goal-to-work-items) plans items; `goal deliver` needs each done and served in production.

## Release holds

One hold per failed outcome (`rc-hold/OUTCOME/CANDIDATE`) lists failed/flaky cases; later failures attach; clears once every attached case passes on a newer candidate UAT serves at its SHA (`release holds`). Folding: two-party `fold` decision, then `release fold A --decision ID`.

## Candidates, requests, reports

`kind: bundle` pins `scenario`/`scenarioRevision`/`scenarioHash`, `digest`/`runnerImageDigest`, `reportFormat` (`graphyard-playwright-v1`/`junit-xml-v1`; skips/retries/timeouts/miscounts fail; `runner verify-report junit-xml-v1 inventory.json report.xml`). Runners `ack` ≤30s, heartbeat/20s; passes need `matched` target/verified artifacts/settled run; recover: `cancel`/`settle`/`retry`; `validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics).
