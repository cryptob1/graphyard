# The packaged Playwright runner and collector

This is the supported end-to-end path: guided discovery, an approved content-addressed oracle bundle, an isolated executor, and a separately trusted collector that verifies inventory, whole-run target attribution and required artifacts before publishing a result. Connecting an existing Playwright suite needs no custom dispatcher and no custom evidence publisher.

What this path still refuses, by design: rich captures (traces, screenshots, videos) whose redaction is not implemented, mutable targets, bundles the operator has not approved by digest, and any result a candidate could have authored. Those refusals are visible states, never silent passes. Read [Limits of this path](#limits-of-this-path) before promising more than it proves.

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

## Approve an executable bundle by digest

`runner snapshot` produces a reviewable source manifest. The thing the runner actually executes is a *bundle directory*: the reviewed assertions plus every transitive helper, fixture, Playwright configuration and lockfile. Its identity is content-addressed:

```bash
graphyard runner bundle-digest ./oracle
```

The digest covers every regular file under the directory, with no exclusions. Symlinks, non-regular files, generated trees such as `node_modules`, and common credential filenames **refuse** rather than being skipped, so a bundle cannot smuggle bytes past approval or carry its own module search path. Runtime dependencies come from the pinned runner image, never from the bundle.

Register the result as an operator with `validation define`, pinning both the bundle `digest` and the `runnerImageDigest` against a specific scenario revision and hash. Changing any executable byte changes the digest, and Graphyard requires a new scenario revision plus a separate operator approval before that bundle can produce evidence. An implementation worker's credential cannot make that revision.

## Execute one dispatched attempt

The runner runs under a **worker** registration. The CLI refuses to start if the credential carries an evidence-producer proof scope, because execution must never be able to attest its own success.

```bash
graphyard runner attempt runner.json > execution.json
```

```json
{
  "registration": { "id": "preview-runner", "revision": 1 },
  "imageRepository": "ghcr.io/example/graphyard-runner",
  "oraclePath": "/srv/graphyard/oracle",
  "outputPath": "/srv/graphyard/attempts/current",
  "network": "gy-preview-isolated",
  "timeoutMs": 900000,
  "testAccountEnvFile": "/srv/graphyard/accounts.env"
}
```

The command polls `dispatch`, acknowledges the attempt before any execution, heartbeats every 20 seconds, and runs two phases in the pinned image, addressed as `REPOSITORY@sha256:...`:

| Phase | Network | Report file | Purpose |
| --- | --- | --- | --- |
| `enumerate` | `none` | `/output/inventory.json` | Enumerate the approved suite offline, so the inventory cannot be steered by the target |
| `execute` | the configured isolated network | `/output/report.json` | Exercise the approved target |

Each phase runs with the bundle bind-mounted read-only at `/oracle`, a separate writable bind mount at `/output`, a `noexec,nosuid,nodev` tmpfs scratch as the working directory, a read-only root filesystem, `--cap-drop=ALL`, `no-new-privileges`, swap disabled, and bounded memory, CPU and PIDs. The container runs as `runAsUser`, which defaults to the unprivileged identity running the command and must own the output directory — nothing here needs root, and nothing may write to the approved bytes. The container environment is constructed rather than inherited: no Graphyard, GitHub, cloud-provider, database, `NODE_*` or `npm_*` variable reaches it, so candidate-influenced configuration cannot redirect imports, interpreters or approved dependencies. Approved test-account material comes only from an explicit private (mode 0600) env file, and container stdout/stderr is discarded because it can carry those credentials.

Before starting, the runner refuses unless the oracle and output paths are separate directories, the oracle directory is not group- or world-writable, and the output directory is owned by `runAsUser`, private (mode 0700) and **empty** — a pre-existing file must never be mistaken for this attempt's output. The bundle digest is verified before the first phase and again after the last one; a mismatch either way is an explicit refusal rather than a result.

Killing `docker run` does not stop the container it started. After the phases the runner force-removes each container and then confirms the name no longer resolves. Anything else — including an unreachable daemon — records `settled: false`, and the execution-resource barrier stays closed instead of releasing the resource to a retry.

The execution record decides nothing about acceptance. It reports what ran, the digests measured before and after, whether the attempt timed out, whether settlement was verified, and any refusals.

## Collect, verify and publish

The collector runs elsewhere, under a **separate producer credential** scoped to the proof. Never give it to the runner, and never give the runner's credential to the collector.

```bash
graphyard runner collect collector.json
```

```json
{
  "grant": { "requestId": "…", "attemptId": "…", "epoch": 1, "runner": { "id": "preview-runner", "revision": 1 },
             "bundleDigest": "sha256:…", "runnerImageDigest": "sha256:…",
             "targetUrl": "https://preview-7f3a.example.test/", "deadline": "2026-09-16T01:00:00.000Z" },
  "record": { "…": "the runner's execution record" },
  "outputPath": "/srv/graphyard/attempts/current",
  "requiredArtifacts": ["inventory", "report"],
  "expected": { "instance": "preview-7f3a", "artifacts": [{ "service": "api", "digest": "sha256:…" }] },
  "observations": [{ "at": "…", "measurement": "provider", "instance": "preview-7f3a", "artifacts": [{ "service": "api", "digest": "sha256:…" }] }],
  "maxGapMs": 30000
}
```

The collector re-reads the dispatch authority itself and compares it with the execution record. A mismatched request, attempt, epoch or runner registration produces **no publishable report at all**, so a stray attempt cannot advance any work. The record is data, not authority: a malformed one refuses, and the collector re-derives the boundary facts — that the measured bundle bytes and runner image match the approved digests, and that offline enumeration preceded execution — against the grant it read rather than trusting the record's own conclusions.

It then reads the output boundary directly. Only the approved reporter's structure is accepted: arbitrary candidate-authored JSON is not proof that a command ran, and any file the approved reporter did not write refuses collection. The enumerated inventory is compared against actual execution — empty, skipped, expected-failing, missing, duplicated, retried, inconsistent and truncated reports all refuse.

Artifacts are uploaded to private storage first, and the published result carries an explicit artifact state. `missing` (nothing at the boundary) and `upload-failed` (stored bytes do not match the collected digest) both refuse acceptance even when the runner exited zero. An artifact kind with no implementation that meets the capture policy — currently traces, screenshots and videos — is refused rather than uploaded unprotected.

### Whole-run target attribution

`observations` are independent measurements of which bytes a concrete instance was running at a moment, from a provider API or host attestation. A version endpoint, header or build label served by the application under test is candidate-controlled: record it with `measurement: "unknown"`, which can never raise attribution above `unknown`.

Before-and-after probes are explicitly insufficient. Coverage requires measurements that bracket the whole execution interval with no gap longer than `maxGapMs`, so an A → B → A rollout inside the interval is either observed or left uncovered:

| Situation | Attribution | Outcome |
| --- | --- | --- |
| Continuous coverage, every measurement matches | `matched` | Can pass |
| A mid-run measurement differs, boundaries agree | `changed` | Attempt and behaviour retained, attribution invalid |
| The final measurement differs | `mismatched` | Refused |
| Fewer than two measurements, a gap over `maxGapMs`, or any `unknown` measurement | `unknown` | Refused |

Set `maxGapMs` from how quickly the target could actually change. A short run with only boundary probes passes coverage only when the whole run fits inside one gap; prefer immutable preview deployments over busy shared staging.

### Independent dimensions

The published result reports execution, behaviour, inventory, attribution and artifacts separately. Graphyard rechecks every one of them against the pinned candidate, so the collector's own computation is a second boundary, not the only one. An infrastructure problem — a refused bundle check, a timeout, an unreadable boundary — is reported as `blocked`, never as a product failure and never as a pass. A report with no usable measurement is `unmeasured`.

## Limits of this path

- The target must be immutable and operator-configured; the adapter has no mutable-target support, so a URL taken from arbitrary PR output is not acceptable input.
- Trace, screenshot and video capture are unimplemented under the protection policy and are refused, so failure diagnosis relies on the data-minimised step trace plus the target's own logs.
- Container isolation is specified and asserted here, but a container boundary is a claim about this executor's configuration, not a proof of sufficient isolation against arbitrary hostile code. The oracle bundle and runner image are trusted, reviewed inputs; the untrusted code in this path is the deployed candidate, reached over the network.
- Settlement is verified through the container runtime. External side effects a test caused in a shared system are not settled by removing a container; use approved test accounts and fresh isolated resources, or refuse dispatch.

## Private artifacts for validation

A candidate may explicitly select `artifactStorage: "postgres"`. The default `external` preserves D1 custom collectors; the packaged collector requires private storage and does not accept arbitrary report URLs instead.

Postgres mode stores bounded artifact bytes in the existing durable database. Only the current registered collector, with the proof scope and a live acknowledged request/attempt epoch, can upload a required artifact name. Each name is immutable within an attempt. A repeated idempotency key returns the original metadata; a different key cannot overwrite its bytes. Artifact bytes never enter events or idempotency receipts.

The collector uses `POST /api/validation/artifacts` or `graphyard validation artifact-upload file.json` with:

- `requestId`, `attemptId`, `epoch`, required `name`;
- `mediaType`: `application/json`, `application/zip` or `image/png`;
- base64 `bytes`, maximum 8 MiB decoded;
- `capturePolicy: "approved-test-data-only"`.

The capture-policy field is an authenticated collector attestation, not an automatic redactor. The packaged collector enforces it by construction: it uploads only the approved reporter's structurally validated, data-minimised JSON, and refuses artifact kinds whose redaction is unimplemented instead of uploading them. Custom collectors must not upload uncontrolled customer data, credentials or unrestricted browser traces. Missing safe required artifacts fail acceptance.

Upload returns the artifact ID, digest, expiry and a `graphyard-artifact://` reference. The reference has no embedded credential and is not a public download URL. Result ingestion checks the stored bytes' metadata against each required name, digest and request/attempt reference. A caller-authored URL or missing/expired artifact cannot authorize success.

Download with an authenticated request:

```bash
graphyard validation artifact-download REQUEST_UUID ARTIFACT_UUID ./report.json
```

The CLI creates a new private file and refuses to overwrite an existing path. The HTTP route is `GET /api/validation/artifacts/REQUEST_UUID/ARTIFACT_UUID`; it returns an attachment, never executable inline HTML. Operators/readers have this single repository's audit access. Implementation workers can read only work whose latest assignment belongs to them; producer access is restricted to their still-authorized collection request. A bearer token and a matching request are required even when someone knows the artifact ID. Artifact reads are audited.

## Persistence and retention

No separate public bucket or collector storage password is required for the initial Postgres backend. Use the persistent Postgres volume from [deployment](deployment.md); disposable/ephemeral databases are unsuitable for deployed artifact storage. The collector holds only its scoped Graphyard credential, never the database password. Budget database storage for artifacts: up to 8 MiB per required name, with a maximum of 30 names per candidate.

Retention is seven days from upload. Reads refuse immediately at expiry; a bounded sweep deletes the stored bytes in batches of 50 and appends a deletion event. Metadata remains auditable. Evidence requiring those artifacts expires at the earliest required artifact expiry, without falling back to an older pass or rewriting completed delivery history. A repeated upload receipt cannot extend retention.

Postgres deletion removes bytes from the active logical database; it is not a claim of instant physical erasure from WAL, replicas or backups. Configure backup/WAL retention and restoration procedures to match the data policy, and run the expiry sweep before serving a restored database.

## Data-minimized Playwright reports

The preparatory reporter uses Playwright's [Reporter API](https://playwright.dev/docs/api/class-reporter). It records opaque test IDs, relative test-source locations, execution status, retry counts and an ordered step timing/failure trace. It excludes titles, URLs, request/response bodies, assertion values, console output, screenshots and attachments. Even step titles may contain application secrets, so they are omitted rather than processed by a best-effort string redactor.

The verifier compares a separately enumerated inventory against actual execution, refusing empty/changed inventory, skipped/expected-failing tests, missing/duplicate tests, retries, failed steps, reporter errors and truncated reports. Local tests invoke real Playwright on controlled fixtures, including a deliberately broken assertion and seeded sensitive values that must not appear in report output.

These functions do not independently establish where code ran. The packaged collector accepts their output only from the attempt's own isolated output boundary and binds it to independently measured target identity, the current request/epoch and verified settlement. Candidate-supplied JSON cannot satisfy that boundary. The minimal timing trace helps locate failed test IDs and step positions; it is not a DOM/network trace or screenshot. Rich captures remain disabled until their protection policy is implemented and tested.
