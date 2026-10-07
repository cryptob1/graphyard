<!-- page: Operate Graphyard | 11 | leads and escalations. -->
# Slice-lead delegation

## Authority boundaries

An AI `slice-lead` leads an optional slice (`product`, `infrastructure`, `docs-experience`): rules on plans, sends back, escalates; never implements, reviews, proves or merges (`lead.action.refused`). `reject-plan`/`send-back` hold the merge gate (**lead hold**) until that lead's `approve-plan` with `"supersedes": "RULING-ID"` / `rework`.

Producers ever assigned the item or in its slice: `evidence.producer.refused`. Limits: [deployment variables](deployment.md#variables).

## Escalation

| Trigger | Raised when |
| --- | --- |
| `lease-loss` | A lapse with no submission, no carried `blocked` report, no stopped-worker attestation, no provider-exhaustion record |
| `evidence-policy-conflict` | Trusted evidence for another policy revision |
| `security-concern` | A lead's `escalate` ruling |
| `requirement-weakening` | A revision retires a criterion or narrows proofs |

Unresolved triggers refuse the merge gate. A `requirement-weakening` raised by applying an approved two-party decision records that decision's id, is resolved by that same approval and is no `scope` fault: the approver already judged the weakening. Explained lapses are `lease.expired` with a [cause](protocol/leases.md#how-a-lease-ends) (`submitted`, `blocked-awaiting-operator`, `stopped-by-attestation`, `exhausted-capacity`); later-explained `lease-loss` auto-settles (`escalation.auto-settled`: `auto-settled: blocked report for epoch N explains the lapse`, `auto-settled: stopped-worker attestation for epoch N explains the lapse`). Meanwhile a replacement may claim; delivery waits.

### Who may settle what

Resolutions record `escalation.resolved`.

- Explained `lease-loss`: reconciliation, or `admin` `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`.
- Control-plane `lease-loss` whose lost attempt can no longer act (superseded by a newer held/submitted epoch, or ended with no lease and no containment fence): reconciliation auto-settles it after 5 min standing (`auto-settled: … nothing from the lost attempt can act or merge`); no approver round. Its own standing fence keeps it waiting.
- `security-concern`, `requirement-weakening`, `evidence-policy-conflict`, or a lead-raised `lease-loss`: master-requested two-party decision, or a declared human session (`admin`, `sessionKind: "human"`; settles any).
- `requirement-weakening` raised by applying an approved `requirements` decision: that approval, citing the decision and approver.
