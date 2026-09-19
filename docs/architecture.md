# Architecture and correctness model

This page is the technical reference for Graphyard's invariants and storage model. For a visual, plain-language tour from setup to Done, start with [How Graphyard works](how-graphyard-works.md).

## Boundary

Graphyard owns coordination decisions. Git owns source history. GitHub owns the actual PR and merge facts. Herdr and other agent runtimes host agent sessions. Proof producers produce evidence. A Graphyard gate is a deterministic evaluation, never an LLM judgment. Terms are defined in the [glossary](glossary.md).

The practical distinction between Graphyard's delivery authority and Herdr's runtime health is summarized in [How Graphyard works](how-graphyard-works.md#graphyard-and-herdr-answer-different-questions).

![Graphyard control-plane components. Agent sessions in a runtime such as Herdr, the human dashboard, and a proof producer each call the HTTP API and CLI under their own principals. The API hands each mutation to the coordination engine, which runs one advisory-locked transaction that writes the work aggregate and an event to Postgres. A reconciliation worker ticks every two seconds, expires leases, leases integration jobs, exchanges pull request, check, review, and protection facts with GitHub, publishes the required check, and runs the guarded merge. GitHub webhooks wake jobs but are never trusted as workflow truth.](diagrams/control-plane-components.svg)

Text equivalent of the diagram above, top to bottom. Three callers sit at the top: **agent sessions** in a runtime (violet; worker, master, and lead sessions in Herdr or another runtime, each using the CLI under its own principal), the **dashboard** (amber; the human operator and readers, with the same authorization as the API and no lifecycle-state endpoint), and a **proof producer** (green; a CI workflow or trusted runner whose evidence is bound to head, base, and policy). Solid arrows from all three lead to the **HTTP API and CLI** (blue): bearer authentication, schema validation, idempotency receipts, the signed webhook endpoint, and the static UI. Authenticated commands flow to the **coordination engine** (blue), one advisory-locked transaction per mutation covering ownership, epochs, gates, evidence trust, and merge authority, with no external I/O inside. The engine writes the aggregate and an event in one transaction to **Postgres** (blue): the `work_items` aggregate, append-only events and receipts, the jobs queue, releases, and delivery observations, with triggers that reject ledger edits. Jobs flow to the **reconciliation worker** (blue), which ticks every two seconds, expires leases, leases jobs with `SKIP LOCKED`, applies observations, publishes the required check, and runs the guarded merge. A solid two-headed arrow joins it to **GitHub** (grey: PR, reviews, checks, branch protection, merge facts); a dashed arrow from GitHub marks the signed webhook, which only wakes a job. The legend inside the image is the [glossary's diagram legend](glossary.md#diagram-legend).

## Storage

`work_items.document` is the current aggregate: intent, requirements, assignment, workspaces, candidate, evidence, gates, and observed facts. Each mutation updates that aggregate and appends an event containing its new snapshot in the same transaction. `events.seq` provides ledger order; wall-clock timestamps alone do not define ordering.

`receipts` stores the result of each successful command under `(principal, idempotency key)` plus a fingerprint of the command. Retries return the original result. A key reused for different input refuses. Read fresh status after replaying an old claim response; an idempotent replay is not a renewed lease.

`releases`, `release_builds`, `release_approvals` and `delivery_observations` are immutable like the event ledger; `delivery_environments` holds each environment's derived delivery state with the observation cursor its sweep resumes from, and `delivery_leases` the epoch each running observer, promoter or rollback executor currently holds. `delivery_rollbacks` holds each rollback with its single provider operation identity, and `validation_runner_polls` the last dispatch poll per runner registration; `validation_artifacts` rows name their backend, location and retention state whether the bytes live in the row or in an S3-compatible store (see [recovery](recovery.md)).

`jobs` is a durable integration queue, with next-attempt time, owner token, lease expiry, error, and attempt count. It is created transactionally with PR submission. Jobs are processed with Postgres `FOR UPDATE SKIP LOCKED`, then acknowledged with the exact owner token. GitHub calls occur outside coordination transactions.

Database triggers reject updates and deletes to the event ledger. This is an application audit guarantee, not tamper-proof storage against a database administrator. Backups and database access controls still matter.

## Coordination transactions

All short domain mutations acquire one Postgres transaction advisory lock. This deliberately serializes cross-item decisions, including dependency readiness and workspace reservations, across API replicas. Remote calls never hold that lock. The first implementation chooses an easily audited concurrency model; measure contention before replacing it with finer-grained locking.

Work requirements and dependency edges are revisable by the human operator (or, additively, by a scoped operator agent) with an expected policy revision and audit reason. Revisions refuse active ownership and dependency cycles, preserve history, retire removed criterion IDs, and invalidate old acceptance and review authorization. Submitted work requires a new attempt. See [coordination](coordination.md); editing stored JSON directly is unsupported.

## Assignments and workspaces

A claim succeeds only for released, unblocked work with finished dependencies and no active lease. Time comes from Postgres. Every claim increments an epoch. Heartbeat, release, blocker, workspace, and submission commands require the current owner, epoch, and an unexpired lease.

Lease expiration makes an unsubmitted task recoverable. Old workspaces remain reserved and visible. A new attempt receives a fresh branch and path; Graphyard never silently deletes another attempt's files. A workspace location is `(host ID, absolute path)`. Set `GRAPHYARD_HOST_ID` when hostnames are not globally unique. A branch is reserved globally within the managed repository.

The CLI reserves before creating a worktree. A failed filesystem operation leaves a visible reservation. It is not compensated by destructive cleanup. This is an intentionally safe partial failure requiring local inspection.

## Candidates and evidence

A candidate is `(PR, head SHA, base SHA)`, independently read from GitHub and checked against the assigned branch. Gates evaluate the candidate together with the current policy revision and the criterion definitions. A push or base change invalidates matching requirements automatically because old evidence no longer matches the tuple.

Evidence carries the producer principal derived from authentication. A worker cannot self-assign trust. A producer credential has a live grant of exact proof names or bounded patterns. The human operator may attest `manual:` proofs, but cannot use an `admin` token to mint trusted automated test evidence. Latest submitted trusted evidence for each matching proof/candidate/policy wins, including a later failure. Historical and stale evidence remains visible.

CI check success proves that named check reported success. It does not prove test inventory. Acceptance evidence separately requires counts and named behavioral proofs. A trusted producer is responsible for deriving these counts from actual reports and binding them to the actual tested code. Graphyard cannot determine whether an assertion adequately expresses product intent.

## Reconciliation

The server runs a non-overlapping tick every two seconds. It expires leases and reevaluates affected state, then processes up to four available GitHub jobs concurrently. A successful job becomes eligible again after 20 seconds; a failed job after 45 seconds. These timings are MVP defaults, not latency guarantees under a large backlog. Add replicas or adjust batching after measuring real load.

Signed webhooks deduplicate delivery IDs and wake jobs. Their payload is a notification, not trusted workflow truth: the worker refetches GitHub data. Periodic polling catches missed webhooks. Observation application compares the work revision read before external I/O to the current revision; concurrent changes force a retry.

Applying an observation also requires the integration job's unexpired owner token. Check publication rechecks that token, the current work revision, and observation freshness after provider reads and immediately before writing. The adapter rereads the PR after collecting evidence and refuses a changed head, base, draft, or open/closed state. These checks narrow races; they do not make the provider write atomic with Postgres.

Each job wake increments a generation. If evidence or a webhook arrives during a running job, acknowledgment preserves an immediate retry instead of overwriting the wake with the normal polling delay. Expired owners cannot acknowledge jobs. Authorized completed work removes its polling job.

GitHub observations older than two minutes refuse the merge gate. Actual GitHub check revocation is asynchronous and cannot be guaranteed during outages. See the [external enforcement boundary](github.md#enforcement-boundary).

## Display state and history

The graph shows the first refusing stage; the card contains all refusal reasons. A blocker annotates work without introducing a separate lifecycle node. Delivered work stays historically delivered. A merge observed with unsatisfied gates creates a permanent visible violation and does not become done when missing evidence arrives later.

The board is a view of evaluated state. There is no drag-to-done API. Current dwell metrics measure how long items have been in their present stage; they are not historical throughput percentiles.

Before a merge can complete work, Graphyard must have recorded an authorization for the same head, base, and policy and a final GitHub verification under a short-lived, single-use execution authority. While that authority is active, requirement, evidence, validation, reconciliation, and non-matching observation mutations are refused. Final verification is a transactional, idempotent mutation that re-evaluates the current GitHub observation, records its timestamp, and must precede the provider-reported merge interval. This freezes the control-plane decision while the external GitHub merge runs without holding a database transaction open. A confirmed failed client cancels the authority; an abandoned or uncertain attempt expires. The engine consults ledger snapshots at the reported merge time, so an outage or later failure does not erase historical authorization. The delivery record references the authorization revision and observed merge SHA. Later differing checks remain visible as a follow-up warning.

Merge completion is not production delivery. Releases, expected-release selection and append-only deployment observations are separate records with their own authority boundaries, and an environment's verification is derived by a bounded, cursor-resumable sweep over what service-scoped observers measured; see [releases and observed production delivery](delivery.md). A verified release attributes its included members once per environment in `releaseDeliveries`, beside — never instead of — the merge record.

Evidence received after an earlier merge cannot retroactively invent approval. A direct external merge without a verified execution authority remains visible as an unauthorized merge and cannot complete the work item. Because GitHub reports merge time with whole-second precision, the master waits until the next timestamp boundary after final verification before invoking the provider. Artifact verification remains necessary to prove that the merged artifact itself was tested.

## Why no workflow framework yet?

LangGraph would be appropriate inside an agent runtime; Graphyard is runtime-independent and runs no agent sessions itself. Temporal could eventually run long-lived deployment/rollback activities. The MVP has a small set of short database commands and repeatable external observations. Postgres transactions and durable retries cover that workload while keeping deployment to two services. Domain invariants remain Graphyard's responsibility whichever execution mechanism is used.
