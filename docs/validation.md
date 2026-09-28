<!-- page: Build integrations | 2 | test cases, runners. -->
# E2E validation

An `e2e:` proof passes only from a pinned candidate, bundle and separate [collector](runner-setup.md).

## Test cases

Define a test case (`admin`) in **Settings → Test cases** or `graphyard scenario scenario.json`: `id`, `title`, `purpose`, `setup`, `steps`, `expected`, `environment`, `runner`, `testPath`. Revisions are immutable; a criterion naming `e2e:ID` pins the latest at creation; a newer one needs a follow-up item.

Trusted `e2e:ID` results append runs to **Tests**, one per attempt, bound to commit and run; workers cannot.

## Identities

- Operator (`admin`): defines environments and bundles, registers identities, selects, requests, cancels, recovers candidates.
- Runner (`worker` + registration): polls `dispatch`, acknowledges, heartbeats.
- Builder and collector (`producer` + registration): attest source → artifacts; verify, publish; a collector that attested the build is refused.

`graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`.

## Configure a candidate

Define the environment, runner registration (local `unix://` Docker socket, attestor key, isolated `executionNetwork`, `testAccountDigest`) and a `kind: bundle` pinning `scenario`, `scenarioRevision`, `scenarioHash`, `digest`, `runnerImageDigest`, `reportFormat`. The builder attests `sourceSha`, `baseSha`, `buildInputsDigest`, `artifacts`, `provenanceUrl`; the operator creates it with `proof`, `environment`, `bundle`, `buildAttestationId`, `requiredArtifacts`.

## Requests and results

A request names candidate, runner, collector, `deadline`, `maxAttempts`, binding the observed target; another manifest supersedes it. The runner `ack`s within 30 seconds, heartbeats every 20; `collection-authority` ends the runner's authority.

Only a measured whole-run `matched` target with verified artifacts, settled execution passes. `cancel`, `settle` (with stop evidence), `retry` recover requests; `graphyard validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stuck ones.

## Report formats

The bundle pins `reportFormat`: `graphyard-playwright-v1` (default; every offline-enumerated test ran once and passed) or `junit-xml-v1` (every inventory identity, `sha256(suitePath ␟ classname ␟ name)`, appears once as passed, counts agree). Skips, retries, timeouts, miscounts fail. `graphyard runner verify-report junit-xml-v1 inventory.json report.xml` previews a verdict.
