<!-- page: Understand or contribute | 1 | the correctness model behind ownership, evidence, and gates. -->
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

`flow_facts` is a normalized, append-only projection of the ledger and of observed provider facts, with its own checkpoint and per-item projection state. It exists so delivery metrics survive upstream retention: a deleted pull request or pruned deployment record cannot erase a fact Graphyard already observed. `deployment_observations` records deployment-provider facts from a `producer` or `admin` credential. Both are read only by [flow analytics](flow-analytics.md) and never participate in gate evaluation. `attribution_records` and `attribution_reanchors` are the append-only [attribution](attribution.md) ledger and its re-anchor fence, written only by validation and observation ingest; the analytics read them and no route writes them.

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

An executed E2E pass may stand for a later head of the same item only through a recorded reuse decision under an operator-defined applicability policy over Graphyard's own file observations, bound to the exact revisions and superseded by any newer live attempt; a replay of retained artifacts is an audit record that authorizes nothing. See [evidence replay, scoped reuse and execution analytics](evidence-reuse.md).

CI check success proves that named check reported success. It does not prove test inventory. Acceptance evidence separately requires counts and named behavioral proofs. A trusted producer is responsible for deriving these counts from actual reports and binding them to the actual tested code. Graphyard cannot determine whether an assertion adequately expresses product intent.

## Inverted coordination: typed actions and stateless executors

Every read already evaluates the gates. The control plane therefore names what each item needs
next, as one typed action, instead of leaving a coordinator session to read a status report and
decide. `nextAction` (`src/model/next-action.ts`) is pure over the item, its graph and the clock,
so two readers always agree without talking to each other.

Nine kinds exist: `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`,
`reclaim`, `merge`, `verify-deployment` and `escalate`. Each carries the inputs whoever runs it
needs — the head, base and policy revision for a review; the proof group and proof names for a
producer; the paths and requester for a scope answer. Every refusal any gate can raise maps to
exactly one kind through `refusalAction`, whose last rule matches everything, so a refusal nobody
wrote a rule for becomes an escalation rather than silence. Two refusals name no action for their
own item because they belong to another: an unfinished dependency is that dependency's dispatch,
and a queue position is the predecessor's merge.

A refusal is classified from the item, not from its text alone, because the same sentence can
stand for different situations. The review gate always refuses with "approval is required", but
`reviewNeed` may already have decided that no review can be asked for this head: a reviewer has
requested changes on it, so the item owes a new one (`request-rework`), or the head does not
contain the base tip, so any approval would be dismissed and a base refresh is what it waits for
(`resync`). A base the control plane could not merge in cleanly is named `request-rework` for the
same reason — its own refusal says to resolve the conflict and push, and that the approval and
proofs bound to that head do not survive the resolution, which no mechanical step can do. Naming
an action nobody can complete is the failure mode this mapping exists to prevent: the row would
be claimed, fail or complete without effect, and come back forever while the item is never shown
as owing a judgment.

Each outstanding action is a durable row on the work aggregate (`src/model/actions.ts`), written
inside the same advisory-locked transaction as every other decision. A row's id is a hash of what
it binds — kind, item, situation — never of when it was made, so a re-derivation after a restart
recognises the row it already has. An executor claims a row under its own identity for a bounded
lease; only that claim may settle it. An executor that dies renews nothing, its claim expires, the
next executor takes the row as a further attempt, and the dead one's late settlement is refused —
so an interrupted action is retried without being executed twice. Every transition records the
requester, the executor, the result and the reason on the row.

A claim is a bounded lease, not a bounded handler: an executor still inside one renews the claim
while it runs, so a dispatch that waits on a runtime or a merge that chains provider calls keeps
its row, and only an executor that stopped renewing loses it. A renewal carries no result and is
accepted from nobody but the live claim's own executor and credential.

A claim records the executor's self-asserted name *and* the credential it was made with, and only
that pair may settle the row. Several executors behind one coordinator credential is an ordinary
deployment, and a settlement under the wrong name would be refused after the handler had already
run — the claim would then expire and the action run a second time, which is exactly what the lease
exists to prevent. A row whose claim is still live is never retired even when the situation has
moved on, because running the action is usually what moved it: the executor still owes a result,
and the row the item now needs is opened beside it.

Executors are stateless. One holds a credential, a host name, and a handler per action kind it can
run; it claims one row, runs it, reports the result, and keeps nothing. Any number of them on any
number of hosts drive the same queue and never coordinate with each other.
`scripts/graphyard-executor.mjs` is the one Graphyard ships: it launches worker, reviewer and
producer sessions, applies the scope rule, re-reads a pull request, brokers the guarded merge and
records a deployment reading.

An executor claims only the kinds it has a handler for, which is what keeps judgment out of the
loop itself. `actionJudgment` classifies every kind: `none` is mechanical end to end, `in-session`
launches a session and walks away — the model works inside it, under its own credential — and
`in-step` means running the action *is* the judgment. The two `in-step` kinds, `escalate` and
`request-rework`, may never have a handler, and the executor entry point refuses one that does, so
a full ready-to-delivered cycle runs with no judgment anywhere in the loop. `llmRole` on each
action names the judgment inside what it starts — implement, review, produce evidence, approve a
two-party decision, resolve an escalation — and is null for the five mechanical kinds.

Workers pull. A free session asks `POST /api/assignments/claim` (`scripts/graphyard-pull.mjs`) for
its next assignment and claims it under its own identity through the ordinary claim rules; the control plane
offers the items it already names as needing a dispatch, in dispatch order. Nothing tracks which
session is alive. A pull is idempotent on its own key, and one key can claim at most one item: the
claim and its receipt are written in the same transaction, a retry replays that receipt, and a
concurrent retry that reaches another offer first is refused for reusing the key with different
input and replays the winner's assignment. The shipped worker keeps one key across its transport
retries, which is what makes the replay reachable when a pull times out after its claim committed.

Two more records make the fleet legible without a relaying coordinator. A typed agent request
(`src/model/agent-requests.ts`) is what a session records instead of blocking on a prose question:
one of `scope-request`, `decision`, `blocker`, `note` or `escalation`, each naming its decider — a
deterministic rule, an independent approver agent, a tracked follow-up item, or one of the three
human-only decisions — and the attempt ends in the same transaction, so the item is free rather
than held at a prompt. Recording one is the same write as the command it replaces, so it carries
the same authority: every type but `note` needs the live lease of the attempt that is asking, and
only the decider the record names may close it. A session handle (`src/model/sessions.ts`) records
where a launched session runs: runtime, host, Herdr workspace, tab and pane, and its transcript,
with the one command or link that attaches to it. Every launcher writes what it knows and names
whose session it is, and that session adds the tab and transcript only it knows, onto the same
record; updating a handle that exists is the named session's, its launcher's or an admin's, because
the attach command on it is an instruction an operator runs.

A merge brokered from the loop is owned by the executor instance that acquired it, never by the
coordinator principal alone, so a daemon, an interactive merge and any number of executors sharing
one credential stand down from each other's in-flight executions instead of resuming them.

What the fleet polls is the bounded coordination view of the work snapshot
(`src/server/work-view.ts`), never whole documents. Inverting the loop multiplies that read: one
master session asking every few seconds becomes the cycle, the dispatcher and every executor
asking, so the view carries the decision state and nothing only a report consults — evidence
without artifacts or per-file scope, the observation without its scope comparison, resolved
requests, resolved action rows and queue entries bounded to the most recent, and no pipeline
timeline. For the same reason the ledger reconstruction that rebuilds those timelines rides the
full read whose speed report it feeds (`master status`) and never the poll: a maintenance walk in
front of the claim path would be paid more often the more executors joined.

None of this authorizes progression. An action is a fact about what is missing; the gates still
decide from evidence and verdicts alone.

## Reconciliation

The server runs a non-overlapping tick every two seconds. It expires leases and reevaluates affected state, then processes up to four available GitHub jobs concurrently. A successful job becomes eligible again after 20 seconds; a failed job after 45 seconds. These timings are MVP defaults, not latency guarantees under a large backlog. Add replicas or adjust batching after measuring real load.

Signed webhooks deduplicate delivery IDs and wake jobs. Their payload is a notification, not trusted workflow truth: the worker refetches GitHub data. Periodic polling catches missed webhooks. Observation application compares the work revision read before external I/O to the current revision; concurrent changes force a retry.

Applying an observation also requires the integration job's unexpired owner token. Check publication rechecks that token, the current work revision, and observation freshness after provider reads and immediately before writing. The adapter rereads the PR after collecting evidence and refuses a changed head, base, draft, or open/closed state. These checks narrow races; they do not make the provider write atomic with Postgres.

Each job wake increments a generation. If evidence or a webhook arrives during a running job, acknowledgment preserves an immediate retry instead of overwriting the wake with the normal polling delay. Expired owners cannot acknowledge jobs. Authorized completed work removes its polling job.

GitHub observations older than two minutes refuse the merge gate. Actual GitHub check revocation is asynchronous and cannot be guaranteed during outages. See the [external enforcement boundary](github.md#enforcement-boundary).

## Display state and history

The graph shows the first refusing stage; the card contains all refusal reasons. A blocker annotates work without introducing a separate lifecycle node. Delivered work stays historically delivered. A merge observed with unsatisfied gates creates a permanent visible violation and does not become done when missing evidence arrives later.

The board is a view of evaluated state. There is no drag-to-done API. Its dwell figures measure how long items have been in their present stage. Historical distributions, phase durations, and throughput percentiles live in [flow analytics](flow-analytics.md), which reads the durable projection rather than the current documents.

All user-facing durations with these elapsed-time semantics — the work card age, the delivery graph's oldest and p50/p95 values, the merge queue wait, and post-deploy time in the graph and drawer — render through the one shared formatter in `web/duration.ts`. Its rule is deterministic: inputs are minutes of elapsed time, truncated to whole minutes before decomposition (never rounded up). Below 60 minutes it renders `Xm`; from 60 minutes through under 48 hours it renders `Xh Ym`; at 48 hours and above it renders `Xd Yh`. Zero components are omitted, so 1440 minutes remains `24h`, while 894 minutes renders `14h 54m` and 3060 minutes renders `2d 3h`. Missing or invalid input renders the unknown marker `—` and negative values clamp to `0m`, so the formatter can never emit negative or NaN text; stages with no items keep their `Clear` state. The visible strings are the accessible text, and labels describe what the percentiles summarize.

Before a merge can complete work, Graphyard must have recorded an authorization for the same head, base, and policy and a final GitHub verification under a short-lived, single-use execution authority. While that authority is active, requirement, evidence, validation, reconciliation, and non-matching observation mutations are refused; [evidence revocation](protocol/evidence.md#revocation) is the deliberate exception and cancels the authority instead of waiting for it. Final verification is a transactional, idempotent mutation that re-evaluates the current GitHub observation, records its timestamp, and must precede the provider-reported merge interval. This freezes the control-plane decision while the external GitHub merge runs without holding a database transaction open. A confirmed failed client cancels the authority; an abandoned or uncertain attempt expires. The engine consults ledger snapshots at the reported merge time, so an outage or later failure does not erase historical authorization. The delivery record references the authorization revision and observed merge SHA. Later differing checks remain visible as a follow-up warning.

Merge completion is not production delivery. Releases, expected-release selection and append-only deployment observations are separate records with their own authority boundaries, and an environment's verification is derived by a bounded, cursor-resumable sweep over what service-scoped observers measured; see [releases and observed production delivery](delivery.md). A verified release attributes its included members once per environment in `releaseDeliveries`, beside — never instead of — the merge record.

Evidence received after an earlier merge cannot retroactively invent approval. A direct external merge without a verified execution authority remains visible as an unauthorized merge and cannot complete the work item. Because GitHub reports merge time with whole-second precision, the master waits until the next timestamp boundary after final verification before invoking the provider. Artifact verification remains necessary to prove that the merged artifact itself was tested.

## Why no workflow framework yet?

LangGraph would be appropriate inside an agent runtime; Graphyard is runtime-independent and runs no agent sessions itself. Temporal could eventually run long-lived deployment/rollback activities. The MVP has a small set of short database commands and repeatable external observations. Postgres transactions and durable retries cover that workload while keeping deployment to two services. Domain invariants remain Graphyard's responsibility whichever execution mechanism is used.
