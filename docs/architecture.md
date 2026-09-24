<!-- page: Understand or contribute | 1 | the correctness model behind ownership, evidence, and gates. -->
# Architecture and correctness model

The technical reference for Graphyard's invariants and storage. For a plain-language tour, start with [How Graphyard works](how-graphyard-works.md).

## Boundary

Graphyard owns coordination decisions. Git owns source history. GitHub owns PR and merge facts. Herdr and other runtimes host agent sessions. Proof producers produce evidence. A gate is a deterministic evaluation, never an LLM judgment. Terms are in the [glossary](glossary.md).

![Graphyard control-plane components: agent sessions, the dashboard and proof producers call the HTTP API and CLI under their own principals; the coordination engine runs one advisory-locked transaction per mutation against Postgres; a reconciliation worker ticks every two seconds, exchanges facts with GitHub, publishes the required check and runs the guarded merge. Webhooks only wake jobs.](diagrams/control-plane-components.svg)

Text equivalent of the diagram: agent sessions (violet), the dashboard (amber) and a proof producer (green) call the **HTTP API and CLI**; commands go to the **coordination engine**, one advisory-locked transaction per mutation with no external I/O; it writes the aggregate and an event to **Postgres**; the **reconciliation worker** leases jobs, exchanges facts with **GitHub** (grey, two-headed arrow), publishes the required check and runs the guarded merge; a dashed arrow marks the signed webhook, which only wakes a job. Legend: [diagram legend](glossary.md#diagram-legend).

## Storage

- `work_items.document` is the current aggregate (intent, requirements, assignment, workspaces, candidate, evidence, gates, observed facts). Each mutation appends an event with the new snapshot in the same transaction; `events.seq` defines order.
- `receipts` stores each command's result under `(principal, idempotency key)` and a fingerprint. Retries replay; a reused key with different input refuses. A replayed claim is not a renewed lease.
- `jobs` is the durable integration queue, created with PR submission and processed with `FOR UPDATE SKIP LOCKED`; GitHub calls happen outside coordination transactions.
- Release, delivery and validation tables support [delivery](delivery.md) and [recovery](recovery.md); `flow_facts`, `deployment_observations` and the [attribution](attribution.md) tables feed analytics only and never gates.

Triggers reject updates and deletes to the event ledger — an application audit guarantee, not tamper-proofing against a database administrator.

## Coordination transactions

All domain mutations take one Postgres advisory lock, serializing cross-item decisions (dependency readiness, workspace reservations) across replicas. Remote calls never hold it.

Requirements and dependency edges are revised by the operator (or additively by a scoped operator agent) with an expected policy revision and a reason. Revisions refuse active ownership and cycles, retire removed criterion IDs and invalidate old acceptance and review. See [coordination](coordination.md).

## Assignments and workspaces

A claim succeeds only for released, unblocked work with finished dependencies and no active lease; time comes from Postgres and every claim increments the epoch. Heartbeat, release, blocker, workspace and submission commands require the current owner, epoch and an unexpired lease.

An expired lease makes unsubmitted work recoverable. Old workspaces stay reserved; a new attempt gets a fresh branch and path, and Graphyard never deletes another attempt's files. A workspace is `(host ID, absolute path)` (set `GRAPHYARD_HOST_ID` if hostnames collide).

## Candidates and evidence

A candidate is `(PR, head SHA, base SHA)`, read from GitHub and checked against the assigned branch. Gates evaluate it with the current policy revision; a push or base change invalidates old evidence automatically.

Evidence carries the producer principal derived from authentication; a worker cannot self-assign trust. A producer has a live grant of exact proof names or bounded patterns. `admin` may attest `manual:` proofs but cannot mint automated evidence. The latest trusted evidence per proof/candidate/policy wins, including a later failure. E2E reuse across heads requires a recorded decision under an operator policy ([evidence reuse](evidence-reuse.md)).

A CI check proves only that the named check reported success. Acceptance evidence separately requires counts and named behavioral proofs derived by a trusted producer from real reports.

## Inverted coordination: typed actions and stateless executors

The control plane names what each item needs next as one typed action: `nextAction` (`src/model/next-action.ts`), pure over the item, its graph and the clock.

Kinds: `dispatch`, `request-review`, `request-rework`, `approve-scope`, `resync`, `reclaim`, `merge`, `verify-deployment` and `escalate`. Every gate refusal maps to exactly one kind through `refusalAction`, whose last rule matches everything, so an unmapped refusal escalates rather than going silent. Review refusals are classified by `reviewNeed`:

| What `reviewNeed` found | Action |
| --- | --- |
| Changes requested on exactly this head | `request-rework` |
| Head does not contain the base tip | `resync` |
| Provider review dispatched by the control plane (`codex`, `agent`) | `resync` |
| Every reviewer profile exhausted | `escalate` |
| An approval is missing (`github`) | `request-review` |

A base that cannot merge cleanly is `request-rework`. A fenced item (unsettled containment quarantine) with no live lease is `escalate`, because only a judgment that the worker stopped can lower the fence.

Each outstanding action is a durable row on the aggregate (`src/model/actions.ts`), with an id hashed from kind, item and situation. An executor claims a row under its own name and credential for a bounded lease, renews while running, and only that pair may settle it; a dead executor's claim expires and its late settlement is refused, so actions retry without double execution.

**Stalls.** Three consecutive failures with an unchanged reason classify a row as stalled rather than retrying (`src/model/action-progress.ts`). A different reason ends the run. Before this, a row in backoff appeared in no count and no list, so an item owing an impossible action read exactly like an item with nothing to do. The queue snapshot now counts every open row, `master status` raises one attention item per stall, and the dashboard shows it on the item's card. A stalled row rechecks every minute instead of its attempt-count interval, so backoff earned while a blocking condition stood does not outlive it.

**Executors are stateless.** Each holds a credential, a host name and a handler per kind; it claims one row, runs it, reports, and keeps nothing. Any number on any hosts share the queue. `scripts/graphyard-executor.mjs` is the shipped one. `actionJudgment` classifies kinds as `none`, `in-session` (launches a session that does the judging) or `in-step`; the `in-step` kinds `escalate` and `request-rework` may never have a handler, so the loop itself makes no judgment.

**Workers pull.** A free session calls `POST /api/assignments/claim` (`scripts/graphyard-pull.mjs`) and claims under its own identity; one idempotency key claims at most one item.

A typed agent request (`src/model/agent-requests.ts`) replaces a blocking prose question: it names its decider and ends the attempt. A session handle (`src/model/sessions.ts`) records where a session runs and how to attach. The fleet polls the bounded view in `src/server/work-view.ts`.

None of this authorizes progression: an action is a fact about what is missing; gates still decide from evidence and verdicts.

## Reconciliation

A tick every two seconds expires leases and processes up to four GitHub jobs (repeat after 20 seconds at the head of the merge queue, five minutes otherwise, 45 seconds after a failure). Signed webhooks only wake the named jobs; their payload is never trusted. Applying an observation needs the job's owner token and an unchanged work revision. Observations older than two minutes refuse the merge gate ([enforcement boundary](github.md#enforcement-boundary)).

## Display state and history

The graph shows the first refusing stage; there is no drag-to-done API. A merge observed with unsatisfied gates is a permanent visible violation.

Before a merge completes work, Graphyard records an authorization for the same head, base and policy and a final GitHub verification under a short-lived, single-use execution authority; mutations that could change the decision are refused while it is active ([evidence revocation](protocol/evidence.md#revocation) cancels it). A direct external merge without that authority stays an unauthorized merge. Merge is not production delivery: see [releases and observed production delivery](delivery.md).
