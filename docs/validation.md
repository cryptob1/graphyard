<!-- page: Build integrations | 2 | cases, runners. -->
# E2E validation

An `e2e:` proof passes from pinned candidate, bundle, separate [collector](runner-setup.md). `graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`: `admin` defines test cases (`graphyard scenario scenario.json`); runners (`worker`) poll, ack, heartbeat; builders and collectors (`producer`) attest, publish, never both; `e2e:ID` pins the latest revision; trusted attempts alone append **Tests** runs.

## E2E case repository

`e2e/cases/ID.json`, code-reviewed: `id` (file name), `title`, optional `description`, `tags`, `target` (`uat`/`any`), `required` (default `false`), `steps`:

- `http`: `method`, `path`, optional `body`, expected `status`; `expect` checks dotted JSON `path` (`equals`, `exists`, `type`, `includes`); `save` keeps values.
- `browser` (Playwright Chromium): `open` `path`, `fill` `label` with `value`, `click`/`expectText` `text`, optionally by `role`; `exact: false` matches substrings.
- `command`: `run` in the checkout with `TARGET_URL`, exit 0 passes, last 50 lines kept: `{"kind":"command","run":"npx playwright test"}`.
- `agent`: agent-browser pursues `goal` at `path` until `success` holds, ending `VERDICT: PASS|FAIL - reason`, screenshot kept: `{"kind":"agent","goal":"Win tic-tac-toe","success":["Board says You win"],"path":"/games"}`.

Both: `timeoutSeconds` (600). Case `secrets: ["NAME"]` from `~/.config/graphyard/INSTALL/e2e-secrets.TARGET.env` (0600, uncommitted) as variables and `{{secret:NAME}}`, redacted; missing fails naming file, variable. Values: `{{token}}`, `{{run}}`, `{{case}}`, saved. `graphyard e2e list` refuses malformed cases by file, field. `graphyard e2e sync` (`admin`, `e2e:record`) registers scenario revisions; edits make new ones, proofs keep theirs. `graphyard e2e run CASE|--tag T|--target uat|--all --url URL`: `GRAPHYARD_TOKEN`/`--token-file`, no token argument; `--step-timeout` (30s); `--retries N`; prints failing steps, reasons; `--report` JSON; records base URL, served SHA, duration, outcome, failing step unless `--no-record`.

**Every release candidate runs `uat` cases**, in id order, as [`release validate`](delivery.md#release-candidates)'s `e2e` suite (`GRAPHYARD_UAT_URL`, `GRAPHYARD_UAT_TOKEN`; `--suite` commands write detail to `GRAPHYARD_SUITE_DETAIL`); `graphyard e2e record REPORT` records every attempt ([`e2e:record` agent](delivery.md#release-filing-credential)). A managed repository's candidate (GY-1535) runs every required and `uat` case in the loop's runner, none skipped after failures; blocking cases feed holds and the revert. A static site names no `GRAPHYARD_UAT_URL`: `GRAPHYARD_UAT_STATIC` names its build output, built by `GRAPHYARD_UAT_BUILD` (errors fail `build`), served on loopback as UAT (`/healthz` answers the candidate SHA).

## Release verdicts

One retry: **passed**; **failed** (both); **flaky** (retry passed at same SHA; `RUN:attempt-1`, `RUN:attempt-2`); **unrun** (stopped by a failed required case; listed apart; never in a managed repository); **pending** (required case whose outcome no done item serves, `rc/ID` `pendingOutcomes`, read in `uat`: never blocks unless a delivered outcome shares it; an unreadable plane warns). Only failed or unaccepted flaky required cases block.

Flaky required cases block promotion until `evidence` decision (`{"case":ID,"runId":RUN,"sha":FULL_SHA}` on hold item, another agent approving) accepts; refused unless both attempts recorded at that SHA. `release promote` reads only that run's and SHA's applied decisions; its `release promote ID` workflow (`GRAPHYARD_URL`, `GRAPHYARD_TOKEN`) promotes only passing UATs.

## Imported run results

An external test system hands a run in through one documented format, `graphyard-external-run-v1` (parsed by `src/runner-report.ts` and `src/e2e/runner.ts`'s `importedRunVerdict`; `tests/external-results.test.ts` holds them): the `producer`, the candidate head `sha` or deployed `digest` it tested, an optional `runId` (else derived), and per case `id`, `verdict`, `attempts`, `durationMs`, `evidence` links:

```json
{"format":"graphyard-external-run-v1","producer":"huck-engineer","sha":"<40-hex-head>","runId":"he-run-7",
 "cases":[{"id":"checkout-guest","verdict":"passed","attempts":1,"durationMs":4310},
  {"id":"checkout-card","verdict":"blocked","attempts":0,"durationMs":0,"required":true,"reason":"payment sandbox unreachable"}]}
```

`verdict` is **passed**, **failed** (ran and failed), **flaky** (failed then passed), **blocked** (could not run — its missing precondition or environment, named in `reason`) or **unrun** (never reached); blocked is its own verdict, never dropped or read as failed. The import keeps every verdict as given; it refuses unknown fields or verdicts, a blocked case without its reason, a run naming neither head nor digest. A `required` failed, blocked or unrun case blocks exactly as the runner's own result would; flaky follows the flaky rule (an `evidence` decision bound to case, run id and head accepts it); optional ones never block.

`e2e/contract.json` lists required customer outcomes: `id`, `title`, optional `criteria`, proving `cases`. Pre-cut `graphyard release contract` refuses `release cut` when a bound case is missing, invalid, not `uat`-targeted, optional, or proves nothing.

## Flake ledger

A required check or merge-trial file passing its one rerun at the failed SHA (PR `checkReruns` `passed`, main `mainGuardFlakes`, trial `mergeLedger.flakes`) is a flake, read once into `.graphyard/flake-ledger.json` (0600; ≤500 entries, 30 days). Each `unit:`/`integration:` test gets one P1 `Flaky test: NAME` item: at its first flake unless it proves its item, else after 3+ on 2+ SHAs in 7 days; none while open or 7 days after. Gates ignore the ledger.

## Goals and acceptance

`graphyard goal FILE` records goal (`statement`, `users`, `constraints`, `deployTarget`), listed in `master status`. The `acceptance` role drafts outcomes, one required `uat` case each, and contract bindings in one pull request the approver (never author) judges; refused, redrafted (≤3). The [revert approver App](deployment.md#variables) approves `goal land` first (GY-1795). Under a `control-plane` merger (GY-1535) the draft is one unpushed commit on `graphyard/goal-N-acceptance-R` (`acceptance.pr` null), sensitive: the merge writer lands only its cases and contract on the approver's exact-head verdict. Stuck a day: `goal closed GOAL-N change -- REASON`. `complete` and later heads refuse case or `e2e/contract.json` changes lacking that item's `goal case-change`, approved by neither requester nor implementer; the approver judges each, retried next cycle. [Planner](how-graphyard-works.md#from-goal-to-work-items) plans items; `goal deliver` needs each done and served in production.

## Release holds

One hold per failed outcome: item `rc-hold/OUTCOME/CANDIDATE` listing failed/flaky cases, failing steps, unmet criteria; later failures attach; clears once every attached case passes on a newer UAT serve at exact SHA (`graphyard release holds`). Folding: two-party `fold` decision (`{"outcome":A,"into":B}`), then `release fold A --decision ID`.

## Candidates, requests, reports

`kind: bundle` pins `scenario`, `scenarioRevision`, `scenarioHash`, `digest`, `runnerImageDigest`, `reportFormat` (`graphyard-playwright-v1`/`junit-xml-v1`; skips, retries, timeouts, miscounts fail; `graphyard runner verify-report junit-xml-v1 inventory.json report.xml` previews). Runners `ack` within 30s, heartbeat every 20s; passes need `matched` target, verified artifacts, settled run; recover: `cancel`, `settle`, `retry`; `graphyard validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stalls.
