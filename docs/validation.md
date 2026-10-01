<!-- page: Build integrations | 2 | test cases, runners. -->
# E2E validation

An `e2e:` proof passes only from a pinned candidate, bundle and separate [collector](runner-setup.md).

## Test cases

`admin` defines one in **Settings → Test cases** or `graphyard scenario scenario.json`: `id`, `title`, `purpose`, `setup`, `steps`, `expected`, `environment`, `runner`, `testPath`. Revisions are immutable; a criterion naming `e2e:ID` pins the latest at creation (newer needs a follow-up item). Trusted `e2e:ID` results, never workers, append runs to **Tests**, one per attempt, bound to commit and run.

## Identities

- Operator (`admin`): defines environments and bundles, registers identities, selects, requests, cancels, recovers candidates.
- Runner (`worker` + registration): polls `dispatch`, acknowledges, heartbeats.
- Builder and collector (`producer` + registration): attest source → artifacts; verify, publish. A collector that attested the build is refused.

`graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`.

## Configure a candidate

Define the environment, runner registration (local `unix://` Docker socket, attestor key, isolated `executionNetwork`, `testAccountDigest`) and a `kind: bundle` pinning `scenario`, `scenarioRevision`, `scenarioHash`, `digest`, `runnerImageDigest`, `reportFormat`. The builder attests `sourceSha`, `baseSha`, `buildInputsDigest`, `artifacts`, `provenanceUrl`; the operator creates the candidate with `proof`, `environment`, `bundle`, `buildAttestationId`, `requiredArtifacts`.

## Requests and results

A request names candidate, runner, collector, `deadline`, `maxAttempts`, binding the observed target; another manifest supersedes it. The runner `ack`s within 30 seconds and heartbeats every 20; `collection-authority` ends its authority. Passing needs a measured whole-run `matched` target, verified artifacts and settled execution. `cancel`, `settle` (with stop evidence) and `retry` recover requests; `graphyard validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stuck ones.

`reportFormat` is `graphyard-playwright-v1` (default: every offline-enumerated test ran once and passed) or `junit-xml-v1` (every inventory identity, `sha256(suitePath␟classname␟name)`, appears once as passed; counts agree). Skips, retries, timeouts and miscounts fail; `graphyard runner verify-report junit-xml-v1 inventory.json report.xml` previews a verdict.
