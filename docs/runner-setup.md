<!-- page: Build integrations | 3 | host setup. -->
# Playwright runner and collector

## Approve the bundle

```bash
graphyard runner inspect [packages/web]
graphyard runner snapshot selected-files.json > oracle-source.json
graphyard runner bundle-digest ./oracle
```

Bundle: attestor-owned, not group/world-writable; `validation define` pins `digest`, `runnerImageDigest` (`docker/runner/Dockerfile`); specs read `GRAPHYARD_TARGET_URL`.

## Run an attempt

Unscoped `worker` credential: `graphyard runner attempt runner.json`:

```json
{"registration":{"id":"preview-runner","revision":1},"imageRepository":"ghcr.io/example/graphyard-runner","oraclePath":"/srv/graphyard/oracle","outputPath":"/srv/graphyard/attempts","timeoutMs":900000,"runAsUser":"10001:20001","testAccountEnvFile":"/srv/graphyard/accounts.env","supervisor":{"command":"sudo","args":["-n","-u","graphyard-attestor","/usr/local/bin/graphyard","runner","supervise"]}}
```

`runAsUser`: non-root UID, boundary-group GID; rest comes from the grant. The attestor (`graphyard runner supervise`, own OS account) enumerates offline, executes read-only, signs what it saw.

### The acknowledgement is retried, never repeated

Each send carries request key `ATTEMPT_ID-ack` and an identical body; an already-acknowledged answer is success, other 2xx refuse. A confirmed refusal is a decision, never retried; transport failures, timeouts, 408, 429, 5xx retry: At most **5 sends**, paused 1, 2, 4 and 8 seconds apart; no send starts more than **60 seconds** after the first. No heartbeat is sent and the attestor is not told to proceed until the acknowledgement is confirmed.

### Attempt boundary

```bash
groupadd --gid 20001 graphyard-boundary
useradd -r --uid 10001 -g graphyard-boundary graphyard-container
useradd -r graphyard-collector
usermod -aG graphyard-boundary graphyard-attestor
usermod -aG graphyard-boundary graphyard-collector
install -d -o graphyard-attestor -g graphyard-boundary -m 2750 /srv/graphyard/attempts
setfacl -d -m g:graphyard-boundary:rx /srv/graphyard/attempts
```

Container writes; attestor, collector read; **never add the runner account**.

## Collect and publish

Proof-scoped `producer` credential, own boundary-group OS account: `graphyard runner collect collector.json`:

```json
{"grant":{"requestId":"6e9b2a41-5f3c-4d18-9a70-1c8f5b2e0d44","attemptId":"b1d7c05e-8a24-4f6b-93ec-2f7a1d905c38","epoch":1,"runner":{"id":"preview-runner","revision":1},"executionHost":"unix:///var/run/docker.sock","attestationPublicKey":"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA2HzeK/2WAQf7BPIiVqXL5Mx9WMOOQ7KdQaUMVaBUHFM=\n-----END PUBLIC KEY-----\n","executionNetwork":"gy-preview-isolated","bundleDigest":"sha256:3f9a1c7d2e5b4086a1d3c6f8092b4e7a5d1c8f30b2a69e4d7c05f1a8b3e6d924","runnerImageDigest":"sha256:7c2e4a91f0d38b56ac17e9042f6b8d3519a0c7e4b62d9f18305a7c4e1b09d6f2","targetUrl":"https://preview-7f3a.example.test/","deadline":"2026-09-16T01:00:00.000Z","testAccountDigest":"sha256:5b8e0d3a7f21c94e6082d5b1a3f7c0e94d26b8a15f309c7e4b1d02a6f8395c7e"},"record":{"…":"attestor-execution-record"},"outputPath":"/srv/graphyard/attempts/b1d7c05e-8a24-4f6b-93ec-2f7a1d905c38","executionAttestation":{"payload":{"…":"signed-host-facts"},"signature":"base64…"},"requiredArtifacts":["inventory","report"],"expected":{"instance":"preview-7f3a","artifacts":[{"service":"api","digest":"sha256:…"}]},"observations":[{"at":"2026-09-16T00:00:00.000Z","measurement":"provider","instance":"preview-7f3a","artifacts":[{"service":"api","digest":"sha256:…"}]}],"maxGapMs":30000}
```

The collector (`collection-authority`) verifies signature, inventory, container teardown, uploading artifacts privately; `observations` must bracket run within `maxGapMs` (difference, gap or `unknown` measurement refuses); infrastructure faults publish `blocked`.
