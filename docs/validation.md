<!-- page: Build integrations | 2 | test cases, runners. -->
# E2E validation

An `e2e:` proof passes only from a pinned candidate, bundle and separate [collector](runner-setup.md). `graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`. Roles: operator `admin`; runner `worker` + registration; builder and collector `producer` + registration, collector ≠ build attester.

## Test cases

`admin` defines test cases (**Settings → Test cases**, `graphyard scenario scenario.json`; [fields](../examples/scenario.json)). Revisions are immutable; an `e2e:ID` criterion pins the latest at creation.

## Candidates

Define the environment, a runner registration (local Docker socket, attestor key, isolated `executionNetwork`) and a `kind: bundle` pinning the scenario revision and hash, `digest`, `runnerImageDigest` and `reportFormat`. Builders attest the build; operators create candidates from it.

## Requests

Requests bind the observed target. Runners `ack` within 30 s and heartbeat every 20 s; a pass needs a whole-run `matched` target, verified artifacts and settled execution. Recover: `cancel`, `settle` (stop evidence), `retry`; `graphyard validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stalls.

Formats: `graphyard-playwright-v1` (default; each offline-enumerated test passed once) or `junit-xml-v1` (each inventory identity passed once). Skips, retries, timeouts, miscounts fail; preview with `graphyard runner verify-report junit-xml-v1 inventory.json report.xml`.
