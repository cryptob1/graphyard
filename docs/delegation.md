<!-- page: Operate Graphyard | 11 | leads, escalations. -->
# Slice-lead delegation

## Authority boundaries

An AI `slice-lead` leads slice (`product`, `infrastructure`, `docs-experience`): rules on plans, sends back, escalates; never implements, reviews, proves, merges (`lead.action.refused`). `reject-plan`/`send-back` hold merging (**lead hold**) until that lead's `approve-plan` with `"supersedes": "RULING-ID"` or `rework`. Producers ever assigned item or in its slice: `evidence.producer.refused`. Limits: [deployment variables](deployment.md#variables).

## Reviewer provider diversity

The agent registry picks a `reviewer` account on a different model provider (the account's model `provider`, else its runtime's launch kind) than the item's newest `worker` session. Same-provider accounts are recorded in `skipped` (`shares the implementer's provider P on GY-N`). A different-provider account at only its session limit is waited for (retried as capacity); otherwise the first eligible same-provider account serves, recording `no reviewer account outside provider P can serve GY-N`. Unknown implementer provider: unchanged.

## Escalation

| Trigger | Raised when
| --- | ---
| `lease-loss` | A lapse with no submission, no carried `blocked` report, no stopped-worker attestation, no provider exhaustion
| `evidence-policy-conflict` | Trusted evidence for another policy revision
| `security-concern` | A lead's `escalate` ruling
| `requirement-weakening` | A revision retires a criterion, narrows proofs

Unresolved triggers refuse merging; replacements may claim, delivery waits. Explained lapses: `lease.expired` with a [cause](protocol/leases.md#how-a-lease-ends) (`submitted`, `blocked-awaiting-operator`, `stopped-by-attestation`, `exhausted-capacity`, `no-submission-bound`); later-explained or superseded `lease-loss` auto-settles (`escalation.auto-settled`: `auto-settled: blocked report for epoch N explains the lapse`, `auto-settled: stopped-worker attestation for epoch N explains the lapse`, `auto-settled: superseded — epoch M is held by OWNER, …`).

### Who may settle what

`escalation.resolved` records each:

- Explained `lease-loss`: reconciliation, or `admin` `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`.
- Superseded-epoch `lease-loss` (no lost-epoch fence): reconciliation; one whose attempts all ended unfenced: after 5 min (`auto-settled: ended — …`).
- `security-concern`, `requirement-weakening`, `evidence-policy-conflict`, lead-raised `lease-loss`: master-requested two-party decision or declared human session (`admin`, `sessionKind: "human"`; settles any).
- `requirement-weakening` from approved `requirements` decision: records id, settled by that approval (citing approver); no `scope` fault.
