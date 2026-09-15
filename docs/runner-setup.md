# Preparing the packaged Playwright runner

**D2 is in development. Execution is not enabled by these commands.** The source preparation and private storage primitives below are the first pieces of the supported runner. The isolated executor, trusted collector, actual inventory enumeration, capture policy enforcement and end-to-end setup still need implementation and validation before GY-17 can pass.

## Inspect without executing repository code

```bash
graphyard runner inspect
# or inspect a particular package
graphyard runner inspect packages/web
```

This Linux-only command reads package metadata and proposes conventional test/configuration paths. It never imports `playwright.config.ts`, installs packages, invokes package scripts or runs tests. Symlinks, generated output and common credential files are excluded. Discovery is bounded to 10,000 entries and 20 directory levels; select a narrower package if necessary. Filesystem descriptor checks refuse path substitution.

The result distinguishes missing inputs from inputs needing approval. Found filenames are **proposals, not a test inventory**. Existing suites with custom naming need explicit selection. The runner must eventually enumerate actual tests inside the approved executable boundary. An empty repository does not acquire fictional coverage.

## Review a source snapshot

Write a JSON array of explicitly selected relative source paths, including the tests and their helpers, configuration and lockfiles:

```json
["package.json", "package-lock.json", "playwright.config.ts", "tests/booking.spec.ts", "tests/fixtures.ts"]
```

```bash
graphyard runner snapshot selected-files.json > oracle-source.json
```

The snapshot contains exact base64-encoded source bytes, per-file hashes and a deterministic manifest digest. It accepts at most 1,000 unique regular files and 20 MB total. Parent/leaf symlinks, traversal and common credential filenames refuse. Review selected content for secrets; filename exclusions are not a general secret scanner. Keep snapshots containing private source outside public Git.

**A source snapshot is neither a complete executable bundle nor approval.** It does not resolve imports, prove dependency closure, install the runtime, approve assertions or register trusted evidence. A later build must produce a content-addressed image containing the independently reviewed assertions, all transitive executable dependencies and pinned runtime. Changed helpers change the source digest; changed executable bytes require a new scenario revision and separate operator approval under the validation protocol.

## Private artifacts for validation

A candidate may explicitly select `artifactStorage: "postgres"`. The default `external` preserves D1 custom collectors; the packaged executor must require private storage and cannot accept arbitrary report URLs instead.

Postgres mode stores bounded artifact bytes in the existing durable database. Only the current registered collector, with the proof scope and a live acknowledged request/attempt epoch, can upload a required artifact name. Each name is immutable within an attempt. A repeated idempotency key returns the original metadata; a different key cannot overwrite its bytes. Artifact bytes never enter events or idempotency receipts.

The collector uses `POST /api/validation/artifacts` or `graphyard validation artifact-upload file.json` with:

- `requestId`, `attemptId`, `epoch`, required `name`;
- `mediaType`: `application/json`, `application/zip` or `image/png`;
- base64 `bytes`, maximum 8 MiB decoded;
- `capturePolicy: "approved-test-data-only"`.

The capture-policy field is an authenticated collector attestation, not an automatic redactor. The packaged collector still has to implement exclusion/redaction and prove it with seeded sensitive fixtures before execution can ship. Custom collectors must not upload uncontrolled customer data, credentials or unrestricted browser traces. Missing safe required artifacts must fail acceptance.

Upload returns the artifact ID, digest, expiry and a `graphyard-artifact://` reference. The reference has no embedded credential and is not a public download URL. Result ingestion checks the stored bytes' metadata against each required name, digest and request/attempt reference. A caller-authored URL or missing/expired artifact cannot authorize success.

Download with an authenticated request:

```bash
graphyard validation artifact-download REQUEST_UUID ARTIFACT_UUID ./report.json
```

The CLI creates a new private file and refuses to overwrite an existing path. The HTTP route is `GET /api/validation/artifacts/REQUEST_UUID/ARTIFACT_UUID`; it returns an attachment, never executable inline HTML. Operators/readers have this single repository's audit access. Implementation workers can read only work whose latest assignment belongs to them; producer access is restricted to their still-authorized collection request. A bearer token and a matching request are required even when someone knows the artifact ID. Artifact reads are audited.

## Persistence and retention

No separate public bucket or collector storage password is required for the initial Postgres backend. Use the persistent Postgres volume from [deployment](deployment.md); disposable/ephemeral databases are unsuitable for deployed artifact storage. The collector holds only its scoped Graphyard credential, never the database password. Budget database storage for artifacts: up to 8 MiB per required name, with a maximum of 30 names per candidate.

Retention is seven days from upload. Reads refuse immediately at expiry; a bounded sweep deletes the stored bytes in batches of 50 and appends a deletion event. Metadata remains auditable. Evidence requiring those artifacts expires at the earliest required artifact expiry, without falling back to an older pass or rewriting completed delivery history. A repeated upload receipt cannot extend retention.

Postgres deletion removes bytes from the active logical database; it is not a claim of instant physical erasure from WAL, replicas or backups. Configure backup/WAL retention and restoration procedures to match the data policy, and run the expiry sweep before serving a restored database. D2's executor is not enabled until its storage and capture checks pass.

## Data-minimized Playwright reports

The preparatory reporter uses Playwright's [Reporter API](https://playwright.dev/docs/api/class-reporter). It records opaque test IDs, execution status, retry counts and an ordered step timing/failure trace. It excludes titles, URLs, request/response bodies, assertion values, console output, screenshots and attachments. Even step titles may contain application secrets, so they are omitted rather than processed by a best-effort string redactor.

The verifier compares a separately enumerated inventory against actual execution, refusing empty/changed inventory, skipped/expected-failing tests, missing/duplicate tests, retries, failed steps, reporter errors and truncated reports. Local tests invoke real Playwright on controlled fixtures, including a deliberately broken assertion and seeded sensitive values that must not appear in report output.

These functions do not independently establish where code ran. The future collector must accept their output only from the approved isolated oracle image and bind it to independently measured target identity, the current request/epoch and verified process settlement. Candidate-supplied JSON cannot satisfy that boundary. The minimal timing trace helps locate failed test IDs and step positions; it is not a DOM/network trace or screenshot. Rich captures remain disabled until their protection policy is implemented and tested.
