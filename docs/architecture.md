<!-- page: Understand or contribute | 1 | invariants, storage, transaction boundaries. -->
# Architecture and correctness model

For a contributor: what makes a gate decision trustworthy.

## Boundary

Graphyard owns coordination decisions. A gate is a deterministic evaluation, never a model's judgment.

![Graphyard control-plane components. Agent sessions in a runtime such as Herdr, the human dashboard, and a proof producer each call the HTTP API and CLI under their own principals. The API hands each mutation to the coordination engine, which runs one advisory-locked transaction that writes the work aggregate and an event to Postgres. A reconciliation worker ticks every two seconds, expires leases, leases integration jobs, exchanges pull request, check, review, and protection facts with GitHub, publishes the required check, and runs the guarded merge. GitHub webhooks wake jobs but are never trusted as workflow truth.](diagrams/control-plane-components.svg)

Text equivalent of the diagram above, top to bottom. Agent sessions, the dashboard and a proof producer all reach the **HTTP API and CLI** (bearer authentication, schema validation, idempotency receipts, the signed webhook endpoint, the static UI), which hands authenticated commands to the **coordination engine** — one advisory-locked transaction per mutation, covering ownership, epochs, gates, evidence trust and merge authority with no external I/O inside. It writes the aggregate and its event together to **Postgres**, and jobs flow to the **reconciliation worker**, which ticks every two seconds and exchanges pull-request, review, check, protection and merge facts with **GitHub**; the dashed arrow back is the signed webhook, which only wakes a job. The legend inside the image is the [glossary's diagram legend](glossary.md#diagram-legend).

## Storage

`work_items.document` is the current aggregate and each mutation updates it and appends an event carrying its new snapshot in the same transaction, with `events.seq` providing ledger order. `receipts` stores each successful command under `(principal, idempotency key)` with a command fingerprint, so a retry returns the original result and a key reused for different input refuses; an idempotent replay is not a renewed lease. The release, delivery, attribution and validation tables hold those protocols' immutable records and operational state, and `jobs` is a durable integration queue processed with `FOR UPDATE SKIP LOCKED` and acknowledged with the exact owner token, with GitHub calls outside coordination transactions. `flow_facts` and `deployment_observations` are the append-only projection [flow analytics](flow-analytics.md) reads and never participate in gate evaluation.

## Transactions, assignments and evidence

All short domain mutations take one Postgres advisory lock, deliberately serializing cross-item decisions including dependency readiness and workspace reservations across replicas; remote calls never hold it. Requirements and dependency edges are revisable with an expected policy revision and an audit reason, refusing active ownership and cycles, preserving history, retiring removed criterion IDs and invalidating old acceptance and review authorization; editing stored JSON directly is unsupported.

## Reconciliation

A non-overlapping tick every two seconds expires leases, re-evaluates affected state, then processes up to four available GitHub jobs concurrently; a successful job becomes eligible again after 20 seconds and a failed one after 45. Applying an observation compares the work revision read before external I/O with the current revision and requires the job's unexpired owner token; check publication rechecks that token, the revision and observation freshness after provider reads and immediately before writing, and the adapter rereads the pull request after collecting evidence, refusing a changed head, base, draft or state. Observations older than two minutes refuse the merge gate.

## The merge execution boundary

Before a merge can complete work, Graphyard must hold an authorization for the same head, base and policy and a final GitHub verification under a short-lived, single-use execution authority. While it is active, requirement, evidence, validation, reconciliation and non-matching observation mutations are refused; [evidence revocation](protocol/evidence.md#revocation) is the deliberate exception and cancels the authority in the same transaction that withdraws the evidence.

## Display state and replicas

The graph shows the first refusing stage while the card carries every refusal reason; a blocker annotates work without introducing a lifecycle node, delivered work stays historically delivered, and a merge observed with unsatisfied gates is a permanent visible violation that later evidence never clears. Every user-facing elapsed duration renders through one deterministic formatter: minutes truncated to whole minutes, `Xm` below 60, `Xh Ym` from 60 minutes to under 48 hours, `Xd Yh` at 48 hours and above, zero components omitted, missing input rendered as `—`, negatives clamped to `0m`.
