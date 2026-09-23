<!-- page: Build integrations | 3 | candidates, attempts. -->
# Validation candidates and runner protocol

For an integrator driving a runner: how an attempt is authorized.

Identity (credential role): authority.

- **Human operator** (`admin`): define environments, approve bundles, register principals, select candidates, request, cancel and recover validation
- **Worker** (`worker`): implementation ownership only — no validation authority, no results
- **Runner** (`worker` with a runner registration): poll dispatch, acknowledge and heartbeat its attempt until collection takes over
- **Build producer** (`producer` with a builder registration): attest a verified source and build inputs → artifact mapping
- **Collector** (`producer` with a collector registration and matching `proofs`): verify execution, inventory, oracle, target identity, artifacts and settlement, then publish the bound result

## Inspect and invoke

```bash
graphyard validation                          # requests, attempts, refusals, unsettled resources
graphyard validation requests NEXT_CURSOR     # 20 per page; definitions [CURSOR] pages 50
graphyard validation show-candidate CANDIDATE_UUID
graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json
```

## Configure a candidate

Define an [E2E scenario](test-cases.md) first, then create work requiring its `e2e:SCENARIO_ID` proof, which pins the scenario revision, hash and environment. The environment definition:

- **ID:** stable, matching that scenario's environment
- **`delivery` block:** optional, for its [release policy](delivery.md#environment-policy)
- **Repository:** matches the managed one
- **HTTPS targets:** no credentials, query strings or fragments
- **Resource names:** identify shared external accounts globally
- **`immutable: true`:** an authorized target *declaration*, not observed proof

## Requests and attempts

A request carries:

- `candidateId`, `expectedWorkRevision`
- `deadline`: absolute ISO UTC, within the next hour
- `maxAttempts`: 1 to 5

Each is bound at creation to the candidate's manifest, compatibility signature and the target identity its observers report: a target already measured running another manifest refuses it before any paid execution; one that moves later supersedes and [re-anchors](attribution.md#re-anchoring) it.

## Trusted results

Only the pinned collector may call `result`, publishing `{requestId, attemptId, epoch}` plus:

- `execution`: `completed`, `cancelled` or `timed_out`
- `behavior`: `passed`, `failed`, `blocked` or `unmeasured`
- `executed`, `skipped`, `inventoryComplete`: Actual inventory, compared against the offline enumeration
- `bundleDigest`, `runnerImageDigest`: What executed
- `executionSettled`: The collector's **own** observation that execution finished

## Recovery

Operator commands take `{requestId, epoch, reason}`:

- `settle`: also requires `settlementEvidence`, a URL referencing independent termination proof; a manual attestation, only once the process and its external operations are confirmed stopped or fenced
- Revoked definitions need newly authorized configuration and a new request

A protected resource is never reassigned on a timer's expiry ([why](recovery.md#runner-capacity-and-request-diagnostics)). Every attempt carries a durable `sequence` ([replay and scoped reuse](evidence-reuse.md)).
