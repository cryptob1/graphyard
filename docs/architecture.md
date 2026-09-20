<!-- page: Understand or contribute | 1 | invariants and boundaries. -->
# Architecture and correctness model

For a contributor: what makes a gate decision trustworthy.

## Boundary

Graphyard owns coordination decisions. A gate is a deterministic evaluation, never a model's judgment.

![Graphyard control-plane components. Agent sessions in a runtime such as Herdr, the human dashboard, and a proof producer each call the HTTP API and CLI under their own principals. The API hands each mutation to the coordination engine, which runs one advisory-locked transaction that writes the work aggregate and an event to Postgres. A reconciliation worker ticks every two seconds, expires leases, leases integration jobs, exchanges pull request, check, review, and protection facts with GitHub, publishes the required check, and runs the guarded merge. GitHub webhooks wake jobs but are never trusted as workflow truth.](diagrams/control-plane-components.svg)

Text equivalent: agent sessions, the dashboard and a proof producer reach the **HTTP API and CLI**, which hands authenticated commands to the **coordination engine** — one advisory-locked transaction per mutation, no external I/O inside — which writes the aggregate and its event together to **Postgres**. Jobs flow to the **reconciliation worker**, which exchanges pull-request, review, check, protection and merge facts with **GitHub**; the dashed arrow back is the signed webhook, which only wakes a job.

## Storage

`work_items.document` is the current aggregate; each mutation updates it and appends an event carrying the new snapshot in the same transaction, ordered by `events.seq`. `receipts` stores each successful command under `(principal, idempotency key)` with a fingerprint, so a retry returns the original result, a key reused for different input refuses, and a replay is not a renewed lease. The release, delivery, attribution and validation tables hold those protocols' immutable records; `jobs` is a durable queue processed with `FOR UPDATE SKIP LOCKED` and acknowledged with the exact owner token; `flow_facts` and `deployment_observations` are the append-only projection [flow analytics](flow-analytics.md) reads, never part of gate evaluation.

## Transactions, assignments and evidence

All short domain mutations take one Postgres advisory lock, serializing cross-item decisions — dependency readiness and workspace reservations included — across replicas; remote calls never hold it. Requirements and dependency edges are revisable with an expected policy revision and an audit reason, refusing active ownership and cycles, preserving history, retiring removed criterion IDs and invalidating old acceptance and review authorization; editing stored JSON directly is unsupported.

## Reconciliation

A non-overlapping tick every two seconds expires leases, re-evaluates affected state, then processes up to four GitHub jobs concurrently; a successful job is eligible again after 20 seconds, a failed one after 45. Applying an observation compares the work revision read before external I/O with the current one and requires the job's unexpired owner token; check publication rechecks that token, the revision and observation freshness immediately before writing, and the adapter rereads the pull request after collecting evidence, refusing a changed head, base, draft or state. Observations older than two minutes refuse the merge gate.

## The merge execution boundary

Before a merge can complete work, Graphyard must hold an authorization for the same head, base and policy and a final GitHub verification under a short-lived, single-use execution authority. While it is active, requirement, evidence, validation, reconciliation and non-matching observation mutations are refused; [evidence revocation](protocol/evidence.md#revocation) is the one exception, cancelling the authority in the same transaction that withdraws the evidence.

## Display state and replicas

The graph shows the first refusing stage while the card carries every refusal reason; delivered work stays historically delivered, and a merge observed with unsatisfied gates is a permanent visible violation. One formatter renders every elapsed duration: `Xm` below 60 minutes, `Xh Ym` under 48 hours, `Xd Yh` above, missing input `—`, negatives clamped.
