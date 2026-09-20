<!-- page: Understand or contribute | 1 | invariants and boundaries. -->
# Architecture and correctness model

For a contributor: what makes a gate decision trustworthy.

## Boundary

Graphyard owns coordination decisions; a gate is a deterministic evaluation, never a model's judgment.

![Graphyard control-plane components; the text equivalent follows.](diagrams/control-plane-components.svg)

Text equivalent: agent sessions, the dashboard and a proof producer reach the **HTTP API and CLI**, handing authenticated commands to the **coordination engine** (one advisory-locked transaction per mutation, no external I/O inside), writing the aggregate and its event together to **Postgres**. Jobs flow to the **reconciliation worker**, exchanging pull-request, review, check, protection and merge facts with **GitHub**; the dashed arrow back is the signed webhook, only waking a job.

## Storage

- **`work_items.document`:** the current aggregate; each mutation updates it and appends an event carrying the new snapshot in the same transaction, ordered by `events.seq`.
- **`receipts`:** each successful command under `(principal, idempotency key)` with a fingerprint: a retry returns the original result, a key reused for different input refuses, a replay is not a renewed lease.
- **Release, delivery, attribution and validation tables:** those protocols' immutable records.
- **`jobs`:** durable queue processed with `FOR UPDATE SKIP LOCKED`, acknowledged with the exact owner token.
- **`flow_facts` and `deployment_observations`:** the append-only projection [flow analytics](flow-analytics.md) reads, never part of gate evaluation.

## Transactions, assignments and evidence

- **One Postgres advisory lock:** taken by all short domain mutations, serializing cross-item decisions (dependency readiness and workspace reservations included) across replicas; remote calls never hold it.
- **Requirements and dependency edges:** revisable with an expected policy revision and an audit reason, refusing active ownership and cycles, preserving history, retiring removed criterion IDs and invalidating old acceptance and review authorization.
- **Unsupported:** editing stored JSON directly.

## Reconciliation

- **Tick:** non-overlapping, every two seconds; expires leases, re-evaluates affected state, then processes up to four GitHub jobs concurrently.
- **Job eligibility:** a successful job again after 20 seconds, a failed one after 45.
- **Applying an observation:** compares the work revision read before external I/O with the current one, requiring the job's unexpired owner token.
- **Check publication:** rechecks that token, the revision and observation freshness immediately before writing.
- **Adapter:** rereads the pull request after collecting evidence, refusing a changed head, base, draft or state.
- **Observations older than two minutes:** refuse the merge gate.

## The merge execution boundary

- **Before a merge can complete work:** Graphyard must hold an authorization for the same head, base and policy and a final GitHub verification under a short-lived, single-use execution authority.
- **Refused while active:** requirement, evidence, validation, reconciliation and non-matching observation mutations.
- **Sole exception:** [evidence revocation](protocol/evidence.md#revocation), cancelling the authority in the transaction withdrawing the evidence.

## Display state and replicas

- **Graph:** shows the first refusing stage; the card carries every refusal reason.
- **Delivered work:** stays historically delivered; a merge observed with unsatisfied gates is a permanent visible violation.
- **One formatter renders every elapsed duration:** `Xm` below 60 minutes, `Xh Ym` under 48 hours, `Xd Yh` above, missing input `—`, negatives clamped.
