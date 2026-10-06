<!-- page: Build integrations | 2 | test cases, runners. -->
# E2E validation

An `e2e:` proof passes from a pinned candidate, bundle and separate [collector](runner-setup.md). `graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`. `admin` defines; runners (`worker`) poll, ack and heartbeat; builders and collectors (`producer`) attest and publish, never both for one build.

## Test cases

`admin` defines them (**Settings → Test cases**, `graphyard scenario scenario.json`); `e2e:ID` pins the latest immutable revision; only trusted attempts append **Tests** runs.

## E2E case repository

A case is `e2e/cases/ID.json`, reviewed like code: `id` (the file name), `title`, optional `description`, `tags`, `target` (`uat` or `any`) and ordered `steps`:

- `http`: `method`, `path`, optional `body`, expected `status`, `expect` checks on the JSON answer at a dotted `path` (one of `equals`, `exists`, `type`, `includes`), and `save` to keep values for later steps.
- `browser` (Playwright Chromium): `open` a `path`, `fill` a `label` with a `value`, `click` or `expectText` a `text`, optionally by `role`; `exact: false` matches a substring.

Values may name `{{token}}`, `{{run}}`, `{{case}}` or a saved value. `graphyard e2e list` validates every file, refusing a malformed case by file and field.

To add one: write the file, run it, open a pull request. `graphyard e2e sync` (`admin`) registers each case as a scenario revision; an edited case becomes a new revision while proofs keep theirs. `graphyard e2e run CASE|--tag T|--target uat|--all --url URL` uses `GRAPHYARD_TOKEN` or `--token-file`, never a token argument; each step times out (`--step-timeout`, 30 s) and cases are not retried unless `--retries N`. It prints each failing step and reason, writes a JSON report (`--report`), exits non-zero on any failure, and records each run (base URL, served SHA, duration, outcome, failing step) on its revision unless `--no-record`.

**Tests** shows each case's last outcome, SHA and environment, pass rate and flaky flag over its last 20 runs, and each failed run's step.

**Every release candidate runs the `uat` cases**: the `e2e` suite of [`release validate`](delivery.md#release-candidates) runs them against UAT with `GRAPHYARD_UAT_URL` and `GRAPHYARD_UAT_TOKEN`. A failing case fails UAT, blocks promotion and files a follow-up naming case and step (a `--suite` command's detail is what it writes to `GRAPHYARD_SUITE_DETAIL`); `graphyard e2e record REPORT` then records the runs.

## Candidates, requests, reports

`kind: bundle` pins `scenario`, `scenarioRevision`, `scenarioHash`, `digest`, `runnerImageDigest`, `reportFormat`. Operators create candidates from build attestations.

Requests bind observed targets. Runners `ack` within 30 s and heartbeat every 20 s; a pass needs a `matched` target, verified artifacts and a settled run. Recover with `cancel`, `settle` or `retry`; `graphyard validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stalls.

`reportFormat`: `graphyard-playwright-v1` or `junit-xml-v1`; skips, retries, timeouts and miscounts fail (`graphyard runner verify-report junit-xml-v1 inventory.json report.xml` previews).
