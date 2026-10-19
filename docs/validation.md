<!-- page: Build integrations | 2 | cases, runners. -->
# E2E validation

An `e2e:` proof passes from pinned candidate/bundle/separate [collector](runner-setup.md). `validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`: `admin` defines cases (**Settings → Test cases**, `scenario scenario.json`); runners (`worker`) poll/ack/heartbeat; builders/collectors (`producer`) attest/publish, never both; `e2e:ID` pins latest immutable revision; only trusted attempts append **Tests** runs.

## E2E case repository

`e2e/cases/ID.json`, code-reviewed: `id` (file name)/`title`, optional `description`/`tags`, `target` (`uat`/`any`), `required` (default `false`), ordered `steps`:

- `http`: `method`, `path`, optional `body`, `status`; `expect` checks dotted `path` (`equals`/`exists`/`type`/`includes`); `save` persists; GET `waitSeconds` (≤3600; pending 0; shared 1800 s release deadline) retries; an install delivering nothing (`github` merger, no App) pends its `delivery`/`production` cases (`suspendedDeliveries`).
- `browser` (Playwright Chromium): `open` `path`, `fill` `label` with `value`, `click`/`expectText` `text`, optionally by `role`; `exact: false` matches substrings.
- `command`: `run` in the checkout with `TARGET_URL`, exit 0 passes, last 50 lines kept: `{"kind":"command","run":"npx playwright test"}`.
- `agent`: agent-browser pursues `goal` at `path` until `success` holds, ending `VERDICT: PASS|FAIL - reason`, screenshot kept: `{"kind":"agent","goal":"Win tic-tac-toe","success":["Board says You win"],"path":"/games"}`.

Both: `timeoutSeconds` (600). `secrets: ["NAME"]` from `~/.config/graphyard/INSTALL/e2e-secrets.TARGET.env` (0600, uncommitted) as variables and `{{secret:NAME}}`, redacted; missing fails, named. Saved: `{{token}}`/`{{run}}`/`{{case}}`. `e2e list` refuses malformed cases. `e2e sync` (`admin`, `e2e:record`) registers scenario revisions; edits make new ones; proofs keep theirs. `e2e run CASE|--tag T|--target uat|--all --url URL` (`GRAPHYARD_TOKEN`/`--token-file`, `--step-timeout` 30s, `--retries N` (none), `--no-record`): prints failing steps, exits non-zero. **Tests**: last outcome, 20-run pass rate, flaky flag, failed steps.

**Every deploy runs every case** under `e2e/cases/` ([continuous deploy](delivery.md#continuous-deploy)); `e2e record REPORT` records attempts (`GRAPHYARD_E2E_RECORD_TOKEN`: `graphyard-e2e-recorder`, only `e2e:record`). Merge previews run every required/`uat` case; static sites: loopback serves `GRAPHYARD_UAT_STATIC`, built by `GRAPHYARD_UAT_BUILD`.

## Verdicts

One retry: **passed**; **failed** (both); **flaky** (retry passed at same SHA; `RUN:attempt-1`/`-2`); **unrun** (stopped by failed required case); **blocked** (imported, couldn't run: `reason`); **pending** (required case whose outcome no done item serves: blocks only if a delivered outcome shares it or under [`e2e.pendingOutcomes: blocking`](delivery.md#managed-repositories)). Only failed or unaccepted flaky required cases block (imported: blocked/unrun/skipped too).

`POST /api/validation/import` (`external-runs:import` producers only; no evidence authority) binds runs to `sha`'s recorded `rc/` candidate, first importer only (409), idempotent per `producer`+`runId`, keeping verdicts, `evidence` and provenance; `GET /api/validation/import/SHA[?candidate=ID]`: runs and hold (once-`required` cases release only passing); `POST …/SHA/seal` (admin/operator agent) closes a released hold (later imports 409). Import-only producers reach only it, own runs/hold, `GET /api/principals` (self); a `delivery:observe-sha` producer reaches only [`POST /api/delivery/observe-sha`](delivery.md#observe-and-verify) and self, never imports, seals, digests, evidence, grants, work or ledger reads; reviewer slots count proof-granted producers only (409 past `GRAPHYARD_MAX_REVIEWERS`). `{"format":"graphyard-external-run-v1","producer":"huck","sha":"<40-hex>","runId":"r7","cases":[{"id":"login","verdict":"skipped","required":true}]}`; malformed fields or links refused.

`e2e/contract.json` lists required customer outcomes: `id`/`title`, optional `criteria`, proving `cases`.

`tests/fixtures/gy-1907-slow-tick-receipt`: `unit:slow-tick-names-cause`'s receipt; `integration:slow-tick-exact-head-twenty-consecutive` re-executes.

## Goals and acceptance

`goal FILE` records (`statement`/`users`/`constraints`/`deployTarget`), listed in `master status`. The `acceptance` role (`run.diagnostician` models) drafts outcomes (one required `uat` case each) and contract bindings in one approver-judged PR. `goal land` merges the approved head after CI, [revert approver App](deployment.md#variables) approving first; under a `control-plane` merger the draft is one unpushed `graphyard/goal-N-acceptance-R` commit the merge writer lands on the approver's exact-head verdict, and `goal land` records it. Stuck a day: `goal closed GOAL-N change -- REASON`. `complete`/later heads refuse protected case or `e2e/contract.json` changes lacking that item's `goal case-change`, approved by neither requester nor implementer; the loop's approver judges each; `master status`: `pendingCaseChanges`. [Planner](how-graphyard-works.md#from-goal-to-work-items) plans items; `goal deliver` needs each done and served in production.

## Candidates, requests, reports

`kind: bundle` pins `scenario`/`scenarioRevision`/`scenarioHash`, `digest`/`runnerImageDigest`, `reportFormat` (`graphyard-playwright-v1`/`junit-xml-v1`; skips/retries/timeouts/miscounts fail; `runner verify-report junit-xml-v1 inventory.json report.xml`). Runners `ack` ≤30s, heartbeat/20s; passes need `matched` target/verified artifacts/settled run; recover: `cancel`/`settle`/`retry`; `validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics).
