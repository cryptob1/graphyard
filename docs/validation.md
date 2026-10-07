<!-- page: Build integrations | 2 | test cases, runners. -->
# E2E validation

An `e2e:` proof passes from a pinned candidate, bundle and separate [collector](runner-setup.md). `graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`. `admin` defines; runners (`worker`) poll, ack and heartbeat; builders and collectors (`producer`) attest and publish, never both for one build.

## Test cases

`admin` defines them (**Settings → Test cases**, `graphyard scenario scenario.json`); `e2e:ID` pins the latest immutable revision; only trusted attempts append **Tests** runs.

## E2E case repository

A case is `e2e/cases/ID.json`, reviewed like code: `id` (the file name), `title`, optional `description`, `tags`, `target` (`uat` or `any`), `required` (default `false`) and ordered `steps`:

- `http`: `method`, `path`, optional `body`, expected `status`, `expect` checks on the JSON answer at a dotted `path` (one of `equals`, `exists`, `type`, `includes`), and `save` to keep values for later steps.
- `browser` (Playwright Chromium): `open` a `path`, `fill` a `label` with a `value`, `click` or `expectText` a `text`, optionally by `role`; `exact: false` matches a substring.

Values may name `{{token}}`, `{{run}}`, `{{case}}` or a saved value. `graphyard e2e list` validates every file, refusing a malformed case by file and field.

To add one: write the file, run it, open a pull request. `graphyard e2e sync` (`admin`) registers each case as a scenario revision; an edited case becomes a new revision while proofs keep theirs. `graphyard e2e run CASE|--tag T|--target uat|--all --url URL` uses `GRAPHYARD_TOKEN` or `--token-file`, never a token argument; each step times out (`--step-timeout`, 30 s) and cases are not retried unless `--retries N`. It prints each failing step and reason, writes a JSON report (`--report`), exits non-zero on any failure, and records each run (base URL, served SHA, duration, outcome, failing step) on its revision unless `--no-record`.

**Tests** shows each case's last outcome, SHA and environment, pass rate and flaky flag over its last 20 runs, each failed run's step, and whether the case is required or optional.

**Every release candidate runs the `uat` cases**: the `e2e` suite of [`release validate`](delivery.md#release-candidates) runs them in id order against UAT with `GRAPHYARD_UAT_URL` and `GRAPHYARD_UAT_TOKEN` (a `--suite` command's detail is what it writes to `GRAPHYARD_SUITE_DETAIL`); `graphyard e2e record REPORT` then records every attempt.

## Release verdicts

Each case in a release run ends in one state:

- **passed**;
- **failed**: both attempts failed (a release run retries a case once);
- **flaky**: the first attempt failed and the retry passed at the same served SHA; both attempts are kept and recorded (`RUN:attempt-1`, `RUN:attempt-2`);
- **unrun**: a required case failed and stopped the run, so this case never ran; the report names the stopping case.

Only required cases block: a failed one, or a flaky one no evidence decision accepts. Unrun cases are listed apart, never counted as failures or passes. Optional cases run, are recorded and show on **Tests** marked optional, but never fail `release validate`. A run at an unreported commit binds no flaky result: a pass after a failure there is failed.

A flaky required case blocks promotion until an `evidence` decision accepts it: one agent requests it on the case's release hold item with `{"case": ID, "runId": RUN, "sha": FULL_SHA}`, a different agent approves it (self-approval is refused), and the server refuses it unless both attempts are recorded at that SHA. `release promote` reads applied evidence decisions only for that run and SHA; an acceptance never carries to another SHA. The workflow promotes only a passing UAT, so a candidate held only by accepted flaky cases is promoted by running `release promote ID` with `GRAPHYARD_URL` and `GRAPHYARD_TOKEN` set.

## Release contract

`e2e/contract.json` lists each required customer outcome: `id`, `title`, optional `criteria` (how a customer would state it) and the `cases` that prove it. A case may prove several outcomes. `graphyard release contract`, the pre-cut check the release-candidate workflow runs before `release cut`, refuses the cut, naming the outcome and case, when a bound case is missing, invalid, not targeted at `uat` or not required, or when a required case is bound to no outcome.

## Goals and acceptance

`graphyard goal FILE` records a goal (`statement`, `users`, `constraints`, `deployTarget`). The loop's `acceptance` role drafts plain-language outcomes, one required `uat` case each, plus contract bindings, as one pull request; the approver identity, never the author, judges it (`goal approve|refuse`). Refused drafts are redrafted, at most three times. Graphyard publishes its merge checks on the approved head, merging once CI passes (`goal land`); closed, moved or conflicting, it is redrafted; unmerged a day after approval, the master decides. Once merged, `complete` refuses a candidate changing a protected case or `e2e/contract.json` unless that existing item's `goal case-change` was approved by neither its requester nor any implementer. `master status` lists open goals.

## Release holds

A failing candidate files one release hold per failed outcome, never one per suite or case: a work item with the failed or flaky cases, their failing steps and the outcome's unmet criteria, and a ledger tag `rc-hold/OUTCOME/CANDIDATE`. A later failure of an outcome whose hold is open is attached to that hold instead of filed again. A hold clears only when every case attached to it passes on a newer candidate UAT serves at its exact SHA. `graphyard release holds` lists them.

Folding one outcome's hold into another's needs a `fold` decision (`{"outcome": A, "into": B}`) requested by one agent and approved by another; `release fold A --decision ID` then records it.

Process and infrastructure incidents (freeze breaches, attestation delays, runner outages, a failing deployment or container suite) are not customer risks: they file the candidate's ordinary follow-up item, never a hold.

## Candidates, requests, reports

`kind: bundle` pins `scenario`, `scenarioRevision`, `scenarioHash`, `digest`, `runnerImageDigest`, `reportFormat`. Operators create candidates from build attestations.

Requests bind observed targets. Runners `ack` within 30 s and heartbeat every 20 s; a pass needs a `matched` target, verified artifacts and a settled run. Recover with `cancel`, `settle` or `retry`; `graphyard validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stalls.

`reportFormat`: `graphyard-playwright-v1` or `junit-xml-v1`; skips, retries, timeouts and miscounts fail (`graphyard runner verify-report junit-xml-v1 inventory.json report.xml` previews).
