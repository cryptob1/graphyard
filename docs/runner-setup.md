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

Stage the approved bytes as a snapshot owned by the **host attestor** described below. Every file and directory under the bundle, and every directory leading to it, must belong to that identity (or to root) and must not be group- or world-writable. A sticky shared parent such as `/tmp` may still be group- or world-writable, because the sticky bit leaves only an entry's own owner able to rename it — but that exemption covers the mode and never the ownership, since POSIX leaves a sticky directory's *own* owner able to rename any child. A mode-1777 parent belonging to the runner would let the runner swap the approved tree aside during execution and restore it before the closing digest, so every ancestor must belong to the attestor or to root whether it is sticky or not. A read-only container mount stops the container, not the host, so an oracle tree another account could write may be weakened after the preflight digest and restored before the closing one. "Not owned by whoever runs the container" would not be enough either, because the runner that asks for an attempt is a third account again: requiring the supervising identity's own ownership is what leaves no other account on the host able to touch the approved bytes. Copy the bundle into place as the attestor, and give the runner account no write access to it at all.

Register the result as an operator with `validation define`, pinning both the bundle `digest` and the `runnerImageDigest` against a specific scenario revision and hash. Changing any executable byte changes the digest, and Graphyard requires a new scenario revision plus a separate operator approval before that bundle can produce evidence. An implementation worker's credential cannot make that revision.

## Execute one dispatched attempt

The runner runs under a **worker** registration. The CLI refuses to start if the credential carries an evidence-producer proof scope, because execution must never be able to attest its own success. Its operator-created registration must also pin the whole execution boundary:

| Registration field | What it pins |
| --- | --- |
| `executionHost` | the Docker endpoint the collector will inspect |
| `attestationPublicKey` | the Ed25519 public key of the host attestor |
| `executionNetwork` | the dedicated isolated Docker network the target-facing phase may join |

Changing any of them requires a new registration revision, and none is accepted from a runner or collector input file. `executionNetwork` matters as much as the other two: Docker resolves a network name against every network the daemon already has, so a runner-chosen name could attach the browser container to the networks carrying databases and other internal services. The built-in `host`, `bridge`, `default` and `none` names are refused at registration.

```bash
graphyard runner attempt runner.json > execution.json
```

```json
{
  "registration": { "id": "preview-runner", "revision": 1 },
  "imageRepository": "ghcr.io/example/graphyard-runner",
  "oraclePath": "/srv/graphyard/oracle",
  "outputPath": "/srv/graphyard/attempts",
  "timeoutMs": 900000,
  "testAccountEnvFile": "/srv/graphyard/accounts.env",
  "supervisor": { "command": "sudo", "args": ["-n", "-u", "graphyard-attestor", "/usr/local/bin/graphyard", "runner", "supervise"] }
}
```

`outputPath` is the **collection root**, not one attempt's directory: the attestor provisions `COLLECTION_ROOT/ATTEMPT_ID` for each attempt and records that path. Attempts therefore need no manual filesystem work between runs — see [The attempt boundary](#the-attempt-boundary).

This file configures *where* an attempt runs, never *what* is approved. The target, the bundle and image digests, the isolated network, the execution host and the attestor's public key all arrive in the dispatch grant, from the operator-versioned registration.

The command polls `dispatch`, hands the attempt to the host attestor over `supervisor`, acknowledges once the attestor reports a clean preflight, and heartbeats every 20 seconds. **The runner itself executes nothing.** The attestor runs two phases in the pinned image, addressed as `REPOSITORY@sha256:...`:

| Phase | Network | Report file | Purpose |
| --- | --- | --- | --- |
| `enumerate` | `none` | `/output/inventory.json` | Enumerate the approved suite offline, so the inventory cannot be steered by the target |
| `execute` | the registered `executionNetwork` | `/output/report.json` | Exercise the approved target |

Each phase runs with the bundle bind-mounted read-only at `/oracle`, a separate writable bind mount at `/output`, a `noexec,nosuid,nodev` tmpfs scratch as the working directory, a read-only root filesystem, `--cap-drop=ALL`, `no-new-privileges`, swap disabled, and bounded memory, CPU and PIDs. The container runs as `runAsUser`, whose UID and GID must both be non-root: `0:0` with a root-owned boundary would otherwise satisfy every structural check and run both browser phases as root against a possibly hostile deployment, which also commonly forces Chromium out of its own sandbox. It defaults to the unprivileged identity running the attestor, and its GID is the boundary group described in [The attempt boundary](#the-attempt-boundary) — nothing here needs root, and nothing may write to the approved bytes. The container environment is constructed rather than inherited: no Graphyard, GitHub, cloud-provider, database, `NODE_*` or `npm_*` variable reaches it, so candidate-influenced configuration cannot redirect imports, interpreters or approved dependencies. Approved test-account material comes only from an explicit private (mode 0600) env file, and container stdout/stderr is discarded because it can carry those credentials. That file is read **once**, in preflight: only the `TEST_ACCOUNT_*` entries it actually contained are passed to the container, never the pathname. Docker reopens an `--env-file` when the container starts, which is after the allowlist was checked, so a rewrite in between could otherwise inject `NODE_OPTIONS` or `NODE_PATH` into the trusted runner image and redirect reporter execution.

Preflight happens **before the acknowledgement**, not after it, and it is the attestor's own. It provisions this attempt's boundary, then refuses unless the oracle and output paths are separate directories, the approved bundle belongs to the attestor as described above, and the boundary is owned by the attestor, group-owned by the container's group with full group access, closed to everything outside that group, and **empty** — a pre-existing file must never be mistaken for this attempt's output. Every directory leading to the boundary is held to the same rule as the bundle's: owned by the attestor or root and not group- or world-writable, with the mode of sticky shared parents such as `/tmp` exempted. A directory's own mode keeps other accounts out of it, but whoever can write its *parent* can rename it aside and leave a different directory — an earlier attempt's passing output — at the same pathname, which both the container mount and the attestor's later measurement would follow. So the attestor also records which directory that pathname resolved to and checks it again after the phases and before it measures the collected bytes: a replaced boundary is an explicit refusal in the record, and nothing is signed at all if the pathname changed before the measurement. Only once preflight has passed does the attestor pause and let the runner acknowledge; a refusal before that leaves the attempt unacknowledged, so it expires and releases its runner, environment and external reservations, while an acknowledged attempt holds them until an operator settles it by hand. If the runner cannot acknowledge, no container starts at all. The bundle digest measured during preflight is the one carried into execution, and it is verified again after the last phase; a mismatch either way is an explicit refusal rather than a result.

A rejected heartbeat means this epoch may no longer act. The runner terminates the attestor, which aborts: the running phase is killed, no further phase starts, and the record carries an explicit authority-loss refusal. The container boundary fences the host, not the target, so an attempt whose authority has been cancelled, superseded or expired must stop exercising the target rather than continue to its request deadline. An ambiguous renewal failure also aborts before the last confirmed 60-second lease can expire; network failure is not permission to keep exercising the target.

Killing `docker run` does not stop the container it started. After the phases — including an aborted or timed-out one — the attestor force-removes each container on the pinned `executionHost` and then confirms, on that same endpoint, that the name no longer resolves. Anything else, including an unreachable daemon, records `settled: false`. That record is a diagnostic: the resource barrier is released only by the collector's own observation, described below.

The execution record decides nothing about acceptance. It reports what ran, the digests measured before and after, whether the attempt timed out, whether settlement was verified, and any refusals.

### The attempt boundary

Three accounts meet at the directory the container writes its report into, and no single-owner private directory can serve all three. The container writes it. The attestor reads it back to measure and sign the bytes. The separately identified collector reads it again, later and possibly from another host. The runner account must reach none of it. So the boundary is shared through one dedicated **boundary group**, and each attempt gets its own directory:

| | Identity | Access to the attempt boundary |
| --- | --- | --- |
| Owner | the host **attestor** | provisions it, reads it, removes it when retention expires |
| Group | the dedicated **boundary group** — the GID in `runAsUser` | read, write and traverse: the container writes its report through it, the attestor and collector read through it |
| Other | everyone else, the **runner** account above all | nothing; the boundary cannot even be traversed |

Create the boundary group, make it the primary group of the container user, and add the attestor and the collector to it. **Do not add the runner account.** It holds Graphyard authority and could otherwise read what it must only forward — and group membership, unlike the container user, is not something the attestor can check for another account.

Provision the collection root once, owned by the attestor and not group- or world-writable:

```bash
groupadd graphyard-boundary
useradd -r -g graphyard-boundary graphyard-container
usermod -aG graphyard-boundary graphyard-attestor
install -d -o graphyard-attestor -g graphyard-boundary -m 2750 /srv/graphyard/attempts
# Files the container creates must stay readable to the group whatever umask the image
# uses. A default ACL is what guarantees it; a umask no stricter than 027 also suffices.
setfacl -d -m g:graphyard-boundary:rx /srv/graphyard/attempts
```

The attestor then creates `/srv/graphyard/attempts/ATTEMPT_ID` mode 2770 for each attempt and records that path in the execution record. That is what the collector's `outputPath` must name.

**Every attempt gets a fresh directory, and that is what makes retries work.** The boundary has to be empty at preflight — a leftover `report.json` from an earlier run would otherwise be measured, signed and published as this attempt's behaviour. Nothing removes a completed attempt's artifacts either, because its collector still has to read them, possibly hours later from another host. A single static output directory would therefore refuse the emptiness check on every attempt after the first. Per-attempt directories make that a non-issue; what they cost is disk, so give the collection root a retention policy and remove settled attempt directories as the attestor, never as the runner.

If the runner image writes its report mode 0600, the trusted readers get `EACCES` and the attempt is refused with exactly that reason rather than reported as a missing artifact. Fix it at the boundary — the default ACL above, or a umask no stricter than 027 in the image — not by widening the boundary.

## The host attestor

Execution happens inside a small host-attestor service, under an OS identity the implementation worker cannot act as. Generate an Ed25519 keypair, store the private key mode 0600 owned by that identity, and pin the public key, the Docker endpoint and the isolated network in the runner registration.

```bash
GRAPHYARD_ATTESTOR_KEY=/etc/graphyard/attestor.key graphyard runner supervise
```

The command reads one supervision request on stdin and answers on stdout. The runner reaches it through the `supervisor` entry in its own configuration — a `sudo` rule restricted to this command is the expected deployment, because `sudo`'s environment reset is what stops the runner from choosing which key signs. The attestor refuses to start if `GRAPHYARD_ATTESTOR_KEY` is unset, if the key is not a private (mode 0600) regular file, or if it belongs to another identity. It holds no Graphyard credential and never contacts the control plane.

**The attestor signs what it observed, not what it was handed.** It performs preflight, starts both containers, measures the approved bundle before and after, settles the containers, and reads the output boundary — all itself. The record it returns is the one its own execution produced; the only thing that crosses the boundary from the runner is the plan, and the request schema has nowhere to put an interval, an exit code, a measured digest or a container state. This is the whole point of the signature: a compromised runner can still fabricate an execution record and a matching passing report in a directory it can write, but it cannot obtain an attestation over them, and the collector publishes nothing without one.

The signature covers the request/attempt/epoch, the pinned host, the actual interval, the canonical output path, the artifact digests, the complete container set, **and the execution conclusions the collector acts on**: the outcome, the refusals, the per-phase results, and the bundle digests measured before and after alongside the runner image digest. Binding those is what stops a valid signature for the run that happened from being reattached to a record whose `timed_out` has become `completed`, whose refusals are gone, or whose mismatched digests have been replaced with the approved ones.

Three OS identities are involved and none may be shared: the **attestor**, which owns the approved bundle, the signing key and each attempt boundary; the **runner** worker account, which holds Graphyard authority and can start nothing itself; and the unprivileged, never-root **container user** in `runAsUser`, which writes the report through the boundary group. The attestor refuses when the container user is the account that asked for supervision — under the `sudo` rule that account is `SUDO_UID` — because a runner able to write the boundary could replace the report between the last phase and the measurement, and the attestation would then cover bytes the container never wrote. It also refuses before starting anything if it is not itself a member of the boundary group, since it could not read the report it is being asked to attest.

The private key is never mounted into either Playwright container, returned to the runner, or placed in Git. Deploy the attestor with its own filesystem and Docker access controls, and give it ownership of the approved bundle; running it under the worker's OS account collapses this boundary and is unsupported.

## Collect, verify and publish

The collector runs elsewhere, under a **separate producer credential** scoped to the proof. Never give it to the runner, and never give the runner's credential to the collector.

```bash
graphyard runner collect collector.json
```

```json
{
  "grant": {
    "requestId": "6e9b2a41-5f3c-4d18-9a70-1c8f5b2e0d44",
    "attemptId": "b1d7c05e-8a24-4f6b-93ec-2f7a1d905c38",
    "epoch": 1,
    "runner": { "id": "preview-runner", "revision": 1 },
    "executionHost": "ssh://graphyard@runner-1.example.test",
    "attestationPublicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA2HzeK/2WAQf7BPIiVqXL5Mx9WMOOQ7KdQaUMVaBUHFM=\n-----END PUBLIC KEY-----\n",
    "executionNetwork": "gy-preview-isolated",
    "bundleDigest": "sha256:3f9a1c7d2e5b4086a1d3c6f8092b4e7a5d1c8f30b2a69e4d7c05f1a8b3e6d924",
    "runnerImageDigest": "sha256:7c2e4a91f0d38b56ac17e9042f6b8d3519a0c7e4b62d9f18305a7c4e1b09d6f2",
    "targetUrl": "https://preview-7f3a.example.test/",
    "deadline": "2026-09-16T01:00:00.000Z"
  },
  "record": { "…": "the execution record the host attestor produced" },
  "outputPath": "/srv/graphyard/attempts/b1d7c05e-8a24-4f6b-93ec-2f7a1d905c38",
  "executionAttestation": { "payload": { "…": "signed host facts" }, "signature": "base64…" },
  "requiredArtifacts": ["inventory", "report"],
  "expected": { "instance": "preview-7f3a", "artifacts": [{ "service": "api", "digest": "sha256:…" }] },
  "observations": [{ "at": "2026-09-16T00:00:00.000Z", "measurement": "provider", "instance": "preview-7f3a", "artifacts": [{ "service": "api", "digest": "sha256:…" }] }],
  "maxGapMs": 30000
}
```

`grant` is parsed with the same strict schema the runner uses, so **every** field of the dispatch authority has to be present — `executionHost` and `attestationPublicKey` included. They are not decoration here: the first is the endpoint this collector inspects for settlement, and the second is the key the host attestation is verified against. Copy the grant through from the runner's output rather than retyping it. `outputPath` is the attempt directory the execution record names, not the collection root.

The collector re-reads the dispatch authority itself and compares it with the execution record **and with the directory it is about to read**, before anything is read or uploaded. It additionally verifies the host-attestor signature against the public key in that authority — and because the attestor derived every signed fact from its own supervision, that signature is what makes the record's contents evidence rather than a claim. A mismatched request, attempt, epoch, host, interval, artifact digest, container set, or runner registration refuses. `outputPath` must resolve to the boundary execution recorded — otherwise a live record plus an older attempt's successful output directory could publish that attempt's behaviour as this one's.

`requiredArtifacts` is this collector's own configuration, and it decides what is *uploaded*, not what is verified. Every approved kind the boundary holds is read whatever the upload list says: behaviour cannot be verified from the execution report without the inventory enumerated offline, and a kind left unread would look like output the approved reporter never wrote. The attestor likewise measures every kind, so a collector publishing a subset still publishes bytes the attestor saw; anything rewritten after attestation no longer matches a measured digest and refuses. A required name with no collector implementation still refuses explicitly.

It then reads the output boundary directly. Only the approved reporter's structure is accepted: arbitrary candidate-authored JSON is not proof that a command ran, and any file the approved reporter did not write refuses collection. The enumerated inventory is compared against actual execution — empty, skipped, expected-failing, missing, duplicated, retried, inconsistent and truncated reports all refuse.

### Settlement is observed, not reported

`executionSettled` in the published result is the collector's own observation, never a field copied from the execution record. The collector derives both container names for the attempt from the grant — `graphyard-enumerate-ATTEMPT` and `graphyard-execute-ATTEMPT` — and inspects each one itself, read-only; it never removes anything, so observing cannot manufacture an `absent`. Only `absent` for exactly those containers settles the attempt and lets Graphyard release its protected reservations. A record whose settlement does not account for exactly those containers, or that claims settlement the collector cannot see, is refused as blocked and the barrier stays closed until an operator supplies independent settlement evidence.

This is why the collector needs reachability to the execution host's container runtime. It uses the `executionHost` pinned in the operator-versioned runner registration; a collector cannot redirect inspection to a daemon where the attempt's containers merely happen to be absent. The attestor addresses that same endpoint for **every** runtime command — the two `docker run` invocations, the force-removal and its own confirming inspection — rather than whichever context its environment happens to default to. Running and removing on one daemon while the collector confirms absence on another would let a failed removal read as a settled attempt with its container still live against the target. Scope that endpoint to inspection. Docker transport, daemon, and authentication failures are `unknown`; only Docker's specific “no such container/object” response establishes absence. The runner cannot publish evidence, and the collector cannot execute.

### Collection revokes execution authority

The collector's first call is `collection-authority`, and taking that authority is what *ends* the runner's. The request moves to `collecting`: further ACKs and heartbeats are refused, so a runner that is still alive aborts rather than starting or restarting a container. Only then does the collector observe settlement, upload artifacts and publish a result — otherwise an attempt container started after the observation could still be running while Graphyard released its protected reservations. Graphyard refuses artifact uploads and results for an attempt that never went through the handoff.

The collector renews the acknowledged attempt while it verifies and uploads. Collection that legitimately takes longer than the runner's final 60-second lease therefore remains live, while a rejected or expired collector renewal still fails closed. Artifact uploads use stable idempotency keys and retry ambiguous transport failures before publishing a terminal result.

Artifacts are uploaded to private storage first, and the published result carries an explicit artifact state. `missing` (nothing at the boundary) and `upload-failed` (stored bytes do not match the collected digest) both refuse acceptance even when the runner exited zero. An artifact kind with no implementation that meets the capture policy — currently traces, screenshots and videos — is refused rather than uploaded unprotected.

### Whole-run target attribution

`observations` are independent measurements of which bytes a concrete instance was running at a moment, from a provider API or host attestation. A version endpoint, header or build label served by the application under test is candidate-controlled: record it with `measurement: "unknown"`, which can never raise attribution above `unknown`.

Before-and-after probes are explicitly insufficient. Coverage requires measurements that bracket the whole execution interval with no gap longer than `maxGapMs`, so an A → B → A rollout inside the interval is either observed or left uncovered.

Only the execution interval is judged. Provider APIs usually return a wider history than the run, so the nearest measurement at or before the start and the nearest at or after the finish are the boundaries, and anything outside them is neither a coverage gap nor a change during this attempt. A rollout an hour after the run does not invalidate it; a measurement an hour before it does not cover it.

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
