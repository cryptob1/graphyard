<!-- page: Build integrations | 2 | cases, runners. -->
# E2E validation

An `e2e:` proof passes from pinned candidate, bundle, separate [collector](runner-setup.md). `graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`: `admin` defines test cases (**Settings → Test cases**, `graphyard scenario scenario.json`); runners (`worker`) poll, ack, heartbeat; builders and collectors (`producer`) attest, publish, never both per build; `e2e:ID` pins latest immutable revision; only trusted attempts append **Tests** runs.

## E2E case repository

`e2e/cases/ID.json`, code-reviewed: `id` (file name), `title`, optional `description`, `tags`, `target` (`uat`/`any`), `required` (default `false`), ordered `steps`:

- `http`: `method`, `path`, optional `body`, expected `status`; `expect` checks dotted JSON `path` (`equals`, `exists`, `type`, `includes`); `save` keeps values.
- `browser` (Playwright Chromium): `open` `path`, `fill` `label` with `value`, `click`/`expectText` `text`, optionally by `role`; `exact: false` matches substrings.
- `command`: `run` in the checkout with `TARGET_URL`, exit 0 passes, last 50 lines kept: `{"kind":"command","run":"npx playwright test"}`.
- `agent`: agent-browser pursues `goal` at `path` until `success` holds, ending `VERDICT: PASS|FAIL - reason`, screenshot kept: `{"kind":"agent","goal":"Win tic-tac-toe","success":["Board says You win"],"path":"/games"}`.

Both: `timeoutSeconds` (600). Case `secrets: ["NAME"]` from `~/.config/graphyard/INSTALL/e2e-secrets.TARGET.env` (0600, uncommitted) as variables and `{{secret:NAME}}`, redacted; missing fails naming file, variable. Values: `{{token}}`, `{{run}}`, `{{case}}`, saved. `graphyard e2e list` refuses malformed cases by file, field. `graphyard e2e sync` (`admin`) registers scenario revisions; edits make new ones, proofs keep theirs. `graphyard e2e run CASE|--tag T|--target uat|--all --url URL`: `GRAPHYARD_TOKEN`/`--token-file`, no token argument; `--step-timeout` (30s); `--retries N` (none); prints failing steps, reasons; `--report` JSON; non-zero on failure; records base URL, served SHA, duration, outcome, failing step unless `--no-record`. **Tests** shows last outcome, SHA, environment, 20-run pass rate, flaky flag, failed steps, required/optional.

**Every release candidate runs `uat` cases**, in id order, as [`release validate`](delivery.md#release-candidates)'s `e2e` suite (`GRAPHYARD_UAT_URL`, `GRAPHYARD_UAT_TOKEN`; `--suite` commands write detail to `GRAPHYARD_SUITE_DETAIL`); `graphyard e2e record REPORT` records every attempt. A managed repository's candidate under a `control-plane` merger (GY-1535) runs every required and `uat` case of its own checkout through the same runner in the loop (`src/release-project.ts`), none skipped after a failure: a failing required case fails the candidate, `rc-uat/ID`'s `e2e` names each verdict, and blocking cases feed holds and the candidate revert. A static site names no `GRAPHYARD_UAT_URL`: `GRAPHYARD_UAT_STATIC` names its build output, built first by `GRAPHYARD_UAT_BUILD` (failing the `build` suite on error) and served on loopback as its UAT (`/healthz` answers the candidate SHA).

## Release verdicts

One retry: **passed**; **failed** (both); **flaky** (retry passed at same served SHA; `RUN:attempt-1`, `RUN:attempt-2` recorded); **unrun** (stopped by a failed required case; listed apart, uncounted; a managed repository's candidate runs every case, so it has none). Only failed or unaccepted flaky required cases block; optional ones marked on **Tests**.

Flaky required cases block promotion until `evidence` decision (`{"case":ID,"runId":RUN,"sha":FULL_SHA}` on hold item, another agent approving) accepts; refused unless both attempts recorded at that SHA. `release promote` reads only that run's and SHA's applied decisions. Workflow's `release promote ID` (`GRAPHYARD_URL`, `GRAPHYARD_TOKEN`) promotes only passing UATs.

`e2e/contract.json` lists required customer outcomes: `id`, `title`, optional `criteria`, proving `cases` (shareable). Pre-cut `graphyard release contract` refuses `release cut`, naming outcome and case, when a bound case is missing, invalid, not `uat`-targeted, optional, or proves nothing.

## Flake ledger

A required check failing then passing its one rerun at the same SHA (PR `checkReruns` `passed`, main `mainGuardFlakes`) is a flake: the loop reads that failed job's log once into `.graphyard/flake-ledger.json` (0600; ≤500 entries, 30 days). A test leading with a proof id (`unit:`/`integration:`) flaking 3+ times on 2+ SHAs in 7 days gets one P1 `Flaky test: NAME` item naming its proof, planned on its test file; none more while open or 7 days after closing. Gates never read it: nothing is skipped or quarantined.

## Goals and acceptance

`graphyard goal FILE` records goal (`statement`, `users`, `constraints`, `deployTarget`); `master status` lists open goals. The loop's `acceptance` role (`run.diagnostician` models) drafts outcomes, one required `uat` case each, and contract bindings in one pull request, judged by the approver identity (never author), redrafted if refused (≤3). Merged at approved head once CI passes (`goal land`), else redrafted. Under a `control-plane` merger (GY-1535) the draft is one commit on `graphyard/goal-N-acceptance-R` in the coordinator checkout, unpushed, with no pull request (`acceptance.pr` null); always sensitive, the merge writer lands it only on the approver's verdict on its exact head, touching only its cases and contract, by one leased deploy-key push; `goal land` records it merged once the base's first-parent history holds that merge. Conflicting or moved, it is recommitted from the new base and rejudged; stuck a day, the master decides (`goal closed GOAL-N change -- REASON`). The planner plans only merged goals, so a new project's cases are on its base before its first item is dispatched. `complete` and later heads refuse changes to protected case or `e2e/contract.json` lacking that item's `goal case-change`, approved by neither requester nor implementer. [Planner](how-graphyard-works.md#from-goal-to-work-items) plans items; `goal deliver` needs each done and served in production.

## Release holds

One hold per failed outcome (not suite or case): item tagged `rc-hold/OUTCOME/CANDIDATE` listing failed/flaky cases, failing steps, unmet criteria; later failures attach; clears once every attached case passes on newer candidate UAT serves at exact SHA (`graphyard release holds`). Folding: two-party `fold` decision (`{"outcome":A,"into":B}`), then `release fold A --decision ID`. Process/infrastructure incidents (freeze breaches, attestation delays, runner outages, deployment/container suites) file follow-ups.

## Candidates, requests, reports

`kind: bundle` pins `scenario`, `scenarioRevision`, `scenarioHash`, `digest`, `runnerImageDigest`, `reportFormat` (`graphyard-playwright-v1`/`junit-xml-v1`; skips, retries, timeouts, miscounts fail; `graphyard runner verify-report junit-xml-v1 inventory.json report.xml` previews). Runners `ack` within 30s, heartbeat every 20s; passes need `matched` target, verified artifacts, settled run; recover: `cancel`, `settle`, `retry`; `graphyard validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stalls.
