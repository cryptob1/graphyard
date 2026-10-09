<!-- page: Operate Graphyard | 11 | leads, escalations. -->
# Slice-lead delegation

## Authority boundaries

An AI `slice-lead` (`product`, `infrastructure`, `docs-experience`) rules on plans, sends back, escalates; never implements, reviews, proves or merges (`lead.action.refused`). `reject-plan`/`send-back` hold merging (**lead hold**) until that lead's `approve-plan` with `"supersedes": "RULING-ID"` or `rework`. Producers ever assigned item or in its slice: `evidence.producer.refused`. [Limits](deployment.md#variables).

## Reviewer provider diversity

The registry picks a `reviewer` account whose model provider (`provider`, else launch kind) differs from the item's newest `worker` session's; same-provider accounts are `skipped` (`shares the implementer's provider P on GY-N`), one at its session limit waited for; else the first eligible same-provider account serves (`no reviewer account outside provider P can serve GY-N`).

## Escalation

| Trigger | Raised when
| --- | ---
| `lease-loss` | A lapse with no submission, no carried `blocked` report, no stopped-worker attestation, no provider exhaustion
| `evidence-policy-conflict` | Trusted evidence for another policy revision
| `security-concern` | A lead's `escalate` ruling
| `requirement-weakening` | A revision retires a criterion, narrows proofs

Unresolved triggers refuse merging; replacements may claim. Explained lapses: `lease.expired` with a [cause](protocol/leases.md#how-a-lease-ends) (`submitted`, `blocked-awaiting-operator`, `stopped-by-attestation`, `exhausted-capacity`, `no-submission-bound`); a later-explained or superseded `lease-loss` auto-settles (`escalation.auto-settled`: `auto-settled: blocked report for epoch N explains the lapse`, `auto-settled: stopped-worker attestation for epoch N explains the lapse`).

### Who may settle what

`escalation.resolved` records each:

- Explained `lease-loss`: reconciliation, or `admin` `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`.
- Superseded-epoch `lease-loss`: reconciliation; all attempts ended unfenced: after 5 min.
- `security-concern`, `requirement-weakening`, `evidence-policy-conflict`, lead-raised `lease-loss`: master-requested two-party decision or declared human session (`sessionKind: "human"`).
- `requirement-weakening` from an approved `requirements` decision: settled by that approval, citing its approver; no `scope` fault.
