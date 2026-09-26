<!-- page: Operate Graphyard | 11 | leads and escalations. -->
# Slice-lead delegation

Optional slices (`product`, `infrastructure`, `docs-experience`) are each led by an AI session with its own `slice-lead` principal.

## Authority boundaries

A lead coordinates its slice's workers, approves or rejects plans, sends work back and escalates; it cannot implement, claim, submit evidence, review its own slice, change requirements or merge (`lead.action.refused`). `reject-plan` and `send-back` record a **lead hold** that refuses the merge gate: a `reject-plan` clears only through a later `approve-plan` from that lead with `"supersedes": "RULING-ID"`, a `send-back` only through `rework`.

A producer that ever held an assignment on the item, or belongs to its slice, is refused (`evidence.producer.refused`). Capacity limits are [deployment variables](deployment.md#variables).

## Escalation

| Trigger | Raised when |
| --- | --- |
| `lease-loss` | A worker lease lapses with no submission, no carried `blocked` report, no stopped-worker attestation and no provider-exhaustion record. |
| `evidence-policy-conflict` | Trusted evidence arrives for another policy revision. |
| `security-concern` | A lead files an `escalate` ruling naming it. |
| `requirement-weakening` | A revision retires a criterion or narrows its proofs. |

An unresolved trigger drops merge authorization and refuses the merge gate; raising one dequeues the head. A lapse the ledger explains is instead a `lease.expired` entry with its [cause](protocol/leases.md#how-a-lease-ends): `submitted`, `blocked-awaiting-operator`, `stopped-by-attestation` or `exhausted-capacity`. Reconciliation auto-settles a later-explained `lease-loss`, recording `escalation.auto-settled` with a note (`auto-settled: blocked report for epoch N explains the lapse` or `auto-settled: stopped-worker attestation for epoch N explains the lapse`). A replacement worker may claim meanwhile; delivery waits.

### Who may settle what

Each resolution records `escalation.resolved`: resolver, session kind, reason, attestation.

- `lease-loss` for a lapse the ledger explains: reconciliation, or any `admin` with `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`.
- Control-plane `lease-loss` of a superseded or stopped epoch: the loop's two-party decision, stale if the superseding lease lapses.
- `security-concern`, `requirement-weakening`, `evidence-policy-conflict`, and any `lease-loss` a lead raised: a two-party decision the master requests, or a declared human session.

A declared human session (`admin`, `sessionKind: "human"`) settles any. A two-party `master decide GY-N resolve` applies once an independent approver approves; nobody resolves alone.
