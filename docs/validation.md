<!-- page: Build integrations | 2 | cases, runners. -->
# E2E validation

An `e2e:` proof passes from a pinned candidate, bundle and separate [collector](runner-setup.md). `graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`: `admin` defines; runners (`worker`) poll, ack, heartbeat; builders and collectors (`producer`) attest, publish, never both per build. `admin` defines test cases (**Settings → Test cases**, `graphyard scenario scenario.json`); `e2e:ID` pins the latest immutable revision; only trusted attempts append **Tests** runs.

## E2E case repository

`e2e/cases/ID.json`, code-reviewed: `id` (file name), `title`, optional `description`, `tags`, `target` (`uat`/`any`), `required` (default `false`), ordered `steps`:

- `http`: `method`, `path`, optional `body`, expected `status`; `expect` checks a dotted JSON `path` (`equals`, `exists`, `type`, `includes`); `save` keeps values.
- `browser` (Playwright Chromium): `open` a `path`, `fill` a `label` with `value`, `click`/`expectText` a `text`, optionally by `role`; `exact: false` matches substrings.

Values: `{{token}}`, `{{run}}`, `{{case}}`, saved ones. `graphyard e2e list` validates, refusing malformed cases by file and field. Add: write, run, PR. `graphyard e2e sync` (`admin`) registers scenario revisions; edits make new ones, proofs keep theirs. `graphyard e2e run CASE|--tag T|--target uat|--all --url URL`: `GRAPHYARD_TOKEN` or `--token-file`, never a token argument; `--step-timeout` (30 s); `--retries N` (default none); prints failing steps, reasons; `--report` JSON; non-zero on failure; records base URL, served SHA, duration, outcome, failing step unless `--no-record`. **Tests**: last outcome, SHA, environment, 20-run pass rate and flaky flag, failed steps, required/optional.

**Every release candidate runs the `uat` cases**, in id order, as [`release validate`](delivery.md#release-candidates)'s `e2e` suite (`GRAPHYARD_UAT_URL`, `GRAPHYARD_UAT_TOKEN`; a `--suite` command's detail is what it writes to `GRAPHYARD_SUITE_DETAIL`); `graphyard e2e record REPORT` records every attempt.

## Release verdicts

One retry: **passed**; **failed** (both); **flaky** (retry passed at the same served SHA; `RUN:attempt-1`, `RUN:attempt-2` recorded); **unrun** (stopped by a failed required case, which the report names; listed apart, never counted). Only required failed or unaccepted flaky cases block; optional ones show marked on **Tests**. At an unreported commit, pass-after-failure is failed.

Flaky required cases block promotion until an `evidence` decision (`{"case": ID, "runId": RUN, "sha": FULL_SHA}` on the hold item; another agent approves, never self) accepts; refused unless both attempts are recorded at that SHA. `release promote` reads only that run's and SHA's applied decisions. The workflow promotes only passing UATs: run `release promote ID` with `GRAPHYARD_URL`, `GRAPHYARD_TOKEN`.

`e2e/contract.json` lists required customer outcomes: `id`, `title`, optional `criteria`, proving `cases` (several outcomes allowed). The workflow's pre-cut `graphyard release contract` refuses `release cut`, naming outcome and case, when a bound case is missing, invalid, not `uat`-targeted or optional, or a required case proves nothing.

## Release holds

One hold per failed outcome, never per suite or case: an item listing failed/flaky cases, failing steps, unmet criteria, tagged `rc-hold/OUTCOME/CANDIDATE`. Later failures attach to an open hold; it clears when every attached case passes on a newer candidate UAT serves at its exact SHA (`graphyard release holds`). Folding: two-party `fold` decision (`{"outcome": A, "into": B}`), then `release fold A --decision ID`. Process and infrastructure incidents (freeze breaches, attestation delays, runner outages, deployment or container suites) file an ordinary follow-up instead.

## Candidates, requests, reports

`kind: bundle` pins `scenario`, `scenarioRevision`, `scenarioHash`, `digest`, `runnerImageDigest`, `reportFormat` (`graphyard-playwright-v1`/`junit-xml-v1`; skips, retries, timeouts, miscounts fail; `graphyard runner verify-report junit-xml-v1 inventory.json report.xml` previews). Operators create candidates from build attestations; requests bind observed targets. Runners `ack` within 30 s, heartbeat every 20 s; passes need a `matched` target, verified artifacts, a settled run; recover: `cancel`, `settle`, `retry`; `graphyard validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stalls.
