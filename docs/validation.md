<!-- page: Build integrations | 2 | cases, runners. -->
# E2E validation

An `e2e:` proof passes from a pinned candidate, bundle and separate [collector](runner-setup.md). `graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`: `admin` defines test cases (**Settings → Test cases**, `graphyard scenario scenario.json`); runners (`worker`) poll, ack, heartbeat; builders and collectors (`producer`) attest, publish, never both per build; `e2e:ID` pins latest immutable revision; only trusted attempts append **Tests** runs.

## E2E case repository

`e2e/cases/ID.json`, code-reviewed: `id` (file name), `title`, optional `description`, `tags`, `target` (`uat`/`any`), `required` (default `false`), ordered `steps`:

- `http`: `method`, `path`, optional `body`, expected `status`; `expect` checks dotted JSON `path` (`equals`, `exists`, `type`, `includes`); `save` keeps values.
- `browser` (Playwright Chromium): `open` a `path`, `fill` a `label` with `value`, `click`/`expectText` a `text`, optionally by `role`; `exact: false` matches substrings.

Values: `{{token}}`, `{{run}}`, `{{case}}`, saved. `graphyard e2e list` refuses malformed cases by file, field. `graphyard e2e sync` (`admin`) registers scenario revisions; edits make new ones, proofs keep theirs. `graphyard e2e run CASE|--tag T|--target uat|--all --url URL`: `GRAPHYARD_TOKEN`/`--token-file`, no token argument; `--step-timeout` (30 s); `--retries N` (none); prints failing steps, reasons; `--report` JSON; non-zero on failure; records base URL, served SHA, duration, outcome, failing step unless `--no-record`. **Tests** shows last outcome, SHA, environment, 20-run pass rate, flaky flag, failed steps, required/optional.

**Every release candidate runs `uat` cases**, in id order, as [`release validate`](delivery.md#release-candidates)'s `e2e` suite (`GRAPHYARD_UAT_URL`, `GRAPHYARD_UAT_TOKEN`; a `--suite` command's detail is what it writes to `GRAPHYARD_SUITE_DETAIL`); `graphyard e2e record REPORT` records every attempt.

## Release verdicts

One retry: **passed**; **failed** (both); **flaky** (retry passed at the same served SHA; `RUN:attempt-1`, `RUN:attempt-2` recorded); **unrun** (stopped by a failed required case, which report names; listed apart, never counted). Only failed or unaccepted flaky required cases block; optional ones are marked on **Tests**. At an unreported commit, pass-after-failure is failed.

Flaky required cases block promotion until an `evidence` decision (`{"case":ID,"runId":RUN,"sha":FULL_SHA}` on the hold item, another agent approving) accepts; refused unless both attempts were recorded at that SHA. `release promote` reads only that run's and SHA's applied decisions. The workflow's `release promote ID` (`GRAPHYARD_URL`, `GRAPHYARD_TOKEN`) promotes only passing UATs.

`e2e/contract.json` lists required customer outcomes: `id`, `title`, optional `criteria`, proving `cases` (shareable). Pre-cut `graphyard release contract` refuses `release cut`, naming outcome, case, when a bound case is missing, invalid, not `uat`-targeted or optional, or a required case proves nothing.

## Goals and acceptance

`graphyard goal FILE` records a goal (`statement`, `users`, `constraints`, `deployTarget`); `master status` lists open goals. With both master identities, the loop's `acceptance` role (`run.diagnostician` models) drafts outcomes, one required `uat` case each, contract bindings in one pull request, judged by the approver identity (never its author), redrafted when refused (≤3 drafts). Graphyard merges it at the approved head once CI passes (`goal land`), else redrafts. Then `complete` and later heads refuse changes to a protected case or `e2e/contract.json` lacking that item's `goal case-change`, approved by neither requester nor implementer. The [planner](how-graphyard-works.md#from-goal-to-work-items) then plans the items; `goal deliver` needs each done and served in production.

## Release holds

One hold per failed outcome (not suite or case): an item tagged `rc-hold/OUTCOME/CANDIDATE` listing failed/flaky cases, failing steps, unmet criteria; later failures attach to it; it clears once every attached case passes on a newer candidate UAT serves at its exact SHA (`graphyard release holds`). Folding: two-party `fold` decision (`{"outcome":A,"into":B}`), then `release fold A --decision ID`. Process/infrastructure incidents (freeze breaches, attestation delays, runner outages, deployment/container suites) file follow-ups.

## Candidates, requests, reports

`kind: bundle` pins `scenario`, `scenarioRevision`, `scenarioHash`, `digest`, `runnerImageDigest`, `reportFormat` (`graphyard-playwright-v1`/`junit-xml-v1`; skips, retries, timeouts, miscounts fail; `graphyard runner verify-report junit-xml-v1 inventory.json report.xml` previews). Operators create candidates from build attestations; requests bind observed targets. Runners `ack` within 30 s, heartbeat every 20 s; passes need `matched` target, verified artifacts, settled run; recover: `cancel`, `settle`, `retry`; `graphyard validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stalls.
