<!-- page: Operate Graphyard | 11 | leads, escalations. -->
# Slice-lead delegation

## Authority boundaries

An AI `slice-lead` leads slice (`product`, `infrastructure`, `docs-experience`): rules on plans, sends back, escalates; never implements, reviews, proves, merges (`lead.action.refused`). `reject-plan`/`send-back` hold merging (**lead hold**) until that lead's `approve-plan` with `"supersedes": "RULING-ID"` or `rework`. Producers ever assigned item or in its slice: `evidence.producer.refused`. Limits: [deployment variables](deployment.md#variables).

## Reviewer provider diversity

The agent registry chooses a `reviewer` account on a different model provider than the item's implementer, so the two share no blind spots. A provider is the account's model `provider`, else its runtime's launch kind; the implementer's is the newest registry `worker` session for the item (retained, then `agent-registry.selected` events), else `lastAssignment.runtime`. Same-provider accounts are recorded in `skipped` (`shares the implementer's provider P on GY-N`). A different-provider account at only its own session limit is waited for (refused as `role reviewer is at its concurrency limit for providers other than P`, retried as capacity). Otherwise the first eligible same-provider account serves, its reason recording `no reviewer account outside provider P can serve GY-N` with why. Unknown implementer provider, or other roles: unchanged.

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
- Superseded-epoch `lease-loss` (latest attempt leased or submitted, no lost-epoch fence): reconciliation; control-plane `lease-loss` whose attempts all ended (no lease, no containment fence): after 5 min (`auto-settled: ended — …`).
- `security-concern`, `requirement-weakening`, `evidence-policy-conflict`, lead-raised `lease-loss`: master-requested two-party decision or declared human session (`admin`, `sessionKind: "human"`; settles any).
- `requirement-weakening` from approved `requirements` decision: records id, settled by that approval (citing approver); no `scope` fault.
