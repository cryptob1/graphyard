<!-- page: Build integrations | 2 | test cases, runners. -->
# E2E validation

An `e2e:` proof passes only from a pinned candidate, bundle and separate [collector](runner-setup.md). `graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`. Operator (`admin`): definitions, identities, candidates. Runner (`worker` + registration): polls `dispatch`, acknowledges, heartbeats. Builder/collector (`producer` + registration): attest source → artifacts; verify, publish (refused if it attested the build).

## Test cases

`admin` defines them (**Settings → Test cases**, `graphyard scenario scenario.json`). Immutable revisions; an `e2e:ID` criterion pins the latest at creation (newer: follow-up). Each trusted attempt appends a commit- and run-bound **Tests** run; workers cannot.

## Candidates, requests, reports

Define environment, runner registration, `kind: bundle` pinning `scenario`, `scenarioRevision`, `scenarioHash`, `digest`, `runnerImageDigest`, `reportFormat`. Builders attest source and artifacts; operators create candidates from a build attestation.

Requests (candidate, runner, collector, `deadline`, `maxAttempts`) bind the observed target; a new manifest supersedes. Runners `ack` within 30 s, heartbeat every 20 s until `collection-authority`. Pass: whole-run `matched` target, verified artifacts, settled execution. Recover: `cancel`, `settle` (stop evidence), `retry`; `graphyard validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stalls.

`reportFormat`: `graphyard-playwright-v1` (default; each offline-enumerated test passed once) or `junit-xml-v1` (each inventory identity passed once). Skips, retries, timeouts, miscounts fail; preview: `graphyard runner verify-report junit-xml-v1 inventory.json report.xml`.
