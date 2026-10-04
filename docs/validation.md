<!-- page: Build integrations | 2 | test cases, runners. -->
# E2E validation

An `e2e:` proof passes from a pinned candidate, bundle and separate [collector](runner-setup.md). `graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json` wraps `POST /api/validation/ACTION`. `admin` defines; runners (`worker`) poll, ack and heartbeat; builders and collectors (`producer`) attest and publish, never both for one build.

## Test cases

`admin` defines them (**Settings → Test cases**, `graphyard scenario scenario.json`); `e2e:ID` pins the latest immutable revision; only trusted attempts append **Tests** runs.

## Candidates, requests, reports

`kind: bundle` pins `scenario`, `scenarioRevision`, `scenarioHash`, `digest`, `runnerImageDigest`, `reportFormat`. Operators create candidates from build attestations.

Requests bind observed targets; new manifests supersede. Runners `ack` within 30 s, heartbeat every 20 s until `collection-authority`. Pass: `matched` target, verified artifacts, settled run. Recover: `cancel`, `settle` (stop evidence), `retry`; `graphyard validation capacity` [diagnoses](recovery.md#runner-capacity-and-request-diagnostics) stalls.

`reportFormat`: `graphyard-playwright-v1` (default) or `junit-xml-v1`; each test passes once, and skips, retries, timeouts, miscounts fail; preview: `graphyard runner verify-report junit-xml-v1 inventory.json report.xml`.
