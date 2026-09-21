<!-- page: Build integrations | 3 | candidates, attempts. -->
# Validation candidates and runner protocol

For an integrator driving a runner: how an attempt is authorized.

Identity (credential role): authority.

- **Human operator** (`admin`): Define environments, approve bundles, register principals, select candidates, request, cancel and recover validation
- **Worker** (`worker`): Implementation ownership only: defines no validation authority, publishes no results
- **Runner** (`worker` with a runner registration): Poll dispatch, acknowledge and heartbeat its attempt until collection takes over
- **Build producer** (`producer` with a builder registration): Attest an independently verified source and build inputs → artifact mapping
- **Collector** (`producer` with a collector registration and matching `proofs`): Verify execution, inventory, oracle, target identity, artifacts and settlement, then publish the bound result

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
- **`immutable: false`:** declares shared staging, granted only once an observer measured the candidate manifest running, passing only with whole-window observed identity

## Requests and attempts

A request carries:

- `candidateId`, `expectedWorkRevision`
- Versioned `runner` and `collector` references; the collector authorized for the candidate's proof and environment
- `deadline`: absolute ISO UTC, within the next hour
- `maxAttempts`: 1 to 5

Each is bound at creation to the candidate's manifest, compatibility signature and the target identity its observers report: a target already measured running another manifest refuses it before any paid execution; one that moves later supersedes and [re-anchors](attribution.md#re-anchoring) it.

## Trusted results

Only the pinned collector may call `result`, publishing `{requestId, attemptId, epoch}` plus:

- `execution`: `completed`, `cancelled` or `timed_out`
- `behavior`: `passed`, `failed`, `blocked` or `unmeasured`
- `executed`, `skipped`, `inventoryComplete`: Actual inventory, compared against the offline enumeration
- `target`: `{instance, artifacts, measurement, coversEntireRun, attribution}`; `measurement` is `provider`, `host-attestation` or `unknown`; a self-report is never trusted measurement
- `bundleDigest`, `runnerImageDigest`: What executed
- `artifacts`, `artifactState`: Verified artifacts covering the required names; `verified`, `missing`, `upload-failed` or `expired`
- `executionSettled`: The collector's **own** observation that execution finished

## Recovery

Operator commands take `{requestId, epoch, reason}`:

- `cancel`: stops authorization, never claiming a process stopped, so running reservations remain; never-acknowledged dispatches settle safely
- `settle`: also requires `settlementEvidence`, a URL referencing independent termination proof; a manual attestation, only once the process and its external operations are confirmed stopped or fenced
- `retry`: needs a settled prior attempt, unexpired deadline, remaining budget and current authority; invalidates any earlier pass
- Revoked definitions need newly authorized configuration and a new request

Never reassign a protected resource on a timer's expiry: unknown outcomes stay blocked until verified settlement. Every attempt carries a durable `sequence` ([replay and scoped reuse](evidence-reuse.md)).
