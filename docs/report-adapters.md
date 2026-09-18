# Report adapters

A report adapter is how the trusted collector turns the two files an attempt writes — an offline inventory and an execution report — into a verdict. Each adapter is a published contract: it says what an accepted verification proves, which of those facts were independently observed rather than reported, which producers and versions its fixtures cover, and how every failure condition is classified. Nothing in a contract yields a pass.

Print the contracts the running CLI ships:

```bash
graphyard runner adapters
```

## The format is authority, not a property of the bytes

The report format is pinned in the operator-approved **bundle definition**, beside the runner image digest:

```json
{ "kind": "bundle", "id": "booking-oracle", "expectedRevision": 0,
  "scenario": "booking", "scenarioRevision": 2, "scenarioHash": "…",
  "digest": "sha256:…", "runnerImageDigest": "sha256:…", "reportFormat": "junit-xml-v1" }
```

`reportFormat` defaults to `graphyard-playwright-v1` and, like the digests, cannot change for a scenario revision once a bundle is approved; a different adapter for the same bytes is a change of executable authority and needs a new scenario revision. The format travels to the runner and the collector through the dispatch grant, so it is covered by the signed attestation's grant digest, and the collector verifies **only** the pinned adapter's structure. Bytes in any other shape — a JUnit file under a Playwright pin, a Playwright report under a JUnit pin, a candidate-authored JSON document under either — are refused rather than sniffed. Unknown format names are refused when the bundle is defined.

## Supported formats

| Format | Kind | Producers covered by contract fixtures | Files the phases write |
| --- | --- | --- | --- |
| `graphyard-playwright-v1` | end-to-end | `@playwright/test` 1.63.x through the [packaged runner image](runner-setup.md#the-approved-runner-image) and its built-in reporter | `inventory.json`, `report.json` |
| `junit-xml-v1` | unit / integration | `node --test --test-reporter=junit` (Node 20–24), `pytest --junitxml` (7.x–8.x, `xunit2`), `jest-junit` 16.x, Maven Surefire/Failsafe 3.x XML, `go-junit-report` v2 | `inventory.json` (`graphyard-inventory-v1`), `report.xml` |

Fixtures under `tests/fixtures/reports/` are real producer output. A producer outside the listed versions may parse and still be refused as unsupported structure; that refusal names the element it did not understand.

### `graphyard-playwright-v1`

Proves that every test the approved bundle enumerated offline executed exactly once, without retry, and passed; that no step failed; and that the executed inventory is identical to the one enumerated before execution. The inventory is enumerated by the pinned image with no network, so the target cannot shape it, and both files are measured and signed by the host attestor before the collector reads them. Identities are hashes: titles, step names, error text and stdio never enter the report.

Failure semantics: a failed test is `behavior: failed`; a skipped, timed-out, interrupted, retried or expected-failing test, a reporter error or an overflow is a refusal, never a pass.

### `junit-xml-v1`

For unit and integration suites whose runner emits JUnit XML. Proves that every identity in the offline inventory appears exactly once in the report as passed — no failure, error, skip or rerun — and that the counts a suite declares agree with the cases it contains. A report that disagrees with itself is refused as inconsistent.

The inventory is a `graphyard-inventory-v1` document the pinned image writes in its `enumerate` phase, offline, listing the identity of every test the bundle contains:

```json
{ "format": "graphyard-inventory-v1", "tests": [{ "id": "<sha256 hex>" }], "overflow": false }
```

An identity is `sha256(suitePath ␟ classname ␟ name)` where `suitePath` is every enclosing `<testsuite name>` from the root joined with `/`, and `␟` is U+001F. The same case executed twice is a retry, not two passes. The adapter verifies against the inventory; it does not observe the enumeration itself, which is the pinned image's responsibility.

Only structure is published. The raw XML can carry assertion messages, stack traces, `<properties>` and captured stdio, so it is parsed into a minimised projection — identities, statuses, timings and counts — and **that** is what the collector uploads; the raw bytes stay at the execution boundary, where the attestor measured them. The XML reader refuses `DOCTYPE` and entity declarations, unknown root elements (an NUnit `<test-run>`, a `.trx` `<TestRun>`), and any element it does not recognise, so an unfamiliar producer fails visibly instead of being half-read.

Failure semantics: `<failure>` and `<error>` are `behavior: failed`; `<skipped>`, a `flakyFailure`/`rerunFailure`, a duplicate case, a count mismatch, an overflow and any refused document never pass.

What acceptance under this adapter does **not** establish: which artifact served the traffic — unit and integration reports carry no target identity, so the collector's [independent attribution dimension](runner-setup.md#whole-run-target-attribution) still decides that — nor that a test exercised a deployed target at all.

## Preview a verdict locally

```bash
graphyard runner verify-report junit-xml-v1 inventory.json report.xml
```

This prints the adapter's verdict and the projection it would publish. It reads no attempt authority and produces no evidence: evidence comes only from the collector, over bytes the host attestor measured.

## Adding an adapter

An adapter is added to `src/report-adapters.ts` with its contract fields filled in, contract fixtures from real producers, and tests showing that failures, skips, retries, inconsistent reports and unknown documents are refused. The format name then joins `reportFormats`, which is what bundle definitions and dispatch grants validate against. Runner images that write the new format are approved by digest like any other; the adapter never selects them.
