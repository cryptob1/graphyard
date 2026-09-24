<!-- page: Operate Graphyard | 6 | bounded product, infrastructure, and docs/experience coordination. -->
# Slice-lead delegation

Graphyard can split delivery into three slices: **product**, **infrastructure** and **docs/experience** (`docs-experience` in API data). A slice lead is an AI coordinator session with its own `slice-lead` principal, never a worker, reviewer, proof producer or merge authority. Slices are optional.

## Authority boundaries

A lead may coordinate workers in its slice, approve or reject plans, classify failures, request reruns, send work back and escalate. Every ruling is append-only, with a versioned rule ID, a reason and an `Idempotency-Key`.

A lead cannot implement, claim, submit evidence, review its own slice, change requirements, bypass a gate or merge; the server refuses and records `lead.action.refused`. A ruling against delivered work is refused; record a follow-up item.

Human-only intake origins require a **declared human session**: an `admin` credential declaring `sessionKind: "ai"`, or nothing, is refused; routine intake is unaffected. Leads must escalate security concerns, suspected requirement weakening, evidence-policy conflict and lease loss.

## Blocking rulings and their recovery

`reject-plan` and `send-back` record a **lead hold** in the same transaction: merge authorization is dropped, the `merge` gate refuses, and the merge broker refuses independently. `send-back` outranks `reject-plan`; a later ruling may raise a hold, never weaken it.

| Standing hold | Authorized recovery |
| --- | --- |
| `reject-plan` | A later `approve-plan` from the same lead with `"supersedes": "RULING-ID"` naming that rejection. |
| `send-back` | Only a `rework` decision (`graphyard rework GY-N --previous-worker-stopped REASON`), which reopens implementation. |

An approval naming any other ruling, or none, is refused. Clearing a hold does not mint authorization; delivery resumes only when every gate passes again.

## Independent proof producers

Trusted evidence comes from a `producer` independent of the implementation and the lead, bound to the exact head, base and policy revision. A submission is refused (`evidence.producer.refused`) when the identity has ever held an assignment on the item, holds `slice-lead` authority, or is bound to the item's slice. Independence is standing: a producer that later takes an assignment on the item stops counting at the next evaluation. Producer credentials may not declare a `slice` or reuse a lead's ID.

## Escalation

| Trigger | Raised when |
| --- | --- |
| `lease-loss` | A worker lease lapses on an epoch with no submission, no carried `blocked` report, no stopped-worker attestation and no provider-exhaustion record: a worker that silently vanished. |
| `evidence-policy-conflict` | Trusted evidence arrives for a policy revision other than the current one. |
| `security-concern` | A lead files an `escalate` ruling naming it. |
| `requirement-weakening` | A revision retires a criterion or narrows its proofs. |

A lead never overwrites or clears an escalation. Each trigger stands alone (at most one unresolved each), listed in `escalations`, refusing the `merge` gate until resolved.

A lapse the ledger explains is a `lease.expired` history entry with its cause, not an escalation:

- `submitted` — `complete` ended the lease.
- `blocked-awaiting-operator` — the worker reported `blocked` for that epoch.
- `stopped-by-attestation` — an admin `rework` or `recover-containment --previous-worker-stopped` for that epoch.
- `exhausted-capacity` — the loop recorded the account had no quota (`capacity.exhausted`).

Reconciliation auto-settles a control-plane `lease-loss` whose epoch is later explained, recording `escalation.auto-settled` with a note such as `auto-settled: blocked report for epoch N explains the lapse (blocked by WORKER at TIME)` or `auto-settled: stopped-worker attestation for epoch N explains the lapse (rework by ADMIN at TIME)`. A replacement worker may claim while a `lease-loss` stands; delivery waits.

### An unresolved escalation refuses delivery

Raising one drops merge authorization. Clear it with `graphyard resolve GY-N TRIGGER "reason"` carrying `expectedRevision`; the `escalation.resolved` event records the incident, resolver, session kind, reason and any attestation cited.

### Who may settle what

| Standing escalation | Settled by |
| --- | --- |
| `lease-loss` raised by the control plane for a lapse the ledger explains | Reconciliation automatically, or any `admin` with `resolve GY-N lease-loss --attestation blocked\|stopped-worker "reason"` (verified against the ledger for that epoch), or a declared human session. |
| `lease-loss` for a lapse nothing explains | A declared human session only. |
| `security-concern`, `requirement-weakening`, `evidence-policy-conflict`, and any `lease-loss` a lead raised | A declared human session only; an `ai` or undeclared `admin` is refused. |

No lead, worker, producer, coordinator or scoped operator agent may resolve an escalation.

### A concern raised mid-merge fences the execution

Raising an escalation or blocking ruling fences any in-flight merge execution in the same transaction; the broker re-reads the item just before calling GitHub and refuses a fenced execution.

## Ownership and worktrees

Each claimed item is held by one worker identity under one lease epoch in one registered worktree, renewed by its `watch` supervisor; any other identity, epoch or worktree, and any renewal after `complete`, is refused. A worker may hold several items in a slice. A standing escalation does not stop a replacement being dispatched ([master-agent](master-agent-reference.md#a-concern-carried-beside-the-work)).

## Capacity and identity

Defaults: three slice leads, two engineers per lead, one to two shared independent review/proof agents. Capacity counts engineers, not leases. Override with `GRAPHYARD_MAX_SLICE_LEADS`, `GRAPHYARD_MAX_ENGINEERS_PER_LEAD`, `GRAPHYARD_MIN_REVIEWERS` and `GRAPHYARD_MAX_REVIEWERS`. Every `role: "producer"` credential, including [delivery](delivery.md) builder, observer and promoter identities, counts toward the review/proof limit; the server refuses to start above it.

Lead credentials use `role: "slice-lead"`, `sessionKind: "ai"` and a `slice`; a person's operator credential declares `sessionKind: "human"`. Principal IDs and tokens are unique; declare `sessionKind` on every credential.

## Dashboard and reads

The **Delivery slices** panel shows each slice's lead, engineers, workers and bottlenecks. `GET /api/delegation` follows the ordinary read scope.
