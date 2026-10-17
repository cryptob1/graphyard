<!-- page: Operate Graphyard | 11 | leads, escalations. -->
# Slice-lead delegation

## Authority boundaries

A `slice-lead` (`product`, `infrastructure`, `docs-experience`) rules on plans, sends back or escalates, never implements, reviews, proves or merges (`lead.action.refused`). `reject-plan`/`send-back` hold merging (**lead hold**) until that lead's `approve-plan` with `"supersedes": "RULING-ID"` or `rework`. Producers ever assigned the item or slice: `evidence.producer.refused`. [Limits](deployment.md#variables).

## Reviewer provider diversity

A `reviewer` account's `provider` (else launch kind) must differ from the item's newest `worker` session's; same-provider accounts are `skipped` (`shares the implementer's provider P on GY-N`) or, at a session limit, waited for; else the first eligible same-provider.

`worker` tries Pi for an item's first two attempts unless a `plannedFiles` entry or scope may hold a sensitive path ([risk class](delivery.md#managed-repositories), lane aside); unplanned changes, later attempts and two failed starts wait for strong accounts.

## Escalation

| Trigger | Raised when
| --- | ---
| `lease-loss` | A lapse with no submission, no carried `blocked` report, no stopped-worker attestation, no provider exhaustion
| `evidence-policy-conflict` | Trusted evidence for another policy revision
| `security-concern` | A lead's `escalate` ruling
| `requirement-weakening` | A revision retires a criterion, narrows proofs

Unresolved triggers refuse merging; replacements may claim. An explained lapse (`lease.expired` [cause](protocol/leases.md#how-a-lease-ends): `blocked-awaiting-operator`, `stopped-by-attestation`…) or superseded `lease-loss` auto-settles (`escalation.auto-settled`: `auto-settled: blocked report for epoch N explains the lapse`, `auto-settled: stopped-worker attestation for epoch N explains the lapse`).

### Who may settle what

`escalation.resolved` records:

- Explained `lease-loss`: reconciliation, or `admin` `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`.
- Superseded-epoch `lease-loss`: reconciliation; all attempts ended unfenced: after 5 min.
- `security-concern`, `requirement-weakening`, `evidence-policy-conflict`, lead-raised `lease-loss`: master-requested two-party decision or declared human session (`sessionKind: "human"`).
- `requirement-weakening` from an approved `requirements` decision: settled by that approval, citing its approver; no `scope` fault or [intervention](dashboard.md).
