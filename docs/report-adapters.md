<!-- page: Build integrations | 5 | what each format proves. -->
# Report adapters

For an integrator choosing a report format, and how failures are classified.

## The format is authority, not a property of the bytes

The report format is pinned in the operator-approved **bundle definition** beside the runner image digest, as `reportFormat`, defaulting to `graphyard-playwright-v1`. Like the digests it cannot change for a scenario revision once the bundle is approved: a different adapter for the same bytes is a change of executable authority needing a new scenario revision. It travels to the runner and collector through the dispatch grant, so the signed attestation's grant digest covers it, and the collector verifies **only** the pinned adapter's structure. Bytes in any other shape are refused rather than sniffed, and an unknown format name is refused when the bundle is defined.

| Format | Kind | Frameworks and reporters covered by contract fixtures | Files the phases write |
| --- | --- | --- | --- |
| `graphyard-playwright-v1` | end-to-end | `@playwright/test` 1.63.x through the [packaged runner image](#the-approved-runner-image) and its built-in reporter | `inventory.json`, `report.json` |
| `junit-xml-v1` | unit / integration | `node --test --test-reporter=junit` (Node 20–24), `pytest --junitxml` (7.x–8.x, `xunit2`), `jest-junit` 16.x, Maven Surefire/Failsafe 3.x XML, `go-junit-report` v2 | `inventory.json` (`graphyard-inventory-v1`), `report.xml` |

## The approved runner image

`docker/runner/Dockerfile` builds the image the two phases run in — what to pin as `runnerImageDigest`. Build and push it, then pin the pushed manifest digest, never the tag: every attempt addresses the image as `REPOSITORY@sha256:…`, the repository local configuration and the digest operator-versioned authority from the bundle definition. The image carries the browsers, the Playwright runtime pinned to the reviewed release and the Graphyard reporter; its entrypoint takes one argument, the phase, and turns it into `playwright test --config /oracle/playwright.config.ts --reporter <built-in>`, adding `--list` for `enumerate`, which reports the declared suite without running a test body.

## Adding an adapter

An adapter is added to `src/report-adapters.ts` with its contract fields, contract fixtures from real frameworks and reporters, and tests showing that failures, skips, retries, inconsistent reports and unknown documents are refused; its name then joins `reportFormats`, which bundle definitions and dispatch grants validate against. Runner images writing the new format are approved by digest like any other.
