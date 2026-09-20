<!-- page: Build integrations | 4 | the packaged runner, attestor, collector. -->
# The packaged Playwright runner and collector

For the operator connecting a Playwright suite: three identities, and which refusals are by design.

## Inspect, snapshot, approve

What each preparation command does, and does not, establish:

- `runner inspect [DIRECTORY]`: Linux-only; proposes conventional test and configuration paths from package metadata, bounded to 10,000 entries and 20 directory levels, excluding symlinks, generated output and credential files. It imports no config, installs nothing and runs nothing: its findings are proposals, not an inventory
- `runner snapshot selected-files.json`: Exact base64 source bytes, per-file hashes and a manifest digest for an explicit list; symlinks, traversal and credential filenames refuse. Not a bundle and not approval
- `runner bundle-digest./oracle`: Content-addresses every regular file under the bundle. Symlinks, non-regular files, `node_modules` and credential filenames **refuse** rather than being skipped, so a bundle cannot smuggle bytes past approval or carry its own module path
- `runner account-digest FILE`: Measures a private env file's `TEST_ACCOUNT_*` entries, so comments and key order may change without a new revision. The digest is approved; a pathname never is
- `runner adapters`, `runner verify-report FORMAT INVENTORY REPORT`: Print each [report adapter](report-adapters.md) contract, or preview its verdict over two local files, reading no authority and producing no evidence

## The three identities

| Identity | Holds | Must not |
| --- | --- | --- |
| **Runner** (`worker` registration) | Dispatch authority: polls, acknowledges, heartbeats | Execute anything, read the attempt boundary, or hold an evidence-producer proof scope — the CLI refuses to start if its credential carries one |
| **Host attestor** (own OS identity, `reader` credential) | The signing key, the approved bundle, every attempt boundary; runs both containers | Acknowledge, heartbeat, upload or publish |
| **Collector** (`producer` registration scoped to the proof) | Verification and publication | Execute, or reach the bundle or the key |
| **Container user** (`runAsUser`, never root) | Writes the report through the boundary group | Anything else; it is refused when it is the account that asked for supervision |

## Execute one dispatched attempt

The operator-created runner registration pins the execution boundary, and none of it is accepted from a runner or collector input file:

- `executionHost`: The local Docker socket every attempt command is addressed to; `ssh://` and `tcp://` refuse, because the same pathnames would mount bytes nobody measured
- `attestationPublicKey`: The Ed25519 public key of the host attestor
- `executionNetwork`: The isolated network the target-facing phase may join; `host`, `bridge`, `default` and `none` refuse
- `testAccountDigest`: Which approved test-account material that phase may sign in as; without it every mode-0600 env file the attestor can read would pass

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
  "runAsUser": "10001:20001",
  "testAccountEnvFile": "/srv/graphyard/accounts.env",
  "supervisor": { "command": "sudo", "args": ["-n", "-u", "graphyard-attestor", "/usr/local/bin/graphyard", "runner", "supervise"] }
}
```

- Two phases run in the pinned image, addressed as `REPOSITORY@sha256:…`: `enumerate` on network `none` writing `/output/inventory.json`, so the target cannot steer the inventory, then `execute` on the registered network writing `/output/report.json`.
- Each mounts the bundle read-only at `/oracle` and a writable `/output`, with a `noexec,nosuid,nodev` tmpfs working directory, a read-only root filesystem, `--cap-drop=ALL`, `no-new-privileges`, swap disabled, bounded memory, CPU and PIDs, and the non-root `runAsUser`.
- The environment is constructed, never inherited — no Graphyard, GitHub, cloud, database, `NODE_*` or `npm_*` variable reaches it — and container output is discarded because it can carry credentials.
- Approved account material is read once, in preflight; only its `TEST_ACCOUNT_*` entries are passed, through the `docker` process's own environment rather than a command line.
- Preflight happens **before the acknowledgement**: it provisions the boundary and refuses unless the oracle and output paths are separate directories, the bundle is owned as above, and the boundary is owned by the attestor, group-owned by the container's group with full group access, closed to everything else and **empty**. It records which directory the pathname resolved to and rechecks it before measuring, so a replaced boundary refuses.
- A refusal before the acknowledgement leaves the attempt unacknowledged, so it expires and releases its reservations. The preflight digest is verified again after the last phase.

### The acknowledgement is retried, never repeated

- **One acknowledgement, however many sends.** Every send carries the request key `ATTEMPT_ID-ack` and an identical body; the idempotency receipt makes them one commit, and that key with a different body is refused outright.
- **Confirmation is read from the answer, not the status code.** Success means the returned request is `running` with this attempt acknowledged, so an already-acknowledged answer is success; a 2xx showing anything else is refused without a retry.
- **A confirmed refusal is a decision.** An expired, cancelled or superseded lease, or the wrong runner principal, surfaces at once; only transport failures, timeouts, 408, 429 and 5xx are retried.
- **The bound.** At most **5 sends**, paused 1, 2, 4 and 8 seconds apart, and no send starts more than **60 seconds** after the first. Once exhausted the command fails naming the last ambiguous answer, and `validation capacity` says whether the attempt expired unacknowledged or is `running` for an operator to settle.
- **Nothing starts before confirmation.** No heartbeat is sent and the attestor is not told to proceed until the acknowledgement is confirmed.

### The attempt boundary

Three accounts meet at the directory the container writes into, so it is shared through one dedicated **boundary group**, with a fresh directory per attempt: the attestor owns and provisions it, the boundary group (the GID in `runAsUser`) may read, write and traverse, and nobody else may traverse it.

```bash
groupadd --gid 20001 graphyard-boundary
useradd -r --uid 10001 -g graphyard-boundary graphyard-container
useradd -r graphyard-collector
usermod -aG graphyard-boundary graphyard-attestor
usermod -aG graphyard-boundary graphyard-collector
install -d -o graphyard-attestor -g graphyard-boundary -m 2750 /srv/graphyard/attempts
# A default ACL keeps the container's files readable to the group whatever umask
# the image uses; a umask no stricter than 027 also suffices.
setfacl -d -m g:graphyard-boundary:rx /srv/graphyard/attempts
```

## The host attestor

Execution happens inside a small [host-attestor service](runner-attestor.md) under an OS identity the implementation worker cannot act as. It holds the signing key, owns the approved bundle and every attempt boundary, runs both containers, re-reads the dispatch authority itself, and signs only what its own supervision observed.

## Collect, verify and publish

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
    "executionHost": "unix:///var/run/docker.sock",
    "attestationPublicKey": "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA2HzeK/2WAQf7BPIiVqXL5Mx9WMOOQ7KdQaUMVaBUHFM=\n-----END PUBLIC KEY-----\n",
    "executionNetwork": "gy-preview-isolated",
    "bundleDigest": "sha256:3f9a1c7d2e5b4086a1d3c6f8092b4e7a5d1c8f30b2a69e4d7c05f1a8b3e6d924",
    "runnerImageDigest": "sha256:7c2e4a91f0d38b56ac17e9042f6b8d3519a0c7e4b62d9f18305a7c4e1b09d6f2",
    "targetUrl": "https://preview-7f3a.example.test/",
    "deadline": "2026-09-16T01:00:00.000Z",
    "testAccountDigest": "sha256:5b8e0d3a7f21c94e6082d5b1a3f7c0e94d26b8a15f309c7e4b1d02a6f8395c7e"
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

- The collector re-reads the dispatch authority itself, compares it with the execution record **and with the directory it is about to read**, verifies the attestation against the public key in that authority, and refuses any mismatch.
- It then reads the boundary, verifies the attestation against those bytes **before uploading anything**, and judges the enumerated inventory against actual execution; `requiredArtifacts` decides what is *uploaded*, not what is verified ([trusted results](validation.md#trusted-results)).
- **Collection revokes execution authority.** The first call, `collection-authority`, moves the request to `collecting` and refuses every further ACK and heartbeat, so a live runner aborts rather than starting a container after settlement was observed. Because that cannot be undone the collector checks its own configuration first, and renews the attempt while it verifies and uploads.
- **Settlement is observed, not reported.** `executionSettled` is the collector's own observation: it derives both container names from the grant — `graphyard-enumerate-ATTEMPT` and `graphyard-execute-ATTEMPT` — and inspects each read-only on the pinned `executionHost`, removing nothing, so observing cannot manufacture an `absent`. Only `absent` for exactly those containers settles the attempt; transport, daemon and authentication failures are `unknown`.
- Artifacts go to private storage first, and a kind whose redaction is unimplemented is refused rather than uploaded unprotected.

### Whole-run target attribution

`observations` are independent measurements of which bytes a concrete instance ran at a moment, from a provider API or host attestation; anything the application under test says about itself is `measurement: "unknown"`. `maxGapMs` bounds the gaps allowed between them, and [whole-run coverage](attribution.md#whole-run-coverage) decides what the result may claim.

## Other report formats and artifacts

The collector verifies the two files through the [report adapter](report-adapters.md) pinned in the bundle's `reportFormat`: `graphyard-playwright-v1` by default, `junit-xml-v1` for unit and integration suites. The format is authority — bytes in any other shape are refused. A candidate may select `artifactStorage: "postgres"`; the default `external` preserves custom collectors, while the packaged collector requires private storage rather than arbitrary report URLs. Only the current registered collector, holding the proof scope and a live acknowledged attempt epoch, may upload a required name, each name is immutable within an attempt, and retention is seven days ([artifact backends](recovery.md#artifact-backends-capacity-and-migration), [limits of this path](runner-attestor.md#limits-of-this-path)).
