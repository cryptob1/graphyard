<!-- page: Operate Graphyard | 6 | leads, rulings. -->
# Slice-lead delegation

For an installation past one coordinator: what a lead rules on, and who settles escalations.

Delivery scales through three formal slices — **product**, **infrastructure** and **docs/experience** (`docs-experience` in API data) — each led by an AI coordinator session with its own `slice-lead` principal.

## Authority boundaries

- **A lead coordinates workers in its slice:** approve or reject plans, classify failures, request reruns, send work back, escalate. Every ruling is append-only, carrying a versioned written rule ID and a reason, written with an `Idempotency-Key`.
- **Lifecycle mutations from a `slice-lead` credential:** refused and recorded as `lead.action.refused`.
- **Ruling against a delivered item:** refused, not bumping its revision.

## Blocking rulings and their recovery

`reject-plan` and `send-back` each record a **lead hold** in the transaction appending the ruling:

- **Merge authorization:** invalidated at once.
- **Guarded merge broker:** refuses the item independently of stored gates.
- **Rank:** `send-back` over `reject-plan`; a later ruling may raise a hold, never weaken one.

## Independent proof producers

- **Refused, recording `evidence.producer.refused`:** a submitter that has ever held an assignment on that item, holds `slice-lead` authority for any slice, or is a producer bound to the item's slice.

## Escalation

Four triggers raise an automatic, append-only escalation:

| Trigger | Raised when |
| --- | --- |
| `lease-loss` | A worker lease lapses on an epoch with no submission, no carried `blocked` report and no stopped-worker attestation: a worker that silently vanished. A lapse the ledger explains is a `lease.expired` history entry with its [cause](protocol/leases.md#lease-end-and-its-cause) (`submitted`, `blocked-awaiting-operator` or `stopped-by-attestation`) and raises nothing |
| `evidence-policy-conflict` | Trusted evidence arrives for a policy revision other than the item's current one |
| `security-concern` | A lead's `escalate` ruling names this trigger |
| `requirement-weakening` | A requirement revision retires a criterion or narrows an existing criterion's required proofs |

### Who may settle what

- **`lease-loss` raised by the control plane for an epoch whose lapse the ledger explains:** Reconciliation, automatically; or any `admin` principal, whatever its declared session kind, with `resolve GY-N lease-loss --attestation blocked|stopped-worker "reason"`. The server verifies the citation against the ledger for that exact epoch, refusing `The ledger holds no KIND attestation for epoch N` otherwise. A declared human session may also resolve it
- **`lease-loss` raised by the control plane for a lapse nothing explains:** A declared human session only; a citation the ledger does not hold is refused, nothing settles it automatically
- **`security-concern`, `requirement-weakening`, `evidence-policy-conflict`, and any `lease-loss` a lead raised:** A declared human session only: an `admin` declaring `sessionKind: "ai"` or nothing is refused with `Escalation resolution requires a declared human session; PRINCIPAL is ai`, and a citation with `Only a lease-loss raised by the control plane is settled by citing an attestation`

Every settlement is append-only history:

- **Resolution:** records an `escalation.resolved` event keeping the incident verbatim with who resolved it, that principal's declared session kind, the reason and the attestation cited (or `null`).
  - `auto-settled: submitted before expiry` for an epoch with a bound submission
  - `auto-settled: blocked report for epoch N explains the lapse` or `auto-settled: stopped-worker attestation for epoch N explains the lapse` for a control-plane one

## Ownership, capacity and identity


