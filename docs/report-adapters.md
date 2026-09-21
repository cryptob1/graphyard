<!-- page: Build integrations | 5 | what each format proves. -->
# Report adapters

For an integrator choosing a report format, and how failures are classified.

## The format is authority, not a property of the bytes

The operator-approved **bundle definition** pins the report format beside the runner image digest, as `reportFormat`, default `graphyard-playwright-v1`.

- **Fixed:** like the digests, for a scenario revision once the bundle is approved; a different adapter for the same bytes changes executable authority and needs a new scenario revision
- **Carried in the dispatch grant** to the runner and collector, so the signed attestation's grant digest covers it
- **Verified:** the collector verifies **only** the pinned adapter's structure
- **Refused:** bytes in any other shape, never sniffed; an unknown format name, when the bundle is defined

| Format | Kind | Frameworks and reporters covered by contract fixtures | Files the phases write |
| --- | --- | --- | --- |
| `graphyard-playwright-v1` | end-to-end | `@playwright/test` 1.63.x through the [packaged runner image](#the-approved-runner-image) and its built-in reporter | `inventory.json`, `report.json` |
| `junit-xml-v1` | unit / integration | `node --test --test-reporter=junit` (Node 20–24), `pytest --junitxml` (7.x–8.x, `xunit2`), `jest-junit` 16.x, Maven Surefire/Failsafe 3.x XML, `go-junit-report` v2 | `inventory.json` (`graphyard-inventory-v1`), `report.xml` |

## The approved runner image

`docker/runner/Dockerfile` builds the image the two phases run in, pinned as `runnerImageDigest`.

- **Pin:** build, push, then pin the pushed manifest digest, never the tag
- **Address, every attempt:** `REPOSITORY@sha256:…`, the repository local configuration, the digest operator-versioned authority from the bundle definition
- **Contents:** browsers, the Playwright runtime pinned to the reviewed release, the Graphyard reporter
- **Entrypoint:** takes one argument, the phase, turned into `playwright test --config /oracle/playwright.config.ts --reporter <built-in>`
- **`--list`:** added for `enumerate`, which reports the declared suite, running no test body

## Adding an adapter

An adapter is added to `src/report-adapters.ts` with:

- Its contract fields
- Contract fixtures from real frameworks and reporters
- Tests showing failures, skips, retries, inconsistent reports and unknown documents are refused

Its name then joins `reportFormats`, which bundle definitions and dispatch grants validate against. Runner images writing it are approved by digest like any other.
