<!-- page: Build integrations | 3 | candidates, attempts, trusted results. -->
# Validation candidates and runner protocol

For an integrator driving a runner: how an attempt is authorized.

| Identity | Credential role | Authority |
| --- | --- | --- |
| Human operator | `admin` | Define environments, approve bundles, register principals, select candidates, request, cancel and recover validation |
| Worker | `worker` | Implementation ownership only; it defines no validation authority and publishes no results |
| Runner | `worker` with a runner registration | Poll dispatch, acknowledge and heartbeat its assigned attempt until collection takes over |
| Build producer | `producer` with a builder registration | Attest an independently verified source and build inputs → artifact mapping |
| Collector | `producer` with a collector registration and matching `proofs` | Verify execution, inventory, approved oracle, target identity, artifacts and settlement, then publish the bound result |

## Inspect and invoke

```bash
graphyard validation                          # requests, attempts, refusals, unsettled resources
graphyard validation requests NEXT_CURSOR     # 20 per page; definitions [CURSOR] pages 50
graphyard validation show-candidate CANDIDATE_UUID
graphyard validation define|build|candidate|request|dispatch|ack|heartbeat|result FILE.json
```

## Configure a candidate

Define an [E2E scenario](test-cases.md) first and create work requiring its `e2e:SCENARIO_ID` proof, which pins the scenario revision, hash and environment. An environment definition uses a stable ID matching that scenario's environment, with an optional `delivery` block for its [release policy](delivery.md#environment-policy); the repository must match the managed one, HTTPS targets carry no credentials, query strings or fragments, and resource names identify shared external accounts globally. `immutable: true` is an authorized target *declaration*, not observed proof; `immutable: false` declares shared staging, granted only once an observer has measured the candidate manifest running, and passing only with whole-window observed identity.

## Requests and attempts

A request carries `candidateId`, `expectedWorkRevision`, versioned `runner` and `collector` references, an absolute ISO UTC `deadline` within the next hour, and `maxAttempts` from 1 to 5; the collector must be authorized for the candidate's proof and environment. Each request is bound at creation to the candidate's manifest, compatibility signature and the target identity its observers report: a target already measured running another manifest refuses it before any paid execution, and one that moves later supersedes and [re-anchors](attribution.md#re-anchoring) it rather than editing it.

## Trusted results

Only the pinned collector may call `result`, publishing `{requestId, attemptId, epoch}` plus:

- `execution`: `completed`, `cancelled` or `timed_out`
- `behavior`: `passed`, `failed`, `blocked` or `unmeasured`
- `executed`, `skipped`, `inventoryComplete`: The actual inventory, compared against the offline enumeration
- `target`: `{instance, artifacts, measurement, coversEntireRun, attribution}`; `measurement` is `provider`, `host-attestation` or `unknown`, and an application self-report is never trusted measurement
- `bundleDigest`, `runnerImageDigest`: What actually executed
- `artifacts`, `artifactState`: Verified artifacts covering the required names; `verified`, `missing`, `upload-failed` or `expired`
- `executionSettled`: The collector's **own** observation that execution and its operations have finished

## Recovery

Operator commands take `{requestId, epoch, reason}`. `cancel` stops authorization but never claims a process stopped, so running reservations remain; never-acknowledged dispatches settle safely. `settle` also requires `settlementEvidence`, a URL referencing independent termination proof, and is a manual attestation for use only after confirming the process and its external operations are stopped or fenced. `retry` requires a settled prior attempt, an unexpired deadline, remaining budget and current authority, and invalidates any earlier pass. Revoked definitions need newly authorized configuration and a new request. Never reassign a protected resource because a timer expired: unknown outcomes stay blocked until verified settlement. Every attempt carries a durable `sequence` ([replay and scoped reuse](evidence-reuse.md)).
