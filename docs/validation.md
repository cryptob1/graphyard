<!-- page: Build integrations | 2 | cases, runners. -->
# E2E validation

An `e2e:` proof passes from pinned candidate, bundle, separate [collector](runner-setup.md). `graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`: `admin` defines test cases (**Settings → Test cases**, `graphyard scenario scenario.json`); runners (`worker`) poll, ack, heartbeat; builders and collectors (`producer`) attest, publish, never both per build; `e2e:ID` pins latest immutable revision; only trusted attempts append **Tests** runs.

## E2E case repository

`e2e/cases/ID.json`, code-reviewed: `id` (file name), `title`, optional `description`, `tags`, `target` (`uat`/`any`), `required` (default `false`), ordered `steps`:

- `http`: `method`, `path`, optional `body`, expected `status`; `expect` checks dotted JSON `path` (`equals`, `exists`, `type`, `includes`); `save` keeps values.
- `browser` (Playwright Chromium): `open` `path`, `fill` `label` with `value`, `click`/`expectText` `text`, optionally by `role`; `exact: false` matches substrings.
- `command`: `run` in the checkout with `TARGET_URL`, exit 0 passes, last 50 lines kept: `{"kind":"command","run":"npx playwright test"}`.
- `agent`: agent-browser pursues `goal` at `path` until `success` holds, ending `VERDICT: PASS|FAIL - reason`, screenshot kept: `{"kind":"agent","goal":"Win tic-tac-toe","success":["Board says You win"],"path":"/games"}`.

Both: `timeoutSeconds` (600). Case `secrets: ["NAME"]` from `~/.config/graphyard/INSTALL/e2e-secrets.TARGET.env` (0600, uncommitted) as variables and `{{secret:NAME}}`, redacted; missing fails naming file, variable. Values: `{{token}}`, `{{run}}`, `{{case}}`, saved. `graphyard e2e list` refuses malformed cases by file, field. `capacity-limit-redispatch` (GY-1708; proofs via `tests/helpers/run-tests.ts`, no backlog items) and GOAL-1's `any`-targeted fixture cases `fixture-static-home`, `fixture-compose-app` (GY-1800) ship revision 1 in `src/scenarios.ts`, materialized atomically on list/create/record. `graphyard e2e sync` (`admin`, `e2e:record`) registers scenario revisions; edits make new ones, proofs keep theirs. `graphyard e2e run CASE|--tag T|--target uat|--all --url URL`: `GRAPHYARD_TOKEN`/`--token-file`, no token argument; `--step-timeout` (30s); `--retries N` (none); prints failing steps, reasons; `--report` JSON; non-zero on failure; records base URL, served SHA, duration, outcome, failing step unless `--no-record`. **Tests** shows last outcome, SHA, environment, 20-run pass rate, flaky flag, failed steps, required/optional.

**Every release candidate runs `uat` cases**, in id order, as [`release validate`](delivery.md#release-candidates)'s `e2e` suite (`GRAPHYARD_UAT_URL`, `GRAPHYARD_UAT_TOKEN`; `--suite` commands write detail to `GRAPHYARD_SUITE_DETAIL`); `graphyard e2e record REPORT` records every attempt ([`e2e:record` agent](delivery.md#release-filing-credential)). A managed repository's candidate under a `control-plane` merger (GY-1535) runs every required and `uat` case in the loop's runner (`src/release-project.ts`), none skipped after failures: a failing required case fails it, `rc-uat/ID`'s `e2e` names each verdict, and blocking cases feed holds and the revert. A static site names no `GRAPHYARD_UAT_URL`: `GRAPHYARD_UAT_STATIC` names its build output, built first by `GRAPHYARD_UAT_BUILD` (errors fail the `build` suite), served on loopback as UAT (`/healthz` answers the candidate SHA).

## Release verdicts

One retry: **passed**; **failed** (both); **flaky** (retry passed at same SHA; `RUN:attempt-1`, `RUN:attempt-2`); **unrun** (stopped by a failed required case; listed apart; never in a managed repository); **pending** (required case whose outcome no done item serves, `rc/ID` `pendingOutcomes`, plane-read in the `uat` environment: never blocks unless a delivered outcome shares it; an unreadable plane warns, records none). Only failed or unaccepted flaky required cases block; optional ones marked on **Tests**.

Flaky required cases block promotion until `evidence` decision (`{"case":ID,"runId":RUN,"sha":FULL_SHA}` on hold item, another agent approving) accepts; refused unless both attempts recorded at that SHA. `release promote` reads only that run's and SHA's applied decisions, and its workflow's `release promote ID` (`GRAPHYARD_URL`, `GRAPHYARD_TOKEN`) only passing UATs.

`e2e/contract.json` lists required customer outcomes: `id`, `title`, optional `criteria`, proving `cases` (shareable). Pre-cut `graphyard release contract` refuses `release cut` when a bound case is missing, invalid, not `uat`-targeted, optional, or proves nothing.

## Flake ledger

A required check or merge-trial file passing its one rerun at the failed SHA (PR `checkReruns` `passed`, main `mainGuardFlakes`, trial `mergeLedger.flakes`) is a flake, read once into `.graphyard/flake-ledger.json` (0600; ≤500 entries, 30 days). Each `unit:`/`integration:` test gets one P1 `Flaky test: NAME` item: at its first flake unless it proves its item, else after 3+ on 2+ SHAs in 7 days; none while open or 7 days after. Own-proof failures are never excused; they or unread tests never rerun checks; its trial file reruns for flakes beside it. Gates ignore the ledger.

## Goals and acceptance

`graphyard goal FILE` records goal (`statement`, `users`, `constraints`, `deployTarget`), listed in `master status`. The `acceptance` role (`run.diagnostician` models) drafts outcomes, one required `uat` case each, and contract bindings in one pull request the approver (never author) judges, redrafted if refused (≤3). `goal land` merges the approved head once CI passes; the [revert approver App](deployment.md#variables) approves it first (GY-1795), so the last-pusher rule strands no approved goal. Under a `control-plane` merger (GY-1535) the draft is one unpushed commit on `graphyard/goal-N-acceptance-R` (`acceptance.pr` null), always sensitive: the merge writer lands only its cases and contract on the approver's exact-head verdict, by one leased deploy-key push; `goal land` records it once first-parent history holds the merge. Conflicting or moved: recommitted, rejudged; stuck a day: `goal closed GOAL-N change -- REASON`. `complete` and later heads refuse changes to protected case or `e2e/contract.json` lacking that item's `goal case-change`, approved by neither requester nor implementer; the loop's approver judges each, delivered goals too, retried next cycle; `master status`: `pendingCaseChanges`. [Planner](how-graphyard-works.md#from-goal-to-work-items) plans items; `goal deliver` needs each done and served in production.

## Release holds

One hold per failed outcome: item tagged `rc-hold/OUTCOME/CANDIDATE` listing failed/flaky cases, failing steps, unmet criteria; later failures attach; clears once every attached case passes on newer candidate UAT serves at exact SHA (`graphyard release holds`). Folding: two-party `fold` decision (`{"outcome":A,"into":B}`), then `release fold A --decision ID`. Process incidents (freezes, attestation delays, runner outages, deployment suites) file follow-ups.

## Candidates, requests, reports

`kind: bundle` pins `scenario`, `scenarioRevision`, `scenarioHash`, `digest`, `runnerImageDigest`, `reportFormat` (`graphyard-playwright-v1`/`junit-xml-v1`; skips, retries, timeouts, miscounts fail; `graphyard runner verify-report junit-xml-v1 inventory.json report.xml` previews). Runners `ack` within 30s, heartbeat every 20s; passes need `matched` target, verified artifacts, settled run; recover: `cancel`, `settle`, `retry`; `graphyard validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stalls.
