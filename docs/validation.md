<!-- page: Build integrations | 2 | cases, runners. -->
# E2E validation

An `e2e:` proof passes from a pinned candidate, bundle and separate [collector](runner-setup.md). `graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`: `admin` defines, runners (`worker`) poll, ack and heartbeat, builders and collectors (`producer`) attest and publish, never both for one build.

`admin` defines test cases (**Settings → Test cases**, `graphyard scenario scenario.json`); `e2e:ID` pins the latest immutable revision, and only trusted attempts append **Tests** runs.

## E2E case repository

A case is `e2e/cases/ID.json`, reviewed like code: `id`, `title`, `tags`, `target` (`uat` or `any`), `required` (default `false`) and ordered `http` (`method`, `path`, `body`, expected `status`, `expect`, `save`) or `browser` (Playwright: `open`, `fill`, `click`, `expectText`) steps; values may use `{{token}}`, `{{run}}`, `{{case}}` or a saved value. `graphyard e2e list` validates every file; `graphyard e2e sync` (`admin`) registers each as a scenario revision. `graphyard e2e run CASE|--tag T|--target uat|--all --url URL` (`GRAPHYARD_TOKEN` or `--token-file`; `--step-timeout`, `--retries N`, `--report`, `--no-record`) exits non-zero on failure and records each run; **Tests** shows outcomes and flaky flags.

**Every release candidate runs the `uat` cases**: the `e2e` suite of [`release validate`](delivery.md#release-candidates) runs them against UAT with `GRAPHYARD_UAT_URL` and `GRAPHYARD_UAT_TOKEN` (a `--suite` command writes its detail to `GRAPHYARD_SUITE_DETAIL`); `graphyard e2e record REPORT` records every attempt.

## Release verdicts

Each case ends **passed**, **failed** (both attempts), **flaky** (the retry passed at the same served SHA) or **unrun** (a required case stopped the run); only required cases block. A flaky required case blocks promotion until an `evidence` decision (`{"case": ID, "runId": RUN, "sha": FULL_SHA}` on the hold item, approved by a second agent) accepts it for that run and SHA; `release promote ID` then promotes under `GRAPHYARD_URL` and `GRAPHYARD_TOKEN`.

`e2e/contract.json` lists each required customer outcome and its proving `cases`; `graphyard release contract`, run before `release cut`, refuses the cut when a bound case is missing, invalid, not `uat`-targeted or not required, or a required case proves no outcome.

## Release holds

A failing candidate files one hold per failed outcome (an item tagged `rc-hold/OUTCOME/CANDIDATE`); later failures attach to it, and it clears when every attached case passes on a newer candidate at its exact SHA. `graphyard release holds` lists them; `release fold A --decision ID` folds one into another after a two-party `fold` decision. Process and infrastructure incidents file an ordinary follow-up item, never a hold.

## Candidates, requests, reports

`kind: bundle` pins the scenario revision, bundle and runner digests and `reportFormat` (`graphyard-playwright-v1` or `junit-xml-v1`; `graphyard runner verify-report junit-xml-v1 inventory.json report.xml` previews). Runners `ack` within 30 s and heartbeat every 20 s; a pass needs a `matched` target, verified artifacts and a settled run; recover with `cancel`, `settle` or `retry`, and `graphyard validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stalls.
