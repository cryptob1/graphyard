<!-- page: Build integrations | 4 | runner, attestor, collector. -->
# The packaged Playwright runner and collector

For the operator connecting a Playwright suite: three identities, and which refusals are by design.

## Inspect, snapshot, approve

What each preparation command does, and does not, establish:

- `runner inspect [DIRECTORY]`: Linux-only; proposes conventional test and configuration paths from package metadata, bounded to 10,000 entries and 20 directory levels, excluding symlinks, generated output and credential files. Imports no config, installs nothing, runs nothing
- `runner snapshot selected-files.json`: Exact base64 source bytes, per-file hashes and a manifest digest for an explicit list; symlinks, traversal and credential filenames refuse. Not a bundle, not approval
- `runner bundle-digest ./oracle`: Content-addresses every regular file under the bundle; symlinks, non-regular files, `node_modules` and credential filenames **refuse**, never skipped, so a bundle cannot smuggle bytes past approval or carry its own module path
- `runner account-digest FILE`: Measures a private env file's `TEST_ACCOUNT_*` entries, so comments and key order may change without a new revision. The digest is approved; a pathname never is
- `runner adapters`, `runner verify-report FORMAT INVENTORY REPORT`: Print each [report adapter](report-adapters.md) contract, or preview its verdict over two local files; no authority read, no evidence produced

## The three identities

| Identity | Holds | Must not |
| --- | --- | --- |
| **Runner** (`worker` registration) | Dispatch authority: polls, acknowledges, heartbeats | Execute anything, read the attempt boundary, or hold a proof scope; the CLI refuses to start if its credential carries one |
| **Host attestor** (own OS identity, `reader` credential) | The signing key, the approved bundle, every attempt boundary; runs both containers | Acknowledge, heartbeat, upload or publish |
| **Collector** (`producer` registration scoped to the proof) | Verification and publication | Execute, or reach the bundle or the key |
| **Container user** (`runAsUser`, never root) | Writes the report through the boundary group | Anything else; refused when it is the account that asked for supervision |

## Execute one dispatched attempt

The operator-created runner registration pins the execution boundary; none of it is accepted from a runner or collector input file:

- `executionHost`: The local Docker socket every attempt command is addressed to; `ssh://` and `tcp://` refuse
- `attestationPublicKey`: The host attestor's Ed25519 public key
- `executionNetwork`: The isolated network the target-facing phase may join; `host`, `bridge`, `default` and `none` refuse
- `testAccountDigest`: Which approved test-account material that phase may sign in as; without it any mode-0600 env file the attestor can read would pass

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

Two phases run in the pinned image, addressed as `REPOSITORY@sha256:…`:

1. `enumerate`: network `none`, writes `/output/inventory.json`, so the target cannot steer the inventory
2. `execute`: the registered network, writes `/output/report.json`

Each gets:

- **Mounts:** bundle read-only at `/oracle`, writable `/output`, `noexec,nosuid,nodev` tmpfs working directory, read-only root filesystem
- **Confinement:** `--cap-drop=ALL`, `no-new-privileges`, swap disabled, bounded memory, CPU and PIDs, non-root `runAsUser`
- **Environment:** constructed, never inherited; no Graphyard, GitHub, cloud, database, `NODE_*` or `npm_*` variable reaches it; only the approved material's `TEST_ACCOUNT_*` entries pass through the `docker` process's environment
- **Container output:** discarded

Preflight happens **before the acknowledgement**, provisions the boundary and refuses unless:

- Oracle and output paths are separate directories
- Bundle owned as above
- Boundary owned by the attestor, group-owned by the container's group with full group access, closed to everything else and **empty**

It records which directory the pathname resolved to, rechecks it before measuring, and re-verifies the preflight digest after the last phase. A refusal before the acknowledgement leaves the attempt unacknowledged: it expires and releases its reservations.

### The acknowledgement is retried, never repeated

- **One acknowledgement, however many sends.** Every send carries the request key `ATTEMPT_ID-ack` and an identical body; the idempotency receipt makes them one commit; that key with a different body is refused.
- **Confirmation is read from the answer, not the status code.** Success means the returned request is `running` with this attempt acknowledged, so an already-acknowledged answer is success; a 2xx showing anything else is refused without a retry.
- **A confirmed refusal is a decision.** An expired, cancelled or superseded lease, or the wrong runner principal, surfaces at once; only transport failures, timeouts, 408, 429 and 5xx are retried.
- **The bound.** At most **5 sends**, paused 1, 2, 4 and 8 seconds apart, and no send starts more than **60 seconds** after the first. Once exhausted the command fails naming the last ambiguous answer; `validation capacity` says whether the attempt expired unacknowledged or is `running` for an operator to settle.
- **Nothing starts before confirmation.** No heartbeat is sent and the attestor is not told to proceed until the acknowledgement is confirmed.

### The attempt boundary

Three accounts meet at the directory the container writes into, so it is shared through one **boundary group**, a fresh directory per attempt:

- **Attestor:** owns and provisions it
- **Boundary group** (the GID in `runAsUser`): may read, write and traverse
- **Nobody else:** may traverse it

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

Execution happens inside a small [host-attestor service](runner-attestor.md) under an OS identity the implementation worker cannot act as: it holds the signing key, owns the approved bundle and every attempt boundary, runs both containers, re-reads the dispatch authority and signs only what its own supervision observed.

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

- The collector re-reads the dispatch authority, compares it with the execution record **and the directory it is about to read**, verifies the attestation against that authority's public key, refusing any mismatch.
- It then reads the boundary, verifies the attestation against those bytes **before uploading anything**, judges the enumerated inventory against actual execution.
- `requiredArtifacts` decides what is *uploaded*, not what is verified ([trusted results](validation.md#trusted-results)).
- **Collection revokes execution authority.** The first call, `collection-authority`, moves the request to `collecting` and refuses every further ACK and heartbeat, so a live runner aborts rather than starting a container after settlement was observed; the collector therefore checks its own configuration first and renews the attempt while it verifies and uploads.
- **Settlement is observed, not reported.** `executionSettled` is the collector's own observation: it derives both container names from the grant (`graphyard-enumerate-ATTEMPT`, `graphyard-execute-ATTEMPT`) and inspects each read-only on the pinned `executionHost`, removing nothing. Only `absent` for exactly those containers settles the attempt; transport, daemon and authentication failures are `unknown`.
- Artifacts go to private storage first; a kind whose redaction is unimplemented is refused, not uploaded unprotected.

## Other report formats and artifacts

The collector verifies the two files through the [report adapter](report-adapters.md) pinned in the bundle's `reportFormat`.

- **Formats:** `graphyard-playwright-v1` by default, `junit-xml-v1` for unit and integration suites. The format is authority: bytes in any other shape are refused
- **Storage:** a candidate may select `artifactStorage: "postgres"`; the default `external` preserves custom collectors; the packaged collector requires private storage rather than arbitrary report URLs
- **Uploads:** only the current registered collector, holding the proof scope and a live acknowledged attempt epoch, may upload a required name; names are immutable within an attempt
- **Retention:** seven days ([artifact backends](recovery.md#artifact-backends-capacity-and-migration), [limits](runner-attestor.md#limits-of-this-path)).
