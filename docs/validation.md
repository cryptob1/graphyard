<!-- page: Build integrations | 2 | test cases, runner protocol. -->
# E2E validation

An `e2e:` proof passes only from a pinned candidate and bundle, published by a separate trusted [collector](runner-setup.md).

## Test cases

Define a test case in **Settings → Test cases** or `graphyard scenario scenario.json` (`admin`): `id`, `title`, `purpose`, `setup`, `steps`, `expected`, `environment`, `runner`, `testPath`. Revisions are immutable; `e2e:ID` criteria pin the latest at creation; newer ones need a follow-up item.

Trusted `e2e:ID` results append runs, bound to commit and CI run, to **Tests**; workers' never do.

## Identities

- Human operator (`admin`): defines environments, bundles and identities; selects, requests, cancels and recovers candidates.
- Runner (`worker` + registration): polls `dispatch`, acknowledges and heartbeats.
- Builder and collector (`producer` + registration): attest source → artifacts, then verify and publish; the build's attestor may not collect.

`graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`.

## Configure a candidate

Define the environment, runner registration (local `unix://` Docker socket, attestor key, isolated `executionNetwork`, `testAccountDigest`) and a `kind: bundle` pinning `scenario`, `scenarioRevision`, `scenarioHash`, `digest`, `runnerImageDigest` and `reportFormat`. The builder attests `sourceSha`, `baseSha`, `buildInputsDigest`, `artifacts` and `provenanceUrl`; the operator's candidate names `proof`, `environment`, `bundle`, `buildAttestationId` and `requiredArtifacts`.

## Requests and results

A request names the candidate, runner, collector, `deadline` and `maxAttempts`, binding the observed target; another manifest supersedes it. The runner `ack`s within 30 seconds, then heartbeats every 20; the collector's `collection-authority` call ends its authority.

Only a measured, whole-run `matched` target with verified artifacts and settled execution passes. `cancel`, `settle` (proving the process stopped) and `retry` recover requests; `graphyard validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stuck ones.

## Report formats

The bundle pins `reportFormat`: `graphyard-playwright-v1` (default; every offline-enumerated test ran once and passed) or `junit-xml-v1` (every inventory identity, `sha256(suitePath ␟ classname ␟ name)`, appears once as passed and the counts agree). Skips, retries, timeouts and count mismatches fail. `graphyard runner verify-report junit-xml-v1 inventory.json report.xml` previews a verdict without evidence.
