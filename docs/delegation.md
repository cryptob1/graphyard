<!-- page: Operate Graphyard | 11 | leads and escalations. -->
# Slice-lead delegation

## Authority boundaries

An AI `slice-lead` leads an optional slice (`product`, `infrastructure`, `docs-experience`): it coordinates workers, rules on plans, sends work back and escalates, never implementing, claiming, submitting evidence, reviewing its slice, changing requirements or merging (`lead.action.refused`). `reject-plan` and `send-back` hold the merge gate (**lead hold**) until that lead's `approve-plan` with `"supersedes": "RULING-ID"`, or `rework`, respectively.

Producers ever assigned the item or in its slice are refused (`evidence.producer.refused`). Limits: [deployment variables](deployment.md#variables).

## Escalation

| Trigger | Raised when |
| --- | --- |
| `lease-loss` | A lapse with no submission, no carried `blocked` report, no stopped-worker attestation, no provider-exhaustion record. |
| `evidence-policy-conflict` | Trusted evidence for another policy revision. |
| `security-concern` | A lead's `escalate` ruling. |
| `requirement-weakening` | A revision retires a criterion or narrows proofs. |

An unresolved trigger drops merge authorization; raising one dequeues the head. An explained lapse is `lease.expired` with its [cause](protocol/leases.md#how-a-lease-ends) (`blocked-awaiting-operator`, `stopped-by-attestation`); a later-explained `lease-loss` auto-settles (`escalation.auto-settled`: `auto-settled: blocked report for epoch N explains the lapse`, `auto-settled: stopped-worker attestation for epoch N explains the lapse`). A replacement may claim; delivery waits.

### Who may settle what

Every resolution records `escalation.resolved` (resolver, session kind, reason, attestation).

- Explained `lease-loss`: reconciliation, or any `admin` via `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`.
- `lease-loss` of a superseded or stopped epoch: the loop's two-party decision (stale if the superseding lease lapses).
- `security-concern`, `requirement-weakening`, `evidence-policy-conflict`, or a lead-raised `lease-loss`: a master-requested two-party decision or a declared human session (`admin`, `sessionKind: "human"`), which settles any trigger. Nobody else resolves alone.
