<!-- page: Operate Graphyard | 11 | leads, escalations. -->
# Slice-lead delegation

## Authority boundaries

An AI `slice-lead` leads an optional slice (`product`, `infrastructure`, `docs-experience`): rules on plans, sends back, escalates; never implements, reviews, proves or merges. `reject-plan`/`send-back` hold the merge gate until `approve-plan` with `"supersedes": "RULING-ID"` or `rework`; producers once assigned the item or in its slice are refused, and limits are [deployment variables](deployment.md#variables).

## Escalation

| Trigger | Raised when |
| --- | --- |
| `lease-loss` | A lapse with no submission, no carried `blocked` report, no stopped-worker attestation, no provider-exhaustion record |
| `evidence-policy-conflict` | Trusted evidence for another policy revision |
| `security-concern` | A lead's `escalate` ruling |
| `requirement-weakening` | A revision retires or narrows a criterion |

Unresolved triggers refuse the merge gate. Explained lapses are `lease.expired` with a [cause](protocol/leases.md#how-a-lease-ends) (`blocked-awaiting-operator`, `stopped-by-attestation`, …); a later-explained `lease-loss` auto-settles (`auto-settled: blocked report for epoch N explains the lapse`, `auto-settled: stopped-worker attestation for epoch N explains the lapse`).

### Who may settle what

Resolutions record `escalation.resolved`.

- Explained `lease-loss`: reconciliation, or `admin` `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`.
- `lease-loss` of a superseded epoch: the loop's two-party decision.
- `security-concern`, `requirement-weakening`, `evidence-policy-conflict`, or a lead-raised `lease-loss`: master-requested two-party decision, or a declared human session (`admin`, `sessionKind: "human"`).
- `requirement-weakening` from an approved `requirements` decision: that approval.
