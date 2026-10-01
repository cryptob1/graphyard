<!-- page: Operate Graphyard | 11 | leads, escalations. -->
# Slice-lead delegation

Optional slices (`product`, `infrastructure`, `docs-experience`) are each led by an AI `slice-lead`.

## Authority boundaries

A lead coordinates its slice's workers, plans, send-backs and escalations; it may not implement, claim, submit evidence, review its own slice, change requirements or merge (`lead.action.refused`). A `reject-plan` **lead hold** refuses the merge gate until that lead's `approve-plan` with `"supersedes": "RULING-ID"`; a `send-back` hold, until `rework`.

A producer ever assigned the item, or in its slice, is refused (`evidence.producer.refused`). Capacity limits: [deployment variables](deployment.md#variables).

## Escalation

| Trigger | When |
| --- | --- |
| `lease-loss` | A lapse with no submission, no carried `blocked` report, no stopped-worker attestation or provider-exhaustion record (else a `lease.expired` [cause](protocol/leases.md#how-a-lease-ends): `submitted`, `blocked-awaiting-operator`, `stopped-by-attestation`, `exhausted-capacity`). |
| `evidence-policy-conflict` | Trusted evidence for another policy revision. |
| `security-concern` | A lead's `escalate` ruling. |
| `requirement-weakening` | A revision retires a criterion or narrows proofs. |

An open trigger drops merge authorization, dequeues the head and refuses the merge gate; a replacement may claim, but not deliver.

### Who may settle what

Each resolution records `escalation.resolved` (resolver, session kind, reason, attestation).

- Later-explained `lease-loss`: reconciliation auto-settles it (`escalation.auto-settled`: `auto-settled: blocked report for epoch N explains the lapse` or `auto-settled: stopped-worker attestation for epoch N explains the lapse`), or any `admin` via `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`.
- Control-plane `lease-loss` of a superseded or stopped epoch: the loop's two-party decision, stale once the superseding lease lapses.
- `security-concern`, `requirement-weakening`, `evidence-policy-conflict`, lead-raised `lease-loss`: a master-requested two-party decision. A declared human session (`admin`, `sessionKind: "human"`) settles any trigger; nobody else resolves alone.
