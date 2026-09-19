<!-- page: Build integrations | 3 | candidates, dispatch, attempts, and trusted result collection. -->
# Validation candidates and runner protocol

Graphyard now coordinates durable validation requests. Operators pin a source/artifact candidate, approved executable test bundle and separate runner/collector identities. Runners explicitly acknowledge an assignment, renew its lease and execute outside the control plane; only an authorized collector can publish its result.

**This is D1, the protocol and durable authority layer.** It does not launch Playwright, install a runner, fetch build attestations, measure live processes, store traces or verify production delivery. A custom integration must implement the trusted build producer and collector contracts below. The packaged executor, protected artifact storage and guided setup are D2 in the [delivery roadmap](turnkey-delivery-roadmap.md). A runner registration alone does not mean that any process is running.

## Identities and trust

Keep credentials separate:

| Identity | Existing credential role | Authority |
| --- | --- | --- |
| Operator | `admin` | Define environments, approve bundles, register principals, select candidates, request/cancel/recover validation |
| Implementation agent | `worker` | Existing implementation ownership; cannot define validation authority or publish trusted results |
| Runner | `worker` with an operator-created runner registration | Poll dispatch, ACK and heartbeat its assigned attempt until collection takes over |
| Build producer | `producer` with a builder registration | Attest independently verified source/build inputs → artifact mapping in its environment |
| Collector | `producer` with a collector registration and matching `proofs` allowlist | Verify execution, inventory, approved oracle, target identity, artifacts and settlement; publish the bound result |

Configure individual credentials through `GRAPHYARD_PRINCIPALS` as described in [deployment](deployment.md). Do not give builder/collector credentials to candidate code or the runner subprocess. Registration refers to principal IDs, not tokens. The server derives identity from authentication and checks current role/scope. The collector's registered proof list must be a subset of its credential allowlist. A request refuses if its collector principal also produced the candidate's build attestation; separate registrations with one shared credential do not establish independence.

Definitions have immutable revisions. Updating a registration requires its current `expectedRevision`; the new revision is also a new authorization generation. Revocation (`enabled: false`), scope changes and rotation invalidate outstanding authority. **Rotate in this order:** disable the registration first, replace the credential on every server replica and retire the old replicas, then enable a fresh registration revision. Never re-enable while a replica still accepts the old token. Replacing only an environment variable does not identify old attempts as revoked; the initial disabling transaction invalidates them across replicas before the credential rollout. Revision changes are transactional across replicas. Environment and bundle revisions likewise invalidate requests pinned to prior authorization.

For this first increment all authority-definition commands are operator-only. Delegated policy principals and worker-requested scheduling are not implemented. There is no arbitrary lifecycle setter.

For the in-development packaged path, see [runner preparation and private artifacts](runner-setup.md). Source preparation does not enable execution.

## Inspect and invoke

The dashboard's **Validation** view shows requests, attempts, refusal reasons and unsettled resources. It polls the latest server-side page of 20 requests every five seconds. Older pages are fetched only on demand; live polling pauses while browsing history, with a **Return to latest** control. Definitions have a separate paginated API, so polling does not download the registry or all candidate history. Failed loads remain visibly failed rather than appearing as an empty queue.

```bash
graphyard validation
graphyard validation requests NEXT_CURSOR
graphyard validation definitions
graphyard validation definitions NEXT_CURSOR
graphyard validation show-candidate CANDIDATE_UUID
graphyard validation define environment.json
graphyard validation build attestation.json
graphyard validation candidate candidate.json
graphyard validation request request.json
graphyard validation dispatch dispatch.json
graphyard validation ack attempt.json
graphyard validation heartbeat attempt.json
graphyard validation result result.json
```

Request pages use `GET /api/validation?cursor=REQUEST_UUID` (20 per page, candidate records only for that page). Definition history uses `GET /api/validation/definitions?cursor=OPAQUE_CURSOR` (50 per page). Both return `nextCursor`, or null when finished. Read a known candidate with `GET /api/validation/candidate/UUID`. Mutations use `POST /api/validation/ACTION`. Cursors preserve ordering even when new requests arrive between page reads. Use the appropriate identity for each command. Every mutation requires an `Idempotency-Key`; the CLI generates one. Set `GRAPHYARD_REQUEST_ID` only when retrying the exact same command after a network failure. Heartbeats and new polling attempts need new keys. Replayed execution grants are rejected after their original authority expires or is superseded; a receipt never extends a lease.

Read the current work `revision` immediately before commands requiring `expectedWorkRevision`. Concurrent heartbeats or GitHub observations can change it; a conflict requires reading again, not dropping the precondition.

## Configure a candidate

First define an [E2E scenario](test-cases.md) and create work requiring its `e2e:SCENARIO_ID` proof. Work pins the scenario revision, hash and environment. Validation cannot substitute a different proof or scenario.

An environment definition uses a stable ID matching that scenario's environment (an optional `delivery` block sets its [release policy](delivery.md#environment-policy)):

```json
{
  "kind": "environment",
  "id": "preview",
  "expectedRevision": 0,
  "repository": "owner/repository",
  "url": "https://preview.example.test",
  "instance": "immutable-deployment-123",
  "immutable": true,
  "services": ["api"],
  "resources": ["booking-test-account"]
}
```

The repository must match the managed GitHub repository. HTTPS targets cannot contain credentials, query strings or fragments. `immutable: true` is an authorized target declaration, **not independently observed runtime proof**. The collector must measure the actual target. Resource names identify shared external accounts/state globally; use the same name wherever the same resource is used. Graphyard additionally reserves the environment ID and runner principal across revisions.

Define separate runner, collector and builder registrations:

```json
{
  "kind": "registration",
  "id": "preview-runner",
  "expectedRevision": 0,
  "principalId": "runner-1",
  "role": "runner",
  "environment": {"id": "preview", "revision": 1},
  "adapterVersion": "custom-v1",
  "executionHost": "unix:///var/run/docker.sock",
  "attestationPublicKey": "-----BEGIN PUBLIC KEY-----\n…\n-----END PUBLIC KEY-----\n",
  "executionNetwork": "gy-preview-isolated",
  "testAccountDigest": "sha256:5b8e0d3a7f21c94e6082d5b1a3f7c0e94d26b8a15f309c7e4b1d02a6f8395c7e",
  "proofs": [],
  "enabled": true
}
```

Runner registrations must pin the exact container host the collector inspects, the public key of an operator-controlled host attestor, and the dedicated isolated network the target-facing phase may join; the attestor private key must be inaccessible to the runner worker. `executionHost` must be a local `unix://` socket: the supported executor measures the bundle and the attempt boundary on the attestor's own filesystem, and a remote daemon would resolve the same bind-mount pathnames somewhere that was never measured, so `ssh://` and `tcp://` endpoints refuse. `executionNetwork` is authority for the same reason as the other two: a container runtime resolves a network name against every network it already has, so an unpinned one lets a runner attach the browser to internal services. The built-in `host`, `bridge`, `default` and `none` names refuse. `testAccountDigest` is optional and pins which approved test-account material the target-facing phase may sign in as, measured with `graphyard runner account-digest FILE`; omit it for an attempt that needs none. Without it the pathname in the runner's own configuration would be the approval, and every private env file the attestor can read — including one for a support or administrator account the scenario was never approved to exercise — would satisfy the structural checks, so a compromised runner could obtain trusted evidence covering privileges nobody approved. Use `role: collector` and its allowed `e2e:...` proofs for the collector; use `role: builder` for the build producer. Non-runner registrations omit `executionHost`, `attestationPublicKey`, `executionNetwork` and `testAccountDigest`. These must reference separately configured principals with the roles in the table above. The `observer`, `promoter` and `rollback` roles are deployment identities for [observed production delivery](delivery.md) and [delivery recovery](recovery.md#rollback): they name the `services` of the environment they cover, carry no proofs and no execution authority, and cannot run, collect or build.

Approve a `kind: bundle` definition with `id`, `expectedRevision`, `scenario`, `scenarioRevision`, `scenarioHash`, `digest` and `runnerImageDigest`. Digests use `sha256:` plus 64 lowercase hex characters. The bundle digest must cover all executable assertions, transitive helpers, fixtures, configuration and lockfiles. The runner image pins runtime dependencies. Changed executable bytes require a new scenario revision and work pinned to it, even if published under a different bundle ID. Existing E2E scenario pins cannot be upgraded in place yet: create a follow-up work item pinned to the new revision, preserving the earlier item for history. Do not remove and re-add a proof to work around this boundary. D1 records the operator's approval; D2's isolated executor must enforce immutable approved bytes throughout execution.

The build producer submits:

- `registration: {id, revision}` for its active builder registration;
- `workId`, `expectedWorkRevision`, `sourceSha`, `baseSha` matching independently observed work;
- `buildInputsDigest`, the complete `artifacts: [{service, digest}]` manifest, and `provenanceUrl`.

The producer must independently establish the mapping, not copy a candidate-authored SHA label. Graphyard authenticates and records the attestation in immutable history and returns its `id`; it does not itself fetch/cryptographically verify a provider attestation in D1. Missing attestations, wrong source, wrong environment and incomplete service membership refuse candidate creation.

Create the candidate as operator with `workId`, `expectedWorkRevision`, required `proof`, versioned `environment` and `bundle` references, `buildAttestationId`, and nonempty `requiredArtifacts` names such as `["report", "trace"]`. The source, base, policy revision and scenario pin are derived from the work. Selecting a new candidate closes acceptance for this proof; old evidence remains in history but cannot satisfy it.

## Requests and attempts

Create a request with `candidateId`, `expectedWorkRevision`, versioned `runner` and `collector` references, an absolute ISO UTC `deadline` within the next hour, and `maxAttempts` from 1 to 5. The selected collector must be authorized for the candidate's proof and environment. A newer request prevents fallback to an older pass while it is queued, running, cancelled or incomplete.

The runner polls `dispatch` with `{"registration":{"id":"preview-runner","revision":1}}`. An eligible response includes the pinned request, candidate, trusted build attestation/artifact manifest, environment, bundle and attempt, plus the `executionAuthority` the registration pinned — host, attestor public key and isolated network; an unavailable queue returns `request: null` with a reason. At most one request holds a runner principal's slot. Global test-resource reservations prevent conflicting assignments across replicas.

An attempt has a unique ID and monotonic epoch. Send `{requestId, attemptId, epoch}` to `ack` **before any execution**. The initial ACK window is 30 seconds; after ACK, heartbeats extend the lease up to 60 seconds, bounded by the request deadline. Renew at least every 20 seconds. Stop on refusal and never infer permission from an old receipt. A runner must implement external fencing/isolation: a database lease cannot physically stop a partitioned process.

Collection is a handoff, not a parallel activity. The collector calls `collection-authority` with `{requestId, attemptId, epoch}` before it reads or publishes anything; the request moves from `running` to `collecting`, which revokes the runner's authority — further `ack`/`heartbeat` calls are refused — and extends the lease for the collector, renewed through `collection-heartbeat`. Artifact uploads and `result` require that state, so settlement is never measured while the executing party could still start a container. An expired `collecting` lease keeps the resource barrier closed exactly like a running one.

An unacknowledged timeout, cancellation or supersession releases its reservations because no execution was authorized and late ACKs fail. A running timeout retains its resource barrier. Server restarts preserve requests, epochs, receipts and reservations. Reconciliation checks active request deadlines and authority every two seconds. `graphyard validation capacity` diagnoses each live request — starved queue, unacknowledged dispatch, missing heartbeat, unsettled reservation — with its own next step, and a runner registration's `queueLimit` bounds its queue; see [runner capacity and request diagnostics](recovery.md#runner-capacity-and-request-diagnostics). Completed current evidence is rechecked on configuration changes and server startup, rather than rescanning all completed history on each tick. Build provenance is stored in an indexed immutable table as well as the event ledger. Source/policy changes immediately make old evidence inapplicable through the gate evaluator.

## Trusted results

Only the pinned collector can call `result`. It must independently verify the execution and publish:

- `{requestId, attemptId, epoch}`;
- `execution`: `completed`, `cancelled` or `timed_out`;
- `behavior`: `passed`, `failed`, `blocked` or `unmeasured`;
- actual `executed`, `skipped` and `inventoryComplete`;
- `target: {instance, artifacts: [{service, digest}], measurement, coversEntireRun, attribution}`;
- actual executed `bundleDigest` and `runnerImageDigest`;
- verified `artifacts: [{name, digest, url}]` covering the required names, and `artifactState`;
- `executionSettled`: whether the collector's **own** independent observation proves execution/operations have finished. A runner's claim about itself is not settlement; releasing a protected resource is never a worker assertion.

`measurement` is `provider`, `host-attestation` or `unknown`. Application self-reported version strings cannot count as either trusted measurement. `attribution` is `matched`, `mismatched`, `changed` or `unknown`, and only `matched` with whole-run coverage can pass: before/after probes cannot rule out A → B → A changes, so an uncovered interval stays `unknown`. `artifactState` is `verified`, `missing`, `upload-failed` or `expired`, and only `verified` can pass, so a runner exiting zero without durable required artifacts cannot be accepted. The collector must inspect the approved execution boundary and real inventory, not trust a report uploaded by candidate code. Artifact URLs are metadata, not public access grants; custom collectors must use private authorized storage and avoid secrets in URLs or reports.

The packaged runner and collector in [runner setup](runner-setup.md) compute all of these fields from the isolated execution boundary and independent target measurements. Graphyard rechecks every dimension against the pinned candidate when the result arrives, so a collector's computation is a second boundary rather than the only one.

A current report returns `{accepted: true, passed, reasons}`. `accepted` means the report belongs to a current authorized attempt; **it does not mean tests passed**. Zero/skipped/missing inventory, wrong artifact, unknown target, wrong bundle, missing artifacts or unverified settlement produce failed evidence. All passing dimensions are required.

Expired, revoked, cancelled or superseded results return `{accepted: false, passed: false, reasons}` and commit an audit record with a report hash. They cannot advance work. Retrying the same result key returns its historical receipt without producing duplicate evidence. Generic evidence submission cannot bypass a selected validation request.

## Recovery

Operator commands use `{requestId, epoch, reason}`:

- `cancel` stops authorization but does not claim a running process stopped. Running reservations remain. Never-ACKed dispatches are safely settled because a late ACK cannot authorize execution. Cancelling a queued retry preserves its prior attempt history.
- `settle` also requires `settlementEvidence`, a URL referencing independent termination/operation-settlement proof. Only use it after confirming the process and its external operations are stopped/fenced. This is an explicit manual recovery attestation in D1, not an automatic kill command.
- `retry` requires a settled prior attempt, an unexpired deadline, remaining attempt budget and current candidate/registration authority. It queues another attempt and invalidates any earlier pass.

Revoked definitions require newly authorized configuration and a new request. Do not reassign a protected resource because a timer expired. Unknown external outcomes remain blocked until verified settlement. The packaged runner implements and tests this external boundary by removing its containers and confirming their absence, and the collector independently re-observes those containers before reporting settlement; these APIs do not make arbitrary custom executors safe automatically.

## Verification

`npm test` runs disposable real Postgres tests for independent-pool races, restart persistence, explicit ACK, stale epochs/receipts, revocation, cancellation, requirement changes, forged-role reports, artifact/target mismatches and no old-pass fallback. Browser checks cover failure states and bounded request display. Production data is never used by these tests.

For parallel local worktrees, give each test run a distinct `GRAPHYARD_TEST_PORT`; the validation suite uses the next port by default, or an explicit `GRAPHYARD_VALIDATION_TEST_PORT`. Both databases remain disposable.
