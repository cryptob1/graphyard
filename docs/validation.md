<!-- page: Build integrations | 2 | E2E test cases and the runner protocol. -->
# Validation: E2E test cases and the runner protocol

An `e2e:` proof passes only from a pinned candidate and bundle, published by a separately trusted collector ([runner setup](runner-setup.md)).

## Test cases

Define a test case in **Settings → Test cases** or with `graphyard scenario scenario.json` (`admin`): `id`, `title`, `purpose`, `setup`, `steps`, `expected`, `environment`, `runner`, `testPath`. Revisions are immutable; a criterion naming `e2e:ID` pins the latest at creation; adopting a newer one needs a follow-up item.

## Identities

- Human operator (`admin`): defines environments and bundles, registers identities, selects candidates, requests, cancels and recovers.
- Runner (`worker` + runner registration): polls `dispatch`, acknowledges and heartbeats its attempt.
- Builder and collector (`producer` + registration): attest source → artifacts, then verify and publish. A collector that attested the build is refused.

`graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`.

## Configure a candidate

Define the environment, the runner registration (a local `unix://` Docker socket, the attestor's key, an isolated `executionNetwork`, `testAccountDigest`), and a `kind: bundle` pinning `scenario`, `scenarioRevision`, `scenarioHash`, `digest`, `runnerImageDigest` and `reportFormat`. The builder attests `sourceSha`, `baseSha`, `buildInputsDigest`, `artifacts` and `provenanceUrl`; the operator then creates the candidate with `proof`, `environment`, `bundle`, `buildAttestationId` and `requiredArtifacts`.

## Requests and results

A request names the candidate, runner, collector, `deadline` and `maxAttempts`, and binds the observed target; a target running another manifest supersedes it. The runner must `ack` before executing (30-second window) and heartbeat every 20 seconds; the collector's `collection-authority` call ends the runner's authority.

Only a measured, whole-run `matched` target with verified artifacts and settled execution passes. `cancel`, `settle` (with evidence the process stopped) and `retry` recover a request; `graphyard validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stuck ones.

## Report formats

`reportFormat` is pinned in the bundle: `graphyard-playwright-v1` (default; every offline-enumerated test ran exactly once and passed) or `junit-xml-v1` (every inventory identity, `sha256(suitePath ␟ classname ␟ name)`, appears once as passed and the counts agree). Skips, retries, timeouts and count mismatches never pass. `graphyard runner verify-report junit-xml-v1 inventory.json report.xml` previews a verdict without producing evidence;
