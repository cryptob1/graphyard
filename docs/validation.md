<!-- page: Build integrations | 2 | cases, runners. -->
# E2E validation

An `e2e:` proof passes from pinned candidate/bundle/separate [collector](runner-setup.md). `validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`: `admin` defines test cases (**Settings → Test cases**, `scenario scenario.json`); runners (`worker`) poll/ack/heartbeat; builders/collectors (`producer`) attest/publish, never both per build; `e2e:ID` pins latest immutable revision; only trusted attempts append **Tests** runs.

## E2E case repository

`e2e/cases/ID.json`, code-reviewed: `id` (file name)/`title`, optional `description`/`tags`, `target` (`uat`/`any`), `required` (default `false`), ordered `steps`:

- `http`: `method`, `path`, optional `body`, expected `status`; `expect` checks dotted JSON `path` (`equals`/`exists`/`type`/`includes`); `save` keeps values.
- `browser` (Playwright Chromium): `open` `path`, `fill` `label` with `value`, `click`/`expectText` `text`, optionally by `role`; `exact: false` matches substrings.
- `command`: `run` in the checkout with `TARGET_URL`, exit 0 passes, last 50 lines kept: `{"kind":"command","run":"npx playwright test"}`.
- `agent`: agent-browser pursues `goal` at `path` until `success` holds, ending `VERDICT: PASS|FAIL - reason`, screenshot kept: `{"kind":"agent","goal":"Win tic-tac-toe","success":["Board says You win"],"path":"/games"}`.

Both: `timeoutSeconds` (600). Case `secrets: ["NAME"]` from `~/.config/graphyard/INSTALL/e2e-secrets.TARGET.env` (0600, uncommitted) as variables and `{{secret:NAME}}`, redacted; missing fails naming file/variable. Values: `{{token}}`/`{{run}}`/`{{case}}`, saved. `e2e list` refuses malformed cases. `capacity-limit-redispatch` (proofs via `tests/helpers/run-tests.ts`, no backlog items) and GOAL-1's `any`-targeted fixture cases `fixture-static-home`/`fixture-compose-app` ship revision 1 in `src/scenarios.ts`. `e2e sync` (`admin`, `e2e:record`) registers scenario revisions; edits make new ones, proofs keep theirs. `e2e run CASE|--tag T|--target uat|--all --url URL`: `GRAPHYARD_TOKEN`/`--token-file`, no token argument; `--step-timeout` (30s); `--retries N` (none); prints failing steps/reasons; `--report` JSON; fails non-zero; records base URL/served SHA/duration/outcome/failing step (`--no-record`: none). **Tests** shows last outcome/SHA/environment, 20-run pass rate, flaky flag, failed steps, required/optional.

**Every release candidate runs `uat` cases**, in id order, as [`release validate`](delivery.md#release-candidates)'s `e2e` suite (`GRAPHYARD_UAT_URL`/`GRAPHYARD_UAT_TOKEN`; `--suite` commands' detail: `GRAPHYARD_SUITE_DETAIL`); `e2e record REPORT` records every attempt ([`e2e:record` agent](delivery.md#release-filing-credential)). A managed `control-plane`-merger candidate runs every required/`uat` case in-loop (`src/release-project.ts`), none skipped: a failing required case fails it, `rc-uat/ID`'s `e2e` names each verdict, blocking cases feed holds/revert. Static sites (no `GRAPHYARD_UAT_URL`): `GRAPHYARD_UAT_STATIC` output, built by `GRAPHYARD_UAT_BUILD` (errors fail `build`), loopback-served as UAT (`/healthz`: candidate SHA).

## Release verdicts

One retry: **passed**; **failed** (both); **flaky** (retry passed at same SHA; `RUN:attempt-1`/`-2`); **unrun** (stopped by failed required case; listed apart); **blocked** (imported, couldn't run: `reason`); **pending** (required case whose outcome no done item serves, `rc/ID` `pendingOutcomes`, plane-read in `uat`: blocks only if a delivered outcome shares it or under [`e2e.pendingOutcomes: blocking`](delivery.md#managed-repositories); unreadable plane: warning). Only failed or unaccepted flaky required cases block (imported: blocked/unrun/skipped too).

Flaky required cases block promotion until an `evidence` decision (`{"case":ID,"runId":RUN,"sha":FULL_SHA}` on hold item, another agent approving) accepts (refused unless both attempts recorded at that SHA); `release promote` reads only that run's/SHA's applied decisions, promoting only passing UATs.

`POST /api/validation/import` (`external-runs:import` producers only; no evidence authority) binds runs to `sha`'s `rc/` candidate (none: 409), first importer only (409), idempotent per `producer`+`runId`, keeps verdicts/`toolVersion`/untrimmed `result`s/`evidenceId`s/ids/`evidence` (links/`{evidenceId,storageKey}` pointers)/`catalogCommitSha` (provenance; `caseVersion`/`attempts`/`durationMs`/`reportRows` null unless given); `GET /api/validation/import/SHA[?candidate=ID]`: runs, hold (held/unread blocks promotion, retried without UAT rerun until window end/superseding cut; once-`required` cases release only passing); uat `imports` job (`release imports ID`, `GRAPHYARD_RELEASE_TOKEN`) seals released holds (`POST …/SHA/seal`; later imports 409), handing promotion `GRAPHYARD_PROMOTION_IMPORTS` (that candidate, sealed). Import-only producers reach only it, own runs/hold, `GET /api/principals` (self); reviewer slots count proof-granted producers only (409 past `GRAPHYARD_MAX_REVIEWERS`). `{"format":"graphyard-external-run-v1","producer":"huck","sha":"<40-hex>","runId":"r7","cases":[{"id":"login","verdict":"skipped","required":true}]}`; unknown fields/non-HTTP(S)/credentialed links/blank,over-200-character,control-character `result`/`evidenceId` refused.

`e2e/contract.json` lists required customer outcomes: `id`/`title`, optional `criteria`, proving `cases` (shareable). Pre-cut `release contract` refuses `release cut` when a bound case is missing/invalid/optional/not `uat`-targeted or proves nothing.

## Flake ledger

A required check or merge-trial file passing its one rerun at the failed SHA (PR `checkReruns` `passed`, main `mainGuardFlakes`, trial `mergeLedger.flakes`) is a flake, read into `.graphyard/flake-ledger.json` (0600; ≤500 entries, 30 days). Each `unit:`/`integration:` test gets one P1 `Flaky test: NAME` item at its first flake unless it proves its item, else after 3+ on 2+ SHAs/7 days; none while open or 7 days after. Own-proof failures are never excused; they and unread `unit:`/`integration:` proofs never rerun checks; only their trial file holds. Gates ignore it.

`tests/fixtures/gy-1907-slow-tick-receipt`: `unit:slow-tick-names-cause`'s receipt/failed attempt; `integration:slow-tick-exact-head-twenty-consecutive` re-executes.

## Goals and acceptance

`goal FILE` records (`statement`/`users`/`constraints`/`deployTarget`), in `master status`. The `acceptance` role (`run.diagnostician` models) drafts outcomes (one required `uat` case each) and contract bindings in one pull request the approver (never author) judges, redrafted when refused (≤3). `goal land` merges the approved head after CI, [revert approver App](deployment.md#variables) approving first. Under a `control-plane` merger the draft is one unpushed commit on `graphyard/goal-N-acceptance-R` (`acceptance.pr` null), always sensitive: the merge writer lands only its cases/contract on the approver's exact-head verdict by one leased deploy-key push; `goal land` records it once first-parent history holds the merge. Conflicting/moved: recommitted/rejudged; stuck daylong: `goal closed GOAL-N change -- REASON`. `complete`/later heads refuse protected case or `e2e/contract.json` changes lacking that item's `goal case-change`, approved by neither requester nor implementer; the loop's approver judges each (delivered goals too), retrying next cycle; `master status`: `pendingCaseChanges`. [Planner](how-graphyard-works.md#from-goal-to-work-items) plans items; `goal deliver` needs each done and served in production.

## Release holds

One hold per failed outcome, tagged `rc-hold/OUTCOME/CANDIDATE` listing failed/flaky cases, failing steps/unmet criteria; later failures attach; clears once every attached case passes on a newer candidate UAT serves at its SHA (`release holds`). Folding: two-party `fold` decision (`{"outcome":A,"into":B}`), then `release fold A --decision ID`. Process incidents file follow-ups.

## Candidates, requests, reports

`kind: bundle` pins `scenario`/`scenarioRevision`/`scenarioHash`, `digest`/`runnerImageDigest`, `reportFormat` (`graphyard-playwright-v1`/`junit-xml-v1`; skips/retries/timeouts/miscounts fail; `runner verify-report junit-xml-v1 inventory.json report.xml` previews). Runners `ack` ≤30s, heartbeat/20s; passes need `matched` target/verified artifacts/settled run; recover: `cancel`/`settle`/`retry`; `validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stalls.
