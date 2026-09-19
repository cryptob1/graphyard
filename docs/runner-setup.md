<!-- page: Build integrations | 4 | the packaged Playwright runner, host attestor, and collector. -->
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
| `executionHost` | the local Docker socket every attempt command is addressed to |
| `attestationPublicKey` | the Ed25519 public key of the host attestor |
| `executionNetwork` | the dedicated isolated Docker network the target-facing phase may join |
| `testAccountDigest` | the approved test-account material the target-facing phase may sign in as, if any |

Changing any of them requires a new registration revision, and none is accepted from a runner or collector input file. `executionNetwork` matters as much as the other two: Docker resolves a network name against every network the daemon already has, so a runner-chosen name could attach the browser container to the networks carrying databases and other internal services. The built-in `host`, `bridge`, `default` and `none` names are refused at registration.

`testAccountDigest` is what makes the account material approved, and the runner's `testAccountEnvFile` only says which private file on this host holds it. Measure the file with `graphyard runner account-digest /srv/graphyard/accounts.env` and register the digest it prints; it covers the `TEST_ACCOUNT_*` entries themselves, so comments, blank lines and key order may be changed freely without a new revision. Preflight refuses unless the file it reads hashes to the registered digest, and refuses a plan that names a file when the registration approves none — or a registration that approves material when the plan names no file. Without that pin the pathname would be the approval: every mode-0600 env file the attestor can read passes the structural checks, including one for a support or administrator account the scenario was never approved to exercise, so a compromised runner could point preflight at it and obtain trusted evidence for privileges nobody approved. The digest travels in the dispatch grant, is re-read independently by the attestor and by the collector, and is covered by the signed attestation along with the rest of the grant.

`executionHost` must be a local `unix://` socket, and a remote `ssh://` or `tcp://` endpoint is refused at registration. Preflight measures the approved bundle, the attempt boundary and every directory leading to them on the filesystem the attestor can see, while `--mount` sources are resolved by whichever daemon actually starts the container. Against a remote daemon those are two different filesystems: the same pathnames could mount bytes nobody measured, or nothing at all, with every host-side check passing. Attestor and daemon therefore share a host, and so does the collector — see [Collect, verify and publish](#collect-verify-and-publish). What the trust boundary actually requires is three separate *identities*, not three separate machines.

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

`outputPath` is the **collection root**, not one attempt's directory: the attestor provisions `COLLECTION_ROOT/ATTEMPT_ID` for each attempt and records that path. Attempts therefore need no manual filesystem work between runs — see [The attempt boundary](#the-attempt-boundary).

This file configures *where* an attempt runs, never *what* is approved. The target, the bundle and image digests, the isolated network, the execution host and the attestor's public key all arrive in the dispatch grant, from the operator-versioned registration.

The command polls `dispatch`, hands the attempt to the host attestor over `supervisor`, acknowledges once the attestor reports a clean preflight, and heartbeats every 20 seconds. **The runner itself executes nothing.** The attestor runs two phases in the pinned image, addressed as `REPOSITORY@sha256:...`:

| Phase | Network | Report file | Purpose |
| --- | --- | --- | --- |
| `enumerate` | `none` | `/output/inventory.json` | Enumerate the approved suite offline, so the inventory cannot be steered by the target |
| `execute` | the registered `executionNetwork` | `/output/report.json` | Exercise the approved target |

Each phase runs with the bundle bind-mounted read-only at `/oracle`, a separate writable bind mount at `/output`, a `noexec,nosuid,nodev` tmpfs scratch as the working directory, a read-only root filesystem, `--cap-drop=ALL`, `no-new-privileges`, swap disabled, and bounded memory, CPU and PIDs. The container runs as the explicitly configured `runAsUser`, whose UID and GID must both be non-root: `0:0` with a root-owned boundary would otherwise satisfy every structural check and run both browser phases as root against a possibly hostile deployment, which also commonly forces Chromium out of its own sandbox. Its UID is the dedicated container account and its GID is the boundary group described in [The attempt boundary](#the-attempt-boundary); the command refuses configurations that omit this host-specific mapping instead of guessing from the attestor identity. Nothing here needs root, and nothing may write to the approved bytes. The container environment is constructed rather than inherited: no Graphyard, GitHub, cloud-provider, database, `NODE_*` or `npm_*` variable reaches it, so candidate-influenced configuration cannot redirect imports, interpreters or approved dependencies. Approved test-account material comes only from an explicit private (mode 0600) env file, and container stdout/stderr is discarded because it can carry those credentials. That file is read **once**, in preflight: only the `TEST_ACCOUNT_*` entries it actually contained are passed to the container, never the pathname. Docker reopens an `--env-file` when the container starts, which is after the allowlist was checked, so a rewrite in between could otherwise inject `NODE_OPTIONS` or `NODE_PATH` into the trusted runner image and redirect reporter execution. Those entries are named on the `docker run` command line without their values and supplied through the environment of the `docker` process the attestor starts, because a command line is readable by every local account through the process listing and `/proc`: an approved password on it would be visible to the runner account, which is precisely the identity this boundary exists to keep away from it. Everything else the container receives is non-secret wiring and stays inline, where what was executed remains visible to an operator.

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
groupadd --gid 20001 graphyard-boundary
useradd -r --uid 10001 -g graphyard-boundary graphyard-container
useradd -r graphyard-collector
usermod -aG graphyard-boundary graphyard-attestor
usermod -aG graphyard-boundary graphyard-collector
install -d -o graphyard-attestor -g graphyard-boundary -m 2750 /srv/graphyard/attempts
# Files the container creates must stay readable to the group whatever umask the image
# uses. A default ACL is what guarantees it; a umask no stricter than 027 also suffices.
setfacl -d -m g:graphyard-boundary:rx /srv/graphyard/attempts
```

The attestor then creates `/srv/graphyard/attempts/ATTEMPT_ID` mode 2770 for each attempt and records that path in the execution record. That is what the collector's `outputPath` must name.

**Every attempt gets a fresh directory, and that is what makes retries work.** The boundary has to be empty at preflight — a leftover `report.json` from an earlier run would otherwise be measured, signed and published as this attempt's behaviour. Nothing removes a completed attempt's artifacts either, because its collector still has to read them, possibly hours later from another host. A single static output directory would therefore refuse the emptiness check on every attempt after the first. Per-attempt directories make that a non-issue; what they cost is disk, so give the collection root a retention policy and remove settled attempt directories as the attestor, never as the runner.

The packaged image writes each report mode 0640 under `umask 027`, so it stays readable to the boundary group. If some other image writes its report mode 0600, the trusted readers get `EACCES` and the attempt is refused with exactly that reason rather than reported as a missing artifact. Fix it at the boundary — the default ACL above, or a umask no stricter than 027 in the image — not by widening the boundary.

## The approved runner image

`docker/runner/Dockerfile` in this repository builds the image the two phases run in. It is the supported answer to "what do I pin as `runnerImageDigest`":

```bash
docker build -f docker/runner/Dockerfile -t REGISTRY/graphyard-runner:VERSION .
docker push REGISTRY/graphyard-runner:VERSION
```

Pin the pushed manifest digest, not the tag. Every attempt addresses the image as `REPOSITORY@sha256:...`, where `REPOSITORY` is the local `imageRepository` in the runner configuration and the digest is operator-versioned authority from the bundle definition.

The image carries the browsers, the Playwright runtime pinned to the release this repository reviewed, and the Graphyard reporter. Its entrypoint takes exactly one argument — the phase — and turns it into a Playwright invocation:

| Phase | Command | Writes |
| --- | --- | --- |
| `enumerate` | `playwright test --config /oracle/playwright.config.ts --reporter <built-in> --list` | `$GRAPHYARD_REPORT_FILE` |
| `execute` | the same, without `--list` | `$GRAPHYARD_REPORT_FILE` |

`--list` reports the declared suite without running a test body, which is what makes the approved inventory something the target cannot shape.

**The bundle supplies assertions, not a runtime.** `/oracle` is mounted read-only and must contain `playwright.config.ts` (or `.js`/`.mjs`) plus the reviewed specs and helpers. Module resolution for those specs is provided by the image, so `import { test } from '@playwright/test'` resolves to the approved runtime without `NODE_PATH` or `NODE_OPTIONS` — both are refused at the container boundary precisely because they redirect resolution. Nothing is installed from the bundle, and `node_modules` inside a bundle refuses at `bundle-digest`.

The specs read the approved target from `GRAPHYARD_TARGET_URL`, which is present in the `execute` phase only. A configuration that hardcodes a `baseURL`, or that reaches the network during `enumerate`, is not usable on this path.

The image sets no `USER`: the attestor supplies `--user` from `runAsUser`, and that account exists on the execution host rather than in the image. The entrypoint refuses an unknown phase, a missing report destination, a bundle with no Playwright configuration, and a report file that already exists — each before starting a browser, so a refusal is never mistaken for a test result.

## The host attestor

Execution happens inside a small host-attestor service, under an OS identity the implementation worker cannot act as. Generate an Ed25519 keypair, store the private key mode 0600 owned by that identity, and pin the public key, the Docker endpoint and the isolated network in the runner registration.

```bash
GRAPHYARD_ATTESTOR_KEY=/etc/graphyard/attestor.key \
GRAPHYARD_ATTESTOR_URL=https://graphyard.example.test \
GRAPHYARD_ATTESTOR_TOKEN_FILE=/etc/graphyard/attestor.token \
  graphyard runner supervise
```

The command reads one supervision request on stdin and answers on stdout. The runner reaches it through the `supervisor` entry in its own configuration — a `sudo` rule restricted to this command is the expected deployment, because `sudo`'s environment reset is what stops the runner from choosing which key signs, which server is consulted, or which credential is used. Set all three variables in that rule. The attestor refuses to start if `GRAPHYARD_ATTESTOR_KEY` is unset, if the key is not a private (mode 0600) regular file, or if it belongs to another identity, and it applies the same two checks to its credential file.

The key is also checked against the attempt before anything is acknowledged: the attestor signs a probe with it and verifies that signature with the `attestationPublicKey` the dispatch grant pins. A key that is malformed, encrypted, of another type, or simply not the registered one is otherwise first used after both containers have run — the attempt would have exercised the target, been acknowledged, and then produced no signature the collector can accept, holding its runner, environment and external reservations until an operator settled it by hand. Refusing here costs nothing instead: the attempt stays unacknowledged and expires. Re-register the runner whenever the attestor keypair is rotated, since the pinned public key is what the collector verifies with.

### The attestor verifies authority itself

The attestor holds a **read-only** Graphyard credential of its own — role `reader`, no proof scope, and never the runner's or the collector's. It uses it for exactly one thing: `GET /api/validation/attempt/REQUEST_ID`, which returns the attempt authority Graphyard currently holds plus the lease state. Nothing about the attempt changes; an attestor that could also acknowledge, heartbeat or publish would be the runner and the collector at once.

It reads twice, and both reads gate execution:

| When | What it requires |
| --- | --- |
| Before provisioning anything | the plan's `grant` is exactly the authority Graphyard dispatched |
| After the runner says it acknowledged | the same authority, `state: running`, an acknowledged attempt, and an unexpired lease |

The acknowledgement handshake on the pipe is a *sequencing* signal — it says the runner has finished trying — and never the authority to execute. Anything that can invoke the supervisor can write `{"proceed":true}`, so a schema-valid plan for an attempt Graphyard never dispatched, never acknowledged, or has already taken back would otherwise start containers against a live target. Because `collecting` fails the second read, an attempt also cannot start a container after the collector has observed settlement and Graphyard has released its reservations.

The credential is not a way around the boundary: it cannot dispatch, acknowledge, upload an artifact or publish a result, and the attestor still signs only what its own `executeAttempt` observed.

**The attestor signs what it observed, not what it was handed.** It performs preflight, starts both containers, measures the approved bundle before and after, settles the containers, and reads the output boundary — all itself. The record it returns is the one its own execution produced; the only thing that crosses the boundary from the runner is the plan, and the request schema has nowhere to put an interval, an exit code, a measured digest or a container state. This is the whole point of the signature: a compromised runner can still fabricate an execution record and a matching passing report in a directory it can write, but it cannot obtain an attestation over them, and the collector publishes nothing without one.

The signature covers the request/attempt/epoch, the pinned host, the actual interval, the canonical output path, the artifact digests, the complete container set, **the execution conclusions the collector acts on** — the outcome, the refusals, the per-phase results, and the bundle digests measured before and after alongside the runner image digest — **and the dispatch authority the run happened under**: the approved target, the execution network, and a digest of the whole grant. Binding the conclusions is what stops a valid signature for the run that happened from being reattached to a record whose `timed_out` has become `completed`, whose refusals are gone, or whose mismatched digests have been replaced with the approved ones. Binding the authority is what stops the other direction: a runner that hands the attestor a plan naming its own target or Docker network, obtains a real signature over that run, and then presents the collector with the record carrying the grant Graphyard actually issued. The request, attempt and epoch never change in that swap, so identifying the attempt alone would not catch it; the grant digest covers every field, including ones added later.

Three OS identities are involved and none may be shared: the **attestor**, which owns the approved bundle, the signing key and each attempt boundary; the **runner** worker account, which holds Graphyard authority and can start nothing itself; and the unprivileged, never-root **container user** in `runAsUser`, which writes the report through the boundary group. The attestor refuses when the container user is the account that asked for supervision — under the `sudo` rule that account is `SUDO_UID` — because a runner able to write the boundary could replace the report between the last phase and the measurement, and the attestation would then cover bytes the container never wrote. It also refuses before starting anything if it is not itself a member of the boundary group, since it could not read the report it is being asked to attest.

The attestor also compares `runAsUser` with its own effective UID and refuses that overlap before provisioning or acknowledgement. Supplying the boundary-group GID alongside the attestor UID is not a distinct container identity; it would give container code the same filesystem authority as the signer even if the runner arrived through a different `SUDO_UID`.

The private key is never mounted into either Playwright container, returned to the runner, or placed in Git. Deploy the attestor with its own filesystem and Docker access controls, and give it ownership of the approved bundle; running it under the worker's OS account collapses this boundary and is unsupported.

## Collect, verify and publish

The collector runs under a **separate producer credential** scoped to the proof. Never give it to the runner, and never give the runner's credential to the collector.

It runs as its own OS account on the execution host, because settlement is observed on the pinned local Docker socket. Separate *identity* is what the boundary requires — the collector cannot execute, the runner cannot publish, and neither is the attestor — and sharing a machine does not weaken any of that. Add the collector to the boundary group, give it read access to the Docker socket, and give it no access to the approved bundle or the attestor's key.

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

`grant` is parsed with the same strict schema the runner uses, so **every** field of the dispatch authority has to be present — `executionHost` and `attestationPublicKey` included. They are not decoration here: the first is the endpoint this collector inspects for settlement, and the second is the key the host attestation is verified against. Copy the grant through from the runner's output rather than retyping it. `outputPath` is the attempt directory the execution record names, not the collection root.

The collector re-reads the dispatch authority itself and compares it with the execution record **and with the directory it is about to read**, before anything is read or uploaded. It additionally verifies the host-attestor signature against the public key in that authority — and because the attestor derived every signed fact from its own supervision, that signature is what makes the record's contents evidence rather than a claim. A mismatched request, attempt, epoch, host, interval, artifact digest, container set, or runner registration refuses. `outputPath` must resolve to the boundary execution recorded — otherwise a live record plus an older attempt's successful output directory could publish that attempt's behaviour as this one's.

`requiredArtifacts` is this collector's own configuration, and it decides what is *uploaded*, not what is verified. Every approved kind the boundary holds is read whatever the upload list says: behaviour cannot be verified from the execution report without the inventory enumerated offline, and a kind left unread would look like output the approved reporter never wrote. The attestor likewise measures every kind, so a collector publishing a subset still publishes bytes the attestor saw; anything rewritten after attestation no longer matches a measured digest and refuses. A required name with no collector implementation still refuses explicitly.

It then reads the output boundary directly, and **verifies the host attestation against the bytes it just read before it uploads anything**. An artifact name is published once per attempt and cannot be taken back: a live grant plus schema-valid forged boundary files would otherwise consume the names this attempt's real evidence needs, and no later correct collection could republish them. Only the approved reporter's structure is accepted: arbitrary candidate-authored JSON is not proof that a command ran, and any file the approved reporter did not write refuses collection. The enumerated inventory is compared against actual execution — empty, skipped, expected-failing, missing, duplicated, retried, inconsistent and truncated reports all refuse.

### Settlement is observed, not reported

`executionSettled` in the published result is the collector's own observation, never a field copied from the execution record. The collector derives both container names for the attempt from the grant — `graphyard-enumerate-ATTEMPT` and `graphyard-execute-ATTEMPT` — and inspects each one itself, read-only; it never removes anything, so observing cannot manufacture an `absent`. Only `absent` for exactly those containers settles the attempt and lets Graphyard release its protected reservations. A record whose settlement does not account for exactly those containers, or that claims settlement the collector cannot see, is refused as blocked and the barrier stays closed until an operator supplies independent settlement evidence.

This is why the collector needs reachability to the execution host's container runtime, and why it runs on that host. It uses the `executionHost` pinned in the operator-versioned runner registration; a collector cannot redirect inspection to a daemon where the attempt's containers merely happen to be absent. The attestor addresses that same endpoint for **every** runtime command — the two `docker run` invocations, the force-removal and its own confirming inspection — rather than whichever context its environment happens to default to. Running and removing on one daemon while the collector confirms absence on another would let a failed removal read as a settled attempt with its container still live against the target. Scope that endpoint to inspection. Docker transport, daemon, and authentication failures are `unknown`; only Docker's specific “no such container/object” response establishes absence. The runner cannot publish evidence, and the collector cannot execute.

### Collection revokes execution authority

The collector's first call is `collection-authority`, and taking that authority is what *ends* the runner's. The request moves to `collecting`: further ACKs and heartbeats are refused, so a runner that is still alive aborts rather than starting or restarting a container. Only then does the collector observe settlement, upload artifacts and publish a result — otherwise an attempt container started after the observation could still be running while Graphyard released its protected reservations. Graphyard refuses artifact uploads and results for an attempt that never went through the handoff.

Because that transition cannot be undone, the collector first checks its own configuration against itself: a record that does not carry the grant it was written with, or that recorded a different output boundary than the one being collected, is refused before any call is made, so a local mistake does not spend the attempt's one collection transition or stop a runner that is still legitimately executing. That check decides nothing on its own — every value in it came from the caller — and the binding that governs is the one made straight afterwards against the authority the collector re-read for itself.

The collector renews the acknowledged attempt while it verifies and uploads. Collection that legitimately takes longer than the runner's final 60-second lease therefore remains live, while a rejected or expired collector renewal still fails closed. Renewal follows the same rule the executing runner does: a refusal Graphyard confirmed is authority taken away and is never recovered from, while a transport or 5xx failure ends the collection only once the authority it renews has actually gone stale — a renewal that succeeds afterwards proves the lease is current, and abandoning the only path that publishes this attempt's result over one lost packet would leave a completed execution with no evidence at all. Artifact uploads use stable idempotency keys and retry ambiguous transport failures before publishing a terminal result.

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

## Other report formats

The collector verifies the two files an attempt writes through the [report adapter](report-adapters.md) pinned in the bundle definition's `reportFormat`. This path's default, `graphyard-playwright-v1`, is the built-in reporter above. `junit-xml-v1` accepts unit and integration suites whose pinned image writes a `graphyard-inventory-v1` inventory in `enumerate` and a JUnit XML `report.xml` in `execute`; only its minimised structure is published. The format is authority: bytes in any other shape are refused, and changing it for a scenario revision needs a new revision like any other change of executable authority.

## Limits of this path

- The target must be immutable and operator-configured; the adapter has no mutable-target support, so a URL taken from arbitrary PR output is not acceptable input.
- Trace, screenshot and video capture are unimplemented under the protection policy and are refused, so failure diagnosis relies on the data-minimised step trace plus the target's own logs.
- The attestor, the Docker daemon and the collector share one host, because preflight measures the mounted bytes on the attestor's own filesystem. A remote `ssh://` or `tcp://` execution endpoint is refused rather than trusted; supporting one needs preflight to run on the daemon host, which this path does not do. The three identities remain separate.
- Container isolation is specified and asserted here, but a container boundary is a claim about this executor's configuration, not a proof of sufficient isolation against arbitrary hostile code. The oracle bundle and runner image are trusted, reviewed inputs; the untrusted code in this path is the deployed candidate, reached over the network.
- Settlement is verified through the container runtime. External side effects a test caused in a shared system are not settled by removing a container; use approved test accounts and fresh isolated resources, or refuse dispatch.

## Private artifacts for validation

A candidate may explicitly select `artifactStorage: "postgres"`. The default `external` preserves D1 custom collectors; the packaged collector requires private storage and does not accept arbitrary report URLs instead.

Postgres mode stores bounded artifact bytes in the existing durable database. Only the current registered collector, with the proof scope and a live acknowledged request/attempt epoch, can upload a required artifact name. Each name is immutable within an attempt. A repeated idempotency key returns the original metadata; a different key cannot overwrite its bytes. Artifact bytes never enter events or idempotency receipts.

The collector uses `POST /api/validation/artifacts` or `graphyard validation artifact-upload file.json` with:

- `requestId`, `attemptId`, `epoch`, required `name`;
- `mediaType`: `application/json`, `application/zip`, `image/png` or `text/plain`;
- base64 `bytes`, maximum 8 MiB decoded;
- `capturePolicy: "approved-test-data-only"`.

The capture-policy field is an authenticated collector attestation, not an automatic redactor. The packaged collector enforces it by construction: it uploads only the approved reporter's structurally validated, data-minimised JSON, and refuses artifact kinds whose redaction is unimplemented instead of uploading them. Custom collectors must not upload uncontrolled customer data, credentials or unrestricted browser traces. Missing safe required artifacts fail acceptance.

Upload returns the artifact ID, digest, expiry and a `graphyard-artifact://` reference. The reference has no embedded credential and is not a public download URL. Result ingestion checks the stored bytes' metadata against each required name, digest and request/attempt reference. A caller-authored URL or missing/expired artifact cannot authorize success.

Download with an authenticated request:

```bash
graphyard validation artifact-download REQUEST_UUID ARTIFACT_UUID ./report.json
```

The CLI creates a new private file and refuses to overwrite an existing path. The HTTP route is `GET /api/validation/artifacts/REQUEST_UUID/ARTIFACT_UUID`. Evidence history records typed artifact descriptors (kind, label, media type, size, digest, retention and authenticated reference), while legacy evidence with one public URL remains readable and is visibly identified as external. The URL form is bound to the candidate's storage mode: external-storage reports must cite safe HTTP(S) locations, and `graphyard-artifact://` references are accepted only for Postgres-backed storage after matching the stored request/artifact row; any other form fails the report and the descriptor is recorded as missing, never as a clickable external link. The work-detail UI fetches private bytes with the browser session credential; credentials are never placed in links or markup. PNG screenshots and JSON/plain-text output up to 1 MiB may be requested with `?preview=1`. Larger files, ZIP/trace/report binaries, HTML and unknown types always use `application/octet-stream`, `nosniff` and attachment disposition, so they cannot execute inline.

Operators/readers have this single repository's audit access. Implementation workers can read only work whose latest assignment belongs to them; producer access is restricted to their still-authorized collection request. A bearer token and a matching request are required even when someone knows the artifact ID. Every preview and download is audited. Missing, redacted and expired descriptors remain explicit history states and do not offer a read action; expired storage reads return refusal rather than falling back to an external location.

## Persistence and retention

An S3-compatible backend, a retained-bytes capacity bound, `upload-failed` as a visible artifact state, verified deletion and digest-checked migration between backends are described in [artifact backends, capacity and migration](recovery.md#artifact-backends-capacity-and-migration).

No separate public bucket or collector storage password is required for the initial Postgres backend. Use the persistent Postgres volume from [deployment](deployment.md); disposable/ephemeral databases are unsuitable for deployed artifact storage. The collector holds only its scoped Graphyard credential, never the database password. Budget database storage for artifacts: up to 8 MiB per required name, with a maximum of 30 names per candidate.

Retention is seven days from upload. Reads refuse immediately at expiry; a bounded sweep deletes the stored bytes in batches of 50 and appends a deletion event. Metadata remains auditable. Evidence requiring those artifacts expires at the earliest required artifact expiry, without falling back to an older pass or rewriting completed delivery history. A repeated upload receipt cannot extend retention.

Postgres deletion removes bytes from the active logical database; it is not a claim of instant physical erasure from WAL, replicas or backups. Configure backup/WAL retention and restoration procedures to match the data policy, and run the expiry sweep before serving a restored database.

## Data-minimized Playwright reports

The preparatory reporter uses Playwright's [Reporter API](https://playwright.dev/docs/api/class-reporter). It records opaque test IDs, relative test-source locations, execution status, retry counts and an ordered step timing/failure trace. It excludes titles, URLs, request/response bodies, assertion values, console output, screenshots and attachments. Even step titles may contain application secrets, so they are omitted rather than processed by a best-effort string redactor.

The verifier compares a separately enumerated inventory against actual execution, refusing empty/changed inventory, skipped/expected-failing tests, missing/duplicate tests, retries, failed steps, reporter errors and truncated reports. Local tests invoke real Playwright on controlled fixtures, including a deliberately broken assertion and seeded sensitive values that must not appear in report output.

These functions do not independently establish where code ran. The packaged collector accepts their output only from the attempt's own isolated output boundary and binds it to independently measured target identity, the current request/epoch and verified settlement. Candidate-supplied JSON cannot satisfy that boundary. The minimal timing trace helps locate failed test IDs and step positions; it is not a DOM/network trace or screenshot. Rich captures remain disabled until their protection policy is implemented and tested.
