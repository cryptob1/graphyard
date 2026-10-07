<!-- page: Operate Graphyard | 11 | leads, escalations. -->
# Slice-lead delegation

## Authority boundaries

An AI `slice-lead` leads a slice (`product`, `infrastructure`, `docs-experience`): rules on plans, sends back, escalates; never implements, reviews, proves, merges (`lead.action.refused`). `reject-plan`/`send-back` hold merging (**lead hold**) until that lead's `approve-plan` with `"supersedes": "RULING-ID"` or `rework`. Producers ever assigned the item or in its slice: `evidence.producer.refused`. Limits: [deployment variables](deployment.md#variables).

## Escalation

| Trigger | Raised when |
| --- | --- |
| `lease-loss` | A lapse with no submission, no carried `blocked` report, no stopped-worker attestation, no provider exhaustion |
| `evidence-policy-conflict` | Trusted evidence for another policy revision |
| `security-concern` | A lead's `escalate` ruling |
| `requirement-weakening` | A revision retires a criterion, narrows proofs |

Unresolved triggers refuse the merge gate; a replacement may claim, delivery waits. Explained lapses are `lease.expired` with a [cause](protocol/leases.md#how-a-lease-ends) (`blocked-awaiting-operator`, `stopped-by-attestation`, …); a later-explained `lease-loss` auto-settles (`escalation.auto-settled`: `auto-settled: blocked report for epoch N explains the lapse`, `auto-settled: stopped-worker attestation for epoch N explains the lapse`).

### Who may settle what

`escalation.resolved` records each:

- Explained `lease-loss`: reconciliation, or `admin` `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`.
- `lease-loss` of a superseded/stopped epoch: loop two-party decision (stale once the superseding lease lapses).
- `security-concern`, `requirement-weakening`, `evidence-policy-conflict`, lead-raised `lease-loss`: master-requested two-party decision or declared human session (`admin`, `sessionKind: "human"`; settles any).
- `requirement-weakening` from applying an approved `requirements` decision: records its id; that approval settles it (citing decision, approver); no `scope` fault.
