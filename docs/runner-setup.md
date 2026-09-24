<!-- page: Build integrations | 4 | runner, host attestor, and collector. -->
# The packaged Playwright runner and collector

The supported end-to-end path: an approved content-addressed oracle bundle, an isolated
executor supervised by a host attestor, and a separately trusted collector that verifies
inventory, target attribution and artifacts before publishing. Rich captures, mutable targets,
unapproved bundles and any result a candidate could author are visible refusals, never passes.

## Inspect, snapshot and approve the bundle

```bash
graphyard runner inspect [packages/web]                 # reads metadata only; runs no repository code
graphyard runner snapshot selected-files.json > oracle-source.json   # reviewable source manifest
graphyard runner bundle-digest ./oracle                 # the digest the runner will execute
```

Found filenames are proposals, and a snapshot is not approval. The bundle directory holds the reviewed specs plus every helper, config and lockfile; symlinks,
`node_modules` and credential files refuse. Every file and every ancestor directory must be
owned by the **attestor** (or root) and not group- or world-writable (sticky `/tmp` mode
excepted). Register it as operator with `validation define`, pinning the bundle `digest` and
`runnerImageDigest`; any byte change needs a new scenario revision and operator approval.

## Register the runner

The runner uses a **worker** credential with no proof scope. Its operator-created registration pins:

| Field | Pins |
| --- | --- |
| `executionHost` | the local `unix://` Docker socket (remote `ssh://`/`tcp://` refused) |
| `attestationPublicKey` | the attestor's Ed25519 public key |
| `executionNetwork` | a dedicated isolated network (`host`, `bridge`, `default`, `none` refused) |
| `testAccountDigest` | approved test-account material, from `graphyard runner account-digest /srv/graphyard/accounts.env` |

Changing any of them needs a new registration revision.

## Execute one dispatched attempt

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

`outputPath` is the collection root (the attestor creates `ATTEMPT_ID` beneath it); `runAsUser`
is a non-root container UID and the boundary-group GID. Target, digests, network, host and key
come in the dispatch grant, never from this file.

The runner polls `dispatch`, hands the attempt to the attestor, acknowledges after a clean
preflight and heartbeats every 20 seconds. The attestor runs two phases in the pinned image:
`enumerate` (network `none`, writes `/output/inventory.json`) and `execute` (the registered
network, writes `/output/report.json`), each read-only at `/oracle`, `--cap-drop=ALL`, no new
privileges, bounded resources and a constructed environment. Test-account entries are read
once in preflight and never placed on the command line.

A rejected heartbeat aborts the attempt. The attestor then force-removes both containers; the
record decides nothing about acceptance.

### The acknowledgement is retried, never repeated

- Every send carries the request key `ATTEMPT_ID-ack` and an identical body (`requestId`, `attemptId`, `epoch`); the idempotency receipt makes them one commit.
- Success means the returned request is `running` with this attempt acknowledged, so an already-acknowledged answer is success; any other 2xx is refused.
- A confirmed refusal is a decision (expired, cancelled or superseded lease, wrong runner) and is never retried. Only transport failures, timeouts, 408, 429 and 5xx are retried.
- At most **5 sends**, paused 1, 2, 4 and 8 seconds apart, and no send starts more than **60 seconds** after the first. On exhaustion `graphyard validation capacity` shows the next step.
- No heartbeat is sent and the attestor is not told to proceed until the acknowledgement is confirmed.

### The attempt boundary

| | Identity | Access |
| --- | --- | --- |
| Owner | the attestor | provisions, reads, removes |
| Group | the boundary group (GID in `runAsUser`) | container writes, attestor and collector read |
| Other | everyone, the runner above all | nothing |

```bash
groupadd --gid 20001 graphyard-boundary
useradd -r --uid 10001 -g graphyard-boundary graphyard-container
useradd -r graphyard-collector
usermod -aG graphyard-boundary graphyard-attestor
usermod -aG graphyard-boundary graphyard-collector
install -d -o graphyard-attestor -g graphyard-boundary -m 2750 /srv/graphyard/attempts
setfacl -d -m g:graphyard-boundary:rx /srv/graphyard/attempts
```

**Do not add the runner account to the group.** Each attempt gets a fresh mode-2770 directory
that must be empty at preflight; give the root a retention policy and clean it as the attestor.
A report written mode 0600 fails with `EACCES`; fix the ACL or image umask, not the boundary.

## The approved runner image

```bash
docker build -f docker/runner/Dockerfile -t REGISTRY/graphyard-runner:VERSION .
docker push REGISTRY/graphyard-runner:VERSION
```

Pin the pushed digest as `runnerImageDigest`. The image carries the browsers, the pinned
Playwright runtime and the reporter; its entrypoint takes the phase (`--list` for `enumerate`).
The bundle supplies `playwright.config.ts` and specs, not a runtime. Specs read the target from
`GRAPHYARD_TARGET_URL` (execute phase only); a hardcoded `baseURL` is unusable.

## The host attestor

```bash
GRAPHYARD_ATTESTOR_KEY=/etc/graphyard/attestor.key \
GRAPHYARD_ATTESTOR_URL=https://graphyard.example.test \
GRAPHYARD_ATTESTOR_TOKEN_FILE=/etc/graphyard/attestor.token \
  graphyard runner supervise
```

Run it as its own OS account through a `sudo` rule restricted to this command, setting all
three variables there; key and token file are mode 0600, owned by the attestor. With a `reader`
credential it re-reads the attempt before provisioning and after the acknowledgement, executes
only what Graphyard dispatched and acknowledged, and signs what it observed (outcome, measured
digests, grant digest). It refuses when the
container user is the caller or itself. Re-register the runner when rotating the keypair.

## Collect, verify and publish

The collector uses a **separate producer credential** scoped to the proof and its own OS
account on the execution host (boundary group, read access to the Docker socket, no access to
the bundle or key).

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

Copy `grant` from the runner's output (every field is required); `outputPath` is the attempt
directory. The collector first takes `collection-authority` (ending the runner's authority),
re-reads the grant, verifies the attestor signature against the bytes it reads, compares the
offline inventory with execution, and inspects `graphyard-enumerate-ATTEMPT` and
`graphyard-execute-ATTEMPT` itself: only `absent` settles the attempt. Artifacts go to private
storage; `missing` and `upload-failed` refuse acceptance.

### Whole-run target attribution

`observations` are independent measurements (provider API or host attestation) of what the
target ran; an app-served version is `measurement: "unknown"`. They must bracket the run with no
gap over `maxGapMs`.

| Situation | Attribution | Outcome |
| --- | --- | --- |
| Continuous coverage, all match | `matched` | Can pass |
| Mid-run difference, boundaries agree | `changed` | Attribution invalid |
| Final measurement differs | `mismatched` | Refused |
| Too few measurements, a gap, or `unknown` | `unknown` | Refused |

Infrastructure problems publish `blocked`, never a product failure or pass.

## Other report formats

`reportFormat` in the bundle definition selects the [report adapter](report-adapters.md):
`graphyard-playwright-v1` (default) or `junit-xml-v1`.

## Private artifacts

Collectors upload with `graphyard validation artifact-upload file.json` (`requestId`,
`attemptId`, `epoch`, `name`, `mediaType`, base64 `bytes` up to 8 MiB,
`capturePolicy: "approved-test-data-only"`) and read with:

```bash
graphyard validation artifact-download REQUEST_UUID ARTIFACT_UUID ./report.json
```

Artifacts are kept seven days, then swept; see
[artifact backends](recovery.md#artifact-backends-capacity-and-migration).

## Limits of this path

- The target must be immutable and operator-configured.
- Traces, screenshots and videos are refused.
- Attestor, Docker daemon and collector share one host; the three identities stay separate.
- Removing a container does not undo side effects in shared systems; use approved test accounts.
