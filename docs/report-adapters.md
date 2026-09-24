<!-- page: Build integrations | 5 | what each supported report format proves, observes and refuses. -->
# Report adapters

A report adapter turns an attempt's offline inventory and execution report into a verdict. `graphyard runner adapters` prints each shipped contract: what it proves, what was independently observed, which frameworks its fixtures cover, and how failures classify.

## The format is pinned in the bundle

```json
{ "kind": "bundle", "id": "booking-oracle", "expectedRevision": 0,
  "scenario": "booking", "scenarioRevision": 2, "scenarioHash": "…",
  "digest": "sha256:…", "runnerImageDigest": "sha256:…", "reportFormat": "junit-xml-v1" }
```

`reportFormat` defaults to `graphyard-playwright-v1` and cannot change within a scenario revision. It travels in the dispatch grant; the collector verifies only the pinned format and refuses any other shape.

## Supported formats

| Format | Kind | Covered by fixtures | Files |
| --- | --- | --- | --- |
| `graphyard-playwright-v1` | end-to-end | `@playwright/test` 1.63.x via the [packaged runner image](runner-setup.md) | `inventory.json`, `report.json` |
| `junit-xml-v1` | unit / integration | `node --test --test-reporter=junit` (Node 20–24), `pytest --junitxml` 7–8, `jest-junit` 16, Maven Surefire/Failsafe 3, `go-junit-report` v2 | `inventory.json`, `report.xml` |

**`graphyard-playwright-v1`** proves every offline-enumerated test ran exactly once, without retry, and passed. Failed tests are `behavior: failed`; skips, timeouts, retries, expected failures and overflow never pass.

**`junit-xml-v1`** proves every inventory identity appears once as passed and the suite's counts agree. The inventory is:

```json
{ "format": "graphyard-inventory-v1", "tests": [{ "id": "<sha256 hex>" }], "overflow": false }
```

An identity is `sha256(suitePath ␟ classname ␟ name)` (`␟` is U+001F; `suitePath` joins enclosing `<testsuite name>`s with `/`). Only a minimised projection (identities, statuses, timings, counts) is uploaded. `DOCTYPE`, entities and unknown elements are refused. `<failure>`/`<error>` fail; skips, reruns, duplicates and count mismatches never pass. It does not establish which artifact served traffic; target attribution still decides that.

## Preview a verdict locally

```bash
graphyard runner verify-report junit-xml-v1 inventory.json report.xml
```

This produces no evidence. To add an adapter, extend `src/report-adapters.ts` and `reportFormats` with real-framework fixtures and refusal tests.
