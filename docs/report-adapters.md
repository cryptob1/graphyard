<!-- page: Build integrations | 5 | format contracts. -->
# Report adapters

For an integrator choosing a report format, and how failures are classified.

## The format is authority, not a property of the bytes

The operator-approved **bundle definition** pins the report format beside the runner image digest, as `reportFormat`, default `graphyard-playwright-v1`.

- **Carried in the dispatch grant** to the runner and collector, so the signed attestation's grant digest covers it
- **Verified:** the collector verifies **only** the pinned adapter's structure

- **`graphyard-playwright-v1`** (end-to-end): `@playwright/test` 1.63.x through the [packaged runner image](#the-approved-runner-image) and its built-in reporter, covered by contract fixtures; the phases write `inventory.json` and `report.json`

## The approved runner image

`docker/runner/Dockerfile` builds the image the two phases run in, pinned as `runnerImageDigest`.

- **Pin:** build, push, then pin the pushed manifest digest, never the tag
- **Address, every attempt:** `REPOSITORY@sha256:…`, the repository local configuration, the digest operator-versioned authority from the bundle definition
- **Contents:** browsers, the Playwright runtime pinned to the reviewed release, the Graphyard reporter
- **Entrypoint:** takes one argument, the phase, turned into `playwright test --config /oracle/playwright.config.ts --reporter <built-in>`
- **`--list`:** added for `enumerate`: reports the declared suite, runs no test body

## Adding an adapter

An adapter joins `src/report-adapters.ts` with its contract fields, contract fixtures from real frameworks and reporters, and tests showing that failures, skips, retries, inconsistent reports and unknown documents are refused. Its name joins `reportFormats`, which bundle definitions and dispatch grants validate against; runner images writing it are approved by digest like any other.
