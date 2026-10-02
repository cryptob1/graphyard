<!-- page: Build integrations | 2 | test cases, runners. -->
# E2E validation

An `e2e:` proof passes only from a pinned candidate, bundle and separate [collector](runner-setup.md). `graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`. Roles: operator `admin`; runner `worker` + registration; builder and collector `producer` + registration, collector ≠ build attester.

## Test cases

`admin` defines test cases (**Settings → Test cases**, `graphyard scenario scenario.json`; [fields](../examples/scenario.json)). Immutable revisions; an `e2e:ID` criterion pins the latest at creation (newer: follow-up item). Each trusted attempt appends a commit- and run-bound **Tests** run.

## Candidates

Define environment, runner registration (local `unix://` Docker socket, attestor key, isolated `executionNetwork`, `testAccountDigest`) and `kind: bundle` pinning `scenario`, `scenarioRevision`, `scenarioHash`, `digest`, `runnerImageDigest`, `reportFormat`. Builders attest `sourceSha`, `baseSha`, `buildInputsDigest`, `artifacts`, `provenanceUrl`; operators create candidates: `proof`, `environment`, `bundle`, `buildAttestationId`, `requiredArtifacts`.

## Requests

Requests (candidate, runner, collector, `deadline`, `maxAttempts`) bind the observed target; another manifest supersedes. Runners `ack` within 30 s and heartbeat every 20 s until `collection-authority`; a pass needs a whole-run `matched` target, verified artifacts and settled execution. Recover: `cancel`, `settle` (stop evidence), `retry`; `graphyard validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stalls.

Formats: `graphyard-playwright-v1` (default; each offline-enumerated test passed once) or `junit-xml-v1` (each inventory identity `sha256(suitePath ␟ classname ␟ name)` passed once; counts agree). Skips, retries, timeouts, miscounts fail; preview: `graphyard runner verify-report junit-xml-v1 inventory.json report.xml`.
